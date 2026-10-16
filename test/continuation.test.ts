import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui, type TuiOptions } from '../src/tui/app.js';
import { demoTransport } from '../src/offline.js';
import { runReadTask, runCodingTask } from '../src/runtime.js';
import { Evidence, readObject } from '../src/evidence.js';
import { readDisplayIndex } from '../src/display-number.js';
import { readRun } from '../src/runtime.js';
import { readSessionChains } from '../src/session-chain.js';
import { readRunRecords } from '../src/query.js';
import { CONTINUE_TAIL_UNFINISHED, COMPACT_VERSION_CHANGED, VERSION_CHANGED_HINT, continueQueued, readContinuation, runVersionChanged } from '../src/continuation.js';
import { recordedExecutionVersion, currentExecutionVersion, versionChanged } from '../src/execution-version.js';

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; writes: string[] = []; stopped = false;
  input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(value: string) { this.writes.push(value); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise(r => setTimeout(r, 30));
let lastScreen = () => '';
async function until(predicate: () => boolean, what = 'condition') { for (let i = 0; i < 400; i++) { if (predicate()) return; await tick(); } throw Error(`${what} timed out\n${lastScreen()}`); }
function base() {
  const root = mkdtempSync(join(tmpdir(), 'durio-continue-')), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'continuation fixture\n');
  return { root, workspace: realpathSync(workspace), dataRoot };
}
function open(options: Partial<TuiOptions> & { workspace: string; dataRoot: string; root: string }) {
  const terminal = new TestTerminal(), transport = demoTransport();
  const app = new ReadOnlyTui({ draftRoot: join(options.root, 'drafts'), mode: 'offline', transport: transport.fetch, terminal, widthCalibration: false, copy: async () => true, ...options });
  app.start();
  const screen = () => app.screen().map(stripTerminalSequences).join('\n'), key = (data: string) => terminal.input(data);
  lastScreen = screen;
  return { app, terminal, transport, screen, key };
}
const interrupted = (controller: AbortController): typeof fetch => async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Error('interrupted'))); controller.abort(); });

test('resume: a completed tail opens 1b idle on that session and the next Enter continues it as task N+1', async () => {
  const f = base(), first = await runReadTask({ ...f, input: 'First task', mode: 'offline', transport: demoTransport().fetch });
  const t = open({ ...f, resume: first.sessionId, coding: false });
  try {
    await until(() => t.screen().includes('✓ 完成'), '1b idle');
    assert.match(t.screen(), /会话 s-[0-9a-f]+ · run r-[0-9a-f]+/);assert.match(t.screen(), /只读 · 任务 1 · ✓ 完成/);
    assert.doesNotMatch(t.screen(), /执行版本已变|不能接续/);
    t.key('Second task'); t.key('\r');
    await until(() => readSessionChains(f.dataRoot).session(first.sessionId)?.tasks === 2 && t.screen().includes('✓ 完成') && !t.screen().includes('Second task\n'), 'continued task');
    await until(() => (t.app as any).phase === 'idle');
    const session = readSessionChains(f.dataRoot).session(first.sessionId)!;
    assert.equal(session.tail.number, 2);assert.equal(session.tail.status, 'completed');
    assert.equal(readSessionChains(f.dataRoot).contextRunIds(session.tailRunId)[0], first.runId);
    assert.match(t.screen(), /会话中前 1 个任务/);
  } finally { await t.app.exit(); }
});

test('resume: a failed tail is shown with the reason and Enter opens a new session', async () => {
  const f = base(), first = await runReadTask({ ...f, input: 'Fails', mode: 'offline', transport: async () => new Response('down', { status: 500 }) });
  assert.equal(first.status, 'failed');
  const t = open({ ...f, resume: first.sessionId, coding: false });
  try {
    await until(() => t.screen().includes(CONTINUE_TAIL_UNFINISHED), 'reason line');
    t.key('Fresh task'); t.key('\r');
    await until(() => readSessionChains(f.dataRoot).list().items.length === 2 && (t.app as any).phase === 'idle', 'new session');
    const [latest] = readSessionChains(f.dataRoot).list().items;
    assert.notEqual(latest.id, first.sessionId);assert.equal(latest.tasks, 1);assert.equal(latest.tail.status, 'completed');
  } finally { await t.app.exit(); }
});

test('resume: a tail awaiting recovery opens the recovery panel without continuing', async () => {
  const f = base(), controller = new AbortController();
  const first = await runReadTask({ ...f, input: 'Interrupted', mode: 'offline', signal: controller.signal, cancellation: 'exit', transport: interrupted(controller) });
  assert.equal(first.status, 'unknown');
  assert.equal(readContinuation(f.dataRoot, first.sessionId)?.state, 'recovery');
  const t = open({ ...f, resume: first.sessionId, coding: false });
  try {
    await until(() => t.screen().includes('恢复核对 ·'), 'recovery panel');
    assert.equal(t.transport.calls.length, 0);
    t.key('\x1b'); t.key('must not run'); t.key('\r');assert.equal(t.transport.calls.length, 0);
  } finally { await t.app.exit(); }
});

test('resume: a tail executed by another process shows the lock holder and cannot submit; resume and show take no lock', async () => {
  const f = base(), controller = new AbortController();
  let release!: () => void;const held = new Promise<void>(resolve => { release = resolve; });
  const running = runCodingTask({ ...f, input: 'Long task', mode: 'offline', signal: controller.signal, cancellation: 'stop', transport: async (_url, init) => { release(); return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('stopped')))); } });
  await held;
  const session = readSessionChains(f.dataRoot).list().items[0];
  const t = open({ ...f, resume: session.id, coding: true });
  try {
    await until(() => t.screen().includes('被占用'), 'lock probe');
    t.key('Must not submit'); t.key('\r');
    assert.match(t.screen(), /不能提交/);assert.equal(t.transport.calls.length, 0);
  } finally { await t.app.exit(); controller.abort(); await running; }
  // A completed coding session: resume and show stay open while another writer takes the workspace lock.
  const done = await runCodingTask({ ...f, input: 'Completed coding task', mode: 'offline', transport: demoTransport().fetch });
  const doneSession = readSessionChains(f.dataRoot).sessionOfRun(done.runId)!.id;
  const resumed = open({ ...f, resume: doneSession, coding: true }), shown = open({ ...f, show: { run: done.runId, session: doneSession } });
  try {
    await until(() => resumed.screen().includes('✓ 完成'), 'resumed');
    await until(() => shown.screen().includes('历史'), 'show session layer');
    const other = await runCodingTask({ ...f, input: 'Another instance', mode: 'offline', transport: demoTransport().fetch });
    assert.equal(other.status, 'completed');
    shown.key('\x1b'); shown.key('Read-only view'); shown.key('\r');
    assert.match(shown.screen(), /只读查看 · 不能提交/);assert.equal(shown.transport.calls.length, 0);
    assert.match(shown.screen(), /只读/);
  } finally { await resumed.app.exit(); await shown.app.exit(); }
});

test('idle Enter continues after improve defaults change in the same process; the hint shows the version change', async () => {
  const f = base(), t = open({ ...f, coding: false });
  try {
    t.key('First'); t.key('\r');await until(() => t.screen().includes('✓ 完成') && (t.app as any).phase === 'idle', 'first task');
    const first = (t.app as any).runId as string;
    // An improve default activation changes the effective instructions (execution config) without a new build.
    const e = new Evidence(f.dataRoot, 'activation-fixture'), content = e.blob('Prefer short answers.\n');
    e.append('improve.activation', { defaults: [{ current: { workspace: f.workspace, taskType: 'read', files: [{ targetId: 'agents', root: f.workspace, path: 'AGENTS.md', kind: 'prompt-skill', content }] } }] });e.close();
    t.key('/bottom'); t.key('\r');
    await until(() => t.screen().includes(VERSION_CHANGED_HINT), 'version hint');
    t.key('Second'); t.key('\r');
    await until(() => readSessionChains(f.dataRoot).sessionOfRun(first) !== null && readSessionChains(f.dataRoot).session(readSessionChains(f.dataRoot).sessionOfRun(first)!.id)!.tasks === 2 && (t.app as any).phase === 'idle', 'continued');
    const chains = readSessionChains(f.dataRoot), tail = chains.session(chains.sessionOfRun(first)!.id)!.tailRunId;
    assert.equal(runVersionChanged(f.dataRoot, tail, chains), true);
    assert.doesNotMatch(t.screen(), /执行版本已变/);
  } finally { await t.app.exit(); }
});

test('continuation is blocked while the session has an unresolved queue item', async () => {
  const f = base(), first = await runReadTask({ ...f, input: 'Queue source', mode: 'offline', transport: demoTransport().fetch });
  const e = new Evidence(f.dataRoot, first.runId);
  const accepted = JSON.parse(readObject(f.dataRoot, readRunRecords(f.dataRoot, first.runId, { limit: 1, kinds: ['task.accepted'] }).records[0].ref).toString());
  const artifact = readRunRecords(f.dataRoot, first.runId, { limit: 8, kinds: ['execution.artifact', 'execution.config'] }).records;
  e.append('control.accepted', { requestId: 'frozen-follow', kind: 'follow-up', input: 'later', taskId: 'queued-task', target: { workspace: f.workspace, sessionId: accepted.sessionId, taskId: accepted.taskId, runId: first.runId }, executionVersion: { artifactId: 'x', artifactSeq: artifact[0].seq, configSeq: artifact[1].seq }, authorization: accepted.authorization });
  e.close();
  const continuation = readContinuation(f.dataRoot, first.sessionId);
  assert.equal(continuation?.state, 'blocked');assert.equal(continuation?.state === 'blocked' && continuation.reason, continueQueued(1));
});

test('v1 records: a completed v1 session continues under the redesign build with the version hint; /compact waits for a new task', async t => {
  const fixture = fileURLToPath(new URL('../../test/fixtures/v1-records', import.meta.url));
  const names = JSON.parse(readFileSync(join(fixture, 'fixture-identity.json'), 'utf8')).names as Record<string, string>;
  const source = join(fixture, 'data'), sessionId = names['session.read'], tailRunId = names['run.read'];
  const workspace = readSessionChains(source).session(sessionId)!.workspace!;
  let created = false;
  if (!existsSync(workspace)) { try { mkdirSync(workspace, { recursive: true }); cpSync(join(fixture, 'workspace'), workspace, { recursive: true }); created = true; } catch { t.skip('recorded v1 workspace path cannot be created on this machine'); return; } }
  // Only this session's v1 records: other v1 runs (ended / recovered) are resolved against session store paths of the
  // original root, so a copied whole root blocks every new task at the old-pending check regardless of continuation.
  const root = mkdtempSync(join(tmpdir(), 'durio-continue-v1-')), dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
  cpSync(join(source, 'objects'), join(dataRoot, 'objects'), { recursive: true });cpSync(join(source, 'host.sqlite'), join(dataRoot, 'host.sqlite'));
  cpSync(join(source, 'sessions', sessionId), join(dataRoot, 'sessions', sessionId), { recursive: true });
  const db = new DatabaseSync(join(dataRoot, 'host.sqlite'));db.prepare('DELETE FROM records WHERE run_id<>?').run(tailRunId);db.close();
  const before = readContinuation(dataRoot, sessionId, { workspace, current: () => currentExecutionVersion({ dataRoot, workspace, coding: false, mode: 'offline' }) });
  assert.equal(before?.state, 'ready');assert.equal(before?.state === 'ready' && before.versionChanged, true);
  const app = open({ root, dataRoot, workspace, resume: sessionId, coding: false });
  try {
    await until(() => app.screen().includes(VERSION_CHANGED_HINT), 'version hint');
    app.key('/compact'); app.key('\r');assert.match(app.screen(), new RegExp(COMPACT_VERSION_CHANGED));
    app.key('Continue the v1 session'); app.key('\r');
    await until(() => readSessionChains(dataRoot).session(sessionId)?.tasks === 2 && (app.app as any).phase === 'idle', 'continued');
    const chains = readSessionChains(dataRoot), tail = chains.session(sessionId)!.tail;
    assert.equal(tail.status, 'completed');assert.equal(tail.number, 2);assert.deepEqual(chains.contextRunIds(tail.runId), [tailRunId, tail.runId]);
    assert.equal(versionChanged(recordedExecutionVersion(dataRoot, tailRunId), recordedExecutionVersion(dataRoot, tail.runId)), true);
    assert.equal(runVersionChanged(dataRoot, tail.runId, chains), true);
    assert.doesNotMatch(app.screen(), /执行版本已变/);
    app.key('/compact'); app.key('\r');
    await until(() => app.screen().includes('上下文压缩') && (app.app as any).phase === 'idle', 'compaction');
    assert.ok(readRunRecords(dataRoot, tail.runId, { tail: true, limit: 8, kinds: ['compaction.started'] }).records.length > 0);
  } finally { await app.app.exit(); if (created) rmSync(workspace, { recursive: true, force: true }); }
});

test('CLI: tui is removed; show without --format outside a terminal fails fast; --format json prints the recorded run; resume rejects r- numbers', async () => {
  const f = base(), first = await runReadTask({ ...f, input: 'CLI fixture', mode: 'offline', transport: demoTransport().fetch });
  const index = readDisplayIndex(f.dataRoot), run = index.label('run', first.runId), session = index.label('session', first.sessionId);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/src/cli.js', ...args, '--data-root', f.dataRoot], { encoding: 'utf8', timeout: 20000 });
  const tui = cli('tui', '--workspace', f.workspace);assert.notEqual(tui.status, 0);assert.match(tui.stderr, /USAGE: run\/control/);
  const help = cli('--help');assert.equal(help.status, 0);assert.doesNotMatch(help.stdout, /pi-durio tui/);assert.match(help.stdout, /pi-durio resume/);assert.match(help.stdout, /--read-only/);
  for (const id of [run, session]) {
    const shown = cli('show', id);assert.equal(shown.status, 1);assert.equal(shown.signal, null);assert.match(shown.stderr, /show outside a terminal requires --format json/);assert.equal(shown.stdout, '');
  }
  const json = cli('show', run, '--format', 'json');assert.equal(json.status, 0, json.stderr);
  const page = await readRun(f.dataRoot, first.runId), printed = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(printed), [...Object.keys(page), 'costEstimate']);assert.deepEqual(printed.records, page.records.map(({ seq, kind, at }) => ({ seq, kind, at })));
  assert.deepEqual(JSON.parse(cli('show', session, '--format', 'json').stdout).records, printed.records);
  assert.match(cli('show', run, '--format', 'text').stdout, /^pi-durio show\n\{/);
  const resumeRun = cli('resume', run);assert.notEqual(resumeRun.status, 0);assert.match(resumeRun.stderr, new RegExp(`is a run of session ${session}`));
  const authorization = cli('resume', session, '--read-only');assert.notEqual(authorization.status, 0);assert.match(authorization.stderr, /--coding\/--read-only are not accepted/);
  const resumed = cli('resume', session);assert.equal(resumed.status, 1);assert.match(resumed.stderr, /TUI_REQUIRES_TERMINAL/);
});
