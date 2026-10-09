import { dispatchProvider, type ProviderBoundary } from './provider-boundary.js';
import { realpath, mkdir, chmod } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createModels, type AssistantMessage, type Models, type AssistantMessageEvent, type Usage } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, GenerationTask, hook, type Conversation, type UsageState, type Storage, type ToolRegistration, type ToolDiagnostic } from '@earendil-works/pi-durable';
import { createReadTool, createWriteTool, createEditTool, createBashTool } from '@earendil-works/pi-durable/tools';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Evidence, readObject, readQueue, type BlobRef, type QueueItemFact, type FaultInjector } from './evidence.js';
import { TaskControl, RunControls, findQueueItem, validControlId, previousQueueDecision, type QueueDecision } from './control.js';
import { acquireOwner } from './ownership.js';
import { preflight, inspectSession } from './preflight.js';
import { readEnvironment } from './read-environment.js';
import { captureArtifact, verifyArtifact } from './artifact.js';
import { codingEnvironment, toolEnvironment, type ToolEnvironmentConfig, type ObservedFile } from './coding-environment.js';
import { acquireWorkspaceOwner, resolveWorkspaceRoot } from './workspace-ownership.js';
import { executionConfig, READ_INSTRUCTIONS, CODING_INSTRUCTIONS } from './execution-config.js';
import { prepareRecovery, recoveryRecords, type RecoveryOptions, type RecoveryDecision, type RecoveryPlan, type RecoveryReport } from './recovery.js';
export { readRun, readObject, readAcceptedTasks, readQueue } from './evidence.js';
export { TaskControl } from './control.js';
export type { ControlInput, QueueDecision } from './control.js';
export { inspectRecovery, checkRecovery, settleRecoveryOwners } from './recovery.js';
export type { RecoveryOptions, RecoveryDecision, RecoveryReport, RecoveryAuthorization } from './recovery.js';

const CTX = BACKGROUND_CONTEXT;
const INSTRUCTIONS = READ_INSTRUCTIONS;
export interface ReadTaskOptions {
  dataRoot: string; workspace: string; input: string;
  mode: 'live' | 'offline';
  /** Explicit offline transport boundary. Never silently fall back from a live provider. */
  transport?: typeof fetch;
  /** Trusted host dispatch capability; never accepted from model/tool data. */
  providerBoundary?: ProviderBoundary;
  /** Offline boundary verification only; normal product compaction defaults stay unchanged. */
  verificationCompaction?: { reserveTokens:number; keepRecentTokens:number };
  signal?: AbortSignal;
  /** stop persists abort intent; exit preserves unfinished work and closes. */
  cancellation?: 'stop' | 'exit';
  /** Host cleanup waiting policy, not a claim that work stops at the deadline. */
  cleanupTimeoutMs?: number;
  onObservation?: (event: { kind: string; runId: string }) => void;
  fault?: FaultInjector;
  /** Injectable credential source for embedding/tests; value is never recorded. */
  apiKey?: string;
  /** UI and headless share the same admission/withdrawal boundary. */
  control?:TaskControl;
}
export interface CodingTaskOptions extends ReadTaskOptions { toolEnvironment?: ToolEnvironmentConfig }
export type { ToolEnvironmentConfig } from './coding-environment.js';
export interface RunResult {
  runId: string; sessionId: string; taskId: string; mode: 'live' | 'offline';
  status: 'completed' | 'failed' | 'aborted' | 'unknown';
  answer?: string; reason?: string; observation: 'ok' | 'degraded'; cleanup: 'confirmed' | 'unknown';
  lifecycle?: { intent: 'stop' | 'exit' | null; disposition: 'completed' | 'failed' | 'aborted' | 'resumable' | 'needs-recovery'; cleanupTimeoutMs: number; storage: 'not-opened' | 'closed' | 'unknown'; owner: 'release-after-host-close' | 'retained'; remoteTermination: 'unknown' };
  executionCleanup?: { managedCommands: 'settled' | 'unknown'; started: number; settled: number; externalProcesses: 'unknown' };
  controls?:{status:'needs-decision';exitCode:75;requestIds:string[];reason:string};
  usage: { source: 'pi.usage'; scope: string; completeness: 'known' | 'partial' | 'unknown'; value: UsageState | null; cost: { kind: 'estimate'; currency: 'USD'; source: string; observedAt: string } };
}

async function validateDataRoot(path: string, workspace: string) {
  // Resolve the nearest existing ancestor before mkdir: even a rejected configuration
  // must not create directories inside the read-only project, including through aliases.
  let ancestor = resolve(path);
  const suffix: string[] = [];
  let canonical: string;
  for (;;) {
    try { canonical = join(await realpath(ancestor), ...suffix); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const rel = relative(workspace, canonical);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))) throw new Error('DATA_ROOT_INSIDE_PROJECT');
  return canonical;
}

export async function runReadTask(options: ReadTaskOptions): Promise<RunResult> {
  return runTask(options, false);
}

export async function runCodingTask(options: CodingTaskOptions): Promise<RunResult> {
  return runTask(options, true);
}

export function waitForRun(run: Promise<RunResult>, signal?: AbortSignal): Promise<RunResult> {
  // The upstream waiter cancels only this observation, never the underlying runtime.
  return awaitWithContext(run, signal ? withAbortSignal(signal, CTX) : CTX);
}

/** Explicit recovery is a checked reopening of the same run, not a new scheduler or task loop. */
export async function recoverRun(options: RecoveryOptions & { decision: RecoveryDecision; transport?: typeof fetch; apiKey?: string; signal?: AbortSignal; cancellation?: 'stop' | 'exit'; onObservation?: ReadTaskOptions['onObservation']; fault?: FaultInjector; control?:TaskControl }): Promise<RunResult | RecoveryReport> {
  const stable = { ...options, authorization: options.authorization && structuredClone(options.authorization), decision: structuredClone(options.decision) };
  const prepared = await prepareRecovery(stable);
  if (!prepared || typeof prepared !== 'object' || !('owner' in prepared)) return prepared as RunResult | RecoveryReport;
  const plan = prepared as RecoveryPlan;
  // Validation failures before executeTask takes the lease must still release it.
  if (!stable.authorization || (stable.authorization.mode === 'offline' && !options.transport) || (stable.authorization.mode === 'live' && options.transport) || (stable.authorization.mode === 'live' && !(options.apiKey ?? process.env.DEEPSEEK_API_KEY)?.trim())) {
    await plan.owner.release();
    throw new Error('RECOVERY_TRANSPORT_OR_AUTH_MISSING');
  }
  try {
    const handoff:RunHandoff={};
    const result=await executeTask({ ...options, dataRoot: plan.owner.path, workspace: stable.authorization.workspace, mode: stable.authorization.mode, toolEnvironment: stable.authorization.toolEnvironment,
      input: plan.accepted.input, cleanupTimeoutMs: plan.config.cleanupTimeoutMs,get cancellation(){return options.cancellation;} }, plan.coding, plan,undefined,handoff);
    if(handoff.pending?.length&&result.cleanup==='confirmed') {
      await freezeQueued(options.dataRoot,handoff.pending,'Recovery continuation does not automatically dispatch independent requests; explicitly inspect and decide');
      result.controls={status:'needs-decision',exitCode:75,requestIds:handoff.pending.map(item=>item.requestId),reason:'Recovery-bound independent requests remain frozen'};
    }
    return result;
  } catch(error) { if(!plan.adopted)await plan.owner.release();throw error; }
}

async function runTask(options: CodingTaskOptions, coding: boolean): Promise<RunResult> {
  let firstIntent: 'stop' | 'exit' | undefined;
  const latch = () => { firstIntent ??= options.cancellation ?? 'exit'; };
  options.signal?.addEventListener('abort', latch, { once: true });
  if (options.signal?.aborted) latch();
  const stable={...options,toolEnvironment:options.toolEnvironment&&structuredClone(options.toolEnvironment),get cancellation(){return firstIntent??options.cancellation;}};
  try {
    let handoff:RunHandoff={},result=await executeTask(stable,coding,undefined,undefined,handoff);
    const pending=[...(handoff.pending??[])];
    // Independent host requests only. Each request still uses the unmodified public Pi agent loop.
    while(result.status==='completed'&&result.cleanup==='confirmed'&&pending.length&&!options.signal?.aborted) {
      const item=pending.shift()!;
      if(item.kind!=='follow-up') {await freezeQueued(options.dataRoot,[item,...pending],'Management request awaits its installed handler and an explicit decision');break;}
      const current=findQueueItem(options.dataRoot,item.requestId);
      if(!current||current.status!=='pending')continue;
      const next:RunHandoff={inheritedPending:[...pending]};
      try {result=await executeTask({...stable,input:item.input,get cancellation(){return firstIntent??options.cancellation;}},coding,undefined,{item:current,context:handoff.context!},next);}
      catch(error){await freezeQueued(options.dataRoot,[item,...pending],`Dispatch blocked: ${String(error)}`);throw error;}
      pending.push(...(next.pending??[]));handoff=next;
    }
    if(options.signal?.aborted&&pending.length&&result.cleanup==='confirmed')await freezeQueued(options.dataRoot,pending,`Application ${firstIntent??options.cancellation??'exit'}; admission frozen`);
    if(options.control) {
      const unresolved=queueItems(options.dataRoot).filter(item=>item.status==='pending'||item.status==='dispatching'||item.status==='frozen');
      if(unresolved.length)result.controls={status:'needs-decision',exitCode:75,requestIds:unresolved.map(item=>item.requestId),reason:'Saved queue remains visible and frozen; ordinary input never reattaches it'};
    }
    return result;
  }
  finally { options.signal?.removeEventListener('abort', latch); }
}

interface ContextSnapshot {sourceRunId:string;sourceSessionId:string;sourceConversationId:number;messages:BlobRef;receiptSeq:number}
interface RunHandoff {pending?:QueueItemFact[];context?:ContextSnapshot;inheritedPending?:QueueItemFact[]}
function queueItems(root:string) {const items:QueueItemFact[]=[];let after:number|undefined,through:number|undefined;do{const page=readQueue(root,{after,through,limit:200});items.push(...page.items);after=page.next??undefined;through=page.through;}while(after);return items;}
async function freezeQueued(root:string,items:QueueItemFact[],reason:string) {
  if(!items.length)return;
  const owner=await acquireOwner(root,()=>{});
  try {for(const item of items){const current=findQueueItem(root,item.requestId);if(!current||!['pending','dispatching'].includes(current.status))continue;const evidence=new Evidence(root,item.target.runId);try{evidence.append('control.receipt',{requestId:item.requestId,status:'frozen',reason});evidence.append('control.report',{status:'needs-decision',exitCode:75,requestIds:[item.requestId],reason,options:['inspect','withdraw','reattach compatible completed-source follow-up','explicitly submit old text as new work']});}finally{evidence.close();}}}
  finally {await owner.release();}
}

/** Persist a machine-readable decision requirement without opening the upstream Harness. */
export async function checkQueue(dataRoot:string) {
  const owner=await acquireOwner(dataRoot,()=>{});
  try {
    for(const item of queueItems(owner.path).filter(item=>item.status==='pending'||item.status==='dispatching')) {
      const evidence=new Evidence(owner.path,item.target.runId);try{evidence.append('control.receipt',{requestId:item.requestId,status:'frozen',reason:'Reopened control state requires a source-bound explicit decision; no automatic dispatch'});}finally{evidence.close();}
    }
    const items=queueItems(owner.path),pending=items.filter(item=>item.status==='frozen');
    const report={status:pending.length?'needs-decision':'settled',exitCode:pending.length?75:0,items,options:['inspect','withdraw','reattach completed-source follow-up','explicitly submit old text as a new task'],reason:'Closing a view does not release any execution restriction'};
    if(items.length){const evidence=new Evidence(owner.path,items[0].target.runId);try{evidence.append('control.report',report);}finally{evidence.close();}}
    return report;
  }finally{await owner.release();}
}

/** Headless/TUI source-bound queue decision. Reattachment runs the same checked runtime. */
export async function decideQueue(options:RecoveryOptions & {decision:QueueDecision;transport?:typeof fetch;apiKey?:string;signal?:AbortSignal;cancellation?:'stop'|'exit';control?:TaskControl;onObservation?:ReadTaskOptions['onObservation']}) : Promise<QueueItemFact|RunResult> {
  const decision=structuredClone(options.decision);validControlId(decision.id);
  const owner=await acquireOwner(options.dataRoot,()=>{});let dispatch:{item:QueueItemFact;context:ContextSnapshot}|undefined;
  try {
    const item=findQueueItem(owner.path,decision.requestId);if(!item)throw Error('CONTROL_NOT_FOUND');
    if(JSON.stringify(item.target)!==JSON.stringify(decision.target)||options.runId!==item.target.runId)throw Error('CONTROL_TARGET_CHANGED');
    if(previousQueueDecision(owner.path,decision))return item;
    if(item.receipt.seq!==decision.receiptSeq)throw Error('STALE_CONTROL_DECISION');
    const evidence=new Evidence(owner.path,item.target.runId);
    try {
      if(decision.action==='withdraw') {
        evidence.append('control.decision',{decision});
        if(item.status!=='applied'&&item.status!=='withdrawn')evidence.append('control.receipt',{requestId:item.requestId,status:'withdrawn',reason:'Explicit host withdrawal; any old durable inbox stays frozen behind recovery checks'});
        return findQueueItem(owner.path,item.requestId)!;
      }
      if(decision.action!=='reattach'||item.kind!=='follow-up'||item.status!=='frozen')throw Error('QUEUE_REATTACH_NOT_APPLICABLE: frozen independent follow-up only; old steer text requires explicit new submission');
      if(queueItems(owner.path).some(other=>other.acceptedSeq<item.acceptedSeq&&other.target.sessionId===item.target.sessionId&&other.kind!=='steer'&&['pending','dispatching','frozen'].includes(other.status)))throw Error('QUEUE_PREDECESSOR_UNRESOLVED: finish or explicitly withdraw earlier independent/management work');
      if(!options.authorization)throw Error('CURRENT_AUTHORIZATION_REQUIRED');
      const source=recoveryRecords(owner.path,item.target.runId);
      const original=source.findLast(record=>record.kind==='run.closed')?.data as RunResult|undefined;
      if(original?.status!=='completed'||original.cleanup!=='confirmed')throw Error('QUEUE_SOURCE_NOT_COMPLETED: resolve old work and explicitly submit text as new work; stopped tasks never revive');
      if(source.some(record=>record.kind==='task.accepted'&&(record.data as any).queueRequestId===item.requestId))throw Error('QUEUE_PREVIOUS_DISPATCH_UNKNOWN');
      // Search every execution identity: a missing linking receipt never permits duplicate work.
      if(recoveryRecords(owner.path).some(record=>record.kind==='task.accepted'&&(record.data as any).queueRequestId===item.requestId))throw Error('QUEUE_PREVIOUS_DISPATCH_UNKNOWN');
      verifyArtifact(owner.path,source.find(record=>record.seq===item.executionVersion.artifactSeq)!.data as ReturnType<typeof captureArtifact>);
      const accepted=source.find(record=>record.kind==='task.accepted')!.data as any;
      const auth=options.authorization;
      if(await realpath(auth.workspace)!==item.target.workspace||auth.mode!==accepted.mode||JSON.stringify([...auth.tools].sort())!==JSON.stringify([...accepted.authorization.tools].sort()))throw Error('QUEUE_AUTHORIZATION_CHANGED');
      const config=source.find(record=>record.seq===item.executionVersion.configSeq)!.data as any;
      const expected=executionConfig(accepted.authorization.execution==='trusted-local-coding',auth.mode,auth.toolEnvironment);
      if(Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('QUEUE_EXECUTION_CONFIGURATION_CHANGED');
      await preflight(owner);
      const snapshot=source.findLast(record=>record.kind==='context.snapshot');if(!snapshot)throw Error('QUEUE_CONTEXT_UNAVAILABLE');
      const context={...(snapshot.data as Omit<ContextSnapshot,'receiptSeq'>),receiptSeq:snapshot.seq};readObject(owner.path,context.messages);
      evidence.append('control.decision',{decision,authorization:{workspace:auth.workspace,mode:auth.mode,tools:auth.tools}});
      evidence.append('control.receipt',{requestId:item.requestId,status:'pending',reason:`Explicit compatible reattachment decision ${decision.id}`});
      dispatch={item:findQueueItem(owner.path,item.requestId)!,context};
    }finally{evidence.close();}
  }finally{await owner.release();}
  const auth=options.authorization!;
  try {return await executeTask({...options,workspace:auth.workspace,input:dispatch!.item.input,mode:auth.mode,toolEnvironment:auth.toolEnvironment,get cancellation(){return options.cancellation;}},auth.tools.includes('write'),undefined,dispatch,{});}
  catch(error){await freezeQueued(options.dataRoot,[dispatch!.item],`Reattachment blocked: ${String(error)}`);throw error;}
}

async function executeTask(options: CodingTaskOptions, coding: boolean, recovery?: RecoveryPlan,queued?:{item:QueueItemFact;context:ContextSnapshot},handoff?:RunHandoff): Promise<RunResult> {
  if (options.signal?.aborted) throw new Error(`RUN_CANCELLED_BEFORE_ACCEPTANCE: ${options.cancellation ?? 'exit'}`);
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 300000) throw new Error('INVALID_CLEANUP_TIMEOUT: provide 1–300000 milliseconds');
  if (!options.input.trim() || Buffer.byteLength(options.input) > 32 * 1024) throw new Error('INPUT_LIMIT: provide 1–32768 bytes');
  if (options.verificationCompaction && (options.mode !== 'offline' || !options.providerBoundary || !Object.values(options.verificationCompaction).every(n=>Number.isSafeInteger(n)&&n>0) || options.verificationCompaction.keepRecentTokens > 32768 || options.verificationCompaction.reserveTokens > 1_048_576)) throw new Error('INVALID_VERIFICATION_COMPACTION');
  if (options.mode === 'offline' && !options.transport) throw new Error('OFFLINE_TRANSPORT_REQUIRED');
  if (options.mode === 'live' && options.transport) throw new Error('LIVE_TRANSPORT_OVERRIDE_DENIED');
  const apiKey = options.mode === 'offline' ? 'offline-transport-placeholder' : (options.apiKey ?? process.env.DEEPSEEK_API_KEY);
  if (!apiKey?.trim()) throw new Error('AUTH_MISSING: DEEPSEEK_API_KEY is required; no provider fallback');
  const workspace = await realpath(options.workspace);
  const workspaceRoot = coding ? await resolveWorkspaceRoot(workspace) : workspace;
  const shellEnvironment = coding ? toolEnvironment(options.toolEnvironment) : undefined;
  const instructions = coding ? CODING_INSTRUCTIONS : INSTRUCTIONS;
  const requestedRoot = await validateDataRoot(options.dataRoot, workspaceRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await validateDataRoot(requestedRoot, workspaceRoot);
  const runId = recovery?.accepted.runId ?? randomUUID(), sessionId = recovery?.accepted.sessionId ?? randomUUID(), taskId = recovery?.accepted.taskId ?? queued?.item.taskId ?? randomUUID();
  const controller = new AbortController();
  let failure: string | undefined;
  let originalLoss = false;
  let observationDegraded = false;
  let generationTaskId: number | undefined;
  const toolContext = new AsyncLocalStorage<{ attemptId: string; durableTaskId: number }>();
  let stopped = false;
  let finalizing = false;
  let storageClosed = false;
  let accepted = false;
  let cancellation: 'stop' | 'exit' | undefined;
  let shellsStarted = 0, shellsSettled = 0;
  const observedFiles = new Map<string, ObservedFile>();
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  let conversation: Conversation | undefined;
  let evidence: Evidence | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanup: 'confirmed' | 'unknown' = 'confirmed';
  let controls:RunControls|undefined;
  let freezing:Promise<void>|undefined;
  let notifyStop!: () => void;
  const stopping = new Promise<'stopped'>(resolve => { notifyStop = () => resolve('stopped'); });
  const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(apiKey).join('[credential redacted]');
  const close = () => closePromise ??= harness ? harness.close(CTX) : storage ? storage.close(CTX) : Promise.resolve();
  const fatal = (error: unknown) => {
    failure ??= safeError(error); stopped = true; controller.abort(); notifyStop();
  };
  const owner = recovery?.owner ?? await acquireOwner(dataRoot, fatal);
  if(recovery) {recovery.adopted=true;owner.setOnCompromised(fatal);}
  let sessionOwner: Awaited<ReturnType<typeof acquireOwner>> | undefined;
  let workspaceOwner: Awaited<ReturnType<typeof acquireWorkspaceOwner>> | undefined;
  let result: RunResult | undefined;
  const guard = () => { owner.assertHeld(); sessionOwner?.assertHeld(); workspaceOwner?.assertHeld(); if (stopped || finalizing || controller.signal.aborted) throw new Error(failure ?? 'RUN_STOPPING'); };
  const record = (kind: string, data: unknown) => {
    let seq: number;
    try { seq = evidence!.append(kind, data); } catch (error) {
      originalLoss = true; fatal(error);
      try { evidence!.append('evidence.gap', { failedKind: kind, reason: safeError(error), completeness: 'unknown', disposition: 'stopped; no side-effect replay to repair evidence' }); } catch { /* A failed disk may not retain even its gap marker. */ }
      throw error;
    }
    try { options.onObservation?.({ kind, runId }); } catch { observationDegraded = true; }
    return seq;
  };
  const derived = (kind: string, data: unknown) => {
    try { evidence!.append(kind, data); options.onObservation?.({ kind, runId }); }
    catch { observationDegraded = true; }
  };
  const stop = () => {
    if (stopped || finalizing) return;
    cancellation = options.cancellation ?? 'exit';
    stopped = true;
    try {
      if (accepted) record(cancellation === 'stop' ? 'run.abort-intent' : 'run.exit-intent', { action: cancellation, remoteTermination: 'unknown' });
      if (accepted) record('lifecycle.processing', { action: cancellation, admission: 'closed', dispatch: 'closed' });
    } catch { /* Earlier records remain authoritative. */ }
    controller.abort();
    if(controls)freezing=controls.freeze(`Application ${cancellation}; original target remains bound`).catch(fatal);
    notifyStop();
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const lifecycleRecord = (kind: string, data: unknown) => {
    if (evidence) try { record(kind, data); } catch { /* Keep cleanup running after original-record failure. */ }
  };
  let requests = recovery?.previousRequests ?? 0, responses = 0, usageReports = 0;
  let httpStatus: number | undefined;
  let usage: UsageState = { models: {}, tools: {} };
  let answer: string | undefined;
  try {
    if (coding) {
      workspaceOwner = await acquireWorkspaceOwner(workspace, fatal);
      if (workspaceOwner.root !== workspaceRoot) throw new Error('WORKSPACE_IDENTITY_CHANGED: project root changed before acceptance');
    }
    await chmod(dataRoot, 0o700);
    const inspected = recovery ? [] : await preflight(owner);
    if(queued) {
      const source=recoveryRecords(dataRoot,queued.item.target.runId);
      const artifact=source.find(record=>record.seq===queued.item.executionVersion.artifactSeq)?.data as ReturnType<typeof captureArtifact>;
      const config=source.find(record=>record.seq===queued.item.executionVersion.configSeq)?.data as Record<string,unknown>;
      verifyArtifact(dataRoot,artifact);
      const expected=executionConfig(coding,options.mode,options.toolEnvironment);
      if(workspace!==queued.item.target.workspace||!config||Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('QUEUE_EXECUTION_VERSION_OR_AUTHORIZATION_CHANGED');
      const current=findQueueItem(dataRoot,queued.item.requestId);
      if(current?.status!=='pending')throw Error('QUEUE_NOT_PENDING');
      const sourceEvidence=new Evidence(dataRoot,queued.item.target.runId,options.fault);
      try {sourceEvidence.append('control.receipt',{requestId:queued.item.requestId,status:'dispatching',reason:'Saved independent run dispatch intent; original target and context retained'});}finally{sourceEvidence.close();}
    }
    if (stopped) throw new Error(`RUN_CANCELLED_BEFORE_ACCEPTANCE: ${options.cancellation ?? 'exit'}`);
    guard();
    evidence = new Evidence(dataRoot, runId, options.fault);
    if (!recovery) record('preflight', { sessions: inspected });
    else record('recovery.started', { decisionId: recovery.decision.id, snapshotId: recovery.report.snapshotId, capabilities: recovery.readOnly ? ['read'] : recovery.accepted.authorization.tools, previousRequests: requests, previousUsageUnknown: recovery.previousUsageUnknown, originalStatus: (recovery.report.original as {status:string}).status });
    guard();
    accepted = true;
    const authorization={ tools: coding ? ['read', 'write', 'edit', 'bash'] : ['read'], execution: coding ? 'trusted-local-coding' : 'trusted-local-read-only', requestLimit: 8, fileLimitBytes: 256 * 1024, replay: 'unsafe' };
    if (!recovery) record('task.accepted', { taskId, runId, sessionId, input: options.input, workspace, mode: options.mode, ...(queued?{queueRequestId:queued.item.requestId,sourceTarget:queued.item.target}:{}), authorization, credentials: { source: options.mode === 'offline' ? 'offline-placeholder' : 'DEEPSEEK_API_KEY', present: true } });
    record('ownership.acquired', { dataRoot: {path:owner.path,claim:owner.claim}, ...(workspaceOwner ? {workspace:{path:workspaceOwner.path,claim:workspaceOwner.claim}}:{}) });
    if (workspaceOwner && !recovery) record('workspace.owner', { root: workspaceOwner.root, workspace, scope: 'protocol participants only; external editors, shared Git metadata and external resources are not isolated' });
    const artifact=recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.artifact')!.data as ReturnType<typeof captureArtifact>:captureArtifact(evidence,workspace);
    const artifactSeq=recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.artifact')!.seq:record('execution.artifact',artifact);
    const models = createModels({ authContext: { env: async name => name === 'DEEPSEEK_API_KEY' ? apiKey : undefined, fileExists: async () => false } });
    models.setProvider(deepseekProvider());
    const model = models.getModel('deepseek', 'deepseek-flash');
    if (!model || model.api !== 'openai-completions' || model.baseUrl !== 'https://api.deepseek.com') throw new Error('MODEL_CONFIGURATION_MISMATCH');
    const configuration = executionConfig(coding,options.mode,options.toolEnvironment);
    const settings = options.verificationCompaction ? {...configuration.settings,compaction:{enabled:true,...options.verificationCompaction}} : configuration.settings;
    const configSeq=recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.config')!.seq:record('execution.config', { cleanupTimeoutMs, ...configuration, settings, ...(options.verificationCompaction?{verificationCompaction:options.verificationCompaction}:{}), recoveryProtocol: 1, capture: 'ordered Pi request messages, effective provider payload and parsed provider stream events; not HTTP wire bytes; authentication headers excluded' });
    const actualStream = models.streamSimple.bind(models);
    const actualComplete = models.completeSimple.bind(models);
    // In the fixed Pi Harness, completeSimple is used by the compaction task.
    const requestPurpose = new AsyncLocalStorage<'compaction'>();
    const capturedModels: Models = Object.assign(models, {
      completeSimple: ((requestedModel,context,streamOptions) => requestPurpose.run('compaction',()=>actualComplete(requestedModel,context,streamOptions))) as Models['completeSimple'],
      streamSimple: ((requestedModel, context, streamOptions) => {
        guard();
        if (++requests > 8) { requests--; throw new Error('REQUEST_LIMIT: this task permits eight provider attempts'); }
        const attemptId = randomUUID();
        let hasUsage = false, responseRecorded = false;
        const purpose=requestPurpose.getStore()??'generation';
        const completed=(message:AssistantMessage)=>{
          if(responseRecorded)return;responseRecorded=true;responses++;if(hasUsage)usageReports++;
          record('model.response', { attemptId, message: { ...message, ...(message.errorMessage ? { errorMessage: safeError(message.errorMessage) } : {}) }, completeness: message.stopReason==='error'||message.stopReason==='aborted'?'partial':'complete', usage: hasUsage ? 'reported' : 'unknown', remoteTermination: message.stopReason==='error'||message.stopReason==='aborted'?'unknown':'response-returned' });
        };
        record('model.intent', { attemptId, durableTaskId: generationTaskId, ordinal: requests, model: { provider: requestedModel.provider, id: requestedModel.id }, context, purpose, boundary: 'Models.streamSimple', options: { maxRetries: streamOptions?.maxRetries, timeoutMs: streamOptions?.timeoutMs, reasoning: streamOptions?.reasoning, sessionId: streamOptions?.sessionId } });
        const stream = actualStream(requestedModel, context, {
          ...streamOptions, apiKey, fetch: async (url, init) => {
            guard();
            record('model.dispatch', { attemptId, url: String(url), method: init?.method, body: typeof init?.body === 'string' ? init.body : null, boundary: 'fetch JSON request body; authentication headers excluded' });
            guard();
            const response = options.providerBoundary
              ? await dispatchProvider({ ...options.providerBoundary, purpose, transport: options.transport ?? options.providerBoundary.transport }, url, init)
              : await (options.transport ?? globalThis.fetch)(url, init);
            httpStatus = response.status;
            record('model.http', { attemptId, status: response.status });
            return response;
          },
          signal: AbortSignal.any([controller.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])]),
          onPayload: payload => { guard(); record('model.payload', { attemptId, payload, boundary: 'Pi provider onPayload before dispatch', transform: '@earendil-works/pi-ai@1.1.0/openai-completions' }); },
          onProviderStreamEvent: event => {
            const candidate = event as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
            if (typeof candidate.usage?.prompt_tokens === 'number' && typeof candidate.usage?.completion_tokens === 'number') hasUsage = true;
            record('model.provider-event', { attemptId, event, boundary: 'parsed provider event before Pi normalization' });
          }
        });
        return new Proxy(stream, { get(target, property) {
          if (property === 'result') return async () => {
            const message = await target.result();
            completed(message);
            return message.errorMessage ? { ...message, errorMessage: safeError(message.errorMessage) } : message;
          };
          if (property === Symbol.asyncIterator) return async function* () {
            try {
              for await (const event of target) {
                if (event.type === 'done' || event.type === 'error') {
                  const message = event.type === 'done' ? event.message : event.error;
                  completed(message);
                }
                if (event.type === 'error' && event.error.errorMessage) yield { ...event, error: { ...event.error, errorMessage: safeError(event.error.errorMessage) } };
                else yield event;
              }
            } catch (error) { fatal(error); throw error; }
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }) as Models['streamSimple']
    });
    const tools: ToolRegistration[] = coding ? [createReadTool(), createWriteTool(), createEditTool(), createBashTool({ prepare(execution) { execution.inheritEnv = false; execution.env = { ...shellEnvironment }; } })] : [createReadTool()];
    const registry = createRegistry();
    const capturedTools = tools.map(tool => ({ ...tool, async execute(args, api, context) {
      guard();
      if (recovery?.readOnly && tool.name !== 'read') { record('recovery.capability-denied', { decisionId: recovery.decision.id, durableTaskId: api.taskId, tool: tool.name, reason: 'completed or skipped uncertain effect; this continuation permits scoped reads only' }); throw new Error('CAPABILITY_DENIED: recovery continuation allows read only; end old work and explicitly start a new task for further effects'); }
      const attemptId = randomUUID();
      record('tool.intent', { attemptId, durableTaskId: api.taskId, conversationId: api.conversationId, callId: api.callId, tool: tool.name, args });
      const diagnostics: ToolDiagnostic[] = [];
      let diagnosticCount = 0;
      const summarizeDiagnostic = (diagnostic: ToolDiagnostic) => {
        diagnosticCount++;
        if (diagnostics.length < 8) diagnostics.push({ severity: diagnostic.severity, ...(diagnostic.code ? { code: diagnostic.code.slice(0, 128) } : {}), message: diagnostic.message.slice(0, 256) });
      };
      const summary = (isError: boolean | null, source: { resultSeq?: number; errorSeq?: number }, truncation: unknown = null) => {
        const data = { attemptId, tool: tool.name, isError, ...source, diagnostics: [...diagnostics], diagnosticsOmitted: Math.max(0, diagnosticCount - diagnostics.length),
          truncation: Buffer.byteLength(JSON.stringify(truncation)) <= 1024 ? truncation : null };
        while (Buffer.byteLength(JSON.stringify(data)) > 3072 && data.diagnostics.length) { data.diagnostics.pop(); data.diagnosticsOmitted++; }
        derived('tool.summary', data);
      };
      try {
        guard();
        record('tool.dispatch', { attemptId, durableTaskId: api.taskId, tool: tool.name });
        guard();
        const value = await toolContext.run({ attemptId, durableTaskId: api.taskId }, () => tool.execute(args, { ...api, diagnostic(diagnostic) {
          record('tool.diagnostic', { attemptId, durableTaskId: api.taskId, diagnostic });
          summarizeDiagnostic(diagnostic);
          api.diagnostic(diagnostic);
        } }, context));
        const resultSeq = record('tool.result', { attemptId, durableTaskId: api.taskId, result: value });
        value.diagnostics?.forEach(summarizeDiagnostic);
        const details = value.details as { truncation?: unknown } | undefined;
        summary(value.isError ?? false, { resultSeq }, details?.truncation ?? null);
        return value;
      } catch (error) { const errorSeq = record('tool.error', { attemptId, durableTaskId: api.taskId, error: safeError(error) }); summary(true, { errorSeq }); throw error; }
    } }) satisfies ToolRegistration);
    registry.install(defineExtension({ name: coding ? 'pi-durio-coding' : 'pi-durio-read-only', tools: capturedTools, hooks: [hook(GenerationTask, { beforeRequest: (request, api) => { guard(); generationTaskId = api.taskId; record('generation.request', { durableTaskId: api.taskId, conversationId: api.conversationId, messages: request.messages }); return undefined; } })] }));
    guard();
    const sessionPath = join(dataRoot, 'sessions', sessionId);
    sessionOwner = await acquireOwner(sessionPath, fatal);
    record('ownership.session',{path:sessionOwner.path,claim:sessionOwner.claim});
    // Finish allocating this already-accepted session even if cancellation arrived
    // during owner acquisition; an empty durable store is then closed, never scheduled.
    const openedStorage = await openNodeSqliteStorage(join(sessionPath, 'durable.sqlite'));
    storage = new Proxy(openedStorage, { get(target, key) {
      if (key === 'close') return async (...args: Parameters<Storage['close']>) => {
        lifecycleRecord('lifecycle.storage-closing', { managedCommands: { started: shellsStarted, settled: shellsSettled } });
        options.fault?.('storage.close');
        await target.close(...args);
        storageClosed = true;
        lifecycleRecord('lifecycle.storage-closed', { storage: 'closed' });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await chmod(join(sessionPath, 'durable.sqlite'), 0o600);
    guard();
    options.fault?.('harness.open');
    harness = await Harness.open(storage, { models: capturedModels, registry, settings, env: () => {
      const capture = (kind: string, acquired: unknown) => record(kind, { toolAttempt: toolContext.getStore(), acquired });
      return coding && !recovery?.readOnly ? codingEnvironment(workspace, shellEnvironment!, guard, capture, state => { if (state === 'started') shellsStarted++; else shellsSettled++; }, observedFiles) : readEnvironment(workspace, guard, capture);
    } }, CTX);
    if(recovery)for(const frozen of recovery.frozenSubmissions??[]) {
      const pending=await harness.submission(frozen.id,CTX);
      if(!pending)throw Error('RECOVERY_QUEUE_SUBMISSION_MISSING');
      const outcome=await pending.abort(CTX); // Public passive withdrawal; never enables scheduling.
      if(outcome!=='aborted'&&outcome!=='settled')throw Error('RECOVERY_QUEUE_PLACEMENT_CHANGED');
      const item=findQueueItem(dataRoot,frozen.requestId);
      if(item?.status!=='withdrawn')record('control.receipt',{requestId:frozen.requestId,status:'frozen',reason:'Recovery retained this old pending steer; continuing the run does not reattach it',upstream:{submissionId:frozen.id,status:(await pending.status(CTX)).status}});
    }
    conversation = recovery ? await harness.conversation(recovery.started.conversationId,CTX) : await harness.root(CTX, { agent: { model: { provider: 'deepseek', modelId: 'deepseek-flash' }, cwd: workspace, instructions } });
    if (!conversation) throw new Error('RECOVERY_CONVERSATION_MISSING');
    if(queued) {
      const messages=JSON.parse(readObject(dataRoot,queued.context.messages).toString());
      // A passive, exactly retained model context import. No source run is opened or resumed.
      record('context.imported',{source:queued.context,target:queued.item.target,policy:'full acquired Pi model context; new independent run and usage'});
      await conversation.commit(tx=>tx.appendEntry(conversation!.id,{kind:'durio.follow-up-context',model:messages}),CTX);
    }
    if (!recovery) record('run.started', { taskId, sessionId, conversationId: conversation.id });
    guard();
    if (recovery) {
      // Public passive commit does not enable scheduling. Preserve upstream interrupted entries; append host facts separately.
      const summary = JSON.stringify({ decision: recovery.decision, tools: recovery.report.tools, capabilities: recovery.readOnly ? ['read'] : recovery.accepted.authorization.tools, warning: 'Original unknown and usage remain unknown. Committed/completed operations must not be redone. Only explicitly retry-selected or proven not-dispatched operations may be attempted again.' });
      await conversation.commit(tx => tx.appendEntry(conversation!.id,{kind:'durio.recovery',model:[{role:'user',content:summary,timestamp:Date.now()}]}),CTX);
    } else record('submission.intent', { requestId: taskId, conversationId: conversation.id, input: options.input });
    const submission = recovery ? await harness.submission(recovery.submissionId,CTX) : await conversation.submit({ type: 'input', content: options.input, requestId: taskId }, CTX);
    if (!submission) throw new Error('RECOVERY_SUBMISSION_MISSING');
    if (!recovery) record('submission.accepted', { requestId: taskId, submissionId: submission.id });
    if(queued) {
      const sourceEvidence=new Evidence(dataRoot,queued.item.target.runId,options.fault);
      try{sourceEvidence.append('control.receipt',{requestId:queued.item.requestId,status:'applied',reason:'New independent run and Pi input submission committed',execution:{runId,sessionId},upstream:{submissionId:submission.id,status:(await submission.status(CTX)).status}});}finally{sourceEvidence.close();}
    }
    if(options.control) {
      controls=new RunControls({root:dataRoot,target:{workspace,sessionId,taskId,runId},version:{artifactId:artifact.id,artifactSeq,configSeq},authorization,conversation,harness,guard,record,failure:fatal});options.control.attach(controls);
      record('control.ready',{target:controls.target,admission:'open'});
    }
    guard(); // wait is an implicit scheduler entry; it cannot bypass the same owner/capability admission.
    const settled = await Promise.race([submission.wait(CTX), stopping]);
    if (settled !== 'stopped') {
      if(settled.status==='done'&&controls)await Promise.race([controls.settleSteers(),stopping]);
      if(stopped)throw Error('RUN_STOPPING');
      finalizing = true;
      record('submission.settled', settled);
      const view = await conversation.viewState(CTX);
      try { usage = structuredClone(view.value.docs['pi.usage']) as UsageState; } finally { view.dispose(); }
      const context = await conversation.context(CTX);
      if(handoff) {
        handoff.pending=controls?.pending()??[];
        if(options.control){const messages=evidence.blob(JSON.stringify(context.messages));const receiptSeq=record('context.snapshot',{sourceRunId:runId,sourceSessionId:sessionId,sourceConversationId:conversation.id,messages});handoff.context={sourceRunId:runId,sourceSessionId:sessionId,sourceConversationId:conversation.id,messages,receiptSeq};}
      }
      const last = context.messages.findLast((m): m is AssistantMessage => m.role === 'assistant');
      if (last) answer = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (settled.status !== 'done') failure ??= httpStatus === 401 || httpStatus === 403 ? 'AUTH_REJECTED: DeepSeek rejected credentials; no provider fallback' : 'TASK_UNANSWERED';
      record('usage.projection', { source: 'pi.usage', conversationId: conversation.id, value: usage, reportedAttempts: usageReports, requests, completeness: usageReports === requests ? 'known' : usageReports ? 'partial' : 'unknown' });
    }
  } catch (error) { if (!stopped || failure) failure ??= safeError(error); }
  finally {
    options.signal?.removeEventListener('abort', stop);
    finalizing = true;
    controller.abort();
    if(controls) {
      options.control?.detach(controls);
      try {await freezing;if(failure||stopped)await controls.freeze(failure??`Application ${cancellation??'interrupted'}`);await controls.drain();}
      catch(error){originalLoss=true;failure??=safeError(error);}
      controls.close();
    }
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(new Error('CLEANUP_TIMEOUT: cleanup remains unconfirmed; inspect residual work before releasing ownership')); }, cleanupTimeoutMs);
    const shutdown = (async () => {
      if (cancellation === 'stop' && conversation) {
        lifecycleRecord('lifecycle.abort-started', { action: cancellation });
        try {
          options.fault?.('conversation.abort');
          await conversation.abort(withAbortSignal(deadline.signal, CTX));
          lifecycleRecord('lifecycle.abort-settled', { action: cancellation });
        } catch (error) { cleanup = 'unknown'; failure ??= safeError(error); lifecycleRecord('lifecycle.abort-failed', { reason: safeError(error) }); }
      }
      lifecycleRecord('lifecycle.close-started', { action: cancellation ?? 'finish', admission: 'closed', dispatch: 'closed' });
      await close();
    })();
    try { await awaitWithContext(shutdown, withAbortSignal(deadline.signal, CTX)); }
    catch (error) { cleanup = 'unknown'; failure ??= safeError(error); lifecycleRecord(timedOut ? 'lifecycle.timeout' : 'lifecycle.close-failed', { cleanupTimeoutMs, reason: safeError(error), owner: 'retained', recoveryRequired: true }); }
    finally { clearTimeout(timer); }
    try { owner.assertHeld(); sessionOwner?.assertHeld(); workspaceOwner?.assertHeld(); }
    catch (error) { cleanup = 'unknown'; failure ??= safeError(error); lifecycleRecord('lifecycle.owner-lost', { reason: safeError(error), owner: 'retained', recoveryRequired: true }); }
    if (shellsStarted !== shellsSettled) { cleanup = 'unknown'; failure ??= 'SHELL_TERMINATION_UNKNOWN'; }
    if (evidence && sessionOwner && cleanup === 'confirmed') {
      try {
        const snapshot = await inspectSession(join(sessionOwner.path, 'durable.sqlite'), owner);
        if (snapshot.usage[0]) usage = snapshot.usage[0].value as UsageState;
        record('durable.closed-snapshot', snapshot);
      } catch (error) { originalLoss = true; failure ??= safeError(error); }
    }
    if (evidence) {
      result = { runId, taskId, sessionId, mode: options.mode, status: originalLoss || cleanup === 'unknown' ? 'unknown' : failure ? 'failed' : cancellation ? (cancellation === 'stop' ? 'aborted' : 'unknown') : 'completed', answer, reason: failure ?? (cancellation ? (cancellation === 'stop' ? 'Task aborted; acquired changes and costs remain; remote termination unknown' : 'Application exit preserved unfinished work; explicit recovery required; remote termination unknown') : undefined), observation: observationDegraded ? 'degraded' : 'ok', cleanup,
        lifecycle: { intent: cancellation ?? null, disposition: originalLoss || cleanup === 'unknown' ? 'needs-recovery' : failure ? 'failed' : cancellation === 'stop' ? 'aborted' : cancellation === 'exit' ? 'resumable' : 'completed', cleanupTimeoutMs, storage: storage ? (storageClosed ? 'closed' : 'unknown') : 'not-opened', owner: cleanup === 'confirmed' ? 'release-after-host-close' : 'retained', remoteTermination: 'unknown' },
        ...(coding ? { executionCleanup: { managedCommands: shellsStarted === shellsSettled ? 'settled' as const : 'unknown' as const, started: shellsStarted, settled: shellsSettled, externalProcesses: 'unknown' as const } } : {}),
        usage: { source: 'pi.usage', scope: `session:${sessionId}`, completeness: cleanup === 'confirmed' && usageReports === requests && requests > 0 ? 'known' : usageReports ? 'partial' : 'unknown', value: usageReports && cleanup === 'confirmed' ? usage : null, cost: { kind: 'estimate', currency: 'USD', source: '@earendil-works/pi-ai@1.1.0 model price catalog', observedAt: new Date().toISOString() } } };
      if(result.status!=='completed')for(const item of handoff?.inheritedPending??[]) {
        const current=findQueueItem(dataRoot,item.requestId);if(!current||!['pending','dispatching'].includes(current.status))continue;
        const source=new Evidence(dataRoot,item.target.runId,options.fault);
        try{source.append('control.receipt',{requestId:item.requestId,status:'frozen',reason:`Preceding run ${runId} ${result.status}; explicit source-bound decision required`});}catch(error){result.status='unknown';result.reason=safeError(error);}finally{source.close();}
      }
      try { record(recovery ? 'recovery.closed' : 'run.closed', recovery ? { decisionId: recovery.decision.id, result, originalStatus: (recovery.report.original as {status:string}).status, previousUsageUnknown: recovery.previousUsageUnknown } : result); } catch { result.status = 'unknown'; result.reason = 'EVIDENCE_FAILURE: close receipt could not be saved'; }
      if (timedOut) {
        // The caller may stop waiting, but active writers still own their storage.
        // Never promote the earlier unknown receipt or auto-release owners after a late close.
        void shutdown.then(() => lifecycleRecord('lifecycle.late-close', { storage: storageClosed ? 'closed' : 'unknown', owner: 'retained', recoveryRequired: true }), error => lifecycleRecord('lifecycle.late-close-failed', { reason: safeError(error), owner: 'retained' })).finally(() => evidence!.close());
      } else evidence.close();
    }
    if (cleanup === 'confirmed') { await sessionOwner?.release(); await workspaceOwner?.release(); await owner.release(); }
  }
  if (!result) throw new Error(failure ?? (stopped ? `RUN_CANCELLED_BEFORE_ACCEPTANCE: ${cancellation ?? options.cancellation ?? 'exit'}` : 'RUN_NOT_ACCEPTED'));
  return result;
}
