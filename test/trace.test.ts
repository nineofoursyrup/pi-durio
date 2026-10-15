import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { readTrace } from '../src/trace.js';
import { TraceView } from '../src/tui/trace.js';
import { overrideColorTierForTest, COLOR_TIER } from '../src/tui/theme.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';
import { runCodingTask, checkRecovery, recoverRun, compactContext } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { readRunOrdinals } from '../src/display-number.js';

const fixtureData = fileURLToPath(new URL('../../test/fixtures/v1-records/data', import.meta.url));
const names = JSON.parse(readFileSync(fileURLToPath(new URL('../../test/fixtures/v1-records/fixture-identity.json', import.meta.url)), 'utf8')).names as Record<string, string>;
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));

function assertGolden(grid: SnapshotGrid, name: string) {
  const rows = grid.rows.map((row, index) => {
    const runs: string[] = []; let start = 0;
    const style = (c: (typeof row)[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${snapshotText(grid)[index]}|\n   ${runs.join(' ; ')}`;
  });
  const text = `${grid.width}x${grid.height} ${grid.tier}\n${rows.join('\n')}\n`;
  const dir = join(process.cwd(), 'test', 'fixtures', 'snapshots'), path = join(dir, `${name}.txt`);
  if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); return; }
  assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}
function withTier<T>(tier: typeof COLOR_TIER, body: () => T) { const previous = COLOR_TIER; overrideColorTierForTest(tier); try { return body(); } finally { overrideColorTierForTest(previous); } }
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'durio-trace-'));
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'README.md'), 'Trace fixture\n');
  return { workspace: project, dataRoot: join(root, 'data') };
}

test('v1 fixture: readonly continuation segment, v1 skip and interruption excluded from the timeline', () => {
  const trace = readTrace(fixtureData, names['run.recovery-skip']);
  const main = trace.segments.filter(s => s.kind !== 'maintenance');
  assert.deepEqual(main.map(s => s.kind), ['run', 'recovery']);
  assert.equal(main[1].readOnly, true, 'recovery.started capabilities [read] with a skip resolution is the v1 readonly continuation');
  assert.ok(main[1].gap! > 1000, 'the interruption between segments is measured');
  assert.equal(trace.duration, main.reduce((sum, s) => sum + s.end - s.start, 0));
  assert.ok(trace.duration < main[1].gap!, 'header duration excludes the interruption');
  assert.equal(trace.status, 'completed');
  const skipped = trace.spans.filter(s => s.tool?.skipped);
  assert.deepEqual(skipped.map(s => s.tool!.name).sort(), ['read', 'write']);
  assert.deepEqual(trace.spans.filter(s => s.kind === 'llm').map(s => s.llm!.number), [1, 2]);
  const lines = plain(withTier('none', () => new TraceView(fixtureData, names['run.recovery-skip']).render(132, 38, 'Esc 返回会话'))).join('\n');
  assert.match(lines, /┄ 中断 \S+ · 恢复核对 · 只读续跑（首版） ┄/);
  assert.match(lines, /跳过（首版处置）/);
  assert.match(lines, /2 次模型请求（重试 0）/);
});

test('2a golden at 132x38 and the <100 / <60 layouts', () => {
  withTier('truecolor', () => {
    const view = new TraceView(fixtureData, names['run.recovery-skip']);
    view.handleInput('\x1b[B'); view.handleInput('\x1b[B');
    const lines = view.render(132, 38, 'Esc 返回会话');
    assert.equal(lines.length, 38);
    assertGolden(captureSnapshot(lines, 132, 38, 'truecolor'), 'trace-132x38');
  });
  withTier('none', () => {
    const view = new TraceView(fixtureData, names['run.coding']);
    view.handleInput('\x1b[B'); view.handleInput('\x1b[B');
    for (const [width, height] of [[132, 38], [99, 30], [59, 20], [40, 12]] as const) {
      const lines = plain(view.render(width, height, 'Esc 返回会话'));
      assert.equal(lines.length, height, `${width}x${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      const text = lines.join('\n');
      assert.match(text.split('\n').at(-1)!, /Esc 返回会话$/);
      if (width >= 100) { assert.match(text, /│ tool · read/); assert.doesNotMatch(text, /✓ 完成.*\n.*✓ 完成/); }
      else {
        assert.doesNotMatch(text, /│/, 'detail pane collapses below 100');
        assert.match(lines[1], /✓ 完成/, 'header facts move to the second line');
        assert.match(lines.at(-2)!, /^tool read · 已返回 · /, 'selected span summary above the footer');
      }
      if (width < 60) assert.doesNotMatch(text, /█/, 'bar column removed below 60');
      else assert.match(text, /█/);
    }
  });
});

test('bash exit 1: predeclared check vs tool failure; environment names checked for DEEPSEEK_API_KEY; 429 retry chain', async () => {
  const { dataRoot } = await workspace(), runId = '11111111-2222-4333-8444-555555555555';
  const e = new Evidence(dataRoot, runId);
  e.append('task.accepted', { taskId: 'task-1', runId, sessionId: 'session-1', authorization: { tools: ['read', 'write', 'edit', 'bash'] } });
  e.append('execution.config', { toolEnvironment: { version: 'minimal-build-v1', names: ['HOME', 'PATH'] } });
  e.append('run.started', { taskId: 'task-1' });
  e.append('acceptance.requirements', { taskId: 'task-1', necessary: [{ check: { command: 'npm test', passExitCodes: [0], failExitCodes: [1] } }] });
  const llm = (id: string, task: number, status: number, ok: boolean) => {
    e.append('model.intent', { attemptId: id, durableTaskId: task, model: { provider: 'deepseek', id: 'deepseek-flash' }, purpose: 'generation' });
    e.append('model.dispatch', { attemptId: id, purpose: 'generation', transportEntered: true });
    e.append('model.http', { attemptId: id, status });
    e.append('model.response', { attemptId: id, purpose: 'generation', message: ok ? { stopReason: 'stop', usage: { input: 100, cacheRead: 20, cacheWrite: 0, output: 5 } } : { stopReason: 'error', errorMessage: 'rate limited' }, completeness: ok ? 'complete' : 'partial', usage: ok ? 'reported' : 'unknown' });
  };
  const bash = (id: string, task: number, command: string, names: string[]) => {
    e.append('tool.intent', { attemptId: id, durableTaskId: task, callId: id, tool: 'bash', args: { command } });
    e.append('tool.dispatch', { attemptId: id, durableTaskId: task, tool: 'bash' });
    e.append('shell.started', { toolAttempt: { attemptId: id, durableTaskId: task }, acquired: { command, environmentNames: names } });
    e.append('shell.completed', { toolAttempt: { attemptId: id, durableTaskId: task }, acquired: { exitCode: 1, completeness: 'complete' } });
    e.append('tool.error', { attemptId: id, durableTaskId: task, error: 'Command exited with code 1' });
  };
  llm('m1', 9, 200, true);
  bash('t1', 12, 'npm test', ['HOME', 'PATH']);
  bash('t2', 13, 'npm run lint', ['DEEPSEEK_API_KEY', 'HOME', 'PATH']);
  llm('m2', 14, 429, false);
  llm('m3', 14, 200, true);
  e.append('run.closed', { runId, status: 'completed' }); e.close();

  const trace = readTrace(dataRoot, runId);
  const [check, failure] = trace.spans.filter(s => s.kind === 'tool');
  assert.equal(check.outcome, 'ok'); assert.equal(check.tool!.check, true);
  assert.equal(failure.outcome, 'failed'); assert.equal(failure.tool!.check, false);
  assert.equal(check.tool!.env!.apiKey, false); assert.equal(failure.tool!.env!.apiKey, true);
  const retry = trace.spans.find(s => s.llm?.number === 3)!;
  assert.equal(retry.llm!.retryOf, 2); assert.equal(retry.llm!.round, 2);
  assert.equal(trace.counts.retries, 1);
  assert.equal(trace.spans.find(s => s.llm?.number === 2)!.llm!.tokens, null);
  assert.equal(trace.spans.find(s => s.llm?.number === 1)!.llm!.tokens, 125, 'input with cache hits plus output');

  withTier('none', () => {
    const view = new TraceView(dataRoot, runId);
    const at = (key: string) => { view.select(key); return plain(view.render(220, 38, 'Esc 返回会话')).join('\n'); };
    let text = at('t1');
    assert.match(text, /exit 1 · 预先声明的检查，不计运行故障/);
    assert.match(text, /minimal-build-v1 · 2 变量名 · 不含 DEEPSEEK_API_KEY/);
    assert.match(text, /中断后不自动重新执行/);
    text = at('t2');
    assert.match(text, /exit 1 · 计入工具失败/);
    assert.match(text, /3 变量名 · 含 DEEPSEEK_API_KEY/);
    text = at('m3');
    assert.match(text, /llm generation #3 ← #2/);
    assert.match(text, /llm generation #2 429 · 重试/);
    assert.match(text, /llm · #3 {2}generation · 第 2 轮/);
    assert.match(text, /同一逻辑请求的上一次 attempt/);
    assert.match(text, /HTTP 429 · error · 未返回 usage/);
    assert.match(text, /unknown — 不记为 0/);
    assert.match(text, /1 次模型请求|3 次模型请求（重试 1）/);
    assert.match(at('t2').split('\n').at(-2)!, /│/);
    view.select('t2');
    assert.match(plain(view.render(80, 24, 'Esc 返回会话')).at(-2)!, /^tool bash · exit 1 · 计入工具失败 · /);
  });
});

test('recovery segment with denied writes and later manual compaction: request numbers never collide, maintenance excluded', async () => {
  const paths = await workspace(), stop = new AbortController();
  const first = scriptedTransport([{ name: 'bash', args: { command: 'printf effect >> effects.txt' } }]);
  const result = await runCodingTask({ ...paths, input: 'Append once', mode: 'offline', transport: first.fetch, signal: stop.signal, cancellation: 'exit', onObservation: event => { if (event.kind === 'tool.result') stop.abort(); } });
  const authorization = { workspace: paths.workspace, mode: 'offline' as const, tools: ['read', 'write', 'edit', 'bash'] as const };
  const report = await checkRecovery({ ...paths, runId: result.runId, authorization });
  const again = scriptedTransport([{ name: 'write', args: { path: 'equivalent.txt', content: 'must not write' } }]);
  const long: typeof fetch = async (url, init) => { const response = await again.fetch(url, init); return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.', 'FINAL ' + 'x'.repeat(90000)), { headers: { 'content-type': 'text/event-stream' } }); };
  const recovered = await recoverRun({ ...paths, runId: result.runId, authorization, decision: { id: 'no-repeat', snapshotId: report.snapshotId, action: 'continue', acceptAdditionalModelAttempts: true }, transport: long });
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  const compacted = await compactContext({ ...paths, runId: result.runId, requestId: 'trace-maintenance', authorization, transport: scriptedTransport([]).fetch });
  assert.equal(compacted.compaction?.state, 'applied', JSON.stringify(compacted));

  const trace = readTrace(paths.dataRoot, result.runId);
  assert.deepEqual(trace.segments.map(s => s.kind), ['run', 'recovery', 'maintenance']);
  assert.equal(trace.segments[1].readOnly, true);
  const numbers = trace.spans.flatMap(s => s.llm ? [s.llm.number] : s.compaction ? s.compaction.requests.map(r => r.number) : []);
  assert.equal(new Set(numbers).size, numbers.length, 'request numbers do not collide');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers.map((_, i) => i + 1), 'numbered in record order across segments');
  const ordinals = readRunOrdinals(paths.dataRoot, result.runId);
  for (const span of trace.spans.filter(s => s.llm)) assert.equal(ordinals.model.get(span.llm!.attemptId), span.llm!.number, 'same numbering as the 1b transcript');
  const maintenance = trace.spans.filter(s => trace.segments[s.segment].kind === 'maintenance');
  assert.equal(maintenance.length, 1); assert.equal(maintenance[0].compaction!.trigger, 'manual'); assert.equal(maintenance[0].compaction!.state, 'applied');
  assert.equal(trace.maintenance, 1);
  const main = trace.segments.filter(s => s.kind !== 'maintenance');
  assert.equal(trace.duration, main.reduce((sum, s) => sum + s.end - s.start, 0), 'maintenance is not in the header duration');
  assert.equal(trace.counts.models, numbers.length - maintenance[0].compaction!.requests.length);
  const denied = trace.spans.filter(s => s.tool?.denied);
  assert.ok(denied.length >= 1); assert.ok(denied.every(s => s.tool!.name === 'write' || s.tool!.name === 'bash'));
  const view = new TraceView(paths.dataRoot, result.runId);
  const text = plain(withTier('none', () => view.render(132, 38, 'Esc 返回会话'))).join('\n');
  for (const line of text.split('\n')) assert.ok(visibleWidth(line) <= 132, line);
  assert.match(text, /tool write ✗ 被拒/);
  view.select(denied[0].key);
  assert.match(view.summaryLine(), /^tool write · ✗ 被拒 · 只读续跑不允许 write · /);
  assert.match(plain(withTier('none', () => view.render(220, 38, 'Esc 返回会话'))).join('\n'), /结果 +✗ 被拒 · 只读续跑不允许 write/);
  assert.match(text, /只读续跑（首版）/);
  assert.match(text, /┄ 维护 · run 结束后追加，不计入头部耗时与 tok ┄/);
  assert.match(text, /compaction 手动 · llm #\d+/);
  assert.match(text, /另有维护 1 项/);
});

test('live: new spans append while open, running spans spin, the selection stays', async () => {
  const paths = await workspace();
  let view: TraceView | undefined, selected: string | undefined, before = 0, running = false, after = 0, sawSpinner = false;
  const transport = scriptedTransport([{ name: 'read', args: { path: 'README.md' } }, { name: 'read', args: { path: 'README.md' } }]);
  let live = true;
  const result = await runCodingTask({ ...paths, input: 'read twice', mode: 'offline', transport: transport.fetch, onObservation: event => {
    if (event.kind === 'tool.dispatch' && !view) {
      view = new TraceView(paths.dataRoot, event.runId, () => live);
      view.handleInput('\x1b[B');
      withTier('none', () => { const text = plain(view!.render(132, 38, 'Esc 返回会话')).join('\n'); sawSpinner = /tool read README\.md ⠋|tool read README\.md [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text); running = /运行中/.test(text); });
      selected = view.selectedSpan?.key; before = view.trace.spans.length;
    }
  } });
  live = false;
  assert.equal(result.status, 'completed');
  assert.ok(view && selected);
  assert.ok(running, 'header shows the running status'); assert.ok(sawSpinner, 'the running tool span shows a spinner');
  await new Promise(resolve => setTimeout(resolve, 250));
  withTier('none', () => view!.render(132, 38, 'Esc 返回会话'));
  after = view!.trace.spans.length;
  assert.ok(after > before, `spans appended incrementally (${before} → ${after})`);
  assert.equal(view!.selectedSpan?.key, selected, 'selection did not move');
  assert.equal(view!.trace.status, 'completed');
});
