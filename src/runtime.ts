import {type TaskOrigin} from './fact-clock.js';
import {prepareImprove,validateImproveRequest,priorImprove,readImproveReport,IMPROVE_INSTRUCTIONS,type ImproveRequest,type ImproveReport} from './improve.js';
import { CompactionFacts, type CompactionResultFact } from './compaction.js';
import { dispatchProvider, type ProviderBoundary } from './provider-boundary.js';
import { realpath, mkdir, chmod } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createModels, type AssistantMessage, type Models, type AssistantMessageEvent, type Usage } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, GenerationTask, hook, type Conversation, type UsageState, type Storage, type ToolRegistration, type ToolDiagnostic, type TaskId, type CompactionResult } from '@earendil-works/pi-durable';
import { createReadTool, createWriteTool, createEditTool, createBashTool } from '@earendil-works/pi-durable/tools';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Evidence, readObject, readQueue, type BlobRef, type QueueItemFact, type ControlTarget, type FaultInjector } from './evidence.js';
import { TaskControl, RunControls, findQueueItem, findCoalescedControl, validControlId, previousQueueDecision, type QueueDecision, type ControlBinding } from './control.js';
import { acquireOwner } from './ownership.js';
import { preflight } from './preflight.js';
import { inspectClosedSession, inspectCompaction } from './storage-projection.js';
import { readEnvironment } from './read-environment.js';
import { captureArtifact, verifyArtifact } from './artifact.js';
import { codingEnvironment, toolEnvironment, type ToolEnvironmentConfig, type ObservedFile } from './coding-environment.js';
import { acquireWorkspaceOwner, resolveWorkspaceRoot } from './workspace-ownership.js';
import { executionConfig,retainedExecutionConfig, READ_INSTRUCTIONS, CODING_INSTRUCTIONS } from './execution-config.js';
import {applyTaskProfile,validateTaskProfile,type TaskProfile} from './task-profile.js';
import {readImproveDefaults,type DefaultSnapshot} from './improve-defaults.js';
import {improveFacts} from './improve-history.js';
import {assertWorkspaceUnfenced} from './workspace-fence.js';
import { prepareRecovery, recoveryRecords, sessionWasEnded, type RecoveryAuthorization, type RecoveryOptions, type RecoveryDecision, type RecoveryPlan, type RecoveryReport } from './recovery.js';
export { readRun, readObject, readAcceptedTasks, readQueue } from './evidence.js';
export { TaskControl } from './control.js';
export type { ControlInput, QueueDecision } from './control.js';
export { readRecoveryDetail, inspectRecovery, checkRecovery, settleRecoveryOwners } from './recovery.js';
export type { RecoveryOptions, RecoveryDecision, RecoveryReport, RecoveryAuthorization } from './recovery.js';

const CTX = BACKGROUND_CONTEXT;
const INSTRUCTIONS = READ_INSTRUCTIONS;
export interface ReadTaskOptions {
  dataRoot: string; workspace: string; input: string;
  mode: 'live' | 'offline';
  /** Trusted embedding host only; never accepted from candidate messages or tools. */
  taskOrigin?: TaskOrigin;
  /** Explicit offline transport boundary. Never silently fall back from a live provider. */
  transport?: typeof fetch;
  /** Trusted host dispatch capability; never accepted from model/tool data. */
  providerBoundary?: ProviderBoundary;
  /** Offline controlled validation of the same public compaction path. */
  verificationCompaction?: { reserveTokens:number; keepRecentTokens:number };
  /** Fixed eval profile; requires the trusted provider dispatch capability. */
  verificationProfile?:TaskProfile;
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
  /** Import a verified, completed active context into this independent task. */
  contextRunId?:string;
}
export interface CodingTaskOptions extends ReadTaskOptions { toolEnvironment?: ToolEnvironmentConfig }
export type { ToolEnvironmentConfig } from './coding-environment.js';
export interface RunResult {
  runId: string; sessionId: string; taskId: string; mode: 'live' | 'offline';
  status: 'completed' | 'failed' | 'aborted' | 'unknown';
  answer?: string; reason?: string; observation: 'ok' | 'degraded'; cleanup: 'confirmed' | 'unknown';
  lifecycle?: { intent: 'stop' | 'exit' | null; disposition: 'completed' | 'failed' | 'aborted' | 'resumable' | 'needs-recovery'; cleanupTimeoutMs: number; storage: 'not-opened' | 'closed' | 'unknown'; owner: 'release-after-host-close' | 'retained'; remoteTermination: 'unknown' };
  executionCleanup?: { managedCommands: 'settled' | 'unknown'; started: number; settled: number; externalProcesses: 'unknown' };
  compaction?:CompactionResultFact;
  improve?:ImproveReport;
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
  if(options.decision.action==='continue'&&recoveryRecords(options.dataRoot,options.runId).some(record=>record.kind==='execution.config'&&(record.data as any).providerBoundary))throw Error('PROVIDER_BOUNDARY_RECOVERY_REQUIRED: original dispatch capability cannot be reconstructed by this recovery entry; inspect or end old work, never resume with an unbudgeted provider');
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
  const stable={...options,verificationProfile:options.verificationProfile&&structuredClone(options.verificationProfile),toolEnvironment:options.toolEnvironment&&structuredClone(options.toolEnvironment),get cancellation(){return firstIntent??options.cancellation;}};
  try {
    let handoff:RunHandoff={},result=await executeTask(stable,coding,undefined,undefined,handoff);
    const pending=[...(handoff.pending??[])];
    // Independent host requests only. Each request still uses the unmodified public Pi agent loop.
    while(result.status==='completed'&&result.cleanup==='confirmed'&&pending.length&&!options.signal?.aborted) {
      const item=pending.shift()!;
      const current=findQueueItem(options.dataRoot,item.requestId);
      if(!current||current.status!=='pending')continue;
      if(item.kind==='compact') {
        const compactHandoff:RunHandoff={};
        const compact=await executeTask(stable,coding,undefined,undefined,compactHandoff,{requestId:item.requestId,source:handoff.context!,item});
        if(compact.status==='completed'&&compact.cleanup==='confirmed'&&compact.compaction&&['applied','noop','cancelled','stale'].includes(compact.compaction.state)){handoff.context=compactHandoff.context;continue;}
        await freezeQueued(options.dataRoot,pending,'Compaction did not complete; later independent requests remain frozen');
        result.controls={status:'needs-decision',exitCode:75,requestIds:pending.map(i=>i.requestId),reason:'Compaction interrupted or failed; inspect its retained facts'};break;
      }
      if(item.kind==='improve') {
        try {
          const request=validateImproveRequest(JSON.parse(item.input),stable.mode);if(request.id!==item.requestId)throw Error('IMPROVE_ID_CONFLICT');
          const analyzed=await executeTask({...stable,control:undefined,contextRunId:undefined,providerBoundary:undefined,verificationCompaction:undefined,input:request.purpose,get cancellation(){return firstIntent??options.cancellation;}},false,undefined,undefined,undefined,undefined,{request,target:item.target,item});
          result.improve=analyzed.improve;
          if(analyzed.status==='completed'&&analyzed.cleanup==='confirmed'&&analyzed.improve?.state==='complete')continue;
          await freezeQueued(options.dataRoot,pending,'Improve analysis incomplete; later independent requests require a decision');break;
        } catch(error){await freezeQueued(options.dataRoot,[item,...pending],`Improve not started: ${String(error)}; complete effective settings before a new explicit request`);break;}
      }
      if(item.kind!=='follow-up') {await freezeQueued(options.dataRoot,[item,...pending],'Management request awaits its installed handler and an explicit decision');break;}
      const next:RunHandoff={inheritedPending:[...pending]};
      try {result=await executeTask({...stable,contextRunId:undefined,input:item.input,get cancellation(){return firstIntent??options.cancellation;}},coding,undefined,{item:current,context:handoff.context!},next);}
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

export interface CompactOptions extends Omit<CodingTaskOptions,'workspace'|'input'|'mode'> {runId:string;requestId:string;authorization:RecoveryAuthorization}

/** Explicit idle-session maintenance. A request is its authorization; history queries never call this. */
export async function compactContext(options:CompactOptions):Promise<RunResult> {
  validControlId(options.requestId);
  const source=recoveryRecords(options.dataRoot,options.runId);
  const accepted=source.find(r=>r.kind==='task.accepted')?.data as any;
  const started=source.find(r=>r.kind==='run.started')?.data as any;
  if(!accepted||!started)throw Error('COMPACTION_SOURCE_MISSING');
  const prior=source.findLast(r=>r.kind==='compaction.closed'&&(r.data as any).requestId===options.requestId)?.data as any;
  if(prior)return prior.result;
  if(source.some(r=>r.kind==='compaction.started'&&(r.data as any).requestId===options.requestId))throw Error('COMPACTION_RECOVERY_REQUIRED: earlier dispatch cannot be repeated');
  const auth=options.authorization;
  if(await realpath(auth.workspace)!==accepted.workspace||auth.mode!==accepted.mode||JSON.stringify([...auth.tools].sort())!==JSON.stringify([...accepted.authorization.tools].sort()))throw Error('COMPACTION_AUTHORIZATION_CHANGED');
  const closed=source.findLast(r=>r.kind==='recovery.closed')?.data as any;
  const original=closed?.result??source.findLast(r=>r.kind==='run.closed')?.data as RunResult|undefined;
  if(original?.status!=='completed'||original.cleanup!=='confirmed')throw Error('COMPACTION_SOURCE_NOT_COMPLETED');
  const config=source.find(r=>r.kind==='execution.config')?.data as any;
  if(config.providerBoundary&&(!options.providerBoundary||options.providerBoundary.operationId!==config.providerBoundary.operationId||options.providerBoundary.budget?.id!==config.providerBoundary.budget?.id))throw Error('PROVIDER_BOUNDARY_RECOVERY_REQUIRED');
  if(queueItems(options.dataRoot).some(i=>i.target.sessionId===accepted.sessionId&&['pending','dispatching','frozen'].includes(i.status)))throw Error('QUEUE_PREDECESSOR_UNRESOLVED');
  return executeTask({...options,workspace:auth.workspace,input:'compact',mode:auth.mode,toolEnvironment:auth.toolEnvironment},accepted.authorization.execution==='trusted-local-coding',undefined,undefined,{}, {requestId:options.requestId,source:{sourceRunId:options.runId,sourceSessionId:accepted.sessionId,sourceConversationId:started.conversationId}});
}

export interface ImproveOptions extends Omit<ReadTaskOptions,'input'|'providerBoundary'|'control'|'contextRunId'|'verificationCompaction'> {targetRunId:string;request:ImproveRequest}
/** Explicit scoped analysis in the same Pi runtime; report reads never enter it. */
export async function analyzeImprove(options:ImproveOptions):Promise<RunResult> {
 const request=validateImproveRequest(options.request,options.mode),workspace=await realpath(options.workspace);
 const prior=priorImprove(options.dataRoot,request.id);
 if(prior){if(JSON.stringify(prior.data.request)!==JSON.stringify(request)||prior.data.target.workspace!==workspace||prior.data.target.runId!==options.targetRunId)throw Error('IMPROVE_ID_CONFLICT');const saved=readImproveReport(options.dataRoot,request.id);if(saved.result)return {...saved.result,improve:saved.report??undefined};throw Error('IMPROVE_RECOVERY_REQUIRED: interrupted analysis cannot restart its budget');}
 if(findQueueItem(options.dataRoot,request.id))throw Error('IMPROVE_REQUEST_QUEUED: use the bound management queue; direct analyze does not reattach it');
 const facts=recoveryRecords(options.dataRoot,options.targetRunId),source=facts.find(r=>r.kind==='task.accepted')?.data as any;
 if(!source||source.workspace!==workspace)throw Error('IMPROVE_TARGET_MISMATCH');
 const target={workspace,runId:options.targetRunId,sessionId:source.sessionId,taskId:source.taskId};
 return executeTask({...options,workspace,input:request.purpose,control:undefined,contextRunId:undefined,providerBoundary:undefined,verificationCompaction:undefined,get cancellation(){return options.cancellation;}},false,undefined,undefined,undefined,undefined,{request,target});
}
interface ImproveExecution {request:ImproveRequest;target:ControlTarget;item?:QueueItemFact}

interface Maintenance {requestId:string;source:Pick<ContextSnapshot,'sourceRunId'|'sourceSessionId'|'sourceConversationId'>;item?:QueueItemFact}
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
        if(item.kind==='compact'&&item.status!=='applied'&&item.status!=='withdrawn'){
          const operation=recoveryRecords(owner.path).findLast(r=>r.kind==='compaction.started'&&(r.data as any).requestId===item.requestId)?.data as any;
          if(operation){
            const facts=recoveryRecords(owner.path,operation.source.sourceRunId),taskFact=facts.findLast(r=>r.kind==='compaction.task'&&(r.data as any).requestId===item.requestId)?.data as any;
            const snapshot=await inspectCompaction(join(owner.path,'sessions',operation.source.sourceSessionId,'durable.sqlite'),owner,taskFact?.taskId);
            const {outcome,result,summary}=snapshot;
            if(result?.entryId!==undefined||summary?.entry!==undefined||outcome?.status==='completed'&&!result?.submissionId){evidence.append('control.receipt',{requestId:item.requestId,status:'applied',reason:'Public durable snapshot proves summary applied or noop; late cancellation cannot roll it back'});return findQueueItem(owner.path,item.requestId)!;}
            if((!outcome||summary?.status==='queued')&&!sessionWasEnded(facts,operation.source.sourceSessionId,snapshot.sourceFiles))throw Error('COMPACTION_RECOVERY_REQUIRED: this specific task or unplaced summary is frozen; inspect and explicitly end source before resolving the request');
          }
        }
        evidence.append('control.decision',{decision});
        if(item.status!=='applied'&&item.status!=='withdrawn')evidence.append('control.receipt',{requestId:item.requestId,status:'withdrawn',reason:'Explicit host withdrawal; any old durable inbox stays frozen behind recovery checks'});
        return findQueueItem(owner.path,item.requestId)!;
      }
      if(decision.action!=='reattach'||!['follow-up','compact','improve'].includes(item.kind)||item.status!=='frozen')throw Error('QUEUE_REATTACH_NOT_APPLICABLE: frozen follow-up or unexecuted compact only; old steer text requires explicit new submission');
      if(item.kind==='improve'){if(priorImprove(owner.path,item.requestId))throw Error('IMPROVE_ALREADY_DISPATCHED: inspect retained report; a new request cannot reset old limits');validateImproveRequest(JSON.parse(item.input),options.authorization?.mode??'live');}
      if(item.kind==='compact'&&recoveryRecords(owner.path).some(r=>r.kind==='compaction.started'&&(r.data as any).requestId===item.requestId))throw Error('COMPACTION_ALREADY_DISPATCHED: inspect/end or withdraw its actual outcome, then explicitly request a new operation');
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
      if(config.providerBoundary)throw Error('PROVIDER_BOUNDARY_RECOVERY_REQUIRED: queued work cannot drop the original dispatch boundary');
      const expected=retainedExecutionConfig(owner.path,accepted.authorization.execution==='trusted-local-coding',auth.mode,auth.toolEnvironment,config);
      if(Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('QUEUE_EXECUTION_CONFIGURATION_CHANGED');
      await preflight(owner);
      let contextSource=source,contextRunId=item.target.runId;
      if(item.kind==='compact')for(const previous of queueItems(owner.path).filter(other=>other.kind==='follow-up'&&other.acceptedSeq<item.acceptedSeq&&other.target.sessionId===item.target.sessionId&&other.status==='applied').sort((a,b)=>a.acceptedSeq-b.acceptedSeq)){
        if(!previous.runId)throw Error('COMPACTION_CONTEXT_LINEAGE_UNPROVEN');
        const next=recoveryRecords(owner.path,previous.runId),accepted=next.find(r=>r.kind==='task.accepted')?.data as any,imported=next.find(r=>r.kind==='context.imported')?.data as any;
        if(accepted?.queueRequestId!==previous.requestId||imported?.source?.sourceRunId!==contextRunId)throw Error('COMPACTION_CONTEXT_LINEAGE_UNPROVEN');
        const closed=(next.findLast(r=>r.kind==='recovery.closed')?.data as any)?.result??next.findLast(r=>r.kind==='run.closed')?.data as RunResult|undefined;
        if(closed?.status!=='completed'||closed.cleanup!=='confirmed'||next.some(r=>r.kind==='recovery.ended'))throw Error('COMPACTION_CONTEXT_SOURCE_NOT_COMPLETED');
        contextSource=next;contextRunId=previous.runId;
      }
      const snapshot=contextSource.findLast(record=>record.kind==='context.snapshot');if(!snapshot)throw Error('QUEUE_CONTEXT_UNAVAILABLE');
      const context={...(snapshot.data as Omit<ContextSnapshot,'receiptSeq'>),receiptSeq:snapshot.seq};readObject(owner.path,context.messages);
      evidence.append('control.decision',{decision,authorization:{workspace:auth.workspace,mode:auth.mode,tools:auth.tools}});
      evidence.append('control.receipt',{requestId:item.requestId,status:'pending',reason:`Explicit compatible reattachment decision ${decision.id}`});
      dispatch={item:findQueueItem(owner.path,item.requestId)!,context};
    }finally{evidence.close();}
  }finally{await owner.release();}
  const auth=options.authorization!;
  try {if(dispatch!.item.kind==='improve'){const request=validateImproveRequest(JSON.parse(dispatch!.item.input),auth.mode);if(request.id!==dispatch!.item.requestId)throw Error('IMPROVE_ID_CONFLICT');return await executeTask({...options,workspace:auth.workspace,mode:auth.mode,input:request.purpose,control:undefined,get cancellation(){return options.cancellation;}},false,undefined,undefined,undefined,undefined,{request,target:dispatch!.item.target,item:dispatch!.item});}return await executeTask({...options,workspace:auth.workspace,input:dispatch!.item.input,mode:auth.mode,toolEnvironment:auth.toolEnvironment,get cancellation(){return options.cancellation;}},auth.tools.includes('write'),undefined,dispatch!.item.kind==='compact'?undefined:dispatch,{},dispatch!.item.kind==='compact'?{requestId:dispatch!.item.requestId,source:dispatch!.context,item:dispatch!.item}:undefined);}
  catch(error){await freezeQueued(options.dataRoot,[dispatch!.item],`Reattachment blocked: ${String(error)}`);throw error;}
}

async function executeTask(options: CodingTaskOptions, coding: boolean, recovery?: RecoveryPlan,queued?:{item:QueueItemFact;context:ContextSnapshot},handoff?:RunHandoff,maintenance?:Maintenance,improve?:ImproveExecution): Promise<RunResult> {
  if (options.signal?.aborted) throw new Error(`RUN_CANCELLED_BEFORE_ACCEPTANCE: ${options.cancellation ?? 'exit'}`);
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 300000) throw new Error('INVALID_CLEANUP_TIMEOUT: provide 1–300000 milliseconds');
  if (!options.input.trim() || Buffer.byteLength(options.input) > 32 * 1024) throw new Error('INPUT_LIMIT: provide 1–32768 bytes');
  if (options.verificationCompaction && (options.mode !== 'offline' || !options.providerBoundary || !Object.values(options.verificationCompaction).every(n=>Number.isSafeInteger(n)&&n>0) || options.verificationCompaction.keepRecentTokens > 32768 || options.verificationCompaction.reserveTokens > 1_048_576)) throw new Error('INVALID_VERIFICATION_COMPACTION');
  if(options.verificationProfile&&(!options.providerBoundary||options.verificationCompaction))throw Error('IMPROVE_PROFILE_CAPABILITY_OR_OVERRIDE_DENIED');
  if (options.mode === 'offline' && !options.transport) throw new Error('OFFLINE_TRANSPORT_REQUIRED');
  if (options.mode === 'live' && options.transport) throw new Error('LIVE_TRANSPORT_OVERRIDE_DENIED');
  const apiKey = options.mode === 'offline' ? 'offline-transport-placeholder' : (options.apiKey ?? process.env.DEEPSEEK_API_KEY);
  if (!apiKey?.trim()) throw new Error('AUTH_MISSING: DEEPSEEK_API_KEY is required; no provider fallback');
  const workspace = await realpath(options.workspace);
  const workspaceRoot = coding ? await resolveWorkspaceRoot(workspace) : workspace;
  const shellEnvironment = coding ? toolEnvironment(options.toolEnvironment) : undefined;
  let instructions = improve ? IMPROVE_INSTRUCTIONS : coding ? CODING_INSTRUCTIONS : INSTRUCTIONS;
  const requestedRoot = await validateDataRoot(options.dataRoot, workspaceRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await validateDataRoot(requestedRoot, workspaceRoot);
  const maintenanceRecords=maintenance?recoveryRecords(dataRoot,maintenance.source.sourceRunId):[];
  const sourceAccepted=maintenanceRecords.find(r=>r.kind==='task.accepted')?.data as any;
  const runId = recovery?.accepted.runId ?? maintenance?.source.sourceRunId ?? randomUUID(), sessionId = recovery?.accepted.sessionId ?? maintenance?.source.sourceSessionId ?? randomUUID(), taskId = recovery?.accepted.taskId ?? sourceAccepted?.taskId ?? queued?.item.taskId ?? randomUUID();
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
  let compactions:CompactionFacts|undefined,compactResult:CompactionResultFact|undefined,compactTask:TaskId<CompactionResult>|undefined,compactBinding:ControlBinding|undefined;
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
  let analysis:ReturnType<typeof prepareImprove>|undefined,analysisTimer:ReturnType<typeof setTimeout>|undefined;
  let defaults:DefaultSnapshot|undefined;
  let defaultsObserved=false;
  let configuration=executionConfig(coding,options.mode,options.toolEnvironment);
  let providerBoundary=options.providerBoundary;
  const guard = () => { owner.assertHeld(); sessionOwner?.assertHeld(); workspaceOwner?.assertHeld(); if (stopped || finalizing || controller.signal.aborted) throw new Error(failure ?? 'RUN_STOPPING'); };
  const record = (kind: string, data: unknown) => {
    let seq: number;
    try { seq = evidence!.append(kind, kind==='control.accepted'&&data&&typeof data==='object'?{...data,origin:options.taskOrigin??{kind:'coding',source:options.mode==='offline'?'synthetic':options.transport?'diagnostic':'ordinary'}}:data); } catch (error) {
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
      if (accepted&&!maintenance) record(cancellation === 'stop' ? 'run.abort-intent' : 'run.exit-intent', { action: cancellation, remoteTermination: 'unknown' });
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
  const notDispatchedAttempts=new Set<string>();
  const previousUsage=maintenanceRecords.findLast(r=>r.kind==='usage.projection')?.data as any;
  const completeness=()=>{const current=usageReports===requests-notDispatchedAttempts.size?'known':usageReports?'partial':'unknown';if(!maintenance)return current;if(previousUsage?.completeness==='known'&&current==='known')return 'known';return previousUsage?.completeness==='known'||previousUsage?.completeness==='partial'||usageReports?'partial':'unknown';};
  let httpStatus: number | undefined;
  let providerFailure:string|undefined;
  let usage: UsageState = { models: {}, tools: {} };
  let answer: string | undefined;
  try {
    if (coding) {
      workspaceOwner = await acquireWorkspaceOwner(workspace, fatal);
      if (workspaceOwner.root !== workspaceRoot) throw new Error('WORKSPACE_IDENTITY_CHANGED: project root changed before acceptance');
    }
    await chmod(dataRoot, 0o700);
    if(!recovery?.readOnly&&!improve)assertWorkspaceUnfenced(workspace);
    const inspected = recovery ? undefined : await preflight(owner, { runId: maintenance?.source.sourceRunId ?? options.contextRunId });
    const savedConfiguration=recovery?.config??(maintenance?maintenanceRecords.find(r=>r.kind==='execution.config')?.data:queued?recoveryRecords(dataRoot,queued.item.target.runId).find(r=>r.seq===queued.item.executionVersion.configSeq)?.data:undefined) as any;
    if(!improve){
      if(savedConfiguration){configuration=retainedExecutionConfig(dataRoot,coding,options.mode,options.toolEnvironment,savedConfiguration);defaults=savedConfiguration.improveDefaults;}
      else if(options.verificationProfile)configuration=applyTaskProfile(configuration,validateTaskProfile(options.verificationProfile));
      else {const current=readImproveDefaults(dataRoot,workspace,coding?'coding':'read');if(current.files.length){defaults=current;configuration=applyTaskProfile(configuration,current.profile);}}
      instructions=configuration.instructions;
    }else configuration={...configuration,instructions};
    let continued:ContextSnapshot|undefined;
    if(options.contextRunId&&!maintenance&&!queued&&!recovery){
      const prior=recoveryRecords(dataRoot,options.contextRunId),accepted=prior.find(r=>r.kind==='task.accepted')?.data as any;
      const closed=(prior.findLast(r=>r.kind==='recovery.closed')?.data as any)?.result??prior.findLast(r=>r.kind==='run.closed')?.data as RunResult|undefined;
      if(!accepted||closed?.status!=='completed'||closed.cleanup!=='confirmed')throw Error('CONTEXT_SOURCE_NOT_COMPLETED');
      if(queueItems(dataRoot).some(i=>i.target.sessionId===accepted.sessionId&&['pending','dispatching','frozen'].includes(i.status)))throw Error('QUEUE_PREDECESSOR_UNRESOLVED');
      verifyArtifact(dataRoot,prior.find(r=>r.kind==='execution.artifact')!.data as ReturnType<typeof captureArtifact>);
      const config=prior.find(r=>r.kind==='execution.config')?.data as any;
      const expected=configuration;
      if(accepted.workspace!==workspace||Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('CONTEXT_EXECUTION_CONFIGURATION_CHANGED');
      if(config.providerBoundary)throw Error('PROVIDER_BOUNDARY_RECOVERY_REQUIRED');
      if(inspected?.selectedSession?.pending||prior.some(r=>r.kind==='recovery.ended'))throw Error('CONTEXT_SOURCE_FROZEN');
      const snapshot=prior.findLast(r=>r.kind==='context.snapshot');if(!snapshot)throw Error('CONTEXT_UNAVAILABLE');
      continued={...(snapshot.data as Omit<ContextSnapshot,'receiptSeq'>),receiptSeq:snapshot.seq};readObject(dataRoot,continued.messages);
    }
    if(maintenance){
      verifyArtifact(dataRoot,maintenanceRecords.find(r=>r.kind==='execution.artifact')!.data as ReturnType<typeof captureArtifact>);
      const config=maintenanceRecords.find(r=>r.kind==='execution.config')?.data as any;
      const expected=retainedExecutionConfig(dataRoot,coding,options.mode,options.toolEnvironment,config);
      if(maintenanceRecords.some(r=>r.kind==='recovery.ended'))throw Error('COMPACTION_SOURCE_ENDED');
      if(workspace!==sourceAccepted.workspace||Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('COMPACTION_EXECUTION_CONFIGURATION_CHANGED');
      if(config.providerBoundary&&(providerBoundary?.operationId!==config.providerBoundary.operationId||providerBoundary?.budget?.id!==config.providerBoundary.budget?.id))throw Error('PROVIDER_BOUNDARY_RECOVERY_REQUIRED');
      if(inspected?.selectedSession?.pending)throw Error('COMPACTION_RECOVERY_REQUIRED: source has frozen durable work');
      if(!maintenance.item){
        const existing=findQueueItem(dataRoot,maintenance.requestId);
        if(existing)throw Error('COMPACTION_ALREADY_PENDING: inspect the saved request');
        if(queueItems(dataRoot).some(i=>i.target.sessionId===sessionId&&['pending','dispatching','frozen'].includes(i.status)))throw Error('QUEUE_PREDECESSOR_UNRESOLVED');
      }else if(findQueueItem(dataRoot,maintenance.requestId)?.status!=='pending')throw Error('QUEUE_NOT_PENDING');
    }
    if(queued) {
      const source=recoveryRecords(dataRoot,queued.item.target.runId);
      const artifact=source.find(record=>record.seq===queued.item.executionVersion.artifactSeq)?.data as ReturnType<typeof captureArtifact>;
      const config=source.find(record=>record.seq===queued.item.executionVersion.configSeq)?.data as Record<string,unknown>;
      verifyArtifact(dataRoot,artifact);
      const expected=retainedExecutionConfig(dataRoot,coding,options.mode,options.toolEnvironment,config);
      if(workspace!==queued.item.target.workspace||!config||Object.entries(expected).some(([key,value])=>JSON.stringify(config[key])!==JSON.stringify(value)))throw Error('QUEUE_EXECUTION_VERSION_OR_AUTHORIZATION_CHANGED');
      const current=findQueueItem(dataRoot,queued.item.requestId);
      if(current?.status!=='pending')throw Error('QUEUE_NOT_PENDING');
      const sourceEvidence=new Evidence(dataRoot,queued.item.target.runId,options.fault);
      try {sourceEvidence.append('control.receipt',{requestId:queued.item.requestId,status:'dispatching',reason:'Saved independent run dispatch intent; original target and context retained'});}finally{sourceEvidence.close();}
    }
    if(improve){
      if(priorImprove(dataRoot,improve.request.id))throw Error('IMPROVE_ALREADY_DISPATCHED');
      const source=recoveryRecords(dataRoot,improve.target.runId),accepted=source.find(r=>r.kind==='task.accepted')?.data as any;
      if(!accepted||accepted.workspace!==workspace||accepted.sessionId!==improve.target.sessionId||accepted.taskId!==improve.target.taskId)throw Error('IMPROVE_TARGET_MISMATCH');
      if(improve.item){const current=findQueueItem(dataRoot,improve.item.requestId);if(current?.status!=='pending'||JSON.stringify(current.target)!==JSON.stringify(improve.target))throw Error('QUEUE_NOT_PENDING');verifyArtifact(dataRoot,source.find(r=>r.seq===current.executionVersion.artifactSeq)!.data as ReturnType<typeof captureArtifact>);
        const receipt=new Evidence(dataRoot,improve.target.runId,options.fault);try{receipt.append('control.receipt',{requestId:improve.request.id,status:'dispatching',reason:'Independent scoped analysis started after preceding coding; original target retained',execution:{runId,sessionId}});}finally{receipt.close();}
      }
    }
    if (stopped) throw new Error(`RUN_CANCELLED_BEFORE_ACCEPTANCE: ${options.cancellation ?? 'exit'}`);
    guard();
    evidence = new Evidence(dataRoot, runId, options.fault);
    if (!recovery) record('preflight', inspected);
    else record('recovery.started', { decisionId: recovery.decision.id, snapshotId: recovery.report.snapshotId, capabilities: recovery.readOnly ? ['read'] : recovery.accepted.authorization.tools, previousRequests: requests, previousUsageUnknown: recovery.previousUsageUnknown, originalStatus: (recovery.report.original as {status:string}).status });
    guard();
    accepted = true;
    if(improve){analysis=prepareImprove(evidence,improve.request,improve.target,guard);providerBoundary={budget:analysis.budget,purpose:'improve',operationId:`improve:${improve.request.id}`};analysisTimer=setTimeout(()=>fatal(Error('BUDGET_DEADLINE')),Math.max(1,Date.parse(analysis.deadline)-Date.now()));}
    const authorization={ tools: improve ? ['evidence_summary','evidence_read','source_view'] : coding ? ['read', 'write', 'edit', 'bash'] : ['read'], execution: improve ? 'scoped-improve-analysis' : coding ? 'trusted-local-coding' : 'trusted-local-read-only', requestLimit: improve?improve.request.limits.maxRequests:8, fileLimitBytes: 256 * 1024, replay: 'unsafe' };
    if (!recovery&&!maintenance) record('task.accepted', { taskId, runId, sessionId, ...(improve?{kind:'improve',improveRequestId:improve.request.id,sourceTarget:improve.target}:{}), input: options.input, workspace, mode: options.mode, origin: improve ? {kind:'improve',source:options.mode==='offline'?'synthetic':options.transport?'diagnostic':'ordinary'} : options.taskOrigin ?? {kind:'coding',source:options.mode==='offline'?'synthetic':options.transport?'diagnostic':'ordinary'}, ...(queued?{queueRequestId:queued.item.requestId,sourceTarget:queued.item.target}:{}), authorization, credentials: { source: options.mode === 'offline' ? 'offline-placeholder' : 'DEEPSEEK_API_KEY', present: true } });
    record('ownership.acquired', { dataRoot: {path:owner.path,claim:owner.claim}, ...(workspaceOwner ? {workspace:{path:workspaceOwner.path,claim:workspaceOwner.claim}}:{}) });
    if (workspaceOwner && !recovery) record('workspace.owner', { root: workspaceOwner.root, workspace, scope: 'protocol participants only; external editors, shared Git metadata and external resources are not isolated' });
    const artifact=maintenance?maintenanceRecords.find(r=>r.kind==='execution.artifact')!.data as ReturnType<typeof captureArtifact>:recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.artifact')!.data as ReturnType<typeof captureArtifact>:captureArtifact(evidence,workspace);
    const artifactSeq=maintenance?maintenanceRecords.find(r=>r.kind==='execution.artifact')!.seq:recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.artifact')!.seq:record('execution.artifact',artifact);
    const models = createModels({ authContext: { env: async name => name === 'DEEPSEEK_API_KEY' ? apiKey : undefined, fileExists: async () => false } });
    models.setProvider(deepseekProvider());
    const model = models.getModel('deepseek', 'deepseek-flash');
    if (!model || model.api !== 'openai-completions' || model.baseUrl !== 'https://api.deepseek.com') throw new Error('MODEL_CONFIGURATION_MISMATCH');
    const settings = improve ? {...configuration.settings,toolExecution:'sequential' as const,stream:{...configuration.settings.stream,maxTokens:improve.request.limits.maxOutputTokens,timeoutMs:improve.request.limits.maxDurationMs}} : options.verificationCompaction ? {...configuration.settings,compaction:{enabled:true,...options.verificationCompaction}} : configuration.settings;
    const configSeq=maintenance?maintenanceRecords.find(r=>r.kind==='execution.config')!.seq:recovery?recoveryRecords(dataRoot,runId).find(record=>record.kind==='execution.config')!.seq:record('execution.config', { cleanupTimeoutMs, ...configuration, settings,...(defaults?{improveDefaults:defaults}:{}),...(options.verificationProfile?{verificationProfile:options.verificationProfile}:{}), ...(providerBoundary?{providerBoundary:{kind:'trusted-dispatch-capability',operationId:providerBoundary.operationId,budget:providerBoundary.budget?{id:providerBoundary.budget.id,root:providerBoundary.budget.evidence.root,runId:providerBoundary.budget.evidence.runId,limits:providerBoundary.budget.limits}:null,recovery:'requires-original-capability; this entry supports readonly or explicit end only'}}:{}), ...(options.verificationCompaction?{verificationCompaction:options.verificationCompaction}:{}), recoveryProtocol: 1, capture: 'ordered Pi request messages, effective provider payload and parsed provider stream events; not HTTP wire bytes; authentication headers excluded' });
    if(maintenance){
      if(!maintenance.item){
        record('control.accepted',{requestId:maintenance.requestId,kind:'compact',input:'compact',taskId:null,target:{workspace,sessionId,taskId,runId},executionVersion:{artifactId:artifact.id,artifactSeq,configSeq},authorization});
        maintenance.item=findQueueItem(dataRoot,maintenance.requestId)!;
      }
      record('compaction.started',{requestId:maintenance.requestId,source:maintenance.source,admissionTarget:maintenance.item.target,executionVersion:{artifactId:artifact.id,artifactSeq,configSeq},allocation:'maintenance',authorization,providerOperation:providerBoundary?{parentOperationId:providerBoundary.operationId,operationId:`maintenance:${maintenance.requestId}`,budgetId:providerBoundary.budget?.id??null,capability:'unchanged original host capability and budget; no new allowance'}:null});
    }
    const actualStream = models.streamSimple.bind(models);
    const actualComplete = models.completeSimple.bind(models);
    // In the fixed Pi Harness, completeSimple is used by the compaction task.
    const requestPurpose = new AsyncLocalStorage<'compaction'>();
    const capturedModels: Models = Object.assign(models, {
      completeSimple: ((requestedModel,context,streamOptions) => requestPurpose.run('compaction',()=>actualComplete(requestedModel,context,streamOptions))) as Models['completeSimple'],
      streamSimple: ((requestedModel, context, streamOptions) => {
        guard();
        if (++requests > (improve?Number.MAX_SAFE_INTEGER:8)) { requests--; throw new Error('REQUEST_LIMIT: this task reached its provider attempt limit'); }
        const attemptId = randomUUID();
        let hasUsage = false, responseRecorded = false, attemptDispatched = false;
        const purpose=requestPurpose.getStore()??(improve?'improve':'generation');
        const completed=(message:AssistantMessage)=>{
          if(responseRecorded)return;responseRecorded=true;responses++;if(hasUsage)usageReports++;
          record('model.response', { attemptId,purpose,allocation:improve?'improve':maintenance?'maintenance':'task',maintenanceRequestId:maintenance?.requestId??null, message: { ...message, ...(message.errorMessage ? { errorMessage: safeError(message.errorMessage) } : {}) }, completeness: message.stopReason==='error'||message.stopReason==='aborted'?'partial':'complete', usage: hasUsage ? 'reported' : 'unknown', remoteTermination: message.stopReason==='error'||message.stopReason==='aborted'?'unknown':'response-returned' });
        };
        record('model.intent', { attemptId, durableTaskId: purpose==='compaction'?null:generationTaskId, ...(purpose==='compaction'?{durableTaskSource:'unknown: Models.completeSimple exposes no owning compaction task ID'}:{}), ordinal: requests, model: { provider: requestedModel.provider, id: requestedModel.id }, context, purpose, allocation:improve?'improve':maintenance?'maintenance':'task',maintenanceRequestId:maintenance?.requestId??null, parentOperationId:providerBoundary?.operationId??null,providerOperationId:maintenance?`maintenance:${maintenance.requestId}`:providerBoundary?.operationId??null, boundary: 'Models.streamSimple', options: { maxRetries: streamOptions?.maxRetries, timeoutMs: streamOptions?.timeoutMs, reasoning: streamOptions?.reasoning, sessionId: streamOptions?.sessionId } });
        const stream = actualStream(requestedModel, context, {
          ...streamOptions, apiKey, fetch: async (url, init) => {
            guard();
            const request={attemptId,purpose,url:String(url),method:init?.method,body:typeof init?.body==='string'?init.body:null};
            record('model.fetch-intent',{...request,boundary:'SDK fetch intent before host admission; not evidence of dispatch'});
            let entered=false;
            const transport:typeof fetch=async(target,requestInit)=>{
              guard();entered=true;attemptDispatched=true;notDispatchedAttempts.delete(attemptId);
              let pending:Promise<Response>;
              try {pending=(options.transport??providerBoundary?.transport??globalThis.fetch)(target,requestInit);}
              catch(error){record('model.dispatch',{...request,transportEntered:true,boundary:'configured host transport entered; provider wire dispatch is not proven here'});throw error;}
              // Preserve the actual entry even for a synchronous transport failure. Intent bytes were saved before this call.
              void pending.catch(()=>{});
              record('model.dispatch',{...request,transportEntered:true,boundary:'configured host transport entered; provider wire dispatch is not proven here'});
              if(defaults&&!defaultsObserved&&!recovery&&!maintenance){defaultsObserved=true;for(const fact of improveFacts(dataRoot).filter(f=>f.kind==='improve.activation'&&(f.data.defaults??[]).some((d:any)=>d.current.revision===defaults!.revision)))record('improve.default-observed',{id:fact.data.id,groupId:fact.data.groupId,activationSource:fact.sourceId,revision:defaults.revision,profileId:defaults.profileId,runId,taskId,configSeq,attemptId,scope:'Actual new task entered configured transport with its fixed profile; not proof of causal improvement'});}
              return pending;
            };
            let response:Response;
            try {
              guard();
              response=providerBoundary
                ?await dispatchProvider({...providerBoundary,purpose,...(maintenance?{operationId:`maintenance:${maintenance.requestId}`} :{}),transport},url,init)
                :await transport(url,init);
            }catch(error){
              if(improve)providerFailure=safeError(error);
              if(!attemptDispatched)notDispatchedAttempts.add(attemptId);
              record('model.dispatch-failed',{...request,dispatched:entered,attemptDispatched,reason:safeError(error),boundary:entered?'configured transport entered; external outcome unknown':'trusted host failed before configured transport entry'});
              throw error;
            }
            httpStatus = response.status;
            record('model.http', { attemptId, status: response.status });
            return response;
          },
          signal: AbortSignal.any([controller.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])]),
          onPayload: payload => { guard(); record('model.payload', { attemptId, payload, boundary: 'Pi provider onPayload before dispatch', transform: '@earendil-works/pi-ai@1.1.0/openai-completions' }); },
          onProviderStreamEvent: event => {
            const candidate = event as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
            if (typeof candidate.usage?.prompt_tokens === 'number' && typeof candidate.usage?.completion_tokens === 'number') hasUsage = true;
            record('model.provider-event', { attemptId,purpose, event, boundary: 'parsed provider event before Pi normalization' });
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
    const tools: ToolRegistration[] = analysis ? analysis.tools : coding ? [createReadTool(), createWriteTool(), createEditTool(), createBashTool({ prepare(execution) { execution.inheritEnv = false; execution.env = { ...shellEnvironment }; } })] : [createReadTool()];
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
    compactions=new CompactionFacts(record,guard,fatal);
    registry.install(defineExtension({ name: improve ? 'pi-durio-improve' : coding ? 'pi-durio-coding' : 'pi-durio-read-only', tools: capturedTools, hooks: [compactions.hook,hook(GenerationTask, { beforeRequest: (request, api) => { guard(); generationTaskId = api.taskId; record('generation.request', { durableTaskId: api.taskId, conversationId: api.conversationId, messages: request.messages }); return undefined; } })] }));
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
      if(improve)return undefined; // No ExecutionEnv exists for restricted evidence/source closures.
      return coding && !recovery?.readOnly ? codingEnvironment(workspace, shellEnvironment!, guard, capture, state => { if (state === 'started') shellsStarted++; else shellsSettled++; }, observedFiles) : readEnvironment(workspace, guard, capture);
    } }, CTX);
    compactions.attach(harness);
    if(recovery)for(const requestId of recovery.frozenRequests??[]) {
      const frozen=await harness.commit(tx=>tx.submissionByRequest(recovery.started.conversationId,requestId),CTX);
      if(!frozen||frozen.status!=='queued'||frozen.id===recovery.submissionId)continue;
      const pending=await harness.submission(frozen.id,CTX);
      if(!pending)throw Error('RECOVERY_QUEUE_SUBMISSION_MISSING');
      const outcome=await pending.abort(CTX); // Public passive withdrawal; never enables scheduling.
      if(outcome!=='aborted'&&outcome!=='settled')throw Error('RECOVERY_QUEUE_PLACEMENT_CHANGED');
      const item=findQueueItem(dataRoot,requestId);
      if(item?.status!=='withdrawn')record('control.receipt',{requestId,status:'frozen',reason:'Recovery retained this old pending steer; continuing the run does not reattach it',upstream:{submissionId:frozen.id,status:(await pending.status(CTX)).status}});
    }
    conversation = maintenance ? await harness.conversation(maintenance.source.sourceConversationId as any,CTX) : recovery ? await harness.conversation(recovery.started.conversationId,CTX) : await harness.root(CTX, { agent: { model: { provider: 'deepseek', modelId: 'deepseek-flash' }, cwd: workspace, instructions } });
    if (!conversation) throw new Error('RECOVERY_CONVERSATION_MISSING');
    if(queued||continued) {
      const source=queued?.context??continued!;
      const messages=JSON.parse(readObject(dataRoot,source.messages).toString());
      // A passive, exactly retained model context import. No source run is opened or resumed.
      record('context.imported',{source,target:queued?.item.target??{workspace,runId:options.contextRunId},policy:'full acquired Pi model context; new independent run and usage'});
      await conversation.commit(tx=>tx.appendEntry(conversation!.id,{kind:'durio.follow-up-context',model:messages}),CTX);
    }
    if (!recovery&&!maintenance) record('run.started', { taskId, sessionId, conversationId: conversation.id });
    guard();
    if(maintenance){
      if(maintenance.item){const receipt=(status:QueueItemFact['status'],reason:string)=>{const source=new Evidence(dataRoot,maintenance.item!.target.runId,options.fault);try{source.append('control.receipt',{requestId:maintenance.requestId,status,reason});}finally{source.close();}};
        receipt('dispatching','Saved compaction dispatch; actual source is fixed at execution');
        compactBinding={target:maintenance.item.target,cancelCompaction:async input=>{validControlId(input.id);if(JSON.stringify(input.target)!==JSON.stringify(maintenance.item!.target)||input.taskId!==compactTask)throw Error('CONTROL_TARGET_CHANGED');record('compaction.cancel-decision',input);return compactions!.cancel(compactTask);},submit:async input=>{
          validControlId(input.id);if(!input.input.trim()||Buffer.byteLength(input.input)>32768)throw Error('INPUT_LIMIT: provide 1–32768 bytes');
          const alias=findCoalescedControl(dataRoot,input.id);if(alias){if(JSON.stringify(alias.input)!==JSON.stringify(input))throw Error('CONTROL_ID_CONFLICT');return findQueueItem(dataRoot,alias.requestId)!;}
          const existing=findQueueItem(dataRoot,input.id);if(existing){if(existing.kind!==input.kind||existing.input!==input.input||JSON.stringify(existing.target)!==JSON.stringify(input.target))throw Error('CONTROL_ID_CONFLICT');return existing;}
          if(input.kind!=='compact'||JSON.stringify(input.target)!==JSON.stringify(maintenance.item!.target))throw Error('COMPACTION_BUSY');
          guard();record('control.coalesced',{id:input.id,requestId:maintenance.requestId,input});return findQueueItem(dataRoot,maintenance.requestId)!;
        },withdraw:async decision=>{
          const current=findQueueItem(dataRoot,maintenance.requestId)!;if(decision.action!=='withdraw'||decision.requestId!==maintenance.requestId||JSON.stringify(decision.target)!==JSON.stringify(current.target))throw Error('CONTROL_TARGET_CHANGED');
          if(current.receipt.seq!==decision.receiptSeq)throw Error('STALE_CONTROL_DECISION');record('control.decision',{decision});
          if(compactTask){const state=await compactions!.cancel(compactTask);receipt(state?.state==='applied'?'applied':'withdrawn',state?.state==='applied'?'Summary already committed; no rollback':'Cancelled only this compaction task or unplaced summary');}
          return findQueueItem(dataRoot,maintenance.requestId)!;}};
        options.control?.attach(compactBinding);
      }
      const compactPromise=compactions.manual(conversation,maintenance.requestId,id=>{compactTask=id;});
      const settled=await Promise.race([compactPromise,stopping]);
      if(settled==='stopped'){if(cancellation==='stop'&&compactTask){record('compaction.cancel-decision',{requestId:maintenance.requestId,taskId:compactTask,source:'stop-current-maintenance'});compactResult=await compactions.cancel(compactTask);}throw Error('COMPACTION_INTERRUPTED');}
      compactResult=settled;
      if(!['applied','noop','cancelled','stale'].includes(settled.state))failure??=settled.reason??'COMPACTION_FAILED';
      if(maintenance.item){const e=new Evidence(dataRoot,maintenance.item.target.runId,options.fault);try{e.append('control.receipt',{requestId:maintenance.requestId,status:['applied','noop'].includes(settled.state)?'applied':['cancelled','stale'].includes(settled.state)?'withdrawn':'frozen',reason:`Compaction ${settled.state}; generated and applied facts are separate`,execution:{runId,sessionId}});}finally{e.close();}}
      record('compaction.operation-result',{requestId:maintenance.requestId,result:settled});
    } else {
    if (recovery) {
      // Public passive commit does not enable scheduling. Preserve upstream interrupted entries; append host facts separately.
      const summary = JSON.stringify({ decision: recovery.decision, toolFacts: {snapshotId:recovery.report.snapshotId,sourceFiles:recovery.report.session?.sourceFiles,counts:recovery.report.details?.toolCounts}, visibleTools: recovery.report.tools, capabilities: recovery.readOnly ? ['read'] : recovery.accepted.authorization.tools, warning: 'Original unknown and usage remain unknown. Committed/completed operations must not be redone. Only explicitly retry-selected or proven not-dispatched operations may be attempted again.' });
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
      controls=new RunControls({root:dataRoot,target:{workspace,sessionId,taskId,runId},version:{artifactId:artifact.id,artifactSeq,configSeq},authorization,conversation,harness,guard,record,failure:fatal,cancelCompaction:id=>compactions!.cancel(id as TaskId<CompactionResult>)});options.control.attach(controls);
      record('control.ready',{target:controls.target,admission:'open'});
    }
    guard(); // wait is an implicit scheduler entry; it cannot bypass the same owner/capability admission.
    const settled = await Promise.race([submission.wait(CTX), stopping]);
    if (settled !== 'stopped') {
      if(settled.status==='done'&&controls)await Promise.race([controls.settleSteers(),stopping]);
      if(stopped)throw Error('RUN_STOPPING');
      if(settled.status==='done')await Promise.race([compactions.settle(),stopping]);
      if(stopped)throw Error('RUN_STOPPING');
      record('submission.settled', settled);
      if(settled.status!=='done')failure??=httpStatus===401||httpStatus===403?'AUTH_REJECTED: DeepSeek rejected credentials; no provider fallback':'TASK_UNANSWERED';
    }
    }
    if(!stopped){
      finalizing = true;
      const view = await conversation.viewState(CTX);
      try { usage = structuredClone(view.value.docs['pi.usage']) as UsageState; } finally { view.dispose(); }
      const context = await conversation.context(CTX);
      if(handoff) {
        handoff.pending=controls?.pending()??[];
        {const messages=evidence.blob(JSON.stringify(context.messages));const receiptSeq=record('context.snapshot',{sourceRunId:runId,sourceSessionId:sessionId,sourceConversationId:conversation.id,messages});handoff.context={sourceRunId:runId,sourceSessionId:sessionId,sourceConversationId:conversation.id,messages,receiptSeq};}
      }
      const last = context.messages.findLast((m): m is AssistantMessage => m.role === 'assistant');
      if (last) answer = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

      record('usage.projection', { source: 'pi.usage', conversationId: conversation.id, value: usage, reportedAttempts: usageReports, requests:requests-notDispatchedAttempts.size, attempts:requests, notDispatchedAttempts:[...notDispatchedAttempts], completeness: completeness(), ...(maintenance?{maintenanceRequestId:maintenance.requestId,allocation:'session-cumulative; manual attempts are maintenance'}:{}) });
    }
  } catch (error) { if (!stopped || failure) failure ??= safeError(error); }
  finally {
    options.signal?.removeEventListener('abort', stop);
    finalizing = true;
    controller.abort();
    if(compactBinding)options.control?.detach(compactBinding);
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
      if (cancellation === 'stop' && conversation && !maintenance) {
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
        const snapshot = await inspectClosedSession(join(sessionOwner.path, 'durable.sqlite'), owner, value => record('durable.closed-snapshot', value));
        if (snapshot.firstUsage) usage = snapshot.firstUsage as UsageState;
      } catch (error) { originalLoss = true; failure ??= safeError(error); }
    }
    if (analysisTimer)clearTimeout(analysisTimer);
    if (evidence) {
      result = { runId, taskId, sessionId, mode: options.mode, status: originalLoss || cleanup === 'unknown' ? 'unknown' : failure ? 'failed' : cancellation ? (cancellation === 'stop' ? 'aborted' : 'unknown') : 'completed', answer, reason: failure ?? (cancellation ? (cancellation === 'stop' ? 'Task aborted; acquired changes and costs remain; remote termination unknown' : 'Application exit preserved unfinished work; explicit recovery required; remote termination unknown') : undefined), observation: observationDegraded ? 'degraded' : 'ok', cleanup,
        lifecycle: { intent: cancellation ?? null, disposition: originalLoss || cleanup === 'unknown' ? 'needs-recovery' : failure ? 'failed' : cancellation === 'stop' ? 'aborted' : cancellation === 'exit' ? 'resumable' : 'completed', cleanupTimeoutMs, storage: storage ? (storageClosed ? 'closed' : 'unknown') : 'not-opened', owner: cleanup === 'confirmed' ? 'release-after-host-close' : 'retained', remoteTermination: 'unknown' },
        ...(coding ? { executionCleanup: { managedCommands: shellsStarted === shellsSettled ? 'settled' as const : 'unknown' as const, started: shellsStarted, settled: shellsSettled, externalProcesses: 'unknown' as const } } : {}),
        usage: { source: 'pi.usage', scope: `session:${sessionId}`, completeness: cleanup === 'confirmed'?completeness():'unknown', value: cleanup==='confirmed'&&(usageReports||maintenance&&previousUsage?.completeness!=='unknown')?usage:null, cost: { kind: 'estimate', currency: 'USD', source: '@earendil-works/pi-ai@1.1.0 model price catalog', observedAt: new Date().toISOString() } } };
      if(analysis){try{result.improve=analysis.finish(answer,failure==='BUDGET_DEADLINE'?failure:providerFailure??failure??(cancellation?`Analysis ${cancellation}; no implicit continuation`:null));}catch(error){result.status='unknown';result.reason=safeError(error);}}
      if(improve?.item){const receipt=new Evidence(dataRoot,improve.target.runId,options.fault);try{receipt.append('control.receipt',{requestId:improve.request.id,status:cancellation||cleanup!=='confirmed'?'frozen':'applied',reason:`Analysis ${result.improve?.state??'unknown'}; report and costs retained, no candidates selected`,execution:{runId,sessionId}});}catch(error){result.status='unknown';result.reason=safeError(error);}finally{receipt.close();}}
      if(maintenance&&compactTask&&!compactResult)compactResult={requestId:maintenance.requestId,taskId:compactTask,state:'interrupted',reason:'No confirmed terminal compaction receipt; inspect saved task/submission facts'};
      if(compactResult)result.compaction=compactResult;
      if(result.status!=='completed')for(const item of handoff?.inheritedPending??[]) {
        const current=findQueueItem(dataRoot,item.requestId);if(!current||!['pending','dispatching'].includes(current.status))continue;
        const source=new Evidence(dataRoot,item.target.runId,options.fault);
        try{source.append('control.receipt',{requestId:item.requestId,status:'frozen',reason:`Preceding run ${runId} ${result.status}; explicit source-bound decision required`});}catch(error){result.status='unknown';result.reason=safeError(error);}finally{source.close();}
      }
      try { record(maintenance?'compaction.closed':recovery ? 'recovery.closed' : 'run.closed', maintenance?{requestId:maintenance.requestId,result}:recovery ? { decisionId: recovery.decision.id, result, originalStatus: (recovery.report.original as {status:string}).status, previousUsageUnknown: recovery.previousUsageUnknown } : result); } catch { result.status = 'unknown'; result.reason = 'EVIDENCE_FAILURE: close receipt could not be saved'; }
      if (timedOut) {
        // The caller may stop waiting, but active writers still own their storage.
        // Never promote the earlier unknown receipt or auto-release owners after a late close.
        void shutdown.then(() => lifecycleRecord('lifecycle.late-close', { storage: storageClosed ? 'closed' : 'unknown', owner: 'retained', recoveryRequired: true }), error => lifecycleRecord('lifecycle.late-close-failed', { reason: safeError(error), owner: 'retained' })).finally(() => evidence!.close());
      } else evidence.close();
    }
    compactions?.close();
    if(maintenance?.item&&(!compactResult||!['applied','noop','cancelled','stale'].includes(compactResult.state))){const e=new Evidence(dataRoot,maintenance.item.target.runId);try{e.append('control.receipt',{requestId:maintenance.requestId,status:'frozen',reason:'Compaction interrupted or failed; inspect actual task and submission before reuse'});}finally{e.close();}}
    if (cleanup === 'confirmed') { await sessionOwner?.release(); await workspaceOwner?.release(); await owner.release(); }
  }
  if (!result) throw new Error(failure ?? (stopped ? `RUN_CANCELLED_BEFORE_ACCEPTANCE: ${cancellation ?? options.cancellation ?? 'exit'}` : 'RUN_NOT_ACCEPTED'));
  return result;
}
