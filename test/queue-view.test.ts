import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui, type TuiOptions } from '../src/tui/app.js';
import { readQueue, Evidence, readObject, type ControlKind, type QueueStatus } from '../src/evidence.js';
import { runReadTask } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { offlineImproveTransport } from '../src/improve.js';
import { readRunRecords } from '../src/query.js';
import { readSessionChains } from '../src/session-chain.js';
import { readDisplayIndex } from '../src/display-number.js';
import { findQueueItem } from '../src/control.js';
import { readOpenQueue, readQueueReattachment } from '../src/queue.js';
import { QueueStrip, QueueView, queueConfirmation } from '../src/tui/queue.js';
import { ConfirmDialog } from '../src/tui/view-stack.js';
import { captureSnapshot, type SnapshotGrid } from '../src/tui/snapshot.js';
import { overrideColorTierForTest } from '../src/tui/theme.js';
import { createHash } from 'node:crypto';

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false;
  input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(predicate: () => boolean, what: string) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw Error(`${what} timed out`); }
function held() {
  return (async (_url, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"id":"queue-hold","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"Queue hold ready"},"finish_reason":null}]}\n\n'));
      init!.signal!.addEventListener('abort', () => stream.error(Error('stopped')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durio-queue-ui-')), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'queue fixture');
  const terminal = new TestTerminal();
  const app = new ReadOnlyTui({ workspace: realpathSync(workspace), dataRoot, draftRoot: join(root, 'drafts'), mode: 'offline', transport: held(), terminal, widthCalibration: false, copy: async () => true });
  app.start();
  return { app, terminal, dataRoot, workspace: realpathSync(workspace), root, key: (data: string) => terminal.input(data), screen: () => app.screen().map(stripTerminalSequences).join('\n') };
}

test('1b empty Backspace withdraws only the latest pending request; deleting text and repeated Backspace cannot withdraw another', async () => {
  const f = fixture();
  try {
    f.key('Run a held request'); f.key('\r'); await until(() => f.screen().includes('Queue hold ready'), 'running input');
    for (const text of ['first follow-up', 'second follow-up']) { f.key(text); f.key('\x18'); f.key('\r'); await until(() => readQueue(f.dataRoot).items.some(item => item.input === text), 'queue admission'); }
    assert.match(f.screen(), /second follow-up.*Backspace 撤回/);
    f.key('x'); f.key('\x7f'); f.key('\x7f');
    await tick(); assert.ok(readQueue(f.dataRoot).items.every(item => item.status === 'pending'), 'erasing the final character does not also withdraw');
    await new Promise(resolve => setTimeout(resolve, 510));
    f.key('\x7f'); await until(() => readQueue(f.dataRoot).items[1].status === 'withdrawn', 'latest withdrawal');
    f.key('\x7f'); await tick(); assert.equal(readQueue(f.dataRoot).items[0].status, 'pending');
    assert.doesNotMatch(f.screen(), /second follow-up/, 'withdrawn text is not restored into the editor');
    f.key('\x1b[A'); assert.match(f.screen(), /second follow-up/, 'submitted input remains available through editor history');
  } finally { await f.app.exit(); }
});


function project() {
  const root = mkdtempSync(join(tmpdir(), 'durio-queue-view-')), workspace = realpathSync(root), dataRoot = join(root, '..', `${root.split('/').at(-1)}-data`);
  writeFileSync(join(workspace, 'README.md'), 'queue view fixture'); return { root, workspace, dataRoot };
}
function open(f: ReturnType<typeof project>, options: Partial<TuiOptions> = {}) {
  const terminal = new TestTerminal(), copied: string[] = [], transport = scriptedTransport([]);
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', transport: transport.fetch, terminal, widthCalibration: false, copy: async text => { copied.push(text); return true; }, ...options });
  app.start(); return { app, terminal, copied, transport, key: (s: string) => terminal.input(s), screen: () => app.screen().map(stripTerminalSequences).join('\n') };
}
function admitted(f: ReturnType<typeof project>, runId: string, id: string, kind: ControlKind, input: string, status: QueueStatus = 'frozen') {
  const facts = readRunRecords(f.dataRoot, runId, { kinds: ['task.accepted', 'execution.artifact', 'execution.config'] }).records;
  const accepted = JSON.parse(readObject(f.dataRoot, facts.find(ref => ref.kind === 'task.accepted')!.ref).toString()), artifact = facts.find(ref => ref.kind === 'execution.artifact'), config = facts.find(ref => ref.kind === 'execution.config');
  const e = new Evidence(f.dataRoot, runId);
  e.append('control.accepted', { requestId: id, kind, input, taskId: kind === 'follow-up' ? `task-${id}` : null,
    target: { workspace: f.workspace, runId, taskId: accepted.taskId, sessionId: accepted.sessionId }, authorization: accepted.authorization,
    executionVersion: { artifactId: artifact ? JSON.parse(readObject(f.dataRoot, artifact.ref).toString()).id : 'synthetic', artifactSeq: artifact?.seq ?? 0, configSeq: config?.seq ?? 0 } });
  e.append('control.receipt', { requestId: id, status, reason: 'Synthetic queue view fixture · 原目标保持不变' }); e.close();
  return findQueueItem(f.dataRoot, id)!;
}
function recordSession(f: ReturnType<typeof project>, runId: string, parent?: string) {
  const e = new Evidence(f.dataRoot, runId);
  e.append('task.accepted', { taskId: `task-${runId}`, sessionId: `session-${runId}`, runId, workspace: f.workspace, input: `Task ${runId}`, mode: 'offline', authorization: { execution: 'readonly', tools: ['read'] } });
  if (parent) e.append('context.imported', { source: { sourceRunId: parent } });
  e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close();
}
function dataDigest(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name); return [path.slice(root.length), createHash('sha256').update(readFileSync(path)).digest('hex')];
  }).sort(([a], [b]) => a.localeCompare(b));
}

test('clicking the withdrawal label changes only that row; clicking the text has no queue action', async () => {
  const f = fixture();
  try {
    f.key('Run a held request'); f.key('\r'); await until(() => f.screen().includes('Queue hold ready'), 'running input');
    for (const text of ['click first', 'click second']) { f.key(text); f.key('\x18'); f.key('\r'); await until(() => readQueue(f.dataRoot).items.some(item => item.input === text), 'admission'); }
    const rows = f.app.screen().map(stripTerminalSequences), row = rows.findIndex(line => line.includes('click first'));
    const click = (column: number) => { f.key(`\x1b[<0;${column};${row + 1}M`); f.key(`\x1b[<0;${column};${row + 1}m`); };
    click(2); await tick(); assert.ok(readQueue(f.dataRoot).items.every(item => item.status === 'pending'));
    click(visibleWidth(rows[row].slice(0, rows[row].indexOf('撤回'))) + 2);
    await until(() => readQueue(f.dataRoot).items[0].status === 'withdrawn', 'clicked withdrawal');
    assert.equal(readQueue(f.dataRoot).items[1].status, 'pending');
  } finally { await f.app.exit(); }
});

test('the workspace queue reads every fact page, puts the current product session first and excludes closed admissions', () => {
  const f = project(); recordSession(f, 'other'); recordSession(f, 'first'); recordSession(f, 'tail', 'first'); recordSession(f, 'branch', 'first');
  // Batch records without repeatedly querying the growing queue during fixture setup.
  const batch = new Evidence(f.dataRoot, 'other');
  for (let i = 0; i < 203; i++) {
    batch.append('control.accepted', { requestId: `other-${i}`, kind: 'follow-up', input: `Other ${i}`, taskId: `queued-${i}`,
      target: { workspace: f.workspace, runId: 'other', taskId: 'task-other', sessionId: 'session-other' }, executionVersion: { artifactId: 'synthetic', artifactSeq: 0, configSeq: 0 }, authorization: { tools: ['read'] } });
    batch.append('control.receipt', { requestId: `other-${i}`, status: 'frozen', reason: 'Synthetic pagination fixture' });
  }
  batch.close();
  admitted(f, 'branch', 'branch-item', 'compact', 'branch compact');
  admitted(f, 'first', 'first-item', 'steer', 'Old task pending'); admitted(f, 'tail', 'tail-item', 'improve', '{"purpose":"Current analysis"}');
  admitted(f, 'tail', 'closed-item', 'follow-up', 'closed', 'applied'); admitted(f, 'tail', 'withdrawn-item', 'compact', 'withdrawn', 'withdrawn');
  const entries = readOpenQueue(f.dataRoot, f.workspace, 'tail');
  assert.equal(entries.length, 206); assert.deepEqual(entries.slice(0, 2).map(entry => entry.item.requestId), ['first-item', 'tail-item']);
  assert.equal(entries[0].sessionId, entries[1].sessionId); assert.notEqual(entries.find(entry => entry.item.requestId === 'branch-item')!.sessionId, entries[0].sessionId);
  assert.ok(entries.some(entry => entry.item.requestId === 'other-202')); assert.ok(!entries.some(entry => ['closed-item', 'withdrawn-item'].includes(entry.item.requestId)));
});

function golden(grid: SnapshotGrid, name: string) {
  const text = `${grid.width}x${grid.height} ${grid.tier}\n` + grid.rows.map((row, y) => {
    const styles: string[] = []; let from = 0;
    const style = (i: number) => `${row[i].fg ?? '-'}/${row[i].bg ?? '-'}${row[i].bold ? '/b' : ''}`;
    for (let x = 1; x <= row.length; x++) if (x === row.length || style(x) !== style(from)) { styles.push(`${from}-${x - 1} ${style(from)}`); from = x; }
    return `${String(y).padStart(2, '0')}|${row.map(cell => cell.char).join('')}|\n   ${styles.join(' ; ')}`;
  }).join('\n') + '\n';
  const path = join(process.cwd(), 'test', 'fixtures', 'snapshots', `${name}.txt`);
  if (!existsSync(path)) writeFileSync(path, text); else assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name}`);
}

test('queue layout keeps q identifiers at narrow widths, expands full text, copies it and renders bounded strip/132×38 golden', async () => {
  overrideColorTierForTest('truecolor');
  const f = project(); recordSession(f, 'layout');
  admitted(f, 'layout', 'pending-first', 'follow-up', 'First\nFull original second line', 'pending');
  admitted(f, 'layout', 'frozen-second', 'improve', '{"purpose":"Analysis goal"}');
  admitted(f, 'layout', 'unknown-third', 'compact', 'compact', 'dispatching');
  admitted(f, 'layout', 'frozen-fourth', 'follow-up', 'Last frozen');
  const entries = readOpenQueue(f.dataRoot, f.workspace).map(entry => ({ ...entry, item: { ...entry.item, acceptedAt: '2026-10-17T09:00:00.000Z' } }));
  const copied: string[] = [], actions: string[] = [], feedback: string[] = [];
  const view = new QueueView(f.dataRoot, '/workspace/shop', { writeBlocked: () => undefined, feedback: text => feedback.push(text), changed() {}, copy: async text => { copied.push(text); return true; }, withdraw: id => actions.push(`w:${id}`), reattach: id => actions.push(`r:${id}`) });
  view.setEntries(entries); golden(captureSnapshot(view.render(132, 38), 132, 38, 'truecolor'), 'queue-132x38');
  for (const width of [132, 99, 80, 59, 40]) {
    const lines = view.render(width, width === 40 ? 12 : 24), shown = lines.map(stripTerminalSequences).join('\n');
    assert.ok(lines.every(line => visibleWidth(line) <= width)); assert.ok(lines.length <= (width === 40 ? 12 : 24));
    for (const entry of entries) assert.ok(shown.includes(readDisplayIndex(f.dataRoot).label('queue-request', entry.item.requestId)), `${width}: q identifier must remain`);
    if (width < 100) assert.doesNotMatch(shown, /2026-10-17/); if (width < 60) assert.doesNotMatch(shown, /s-[0-9a-f]+/);
  }
  view.handleInput('\r'); assert.match(view.render(132, 38).map(stripTerminalSequences).join('\n'), /Full original second line/);
  view.handleInput('y'); await tick(); assert.equal(copied[0], 'First\nFull original second line');
  view.handleInput('w'); view.handleInput('r'); assert.deepEqual(actions, ['w:pending-first', 'r:pending-first']);
  view.reason('pending-first', '前面还有 1 项未处理'); assert.match(view.render(132, 38).map(stripTerminalSequences).join('\n'), /不可重新接入 · 前面还有 1 项未处理/);
  const strip = new QueueStrip(), rows = strip.render(entries, 132, 38);
  assert.equal(rows.length, 3); assert.match(rows.map(stripTerminalSequences).join('\n'), /First.*Backspace 撤回/); assert.match(rows.map(stripTerminalSequences).join('\n'), /\+2 项 · \/queue/);
  assert.equal(strip.render(entries, 80, 19).length, 1); assert.match(strip.render(entries, 80, 19)[0], /队列 4 项/);
});

test('/reattach only opens a bound confirmation, Esc changes no records, and unavailable r stays on the selected item', async () => {
  const f = project(), first = await runReadTask({ ...f, input: 'Completed UI source', mode: 'offline', transport: scriptedTransport([]).fetch });
  const item = admitted(f, first.runId, 'confirm-ui', 'follow-up', 'Explicit follow-up'), steer = admitted(f, first.runId, 'steer-ui', 'steer', 'Steer text');
  const t = open(f, { resume: first.sessionId });
  try {
    await until(() => t.screen().includes('不能接续'), 'resumed queue');
    const before = dataDigest(f.dataRoot), q = readDisplayIndex(f.dataRoot).label('queue-request', item.requestId);
    t.key(`/reattach ${q}`); t.key('\r'); await until(() => t.screen().includes('重新接入排队请求'), 'confirmation');
    assert.match(t.screen(), /原目标：s-[0-9a-f]+ · 任务 1 · t-[0-9a-f]+ · r-[0-9a-f]+/);
    assert.match(t.screen(), /8 次请求最坏情况预留.*上限约 ¥/); assert.deepEqual(dataDigest(f.dataRoot), before); assert.equal(t.transport.calls.length, 0);
    const plan = readQueueReattachment(f.dataRoot, item, { workspace: f.workspace, mode: 'offline' }); assert.equal(plan.state, 'ready');
    if (plan.state === 'ready') {
      const box = new ConfirmDialog(queueConfirmation(readOpenQueue(f.dataRoot, f.workspace)[0], plan, readDisplayIndex(f.dataRoot)));
      assert.ok(box.render(40, 12).every(line => visibleWidth(line) <= 40));
      const tiny = box.render(40, 5).map(stripTerminalSequences).join('\n'); assert.match(tiny, /窗口过小/); assert.equal(box.handleInput('\r').type, 'noop');
    }
    t.key('\x1b'); assert.deepEqual(dataDigest(f.dataRoot), before);
    t.key('\t'); t.key('r'); assert.match(t.screen(), /不可重新接入 · steer 只能复制后重新提交/); assert.doesNotMatch(t.screen(), /重新接入排队请求/);
    t.key('y'); await tick(); assert.equal(t.copied[0], steer.input);
    t.key('w'); await until(() => findQueueItem(f.dataRoot, steer.requestId)?.status === 'withdrawn' && t.screen().includes('已撤回'), 'w committed feedback');
    t.key('r'); await until(() => t.screen().includes('重新接入排队请求'), 'second confirmation');
    t.key('\r'); await until(() => findQueueItem(f.dataRoot, item.requestId)?.status === 'applied' && t.screen().includes('✓ 完成'), 'reattachment');
    assert.equal(t.transport.calls.length, 1);
  } finally { await t.app.exit(); }
});

test('a committed application wins the withdrawal race and the view reports 已接入，未撤回', async () => {
  const f = project(); recordSession(f, 'race'); const item = admitted(f, 'race', 'race-item', 'follow-up', 'Already committed input', 'pending');
  const t = open(f, { resume: 'session-race' });
  try {
    await until(() => t.screen().includes('不能接续'), 'race view');
    t.key(`/withdraw ${item.requestId}`); t.key('\r');
    // The action has captured its receipt, while the async owner acquisition gives the runtime receipt the race.
    const e = new Evidence(f.dataRoot, 'race'); e.append('control.receipt', { requestId: item.requestId, status: 'applied', reason: 'Already committed before the withdrawal owner was acquired' }); e.close();
    await until(() => t.screen().includes('已接入，未撤回'), 'late withdrawal feedback');
    assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'applied'); assert.equal(t.transport.calls.length, 0);
  } finally { await t.app.exit(); }
});

test('r displays source failure and earlier-item reasons in place without opening a confirmation', async () => {
  const f = project(); recordSession(f, 'failed');
  const failure = new Evidence(f.dataRoot, 'failed'); failure.append('run.closed', { status: 'failed', cleanup: 'confirmed' }); failure.close();
  admitted(f, 'failed', 'failed-item', 'follow-up', 'Failed source text');
  recordSession(f, 'ordered'); const context = new Evidence(f.dataRoot, 'ordered'); context.append('context.snapshot', { messages: context.blob('[]') }); context.close();
  admitted(f, 'ordered', 'earlier-item', 'steer', 'Earlier steer'); admitted(f, 'ordered', 'later-item', 'follow-up', 'Later follow-up');
  const t = open(f);
  try {
    t.key('/queue'); t.key('\r'); t.key('r'); assert.match(t.screen(), /不可重新接入 · 源任务未完成 · 可复制后重新提交/);
    t.key('\t'); t.key('\t'); t.key('r'); assert.match(t.screen(), /不可重新接入 · 前面还有 1 项未处理/); assert.doesNotMatch(t.screen(), /重新接入排队请求/);
    assert.equal(t.transport.calls.length, 0);
  } finally { await t.app.exit(); }
});

test('show queue retains expansion/copy but blocks every write entry and leaves the data root unchanged', async () => {
  const f = project(); recordSession(f, 'readonly'); const item = admitted(f, 'readonly', 'readonly-queue', 'follow-up', 'Readonly queue content', 'pending');
  const before = dataDigest(f.dataRoot), t = open(f, { show: { run: 'readonly' } });
  try {
    t.key('\x1b'); t.key('\x1b'); t.key('\x1b');
    t.key('/queue'); t.key('\r'); t.key('\r'); assert.match(t.screen(), /原目标：/);
    const full = t.app.screen().map(stripTerminalSequences);
    assert.match(full[0], /^ {2}◆ queue /, 'queue occupies the terminal from its first row, inside the side margin');
    assert.match(full.at(-2)!, /Esc 返回会话/, 'the queue footer stays on the last row above the bottom margin');
    assert.match(full.at(-1)!, /^ *$/, 'the bottom margin row is blank');
    t.key('y'); await tick(); assert.equal(t.copied[0], item.input);
    for (const key of ['w', 'r']) { t.key(key); assert.match(t.screen(), /只读查看/); assert.doesNotMatch(t.screen(), /重新接入排队请求/); }
    t.key('\x1b'); t.key('\x7f'); assert.deepEqual(dataDigest(f.dataRoot), before);
    for (const command of [`/withdraw ${item.requestId}`, `/reattach ${item.requestId}`]) { t.key(command); t.key('\r'); assert.match(t.screen(), /只读查看/); }
    assert.equal(t.transport.calls.length, 0); assert.deepEqual(dataDigest(f.dataRoot), before);
  } finally { await t.app.exit(); }
  assert.deepEqual(dataDigest(f.dataRoot), before);
});

test('changed-version improve opens a prefilled second confirmation bound to the original session while the current session remains selected', async () => {
  const f = project(), first = await runReadTask({ ...f, input: 'Original analysis source', mode: 'offline', transport: scriptedTransport([]).fetch });
  const current = await runReadTask({ ...f, input: 'Unrelated current session', mode: 'offline', transport: scriptedTransport([]).fetch });
  const item = admitted(f, first.runId, 'old-improve-ui', 'improve', '{"id":"old-improve-ui","purpose":"Inspect the original goal"}');
  const e = new Evidence(f.dataRoot, 'activation'), content = e.blob('A changed instruction'); e.append('improve.activation', { defaults: [{ current: { workspace: f.workspace, taskType: 'read', files: [{ targetId: 'agents', root: f.workspace, path: 'AGENTS.md', kind: 'prompt-skill', content }] } }] }); e.close();
  const analysis = offlineImproveTransport(), t = open(f, { resume: current.sessionId, transport: analysis.fetch });
  try {
    await until(() => t.screen().includes('✓ 完成'), 'current session');
    t.key(`/reattach ${item.requestId}`); t.key('\r'); await until(() => t.screen().includes('撤回旧分析并重新确认'), 'replacement confirmation');
    assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'frozen');
    t.key('\r'); await until(() => t.screen().includes('新建 improve 分析'), 'launch confirmation');
    assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'withdrawn'); assert.match(t.screen(), /Inspect the original goal/);
    assert.ok(t.screen().includes(readDisplayIndex(f.dataRoot).label('session', first.sessionId))); assert.ok(t.screen().includes(readDisplayIndex(f.dataRoot).label('run', first.runId)));
    assert.equal(readSessionChains(f.dataRoot).list().items.filter(item => item.kind === 'improve').length, 0, 'nothing starts before the second Enter');
    t.key('\r'); await until(() => readSessionChains(f.dataRoot).list().items.some(item => item.kind === 'improve' && item.tail.status === 'completed'), 'analysis done');
    const run = readSessionChains(f.dataRoot).list().items.find(item => item.kind === 'improve')!, ref = readRunRecords(f.dataRoot, run.tailRunId, { kinds: ['improve.started'] }).records[0], started = JSON.parse(readObject(f.dataRoot, ref.ref).toString());
    assert.equal(started.target.runId, first.runId); assert.equal(started.target.sessionId, first.sessionId); assert.equal(started.target.workspace, f.workspace);
    assert.equal(started.request.purpose, 'Inspect the original goal'); assert.notEqual(started.request.id, item.requestId);
    await until(() => t.screen().includes('✓ 完成'), 'main view idle');
    assert.ok(t.screen().includes(readDisplayIndex(f.dataRoot).label('run', current.runId)), 'analysis does not replace the current conversation');
  } finally { await t.app.exit(); }
});

test('Backspace during an executing follow-up withdraws only its inherited latest pending sibling, never the executing or unrelated admission', async () => {
  const f = project(); recordSession(f, 'unrelated'); const unrelated = admitted(f, 'unrelated', 'unrelated-pending', 'follow-up', 'Other session pending', 'pending');
  let calls = 0, releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; }), first = scriptedTransport([]), hold = held();
  const transport: typeof fetch = async (url, init) => { calls++; if (calls === 1) { await gate; return first.fetch(url, init); } return hold(url, init); };
  const t = open(f, { transport });
  try {
    t.key('Initial task'); t.key('\r'); await until(() => calls === 1, 'initial active runtime');
    for (const input of ['First follow-up is running', 'Second follow-up stays pending']) {
      t.key(input); t.key('\x18'); t.key('\r'); await until(() => readOpenQueue(f.dataRoot, f.workspace).some(entry => entry.item.input === input), 'follow-up admission');
    }
    releaseFirst(); await until(() => calls === 2 && t.screen().includes('Queue hold ready'), 'first follow-up running');
    const items = readQueue(f.dataRoot).items, running = items.find(item => item.input === 'First follow-up is running')!, pending = items.find(item => item.input === 'Second follow-up stays pending')!;
    assert.equal(running.status, 'applied'); assert.equal(pending.status, 'pending'); assert.match(t.screen(), /Second follow-up stays pending.*Backspace 撤回/);
    t.key('\x7f'); await until(() => findQueueItem(f.dataRoot, pending.requestId)?.status === 'withdrawn' && t.screen().includes('已撤回'), 'inherited withdrawal');
    assert.equal(findQueueItem(f.dataRoot, running.requestId)!.status, 'applied'); assert.equal(findQueueItem(f.dataRoot, unrelated.requestId)!.status, 'pending');
    t.key(`/withdraw ${unrelated.requestId}`); t.key('\r'); await until(() => t.screen().includes('队列决定未执行'), 'unrelated refusal');
    assert.equal(findQueueItem(f.dataRoot, unrelated.requestId)!.status, 'pending');
    t.key(`/withdraw ${running.requestId}`); t.key('\r'); await until(() => t.screen().includes('已接入，未撤回'), 'running admission refusal');
    assert.equal(calls, 2);
  } finally { releaseFirst(); await t.app.exit(); }
  assert.equal(findQueueItem(f.dataRoot, unrelated.requestId)!.status, 'pending');
});
