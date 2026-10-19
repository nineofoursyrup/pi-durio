import { dataRoot as runtimeData, names as runtimeNames, readonlyDenialDir } from './v1-runtime-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { HistoryView } from '../src/tui/history.js';
import { readRunRecords } from '../src/query.js';
import { readSessionChains } from '../src/session-chain.js';
import { readDisplayIndex } from '../src/display-number.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';

const text = (view: HistoryView) => view.render(132, 38).map(stripTerminalSequences).join('\n');
test('history groups accepted tasks by session and opens the shared readonly transcript, including pending follow-ups', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-view-')), e = new Evidence(root, 'source');
  e.append('task.accepted', { taskId: 'source-task', sessionId: 'source-session', workspace: '/project', input: 'first task' });
  e.append('run.started', { sessionId: 'source-session' });
  e.append('control.accepted', { requestId: 'next', taskId: 'next-task', kind: 'follow-up', input: 'pending request', target: { workspace: '/project', sessionId: 'source-session', taskId: 'source-task', runId: 'source' }, executionVersion: { artifactId: 'v', configSeq: 0, artifactSeq: 0 }, authorization: { tools: ['read'] } });
  e.close();
  const view = new HistoryView(root, { project: '/project' });
  assert.match(text(view), /◆ history/);
  assert.match(text(view), /1 个任务/);
  view.handleInput('\r');
  assert.match(text(view), /任务 1.*first task/);
  assert.match(text(view), /未运行.*pending request/);
  view.handleInput('\r');
  assert.match(text(view), /只读 · 不能提交/);
  assert.match(text(view), /┃ first task/);
  assert.doesNotMatch(text(view), /#\d+ task.accepted|Enter原文|u用量|d脱敏/);
});

test('history filters use last activity and the same three-dimensional scope as /history parameters', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-filter-'));
  const a = new Evidence(root, 'older'), b = new Evidence(root, 'newer');
  a.append('task.accepted', { taskId: 'ta', sessionId: 'sa', workspace: '/project', input: 'accepted first, active last' });
  b.append('task.accepted', { taskId: 'tb', sessionId: 'sb', workspace: '/project', input: 'accepted second' });
  b.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  a.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); a.close(); b.close();
  const view = new HistoryView(root, { project: '/project' });
  assert.match(text(view).split('\n').find(line => line.startsWith('›'))!, /active last/);
});

import { historyScope, historyCommand, HistoryFilter } from '../src/tui/history-filter.js';
import { parseCommand, CommandError } from '../src/tui/commands.js';
import { visibleWidth } from '@earendil-works/pi-tui';

test('three presets replay as the same /history scope and project names reject ambiguity', () => {
  const now = new Date(2026, 9, 17, 12), workspace = '/projects/current', projects = ['/projects/other', '/one/shared', '/two/shared'];
  const filter = new HistoryFilter(historyScope({}, workspace, projects, now), workspace, projects, now);
  for (const key of ['1', '\x1b[B', '2', '\x1b[B', '5']) filter.preset.handleInput(key);
  const scope = filter.scope!, command = historyCommand(scope);
  const parsed = parseCommand(command, undefined, now);
  assert.deepEqual(historyScope(parsed.options, workspace, projects, now), scope);
  assert.equal(scope.project, undefined); assert.equal(scope.status, 'unknown');
  assert.equal(scope.from, new Date(2026, 9, 11).toISOString()); assert.equal(scope.to, new Date(2026, 9, 18).toISOString());
  const rendered = filter.preset.render(132).map(stripTerminalSequences).join('\n');
  assert.match(rendered, /时间.*近 7 天/); assert.match(rendered, /项目.*全部/); assert.match(rendered, /状态.*待恢复核对/);
  assert.doesNotMatch(rendered, /任务类型|来源|执行版本|provider|完整性/);
  assert.equal(historyScope({ project: 'other' }, workspace, projects).project, '/projects/other');
  assert.equal(historyScope({ project: '/one/shared' }, workspace, projects).project, '/one/shared');
  assert.throws(() => historyScope({ project: 'shared' }, workspace, projects), (error: unknown) => error instanceof CommandError && /\/one\/shared/.test(error.line) && /\/two\/shared/.test(error.line));
});

test('one-sided date scopes stay unchanged when the preset filter opens and applies without editing', () => {
  const now = new Date(2026, 9, 17, 12);
  for (const options of [{ from: '2026-10-01' }, { to: '2026-10-20' }]) {
    const scope = historyScope(options, '/project', [], now), filter = new HistoryFilter(scope, '/project', [], now);
    assert.equal(filter.preset.handleInput('\r'), 'apply'); assert.deepEqual(filter.scope, scope);
    const parsed = parseCommand(historyCommand(filter.scope!), undefined, now);
    assert.deepEqual(historyScope(parsed.options, '/project', [], now), scope);
  }
});

test('session pages preserve selection and n/p windows and never overflow at 132x38, 80x24 or 40x12', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-pages-'));
  for (let n = 0; n < 12; n++) { const e = new Evidence(root, `run-${n}`); e.append('task.accepted', { taskId: `t-${n}`, sessionId: `s-${n}`, workspace: '/project', input: `task-${n} 中文输入` }); e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close(); }
  const view = new HistoryView(root, { project: '/project' });
  for (const [w, h] of [[132, 38], [80, 24], [40, 12]]) { const rows = view.render(w, h); assert.equal(rows.length, h); assert.ok(rows.every(row => visibleWidth(row) <= w)); }
  view.handleInput('\x1b[B'); const firstPage = text(view);
  view.handleInput('n'); assert.match(text(view), /task-3/); assert.doesNotMatch(text(view), /task-11/);
  view.handleInput('p'); assert.equal(text(view), firstPage);
  view.handleInput('\r'); view.handleInput('\r'); view.back(); view.back(); assert.equal(text(view), firstPage);
});

test('v1 recovery notices retain the original skip explanation and readonly recovery facts in the shared transcript', () => {
  const view = new HistoryView(runtimeData, { run: runtimeNames['run.recovery-skip'] });
  assert.match(text(view), /跳过（首版处置）/);
  assert.match(text(view), /Fixture skip decision after an actual unsafe write with unavailable result/);
  assert.match(text(view), /只读续跑/);
});

test('history renders the frozen v1 readonly write refusal without relabeling it as a repeated completed call', () => {
  const fixture = readonlyDenialDir;
  const identity = JSON.parse(readFileSync(join(fixture, 'fixture-identity.json'), 'utf8'));
  const root = join(fixture, 'data'), hostBefore = readFileSync(join(root, 'host.sqlite'));
  const view = new HistoryView(root, { run: identity.names.run }), body = text(view);
  assert.match(body, /只读 · 不能提交/);
  assert.match(body, /只读续跑/);
  assert.match(body, /被拒 · 只读续跑不允许 write/);
  assert.doesNotMatch(body, /该操作已完成，不重做/);
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), hostBefore, 'Reading history leaves the frozen v1 host facts unchanged');
});

test('ordinary read-only recovery retries do not acquire the old restricted-continuation label', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-read-retry-')), e = new Evidence(root, 'read-retry');
  e.append('task.accepted', { sessionId: 'session', taskId: 'task', input: 'Normal read task', authorization: { tools: ['read'] } });
  e.append('recovery.decision', { decision: { id: 'retry', resolutions: [{ choice: 'retry' }] } });
  e.append('recovery.started', { decisionId: 'retry', capabilities: ['read'] }); e.close();
  const view = new HistoryView(root, { run: 'read-retry' });
  assert.match(text(view), /┃ Normal read task/); assert.doesNotMatch(text(view), /只读续跑|首版处置/);
});

test('a completed run with unknown cleanup belongs to the recovery filter, and a cleaned original does not hide its task', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-availability-')), e = new Evidence(root, 'run');
  e.append('task.accepted', { taskId: 'task', sessionId: 'session', workspace: '/project', input: 'Keep the host text' });
  e.append('tool.intent', { attemptId: 'read', tool: 'read', args: { path: 'large.txt' } });
  const result = e.append('tool.result', { attemptId: 'read', result: { content: [{ type: 'text', text: 'removed original' }] } });
  e.append('tool.summary', { attemptId: 'read', resultSeq: result, isError: false });
  e.append('run.closed', { status: 'completed', cleanup: 'unknown' }); e.close();
  const ref = readRunRecords(root, 'run', { kinds: ['tool.result'] }).records[0];
  const removal = new Evidence(root, 'run'); removal.append('evidence.availability', { sourceId: ref.ref.sha256, state: 'cleaned' }); removal.close();
  unlinkSync(join(root, 'objects', ref.ref.sha256));
  const view = new HistoryView(root, { status: 'unknown' });
  assert.match(text(view), /Keep the host text/);
  view.handleInput('\r'); assert.match(text(view), /待恢复核对/); assert.match(text(view), /部分原文已清理/); assert.doesNotMatch(text(view), /存储已清理/);
  view.handleInput('\r'); assert.match(text(view), /┃ Keep the host text/); assert.match(text(view), /部分原文已清理/);
});

function assertGolden(grid: SnapshotGrid, name: string) {
  const rows = grid.rows.map((row, index) => {
    const runs: string[] = []; let start = 0;
    const style = (c: (typeof row)[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${snapshotText(grid)[index]}|\n   ${runs.join(' ; ')}`;
  });
  const content = `${grid.width}x${grid.height} ${grid.tier}\n${rows.join('\n')}\n`, dir = join(process.cwd(), 'test', 'fixtures', 'snapshots'), path = join(dir, `${name}.txt`);
  if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, content); return; }
  assert.equal(content, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}

test('v1 branches retain their own display identity, counts and chain depth and fit narrow terminals', () => {
  const names = runtimeNames, root = runtimeData;
  const chains = readSessionChains(root), index = readDisplayIndex(root), branch = chains.session(names['session.fork-2'])!;
  assert.equal(branch.tasks, 1); assert.equal(branch.first.number, 2);
  const list = new HistoryView(root), session = new HistoryView(root, { session: branch.id });
  assert.match(text(list), new RegExp(`${index.label('session', branch.id)}.*1 个任务`));
  assert.match(text(session), new RegExp(`分支自 ${index.label('session', names['session.coding'])} 任务 1`));
  assert.match(text(session), /任务 2/); assert.doesNotMatch(text(session), /任务 1 ·/);

  for (const [w, h] of [[80, 24], [40, 12]]) {
    for (const view of [new HistoryView(root), new HistoryView(root, { session: branch.id }), new HistoryView(root, { run: branch.first.runId })]) {
      const lines = view.render(w, h); assert.equal(lines.length, h); assert.ok(lines.every(line => visibleWidth(line) <= w));
      assert.match(stripTerminalSequences(lines[0]), /◆ history/); assert.match(stripTerminalSequences(lines.at(-1)!), /Esc/);
      if (view.isBody) assert.match(lines.map(stripTerminalSequences).join('\n'), /只读 · 不能提交/);
    }
  }
});

test('history annotation hooks keep the accepted task identity and selection when saved facts refresh', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-history-annotation-'));
  for (let n = 0; n < 10; n++) { const e = new Evidence(root, `run${n}`); e.append('task.accepted', { taskId: `task${n}`, sessionId: `session${n}`, input: `Task ${n}` }); if (n) e.append('context.imported', { source: { sourceRunId: `run${n - 1}` } }); e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close(); }
  let target: unknown;
  const view = new HistoryView(root, { session: 'session0' }, { annotate: (task, saved) => { target = task; const e = new Evidence(root, 'run9'); e.append('acceptance.judgment', { taskId: task.taskId, result: 'PASS' }); e.close(); saved(); } });
  view.handleInput('n'); view.handleInput('\x1b[B'); const before = text(view);
  view.handleInput('a'); assert.equal(text(view), before);
  assert.deepEqual(target, view.selectedTask); assert.equal(view.selectedTask?.taskId, 'task9'); assert.equal(view.selectedTask?.runId, 'run9'); assert.equal(view.selectedTask?.sessionId, 'session0'); assert.match(view.selectedTask!.acceptedSource, /^e1:/);
});

test('deterministic history layout keeps the mixed rendering fixture golden', () => {
  const fixture = fileURLToPath(new URL('../../test/fixtures/v1-records', import.meta.url));
  const names = JSON.parse(readFileSync(join(fixture, 'fixture-identity.json'), 'utf8')).names, root = join(fixture, 'data');
  const list = new HistoryView(root), session = new HistoryView(root, { session: names['session.fork-2'] });
  assertGolden(captureSnapshot(list.render(132, 38, 'truecolor'), 132, 38, 'truecolor'), 'history-list-132x38');
  assertGolden(captureSnapshot(session.render(132, 38, 'truecolor'), 132, 38, 'truecolor'), 'history-session-132x38');
});
