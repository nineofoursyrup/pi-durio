/**
 * 2b eval 视图（U8）：列表层与计划层。只读呈现：不调用模型、不写记录、不取锁。
 * 启动、停止批次与重评分（Enter 启动框、Ctrl+C、`r`）由 #82 接入；本文件只留 `runningHere` 钩子。
 */
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { formatAmount } from '../cost-estimate.js';
import { verifiedImage } from '../eval/plan.js';
import { BASELINE_ZERO, type Metric } from '../eval/comparison.js';
import { listPlanSources, planState, readPlanReport, PLAN_STATE_LABEL, type EvalReport, type EvalReportTrial, type PlanSource, type PlanState } from '../eval/overview.js';
import { COLOR_TIER, SPINNER_FRAMES, SPINNER_INTERVAL_MS, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { SPACER, clean, escHint, fixedFrame, fitSegments as fit, hintLine, settleSpacers, statusError, truncateEnd, widthTier } from './view-stack.js';
import { formatDuration, formatTokens } from './trace.js';
import { clock } from './session-screen.js';

// ─── 纯函数：字形、d、四格、判定原因（oracle 与 golden 共用） ─────────────────

/** 字形只表达有效性与评分（V9）：✓ PASS、✗ FAIL、? 无法评分或未取得结果、! 无效、⠹ 本 TUI 正在运行、· 未运行。 */
export type TrialGlyph = 'pass' | 'fail' | 'unknown' | 'invalid' | 'running' | 'not-run';
export const GLYPH: Record<TrialGlyph, { text: string; fg: TokenName }> = {
  pass: { text: '✓', fg: 'ac.ok' }, fail: { text: '✗', fg: 'ac.err' }, unknown: { text: '?', fg: 'ac.info' },
  invalid: { text: '!', fg: 'ac.warn' }, running: { text: '⠹', fg: 'ac.brand' }, 'not-run': { text: '·', fg: 'fg.gutter' },
};
export function trialGlyph(t: EvalReportTrial, runningHere = false): TrialGlyph {
  if (!t.outcome.started && t.outcome.status === 'not-run') return 'not-run';
  if (t.outcome.status === 'unknown') return runningHere ? 'running' : 'unknown';
  if (!t.outcome.valid) return 'invalid';
  if (t.grade?.outcome === t.outcome.source && t.grade.judgment === 'PASS') return 'pass';
  if (t.grade?.outcome === t.outcome.source && t.grade.judgment === 'FAIL') return 'fail';
  return 'unknown';
}
/** 说明列的执行状态（超时、取消、预算停止、服务故障等写在说明里，不用字形）。 */
const STATUS_NOTE: Record<string, string> = {
  timeout: '超时', cancelled: '取消', 'budget-stopped': '预算停止', 'service-error': '服务故障', invalid: '无效',
  'preparation-error': '准备失败', 'original-error': '原文写入失败', error: '任务出错',
};
export function trialNote(t: EvalReportTrial, runningHere = false): string | null {
  if (t.outcome.status === 'not-run') return null;
  if (t.outcome.status === 'unknown') return runningHere ? '运行中' : '未取得结果';
  if ((t.outcome as { evidenceAvailability?: string }).evidenceAvailability) return '证据不可读';
  const note = STATUS_NOTE[t.outcome.status];
  if (note) return note;
  return trialGlyph(t) === 'unknown' ? '无法评分' : null;
}

const METRIC_LABEL: Record<Metric, string> = { requests: '请求数', tokens: 'token', cost: '费用', taskMs: '耗时', 'task-pass': '任务通过' };
const CATEGORY_LABEL: Record<string, string> = { 'local-fix': '局部修复', 'multi-file': '多文件小改', regression: '回归', 'no-change': '反例' };
const currencySymbol = (currency: string | null | undefined) => currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? `${currency} ` : '';
const sign = (n: number) => n > 0 ? '+' : n < 0 ? '−' : '';
const trimNumber = (n: number) => String(+n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2));

/**
 * d 或 δ 的显示：相对口径写百分比（+18%）；首版旧计划保留绝对值并带单位（+2 请求、−$0.02、+1.2s）；task-pass 为通过差。
 * `signed=false` 用于 δ。
 */
export function formatDelta(report: Pick<EvalReport, 'plan'>, metric: Metric, value: number, signed = true): string {
  const relative = report.plan.comparison?.scale === 'relative' && metric !== 'task-pass';
  const s = signed ? sign(value) : '', v = Math.abs(value);
  if (relative) return `${s}${trimNumber(v * 100)}%`;
  if (metric === 'requests') return `${s}${trimNumber(v)} 请求`;
  if (metric === 'tokens') return `${s}${formatTokens(v)} tok`;
  if (metric === 'taskMs') return `${s}${formatDuration(v)}`;
  if (metric === 'cost') return `${s}${currencySymbol(report.plan.price?.currency)}${v > 0 && v < 0.01 ? v.toPrecision(2) : v.toFixed(2)}`;
  return `${s}${trimNumber(v)}`;
}

/** 四格（主目标、门槛、保护、预算）；单侧计划只显示预算，其余标“无对照”。 */
export function planCells(report: EvalReport): { label: string; value: string }[] {
  const c = report.plan.comparison, budget = report.budget, limit = budget.amounts.limit;
  const money = limit ? formatAmount(limit.amount, limit.currency) : `${budget.limits.maxTokens} tok`;
  const cells = [{ label: '预算', value: `${budget.limits.maxRequests} 请求 · ${money}` }];
  if (!c) return [{ label: '主目标', value: '无对照' }, { label: '门槛', value: '无对照' }, { label: '保护', value: '无对照' }, ...cells];
  const hard = c.protections.filter(p => p.kind === 'hard').length, soft = c.protections.length - hard;
  const cases = new Set(c.protections.flatMap(p => p.cases)).size;
  const threshold = report.comparison?.thresholdValid && c.objective.delta !== null;
  return [
    { label: '主目标', value: `${METRIC_LABEL[c.objective.metric]} ${c.objective.direction === 'lower' ? '↓' : '↑'}` },
    { label: '门槛', value: threshold ? `每配对 d ≥ δ = ${formatDelta(report, c.objective.metric, c.objective.delta!, false)}` : '未设门槛 · 只诊断' },
    { label: '保护', value: `硬约束 ${hard} · 软约束 ${soft} · ${cases} 案例` },
    ...cells,
  ];
}

/** 隔离徽章：离线受控；已验证镜像且没有 trial 的边界检查失败；否则写失败 trial 数。 */
export function isolationBadge(report: EvalReport): { text: string; fg: TokenName } {
  if (report.mode === 'offline') return { text: '离线受控 · 不判模型质量', fg: 'fg.muted' };
  const failed = report.trials.filter(t => t.outcome.status === 'invalid' || t.grade?.reason?.startsWith('isolation:')).length;
  return report.plan.image === verifiedImage && !failed ? { text: '✓ 隔离已验证', fg: 'ac.ok' } : { text: `! 隔离检查未通过 ${failed} 个 trial`, fg: 'ac.warn' };
}
/** grader：各案例同版本写“grader g2 · 可信侧”，否则“按案例 N 个版本”；重评分后加评分修订号。 */
export function graderText(report: EvalReport): string {
  const versions = new Set(report.plan.cases.map(c => report.gradingRevisions.findLast(r => r.graders[c.id])?.graders[c.id].version ?? c.grader.version));
  const revision = report.gradingRevisions.length ? ` · 评分修订 #${report.gradingRevisions.length}` : '';
  return `${versions.size === 1 ? `grader ${[...versions][0]} · 可信侧` : `按案例 ${versions.size} 个版本`}${revision}`;
}

export interface CaseRow {
  id: string; category: string; protectionOnly: boolean;
  /** baseline 在前、candidate 在后，各按 repeat 排序；单侧计划只有 candidate */
  trials: { trial: EvalReportTrial; side: 'A' | 'B' | ''; glyph: TrialGlyph }[];
  /** 该案例有效配对中最差的 d；没有时为 null */
  worst: number | null;
  note: string;
}
export function caseRows(report: EvalReport, runningHere = false): CaseRow[] {
  const c = report.plan.comparison, pairs = report.comparison?.pairs ?? [];
  const delta = c?.objective.delta ?? null, threshold = !!report.comparison?.thresholdValid && delta !== null;
  return report.plan.cases.map(fixture => {
    const own = report.trials.filter(t => t.caseId === fixture.id)
      .sort((a, b) => Number(a.side !== 'baseline') - Number(b.side !== 'baseline') || a.repeat - b.repeat);
    const trials = own.map(trial => ({ trial, side: (c ? trial.side === 'baseline' ? 'A' : 'B' : '') as 'A' | 'B' | '', glyph: trialGlyph(trial, runningHere) }));
    const protectionOnly = !!c && c.roles[fixture.id] === 'protection';
    const objective = pairs.filter(p => p.caseId === fixture.id && p.role === 'objective');
    const known = objective.filter(p => p.delta !== null).map(p => p.delta!);
    const notes: string[] = [];
    if (c && !protectionOnly && objective.length) {
      if (threshold) notes.push(`${known.filter(d => d >= delta!).length}/${objective.length} 配对 ≥ δ`);
      const zero = objective.filter(p => p.exclusion === BASELINE_ZERO).length;
      if (zero) notes.push(`${zero} 个配对 baseline 为 0，不可比`);
    }
    if (trials.every(t => t.glyph === 'not-run')) notes.push('未运行');
    else for (const t of trials) { const note = trialNote(t.trial, runningHere); if (note) notes.push(`${t.side ? `${t.side} ` : ''}r${t.trial.repeat} ${note}`); }
    return { id: fixture.id, category: `${CATEGORY_LABEL[fixture.category] ?? fixture.category}${protectionOnly ? ' · 仅保护' : ''}`, protectionOnly, trials, worst: known.length ? Math.min(...known) : null, note: notes.join(' · ') };
  });
}

export type Conclusion = '改善' | '退化' | '无明显差异' | '证据不足' | '不判改善' | '未开始';
/** 判定框：结论加由事实拼成的中文原因（U8）。 */
export function verdict(report: EvalReport, runningHere = false): { conclusion: Conclusion; reasons: string[]; rule: string } {
  const c = report.comparison, plan = report.plan.comparison;
  const rows = caseRows(report, runningHere), glyphs = rows.flatMap(r => r.trials.map(t => t.glyph));
  const count = (g: TrialGlyph) => glyphs.filter(x => x === g).length;
  if (planState(report) === 'not-started') return { conclusion: plan ? '未开始' : '不判改善', reasons: [plan ? '批次未开始' : '未设对照，不判改善'], rule: plan ? '改善需全部计划有效且每配对 d ≥ δ' : '单侧计划只诊断' };
  const facts: string[] = [];
  const incomplete = report.trials.some(t => t.outcome.status !== 'completed');
  if (incomplete) facts.push('计划未完成');
  if (count('invalid')) facts.push(`${count('invalid')} 个 trial 无效`);
  if (count('running')) facts.push(`${count('running')} 个 trial 运行中`);
  if (count('unknown')) {
    const missing = report.trials.filter(t => t.outcome.status === 'unknown').length;
    if (missing && !runningHere) facts.push(`${missing} 个 trial 未取得结果`);
    if (count('unknown') - (runningHere ? 0 : missing) > 0) facts.push(`${count('unknown') - (runningHere ? 0 : missing)} 个 trial 无法评分`);
  }
  if (rows.some(r => r.protectionOnly && r.trials.every(t => t.glyph === 'not-run'))) facts.push('保护案例未运行');
  if (!plan || !c) return { conclusion: '不判改善', reasons: ['未设对照，不判改善', ...facts], rule: '单侧计划只诊断' };
  const zero = c.pairs.filter(p => p.exclusion === BASELINE_ZERO).length;
  if (zero) facts.push(`${zero} 个配对 baseline 为 0，不可比`);
  if (c.hardRegressions.length) facts.push(`硬约束新增退化 ${c.hardRegressions.length} 处`);
  if (c.softRegressions.length) facts.push(`软保护一致越过容忍度 ${c.softRegressions.length} 处`);
  if (!c.thresholdValid) facts.push('未设判定门槛');
  if (!c.repetitionValid) facts.push('重复次数不足');
  if (!incomplete && c.evidenceGaps.length) facts.push(`证据缺口 ${c.evidenceGaps.length} 项`);
  const conclusion = c.conclusion as Conclusion, objectives = c.pairs.filter(p => p.role === 'objective');
  if (conclusion === '改善') facts.push(`全部 ${objectives.length} 个主目标配对 d ≥ δ · 保护通过`);
  if (conclusion === '无明显差异') facts.push(`全部 ${objectives.length} 个主目标配对 −δ < d < δ · 保护通过`);
  if (conclusion === '退化' && !c.hardRegressions.length && !c.softRegressions.length) facts.push('主目标每配对 d ≤ −δ');
  if (conclusion === '证据不足' && !facts.length) facts.push('配对方向不一致或未达门槛');
  return { conclusion, reasons: facts, rule: conclusion === '证据不足' ? '改善需全部计划有效且每配对 d ≥ δ' : '结论只限本批案例、重复与受限环境' };
}

const CONCLUSION_FG: Record<Conclusion, TokenName> = { 改善: 'ac.ok', 退化: 'ac.err', 无明显差异: 'fg.primary', 证据不足: 'ac.warn', 不判改善: 'fg.muted', 未开始: 'fg.muted' };
/** 列表层的判定一词。 */
export function verdictWord(report: EvalReport): string {
  if (planState(report) === 'not-started') return '—';
  return report.plan.comparison ? report.improvement : '不判改善';
}

// ─── 共用排版 ────────────────────────────────────────────────────────────────

const width$ = (segments: TextSegment[]) => segments.reduce((n, s) => n + visibleWidth(s.text), 0);
const spinner = () => SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
const amountText = (report: EvalReport) => {
  const cost = report.cost;
  if (!cost.price) return 'unknown（计划未固定价格）';
  return `${cost.knownTokens || !cost.missing ? formatAmount(cost.knownValue ?? 0, cost.price.currency) : 'unknown'}${cost.missing ? ` +${cost.missing} unknown` : ''}`;
};

// ─── 列表层 ──────────────────────────────────────────────────────────────────

interface ListRow { source: PlanSource; purpose: string; state: PlanState | null; verdict: string; error?: string }
const EMPTY = '还没有 eval 计划 · 新建用 pi-durio eval plan，或 improve 的 fresh 对照';

/** 列表层：主数据根的计划与 improve 发起的计划；每行 `ep-号 · 用途 · 状态 · 判定`。 */
export class EvalListView {
  private rows: ListRow[];
  private selected = 0;
  private offset = 0;
  constructor(root: string, private readonly host: { openPlan(source: PlanSource): void }) {
    this.rows = listPlanSources(root).map(source => {
      try {
        const { report } = readPlanReport(source);
        return { source, purpose: report.purpose, state: planState(report), verdict: verdictWord(report) };
      } catch (error) { return { source, purpose: '', state: null, verdict: '', error: clean(String((error as Error)?.message ?? error)).split(/[\s:]/)[0] }; }
    });
  }
  get sources() { return this.rows.map(r => r.source); }
  handleInput(data: string): boolean {
    if (matchesKey(data, 'up')) { this.selected = Math.max(0, this.selected - 1); return true; }
    if (matchesKey(data, 'down')) { this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1); return true; }
    if (matchesKey(data, 'enter') && this.rows[this.selected]) { this.host.openPlan(this.rows[this.selected].source); return true; }
    return false;
  }
  scroll(delta: number) { this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + Math.sign(delta))); }
  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const line = (segments: TextSegment[], bg?: TokenName) => styledLine(segments, width, bg, tier);
    const header = [line([{ text: ' ◆ ', fg: 'ac.info' }, { text: 'eval', fg: 'fg.primary', bold: true }, { text: `  计划 ${this.rows.length} 份 · 本数据根与 improve 发起`, fg: 'fg.faint' }]), line([{ text: '─'.repeat(width), fg: 'line.subtle' }])];
    const footer = [hintLine(this.rows.length ? ['↑↓ 选择', 'Enter 打开'] : [], width, { esc: escHint(1), tier })];
    if (!this.rows.length) return fixedFrame(header, [line([{ text: ` ${EMPTY}`, fg: 'fg.muted' }])], footer, height, 0).lines;
    const narrow = width < 60;
    const body = this.rows.map((row, i) => {
      const selected = i === this.selected, bg: TokenName | undefined = selected ? 'bg.selected' : undefined;
      const tail: TextSegment[] = row.error
        ? [{ text: ` · 不可读取 · ${row.error}`, fg: 'ac.err' }]
        : [{ text: ` · ${PLAN_STATE_LABEL[row.state!]}`, fg: row.state === 'running' ? 'ac.brand' : 'fg.muted' }, { text: ` · ${row.verdict}`, fg: CONCLUSION_FG[(row.verdict === '—' ? '未开始' : row.verdict) as Conclusion] ?? 'fg.body' }];
      const head: TextSegment[] = [{ text: selected ? ' › ' : '   ', fg: 'ac.brand' }, { text: row.source.label, fg: 'fg.primary' }, ...row.source.origin ? [{ text: ` · ${row.source.origin.label}`, fg: 'ac.improve' as TokenName }] : []];
      const room = width - width$(head) - width$(tail) - 3;
      const purpose: TextSegment[] = !narrow && room > 6 ? [{ text: ` · ${truncateEnd(clean(row.purpose), room)}`, fg: 'fg.body' }] : [];
      return line(fit([...head, ...purpose, ...tail], width).map(s => ({ ...s, bg })), bg);
    });
    const room = Math.max(1, height - header.length - footer.length);
    if (this.selected < this.offset) this.offset = this.selected; else if (this.selected >= this.offset + room) this.offset = this.selected - room + 1;
    const frame = fixedFrame(header, body, footer, height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }
}

// ─── 计划层 ──────────────────────────────────────────────────────────────────

export interface PlanViewHost {
  /** Enter：用 2a 视图打开选中 trial 的 trace（V7） */
  openTrial(source: PlanSource, report: EvalReport, trialId: string): void;
}
export interface PlanViewOptions {
  /** 本 TUI 正在运行该批次（#82）：未取得结果的 trial 显示 ⠹，状态行显示进度 */
  runningHere?: () => boolean;
  stoppingHere?: () => boolean;
  /** 视图栈深度（Esc 文案）；默认 2（从列表层进入） */
  depth?: number;
  /** 渲染时刻（golden 固定用） */
  now?: () => number;
}

/** 计划层：计划头、隔离徽章、grader、四格、案例 × trial 矩阵、两侧计数与三率、预算条、判定框、状态行（U8）。 */
export class EvalPlanView {
  private current?: EvalReport;
  private from: 'live' | 'snapshot' = 'live';
  private error?: { message: string; code: string };
  private caseIndex = 0;
  private trialIndex = 0;
  private offset = 0;
  private lastRead = 0;
  /** 旧报告修订：undefined 为最新；其余为截止序号 */
  private revisions: (number | undefined)[] = [undefined];
  private revision = 0;

  constructor(readonly source: PlanSource, private readonly host: PlanViewHost, private readonly options: PlanViewOptions = {}) {
    this.refresh();
  }
  get report() { return this.current; }
  refresh(){this.read();if(this.current)this.revisions=[this.source.through,...this.current.gradingRevisions.toReversed().map(r=>Number(String(r.source).split(':')[1])-1)];}
  private now() { return this.options.now?.() ?? Date.now(); }
  private runningHere() { return !!this.options.runningHere?.(); }
  /** 批次未结束（运行中）且看的是最新报告：宿主定时重绘，render 每秒最多重读一次。 */
  get live() { return this.source.through === undefined && !!this.current && this.revision === 0 && planState(this.current) === 'running'; }
  private read() {
    try { const read = readPlanReport(this.source, { asOf: this.revisions[this.revision] }); this.current = read.report; this.from = read.from; this.error = undefined; }
    catch (error) { const text = clean(String((error as Error)?.message ?? error)); this.error = { message: '计划报告不可读取', code: text.replace(/^Error:\s*/, '').split(/[\s:]/)[0] || 'EVAL_REPORT_UNAVAILABLE' }; }
    this.lastRead = Date.now();
  }
  private rows() { return this.current ? caseRows(this.current, this.runningHere()) : []; }
  get selectedTrial() { return this.rows()[this.caseIndex]?.trials[this.trialIndex]?.trial; }
  handleInput(data: string): boolean {
    const rows = this.rows();
    if (matchesKey(data, 'up')) { this.caseIndex = Math.max(0, this.caseIndex - 1); this.clampTrial(rows); return true; }
    if (matchesKey(data, 'down')) { this.caseIndex = Math.min(Math.max(0, rows.length - 1), this.caseIndex + 1); this.clampTrial(rows); return true; }
    if (matchesKey(data, 'left')) { this.trialIndex = Math.max(0, this.trialIndex - 1); return true; }
    if (matchesKey(data, 'right')) { this.trialIndex = Math.min(Math.max(0, (rows[this.caseIndex]?.trials.length ?? 1) - 1), this.trialIndex + 1); return true; }
    if (matchesKey(data, 'enter')) { const trial = this.selectedTrial; if (trial && this.current) this.host.openTrial(this.source, this.current, trial.id); return true; }
    if (data === 'v' && this.revisions.length > 1) { this.revision = (this.revision + 1) % this.revisions.length; this.read(); return true; }
    return false;
  }
  private clampTrial(rows: CaseRow[]) { this.trialIndex = Math.min(this.trialIndex, Math.max(0, (rows[this.caseIndex]?.trials.length ?? 1) - 1)); }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); }
  /** 选中某个 trial（1e 下钻、测试）。 */
  select(trialId: string) {
    this.rows().forEach((row, ci) => row.trials.forEach((t, ti) => { if (t.trial.id === trialId) { this.caseIndex = ci; this.trialIndex = ti; } }));
  }

  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    if ((this.live||this.runningHere()) && Date.now() - this.lastRead >= 1000) this.read();
    const line = (segments: TextSegment[], bg?: TokenName) => styledLine(segments, width, bg, tier);
    const rule = line([{ text: '─'.repeat(width), fg: 'line.subtle' }]);
    const esc = escHint(this.options.depth ?? 2);
    const hints = ['↑↓ 案例', '←→ trial', 'Enter trial trace', 'r 重评分',...this.runningHere()?['Ctrl+C 停止批次']:[],...this.revisions.length > 1 ? ['v 旧报告修订'] : []];
    if (!this.current) {
      const head = [line([{ text: '◆ ', fg: 'ac.info' }, { text: 'eval', fg: 'fg.primary', bold: true }, { text: `  计划 ${this.source.label}`, fg: 'fg.faint' }]), rule];
      return fixedFrame(head, ['', ...statusError(this.error!.message, this.error!.code, this.source.origin ? '在 improve 视图的历史报告中查看该决定' : 'pi-durio eval report 查看原因', width, tier)], [hintLine([], width, { esc, tier })], height, 0).lines;
    }
    const report = this.current, tierW = widthTier(width), running = this.runningHere();
    const rows = caseRows(report, running);
    this.caseIndex = Math.min(this.caseIndex, Math.max(0, rows.length - 1)); this.clampTrial(rows);
    const head = [...this.header(report, width, tier), rule];

    // 主体（可滚动）：四格、矩阵、图例、两侧计数、预算；各块之间空一行（U10）。
    const body: string[] = [SPACER];
    const cells = planCells(report), cellFg = (value: string): TokenName => value === '无对照' ? 'fg.faint' : 'fg.primary';
    if (tierW === 'wide') {
      const w = Math.floor(width / 4);
      body.push(line(cells.flatMap(c => fit([{ text: c.label, fg: 'fg.label' }], w))));
      body.push(line(cells.flatMap(c => fit([{ text: c.value, fg: cellFg(c.value) }], w))));
    } else if (tierW === 'medium') {
      const w = Math.floor(width / 2);
      for (let i = 0; i < 4; i += 2) body.push(line([cells[i], cells[i + 1]].flatMap(c => fit([{ text: `${c.label}  `, fg: 'fg.label' }, { text: c.value, fg: cellFg(c.value) }], w))));
    } else for (const c of cells) body.push(line([{ text: `${c.label}  `, fg: 'fg.label' }, { text: c.value, fg: cellFg(c.value) }]));
    body.push(line([]));
    const LEGEND: Record<TrialGlyph, string> = { pass: '通过', fail: '失败', invalid: '无效 / 污染', running: '运行中', 'not-run': '未运行', unknown: '无法评分 / 未取得结果' };
    const legend = line([{ text: ' ' }, ...(['pass', 'fail', 'invalid', 'running', 'not-run', 'unknown'] as TrialGlyph[]).flatMap(g => [{ text: GLYPH[g].text, fg: GLYPH[g].fg }, { text: ` ${LEGEND[g]}   `, fg: 'fg.faint' as TokenName }])]);
    // 宽屏时预算与四格的第三格对齐（设计稿 2b）。
    const half = 2 * Math.floor(width / 4);
    const counts = this.counts(report, tierW === 'wide' ? half : width, tier);
    const budget = this.budget(report, tierW === 'wide' ? width - half : width, tier);
    const lower = (withNotes: boolean) => {
      const c = withNotes ? counts : counts.slice(0, -1), b = withNotes ? budget : budget.slice(0, -1);
      if (tierW !== 'wide') return [...c, line([]), ...b];
      return Array.from({ length: Math.max(c.length, b.length) }, (_, i) => (c[i] ?? styledLine([], half, undefined, tier)) + (b[i] ?? styledLine([], width - half, undefined, tier)));
    };

    // 底栏上方固定：判定框（矮时一行）、状态行；宽度小于 100 时加选中案例的摘要行。
    const v = verdict(report, running);
    const box = this.verdictBox(v, width, tier);
    const oneLine = [line([{ text: '当前判定  ', fg: 'fg.label' }, { text: v.conclusion, fg: CONCLUSION_FG[v.conclusion], bold: true }, { text: `  ${v.reasons.join(' · ')}`, fg: 'fg.muted' }])];
    const status = this.status(report, width, tier), hint = hintLine(hints, width, { esc, tier });
    const selectedRow = rows[this.caseIndex];
    const summary = tierW === 'wide' ? [] : [line([{ text: truncateEnd(clean(`${selectedRow?.id ?? ''} · ${this.trialLabel(rows)}${selectedRow?.note ? ` · ${selectedRow.note}` : ''}`), width), fg: 'fg.body' }])];
    // 高度不够时依次：收空行（矩阵行间、块间）、收图例与计数公式行（含预算说明行）、判定框收成一行、主体滚动且选中案例始终可见。
    // SPACER 的去留与 fixedFrame 同一规则（settleSpacers）；紧凑时先去掉，再逐级收起。
    let matrix = this.matrix(report, rows, width, tier, true), full = [...body, ...matrix.lines, legend, line([]), ...lower(true)], foot = [SPACER, ...box, status, ...summary, hint];
    const fits = () => head.length + full.length + foot.length <= height, airy = fits();
    if (!airy) { matrix = this.matrix(report, rows, width, tier, false); full = settleSpacers([...body, ...matrix.lines, legend, line([]), ...lower(true)], false); foot = settleSpacers(foot, false); }
    if (!fits()) full = settleSpacers([...body, ...matrix.lines, line([]), ...lower(false)], false);
    if (!fits()) foot = [...oneLine, status, ...summary, hint];
    const room = Math.max(0, height - head.length - foot.length);
    // 选中案例的位置按实际进入 frame 的行计：矩阵之前是收起后的 body。
    const top = settleSpacers(body, airy).length + matrix.selectedTop, bottom = top + matrix.selectedBottom - matrix.selectedTop;
    if (top < this.offset) this.offset = top; else if (bottom >= this.offset + room) this.offset = bottom - room + 1;
    const frame = fixedFrame(head, full, foot, height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }

  private header(report: EvalReport, width: number, tier: ColorTier): string[] {
    const c = report.plan.comparison;
    const short = (side: string) => report.trials.find(t => t.side === side)?.version.slice(0, 7) ?? '—';
    const sides = !c ? '无对照' : this.source.origin
      ? `A = 基线 ${c.sides.baseline.runtime.id.slice(0, 7)} · B = ${this.source.origin.label}`
      : `A = ${short('baseline')} · B = ${short('candidate')}`;
    const old = this.revision ? ` · 报告修订 #${this.revisions[this.revision]}` : this.source.through !== undefined ? ` · stats 截止 #${this.source.through}` : '';
    const left: TextSegment[] = [{ text: '◆ ', fg: 'ac.info' }, { text: 'eval', fg: 'fg.primary', bold: true }, { text: `  计划 ${this.source.label}${old} · ${clean(report.purpose)} · ${sides}`, fg: 'fg.faint' }];
    const badge = isolationBadge(report);
    const right: TextSegment[] = [{ text: badge.text, fg: badge.fg }, { text: ` · ${graderText(report)}${this.from === 'snapshot' ? ' · 报告快照' : ''} `, fg: 'fg.faint' }];
    // 头部右侧是事实：放不下（宽度小于 100）时移到第二行，不收起（U12）。
    if (width >= 100) {
      const spare = width - width$(right);
      if (width$(left) + 2 <= spare) return [styledLine([...left, { text: ' '.repeat(spare - width$(left)) }, ...right], width, undefined, tier)];
      return [styledLine([...fit(left, spare - 1), { text: ' ' }, ...right], width, undefined, tier)];
    }
    return [styledLine(fit(left, width), width, undefined, tier), styledLine(fit([{ text: '  ' }, ...right], width), width, undefined, tier)];
  }

  private trialLabel(rows: CaseRow[]) {
    const t = rows[this.caseIndex]?.trials[this.trialIndex];
    return t ? `${t.side ? `${t.side} ` : ''}r${t.trial.repeat} ${GLYPH[t.glyph].text}` : '没有 trial';
  }

  /** 案例 × trial 矩阵。返回选中案例在矩阵内的起止行，用于滚动时保持可见。 */
  /** `airy`：表头下一条分隔线，数据行之间空一行（U10）。斑马底色只铺数据行，不随 `airy` 收起。 */
  private matrix(report: EvalReport, rows: CaseRow[], width: number, tier: ColorTier, airy: boolean) {
    const tierW = widthTier(width), plan = report.plan.comparison, metric = plan?.objective.metric;
    const reps = Math.max(1, ...rows.map(r => Math.max(r.trials.filter(t => t.side === 'A').length, r.trials.filter(t => t.side !== 'A').length)));
    const slot = tierW === 'narrow' ? 1 : 3, sided = !!plan;
    const groupW = (sided ? 2 : 0) + (slot > 1 ? reps * slot - 1 : reps);
    const caseW = tierW === 'wide' ? 22 : tierW === 'medium' ? 20 : Math.max(8, Math.min(16, width - 2 * groupW - 14));
    const typeW = tierW === 'wide' ? 14 : 0, dW = 8, gap = tierW === 'narrow' ? '  ' : '   ';
    const noteW = tierW === 'wide' ? Math.max(8, width - 1 - caseW - typeW - groupW * (sided ? 2 : 1) - dW - gap.length * (sided ? 5 : 4)) : 0;
    const dName = metric ? `d ${METRIC_LABEL[metric]}` : 'd';
    const lines: string[] = [];
    const glyphs = (row: CaseRow, side: 'A' | 'B' | '', ci: number): TextSegment[] => {
      const own = row.trials.map((t, ti) => ({ ...t, ti })).filter(t => !sided || t.side === side);
      const segs: TextSegment[] = sided ? [{ text: `${side} `, fg: 'fg.faint' }] : [];
      own.forEach((t, k) => {
        const selected = ci === this.caseIndex && t.ti === this.trialIndex, g = GLYPH[t.glyph];
        // 无色档不画底色：选中的 trial 用反显（U10）。
        const text = tier === 'none' && selected ? `\x1b[7m${g.text}\x1b[27m` : g.text;
        segs.push({ text, fg: g.fg, bg: selected ? 'bg.selected' : undefined, bold: selected });
        if (slot > 1 && k < own.length - 1) segs.push({ text: ' '.repeat(slot - 1) });
      });
      return fit(segs, groupW);
    };
    const delta = plan?.objective.delta ?? null, threshold = !!report.comparison?.thresholdValid && delta !== null;
    const dText = (row: CaseRow): TextSegment => row.worst === null || !metric ? { text: '—', fg: 'fg.faint' }
      : { text: formatDelta(report, metric, row.worst), fg: !threshold ? 'fg.body' : row.worst >= delta! ? 'ac.ok' : row.worst <= -delta! ? 'ac.err' : 'ac.warn' };
    const repsHead = (side: string) => fit([{ text: sided ? `${side} ` : '' }, { text: slot > 1 ? Array.from({ length: reps }, (_, i) => `r${i + 1}`.padEnd(slot)).join('').trimEnd() : '' }], groupW);
    const headSegs: TextSegment[] = [{ text: ' ' }, ...fit([{ text: 'case' }], caseW), ...typeW ? [{ text: gap }, ...fit([{ text: '类型' }], typeW)] : [], { text: gap }, ...repsHead('A'), ...sided ? [{ text: gap }, ...repsHead('B')] : [], { text: gap }, ...fit([{ text: dName }], dW), ...noteW ? [{ text: gap }, { text: '说明' }] : []];
    lines.push(styledLine(headSegs.map(s => ({ ...s, fg: 'fg.faint' as TokenName })), width, undefined, tier));
    if (airy) lines.push(styledLine([{ text: '─'.repeat(width), fg: 'line.subtle' }], width, undefined, tier));
    let selectedTop = 0, selectedBottom = 0;
    rows.forEach((row, ci) => {
      if (airy && ci) lines.push(styledLine([], width, undefined, tier));
      const selected = ci === this.caseIndex, zebra: TokenName | undefined = ci % 2 ? 'bg.zebra' : undefined;
      const name: TextSegment = { text: row.id, fg: selected ? 'fg.primary' : 'fg.body', bold: selected };
      const marker: TextSegment = { text: selected ? '›' : ' ', fg: 'ac.brand' };
      const a = glyphs(row, sided ? 'A' : '', ci), b = sided ? glyphs(row, 'B', ci) : [];
      const one: TextSegment[] = [marker, ...fit([name], caseW), ...typeW ? [{ text: gap }, ...fit([{ text: row.category, fg: 'fg.muted' as TokenName }], typeW)] : [], { text: gap }, ...a, ...sided ? [{ text: gap }, ...b] : [], { text: gap }, ...fit([dText(row)], dW), ...noteW ? [{ text: gap }, ...fit([{ text: row.note, fg: 'fg.muted' as TokenName }], noteW)] : []];
      if (selected) selectedTop = lines.length;
      if (width$(one) <= width) lines.push(styledLine(one, width, zebra, tier));
      else {
        // 宽度小于 60 仍放不下：该案例折成两行（名称与 d / 两侧字形），每个 trial 仍能单独选中。
        lines.push(styledLine([marker, ...fit([name], Math.max(1, width - dW - 3)), { text: ' ' }, dText(row)], width, zebra, tier));
        lines.push(styledLine([{ text: '   ' }, ...a, ...sided ? [{ text: ' ' }, ...b] : []], width, zebra, tier));
      }
      if (selected) selectedBottom = lines.length - 1;
    });
    return { lines, selectedTop, selectedBottom };
  }

  private counts(report: EvalReport, width: number, tier: ColorTier): string[] {
    const line = (segments: TextSegment[]) => styledLine(segments, width, undefined, tier);
    const rate = (n: number | null) => n === null ? 'N/A' : `${trimNumber(n * 100)}%`;
    const narrow = width < 60;
    const heads = ['计划', '启动', '完成', '可评分', '通过', ...narrow ? [] : ['通过率', '完成率', '覆盖率']];
    // 列宽按可用宽度均分，每列至多 12 列（设计稿 2b）；放不下时按内容宽度。
    const even = Math.min(12, Math.floor((width - 4) / heads.length)), widths = heads.map(h => Math.max(even, Math.max(visibleWidth(h), h.endsWith('率') ? 6 : 4) + 1));
    const sides: [string, EvalReport['counts'] | undefined][] = report.plan.comparison ? [['A', report.sides.baseline], ['B', report.sides.candidate]] : [['计', report.counts]];
    const out = [line([{ text: '两侧计数', fg: 'fg.label' }]), line([{ text: '    ' }, ...heads.map((h, i) => ({ text: ' '.repeat(widths[i] - visibleWidth(h)) + h, fg: 'fg.faint' as TokenName }))])];
    for (const [label, c] of sides) {
      if (!c) continue;
      const values = [c.planned, c.started, c.completed, c.gradable, c.passed].map(String);
      const rates = narrow ? [] : [rate(c.passRate), rate(c.completionRate), rate(c.coverageRate)];
      out.push(line([{ text: `${label}   `, fg: 'fg.faint' }, ...[...values, ...rates].map((v, i): TextSegment => ({ text: v.padStart(widths[i]), fg: v === 'N/A' ? 'fg.faint' : i >= 5 ? 'fg.primary' : 'fg.body' }))]));
    }
    out.push(line([{ text: '通过率 = 通过/可评分 · 完成率 = 完成/计划 · 覆盖率 = 可评分/计划', fg: 'fg.muted' }]));
    return out;
  }

  private budget(report: EvalReport, width: number, tier: ColorTier): string[] {
    const line = (segments: TextSegment[]) => styledLine(segments, width, undefined, tier);
    const barW = Math.max(6, Math.min(24, width - 34));
    const bar = (ratio: number | null): TextSegment[] => {
      const filled = ratio === null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * barW);
      return [{ text: '█'.repeat(filled), fg: 'ac.info' }, { text: (tier === 'none' ? '░' : '█').repeat(barW - filled), fg: 'line.track' }];
    };
    const b = report.budget, limit = b.amounts.limit, cost = report.cost;
    const money = limit ? `${amountText(report)} / ${currencySymbol(limit.currency)}${limit.amount.toFixed(2)}` : amountText(report);
    return [
      line([{ text: '预算', fg: 'fg.label' }]),
      line([...bar(b.requests / b.limits.maxRequests), { text: `  ${b.requests} / ${b.limits.maxRequests} 请求`, fg: 'fg.body' }]),
      line([...bar(limit && limit.amount > 0 ? (cost.knownValue ?? 0) / limit.amount : null), { text: `  ${money}`, fg: cost.missing ? 'ac.warn' : 'fg.body' }, { text: ' · 含两侧、失败与压缩', fg: 'fg.faint' }]),
      line([{ text: '重启不重置额度 · 未知用量按在途上界占额 · 上限按高峰价', fg: 'fg.muted' }]),
    ];
  }

  private verdictBox(v: ReturnType<typeof verdict>, width: number, tier: ColorTier): string[] {
    const inner = Math.max(4, width - 2);
    const edge = (l: string, r: string) => styledLine([{ text: `${l}${'─'.repeat(inner)}${r}`, fg: 'border.input' }], width, undefined, tier);
    const row = (segments: TextSegment[]) => styledLine([{ text: '│', fg: 'border.input' }, ...fit(segments, inner), { text: '│', fg: 'border.input' }], width, undefined, tier);
    const judged: TextSegment[] = [{ text: ' 当前判定  ', fg: 'fg.label' }, { text: v.conclusion, fg: CONCLUSION_FG[v.conclusion], bold: true }, { text: `  ${v.reasons.join(' · ')}`, fg: 'fg.muted' }];
    // 判定规则放得下时靠右与判定同行（设计稿 2b），否则另起一行。
    const spare = inner - width$(judged) - visibleWidth(v.rule) - 1;
    return [edge('╭', '╮'), ...spare >= 2 ? [row([...judged, { text: ' '.repeat(spare) }, { text: v.rule, fg: 'fg.faint' }])] : [row(judged), row([{ text: ` ${v.rule}`, fg: 'fg.faint' }])], edge('╰', '╯')];
  }

  private status(report: EvalReport, width: number, tier: ColorTier): string {
    const state = planState(report), n = report.trials.length, started = report.trials.filter(t => t.outcome.started).length;
    const batch = (report as Partial<EvalReport>).batch;
    let left: TextSegment[];
    if(this.options.stoppingHere?.())left=[{text:`${spinner()} 停止中 · ${this.source.origin?'结束整个 improve 提交批次，剩余项不启动':'等待 VM 和写入者清理'}`,fg:'ac.warn'}];
    else if (state === 'not-started') left = [{ text: `○ 未开始 · ${n} trial`, fg: 'fg.muted' }];
    else if (state === 'running' && this.runningHere()) left = [{ text: `${spinner()} 运行${this.source.origin?` · 停止将结束 improve 提交批次 ${this.source.origin.label}，剩余项不启动`:''}`, fg: 'ac.brand' }, { text: ` · trial ${started}/${n}${batch?.startedAt ? ` · ${clock(this.now() - Date.parse(batch.startedAt))}` : ''}`, fg: 'fg.body' }];
    else if (state === 'running') left = [{ text: '未结束 · 不在本 TUI 运行', fg: 'ac.warn' }, { text: ` · 已启动 ${started}/${n} trial`, fg: 'fg.muted' }];
    else if (state === 'ended') {
      const done = report.trials.filter(t => t.outcome.status !== 'not-run').length;
      const took = batch?.startedAt && batch.closedAt ? ` · ${clock(Date.parse(batch.closedAt) - Date.parse(batch.startedAt))}` : '';
      left = [{ text: '✓ 已结束', fg: 'ac.ok' }, { text: ` · ${done}/${n} trial${took} · ${amountText(report)}`, fg: 'fg.body' }];
    } else left = [{ text: `◇ 已停止于 trial ${started}/${n}`, fg: 'fg.muted' }, { text: ` · ${amountText(report)} · 不续跑`, fg: 'fg.body' }];
    const note = 'eval 费用单列，不计入 /stats';
    const spare = width - width$(left) - visibleWidth(note);
    return styledLine([...left, ...spare >= 2 ? [{ text: ' '.repeat(spare) }, { text: note, fg: 'fg.faint' as TokenName }] : []], width, undefined, tier);
  }
}
