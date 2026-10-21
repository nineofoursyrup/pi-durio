/** pi-durio 视觉系统：颜色 token、色彩档位判定与 SGR 生成。 */
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';

// ─── 色彩档位 ────────────────────────────────────────────────────────────────

export type ColorTier = 'truecolor' | '256color' | 'none';

/**
 * 判定色彩档位。规则：NO_COLOR 非空 → 无色；COLORTERM 为 truecolor/24bit → 真彩色；否则 256 色。
 * 可传入自定义 env 供测试使用；生产代码用 COLOR_TIER（模块加载时判定一次）。
 */
export function detectColorTier(env: Record<string,string|undefined> = process.env): ColorTier {
  if (env['NO_COLOR']) return 'none';
  if (/^(truecolor|24bit)$/i.test(env['COLORTERM'] ?? '')) return 'truecolor';
  return '256color';
}

/** 启动时判定一次，生产代码全程使用此值。测试可用 overrideColorTierForTest。 */
export let COLOR_TIER: ColorTier = detectColorTier();
/** 仅供测试：覆盖档位（不影响 detectColorTier() 纯函数逻辑）。 */
export function overrideColorTierForTest(tier: ColorTier): void { COLOR_TIER = tier; }

// ─── 颜色 Token 表 ─────────────────────────────────────────────────────────

export type TokenName =
  | 'bg.base' | 'bg.zebra' | 'bg.block' | 'bg.selected'
  | 'bg.diffDel' | 'bg.diffAdd'
  | 'line.subtle' | 'line.inner' | 'line.track'
  | 'border.input' | 'border.off'
  | 'fg.primary' | 'fg.body' | 'fg.muted' | 'fg.label' | 'fg.faint' | 'fg.gutter'
  | 'ac.brand' | 'ac.info' | 'ac.ok' | 'ac.warn' | 'ac.err'
  | 'ac.path' | 'ac.model' | 'ac.improve' | 'ac.code';

interface TokenDef {
  hex: string;
  /** 256 色档索引；'drop' = 该档不输出颜色；undefined = 自动取最近邻。 */
  c256?: number | 'drop';
  /** 无色档下的替代属性；undefined = 不加属性，用默认前景。 */
  none?: 'dim' | 'reverse' | 'bold';
}

const TOKENS: Record<TokenName, TokenDef> = {
  'bg.base':      { hex: '#141414', c256: 233 },
  'bg.zebra':     { hex: '#1a1a1a', c256: 234 },
  'bg.block':     { hex: '#1c1c1c', c256: 235 },
  'bg.selected':  { hex: '#242424', c256: 236, none: 'reverse' },
  'bg.diffDel':   { hex: '#420e14', c256: 'drop' },
  'bg.diffAdd':   { hex: '#063806', c256: 'drop' },
  'line.subtle':  { hex: '#1f1f1f', c256: 235, none: 'dim' },
  'line.inner':   { hex: '#242424', none: 'dim' },
  'line.track':   { hex: '#2a2a2a', c256: 236, none: 'dim' },
  'border.input': { hex: '#505058' },
  'border.off':   { hex: '#323237', none: 'dim' },
  'fg.primary':   { hex: '#e1e1e1' },
  'fg.body':      { hex: '#c8c8c8' },
  'fg.muted':     { hex: '#787878' },
  'fg.label':     { hex: '#6c6c6c', none: 'dim' },
  'fg.faint':     { hex: '#585858', none: 'dim' },
  'fg.gutter':    { hex: '#414141', none: 'dim' },
  'ac.brand':     { hex: '#bb9af7' },
  'ac.info':      { hex: '#7aa2f7' },
  'ac.ok':        { hex: '#9ece6a' },
  'ac.warn':      { hex: '#e0af68' },
  'ac.err':       { hex: '#f7768e' },
  'ac.path':      { hex: '#ff9e64' },
  'ac.model':     { hex: '#1abc9c' },
  'ac.improve':   { hex: '#ffdb8d' },
  'ac.code':      { hex: '#3a95ab' },
};

// ─── 256 色最近邻表 ───────────────────────────────────────────────────────────

const PAL: [number, number, number][] = new Array(256);
{
  const lv = [0, 95, 135, 175, 215, 255];
  for (let i = 16; i < 232; i++) {
    const n = i - 16;
    PAL[i] = [lv[Math.floor(n / 36)], lv[Math.floor(n / 6) % 6], lv[n % 6]];
  }
  for (let i = 232; i < 256; i++) {
    const v = 8 + 10 * (i - 232);
    PAL[i] = [v, v, v];
  }
}
function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
function nearest256(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  let best = 16, bd = Infinity;
  for (let i = 16; i < 256; i++) {
    const [pr, pg, pb] = PAL[i];
    const d = (pr-r)**2 + (pg-g)**2 + (pb-b)**2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ─── SGR 生成 ─────────────────────────────────────────────────────────────────

const ATTR_CODES: Record<string, string> = { bold: '1', dim: '2', reverse: '7' };

/** 前景颜色 SGR 序列，含 ESC[ 和 m。无色档或 drop 返回空字符串。 */
export function fgSgr(token: TokenName, tier: ColorTier = COLOR_TIER): string {
  const def = TOKENS[token];
  if (tier === 'none') {
    return def.none ? `\x1b[${ATTR_CODES[def.none]}m` : '';
  }
  if (tier === 'truecolor') {
    const [r, g, b] = hexToRgb(def.hex);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  // 256color
  const idx = def.c256;
  if (idx === 'drop') return '';
  const n = idx !== undefined ? idx : nearest256(def.hex);
  return `\x1b[38;5;${n}m`;
}

/** 背景颜色 SGR 序列，含 ESC[ 和 m。无色档或 drop 返回空字符串。 */
export function bgSgr(token: TokenName, tier: ColorTier = COLOR_TIER): string {
  const def = TOKENS[token];
  if (tier === 'none') return ''; // 无色档不画背景
  if (def.c256 === 'drop' && tier === '256color') return '';
  if (tier === 'truecolor') {
    const [r, g, b] = hexToRgb(def.hex);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  // 256color
  const idx = def.c256;
  const n = idx !== undefined ? (idx as number) : nearest256(def.hex);
  return `\x1b[48;5;${n}m`;
}

/** 粗体 SGR（三档相同）。 */
export function boldSgr(): string { return '\x1b[1m'; }
/** dim SGR。 */
export function dimSgr(): string { return '\x1b[2m'; }
/** 重置 SGR。 */
export function resetSgr(): string { return '\x1b[0m'; }

/** Fill display columns with measured horizontal strokes; an odd remainder stays blank. */
export function horizontalLine(columns: number): string {
  const width = Math.max(0, Math.floor(columns)), stroke = Math.max(1, visibleWidth('─'));
  return '─'.repeat(Math.floor(width / stroke)) + ' '.repeat(width % stroke);
}

/** A rounded edge reserves the measured columns of both corners. */
export function boxEdge(width: number, left: string, right: string): string {
  return left + horizontalLine(width - visibleWidth(left + right)) + right;
}

// ─── 行构建 ──────────────────────────────────────────────────────────────────

export interface TextSegment {
  text: string;
  fg?: TokenName;
  bg?: TokenName;
  bold?: boolean;
  dim?: boolean;
}

/**
 * 构建一行带颜色的文本字符串，按指定档位输出 SGR，并在末尾用 lineBg 底色（或 bg.base）填满 width。
 * 无色档用 token 的属性替代底色；选中行的反显包含尾部空白。
 */
export function styledLine(
  segments: TextSegment[],
  width: number,
  lineBg?: TokenName,
  tier: ColorTier = COLOR_TIER
): string {
  const bg = lineBg ?? 'bg.base';
  const fillBg = tier !== 'none' ? bgSgr(bg, tier) : fgSgr(bg, tier);
  let out = resetSgr() + fillBg;
  let col = 0;

  for (const seg of segments) {
    if (!seg.text) continue;
    let sgr = '';
    if (tier !== 'none') {
      sgr += resetSgr();
      if (seg.bg) sgr += bgSgr(seg.bg, tier);
      else sgr += fillBg; // inherit line bg
      if (seg.fg) sgr += fgSgr(seg.fg, tier);
    } else {
      // Attributes are segment-local, including an explicit background override.
      // Reset first so dim/bold/reverse from the previous segment cannot leak.
      sgr += resetSgr() + fgSgr(seg.bg ?? bg, tier);
      if (seg.fg) sgr += fgSgr(seg.fg, tier);
    }
    if (seg.bold) sgr += boldSgr();
    if (seg.dim) sgr += dimSgr();

    // Clip text to remaining width
    const clipped = truncateToWidth(seg.text, width - col);
    const w = visibleWidth(clipped);
    if (w <= 0) continue;
    // Truncation resets SGR around its ellipsis, including in pre-truncated text.
    // Restore only this segment's background; foreground and attributes keep their existing semantics.
    const segmentBg = tier === 'none' ? '' : bgSgr(seg.bg ?? bg, tier);
    out += sgr + (segmentBg ? clipped.replaceAll(resetSgr(), resetSgr() + segmentBg) : clipped);
    col += w;
    if (col >= width) break;
  }

  // Pad remaining width with line background
  const remaining = width - col;
  if (remaining > 0) {
    out += resetSgr() + fillBg + ' '.repeat(remaining);
  }
  out += resetSgr();
  return out;
}

// ─── 弹层内容暗化（宿主实现） ─────────────────────────────────────────────────

/**
 * 在弹层打开时，底层去掉局部底色，保留 bg.base 并统一使用 fg.gutter。
 * 宿主（app.ts）负责在需要时调用此函数处理底层行。
 */
export function dimForOverlay(line: string, tier: ColorTier = COLOR_TIER): string {
  // Remove local highlights, including selected rows, while keeping the full-screen base.
  const plain = line.replace(/\x1b\[\d+(?:;\d+)*m/g, '');
  return resetSgr() + (tier === 'none' ? dimSgr() : bgSgr('bg.base', tier) + fgSgr('fg.gutter', tier)) + plain + resetSgr();
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

/** braille 10 帧 spinner（pi-tui Loader 默认帧组）。 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** spinner 帧间隔（ms）。 */
export const SPINNER_INTERVAL_MS = 80;

/** 按档位获取 spinner 帧文本（带颜色）。无色档不着色。 */
export function spinnerFrame(frame: number, tier: ColorTier = COLOR_TIER): string {
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  if (tier === 'none') return glyph;
  return fgSgr('ac.brand', tier) + glyph + resetSgr();
}

// ─── 状态字形 ─────────────────────────────────────────────────────────────────

/** 状态字形表。含义按 U10，任何档位均不省略。 */
export const GLYPHS = {
  brand:   '◆',
  prompt:  '❯',
  ok:      '✓',
  err:     '✗',
  warn:    '◈',
  aborted: '◇',
  idle:    '○',
  trunc:   '⋯',
  diff_del: '−',
  diff_add: '+',
} as const;

// ─── 输入框 / 边框颜色函数 ────────────────────────────────────────────────────

/**
 * 为 EditorTheme.borderColor 生成函数：用 border.input 着色 str。
 * 每次调用时读取当前 COLOR_TIER（不捕获旧值），确保档位覆盖后即时生效。
 */
export function makeBorderColor(token: TokenName): (str: string) => string {
  return (str: string) => {
    if (COLOR_TIER === 'none') return str; // 无色档不着色边框
    return fgSgr(token, COLOR_TIER) + str + resetSgr();
  };
}

// ─── 导出 token 表（供 snapshot 反查使用） ────────────────────────────────────
export { TOKENS };
