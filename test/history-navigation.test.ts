import { fixtureDir as v1FixtureDir, dataRoot as v1DataRoot, names as v1Names } from './v1-runtime-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { ReadOnlyTui, type TuiOptions } from '../src/tui/app.js';
import { watermark } from '../src/history.js';

const key = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', ctrlR: '\x12', ctrlO: '\x0f' };
class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; input: (s: string) => void = () => {};
  start(input: (s: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-history-nav-'))), workspace = join(root, 'workspace'), dataRoot = join(root, 'data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'History fixture\n');
  return { root, workspace, dataRoot };
}
function task(f: ReturnType<typeof fixture>, runId: string, input: string, status = 'completed', parent?: string) {
  const e = new Evidence(f.dataRoot, runId), sessionId = randomUUID();
  e.append('task.accepted', { taskId: `${runId}-task`, sessionId, workspace: f.workspace, input, authorization: { execution: 'trusted-local-read-only', tools: ['read'] } });
  if (parent) e.append('context.imported', { source: { sourceRunId: parent } });
  e.append('run.started', { sessionId });
  e.append('tool.intent', { attemptId: `${runId}-read`, durableTaskId: 1, callId: `${runId}-read`, tool: 'read', args: { path: 'README.md' } });
  const result = e.append('tool.result', { attemptId: `${runId}-read`, durableTaskId: 1, result: { content: [{ type: 'text', text: `1: ${runId} original result\n2: second line` }] } });
  e.append('tool.summary', { attemptId: `${runId}-read`, resultSeq: result, isError: false });
  e.append('context.snapshot', { messages: e.blob(JSON.stringify([{ role: 'user', content: runId }])) });
  e.append('run.closed', { status, cleanup: 'confirmed' }); e.close();
  return sessionId;
}
function open(f: ReturnType<typeof fixture>, options: Partial<TuiOptions> = {}) {
  const terminal = new TestTerminal(), copied: string[] = []; let calls = 0;
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false,
    transport: async () => { calls++; throw Error('history never dispatches'); }, copy: async text => { copied.push(text); return true; }, ...options });
  app.start();
  return { app, terminal, copied, calls: () => calls, press: (...data: string[]) => data.forEach(value => terminal.input(value)), screen: () => app.screen().map(stripTerminalSequences).join('\n') };
}

test('real app navigates three history layers and trace/raw without losing positions, Ctrl+O expands only historical tools', async () => {
  const f = fixture(); task(f, 'first', 'First task'); task(f, 'second', 'Second task', 'completed', 'first'); task(f, 'other', 'Other session');
  const before = readFileSync(join(f.dataRoot, 'host.sqlite')), through = watermark(f.dataRoot), t = open(f);
  try {
    await new Promise(resolve => setImmediate(resolve));
    t.press(key.ctrlR, key.down); const list = t.screen(); assert.match(list, /^ {132}\n {2}◆ history/);
    t.press(key.enter, key.down); const session = t.screen(); assert.match(session, /任务 2.*Second task/);
    t.press(key.enter); const body = t.screen(); assert.match(body, /只读 · 不能提交/); assert.doesNotMatch(body, /second original result/);
    assert.doesNotMatch(body, /◆ pi-durio|offline-demo|Enter 提交/, 'a short history transcript covers the underlying session screen');
    t.press(key.ctrlO); assert.match(t.screen(), /second original result/);
    t.press(key.ctrlO); assert.equal(t.screen(), body);
    t.press('u', 'd'); assert.equal(t.screen(), body, 'removed record/usage/derived views do not return');
    t.press('t', key.down, key.enter); assert.match(t.screen(), /◆ trace 原文/);
    t.press('\t', 'y'); await new Promise(resolve => setImmediate(resolve)); assert.match(t.copied[0], /second original result/);
    t.press(key.esc, key.esc); assert.equal(t.screen(), body);
    t.press(key.esc); assert.equal(t.screen(), session);
    t.press(key.esc); assert.equal(t.screen(), list);
    t.press('c', key.up); await new Promise(resolve => setImmediate(resolve));
    assert.match(t.screen(), /^ {132}\n {2}◆ history/, 'changing the selection must invalidate a pending continuation probe');
    assert.match(t.screen().split('\n').find(line => line.trimStart().startsWith('›'))!, /Other session/);
    assert.equal(t.calls(), 0); assert.equal(watermark(f.dataRoot), through); assert.deepEqual(readFileSync(join(f.dataRoot, 'host.sqlite')), before);
  } finally { await t.app.exit(); }
});

import { readDisplayIndex } from '../src/display-number.js';
import { CONTINUE_TAIL_UNFINISHED, CONTINUE_CLEANED, VERSION_CHANGED_HINT, continueQueued, runVersionChanged } from '../src/continuation.js';
import { readRunRecords } from '../src/query.js';
import { readObject } from '../src/evidence.js';
import { unlinkSync } from 'node:fs';

async function until(predicate: () => boolean, screen: () => string) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error(`history condition did not become ready\n${screen()}`);
}

test('c rejects failed tails, unhandled queue items and missing snapshots while leaving history and all records intact', async () => {
  const f = fixture(), failed = task(f, 'failed', 'Failed task', 'failed'), queued = task(f, 'queued', 'Queued task'), cleaned = task(f, 'cleaned', 'Cleaned task');
  const e = new Evidence(f.dataRoot, 'queued');
  e.append('control.accepted', { requestId: 'pending', taskId: 'pending-task', kind: 'follow-up', input: 'do later', target: { workspace: f.workspace, sessionId: queued, taskId: 'queued-task', runId: 'queued' }, executionVersion: { artifactId: 'v', configSeq: 0, artifactSeq: 0 }, authorization: { tools: ['read'] } }); e.close();
  const snapshot = readRunRecords(f.dataRoot, 'cleaned', { kinds: ['context.snapshot'] }).records[0];
  const messages = JSON.parse(readObject(f.dataRoot, snapshot.ref).toString()).messages;
  unlinkSync(join(f.dataRoot, 'objects', messages.sha256));
  const removal = new Evidence(f.dataRoot, 'cleaned'); removal.append('evidence.availability', { sessionId: cleaned, unitId: `session:${cleaned}`, state: 'cleaned', scope: 'durable session unavailable; host facts retained' }); removal.close();
  const before = readFileSync(join(f.dataRoot, 'host.sqlite')), through = watermark(f.dataRoot), t = open(f), index = readDisplayIndex(f.dataRoot);
  try {
    for (const [session, reason] of [[failed, CONTINUE_TAIL_UNFINISHED], [queued, continueQueued(1)], [cleaned, CONTINUE_CLEANED]]) {
      t.press(`/history ${index.label('session', session)}`, key.enter);
      assert.match(t.screen(), /◆ history/, 'the history command must have opened its target before c');
      t.press('c');
      await until(() => t.screen().includes(reason), t.screen);
      assert.match(t.screen(), /◆ history/);
      if (session === failed) { assert.match(t.screen(), /不能接续 · 链尾任务未完成 · 新任务将开启新会话/); assert.doesNotMatch(t.screen(), /该会话不能接续/); }
      if (session === cleaned) { assert.match(t.screen(), /存储已清理/); t.press(key.enter); assert.match(t.screen(), /┃ Cleaned task/); assert.match(t.screen(), /宿主正文保留/); t.press(key.esc); }
      t.press(key.esc, key.esc);
    }
    assert.equal(t.calls(), 0); assert.equal(watermark(f.dataRoot), through); assert.deepEqual(readFileSync(join(f.dataRoot, 'host.sqlite')), before);
  } finally { await t.app.exit(); }
});

test('show r opens readonly body, show s opens tasks, and c cannot switch show into an execution session', async () => {
  const f = fixture(), session = task(f, 'readonly', 'Readonly body'), before = readFileSync(join(f.dataRoot, 'host.sqlite'));
  for (const show of [{ run: 'readonly' }, { run: 'readonly', session }]) {
    const t = open(f, { show });
    try {
      assert.match(t.screen(), show.session ? /任务 1.*Readonly body/ : /只读 · 不能提交/);
      if (!show.session) t.press(key.esc);
      t.press('c'); assert.match(t.screen(), /只读查看/); assert.match(t.screen(), /◆ history/);
      t.press(key.esc, key.esc, 'must stay a draft', key.enter);
      assert.match(t.screen(), /只读查看 · 不能提交/); assert.equal(t.calls(), 0); assert.deepEqual(readFileSync(join(f.dataRoot, 'host.sqlite')), before);
    } finally { await t.app.exit(); }
  }
});

test('history filter text owns ? and Esc, and applying presets gives the same app result as /history arguments', async () => {
  const f = fixture(); task(f, 'failure', 'Failed selection', 'failed'); task(f, 'success', 'Successful selection');
  const t = open(f);
  try {
    t.press(key.ctrlR, '/', '5', key.enter, '?');
    assert.match(t.screen(), /◆ history · 筛选/);
    const inputRow = t.app.screen().find(line => stripTerminalSequences(line).trim() === '?');
    assert.ok(inputRow, 'the filter keeps ? as input text');
    assert.match(inputRow, /\?\x1b\[7m \x1b\[27m/, 'the public Input displays its block cursor after the text');
    t.press(key.esc); assert.match(t.screen(), /◆ history · 筛选/);
    t.press('4', key.down, '2', key.down, '3', key.enter);
    const filtered = t.screen(); assert.match(filtered, /Failed selection/); assert.doesNotMatch(filtered, /Successful selection/);
    t.press(key.esc, '/history --project all --status failed', key.enter); assert.equal(t.screen(), filtered);
  } finally { await t.app.exit(); }
});

test('empty history opens before the first accepted task and stays a read-only empty result', async () => {
  const f = fixture(), t = open(f);
  try { t.press(key.ctrlR); assert.match(t.screen(), /◆ history/); assert.match(t.screen(), /没有会话/); assert.equal(t.calls(), 0); }
  finally { await t.app.exit(); }
});

import { runCodingTask, runReadTask } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';
import { readSessionChains } from '../src/session-chain.js';

test('c is inert during real runtime work, and another workspace only offers its resume command', async () => {
  const f = fixture(), done = await runReadTask({ ...f, input: 'Previous session', mode: 'offline', transport: demoTransport().fetch }), session = done.sessionId;
  let entered = false;
  const t = open(f, { transport: async (_url, init) => { entered = true; return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('stopped')))); } });
  try {
    t.press('Running work', key.enter); await until(() => entered, t.screen);
    const accepted = readSessionChains(f.dataRoot).list().items[0].id;
    t.press(key.ctrlR, key.down, 'c'); assert.match(t.screen(), /不能接续 · 当前任务运行中/);
    assert.equal(readSessionChains(f.dataRoot).session(session)!.tasks, 1);
    assert.equal(readSessionChains(f.dataRoot).list().items[0].id, accepted);
    t.press(key.esc, '\x03'); await until(() => t.screen().includes('已中止'), t.screen);
  } finally { await t.app.exit(); }
  const other = join(f.root, 'other'); mkdirSync(other);
  const u = open(f, { workspace: other });
  try {
    u.press('/history --project all', key.enter);
    // Original ready session is the older row, while the stopped task is a separate session.
    u.press(key.down, 'c'); await until(() => u.screen().includes('pi-durio resume'), u.screen);
    assert.match(u.screen(), new RegExp(readDisplayIndex(f.dataRoot).label('session', session)));
    assert.equal(u.calls(), 0);
  } finally { await u.app.exit(); }
});

test('c on an original v1 session selects its tail without dispatch, then the next task records the changed version in history', async () => {
  const original = v1FixtureDir, source = v1DataRoot, names = v1Names;
  const sessionId = names['session.read'], oldRun = names['run.read'], workspace = readSessionChains(source).session(sessionId)!.workspace!;
  if (!existsSync(workspace)) { mkdirSync(workspace, { recursive: true }); cpSync(join(original, 'workspace'), workspace, { recursive: true }); }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-history-v1-'))), dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
  cpSync(join(source, 'objects'), join(dataRoot, 'objects'), { recursive: true }); cpSync(join(source, 'host.sqlite'), join(dataRoot, 'host.sqlite'));
  cpSync(join(source, 'sessions', sessionId), join(dataRoot, 'sessions', sessionId), { recursive: true });
  // Isolate the copied completed session from unrelated pending v1 storage paths. The immutable source is never opened writable.
  const db = new DatabaseSync(join(dataRoot, 'host.sqlite')); db.prepare('DELETE FROM records WHERE run_id<>?').run(oldRun); db.close();
  const originalDb = readFileSync(join(source, 'host.sqlite')), index = readDisplayIndex(dataRoot), transport = demoTransport(), t = open({ root, workspace, dataRoot }, { transport: transport.fetch });
  try {
    t.press(`/history ${index.label('session', sessionId)}`, key.enter, 'c', key.esc);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(t.screen(), /^ {132}\n {2}◆ history/, 'Esc back to the list must invalidate the session-layer continuation probe');
    t.press(key.enter, 'c');
    await until(() => t.screen().includes(VERSION_CHANGED_HINT), t.screen);
    assert.equal(transport.calls.length, 0); assert.equal(readSessionChains(dataRoot).session(sessionId)!.tasks, 1);
    t.press('Continue from the original v1 task', key.enter);
    await until(() => readSessionChains(dataRoot).session(sessionId)?.tasks === 2 && (t.app as any).phase === 'idle', t.screen);
    const chains = readSessionChains(dataRoot), tail = chains.session(sessionId)!.tail;
    assert.equal(tail.status, 'completed'); assert.equal(tail.number, 2); assert.deepEqual(chains.contextRunIds(tail.runId), [oldRun, tail.runId]);
    assert.equal(runVersionChanged(dataRoot, tail.runId, chains), true);
    t.press(`/history ${index.label('session', sessionId)}`, key.enter);
    assert.match(t.screen(), /任务 2.*执行版本已变/); assert.match(t.screen(), /任务 1/);
    assert.deepEqual(readFileSync(join(source, 'host.sqlite')), originalDb);
  } finally { await t.app.exit(); }
});

test('body window navigation and mouse paging keep the readonly task when returning from trace originals', async () => {
  const f = fixture();
  const e = new Evidence(f.dataRoot, 'paged');
  e.append('task.accepted', { taskId: 'paged-task', sessionId: randomUUID(), workspace: f.workspace, input: 'Window one', authorization: { tools: ['read'] } });
  e.append('run.started', {});
  for (let n = 0; n < 70; n++) {
    e.append('model.intent', { attemptId: `m${n}`, durableTaskId: n, model: { provider: 'deepseek', id: 'deepseek-flash' }, purpose: 'generation' });
    e.append('model.response', { attemptId: `m${n}`, completeness: 'complete', message: { content: [{ type: 'text', text: `Answer ${n}` }] } });
  }
  e.append('tool.intent', { attemptId: 'large', tool: 'read', args: { path: 'large.txt' } });
  const result = e.append('tool.result', { attemptId: 'large', result: { content: [{ type: 'text', text: Array.from({ length: 100 }, (_, n) => `line ${n}`).join('\n') }] } });
  e.append('tool.summary', { attemptId: 'large', resultSeq: result, isError: false }); e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close();
  const t = open(f, { show: { run: 'paged' } });
  try {
    const current = t.screen(); assert.match(current, /^ {132}\n {2}◆ history/); assert.match(current, /Answer \d+/); assert.doesNotMatch(current, /┃ Window one/);
    t.press('p'); assert.match(t.screen(), /┃ Window one/);
    t.press('n'); assert.equal(t.screen(), current);
    // Scroll to the final tool and click its row, then the shared renderer's paging link.
    for (let i = 0; i < 30; i++) t.press('\x1b[6~');
    let row = t.app.screen().map(stripTerminalSequences).findIndex(line => line.includes('read') && line.includes('large.txt'));
    assert.ok(row >= 0); t.press(`\x1b[<0;4;${row + 1}M`, `\x1b[<0;4;${row + 1}m`);
    t.press('\x1b[6~'); assert.match(t.screen(), /line 0/);
    row = t.app.screen().map(stripTerminalSequences).findIndex(line => line.includes('read') && line.includes('large.txt'));
    assert.ok(row >= 0); t.press(`\x1b[<0;4;${row + 1}M`, `\x1b[<0;4;${row + 1}m`);
    assert.doesNotMatch(t.screen(), /line 0/);
    row = t.app.screen().map(stripTerminalSequences).findIndex(line => line.includes('read') && line.includes('large.txt'));
    assert.ok(row >= 0); t.press(`\x1b[<0;4;${row + 1}M`, `\x1b[<0;4;${row + 1}m`);
    for (let i = 0; i < 30; i++) t.press('\x1b[6~');
    row = t.app.screen().map(stripTerminalSequences).findIndex(line => line.includes('分页查看'));
    assert.ok(row >= 0); const body = t.screen();
    t.press(`\x1b[<0;4;${row + 1}M`, `\x1b[<0;4;${row + 1}m`);
    assert.match(t.screen(), /◆ trace 原文/); t.press(key.esc, key.esc); assert.equal(t.screen(), body);
    assert.equal(t.calls(), 0);
  } finally { await t.app.exit(); }
});

test('c probes a ready coding session owner without taking the lock or switching away from history', async () => {
  const f = fixture(), done = await runCodingTask({ ...f, input: 'Ready coding session', mode: 'offline', transport: demoTransport().fetch });
  const controller = new AbortController(); let owned = false;
  const running = runCodingTask({ ...f, dataRoot: join(f.root, 'other-data'), input: 'Owner held', mode: 'offline', signal: controller.signal, cancellation: 'stop',
    onObservation: event => { if (event.kind === 'ownership.acquired') owned = true; },
    transport: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('stopped')))) });
  const t = open(f), label = readDisplayIndex(f.dataRoot).label('session', done.sessionId);
  try {
    // This view probes ownership; provider entry follows the independent artifact capture.
    await until(() => owned, t.screen);
    t.press(`/history ${label}`, key.enter, 'c'); await until(() => t.screen().includes('工作区被其他进程占用'), t.screen);
    assert.match(t.screen(), /^ {132}\n {2}◆ history/); assert.equal(t.calls(), 0); assert.equal(readSessionChains(f.dataRoot).session(done.sessionId)!.tasks, 1);
  } finally { controller.abort(); await running; await t.app.exit(); }
});

test('c opens recovery for an uncertain tail, and a pending recovery prevents selecting another ready session', async () => {
  const f = fixture(), ready = await runReadTask({ ...f, input: 'Completed session', mode: 'offline', transport: demoTransport().fetch });
  const controller = new AbortController();
  const unknown = await runReadTask({ ...f, input: 'Interrupted session', mode: 'offline', signal: controller.signal, cancellation: 'exit', transport: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Error('interrupted'))); controller.abort(); }) });
  assert.equal(unknown.status, 'unknown');
  const t = open(f), index = readDisplayIndex(f.dataRoot);
  try {
    t.press(`/history ${index.label('session', unknown.sessionId)}`, key.enter, 'c'); await until(() => t.screen().includes('恢复核对 ·'), t.screen);
    assert.equal(t.calls(), 0);
    t.press(key.ctrlR);
    // The interrupted run is latest; the completed session is the next row.
    t.press(key.down, 'c'); assert.match(t.screen(), /不能接续 · 有待处理的恢复核对/); assert.match(t.screen(), /^ {132}\n {2}◆ history/);
    assert.equal(readSessionChains(f.dataRoot).session(ready.sessionId)!.tasks, 1); assert.equal(t.calls(), 0);
  } finally { await t.app.exit(); }
});
