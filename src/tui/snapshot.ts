/**
 * 渲染快照工具：将终端屏幕行（含 ANSI 序列）解析为字符网格，并标注颜色 token。
 * golden 文件存为 JSON，供测试夹具复用。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TOKENS, type TokenName, type ColorTier } from './theme.js';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SnapshotCell {
  char: string;
  /** 前景 token 名（已识别），或裸 SGR 码（未识别），或 undefined。 */
  fg?: string;
  /** 背景 token 名（已识别），或裸 SGR 码（未识别），或 undefined。 */
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  reverse?: boolean;
}

export type SnapshotRow = SnapshotCell[];
export interface SnapshotGrid {
  width: number;
  height: number;
  tier: ColorTier;
  rows: SnapshotRow[];
}

// ─── 反查表（SGR → token） ──────────────────────────────────────────────────

function buildReverseMap(tier: ColorTier): Map<string, TokenName> {
  const m = new Map<string, TokenName>();
  for (const [name, def] of Object.entries(TOKENS) as [TokenName, typeof TOKENS[TokenName]][]) {
    if (tier === 'none') continue; // 无色档没有颜色 SGR
    if (tier === 'truecolor') {
      const hex = def.hex;
      const [r, g, b] = [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
      m.set(`38;2;${r};${g};${b}`, name);
      m.set(`48;2;${r};${g};${b}`, name);
    } else {
      // 256color
      const idx = def.c256;
      if (idx === 'drop' || idx === undefined) {
        // 用最近邻（反查时用同样方法）
        if (idx !== 'drop') {
          // nearest – build separate
        }
      } else {
        m.set(`38;5;${idx}`, name);
        m.set(`48;5;${idx}`, name);
      }
    }
  }
  return m;
}

// ─── ANSI SGR 解析 ─────────────────────────────────────────────────────────────

interface SgrState {
  fg?: string;   // SGR code like "38;2;r;g;b" or "38;5;n"
  bg?: string;
  bold: boolean;
  dim: boolean;
  reverse: boolean;
}

function parseSgrCodes(params: string): Partial<SgrState> & { reset?: boolean } {
  const codes = params.split(';').filter(Boolean);
  const result: Partial<SgrState> & { reset?: boolean } = {};

  let i = 0;
  while (i < codes.length) {
    const code = parseInt(codes[i], 10);
    if (isNaN(code) || codes[i] === '') { i++; continue; }
    switch (code) {
      case 0: result.reset = true; break;
      case 1: result.bold = true; break;
      case 2: result.dim = true; break;
      case 7: result.reverse = true; break;
      case 22: result.bold = false; result.dim = false; break;
      case 27: result.reverse = false; break;
      case 39: result.fg = undefined; break;
      case 49: result.bg = undefined; break;
      case 38:
        if (codes[i+1] === '2' && i+4 < codes.length) {
          result.fg = `38;2;${codes[i+2]};${codes[i+3]};${codes[i+4]}`;
          i += 4;
        } else if (codes[i+1] === '5' && i+2 < codes.length) {
          result.fg = `38;5;${codes[i+2]}`;
          i += 2;
        }
        break;
      case 48:
        if (codes[i+1] === '2' && i+4 < codes.length) {
          result.bg = `48;2;${codes[i+2]};${codes[i+3]};${codes[i+4]}`;
          i += 4;
        } else if (codes[i+1] === '5' && i+2 < codes.length) {
          result.bg = `48;5;${codes[i+2]}`;
          i += 2;
        }
        break;
      default:
        // 30-37: basic fg; 40-47: basic bg (not used by our theme, ignore)
        break;
    }
    i++;
  }
  return result;
}

// ─── 核心解析 ──────────────────────────────────────────────────────────────────

/**
 * 将 getScreenLines() 返回的 ANSI 行数组解析为字符网格，并标注颜色 token。
 */
export function captureSnapshot(lines: string[], width: number, height: number, tier: ColorTier): SnapshotGrid {
  const revMap = buildReverseMap(tier);
  const rows: SnapshotRow[] = [];

  const lookupToken = (sgrCode: string | undefined): string | undefined => {
    if (!sgrCode) return undefined;
    return revMap.get(sgrCode) ?? sgrCode;
  };

  for (let row = 0; row < height; row++) {
    const line = lines[row] ?? '';
    const cells: SnapshotCell[] = [];
    let state: SgrState = { bold: false, dim: false, reverse: false };
    let col = 0;

    // Parse the line character by character, handling ANSI escape sequences
    let pos = 0;
    while (pos < line.length) {
      if (line[pos] === '\x1b' && line[pos+1] === '[') {
        // Find end of escape sequence (ends at letter)
        let end = pos + 2;
        while (end < line.length && !/[A-Za-z]/.test(line[end])) end++;
        const cmd = line[end];
        const params = line.slice(pos+2, end);
        if (cmd === 'm') {
          const parsed = parseSgrCodes(params);
          if (parsed.reset) {
            state = { bold: false, dim: false, reverse: false };
          } else {
            if (parsed.bold !== undefined) state.bold = parsed.bold;
            if (parsed.dim !== undefined) state.dim = parsed.dim;
            if (parsed.reverse !== undefined) state.reverse = parsed.reverse;
            if ('fg' in parsed) state.fg = parsed.fg;
            if ('bg' in parsed) state.bg = parsed.bg;
          }
        }
        // Skip other escape sequences (cursor movement, etc.)
        pos = end + 1;
      } else if (line[pos] === '\x1b') {
        // Other ESC sequence – skip
        pos++;
        if (pos < line.length && line[pos] === '[') {
          while (pos < line.length && !/[A-Za-z]/.test(line[pos])) pos++;
          pos++;
        }
      } else {
        // Regular character
        const char = line[pos];
        if (col < width) {
          cells.push({
            char,
            fg: lookupToken(state.fg),
            bg: lookupToken(state.bg),
            bold: state.bold || undefined,
            dim: state.dim || undefined,
            reverse: state.reverse || undefined,
          });
          col++;
        }
        pos++;
      }
    }

    // Pad to width
    while (cells.length < width) cells.push({ char: ' ' });

    rows.push(cells);
  }

  return { width, height, tier, rows };
}

// ─── Golden 比较 ───────────────────────────────────────────────────────────────

/** golden 文件格式（宽松：只比对 char 和关键颜色属性）。 */
export interface GoldenFile {
  width: number;
  height: number;
  tier: ColorTier;
  rows: SnapshotRow[];
}

/** 保存 golden 文件（JSON 格式）。 */
export function saveGolden(grid: SnapshotGrid, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(grid, null, 2), 'utf8');
}

/**
 * 将 grid 与 golden 文件比对；不一致时抛出包含差异的 Error。
 * 如果 golden 文件不存在，保存当前 grid 为 golden 并直接通过（初始化）。
 */
export function assertMatchesGolden(grid: SnapshotGrid, filePath: string): void {
  if (!existsSync(filePath)) {
    saveGolden(grid, filePath);
    return;
  }
  const golden: GoldenFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const diffs: string[] = [];

  if (golden.width !== grid.width) diffs.push(`width: golden=${golden.width} actual=${grid.width}`);
  if (golden.height !== grid.height) diffs.push(`height: golden=${golden.height} actual=${grid.height}`);
  if (golden.tier !== grid.tier) diffs.push(`tier: golden=${golden.tier} actual=${grid.tier}`);

  const maxRows = Math.max(golden.rows.length, grid.rows.length);
  for (let r = 0; r < maxRows && diffs.length < 20; r++) {
    const goldenRow = golden.rows[r];
    const actualRow = grid.rows[r];
    if (!goldenRow || !actualRow) {
      diffs.push(`row ${r}: missing (golden=${!!goldenRow} actual=${!!actualRow})`);
      continue;
    }
    const maxCols = Math.max(goldenRow.length, actualRow.length);
    for (let c = 0; c < maxCols && diffs.length < 20; c++) {
      const gc = goldenRow[c];
      const ac = actualRow[c];
      if (!gc || !ac) { diffs.push(`[${r},${c}]: missing cell`); continue; }
      if (gc.char !== ac.char) diffs.push(`[${r},${c}] char: golden=${JSON.stringify(gc.char)} actual=${JSON.stringify(ac.char)}`);
      if (gc.fg !== ac.fg) diffs.push(`[${r},${c}] fg: golden=${gc.fg} actual=${ac.fg}`);
      if (gc.bg !== ac.bg) diffs.push(`[${r},${c}] bg: golden=${gc.bg} actual=${ac.bg}`);
      if (!!gc.bold !== !!ac.bold) diffs.push(`[${r},${c}] bold: golden=${gc.bold} actual=${ac.bold}`);
    }
  }

  if (diffs.length > 0) {
    throw new Error(`Snapshot mismatch (${diffs.length} diff${diffs.length===1?'':'s'}):\n${diffs.join('\n')}`);
  }
}

// ─── 辅助：从 grid 提取纯文本（供测试断言） ─────────────────────────────────

/** 从 grid 中提取纯文本（不含颜色信息），每行一个字符串。 */
export function snapshotText(grid: SnapshotGrid): string[] {
  return grid.rows.map(row => row.map(c => c.char).join(''));
}

/** 检查 grid 中是否包含某个字符（状态字形断言用）。 */
export function snapshotContains(grid: SnapshotGrid, char: string): boolean {
  return grid.rows.some(row => row.some(c => c.char === char));
}

/** 检查原始 ANSI 行数组中是否出现指定 SGR 模式（如 38;2 / 48;2）。 */
export function linesContainSgr(lines: string[], pattern: RegExp): boolean {
  return lines.some(line => pattern.test(line));
}
