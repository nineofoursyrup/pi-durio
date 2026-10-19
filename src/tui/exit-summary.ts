/** 1f：退出后的只读取数与无样式摘要，不打开 Harness、不写记录。 */
import { readDisplayIndex } from '../display-number.js';
import { readSessionChains } from '../session-chain.js';
import { formatCostTotals, COST_ESTIMATE_NOTICE, type CostTotals } from '../cost-estimate.js';
import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { readContinuation } from '../continuation.js';
import { readObject, readQueue } from '../evidence.js';
import { readRunRecords } from '../query.js';
import { resolve } from 'node:path';
import {editLineChanges,writeLineChanges} from './tool-facts.js';
import { RunView, sumUsage } from './run-view.js';
import { tokenCount } from './session-screen.js';
import { probeWelcomeLock } from './welcome.js';
import type { RunResult } from '../runtime.js';
import type { PlanSource } from '../eval/overview.js';
import type {ImproveCleanupReceipt} from '../improve-decisions.js';
import type { EvalCleanupReceipt } from '../eval/cleanup.js';

/** #82 在本进程确实请求停止、等待 runner/VM 清理后提供；仅查看旧批次不能填写。 */
export type EvalExitFact = { planId: string; source?: Pick<PlanSource,'root'|'id'|'label'|'origin'>; receipt?:EvalCleanupReceipt; trial: number; total: number; cost: CostTotals } & (
  | { state: 'stopped'; cleanup: 'confirmed' }
  | { state: 'unconfirmed'; cleanup: 'unknown' }
);

export interface ExitSummaryFacts {
  workspace: string;
  runId?: string;
  /** 只传本进程实际返回的清理结果；打开历史不能冒充执行或释放过锁。 */
  cleanup?: RunResult;
  /** 本进程调用过执行入口但没有返回结果时，不能沿用前一次的已清理状态。 */
  cleanupAttempted?: boolean;
  elapsedMs: number;
  draftLines: number;
  terminalRestored: boolean;
  /** 本进程最近一次停止批次的事实；没有发生时省略。 */
  eval?: EvalExitFact;
  evalCleanup?:EvalCleanupReceipt;
  batchCleanup?:ImproveCleanupReceipt;
  error?: string;
}

/**
 * 仅接收本进程 runtime 的持久化观察通知。排队 improve/compact 可能返回主任务结果，
 * 因而另按 run 身份与记录序位保留其实际清理未知；其他 run 的成功不能覆盖它。
 */
export class ProcessCleanupReceipts {
  private readonly receipts = new Map<string, { seq: number; result: RunResult }>();
  private readonly unavailable = new Set<string>();
  observe(dataRoot: string, event: { kind: string; runId: string }) {
    if (!['run.closed', 'recovery.closed', 'compaction.closed'].includes(event.kind)) return;
    try {
      const ref = readRunRecords(dataRoot, event.runId, { kinds: [event.kind], tail: true, limit: 1 }).records[0];
      if (!ref) throw Error('CLEANUP_RECEIPT_MISSING');
      const data = JSON.parse(readObject(dataRoot, ref.ref).toString()), result = data.result ?? data;
      if (result.runId !== event.runId || !['confirmed', 'unknown'].includes(result.cleanup)) throw Error('CLEANUP_RECEIPT_INVALID');
      if (ref.seq > (this.receipts.get(event.runId)?.seq ?? 0)) this.receipts.set(event.runId, { seq: ref.seq, result });
      this.unavailable.delete(event.runId);
    } catch { this.unavailable.add(event.runId); }
  }
  /** active 已结束后读取；late-close 仍保留 owner，不作为确认清理的关闭 receipt。 */
  result(returned?: RunResult) {
    const unknown = [...this.receipts.values()].filter(item => item.result.cleanup === 'unknown').sort((a, b) => b.seq - a.seq)[0];
    return unknown?.result ?? (this.unavailable.size ? undefined : returned);
  }
}

/** 用户文本先取首行，去除终端转义和控制字符；输出行也复用这道边界。 */
function firstLine(text: string) {
  return stripTerminalSequences(text.split(/[\r\n\u2028\u2029]/, 1)[0]).replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
function cleanupLine(facts: ExitSummaryFacts, session?: string) {
  const result = facts.cleanup, lifecycle = result?.lifecycle;
  let line: string;
  if (result?.cleanup === 'unknown') line = `✗ 清理未确认 · 写入者锁保留${session ? ` · pi-durio resume ${session} 核对` : ''}`;
  else if (result) {
    const owner = lifecycle?.owner === 'release-after-host-close' ? '已释放' : '状态未记录';
    const storage = lifecycle?.storage === 'closed' ? '已关闭' : lifecycle?.storage === 'not-opened' ? '未打开' : '状态未记录';
    line = `◇ 写入者锁${owner} · storage ${storage}`;
  } else if(facts.batchCleanup){const b=facts.batchCleanup;line=`◇ improve 写入者锁${b.owner==='released'?'已释放':'状态未知'} · storage ${b.storage==='closed'?'已关闭':b.storage==='not-opened'?'未打开':'状态未知'} · 工作区锁${b.workspaces.every(w=>w.released)?'已释放':'状态未知'}`;} else if(facts.evalCleanup){const r=facts.evalCleanup;line=`◇ eval 写入者锁${r.owner==='released'?'已释放':r.owner==='not-acquired'?'未取得':'状态未知'} · storage ${r.storage==='closed'?'已关闭':r.storage==='not-opened'?'未打开':'状态未知'}`;} else if (facts.cleanupAttempted) line = '✗ 清理结果未取得 · 写入者锁 / storage 状态未知';
  else line = '◇ 写入者锁未取得 · storage 未打开';
  if(facts.batchCleanup&&(facts.batchCleanup.owner!=='released'||facts.batchCleanup.storage==='unknown'||facts.batchCleanup.workspaces.some(w=>!w.released)))line=`✗ improve 清理未确认 · ${line.slice(2)}`;
  if (facts.eval?.cleanup === 'unknown'||facts.evalCleanup?.cleanup==='unknown') line = `✗ 清理未确认 · eval VM 状态未知 · ${line.slice(2)}`;
  line = facts.terminalRestored ? `${line} · 终端已恢复` : `✗ 终端恢复未确认 · 请运行 reset · ${line.slice(2)}`;
  return facts.error ? `${line} · 退出异常：${firstLine(facts.error)}` : line;
}
function frozenLine(dataRoot: string, workspace: string) {
  let count = 0, first = '', after: number | undefined, through: number | undefined;
  try {
    do {
      const page = readQueue(dataRoot, { after, through, limit: 200 });
      for (const item of page.items) if (item.target.workspace === workspace && item.status === 'frozen') {
        if (!count) first = firstLine(item.input);
        count++;
      }
      through = page.through; after = page.next ?? undefined;
    } while (after);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '⧗ 冻结项未能读取 · unknown';
  }
  return count ? `⧗ ${count} 项已冻结 · 「${first}」· 不会自动接入` : undefined;
}
/** 只计已取得的成功 edit/write 结果，不扫描工作区、不解析 bash 或检查输出。 */
function fileSummary(root: string, runId: string, workspace: string) {
  const pending = new Map<string, { tool: 'edit' | 'write'; path?: string; added?: number; removed?: number }>();
  const files = new Set<string>();
  let added = 0, removed = 0, incomplete = false, after = 0;
  try {
    for (;;) {
      const page = readRunRecords(root, runId, { after, limit: 50, kinds: ['tool.intent', 'tool.result', 'tool.error', 'file.write-intent'] });
      for (const ref of page.records) {
        after = ref.seq;
        const data = JSON.parse(readObject(root, ref.ref).toString());
        if (ref.kind === 'tool.intent') {
          if (data.tool === 'edit' || data.tool === 'write') pending.set(data.attemptId, { tool: data.tool, path: typeof data.args?.path === 'string' ? resolve(workspace, data.args.path) : undefined });
        } else if (ref.kind === 'file.write-intent') {
          const item = pending.get(data.toolAttempt?.attemptId), acquired = data.acquired;
          if (!item || !acquired) continue;
          if (typeof acquired.path === 'string') item.path = resolve(workspace, acquired.path);
          if (item.tool === 'write' && typeof acquired.content === 'string' && (acquired.previous === null || typeof acquired.previous === 'string')) {
            const changes=writeLineChanges(acquired);item.added=changes.added;item.removed=changes.removed;
          }
        } else {
          const item = pending.get(data.attemptId);
          if (!item) continue;
          pending.delete(data.attemptId);
          if (ref.kind === 'tool.error' || data.result?.isError === true) continue;
          if (item.path) files.add(item.path); else incomplete = true;
          if (item.tool === 'edit' && typeof data.result?.details?.diff === 'string') {
            const changes=editLineChanges(data.result.details.diff);item.added=changes.added;item.removed=changes.removed;
          }
          if (item.added === undefined || item.removed === undefined) incomplete = true;
          else { added += item.added; removed += item.removed; }
        }
      }
      if (!page.more) break;
    }
  } catch { return '文件统计 unknown'; }
  if (!files.size) return incomplete ? '文件统计 unknown' : undefined;
  return `${files.size} 文件 +${added} −${removed}${incomplete ? ' · 统计不完整' : ''}`;
}

async function summaryLines(dataRoot: string, facts: ExitSummaryFacts): Promise<string[]> {
  const chains = readSessionChains(dataRoot), membership = facts.runId && chains.sessionOfRun(facts.runId);
  const session = membership ? chains.session(membership.id) : null;
  const label = session ? readDisplayIndex(dataRoot).label('session', session.id) : undefined;
  const lines = [`◆ pi-durio 已退出${label ? ` · 会话 ${label}` : ''} · 用时 ${elapsed(facts.elapsedMs)}`];
  if (session) {
    const tail = session.tail, prefix = `${session.kind === 'improve' ? 'improve · ' : ''}任务 ${tail.number}`;
    if (tail.status === 'unknown') lines.push(`◈ ${prefix} 已中断 · 待恢复核对`);
    else if (tail.status === 'running' || tail.status === 'accepted') lines.push(`◈ ${prefix} 未结束 · 待恢复核对`);
    else {
      const [glyph, state] = tail.status === 'completed' ? ['✓', '完成'] : tail.status === 'failed' ? ['✗', '失败'] : ['◇', tail.status === 'ended' ? '已结束' : '已中止'];
      lines.push(`${glyph} ${prefix} ${state}${tail.input ? ` · ${firstLine(tail.input)}` : ''}`);
    }
    const changes = fileSummary(dataRoot, tail.runId, session.workspace ?? facts.workspace);
    if (changes) lines[lines.length - 1] += ` · ${changes}`;
  }
  const frozen = frozenLine(dataRoot, facts.workspace);
  if (frozen) lines.push(frozen);
  if (facts.draftLines) lines.push(`◇ 草稿已保存 · ${facts.draftLines} 行 · 下次 /restore 恢复`);
  if (facts.eval) {
    const evaluation = facts.eval, source=evaluation.source, plan = source?.label??readDisplayIndex(dataRoot).label('eval-plan', evaluation.planId);
    const state = evaluation.state === 'stopped' ? '已停止于' : '停止未确认于';
    lines.push(`eval ${plan}${source?.origin?` · ${source.origin.label}`:''} ${state} trial ${evaluation.trial}/${evaluation.total} · ${formatCostTotals(evaluation.cost)}`);
  }
  if (session) {
    try {
      const usage = sumUsage(chains.contextRunIds(session.tailRunId).map(id => new RunView(dataRoot, id).usage()));
      const knownCost=Object.keys(usage.totals.amounts).length?formatCostTotals({amounts:usage.totals.amounts,unknownRequests:0,partial:false}):usage.totals.unknownRequests||usage.totals.partial?'unknown':formatCostTotals(usage.totals);
      lines.push(`◇ 本会话 ${tokenCount(usage.tokens)} tok ${knownCost}（${COST_ESTIMATE_NOTICE}）${usage.totals.unknownRequests?` · +${usage.totals.unknownRequests} unknown`:''}${usage.totals.partial?' · partial':''}`);
    } catch { lines.push('◇ 本会话用量 unknown'); }
  }
  const cleanupSession = facts.cleanup && chains.sessionOfRun(facts.cleanup.runId);
  const cleanupLabel = cleanupSession ? readDisplayIndex(dataRoot).label('session', cleanupSession.id) : label;
  lines.push(cleanupLine(facts, cleanupLabel));
  if (session) {
    const continuation = readContinuation(dataRoot, session.id, { chains });
    let next = '';
    if (continuation?.state === 'ready' && (!facts.cleanupAttempted || facts.cleanup) && tuiCleanupStatus({cleanupResult:facts.cleanup,eval:facts.eval,evalCleanup:facts.evalCleanup,batchCleanup:facts.batchCleanup}).cleanup==='confirmed') {
      const lock = session.workspace ? await probeWelcomeLock(session.workspace, continuation.coding) : undefined;
      if (lock?.state === 'free' || lock?.state === 'readonly') next = `继续  pi-durio resume ${label}     `;
    } else if (continuation?.state === 'recovery') next = `恢复核对  pi-durio resume ${label}     `;
    lines.push(`${next}原文  pi-durio show ${label} --trace`);
  }
  return lines;
}

/** 原缓冲区恢复后再调用；原文不可取得不应令已经完成的退出挂起或伪造成功。 */
export async function exitSummary(dataRoot: string, facts: ExitSummaryFacts, columns: number): Promise<string[]> {
  let lines: string[];
  try { lines = await summaryLines(dataRoot, facts); }
  catch (error) {
    lines = [`◆ pi-durio 已退出 · 用时 ${elapsed(facts.elapsedMs)}`, '◈ 摘要记录不可取得 · unknown'];
    if (facts.draftLines) lines.push(`◇ 草稿已保存 · ${facts.draftLines} 行 · 下次 /restore 恢复`);
    lines.push(cleanupLine({ ...facts, error: facts.error ?? String(error) }));
  }
  const width = Math.max(1, Math.floor(columns));
  return lines.map(line => truncateToWidth(firstLine(line), width));
}

/** 首版 TUI 退出码映射；未确认清理仍由 exitHostIfUnconfirmed 负责有界退出。 */
export function tuiCleanupStatus(exit:{result?:RunResult;cleanupResult?:RunResult;eval?:EvalExitFact;evalCleanup?:EvalCleanupReceipt;batchCleanup?:ImproveCleanupReceipt}) {
  const b=exit.batchCleanup;return {cleanup:exit.eval?.cleanup==='unknown'||exit.evalCleanup?.cleanup==='unknown'||(exit.cleanupResult??exit.result)?.cleanup==='unknown'||!!b&&(b.owner!=='released'||b.storage==='unknown'||b.workspaces.some(w=>!w.released))?'unknown' as const:'confirmed' as const};
}
export function tuiExitCode(exit: { result?: RunResult;cleanupResult?:RunResult; error?: string; eval?:EvalExitFact;evalCleanup?:EvalCleanupReceipt;batchCleanup?:ImproveCleanupReceipt }) {
  const result = exit.result;
  if(tuiCleanupStatus(exit).cleanup==='unknown')return 75;
  return exit.error ? 1 : result?.status === 'unknown' ? 75 : result?.status === 'aborted' ? 130 : result?.status === 'failed' ? 1 : result?.controls?.exitCode ?? 0;
}

/** 与 1b 空闲底栏相同：当前 run 的完整上下文链，含分支会话的共同前序。 */
export function exitCostSummary(dataRoot: string, result: RunResult) {
  const chains = readSessionChains(dataRoot), session = chains.sessionOfRun(result.runId);
  let amount: string;
  try { amount = formatCostTotals(sumUsage(chains.contextRunIds(result.runId).map(id => new RunView(dataRoot, id).usage())).totals); }
  catch { amount = 'unknown'; }
  const label = session ? readDisplayIndex(dataRoot).label('session', session.id) : '未记录';
  return `本次会话 ${label} 费用 ${amount}（${COST_ESTIMATE_NOTICE}）`;
}
