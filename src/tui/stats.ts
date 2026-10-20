import { basename } from 'node:path';
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { queryFeedbackMetrics, queryOperationsMetrics, queryTaskMetrics, type MetricsScope, type TaskMetricsReport, type OperationsMetricsReport, type FeedbackMetricsReport } from '../metrics/index.js';
import { records, decode } from '../history.js';
import { listPlanSources, readPlanReport, type PlanSource, type EvalReport } from '../eval/overview.js';
import { formatAmount, sumCostEstimates, type CostTotals } from '../cost-estimate.js';
import { COLOR_TIER, GLYPHS, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { CommandError } from './commands.js';
import { resolveProjectFilter, canonicalProject } from './project-filter.js';
import { fitSegments, clean, escHint, fixedFrame, footerLines, hintLine, rule, statusError, truncateEnd, widthTier } from './view-stack.js';

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
export function statsRequest(options: Record<string, string | boolean | undefined>, workspace: string, now = new Date(), projects: readonly string[] = []): StatsRequest {
  const text = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const asOfInput = text('as-of'), snapshot = text('snapshot');
  if (asOfInput !== undefined && !Number.isFinite(Date.parse(asOfInput))) throw new CommandError(`--as-of 不是可识别的时间：${asOfInput}`);
  if (snapshot !== undefined && !/^\d+$/.test(snapshot)) throw new CommandError(`--snapshot 要整数序号：${snapshot}`);
  const asOf = asOfInput !== undefined ? new Date(asOfInput).toISOString() : now.toISOString();
  const to = text('to') ?? (text('from') !== undefined ? localDay(text('from')!, 30) : localDay(asOf, 1));
  const from = text('from') ?? localDay(to, -30);
  const projectInput = text('project'), source = (text('source') ?? 'ordinary') as StatsSource;
  const scope: StatsScope = { from, to, asOf, source };
  const project = resolveProjectFilter(projectInput, workspace, projects);
  if (project !== undefined) scope.project = project;
  if (text('type') !== undefined) scope.taskType = text('type');
  if (text('version') !== undefined) scope.version = text('version');
  if (snapshot !== undefined) scope.through = Number(snapshot);
  return { scope, command: statsCommand(scope) };
}

/** A replayable command includes the frozen wall-clock cutoff and exact project identity. */
export function statsCommand(scope: StatsScope): string {
  const date = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const quote = (value: string) => /[\s"\\]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
  const parts = ['/stats', '--from', date(scope.from), '--to', date(scope.to), '--as-of', scope.asOf, '--project', quote(scope.project ?? 'all')];
  if (scope.taskType) parts.push('--type', quote(scope.taskType));
  if (scope.version) parts.push('--version', quote(scope.version));
  if (scope.source !== 'ordinary') parts.push('--source', scope.source);
  if (scope.through !== undefined) parts.push('--snapshot', String(scope.through));
  return parts.join(' ');
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
/** Full immutable input for drilldown/export; the figures-only interface stays usable for render oracles. */
export interface StatsPlan {
  source: PlanSource;
  report: EvalReport;
  label: string;
  at: string;
  P: number;
  V: number;
  R: number;
}
export interface StatsSnapshot extends StatsData {
  root: string;
  reports: { task: TaskMetricsReport; operations: OperationsMetricsReport; feedback: FeedbackMetricsReport };
  plans: StatsPlan[];
  planSources: PlanSource[];
  /** Parent-root cutoffs immediately before retained judgments/feedback/price/report revisions. */
  revisions: number[];
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
export const spendKind = (kind: string): SpendKind => kind === 'coding' || kind === 'eval' || kind === 'improve' || kind === 'maintenance' ? kind : 'unassigned';
const sourceOfMode = (mode: unknown) => mode === 'offline' ? 'synthetic' : mode === 'live' ? 'ordinary' : null;

/** The same request identities and currency/unknown rules serve 1e and 2c. */
export function periodSpend(ops: OperationsMetricsReport): StatsFigures['spend'] {
  const period = new Set(ops.costs.period.requestIds), requests = ops.costs.requests.filter(r => period.has(r.id));
  const kinds: SpendKind[] = ['coding', 'eval', 'improve', 'maintenance', 'unassigned'];
  return {
    rows: kinds.map(kind => { const items = requests.filter(r => spendKind(r.kind) === kind); return { kind, totals: sumCostEstimates(items), tokens: items.reduce((n, r) => n + tokensOf(r.usage), 0) }; }),
    total: { totals: ops.costs.period.totals, tokens: requests.reduce((n, r) => n + tokensOf(r.usage), 0) },
  };
}

/** 读同一快照下的任务、运维、反馈三份报告与窗口内各 eval 计划的回归计数。只读，不取锁。 */
export function readStats(root: string, scope: StatsScope): StatsSnapshot {
  const task = queryTaskMetrics(root, scope), fixed = { ...scope, through: task.scope.through };
  const ops = queryOperationsMetrics(root, fixed), feedback = queryFeedbackMetrics(root, fixed);
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(scope.from) && Date.parse(at) < Date.parse(scope.to);

  // A display number is local to its root. Retain the complete source and the same acquisition cutoff for 2b.
  const sources = listPlanSources(root, { through: task.scope.through, limit: null });
  const candidates: PlanSource[] = sources.filter(s => s.root === root).map(s => ({ ...s, through: task.scope.through }));
  for (const child of ops.ownedChildren.snapshots as { dataRoot: string; planId: string; through: number }[]) {
    const ref = [...records(child.dataRoot, { through: child.through, kinds: ['eval.plan'] })].find(r => r.runId === child.planId);
    const source = sources.find(s => canonicalProject(s.root) === child.dataRoot && s.id === child.planId);
    if (source && ref) candidates.push({ ...source, root: child.dataRoot, at: ref.at, through: child.through });
  }
  const plans: StatsPlan[] = candidates.filter(source => inWindow(source.at)).flatMap(source => {
    const { report } = readPlanReport(source), counts = report.comparison?.regression.counts;
    if (!counts || sourceOfMode(report.plan.mode) !== scope.source) return [];
    const label = [source.label, source.origin?.label ?? (source.root !== root ? source.root : '')].filter(Boolean).join(' · ');
    return [{ source, report, label, at: source.at, P: counts.planned, V: counts.valid, R: counts.regressed }];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const regression = plans.map(({ label, at, P, V, R }) => ({ label, at, P, V, R }));
  const previous = [
    ...task.tasks.flatMap(t => t.acceptance.history.map(h => h.source)),
    ...[...feedback.intervention.tasks, ...feedback.rework.tasks].flatMap(t => t.feedback.history.map(h => h.source)),
    ...ops.costs.requests.filter(r => r.dataRoot === root).flatMap(r => r.history.filter(h => h.id).map(h => h.source as string)),
    ...plans.filter(p => p.source.root === root).flatMap(p => p.report.gradingRevisions.map(r => String(r.source))),
    ...ops.ownedChildren.snapshots.flatMap(c => c.parentCheckSource ? [String(c.parentCheckSource)] : []),
  ].map(id => Number(id.split(':')[1]) - 1).filter(n => Number.isSafeInteger(n) && n >= 0 && n < task.scope.through);
  const revisions = [task.scope.through, ...new Set(previous.sort((a, b) => b - a))];

  // 双时钟分段：只列宿主有记录的；均值按已测出执行历时的任务计，各分段均值相加等于执行均值（M3）。
  const measured = task.tasks.filter(t => t.clocks.execution.state === 'measured');
  const recorded = new Set<string>(task.tasks.flatMap(t => t.clocks.segments.map(s => s.kind)));
  const segments = (['queue', 'user-wait', 'active', 'recovery-offline', 'unknown'] as const).flatMap((kind): { kind: SegmentName; meanMs: number }[] => {
    if (!measured.length) return [];
    const meanMs = measured.reduce((n, t) => n + (t.clocks.partition.measured[kind] ?? 0), 0) / measured.length;
    return kind === 'unknown' ? (meanMs > 0 ? [{ kind, meanMs }] : []) : recorded.has(kind) ? [{ kind, meanMs }] : [];
  });

  const spend = periodSpend(ops);

  const i = feedback.intervention.counts, w = feedback.rework.counts, f = ops.faults.tasks.counts;
  const started = task.tasks.filter(t => t.startedSource);
  return {
    scope: fixed, root, reports: { task, operations: ops, feedback }, plans, planSources: candidates, revisions,
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
export function spendRows(f: Pick<StatsFigures, 'spend'>): SpendRow[] {
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

/** Metrics table; StatsBrowser owns tab selection, filters and evidence navigation. */
export class StatsView {
  /** Set by the interactive browser; omitted by standalone render oracles. */
  selectedRow?: number;
  hints?: string[];
  revisionLabel?: string;
  /** 表格滚动偏移（高度不够时） */
  private offset = 0;
  private data?: StatsData;
  /** 超上限时的原因码；此时不显示任何部分结果，`e` 不可用 */
  readonly limit?: string;

  constructor(readonly request: StatsRequest, read: (scope: StatsScope) => StatsData) {
    try { this.data = read(request.scope); }
    catch (error) { const code = limitCode(error); if (!code) throw error; this.limit = code; }
  }
  get stats() { return this.data; }
  /** 导出（#84）是否可用：超上限时不可用 */
  get exportable() { return !this.limit; }

  /** 返回 true 表示按键已处理。 */
  handleInput(data: string): boolean {
    if (matchesKey(data, 'up')) { this.scroll(-1); return true; }
    if (matchesKey(data, 'down')) { this.scroll(1); return true; }
    if (matchesKey(data, 'pageUp')) { this.scroll(-5); return true; }
    if (matchesKey(data, 'pageDown')) { this.scroll(5); return true; }
    return false;
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); }

  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const line = (segments: TextSegment[], bg?: TokenName) => styledLine(segments, width, bg, tier);
    // 页签行、头部、等价命令行与底栏都从共用边距起（U10）；底栏左侧说明、右侧键位，放不下时分两行。
    const tabs = line([{ text: '指标', fg: 'fg.primary', bold: true }, { text: ' · ', fg: 'fg.faint' }, { text: '本机实测', fg: 'fg.label' }]);
    const hints = this.hints ?? ['Tab 切换页签', '↑↓ 滚动'];
    const hint = hintLine(hints, width, { esc: escHint(1), tier });
    const tierW = widthTier(width), scope = this.request.scope;
    const head = [tabs, ...this.header(width, tier)];
    const command = line([{ text: `${GLYPHS.prompt} `, fg: 'ac.brand' }, { text: truncateEnd(clean(this.request.command), width - 2), fg: 'fg.body' }]);
    const footer = footerLines([{ text: truncateEnd(NOTE, width), fg: 'fg.label' }], hints, width, { esc: escHint(1), tier });

    if (!this.data) {
      const error = statusError(SCOPE_LIMITS[this.limit!], this.limit!, '/ 缩小时间或项目范围', width, tier);
      return fixedFrame(head, ['', ...error], [command, hint], height, 0).lines;
    }

    const f = this.data.figures, rows = metricRows(f), spend = spendRows(f);
    const covW = tierW === 'wide' ? COVER_W : tierW === 'medium' ? Math.min(COVER_W, width - 2 - LABEL_W - VALUE_W - 2 * GAP.length) : 0;
    const scopeW = Math.max(8, width - 2 - LABEL_W - VALUE_W - COVER_W - 3 * GAP.length);
    const bar = (ratio: number | null | undefined): TextSegment[] => {
      if (ratio === undefined) return [];
      const filled = ratio === null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * 10);
      return [{ text: '█'.repeat(filled), fg: 'ac.info' }, { text: (tier === 'none' ? '░' : '█').repeat(10 - filled), fg: 'line.track' }];
    };
    const range = `[${monthDay(scope.from)}, ${monthDay(scope.to)})`;
    const coverage = (row: MetricRow): TextSegment[] => [...bar(row.bar), ...row.coverage.map(s => ({ ...s, fg: s.fg ?? (row.bar === null ? 'fg.faint' : 'fg.muted') as TokenName }))];
    /**
     * 表格与期间开销的标题部分。`airy` 时（U10）头部下方、表头下方、期间开销之前各一条分隔线，
     * 数据行之间、期间开销之前各空一行；斑马底色只铺数据行。
     */
    const layout = (airy: boolean) => {
      const table: string[] = [''], starts: number[] = [];
      if (!this.data!.sample.N) table.push(line([{ text: `窗口内没有${SOURCE_LABEL[scope.source]}受理样本 · / 调整范围`, fg: 'fg.muted' }]));
      if (tierW === 'wide') {
        table.push(line([{ text: '  ' }, ...fitSegments([{ text: '指标' }], LABEL_W), { text: GAP }, ...fitSegments([{ text: '值' }], VALUE_W), { text: GAP }, ...fitSegments([{ text: '口径' }], scopeW), { text: GAP }, { text: '覆盖' }].map(s => ({ ...s, fg: 'fg.faint' as TokenName }))));
        if (airy) table.push(rule(width, 'line.subtle', tier));
      }
      rows.forEach((row, index) => {
        if (airy && index) table.push('');
        starts.push(table.length);
        const selected = this.selectedRow === index;
        const bg: TokenName | undefined = selected ? 'bg.selected' : index % 2 === 0 ? 'bg.zebra' : undefined;
        const value: TextSegment[] = [{ text: row.value.text, fg: TONE[row.value.tone], bold: row.value.tone !== 'na' }, ...row.value.unit ? [{ text: row.value.unit, fg: 'fg.faint' as TokenName }] : []];
        const scopeSegs = row.scope.map(s => ({ ...s, fg: s.fg ?? 'fg.body' as TokenName }));
        const label = fitSegments([{ text: row.label, fg: 'fg.primary' }], LABEL_W);
        if (tierW === 'wide') table.push(line([{ text: selected ? '› ' : '  ' }, ...label, { text: GAP }, ...fitSegments(value, VALUE_W), { text: GAP }, ...fitSegments(scopeSegs, scopeW), { text: GAP }, ...fitSegments(coverage(row), COVER_W)], bg));
        else {
          // 宽度小于 100：指标、值、覆盖一行，口径缩进一行，共用斑马底色；小于 60 去掉覆盖列。
          const first: TextSegment[] = [{ text: selected ? '› ' : '  ' }, ...label, { text: GAP }, ...fitSegments(value, VALUE_W)];
          if (covW > 0) first.push({ text: GAP }, ...fitSegments(coverage(row), covW));
          table.push(line(first, bg), line([{ text: '    ' }, ...fitSegments(scopeSegs, Math.max(1, width - 4))], bg));
        }
      });
      const spendTitle = line([{ text: `  期间开销（去重）· 请求发生于 ${range}`, fg: 'fg.label' }]);
      return { head: airy ? [...head, rule(width, 'line.subtle', tier)] : head, table, starts, spendHead: airy ? ['', rule(width, 'line.subtle', tier), '', spendTitle] : ['', spendTitle] };
    };
    const barW = tierW === 'wide' ? 24 : tierW === 'medium' ? 12 : 0;
    const max = Math.max(0, ...spend.map(r => r.known));
    const spendLine = (row: SpendRow) => {
      const selected = this.selectedRow === 7 + spend.findIndex(r => r.kind === row.kind);
      const segs: TextSegment[] = [{ text: selected ? '› ' : '  ' }, ...fitSegments([{ text: row.label, fg: row.kind === 'total' ? 'fg.primary' : 'fg.body' }], LABEL_W), { text: GAP }];
      if (barW) {
        const cells = max ? row.known / max * barW : 0, whole = Math.floor(cells);
        const glyphs = '█'.repeat(whole) + (cells - whole >= 0.5 || (row.known > 0 && whole === 0) ? '▌' : '');
        segs.push(...fitSegments([{ text: glyphs, fg: SPEND[row.kind].fg }], barW), { text: GAP });
      }
      segs.push(...row.text.map(s => ({ ...s, fg: s.fg ?? 'fg.muted' as TokenName })));
      return line(fitSegments(segs, width), selected ? 'bg.selected' : undefined);
    };
    const spendLines = spend.map(spendLine), totalOnly = [spendLine(spend.at(-1)!)];

    // 高度不够时依次收起：分隔线与空行、底部说明、等价命令行、期间开销（只剩合计）、表格滚动。页签行与底栏键位始终保留。
    const bodyOf = (parts: ReturnType<typeof layout>, spendPart: string[]) => [...parts.table, ...parts.spendHead, ...spendPart];
    const airy = layout(true), parts = airy.head.length + bodyOf(airy, spendLines).length + 1 + footer.length <= height ? airy : layout(false);
    const fits = (body: number, foot: number) => parts.head.length + body + foot <= height;
    let body = bodyOf(parts, spendLines), foot = [command, ...footer];
    if (!fits(body.length, foot.length)) foot = [command, hint];
    if (!fits(body.length, foot.length)) foot = [hint];
    if (!fits(body.length, foot.length) && (this.selectedRow === undefined || this.selectedRow < 7)) body = bodyOf(parts, totalOnly);
    if (this.selectedRow !== undefined) {
      const selected = this.selectedRow < 7 ? parts.starts[this.selectedRow] : parts.table.length + parts.spendHead.length + this.selectedRow - 7;
      const available = Math.max(1, height - parts.head.length - foot.length);
      if (selected < this.offset) this.offset = selected;
      else if (selected >= this.offset + available) this.offset = selected - available + 1;
    }
    const frame = fixedFrame(parts.head, body, foot, height, this.offset);
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
    if (this.revisionLabel) second.push(this.revisionLabel);
    const sample = data ? [`样本 ${data.sample.N}（筛除 ${data.sample.excluded}）`] : [];
    const brand: TextSegment[] = [{ text: '◆ ', fg: 'ac.model' }, { text: 'stats', fg: 'fg.primary', bold: true }, { text: '  ' }];
    const room = (segs: TextSegment[]) => width - segs.reduce((n, s) => n + visibleWidth(s.text), 0);
    if (widthTier(width) === 'wide') {
      const facts = clean([...first, ...second, ...sample].join(' · '));
      const left = [...brand, { text: facts, fg: 'fg.faint' as TokenName }], spare = room(left) - visibleWidth(RIGHT_NOTE) - 1;
      if (spare >= 2) return [styledLine([...left, { text: ' '.repeat(spare) }, { text: RIGHT_NOTE, fg: 'fg.faint' }], width, undefined, tier)];
      return [styledLine([...brand, { text: truncateEnd(facts, room(brand)), fg: 'fg.faint' }], width, undefined, tier)];
    }
    return [
      styledLine([...brand, { text: truncateEnd(clean([...first, ...sample].join(' · ')), room(brand)), fg: 'fg.faint' }], width, undefined, tier),
      styledLine([{ text: '  ' }, { text: truncateEnd(clean(second.join(' · ')), width - 2), fg: 'fg.faint' }], width, undefined, tier),
    ];
  }
}
