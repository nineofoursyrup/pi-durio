import { join, dirname } from 'node:path';
import { readdir, realpath, access, readFile, stat, mkdir, rename, rmdir } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { hostname } from 'node:os';
import { Evidence, digest, openHostReadonly, readObject, type EvidenceRecord, type BlobRef } from './evidence.js';
import { acquireOwner, type OwnerLease } from './ownership.js';
import { inspectSession } from './preflight.js';
import { verifyArtifact } from './artifact.js';
import { retainedExecutionConfig } from './execution-config.js';
import { resolveWorkspaceRoot } from './workspace-ownership.js';
import type { ToolEnvironmentConfig } from './coding-environment.js';
import type { SubmissionId } from '@earendil-works/pi-durable';
import type { RunResult } from './runtime.js';

export type ToolName = 'read' | 'write' | 'edit' | 'bash';
export interface RecoveryAuthorization {
  workspace: string; mode: 'live' | 'offline'; tools: readonly ToolName[];
  toolEnvironment?: ToolEnvironmentConfig;
}
export interface RecoveryOptions { dataRoot: string; runId: string; authorization?: RecoveryAuthorization }
export interface RecoveryTool {
  taskId: number; callId: string; tool: string; args: unknown;
  fact: 'committed' | 'completed-uncommitted' | 'not-dispatched' | 'unknown'; evidence: number[];
  resolution?: {decisionId:string;choice:'retry'|'skip'|'completed';reason:string};
}
export interface RecoveryDecision {
  id: string; snapshotId: string; action: 'continue' | 'end';
  acceptAdditionalModelAttempts?: boolean;
  resolutions?: { taskId: number; choice: 'retry' | 'skip' | 'completed'; reason: string }[];
}
export interface RecoveryReport {
  runId: string; snapshotId: string; status: 'completed' | 'needs-decision' | 'blocked' | 'ended'; exitCode: 0 | 75;
  reasons: string[]; options: string[]; original: unknown;
  tools: RecoveryTool[]; unknownModelAttempts: string[]; remainingModelAttempts: number;
  compactions?:{taskId:number;reason:string;status:string;submissionId?:number;submissionStatus?:string;entryId?:number}[];
  session?: { id: string; sourceFiles: {path:string;sha256:string}[]; pending: {kind:string;id:number;status:string}[]; taskCount:number; submissionCount:number };
  persistence?: 'saved' | 'not-requested' | 'owner-blocked' | 'saved-separate-owner-report';
  ownerClaims?: OwnerClaim[];
  needsInput?: { reason:string; options:string[]; risks:string[] };
  decisionId?: string;
}
export function recoveryRecords(root: string, runId?: string): EvidenceRecord[] {
  const db = openHostReadonly(root);
  try { return db.prepare(`SELECT seq,kind,at,body FROM records ${runId ? 'WHERE run_id=?' : ''} ORDER BY seq`).all(...(runId ? [runId] : [])).map(row => ({ seq: Number(row.seq), kind: String(row.kind), at: String(row.at), data: JSON.parse(readObject(root, JSON.parse(String(row.body)) as BlobRef).toString()) })); }
  finally { db.close(); }
}
function freezePendingControls(evidence:Evidence,records:EvidenceRecord[]) {
  for(const record of records.filter(record=>record.kind==='control.accepted')) {
    const admission=record.data as any;
    const state=records.findLast(record=>record.kind==='control.receipt'&&(record.data as any).requestId===admission.requestId)?.data as any;
    if(!state||state.status==='pending'||state.status==='dispatching')evidence.append('control.receipt',{requestId:admission.requestId,status:'frozen',reason:'Recovery check freezes unapplied inputs; closing the panel or continuing old work never reattaches them'});
  }
}
interface OwnerClaim { path:string; markerSha256:string; claim:{pid:number;host:string;token?:string}; lock:{ino:number;mtimeMs:number}|null }
async function ownerClaims(root:string,records:EvidenceRecord[]):Promise<OwnerClaim[]> {
  const acquired=last(records,'ownership.acquired');
  const session=last(records,'ownership.session');
  const known=[acquired?.workspace,session,acquired?.dataRoot].filter(Boolean) as {path:string;claim:OwnerClaim['claim']}[];
  if (!known.some(item=>item.path===root)) known.push({path:root,claim:{pid:0,host:''}});
  const claims:OwnerClaim[]=[];
  for(const item of known) {
    let bytes:Buffer;
    try {bytes=await readFile(join(item.path,'owner.json'));} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    let lock:OwnerClaim['lock']=null;
    try {const info=await stat(`${item.path}.lock`);lock={ino:info.ino,mtimeMs:info.mtimeMs};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    claims.push({path:item.path,markerSha256:digest(bytes),claim:JSON.parse(bytes.toString()),lock});
  }
  return claims;
}
async function saveOwnerReport(root:string,report:RecoveryReport) {
  const dir=join(root,'recovery-owner-reports');await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,`${report.snapshotId}-${digest(JSON.stringify(report))}.json`);
  try {const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(report));fsyncSync(fd);}finally{closeSync(fd);}const folder=openSync(dir,'r');try{fsyncSync(folder);}finally{closeSync(folder);}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
}
const last = (records: EvidenceRecord[], kind: string): any => records.findLast(r => r.kind === kind)?.data;
const identity = (files: {path:string;sha256:string}[]) => digest(JSON.stringify(files));
function authorizationIdentity(auth?:RecoveryAuthorization) {
  if(!auth)return undefined;
  const environment=auth.toolEnvironment;
  return {...auth,...(environment?{toolEnvironment:{version:environment.version,names:Object.keys(environment.variables).sort(),digest:digest(JSON.stringify(Object.entries(environment.variables).sort(([a],[b])=>a.localeCompare(b))))}}:{})};
}
export function sessionWasEnded(records: EvidenceRecord[], sessionId: string, files: {path:string;sha256:string}[]) {
  return records.some(record => record.kind === 'recovery.ended' && (record.data as any).sessionId === sessionId && (record.data as any).sourceId === identity(files));
}

export async function inspectOwnedRecovery(options: RecoveryOptions, owner: OwnerLease) {
  owner.assertHeld();
  const records = recoveryRecords(owner.path, options.runId);
  const accepted = last(records, 'task.accepted');
  if (!accepted || !/^[a-f0-9-]{36}$/.test(accepted.sessionId)) throw new Error('RUN_NOT_FOUND');
  const original = last(records, 'run.closed') ?? { status: 'unknown', reason: 'No original close receipt' };
  for (const marker of [join(owner.path,'sessions',accepted.sessionId,'owner.json'),join(owner.path,'sessions',`${accepted.sessionId}.lock`)]) {
    try { await access(marker); throw new Error('OWNER_CONFLICT: unresolved session owner'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const session = await inspectSession(join(owner.path, 'sessions', accepted.sessionId, 'durable.sqlite'), owner);
  const started = last(records, 'run.started');
  const allRecords = recoveryRecords(owner.path);
  const reasons: string[] = [];
  const tools: RecoveryTool[] = [];
  const pending = session.tasks.filter(t => t.state.status !== 'terminal');
  const submission = session.submissions.find(item => item.type === 'input' && item.requestId === accepted.taskId && item.conversationId === started?.conversationId);
  const steerIds=new Set(records.filter(record=>record.kind==='control.accepted'&&(record.data as any).kind==='steer'&&(record.data as any).target?.runId===options.runId&&(record.data as any).taskId===accepted.taskId).map(record=>(record.data as any).requestId));
  const ownedSubmissions=session.submissions.filter(item=>item.conversationId===started?.conversationId&&(item.id===submission?.id||item.type==='input'&&steerIds.has(item.requestId)));
  const compactIds=new Set(records.filter(r=>r.kind==='compaction.task').map(r=>(r.data as any).taskId));
  const compactTasks=session.tasks.filter(t=>t.kind==='pi.compaction'&&t.version===1&&t.conversationId===started?.conversationId&&compactIds.has(t.id));
  const compactions=compactTasks.map(t=>{const result=t.state.status==='terminal'&&t.state.outcome.status==='completed'?t.state.outcome.result:undefined;const summary=session.submissions.find(s=>s.id===result?.submissionId&&s.type==='write'&&s.requestId===`compaction:${t.id}`);return {taskId:t.id,reason:t.input.reason,status:t.state.status==='terminal'?t.state.outcome.status:t.state.status,...(summary?{submissionId:summary.id,submissionStatus:summary.status,entryId:summary.entry}:{}),...(result?.entryId!==undefined?{entryId:result.entryId}:{})};});
  const compactSubmissionIds=new Set(compactions.flatMap(c=>c.submissionId===undefined?[]:[c.submissionId]));
  const ownedSubmissionIds=new Set(ownedSubmissions.map(item=>item.id));
  const notDispatched=new Set(records.filter(r=>r.kind==='model.dispatch-failed'&&(r.data as any).dispatched===false&&(r.data as any).attemptDispatched===false).map(r=>(r.data as any).attemptId));
  for(const r of records)if(r.kind==='model.dispatch'&&(r.data as any).transportEntered===true)notDispatched.delete((r.data as any).attemptId);
  const unknownModelAttempts = records.filter(r => r.kind === 'model.intent' && !notDispatched.has((r.data as any).attemptId) && !records.some(response => response.kind === 'model.response' && (response.data as any).attemptId === (r.data as any).attemptId && (response.data as any).usage === 'reported')).map(r => (r.data as any).attemptId as string);
  const remainingModelAttempts = Math.max(0, 8 - records.filter(r => r.kind === 'model.intent').length);
  for (const task of session.tasks.filter(t => t.kind === 'pi.tool')) {
    const input = task.input as { assistant:number;callId:string };
    const assistant = session.entries.find(entry => entry.id === input.assistant);
    const message = assistant?.model?.[0];
    const call = message?.role === 'assistant' ? message.content.find(part => part.type === 'toolCall' && part.id === input.callId) : undefined;
    if (!call || call.type !== 'toolCall') { reasons.push(`DURABLE_TOOL_IDENTITY_MISSING:${task.id}`); continue; }
    const facts = records.filter(r => (r.data as any)?.durableTaskId === task.id);
    const outcome = task.state.outcome;
    const result = task.state.status === 'terminal' && outcome?.status === 'completed' ? session.entries.find(entry => entry.id === outcome.result?.entryId) : undefined;
    const hostResult = facts.find(r => r.kind === 'tool.result');
    const dispatch = facts.find(r => r.kind === 'tool.dispatch');
    const phase = 'checkpoint' in task.state ? task.state.checkpoint?.phase : undefined;
    const fact: RecoveryTool['fact'] = result?.kind === 'pi.tool-result' ? 'committed' : hostResult ? 'completed-uncommitted' : (phase === 'call' || (!dispatch && last(records,'execution.config')?.recoveryProtocol === 1 && !records.some(r => r.kind === 'evidence.gap'))) ? 'not-dispatched' : 'unknown';
    const previous=records.findLast(r=>r.kind==='recovery.decision'&&(r.data as any).decision.resolutions?.some((resolution:any)=>resolution.taskId===task.id))?.data as any;
    const resolution=previous?.decision.resolutions?.find((resolution:any)=>resolution.taskId===task.id);
    tools.push({ taskId: task.id, callId: input.callId, tool: call.name, args: phase === 'execute' ? task.state.checkpoint.arguments : call.arguments, fact, evidence: facts.filter(r => ['tool.intent','tool.dispatch','tool.result','tool.error'].includes(r.kind)).map(r => r.seq),...(resolution?{resolution:{decisionId:previous.decision.id,choice:resolution.choice,reason:resolution.reason}}:{}) });
  }
  // No raw Harness escapes this boundary. Every live task/submission in the whole store must belong to this run.
  if (!started || !submission) reasons.push('CROSS_STORE_GAP: missing run/conversation/submission identity; never resend an unknown admission');
  if (session.submissions.some(item => (item.status === 'queued' || item.status === 'placed') && !ownedSubmissionIds.has(item.id)&&!compactSubmissionIds.has(item.id))) reasons.push('OTHER_PENDING_SUBMISSION');
  const executionPending=pending.filter(task=>!compactTasks.some(c=>c.id===task.id));
  if(compactions.some(c=>c.status!=='completed'&&c.status!=='failed'&&c.status!=='aborted'||c.submissionStatus==='queued'))reasons.push('COMPACTION_FROZEN: automatic/manual tasks and unapplied summaries remain quarantined; explicitly end this source before new work');
  if (executionPending.some(task => task.conversationId !== started?.conversationId || task.background || !['pi.generation','pi.tool'].includes(task.kind) || task.version !== 1)) reasons.push('OTHER_PENDING_TASK_OR_UNSUPPORTED_DEFINITION');
  const live=session.live.find(item=>item.conversationId===started?.conversationId)?.value;
  const controlledRun=live?.run?.inputs.length&&live.run.inputs.every(id=>ownedSubmissionIds.has(id)) ? live.run.taskId : undefined;
  if (executionPending.some(task=>task.kind==='pi.generation' ? task.id!==controlledRun : task.owner!==controlledRun)) reasons.push('OTHER_PENDING_TASK_OUTSIDE_ACCEPTED_RUN');
  if (executionPending.some(task=>task.abortRequested)) reasons.push('DURABLE_ABORT_INTENT_PRESERVED');
  if (executionPending.some(task=>'checkpoint' in task.state && (task.kind==='pi.tool' ? !['call','execute'].includes(task.state.checkpoint?.phase)||task.state.checkpoint?.phase==='execute'&&task.state.checkpoint.replay!=='unsafe' : !['prepare','request','retry','tools'].includes(task.state.checkpoint?.phase)))) reasons.push('UNSUPPORTED_EXECUTION_CHECKPOINT');
  for (const dir of await readdir(join(owner.path,'sessions'), {withFileTypes:true})) {
    if (!dir.isDirectory()) { reasons.push('SESSION_STORAGE_ALIAS'); continue; }
    if (dir.name === accepted.sessionId) continue;
    const other = await inspectSession(join(owner.path,'sessions',dir.name,'durable.sqlite'),owner);
    if (other.pending.length && !sessionWasEnded(allRecords,dir.name,other.sourceFiles)) reasons.push(`OTHER_SESSION_PENDING:${dir.name}`);
    const otherAccepted = allRecords.find(r => r.kind === 'task.accepted' && (r.data as any).sessionId === dir.name);
    if (!otherAccepted) reasons.push(`SESSION_WITHOUT_HOST_IDENTITY:${dir.name}`);
  }
  for(const start of records.filter(r=>r.kind==='compaction.started')){const requestId=(start.data as any).requestId;const closed=records.findLast(r=>r.kind==='compaction.closed'&&(r.data as any).requestId===requestId)?.data as any;if(!closed||closed.result?.status==='unknown'||closed.result?.cleanup!=='confirmed')reasons.push(`COMPACTION_OUTCOME_UNKNOWN:${requestId}: original maintenance fact requires explicit disposition`);}
  const ended = sessionWasEnded(records, accepted.sessionId, session.sourceFiles);
  const settled = !session.pending.length && submission?.status === 'done';
  const config = last(records,'execution.config');
  const coding = accepted.authorization?.execution === 'trusted-local-coding';
  if (!settled && !ended) {
    try { verifyArtifact(owner.path,last(records,'execution.artifact')); } catch (error) { reasons.push(String(error)); }
    if (!options.authorization) reasons.push('CURRENT_AUTHORIZATION_REQUIRED');
    else {
      const auth = options.authorization;
      const workspace = await realpath(auth.workspace);
      if (workspace !== accepted.workspace || auth.mode !== accepted.mode) reasons.push('WORKSPACE_OR_MODE_CHANGED');
      if (JSON.stringify([...auth.tools].sort()) !== JSON.stringify([...accepted.authorization.tools].sort())) reasons.push('CURRENT_PERMISSION_CHANGED');
      if (coding) {
        const previous = last(records,'workspace.owner');
        if (!previous || previous.root !== await resolveWorkspaceRoot(workspace)) reasons.push('WORKSPACE_ROOT_CHANGED');
      }
      const expected = retainedExecutionConfig(owner.path,coding,auth.mode,auth.toolEnvironment,config);
      if (!config || config.recoveryProtocol !== 1 || Object.entries(expected).some(([key,value]) => JSON.stringify(config[key]) !== JSON.stringify(value))) reasons.push('EXECUTION_CONFIGURATION_CHANGED');
      const agent = session.agents.find(agent => agent.conversationId === started?.conversationId)?.value as any;
      if (!agent || agent.cwd !== accepted.workspace || agent.instructions !== expected.instructions || agent.model?.provider !== 'deepseek' || agent.model?.modelId !== 'deepseek-flash' || agent.tools !== undefined || agent.extensions !== undefined || agent.thinkingLevel !== undefined) reasons.push('DURABLE_AGENT_CHANGED');
    }
    if (records.some(r => r.kind === 'run.abort-intent')) reasons.push('STOP_INTENT_PRESERVED: end old work; do not resume it as pending');
    if (!remainingModelAttempts) reasons.push('REQUEST_LIMIT_EXHAUSTED');
    if (original.cleanup === 'unknown' && !records.some(r => r.kind === 'lifecycle.late-close' && (r.data as any).storage === 'closed')) reasons.push('CLEANUP_UNCONFIRMED');
  }
  const snapshotId = digest(JSON.stringify({ source:session.sourceFiles, facts:records.filter(r => !r.kind.startsWith('recovery.')||r.kind==='recovery.decision').map(r => [r.seq,r.kind,r.data]), authorization:authorizationIdentity(options.authorization), reasons }));
  const status: RecoveryReport['status'] = ended ? 'ended' : reasons.length ? 'blocked' : settled ? 'completed' : 'needs-decision';
  const report: RecoveryReport = { runId:options.runId,snapshotId,status,exitCode:status === 'completed'||status === 'ended'?0:75,reasons,options:status === 'completed'||status === 'ended'?[]:reasons.length?['inspect','end']:['inspect','continue','end'],original,tools,compactions,unknownModelAttempts,remainingModelAttempts,session:{id:accepted.sessionId,sourceFiles:session.sourceFiles,pending:session.pending,taskCount:session.tasks.length,submissionCount:session.submissions.length},persistence:'not-requested' };
  if(reasons.some(reason=>/OTHER_PENDING|OTHER_SESSION|SESSION_WITHOUT|ALIAS/.test(reason))) report.options=['inspect','external-verification'];
  if(report.exitCode===75) report.needsInput={reason:reasons.length?reasons.join('; '):'Explicit continuation or ending is required',options:report.options,risks:[...tools.filter(tool=>tool.fact==='unknown').map(tool=>`Tool ${tool.taskId} (${tool.tool}) may already have changed files or external resources; a retry may duplicate its effects. Resolve with retry, skip, completed, or end.`),...(unknownModelAttempts.length?['A new model request may add fees; earlier unknown/partial usage stays unknown/partial.']:[])]};
  return { report, records, session, accepted, started, submission, ownedSubmissions, config, coding };
}

/** No source database changes, model, tool, migration, or ordinary Harness open. Owner markers are temporary coordination only. */
export async function inspectRecovery(options: RecoveryOptions): Promise<RecoveryReport> {
  const records = recoveryRecords(options.dataRoot,options.runId);
  if (!last(records,'task.accepted')) throw new Error('RUN_NOT_FOUND');
  let owner: OwnerLease | undefined;
  try { owner = await acquireOwner(options.dataRoot, () => {}); return (await inspectOwnedRecovery(options,owner)).report; }
  catch (error) {
    const claims=(await ownerClaims(await realpath(options.dataRoot),records)).filter(claim=>claim.path!==owner?.path);
    return { runId:options.runId,snapshotId:digest(JSON.stringify({facts:records.map(r => [r.seq,r.kind]),claims})),status:'blocked',exitCode:75,reasons:[String(error)],options:['inspect','confirm-cleanup'],original:last(records,'run.closed')??{status:'unknown'},tools:[],unknownModelAttempts:[],remainingModelAttempts:0,persistence:'owner-blocked',ownerClaims:claims,needsInput:{reason:'Ownership or stable snapshot unavailable',options:['inspect','confirm-cleanup'],risks:['No durable store was opened. PID disappearance or user consent alone cannot establish cleanup.']} };
  } finally { await owner?.release(); }
}
/** Explicit check persists a separate report, without changing execution state. Read-only show/inspect never calls this. */
export async function checkRecovery(options: RecoveryOptions): Promise<RecoveryReport> {
  let owner: OwnerLease | undefined;
  try {
    owner = await acquireOwner(options.dataRoot, () => {});
    const evidence = new Evidence(owner.path,options.runId);
    try {
      freezePendingControls(evidence,recoveryRecords(owner.path,options.runId));
      const {report}=await inspectOwnedRecovery(options,owner);
      if(report.compactions?.length)evidence.append('recovery.compaction-frozen',{snapshotId:report.snapshotId,compactions:report.compactions,reason:'Recovery check never opens Harness; no pending summary is admitted'});
      report.persistence='saved'; evidence.append('recovery.report',report);return report;
    }
    finally { evidence.close(); }
  } catch (error) {
    if (String(error).includes('OWNER_CONFLICT')) {const report=await inspectRecovery(options);report.persistence='saved-separate-owner-report';await saveOwnerReport(options.dataRoot,report);return report;}
    throw error;
  } finally { await owner?.release(); }
}
/** Only an observed, completed managed cleanup can settle a retained owner. A raw crash remains blocked. */
export async function settleRecoveryOwners(options:RecoveryOptions & {decision:{id:string;snapshotId:string;action:'confirm-cleanup';acceptUnknownExternalEffects:boolean}}):Promise<RecoveryReport> {
  const root=await realpath(options.dataRoot);
  const gate=await acquireOwner(join(dirname(root),`.durio-recovery-${digest(root)}`),()=>{});
  try {
    const records=recoveryRecords(root,options.runId);
    const previous=records.findLast(r=>r.kind==='recovery.owner-settled'&&(r.data as any).decision.id===options.decision.id)?.data as any;
    if(previous){if(JSON.stringify(previous.decision)!==JSON.stringify(options.decision))throw new Error('DECISION_ID_CONFLICT');return previous.report;}
    const report=await inspectRecovery(options);
    if(report.snapshotId!==options.decision.snapshotId)throw new Error('STALE_RECOVERY_DECISION');
    if(options.decision.action!=='confirm-cleanup'||!options.decision.acceptUnknownExternalEffects||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.decision.id))throw new Error('INVALID_OWNER_DECISION');
    const closing=records.findLast(r=>r.kind==='lifecycle.storage-closing');
    const closed=records.findLast(r=>r.kind==='lifecycle.storage-closed');
    const cleanup=(closing?.data as any)?.managedCommands;
    if(!closing||!closed||closed.seq<closing.seq||!cleanup||cleanup.started!==cleanup.settled) {
      report.reasons.push('CLEANUP_EVIDENCE_REQUIRED: no confirmed storage close with every managed command settled; raw crashes require independent external cleanup and cannot be released by this operation');
      report.persistence='saved-separate-owner-report';await saveOwnerReport(root,report);return report;
    }
    const acquired=last(records,'ownership.acquired');
    const known=[acquired?.workspace,last(records,'ownership.session'),acquired?.dataRoot].filter(Boolean) as {path:string;claim:OwnerClaim['claim']}[];
    for(const claim of report.ownerClaims??[]) {
      if(!known.some(item=>item.path===claim.path&&item.claim.token&&item.claim.token===claim.claim.token))throw new Error('OWNER_IDENTITY_UNVERIFIED');
      if(claim.claim.host!==hostname()||!Number.isSafeInteger(claim.claim.pid)||claim.claim.pid<=0)throw new Error('OWNER_HOST_UNVERIFIED');
      try{process.kill(claim.claim.pid,0);throw new Error('OWNER_STILL_ALIVE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      if(claim.lock&&(await readdir(`${claim.path}.lock`)).length)throw new Error('OWNER_LOCK_CONTENT_UNKNOWN');
    }
    if(!report.ownerClaims?.length)throw new Error('NO_RETAINED_OWNER');
    if(JSON.stringify(await ownerClaims(root,records))!==JSON.stringify(report.ownerClaims))throw new Error('OWNER_CHANGED');
    const dir=join(root,'recovery-owner-decisions',options.decision.id);await mkdir(dir,{recursive:true,mode:0o700});
    const receipt={decision:options.decision,claims:report.ownerClaims,cleanupEvidence:[closing.seq,closed.seq],externalProcesses:'unknown',classification:'explicit owner disposition backed by managed cleanup and owner liveness checks; not proof of all external effects stopping'};
    const fd=openSync(join(dir,'decision.json'),'wx',0o600);try{writeFileSync(fd,JSON.stringify(receipt));fsyncSync(fd);}finally{closeSync(fd);}
    for(const [index,claim] of report.ownerClaims.entries()) {
      if(digest(await readFile(join(claim.path,'owner.json')))!==claim.markerSha256)throw new Error('OWNER_CHANGED');
      if(claim.lock)await rmdir(`${claim.path}.lock`);
      await rename(join(claim.path,'owner.json'),join(dir,`${index}.owner.json`));
    }
    const owner=await acquireOwner(root,()=>{});
    try{const evidence=new Evidence(root,options.runId);try{const result={...report,ownerClaims:[],reasons:['Retained protocol owners settled; original external-process and cost uncertainty remains. Recheck before an explicit continuation.'],options:['inspect','check'],decisionId:options.decision.id,persistence:'saved' as const};evidence.append('recovery.owner-settled',{...receipt,report:result});return result;}finally{evidence.close();}}
    finally{await owner.release();}
  } finally {await gate.release();}
}
export interface RecoveryPlan {
  owner: OwnerLease; report: RecoveryReport; records: EvidenceRecord[]; accepted: any; started: any; config: any; coding: boolean;
  submissionId: SubmissionId; decision: RecoveryDecision; readOnly: boolean; previousRequests: number; previousUsageUnknown: boolean;
  adopted?:boolean;
  frozenSubmissions?:{id:SubmissionId;requestId:string}[];
}
export async function prepareRecovery(options: RecoveryOptions & {decision:RecoveryDecision}) : Promise<RecoveryPlan | RecoveryReport | RunResult> {
  let owner:OwnerLease;
  try {owner=await acquireOwner(options.dataRoot,()=>{});}
  catch(error) {if(String(error).includes('OWNER_CONFLICT'))return checkRecovery(options);throw error;}
  let transfer = false;
  try {
    const records = recoveryRecords(owner.path,options.runId);
    const prior = records.find(r => r.kind === 'recovery.decision' && (r.data as any).decision.id === options.decision.id)?.data as any;
    if (prior) {
      if (JSON.stringify(prior.decision) !== JSON.stringify(options.decision) || JSON.stringify(prior.authorization) !== JSON.stringify(authorizationIdentity(options.authorization))) throw new Error('DECISION_ID_CONFLICT');
      const result = records.findLast(r => r.kind === 'recovery.closed' && (r.data as any).decisionId === options.decision.id)?.data as any;
      if (result) return result.result;
      const ended = records.findLast(r => r.kind === 'recovery.ended' && (r.data as any).decisionId === options.decision.id)?.data as any;
      if (ended) return ended.report;
      const report = (await inspectOwnedRecovery(options,owner)).report;
      return {...report,status:'needs-decision',exitCode:75,reasons:[...report.reasons,'PREVIOUS_DECISION_OUTCOME_UNKNOWN: inspect current facts and submit a new decision id'],decisionId:options.decision.id};
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.decision.id)) throw new Error('INVALID_DECISION_ID');
    const inspected = await inspectOwnedRecovery(options,owner);
    const {report,session,accepted,started,submission,ownedSubmissions,config,coding} = inspected;
    if (options.decision.snapshotId !== report.snapshotId) throw new Error('STALE_RECOVERY_DECISION');
    const evidence = new Evidence(owner.path,options.runId);
    try {
      report.persistence='saved';evidence.append('recovery.report',report);
      if (report.status === 'completed' || report.status === 'ended') return report;
      const resolutions = options.decision.resolutions ?? [];
      if (new Set(resolutions.map(r => r.taskId)).size !== resolutions.length || resolutions.some(r => !report.tools.some(t => t.taskId === r.taskId && t.fact==='unknown') || !['retry','skip','completed'].includes(r.choice) || !r.reason?.trim())) throw new Error('INVALID_RECOVERY_RESOLUTION');
      if (options.decision.action === 'end') {
        // Host quarantine never opens the old store or starts an unrelated pending task.
        // Unknown ownership/extra work cannot be silently ended on behalf of a different run.
        if (report.reasons.some(reason => /OTHER_PENDING|OTHER_SESSION|SESSION_WITHOUT|ALIAS/.test(reason))) return report;
        freezePendingControls(evidence,inspected.records);
        evidence.append('recovery.decision',{decision:options.decision,authorization:authorizationIdentity(options.authorization),originalStatus:(report.original as any).status,classification:'user-choice; does not establish past success or cleanup'});
        const ended: RecoveryReport = {...report,status:'ended',exitCode:0,options:[],decisionId:options.decision.id,persistence:'saved'};
        evidence.append('recovery.ended',{decisionId:options.decision.id,sessionId:accepted.sessionId,sourceId:identity(session.sourceFiles),report:ended,disposition:'host-quarantined; durable originals and unknown facts retained; this store will never be scheduled'});
        return ended;
      }
      if (options.decision.action !== 'continue') throw new Error('INVALID_RECOVERY_ACTION');
      if (report.status === 'blocked') return report;
      if (!options.decision.acceptAdditionalModelAttempts) report.reasons.push('ADDITIONAL_MODEL_ATTEMPTS_REQUIRE_EXPLICIT_ACCEPTANCE: retries may incur new costs; previous unknown usage remains unknown');
      for (const tool of report.tools.filter(tool => tool.fact === 'unknown'&&!tool.resolution)) if (!resolutions.some(r => r.taskId === tool.taskId)) report.reasons.push(`TOOL_OUTCOME_UNKNOWN:${tool.taskId}: retry may duplicate external effects; choose retry, skip, completed, or end`);
      if (report.reasons.length) { report.persistence='saved'; evidence.append('recovery.report',report); return report; }
      freezePendingControls(evidence,inspected.records);
      evidence.append('recovery.decision',{decision:options.decision,authorization:authorizationIdentity(options.authorization),originalStatus:(report.original as any).status,classification:'user-choice; does not establish past success or cleanup'});
      const readOnly = report.tools.some(tool => tool.fact === 'completed-uncommitted'||tool.resolution&&tool.resolution.choice!=='retry') || resolutions.some(r => r.choice !== 'retry');
      transfer=true;
      return {owner,report,records:inspected.records,accepted,started,submissionId:(ownedSubmissions.find(item=>item.status==='placed')??submission)!.id,config,coding,decision:options.decision,readOnly,previousRequests:8-report.remainingModelAttempts,previousUsageUnknown:report.unknownModelAttempts.length>0,
        frozenSubmissions:ownedSubmissions.filter(item=>item.status==='queued'&&item.id!==submission!.id).map(item=>({id:item.id,requestId:item.requestId!}))};
    } finally { evidence.close(); }
  } finally { if (!transfer) await owner.release(); }
}
