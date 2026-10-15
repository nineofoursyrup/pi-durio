import { basename } from 'node:path';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { queryFeedbackMetrics, queryOperationsMetrics, queryTaskMetrics, type MetricsScope } from '../metrics/index.js';
import { records, decode } from '../history.js';
import { evalReport } from '../eval/runner.js';
import { readDisplayIndex } from '../display-number.js';
import { formatAmount, sumCostEstimates, type CostTotals } from '../cost-estimate.js';
import { COLOR_TIER, GLYPHS, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { CommandError } from './commands.js';
import { clean, escHint, fixedFrame, hintLine, statusError, truncateEnd, widthTier } from './view-stack.js';

// ─── 范围（M0、U5） ───────────────────────────────────────────────────────────

export type StatsSource = NonNullable<MetricsScope['source']>;
export type StatsScope = MetricsScope & { from: string; to: string; asOf: string; source: StatsSource };
/** 打开 1e 所需的范围与底部等价命令。 */
export interface StatsRequest { scope: StatsScope; command: string }

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDay = (iso: string, days = 0) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).toISOString(); };
const monthDay = (iso: string) => { const d = new Date(iso); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const minute = (iso: string) => { const d = new Date(iso); return `${monthDay(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/**
 * `/stats` 选项 → 范围。默认近 30 天整日（本机时区 `[as_of 当天−29, 次日)`）、当前工作区所属项目、日常来源，
 * as_of 为打开时刻。`--from`/`--to` 已由命令表转成本地零点 ISO；只给一端时另一端按 30 天补齐。
 */
export function statsRequest(options: Record<string, string | boolean | undefined>, workspace: string, now = new Date()): StatsRequest {
  const text = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const asOfInput = text('as-of'), snapshot = text('snapshot');
  if (asOfInput !== undefined && !Number.isFinite(Date.parse(asOfInput))) throw new CommandError(`--as-of 不是可识别的时间：${asOfInput}`);
  if (snapshot !== undefined && !/^\d+$/.test(snapshot)) throw new CommandError(`--snapshot 要整数序号：${snapshot}`);
  const asOf = asOfInput !== undefined ? new Date(asOfInput).toISOString() : now.toISOString();
  const to = text('to') ?? (text('from') !== undefined ? localDay(text('from')!, 30) : localDay(asOf, 1));
  const from = text('from') ?? localDay(to, -30);
  const projectInput = text('project'), source = (text('source') ?? 'ordinary') as StatsSource;
  const scope: StatsScope = { from, to, asOf, source };
  if (projectInput !== 'all') scope.project = projectInput ?? workspace;
  if (text('type') !== undefined) scope.taskType = text('type');
  if (text('version') !== undefined) scope.version = text('version');
  if (snapshot !== undefined) scope.through = Number(snapshot);
  const year = (iso: string) => new Date(iso).getFullYear() === now.getFullYear() ? monthDay(iso) : `${new Date(iso).getFullYear()}-${monthDay(iso)}`;
  const parts = ['/stats', '--from', year(from), '--to', year(to)];
  if (asOfInput !== undefined) parts.push('--as-of', asOfInput);
  if (projectInput !== undefined) parts.push('--project', projectInput);
  for (const name of ['type', 'version', 'source', 'snapshot']) if (text(name) !== undefined && !(name === 'source' && source === 'ordinary')) parts.push(`--${name}`, text(name)!);
  return { scope, command: parts.join(' ') };
}

// ─── 取数（只读：不调用模型、不写记录） ─────────────────────────────────────────

export type SegmentName = 'queue' | 'user-wait' | 'active' | 'recovery-offline' | 'unknown';
export type SpendKind = 'coding' | 'eval' | 'improve' | 'maintenance' | 'unassigned';
/** 1e 表格与期间开销用到的全部数。由三份报告与窗口内的 eval 计划推出；oracle 与 golden 直接构造它。 */
export interface StatsFigures {
  acceptance: { N: number; B: number; C: number; G: number; S: number };
  /** 样本累计（成本行分子）；S 与任务验收相同 */
  cost: CostTotals;
  clocks: {
    execution: { mean: number | null; valid: number; total: number };
    acceptance: { mean: number | null; valid: number; total: number };
    /** 只含宿主有记录的分段，均值按已测出执行历时的完成项计 */
    segments: { kind: SegmentName; meanMs: number }[];
  };
  intervention: { Ni: number; I: number; Z: number; U: number; openPositive: number };
  /** 窗口内固定的正式 eval 计划，最近的在前；每个计划单独计数，不合算 */
  regression: { label: string; at: string; P: number; V: number; R: number }[];
  rework: { Nr: number; Rr: number; Zr: number; Ur: number; immaturePositive: number };
  faults: { B: number; F: number; Zf: number; Uf: number };
  /** 期间开销（去重），按请求发生时间选取；total 为合计 */
  spend: { rows: { kind: SpendKind; totals: CostTotals; tokens: number }[]; total: { totals: CostTotals; tokens: number } };
}
export interface StatsData {
  scope: StatsScope;
  sample: { N: number; excluded: number };
  versions: { ids: string[]; unknown: number };
  figures: StatsFigures;
}
/** 超过查询上限：整屏报错，不显示部分结果（M0、U5）。 */
export const SCOPE_LIMITS: Record<string, string> = {
  METRICS_SCOPE_TOO_LARGE: '范围过大 · 受理任务超过 10000 个',
  OPERATIONS_SCOPE_TOO_LARGE: '范围过大 · 运维记录超过 30000 条或 32 MB',
};
const limitCode = (error: unknown) => Object.keys(SCOPE_LIMITS).find(code => String((error as Error)?.message ?? error).startsWith(code));

const tokensOf = (usage: any): number => {
  if (!usage || typeof usage !== 'object') return 0;
  if (typeof usage.tokens === 'number') return usage.tokens;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, k) => n + (typeof usage[k] === 'number' ? usage[k] : 0), 0);
};
const spendKind = (kind: string): SpendKind => kind === 'coding' || kind === 'eval' || kind === 'improve' || kind === 'maintenance' ? kind : 'unassigned';
const sourceOfMode = (mode: unknown) => mode === 'offline' ? 'synthetic' : mode === 'live' ? 'ordinary' : null;

/** 读同一快照下的任务、运维、反馈三份报告与窗口内各 eval 计划的回归计数。只读，不取锁。 */
export function readStats(root: string, scope: StatsScope): StatsData {
  const task = queryTaskMetrics(root, scope), fixed = { ...scope, through: task.scope.through };
  const ops = queryOperationsMetrics(root, fixed), feedback = queryFeedbackMetrics(root, fixed);
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(scope.from) && Date.parse(at) < Date.parse(scope.to);

  // 回归：本数据根与 improve 子数据根中固定于窗口内、来源相符、带比较的计划，逐个计算（M5）。
  const plans: { root: string; id: string; at: string; asOf?: number }[] = [];
  for (const ref of records(root, { through: task.scope.through, kinds: ['eval.plan'] })) {
    if (!inWindow(ref.at)) continue;
    try { if (sourceOfMode(decode(root, ref).mode) === scope.source) plans.push({ root, id: ref.runId, at: ref.at, asOf: task.scope.through }); } catch { /* 计划原文不可读：不进入回归行 */ }
  }
  for (const child of ops.ownedChildren.snapshots as { dataRoot: string; planId: string; through: number }[]) {
    const ref = [...records(child.dataRoot, { through: child.through, kinds: ['eval.plan'] })].find(r => r.runId === child.planId);
    if (ref && inWindow(ref.at) && sourceOfMode(decode(child.dataRoot, ref).mode) === scope.source) plans.push({ root: child.dataRoot, id: child.planId, at: ref.at, asOf: child.through });
  }
  const regression = plans.flatMap(plan => {
    const counts = evalReport(plan.root, plan.id, { asOf: plan.asOf }).comparison?.regression.counts;
    return counts ? [{ label: readDisplayIndex(plan.root).label('eval-plan', plan.id), at: plan.at, P: counts.planned, V: counts.valid, R: counts.regressed }] : [];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  // 双时钟分段：只列宿主有记录的；均值按已测出执行历时的任务计，各分段均值相加等于执行均值（M3）。
  const measured = task.tasks.filter(t => t.clocks.execution.state === 'measured');
  const recorded = new Set<string>(task.tasks.flatMap(t => t.clocks.segments.map(s => s.kind)));
  const segments = (['queue', 'user-wait', 'active', 'recovery-offline', 'unknown'] as const).flatMap((kind): { kind: SegmentName; meanMs: number }[] => {
    if (!measured.length) return [];
    const meanMs = measured.reduce((n, t) => n + (t.clocks.partition.measured[kind] ?? 0), 0) / measured.length;
    return kind === 'unknown' ? (meanMs > 0 ? [{ kind, meanMs }] : []) : recorded.has(kind) ? [{ kind, meanMs }] : [];
  });

  const period = new Set(ops.costs.period.requestIds), periodRequests = ops.costs.requests.filter(r => period.has(r.id));
  const kinds: SpendKind[] = ['coding', 'eval', 'improve', 'maintenance', 'unassigned'];
  const spend = {
    rows: kinds.map(kind => { const items = periodRequests.filter(r => spendKind(r.kind) === kind); return { kind, totals: sumCostEstimates(items), tokens: items.reduce((n, r) => n + tokensOf(r.usage), 0) }; }),
    total: { totals: ops.costs.period.totals, tokens: periodRequests.reduce((n, r) => n + tokensOf(r.usage), 0) },
  };

  const i = feedback.intervention.counts, w = feedback.rework.counts, f = ops.faults.tasks.counts;
  const started = task.tasks.filter(t => t.startedSource);
  return {
    scope,
    sample: { N: task.counts.N, excluded: task.excluded.length },
    versions: { ids: [...new Set(started.flatMap(t => t.version ? [t.version] : []))], unknown: started.filter(t => !t.version).length },
    figures: {
      acceptance: { N: task.counts.N, B: task.counts.B, C: task.counts.C, G: task.counts.G, S: task.counts.S },
      cost: ops.costs.sample.totals,
      clocks: {
        execution: { mean: task.clocks.execution.mean, valid: task.clocks.execution.valid, total: task.clocks.execution.total },
        acceptance: { mean: task.clocks.acceptance.mean, valid: task.clocks.acceptance.valid, total: task.clocks.acceptance.total },
        segments,
      },
      intervention: { Ni: i.Ni, I: i.I, Z: i.Z, U: i.U, openPositive: i.openPositive },
      regression,
      rework: { Nr: w.Nr, Rr: w.Rr, Zr: w.Zr, Ur: w.Ur, immaturePositive: w.immaturePositive },
      faults: { B: f.B, F: f.F, Zf: f.Zf, Uf: f.Uf },
      spend,
    },
  };
}

// ─── 表格模型（纯函数：oracle 与 golden 共用） ─────────────────────────────────

/** 值的配色：成功率 ac.ok；有失败事实 ac.err；完整率未知或金额不完整 ac.warn；其余 fg.primary；N/A 为 dim。 */
export type ValueTone = 'ok' | 'err' | 'warn' | 'plain' | 'na';
export interface MetricRow {
  label: string;
  value: { text: string; tone: ValueTone; unit?: string };
  scope: TextSegment[];
  /** 覆盖条比例（0–1）；null = 零分母（画空条写 N/A）；undefined = 本行没有条形 */
  bar?: number | null;
  coverage: TextSegment[];
}
export interface SpendRow { label: string; kind: SpendKind | 'total'; known: number; text: TextSegment[] }

const percent = (n: number, d: number) => `${(n / d * 100).toFixed(1)}%`;
const share = (n: number, d: number) => `${+(n / d * 100).toFixed(1)}%`;
const range = (lo: number, hi: number, d: number) => `[${share(lo, d)}, ${share(hi, d)}]`;
const NA = 'N/A';
/** 历时：<1m 秒，<1h 分，<100h 时，其余天。 */
export function formatDuration(ms: number | null) {
  if (ms === null) return NA;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 100 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
export function formatTokens(n: number) { return n < 1000 ? `${n} tok` : n < 1e6 ? `${Math.round(n / 1000)}k tok` : `${+(n / 1e6).toFixed(1)}M tok`; }
const knownAmounts = (totals: CostTotals, divisor = 1) => Object.keys(totals.amounts)
  .sort((a, b) => Number(b === 'CNY') - Number(a === 'CNY') || a.localeCompare(b))
  .map(currency => formatAmount(totals.amounts[currency] / divisor, currency)).join(' · ');
const incomplete = (totals: CostTotals) => totals.unknownRequests > 0 || totals.partial;
const gapText = (totals: CostTotals): TextSegment[] => totals.unknownRequests ? [{ text: ` · +${totals.unknownRequests} unknown`, fg: 'ac.warn' }] : totals.partial ? [{ text: ' · partial', fg: 'ac.warn' }] : [];
const SEGMENT_LABEL: Record<SegmentName, string> = { queue: '队列', 'user-wait': '用户等待', active: '活跃', 'recovery-offline': '恢复', unknown: '未知' };

/** 七行指标（U5）。 */
export function metricRows(f: StatsFigures): MetricRow[] {
  const { N, C, G, S } = f.acceptance;
  const acceptance: MetricRow = {
    label: '任务验收',
    value: G ? { text: percent(S, G), tone: 'ok' } : { text: NA, tone: 'na' },
    scope: [{ text: `成功 S/G = ${S}/${G} · 完成 C/N = ${C}/${N} = ${N ? share(C, N) : NA}` }],
    bar: N ? G / N : null,
    coverage: [{ text: ` G/N ${N ? share(G, N) : NA}` }],
  };

  const known = knownAmounts(f.cost), partial = incomplete(f.cost);
  const cost: MetricRow = {
    label: '成本',
    value: !S ? { text: NA, tone: 'na' } : known ? { text: knownAmounts(f.cost, S), tone: partial ? 'warn' : 'plain', unit: ' /成功' } : { text: 'unknown', tone: 'warn' },
    scope: partial
      ? [{ text: `已知部分 ${known || 'unknown'} ÷ S=${S} · ` }, { text: '不是完整值，也不是下界', fg: 'ac.warn' }]
      : [{ text: `样本累计 ${known || formatAmount(0, 'CNY')} ÷ S=${S} · 含失败、取消、重试与自动压缩` }],
    coverage: [{ text: '估算 · 非账单' }, ...gapText(f.cost)],
  };

  const { execution, acceptance: judged } = f.clocks;
  const clocks: MetricRow = {
    label: '双时钟',
    value: execution.mean === null && judged.mean === null ? { text: NA, tone: 'na' } : { text: `${formatDuration(execution.mean)} / ${formatDuration(judged.mean)}`, tone: 'plain' },
    scope: [{ text: f.clocks.segments.length ? `均值 · ${f.clocks.segments.map(s => `${SEGMENT_LABEL[s.kind]} ${formatDuration(s.meanMs)}`).join(' · ')}` : '均值 · 没有已测出的完成项' }],
    coverage: [{ text: `有效 ${execution.valid}/${execution.total} · ${judged.valid}/${judged.total}` }],
  };

  const iv = f.intervention;
  const intervention: MetricRow = {
    label: '人工介入',
    value: iv.Ni ? { text: percent(iv.I, iv.Ni), tone: iv.U ? 'warn' : 'plain' } : { text: NA, tone: 'na' },
    scope: [
      { text: `I/Ni = ${iv.I}/${iv.Ni}` },
      ...iv.Ni && iv.U ? [{ text: ` · 逻辑范围 ${range(iv.I, iv.I + iv.U, iv.Ni)} ` }, { text: '非置信区间', fg: 'fg.faint' as TokenName }] : [],
      ...iv.openPositive ? [{ text: ` · 未结束阳性 ${iv.openPositive} 另列`, fg: 'fg.muted' as TokenName }] : [],
    ],
    bar: iv.Ni ? (iv.I + iv.Z) / iv.Ni : null,
    coverage: [{ text: ` ${iv.Ni ? share(iv.I + iv.Z, iv.Ni) : NA} · U=${iv.U}` }],
  };

  const [main, ...others] = f.regression, regressed = others.filter(p => p.R > 0).length;
  const regression: MetricRow = main ? {
    label: '回归',
    value: main.V ? { text: `${main.R}/${main.V}`, tone: main.R ? 'err' : 'plain' } : { text: NA, tone: 'na' },
    scope: [
      { text: `R/V = ${main.R}/${main.V}（P=${main.P}）· ${main.label}` },
      ...others.length ? [regressed
        ? { text: ` · 另 ${others.length} 个，其中 ${regressed} 个有新增回归`, fg: 'ac.err' as TokenName }
        : { text: ` · 另 ${others.length} 个，均无新增回归`, fg: 'fg.muted' as TokenName }] : [],
    ],
    bar: main.P ? main.V / main.P : null,
    coverage: [{ text: ` V/P ${main.P ? share(main.V, main.P) : NA}` }],
  } : { label: '回归', value: { text: '', tone: 'plain' }, scope: [{ text: '窗口内无正式 eval', fg: 'fg.muted' }], coverage: [] };

  const rw = f.rework;
  const rework: MetricRow = {
    label: '返工',
    value: rw.Nr ? { text: `${rw.Rr}/${rw.Nr}`, tone: rw.Rr ? 'err' : rw.Ur ? 'warn' : 'plain' } : { text: NA, tone: 'na' },
    scope: [{ text: `Rr/Nr = ${rw.Rr}/${rw.Nr}` }, ...rw.immaturePositive ? [{ text: ` · 未成熟阳性 ${rw.immaturePositive} 另列`, fg: 'fg.muted' as TokenName }] : []],
    bar: rw.Nr ? (rw.Rr + rw.Zr) / rw.Nr : null,
    coverage: [{ text: ` ${rw.Nr ? share(rw.Rr + rw.Zr, rw.Nr) : NA} · Ur=${rw.Ur}` }],
  };

  const ft = f.faults;
  const faults: MetricRow = {
    label: '运行故障',
    value: ft.B ? { text: percent(ft.F, ft.B), tone: ft.F ? 'err' : ft.Uf ? 'warn' : 'plain' } : { text: NA, tone: 'na' },
    scope: [{ text: `F/B = ${ft.F}/${ft.B}` }, ...ft.B && ft.Uf ? [{ text: ' · 完整率 ' }, { text: 'unknown', fg: 'ac.warn' as TokenName }, { text: ` · 范围 ${range(ft.F, ft.F + ft.Uf, ft.B)}` }] : []],
    bar: ft.B ? (ft.F + ft.Zf) / ft.B : null,
    coverage: [{ text: ` ${ft.B ? share(ft.F + ft.Zf, ft.B) : NA} · Uf=${ft.Uf}` }],
  };
  return [acceptance, cost, clocks, intervention, regression, rework, faults];
}

const SPEND: Record<SpendKind | 'total', { label: string; note: string; fg: TokenName }> = {
  coding: { label: 'coding', note: '任务执行与自动压缩', fg: 'ac.brand' },
  eval: { label: 'eval', note: '两侧 + 评分', fg: 'ac.info' },
  improve: { label: 'improve', note: '分析 + 候选制作', fg: 'ac.improve' },
  maintenance: { label: '维护', note: '空闲手动 /compact', fg: 'fg.faint' },
  unassigned: { label: '共同/未归属', note: '不分给具体任务', fg: 'fg.muted' },
  total: { label: '合计', note: '去重汇总', fg: 'fg.body' },
};
const spendIsZero = (row: { totals: CostTotals; tokens: number }) => !Object.values(row.totals.amounts).some(Boolean) && !row.totals.unknownRequests && !row.totals.partial && !row.tokens;
/** 期间开销各行：coding、eval、improve、维护，共同/未归属非零时加一行，最后为合计。 */
export function spendRows(f: StatsFigures): SpendRow[] {
  const rows = f.spend.rows.filter(r => r.kind !== 'unassigned' || !spendIsZero(r));
  return [...rows, { kind: 'total' as const, ...f.spend.total }].map(row => ({
    label: SPEND[row.kind].label,
    kind: row.kind,
    known: row.totals.amounts.CNY ?? 0,
    text: [{ text: `${knownAmounts(row.totals) || (incomplete(row.totals) ? 'unknown' : formatAmount(0, 'CNY'))} · ${formatTokens(row.tokens)}` }, ...gapText(row.totals), { text: ` · ${SPEND[row.kind].note}`, fg: 'fg.faint' }],
  }));
}

// ─── 视图 ────────────────────────────────────────────────────────────────────

export type StatsTab = 'metrics' | 'self';
const TONE: Record<ValueTone, TokenName> = { ok: 'ac.ok', err: 'ac.err', warn: 'ac.warn', plain: 'fg.primary', na: 'fg.faint' };
const SOURCE_LABEL: Record<StatsSource, string> = { ordinary: '日常', synthetic: '合成', diagnostic: '诊断' };
const NOTE = '零分母显示 N/A · 缺依据显示 unknown/partial · 索引陈旧不写成「没有发生」';
const RIGHT_NOTE = '只读 · 不调用模型 · 不重记费用';
const LABEL_W = 16, VALUE_W = 16, COVER_W = 32, GAP = '  ';

/** 把若干段放进恰好 w 列：放不下时末尾加 `…`，不足时补空格。 */
function fit(segments: TextSegment[], w: number): TextSegment[] {
  const out: TextSegment[] = []; let used = 0;
  const total = segments.reduce((n, s) => n + visibleWidth(s.text), 0);
  for (const s of segments) {
    const sw = visibleWidth(s.text);
    if (total <= w || used + sw < w) { out.push(s); used += sw; continue; }
    const t = truncateToWidth(s.text, Math.max(0, w - used), '…'); out.push({ ...s, text: t }); used += visibleWidth(t); break;
  }
  if (used < w) out.push({ text: ' '.repeat(w - used) });
  return out;
}

/**
 * `/stats` 视图（U5）：最上层两个页签“指标”“本机实测”，Tab / Shift+Tab 切换；本票实现指标页签的表格层，
 * 本机实测（2c，#85）先放占位。查询同步完成、靠上限保证有界；超上限整屏报错。下钻、筛选、导出由 #84 接入。
 */
export class StatsView {
  tab: StatsTab;
  /** 表格滚动偏移（高度不够时） */
  private offset = 0;
  private data?: StatsData;
  /** 超上限时的原因码；此时不显示任何部分结果，`e` 不可用 */
  readonly limit?: string;

  constructor(readonly request: StatsRequest, read: (scope: StatsScope) => StatsData, opts: { tab?: StatsTab } = {}) {
    this.tab = opts.tab ?? 'metrics';
    try { this.data = read(request.scope); }
    catch (error) { const code = limitCode(error); if (!code) throw error; this.limit = code; }
  }
  get stats() { return this.data; }
  /** 导出（#84）是否可用：超上限时不可用 */
  get exportable() { return !this.limit; }

  /** 返回 true 表示按键已处理。 */
  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { this.tab = this.tab === 'metrics' ? 'self' : 'metrics'; this.offset = 0; return true; }
    if (matchesKey(data, 'up')) { this.scroll(-1); return true; }
    if (matchesKey(data, 'down')) { this.scroll(1); return true; }
    if (matchesKey(data, 'pageUp')) { this.scroll(-5); return true; }
    if (matchesKey(data, 'pageDown')) { this.scroll(5); return true; }
    return false;
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); }

  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const line = (segments: TextSegment[], bg?: TokenName) => styledLine(segments, width, bg, tier);
    const tabs = line([{ text: ' ' }, { text: '指标', fg: this.tab === 'metrics' ? 'fg.primary' : 'fg.label', bold: this.tab === 'metrics' }, { text: ' · ', fg: 'fg.faint' }, { text: '本机实测', fg: this.tab === 'self' ? 'fg.primary' : 'fg.label', bold: this.tab === 'self' }]);
    const hints = this.tab === 'metrics' ? ['Tab 切换页签', '↑↓ 滚动'] : ['Tab 切换页签'];
    const hint = hintLine(hints, width, { esc: escHint(1), tier });
    if (this.tab === 'self') {
      const frame = fixedFrame([tabs, line([{ text: ' ◆ ', fg: 'ac.model' }, { text: 'self', fg: 'fg.primary', bold: true }])], ['', line([{ text: ' 本机实测页签尚未提供 · Tab 回到指标', fg: 'fg.muted' }])], [hint], height, 0);
      return frame.lines;
    }
    const tierW = widthTier(width), scope = this.request.scope;
    const head = [tabs, ...this.header(width, tier)];
    const command = line([{ text: ` ${GLYPHS.prompt} `, fg: 'ac.brand' }, { text: truncateEnd(clean(this.request.command), width - 4), fg: 'fg.body' }]);
    const note = line([{ text: ` ${truncateEnd(NOTE, width - 2)}`, fg: 'fg.label' }]);

    if (!this.data) {
      const error = statusError(SCOPE_LIMITS[this.limit!], this.limit!, '/ 缩小时间或项目范围', width, tier);
      return fixedFrame(head, ['', ...error], [command, hint], height, 0).lines;
    }

    const f = this.data.figures, rows = metricRows(f), spend = spendRows(f);
    const table: string[] = [''];
    if (!this.data.sample.N) table.push(line([{ text: ` 窗口内没有${SOURCE_LABEL[scope.source]}受理样本 · / 调整范围`, fg: 'fg.muted' }]));
    const covW = tierW === 'wide' ? COVER_W : tierW === 'medium' ? Math.min(COVER_W, width - 2 - LABEL_W - VALUE_W - 2 * GAP.length) : 0;
    const scopeW = Math.max(8, width - 2 - LABEL_W - VALUE_W - COVER_W - 3 * GAP.length);
    if (tierW === 'wide') table.push(line([{ text: '  ' }, ...fit([{ text: '指标' }], LABEL_W), { text: GAP }, ...fit([{ text: '值' }], VALUE_W), { text: GAP }, ...fit([{ text: '口径' }], scopeW), { text: GAP }, { text: '覆盖' }].map(s => ({ ...s, fg: 'fg.faint' as TokenName }))));
    const bar = (ratio: number | null | undefined): TextSegment[] => {
      if (ratio === undefined) return [];
      const filled = ratio === null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * 10);
      return [{ text: '█'.repeat(filled), fg: 'ac.info' }, { text: (tier === 'none' ? '░' : '█').repeat(10 - filled), fg: 'line.track' }];
    };
    const coverage = (row: MetricRow): TextSegment[] => [...bar(row.bar), ...row.coverage.map(s => ({ ...s, fg: s.fg ?? (row.bar === null ? 'fg.faint' : 'fg.muted') as TokenName }))];
    rows.forEach((row, index) => {
      const bg: TokenName | undefined = index % 2 === 0 ? 'bg.zebra' : undefined;
      const value: TextSegment[] = [{ text: row.value.text, fg: TONE[row.value.tone], bold: row.value.tone !== 'na' }, ...row.value.unit ? [{ text: row.value.unit, fg: 'fg.faint' as TokenName }] : []];
      const scopeSegs = row.scope.map(s => ({ ...s, fg: s.fg ?? 'fg.body' as TokenName }));
      const label = fit([{ text: row.label, fg: 'fg.primary' }], LABEL_W);
      if (tierW === 'wide') table.push(line([{ text: '  ' }, ...label, { text: GAP }, ...fit(value, VALUE_W), { text: GAP }, ...fit(scopeSegs, scopeW), { text: GAP }, ...fit(coverage(row), COVER_W)], bg));
      else {
        // 宽度小于 100：指标、值、覆盖一行，口径缩进一行，共用斑马底色；小于 60 去掉覆盖列。
        const first: TextSegment[] = [{ text: '  ' }, ...label, { text: GAP }, ...fit(value, VALUE_W)];
        if (covW > 0) first.push({ text: GAP }, ...fit(coverage(row), covW));
        table.push(line(first, bg), line([{ text: '    ' }, ...fit(scopeSegs, Math.max(1, width - 4))], bg));
      }
    });
    const range = `[${monthDay(scope.from)}, ${monthDay(scope.to)})`;
    const spendTitle = line([{ text: ` 期间开销（去重）· 请求发生于 ${range}`, fg: 'fg.label' }]);
    const barW = tierW === 'wide' ? 24 : tierW === 'medium' ? 12 : 0;
    const max = Math.max(0, ...spend.map(r => r.known));
    const spendLine = (row: SpendRow) => {
      const segs: TextSegment[] = [{ text: '  ' }, ...fit([{ text: row.label, fg: row.kind === 'total' ? 'fg.primary' : 'fg.body' }], LABEL_W), { text: GAP }];
      if (barW) {
        const cells = max ? row.known / max * barW : 0, whole = Math.floor(cells);
        const glyphs = '█'.repeat(whole) + (cells - whole >= 0.5 || (row.known > 0 && whole === 0) ? '▌' : '');
        segs.push(...fit([{ text: glyphs, fg: SPEND[row.kind].fg }], barW), { text: GAP });
      }
      segs.push(...row.text.map(s => ({ ...s, fg: s.fg ?? 'fg.muted' as TokenName })));
      return line(fit(segs, width));
    };
    const spendLines = spend.map(spendLine), totalOnly = [spendLine(spend.at(-1)!)];

    // 高度不够时依次收起：底部说明行、等价命令行、期间开销（只剩合计）、表格滚动。页签行与底栏始终保留。
    const fits = (body: number, foot: number) => head.length + body + foot <= height;
    const bodyOf = (spendPart: string[]) => [...table, '', spendTitle, ...spendPart];
    let body = bodyOf(spendLines), foot = [command, note, hint];
    if (!fits(body.length, foot.length)) foot = [command, hint];
    if (!fits(body.length, foot.length)) foot = [hint];
    if (!fits(body.length, foot.length)) body = bodyOf(totalOnly);
    const frame = fixedFrame(head, body, foot, height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }

  /** 头部：宽时一行，右侧写说明；宽度小于 100 时分两行（来源·范围·样本 / as_of·项目·执行版本），说明收起。 */
  private header(width: number, tier: ColorTier): string[] {
    const scope = this.request.scope, data = this.data;
    const project = scope.project === undefined ? '全部项目' : basename(scope.project) || scope.project;
    const first = [`${SOURCE_LABEL[scope.source]}`, `受理 [${monthDay(scope.from)}, ${monthDay(scope.to)})`];
    const second = [`as_of ${minute(scope.asOf)}`, project];
    if (data) {
      const { ids, unknown } = data.versions;
      const version = [ids.length === 1 ? ids[0].slice(0, 7) : ids.length ? `${ids.length} 个执行版本` : '', unknown ? `未知 ${unknown}` : ''].filter(Boolean).join(' ');
      if (version) second.push(version);
    }
    const sample = data ? [`样本 ${data.sample.N}（筛除 ${data.sample.excluded}）`] : [];
    const brand: TextSegment[] = [{ text: ' ◆ ', fg: 'ac.model' }, { text: 'stats', fg: 'fg.primary', bold: true }, { text: '  ' }];
    const room = (segs: TextSegment[]) => width - segs.reduce((n, s) => n + visibleWidth(s.text), 0);
    if (widthTier(width) === 'wide') {
      const facts = clean([...first, ...second, ...sample].join(' · '));
      const left = [...brand, { text: facts, fg: 'fg.faint' as TokenName }], spare = room(left) - visibleWidth(RIGHT_NOTE) - 1;
      if (spare >= 2) return [styledLine([...left, { text: ' '.repeat(spare) }, { text: RIGHT_NOTE, fg: 'fg.faint' }], width, undefined, tier)];
      return [styledLine([...brand, { text: truncateEnd(facts, room(brand)), fg: 'fg.faint' }], width, undefined, tier)];
    }
    return [
      styledLine([...brand, { text: truncateEnd(clean([...first, ...sample].join(' · ')), room(brand)), fg: 'fg.faint' }], width, undefined, tier),
      styledLine([{ text: '   ' }, { text: truncateEnd(clean(second.join(' · ')), width - 3), fg: 'fg.faint' }], width, undefined, tier),
    ];
  }
}
