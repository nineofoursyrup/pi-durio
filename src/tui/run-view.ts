/**
 * 1b 主会话的取数（U2、T2）：当前任务 run 的窗口投影、“第 M 轮”、执行段起点与用量。
 * 只读宿主记录；已完成的工具调用与用量按 run 缓存，同一 run 的新记录增量读取。
 */
import { readRunRecords, readObjectRange, type RecordReference } from '../query.js';
import { readObject } from '../evidence.js';
import { estimateRunRequests, sumCostEstimates, type CostTotals, type ModelRequestCost } from '../cost-estimate.js';

/** 主区窗口读取的记录种类；工具输出块（tool.output）与写入意图按工具调用另读。 */
export const VISIBLE_KINDS = ['task.accepted','tool.intent','tool.result','tool.error','tool.summary','recovery.capability-denied','control.receipt','model.provider-event','model.response','run.abort-intent','run.exit-intent','run.closed','compaction.generated','compaction.finished'];

export type ToolState = 'running' | 'ok' | 'error' | 'unknown' | 'denied';
/** 工具输出的保留片段：read/write 取开头，bash 与错误取末尾；`total` 是全部行数。 */
export interface ToolOutput { lines: string[]; total: number; end: 'head' | 'tail' }
export interface ToolEntry {
  kind: 'tool'; ref: RecordReference; attemptId: string; tool: string; args: string; argKind: 'path' | 'command' | 'text';
  state: ToolState; startedAt: string;
  /** 只写系统掌握的事实：read 行数/范围，edit/write `+N −M`，bash `exit N · M 行`。 */
  summary: string;
  /** edit 的 diff 行（带行号前缀 `+12 `/`-12 `/` 12 `）；write 为新内容开头。 */
  diff?: string[];
  output?: ToolOutput;
  /** “分页查看”打开的原文记录（2a 原文层改版前为首版详情）。 */
  detail: RecordReference;
}
export type Entry =
  | { kind: 'user'; ref: RecordReference; text: string; steer: boolean }
  | { kind: 'assistant'; ref: RecordReference; text: string; limited: boolean; partial: boolean; attempt?: string }
  | ToolEntry
  | { kind: 'notice'; ref: RecordReference; title: string; text: string };

export interface RunProgress {
  /** 第 M 轮：本 run 中发往模型的任务请求序位；不含压缩请求，重试另算一轮。 */
  round: number;
  /** 当前一轮是对上一轮未完整返回的请求的重试。 */
  retry: boolean;
  /** 当前执行段的起点：`run.started`，恢复后为 `recovery.started`，维护段为 `compaction.started`。 */
  segmentStart: string | null;
}
export interface RunUsage { tokens: number; requests: ModelRequestCost[] }

const OUTPUT_KEEP = 40;
const decode = (root: string, ref: RecordReference) => JSON.parse(readObject(root, ref.ref).toString());
const lineCount = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
const linesOf = (text: string) => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
function keep(lines: string[], end: 'head' | 'tail'): ToolOutput {
  return { lines: end === 'head' ? lines.slice(0, OUTPUT_KEEP) : lines.slice(-OUTPUT_KEEP), total: lines.length, end };
}
function* pages(root: string, runId: string, options: { after?: number; before?: number; kinds: string[] }) {
  let after = options.after ?? 0;
  for (;;) {
    const page = readRunRecords(root, runId, { after, before: options.before, kinds: options.kinds, limit: 50 });
    // `before` reads newest first; tool facts only page forward.
    yield* page.records;
    if (!page.more || options.before !== undefined || !page.records.length) return;
    after = page.records.at(-1)!.seq;
  }
}
const headAttempt = (root: string, ref: RecordReference) => /^\{"attemptId":"([^"\\]+)"/.exec(readObjectRange(root, ref.ref, { limit: 256 }).bytes.toString('utf8'))?.[1];

export class RunView {
  private readonly tools = new Map<string, ToolEntry>();
  private steers?: Map<string, { kind: string; input: string }>;
  private progressAfter = 0;
  private lastGeneration?: string;
  private readonly completed = new Set<string>();
  private readonly compaction = new Set<string>();
  readonly progress: RunProgress = { round: 0, retry: false, segmentStart: null };
  private usageCache?: { through: number; usage: RunUsage };
  constructor(readonly root: string, readonly runId: string) {}

  /** 增量读取本 run 新增的模型请求与执行段起点，更新 progress。 */
  updateProgress() {
    for (const ref of pages(this.root, this.runId, { after: this.progressAfter, kinds: ['model.intent','model.response','run.started','recovery.started','compaction.started'] })) {
      this.progressAfter = ref.seq;
      if (ref.kind === 'model.intent') {
        // 意图以 attemptId 开头，压缩请求紧接着写 durableTaskId:null；意图带整个上下文，只读开头。
        const head = readObjectRange(this.root, ref.ref, { limit: 512 }).bytes.toString('utf8');
        const attempt = /^\{"attemptId":"([^"\\]+)"/.exec(head)?.[1] ?? decode(this.root, ref).attemptId;
        if (/^\{"attemptId":"[^"\\]+","durableTaskId":null[,}]/.test(head)) { this.compaction.add(attempt); continue; }
        this.progress.round++;
        this.progress.retry = this.lastGeneration !== undefined && !this.completed.has(this.lastGeneration);
        this.lastGeneration = attempt;
      } else if (ref.kind === 'model.response') {
        const data = decode(this.root, ref);
        if (data.completeness === 'complete') this.completed.add(data.attemptId);
      } else this.progress.segmentStart = ref.at;
    }
    return this.progress;
  }

  /** 本 run 的用量：tok = 输入（含缓存命中）+ 输出；只在出现新的模型响应时重算。 */
  usage(): RunUsage {
    const through = readRunRecords(this.root, this.runId, { tail: true, limit: 1, kinds: ['model.response'] }).records.at(-1)?.seq ?? 0;
    if (this.usageCache?.through === through) return this.usageCache.usage;
    const requests = estimateRunRequests(this.root, this.runId).requests;
    const tokens = requests.reduce((sum, request) => {
      const usage = request.usage as Record<string, number> | null;
      return usage ? sum + (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0) : sum;
    }, 0);
    this.usageCache = { through, usage: { tokens, requests } };
    return this.usageCache.usage;
  }

  /** 把一个记录窗口投影为主区条目。`active`：run 仍在执行（无结果的工具显示为运行中）。 */
  project(records: RecordReference[], options: { active: boolean; answer?: string }): Entry[] {
    const entries: Entry[] = [];
    const decoded = new Map<number, { value?: any; error?: string }>();
    for (const ref of records) {
      try { const page = readObjectRange(this.root, ref.ref, { limit: 4096 }); decoded.set(ref.seq, page.next === null ? { value: JSON.parse(page.bytes.toString()) } : {}); }
      catch (error) { decoded.set(ref.seq, { error: String(error) }); }
    }
    const seen = new Set<string>();
    const assistant = (ref: RecordReference, attempt: string | undefined) => {
      let entry = entries.find((row): row is Extract<Entry, { kind: 'assistant' }> => row.kind === 'assistant' && !!attempt && row.attempt === attempt);
      if (!entry) { entry = { kind: 'assistant', ref, text: '', limited: false, partial: false, attempt }; entries.push(entry); }
      entry.ref = ref; return entry;
    };
    for (const ref of records) {
      const data = decoded.get(ref.seq)!, value = data.value;
      if (data.error) { entries.push({ kind: 'notice', ref, title: '原文暂不可取得', text: data.error }); continue; }
      if (ref.kind === 'task.accepted') entries.push({ kind: 'user', ref, text: value?.input ?? decode(this.root, ref).input ?? '', steer: false });
      else if (ref.kind === 'tool.intent' || ref.kind === 'tool.result' || ref.kind === 'tool.error' || ref.kind === 'tool.summary') {
        const attempt = value?.attemptId ?? headAttempt(this.root, ref);
        if (!attempt || seen.has(attempt)) continue;
        const entry = this.tool(ref, attempt, options.active);
        if (entry) { seen.add(attempt); entries.push(entry); }
      } else if (ref.kind === 'recovery.capability-denied') {
        const tool = String(value?.tool ?? '工具');
        entries.push({ kind: 'tool', ref, attemptId: `denied:${ref.seq}`, tool, args: '', argKind: 'text', state: 'denied', startedAt: ref.at, summary: `被拒 · 只读续跑不允许 ${tool}`, detail: ref });
      } else if (ref.kind === 'control.receipt') {
        // 已接入的 steer 在接入位置显示为标 steer 的用户消息块；follow-up 等开自己的 run，不在这里显示。
        if (value?.status !== 'applied') continue;
        const steer = this.steer(value.requestId);
        if (steer?.kind === 'steer') entries.push({ kind: 'user', ref, text: steer.input, steer: true });
      } else if (ref.kind === 'model.provider-event') {
        const text = value?.event?.choices?.map((choice: { delta?: { content?: string } }) => choice.delta?.content ?? '').join('') ?? '';
        if (text && value.purpose !== 'compaction') { const entry = assistant(ref, value.attemptId); const combined = entry.text + text; entry.limited ||= combined.length > 4000; entry.text = combined.slice(-4000); entry.partial = true; }
      } else if (ref.kind === 'model.response') {
        const text = value?.message?.content?.filter((item: { type?: string }) => item.type === 'text').map((item: { text: string }) => item.text).join('\n');
        if (text && value.purpose === 'compaction') { entries.push({ kind: 'notice', ref, title: '压缩摘要已生成', text: '原文保留；Ctrl+T 在 trace 中查看覆盖范围、摘要与接入事实' }); continue; }
        if (text) { const entry = assistant(ref, value.attemptId); entry.text = text.slice(0, 4000); entry.limited = text.length > 4000; entry.partial = value.completeness === 'partial'; }
      } else if (ref.kind === 'compaction.finished') entries.push({ kind: 'notice', ref, title: `上下文压缩 ${value?.state ?? '未知'}`, text: '原文保留；Ctrl+T 在 trace 中查看覆盖范围、摘要与接入事实' });
      else if (ref.kind === 'run.abort-intent' && options.active) entries.push({ kind: 'notice', ref, title: '正在中止', text: '等待 runtime 确认清理；当前未接入草稿不会执行。' });
      else if (ref.kind === 'run.exit-intent' && options.active) entries.push({ kind: 'notice', ref, title: '正在退出', text: '等待执行清理和存储关闭。' });
    }
    if (options.answer !== undefined) {
      const ref = records.findLast(record => record.kind === 'run.closed') ?? records.at(-1);
      if (ref) {
        const last = entries.findLast(row => row.kind === 'assistant') as Extract<Entry, { kind: 'assistant' }> | undefined;
        const entry = last ?? { kind: 'assistant' as const, ref, text: '', limited: false, partial: false };
        if (!last) entries.push(entry);
        entry.ref = ref; entry.text = options.answer.slice(0, 4000); entry.limited = options.answer.length > 4000; entry.partial = false;
      }
    }
    return entries;
  }

  private steer(requestId: string) {
    if (!this.steers?.has(requestId)) {
      this.steers = new Map();
      for (const ref of pages(this.root, this.runId, { kinds: ['control.accepted'] })) { const data = decode(this.root, ref); this.steers.set(data.requestId, { kind: data.kind, input: data.input }); }
    }
    return this.steers.get(requestId);
  }

  /** 一次工具调用的事实；有了 tool.summary 的结果按 attemptId 缓存。 */
  private tool(seenAt: RecordReference, attemptId: string, active: boolean): ToolEntry | undefined {
    const cached = this.tools.get(attemptId);
    if (cached) return cached;
    let intent = seenAt.kind === 'tool.intent' ? seenAt : undefined;
    if (!intent) for (const ref of pages(this.root, this.runId, { before: seenAt.seq, kinds: ['tool.intent'] })) if (headAttempt(this.root, ref) === attemptId) { intent = ref; break; }
    if (!intent) return undefined;
    const data = decode(this.root, intent), args = data.args ?? {};
    const tool = String(data.tool ?? 'tool');
    const argKind = typeof args.path === 'string' ? 'path' : typeof args.command === 'string' ? 'command' : 'text';
    const argText = argKind === 'path' ? args.path : argKind === 'command' ? String(args.command).split('\n')[0] : JSON.stringify(args);
    const entry: ToolEntry = { kind: 'tool', ref: intent, attemptId, tool, args: argText, argKind, state: active ? 'running' : 'unknown', startedAt: intent.at, summary: active ? '' : '结果未知', detail: intent };
    let summaryRef: RecordReference | undefined, summary: any;
    for (const ref of pages(this.root, this.runId, { after: intent.seq, kinds: ['tool.summary'] })) {
      const value = JSON.parse(readObject(this.root, ref.ref).toString());
      if (value.attemptId === attemptId) { summaryRef = ref; summary = value; break; }
    }
    if (!summaryRef) return entry;
    const source = summary.resultSeq ?? summary.errorSeq;
    const sourceRef = source ? readRunRecords(this.root, this.runId, { after: source - 1, limit: 1 }).records.find(ref => ref.seq === source) : undefined;
    const sourceData = sourceRef ? decode(this.root, sourceRef) : undefined;
    if (sourceRef) entry.detail = sourceRef;
    entry.state = summary.isError === true ? 'error' : summary.isError === false ? 'ok' : 'unknown';
    entry.summary = entry.state === 'unknown' ? '结果未知' : '';
    const resultText = (sourceData?.result?.content ?? []).filter((item: { type?: string }) => item.type === 'text').map((item: { text: string }) => item.text).join('\n');
    const error: string | undefined = sourceData?.error;
    if (tool === 'read' && entry.state === 'ok') {
      const lines = lineCount(resultText), start = typeof args.offset === 'number' ? args.offset : 1, truncation = summary.truncation;
      const partial = args.offset !== undefined || args.limit !== undefined || truncation?.truncated;
      entry.summary = partial ? `第 ${start}–${start + Math.max(0, lines - 1)} 行${typeof truncation?.totalLines === 'number' ? ` / 共 ${truncation.totalLines} 行` : ''}` : `${lines} 行`;
      entry.output = keep(linesOf(resultText), 'head');
    } else if (tool === 'edit' && entry.state === 'ok') {
      const diff = String(sourceData?.result?.details?.diff ?? '').split('\n').filter(Boolean);
      entry.diff = diff;
      entry.summary = `+${diff.filter(line => /^\+\s*\d/.test(line)).length} −${diff.filter(line => /^-\s*\d/.test(line)).length}`;
    } else if (tool === 'write' && entry.state === 'ok') {
      const write = [...pages(this.root, this.runId, { after: intent.seq, before: summaryRef.seq, kinds: ['file.write-intent'] })].map(ref => decode(this.root, ref)).find(value => value.toolAttempt?.attemptId === attemptId)?.acquired;
      if (write) {
        const content = Buffer.from(write.content, 'base64').toString('utf8'), previous = write.previous === null ? '' : Buffer.from(write.previous, 'base64').toString('utf8');
        entry.summary = `+${lineCount(content)} −${lineCount(previous)}`;
        entry.diff = linesOf(content).slice(0, OUTPUT_KEEP).map((line, index) => `+${index + 1} ${line}`);
      }
    } else if (tool === 'bash') {
      const output = this.shellOutput(intent.seq, summaryRef.seq, attemptId) ?? keep(linesOf(resultText), 'tail');
      const code = entry.state === 'ok' ? 0 : /exited with code (\d+)/.exec(error ?? '')?.[1];
      const outcome = code !== undefined ? `exit ${code}` : /timed out/.test(error ?? '') ? '超时' : /abort/i.test(error ?? '') ? '已中止' : (error ?? '').split('\n')[0];
      entry.summary = `${outcome} · ${output.total} 行`;
      entry.output = output;
    }
    // 失败的说明：错误、结果正文与诊断（如 read 的 unsupported_image）都是已记录的事实。
    if (entry.state === 'error' && tool !== 'bash') entry.output = keep([error, resultText, ...(summary.diagnostics ?? []).map((d: { message?: string }) => d.message)].filter((text): text is string => !!text).flatMap(linesOf), 'tail');
    this.tools.set(attemptId, entry);
    return entry;
  }

  /** bash 的全部已取得输出（tool.output 块）：只保留开头与末尾各 40 行，计数全部行。 */
  private shellOutput(after: number, before: number, attemptId: string): ToolOutput | undefined {
    let total = 0, partial = '', tail: string[] = [], chunks = 0;
    // Chunks are byte slices; a streaming decoder keeps characters split across them intact.
    const decoder = new TextDecoder();
    for (const ref of pages(this.root, this.runId, { after, kinds: ['tool.output'] })) {
      if (ref.seq >= before) break;
      const value = decode(this.root, ref);
      if (value.toolAttempt?.attemptId !== attemptId) continue;
      chunks++;
      const lines = (partial + decoder.decode(Buffer.from(value.acquired.bytes, 'base64'), { stream: true })).split('\n');
      partial = lines.pop()!;
      total += lines.length; tail = [...tail, ...lines].slice(-OUTPUT_KEEP);
    }
    if (!chunks) return undefined;
    if (partial) { total++; tail = [...tail, partial].slice(-OUTPUT_KEEP); }
    return { lines: tail, total, end: 'tail' };
  }
}

/** 多个 run 的用量之和（本会话 = 上下文链上各 run）。 */
export function sumUsage(items: RunUsage[]): { tokens: number; totals: CostTotals } {
  return { tokens: items.reduce((sum, item) => sum + item.tokens, 0), totals: sumCostEstimates(items.flatMap(item => item.requests)) };
}
