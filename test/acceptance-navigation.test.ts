import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { watermark } from '../src/history.js';
import { readDisplayIndex } from '../src/display-number.js';
import { queryTaskMetrics, queryFeedbackMetrics } from '../src/metrics/index.js';
import { readAcceptance } from '../src/metrics/acceptance.js';
import { ReadOnlyTui, type TuiOptions } from '../src/tui/app.js';
import { scriptedTransport } from '../src/offline.js';
import { runReadTask } from '../src/runtime.js';

const keys = { enter: '\r', down: '\x1b[B', esc: '\x1b', ctrlA: '\x01' };
const scope = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', asOf: '2100-01-01T00:00:00Z', source: 'synthetic' as const };
const stats = '/stats --from 2000-01-01 --to 2100-01-01 --project all --source synthetic';
class TestTerminal implements Terminal {
 columns = 132; rows = 38; kittyProtocolActive = false; input: (s: string) => void = () => {};
 start(input: (s: string) => void) { this.input = input; }
 stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
 clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function fixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-annotation-nav-'))), workspace = join(root, 'project'), dataRoot = join(root, 'data');
 mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'Annotation fixture\n');
 const task = (input: string) => {
  const runId = randomUUID(), taskId = randomUUID(), sessionId = randomUUID(), e = new Evidence(dataRoot, runId);
  e.append('task.accepted', { taskId, sessionId, workspace, input, origin: { kind: 'coding', source: 'synthetic' } });
  e.append('run.started', {}); e.append('run.closed', { status: 'completed', cleanup: 'confirmed', answer: `Actual result for ${input}` }); e.close();
  return { runId, taskId, sessionId };
 };
 return { root, workspace, dataRoot, first: task('First task'), second: task('Second task') };
}
function open(f: ReturnType<typeof fixture>, options: Partial<TuiOptions> = {}) {
 const terminal = new TestTerminal(); let calls = 0;
 const configuration: TuiOptions = { ...f, mode: 'offline', draftRoot: join(f.root, 'drafts'), terminal, widthCalibration: false, transport: async () => { calls++; throw Error('annotations never call a provider'); }, ...options };
 const app = new ReadOnlyTui(configuration);
 app.start();
 return { app, terminal, configuration, calls: () => calls, press: (...values: string[]) => values.forEach(v => terminal.input(v)), screen: () => app.screen().map(stripTerminalSequences).join('\n') };
}
const contents = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => [join(e.parentPath, e.name).slice(root.length), createHash('sha256').update(readFileSync(join(e.parentPath, e.name))).digest('hex')]).sort();
async function until(check: () => boolean, screen: () => string) {
 for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
 throw Error(`annotation condition did not become ready\n${screen()}`);
}

test('command parameters only prefill; history and stats a append corrections and keep the selected member', async () => {
 const f = fixture(), t = open(f), index = readDisplayIndex(f.dataRoot), before = watermark(f.dataRoot);
 try {
  t.press(`/acceptance ${index.label('task', f.first.taskId)} --verdict pass --intervention none --rework none --note "已核对原结果"`, keys.enter);
  assert.match(t.screen(), /补记 t-/); assert.match(t.screen(), /已核对原结果/);
  assert.equal(watermark(f.dataRoot), before);
  t.press(keys.esc); assert.equal(watermark(f.dataRoot), before);
  t.press(`/acceptance ${f.first.taskId} --verdict pass --intervention none --rework none`, keys.enter);
  assert.equal(watermark(f.dataRoot), before); t.press(keys.enter);
  assert.equal(queryTaskMetrics(f.dataRoot, scope).counts.S, 1);
  assert.equal(queryFeedbackMetrics(f.dataRoot, scope).intervention.counts.Z, 1);
  const original = readAcceptance(f.dataRoot, f.first.taskId);
  t.press(`/history ${index.label('session', f.first.sessionId)}`, keys.enter, 'a');
  assert.match(t.screen(), /◉ 2 通过/); t.press('3', keys.enter);
  assert.match(t.screen(), /◆ history/); assert.match(t.screen(), /First task/);
  assert.equal(queryTaskMetrics(f.dataRoot, scope).tasks[0].acceptance.outcome, 'FAIL');
  assert.deepEqual(readAcceptance(f.dataRoot, f.first.taskId).slice(0, original.length), original);
  t.press(keys.esc, keys.esc, stats, keys.enter, keys.enter, keys.down);
  assert.match(t.screen(), /成员 2\/2/);
  t.press('a'); assert.match(t.screen(), new RegExp(`补记 ${index.label('task', f.second.taskId)}`));
  t.press('2', keys.enter);
  assert.match(t.screen(), /成员 2\/2/); assert.match(t.screen(), /PASS/);
  assert.equal(queryTaskMetrics(f.dataRoot, scope).counts.S, 1);
  t.press(keys.esc); assert.match(t.screen(), /◆ stats/);
  assert.match(t.screen(), /1\/2/); assert.equal(t.calls(), 0);
  t.press(keys.esc); const current = watermark(f.dataRoot);
  t.press('/acceptance --verdict maybe', keys.enter);
  assert.match(t.screen(), /参数有误.*pass fail unknown/); assert.doesNotMatch(t.screen(), /写入记录 · 不调用模型/);
  assert.equal(watermark(f.dataRoot), current);
 } finally { await t.app.exit(); }
});

test('a capability revoked after the form opens still prevents its actual confirmation write', async () => {
 const f = fixture(), t = open(f), before = watermark(f.dataRoot);
 try {
  t.press(`/acceptance ${f.first.taskId} --verdict pass`, keys.enter); assert.match(t.screen(), /补记 t-/);
  t.configuration.show = { run: f.first.runId };
  t.press(keys.enter); assert.match(t.screen(), /只读查看/);
  assert.equal(watermark(f.dataRoot), before); assert.equal(t.calls(), 0);
 } finally { await t.app.exit(); }
});

test('show blocks command, history a and stats a without a record, provider call or writer lease', async () => {
 const f = fixture(), before = contents(f.dataRoot), t = open(f, { show: { run: f.first.runId, session: f.first.sessionId } });
 try {
  t.press('a'); assert.match(t.screen(), /只读查看/); assert.doesNotMatch(t.screen(), /写入记录 · 不调用模型/);
  t.press(keys.esc, keys.esc, `/acceptance ${f.first.taskId} --verdict pass`, keys.enter);
  assert.match(t.screen(), /只读查看/); assert.doesNotMatch(t.screen(), /写入记录 · 不调用模型/);
  t.press(stats, keys.enter, keys.enter, 'a'); assert.match(t.screen(), /只读查看/);
  assert.equal(t.calls(), 0); assert.deepEqual(contents(f.dataRoot), before);
 } finally { await t.app.exit(); }
 assert.deepEqual(contents(f.dataRoot), before);
});

test('a running task never opens an annotation; after completion bare acceptance binds the current session only', async () => {
 const original = fixture(), f = { ...original, dataRoot: join(original.root, 'runtime-data') }, transport = scriptedTransport([]); let entered = false, release!: () => void;
 await runReadTask({ workspace: f.workspace, dataRoot: f.dataRoot, input: 'Earlier completed task', mode: 'offline', transport: scriptedTransport([]).fetch });
 const priorId = queryTaskMetrics(f.dataRoot, scope).tasks[0].taskId;
 const waiting = new Promise<void>(resolve => { release = resolve; });
 const t = open(f, { transport: async (url, init) => { entered = true; await waiting; return transport.fetch(url, init); } });
 try {
  t.press('A new current task', keys.enter); await until(() => entered, t.screen);
  const before = watermark(f.dataRoot);
  t.press(`/acceptance ${priorId} --verdict pass`, keys.enter);
  assert.match(t.screen(), /结束后再记录/); assert.doesNotMatch(t.screen(), /写入记录 · 不调用模型/);
  assert.equal(watermark(f.dataRoot), before);
  release(); await until(() => t.screen().includes('✓ 完成'), t.screen);
  t.press('/acceptance --verdict pass', keys.enter); assert.match(t.screen(), /A new current task/);
  assert.equal(queryTaskMetrics(f.dataRoot, scope).counts.S, 0);
  t.press(keys.enter); const tasks = queryTaskMetrics(f.dataRoot, scope).tasks;
  assert.equal(tasks.at(-1)!.acceptance.outcome, 'PASS');
  assert.equal(tasks.find(task => task.taskId === priorId)!.acceptance.outcome, 'unknown');
  assert.equal(transport.calls.length, 1);
 } finally { release(); await t.app.exit(); }
});
