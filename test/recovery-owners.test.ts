import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { checkRecovery, inspectRecovery, recoveryRecords, settleRecoveryOwners } from '../src/recovery.js';
import { runReadTask } from '../src/runtime.js';
import { acquireOwner } from '../src/ownership.js';
import { acquireWorkspaceOwner } from '../src/workspace-ownership.js';
import { RecoveryPanel, readRecoveryFacts } from '../src/tui/recovery.js';
import { ReadOnlyTui } from '../src/tui/app.js';

type Situation = 'running' | 'cleaned' | 'crash' | 'foreign';
/** Real protocol files with deterministic cleanup records; no provider or writable Harness is needed for the blocked inspection. */
async function retained(situation: Situation, durable = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-recovery-owners-'))), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace);
  let runId: string = randomUUID(), sessionId: string = randomUUID();
  if (durable) {
    writeFileSync(join(workspace, 'README.md'), 'Owner recovery fixture');
    const controller = new AbortController();
    const original = await runReadTask({ workspace, dataRoot, input: '恢复锁测试', mode: 'offline', signal: controller.signal, cancellation: 'exit',
      transport: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Error('interrupted'))); controller.abort(); }) });
    runId = original.runId; sessionId = original.sessionId;
  }
  const workspaceLease = await acquireWorkspaceOwner(workspace, () => {}), workspacePath = workspaceLease.path;
  await workspaceLease.release();
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.equal(dead.status, 0);
  const holder = { pid: situation === 'running' ? process.pid : dead.pid, host: situation === 'foreign' ? 'other-host.example' : hostname(), started: '2001-01-01T00:00:00.000Z' };
  const locations = [workspacePath, join(dataRoot, 'sessions', sessionId), dataRoot];
  const claims = locations.map(path => ({ path, claim: { ...holder, token: randomUUID() } }));
  const evidence = new Evidence(dataRoot, runId);
  if (!durable) evidence.append('task.accepted', { runId, sessionId, workspace, input: '恢复锁测试', mode: 'offline', authorization: { tools: ['read'] } });
  evidence.append('ownership.acquired', { workspace: claims[0], dataRoot: claims[2] });
  evidence.append('ownership.session', claims[1]);
  if (situation !== 'crash') {
    evidence.append('lifecycle.storage-closing', { managedCommands: { started: 1, settled: 1 } });
    evidence.append('lifecycle.storage-closed', { storage: 'closed' });
  }
  evidence.close();
  for (const owner of claims) {
    mkdirSync(owner.path, { recursive: true });
    mkdirSync(`${owner.path}.lock`);
    writeFileSync(join(owner.path, 'owner.json'), JSON.stringify(owner.claim));
  }
  return { root, workspace, dataRoot, runId, sessionId, holder, claims,
    cleanup() {
      for (const owner of claims) {
        const marker = join(owner.path, 'owner.json');
        if (existsSync(marker)) {
          assert.equal(JSON.parse(readFileSync(marker, 'utf8')).token, owner.claim.token, 'only remove this fixture owner');
          rmSync(marker); rmSync(`${owner.path}.lock`, { recursive: true, force: true });
        }
      }
      rmSync(workspacePath, { recursive: true });
      rmSync(root, { recursive: true });
    } };
}

test('owner recovery shows host facts for running, cleaned, crashed and unverified hosts, with exactly two dispositions', async () => {
  for (const situation of ['running', 'cleaned', 'crash', 'foreign'] as const) {
    const f = await retained(situation);
    try {
      const report = await inspectRecovery(f), panel = new RecoveryPanel(readRecoveryFacts(f.dataRoot, [report]));
      const text = panel.render(180, 80).map(stripTerminalSequences).join('\n');
      assert.match(text, /所有者/);
      assert.ok(text.includes(`pid ${f.holder.pid} · ${f.holder.host} · ${f.holder.started}`), text);
      assert.doesNotMatch(text, /^\s*(工作|未知|证据)\s/m);
      assert.match(text, /1  重新核对（只读）/);
      assert.match(text, /2  释放上次进程留下的写入者锁/);
      assert.doesNotMatch(text, /视为已完成|从中断处继续|结束旧工作，开新任务/);
      for (const owner of f.claims) assert.equal(JSON.parse(readFileSync(join(owner.path, 'owner.json'), 'utf8')).token, owner.claim.token, 'inspection never releases a lock');
      if (situation === 'cleaned') {
        assert.match(text, /已结束 · 存储已关闭，受管命令已结束 · 可释放/);
        panel.handleInput('\x1b[B'); assert.equal(panel.cursor, 1);
        assert.deepEqual(panel.handleInput('\r'), { type: 'release-owner' });
      } else {
        assert.match(text, situation === 'running' ? /仍在运行 · 等它结束后重新核对/ : situation === 'foreign' ? /OWNER_HOST_UNVERIFIED/ : /没有清理记录（崩溃或强杀）/);
        assert.match(text, /不可选/);
        panel.handleInput('\x1b[B'); panel.handleInput('2'); assert.equal(panel.cursor, 0);
        assert.deepEqual(panel.handleInput('\r'), { type: 'recheck' });
        if (situation !== 'running') {
          for (const owner of f.claims) {
            assert.ok(text.includes(`${owner.path}.lock`), text);
            assert.ok(text.includes(join(owner.path, 'owner.json')), text);
          }
          assert.match(text, /恢复方法/); assert.match(text, /确认.*命令.*结束/);
        }
      }
      panel.handleInput('3'); panel.handleInput('4'); assert.ok(panel.cursor < 2);
    } finally { f.cleanup(); }
  }
});

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false;
  input: (text: string) => void = () => {}; resize: () => void = () => {};
  start(input: (text: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('owner recovery did not become ready');
}

test('release confirms the retained uncertainty, automatically rechecks, and all three protocol locks can be acquired again', async () => {
  const f = await retained('cleaned', true), terminal = new TestTerminal();
  let calls = 0;
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false,
    transport: async () => { calls++; throw Error('owner release must not call a provider'); } });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n'), key = (data: string) => terminal.input(data);
  try {
    app.start(); await until(() => screen().includes('释放上次进程留下的写入者锁'));
    key('2'); key('\r');
    assert.match(screen(), /释放后，外部进程与费用的不确定性仍然保留/);
    for (const owner of f.claims) assert.ok(existsSync(join(owner.path, 'owner.json')), 'the first Enter only opens confirmation');
    key('\x1b'); assert.match(screen(), /所有者/);
    key('\r'); assert.match(screen(), /释放后，外部进程与费用的不确定性仍然保留/);
    key('\r');
    await until(() => screen().includes('继续旧工作'));
    const records = Array.from(recoveryRecords(f.dataRoot, f.runId));
    const settled = records.find(record => record.kind === 'recovery.owner-settled')!;
    assert.ok(settled); assert.equal((settled.data as any).externalProcesses, 'unknown');
    assert.ok(records.some(record => record.kind === 'recovery.report' && record.seq > settled.seq), 'a fresh host check follows the release without another key');
    assert.equal((records.find(record => record.kind === 'run.closed')!.data as any).status, 'unknown');
    key('\x1b'); assert.match(screen(), /2  视为已完成/); assert.match(screen(), /4  结束旧工作，开新任务/);
    assert.doesNotMatch(screen(), /所有者/); assert.equal(calls, 0);
    const workspace = await acquireWorkspaceOwner(f.workspace, () => {}), data = await acquireOwner(f.dataRoot, () => {}), session = await acquireOwner(f.claims[1].path, () => {});
    try { workspace.assertHeld(); data.assertHeld(); session.assertHeld(); }
    finally { await session.release(); await data.release(); await workspace.release(); }
  } finally { await app.exit(); f.cleanup(); }
});

test('a workspace-only or session-only retained owner is reported without mistaking the temporary inspection lease for a live holder', async () => {
  for (const kept of [0, 1]) {
    const f = await retained('cleaned', true);
    try {
      for (const owner of f.claims.filter((_claim, i) => i !== kept)) { rmSync(join(owner.path, 'owner.json')); rmSync(`${owner.path}.lock`, { recursive: true }); }
      const options = { ...f, authorization: { workspace: f.workspace, mode: 'offline' as const, tools: ['read'] as const } };
      for (const inspect of [inspectRecovery, checkRecovery]) {
        const report = await inspect(options);
        assert.ok(report.options.includes('confirm-cleanup'));
        assert.equal(report.ownerCleanup?.status, 'releasable');
        assert.deepEqual(report.ownerClaims?.map(claim => claim.path), [f.claims[kept].path]);
        assert.ok(existsSync(join(f.claims[kept].path, 'owner.json')));
      }
    } finally { f.cleanup(); }
  }
});

test('a formerly releasable owner changing during confirmation is rejected by the host, including on a fresh foreign-host decision', async () => {
  const f = await retained('cleaned'), terminal = new TestTerminal();
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n'), key = (data: string) => terminal.input(data);
  try {
    app.start(); await until(() => screen().includes('释放上次进程留下的写入者锁'));
    key('2'); key('\r'); assert.match(screen(), /释放后，外部进程与费用的不确定性仍然保留/);
    writeFileSync(join(f.dataRoot, 'owner.json'), JSON.stringify({ ...f.claims[2].claim, host: 'changed-host.example' }));
    key('\r'); await until(() => screen().includes('STALE_RECOVERY_DECISION'));
    for (const owner of f.claims) assert.ok(existsSync(join(owner.path, 'owner.json')));
    assert.ok(!existsSync(join(f.dataRoot, 'recovery-owner-decisions')), 'a stale confirmation cannot start an owner disposition');
    key('\r'); await until(() => screen().includes('OWNER_HOST_UNVERIFIED'));
    const current = await inspectRecovery(f);
    assert.equal(current.ownerCleanup?.status, 'blocked');
    await assert.rejects(settleRecoveryOwners({ ...f, decision: { id: 'fresh-foreign', snapshotId: current.snapshotId, action: 'confirm-cleanup', acceptUnknownExternalEffects: true } }), /OWNER_HOST_UNVERIFIED/);
    for (const owner of f.claims) assert.ok(existsSync(join(owner.path, 'owner.json')));
  } finally { await app.exit(); f.cleanup(); }
});

test('owner recovery at 80×24 and 40×12 keeps both dispositions and recovery status while full lock paths remain pageable', async () => {
  const f = await retained('crash'), terminal = new TestTerminal();
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n');
  try {
    app.start(); await until(() => screen().includes('没有清理记录'));
    for (const [columns, rows] of [[80, 24], [40, 12]] as const) {
      terminal.columns = columns; terminal.rows = rows; terminal.resize();
      const seen: string[] = [];
      for (let page = 0; page < 100; page++) {
        const lines = app.screen(), text = lines.map(stripTerminalSequences).join('\n');
        assert.ok(lines.length <= rows); assert.ok(lines.every(line => visibleWidth(line) <= columns));
        for (const kept of [/1  重新核对（只读）/, /2  释放上次进程留下的写入者锁/, /不可选 · 没有清理记录/, /Enter/, /Esc 返回查看/, /◈ 恢复核对/]) assert.match(text, kept, `${columns}×${rows}`);
        if (text === seen.at(-1)) break;
        seen.push(text); terminal.input('\x1b[6~');
      }
      assert.ok(seen.length > 1, 'long paths can be paged without moving or hiding dispositions');
      assert.match(seen.join('\n'), /数据根锁/);
      for (let page = 0; page < seen.length; page++) terminal.input('\x1b[5~');
    }
    terminal.input('\x1b'); assert.doesNotMatch(screen(), /2  释放上次进程留下的写入者锁/); assert.match(screen(), /◈ 恢复核对/);
    terminal.input('\r'); await until(() => screen().includes('2  释放上次进程留下的写入者锁'));
    const report = await inspectRecovery(f), panel = new RecoveryPanel(readRecoveryFacts(f.dataRoot, [report]));
    const complete = panel.render(40, 1000).map(stripTerminalSequences).join('').replace(/\s/g, '');
    for (const owner of f.claims) {
      assert.ok(complete.includes(`${owner.path}.lock`.replace(/\s/g, '')));
      assert.ok(complete.includes(join(owner.path, 'owner.json').replace(/\s/g, '')));
    }
  } finally { await app.exit(); f.cleanup(); }
});

test('show never enters owner recovery or writes a cleanup report or decision', async () => {
  const f = await retained('cleaned'), terminal = new TestTerminal();
  let calls = 0;
  const before = Array.from(recoveryRecords(f.dataRoot, f.runId));
  const app = new ReadOnlyTui({ ...f, show: { run: f.runId }, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false,
    transport: async () => { calls++; throw Error('show must not execute'); } });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n');
  try {
    app.start(); terminal.input('\r'); terminal.input('2'); terminal.input('\r'); terminal.input('\r');
    assert.match(screen(), /只读查看/); assert.doesNotMatch(screen(), /释放上次进程留下的写入者锁|释放后，外部进程/);
    assert.equal(calls, 0); assert.deepEqual(Array.from(recoveryRecords(f.dataRoot, f.runId)), before);
    assert.ok(!existsSync(join(f.dataRoot, 'recovery-owner-reports'))); assert.ok(!existsSync(join(f.dataRoot, 'recovery-owner-decisions')));
    for (const owner of f.claims) assert.equal(JSON.parse(readFileSync(join(owner.path, 'owner.json'), 'utf8')).token, owner.claim.token);
  } finally { await app.exit(); f.cleanup(); }
});
