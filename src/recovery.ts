import { join, dirname } from 'node:path';
import { readdir, realpath, access, readFile, stat, mkdir, rename, rmdir } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { hostname } from 'node:os';
import { Evidence, digest } from './evidence.js';
import { acquireOwner, type OwnerLease } from './ownership.js';
import { inspectSnapshot, inspectAdmission } from './preflight.js';
import { forEachDirectory } from './storage-projection.js';
import { DetailPage, projectRecovery, recoverySteerRequests, boundedText, type RecoveryPage, type DetailSummary } from './recovery-projection.js';
import { recoveryRecords, recoverySnapshotId, ownerSnapshotId, type RecoveryRecords } from './recovery-facts.js';
export { recoveryRecords } from './recovery-facts.js';
import { verifyArtifact } from './artifact.js';
import { retainedExecutionConfig } from './execution-config.js';
import { resolveWorkspaceRoot } from './workspace-ownership.js';
import type { ToolEnvironmentConfig } from './coding-environment.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { EntryId, TaskId } from '@earendil-works/pi-durable';
import type { SubmissionId } from '@earendil-works/pi-durable';
import type { RunResult } from './runtime.js';

export type ToolName = 'read' | 'write' | 'edit' | 'bash';
export interface RecoveryAuthorization {
  workspace: string; mode: 'live' | 'offline'; tools: readonly ToolName[];
  toolEnvironment?: ToolEnvironmentConfig;
}
export interface RecoveryOptions { dataRoot: string; runId: string; authorization?: RecoveryAuthorization; page?: RecoveryPage }
export interface RecoveryTool {
  taskId: number; callId: string; tool: string; args: unknown;
  fact: 'committed' | 'completed-uncommitted' | 'not-dispatched' | 'unknown'; evidence: number[];
  evidenceSummary?: DetailSummary; assistantEntryId?: number;
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
  session?: { id: string; sourceFiles: {path:string;sha256:string}[]; pending: {kind:string;id:number;status:string}[]; taskCount:number; submissionCount:number; pendingCount?:number };
  details?: { tools: DetailSummary; compactions: DetailSummary; unknownModelAttempts: DetailSummary; reasons: DetailSummary; pending: DetailSummary; toolCounts: Record<RecoveryTool['fact'], number>; unresolvedTools: number; navigation: string };
  persistence?: 'saved' | 'not-requested' | 'owner-blocked' | 'saved-separate-owner-report';
  ownerClaims?: OwnerClaim[];
  needsInput?: { reason:string; options:string[]; risks:string[] };
  decisionId?: string;
}
function freezePendingControls(evidence:Evidence,records:RecoveryRecords) {
  for(const record of records.filter(record=>record.kind==='control.accepted')) {
    const admission=record.data as any;
    const state=records.findLast(record=>record.kind==='control.receipt'&&(record.data as any).requestId===admission.requestId)?.data as any;
    if(!state||state.status==='pending'||state.status==='dispatching')evidence.append('control.receipt',{requestId:admission.requestId,status:'frozen',reason:'Recovery check freezes unapplied inputs; closing the panel or continuing old work never reattaches them'});
  }
}
interface OwnerClaim { path:string; markerSha256:string; claim:{pid:number;host:string;token?:string}; lock:{ino:number;mtimeMs:number}|null }
async function ownerClaims(root:string,records:RecoveryRecords):Promise<OwnerClaim[]> {
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
const last = (records: RecoveryRecords, kind: string): any => records.findLast(r => r.kind === kind)?.data;
const identity = (files: {path:string;sha256:string}[]) => digest(JSON.stringify(files));
function authorizationIdentity(auth?:RecoveryAuthorization) {
  if(!auth)return undefined;
  const environment=auth.toolEnvironment;
  return {...auth,...(environment?{toolEnvironment:{version:environment.version,names:Object.keys(environment.variables).sort(),digest:digest(JSON.stringify(Object.entries(environment.variables).sort(([a],[b])=>a.localeCompare(b))))}}:{})};
}
export function sessionWasEnded(records: RecoveryRecords, sessionId: string, files: {path:string;sha256:string}[]) {
  return records.some(record => record.kind === 'recovery.ended' && (record.data as any).sessionId === sessionId && (record.data as any).sourceId === identity(files));
}

export async function inspectOwnedRecovery(options: RecoveryOptions, owner: OwnerLease, resolutions: NonNullable<RecoveryDecision['resolutions']> = []) {
  owner.assertHeld();
  const records = recoveryRecords(owner.path, options.runId);
  const accepted = last(records, 'task.accepted');
  if (!accepted || !/^[a-f0-9-]{36}$/.test(accepted.sessionId)) throw new Error('RUN_NOT_FOUND');
  const original = last(records, 'run.closed') ?? { status: 'unknown', reason: 'No original close receipt' };
  for (const marker of [join(owner.path,'sessions',accepted.sessionId,'owner.json'),join(owner.path,'sessions',`${accepted.sessionId}.lock`)]) {
    try { await access(marker); throw new Error('OWNER_CONFLICT: unresolved session owner'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const started = last(records, 'run.started');
  const allRecords = recoveryRecords(owner.path);
  const page = options.page ?? {};
  if (page.offset && !page.snapshotId) throw Error('INVALID_RECOVERY_PAGE: subsequent pages require snapshotId');
  const reasons = new DetailPage<string>(page.offset, page.limit);
  let externalBlock = false;
  const reason = (value: string) => { reasons.add(boundedText(value)); if (/OTHER_PENDING|OTHER_SESSION|SESSION_WITHOUT|ALIAS/.test(value)) externalBlock = true; };
  const session = await inspectSnapshot(join(owner.path, 'sessions', accepted.sessionId, 'durable.sqlite'), owner,
    storage => projectRecovery(storage, records, accepted, started, options.runId, page, resolutions, reason));
  const submission = session.main;
  const remainingModelAttempts = Math.max(0, 8 - session.modelAttempts);
  await forEachDirectory(join(owner.path,'sessions'), async dir => {
    if (!dir.isDirectory) { reason('SESSION_STORAGE_ALIAS'); return; }
    if (dir.name === accepted.sessionId) return;
    const other = await inspectAdmission(join(owner.path,'sessions',dir.name,'durable.sqlite'),owner);
    if (other.pending && !sessionWasEnded(allRecords,dir.name,other.sourceFiles)) reason(`OTHER_SESSION_PENDING:${dir.name}`);
    const otherAccepted = allRecords.find(r => r.kind === 'task.accepted' && (r.data as any).sessionId === dir.name);
    if (!otherAccepted) reason(`SESSION_WITHOUT_HOST_IDENTITY:${dir.name}`);
  });
  for(const start of records.filter(r=>r.kind==='compaction.started')){const requestId=(start.data as any).requestId;const closed=records.findLast(r=>r.kind==='compaction.closed'&&(r.data as any).requestId===requestId)?.data as any;if(!closed||closed.result?.status==='unknown'||closed.result?.cleanup!=='confirmed')reason(`COMPACTION_OUTCOME_UNKNOWN:${requestId}: original maintenance fact requires explicit disposition`);}
  const ended = sessionWasEnded(records, accepted.sessionId, session.sourceFiles);
  const settled = !session.pending.count && submission?.status === 'done';
  const config = last(records,'execution.config');
  const coding = accepted.authorization?.execution === 'trusted-local-coding';
  if (!settled && !ended) {
    try { verifyArtifact(owner.path,last(records,'execution.artifact')); } catch (error) { reason(String(error)); }
    if (!options.authorization) reason('CURRENT_AUTHORIZATION_REQUIRED');
    else {
      const auth = options.authorization;
      const workspace = await realpath(auth.workspace);
      if (workspace !== accepted.workspace || auth.mode !== accepted.mode) reason('WORKSPACE_OR_MODE_CHANGED');
      if (JSON.stringify([...auth.tools].sort()) !== JSON.stringify([...accepted.authorization.tools].sort())) reason('CURRENT_PERMISSION_CHANGED');
      if (coding) {
        const previous = last(records,'workspace.owner');
        if (!previous || previous.root !== await resolveWorkspaceRoot(workspace)) reason('WORKSPACE_ROOT_CHANGED');
      }
      const expected = retainedExecutionConfig(owner.path,coding,auth.mode,auth.toolEnvironment,config);
      if (!config || config.recoveryProtocol !== 1 || Object.entries(expected).some(([key,value]) => JSON.stringify(config[key]) !== JSON.stringify(value))) reason('EXECUTION_CONFIGURATION_CHANGED');
      const agent = session.agent as any;
      if (!agent || agent.cwd !== accepted.workspace || agent.instructions !== expected.instructions || agent.model?.provider !== 'deepseek' || agent.model?.modelId !== 'deepseek-flash' || agent.tools !== undefined || agent.extensions !== undefined || agent.thinkingLevel !== undefined) reason('DURABLE_AGENT_CHANGED');
    }
    if (records.some(r => r.kind === 'run.abort-intent')) reason('STOP_INTENT_PRESERVED: end old work; do not resume it as pending');
    if (!remainingModelAttempts) reason('REQUEST_LIMIT_EXHAUSTED');
    if (original.cleanup === 'unknown' && !records.some(r => r.kind === 'lifecycle.late-close' && (r.data as any).storage === 'closed')) reason('CLEANUP_UNCONFIRMED');
  }
  const reasonSummary = reasons.summary();
  const snapshotId = recoverySnapshotId(session.sourceFiles, records, authorizationIdentity(options.authorization), [`complete-reasons:${reasonSummary.count}:${reasonSummary.sha256}`]);
  if (page.snapshotId !== undefined && page.snapshotId !== snapshotId) throw Error('STALE_RECOVERY_SNAPSHOT');
  const status: RecoveryReport['status'] = ended ? 'ended' : reasons.count ? 'blocked' : settled ? 'completed' : 'needs-decision';
  const originalRecord = records.findLast(record => record.kind === 'run.closed');
  const originalSummary = { status: original.status, cleanup: original.cleanup, reason: original.reason ? boundedText(String(original.reason)) : undefined, recordSeq: originalRecord?.seq, projection: 'original-close-status; full original remains in host evidence' };
  const report: RecoveryReport = {
    runId: options.runId, snapshotId, status, exitCode: status === 'completed' || status === 'ended' ? 0 : 75,
    reasons: reasons.items, options: status === 'completed' || status === 'ended' ? [] : reasons.count ? ['inspect', 'end'] : ['inspect', 'continue', 'end'],
    original: originalSummary, tools: session.tools.items, compactions: session.compactions.items,
    unknownModelAttempts: session.unknownModelAttempts.items, remainingModelAttempts,
    session: { id: accepted.sessionId, sourceFiles: session.sourceFiles, pending: session.pending.items, pendingCount: session.pending.count, taskCount: session.taskCount, submissionCount: session.submissionCount },
    details: { tools: session.tools.summary(), compactions: session.compactions.summary(), unknownModelAttempts: session.unknownModelAttempts.summary(), reasons: reasonSummary, pending: session.pending.summary(), toolCounts: session.toolCounts, unresolvedTools: session.unresolvedTools,
      navigation: 'inspectRecovery({page:{offset,limit,snapshotId}}) or recover --inspect --after OFFSET --limit N --snapshot ID; original entries: readRecoveryDetail({snapshotId,entryId|taskId,offset,limit})' },
    persistence: 'not-requested'
  };
  if (externalBlock) report.options = ['inspect', 'external-verification'];
  if (report.exitCode === 75) report.needsInput = { reason: reasons.count ? `${reasons.count} blocking reasons; this page shows ${reasons.items.length}. ${reasons.items.join('; ')}` : 'Explicit continuation or ending is required', options: report.options,
    risks: [...(session.unknownTools ? [`${session.unknownTools} tools have unknown outcomes; ${session.unresolvedTools} lack a retained or proposed resolution. Inspect all pages and resolve each with retry, skip, completed, or end; retry may duplicate effects.`] : []), ...(session.unknownModelAttempts.count ? [`${session.unknownModelAttempts.count} model attempts have unknown/partial usage. A new model request may add fees; earlier uncertainty remains.`] : [])] };
  return { report, records, session, accepted, started, submission, config, coding, externalBlock };
}

/** No source database changes, model, tool, migration, or ordinary Harness open. Owner markers are temporary coordination only. */
export async function inspectRecovery(options: RecoveryOptions): Promise<RecoveryReport> {
  const records = recoveryRecords(options.dataRoot,options.runId);
  if (!last(records,'task.accepted')) throw new Error('RUN_NOT_FOUND');
  let owner: OwnerLease | undefined;
  try { owner = await acquireOwner(options.dataRoot, () => {}); return (await inspectOwnedRecovery(options,owner)).report; }
  catch (error) {
    if (/STALE_RECOVERY_SNAPSHOT|INVALID_RECOVERY_PAGE|INVALID_DETAIL_PAGE/.test(String(error))) throw error;
    const claims=(await ownerClaims(await realpath(options.dataRoot),records)).filter(claim=>claim.path!==owner?.path);
    return { runId:options.runId,snapshotId:ownerSnapshotId(records,claims),status:'blocked',exitCode:75,reasons:[boundedText(String(error))],options:['inspect','confirm-cleanup'],original:{status:last(records,'run.closed')?.status??'unknown',cleanup:last(records,'run.closed')?.cleanup,projection:'original remains in host evidence'},tools:[],unknownModelAttempts:[],remainingModelAttempts:0,persistence:'owner-blocked',ownerClaims:claims,needsInput:{reason:'Ownership or stable snapshot unavailable',options:['inspect','confirm-cleanup'],risks:['No original durable store was opened or scheduled. PID disappearance or user consent alone cannot establish cleanup.']} };
  } finally { await owner?.release(); }
}
/** Original entry JSON is retrieved only on demand, in bounded UTF-16 text pages. Revalidate the
 * exact recovery identity and the source copy; a saved display page is never scheduling authority. */
export async function readRecoveryDetail(options: RecoveryOptions & { snapshotId: string; entryId?: number; taskId?: number; offset?: number; limit?: number }) {
  const offset = options.offset ?? 0, limit = options.limit ?? 4096;
  if (typeof options.snapshotId !== 'string') throw Error('INVALID_RECOVERY_DETAIL');
  const id = options.entryId ?? options.taskId;
  if ((options.entryId === undefined) === (options.taskId === undefined) || !Number.isSafeInteger(id) || id! < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw Error('INVALID_RECOVERY_DETAIL');
  const owner = await acquireOwner(options.dataRoot, () => {});
  try {
    const inspected = await inspectOwnedRecovery({ ...options, page: { snapshotId: options.snapshotId } }, owner);
    const detail = await inspectSnapshot(inspected.session.source, owner, async storage => {
      const entry = options.entryId === undefined ? undefined : await storage.entry(options.entryId as EntryId, BACKGROUND_CONTEXT);
      const task = options.taskId === undefined ? undefined : await storage.task(options.taskId as TaskId, BACKGROUND_CONTEXT);
      if (!entry && !task) throw Error('RECOVERY_DETAIL_MISSING');
      const original = JSON.stringify(entry?.entry ?? task);
      return { entryId: options.entryId, taskId: options.taskId, commitSeq: entry?.commitSeq, sha256: digest(original), bytes: Buffer.byteLength(original), length: original.length,
        offset, text: original.slice(offset, offset + limit), next: offset + limit < original.length ? offset + limit : null, offsets: 'UTF-16 code units' };
    });
    if (identity(detail.sourceFiles) !== identity(inspected.session.sourceFiles)) throw Error('STALE_RECOVERY_SNAPSHOT');
    return { ...detail, snapshotId: inspected.report.snapshotId };
  } finally { await owner.release(); }
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
      if(report.details?.compactions.count)evidence.append('recovery.compaction-frozen',{snapshotId:report.snapshotId,compactions:report.compactions,details:report.details.compactions,reason:'Recovery check never opens Harness; no pending summary is admitted'});
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
  owner: OwnerLease; report: RecoveryReport; records: RecoveryRecords; accepted: any; started: any; config: any; coding: boolean;
  submissionId: SubmissionId; decision: RecoveryDecision; readOnly: boolean; previousRequests: number; previousUsageUnknown: boolean;
  adopted?:boolean;
  frozenRequests?:Iterable<string>;
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
    const inspected = await inspectOwnedRecovery(options,owner,options.decision.resolutions ?? []);
    const {report,session,accepted,started,submission,config,coding} = inspected;
    if (options.decision.snapshotId !== report.snapshotId) throw new Error('STALE_RECOVERY_DECISION');
    const evidence = new Evidence(owner.path,options.runId);
    try {
      report.persistence='saved';evidence.append('recovery.report',report);
      if (report.status === 'completed' || report.status === 'ended') return report;
      const resolutions = options.decision.resolutions ?? [];
      if (new Set(resolutions.map(r => r.taskId)).size !== resolutions.length || session.matchedResolutions !== resolutions.length || resolutions.some(r => !['retry','skip','completed'].includes(r.choice) || !r.reason?.trim())) throw new Error('INVALID_RECOVERY_RESOLUTION');
      if (options.decision.action === 'end') {
        // Host quarantine never opens the old store or starts an unrelated pending task.
        // Unknown ownership/extra work cannot be silently ended on behalf of a different run.
        if (inspected.externalBlock) return report;
        freezePendingControls(evidence,inspected.records);
        evidence.append('recovery.decision',{decision:options.decision,authorization:authorizationIdentity(options.authorization),originalStatus:(report.original as any).status,classification:'user-choice; does not establish past success or cleanup'});
        const ended: RecoveryReport = {...report,status:'ended',exitCode:0,options:[],decisionId:options.decision.id,persistence:'saved'};
        evidence.append('recovery.ended',{decisionId:options.decision.id,sessionId:accepted.sessionId,sourceId:identity(session.sourceFiles),report:ended,disposition:'host-quarantined; durable originals and unknown facts retained; this store will never be scheduled'});
        return ended;
      }
      if (options.decision.action !== 'continue') throw new Error('INVALID_RECOVERY_ACTION');
      if (report.status === 'blocked') return report;
      if (!options.decision.acceptAdditionalModelAttempts) report.reasons.push('ADDITIONAL_MODEL_ATTEMPTS_REQUIRE_EXPLICIT_ACCEPTANCE: retries may incur new costs; previous unknown usage remains unknown');
      if (session.unresolvedTools) report.reasons.push(`TOOL_OUTCOME_UNKNOWN:${session.unresolvedTools} unresolved tools across the complete snapshot; inspect all pages and choose retry, skip, completed, or end`);
      if (report.reasons.length) { report.persistence='saved'; evidence.append('recovery.report',report); return report; }
      freezePendingControls(evidence,inspected.records);
      evidence.append('recovery.decision',{decision:options.decision,authorization:authorizationIdentity(options.authorization),originalStatus:(report.original as any).status,classification:'user-choice; does not establish past success or cleanup'});
      const readOnly = session.readOnly || resolutions.some(r => r.choice !== 'retry');
      transfer=true;
      return {owner,report,records:inspected.records,accepted,started,submissionId:(session.placed??submission)!.id,config,coding,decision:options.decision,readOnly,previousRequests:8-report.remainingModelAttempts,previousUsageUnknown:session.unknownModelAttempts.count>0,
        frozenRequests:recoverySteerRequests(inspected.records,accepted,options.runId)};
    } finally { evidence.close(); }
  } finally { if (!transfer) await owner.release(); }
}
