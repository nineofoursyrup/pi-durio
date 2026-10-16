import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readObject, readQueue, type QueueItemFact } from './evidence.js';
import { readRunRecords } from './query.js';
import { readSessionChains, type SessionChains, type SessionTaskStatus } from './session-chain.js';
import { readDisplayIndex } from './display-number.js';
import { recordedExecutionVersion, versionChanged, type ExecutionVersion } from './execution-version.js';

/**
 * 接续的可用条件（U13、#62 Q5）：`resume`、会话列表 `c`、退出摘要“继续”、1b 空闲 Enter 共用。
 * 只接续链尾；执行版本不是条件（R6），只标出是否已变。只读：不取锁、不调度。
 * 被其他进程占用由调用方的锁探测判断（异步），不在这里。
 */
export type Continuation =
  /** 可以接续：下一任务以 `tailRunId` 为上下文，成为任务 `number + 1`。 */
  | { state: 'ready'; sessionId: string; tailRunId: string; number: number; coding: boolean; versionChanged: boolean | null }
  /** 链尾待恢复核对（有未知、清理未确认，或没有关闭记录）：打开 1c，不算接续。 */
  | { state: 'recovery'; sessionId: string; tailRunId: string; number: number; coding: boolean; status: SessionTaskStatus }
  /** 不能接续；`reason` 是写在前序任务行位置的一句。`elsewhere` = 其他工作区的会话。 */
  | { state: 'blocked'; sessionId: string; tailRunId: string; number: number; coding: boolean; reason: string; elsewhere?: true };

export const CONTINUE_TAIL_UNFINISHED = '不能接续 · 链尾任务未完成 · 新任务将开启新会话';
export const CONTINUE_CLEANED = '不能接续 · 会话原文已清理';
export const VERSION_CHANGED_HINT = '◇ 执行版本已变 · 下一任务按当前版本运行';
export const COMPACT_VERSION_CHANGED = '不能压缩 · 链尾执行版本已变 · 完成一个新任务后可压缩';
export const continueQueued = (n: number) => `不能接续 · 有 ${n} 项排队请求未处理 · /queue`;
export const continueElsewhere = (session: string) => `其他工作区的会话 · pi-durio resume ${session}`;

const OPEN_QUEUE = new Set(['pending', 'dispatching', 'frozen']);
function decoded(root: string, runId: string, kinds: string[]) {
  const ref = readRunRecords(root, runId, { tail: true, limit: 1, kinds }).records[0];
  return ref ? { kind: ref.kind, data: JSON.parse(readObject(root, ref.ref).toString()) } : undefined;
}

/**
 * `sessionId` 是会话身份（会话首任务的 durable sessionId；`s-` 号先解析）。
 * - `workspace`：当前工作区（realpath）；给出时，其他工作区的会话为 blocked + elsewhere。
 * - `busy`：本进程忙或有待处理的恢复核对时的原因，由调用方写好（如 `不能接续 · 当前任务运行中`）。
 * - `current`：取现在的执行版本（只在 ready 时调用，构建摘要较重）；给出时 ready 带 `versionChanged`，否则为 null。
 * 未知会话返回 null。
 */
export function readContinuation(root: string, sessionId: string, options: { workspace?: string; busy?: string; current?: () => ExecutionVersion | null; chains?: SessionChains } = {}): Continuation | null {
  const chains = options.chains ?? readSessionChains(root), session = chains.session(sessionId);
  if (!session) return null;
  const tail = session.tail, accepted = decoded(root, tail.runId, ['task.accepted'])?.data;
  const base = { sessionId, tailRunId: tail.runId, number: tail.number, coding: accepted?.authorization?.execution === 'trusted-local-coding' };
  const blocked = (reason: string, elsewhere?: true): Continuation => ({ state: 'blocked', ...base, reason, ...(elsewhere ? { elsewhere } : {}) });
  if (options.busy) return blocked(options.busy);
  if (options.workspace !== undefined && session.workspace !== options.workspace) return blocked(continueElsewhere(readDisplayIndex(root).label('session', sessionId)), true);
  if (tail.status === 'running' || tail.status === 'accepted' || tail.status === 'unknown') return { state: 'recovery', ...base, status: tail.status };
  if (tail.status !== 'completed') return blocked(CONTINUE_TAIL_UNFINISHED);
  // run.closed 或恢复后的 recovery.closed（与 runtime 接续检查同一来源）。
  const closed = decoded(root, tail.runId, ['run.closed', 'recovery.closed']), result = closed?.kind === 'recovery.closed' ? closed.data.result : closed?.data;
  if (result?.cleanup !== 'confirmed') return { state: 'recovery', ...base, status: tail.status };
  if (session.kind === 'improve' || accepted?.kind === 'improve') return blocked(CONTINUE_TAIL_UNFINISHED);
  let queued = 0, after: number | undefined, through: number | undefined;
  do {
    const page = readQueue(root, { after, through, limit: 200 });
    queued += page.items.filter((item: QueueItemFact) => OPEN_QUEUE.has(item.status) && chains.sessionOfRun(item.target.runId)?.id === sessionId).length;
    after = page.next ?? undefined; through = page.through;
  } while (after);
  if (queued) return blocked(continueQueued(queued));
  // 快照取不到 = 会话原文已清理（只看对象是否在且字节数一致，不整份读入）。
  const snapshot = decoded(root, tail.runId, ['context.snapshot'])?.data;
  try { if (!snapshot || statSync(join(root, 'objects', snapshot.messages.sha256)).size !== snapshot.messages.bytes) return blocked(CONTINUE_CLEANED); }
  catch { return blocked(CONTINUE_CLEANED); }
  return { state: 'ready', ...base, versionChanged: options.current ? versionChanged(recordedExecutionVersion(root, tail.runId), options.current()) : null };
}

/** run 的执行版本是否与它的上下文来源（前一任务）不同；没有前一任务或任一侧未记录时为 null。会话层与 2a 的“执行版本已变”。 */
export function runVersionChanged(root: string, runId: string, chains: SessionChains = readSessionChains(root)) {
  const ids = chains.contextRunIds(runId), previous = ids.at(-2);
  return previous ? versionChanged(recordedExecutionVersion(root, previous), recordedExecutionVersion(root, runId)) : null;
}
