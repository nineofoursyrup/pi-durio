process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { StatsView, metricRows, spendRows, statsRequest, readStats, type StatsData, type StatsFigures, type StatsRequest } from '../src/tui/stats.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';
import { CommandError } from '../src/tui/commands.js';
import { queryTaskMetrics, queryOperationsMetrics, queryFeedbackMetrics } from '../src/metrics/index.js';
import { watermark } from '../src/history.js';
import type { CostTotals } from '../src/cost-estimate.js';

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

const MIN = 60_000, HOUR = 60 * MIN;
const totals = (CNY: number | null, unknownRequests = 0, partial = false): CostTotals => ({ amounts: CNY === null ? {} : { CNY }, unknownRequests, partial });
/** 六个 oracle 示例（docs/design/llmops-metrics-and-feedback.md 例 1–6）合成一屏。 */
function oracle(): StatsFigures {
  return {
    // 例 1：10 受理、8 启动、6 正常完成、5 可评分、4 通过
    acceptance: { N: 10, B: 8, C: 6, G: 5, S: 4 },
    // 例 2：样本累计完整已知 ¥80，S=4
    cost: totals(80),
    // 例 3：执行 12 分钟 = 排队 2 + 用户等待 3 + 活跃 7；验收 24 小时
    clocks: { execution: { mean: 12 * MIN, valid: 6, total: 10 }, acceptance: { mean: 24 * HOUR, valid: 5, total: 10 }, segments: [{ kind: 'queue', meanMs: 2 * MIN }, { kind: 'user-wait', meanMs: 3 * MIN }, { kind: 'active', meanMs: 7 * MIN }] },
    // 例 4：Ni=8，I=2，Z=3，U=3
    intervention: { Ni: 8, I: 2, Z: 3, U: 3, openPositive: 0 },
    // 例 5：P=4，V=3，R=1；返工成熟 3，Rr=1，Zr=1，Ur=1，未成熟阳性 1
    regression: [{ label: 'ep-c03e', at: '2026-10-10T02:00:00.000Z', P: 4, V: 3, R: 1 }],
    rework: { Nr: 3, Rr: 1, Zr: 1, Ur: 1, immaturePositive: 1 },
    // 例 6：B=8，F=2，Zf=5，Uf=1
    faults: { B: 8, F: 2, Zf: 5, Uf: 1 },
    // 例 2 的窗口：eval ¥20、improve ¥10、维护 ¥5、确定不属于样本的未归属 ¥3，合计 ¥118
    spend: {
      rows: [
        { kind: 'coding', totals: totals(80), tokens: 412_000 },
        { kind: 'eval', totals: totals(20), tokens: 96_000 },
        { kind: 'improve', totals: totals(10), tokens: 51_000 },
        { kind: 'maintenance', totals: totals(5), tokens: 24_000 },
        { kind: 'unassigned', totals: totals(3), tokens: 14_000 },
      ],
      total: { totals: totals(118), tokens: 597_000 },
    },
  };
}
const NOW = new Date('2026-10-15T06:05:00.000Z'); // 本机 10-15 14:05
const request = (options: Record<string, string> = {}): StatsRequest => statsRequest(options, '/Users/me/code/shop-api', NOW);
const data = (figures: StatsFigures, req = request()): StatsData => ({ scope: req.scope, sample: { N: figures.acceptance.N, excluded: 3 }, versions: { ids: ['f26ae8f0123456789'], unknown: 0 }, figures });
const view = (figures = oracle(), req = request()) => new StatsView(req, () => data(figures, req));
const text = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');
const row = (f: StatsFigures, label: string) => { const r = metricRows(f).find(r => r.label === label)!; return { value: r.value.text + (r.value.unit ?? ''), tone: r.value.tone, scope: r.scope.map(s => s.text).join(''), coverage: r.coverage.map(s => s.text).join('').trim(), bar: r.bar }; };

test('default scope: 30 whole local days [today-29, tomorrow), current workspace project, ordinary source, as_of now', () => {
  const r = request();
  assert.equal(r.scope.from, new Date('2026-09-15T16:00:00.000Z').toISOString());
  assert.equal(r.scope.to, new Date('2026-10-15T16:00:00.000Z').toISOString());
  assert.equal(r.scope.asOf, NOW.toISOString());
  assert.equal(r.scope.project, '/Users/me/code/shop-api');
  assert.equal(r.scope.source, 'ordinary');
  assert.equal(r.command, '/stats --from 2026-09-16 --to 2026-10-16 --as-of 2026-10-15T06:05:00.000Z --project /Users/me/code/shop-api');
  const all = request({ project: 'all', source: 'synthetic', from: new Date(2026, 9, 1).toISOString() });
  assert.equal(all.scope.project, undefined);
  assert.equal(all.scope.to, new Date(2026, 9, 31).toISOString());
  assert.equal(all.command, '/stats --from 2026-10-01 --to 2026-10-31 --as-of 2026-10-15T06:05:00.000Z --project all --source synthetic');
  assert.throws(() => request({ 'as-of': 'soon' }), CommandError);
  assert.throws(() => request({ snapshot: '1.5' }), CommandError);
});

test('oracle examples 1–6 produce the 1e row values, scopes and coverage', () => {
  const f = oracle();
  assert.deepEqual(row(f, '任务验收'), { value: '80.0%', tone: 'ok', scope: '成功 S/G = 4/5 · 完成 C/N = 6/10 = 60%', coverage: 'G/N 50%', bar: 0.5 });
  assert.deepEqual(row(f, '成本'), { value: '≈ ¥20.00 /成功', tone: 'plain', scope: '样本累计 ≈ ¥80.00 ÷ S=4 · 含失败、取消、重试与自动压缩', coverage: '估算 · 非账单', bar: undefined });
  assert.deepEqual(row(f, '双时钟'), { value: '12m / 24h', tone: 'plain', scope: '均值 · 队列 2m · 用户等待 3m · 活跃 7m', coverage: '有效 6/10 · 5/10', bar: undefined });
  assert.deepEqual(row(f, '人工介入'), { value: '25.0%', tone: 'warn', scope: 'I/Ni = 2/8 · 逻辑范围 [25%, 62.5%] 非置信区间', coverage: '62.5% · U=3', bar: 0.625 });
  assert.deepEqual(row(f, '回归'), { value: '1/3', tone: 'err', scope: 'R/V = 1/3（P=4）· ep-c03e', coverage: 'V/P 75%', bar: 0.75 });
  assert.deepEqual(row(f, '返工'), { value: '1/3', tone: 'err', scope: 'Rr/Nr = 1/3 · 未成熟阳性 1 另列', coverage: '66.7% · Ur=1', bar: 2 / 3 });
  assert.deepEqual(row(f, '运行故障'), { value: '25.0%', tone: 'err', scope: 'F/B = 2/8 · 完整率 unknown · 范围 [25%, 37.5%]', coverage: '87.5% · Uf=1', bar: 7 / 8 });
  assert.deepEqual(spendRows(f).map(r => [r.label, r.text.map(s => s.text).join('')]), [
    ['coding', '≈ ¥80.00 · 412k tok · 任务执行与自动压缩'],
    ['eval', '≈ ¥20.00 · 96k tok · 两侧 + 评分'],
    ['improve', '≈ ¥10.00 · 51k tok · 分析 + 候选制作'],
    ['维护', '≈ ¥5.00 · 24k tok · 空闲手动 /compact'],
    ['共同/未归属', '≈ ¥3.00 · 14k tok · 不分给具体任务'],
    ['合计', '≈ ¥118.00 · 597k tok · 去重汇总'],
  ]);
});

test('zero-denominator variants show N/A (dim), never 0% or 100%', () => {
  const f = oracle();
  f.acceptance = { N: 10, B: 8, C: 6, G: 0, S: 0 };
  assert.deepEqual(row(f, '任务验收'), { value: 'N/A', tone: 'na', scope: '成功 S/G = 0/0 · 完成 C/N = 6/10 = 60%', coverage: 'G/N 0%', bar: 0 });
  assert.equal(row(f, '成本').value, 'N/A', 'S=0');
  assert.match(row(f, '成本').scope, /÷ S=0/, 'S=0 still shows the accumulated spend');
  f.acceptance = { N: 0, B: 0, C: 0, G: 0, S: 0 };
  assert.deepEqual(row(f, '任务验收'), { value: 'N/A', tone: 'na', scope: '成功 S/G = 0/0 · 完成 C/N = 0/0 = N/A', coverage: 'G/N N/A', bar: null });
  f.clocks = { execution: { mean: null, valid: 0, total: 0 }, acceptance: { mean: null, valid: 0, total: 0 }, segments: [] };
  assert.deepEqual(row(f, '双时钟'), { value: 'N/A', tone: 'na', scope: '均值 · 没有已测出的完成项', coverage: '有效 0/0 · 0/0', bar: undefined });
  f.intervention = { Ni: 0, I: 0, Z: 0, U: 0, openPositive: 0 };
  assert.deepEqual(row(f, '人工介入'), { value: 'N/A', tone: 'na', scope: 'I/Ni = 0/0', coverage: 'N/A · U=0', bar: null });
  f.rework = { Nr: 0, Rr: 0, Zr: 0, Ur: 0, immaturePositive: 0 };
  assert.equal(row(f, '返工').value, 'N/A');
  f.faults = { B: 0, F: 0, Zf: 0, Uf: 0 };
  assert.deepEqual(row(f, '运行故障'), { value: 'N/A', tone: 'na', scope: 'F/B = 0/0', coverage: 'N/A · Uf=0', bar: null });
  f.regression = [{ label: 'ep-0001', at: '2026-10-01T00:00:00.000Z', P: 0, V: 0, R: 0 }];
  assert.deepEqual(row(f, '回归'), { value: 'N/A', tone: 'na', scope: 'R/V = 0/0（P=0）· ep-0001', coverage: 'V/P N/A', bar: null });
  f.regression = [];
  assert.deepEqual(row(f, '回归'), { value: '', tone: 'plain', scope: '窗口内无正式 eval', coverage: '', bar: undefined });
});

test('missing-evidence variants are unknown/partial in ac.warn, not N/A; failure facts stay ac.err', () => {
  const f = oracle();
  // 例 2 变体：额外失败请求费用未知 → 只能写已知部分
  f.cost = totals(80, 1);
  assert.deepEqual(row(f, '成本'), { value: '≈ ¥20.00 /成功', tone: 'warn', scope: '已知部分 ≈ ¥80.00 ÷ S=4 · 不是完整值，也不是下界', coverage: '估算 · 非账单 · +1 unknown', bar: undefined });
  f.cost = totals(null, 2);
  assert.equal(row(f, '成本').value, 'unknown');
  assert.equal(row(f, '成本').tone, 'warn');
  f.cost = totals(80, 0, true);
  assert.equal(row(f, '成本').coverage, '估算 · 非账单 · partial');
  // 介入/返工/故障：无阳性但有未知 → warn；全部可判 → plain
  f.intervention = { Ni: 8, I: 0, Z: 8, U: 0, openPositive: 1 };
  assert.deepEqual(row(f, '人工介入'), { value: '0.0%', tone: 'plain', scope: 'I/Ni = 0/8 · 未结束阳性 1 另列', coverage: '100% · U=0', bar: 1 });
  f.rework = { Nr: 3, Rr: 0, Zr: 2, Ur: 1, immaturePositive: 0 };
  assert.equal(row(f, '返工').tone, 'warn');
  f.faults = { B: 8, F: 0, Zf: 7, Uf: 1 };
  assert.equal(row(f, '运行故障').tone, 'warn');
  f.faults = { B: 8, F: 0, Zf: 8, Uf: 0 };
  assert.deepEqual(row(f, '运行故障'), { value: '0.0%', tone: 'plain', scope: 'F/B = 0/8', coverage: '100% · Uf=0', bar: 1 });
  // 期间开销中未知请求
  f.spend.rows[1] = { kind: 'eval', totals: totals(20, 2), tokens: 96_000 };
  assert.equal(spendRows(f)[1].text.map(s => s.text).join(''), '≈ ¥20.00 · 96k tok · +2 unknown · 两侧 + 评分');
  f.spend.rows[4] = { kind: 'unassigned', totals: totals(null), tokens: 0 };
  assert.ok(!spendRows(f).some(r => r.label === '共同/未归属'), 'zero shared/unassigned row is omitted');
});

test('regression shows plans one by one: newest is the main value; other plans with new regressions must be flagged', () => {
  const f = oracle();
  f.regression = [
    { label: 'ep-0003', at: '2026-10-12T00:00:00.000Z', P: 4, V: 4, R: 0 },
    { label: 'ep-0002', at: '2026-10-05T00:00:00.000Z', P: 2, V: 2, R: 2 },
    { label: 'ep-0001', at: '2026-09-20T00:00:00.000Z', P: 3, V: 3, R: 0 },
  ];
  assert.deepEqual(row(f, '回归'), { value: '0/4', tone: 'plain', scope: 'R/V = 0/4（P=4）· ep-0003 · 另 2 个，其中 1 个有新增回归', coverage: 'V/P 100%', bar: 1 });
  const flagged = metricRows(f).find(r => r.label === '回归')!.scope.at(-1)!;
  assert.equal(flagged.fg, 'ac.err');
  f.regression[1].R = 0;
  assert.equal(row(f, '回归').scope, 'R/V = 0/4（P=4）· ep-0003 · 另 2 个，均无新增回归');
});

test('132x38 golden with the six oracle examples', () => {
  const lines = view().render(132, 38, 'truecolor');
  assert.equal(lines.length, 38);
  const screen = text(lines);
  for (const fragment of ['指标 · 本机实测', '◆ stats  日常 · 受理 [09-16, 10-16) · as_of 10-15 14:05 · shop-api · f26ae8f · 样本 10（筛除 3）', '只读 · 不调用模型 · 不重记费用', '期间开销（去重）· 请求发生于 [09-16, 10-16)', '❯ /stats --from 2026-09-16 --to 2026-10-16 --as-of 2026-10-15T06:05:00.000Z --project /Users/me/code/shop-api', '零分母显示 N/A', 'Esc 返回会话'])
    assert.ok(screen.includes(fragment), fragment);
  assertGolden(captureSnapshot(lines, 132, 38, 'truecolor'), 'stats-1e-132x38');
});

test('header shows the read-only note at an exact two-column gap and preserves facts when one column short', () => {
  const left = '◆ stats  日常 · 受理 [09-16, 10-16) · as_of 10-15 14:05 · shop-api · f26ae8f · 样本 10（筛除 3）';
  const fits = view().render(128, 38, 'truecolor').map(stripTerminalSequences);
  assert.equal(fits[1], left + '  只读 · 不调用模型 · 不重记费用');
  const tight = view().render(127, 38, 'truecolor').map(stripTerminalSequences);
  assert.equal(tight[1].trimEnd(), left);
  assert.doesNotMatch(tight[1], /只读 · 不调用模型/);
});

test('width below 100: two lines per metric sharing the zebra background, two-line header without the right note', () => {
  const lines = view().render(80, 38, 'truecolor'), screen = text(lines);
  assert.ok(!screen.includes('只读 · 不调用模型'));
  assert.match(screen, /◆ stats  日常 · 受理 \[09-16, 10-16\) · 样本 10（筛除 3）/);
  assert.match(screen, /as_of 10-15 14:05 · shop-api · f26ae8f/);
  const plain = lines.map(stripTerminalSequences), at = plain.findIndex(l => l.includes('任务验收'));
  assert.match(plain[at], /80\.0%.*G\/N 50%/);
  assert.match(plain[at + 1], /^ {4}成功 S\/G = 4\/5/);
  assert.equal(lines[at].match(/48;2;26;26;26/) !== null, true, 'zebra first line');
  assert.equal(lines[at + 1].match(/48;2;26;26;26/) !== null, true, 'zebra second line');
  assertGolden(captureSnapshot(lines, 80, 38, 'truecolor'), 'stats-1e-80x38');
});

test('width below 60: coverage column and spend bars removed', () => {
  const lines = view().render(56, 38, 'truecolor'), screen = text(lines);
  assert.ok(!screen.includes('G/N 50%'));
  assert.ok(!screen.includes('█'));
  assert.match(screen, /coding +≈ ¥80\.00 · 412k tok/);
  assert.ok(screen.includes('指标 · 本机实测'));
  assertGolden(captureSnapshot(lines, 56, 38, 'truecolor'), 'stats-1e-56x38');
});

test('short heights collapse note, command, spend (total only), then scroll the table; tabs and Esc always stay', () => {
  for (const [w, h] of [[132, 38], [80, 24], [40, 12], [132, 20], [100, 26]]) {
    const lines = view().render(w, h, 'truecolor');
    assert.equal(lines.length, h, `${w}x${h}`);
    for (const l of lines) assert.ok(visibleWidth(l) <= w, `${w}x${h} overflow: ${stripTerminalSequences(l)}`);
    const plain = lines.map(stripTerminalSequences);
    assert.match(plain[0], /指标 · 本机实测/, `${w}x${h} tabs`);
    assert.match(plain.at(-1)!, /Esc 返回会话/, `${w}x${h} esc`);
  }
  const boxed = text(view().render(132, 38, 'truecolor'));
  assert.match(boxed, /╭─+╮\n│❯ \/stats/);
  const airyWithoutBox = text(view().render(80, 38, 'truecolor'));
  assert.ok(!airyWithoutBox.includes('╭') && airyWithoutBox.includes('❯ /stats'), 'the box gives way before the table spacing');
  const noNote = text(view().render(80, 28, 'truecolor'));
  assert.ok(!noNote.includes('╭'), 'the command first falls back to a single unframed line');
  assert.ok(!noNote.includes('零分母显示') && noNote.includes('❯ /stats') && noNote.includes('improve '), 'the note goes first');
  const noCommand = text(view().render(80, 27, 'truecolor'));
  assert.ok(!noCommand.includes('❯ /stats') && noCommand.includes('improve '), 'then the equivalent command');
  const total = text(view().render(132, 16, 'truecolor'));
  assert.ok(total.includes('合计') && !total.includes('improve ') && total.includes('运行故障'), 'then spend collapses to the total');
  const v = view(), before = text(v.render(80, 12, 'truecolor'));
  v.handleInput('\x1b[B'); v.handleInput('\x1b[B');
  assert.notEqual(text(v.render(80, 12, 'truecolor')), before, 'table scrolls');
});

test('no sample: table still drawn with N/A, hint above the table, regression and spend still computed', () => {
  const f = oracle();
  f.acceptance = { N: 0, B: 0, C: 0, G: 0, S: 0 }; f.intervention = { Ni: 0, I: 0, Z: 0, U: 0, openPositive: 0 }; f.faults = { B: 0, F: 0, Zf: 0, Uf: 0 };
  const screen = text(view(f).render(132, 38, 'truecolor'));
  assert.match(screen, /窗口内没有日常受理样本 · \/ 调整范围/);
  assert.match(screen, /样本 0（筛除 3）/);
  assert.match(screen, /任务验收 +N\/A/);
  assert.match(screen, /R\/V = 1\/3（P=4）/);
  assert.match(screen, /合计 +█+ +≈ ¥118\.00/);
});

test('over the query limit: whole-screen error, no partial result, export unavailable', () => {
  for (const [code, message] of [['METRICS_SCOPE_TOO_LARGE', '受理任务超过 10000 个'], ['OPERATIONS_SCOPE_TOO_LARGE', '运维记录超过 30000 条或 32 MB']]) {
    const v = new StatsView(request(), () => { throw Error(`${code}: narrow the admission window`); });
    const lines = v.render(132, 38, 'truecolor'), screen = text(lines);
    assert.equal(v.exportable, false);
    assert.equal(v.stats, undefined);
    assert.match(screen, new RegExp(`✗ 范围过大 · ${message} · ${code}`));
    assert.match(screen, /\/ 缩小时间或项目范围/);
    assert.match(screen, /受理 \[09-16, 10-16\) · as_of 10-15 14:05 · shop-api/, 'header still shows the range');
    assert.ok(!/任务验收|期间开销|样本 /.test(screen), 'no partial result');
    if (code === 'METRICS_SCOPE_TOO_LARGE') assertGolden(captureSnapshot(lines, 132, 38, 'truecolor'), 'stats-1e-too-large');
  }
  assert.throws(() => new StatsView(request(), () => { throw Error('INVALID_METRICS_SNAPSHOT'); }), /INVALID_METRICS_SNAPSHOT/);
});

test('color tiers: values follow the state colors; none tier keeps bars distinguishable', () => {
  const lines = view().render(132, 38, '256color');
  assert.ok(lines.some(l => l.includes('38;5;')));
  const none = view().render(132, 38, 'none');
  assert.ok(!none.some(l => /\x1b\[(?:38|48);/.test(l)));
  assert.ok(text(none).includes('█████░░░░░'));
});

const fixtureDir = fileURLToPath(new URL('../../test/fixtures/v1-records', import.meta.url));
test('first-version records: figures equal the three shared reports, regression per plan, read-only', () => {
  const dataRoot = join(fixtureDir, 'data');
  const before = readFileSync(join(dataRoot, 'host.sqlite')), seq = watermark(dataRoot);
  const scope = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', asOf: '2100-01-01T00:00:00.000Z', source: 'synthetic' as const };
  const stats = readStats(dataRoot, scope), task = queryTaskMetrics(dataRoot, scope), through = task.scope.through;
  const ops = queryOperationsMetrics(dataRoot, { ...scope, through }), feedback = queryFeedbackMetrics(dataRoot, { ...scope, through });
  assert.ok(stats.sample.N > 0);
  assert.deepEqual(stats.figures.acceptance, { N: task.counts.N, B: task.counts.B, C: task.counts.C, G: task.counts.G, S: task.counts.S });
  assert.deepEqual(stats.figures.cost, ops.costs.sample.totals);
  assert.deepEqual(stats.figures.spend.total.totals, ops.costs.period.totals);
  assert.equal(stats.figures.faults.B, ops.faults.tasks.counts.B);
  assert.equal(stats.figures.intervention.Ni, feedback.intervention.counts.Ni);
  assert.equal(stats.figures.rework.Nr, feedback.rework.counts.Nr);
  assert.ok(stats.figures.regression.every(p => /^ep-/.test(p.label)));
  const execution = task.clocks.execution;
  if (execution.mean !== null) assert.equal(Math.round(stats.figures.clocks.segments.reduce((n, s) => n + s.meanMs, 0)), Math.round(execution.mean), 'segment means add up to the execution mean');
  const screen = text(new StatsView({ scope, command: '/stats' }, s => readStats(dataRoot, s)).render(132, 38, 'truecolor'));
  assert.match(screen, /合成 · 受理/);
  assert.equal(watermark(dataRoot), seq);
  assert.deepEqual(readFileSync(join(dataRoot, 'host.sqlite')), before);
  assert.equal(readStats(dataRoot, { ...scope, source: 'ordinary' }).figures.regression.length, 0, 'offline fixture plans are synthetic, not ordinary');
});
