import { DetailPage } from './detail-page.js';
export { DetailPage, type DetailSummary } from './detail-page.js';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId, EntryId, LiveState, SubmissionRecord } from '@earendil-works/pi-durable';
import { digest } from './evidence.js';
import type { RecoveryRecords } from './recovery-facts.js';
import type { RecoveryDecision, RecoveryTool } from './recovery.js';
import { conversationDocument, scanTasks, scanSubmissions, withProjectionIndex, type StorageReader } from './storage-projection.js';

export interface RecoveryPage { offset?: number; limit?: number; snapshotId?: string }
export const boundedText = (text: string, max = 1024) => text.length <= max ? text : `${text.slice(0, max)} [display truncated; sha256:${digest(text)}]`;
function toolArguments(args: unknown, assistant: number, callId: string, taskId: number, checkpoint: boolean) {
  const original = JSON.stringify(args);
  return original && Buffer.byteLength(original) > 2048 ? {
    reference: { kind: checkpoint ? 'durable-task-checkpoint' : 'durable-entry', ...(checkpoint ? { taskId } : { entryId: assistant }), callId: boundedText(callId, 256) },
    bytes: Buffer.byteLength(original), sha256: digest(original),
    display: 'Use readRecoveryDetail with this snapshot and the referenced Entry or Task ID for original JSON pages',
  } : args;
}
export function* recoverySteerRequests(records: RecoveryRecords, accepted: any, runId: string) {
  for (const record of records) {
    if (record.kind !== 'control.accepted') continue;
    const data = record.data as any;
    if (data.kind === 'steer' && data.target?.runId === runId && data.taskId === accepted.taskId) yield data.requestId as string;
  }
}
type CompactionDetail = { taskId: number; reason: string; status: string; submissionId?: number; submissionStatus?: string; entryId?: number };
/** All decision booleans/counts come from the complete scan. Display pages cannot grant authority. */
export async function projectRecovery(storage: StorageReader, records: RecoveryRecords, accepted: any, started: any, runId: string, page: RecoveryPage, resolutions: NonNullable<RecoveryDecision['resolutions']>, reason: (value: string) => void) {
  return withProjectionIndex(async index => {
    index.exec(`CREATE TABLE steer(id TEXT PRIMARY KEY); CREATE TABLE compact(id INTEGER PRIMARY KEY); CREATE TABLE compact_submission(id INTEGER PRIMARY KEY);
      CREATE TABLE owned(id INTEGER PRIMARY KEY); CREATE TABLE facts(task INTEGER, seq INTEGER, kind TEXT); CREATE INDEX facts_task ON facts(task,seq);
      CREATE TABLE resolution(task INTEGER PRIMARY KEY, body TEXT); CREATE TABLE attempts(id TEXT PRIMARY KEY, dispatched INTEGER DEFAULT 0, not_dispatched INTEGER DEFAULT 0, reported INTEGER DEFAULT 0);`);
    for (const requestId of recoverySteerRequests(records, accepted, runId)) index.prepare('INSERT OR IGNORE INTO steer VALUES(?)').run(requestId);
    for (const record of records) {
      if (record.kind === 'compaction.task') index.prepare('INSERT OR IGNORE INTO compact VALUES(?)').run((record.data as any).taskId);
      if (['tool.intent', 'tool.dispatch', 'tool.result', 'tool.error'].includes(record.kind)) {
        const data = record.data as any;
        if (Number.isSafeInteger(data.durableTaskId)) index.prepare('INSERT INTO facts VALUES(?,?,?)').run(data.durableTaskId, record.seq, record.kind);
      }
      if (record.kind === 'recovery.decision') {
        const decision = (record.data as any).decision;
        for (const resolution of decision.resolutions ?? []) index.prepare('INSERT OR REPLACE INTO resolution VALUES(?,?)').run(resolution.taskId, JSON.stringify({ decisionId: decision.id, choice: resolution.choice, reason: boundedText(resolution.reason) }));
      }
      if (['model.intent', 'model.dispatch', 'model.dispatch-failed', 'model.response'].includes(record.kind)) {
        const data = record.data as any;
        index.prepare('INSERT OR IGNORE INTO attempts(id) VALUES(?)').run(data.attemptId);
        if (record.kind === 'model.dispatch' && data.transportEntered === true) index.prepare('UPDATE attempts SET dispatched=1 WHERE id=?').run(data.attemptId);
        if (record.kind === 'model.dispatch-failed' && data.dispatched === false && data.attemptDispatched === false) index.prepare('UPDATE attempts SET not_dispatched=1 WHERE id=?').run(data.attemptId);
        if (record.kind === 'model.response' && data.usage === 'reported') index.prepare('UPDATE attempts SET reported=1 WHERE id=?').run(data.attemptId);
      }
    }
    const tools = new DetailPage<RecoveryTool>(page.offset, page.limit), compactions = new DetailPage<CompactionDetail>(page.offset, page.limit);
    const unknownModelAttempts = new DetailPage<string>(page.offset, page.limit), pending = new DetailPage<{ kind: string; id: number; status: string }>(page.offset, page.limit);
    let modelAttempts = 0;
    for (const record of records) if (record.kind === 'model.intent') {
      modelAttempts++;
      const attemptId = (record.data as any).attemptId;
      const state = index.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId)!;
      if (!state.reported && (!state.not_dispatched || state.dispatched)) unknownModelAttempts.add(boundedText(attemptId));
    }
    let taskCount = 0, submissionCount = 0, compactionFrozen = false;
    const conversationId = started?.conversationId as ConversationId | undefined;
    const submission = conversationId === undefined ? undefined : await storage.submissionByRequest(conversationId, accepted.taskId, context);
    const main = submission?.type === 'input' ? submission : undefined;
    // Resolve every known compaction's exact output via public by-ID reads, including late pages.
    for await (const task of scanTasks(storage)) {
      if (task.kind !== 'pi.compaction' || task.version !== 1 || task.conversationId !== conversationId || !index.prepare('SELECT 1 FROM compact WHERE id=?').get(task.id)) continue;
      const result = task.state.status === 'terminal' && task.state.outcome.status === 'completed' ? task.state.outcome.result as any : undefined;
      const candidate = result?.submissionId === undefined ? undefined : await storage.submission(result.submissionId, context);
      const summary = candidate?.type === 'write' && candidate.requestId === `compaction:${task.id}` && candidate.conversationId === task.conversationId ? candidate : undefined;
      if (summary) index.prepare('INSERT OR IGNORE INTO compact_submission VALUES(?)').run(summary.id);
      const detail = { taskId: task.id, reason: boundedText(String((task.input as any).reason)), status: task.state.status === 'terminal' ? task.state.outcome.status : task.state.status, ...(summary ? { submissionId: summary.id, submissionStatus: summary.status, entryId: summary.entry } : {}), ...(result?.entryId !== undefined ? { entryId: result.entryId } : {}) };
      compactions.add(detail);
      if (!['completed', 'failed', 'aborted'].includes(detail.status) || detail.submissionStatus === 'queued') compactionFrozen = true;
    }
    let placed: SubmissionRecord | undefined, otherSubmission = false;
    for await (const item of scanSubmissions(storage)) {
      submissionCount++;
      const owned = item.conversationId === conversationId && (item.id === main?.id || item.type === 'input' && !!index.prepare('SELECT 1 FROM steer WHERE id=?').get(item.requestId ?? null));
      if (owned) { index.prepare('INSERT OR IGNORE INTO owned VALUES(?)').run(item.id); if (item.status === 'placed') placed ??= item; }
      if (item.status === 'queued' || item.status === 'placed') {
        // Pending report is populated in task/submission order below for a stable cursor.
        if (!owned && !index.prepare('SELECT 1 FROM compact_submission WHERE id=?').get(item.id)) otherSubmission = true;
      }
    }
    const live = conversationId === undefined ? undefined : (await conversationDocument(storage, conversationId, 'pi.live'))?.value as LiveState | undefined;
    const controlledRun = live?.run?.inputs.length && live.run.inputs.every(id => !!index.prepare('SELECT 1 FROM owned WHERE id=?').get(id)) ? live.run.taskId : undefined;
    const protocol = records.findLast(r => r.kind === 'execution.config')?.data as any;
    const gap = records.some(r => r.kind === 'evidence.gap');
    const currentResolutions = new Map(resolutions.map(resolution => [resolution.taskId, resolution]));
    let matchedResolutions = 0, unresolvedTools = 0, unknownTools = 0, readOnly = false;
    let unsupported = false, outside = false, aborted = false, checkpoint = false;
    const toolCounts = { committed: 0, 'completed-uncommitted': 0, 'not-dispatched': 0, unknown: 0 };
    for await (const task of scanTasks(storage)) {
      taskCount++;
      if (task.state.status !== 'terminal') {
        pending.add({ kind: task.kind, id: task.id, status: task.state.status });
        const compact = task.kind === 'pi.compaction' && task.version === 1 && task.conversationId === conversationId && !!index.prepare('SELECT 1 FROM compact WHERE id=?').get(task.id);
        if (!compact) {
          if (task.conversationId !== conversationId || task.background || !['pi.generation', 'pi.tool'].includes(task.kind) || task.version !== 1) unsupported = true;
          if (task.kind === 'pi.generation' ? task.id !== controlledRun : task.owner !== controlledRun) outside = true;
          if (task.abortRequested) aborted = true;
          const state = 'checkpoint' in task.state ? task.state.checkpoint as any : undefined;
          if ('checkpoint' in task.state && (task.kind === 'pi.tool' ? !['call', 'execute'].includes(state?.phase) || state?.phase === 'execute' && state.replay !== 'unsafe' : !['prepare', 'request', 'retry', 'tools'].includes(state?.phase))) checkpoint = true;
        }
      }
      if (task.kind !== 'pi.tool') continue;
      const input = task.input as any;
      const assistant = Number.isSafeInteger(input.assistant) ? (await storage.entry(task.conversationId, input.assistant as EntryId, context))?.entry : undefined;
      const message = assistant?.model?.[0];
      const call = message?.role === 'assistant' ? message.content.find(part => part.type === 'toolCall' && part.id === input.callId) : undefined;
      const identityMissing = assistant?.kind !== 'pi.assistant' || !call || call.type !== 'toolCall';
      if (identityMissing) reason(`DURABLE_TOOL_IDENTITY_MISSING:${task.id}`);
      const toolCall = call?.type === 'toolCall' ? call : undefined;
      const outcome = task.state.outcome;
      const resultId = task.state.status === 'terminal' && outcome?.status === 'completed' ? (outcome.result as any)?.entryId : undefined;
      const result = Number.isSafeInteger(resultId) ? (await storage.entry(task.conversationId, resultId, context))?.entry : undefined;
      const committed = result?.kind === 'pi.tool-result' && result.model?.some(message => message.role === 'toolResult' && message.toolCallId === input.callId && message.toolName === toolCall?.name);
      if (task.state.status === 'terminal' && outcome?.status === 'completed' && !committed) reason(`DURABLE_TOOL_OUTCOME_MISSING:${task.id}`);
      const hostResult = !!index.prepare("SELECT 1 FROM facts WHERE task=? AND kind='tool.result' LIMIT 1").get(task.id);
      const dispatched = !!index.prepare("SELECT 1 FROM facts WHERE task=? AND kind='tool.dispatch' LIMIT 1").get(task.id);
      const state = 'checkpoint' in task.state ? task.state.checkpoint as any : undefined;
      const fact: RecoveryTool['fact'] = identityMissing ? 'unknown' : committed ? 'committed' : hostResult ? 'completed-uncommitted' : state?.phase === 'call' || !dispatched && protocol?.recoveryProtocol === 1 && !gap ? 'not-dispatched' : 'unknown';
      const previous = index.prepare('SELECT body FROM resolution WHERE task=?').get(task.id);
      const resolution = previous ? JSON.parse(String(previous.body)) : undefined;
      toolCounts[fact]++;
      if (fact === 'unknown') { unknownTools++; if (currentResolutions.has(task.id)) matchedResolutions++; if (!resolution && !currentResolutions.has(task.id)) unresolvedTools++; }
      if (fact === 'completed-uncommitted' || resolution && resolution.choice !== 'retry') readOnly = true;
      const evidence = new DetailPage<number>();
      for (const record of index.prepare('SELECT seq FROM facts WHERE task=? ORDER BY seq').iterate(task.id)) evidence.add(Number(record.seq));
      tools.add({ taskId: task.id, callId: boundedText(String(input.callId),256), tool: boundedText(toolCall?.name ?? '<identity-missing>',256), args: toolArguments(state?.phase === 'execute' ? state.arguments : toolCall?.arguments, input.assistant, input.callId, task.id, state?.phase === 'execute'), fact, evidence: evidence.items, evidenceSummary: evidence.summary(), assistantEntryId: input.assistant, ...(resolution ? { resolution } : {}) });
    }
    for await (const item of scanSubmissions(storage)) if (item.status === 'queued' || item.status === 'placed') pending.add({ kind: 'submission', id: item.id, status: item.status });
    if (!started || !main) reason('CROSS_STORE_GAP: missing run/conversation/submission identity; never resend an unknown admission');
    if (otherSubmission) reason('OTHER_PENDING_SUBMISSION');
    if (compactionFrozen) reason('COMPACTION_FROZEN: automatic/manual tasks and unapplied summaries remain quarantined; explicitly end this source before new work');
    if (unsupported) reason('OTHER_PENDING_TASK_OR_UNSUPPORTED_DEFINITION');
    if (outside) reason('OTHER_PENDING_TASK_OUTSIDE_ACCEPTED_RUN');
    if (aborted) reason('DURABLE_ABORT_INTENT_PRESERVED');
    if (checkpoint) reason('UNSUPPORTED_EXECUTION_CHECKPOINT');
    return { tools, compactions, unknownModelAttempts, pending, taskCount, submissionCount, main, placed, modelAttempts, toolCounts, unknownTools, unresolvedTools, matchedResolutions, readOnly, agent: conversationId === undefined ? undefined : (await conversationDocument(storage, conversationId, 'pi.agent'))?.value };
  });
}
