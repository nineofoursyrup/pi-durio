/**
 * 2b 中按 Enter 打开的 trial trace（V7、U8）：用 2a 视图只读打开受限侧导出原文的副本，标“受限侧自报 · 仅供诊断”；
 * llm 的用量与金额换成宿主中介记录（按请求序位对应，对不上时并列并标明），另加准备、任务、评分三段宿主计时。
 * 原文打不开时只列宿主记录并注明原因。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { formatAmount, sumCostEstimates } from '../cost-estimate.js';
import type { Trace } from '../trace.js';
import { hostRequests, hostTiming, openRestrictedCopy, type EvalReport, type HostRequest, type HostTiming, type PlanSource, type RestrictedCopy } from '../eval/overview.js';
import { COLOR_TIER, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { TraceView, formatDuration, formatTokens } from './trace.js';
import { clean, fixedFrame, hintLine, LoadingState, statusError, truncateEnd } from './view-stack.js';

export const SELF_REPORTED = '受限侧自报 · 仅供诊断';
/** 一个请求序位上宿主与受限侧不一致之处。 */
export interface RequestMismatch { ordinal: number; host: number | null; restricted: number | null; reason: 'usage' | 'host-only' | 'restricted-only' }

export class TrialTraceView {
  readonly requests: HostRequest[];
  readonly timing: HostTiming;
  /** 打开副本完成（成功或失败）；测试等待它 */
  readonly opened: Promise<void>;
  private trace?: TraceView;
  private copy?: RestrictedCopy;
  private failure?: { message: string; code: string };
  private loading: LoadingState;
  private closed = false;
  private mismatches: RequestMismatch[] = [];
  private readonly title: string;

  constructor(private readonly source: PlanSource, private readonly report: EvalReport, readonly trialId: string, private readonly changed: () => void = () => {}) {
    const trial = report.trials.find(t => t.id === trialId)!;
    this.requests = hostRequests(source, report, trialId);
    this.timing = hostTiming(trial);
    const side = report.plan.comparison ? `${trial.side === 'baseline' ? 'A' : 'B'} ` : '';
    this.title = `${source.label} · ${trial.caseId} · ${side}r${trial.repeat}`;
    this.loading = new LoadingState('打开原文副本', `trial ${this.title}`, changed);
    this.opened = this.open(trial);
  }
  private async open(trial: EvalReport['trials'][number]) {
    try {
      const copy = await this.loading.track(openRestrictedCopy(this.source, trial));
      if (!copy) return;
      if (this.closed) { await copy.close(); return; }
      this.copy = copy;
      this.trace = new TraceView(copy.root, copy.runId, () => false, undefined, t => this.adjust(t));
    } catch (error) {
      const text = clean(String((error as Error)?.message ?? error)).replace(/^Error:\s*/, '');
      const [code, ...rest] = text.split(': ');
      this.failure = { message: rest.join(': ') || '原文不可取得', code: code.split(/\s/)[0] || 'RESTRICTED_RAW_UNAVAILABLE' };
    }
    this.changed();
  }
  /** Esc 离开：丢弃仍在复制的结果，删除副本。 */
  close() { this.closed = true; this.loading.cancel(); void this.copy?.close(); }
  get mismatch() { return this.mismatches; }
  get selectedSpan() { return this.trace?.selectedSpan; }

  /** llm 行改用宿主中介记录：受限侧第 k 个模型请求对应 `guestDispatchOrdinal = k`。 */
  private adjust(trace: Trace): Trace {
    const llms = trace.spans.filter(s => s.kind === 'llm').sort((a, b) => a.llm!.number - b.llm!.number);
    const mismatches: RequestMismatch[] = [];
    const spans = trace.spans.map(span => {
      if (span.kind !== 'llm') return span;
      const ordinal = llms.indexOf(span) + 1, host = this.requests.find(r => r.ordinal === ordinal), llm = span.llm!;
      if (!host) { mismatches.push({ ordinal, host: null, restricted: llm.tokens, reason: 'restricted-only' }); return { ...span, llm: { ...llm, tokens: null, cost: llm.cost ? { ...llm.cost, amount: null, state: 'unknown' as const } : null } }; }
      if (host.tokens !== llm.tokens) mismatches.push({ ordinal, host: host.tokens, restricted: llm.tokens, reason: 'usage' });
      const cost = llm.cost ? { ...llm.cost, amount: host.amount, currency: host.currency, state: host.amount === null ? 'unknown' as const : 'complete' as const, price: { ...(llm.cost.price ?? {}), version: this.report.plan.price?.version ?? null } } : null;
      return { ...span, llm: { ...llm, tokens: host.tokens, cost } };
    });
    for (const r of this.requests) if (r.ordinal !== null && r.ordinal > llms.length) mismatches.push({ ordinal: r.ordinal, host: r.tokens, restricted: null, reason: 'host-only' });
    this.mismatches = mismatches.sort((a, b) => a.ordinal - b.ordinal);
    const known = this.requests.filter(r => r.tokens !== null);
    return {
      ...trace, spans,
      tokens: known.reduce((n, r) => n + r.tokens!, 0), unknownTokens: this.requests.length - known.length,
      cost: sumCostEstimates(this.requests.map(r => ({ currency: r.currency, amount: r.amount, state: r.amount === null ? 'unknown' : 'complete' }))),
    };
  }

  handleInput(data: string) { this.trace?.handleInput(data); }
  scroll(delta: number) { this.trace?.scroll(delta); }
  click(y: number) { this.trace?.click(y - this.bannerHeight); }
  private bannerHeight = 3;

  render(width: number, height: number, esc: string, tier: ColorTier = COLOR_TIER): string[] {
    const line = (segments: TextSegment[]) => styledLine(segments, width, undefined, tier);
    const left: TextSegment[] = [{ text: ' ◆ ', fg: 'ac.info' }, { text: 'trial', fg: 'fg.primary', bold: true }, { text: `  ${clean(this.title)}`, fg: 'fg.faint' }];
    const used = left.reduce((n, s) => n + visibleWidth(s.text), 0), label = SELF_REPORTED;
    const title = used + visibleWidth(label) + 2 <= width
      ? line([...left, { text: ' '.repeat(width - used - visibleWidth(label) - 1) }, { text: label, fg: 'ac.warn' }])
      : line([{ text: ' ' }, { text: truncateEnd(`trial ${this.title} · ${label}`, width - 1), fg: 'ac.warn' }]);
    const ms = (n: number | null) => n === null ? '未记录' : formatDuration(n);
    const known = this.requests.filter(r => r.tokens !== null), tokens = known.reduce((n, r) => n + r.tokens!, 0);
    const amount = this.requests.length ? sumCostEstimates(this.requests.map(r => ({ currency: r.currency, amount: r.amount, state: r.amount === null ? 'unknown' : 'complete' }))) : null;
    const money = amount ? Object.entries(amount.amounts).map(([c, v]) => formatAmount(v, c)).join(' · ') || 'unknown' : '';
    const timing = line([{ text: ' 宿主计时  ', fg: 'fg.label' }, { text: truncateEnd(`准备 ${ms(this.timing.preparationMs)} · 任务 ${ms(this.timing.taskMs)} · 评分 ${ms(this.timing.gradingMs)} · 宿主中介 ${this.requests.length} 次请求${this.requests.length ? ` · ${formatTokens(tokens)} tok${known.length < this.requests.length ? ` +${this.requests.length - known.length} unknown` : ''} · ${money}` : ''}`, width - 11), fg: 'fg.body' }]);

    if (this.failure || (!this.trace && !this.loading.isShowing && this.closed)) {
      const f = this.failure ?? { message: '原文不可取得', code: 'RESTRICTED_RAW_UNAVAILABLE' };
      const rows = this.requests.map(r => line([{ text: `   ${r.ordinal === null ? '#?' : `#${r.ordinal}`}`, fg: 'fg.primary' }, { text: ` · ${r.dispatched ? '已派发' : '只预留未派发'} · ${r.tokens === null ? 'unknown tok' : `${formatTokens(r.tokens)} tok`} · ${r.amount === null || !r.currency ? 'unknown' : formatAmount(r.amount, r.currency)}`, fg: r.tokens === null ? 'ac.warn' : 'fg.body' }]));
      const body = ['', ...statusError(f.message, f.code, '只列宿主记录：中介请求与三段计时', width, tier), '', line([{ text: ' 宿主中介请求', fg: 'fg.label' }]), ...rows.length ? rows : [line([{ text: '   本 trial 没有宿主中介的模型请求', fg: 'fg.muted' }])]];
      return fixedFrame([title, timing, line([{ text: '─'.repeat(width), fg: 'line.subtle' }])], body, [hintLine([], width, { esc, tier })], height, 0).lines;
    }
    if (!this.trace) {
      const body = this.loading.isShowing ? [this.loading.renderLine(width, tier)] : [];
      return fixedFrame([title, timing, line([{ text: '─'.repeat(width), fg: 'line.subtle' }])], body, [hintLine([], width, { esc, tier })], height, 0).lines;
    }
    const lines = this.trace.render(width, Math.max(4, height - 3), esc);
    const m = this.mismatches;
    const text = m.length
      ? `不一致 · ${m.map(x => x.reason === 'host-only' ? `宿主 #${x.ordinal} 无对应受限侧请求` : x.reason === 'restricted-only' ? `受限侧 #${x.ordinal} 无宿主记录` : `#${x.ordinal} 宿主 ${x.host === null ? 'unknown' : formatTokens(x.host)} / 受限侧自报 ${x.restricted === null ? 'unknown' : formatTokens(x.restricted)} tok`).join(' · ')}`
      : '用量与金额取宿主中介记录，按请求序位对应 · 与受限侧自报一致';
    const reconcile = line([{ text: ' ' }, { text: truncateEnd(text, width - 2), fg: (m.length ? 'ac.warn' : 'fg.muted') as TokenName }]);
    return [title, timing, reconcile, ...lines].slice(0, height);
  }
}
