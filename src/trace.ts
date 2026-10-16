/**
 * Trace（2a）的 span 模型：查看时由一个 run 的已有宿主事实推导，不另存 span、索引或用量账（E6、#47）。
 * 视图层只读本模块的结果；原文层、/details（#79）与 eval trial trace（#81）复用同一模型。
 */
import { records, decode, type Availability, type EvidenceReference } from './history.js';
import { readObjectRange } from './query.js';
import { estimateModelRequests, sumCostEstimates, type CostTotals, type ModelRequestCost } from './cost-estimate.js';
import { isBusinessCheck } from './metrics/faults.js';
import { factClock } from './fact-clock.js';

interface Fact { ref: EvidenceReference; data: any }

/** 原文项的取得状态：E2 的区分加上“部分取得”。 */
export type TraceRawState = Availability | 'partial';
export const RAW_STATE_LABEL: Record<TraceRawState, string> = {
  complete: '完整取得', partial: '部分取得', 'source-not-returned': '源未返回', 'collection-gap': '采集缺口',
  archived: '已归档', cleaned: '已清理', corrupt: '损坏', 'temporarily-unreadable': '暂不可读',
};
/** 一个 span 的一项原文（tool：参数、stdout、stderr、送模内容、错误；llm：请求 payload、响应；compaction：源上下文、摘要）。 */
export interface TraceRaw { label: string; sources: string[]; state: TraceRawState; bytes?: number; /** 如 `送模截断 · 原文完整` */ note?: string }

export interface TraceLlm {
  /** `llm #N`：run 内 model.intent 的记录顺序，含压缩请求，跨执行段连续。 */
  number: number; attemptId: string; purpose: string;
  /** 第 M 轮：generation/improve 请求按 durableTaskId 计的逻辑请求序位；压缩请求为 null。 */
  round: number | null;
  /** 重试：同一 durableTaskId 的上一次请求号。 */
  retryOf: number | null;
  model: string | null; http: number | null; stopReason: string | null; error: string | null;
  usage: { input: number; cacheRead: number; output: number } | null;
  /** 输入（含缓存命中）加输出；未返回 usage 时为 null。 */
  tokens: number | null;
  cost: ModelRequestCost | null;
}
export interface TraceTool {
  name: string; target: string | null;
  /** 逻辑调用序位（按 durableTaskId 首次出现）；`tc-<run>-<序位>` 由视图生成。 */
  call: number | null;
  attempt: number; attemptId: string | null; durableTaskId: number | null;
  exit: number | null;
  /** 非零退出匹配预先声明的检查（M6）。 */
  check: boolean;
  error: string | null;
  env: { version: string | null; names: number; apiKey: boolean } | null;
  /** 用户在恢复核对中选择“重试”后的再次执行。 */
  recoveryRetry: { decisionId: string; at: string } | null;
  /** 首版恢复决定 `skip`。 */
  skipped: { reason: string } | null;
  denied: boolean;
  /** 恢复续跑中被拦截的完全相同调用（该操作已完成，不重做）；否则为首版只读续跑的拒绝。 */
  duplicate?: boolean;
}
export interface TraceCompaction { trigger: 'automatic' | 'manual'; entries: number | null; state: string | null; requests: TraceLlm[]; tokens: number | null; cost: CostTotals }
export type SpanOutcome = 'ok' | 'failed' | 'cancelled' | 'unknown' | 'denied';
export interface TraceSpan {
  /** 稳定身份：attemptId、`compaction:<taskId>`、`maintenance:<requestId>`、`denied:<seq>`。增量刷新时按它保持选中。 */
  key: string;
  kind: 'llm' | 'tool' | 'compaction';
  segment: number;
  /** 时间轴偏移（ms），不含执行段之间的中断时间。 */
  start: number; end: number;
  running: boolean;
  outcome: SpanOutcome;
  /** 相关记录的 evidence id，首项为起始记录。 */
  sources: string[];
  raws: TraceRaw[];
  llm?: TraceLlm; tool?: TraceTool; compaction?: TraceCompaction;
}
export interface TraceSegment {
  index: number; kind: 'run' | 'recovery' | 'maintenance';
  /** 时间轴上的起止（ms）。 */
  start: number; end: number; open: boolean;
  /** 与上一个非维护执行段之间的中断（墙钟 ms）；第一段与维护段为 null。 */
  gap: number | null;
  /** 首版只读续跑：`recovery.started.capabilities` 只有 read，且不是原本就只读的续跑。 */
  readOnly: boolean;
  decision: { id: string; at: string; source: string } | null;
  requestId: string | null;
}
export interface Trace {
  runId: string; taskId: string | null; taskKind: string; version: string | null;
  status: 'completed' | 'failed' | 'aborted' | 'unknown' | 'ended' | 'running'; reason: string | null;
  segments: TraceSegment[]; spans: TraceSpan[];
  /** 头部耗时：非维护执行段之和。 */
  duration: number;
  /** 头部 tok 与费用：非维护请求。 */
  tokens: number; unknownTokens: number; cost: CostTotals;
  counts: { models: number; retries: number; tools: number; recoveryRetries: number };
  /** 维护段（run 结束后追加的手动压缩）的项数。 */
  maintenance: number;
  through: number; empty: boolean;
}

const KINDS = ['task.accepted', 'execution.artifact', 'execution.config', 'run.started', 'run.closed', 'recovery.report', 'recovery.decision', 'recovery.started', 'recovery.closed', 'recovery.ended', 'recovery.capability-denied',
  'model.intent', 'model.payload', 'model.dispatch', 'model.dispatch-failed', 'model.http', 'model.response', 'model.provider-event', 'cost.estimate',
  'tool.intent', 'tool.dispatch', 'tool.result', 'tool.error', 'tool.summary', 'tool.output', 'shell.started', 'shell.completed', 'acceptance.requirements',
  'compaction.task', 'compaction.source', 'compaction.summary', 'compaction.finished', 'compaction.started', 'compaction.closed'];
/** 只需要 attemptId 的大记录：读开头，不整条解码。 */
const HEAD_ONLY = new Set(['model.payload']);
const COST_KINDS = new Set(['model.intent', 'model.dispatch', 'model.dispatch-failed', 'model.response', 'model.provider-event', 'cost.estimate']);

interface Clock { processId: string | null; mono: number | null; wall: number }
const clockOf = (fact: Fact): Clock => {
  const clock = fact.data?.clock;
  return { processId: typeof clock?.processId === 'string' ? clock.processId : null, mono: typeof clock?.monotonicMs === 'number' ? clock.monotonicMs : null, wall: Date.parse(clock?.wallTime ?? fact.ref.at) };
};
/** 同一进程用单调时钟，跨进程用墙钟。 */
const between = (from: Clock, to: Clock) => from.processId !== null && from.processId === to.processId && from.mono !== null && to.mono !== null ? to.mono - from.mono : to.wall - from.wall;

/**
 * 增量读取一个 run 的事实：`update()` 只读上次之后追加的记录；`trace(live)` 在内存里推导。
 * `live` 表示该 run 正由本进程执行：未关闭的执行段与进行中的 span 延伸到此刻。
 */
export class TraceReader {
  private facts: Fact[] = [];
  private after = 0;
  private costs: ModelRequestCost[] = [];
  private declared = new Map<string, Availability>();
  constructor(readonly root: string, readonly runId: string) {
    for (const ref of records(root, { kinds: ['evidence.availability'] })) {
      try { const data = decode(root, ref); for (const key of [data.sourceId, data.sha256]) if (typeof key === 'string') this.declared.set(key, data.state); } catch { /* 声明本身不可读时按记录默认状态显示。 */ }
    }
    this.update();
  }
  /** 读取新追加的记录；有新记录时返回 true。 */
  update() {
    let costChanged = false, added = false;
    for (const ref of records(this.root, { runId: this.runId, after: this.after, kinds: KINDS })) {
      this.after = ref.seq; added = true;
      let data: any;
      try {
        if (HEAD_ONLY.has(ref.kind)) data = { attemptId: /^\{"attemptId":"([^"\\]+)"/.exec(readObjectRange(this.root, ref.ref, { limit: 256 }).bytes.toString('utf8'))?.[1] };
        else data = decode(this.root, ref);
      } catch (error) { data = { unreadable: String(error) }; }
      // 模型请求的上下文只在原文层按需读取；这里只留身份与模型。
      if (ref.kind === 'model.intent') data = { attemptId: data.attemptId, durableTaskId: data.durableTaskId ?? null, purpose: data.purpose ?? null, allocation: data.allocation ?? null, maintenanceRequestId: data.maintenanceRequestId ?? null, model: data.model ?? null, clock: data.clock };
      if (ref.kind === 'tool.output') data = { toolAttempt: data.toolAttempt, stream: data.acquired?.stream, bytes: typeof data.acquired?.bytes === 'string' ? Buffer.from(data.acquired.bytes, 'base64').length : 0 };
      this.facts.push({ ref, data });
      if (COST_KINDS.has(ref.kind)) costChanged = true;
    }
    if (costChanged) {
      // 费用不可读时只让金额 unknown，trace 照常显示。
      try { this.costs = estimateModelRequests(this.root, this.facts.filter(f => COST_KINDS.has(f.ref.kind))); } catch { this.costs = []; }
    }
    return added;
  }
  get through() { return this.after; }
  trace(live = false): Trace { return buildTrace(this.runId, this.facts, this.costs, this.declared, live ? factClock() : null); }
}

/** 一次读取并推导（CLI、测试）。 */
export function readTrace(root: string, runId: string, options: { live?: boolean } = {}) { return new TraceReader(root, runId).trace(options.live); }

function buildTrace(runId: string, facts: readonly Fact[], costs: readonly ModelRequestCost[], declared: ReadonlyMap<string, Availability>, now: { processId: string; monotonicMs: number; wallTime: string } | null): Trace {
  const state = (ref: EvidenceReference): TraceRawState => declared.get(ref.id) ?? declared.get(ref.ref.sha256) ?? 'complete';
  const raw = (label: string, refs: EvidenceReference[], extra: Partial<TraceRaw> = {}): TraceRaw => {
    const declaredState = refs.map(state).find(s => s !== 'complete');
    return { label, sources: refs.map(r => r.id), state: declaredState ?? extra.state ?? 'complete', ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}), ...(extra.note ? { note: extra.note } : {}) };
  };
  const accepted = facts.find(f => f.ref.kind === 'task.accepted')?.data;
  const artifact = facts.find(f => f.ref.kind === 'execution.artifact')?.data;
  const config = facts.find(f => f.ref.kind === 'execution.config')?.data;
  const tools: string[] = accepted?.authorization?.tools ?? [];
  const taskKind = accepted?.kind === 'improve' ? 'improve' : tools.some(t => t !== 'read') ? 'coding' : accepted ? '只读' : '未记录';

  // ── 执行段 ──
  interface Seg { info: TraceSegment; anchor: Clock; last: Clock; endClock: Clock | null; wallEnd: number }
  const segs: Seg[] = [];
  const segOf = new Map<number, Seg>();
  let current: Seg | undefined, mainCurrent: Seg | undefined;
  const decisions = facts.filter(f => f.ref.kind === 'recovery.decision');
  const open = (kind: TraceSegment['kind'], fact: Fact, extra: Partial<TraceSegment> = {}) => {
    const seg: Seg = { info: { index: segs.length, kind, start: 0, end: 0, open: true, gap: null, readOnly: false, decision: null, requestId: null, ...extra }, anchor: clockOf(fact), last: clockOf(fact), endClock: null, wallEnd: clockOf(fact).wall };
    segs.push(seg); return seg;
  };
  for (const fact of facts) {
    const kind = fact.ref.kind;
    if (kind === 'run.started' && !segs.some(s => s.info.kind === 'run')) current = mainCurrent = open('run', fact);
    else if (kind === 'recovery.started') {
      const decisionFact = decisions.findLast(d => d.ref.seq < fact.ref.seq && d.data.decision?.id === fact.data.decisionId);
      const resolutions: any[] = decisionFact?.data.decision?.resolutions ?? [];
      const capabilities: string[] = fact.data.capabilities ?? [];
      const readOnly = capabilities.length === 1 && capabilities[0] === 'read' && (tools.some(t => t !== 'read') || resolutions.some(r => r.choice !== 'retry'));
      current = mainCurrent = open('recovery', fact, { readOnly, decision: decisionFact ? { id: decisionFact.data.decision.id, at: decisionFact.ref.at, source: decisionFact.ref.id } : { id: fact.data.decisionId, at: fact.ref.at, source: fact.ref.id } });
    } else if (kind === 'compaction.started') current = open('maintenance', fact, { requestId: fact.data.requestId ?? null });
    else if (!current && ['model.intent', 'tool.intent', 'tool.dispatch', 'compaction.task', 'compaction.source', 'recovery.capability-denied'].includes(kind)) {
      if (!segs.length) {
        // 首版导入前中止等没有 run.started 的 run：从受理开始计。
        const start = facts.find(f => f.ref.kind === 'task.accepted') ?? fact;
        current = mainCurrent = open('run', start);
      } else if (mainCurrent) {
        // 关闭之后才写下的执行事实（如关闭后补记的派发）归入最近的执行段，不另开段。
        segOf.set(fact.ref.seq, mainCurrent);
        continue;
      }
    }
    if (!current) continue;
    segOf.set(fact.ref.seq, current);
    current.last = clockOf(fact); current.wallEnd = current.last.wall;
    const closes = current.info.kind === 'maintenance' ? kind === 'compaction.closed' && fact.data.requestId === current.info.requestId
      : current.info.kind === 'run' ? kind === 'run.closed' : kind === 'recovery.closed' || kind === 'recovery.ended';
    if (closes) {
      current.info.open = false; current.endClock = clockOf(fact);
      // 维护段结束后，后续记录回到最近的非维护段。
      current = current.info.kind === 'maintenance' ? mainCurrent : undefined;
      if (current?.info.open === false) current = undefined;
    }
  }
  const nowClock: Clock | null = now ? { processId: now.processId, mono: now.monotonicMs, wall: Date.parse(now.wallTime) } : null;
  const lastOpen = segs.findLast(s => s.info.open);
  const liveSeg = nowClock && lastOpen ? lastOpen : undefined;
  // 时间轴：非维护段依次相接，维护段排在末尾。
  let cursor = 0, previousWallEnd: number | null = null;
  const ordered = [...segs.filter(s => s.info.kind !== 'maintenance'), ...segs.filter(s => s.info.kind === 'maintenance')];
  for (const seg of ordered) {
    const endClock = seg.endClock ?? (seg === liveSeg ? nowClock! : seg.last);
    const length = Math.max(0, between(seg.anchor, endClock));
    seg.info.start = cursor; seg.info.end = cursor + length; cursor += length;
    if (seg.info.kind !== 'maintenance') { if (previousWallEnd !== null) seg.info.gap = Math.max(0, seg.anchor.wall - previousWallEnd); previousWallEnd = seg.endClock?.wall ?? seg.wallEnd; }
  }
  const at = (fact: Fact) => { const seg = segOf.get(fact.ref.seq)!; return seg.info.start + Math.max(0, Math.min(seg.info.end - seg.info.start, between(seg.anchor, clockOf(fact)))); };
  const segEnd = (fact: Fact) => segOf.get(fact.ref.seq)!.info.end;
  const isLive = (fact: Fact) => segOf.get(fact.ref.seq) === liveSeg;

  // ── 按 attempt 归集 ──
  const byAttempt = new Map<string, Fact[]>();
  for (const fact of facts) {
    const id = fact.data?.attemptId ?? fact.data?.toolAttempt?.attemptId;
    if (typeof id === 'string') { const list = byAttempt.get(id) ?? []; list.push(fact); byAttempt.set(id, list); }
  }
  const related = (id: string, kind: string) => (byAttempt.get(id) ?? []).filter(f => f.ref.kind === kind);

  const spans: TraceSpan[] = [];
  // ── 模型请求 ──
  const llmOf = new Map<string, { fact: Fact; detail: TraceLlm; end: number; running: boolean; outcome: SpanOutcome; raws: TraceRaw[]; sources: string[] }>();
  const lastByTask = new Map<number, number>(), rounds = new Map<number, number>();
  let number = 0;
  for (const fact of facts.filter(f => f.ref.kind === 'model.intent' && segOf.has(f.ref.seq))) {
    const d = fact.data, id: string = d.attemptId; number++;
    const purpose: string = d.purpose ?? related(id, 'model.response')[0]?.data.purpose ?? 'generation';
    const task = purpose === 'compaction' ? null : typeof d.durableTaskId === 'number' ? d.durableTaskId : null;
    const retryOf = task !== null ? lastByTask.get(task) ?? null : null;
    if (task !== null) { lastByTask.set(task, number); if (!rounds.has(task)) rounds.set(task, rounds.size + 1); }
    const response = related(id, 'model.response').at(-1), failed = related(id, 'model.dispatch-failed').at(-1), http = related(id, 'model.http').at(-1);
    const message = response?.data.message, stop: string | null = message?.stopReason ?? null;
    const usage = response?.data.usage === 'reported' && message?.usage ? { input: Number(message.usage.input) || 0, cacheRead: Number(message.usage.cacheRead) || 0, output: Number(message.usage.output) || 0 } : null;
    const status: number | null = typeof http?.data.status === 'number' ? http.data.status : null;
    const terminal = response ?? failed;
    const outcome: SpanOutcome = status !== null && status >= 400 || stop === 'error' || message?.errorMessage && stop !== 'aborted' || failed && !response ? 'failed' : stop === 'aborted' ? 'cancelled' : response ? 'ok' : 'unknown';
    const running = !terminal && isLive(fact);
    const detail: TraceLlm = { number, attemptId: id, purpose, round: task !== null ? rounds.get(task)! : null, retryOf, model: d.model?.id ?? message?.model ?? null, http: status, stopReason: stop, error: message?.errorMessage ?? failed?.data.reason ?? null, usage, tokens: usage ? usage.input + usage.cacheRead + usage.output : null, cost: costs.find(c => c.attemptId === id) ?? null };
    const payload = related(id, 'model.payload').map(f => f.ref), responses = [...related(id, 'model.response'), ...related(id, 'model.provider-event')].map(f => f.ref);
    llmOf.set(id, { fact, detail, end: terminal ? at(terminal) : segEnd(fact), running, outcome: running ? 'unknown' : outcome, sources: (byAttempt.get(id) ?? []).map(f => f.ref.id),
      raws: [raw('请求 payload', payload, payload.length ? {} : { state: 'source-not-returned' }), raw('响应', responses, response ? response.data.completeness === 'partial' ? { state: 'partial' } : {} : { state: 'source-not-returned' })] });
  }
  const llmSpan = (entry: NonNullable<ReturnType<typeof llmOf.get>>): TraceSpan => ({ key: entry.detail.attemptId, kind: 'llm', segment: segOf.get(entry.fact.ref.seq)!.info.index, start: at(entry.fact), end: entry.end, running: entry.running, outcome: entry.outcome, sources: entry.sources, raws: entry.raws, llm: entry.detail });
  const compactionTotals = (requests: TraceLlm[]) => ({ tokens: requests.some(r => r.tokens === null) || !requests.length ? requests.length ? null : 0 : requests.reduce((sum, r) => sum + r.tokens!, 0), cost: sumCostEstimates(requests.map(r => r.cost ?? { currency: null, amount: null, state: 'unknown' })) });
  const STATE_ORDER = ['applied', 'stale', 'cancelled', 'failed', 'noop', 'interrupted', 'generated'];
  const finalState = (states: string[]) => STATE_ORDER.find(s => states.includes(s)) ?? null;

  // ── 自动压缩：一次压缩合为一行 ──
  const groups = new Map<number, { facts: Fact[]; requests: string[]; finished: Fact[] }>();
  const maintenanceSeg = (fact: Fact) => segOf.get(fact.ref.seq)?.info.kind === 'maintenance';
  let openGroup: number | undefined;
  for (const fact of facts) {
    if (!segOf.has(fact.ref.seq) || maintenanceSeg(fact)) continue;
    const kind = fact.ref.kind, taskId = fact.data?.taskId;
    if ((kind === 'compaction.task' || kind === 'compaction.source') && typeof taskId === 'number' && fact.data.trigger !== 'manual') {
      const group = groups.get(taskId) ?? { facts: [], requests: [], finished: [] }; group.facts.push(fact); groups.set(taskId, group); openGroup = taskId;
    } else if (kind === 'compaction.finished' && groups.has(taskId)) { groups.get(taskId)!.finished.push(fact); groups.get(taskId)!.facts.push(fact); }
    else if (kind === 'compaction.summary' && openGroup !== undefined) groups.get(openGroup)!.facts.push(fact);
    else if (kind === 'model.intent' && fact.data.purpose === 'compaction' && fact.data.allocation !== 'maintenance' && openGroup !== undefined) groups.get(openGroup)!.requests.push(fact.data.attemptId);
  }
  const grouped = new Set<string>();
  for (const [taskId, group] of groups) {
    const requests = group.requests.map(id => llmOf.get(id)!).filter(Boolean);
    requests.forEach(r => grouped.add(r.detail.attemptId));
    const first = group.facts[0], source = group.facts.find(f => f.ref.kind === 'compaction.source');
    const done = group.finished.length > 0, states = group.finished.map(f => f.data.state);
    const end = Math.max(...group.facts.map(at), ...requests.map(r => r.end));
    const running = !done && isLive(first);
    spans.push({ key: `compaction:${taskId}`, kind: 'compaction', segment: segOf.get(first.ref.seq)!.info.index, start: Math.min(at(first), ...requests.map(r => at(r.fact))), end: done ? end : running ? segEnd(first) : end, running,
      outcome: !done ? 'unknown' : states.includes('failed') && !states.includes('applied') ? 'failed' : states.includes('cancelled') ? 'cancelled' : 'ok',
      sources: [...group.facts.map(f => f.ref.id), ...requests.flatMap(r => r.sources)],
      raws: [raw('源上下文', source ? [source.ref] : [], source ? {} : { state: 'source-not-returned' }), raw('摘要', group.facts.filter(f => f.ref.kind === 'compaction.summary').map(f => f.ref), group.facts.some(f => f.ref.kind === 'compaction.summary') ? {} : { state: 'source-not-returned' })],
      compaction: { trigger: 'automatic', entries: Array.isArray(source?.data.entries) ? source!.data.entries.length : null, state: finalState(states), requests: requests.map(r => r.detail), ...compactionTotals(requests.map(r => r.detail)) } });
  }
  // ── 维护段：一次手动压缩一行 ──
  for (const seg of segs.filter(s => s.info.kind === 'maintenance')) {
    const own = facts.filter(f => segOf.get(f.ref.seq) === seg);
    const requests = own.filter(f => f.ref.kind === 'model.intent').map(f => llmOf.get(f.data.attemptId)!).filter(Boolean);
    requests.forEach(r => grouped.add(r.detail.attemptId));
    const source = own.find(f => f.ref.kind === 'compaction.source'), closed = own.find(f => f.ref.kind === 'compaction.closed');
    const states = own.filter(f => f.ref.kind === 'compaction.finished').map(f => f.data.state), state = finalState(states) ?? closed?.data.result?.compaction?.state ?? null;
    spans.push({ key: `maintenance:${seg.info.requestId}`, kind: 'compaction', segment: seg.info.index, start: seg.info.start, end: seg.info.end, running: seg === liveSeg,
      outcome: seg.info.open ? 'unknown' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : closed?.data.result?.status === 'completed' ? 'ok' : 'unknown',
      sources: own.map(f => f.ref.id),
      raws: [raw('源上下文', source ? [source.ref] : [], source ? {} : { state: 'source-not-returned' }), raw('摘要', own.filter(f => f.ref.kind === 'compaction.summary').map(f => f.ref), own.some(f => f.ref.kind === 'compaction.summary') ? {} : { state: 'source-not-returned' })],
      compaction: { trigger: 'manual', entries: Array.isArray(source?.data.entries) ? source!.data.entries.length : null, state, requests: requests.map(r => r.detail), ...compactionTotals(requests.map(r => r.detail)) } });
  }
  for (const entry of llmOf.values()) if (!grouped.has(entry.detail.attemptId)) spans.push(llmSpan(entry));

  // ── 工具调用 ──
  const calls = new Map<number, number>(), attempts = new Map<number, number>();
  const reportTools = new Map<number, any>();
  for (const report of facts.filter(f => f.ref.kind === 'recovery.report')) for (const tool of report.data.tools ?? []) if (typeof tool.taskId === 'number') reportTools.set(tool.taskId, tool);
  const resolution = (task: number, choice: string, after: number) => {
    for (const d of decisions) if (d.ref.seq > after) { const r = (d.data.decision?.resolutions ?? []).find((x: any) => x.taskId === task && x.choice === choice); if (r) return { fact: d, reason: String(r.reason ?? '') }; }
    return undefined;
  };
  const toolStarts = facts.filter(f => (f.ref.kind === 'tool.intent' || f.ref.kind === 'tool.dispatch' && !related(f.data.attemptId, 'tool.intent').length) && segOf.has(f.ref.seq));
  const seenAttempts = new Set<string>();
  for (const fact of toolStarts) {
    const id: string = fact.data.attemptId;
    if (seenAttempts.has(id)) continue; seenAttempts.add(id);
    const intent = related(id, 'tool.intent')[0]?.data, task: number | null = typeof fact.data.durableTaskId === 'number' ? fact.data.durableTaskId : null;
    // 与 readRunOrdinals 同口径：只有 tool.intent 编逻辑调用号。
    if (task !== null && intent && !calls.has(task)) calls.set(task, calls.size + 1);
    const attempt = task === null ? 1 : (attempts.get(task) ?? 0) + 1; if (task !== null) attempts.set(task, attempt);
    const reported = task !== null ? reportTools.get(task) : undefined;
    const name: string = intent?.tool ?? fact.data.tool ?? reported?.tool ?? '未记录';
    const args = intent?.args ?? reported?.args ?? {};
    const shellStarted = related(id, 'shell.started').at(-1)?.data.acquired, shellDone = related(id, 'shell.completed').at(-1)?.data.acquired;
    const result = related(id, 'tool.result').at(-1), error = related(id, 'tool.error').at(-1), terminal = result ?? error;
    const dispatch = related(id, 'tool.dispatch')[0] ?? fact;
    const exit: number | null = typeof shellDone?.exitCode === 'number' ? shellDone.exitCode : null;
    const command = typeof args.command === 'string' ? args.command : shellStarted?.command;
    const check = exit !== null && exit !== 0 && isBusinessCheck(facts.filter(f => f.ref.seq < fact.ref.seq) as any, fact.ref.seq, command, exit);
    const isError = !!error || result?.data.result?.isError === true || exit !== null && exit !== 0;
    const seg = segOf.get(fact.ref.seq)!;
    const retry = seg.info.kind === 'recovery' && task !== null && seg.info.decision ? decisions.find(d => d.data.decision?.id === seg.info.decision!.id && (d.data.decision?.resolutions ?? []).some((r: any) => r.taskId === task && r.choice === 'retry')) : undefined;
    const skip = task !== null ? resolution(task, 'skip', fact.ref.seq) : undefined;
    const outputs = related(id, 'tool.output'), summary = related(id, 'tool.summary').at(-1);
    const running = !terminal && isLive(fact);
    const rawItems: TraceRaw[] = [raw('参数', intent ? [related(id, 'tool.intent')[0].ref] : [], intent ? {} : { state: 'source-not-returned' })];
    if (shellStarted) for (const stream of ['stdout', 'stderr']) {
      const chunks = outputs.filter(f => f.data.stream === stream);
      rawItems.push(raw(stream, chunks.map(f => f.ref), { bytes: chunks.reduce((sum, f) => sum + f.data.bytes, 0), ...(shellDone?.error || shellDone && related(id, 'shell.completed').at(-1)!.data.acquired?.completeness === 'partial' ? { state: 'partial' } : {}) }));
    }
    if (result) rawItems.push(raw('送模内容', [result.ref], summary?.data.truncation ? { note: '送模截断 · 原文完整' } : {}));
    if (error) rawItems.push(raw('错误', [error.ref]));
    spans.push({ key: id, kind: 'tool', segment: seg.info.index, start: at(dispatch), end: terminal ? at(terminal) : running ? seg.info.end : at(dispatch), running,
      outcome: running ? 'unknown' : !terminal ? 'unknown' : isError && !check ? 'failed' : 'ok',
      sources: (byAttempt.get(id) ?? []).map(f => f.ref.id), raws: rawItems,
      tool: { name, target: typeof args.path === 'string' ? args.path : typeof command === 'string' ? command : null, call: task !== null ? calls.get(task) ?? null : null, attempt, attemptId: id, durableTaskId: task, exit, check,
        error: error ? String(error.data.error) : shellDone?.error ? String(shellDone.error) : null,
        env: shellStarted ? { version: config?.toolEnvironment?.version ?? null, names: (shellStarted.environmentNames ?? []).length, apiKey: (shellStarted.environmentNames ?? []).includes('DEEPSEEK_API_KEY') } : null,
        recoveryRetry: retry ? { decisionId: retry.data.decision.id, at: retry.ref.at } : null, skipped: skip ? { reason: skip.reason } : null, denied: false } });
  }
  for (const fact of facts.filter(f => f.ref.kind === 'recovery.capability-denied' && segOf.has(f.ref.seq))) {
    const task: number | null = typeof fact.data.durableTaskId === 'number' ? fact.data.durableTaskId : null;
    spans.push({ key: `denied:${fact.ref.seq}`, kind: 'tool', segment: segOf.get(fact.ref.seq)!.info.index, start: at(fact), end: at(fact), running: false, outcome: 'denied', sources: [fact.ref.id], raws: [],
      tool: { name: String(fact.data.tool ?? '未记录'), target: null, call: null, attempt: 1, attemptId: null, durableTaskId: task, exit: null, check: false, error: String(fact.data.reason ?? ''), env: null, recoveryRetry: null, skipped: null, denied: true, duplicate: fact.data.duplicate === true } });
  }
  spans.sort((a, b) => a.start - b.start || Number(a.sources[0]?.split(':')[1]) - Number(b.sources[0]?.split(':')[1]));

  // ── 头部 ──
  const closing = facts.findLast(f => ['run.closed', 'recovery.closed', 'recovery.ended'].includes(f.ref.kind));
  const closed = closing?.ref.kind === 'recovery.closed' ? closing.data.result : closing?.data;
  const status: Trace['status'] = liveSeg && liveSeg.info.kind !== 'maintenance' ? 'running' : closing?.ref.kind === 'recovery.ended' ? 'ended' : ['completed', 'failed', 'aborted'].includes(closed?.status) && !segs.some(s => s.info.kind !== 'maintenance' && s.info.open) ? closed.status : 'unknown';
  const main = (span: TraceSpan) => segs[span.segment]?.info.kind !== 'maintenance';
  const requests = [...llmOf.values()].filter(e => segOf.get(e.fact.ref.seq)?.info.kind !== 'maintenance').map(e => e.detail);
  const toolSpans = spans.filter(s => s.kind === 'tool' && !s.tool!.denied);
  return {
    runId, taskId: accepted?.taskId ?? null, taskKind, version: artifact?.id ?? null, status,
    reason: closed?.reason ?? (closing ? null : facts.length ? '没有关闭记录' : null),
    segments: segs.map(s => s.info), spans,
    duration: segs.filter(s => s.info.kind !== 'maintenance').reduce((sum, s) => sum + s.info.end - s.info.start, 0),
    tokens: requests.reduce((sum, r) => sum + (r.tokens ?? 0), 0), unknownTokens: requests.filter(r => r.tokens === null).length,
    cost: sumCostEstimates(requests.map(r => r.cost ?? { currency: null, amount: null, state: 'unknown' })),
    counts: { models: requests.length, retries: requests.filter(r => r.retryOf !== null).length, tools: toolSpans.filter(main).length, recoveryRetries: toolSpans.filter(s => s.tool!.recoveryRetry).length },
    maintenance: segs.filter(s => s.info.kind === 'maintenance').length,
    through: facts.at(-1)?.ref.seq ?? 0, empty: !facts.length,
  };
}
