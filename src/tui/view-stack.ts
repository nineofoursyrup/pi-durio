/**
 * 全屏视图的共用基础（issue #68；规格 T1、T6、U12）。
 *
 * - viewKey：全屏视图层的全局键规则（Esc 逐层返回、Ctrl+C 只停本视图操作、其余全局键不起作用）
 * - hintLine：底栏键位提示与即时反馈（Esc 始终保留在最右边）
 * - ConfirmDialog：居中确认框 / 选择框（单选 ◉/○ 数字键，多选 [✓]/[ ] 空格）
 * - statusError / statusEmpty / LoadingState：通用状态写法
 * - widthTier / truncateMiddle / truncateEnd / wrapAuthorized / fixedFrame：窄终端与矮终端
 * - SPACER / sideMargin / topMargin / bottomMargin / inset / rule / footerLines：U10 间距（视觉修正 r1）
 * - PresetFilter：预设选项筛选层（1e 与历史视图复用）
 */

import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, stripTerminalSequences } from '@earendil-works/pi-tui';
import {
  styledLine, fgSgr, bgSgr, resetSgr, dimForOverlay,
  GLYPHS, spinnerFrame, SPINNER_FRAMES, SPINNER_INTERVAL_MS,
  type ColorTier, COLOR_TIER, type TextSegment, type TokenName,
} from './theme.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 显示前去掉控制字符与终端序列（原因码、路径、用户内容都经过这里）。 */
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** A filesystem/API error becomes a stable, sanitized status code at the UI boundary. */
export function errorCode(error: unknown, fallback: string): string {
  return clean((error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error)).split(/[\s:]/)[0]) || fallback;
}

/** Public pi-tui single-line editing, with the product's existing clear shortcut and input bounds. */
export class SingleLineInput extends Input {
  constructor(value = '', private readonly maxLength = Infinity, placeholder = '') { super({ prompt: '', placeholder }); this.setValue(value); super.handleInput('\x1b[F'); }
  override setValue(value: string): void { super.setValue(clean(value).replace(/[\r\n\t]/g, ' ').slice(0, this.maxLength).replace(/[\uD800-\uDBFF]$/u, '')); }
  override handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+a')) { this.setValue(''); return; }
    super.handleInput(data);
    const value = this.getValue(), bounded = clean(value).replace(/[\r\n\t]/g, ' ').slice(0, this.maxLength).replace(/[\uD800-\uDBFF]$/u, '');
    if (bounded !== value) super.setValue(bounded);
  }
}

// ─── 全屏视图的键规则（T6） ──────────────────────────────────────────────────

/**
 * 全屏视图层的全局键：
 * - `back`：Esc，返回上一层，在最上层时回到会话
 * - `stop`：Ctrl+C，只停止本视图中正在进行的操作；没有时不起作用，也不传给会话屏
 * - `redraw`：Ctrl+L，重绘并重新测量字宽
 * - `inert`：Ctrl+D、Ctrl+O、Ctrl+T、Ctrl+R、`?`，在视图内不起作用
 * - undefined：交给视图自己的局部键
 *
 * 例外（历史正文层的 Ctrl+O、视图内的文字输入）由视图在调用前自行处理。
 */
export type ViewKeyAction = 'back' | 'stop' | 'redraw' | 'inert';
export function viewKey(data: string): ViewKeyAction | undefined {
  if (matchesKey(data, 'escape')) return 'back';
  if (matchesKey(data, 'ctrl+c')) return 'stop';
  if (matchesKey(data, 'ctrl+l')) return 'redraw';
  if (data === '?' || matchesKey(data, 'ctrl+d') || matchesKey(data, 'ctrl+o') || matchesKey(data, 'ctrl+t') || matchesKey(data, 'ctrl+r')) return 'inert';
  return undefined;
}

/** 底栏的 Esc 文案：最上层“返回会话”，下层“返回上层”（#42 第 4 节）。 */
export function escHint(depth: number): string {
  return depth <= 1 ? 'Esc 返回会话' : 'Esc 返回上层';
}

// ─── 底栏键位提示与即时反馈 ──────────────────────────────────────────────────

/** 键名可以连续出现（Ctrl+X Enter），说明与分隔符仍为 fg.label。 */
export function hintSegments(text: string): TextSegment[] {
  return text.split(' · ').flatMap((item, index) => {
    const key = item.match(/^(?:(?:Ctrl\+[A-Za-z]|Shift\+(?:Tab|Enter)|PgUp(?:\/(?:Pg)?Dn)?|PgDn|Backspace|空格|Enter|Tab|Esc|[↑↓←→]+|[0-9]+(?:[–/-][0-9]+)*|[A-Za-z?/@](?:\/[A-Za-z])?)(?:\s+|$))+/)?.[0] ?? item.match(/^[↑↓←→]+/)?.[0] ?? '';
    return [...(index ? [{ text: ' · ', fg: 'fg.label' as const }] : []),
      ...(key ? [{ text: key.trimEnd(), fg: 'fg.body' as const }] : []),
      { text: item.slice(key.trimEnd().length), fg: 'fg.label' as const }];
  });
}

/**
 * 底栏键位提示行。
 *
 * - 有 `esc` 时（全屏视图），Esc 固定在最右边；宽度不够时从 Esc 左边一项起往左去掉。
 * - 没有 `esc` 时（会话屏），从右往左去掉；`keepLast` 指定的一项最后去掉（如空闲时的 `? 帮助`）。
 * - `feedback`：按键的即时反馈，临时替换提示项（保留 Esc），放不下时在末尾截断。
 */
export function hintLine(
  items: string[],
  width: number,
  opts: { esc?: string; feedback?: string; keepLast?: string; tier?: ColorTier } = {},
): string {
  const tier = opts.tier ?? COLOR_TIER;
  const sep = ' · ';
  const escPart = opts.esc ? `${sep}${opts.esc}` : '';
  const room = Math.max(0, width - visibleWidth(escPart));
  let text: string;
  if (opts.feedback !== undefined) text = truncateEnd(clean(opts.feedback), room);
  else {
    const kept = [...items];
    while (kept.length && visibleWidth(kept.join(sep)) > room) {
      // 从最靠近 Esc（最右）的一项开始去掉；keepLast 只在只剩它时才去掉。
      let index = kept.length - 1;
      if (kept[index] === opts.keepLast && kept.length > 1) index--;
      kept.splice(index, 1);
    }
    text = kept.join(sep);
  }
  const segments: TextSegment[] = opts.feedback !== undefined ? [{ text, fg: 'fg.body' }] : hintSegments(text);
  if (opts.esc) segments.push(...(text ? [{ text: sep, fg: 'fg.label' as const }] : []), ...hintSegments(opts.esc));
  return styledLine(segments, width, undefined, tier);
}

/**
 * 底栏：左侧状态或用量，右侧键位提示（设计稿为一行）。
 * 两边连同至少 2 列间隔放得下时合成一行，否则退回两行：左侧一行，键位提示按 hintLine 另起一行，信息不丢。
 */
export function footerLines(
  left: TextSegment[],
  items: string[],
  width: number,
  opts: { esc?: string; feedback?: string; keepLast?: string; tier?: ColorTier } = {},
): string[] {
  const tier = opts.tier ?? COLOR_TIER;
  const right = [...(opts.feedback !== undefined ? [clean(opts.feedback)] : items), ...(opts.esc ? [opts.esc] : [])].join(' · ');
  const leftWidth = left.reduce((sum, s) => sum + visibleWidth(s.text), 0);
  if (!left.length) return [hintLine(items, width, opts)];
  if (leftWidth + 2 + visibleWidth(right) <= width) {
    const gap = ' '.repeat(width - leftWidth - visibleWidth(right));
    const hints: TextSegment[] = opts.feedback !== undefined
      ? [{ text: clean(opts.feedback), fg: 'fg.body' }, ...(opts.esc ? [{ text: ' · ', fg: 'fg.label' as const }, ...hintSegments(opts.esc)] : [])]
      : hintSegments(right);
    return [styledLine([...left, { text: gap }, ...hints], width, undefined, tier)];
  }
  return [styledLine(left, width, undefined, tier), hintLine(items, width, opts)];
}

// ─── 间距（U10，视觉修正 r1） ────────────────────────────────────────────────

/**
 * 可收起的空行。固定版式的屏在区块之间放它：放得下时画成空行，放不下时最先去掉。
 * 会滚动的正文（1b 主区等）用普通空行，不用它。
 */
export const SPACER = '\u0000spacer';
/** 放得下时把 SPACER 换成空行，否则全部去掉，整屏退回紧凑排布。 */
export function settleSpacers(lines: string[], fits: boolean): string[] {
  return fits ? lines.map(line => line === SPACER ? '' : line) : lines.filter(line => line !== SPACER);
}
/** 左右边距：留边距后内宽仍不小于 100 列时各留 2 列；更窄时不留，内容不为边距让位。 */
export function sideMargin(width: number): number {
  return widthTier(width - 4) === 'wide' ? 2 : 0;
}
/** 底部留白：不矮于 30 行时留 1 行；更矮时不留，内容不为留白让位。 */
export function bottomMargin(rows: number): number {
  return rows >= 30 ? 1 : 0;
}
/** 顶部留白与底部同条件；先于视图的内容收起项消失。 */
export function topMargin(rows: number): number { return bottomMargin(rows); }
/** 给按内宽（width − 2 × margin）渲染的行加左右边距；短行与空串用 `bg.base` 补满。 */
export function inset(lines: string[], width: number, margin: number, tier: ColorTier = COLOR_TIER): string[] {
  const pad = margin ? styledLine([], margin, undefined, tier) : '';
  return lines.map(line => {
    const fill = width - 2 * margin - visibleWidth(line);
    return pad + line + (fill > 0 ? styledLine([], fill, undefined, tier) : '') + pad;
  });
}
/** 圆角整框（U10）：`lines` 按 width − 4 渲染，框线用 `border.input`，短行用 `bg.base` 补满。 */
export function frameBox(lines: string[], width: number, tier: ColorTier = COLOR_TIER): string[] {
  const inner = width - 4, border = (text: string) => styledLine([{ text, fg: 'border.input' }], visibleWidth(text), undefined, tier);
  return [border(`╭${'─'.repeat(width - 2)}╮`),
    ...lines.map(line => border('│ ') + line + (visibleWidth(line) < inner ? styledLine([], inner - visibleWidth(line), undefined, tier) : '') + border(' │')),
    border(`╰${'─'.repeat(width - 2)}╯`)];
}
/** 输入框与只读等价命令：内容按 width − 2 渲染，左右各一列闭合框线。 */
export function inputBox(lines: string[], width: number, tier: ColorTier = COLOR_TIER, token: TokenName = 'border.input'): string[] {
  const border = (text: string) => styledLine([{ text, fg: token }], visibleWidth(text), undefined, tier);
  return [border(`╭${'─'.repeat(Math.max(0, width - 2))}╮`),
    ...lines.map(line => border('│') + line + styledLine([], Math.max(0, width - 2 - visibleWidth(line)), undefined, tier) + border('│')),
    border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)];
}
/** 按显示列截取 [from, to)，跨边界的宽字符换成空格，不足补空格。 */
function sliceColumns(text: string, from: number, to: number): string {
  let out = '', column = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = visibleWidth(segment), end = column + w;
    if (end <= from) { column = end; continue; }
    if (column >= to) break;
    out += column < from || end > to ? ' '.repeat(Math.min(end, to) - Math.max(column, from)) : segment;
    column = end;
  }
  return out + ' '.repeat(Math.max(0, to - Math.max(column, from)));
}
/** 浮层（U10）：底层改用 `fg.gutter` / `bg.base`，框水平、垂直居中；返回行数同底层。 */
export function composeOverlay(base: string[], box: string[], width: number, tier: ColorTier = COLOR_TIER): string[] {
  const boxWidth = Math.max(0, ...box.map(line => visibleWidth(line)));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2)), top = Math.max(0, Math.floor((base.length - box.length) / 2));
  const dim = (text: string) => dimForOverlay(text, tier);
  return base.map((line, row) => {
    const plain = stripTerminalSequences(line), over = box[row - top];
    return over === undefined ? dim(sliceColumns(plain, 0, width)) : dim(sliceColumns(plain, 0, left)) + over + dim(sliceColumns(plain, left + boxWidth, width));
  });
}
/** 区块分隔线：整行 `─`，默认 `line.subtle`；框内分隔用 `line.inner`。 */
export function rule(width: number, token: TokenName = 'line.subtle', tier: ColorTier = COLOR_TIER): string {
  return styledLine([{ text: '─'.repeat(Math.max(0, width)), fg: token }], width, undefined, tier);
}

// ─── 窄终端（U12） ───────────────────────────────────────────────────────────

/** 两档断点：≥100 wide，60–99 medium，<60 narrow。 */
export type WidthTier = 'wide' | 'medium' | 'narrow';
export function widthTier(width: number): WidthTier {
  return width >= 100 ? 'wide' : width >= 60 ? 'medium' : 'narrow';
}

/** 末尾加 `…` 截断。 */
export function truncateEnd(text: string, width: number): string {
  if (width <= 0) return '';
  return truncateToWidth(text, width, '…');
}

/** 按宽度裁切一组分段：超出处加 `…`，不足处补空格。 */
export function fitSegments(segments: TextSegment[], width: number): TextSegment[] {
  const out: TextSegment[] = []; let used = 0;
  for (const segment of segments) {
    if (!segment.text) continue;
    const w = visibleWidth(segment.text);
    if (used + w > width) {
      // 宽字符处截断可能少一格；按实际宽度补齐，决不超出。
      let room = width - used, text = truncateEnd(segment.text, room);
      while (room > 0 && visibleWidth(text) > width - used) text = truncateEnd(segment.text, --room);
      out.push({ ...segment, text }); used += visibleWidth(text); break;
    }
    out.push(segment); used += w;
  }
  if (used < width) out.push({ text: ' '.repeat(width - used) });
  return out;
}
/** 路径从中间省略：保留开头与结尾，中间写 `…`。 */
export function truncateMiddle(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? '…' : '';
  const chars = Array.from(text);
  const budget = width - 1, headBudget = Math.ceil(budget / 2), tailBudget = budget - headBudget;
  let head = '', used = 0;
  for (const char of chars) { const w = visibleWidth(char); if (used + w > headBudget) break; head += char; used += w; }
  let tail = ''; used = 0;
  for (let i = chars.length - 1; i >= 0; i--) { const w = visibleWidth(chars[i]); if (used + w > tailBudget) break; tail = chars[i] + tail; used += w; }
  return `${head}…${tail}`;
}

/** 授权内容（候选卡片、执行计划、确认框的影响与费用）：只换行、不截断。 */
export function wrapAuthorized(text: string, width: number): string[] {
  return clean(text.replace(/\r/g, '')).split('\n').flatMap(line => line ? wrapTextWithAnsi(line, Math.max(1, width)) : ['']);
}

/**
 * 高度不够时头部与底栏固定、主体滚动。
 * 返回恰好 `height` 行（主体不足时补空串）和夹紧后的主体偏移；连头部与底栏都放不下时先保留底栏。
 * 三段里的 SPACER 在整屏放得下时画成空行，放不下时先全部去掉（U10）。
 */
export function fixedFrame(header: string[], body: string[], footer: string[], height: number, offset: number): { lines: string[]; offset: number } {
  const fits = header.length + body.length + footer.length <= height;
  [header, body, footer] = [header, body, footer].map(part => settleSpacers(part, fits));
  const foot = footer.slice(Math.max(0, footer.length - height));
  const head = header.slice(0, Math.max(0, height - foot.length));
  const bodyHeight = Math.max(0, height - head.length - foot.length);
  const clamped = Math.max(0, Math.min(offset, body.length - bodyHeight));
  const visible = body.slice(clamped, clamped + bodyHeight);
  while (visible.length < bodyHeight) visible.push('');
  return { lines: [...head, ...visible, ...foot], offset: clamped };
}

// ─── 通用状态（U12） ─────────────────────────────────────────────────────────

/**
 * 错误：`✗ <一句中文> · <原因码>`，下一行写可以做什么。
 * 原因码保留原文（便于 agent 检索），显示前去掉控制字符。
 */
export function statusError(message: string, code: string, action: string, width: number, tier: ColorTier = COLOR_TIER): string[] {
  return [
    styledLine([
      { text: `${GLYPHS.err} `, fg: 'ac.err' },
      { text: `${clean(message)} · `, fg: 'fg.body' },
      { text: clean(code), fg: 'fg.muted' },
    ], width, undefined, tier),
    styledLine([{ text: `  ${clean(action)}`, fg: 'fg.label' }], width, undefined, tier),
  ];
}

/** 空：`在 <范围> 内没有 <什么>[ · <入口>]`，fg.muted 一行；不写 0 或 N/A。 */
export function statusEmpty(range: string, what: string, width: number, entry?: string, tier: ColorTier = COLOR_TIER): string {
  return styledLine([{ text: `在 ${clean(range)} 内没有 ${clean(what)}${entry ? ` · ${clean(entry)}` : ''}`, fg: 'fg.muted' }], width, undefined, tier);
}

/** 加载态出现前的延迟。 */
export const LOADING_DELAY_MS = 200;

/**
 * 异步操作的加载态：超过 200ms 才显示 `⠋ <动作>中 · <对象>`；期间 Esc 照常返回并丢弃结果。
 *
 * ```ts
 * const loading = new LoadingState('统计', '数据根', () => tui.requestRender());
 * const value = await loading.track(storageUsage(root));   // Esc 时 loading.cancel() → value 为 undefined
 * if (value !== undefined) apply(value);
 * // 渲染：if (loading.isShowing) lines.push(loading.renderLine(width));
 * ```
 */
export class LoadingState {
  private showing = false;
  private cancelled = false;
  private frame = 0;
  private delay?: ReturnType<typeof setTimeout>;
  private spin?: ReturnType<typeof setInterval>;

  constructor(
    private readonly action: string,
    private readonly subject: string | undefined,
    private readonly changed: () => void,
    delayMs = LOADING_DELAY_MS,
  ) {
    this.delay = setTimeout(() => {
      this.delay = undefined;
      this.showing = true; this.changed();
      this.spin = setInterval(() => { this.frame = (this.frame + 1) % SPINNER_FRAMES.length; this.changed(); }, SPINNER_INTERVAL_MS);
    }, delayMs);
  }

  get isShowing(): boolean { return this.showing; }
  get isCancelled(): boolean { return this.cancelled; }

  /** 操作结束：停止计时，不再显示。返回 false 表示已取消，结果应丢弃。 */
  complete(): boolean {
    if (this.delay) { clearTimeout(this.delay); this.delay = undefined; }
    if (this.spin) { clearInterval(this.spin); this.spin = undefined; }
    this.showing = false;
    return !this.cancelled;
  }

  /** Esc 返回：丢弃之后到达的结果。 */
  cancel(): void { this.cancelled = true; this.complete(); }

  /** 等待操作；已取消时得到 undefined。未取消时拒绝照常抛出，已取消时吞掉。 */
  async track<T>(work: Promise<T>): Promise<T | undefined> {
    try { const value = await work; return this.complete() ? value : undefined; }
    catch (error) { if (this.complete()) throw error; return undefined; }
  }

  renderLine(width: number, tier: ColorTier = COLOR_TIER): string {
    return styledLine([
      { text: `${spinnerFrame(this.frame, tier)} ` },
      { text: `${this.action}中${this.subject ? ` · ${clean(this.subject)}` : ''}`, fg: 'fg.body' },
    ], width, undefined, tier);
  }
}

// ─── 确认框与选择框（U12） ───────────────────────────────────────────────────

export interface ConfirmOption { label: string; /** 不可选时的原因；渲染为 `不可选 · <原因>`，↑↓ 跳过 */ disabled?: string }

export interface ConfirmConfig {
  /** 粗体标题（首行） */
  title: string;
  /** 末行 `Enter <action> · Esc 取消` */
  action: string;
  /** 正文：高度不够时在框内滚动（逐行截断） */
  body?: string[];
  /** Custom wrapped body rows; the shared dialog owns frame, clipping and cursor visibility. */
  bodyRows?: (inner: number) => Array<{ segments: TextSegment[]; cursor?: boolean }>;
  /** Custom footer, wrapped by the shared frame. Receives the current confirmation blocker. */
  footer?: (reason: string | undefined) => TextSegment[];
  /** Authorization-bearing body text must wrap completely, including after a resize. */
  wrapBody?: boolean;
  /** 单选（数字键）或多选（空格切换、↑↓ 换行）；排在正文之后，与正文一起滚动 */
  choice?: { mode: 'single' | 'multi'; options: ConfirmOption[]; selected?: number[] };
  /** 影响与费用行：固定显示、不随框内滚动，只换行不截断 */
  fixed?: string[];
  /** Trusted component rows, kept in the fixed area with their cursor styling. */
  fixedRows?: (inner: number) => string[];
  /** Enter 不可用的原因（冲突、截止时间已过、尚未选择…）；末行写明并灰显 Enter */
  disabled?: string | ((selected: number[]) => string | undefined);
}

export type ConfirmResult =
  | { type: 'confirm'; selected: number[] }
  | { type: 'cancel' }
  | { type: 'handled' }
  | { type: 'noop' };

/** 连固定行都放不下时 Enter 不可用的原因。 */
export const TOO_SMALL_TO_CONFIRM = '窗口过小，无法确认';

/**
 * 居中浮层的确认框：圆角整框，宽度取 min(终端宽 − 4, 88)。
 * 框内自上而下：粗体标题、正文与选项（滚动区）、固定行（影响与费用）、末行。
 * `render(columns, rows)` 返回整框各行，高度不超过 rows；宿主用居中浮层显示（见 app.ts openConfirm）。
 */
export class ConfirmDialog {
  private scroll = 0;
  private cursor = 0;
  private chosen: Set<number>;
  private followCursor = true;
  private tooSmall = false;

  constructor(private readonly config: ConfirmConfig) {
    this.chosen = new Set(config.choice?.selected ?? []);
    this.cursor = Math.max(0, config.choice?.options.findIndex(option => !option.disabled) ?? 0);
  }

  update(config: Partial<ConfirmConfig>): void { Object.assign(this.config, config); }

  static width(columns: number): number { return Math.max(1, Math.min(columns - 4, 88)); }

  get selected(): number[] { return [...this.chosen].sort((a, b) => a - b); }

  /** 当前 Enter 不可用的原因；可用时 undefined。以最近一次 render 的尺寸判断“窗口过小”。 */
  get disabledReason(): string | undefined {
    if (this.tooSmall) return TOO_SMALL_TO_CONFIRM;
    const disabled = this.config.disabled;
    return typeof disabled === 'function' ? disabled(this.selected) : disabled;
  }

  scrollBy(delta: number): void { this.scroll = Math.max(0, this.scroll + delta); this.followCursor = false; }
  revealCursor(): void { this.followCursor = true; }

  render(columns: number, rows: number, tier: ColorTier = COLOR_TIER): string[] {
    const width = ConfirmDialog.width(columns), inner = Math.max(1, width - 4);
    const fixed = [...(this.config.fixed ?? []).flatMap(text => wrapAuthorized(text, inner)), ...(this.config.fixedRows?.(inner) ?? []).flatMap(text => wrapTextWithAnsi(text, inner))];
    // 末行放不下时换行（原因不截断，Esc 不去掉）；当前提示和“窗口过小”的提示都必须完整容纳。
    const footer = (reason: string | undefined) => wrapSegments(this.config.footer ? this.config.footer(reason) : reason
      ? [{ text: 'Enter ', fg: 'fg.gutter' }, { text: clean(reason), fg: 'fg.muted' }, { text: ' · ', fg: 'fg.label' }, ...hintSegments('Esc 取消')]
      : hintSegments(`Enter ${clean(this.config.action)} · Esc 取消`), inner);
    const disabled = this.config.disabled;
    const reason = typeof disabled === 'function' ? disabled(this.selected) : disabled;
    const chrome = 3 + Math.max(footer(TOO_SMALL_TO_CONFIRM).length, footer(reason).length); // 上框线、标题、末行、下框线
    this.tooSmall = rows < chrome + fixed.length;
    const border = (text: string) => (tier === 'none' ? '' : bgSgr('bg.block', tier) + fgSgr('border.input', tier)) + text + resetSgr();
    const row = (segments: TextSegment[], lineBg: TokenName = 'bg.block') =>
      border('│ ') + styledLine(segments.map(s => ({ bg: lineBg, ...s })), inner, lineBg, tier) + border(' │');
    const lines = [border(`╭${'─'.repeat(Math.max(0, width - 2))}╮`), row([{ text: truncateEnd(clean(this.config.title), inner), fg: 'fg.primary', bold: true }])];
    if (!this.tooSmall) {
      const scrollable = this.scrollable(inner);
      const height = Math.min(scrollable.length, rows - chrome - fixed.length);
      const at = scrollable.findIndex(line => line.cursor);
      if (this.followCursor && at >= 0 && at < this.scroll) this.scroll = at;
      if (this.followCursor && at >= 0 && at >= this.scroll + height) this.scroll = at - height + 1;
      this.scroll = Math.max(0, Math.min(this.scroll, scrollable.length - height));
      for (const line of scrollable.slice(this.scroll, this.scroll + height)) lines.push(row(line.segments, line.cursor ? 'bg.selected' : 'bg.block'));
      for (const text of fixed) lines.push(row([{ text, fg: 'fg.label' }]));
    }
    for (const segments of footer(this.disabledReason)) lines.push(row(segments));
    lines.push(border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`));
    return lines.slice(0, Math.max(0, rows));
  }

  handleInput(data: string): ConfirmResult {
    const choice = this.config.choice;
    if (matchesKey(data, 'escape')) return { type: 'cancel' };
    if (matchesKey(data, 'enter')) return this.disabledReason ? { type: 'noop' } : { type: 'confirm', selected: this.selected };
    if (choice?.mode === 'single' && /^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (!choice.options[index] || choice.options[index].disabled) return { type: 'noop' };
      this.chosen = new Set([index]); return { type: 'handled' };
    }
    if (choice?.mode === 'multi') {
      if (data === ' ') {
        if (choice.options[this.cursor]?.disabled) return { type: 'noop' };
        if (this.chosen.has(this.cursor)) this.chosen.delete(this.cursor); else this.chosen.add(this.cursor);
        return { type: 'handled' };
      }
      const step = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : 0;
      if (!step) return { type: 'noop' };
      for (let next = this.cursor + step; next >= 0 && next < choice.options.length; next += step)
        if (!choice.options[next].disabled) { this.cursor = next; break; }
      return { type: 'handled' };
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'pageUp')) { this.scrollBy(matchesKey(data, 'up') ? -1 : -3); return { type: 'handled' }; }
    if (matchesKey(data, 'down') || matchesKey(data, 'pageDown')) { this.scrollBy(matchesKey(data, 'down') ? 1 : 3); return { type: 'handled' }; }
    return { type: 'noop' };
  }

  private scrollable(inner: number): Array<{ segments: TextSegment[]; cursor?: boolean }> {
    if (this.config.bodyRows) return this.config.bodyRows(inner);
    const lines: Array<{ segments: TextSegment[]; cursor?: boolean }> = (this.config.body ?? [])
      .flatMap(text => this.config.wrapBody ? wrapAuthorized(text, inner) : clean(text.replace(/\r/g, '')).split('\n'))
      .map(text => ({ segments: [{ text: truncateEnd(text, inner), fg: 'fg.body' as TokenName }] }));
    const choice = this.config.choice;
    choice?.options.forEach((option, index) => {
      const on = this.chosen.has(index);
      const mark = choice.mode === 'single' ? `${on ? '◉' : '○'} ${index + 1} ` : `${on ? `[${GLYPHS.ok}]` : '[ ]'} `;
      const text = truncateEnd(`${mark}${clean(option.label)}${option.disabled ? ` · 不可选 · ${clean(option.disabled)}` : ''}`, inner);
      lines.push({ segments: [{ text, fg: option.disabled ? 'fg.gutter' : on ? 'fg.primary' : 'fg.body' }], cursor: choice.mode === 'multi' && index === this.cursor });
    });
    return lines;
  }
}

/** 把一串带样式的片段按显示宽度折成多行（逐字符，保留各片段样式）。 */
export function wrapSegments(segments: TextSegment[], width: number): TextSegment[][] {
  const rows: TextSegment[][] = [[]];
  let used = 0;
  for (const segment of segments) for (const char of Array.from(segment.text)) {
    const w = visibleWidth(char);
    if (used + w > width && used > 0) { rows.push([]); used = 0; if (char === ' ') continue; }
    const row = rows[rows.length - 1], last = row[row.length - 1];
    if (last && last.fg === segment.fg && last.bold === segment.bold) last.text += char; else row.push({ ...segment, text: char });
    used += w;
  }
  return rows;
}

// ─── 预设选项筛选层（U5、U13） ───────────────────────────────────────────────

export interface FilterOption {
  label: string;
  /**
   * 选中该项后按 Enter 才进入的二级输入：
   * - `input`：输入一行文字（如自定义日期）；`validate` 返回错误时不接受
   * - `list`：从列表中选一项（如项目列表）
   */
  custom?: { kind: 'input'; placeholder: string; validate?: (text: string) => string | undefined } | { kind: 'list'; items: string[] };
}
export interface FilterDimension { key: string; label: string; options: FilterOption[]; /** 默认选中项 */ selected?: number }
/** 每个维度的结果：选中项下标，以及自定义输入或列表选中的值。 */
export type FilterValues = Record<string, { option: number; value?: string }>;

/**
 * 筛选层：每个维度一行预设选项（◉/○），只有选中带 `custom` 的项并按 Enter 时才输入。
 * 键：↑↓ 换维度，←→ 或数字键选项，Enter 应用（有未填的自定义项时先进入该项输入），Esc 返回上层。
 * 输入中：文字照常输入（含 `?`），Enter 接受，Esc 放弃本次输入；列表中 ↑↓ 选、Enter 接受。
 */
export class PresetFilter {
  private row = 0;
  private values: FilterValues;
  private editing?: { key: string; input: SingleLineInput; error?: string; listIndex: number };

  constructor(private readonly dimensions: FilterDimension[], initial?: FilterValues) {
    this.values = Object.fromEntries(dimensions.map(d => [d.key, { ...(initial?.[d.key] ?? { option: d.selected ?? 0 }) }]));
  }

  /** 正在输入自定义值时为 true：宿主应把全部按键（含 `?`）交给本组件，不按 viewKey 拦截。 */
  get isEditing(): boolean { return !!this.editing; }
  get result(): FilterValues { return structuredClone(this.values); }

  handleInput(data: string): 'apply' | 'cancel' | 'handled' | 'noop' {
    if (this.editing) return this.editInput(data);
    if (matchesKey(data, 'escape')) return 'cancel';
    if (matchesKey(data, 'up')) { this.row = Math.max(0, this.row - 1); return 'handled'; }
    if (matchesKey(data, 'down') || matchesKey(data, 'tab')) { this.row = Math.min(this.dimensions.length - 1, this.row + 1); return 'handled'; }
    const dimension = this.dimensions[this.row];
    if (!dimension) return 'noop';
    const current = this.values[dimension.key];
    const pick = (option: number) => { if (option !== current.option) this.values[dimension.key] = { option }; return 'handled' as const; };
    if (matchesKey(data, 'left')) return pick(Math.max(0, current.option - 1));
    if (matchesKey(data, 'right')) return pick(Math.min(dimension.options.length - 1, current.option + 1));
    if (/^[1-9]$/.test(data) && dimension.options[Number(data) - 1]) return pick(Number(data) - 1);
    if (matchesKey(data, 'enter')) {
      const here = dimension.options[current.option]?.custom && current.value === undefined ? this.row : -1;
      const missing = here >= 0 ? here : this.dimensions.findIndex(d => d.options[this.values[d.key].option]?.custom && this.values[d.key].value === undefined);
      if (missing < 0) return 'apply';
      this.row = missing;
      const custom = this.dimensions[missing].options[this.values[this.dimensions[missing].key].option].custom!;
      this.editing = { key: this.dimensions[missing].key, input: new SingleLineInput('', Infinity, custom.kind === 'input' ? custom.placeholder : ''), listIndex: 0 };
      return 'handled';
    }
    return 'noop';
  }

  render(width: number, tier: ColorTier = COLOR_TIER): string[] {
    const lines: string[] = [];
    const indent = Math.max(...this.dimensions.map(d => visibleWidth(d.label))) + 4;
    const pad = ' '.repeat(indent);
    this.dimensions.forEach((dimension, row) => {
      const current = this.values[dimension.key], focused = row === this.row, lineBg: TokenName | undefined = focused ? 'bg.selected' : undefined;
      const head = `${focused ? '›' : ' '} ${dimension.label}`;
      let segments: TextSegment[] = [{ text: head + ' '.repeat(indent - visibleWidth(head)), fg: focused ? 'fg.primary' : 'fg.label' }];
      let used = indent;
      // 一行放不下时选项换到下一行（缩进对齐），不截断选项。
      dimension.options.forEach((option, index) => {
        const on = index === current.option;
        const part = `${on ? '◉' : '○'} ${option.label}${on && current.value !== undefined ? `：${clean(current.value)}` : ''}`;
        const gap = index && used > indent ? '  ' : '';
        if (gap && used + visibleWidth(gap + part) > width) {
          lines.push(styledLine(segments, width, lineBg, tier));
          segments = [{ text: pad }]; used = indent;
        }
        const text = (used > indent ? gap : '') + part;
        segments.push({ text, fg: on ? 'fg.primary' : 'fg.body' }); used += visibleWidth(text);
      });
      lines.push(styledLine(segments, width, lineBg, tier));
      if (this.editing?.key !== dimension.key) return;
      const editing = this.editing, custom = dimension.options[current.option].custom!;
      if (custom.kind === 'input') {
        lines.push(styledLine([{ text: pad }, { text: editing.input.render(Math.max(1, width - indent))[0], fg: 'fg.primary' }], width, undefined, tier));
        if (editing.error) lines.push(styledLine([{ text: pad }, { text: `${GLYPHS.err} ${clean(editing.error)}`, fg: 'ac.err' }], width, undefined, tier));
      } else custom.items.forEach((item, index) => lines.push(styledLine([
        { text: pad },
        { text: `${index === editing.listIndex ? '›' : ' '} ${truncateMiddle(clean(item), Math.max(1, width - indent - 2))}`, fg: index === editing.listIndex ? 'fg.primary' : 'fg.body' },
      ], width, index === editing.listIndex ? 'bg.selected' : undefined, tier)));
    });
    return lines;
  }

  /** 与 render 配套的底栏提示项（不含 Esc；Esc 由 hintLine 的 esc 参数给出）。 */
  hints(): string[] {
    if (!this.editing) return ['↑↓ 维度', '←→ 选项', 'Enter 应用'];
    const dimension = this.dimensions.find(d => d.key === this.editing!.key)!;
    return dimension.options[this.values[dimension.key].option].custom?.kind === 'list' ? ['↑↓ 选择', 'Enter 确定'] : ['Enter 确定'];
  }

  private editInput(data: string): 'handled' | 'noop' {
    const editing = this.editing!;
    const dimension = this.dimensions.find(d => d.key === editing.key)!;
    const current = this.values[editing.key];
    const custom = dimension.options[current.option].custom!;
    if (matchesKey(data, 'escape')) { this.editing = undefined; return 'handled'; }
    if (custom.kind === 'list') {
      if (matchesKey(data, 'up')) editing.listIndex = Math.max(0, editing.listIndex - 1);
      else if (matchesKey(data, 'down')) editing.listIndex = Math.min(custom.items.length - 1, editing.listIndex + 1);
      else if (matchesKey(data, 'enter') && custom.items[editing.listIndex] !== undefined) { this.values[editing.key] = { option: current.option, value: custom.items[editing.listIndex] }; this.editing = undefined; }
      else return 'noop';
      return 'handled';
    }
    if (matchesKey(data, 'enter')) {
      const text = editing.input.getValue().trim(), error = text ? custom.validate?.(text) : '不能为空';
      if (error) { editing.error = error; return 'handled'; }
      this.values[editing.key] = { option: current.option, value: text }; this.editing = undefined; return 'handled';
    }
    editing.input.handleInput(data); editing.error = undefined; return 'handled';
  }
}
