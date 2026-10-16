import { openHostReadonly, readObject, readQueue, type QueueItemFact, type ControlTarget } from './evidence.js';
import { readSessionChains } from './session-chain.js';
import { readContinuation } from './continuation.js';
import { readRunRecords } from './query.js';
import { currentExecutionVersion, recordedExecutionVersion, versionChanged, type ExecutionVersion } from './execution-version.js';
import { executionConfig } from './execution-config.js';
import { upperBoundAmount } from './cost-estimate.js';
import type { RecoveryAuthorization } from './recovery.js';

export const OPEN_QUEUE = new Set<QueueItemFact['status']>(['pending', 'dispatching', 'frozen']);
export interface QueueEntry { item: QueueItemFact; sessionId?: string; taskNumber?: number }

/** All open admissions at one snapshot; a fact page is never the complete queue. */
export function readOpenQueue(root: string, workspace: string, currentRunId?: string): QueueEntry[] {
  const items: QueueItemFact[] = [];
  let after: number | undefined, through: number | undefined;
  do {
    const page = readQueue(root, { after, through, limit: 200 });
    items.push(...page.items.filter(item => item.target.workspace === workspace && OPEN_QUEUE.has(item.status)));
    after = page.next ?? undefined; through = page.through;
  } while (after);
  const chains = readSessionChains(root, { through }), current = currentRunId && chains.sessionOfRun(currentRunId)?.id;
  return items.map(item => {
    const of = chains.sessionOfRun(item.target.runId);
    return { item, sessionId: of?.id, taskNumber: of?.number };
  }).sort((a, b) => Number(!!current && b.sessionId === current) - Number(!!current && a.sessionId === current) || a.item.acceptedSeq - b.item.acceptedSeq);
}

export function latestPending(entries: readonly QueueEntry[]): QueueItemFact | undefined {
  return entries.filter(entry => entry.item.status === 'pending').reduce<QueueItemFact | undefined>((latest, entry) =>
    !latest || entry.item.acceptedSeq > latest.acceptedSeq ? entry.item : latest, undefined);
}

function latest(root: string, runId: string, kinds: string[]) {
  const ref = readRunRecords(root, runId, { kinds, tail: true, limit: 1 }).records[0];
  return ref ? { ...ref, data: JSON.parse(readObject(root, ref.ref).toString()) } : undefined;
}

export function queueWithdrawalBlocked(root: string, item: QueueItemFact): string | undefined {
  return OPEN_QUEUE.has(item.status) && latest(root, item.target.runId, ['recovery.ended']) ? '旧工作已结束 · 只能查看和复制' : undefined;
}

/** A saved dispatch intent with no final linking receipt is never permission to repeat its input. */
export function queueWasDispatched(root: string, item: QueueItemFact): boolean {
  if (item.status === 'dispatching') return true;
  const db = openHostReadonly(root);
  try {
    for (const row of db.prepare("SELECT kind,body FROM records WHERE kind IN ('task.accepted','control.receipt','compaction.started') AND seq>? ORDER BY seq").iterate(item.acceptedSeq)) {
      const data = JSON.parse(readObject(root, JSON.parse(String(row.body))).toString());
      if (row.kind === 'task.accepted' && (data.queueRequestId === item.requestId || data.improveRequestId === item.requestId || data.replacesQueueRequestId === item.requestId)) return true;
      if (data.requestId === item.requestId && (row.kind === 'compaction.started' || data.status === 'dispatching')) return true;
    }
    return false;
  } finally { db.close(); }
}

export type QueueRoute = 'reattach' | 'replace-follow-up' | 'relaunch-improve';
/** Confirmation binds the source receipt, current tail, current execution version and the new authorization. */
export interface QueueConfirmation {
  requestId: string; receiptSeq: number; target: ControlTarget;
  sessionId: string; tailRunId: string; route: QueueRoute; version: ExecutionVersion;
  authorization: RecoveryAuthorization;
}
export type QueueReattachment =
  | { state: 'blocked'; reason: string; code: string }
  | { state: 'ready'; confirmation: QueueConfirmation; taskNumber: number; coding: boolean };

/** U13/#62 availability, shared by the view and the actual writer-locked host decision. */
export function readQueueReattachment(root: string, item: QueueItemFact, options: Pick<RecoveryAuthorization, 'workspace' | 'mode' | 'toolEnvironment'> & { busy?: string }): QueueReattachment {
  const blocked = (reason: string, code: string): QueueReattachment => ({ state: 'blocked', reason, code });
  if (item.kind === 'steer') return blocked('steer 只能复制后重新提交', 'QUEUE_REATTACH_NOT_APPLICABLE');
  if (item.status === 'applied') return blocked('已接入，不能重复提交', 'QUEUE_ALREADY_APPLIED');
  if (item.status === 'withdrawn') return blocked('已撤回 · 可复制后重新提交', 'QUEUE_ALREADY_WITHDRAWN');
  if (item.target.workspace !== options.workspace) return blocked('其他工作区的请求 · 请在原工作区处理', 'CONTROL_TARGET_CHANGED');
  if (options.busy) return blocked(options.busy.replace(/^不能接续 · /, ''), 'QUEUE_PROCESS_BUSY');
  const chains = readSessionChains(root), of = chains.sessionOfRun(item.target.runId), session = of && chains.session(of.id);
  if (!of || !session) return blocked('原会话未记录', 'QUEUE_SOURCE_NOT_FOUND');
  if (latest(root, item.target.runId, ['recovery.ended'])) return blocked('旧工作已结束 · 可复制后重新提交', 'QUEUE_SOURCE_ENDED');
  const closed = latest(root, item.target.runId, ['run.closed', 'recovery.closed']), source = closed?.data.result ?? closed?.data;
  if (source?.status === 'failed' || source?.status === 'aborted') return blocked('源任务未完成 · 可复制后重新提交', 'QUEUE_SOURCE_NOT_COMPLETED');
  if (source?.status !== 'completed' || source.cleanup !== 'confirmed') return blocked('会话待恢复核对', 'QUEUE_SOURCE_NOT_COMPLETED');
  const snapshot = latest(root, item.target.runId, ['context.snapshot'])?.data;
  try { if (!snapshot) return blocked('会话原文已清理', 'QUEUE_CONTEXT_UNAVAILABLE'); readObject(root, snapshot.messages); }
  catch { return blocked('会话原文已清理', 'QUEUE_CONTEXT_UNAVAILABLE'); }
  const continuation = readContinuation(root, of.id, { workspace: options.workspace, chains, queueBefore: item.acceptedSeq });
  if (!continuation || continuation.state === 'recovery') return blocked('会话待恢复核对', 'QUEUE_RECOVERY_REQUIRED');
  if (continuation.state === 'blocked') {
    const n = /有 (\d+) 项排队请求未处理/.exec(continuation.reason)?.[1];
    if (n) return blocked(`前面还有 ${n} 项未处理`, 'QUEUE_PREDECESSOR_UNRESOLVED');
    return blocked(continuation.reason.replace(/^不能接续 · /, ''), continuation.reason.includes('原文已清理') ? 'QUEUE_CONTEXT_UNAVAILABLE' : 'QUEUE_SOURCE_NOT_COMPLETED');
  }
  if (queueWasDispatched(root, item)) return blocked('上次派发结果未知', 'QUEUE_PREVIOUS_DISPATCH_UNKNOWN');
  if (item.status !== 'frozen') return blocked('正在等待接入 · 可撤回', 'QUEUE_REATTACH_NOT_APPLICABLE');
  const version = currentExecutionVersion({ dataRoot: root, workspace: options.workspace, coding: continuation.coding, mode: options.mode, toolEnvironment: options.toolEnvironment });
  const changed = versionChanged(recordedExecutionVersion(root, item.target.runId), version);
  if (changed === null) return blocked('执行版本未记录 · 可复制后重新提交', 'QUEUE_VERSION_UNAVAILABLE');
  if (changed && item.kind === 'compact') return blocked('执行版本已变 · 可撤回', 'QUEUE_EXECUTION_VERSION_CHANGED');
  const authorization: RecoveryAuthorization = { workspace: options.workspace, mode: options.mode, tools: continuation.coding ? ['read', 'write', 'edit', 'bash'] : ['read'], ...(options.toolEnvironment ? { toolEnvironment: options.toolEnvironment } : {}) };
  return { state: 'ready', taskNumber: continuation.number + 1, coding: continuation.coding,
    confirmation: { requestId: item.requestId, receiptSeq: item.receipt.seq, target: item.target, sessionId: of.id, tailRunId: continuation.tailRunId,
      route: !changed ? 'reattach' : item.kind === 'follow-up' ? 'replace-follow-up' : 'relaunch-improve', version, authorization } };
}

/** Eight provider requests, each reserving the model's full input context plus maximum output, at peak output price. */
export function queueBudget() {
  const model = executionConfig(false, 'live').model, tokens = 8 * (model.contextWindow + model.maxTokens);
  return { requests: 8, tokens, amount: upperBoundAmount(tokens, model.provider, model.id) };
}
