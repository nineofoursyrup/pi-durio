/** 2a 原文层（U7）：一次显示所选 span 的一项原文，顶部列出全部原文项。只读：不调用模型、不写记录、不取锁。 */
import { matchesKey, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { RAW_STATE_LABEL, type TraceRaw, type TraceSpan } from '../trace.js';
import { RawContent, type RawPage } from '../trace-raw.js';
import { COLOR_TIER, styledLine, type TextSegment } from './theme.js';
import { clean, hintLine, truncateEnd } from './view-stack.js';
import type { TraceView } from './trace.js';

/** 原文层需要宿主（app.ts）提供的：复制与即时反馈。 */
export interface TraceRawHost {
  copy(text: string): Promise<boolean | string>;
  feedback(text: string): void;
  changed(): void;
}

/**
 * 原文里的控制字符改成可见字形，不让终端解释：C0 写成 `␛`、`␍` 等控制图形，DEL 写 `␡`，C1 写 `\x9b`，
 * 双向控制符写 `<U+202E>`；制表符展开为 4 个空格，CRLF 视作换行。复制时仍是原文。
 */
export function visibleControls(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, c => c === '\x7f' ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0)))
    .replace(/[\x80-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16)}`)
    .replace(/[؜‎‏‪-‮⁦-⁩]/g, c => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** “分页查看”与 `/details` 先显示的项：有内容的 stdout、stderr，否则送模内容或错误。 */
export function outputItem(span: TraceSpan) {
  return span.raws.find(raw => (raw.label === 'stdout' || raw.label === 'stderr') && raw.bytes)?.label ?? span.raws.find(raw => raw.label === '送模内容' || raw.label === '错误')?.label;
}

const KEYS = ['Tab 切换', '↑↓ 滚动', 'n/p 翻页', 'y 复制'];

export class TraceRawView {
  private item = 0;
  private page = 0;
  private offset = 0;
  private readonly contents = new Map<string, RawContent>();
  private wrapped?: { id: string; lines: string[] };
  private bodyHeight = 1;
  /** `key`：所选 span；`item`：先显示的原文项（如“分页查看”先显示 stdout）。 */
  constructor(private readonly root: string, private readonly view: TraceView, readonly key: string, private readonly host: TraceRawHost, item?: string) {
    const raws = this.span()?.raws ?? [];
    this.item = Math.max(0, raws.findIndex(raw => raw.label === item));
  }
  private span(): TraceSpan | undefined { return this.view.trace.spans.find(span => span.key === this.key); }
  /** 进行中的 span 的原文项会随新记录增长（stdout 分块）：来源变化时重新读取。 */
  private content(raw: TraceRaw) {
    const id = `${raw.label}:${raw.state}:${raw.sources.length}`;
    let content = this.contents.get(raw.label);
    if (!content || `${content.raw.label}:${content.raw.state}:${content.raw.sources.length}` !== id) { content = new RawContent(this.root, raw); this.contents.set(raw.label, content); }
    return content;
  }
  /** 当前页；没有原文项时为 undefined。 */
  current(): { raw: TraceRaw; page: RawPage } | undefined {
    const raw = this.span()?.raws[this.item];
    if (!raw) return undefined;
    const page = this.content(raw).page(this.page);
    this.page = page.page;
    return { raw, page };
  }

  handleInput(data: string) {
    const count = this.span()?.raws.length ?? 0;
    if (matchesKey(data, 'tab') && count) this.switchItem((this.item + 1) % count);
    else if (matchesKey(data, 'shift+tab') && count) this.switchItem((this.item - 1 + count) % count);
    else if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, 'down')) this.offset++;
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - this.bodyHeight);
    else if (matchesKey(data, 'pageDown')) this.offset += this.bodyHeight;
    else if (data === 'n' || data === 'p') {
      const current = this.current();
      if (!current) return;
      const next = this.page + (data === 'n' ? 1 : -1);
      if (next < 0 || next >= current.page.pages) { this.host.feedback(next < 0 ? '已是第一页' : '已是最后一页'); return; }
      this.page = next; this.offset = 0;
    } else if (data === 'y') void this.copy();
    this.host.changed();
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); this.host.changed(); }
  private switchItem(index: number) { this.item = index; this.page = 0; this.offset = 0; }
  /** `y`：复制当前页的原文，不需确认。 */
  private async copy() {
    const current = this.current();
    if (!current || current.page.error) { this.host.feedback('当前页没有可复制的原文'); return; }
    try {
      const result = await this.host.copy(current.page.text);
      this.host.feedback(result === true ? `已复制 ${current.raw.label} 第 ${current.page.page + 1}/${current.page.pages} 页 · ${Buffer.byteLength(current.page.text)} B` : `复制失败 · ${clean(String(result))}`);
    } catch (error) { this.host.feedback(`复制失败 · ${clean(String(error))}`); }
  }

  render(width: number, height: number, esc: string): string[] {
    this.view.refresh();
    const span = this.span(), wide = width >= 100;
    const header = styledLine([{ text: '◆', fg: 'ac.info' }, { text: ' trace 原文', fg: 'fg.primary', bold: true }, { text: truncateEnd(`  run ${this.view.runLabel} · ${span ? this.view.spanName(span) : '该 span 已不在 trace 中'}`, Math.max(0, width - 11)), fg: 'fg.faint' }], width);
    const footer = hintLine(KEYS, width, { esc });
    const raws = span?.raws ?? [];
    const current = this.current();
    const tabs = this.tabs(raws, width);
    const status = current ? this.statusLine(current.raw, current.page, width) : styledLine([{ text: '这一行没有原文项', fg: 'fg.muted' }], width);
    const fixed = [header, ...tabs, status, styledLine([{ text: '─'.repeat(width), fg: 'line.subtle' }], width)];
    this.bodyHeight = Math.max(1, height - fixed.length - 1);
    // 宽度小于 100 时没有详情栏：原文层顶部先显示完整详情（#59 第 7 节）。
    const detail = !wide && span ? [...this.view.detailRows(width), styledLine([], width)] : [];
    const content = current ? this.contentLines(current.raw, current.page, width) : [];
    const body = [...detail, ...content];
    this.offset = Math.max(0, Math.min(this.offset, body.length - this.bodyHeight));
    const visible = body.slice(this.offset, this.offset + this.bodyHeight);
    while (visible.length < this.bodyHeight) visible.push(styledLine([], width));
    return [...fixed, ...visible, footer].slice(0, height);
  }

  /** 顶部的原文项列表；当前项用选中底色，无色档没有底色时写成 `[项]`。放不下时换行。 */
  private tabs(raws: TraceRaw[], width: number): string[] {
    if (!raws.length) return [];
    const rows: TextSegment[][] = [[]];
    let used = 0;
    raws.forEach((raw, i) => {
      const selected = i === this.item, name = `${raw.label}${raw.state === 'complete' && !raw.note ? '' : ' ◐'}`;
      const text = truncateEnd(selected && COLOR_TIER === 'none' ? `[${name}]` : ` ${name} `, width);
      if (used && used + 1 + visibleWidth(text) > width) { rows.push([]); used = 0; }
      if (used) { rows.at(-1)!.push({ text: ' ' }); used++; }
      rows.at(-1)!.push({ text, fg: selected ? 'fg.primary' : 'fg.label', bg: selected ? 'bg.selected' : undefined });
      used += visibleWidth(text);
    });
    return rows.map(row => styledLine(row, width));
  }
  private statusLine(raw: TraceRaw, page: RawPage, width: number) {
    const ok = page.state === 'complete';
    const parts = [RAW_STATE_LABEL[page.state], ...(raw.note ? [raw.note] : []), `第 ${page.page + 1}/${page.pages} 页`, ...(raw.bytes !== undefined ? [`共 ${raw.bytes} B`] : []), ...(page.note ? [page.note] : [])];
    return styledLine([{ text: ok && !raw.note ? '●' : '◐', fg: ok && !raw.note ? 'ac.ok' : 'ac.warn' }, { text: truncateEnd(` ${parts.join(' · ')}`, width - 1), fg: 'fg.body' }], width);
  }
  private contentLines(raw: TraceRaw, page: RawPage, width: number): string[] {
    if (page.error) return [styledLine([{ text: truncateEnd(clean(page.error), width), fg: 'fg.muted' }], width)];
    const id = `${raw.label}:${raw.sources.length}:${page.page}:${width}`;
    if (this.wrapped?.id !== id) {
      const text = visibleControls(page.text).replace(/\n$/, '');
      const lines = text ? text.split('\n').flatMap(line => line ? wrapTextWithAnsi(line, Math.max(1, width - 1)) : ['']) : [];
      this.wrapped = { id, lines: lines.length ? lines.map(line => styledLine([{ text: ' ' }, { text: line, fg: 'fg.body' }], width)) : [styledLine([{ text: '（空）', fg: 'fg.muted' }], width)] };
    }
    return this.wrapped.lines;
  }
}
