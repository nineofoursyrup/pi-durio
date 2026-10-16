import { randomUUID } from 'node:crypto';
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { previewCleanup, commitCleanup, type CleanupPlan } from '../storage.js';
import { storageGroups, type StorageGroup, type StorageTotals, type GroupedUnit } from '../storage-groups.js';
import { readDisplayIndex, type DisplayIndex } from '../display-number.js';
import { GLYPHS, styledLine, type TextSegment } from './theme.js';
import { LoadingState, clean, escHint, fixedFrame, hintLine, statusEmpty, statusError, truncateEnd, truncateMiddle, widthTier, type ConfirmConfig } from './view-stack.js';
import { mayWrite, type WriteAccess } from './write-access.js';

/** What the storage view needs from its host (app.ts): render, the busy state, feedback and the confirm box. */
export interface StorageHost extends WriteAccess {
  changed(): void;
  /** A task of this process is running: preview is not offered (E9). */
  busy(): boolean;
  /** Instant feedback in place of the key hint line (U12). */
  feedback(text: string): void;
  /** `confirm` returns the cleanup it starts. */
  confirm(config: ConfirmConfig, confirm: () => Promise<void>): void;
}
type Preview = Awaited<ReturnType<typeof previewCleanup>>;
type UnitResult = { status: 'deleted' | 'failed' | 'not-run' | 'protected'; reason?: string };

/** Preview takes at most 100 units; a larger selection is split into several cleanup operations. */
const PREVIEW_UNITS = 100;
export const DELETE_NOTE = '不可撤销 · 宿主记录保留，trace 中对应原文标‘已清理’';

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function activity(at: string) {
  const date = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Protection reason codes of the retention projection, in words; ids become display numbers. */
export function reasonText(reasons: string[], index: DisplayIndex) {
  // Reasons naming objects are merged per kind: `已冻结的排队请求 q-1、q-2`.
  const words: string[] = [], named = new Map<string, string[]>();
  const add = (text: string) => { if (!words.includes(text)) words.push(text); };
  const name = (label: string, number: string) => { const list = named.get(label) ?? []; if (!list.includes(number)) list.push(number); named.set(label, list); };
  const run = (label: string, id: string) => name(label, index.label('run', id));
  for (const reason of reasons) {
    const [code, ...rest] = reason.split(':'), arg = rest.join(':');
    if (code === 'queue') name(({ frozen: '已冻结的排队请求', pending: '待接入的排队请求', dispatching: '接入待核对的排队请求' } as Record<string, string>)[rest[0]] ?? '未结排队请求', index.label('queue-request', rest.slice(1).join(':')));
    else if (code === 'recovery-needs-decision') add('待恢复核对');
    else if (code === 'unfinished-or-unconfirmed-close') add('任务未结束或清理未确认');
    else if (code === 'fixed') add('固定证据');
    else if (code === 'fixed-dependency') add('固定证据的依赖');
    else if (code === 'fixed-decision-manifest') add('固定决定的清单');
    else if (code === 'improve-formal') add('improve 写回可回退');
    else if (code === 'improve-active-default') add('当前默认执行版本在用');
    else if (code === 'improve-version') add('improve 执行版本内容');
    else if (code === 'protected-run') run('属于受保护的任务', arg);
    else if (code === 'dependency-of') run('受保护任务的依赖', arg);
    else if (code === 'host-fact-body') add('宿主记录正文');
    else if (code === 'durable-pending-in-whole-session') add('会话中有待接入摘要或待处理提交');
    else if (code === 'session-without-host-identity') add('会话存储没有宿主记录');
    else if (code === 'unresolved-session-owner') add('会话存储的所有者未解除');
    else if (code === 'unknown-session-file') add('会话目录有未知文件');
    else if (code === 'unknown-or-empty-session-format') add('会话存储格式未知或为空');
    else if (code === 'session-unreadable') add('会话存储不可读');
    else if (code === 'unattributed-object') add('附件来源不明');
    else if (code === 'unit-not-found') add('单元已不存在');
    else add(`保护范围无法确定 · ${code}`);
  }
  for (const [label, list] of named) words.push(`${label} ${list.slice(0, 3).join('、')}${list.length > 3 ? ` 等 ${list.length} 个` : ''}`);
  return words.join('、');
}

/**
 * 存储视图（U13、E9、#60 第 5 节）：一个会话一行，空格多选，Enter 预览；预览框中 Enter 删除，各单元结果原位显示。
 * 统计、预览与删除是异步操作，期间 Esc 照常返回并丢弃结果（宿主调用 cancel）。归档、还原、迁移与取消固定只在 CLI 提供。
 */
export class StorageView {
  private root: string;
  private totals?: StorageTotals;
  private groups: StorageGroup[] = [];
  private index?: DisplayIndex;
  private cursor = 0;
  private offset = 0;
  private readonly chosen = new Set<string>();
  private readonly results = new Map<string, UnitResult>();
  private loading?: LoadingState;
  private error?: { message: string; code: string; action: string };
  /** Visible list rows in the last render; n/p page by it. */
  private page = 10;
  readonly ready: Promise<void>;

  constructor(root: string, private readonly host: StorageHost) {
    this.root = root;
    this.ready = this.refresh();
  }
  get inProgress() { return this.loading !== undefined; }
  /** Esc while loading: the result arriving later is discarded. */
  cancel() { this.loading?.cancel(); this.loading = undefined; }

  private async run<T>(action: string, subject: string, work: () => Promise<T>) {
    const loading = this.loading = new LoadingState(action, subject, () => this.host.changed());
    this.host.changed();
    try { return await loading.track(work()); }
    finally { if (this.loading === loading) this.loading = undefined; this.host.changed(); }
  }
  /** `keepRows`: after a cleanup the rows and their results stay in place; only the header totals are counted again. */
  private async refresh(keepRows = false) {
    try {
      const value = await this.run('统计', '数据根', () => storageGroups(this.root));
      if (!value) return;
      this.root = value.root; this.totals = value.totals; this.index = readDisplayIndex(this.root); this.error = undefined;
      if (!keepRows) { this.groups = value.groups; this.cursor = 0; this.offset = 0; }
    } catch (error) { this.error = { message: '存储统计失败', code: failureCode(error), action: '/storage 重新打开' }; }
  }

  /** Returns the preview started by Enter, if any (tests await it; the host does not). */
  handleInput(data: string): Promise<void> | undefined {
    if (this.loading) return;
    let started: Promise<void> | undefined;
    const last = Math.max(0, this.groups.length - 1);
    if (matchesKey(data, 'up')) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, 'down')) this.cursor = Math.min(last, this.cursor + 1);
    else if (data === 'n') this.cursor = Math.min(last, this.cursor + this.page);
    else if (data === 'p') this.cursor = Math.max(0, this.cursor - this.page);
    else if (data === ' ') {
      const key = this.groups[this.cursor]?.key;
      if (key) { if (this.chosen.has(key)) this.chosen.delete(key); else this.chosen.add(key); }
    } else if (matchesKey(data, 'enter')) started = this.preview();
    this.host.changed();
    return started;
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); this.host.changed(); }

  /** Enter: the chosen rows, or the row under the cursor when none is chosen. */
  private async preview() {
    if (!mayWrite(this.host)) return;
    const groups = this.chosen.size ? this.groups.filter(group => this.chosen.has(group.key)) : this.groups.slice(this.cursor, this.cursor + 1);
    if (!groups.length) return;
    if (this.host.busy()) { this.host.feedback('有任务运行中，结束后再清理'); return; }
    const units = [...new Set(groups.flatMap(group => group.units.map(unit => unit.id)))];
    let previews: Preview[] | undefined;
    try {
      previews = await this.run('预览', `${groups.length} 个会话`, async () => {
        const output: Preview[] = [], operation = `tui-${randomUUID()}`;
        for (let start = 0; start < units.length; start += PREVIEW_UNITS)
          output.push(await previewCleanup(this.root, { id: `${operation}-${start / PREVIEW_UNITS + 1}`, units: units.slice(start, start + PREVIEW_UNITS), reason: 'explicit TUI storage view selection' }));
        return output;
      });
    } catch (error) {
      const code = failureCode(error);
      // Preview takes the data-root writer lock; while a task holds it there is only a hint, no box (E9).
      if (code.startsWith('OWNER_')) { this.host.feedback(`写入者锁被占用 · 有任务运行中，结束后再清理 · ${code}`); return; }
      this.error = { message: '清理预览失败', code, action: 'Enter 重新预览' };
      return;
    }
    if (!previews || !mayWrite(this.host)) return;
    this.error = undefined;
    const ready = previews;
    this.host.confirm(this.previewBox(groups, ready.map(p => p.plan)), () => this.commit(ready));
  }

  /** #59 第 3 节版式：逐个单元列出可删除与受保护（附原因）；固定行写字节数、失效引用数与不可撤销说明。 */
  private previewBox(groups: StorageGroup[], plans: CleanupPlan[]): ConfirmConfig {
    const index = this.index ?? readDisplayIndex(this.root);
    const eligible = new Map(plans.flatMap(plan => plan.units.map(unit => [unit.id, unit] as const)));
    const blocked = new Map(plans.flatMap(plan => plan.blocked.map(unit => [unit.id, unit.reasons] as const)));
    const body: string[] = [], seen = new Set<string>();
    for (const group of groups) {
      body.push(this.groupTitle(group));
      for (const unit of group.units) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
        const reasons = blocked.get(unit.id);
        body.push(reasons
          ? `  ${GLYPHS.warn} 受保护 · ${unitName(unit)} · ${formatBytes(unit.bytes)} · ${reasonText(reasons, index)}`
          : `  ${GLYPHS.ok} 可删除 · ${unitName(unit)} · ${formatBytes(eligible.get(unit.id)?.bytes ?? unit.bytes)}`);
      }
    }
    const bytes = plans.reduce((n, plan) => n + plan.bytes, 0), count = eligible.size;
    // A removed durable store makes its runs' originals unavailable; a removed attachment, the facts that reference it.
    const references = [...eligible.values()].reduce((n, unit) => n + (unit.kind === 'session' ? unit.runIds.length : unit.sources.length), 0);
    return {
      title: `清理预览 · ${groups.length} 个会话`, action: '删除', body,
      fixed: [`删除 ${count} 个单元 · ${formatBytes(bytes)} · 失效引用 ${references} 处 · 受保护 ${blocked.size} 个不删除`, DELETE_NOTE],
      disabled: count ? undefined : '没有可删除的单元',
    };
  }

  private async commit(previews: Preview[]) {
    if (!mayWrite(this.host)) return;
    const pending = previews.filter(p => p.plan.units.length), count = pending.reduce((n, p) => n + p.plan.units.length, 0);
    const outcome = await this.run('删除', `${count} 个单元`, async () => {
      const results = new Map<string, UnitResult>();
      for (const p of previews) for (const unit of p.plan.blocked) results.set(unit.id, { status: 'protected' });
      for (const p of pending) {
        try {
          const done = await commitCleanup(this.root, { id: p.plan.id, identity: p.identity });
          for (const part of done.parts) results.set(part.id, part.status === 'completed' ? { status: 'deleted' } : part.status === 'failed' ? { status: 'failed', reason: part.reason ?? undefined } : { status: 'not-run' });
        } catch (error) { for (const unit of p.plan.units) results.set(unit.id, { status: 'failed', reason: failureCode(error) }); }
      }
      return results;
    });
    if (!outcome) return;
    for (const [id, result] of outcome) this.results.set(id, result);
    this.chosen.clear();
    await this.refresh(true);
  }

  private groupTitle(group: StorageGroup) {
    if (!group.session) return `未归属附件 · ${group.units.length} 个单元`;
    return `${this.index!.label('session', group.session.id)} · ${firstLine(group.session.first.input)}`;
  }
  /** `[ ] s-号 · 首任务首行 · N 个任务 · 会话存储 X + 附件 Y · 最后活动`；<100 去掉最后活动，<60 两项合成一个总量。 */
  private row(group: StorageGroup, width: number) {
    const tier = widthTier(width), mark = this.chosen.has(group.key) ? `[${GLYPHS.ok}]` : '[ ]';
    const sizes = tier === 'narrow' ? formatBytes(group.sessionBytes + group.attachmentBytes)
      : !group.session && !group.sessionBytes ? `附件 ${formatBytes(group.attachmentBytes)}`
      : `会话存储 ${formatBytes(group.sessionBytes)} + 附件 ${formatBytes(group.attachmentBytes)}`;
    let head: string, flexible: string, tail: string;
    if (group.session) {
      head = `${mark} ${this.index!.label('session', group.session.id)} · `; flexible = firstLine(group.session.first.input);
      tail = ` · ${group.session.tasks} 个任务 · ${sizes}${tier === 'wide' ? ` · ${activity(group.session.tail.at)}` : ''}`;
    } else { head = `${mark} `; flexible = '未归属附件'; tail = ` · ${group.units.length} 个单元 · ${sizes}`; }
    const room = width - visibleWidth(head) - visibleWidth(tail);
    return room >= 4 ? `${head}${truncateEnd(flexible, room)}${tail}` : truncateEnd(`${head}${flexible}${tail}`, width);
  }
  /** 删除结果原位显示：已删除 / 未删除 / 未执行逐个一行，受保护的合计一行。 */
  private resultLines(group: StorageGroup, width: number) {
    const lines: string[] = [];let kept = 0;
    for (const unit of group.units) {
      const result = this.results.get(unit.id);
      if (!result) continue;
      if (result.status === 'protected') { kept++; continue; }
      const segments: TextSegment[] = result.status === 'deleted' ? [{ text: `    ${GLYPHS.ok} `, fg: 'ac.ok' }, { text: `${unitName(unit)} · 已删除 ${formatBytes(unit.bytes)}`, fg: 'fg.body' }]
        : result.status === 'failed' ? [{ text: `    ${GLYPHS.err} `, fg: 'ac.err' }, { text: `${unitName(unit)} · 未删除 · `, fg: 'fg.body' }, { text: clean(result.reason ?? 'unknown'), fg: 'fg.muted' }]
        : [{ text: `    ${GLYPHS.idle} ${unitName(unit)} · 未执行`, fg: 'fg.muted' }];
      lines.push(styledLine(segments, width));
    }
    if (kept) lines.push(styledLine([{ text: `    ${GLYPHS.warn} `, fg: 'ac.warn' }, { text: `受保护 ${kept} 个 · 未删除`, fg: 'fg.muted' }], width));
    return lines;
  }

  render(width: number, height: number): string[] {
    const totals = this.totals, header: string[] = [];
    const brand: TextSegment[] = [{ text: '◆ ', fg: 'ac.brand' }, { text: 'storage', fg: 'fg.primary', bold: true }];
    if (totals) {
      // 头部：数据根路径（从中间省略）与总量；右侧说明宽度小于 100 时收起。
      const note = widthTier(width) === 'wide' ? '不自动过期 · 压缩不删除原文' : '', total = ` · 总量 ${formatBytes(totals.total)}`;
      const room = width - visibleWidth('◆ storage  ') - visibleWidth(total) - (note ? visibleWidth(note) + 2 : 0);
      const left = `  ${truncateMiddle(clean(this.root), Math.max(1, room))}${total}`, used = visibleWidth('◆ storage') + visibleWidth(left);
      header.push(styledLine([...brand, { text: left, fg: 'fg.body' }, ...(note ? [{ text: ' '.repeat(Math.max(2, width - used - visibleWidth(note))) }, { text: note, fg: 'fg.muted' as const }] : [])], width));
      header.push(styledLine([{ text: truncateEnd(`宿主记录 ${formatBytes(totals.host)} · 会话存储 ${formatBytes(totals.sessions)} · 附件 ${formatBytes(totals.attachments)} · 未完成清理 ${formatBytes(totals.incomplete)}`, width), fg: 'fg.label' }], width));
    } else header.push(styledLine(brand, width));
    const body: string[] = [];let cursorLine = -1;
    if (this.loading?.isShowing) body.push(this.loading.renderLine(width));
    if (this.error) body.push(...statusError(this.error.message, this.error.code, this.error.action, width));
    if (totals) {
      if (!this.groups.length) body.push(statusEmpty('当前数据根', '可清理的会话存储或附件', width));
      this.groups.forEach((group, i) => {
        if (i === this.cursor) cursorLine = body.length;
        body.push(styledLine([{ text: this.row(group, width), fg: this.chosen.has(group.key) ? 'fg.primary' : 'fg.body' }], width, i === this.cursor ? 'bg.selected' : undefined));
        body.push(...this.resultLines(group, width));
      });
    }
    const footer = [hintLine(['↑↓ 选择', '空格 多选', 'Enter 预览', 'n/p 翻页'], width, { esc: escHint(1) })];
    const bodyHeight = Math.max(0, height - header.length - footer.length);
    this.page = Math.max(1, bodyHeight - 1);
    if (cursorLine >= 0) { if (cursorLine < this.offset) this.offset = cursorLine; else if (cursorLine >= this.offset + bodyHeight) this.offset = cursorLine - bodyHeight + 1; }
    const frame = fixedFrame(header, body, footer, height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }
}

function firstLine(text: string) { return clean(text.split('\n')[0] ?? '') || '（无输入）'; }
function unitName(unit: GroupedUnit) {
  return unit.kind === 'session' ? `会话存储${unit.task ? ` · 任务 ${unit.task}` : ''}` : `附件 ${unit.id.slice('object:'.length, 'object:'.length + 8)}`;
}
function failureCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return clean(code ?? (error instanceof Error ? error.message : String(error)).split(/[\s:]/)[0]) || 'STORAGE_FAILURE';
}
