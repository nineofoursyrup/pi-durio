import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { RunView, sumUsage } from '../src/tui/run-view.js';
import { formatCostTotals } from '../src/cost-estimate.js';
import { readRunRecords } from '../src/query.js';
import { readTrace } from '../src/trace.js';
import { RawContent } from '../src/trace-raw.js';
import { narrowing, statusParts, toolLines, headerLine, statusLine, type HeaderState } from '../src/tui/session-screen.js';
import { overrideColorTierForTest } from '../src/tui/theme.js';
import { captureSnapshot, type SnapshotGrid } from '../src/tui/snapshot.js';
import { ReadOnlyTui } from '../src/tui/app.js';

overrideColorTierForTest('truecolor');
const plain = (line: string) => stripTerminalSequences(line);
const tick = () => new Promise(r => setTimeout(r, 30));
async function until(predicate: () => boolean, what = 'condition') { for (let i = 0; i < 600; i++) { if (predicate()) return; await tick(); } throw Error(`${what} timed out`); }

function records() {
  const root = mkdtempSync(join(tmpdir(), 'durio-1b-')), runId = 'run-1b';
  const evidence = new Evidence(root, runId);
  return { root, runId, append: (kind: string, data: unknown) => evidence.append(kind, data), close: () => evidence.db.close() };
}

test('run usage follows new intents and dispatch outcomes before any response, and reuses unchanged facts', () => {
  const r = records(), view = new RunView(r.root, r.runId);
  const intent = (attemptId: string) => r.append('model.intent', { attemptId, durableTaskId: 9, purpose: 'generation', model: { provider: 'deepseek', id: 'deepseek-flash' } });
  try {
    assert.equal(formatCostTotals(sumUsage([view.usage()]).totals), '≈ ¥0.00');
    intent('pending');
    const pending = view.usage();
    assert.equal(pending.requests[0]?.state, 'unknown');
    assert.ok(pending.requests[0].gaps.includes('transport entry not proven'));
    r.append('model.dispatch', { attemptId: 'pending', transportEntered: true });
    const dispatched = view.usage();
    assert.equal(formatCostTotals(sumUsage([dispatched]).totals), '+1 unknown');
    assert.ok(!dispatched.requests[0].gaps.includes('transport entry not proven'));

    intent('not-admitted');
    assert.equal(sumUsage([view.usage()]).totals.unknownRequests, 2);
    r.append('model.dispatch-failed', { attemptId: 'not-admitted', dispatched: false, attemptDispatched: false });
    const settled = view.usage();
    assert.equal(settled.requests[1].state, 'not-applicable');
    assert.equal(formatCostTotals(sumUsage([settled]).totals), '+1 unknown');
    assert.strictEqual(view.usage(), settled, 'unchanged usage facts reuse the projection');
    r.append('tool.intent', { attemptId: 'tool-1', durableTaskId: 12, tool: 'read', args: { path: 'README.md' } });
    assert.strictEqual(view.usage(), settled, 'unrelated tool facts do not trigger a full usage reread');
  } finally { r.close(); }
});

test('run usage observes sourced estimate revisions and provider usage details after the response', () => {
  const r = records(), view = new RunView(r.root, r.runId), attemptId = 'priced';
  try {
    r.append('model.intent', { attemptId, durableTaskId: 9, purpose: 'generation', model: { provider: 'deepseek', id: 'deepseek-flash' } });
    r.append('model.dispatch', { attemptId, transportEntered: true });
    r.append('model.response', { attemptId, usage: 'reported', completeness: 'complete', message: { usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 } } });
    const original = view.usage().requests[0];
    const estimate = { method: 'explicit-sourced-estimate-v1', requestSource: original.source, usageSources: original.usageSources, currency: 'CNY', price: { source: 'explicit tariff', version: 'explicit-v1', effectiveAt: '2000-01-01T00:00:00Z', provider: 'deepseek', model: 'deepseek-flash' } };
    r.append('cost.estimate', { ...estimate, id: 'first', amount: 3 });
    assert.equal(formatCostTotals(sumUsage([view.usage()]).totals), '≈ ¥3.00');
    r.append('cost.estimate', { ...estimate, id: 'revised', revisionOf: 'first', amount: 2 });
    const revised = view.usage();
    assert.equal(formatCostTotals(sumUsage([revised]).totals), '≈ ¥2.00');
    assert.equal(revised.tokens, 1200, 'price revisions preserve reported token usage');

    r.append('model.provider-event', { attemptId, event: { usage: { prompt_tokens: 1000, completion_tokens: 200 } } });
    assert.equal(view.usage().requests[0].state, 'partial', 'late provider details can establish incomplete usage');
    r.append('model.provider-event', { attemptId, event: { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 0 } } });
    const complete = view.usage();
    assert.equal(formatCostTotals(sumUsage([complete]).totals), '≈ ¥2.00');
    assert.strictEqual(view.usage(), complete);
  } finally { r.close(); }
});

test('第 M 轮 counts task requests only: a compaction request is not a round, a retry is another round flagged as 重试', async () => {
  const r = records();
  const intent = (attemptId: string, compaction = false) => r.append('model.intent', compaction ? { purpose: 'compaction', durableTaskSource: 'unknown', ordinal: 0, durableTaskId: null, attemptId } : { attemptId, durableTaskId: 9, ordinal: 0, purpose: 'generation' });
  const response = (attemptId: string, completeness: 'complete' | 'partial') => r.append('model.response', { attemptId, purpose: 'generation', message: { content: [] }, completeness });
  r.append('run.started', { taskId: 't' });
  intent('a1'); response('a1', 'complete');
  intent('c1', true); response('c1', 'complete');
  const view = new RunView(r.root, r.runId);
  assert.deepEqual({ ...view.updateProgress(), segmentStart: undefined }, { round: 1, retry: false, segmentStart: undefined });
  intent('a2');
  assert.equal(view.updateProgress().round, 2);
  // Interrupted with no response; recovery opens a new execution segment and re-requests the same turn.
  await new Promise(r => setTimeout(r, 40));
  const recovery = r.append('recovery.started', { decisionId: 'd' });
  intent('a3');
  let progress = view.updateProgress();
  assert.equal(progress.round, 3); assert.equal(progress.retry, true, 'the re-request after an incomplete one is a retry');
  const started = readRunRecords(r.root, r.runId, { after: recovery - 1, limit: 1 }).records[0];
  assert.equal(progress.segmentStart, started.at, 'the timer starts at recovery.started, excluding the interruption');
  response('a3', 'complete'); intent('a4');
  progress = view.updateProgress();
  assert.equal(progress.round, 4); assert.equal(progress.retry, false);
  const running = statusParts({ phase: 'running', recovery: false, round: 3, retry: true, elapsedMs: 65_000, frame: 2 });
  assert.equal(running.left.map(s => s.text).join(''), '⠹ 重试 · 第 3 轮 · 01:05'); assert.equal(running.left[1].fg, 'ac.warn'); assert.equal(running.hint, 'Esc 中止当前任务');
  r.close();
});

test('tool rows summarize only held facts: read lines, edit/write +N −M, bash exit N · M 行; failed output stays visible while folded', async () => {
  const r = records(), at = (id: string) => ({ attemptId: id, durableTaskId: 1 });
  const tool = (id: string, name: string, args: unknown, result: unknown, error?: string, extra?: () => void) => {
    r.append('tool.intent', { ...at(id), tool: name, args });
    extra?.();
    const seq = error ? r.append('tool.error', { ...at(id), error }) : r.append('tool.result', { ...at(id), result });
    r.append('tool.summary', { attemptId: id, tool: name, isError: !!error, ...(error ? { errorSeq: seq } : { resultSeq: seq }), diagnostics: [], diagnosticsOmitted: 0, truncation: null });
  };
  tool('r1', 'read', { path: 'src/cart/total.ts' }, { content: [{ type: 'text', text: Array.from({ length: 142 }, (_, i) => `line ${i}`).join('\n') }] });
  tool('r2', 'read', { path: 'big.ts', offset: 40, limit: 10 }, { content: [{ type: 'text', text: 'a\n'.repeat(10) }] });
  tool('e1', 'edit', { path: 'src/cart/total.ts', edits: [] }, { content: [{ type: 'text', text: 'ok' }], details: { diff: ' 38 export function cartTotal() {\n-39   const sum = 1\n+39   const cents = 1\n+40   const off = 2\n 41 }' } });
  tool('w1', 'write', { path: 'notes.md', content: 'x' }, { content: [{ type: 'text', text: 'Successfully wrote to notes.md' }] }, undefined,
    () => r.append('file.write-intent', { toolAttempt: at('w1'), acquired: { path: 'notes.md', previous: Buffer.from('old 1\nold 2\n').toString('base64'), content: Buffer.from('new 1\nnew 2\nnew 3\n').toString('base64'), encoding: 'base64' } }));
  const output = Array.from({ length: 20 }, (_, i) => `out ${i + 1}${i === 19 ? '\x07' : ''}`).join('\n') + '\n';
  tool('b1', 'bash', { command: 'npm test -- cart' }, undefined, 'localized shell \x07failure', () => {
    r.append('shell.started', { toolAttempt: at('b1'), acquired: { command: 'npm test -- cart' } });
    r.append('shell.completed', { toolAttempt: at('b1'), acquired: { exitCode: 1 } });
    // Output chunks are byte slices; one splits a line.
    const bytes = Buffer.from(output);
    r.append('tool.output', { toolAttempt: at('b1'), acquired: { stream: 'stdout', index: 0, bytes: bytes.subarray(0, 37).toString('base64') } });
    r.append('tool.output', { toolAttempt: at('b1'), acquired: { stream: 'stdout', index: 1, bytes: bytes.subarray(37).toString('base64') } });
  });
  tool('b2', 'bash', { command: 'true' }, { content: [] }, undefined, () => r.append('shell.completed', { toolAttempt: at('b2'), acquired: { exitCode: 0 } }));
  const view = new RunView(r.root, r.runId);
  {
    const window = readRunRecords(r.root, r.runId, { limit: 50 }).records;
    const tools = view.project(window, { active: false }).filter(entry => entry.kind === 'tool');
    assert.deepEqual(tools.map(entry => entry.kind === 'tool' && `${entry.tool} ${entry.args} ${entry.summary}`), [
      'read src/cart/total.ts 142 行', 'read big.ts 第 40–49 行', 'edit src/cart/total.ts +2 −1', 'write notes.md +3 −2', 'bash npm test -- cart exit 1 · 20 行', 'bash true exit 0 · 0 行']);
    const bash = tools[4] as Extract<typeof tools[number], { kind: 'tool' }>;
    const trace = readTrace(r.root, r.runId).spans.find(span => span.key === 'b1')!;
    const original = new RawContent(r.root, trace.raws.find(raw => raw.label === 'stdout')!).page(0);
    assert.equal(original.text, output, '2a paginates only the captured bash output');
    assert.equal(original.text.trimEnd().split('\n').length, 20);
    assert.equal(new RawContent(r.root, trace.raws.find(raw => raw.label === '错误')!).page(0).text, 'localized shell \x07failure');
    const folded = toolLines(bash, 80, false, Date.now(), 0);
    assert.equal(plain(folded.row).trimEnd(), '✗ bash npm test -- cart exit 1 · 20 行');
    assert.deepEqual(folded.body.map(line => plain(line).trim()), ['out 15', 'out 16', 'out 17', 'out 18', 'out 19', 'out 20\x07', 'localized shell failure']);
    assert.equal(plain(folded.paging!).trim(), '显示 6/20 行 ⋯ 截断 · 原文完整保存 · 分页查看 14 行');
    assert.equal(captureSnapshot([folded.body.at(-1)!], 80, 1, 'truecolor').rows[0][4].fg, 'ac.err', 'the separate recorded error keeps the failure style');
    const expanded = toolLines(bash, 80, true, Date.now(), 0);
    assert.equal(expanded.body.length, 21); assert.equal(expanded.paging, undefined);
    const ok = toolLines(tools[0] as any, 80, false, Date.now(), 0);
    assert.equal(ok.body.length, 0, 'successful output is folded by default'); assert.equal(ok.paging, undefined);
    const edit = toolLines(tools[2] as any, 80, true, Date.now(), 0);
    assert.deepEqual(edit.body.map(line => plain(line).trim()), ['38 export function cartTotal() {', '−39   const sum = 1', '+39   const cents = 1', '+40   const off = 2', '41 }']);
    const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace: r.root, dataRoot: r.root, draftRoot: join(r.root, 'drafts'), mode: 'offline', show: { run: r.runId }, terminal, widthCalibration: false });
    const screen = () => app.screen().map(plain).join('\n');
    try {
      app.start(); terminal.input('\x1b'); // Return from the initial history view to the 1b session screen.
      await until(() => screen().includes('out 20'), 'failed bash on 1b');
      assert.match(screen(), /^ {6}out 20� *$/m, '1b replaces control characters in tool output');
      assert.match(screen(), /^ {6}localized shell �failure *$/m, '1b applies the same replacement to the recorded error');
    } finally { await app.exit(); r.close(); }
  }
});

test('narrow terminals drop the status hint first, then the header task·round', () => {
  const header: HeaderState = { workspace: '~/code/shop-api', readOnly: false, session: 's-7f3a', run: 'r-0207', task: 2, round: 3 };
  const status = statusParts({ phase: 'running', recovery: false, round: 3, retry: false, elapsedMs: 42_000, frame: 2 });
  const at = (width: number) => narrowing(width, header, status);
  assert.deepEqual(at(132), { headerRight: true, statusHint: true });
  let dropped = false;
  for (let width = 132; width >= 20; width--) {
    const fit = at(width);
    if (!fit.headerRight) assert.equal(fit.statusHint, false, `${width}: header right goes only after the status hint`);
    if (!fit.statusHint) dropped = true; else assert.equal(dropped, false, 'once dropped, the hint stays dropped');
    for (const line of [headerLine(header, width, fit.headerRight), statusLine(status, width, fit.statusHint)]) assert.equal(visibleWidth(line), width);
  }
  assert.deepEqual(at(40), { headerRight: false, statusHint: false });
});

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {}
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
/** Text golden with style runs; timers, spinner frames, display-number hex and ctx digits are masked in place (same width). */
function assertGolden(grid: SnapshotGrid, name: string) {
  const masks: [RegExp, (m: string) => string][] = [[/\d\d:\d\d/g, () => '00:00'], [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, () => '⠋'], [/\b(s|r|q|ir|tc)-[0-9a-f]{4,}/g, m => m.replace(/(?<=-.*)[0-9a-f]/g, 'x')], [/ctx ≈?[\d.]+k?/g, m => m.replace(/\d/g, '9')]];
  const rows = grid.rows.map((row, index) => {
    let text = row.map(cell => cell.char).join('');
    for (const [pattern, replace] of masks) text = text.replace(pattern, replace);
    const runs: string[] = []; let start = 0;
    const style = (c: (typeof row)[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${text}|\n   ${runs.join(' ; ')}`;
  });
  const text = `${grid.width}x${grid.height} ${grid.tier}\n${rows.join('\n')}\n`;
  const dir = join(process.cwd(), 'test', 'fixtures', 'snapshots'), path = join(dir, `${name}.txt`);
  if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); return; }
  assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}

test('1b running and idle at 132×38 (golden); 80×24 and 40×12 never overflow', async t => {
  // Fix the golden's tariff period; real timers and paid/native acceptance remain separate.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T05:00:00Z') });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-1b-golden-'))), workspace = join(root, 'project');
  mkdirSync(workspace); writeFileSync(join(workspace, 'total.ts'), 'export const total = 1;\nexport const tax = 0;\n');
  writeFileSync(join(workspace, 'hold.cjs'), "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);console.log('released');}},20);");
  writeFileSync(join(workspace, 'cart.test.cjs'), "for(let i=1;i<=20;i++)console.log('case '+i+(i===18?' FAIL expected 80.00 received 80.01':' ok'));process.exit(1);");
  const steps: { text?: string; calls?: { name: string; args: unknown }[] }[] = [
    { text: '先读一下 `total.ts`。', calls: [{ name: 'read', args: { path: 'total.ts' } }] },
    { calls: [{ name: 'edit', args: { path: 'total.ts', edits: [{ oldText: 'export const tax = 0;', newText: 'export const tax = 0;\nexport const cents = 100;' }] } }] },
    { calls: [{ name: 'write', args: { path: 'notes.md', content: '# notes\n改为以分为单位\n' } }] },
    { calls: [{ name: 'bash', args: { command: 'node cart.test.cjs' } }] },
    { text: '测试仍用旧的 `discount()` 期望值，正在更新并重跑。', calls: [{ name: 'bash', args: { command: 'node hold.cjs' } }] },
    { text: '已改为以「分」为单位累加，`cartTotal()` 不再逐行四舍五入。' },
  ];
  let call = 0;
  const transport: typeof fetch = async () => {
    const step = steps[call++] ?? { text: 'done' };
    const delta = { ...(step.text ? { content: step.text } : {}), ...(step.calls ? { tool_calls: step.calls.map((c, index) => ({ index, id: `s${call}-${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) };
    const frame = (choices: unknown[], usage?: unknown) => ({ id: `g-${call}`, model: 'deepseek-flash-offline-fixture', choices, ...(usage ? { usage } : {}) });
    const frames = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }]), frame([], { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 })];
    return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const home = process.env.HOME;
  process.env.HOME = root; // The header abbreviates the workspace under HOME as ~/…
  const terminal = new TestTerminal();
  const app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', transport, terminal, widthCalibration: false, copy: async () => true, coding: true });
  const lines = () => app.screen().map(line => line.replace(/\x1b\]8;;[^\x07]*\x07/g, ''));
  const screen = () => lines().map(plain).join('\n');
  const fits = (columns: number, rows: number) => {
    terminal.columns = columns; terminal.rows = rows; terminal.resize();
    const shown = lines();
    assert.ok(shown.length <= rows, `${columns}×${rows} rows`);
    for (const line of shown) assert.ok(visibleWidth(line) <= columns, `${columns}×${rows}: ${plain(line)}`);
    terminal.columns = 132; terminal.rows = 38; terminal.resize();
  };
  try {
    app.start();
    terminal.input('修复满减后 0.01 的金额误差并跑相关测试'); terminal.input('\r');
    await until(() => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash node hold\.cjs 运行中 · \d\d:\d\d/.test(screen()), 'held bash');
    const running = screen();
    assert.match(running, /任务 1 · 第 5 轮/); assert.match(running, / 运行 · 第 5 轮 · \d\d:\d\d +Esc 中止当前任务/);
    assert.match(running, /✓ read total\.ts 2 行/); assert.match(running, /✓ edit total\.ts \+1 −0/); assert.match(running, /✓ write notes\.md \+2 −0/);
    assert.match(running, /✗ bash .* exit 1 · 20 行/); assert.match(running, /case 20 ok/); assert.match(running, /显示 6\/20 行 ⋯ 截断 · 原文完整保存 · 分页查看 14 行/);
    assert.match(running, /本任务 6k tok/, 'running footer: this task only');
    assert.match(running, /Ctrl\+O 展开/);
    assertGolden(captureSnapshot(lines(), 132, 38, 'truecolor'), '1b-running-132x38');
    fits(80, 24); fits(40, 12);
    writeFileSync(join(workspace, 'release'), '');
    await until(() => screen().includes('✓ 完成'), 'completion');
    terminal.input('\x1b[I'); // any key restores the key hints
    assert.match(screen(), /任务 1 · ✓ 完成/); assert.match(screen(), /本会话 7\.2k tok/);
    assertGolden(captureSnapshot(lines(), 132, 38, 'truecolor'), '1b-idle-132x38');
    fits(80, 24); fits(40, 12);
    // Ctrl+O expands every tool row (a successful write shows its lines; failed output shows more than 6), again folds them.
    terminal.input('\x0f'); assert.match(screen(), /^ {6}case 1 ok/m);
    // 宽敞窗口的分隔线、主区顶部空行与底部留白（U10）少占了几行：展开的 write 在上一页。
    terminal.input('\x1b[5~'); assert.match(screen(), /^ {6}\+2 改为以分为单位/m); terminal.input('\x1b[6~');
    terminal.input('\x0f'); assert.doesNotMatch(screen(), /^ {6}case 1 ok/m);
    // A follow-up task continues the chain: task 2, with the preceding-task line opening the session layer.
    terminal.input('再检查 0 元订单'); terminal.input('\r');
    await until(() => /任务 2 · ✓ 完成/.test(screen()), 'second task');
    assert.match(screen(), /会话中前 1 个任务 · \/history s-[0-9a-f]{4,} 只读查看/);
    assert.match(screen(), /本会话 8\.4k tok/, 'idle footer sums the chain');
  } finally { process.env.HOME = home; await app.exit(); }
});
