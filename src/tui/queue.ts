import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { readDisplayIndex, isUserChosenId, type DisplayIndex } from '../display-number.js';
import type { QueueItemFact } from '../evidence.js';
import { latestPending, queueBudget, type QueueEntry, type QueueReattachment } from '../queue.js';
import { styledLine, COLOR_TIER, type ColorTier, type TextSegment } from './theme.js';
import { clean, truncateEnd, truncateMiddle, wrapAuthorized, fixedFrame, hintLine, statusEmpty, type ConfirmConfig } from './view-stack.js';
import { mayWrite, type WriteAccess } from './write-access.js';

export const QUEUE_STATUS = { pending: '待接入', dispatching: '接入待核对', frozen: '已冻结', applied: '已接入', withdrawn: '已撤回' };
export const QUEUE_KIND = { steer: 'steer', 'follow-up': 'follow-up', compact: '手动压缩', improve: 'improve 分析' };
/** 1b 队列行的类型字形（设计稿 1b）：steer 接入当前任务，follow-up 等当前任务结束。 */
const QUEUE_GLYPH = { steer: '↳', 'follow-up': '⧗', compact: '·', improve: '·' };
export function queueContent(item: QueueItemFact): string {
  if (item.kind === 'improve') try { const request = JSON.parse(item.input); if (typeof request.purpose === 'string') return request.purpose; } catch { /* Retain unparseable original content. */ }
  return item.input;
}

/** 1b queue region: at most three rows, with a hit region only over the rendered withdrawal action. */
export class QueueStrip {
  private hits: Array<{ row: number; start: number; end: number; id: string }> = [];
  render(entries: readonly QueueEntry[], width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    this.hits = [];
    if (!entries.length) return [];
    if (height < 20) return [styledLine([{ text: `队列 ${entries.length} 项 · /queue`, fg: 'fg.muted' }], width, undefined, tier)];
    const latest = latestPending(entries);
    let shown = entries.length > 3 ? entries.slice(-2) : [...entries];
    if (entries.length > 3 && latest && !shown.some(entry => entry.item.requestId === latest.requestId)) shown = [entries.find(entry => entry.item.requestId === latest.requestId)!, shown[1]];
    const rows = shown.map(({ item }, row) => {
      // 设计稿 1b：字形、类型（ac.info）与状态分色，内容在中间，撤回提示靠右对齐。
      const action = item.status === 'pending' ? item.requestId === latest?.requestId ? 'Backspace 撤回' : '撤回' : '';
      const head: TextSegment[] = [{ text: `${QUEUE_GLYPH[item.kind]} `, fg: 'ac.info' }, { text: `${QUEUE_KIND[item.kind]} `, fg: 'ac.info' }, { text: QUEUE_STATUS[item.status], fg: item.status === 'frozen' || item.status === 'pending' ? 'ac.warn' : 'fg.muted' }, { text: ' · ', fg: 'fg.faint' }];
      const used = head.reduce((sum, s) => sum + visibleWidth(s.text), 0), reserve = action ? visibleWidth(action) + 2 : 0;
      const content = truncateEnd(`「${clean(queueContent(item)).split('\n')[0]}」`, Math.max(1, width - used - reserve));
      const gap = Math.max(action ? 2 : 0, width - used - visibleWidth(content) - visibleWidth(action));
      const start = used + visibleWidth(content) + gap;
      if (action) this.hits.push({ row, start, end: start + visibleWidth(action), id: item.requestId });
      return styledLine([...head, { text: content, fg: 'fg.body' }, ...(action ? [{ text: ' '.repeat(gap) }, { text: action, fg: 'fg.faint' as const }] : [])], width, undefined, tier);
    });
    if (shown.length < entries.length) rows.push(styledLine([{ text: `+${entries.length - shown.length} 项 · /queue`, fg: 'fg.muted' }], width, undefined, tier));
    return rows;
  }
  hit(x: number, y: number): string | undefined { return this.hits.find(hit => hit.row === y && x >= hit.start && x < hit.end)?.id; }
}

/** Original binding and new authorization are fully scrollable; impact and charge bound stay fixed. */
export function queueConfirmation(entry: QueueEntry, plan: Extract<QueueReattachment, { state: 'ready' }>, index: DisplayIndex): ConfirmConfig {
  const { item, sessionId, taskNumber } = entry, { confirmation } = plan, budget = queueBudget();
  const replacing = confirmation.route === 'replace-follow-up', relaunch = confirmation.route === 'relaunch-improve';
  return {
    title: relaunch ? '撤回旧分析并重新确认' : replacing ? '按当前版本提交新任务' : '重新接入排队请求',
    action: relaunch ? '撤回并打开启动框' : replacing ? '撤回并提交新任务' : '重新接入', wrapBody: true,
    body: [
      `${QUEUE_KIND[item.kind]} · ${index.label('queue-request', item.requestId)}`,
      `原目标：${sessionId ? index.label('session', sessionId) : '会话未记录'} · 任务 ${taskNumber ?? '未记录'} · ${index.label('task', item.target.taskId)} · ${index.label('run', item.target.runId)}`,
      `工作区：${item.target.workspace}`,
      ...(replacing ? [`新任务：${index.label('session', confirmation.sessionId)} · 任务 ${plan.taskNumber} · 接在 ${index.label('run', confirmation.tailRunId)} 后`] : []),
      `内容：${queueContent(item)}`,
      item.kind === 'improve' ? `执行授权：只读 improve 分析 · ${confirmation.authorization.mode} · 工具 evidence_summary、evidence_read、source_view` : `执行授权：${plan.coding ? 'coding' : '只读'} · ${confirmation.authorization.mode} · 工具 ${confirmation.authorization.tools.join('、')}`,
      ...(confirmation.authorization.toolEnvironment ? [`工具环境：${JSON.stringify(confirmation.authorization.toolEnvironment)}`] : []),
    ],
    fixed: [relaunch ? '执行版本已变 · 撤回原项，保留原会话和分析目的；启动框再次确认后才分析' : replacing ? `执行版本已变 · 撤回原项，以新任务身份接到当前会话链尾${plan.coding ? '；可能修改项目文件' : ''}` : `保留原目标重新接入${plan.coding && item.kind !== 'improve' ? '；可能修改项目文件' : ''}`,
      `按一个任务 ${budget.requests} 次请求最坏情况预留 · ${budget.amount ? `上限约 ¥${budget.amount.amount.toFixed(2)}（高峰价）` : '金额未知 · 价目未覆盖'}`],
  };
}

export interface QueueHost extends WriteAccess {
  withdraw(id: string): void;
  reattach(id: string): void;
  copy(text: string): Promise<boolean | string>;
  changed(): void;
}

/** U13 queue panel: actions stay bound to request ids while receipts and ordering refresh. */
export class QueueView {
  private entries: QueueEntry[] = [];
  private selectedId?: string;
  private within = 0;
  private offset = 0;
  private visible = 1;
  private body: Array<{ line: string; id?: string; within: number }> = [];
  private readonly expanded = new Set<string>();
  private readonly reasons = new Map<string, string>();
  private index?: DisplayIndex;
  constructor(private readonly root: string, private readonly workspace: string, private readonly host: QueueHost) {}
  setEntries(entries: QueueEntry[]) {
    const previous = Math.max(0, this.entries.findIndex(entry => entry.item.requestId === this.selectedId));
    this.entries = entries; this.index = undefined;
    if (!entries.some(entry => entry.item.requestId === this.selectedId)) { this.selectedId = entries[Math.min(previous, entries.length - 1)]?.item.requestId; this.within = 0; }
  }
  select(id: string) { if (this.entries.some(entry => entry.item.requestId === id)) { this.selectedId = id; this.within = 0; } }
  reason(id: string, reason: string) {
    if (!this.entries.some(entry => entry.item.requestId === id)) { this.host.feedback(`不可重新接入 · ${reason}`); return; }
    this.reasons.set(id, reason); this.select(id); this.host.changed();
  }
  get selected() { return this.entries.find(entry => entry.item.requestId === this.selectedId); }
  private label(kind: 'session' | 'run' | 'task' | 'queue-request', id: string) { this.index ??= readDisplayIndex(this.root); return this.index.label(kind, id); }
  render(width: number, height: number, esc = 'Esc 返回会话', tier: ColorTier = COLOR_TIER): string[] {
    this.body = [];
    const push = (text: string, entry: QueueEntry, fg: 'fg.body' | 'fg.muted' | 'ac.warn' = 'fg.body') => {
      const id = entry.item.requestId, first = this.body.findIndex(row => row.id === id), within = first < 0 ? 0 : this.body.length - first;
      this.body.push({ line: styledLine([{ text, fg }], width, id === this.selectedId && within === 0 ? 'bg.selected' : undefined, tier), id, within });
    };
    for (const entry of this.entries) {
      const { item, sessionId } = entry, q = this.label('queue-request', item.requestId);
      const kind = width < 60 && item.kind === 'improve' ? 'improve' : QUEUE_KIND[item.kind], status = width < 60 && item.status === 'dispatching' ? '待核对' : QUEUE_STATUS[item.status];
      const prefix = `${item.requestId === this.selectedId ? '›' : ' '} ${kind} · ${status} · 「`;
      const suffix = `」 · ${q}${width >= 60 ? ` · ${sessionId ? this.label('session', sessionId) : 's-未记录'}` : ''}${width >= 100 ? ` · ${clean(item.acceptedAt).replace('T', ' ').slice(0, 19)}` : ''}`;
      push(`${prefix}${truncateEnd(clean(queueContent(item)).split('\n')[0], Math.max(0, width - visibleWidth(prefix + suffix)))}${suffix}`, entry);
      const reason = this.reasons.get(item.requestId);
      if (reason) for (const line of wrapAuthorized(`  不可重新接入 · ${reason}`, width)) push(line, entry, 'ac.warn');
      if (this.expanded.has(item.requestId)) {
        const detail = [
          ...(isUserChosenId(item.requestId) ? [`原 id ${item.requestId}`] : []),
          `原目标：${sessionId ? this.label('session', sessionId) : '会话未记录'} · 任务 ${entry.taskNumber ?? '未记录'} · ${this.label('task', item.target.taskId)} · ${this.label('run', item.target.runId)}`,
          `工作区：${item.target.workspace}`,
          `原因：${item.reason}`,
          `全文：\n${queueContent(item)}`,
        ];
        for (const text of detail) for (const line of wrapAuthorized(text, Math.max(1, width - 2))) push(`  ${line}`, entry, 'fg.muted');
      }
    }
    if (!this.body.length) this.body.push({ line: statusEmpty('当前工作区', '未结排队请求', width, undefined, tier), within: 0 });
    const first = this.body.findIndex(row => row.id === this.selectedId), count = this.body.filter(row => row.id === this.selectedId).length;
    this.within = Math.max(0, Math.min(this.within, count - 1));
    const cursor = first < 0 ? 0 : first + this.within;
    this.visible = Math.max(1, height - 2);
    if (cursor < this.offset) this.offset = cursor;
    if (cursor >= this.offset + this.visible) this.offset = cursor - this.visible + 1;
    const frame = fixedFrame([styledLine([{ text: `◆ queue  ${truncateMiddle(clean(this.workspace), Math.max(1, width - 10))}`, fg: 'fg.primary', bold: true }], width, undefined, tier)], this.body.map(row => row.line), [hintLine(['↑↓ 选择/滚动', 'Enter 全文', 'w 撤回', 'r 重新接入', 'y 复制'], width, { esc, tier })], height, this.offset);
    this.offset = frame.offset; return frame.lines;
  }
  handleInput(data: string) {
    const entry = this.selected, id = entry?.item.requestId;
    if (!entry || !id) return;
    if (matchesKey(data, 'enter')) { if (!this.expanded.delete(id)) this.expanded.add(id); this.within = 0; }
    else if (data === 'w' && mayWrite(this.host)) this.host.withdraw(id);
    else if (data === 'r' && mayWrite(this.host)) this.host.reattach(id);
    else if (data === 'y') void this.host.copy(queueContent(entry.item)).then(result => this.host.feedback(result === true ? '已复制内容' : String(result || '复制未完成'))).catch(error => this.host.feedback(`复制失败：${clean(String(error))}`));
    else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab') || matchesKey(data, 'right') || matchesKey(data, 'left')) {
      const step = matchesKey(data, 'shift+tab') || matchesKey(data, 'left') ? -1 : 1, at = this.entries.indexOf(entry);
      this.select(this.entries[Math.max(0, Math.min(this.entries.length - 1, at + step))].item.requestId);
    } else {
      const step = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : data === 'n' ? this.visible : data === 'p' ? -this.visible : 0;
      if (step) this.move(step);
    }
    this.host.changed();
  }
  private move(delta: number) {
    const start = this.body.findIndex(row => row.id === this.selectedId), next = this.body[Math.max(0, Math.min(this.body.length - 1, start + this.within + delta))];
    if (next?.id) { this.selectedId = next.id; this.within = next.within; }
  }
  scroll(delta: number) { this.move(delta); this.host.changed(); }
  click(row: number) { const hit = this.body[this.offset + row - 1]; if (hit?.id) { this.selectedId = hit.id; this.within = hit.within; this.host.changed(); } }
}
