/** 2a trace 视图的列表层与详情栏（U7）。只读：不调用模型、不取锁；只有 `p` 固定为证据经确认后写一条固定记录。 */
import { randomUUID } from 'node:crypto';
import { matchesKey, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { hasOwnerMarker } from '../ownership.js';
import { records, decode } from '../history.js';
import { fixEvidence, verifyFixed } from '../fixed-evidence.js';
import { TraceReader, RAW_STATE_LABEL, type Trace, type TraceSpan, type TraceLlm, type TraceRaw } from '../trace.js';
import { readDisplayIndex, type DisplayIndex } from '../display-number.js';
import { formatCostTotals, requestCostView } from '../cost-estimate.js';
import { COLOR_TIER, SPINNER_FRAMES, SPINNER_INTERVAL_MS, styledLine, type TextSegment, type TokenName } from './theme.js';
import { fitSegments, errorCode, clean, hintLine, statusEmpty, truncateEnd, truncateMiddle, type ConfirmConfig } from './view-stack.js';
import { mayWrite, type WriteAccess } from './write-access.js';

/** 秒级耗时：0.04s、8.7s、1m02s、3h12m。 */
export function formatDuration(ms: number) {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
import { tokenCount as formatTokens } from './session-screen.js';
export { formatTokens };
import { runVersionChanged } from '../continuation.js';
const COMPACTION_STATE: Record<string, string> = { applied: '已接入', generated: '已生成未接入', stale: '过期', noop: '无需压缩', failed: '失败', cancelled: '已取消', interrupted: '中断' };
const requestRange = (requests: TraceLlm[]) => !requests.length ? '无模型请求' : requests.length === 1 ? `llm #${requests[0].number}` : `llm #${requests[0].number}–#${requests.at(-1)!.number}`;

/** 列表层的 Enter 与 `p` 需要宿主（app.ts）提供的；不传时这两个键不起作用。 */
export interface TraceHost extends WriteAccess {
  /** 本进程有任务运行（持有写入者锁）。 */
  busy(): boolean;
  feedback(text: string): void;
  /** 打开确认框（U12）；Enter 后调用 run。 */
  confirm(config: ConfirmConfig, run: () => Promise<void>): void;
  changed(): void;
  /** Enter：为选中的 span 进入原文层。 */
  openRaw(span: TraceSpan): void;
}

type Row = { kind: 'run' } | { kind: 'span'; span: TraceSpan; last: boolean } | { kind: 'gap'; text: string };

/** 原文取得状态（详情栏与原文层共用）：完整取得且无说明 `●` ac.ok；截断、部分、已归档或暂不可读 `◐` ac.warn；缺口、损坏或已清理 `✗` ac.err（无色档靠字形区分）。 */
export function rawStateGlyph(state: TraceRaw['state'], note?: string): TextSegment {
  if (state === 'complete' && !note) return { text: '●', fg: 'ac.ok' };
  return ['complete', 'partial', 'archived', 'temporarily-unreadable'].includes(state) ? { text: '◐', fg: 'ac.warn' } : { text: '✗', fg: 'ac.err' };
}
const right = (text: string, width: number, fg?: TokenName): TextSegment => { const shown = truncateEnd(text, width); return { text: ' '.repeat(width - visibleWidth(shown)) + shown, fg }; };

/**
 * 列表层与详情栏。`live()` 为真时（该 run 正由本进程执行）未关闭的执行段与进行中的 span 延伸到此刻；
 * 新记录在下一次渲染时增量读入，选中项按 span 身份保持不动。
 */
export class TraceView {
  private readonly reader: TraceReader;
  private index: DisplayIndex;
  private current: Trace;
  private selected = 'run';
  private offset = 0;
  private follow = true;
  private rows: Row[] = [];
  private bodyTop = 0;
  private readonly versionChanged: boolean;
  private lastRead = 0;
  /** 未解除的固定记录（来源记录集合）；核对结果按固定记录缓存。 */
  private readonly fixations: { source: string; selected: Set<string> }[] = [];
  private readonly verified = new Map<string, boolean>();
  /** `host` 接入原文与固定操作；`adjust` 让 eval trial 使用宿主中介记录的用量与金额。 */
  constructor(readonly root: string, readonly runId: string, private readonly live: () => boolean = () => false, private readonly host?: TraceHost, private readonly adjust: (trace: Trace) => Trace = trace => trace) {
    this.versionChanged = runVersionChanged(root, runId) === true;
    this.reader = new TraceReader(root, runId);
    this.index = readDisplayIndex(root);
    this.current = adjust(this.reader.trace(live()));
    for (const ref of records(root, { kinds: ['evidence.fixed'] })) {
      try { this.fixations.push({ source: ref.id, selected: new Set(decode(root, ref).selected ?? []) }); } catch { /* 不可读的固定记录不算已固定。 */ }
    }
  }
  get trace() { return this.current; }
  get runLabel() { return this.index.label('run', this.runId); }
  /** 行名的简写，用于原文层头部与固定用途：`llm #3`、`tc-…-02 bash`、`compaction 自动 · llm #5`。 */
  spanName(span: TraceSpan) {
    if (span.kind === 'llm') return `llm #${span.llm!.number}`;
    if (span.kind === 'compaction') return `compaction ${span.compaction!.trigger === 'automatic' ? '自动' : '手动'} · ${requestRange(span.compaction!.requests)}`;
    const tool = span.tool!;
    return `${tool.call !== null ? `${this.index.toolCall(this.runId, tool.call)} ` : ''}${tool.name}${tool.denied ? ' 被拒' : ` · attempt ${tool.attempt}`}`;
  }
  /** 该 span 被固定为证据（未解除、内容核对完整）时返回固定记录 id。E2：已缺失内容不显示固定成功。 */
  fixedOf(span: TraceSpan) {
    for (const fixation of this.fixations) {
      if (!span.sources.some(source => fixation.selected.has(source))) continue;
      if (!this.verified.has(fixation.source)) { let ok = false; try { ok = verifyFixed(this.root, fixation.source).state === 'protected'; } catch { /* 核对失败不算已固定。 */ } this.verified.set(fixation.source, ok); }
      if (this.verified.get(fixation.source)) return fixation.source;
    }
    return undefined;
  }
  /** 列表层 `p`：以所选 span 的记录为来源固定为证据（依赖闭包沿用 fixEvidence，覆盖整个 run）。 */
  private pin(host: TraceHost) {
    if (!mayWrite(host)) return;
    const span = this.selectedSpan;
    if (!span) { host.feedback('选中一个 span 后按 p 固定为证据'); return; }
    if (this.fixedOf(span)) { host.feedback('已固定为证据 · 不重复固定'); return; }
    // fixEvidence 要取数据根写入者锁：锁被占用时不弹框，只提示（#47 第 6 节）。
    if (host.busy() || hasOwnerMarker(this.root)) { host.feedback('有任务运行中，结束后再固定'); return; }
    const purpose = `trace：${this.runLabel} ${this.spanName(span)}`, sources = span.sources.slice(0, 50);
    host.confirm({
      title: '固定为证据', action: '固定',
      body: [`来源 ${this.spanName(span)} 的 ${sources.length} 条记录`, `用途 ${purpose}`, 'id 自动生成 · 自定义用途用 CLI pi-durio fix'],
      fixed: [`范围：整个 run ${this.runLabel} 截至此刻的全部原文与执行版本安装文件（依赖闭包）`, '写入一条固定记录 · 不调用模型 · 固定的内容不会被存储清理删除，解除用 pi-durio storage unfix'],
    }, async () => {
      if (!mayWrite(host)) return;
      try {
        const result = await fixEvidence(this.root, { id: `tui-fix-${randomUUID()}`, sources, purpose });
        this.fixations.push({ source: result.source, selected: new Set(result.selected) });
        this.verified.delete(result.source);
        host.feedback(this.fixedOf(span) ? '已固定为证据' : '固定记录已写入，但内容核对未通过');
      } catch (error) {
        const code = errorCode(error, 'FIX_FAILED');
        host.feedback(code.startsWith('OWNER_') ? '有任务运行中，结束后再固定' : `固定失败 · ${code}`);
      }
      host.changed();
    });
  }
  /** 当前选中的 span；选中 run 行时为 undefined。#79 的原文层与 `p` 从这里取。 */
  get selectedSpan() { return this.current.spans.find(span => span.key === this.selected); }
  select(key: string) { this.selected = key; this.follow = true; }
  private selectable() { return ['run', ...this.current.spans.map(span => span.key)]; }
  handleInput(data: string) {
    const keys = this.selectable(), at = Math.max(0, keys.indexOf(this.selected));
    if (matchesKey(data, 'up')) this.select(keys[Math.max(0, at - 1)]);
    else if (matchesKey(data, 'down')) this.select(keys[Math.min(keys.length - 1, at + 1)]);
    else if (matchesKey(data, 'home')) this.select(keys[0]);
    else if (matchesKey(data, 'end')) this.select(keys.at(-1)!);
    else if (this.host && matchesKey(data, 'enter')) {
      const span = this.selectedSpan;
      if (!span) this.host.feedback('选中一个 span 后按 Enter 查看原文');
      else if (!span.raws.length) this.host.feedback('这一行没有原文项');
      else this.host.openRaw(span);
    } else if (this.host && data === 'p') this.pin(this.host);
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); this.follow = false; }
  /** 鼠标点击：y 为视图内行号。 */
  click(y: number) {
    const row = this.rows[y - this.bodyTop + this.offset];
    if (!row || y < this.bodyTop) return;
    if (row.kind === 'run') this.select('run'); else if (row.kind === 'span') this.select(row.span.key);
  }
  /** 读入新追加的记录（运行中每 200ms 最多一次）。原文层渲染前也调用。 */
  refresh() {
    const live = this.live();
    // 运行中每 200ms 最多读一次新记录；查询本身按 run 与序号有界。
    if (Date.now() - this.lastRead >= 200 || !live) {
      this.lastRead = Date.now();
      if (this.reader.update()) { const fresh = readDisplayIndex(this.root); if (fresh.has('run', this.runId)) this.index = fresh; }
    }
    this.current = this.adjust(this.reader.trace(live));
  }

  render(width: number, height: number, esc: string): string[] {
    this.refresh();
    const trace = this.current, wide = width >= 100, narrow = width < 60;
    const header = this.header(trace, width, wide);
    if (trace.empty) return [...header, statusEmpty(`run ${this.index.label('run', this.runId)}`, '已取得的记录', width), ...Array(Math.max(0, height - header.length - 2)).fill(styledLine([], width)), this.footer(trace, width, esc)];
    const detailWidth = wide ? Math.round(width * 380 / 1180) : 0, listWidth = wide ? width - detailWidth - 1 : width;
    this.rows = this.buildRows(trace);
    const summary = wide ? [] : [styledLine([{ text: clean(this.summaryLine()), fg: 'fg.body' }], width)];
    const fixed = header.length + 2 + summary.length + 1;
    const room = Math.max(1, height - fixed);
    // 图例上方与底栏上方的区块分隔线（U10）：列表放得下时才画，否则先收它们，再收图例。
    const legend = this.rows.length + 1 <= room, rules = this.rows.length + 3 <= room;
    const bodyHeight = room - (legend ? 1 : 0) - (rules ? 2 : 0);
    const selectedRow = this.rows.findIndex(row => row.kind === 'run' ? this.selected === 'run' : row.kind === 'span' && row.span.key === this.selected);
    if (this.follow && selectedRow >= 0) { if (selectedRow < this.offset) this.offset = selectedRow; else if (selectedRow >= this.offset + bodyHeight) this.offset = selectedRow - bodyHeight + 1; }
    this.offset = Math.max(0, Math.min(this.offset, this.rows.length - bodyHeight));
    this.bodyTop = header.length + 2;
    const columns = this.columns(listWidth, narrow);
    const total = Math.max(1, ...trace.segments.map(s => s.end));
    const list = [this.columnHeader(columns, total, listWidth), ...Array.from({ length: bodyHeight }, (_, i) => this.rowLine(this.rows[this.offset + i], columns, total, listWidth, trace))];
    if (rules) list.push(styledLine([{ text: '─'.repeat(listWidth), fg: 'line.subtle' }], listWidth));
    if (legend) list.push(styledLine([{ text: '■', fg: 'ac.brand' }, { text: ' llm  ', fg: 'fg.faint' }, { text: '■', fg: 'fg.muted' }, { text: ' tool  ', fg: 'fg.faint' }, { text: '■', fg: 'ac.model' }, { text: ' compaction  ', fg: 'fg.faint' }, { text: '■', fg: 'ac.warn' }, { text: ' 重试 / unknown  ', fg: 'fg.faint' }, { text: '■', fg: 'ac.err' }, { text: ' 失败', fg: 'fg.faint' }], listWidth));
    let body = list;
    if (wide) {
      // 详情栏左右各留 2 列（设计稿 2a）。
      const detail = this.detail(trace, detailWidth - 4);
      const bar = styledLine([{ text: '│', fg: 'line.subtle' }], 1);
      body = list.map((row, i) => row + bar + styledLine([{ text: '  ' }, ...(detail[i] ?? [])], detailWidth));
    }
    const rule = styledLine([{ text: '─'.repeat(width), fg: 'line.subtle' }], width);
    return [...header, rule, ...body, ...(rules ? [rule] : []), ...summary, this.footer(trace, width, esc)];
  }

  private header(trace: Trace, width: number, wide: boolean): string[] {
    const task = trace.taskId ? ` · 任务 ${this.index.label('task', trace.taskId)}` : '';
    const left: TextSegment[] = [{ text: '◆', fg: 'ac.info' }, { text: ' trace', fg: 'fg.primary', bold: true }, { text: ` ${this.versionChanged ? ' · 执行版本已变 ' : ' '}run ${this.index.label('run', trace.runId)} · ${trace.taskKind}${task} · 执行版本 ${trace.version ? `build ${trace.version.slice(0, 7)}` : '未记录'}`, fg: 'fg.faint' }];
    const status = this.statusSegment(trace.status);
    const facts = `${formatDuration(trace.duration)} · ${formatTokens(trace.tokens)} tok ${formatCostTotals(trace.cost)}${trace.maintenance ? ` · 另有维护 ${trace.maintenance} 项` : ''}`;
    const rightSegments: TextSegment[] = [status, { text: ` · ${facts}`, fg: 'fg.faint' }];
    const leftWidth = left.reduce((w, s) => w + visibleWidth(s.text), 0), rightWidth = rightSegments.reduce((w, s) => w + visibleWidth(s.text), 0);
    const errors = trace.costError ? [styledLine([{ text: `✗ 费用估算不可读取 · ${clean(trace.costError)}`, fg: 'ac.err' }], width)] : [];
    // 头部右侧是事实：放不下（宽度小于 100）时移到第二行，不收起（U12）。
    if (wide && leftWidth + rightWidth + 2 <= width) return [styledLine([...left, { text: ' '.repeat(width - leftWidth - rightWidth) }, ...rightSegments], width), ...errors];
    return [styledLine(fitSegments(left, width), width), styledLine(fitSegments([{ text: '  ' }, ...rightSegments], width), width), ...errors];
  }
  private statusSegment(status: Trace['status']): TextSegment {
    if (status === 'running') return { text: `${SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]} 运行中`, fg: 'ac.brand' };
    return { completed: { text: '✓ 完成', fg: 'ac.ok' }, failed: { text: '✗ 失败', fg: 'ac.err' }, aborted: { text: '◇ 已中止', fg: 'fg.muted' }, ended: { text: '◇ 已结束', fg: 'fg.muted' }, unknown: { text: '◈ 结果未知', fg: 'ac.warn' } }[status] as TextSegment;
  }
  private footer(trace: Trace, width: number, esc: string) {
    const stats = `${trace.counts.models} 次模型请求（重试 ${trace.counts.retries}）· ${trace.counts.tools} 次工具调用（恢复后重试 ${trace.counts.recoveryRetries}）· 只读，查看不调用模型、不新增用量`;
    const keys = this.host ? ['↑↓ span', 'Enter 原文', ...(this.host.writeBlocked() ? [] : ['p 固定为证据'])] : ['↑↓ span'];
    const keysWidth = Math.min(width, visibleWidth(`${keys.join(' · ')} · ${esc}`));
    // 键位在右、Esc 最右；放不下时先截断左侧说明，再按 hintLine 从 Esc 左边去掉键位。
    if (width - keysWidth < 12) return hintLine(keys, width, { esc });
    return styledLine([{ text: truncateEnd(stats, width - keysWidth - 2), fg: 'fg.label' }], width - keysWidth) + hintLine(keys, keysWidth, { esc });
  }

  private buildRows(trace: Trace): Row[] {
    const rows: Row[] = [{ kind: 'run' }];
    const spans = (index: number) => trace.spans.filter(span => span.segment === index);
    const main = trace.segments.filter(s => s.kind !== 'maintenance'), maintenance = trace.segments.filter(s => s.kind === 'maintenance');
    for (const segment of main) {
      if (segment.gap !== null) rows.push({ kind: 'gap', text: `┄ 中断 ${formatDuration(segment.gap)} · 恢复核对${segment.readOnly ? ' · 只读续跑（首版）' : ''} ┄` });
      else if (segment.readOnly) rows.push({ kind: 'gap', text: '┄ 只读续跑（首版） ┄' });
      for (const span of spans(segment.index)) rows.push({ kind: 'span', span, last: false });
    }
    if (maintenance.length) {
      rows.push({ kind: 'gap', text: '┄ 维护 · run 结束后追加，不计入头部耗时与 tok ┄' });
      for (const segment of maintenance) for (const span of spans(segment.index)) rows.push({ kind: 'span', span, last: false });
    }
    const lastSpan = rows.findLast(row => row.kind === 'span');
    if (lastSpan && lastSpan.kind === 'span') lastSpan.last = true;
    return rows;
  }
  private columns(listWidth: number, narrow: boolean) {
    const dur = 7, tok = 6;
    if (narrow) return { name: Math.max(8, listWidth - dur - tok - 3), bar: 0, dur, tok };
    const name = Math.max(20, Math.min(40, Math.round(listWidth * 0.42)));
    return { name, bar: Math.max(4, listWidth - name - dur - tok - 5), dur, tok };
  }
  private columnHeader(c: ReturnType<TraceView['columns']>, total: number, width: number) {
    const segments: TextSegment[] = fitSegments([{ text: 'span', fg: 'fg.faint' }], c.name);
    if (c.bar) {
      const start = '0s', mid = formatDuration(total / 2), end = formatDuration(total);
      const gap = Math.max(1, c.bar - start.length - mid.length - end.length), a = Math.floor(gap / 2);
      segments.push({ text: ' ' }, { text: c.bar >= start.length + mid.length + end.length + 2 ? `${start}${' '.repeat(a)}${mid}${' '.repeat(gap - a)}${end}` : ' '.repeat(c.bar), fg: 'fg.faint' });
    }
    segments.push({ text: ' ' }, right('耗时', c.dur, 'fg.faint'), { text: ' ' }, right('tok', c.tok, 'fg.faint'));
    return styledLine(segments, width);
  }
  /** 条形颜色：llm、tool、compaction、重试 / unknown、失败（设计稿图例）。 */
  private color(span: TraceSpan, trace: Trace): TokenName {
    if (span.outcome === 'failed' || span.outcome === 'denied') return span.kind === 'llm' && trace.spans.some(s => s.llm?.retryOf === span.llm!.number) ? 'ac.warn' : 'ac.err';
    if (span.kind === 'llm' && span.llm!.tokens === null && !span.running) return 'ac.warn';
    return span.kind === 'llm' ? 'ac.brand' : span.kind === 'tool' ? 'fg.muted' : 'ac.model';
  }
  private bar(width: number, from: number, to: number, total: number, fg: TokenName): TextSegment[] {
    const a = Math.min(width - 1, Math.floor(from / total * width)), b = Math.max(a + 1, Math.min(width, Math.ceil(to / total * width)));
    const empty = COLOR_TIER === 'none' ? '░' : ' ';
    return [{ text: empty.repeat(a), fg: 'line.track' }, { text: '█'.repeat(b - a), fg }, { text: empty.repeat(width - b), fg: 'line.track' }];
  }
  private nameSegments(row: Row, trace: Trace, width: number): TextSegment[] {
    if (row.kind === 'run') return [{ text: '▾ ', fg: 'fg.faint' }, { text: 'run', fg: 'fg.primary' }, { text: ` ${this.index.label('run', trace.runId)}`, fg: 'fg.faint' }];
    if (row.kind !== 'span') return [];
    const span = row.span, tree: TextSegment = { text: row.last ? '└─ ' : '├─ ', fg: 'fg.gutter' };
    const spin: TextSegment[] = span.running ? [{ text: ` ${SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]}`, fg: 'ac.brand' }] : [];
    if (span.kind === 'llm') {
      const llm = span.llm!, suffix: TextSegment[] = [];
      if (llm.retryOf !== null) suffix.push({ text: ` ← #${llm.retryOf}`, fg: 'fg.faint' });
      if (span.outcome === 'failed') suffix.push({ text: ` ${llm.http && llm.http >= 400 ? llm.http : '✗'}${trace.spans.some(s => s.llm?.retryOf === llm.number) ? ' · 重试' : ''}`, fg: this.color(span, trace) });
      return [tree, { text: 'llm', fg: 'ac.brand' }, { text: ` ${llm.purpose} ` }, { text: `#${llm.number}`, fg: 'fg.faint' }, ...suffix, ...spin];
    }
    if (span.kind === 'compaction') {
      const c = span.compaction!;
      return [tree, { text: 'compaction', fg: 'ac.model' }, { text: ` ${c.trigger === 'automatic' ? '自动' : '手动'}` }, { text: ` · ${requestRange(c.requests)}`, fg: 'fg.faint' }, ...(span.outcome === 'failed' ? [{ text: ' ✗', fg: 'ac.err' as TokenName }] : []), ...spin];
    }
    const tool = span.tool!, suffix: TextSegment[] = [];
    if (tool.denied) suffix.push({ text: ` ✗ ${deniedText(tool).join(' · ')}`, fg: 'ac.err' });
    else if (span.outcome === 'failed') suffix.push({ text: ' ✗', fg: 'ac.err' });
    else if (tool.exit === 0) suffix.push({ text: ' ✓', fg: 'ac.ok' });
    if (tool.recoveryRetry) suffix.push({ text: ' 恢复后重试', fg: 'ac.warn' });
    if (tool.skipped) suffix.push({ text: ' 跳过（首版处置）', fg: 'fg.faint' });
    const fixed = [tree, { text: 'tool', fg: 'fg.muted' as TokenName }, { text: ` ${tool.name}` }, ...suffix, ...spin];
    const target = tool.target ? clean(tool.target.split('\n')[0]) : '';
    const room = width - fixed.reduce((w, s) => w + visibleWidth(s.text), 0) - 1;
    const isPath = tool.name !== 'bash' && !!tool.target;
    const shown = room <= 1 ? '' : isPath ? truncateMiddle(target, room) : truncateEnd(target, room);
    return [tree, { text: 'tool', fg: 'fg.muted' }, { text: ` ${tool.name}` }, ...(shown ? [{ text: ` ${shown}`, fg: (isPath ? 'ac.path' : 'ac.warn') as TokenName }] : []), ...suffix, ...spin];
  }
  private rowLine(row: Row | undefined, c: ReturnType<TraceView['columns']>, total: number, width: number, trace: Trace) {
    if (!row) return styledLine([], width);
    if (row.kind === 'gap') return styledLine([{ text: truncateEnd(row.text, width), fg: 'fg.faint' }], width);
    const selected = row.kind === 'run' ? this.selected === 'run' : row.span.key === this.selected;
    // 列表与头部、底栏左对齐（设计稿 2a）；宽屏时列表右侧到竖线留 2 列。
    const segments: TextSegment[] = fitSegments(this.nameSegments(row, trace, c.name), c.name);
    let duration: string, tokens: TextSegment;
    if (row.kind === 'run') {
      const main = trace.segments.filter(s => s.kind !== 'maintenance');
      if (c.bar) segments.push({ text: ' ' }, ...this.bar(c.bar, 0, main.length ? Math.max(...main.map(s => s.end)) : 0, total, 'line.track'));
      duration = formatDuration(trace.duration);
      tokens = right(trace.unknownTokens && !trace.tokens ? '?' : formatTokens(trace.tokens), c.tok, trace.unknownTokens ? 'ac.warn' : undefined);
    } else {
      const span = row.span;
      if (c.bar) segments.push({ text: ' ' }, ...this.bar(c.bar, span.start, span.end, total, this.color(span, trace)));
      duration = formatDuration(span.end - span.start);
      const count = span.kind === 'llm' ? span.llm!.tokens : span.kind === 'compaction' ? span.compaction!.tokens : undefined;
      tokens = count === undefined ? right('—', c.tok, 'fg.faint') : count === null ? right('?', c.tok, 'ac.warn') : right(formatTokens(count), c.tok);
    }
    segments.push({ text: ' ' }, right(duration, c.dur), { text: ' ' }, tokens);
    return styledLine(segments.map(s => ({ ...s, bg: selected ? 'bg.selected' : s.bg })), width, selected ? 'bg.selected' : undefined);
  }

  /** 宽度小于 100 时底栏上方的选中 span 摘要。 */
  summaryLine(span = this.selectedSpan): string {
    const trace = this.current;
    if (!span) return `run ${this.index.label('run', trace.runId)} · ${this.statusSegment(trace.status).text} · ${formatDuration(trace.duration)}`;
    const length = formatDuration(span.end - span.start);
    if (span.kind === 'llm') { const result = this.llmResult(span.llm!); return [`llm #${span.llm!.number}`, span.llm!.purpose, result.value, ...result.notes, length].join(' · '); }
    if (span.kind === 'compaction') return [`compaction ${span.compaction!.trigger === 'automatic' ? '自动' : '手动'}`, COMPACTION_STATE[span.compaction!.state ?? ''] ?? '未记录', length].join(' · ');
    const tool = span.tool!;
    const exit = this.exitText(span);
    return [`tool ${tool.name}`, exit.value, ...exit.notes, length].filter(Boolean).join(' · ');
  }
  /** 主值与说明分开给出：详情栏分别上色，摘要行用 ` · ` 拼接。 */
  private llmResult(llm: TraceLlm): { value: string; notes: string[] } {
    return { value: llm.http !== null ? `HTTP ${llm.http}` : '未记录 HTTP', notes: [llm.stopReason ?? '未返回结果', ...(llm.usage ? [] : ['未返回 usage'])] };
  }
  private exitText(span: TraceSpan): { value: string; notes: string[] } {
    const tool = span.tool!;
    if (tool.denied) { const [value, ...notes] = deniedText(tool); return { value: `✗ ${value}`, notes }; }
    if (tool.exit !== null && tool.exit !== 0) return { value: `exit ${tool.exit}`, notes: [tool.check ? '预先声明的检查，不计运行故障' : '计入工具失败'] };
    if (tool.exit === 0) return { value: 'exit 0', notes: [] };
    if (span.running) return { value: '运行中', notes: [] };
    if (span.outcome === 'failed') return { value: `✗ ${clean(tool.error ?? '工具返回错误').split('\n')[0]}`, notes: ['计入工具失败'] };
    return { value: span.outcome === 'ok' ? '已返回' : '未返回结果', notes: [] };
  }

  /** 选中项的完整详情，渲染成整行（宽度小于 100 时原文层顶部显示）。 */
  detailRows(width: number): string[] { return this.detail(this.current, width - 2).map(segments => styledLine([{ text: ' ' }, ...segments], width)); }
  private detail(trace: Trace, width: number): TextSegment[][] {
    const lines: TextSegment[][] = [];
    // 标题与各分节之间空一行（U10、设计稿 2a）。
    const title = (bold: string, rest = '') => lines.push([{ text: truncateEnd(bold, width), fg: 'fg.primary', bold: true }, { text: truncateEnd(rest ? `  ${rest}` : '', Math.max(0, width - visibleWidth(bold))), fg: 'fg.faint' }], []);
    /** 标签 `fg.label`，值按语义上色；`note`（含分隔符）为 `fg.faint` 的说明，与值同行放不下时另起一行。 */
    const kv = (label: string, value: string, fg: TokenName = 'fg.body', note?: string, noteFg: TokenName = 'fg.faint') => {
      const labelWidth = 9, text = clean(value), room = Math.max(4, width - labelWidth), extra = note ? clean(note) : '';
      const head = (i: number) => ({ text: i ? ' '.repeat(labelWidth) : label + ' '.repeat(Math.max(1, labelWidth - visibleWidth(label))), fg: 'fg.label' as TokenName });
      if (extra && visibleWidth(text + extra) <= room) { lines.push([head(0), { text, fg }, { text: extra, fg: noteFg }]); return; }
      const wrapped = [...wrapTextWithAnsi(text, room).map(part => ({ text: part, fg })), ...(extra ? wrapTextWithAnsi(extra.replace(/^ *(· |— )?/, ''), room).map(part => ({ text: part, fg: noteFg })) : [])];
      wrapped.forEach((part, i) => lines.push([head(i), part]));
    };
    const offsets = (span: TraceSpan) => `+${formatDuration(span.start)} → ${span.running ? '进行中' : `+${formatDuration(span.end)}`}`;
    const raws = (items: TraceRaw[]) => {
      if (!items.length) return;
      lines.push([]); lines.push([{ text: '原文', fg: 'fg.label' }]);
      for (const item of items) {
        // 状态文字靠右。
        const size = item.bytes !== undefined ? ` · ${item.bytes} B` : '', state = RAW_STATE_LABEL[item.state], name = truncateEnd(` ${item.label}${size}`, Math.max(1, width - 1 - visibleWidth(state) - 2));
        lines.push([rawStateGlyph(item.state, item.note), { text: name }, { text: ' '.repeat(Math.max(2, width - 1 - visibleWidth(name) - visibleWidth(state))) }, { text: state, fg: 'fg.faint' }]);
        if (item.note) lines.push([{ text: `  ${item.note}`, fg: 'fg.faint' }]);
      }
    };
    const llmBlock = (span: TraceSpan, llm: TraceLlm) => {
      kv('请求模型', llm.model ?? '未记录', 'ac.model');
      const result = this.llmResult(llm);
      kv('结果', result.value, span.outcome === 'failed' ? 'ac.warn' : 'fg.body', [...result.notes, ...(llm.error ? [clean(llm.error).split('\n')[0]] : [])].map(part => ` · ${part}`).join(''));
      if (llm.usage) kv('用量', `输入 ${llm.usage.input} · 缓存 ${llm.usage.cacheRead} · 输出 ${llm.usage.output}`);
      else kv('用量', 'unknown', 'ac.warn', ' — 不记为 0');
      const cost = requestCostView(llm.cost ?? undefined);
      if (cost) kv('费用', cost.display, cost.state === 'complete' ? 'fg.body' : 'ac.warn', ` · 价目 ${cost.price.version ?? '无'} · ${cost.price.period}`);
      else kv('费用', 'unknown', 'ac.warn', ' · 没有估算');
    };
    const span = this.selectedSpan;
    if (!span) {
      const segments = trace.segments.filter(s => s.kind !== 'maintenance');
      title('run', this.index.label('run', trace.runId));
      const status = this.statusSegment(trace.status);
      kv('状态', status.text, status.fg, trace.reason ? ` · ${trace.reason}` : undefined);
      kv('执行段', `${segments.length}${segments.length > 1 ? `（恢复后续跑 ${segments.length - 1}）` : ''}${trace.maintenance ? ` · 另有维护 ${trace.maintenance} 项` : ''}`);
      kv('执行版本', trace.version ?? '未记录');
      if (trace.taskId) kv('任务', this.index.label('task', trace.taskId));
      kv('耗时', formatDuration(trace.duration), 'fg.body', ' · 不计中断');
      kv('用量', `${formatTokens(trace.tokens)} tok`, 'fg.body', trace.unknownTokens ? ` · ${trace.unknownTokens} 次请求 unknown` : undefined, 'ac.warn');
      kv('费用', formatCostTotals(trace.cost), trace.cost.unknownRequests || trace.cost.partial ? 'ac.warn' : 'fg.body', ' · 估算 · 非账单');
      if (trace.costError) kv('费用错误', trace.costError, 'ac.err');
      return lines;
    }
    const fixed = this.fixedOf(span);
    const pinned = () => { if (fixed) kv('证据', '已固定', 'ac.ok'); };
    if (span.kind === 'tool') {
      const tool = span.tool!;
      title(`tool · ${tool.name}`, `${tool.call !== null ? this.index.toolCall(trace.runId, tool.call) : 'tc 未记录'} · attempt ${tool.attempt}`);
      pinned();
      if (tool.target) kv(tool.name === 'bash' ? '命令' : '路径', tool.target, 'ac.path');
      kv('起止', offsets(span));
      const exit = this.exitText(span);
      kv(tool.denied ? '结果' : '退出', exit.value, span.outcome === 'failed' || tool.denied || (tool.exit ?? 0) !== 0 ? 'ac.err' : 'fg.body', exit.notes.map(part => ` · ${part}`).join('') || undefined);
      if (tool.env) {
        const env = `${tool.env.version ?? '环境版本未记录'} · ${tool.env.names} 变量名 · `;
        lines.push(...wrapTextWithAnsi(`${env}${tool.env.apiKey ? '含 DEEPSEEK_API_KEY' : '不含 DEEPSEEK_API_KEY'}`, Math.max(4, width - 9)).map((part, i) => [{ text: i ? ' '.repeat(9) : '环境     ', fg: 'fg.label' as TokenName }, { text: part, fg: (tool.env!.apiKey ? 'ac.err' : 'fg.body') as TokenName }]));
      }
      if (!tool.denied) kv('重新执行', '中断后不自动重新执行');
      if (tool.recoveryRetry) kv('恢复', `恢复后重试 · 依据 ${tool.recoveryRetry.at.slice(5, 16).replace('T', ' ')} 的恢复决定 ${tool.recoveryRetry.decisionId}`, 'ac.warn');
      if (tool.skipped) kv('恢复', `跳过（首版处置）${tool.skipped.reason ? ` · ${tool.skipped.reason}` : ''}`);
      raws(span.raws);
      return lines;
    }
    if (span.kind === 'compaction') {
      const c = span.compaction!;
      title(`compaction · ${c.trigger === 'automatic' ? '自动' : '手动'}`, c.trigger === 'manual' ? '维护 · 不计入头部' : '');
      pinned();
      kv('触发', c.trigger === 'automatic' ? '自动（上下文接近上限）' : '手动（/compact）');
      kv('源范围', c.entries === null ? '未记录' : `${c.entries} 条`);
      kv('结果', COMPACTION_STATE[c.state ?? ''] ?? (span.running ? '进行中' : '未记录'));
      kv('请求', requestRange(c.requests));
      kv('用量', c.tokens === null ? 'unknown — 不记为 0' : `${formatTokens(c.tokens)} tok`, c.tokens === null ? 'ac.warn' : 'fg.body');
      kv('费用', formatCostTotals(c.cost));
      kv('起止', offsets(span));
      raws(span.raws);
      return lines;
    }
    const llm = span.llm!;
    title(`llm · #${llm.number}`, `${llm.purpose}${llm.round !== null ? ` · 第 ${llm.round} 轮` : ''}`);
    pinned();
    llmBlock(span, llm);
    kv('起止', offsets(span));
    raws(span.raws);
    const previous = llm.retryOf !== null ? trace.spans.find(s => s.llm?.number === llm.retryOf) : undefined;
    if (previous) {
      lines.push([], [{ text: '─'.repeat(width), fg: 'line.inner' }], []);
      title(`llm · #${previous.llm!.number}`, '同一逻辑请求的上一次 attempt');
      llmBlock(previous, previous.llm!);
    }
    return lines;
  }
}

/** 主值与说明：`[被拒, 只读续跑不允许 <工具>]`。 */
function deniedText(tool: NonNullable<TraceSpan['tool']>): [string, string] { return tool.duplicate ? ['已拦截', '该操作已完成，不重做'] : ['被拒', `只读续跑不允许 ${tool.name}`]; }
