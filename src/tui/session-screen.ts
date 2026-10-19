/**
 * 1b 主会话的各行（U2、T1、T2、U10）：头部、前序任务行、用户/steer 块、助手正文、工具行、状态行与底栏用量。
 * 纯渲染：输入是已取得的事实，输出是按档位着色、铺满宽度的行。
 */
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { COLOR_TIER, GLYPHS, SPINNER_FRAMES, fgSgr, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { clean, truncateEnd, truncateMiddle } from './view-stack.js';
import type { ToolEntry } from './run-view.js';

const cells = (segments: TextSegment[]) => segments.reduce((sum, s) => sum + visibleWidth(s.text), 0);
/** 左右两组分段拼成一行；右侧放不下时由调用方先决定去掉。 */
function spread(left: TextSegment[], right: TextSegment[], width: number, tier: ColorTier, lineBg?: TokenName) {
  const gap = Math.max(1, width - cells(left) - cells(right));
  return styledLine([...left, ...(right.length ? [{ text: ' '.repeat(gap) }, ...right] : [])], width, lineBg, tier);
}
/** 计时：mm:ss，超过一小时为 h:mm:ss。 */
export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** 950、18.2k、1M。 */
export function tokenCount(tokens: number) {
  const [value, unit] = tokens >= 999_950 ? [tokens / 1e6, 'M'] : tokens >= 1000 ? [tokens / 1e3, 'k'] : [tokens, ''];
  return unit ? `${value.toFixed(1).replace(/\.0$/, '')}${unit}` : String(value);
}

export type RunStatus = 'completed' | 'failed' | 'aborted' | 'unknown';
/** 终态的字形与文字（U10）。 */
export function terminal(status: RunStatus): TextSegment[] {
  const [glyph, fg, text]: [string, TokenName, string] = status === 'completed' ? [GLYPHS.ok, 'ac.ok', '完成'] : status === 'failed' ? [GLYPHS.err, 'ac.err', '失败'] : status === 'aborted' ? [GLYPHS.aborted, 'fg.muted', '已中止'] : [GLYPHS.warn, 'ac.warn', '结果未知 · 需恢复核对'];
  return [{ text: glyph, fg }, { text: ` ${text}` }];
}

// ─── 头部 ──────────────────────────────────────────────────────────────────

export interface HeaderState {
  workspace: string; readOnly: boolean;
  /** 已显示号化的会话与 run；尚未受理时不写。 */
  session?: string; run?: string;
  /** 任务 N（会话链深度）与运行时的第 M 轮，或空闲时的终态。 */
  task?: number; round?: number; status?: RunStatus;
  /** 工作区取自会话记录、与当前目录不同（`resume`）。 */
  elsewhere?: boolean;
}
export function headerRight(state: HeaderState): TextSegment[] {
  const parts: TextSegment[] = [];
  if (state.readOnly) parts.push({ text: '只读', fg: 'fg.label' });
  if (state.task !== undefined) {
    parts.push({ text: `${parts.length ? ' · ' : ''}任务 ${state.task}`, fg: 'fg.faint' });
    if (state.round !== undefined) parts.push({ text: ` · 第 ${state.round} 轮`, fg: 'fg.faint' });
    else if (state.status) parts.push({ text: ' · ', fg: 'fg.faint' }, ...terminal(state.status).map(s => ({ ...s, fg: s.fg ?? 'fg.faint' as TokenName })));
  }
  return parts;
}
function headerLeft(state: HeaderState, workspace: string): TextSegment[] {
  const ids = [state.session ? `会话 ${state.session}` : '', state.run ? `run ${state.run}` : ''].filter(Boolean).join(' · ');
  return [{ text: GLYPHS.brand, fg: 'ac.brand' }, { text: ' pi-durio', fg: 'fg.primary', bold: true }, { text: '  ' }, { text: workspace, fg: 'ac.path' }, ...(state.elsewhere ? [{ text: ' · 非当前目录', fg: 'ac.warn' as TokenName }] : []), ...(ids ? [{ text: `  · ${ids}`, fg: 'fg.faint' as TokenName }] : [])];
}
/** `◆ pi-durio <工作区> · 会话 s-… · run r-…`，右侧 `任务 N · 第 M 轮`；放不下时工作区从中间省略。 */
export function headerLine(state: HeaderState, width: number, showRight: boolean, tier: ColorTier = COLOR_TIER) {
  const right = showRight ? headerRight(state) : [];
  const fixed = cells(headerLeft(state, '')) + (right.length ? cells(right) + 1 : 0);
  return spread(headerLeft(state, truncateMiddle(state.workspace, Math.max(1, width - fixed))), right, width, tier);
}
/** 头部右侧能否放下：工作区先从中间省略到至多 16 列，再看右侧。 */
export function headerFits(state: HeaderState, width: number) {
  return cells(headerLeft(state, '')) + Math.min(16, visibleWidth(state.workspace)) + cells(headerRight(state)) + 1 <= width;
}

// ─── 状态行 ────────────────────────────────────────────────────────────────

/** 状态行的后台工作：improve 分析、improve 执行、eval 批次（U2）。 */
export type Activity =
  | { kind: 'improve-analysis'; report: string }
  | { kind: 'improve-execution'; report: string; progress?: [number, number] }
  | { kind: 'eval'; plan: string; trial?: [number, number] };
export interface StatusState {
  phase: 'idle' | 'running' | 'stopping' | 'exiting'; recovery: boolean; status?: RunStatus;
  activity?: Activity; round: number; retry: boolean; elapsedMs?: number; frame: number;
}
/** 状态行左侧与右侧提示：`<字形> <状态> · 第 M 轮 · mm:ss` · `Esc 中止当前任务` 等变体。 */
export function statusParts(state: StatusState): { left: TextSegment[]; hint?: string } {
  const spin: TextSegment = { text: SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length], fg: 'ac.brand' };
  const round = state.round ? ` · 第 ${state.round} 轮` : '', time = state.elapsedMs === undefined ? '' : ` · ${clock(state.elapsedMs)}`;
  if (state.phase === 'stopping') return { left: [spin, { text: ' 中止中' }] };
  if (state.phase === 'exiting') return { left: [spin, { text: ' 退出中' }] };
  if (state.phase === 'running') {
    const activity = state.activity;
    if (activity?.kind === 'improve-analysis') return { left: [spin, { text: ` improve 分析 ${activity.report}${round}${time}` }], hint: 'Ctrl+C 停止分析' };
    if (activity?.kind === 'improve-execution') return { left: [spin, { text: ` improve 执行 ${activity.report}${activity.progress ? ` · ${activity.progress.join('/')}` : ''} · /improve 查看` }] };
    if (activity?.kind === 'eval') return { left: [spin, { text: ` eval ${activity.plan}${activity.trial ? ` · trial ${activity.trial.join('/')}` : ''} · /eval 查看` }] };
    return { left: [spin, state.retry ? { text: ' 重试', fg: 'ac.warn' } : { text: ' 运行' }, { text: `${round}${time}` }], hint: 'Esc 中止当前任务' };
  }
  if (state.recovery) return { left: [{ text: GLYPHS.warn, fg: 'ac.warn' }, { text: ' 恢复核对' }], hint: 'Ctrl+C 退出（保留可恢复工作）' };
  if (state.status) return { left: terminal(state.status) };
  return { left: [{ text: GLYPHS.idle, fg: 'fg.muted' }, { text: ' 空闲' }] };
}
export function statusLine(parts: { left: TextSegment[]; hint?: string }, width: number, showHint: boolean, tier: ColorTier = COLOR_TIER) {
  return spread(parts.left.map(s => ({ ...s, fg: s.fg ?? 'fg.body' })), showHint && parts.hint ? [{ text: parts.hint, fg: 'fg.faint' }] : [], width, tier);
}
/**
 * 宽度不够时的收起顺序（U2）：状态行先去掉右侧提示，头部再去掉右侧的“任务·轮”。
 * 头部右侧放不下时，状态行提示一并去掉，保证先后次序。
 */
export function narrowing(width: number, header: HeaderState, status: { left: TextSegment[]; hint?: string }) {
  const headerRight = headerFits(header, width);
  const statusHint = headerRight && !!status.hint && cells(status.left) + visibleWidth(status.hint) + 1 <= width;
  return { headerRight, statusHint };
}

// ─── 底栏用量 ──────────────────────────────────────────────────────────────

/** `模型 · ctx ≈… / 1M · 本会话 X tok ≈ ¥Y`；unknown/partial 用 `ac.warn`。 */
export function usageLine(model: string, context: string, scope: '本会话' | '本任务', tokens: number, cost: string, width: number, tier: ColorTier = COLOR_TIER) {
  const segments: TextSegment[] = [{ text: model, fg: 'ac.model' }, { text: ` · ${context} · ${scope} ${tokenCount(tokens)} tok`, fg: 'fg.label' }];
  segments.push({ text: ' ' });
  for (const part of cost.split(/(\+\d+ unknown|partial|unknown)/).filter(Boolean)) segments.push({ text: part, fg: /unknown|partial/.test(part) ? 'ac.warn' : 'fg.label' });
  return styledLine(segments, width, undefined, tier);
}

// ─── 主区 ──────────────────────────────────────────────────────────────────

/** 前序任务行：`会话中前 N 个任务 · /history s-… 只读查看`；分支会话写“分支自 s-X 任务 N”。 */
export function precedingText(input: { session: string; preceding: number; forkedFrom?: { session: string; number: number } }) {
  const own = input.preceding > 0 ? `会话中前 ${input.preceding} 个任务` : '';
  if (input.forkedFrom) {
    const target = own ? input.session : input.forkedFrom.session;
    return { text: [`分支自 ${input.forkedFrom.session} 任务 ${input.forkedFrom.number}`, own, `/history ${target} 只读查看`].filter(Boolean).join(' · '), command: `/history ${target}` };
  }
  return own ? { text: `${own} · /history ${input.session} 只读查看`, command: `/history ${input.session}` } : undefined;
}
export function plainLines(text: string, width: number, fg: TokenName, tier: ColorTier = COLOR_TIER) {
  return wrapTextWithAnsi(text, Math.max(1, width)).map(line => styledLine([{ text: line, fg }], width, undefined, tier));
}
/** 用户消息块：`┃` 加 `bg.block`；已接入的 steer 标 `steer`。 */
export function userLines(text: string, width: number, steer: boolean, tier: ColorTier = COLOR_TIER) {
  const label = steer ? 'steer ' : '';
  return wrapTextWithAnsi(text, Math.max(1, width - 2 - visibleWidth(label))).map((line, index) =>
    styledLine([{ text: '┃ ', fg: 'fg.muted' }, ...(steer ? [{ text: index ? ' '.repeat(label.length) : label, fg: 'ac.info' as TokenName }] : []), { text: line, fg: 'fg.primary' }], width, 'bg.block', tier));
}
/** 助手正文：只给反引号内联代码着 `ac.code`，不做完整 Markdown。 */
export function assistantLines(text: string, width: number, tier: ColorTier = COLOR_TIER) {
  const body = fgSgr('fg.body', tier), code = fgSgr('ac.code', tier);
  const styled = text.replace(/`([^`\n]+)`/g, (_match, inner: string) => `${code}${inner}${body}`);
  return wrapTextWithAnsi(`${body}${styled}`, Math.max(1, width)).map(line => styledLine([{ text: line }], width, undefined, tier));
}

/** 工具行与它下方的输出：失败输出折叠时仍显示末尾 ≤6 行与截断说明；展开时显示 diff 或 ≤40 行输出。 */
export interface ToolLines { row: string; body: string[]; paging?: string }
export function toolLines(entry: ToolEntry, width: number, expanded: boolean, now: number, frame: number, tier: ColorTier = COLOR_TIER): ToolLines {
  const glyph: TextSegment = entry.state === 'running' ? { text: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], fg: 'ac.brand' } : entry.state === 'ok' ? { text: GLYPHS.ok, fg: 'ac.ok' } : entry.state === 'unknown' ? { text: GLYPHS.warn, fg: 'ac.warn' } : { text: GLYPHS.err, fg: 'ac.err' };
  const summary: TextSegment[] = entry.state === 'running' ? [{ text: `运行中 · ${clock(now - Date.parse(entry.startedAt))}`, fg: 'fg.faint' }]
    : /^\+\d+ −\d+$/.test(entry.summary) ? entry.summary.split(' ').map((text, index) => ({ text: index ? ` ${text}` : text, fg: index ? 'ac.err' : 'ac.ok' }))
    : entry.summary.startsWith('exit ') && entry.state === 'error' ? [{ text: entry.summary.split(' · ')[0], fg: 'ac.err' }, { text: entry.summary.slice(entry.summary.split(' · ')[0].length), fg: 'fg.faint' }]
    : entry.summary ? [{ text: entry.summary, fg: 'fg.faint' }] : [];
  const fixed = 2 + visibleWidth(entry.tool) + (summary.length ? 1 + cells(summary) : 0) + (entry.args ? 1 : 0);
  const room = Math.max(1, width - fixed);
  const args = entry.argKind === 'path' ? truncateMiddle(entry.args, room) : truncateEnd(entry.args, room);
  const row = styledLine([glyph, { text: ` ${entry.tool}`, fg: 'fg.muted' }, ...(args ? [{ text: ` ${args}`, fg: (entry.argKind === 'path' ? 'ac.path' : entry.argKind === 'command' ? 'ac.warn' : 'fg.body') as TokenName }] : []), ...(summary.length ? [{ text: ' ' }, ...summary] : [])], width, undefined, tier);
  const indent = '    ', inner = Math.max(1, width - indent.length);
  const body: string[] = [];
  let shown = 0, total = 0;
  if (expanded && entry.diff?.length) {
    for (const line of entry.diff.slice(0, 40)) {
      const tone = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context';
      const text = tone === 'del' ? `−${line.slice(1)}` : line;
      body.push(styledLine([{ text: indent }, { text: truncateEnd(text, inner), fg: tone === 'add' ? 'ac.ok' : tone === 'del' ? 'ac.err' : 'fg.label', bg: tone === 'add' ? 'bg.diffAdd' : tone === 'del' ? 'bg.diffDel' : undefined }], width, undefined, tier));
    }
    shown = Math.min(40, entry.diff.length); total = entry.diff.length;
  } else if (entry.output && (expanded || entry.state === 'error')) {
    const limit = expanded ? 40 : 6, lines = entry.output.end === 'tail' ? entry.output.lines.slice(-limit) : entry.output.lines.slice(0, limit);
    for (const line of lines) body.push(styledLine([{ text: indent }, { text: truncateEnd(line, inner), fg: 'fg.muted' }], width, undefined, tier));
    shown = lines.length; total = entry.output.total;
  }
  if (entry.error) body.push(styledLine([{ text: indent }, { text: truncateEnd(clean(entry.error).replace(/\n/g, ' '), inner), fg: 'ac.err' }], width, undefined, tier));
  const paging = total > shown
    ? styledLine([{ text: indent }, { text: `显示 ${shown}/${total} 行 `, fg: 'fg.faint' }, { text: `${GLYPHS.trunc} 截断`, fg: 'ac.warn' }, { text: ` · 原文完整保存 · 分页查看 ${total - shown} 行`, fg: 'fg.faint' }], width, undefined, tier)
    : undefined;
  return { row, body, paging };
}
