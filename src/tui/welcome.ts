import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { digest } from '../evidence.js';
import { executionConfig } from '../execution-config.js';
import { applyTaskProfile } from '../task-profile.js';
import { readImproveDefaults } from '../improve-defaults.js';
import { readSessionChains, type SessionTaskStatus } from '../session-chain.js';
import { probeWorkspaceOwner, type WorkspaceHolder } from '../workspace-ownership.js';
import { formatAmount } from '../cost-estimate.js';
import type { ToolEnvironmentConfig } from '../coding-environment.js';
import { COLOR_TIER, GLYPHS, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { clean, truncateEnd, truncateMiddle } from './view-stack.js';

/** 内置静态 Tip（U1：不超过 5 条，每次启动轮换一条，只在欢迎屏显示，不设开关）。 */
export const TIPS = [
  '空闲时 Enter 提交新任务；运行中 Enter 变为 steer，在当前工具轮次边界接入。',
  '运行中按 Ctrl+X 再按 Enter，把输入排到下一任务（follow-up）。',
  'Ctrl+R 打开历史；/history s-号 直接查看某个会话。',
  '输入 / 弹出命令补全，@ 弹出文件补全、只插入路径。',
  '? 打开帮助，列出会话屏键位与全部命令。',
] as const;

/** 写入者锁探测结果（R2，不取锁）。`probing` 只在首次探测返回前出现。 */
export type WelcomeLock = { state: 'probing' } | { state: 'readonly' } | { state: 'free' } | { state: 'held'; holder: WorkspaceHolder } | { state: 'unknown'; reason: string };
export interface WelcomeSession { label: string; improve: boolean; input: string; status: SessionTaskStatus; at: string }
export interface WelcomeFacts {
  version: string; build: string; workspace: string; lock: WelcomeLock;
  model: { id: string; api: string; host: string };
  /** `build <7> · deps <4> · 指令 <4> · N tools[ · improve 默认 N 项]` */
  execution: string; dataRoot: string; sessions: WelcomeSession[] | { error: string }; tip: string;
}

const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
const short = (bytes: string | Buffer, n: number) => digest(bytes).slice(0, n);
const home = (path: string) => { const dir = homedir(); return path === dir || path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path; };

/**
 * 欢迎屏的事实，只读：不取锁、不跑 `captureArtifact`（正式执行版本仍在受理时固定，S4）。
 * 执行版本摘要按下一任务的生效配置：自有构建、依赖锁、生效指令（含 improve 默认项）与工具数。
 */
export function readWelcomeFacts(options: { workspace: string; dataRoot: string; coding: boolean; mode: 'live' | 'offline'; toolEnvironment?: ToolEnvironmentConfig }, sessionLabel: (id: string) => string, tip: string): Omit<WelcomeFacts, 'lock'> {
  const version = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).version as string;
  const build = short(readFileSync(join(installRoot, 'dist', 'execution', 'source-build.json')), 7);
  const deps = short(readFileSync(join(installRoot, 'dist', 'execution', 'package-lock.json')), 4);
  let configuration = executionConfig(options.coding, options.mode, options.toolEnvironment), defaults = 0;
  // 同 estimateTaskPrefix：默认项不可读只影响这行显示，受理时照常报错。
  try { const current = readImproveDefaults(options.dataRoot, options.workspace, options.coding ? 'coding' : 'read'); if (current.files.length) { configuration = applyTaskProfile(configuration, current.profile); defaults = current.files.length; } } catch {}
  const tools = options.coding ? 4 : 1;
  const execution = `build ${build} · deps ${deps} · 指令 ${short(configuration.instructions, 4)} · ${tools} ${tools === 1 ? 'tool' : 'tools'}${defaults ? ` · improve 默认 ${defaults} 项` : ''}`;
  let sessions: WelcomeFacts['sessions'];
  try {
    sessions = readSessionChains(options.dataRoot).list({ workspace: options.workspace, limit: 3 }).items.map(session => ({
      label: sessionLabel(session.id), improve: session.kind === 'improve', input: session.first.input.split('\n')[0], status: session.tail.status, at: session.tail.at,
    }));
  } catch (error) { sessions = { error: clean(error instanceof Error ? error.message : String(error)) }; }
  const { model } = configuration;
  return { version, build, workspace: options.workspace, model: { id: model.id, api: model.api, host: new URL(model.baseUrl).host }, execution, dataRoot: options.dataRoot, sessions, tip };
}

/** 启动与每次回到空闲时探测；只读模式不探测。 */
export async function probeWelcomeLock(workspace: string, coding: boolean): Promise<WelcomeLock> {
  if (!coding) return { state: 'readonly' };
  try { const { holder } = await probeWorkspaceOwner(workspace); return holder ? { state: 'held', holder } : { state: 'free' }; }
  catch (error) { return { state: 'unknown', reason: clean(error instanceof Error ? error.message : String(error)).split(':')[0] }; }
}

const STATUS: Record<SessionTaskStatus, { glyph: string; text: string; fg: TokenName }> = {
  completed: { glyph: GLYPHS.ok, text: '完成', fg: 'ac.ok' },
  failed: { glyph: GLYPHS.err, text: '失败', fg: 'ac.err' },
  aborted: { glyph: GLYPHS.aborted, text: '已中止', fg: 'fg.muted' },
  // 恢复核对里处置 4 与普通中止分别显示。
  ended: { glyph: GLYPHS.aborted, text: '已结束', fg: 'fg.muted' },
  unknown: { glyph: GLYPHS.warn, text: '待恢复核对', fg: 'ac.warn' },
  // 没有关闭记录：本进程尚未受理任务，所以它不属于本进程，按需恢复核对显示。
  running: { glyph: GLYPHS.warn, text: '待恢复核对', fg: 'ac.warn' },
  accepted: { glyph: GLYPHS.warn, text: '待恢复核对', fg: 'ac.warn' },
};

/** `今天 10:12` / `昨天 22:40` / `10-09` / `2025-10-09`（本地时间）。 */
export function sessionTime(at: string, now: Date): string {
  const date = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  if (Number.isNaN(date.getTime())) return '未记录';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000), clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`;
}

function lockSegments(lock: WelcomeLock, now: Date): TextSegment[] {
  switch (lock.state) {
    case 'probing': return [{ text: '写入者锁探测中', fg: 'fg.faint' }];
    case 'readonly': return [{ text: '只读 · 不取写入者锁', fg: 'fg.muted' }];
    case 'free': return [{ text: GLYPHS.ok, fg: 'ac.ok' }, { text: ' 写入者锁可取得', fg: 'fg.muted' }];
    case 'unknown': return [{ text: GLYPHS.warn, fg: 'ac.warn' }, { text: ` 写入者锁状态未知 · ${lock.reason}`, fg: 'fg.muted' }];
    case 'held': {
      const { pid, host, started } = lock.holder;
      const who = [pid === undefined ? '持有者未记录' : `pid ${pid}`, host, started && sessionTime(started, now)].filter(Boolean).join(' · ');
      return [{ text: GLYPHS.err, fg: 'ac.err' }, { text: ` 被占用 · ${clean(who)}`, fg: 'fg.body' }];
    }
  }
}

type Row = { segments: TextSegment[]; session?: string };

/** 两行高的标识（U1，视觉修正 r1）：`◢◣`/`◥◤` 拼成的 ◆，加半格方块字 pi·durio。 */
const LOGO = { diamond: ['◢◣', '◥◤'], pi: ['█▀█ █', '█▀▀ █'], dot: ['▄', ' '], durio: ['█▀▄ █ █ █▀█ █ █▀█', '█▄▀ █▄█ █▀▄ █ █▄█'] };

/**
 * 1a 主体（输入框以上）。高度不够时先把方块字标识退回一行，再去掉空行（U10），
 * 再依次收起 Tip、最近会话（3→1→隐藏）、执行版本与数据根、版本行；标识、工作区（含锁）、模型始终保留。
 * 返回恰好 `height` 行，`sessions` 是可点击行号 → 会话显示号；`selected` 的会话行带 `▏` 与 `bg.selected`。
 */
export function renderWelcome(facts: WelcomeFacts, width: number, height: number, now = new Date(), tier: ColorTier = COLOR_TIER, selected?: string) {
  const indent = width >= 100 ? 6 : width >= 60 ? 3 : 1, labelWidth = width >= 60 ? 12 : 9;
  const inner = Math.max(1, width - indent), valueWidth = Math.max(1, inner - labelWidth);
  const label = (text: string): TextSegment => ({ text: text + ' '.repeat(Math.max(1, labelWidth - visibleWidth(text))), fg: 'fg.label' });
  const field = (name: string, text: string, fg: TokenName, middle = false): Row => ({ segments: [label(name), { text: middle ? truncateMiddle(text, valueWidth) : truncateEnd(text, valueWidth), fg }] });
  const blank: Row = { segments: [] };

  const logo: Row = { segments: [{ text: GLYPHS.brand, fg: 'ac.brand', bold: true }, { text: ' pi', fg: 'fg.primary', bold: true }, { text: '·', fg: 'fg.faint', bold: true }, { text: 'durio', fg: 'fg.primary', bold: true }] };
  const logoBlock: Row[] = [0, 1].map(i => ({ segments: [{ text: LOGO.diamond[i], fg: 'ac.brand' }, { text: '  ' }, { text: LOGO.pi[i], fg: 'fg.primary' }, { text: ' ' }, { text: LOGO.dot[i], fg: 'fg.faint' }, { text: ' ' }, { text: LOGO.durio[i], fg: 'fg.primary' }] }));
  const version: Row = { segments: [{ text: '本机 coding agent', fg: 'fg.primary' }, { text: ' · ', fg: 'fg.faint' }, { text: `v${facts.version} · ${facts.build}`, fg: 'fg.label' }] };

  // 工作区与锁：放得下时同一行；被占用时持有者与恢复方法各占一行（宽终端恢复方法可换行）。
  const workspace = home(facts.workspace), lock = lockSegments(facts.lock, now), lockWidth = lock.reduce((w, s) => w + visibleWidth(s.text), 0);
  const workspaceRows: Row[] = [];
  if (facts.lock.state !== 'held' && visibleWidth(workspace) + 3 + lockWidth <= valueWidth)
    workspaceRows.push({ segments: [label('工作区'), { text: workspace, fg: 'ac.path' }, { text: ' · ', fg: 'fg.faint' }, ...lock] });
  else {
    workspaceRows.push(field('工作区', workspace, 'ac.path', true));
    const pad: TextSegment = { text: ' '.repeat(labelWidth) };
    const text = lock.map(s => s.text).join('');
    workspaceRows.push({ segments: [pad, ...(visibleWidth(text) <= valueWidth ? lock : [{ ...lock[0] }, { ...lock[1], text: truncateEnd(lock[1].text, Math.max(0, valueWidth - visibleWidth(lock[0].text))) }])] });
    if (facts.lock.state === 'held') {
      const { path } = facts.lock.holder;
      const recovery = `恢复：等持有者结束后重开；进程已不在时，先确认它启动的命令都已结束，再删除 ${home(path)}.lock 与 ${home(path)}/owner.json，不要只凭 PID 消失删除锁`;
      const lines = width >= 100 ? wrapTextWithAnsi(recovery, valueWidth) : [truncateEnd(recovery, valueWidth)];
      for (const line of lines) workspaceRows.push({ segments: [pad, { text: line, fg: 'fg.muted' }] });
    }
  }
  const model: Row = { segments: [label('模型'), { text: facts.model.id, fg: 'ac.model' }, { text: truncateEnd(` · ${facts.model.api} · ${facts.model.host}`, Math.max(0, valueWidth - visibleWidth(facts.model.id))), fg: 'fg.faint' }] };
  const execution = field('执行版本', facts.execution, 'fg.muted'), dataRoot = field('数据根', home(facts.dataRoot), 'fg.muted', true);

  // 最近会话四列：选中标记、号、[improve ·] 首任务输入首行、状态（右对齐）、时间（右对齐）；宽度小于 60 时去掉时间列。
  const rowWidth = Math.min(inner, 100);
  const all = Array.isArray(facts.sessions) ? facts.sessions : [];
  const idWidth = Math.max(0, ...all.map(session => visibleWidth(session.label))) + 4;
  const sessionRows = all.map((session): Row => {
    const status = STATUS[session.status], time = sessionTime(session.at, now), state = `${status.glyph} ${status.text}`;
    const on = session.label === selected, bg: TokenName | undefined = on ? 'bg.selected' : undefined;
    // 状态列宽按最长的“◈ 待恢复核对”，时间列宽按“今天 10:12”/“2025-10-09”。
    const right = width >= 60 ? 12 + 2 + 10 + 1 : 12 + 1, prefix = session.improve ? 'improve · ' : '';
    const room = Math.max(0, rowWidth - 3 - idWidth - right);
    const input = truncateEnd(clean(session.input), Math.max(0, room - visibleWidth(prefix)));
    const gap = Math.max(1, room - visibleWidth(prefix) - visibleWidth(input));
    return { session: session.label, segments: [
      { text: ' ', bg }, { text: on ? '▏' : ' ', fg: 'ac.brand', bg }, { text: ' ', bg },
      { text: session.label + ' '.repeat(idWidth - visibleWidth(session.label)), fg: on ? 'fg.primary' : 'fg.body', bg },
      { text: prefix, fg: 'ac.improve', bg }, { text: input, fg: on ? 'fg.primary' : 'fg.body', bg }, { text: ' '.repeat(gap), bg },
      { text: ' '.repeat(Math.max(0, 12 - visibleWidth(state))) + state, fg: status.fg, bg },
      ...(width >= 60 ? [{ text: '  ', bg }, { text: ' '.repeat(Math.max(0, 10 - visibleWidth(time))) + time, fg: 'fg.faint' as TokenName, bg }] : []),
      { text: ' ', bg },
    ] };
  });
  const sessionsHeader: Row = { segments: [{ text: '最近会话', fg: 'fg.label' }, { text: truncateEnd(' · ↑↓ 选择，Enter 或点击只读打开，不会调用模型或工具', Math.max(0, inner - 8)), fg: 'fg.faint' }] };
  const noSessions: Row = Array.isArray(facts.sessions)
    ? { segments: [{ text: truncateEnd('当前工作区还没有会话 · 在下方输入框提交第一个任务', inner), fg: 'fg.muted' }] }
    : { segments: [{ text: GLYPHS.err, fg: 'ac.err' }, { text: truncateEnd(` 最近会话不可读取 · ${facts.sessions.error}`, Math.max(0, inner - 1)), fg: 'fg.muted' }] };
  const tip: Row = { segments: [{ text: 'Tip: ', fg: 'fg.label', bold: true }, { text: truncateEnd(facts.tip, Math.max(0, width - 2 - 5)), fg: 'fg.label' }] };

  const levels = [
    ...(width >= 60 ? [{ block: true, tip: true, sessions: 3, details: true, version: true, blanks: true }] : []),
    { block: false, tip: true, sessions: 3, details: true, version: true, blanks: true },
    { block: false, tip: true, sessions: 3, details: true, version: true, blanks: false },
    { block: false, tip: false, sessions: 3, details: true, version: true, blanks: false },
    { block: false, tip: false, sessions: 1, details: true, version: true, blanks: false },
    { block: false, tip: false, sessions: 0, details: true, version: true, blanks: false },
    { block: false, tip: false, sessions: 0, details: false, version: true, blanks: false },
    { block: false, tip: false, sessions: 0, details: false, version: false, blanks: false },
  ];
  let block: Row[] = [], tail: Row[] = [];
  for (const level of levels) {
    const gap = level.blanks ? [blank] : [];
    block = [...(level.block ? logoBlock : [logo]), ...(level.version ? [...gap, version] : []), ...gap, ...workspaceRows, model, ...(level.details ? [execution, dataRoot] : [])];
    if (level.sessions) block.push(...gap, sessionsHeader, ...gap, ...(sessionRows.length ? sessionRows.slice(0, level.sessions) : [noSessions]));
    tail = level.tip ? [blank, tip] : [];
    if (block.length + tail.length <= height) break;
  }
  const top = Math.max(0, Math.floor((height - tail.length - block.length) / 2));
  const rows: Row[] = [...Array(top).fill(blank), ...block];
  while (rows.length < height - tail.length) rows.push(blank);
  rows.push(...tail);
  const sessions = new Map<number, string>();
  const lines = rows.slice(0, height).map((row, index) => {
    if (row.session) sessions.set(index, row.session);
    const pad = row === tail.at(-1) && tail.length ? 1 : indent;
    return styledLine(row.segments.length ? [{ text: ' '.repeat(pad) }, ...row.segments] : [], width, undefined, tier);
  });
  return { lines, sessions };
}

/** 1a 状态行：`○ 空闲 · 模型 · ctx ≈… / 1M · 本会话 0 tok ≈ ¥0.00`（本进程尚无会话）。 */
export function welcomeStatusSegments(model: string, context: string): TextSegment[] {
  return [{ text: GLYPHS.idle, fg: 'ac.ok' }, { text: ' 空闲', fg: 'ac.ok' }, { text: ' · ', fg: 'fg.faint' }, { text: model, fg: 'ac.model' }, { text: ' · ', fg: 'fg.faint' },
    { text: `${context} · 本会话 0 tok ${formatAmount(0, 'CNY')}`, fg: 'fg.label' }];
}
export function welcomeStatus(model: string, context: string, width: number, tier: ColorTier = COLOR_TIER) {
  return styledLine(welcomeStatusSegments(model, context), width, undefined, tier);
}

export interface WelcomeHost {
  read: () => Omit<WelcomeFacts, 'lock'>; coding: boolean;
  /** 主体可用行数（终端高减去输入框与状态区）。 */
  height: (width: number) => number;
  /** 点击最近会话行：按显示号打开该会话。 */
  open: (session: string) => void;
  changed: () => void; inspect: (lines: string[]) => void;
}
/** 欢迎屏组件：只在本进程尚未受理任务时由宿主放进布局。输入框为空时 ↑↓ 选择最近会话（U1）。 */
export class WelcomeScreen implements Component {
  facts: WelcomeFacts;
  private rows = new Map<number, string>();
  /** 选中的会话显示号；初始不选中（U1）。 */
  private selected?: string;
  private probe = 0;
  constructor(private readonly host: WelcomeHost) {
    this.facts = { ...host.read(), lock: host.coding ? { state: 'probing' } : { state: 'readonly' } };
  }
  /** 探测写入者锁（不取锁）；启动时调用，回到空闲时随 refresh 调用。较早的探测结果晚到时丢弃。 */
  async probeLock() {
    const probe = ++this.probe, lock = await probeWelcomeLock(this.facts.workspace, this.host.coding);
    if (probe === this.probe) { this.facts = { ...this.facts, lock }; this.host.changed(); }
  }
  /** 回到空闲时：重读事实并重新探测。 */
  async refresh() {
    this.facts = { ...this.host.read(), lock: this.facts.lock };
    return this.probeLock();
  }
  /**
   * 输入框为空时的按键（U1）：↑↓ 移动选中行，有选中行时 Enter 打开、Esc 取消选中；
   * 其他键只取消选中，交还宿主照常处理。返回是否已处理。
   */
  key(data: string): boolean {
    const labels = [...this.rows.values()];
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      if (!labels.length) return false;
      const index = this.selected === undefined ? -1 : labels.indexOf(this.selected), down = matchesKey(data, 'down');
      this.selected = labels[index < 0 ? (down ? 0 : labels.length - 1) : Math.max(0, Math.min(labels.length - 1, index + (down ? 1 : -1)))];
      return true;
    }
    if (this.selected === undefined) return false;
    const session = this.selected;
    this.selected = undefined;
    if (matchesKey(data, 'enter')) { this.host.open(session); return true; }
    return matchesKey(data, 'escape');
  }
  render(width: number) {
    const { lines, sessions } = renderWelcome(this.facts, width, Math.max(0, this.host.height(width)), new Date(), COLOR_TIER, this.selected);
    this.rows = sessions; this.host.inspect(lines);
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    const session = this.rows.get(event.y);
    if (event.type !== 'click' || !session) return undefined;
    this.host.open(session);
    return { handled: true };
  }
  invalidate() {}
}
