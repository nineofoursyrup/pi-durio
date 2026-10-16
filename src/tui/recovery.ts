/**
 * 1c 恢复核对面板（U3）：取数与纯渲染、按项处置的状态机。宿主（app.ts）负责打开时的只读核对、
 * 确认框与提交；本文件不取锁、不写记录。
 *
 * “所有者”一节（`confirm-cleanup`）归 #76：现在只显示检查行，只能重新核对。
 */
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { recoveryRecords } from '../recovery-facts.js';
import type { RecoveryDecision, RecoveryReport, RecoveryTool } from '../recovery.js';
import type { QueueItemFact } from '../evidence.js';
import { readSessionChains } from '../session-chain.js';
import { readDisplayIndex } from '../display-number.js';
import { COLOR_TIER, GLYPHS, styledLine, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { clean, hintLine, truncateEnd, wrapSegments } from './view-stack.js';

/** 原因码中文对照（#59 第 4 节）；表外原因码原样显示。 */
export const REASON_TEXT: Record<string, string> = {
  EXECUTION_VERSION_CHANGED: '执行版本的文件已变化',
  EXECUTION_PLATFORM_CHANGED: '运行平台已变化',
  EXECUTION_INSTALLATION_CHANGED: '原依赖内容在当前安装中不可取得',
  EXECUTION_CONTENT_UNAVAILABLE: '原执行版本的安装清单缺失',
  EXECUTION_CONFIGURATION_CHANGED: '执行配置已变化',
  DURABLE_AGENT_CHANGED: '模型、指令或工具配置已变化',
  CURRENT_AUTHORIZATION_REQUIRED: '缺少当前授权',
  CURRENT_PERMISSION_CHANGED: '授权的工具与原任务不同',
  WORKSPACE_OR_MODE_CHANGED: '工作区或模式与原任务不同',
  WORKSPACE_ROOT_CHANGED: '工作区根目录已变化',
  REQUEST_LIMIT_EXHAUSTED: '本 run 的 8 次模型请求已用完',
  STOP_INTENT_PRESERVED: '已请求中止，只能结束',
  CLEANUP_UNCONFIRMED: '上次清理未确认',
  COMPACTION_OUTCOME_UNKNOWN: '有结果未知的手动压缩',
  OTHER_SESSION_PENDING: '会话 s-… 有未完成的工作',
  SESSION_WITHOUT_HOST_IDENTITY: '有会话存储缺少宿主记录',
  SESSION_STORAGE_ALIAS: '会话存储路径异常',
};
const VERSION_CODES = ['EXECUTION_VERSION_CHANGED', 'EXECUTION_PLATFORM_CHANGED', 'EXECUTION_INSTALLATION_CHANGED', 'EXECUTION_CONTENT_UNAVAILABLE', 'EXECUTION_CONFIGURATION_CHANGED', 'DURABLE_AGENT_CHANGED'];
const AUTHORIZATION_CODES = ['CURRENT_AUTHORIZATION_REQUIRED', 'CURRENT_PERMISSION_CHANGED', 'WORKSPACE_OR_MODE_CHANGED', 'WORKSPACE_ROOT_CHANGED'];
const LOCK_CODES = ['OWNER_CONFLICT', 'OWNER_HOST_UNVERIFIED', 'OWNER_STILL_ALIVE', 'OWNER_IDENTITY_UNVERIFIED'];

/** 按工具类型的固定影响模板（#43 第 3 节）：不写行数等推测。 */
export function impactOf(tool: string) {
  return ({ bash: '可能重复命令已产生的影响', write: '可能再次覆盖写入该文件', edit: '可能再次修改该文件', read: '只读操作，重复读取不改变文件' } as Record<string, string>)[tool] ?? '可能重复该操作已产生的影响';
}

/** 原因文本里的原因码：开头的大写标识（`Error: X` 去掉前缀）。 */
export function reasonCode(reason: string) {
  return /([A-Z][A-Z0-9_]{2,})/.exec(reason.replace(/^\w*Error:\s*/, ''))?.[1] ?? reason;
}

export interface RecoveryCheck { ok: boolean; text: string; code?: string }
export interface RecoveryItem { taskId: number; tool: string; target: string; intentAt?: string; dispatched: boolean; output?: { bytes: number; tail: string } }
export interface RecoveryFacts {
  runId: string; snapshotId: string; status: RecoveryReport['status']; options: string[];
  work: { title: string; task?: number; round?: number };
  lastConfirmed?: { tool: string; target: string; at?: string };
  /** 结果未知且尚无处置的工具，按任务顺序。 */
  items: RecoveryItem[];
  /** 记录中已有的处置（含首版 `skip`）。 */
  prior: { tool: string; target: string; choice: string; reason: string }[];
  checks: RecoveryCheck[];
  frozen: { count: number; first?: { kind: string; text: string } };
  /** `OTHER_SESSION_PENDING` 指向的会话 s- 号。 */
  otherSessions: string[];
  unknownModelAttempts: number;
}

/** 首页之后的分页（同一快照）：工具与原因都按同一偏移翻页，直到各列表都取完。 */
export async function recoveryPages(first: RecoveryReport, page: (offset: number) => Promise<RecoveryReport>) {
  const pages = [first];
  for (let next = nextOffset(first); next !== undefined; next = nextOffset(pages.at(-1)!)) pages.push(await page(next));
  return pages;
}
function nextOffset(report: RecoveryReport) {
  const details = report.details;
  if (!details) return undefined;
  const next = [details.tools, details.reasons].map(detail => detail.next).filter((value): value is number => value !== null);
  return next.length ? Math.min(...next) : undefined;
}

const firstLine = (text: string) => clean(String(text ?? '')).split('\n').find(line => line.trim())?.trim() ?? '';
function targetOf(tool: RecoveryTool) {
  const args = tool.args as any;
  if (args?.reference) return `参数 ${args.bytes} B`;
  return firstLine(tool.tool === 'bash' ? args?.command : args?.path ?? (args === undefined ? '' : JSON.stringify(args)));
}

/** 面板事实：报告各页 + 该 run 的宿主记录（intent 时间、已收输出、最后已提交结果）。只读。 */
export function readRecoveryFacts(root: string, pages: RecoveryReport[], context: { round?: number; task?: number; queue?: QueueItemFact[] } = {}): RecoveryFacts {
  const report = pages[0];
  const tools = pages.flatMap(page => page.tools), reasons = [...new Set(pages.flatMap(page => page.reasons))];
  const pending = tools.filter(tool => tool.fact === 'unknown' && !tool.resolution);
  const watched = new Set(tools.map(tool => tool.taskId));
  const intents = new Map<number, { at: string; attemptId: string }>(), dispatched = new Set<number>(), results = new Map<number, { seq: number; at: string }>();
  const outputs = new Map<string, { bytes: number; tail: Buffer }>();
  let title = '';
  const records = recoveryRecords(root, report.runId);
  for (const record of records) {
    if (record.kind === 'task.accepted') title = firstLine((record.data as any).input);
    if (!['tool.intent', 'tool.dispatch', 'tool.result'].includes(record.kind)) continue;
    const data = record.data as any;
    if (!watched.has(data.durableTaskId)) continue;
    if (record.kind === 'tool.intent') intents.set(data.durableTaskId, { at: record.at, attemptId: data.attemptId });
    if (record.kind === 'tool.dispatch') dispatched.add(data.durableTaskId);
    if (record.kind === 'tool.result') results.set(data.durableTaskId, { seq: record.seq, at: record.at });
  }
  const attempts = new Set(pending.map(tool => intents.get(tool.taskId)?.attemptId).filter(Boolean));
  if (attempts.size) for (const record of records) {
    if (record.kind !== 'tool.output') continue;
    const data = record.data as any, attempt = data.toolAttempt?.attemptId;
    if (!attempts.has(attempt) || typeof data.acquired?.bytes !== 'string') continue;
    const chunk = Buffer.from(data.acquired.bytes, 'base64'), seen = outputs.get(attempt) ?? { bytes: 0, tail: Buffer.alloc(0) };
    outputs.set(attempt, { bytes: seen.bytes + chunk.length, tail: Buffer.concat([seen.tail, chunk]).subarray(-256) });
  }
  const committed = tools.filter(tool => tool.fact === 'committed').sort((a, b) => (results.get(a.taskId)?.seq ?? 0) - (results.get(b.taskId)?.seq ?? 0)).at(-1);
  const items: RecoveryItem[] = pending.map(tool => {
    const intent = intents.get(tool.taskId), output = intent && outputs.get(intent.attemptId);
    return { taskId: tool.taskId, tool: tool.tool, target: targetOf(tool), intentAt: intent?.at, dispatched: dispatched.has(tool.taskId) || tool.evidence.length > 0,
      ...(output ? { output: { bytes: output.bytes, tail: firstLine(output.tail.toString('utf8').replace(/^�+/, '').split('\n').filter(Boolean).at(-1) ?? '') } } : {}) };
  });
  const frozen = (context.queue ?? []).filter(item => item.status === 'frozen' && item.target.runId === report.runId);
  const otherSessions = reasons.filter(reason => reason.startsWith('OTHER_SESSION_PENDING:')).map(reason => sessionLabel(root, reason.slice('OTHER_SESSION_PENDING:'.length).trim()));
  return {
    runId: report.runId, snapshotId: report.snapshotId, status: report.status, options: report.options,
    work: { title: title || '未记录', task: context.task, round: context.round || undefined },
    ...(committed ? { lastConfirmed: { tool: committed.tool, target: targetOf(committed), at: results.get(committed.taskId)?.at } } : {}),
    items, prior: tools.filter(tool => tool.resolution).map(tool => ({ tool: tool.tool, target: targetOf(tool), choice: tool.resolution!.choice, reason: tool.resolution!.reason })),
    checks: recoveryChecks(reasons), frozen: { count: frozen.length, ...(frozen[0] ? { first: { kind: frozen[0].kind, text: firstLine(frozen[0].input) } } : {}) },
    otherSessions: [...new Set(otherSessions)], unknownModelAttempts: report.details?.unknownModelAttempts.count ?? report.unknownModelAttempts.length,
  };
}
/** 持久会话目录 → 派生会话的 s- 号（经该会话首个受理的 run）。 */
function sessionLabel(root: string, durableSessionId: string) {
  const runId = (recoveryRecords(root).find(record => record.kind === 'task.accepted' && (record.data as any).sessionId === durableSessionId)?.data as any)?.runId;
  const session = runId ? readSessionChains(root).sessionOfRun(runId) : null;
  return session ? readDisplayIndex(root).label('session', session.id) : durableSessionId.slice(0, 8);
}

/** 检查行：执行版本、授权、写入者锁三项固定列出，其余原因各列一项；✗ 排前（U3）。 */
export function recoveryChecks(reasons: string[]): RecoveryCheck[] {
  const codes = [...new Set(reasons.map(reasonCode))];
  const failed = (group: string[]) => codes.filter(code => group.includes(code));
  const fixed = [
    { group: VERSION_CODES, ok: '执行版本一致' },
    { group: AUTHORIZATION_CODES, ok: '授权仍适用' },
    { group: LOCK_CODES, ok: '写入者锁可取得' },
  ];
  const checks: RecoveryCheck[] = [];
  for (const { group, ok } of fixed) {
    const bad = failed(group);
    if (!bad.length) checks.push({ ok: true, text: ok });
    for (const code of bad) checks.push({ ok: false, text: REASON_TEXT[code] ?? (group === LOCK_CODES ? '写入者锁不可取得' : code), code });
  }
  const known = new Set([...VERSION_CODES, ...AUTHORIZATION_CODES, ...LOCK_CODES]);
  for (const code of codes.filter(code => !known.has(code))) checks.push({ ok: false, text: REASON_TEXT[code] ?? code, code });
  return [...checks.filter(check => !check.ok), ...checks.filter(check => check.ok)];
}

export const DISPOSITIONS = [
  { name: '重新核对（只读）', text: '只重跑宿主检查，不运行命令、不调用模型' },
  { name: '视为已完成', text: '需你确认该操作已完成；不重做，追加你的决定' },
  { name: '从中断处继续', text: '允许重新运行该操作，可能重复已发生的影响' },
  { name: '结束旧工作，开新任务', text: '旧 run 标记已结束；新任务不接续旧上下文；冻结项需重新提交' },
] as const;
export const DEFAULT_REASON = { completed: '用户确认该操作已完成（未填写说明）', retry: '用户选择从中断处继续，接受可能重复的影响' } as const;
const CHOICE_TEXT: Record<string, string> = { completed: '视为已完成', retry: '从中断处继续', skip: '跳过（首版处置）' };

export type RecoveryAction =
  | { type: 'none' } | { type: 'close' } | { type: 'recheck' } | { type: 'end' }
  /** 0 项未知时的“继续旧工作”。 */
  | { type: 'continue' }
  /** 最后一项选完：汇总确认后提交。 */
  | { type: 'summary'; resolutions: NonNullable<RecoveryDecision['resolutions']> };

/** 1c 面板：光标、逐项处置与“视为已完成”的一句说明；渲染按给定高度收起（U3）。 */
export class RecoveryPanel {
  /** 光标所在处置（0–3）。 */
  cursor = 0;
  /** 当前处置的未知项。 */
  index = 0;
  /** 正在为“视为已完成”填写说明。 */
  note?: string;
  readonly choices = new Map<number, { choice: 'completed' | 'retry'; reason: string; note?: string }>();
  constructor(readonly facts: RecoveryFacts) {}

  /** 处置不可选的原因；可选时 undefined。 */
  disabled(option: number): string | undefined {
    const options = this.facts.options, first = this.facts.checks.find(check => !check.ok)?.text ?? '需先处理检查项';
    if (option === 0) return undefined;
    if (options.includes('confirm-cleanup')) return '上次进程未释放写入者锁';
    if (options.includes('external-verification')) return first;
    if (!options.includes('continue')) return option === 3 ? (options.includes('end') ? undefined : first) : first;
    if (option === 1 && !this.facts.items.length) return '没有结果未提交的操作';
    return undefined;
  }
  get zeroUnknown() { return !this.facts.items.length && this.facts.options.includes('continue'); }

  handleInput(data: string): RecoveryAction {
    if (this.note !== undefined) {
      if (matchesKey(data, 'escape')) { this.note = undefined; return { type: 'none' }; }
      if (matchesKey(data, 'enter')) { const note = this.note.trim(); this.note = undefined; return this.choose('completed', note); }
      if (matchesKey(data, 'backspace')) { this.note = Array.from(this.note).slice(0, -1).join(''); return { type: 'none' }; }
      const text = clean(data).replace(/[\r\n]/g, '');
      if (text && !data.startsWith('\x1b')) this.note = Array.from(this.note + text).slice(0, 200).join('');
      return { type: 'none' };
    }
    if (matchesKey(data, 'escape')) return { type: 'close' };
    const step = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : 0;
    if (step) { for (let next = this.cursor + step; next >= 0 && next < 4; next += step) if (!this.disabled(next)) { this.cursor = next; break; } return { type: 'none' }; }
    if (/^[1-4]$/.test(data)) { const option = Number(data) - 1; if (!this.disabled(option)) this.cursor = option; return { type: 'none' }; }
    if (!matchesKey(data, 'enter') || this.disabled(this.cursor)) return { type: 'none' };
    if (this.cursor === 0) return { type: 'recheck' };
    if (this.cursor === 3) return { type: 'end' };
    if (!this.facts.items.length) return { type: 'continue' };
    if (this.cursor === 1) { this.note = ''; return { type: 'none' }; }
    return this.choose('retry');
  }
  /** 汇总确认里按 Esc：回到最后一项调整。 */
  adjust() { this.index = Math.max(0, this.facts.items.length - 1); this.cursor = 0; }

  private choose(choice: 'completed' | 'retry', note?: string): RecoveryAction {
    const item = this.facts.items[this.index];
    this.choices.set(item.taskId, { choice, reason: note || DEFAULT_REASON[choice], ...(note ? { note } : {}) });
    if (this.index < this.facts.items.length - 1) { this.index++; this.cursor = 0; return { type: 'none' }; }
    return { type: 'summary', resolutions: this.facts.items.map(item => ({ taskId: item.taskId, choice: this.choices.get(item.taskId)!.choice, reason: this.choices.get(item.taskId)!.reason })) };
  }

  /** 汇总确认框正文：各项处置与说明。 */
  summaryBody() {
    const total = this.facts.items.length;
    return this.facts.items.map((item, i) => {
      const chosen = this.choices.get(item.taskId)!;
      return `${i + 1}/${total} ${item.tool} ${truncateEnd(item.target, 40)} · ${CHOICE_TEXT[chosen.choice]}${chosen.note ? ` · “${chosen.note}”` : ''}`;
    });
  }

  /** 完整高度（不收起）。 */
  fullHeight(width: number) { return this.lines(width, 0).length; }
  /** 收起后的最小高度：工作、未知、检查、四项名称、选中项说明与面板底栏。 */
  minHeight(width: number) { return this.lines(width, 4).length; }

  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    for (let level = 0; level <= 4; level++) {
      const lines = this.lines(width, level, tier);
      if (lines.length <= height) return lines;
      // 连最小形式都放不下：保留面板底栏，其余从下往上截去。
      if (level === 4) return height <= 0 ? [] : [...lines.slice(0, height - 1), lines.at(-1)!];
    }
    return [];
  }

  /**
   * 收起级别：0 全部；1 证据行与已冻结行各收成一行；2 只显示选中处置的说明；
   * 3 收起最后确认点、证据行与已冻结行；4 再收起标题、影响、你的决定、处置标题与“需先处理”行。
   */
  private lines(width: number, level: number, tier: ColorTier = COLOR_TIER): string[] {
    const facts = this.facts, wide = width >= 100, labelWidth = width >= 60 ? 12 : 11, valueWidth = Math.max(1, width - labelWidth);
    const out: string[] = [];
    const row = (label: string, segments: TextSegment[]) => out.push(styledLine([{ text: pad(label, labelWidth), fg: 'fg.label' }, ...fit(segments, valueWidth)], width, undefined, tier));
    const more = (segments: TextSegment[]) => out.push(styledLine([{ text: ' '.repeat(labelWidth) }, ...fit(segments, valueWidth)], width, undefined, tier));
    if (level < 4) out.push(styledLine([{ text: '恢复核对', fg: 'fg.primary', bold: true }, { text: ' · 只读 · 未打开可写存储', fg: 'fg.muted' }, ...rightAlign(width, '恢复核对 · 只读 · 未打开可写存储', 'Esc 返回查看')], width, undefined, tier));
    const work = facts.work;
    row('工作', [{ text: work.title, fg: 'fg.body' }, { text: `${work.task ? ` · 任务 ${work.task}` : ''}${work.round ? ` · 第 ${work.round} 轮` : ''}`, fg: 'fg.faint' }]);
    if (level < 3) row('最后确认点', facts.lastConfirmed
      ? [{ text: `${GLYPHS.ok} `, fg: 'ac.ok' }, { text: `${facts.lastConfirmed.tool} ${facts.lastConfirmed.target}`, fg: 'fg.body' }, { text: ` · ${facts.lastConfirmed.at ? `${time(facts.lastConfirmed.at)} ` : ''}已提交结果`, fg: 'fg.faint' }]
      : [{ text: '没有已提交的工具结果', fg: 'fg.muted' }]);
    const item = facts.items[this.index], total = facts.items.length;
    if (item) {
      row(`未知 ${this.index + 1}/${total}`, [{ text: `${GLYPHS.warn} `, fg: 'ac.warn' }, { text: `${item.tool} `, fg: 'fg.body' }, { text: item.target, fg: 'ac.code' }, { text: ` · ${item.intentAt ? `intent 已记录 ${time(item.intentAt)}，` : ''}结果未提交 · 可能已产生影响`, fg: 'fg.faint' }]);
      if (level < 3) {
        const evidence: TextSegment[] = item.output ? [{ text: `已收输出 ${item.output.bytes} B`, fg: 'fg.body' }, ...(item.output.tail ? [{ text: `：“${item.output.tail}”`, fg: 'fg.muted' as TokenName }] : [])] : [{ text: item.dispatched ? '已派发 · 没有已收输出' : '没有派发记录 · 没有已收输出', fg: 'fg.muted' }];
        row('证据', evidence);
      }
      if (level < 4) row('影响', [{ text: impactOf(item.tool), fg: 'fg.body' }]);
    } else row('未知 0', [{ text: '没有结果未提交的操作', fg: 'fg.muted' }]);
    // 检查行：可折成多行、不截断；原因码 dim 附行末。
    const checks: TextSegment[] = [];
    facts.checks.forEach((check, i) => {
      if (i) checks.push({ text: ' · ', fg: 'fg.faint' });
      checks.push({ text: `${check.ok ? GLYPHS.ok : GLYPHS.err} `, fg: check.ok ? 'ac.ok' : 'ac.err' }, { text: check.text, fg: 'fg.body' });
    });
    const codes = facts.checks.filter(check => check.code && REASON_TEXT[check.code]).map(check => check.code!);
    if (codes.length) checks.push({ text: `  ${codes.join(' ')}`, fg: 'fg.faint', dim: true });
    wrapSegments(checks, valueWidth).forEach((segments, i) => (i ? more : (s: TextSegment[]) => row('检查', s))(segments));
    if (level < 4) for (const session of facts.otherSessions) row('需先处理', [{ text: `会话 ${session} 有未完成的工作 · pi-durio resume ${session}`, fg: 'ac.warn' }]);
    if (level < 3 && facts.frozen.count) {
      row('已冻结', [{ text: `⧗ ${facts.frozen.first!.kind} `, fg: 'ac.info' }, { text: facts.frozen.first!.text, fg: 'fg.body' }, { text: ` · ${facts.frozen.count} 项 · 不会自动接入`, fg: 'fg.faint' }]);
      if (level < 1) more([{ text: '继续旧工作后仍冻结，在 /queue 中显式重新接入；结束旧工作后只能查看和复制', fg: 'fg.faint' }]);
    }
    if (level < 4) {
      const chosen = item && this.choices.get(item.taskId);
      const decided: TextSegment[] = chosen ? [{ text: CHOICE_TEXT[chosen.choice], fg: 'fg.body' }, ...(chosen.note ? [{ text: ` · “${chosen.note}”`, fg: 'fg.muted' as TokenName }] : [])] : [];
      if (decided.length) row('你的决定', decided);
      facts.prior.slice(0, level < 1 ? 3 : 1).forEach((prior, i) => (i || decided.length ? more : (s: TextSegment[]) => row('你的决定', s))([
        { text: `此前 · ${prior.tool} ${prior.target} · `, fg: 'fg.faint' }, { text: CHOICE_TEXT[prior.choice] ?? prior.choice, fg: 'fg.body' }, ...(prior.reason ? [{ text: ` · ${prior.reason}`, fg: 'fg.muted' as TokenName }] : [])]));
      out.push(styledLine([{ text: '处置', fg: 'fg.label' }, { text: ' · 原 interrupted/unknown 记录不会被改写', fg: 'fg.faint' }], width, undefined, tier));
    }
    const nameWidth = 28;
    DISPOSITIONS.forEach((option, i) => {
      const selected = i === this.cursor, off = this.disabled(i), bg: TokenName | undefined = selected ? 'bg.selected' : undefined;
      const name = `${i + 1}  ${option.name}`, description = off ? `不可选 · ${off}` : option.text;
      const head: TextSegment[] = [{ text: selected ? '▏ ' : '  ', fg: 'ac.brand' }, { text: wide ? pad(name, nameWidth) : name, fg: off ? 'fg.gutter' : selected ? 'fg.primary' : 'fg.body', bold: selected && !off }];
      const showText = level < 2 || selected;
      const note = selected && this.note !== undefined;
      const descSegments: TextSegment[] = note ? [{ text: `说明（可选）：${this.note}▏`, fg: 'fg.primary' }, { text: '  Enter 确认 · Esc 取消', fg: 'fg.label' }] : [{ text: description, fg: off ? 'fg.gutter' : 'fg.muted' }];
      if (wide && showText && !note) out.push(styledLine([...head, ...fit(descSegments, Math.max(1, width - 2 - nameWidth))], width, bg, tier));
      else {
        out.push(styledLine(head, width, bg, tier));
        if (showText) out.push(styledLine([{ text: '     ' }, ...fit(descSegments, Math.max(1, width - 5))], width, bg, tier));
      }
    });
    out.push(hintLine(['↑↓ 选择', 'Enter 确认'], width, { esc: 'Esc 返回查看', tier }));
    return out;
  }
}

/** 恢复期间禁用的输入框（U3）：草稿灰显保留；没有草稿时写占位。 */
export function disabledInputLines(draft: string, width: number, tier: ColorTier = COLOR_TIER) {
  const rule = styledLine([{ text: '─'.repeat(width), fg: 'border.off' }], width, undefined, tier);
  const text = firstLine(draft);
  const body: TextSegment[] = text
    ? [{ text: `${GLYPHS.prompt} `, fg: 'fg.gutter' }, ...fit([{ text, fg: 'fg.faint' }, { text: '  草稿已保留，不会提交', fg: 'fg.muted' }], Math.max(1, width - 2))]
    : [{ text: `${GLYPHS.prompt} `, fg: 'fg.gutter' }, { text: '恢复核对进行中 · 输入不会提交', fg: 'fg.faint' }];
  return [rule, styledLine(body, width, undefined, tier), rule];
}

function time(at: string) { const d = new Date(at); return Number.isNaN(d.getTime()) ? at : [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); }
function pad(text: string, width: number) { const w = visibleWidth(text); return w >= width ? truncateEnd(text, width) : text + ' '.repeat(width - w); }
function rightAlign(width: number, left: string, right: string): TextSegment[] {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? [{ text: ' '.repeat(gap) }, { text: right, fg: 'fg.label' }] : [];
}
/** 片段逐个截断到给定宽度，末尾加 `…`。 */
function fit(segments: TextSegment[], width: number): TextSegment[] {
  const out: TextSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const text = clean(segment.text), w = visibleWidth(text);
    if (used + w <= width) { out.push({ ...segment, text }); used += w; continue; }
    out.push({ ...segment, text: truncateEnd(text, width - used) }); break;
  }
  return out;
}
