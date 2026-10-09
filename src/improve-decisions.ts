import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname,join,isAbsolute,relative,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Evidence,digest} from './evidence.js';
import {acquireOwner} from './ownership.js';
import {acquireWorkspaceOwner,resolveWorkspaceRoot} from './workspace-ownership.js';
import {readImproveReport,type ImproveCandidate} from './improve.js';
import {sourceBytes,verifySelfSource,type SourceTarget} from './improve-source.js';
import {appendFact} from './eval/store.js';
import {improveFacts,readImproveDecision,problemIdentity,conditionIdentity,conditionFiles,listImproveSuppressions} from './improve-history.js';
import {validateGroup,validateImproveGroup,groupReservation,type ValidationGroup} from './improve-validation.js';
import {validateFormalSelection,captureGroupIdentities,applyImproveGroup,type FormalSelection} from './improve-formal.js';
import {assertWorkspaceUnfenced} from './workspace-fence.js';
import {plannedDefaults,validateDefaultScope} from './improve-defaults.js';
import {effectiveProfileChanges,validateProfileBasis,type EffectiveProfileChange} from './improve-profile-validation.js';
export {readImproveDefaults} from './improve-defaults.js';
export {readImproveEffectiveConfig,type EffectiveConfig,type EffectiveProfileChange} from './improve-profile-validation.js';
export {rollbackImproveDecision,type ImproveRollback} from './improve-rollback.js';
export {readImproveDecision,scopedImproveDecisions,suppressionMatch,listImproveSuppressions} from './improve-history.js';

export type ImproveMode='validate-only'|'defer'|'do-not-suggest'|'execute-declared-scope';
export interface ImproveSelection {candidateId:string;candidateRevision:string;target:SourceTarget;mode:ImproveMode;steps:string[];formal?:FormalSelection}
export interface ImproveDecision {id:string;reportId:string;reportRevision:string;selections:ImproveSelection[];groups:ValidationGroup[];limits:{deadline:string;maxChecks:number;maxRequests:number;maxTokens:number};directory?:string}
const identifier=(value:unknown)=>typeof value==='string'&&/^[-\w.]{1,80}$/.test(value);
export function decisionDigest(value:unknown):string {
 const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
 return digest(JSON.stringify(canonical(value)));
}
function currentVersion(){
 const bytes=readFileSync(new URL('../execution/source-build.json',import.meta.url)),manifest=JSON.parse(bytes.toString());
 for(const file of manifest.outputs)if(digest(readFileSync(new URL('../../'+file.path,import.meta.url)))!==file.sha256)throw Error('IMPROVE_EXECUTION_VERSION_DRIFT');
 return digest(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,build:digest(bytes)}));
}
const contains=(parent:string,child:string)=>{const p=relative(parent,child);return !p||!isAbsolute(p)&&p!=='..'&&!p.startsWith('../');};
function checkTemporaryDirectory(path:string|undefined,targets:SourceTarget[]){
 if(!path||!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path)||existsSync(path)&&realpathSync(path)!==path||targets.some(t=>t.workspace&&contains(t.workspace,path)))throw Error('IMPROVE_TEMPORARY_SCOPE_REQUIRED: an explicit new directory outside every formal target');
}
export function checkImproveBaseline(target:SourceTarget){
 if(!target.workspace||realpathSync(target.workspace)!==target.workspace)throw Error('IMPROVE_TARGET_IDENTITY_DRIFT');
 if(target.kind==='self-source'&&verifySelfSource(target.workspace)!==target.applicableVersion)throw Error('IMPROVE_SELF_SOURCE_VERSION_DRIFT');
 for(const f of target.files){const bytes=sourceBytes(target.workspace,f.path);if(bytes.length!==f.bytes||digest(bytes)!==f.sha256)throw Error(`IMPROVE_BASELINE_DRIFT: ${target.workspace}/${f.path}; user content preserved`);}
}
/** Preview and submission accept exactly the same structured data; no text parser. */
export function previewImproveDecision(root:string,value:ImproveDecision){
 const d=structuredClone(value);
 if(!d||!identifier(d.id)||typeof d.reportId!=='string'||!/^[-\w.]{1,128}$/.test(d.reportId)||typeof d.reportRevision!=='string'||!Array.isArray(d.selections)||d.selections.length>5||!Array.isArray(d.groups)||d.groups.length>5||!Object.keys(d).every(k=>['id','reportId','reportRevision','selections','groups','limits','directory'].includes(k)))throw Error('IMPROVE_DECISION_INVALID');
 const l=d.limits;if(!l||!Object.keys(l).every(k=>['deadline','maxChecks','maxRequests','maxTokens'].includes(k))||!Number.isFinite(Date.parse(l.deadline))||!['maxChecks','maxRequests','maxTokens'].every(k=>Number.isSafeInteger((l as any)[k])&&(l as any)[k]>=0)||l.maxChecks>32||l.maxRequests>100)throw Error('IMPROVE_TOTAL_LIMITS_REQUIRED');
 const report=readImproveReport(root,d.reportId).report;if(!report||report.revision!==d.reportRevision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');
 if(new Set(d.selections.map(s=>s.candidateId)).size!==d.selections.length)throw Error('IMPROVE_DUPLICATE_SELECTION');
 const candidates:ImproveCandidate[]=[];
 for(const s of d.selections){
  if(!['execute-declared-scope','validate-only','defer','do-not-suggest'].includes(s.mode)||!Object.keys(s).every(k=>['candidateId','candidateRevision','target','mode','steps','formal'].includes(k)))throw Error('IMPROVE_SELECTION_INVALID');
  const c=report.candidates.find(c=>c.id===s.candidateId);
  if(!c||c.revision!==s.candidateRevision||!isDeepStrictEqual(c.target,s.target)||!isDeepStrictEqual(c.steps,s.steps))throw Error('IMPROVE_CANDIDATE_REVISION_DRIFT');
  validateFormalSelection(s,c,report.target.workspace);
  if(['validate-only','execute-declared-scope'].includes(s.mode)&&(c.suggestionOnly||c.target.state!=='verified'))throw Error('IMPROVE_SUGGESTION_ONLY');
  if(c.target.workspace)checkImproveBaseline(c.target);candidates.push(c);
 }
 const active=candidates.filter(c=>['validate-only','execute-declared-scope'].includes(d.selections.find(s=>s.candidateId===c.id)!.mode)),groups=d.groups;
 if(new Set(groups.map(g=>g.id)).size!==groups.length)throw Error('IMPROVE_GROUP_ID_CONFLICT');
 const members=groups.flatMap(g=>g.candidateIds);
 if(members.length!==active.length||new Set(members).size!==members.length||active.some(c=>!members.includes(c.id)))throw Error('IMPROVE_VALIDATION_PLAN_REQUIRED: every selected validation must appear in exactly one ordered group');
 for(const c of active){
  if(c.dependencies.some(id=>!active.some(other=>other.id===id)))throw Error('IMPROVE_DEPENDENCY_NOT_SELECTED');
  if(c.conflicts.some(id=>active.some(other=>other.id===id)))throw Error('IMPROVE_SELECTION_CONFLICT');
  for(const other of active){if(other.id===c.id)continue;
   const joint=c.target.workspace===other.target.workspace||c.dependencies.includes(other.id)||other.dependencies.includes(c.id)||(['prompt-skill','agent-config','self-source'].includes(c.target.kind)&&['prompt-skill','agent-config','self-source'].includes(other.target.kind));
   if(joint&&!groups.some(g=>g.candidateIds.includes(c.id)&&g.candidateIds.includes(other.id)))throw Error('IMPROVE_COMBINATION_REQUIRED: shared target, dependency or agent behavior must be checked as one combination');
  }
  const group=groups.find(g=>g.candidateIds.includes(c.id));
  if(group&&c.dependencies.some(id=>group.candidateIds.indexOf(id)>group.candidateIds.indexOf(c.id)))throw Error('IMPROVE_DEPENDENCY_ORDER');
 }
 const effectiveProfiles:{groupId:string;profiles:EffectiveProfileChange[]}[]=[];
 for(const group of groups){validateGroup(group,active,l.deadline);const selected=d.selections.filter(s=>group.candidateIds.includes(s.candidateId)),modes=selected.map(s=>s.mode);if(new Set(modes).size!==1)throw Error('IMPROVE_COMBINATION_MODE_CONFLICT');
  if(group.profileScope){validateDefaultScope(group.profileScope,report.target.workspace);if(!selected.some(s=>['agent-config','prompt-skill'].includes(s.target.kind)))throw Error('IMPROVE_PROFILE_SCOPE_TARGET_REQUIRED');if(selected.some(s=>s.formal?.activate)&&selected.filter(s=>['agent-config','prompt-skill'].includes(s.target.kind)).some(s=>!isDeepStrictEqual(s.formal?.activate,group.profileScope)))throw Error('IMPROVE_PROFILE_ACTIVATION_COMBINATION_MISMATCH');}
  const defaults=plannedDefaults(root,selected,group);
  const profiles=effectiveProfileChanges(defaults);validateProfileBasis(group,profiles);if(profiles.length)effectiveProfiles.push({groupId:group.id,profiles});
  if(modes.includes('execute-declared-scope')&&group.changes.some(c=>Buffer.byteLength(c.content)>262144))throw Error('IMPROVE_FORMAL_FILE_SIZE_LIMIT');
  for(const check of group.checks)if(check.kind==='fresh'&&check.effectiveTask&&!defaults.some(d=>d.current.taskType===check.effectiveTask))throw Error('IMPROVE_EFFECTIVE_PROFILE_SCOPE_REQUIRED');
  if(!['no-behavior','deterministic-fix'].includes(group.basis?.impact??''))for(const d of defaults)if(!group.checks.some(c=>c.kind==='fresh'&&c.effectiveTask===d.current.taskType))throw Error('IMPROVE_EFFECTIVE_PROFILE_CHECK_REQUIRED: legacy instruction-only comparison cannot authorize runtime profile activation');
 }
 const total=groups.reduce((n,g)=>{const r=groupReservation(g);return {checks:n.checks+r.checks,requests:n.requests+r.requests,tokens:n.tokens+r.tokens};},{checks:0,requests:0,tokens:0});
 if(total.checks>l.maxChecks||total.requests>l.maxRequests||total.tokens>l.maxTokens)throw Error('IMPROVE_TOTAL_BUDGET_EXCEEDED');
 if(groups.length){checkTemporaryDirectory(d.directory,candidates.map(c=>c.target));if(candidates.some(c=>c.target.workspace&&contains(c.target.workspace,realpathSync(root))))throw Error('IMPROVE_RECORDING_ROOT_OVERLAPS_FORMAL_TARGET');if(Date.parse(l.deadline)<=Date.now())throw Error('IMPROVE_DEADLINE');}
 return {...d,summary:{order:d.selections.map(s=>s.candidateId),executionOrder:groups.map(g=>({group:g.id,candidates:g.candidateIds})),targets:candidates.map(c=>c.target.workspace),dependencies:candidates.map(c=>({candidateId:c.id,dependencies:c.dependencies,conflicts:c.conflicts})),totalBudget:d.limits,plannedReservation:total,effectiveProfiles,writeback:'not-written',activation:'not-enabled'}};
}
type SubmitOptions={dataRoot:string;decision:ImproveDecision;fault?:(kind:string)=>void;signal?:AbortSignal};
async function workspaceLeases(decision:ImproveDecision,onCompromised:(error:Error)=>void){
 const roots=[...new Set(await Promise.all(decision.selections.filter(s=>['validate-only','execute-declared-scope'].includes(s.mode)).flatMap(s=>[s.target.workspace!,...(s.formal?.activate?[s.formal.activate.workspace]:[])]).map(root=>resolveWorkspaceRoot(root))))].sort((a,b)=>a.length-b.length),leases:Awaited<ReturnType<typeof acquireWorkspaceOwner>>[]=[];
 try{for(const root of roots)if(!leases.some(l=>contains(l.root,root)))leases.push(await acquireWorkspaceOwner(root,onCompromised));return leases;}catch(error){for(const lease of leases.reverse())await lease.release();throw error;}
}
async function executeGroups(options:SubmitOptions,evidence:Evidence,sourceId:string,groups:ValidationGroup[],version:string,guard:()=>void,ownerRoots:string[],resuming=false){
 const d=options.decision,report=readImproveReport(options.dataRoot,d.reportId).report!,record=(kind:string,data:any)=>appendFact(evidence,kind,{id:d.id,...data});
 if(!groups.length){record('improve.batch',{state:'completed',reason:null});return;}
 let stopped:string|null=null;
 try{
  if(!resuming)await mkdir(d.directory!,{recursive:false,mode:0o700});
  record('improve.batch-started',{groups:groups.map(g=>g.id),resuming});
  for(const group of groups){
   guard();if(options.signal?.aborted){stopped='cancelled before next group';break;}
   checkTemporaryDirectory(d.directory,report.candidates.filter(c=>d.selections.some(s=>s.candidateId===c.id)).map(c=>c.target));
   if(Date.parse(d.limits.deadline)<=Date.now()){stopped='IMPROVE_DEADLINE';break;}
   if(currentVersion()!==version)throw Error('IMPROVE_EXECUTION_VERSION_DRIFT');
   const candidates=report.candidates.filter(c=>group.candidateIds.includes(c.id));
   for(const c of candidates)checkImproveBaseline(c.target);
   for(const root of ownerRoots)assertWorkspaceUnfenced(root);
   const selections=d.selections.filter(s=>group.candidateIds.includes(s.candidateId));
   const identities=selections.some(s=>s.mode==='execute-declared-scope')?captureGroupIdentities(candidates):[];
   const defaults=plannedDefaults(options.dataRoot,selections,group,bytes=>evidence.blob(bytes));
   const reserved=groupReservation(group),spent=readImproveDecision(options.dataRoot,d.id).reserved;
   if(spent.checks+reserved.checks>d.limits.maxChecks||spent.requests+reserved.requests>d.limits.maxRequests||spent.tokens+reserved.tokens>d.limits.maxTokens)throw Error('IMPROVE_TOTAL_BUDGET_EXCEEDED');
   record('improve.group-started',{groupId:group.id,reserved,directory:join(d.directory!,group.id)});
   let result=await validateImproveGroup({evidence,decisionSource:sourceId,decisionId:d.id,group,candidates,defaults,directory:join(d.directory!,group.id),deadline:d.limits.deadline,signal:options.signal??new AbortController().signal,record,guard});
   try{for(const c of candidates)checkImproveBaseline(c.target);}catch(error){result={...result,state:'failed',reason:String(error),effect:'证据不足',conclusion:{...result.conclusion,effect:'证据不足',allChecksPassed:false,allDeclaredBenefitsMet:false}};}
   record('improve.validation',{groupId:group.id,state:result.state,reason:result.reason,result});
   if(result.state!=='completed'){stopped=result.reason??result.state;break;}
   const formal=await applyImproveGroup({evidence,decisionId:d.id,decisionSource:sourceId,group,candidates,selections,result,identities,defaults,ownerRoots:ownerRoots.filter(root=>candidates.some(c=>contains(root,c.target.workspace!))||defaults.some(d=>contains(root,d.current.workspace))),record,guard:()=>{guard();if(currentVersion()!==version)throw Error('IMPROVE_EXECUTION_VERSION_DRIFT');},baseline:()=>{for(const c of candidates)checkImproveBaseline(c.target);},signal:options.signal});
   if(formal.state==='blocked'){stopped=formal.reason??'IMPROVE_FORMAL_BLOCKED';break;}
  }
  record('improve.batch',{state:stopped?'frozen':'completed',reason:stopped});
 }catch(error){try{record('improve.batch',{state:'frozen',reason:String(error)});}catch{/* An unsaved outcome stays unknown; no action is retried. */}throw error;}
}
export async function submitImproveDecision(options:SubmitOptions){
 // Snapshot at the public boundary, before any await or caller callback.
 options={...options,decision:structuredClone(options.decision)};
 const {dataRoot,decision}=options,requestDigest=decisionDigest(decision);
 const prior=improveFacts(dataRoot).find(f=>f.kind==='improve.decision'&&f.data.id===decision.id);
 if(prior){if(prior.data.requestDigest!==requestDigest)throw Error('IMPROVE_DECISION_ID_REUSED');return readImproveDecision(dataRoot,decision.id);}
 previewImproveDecision(dataRoot,decision);
 const abort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal;
 const owner=await acquireOwner(dataRoot,error=>abort.abort(error));let evidence:Evidence|undefined,leases:Awaited<ReturnType<typeof workspaceLeases>>=[];
 try{
  owner.assertHeld();const raced=improveFacts(dataRoot).find(f=>f.kind==='improve.decision'&&f.data.id===decision.id);
  if(raced){if(raced.data.requestDigest!==requestDigest)throw Error('IMPROVE_DECISION_ID_REUSED');return readImproveDecision(dataRoot,decision.id);}
  previewImproveDecision(dataRoot,decision);
  leases=await workspaceLeases(decision,error=>abort.abort(error));
  const report=readImproveReport(dataRoot,decision.reportId).report!;
  const guard=()=>{owner.assertHeld();for(const lease of leases)lease.assertHeld();};
  evidence=new Evidence(dataRoot,report.runId,kind=>{guard();options.fault?.(kind);});
  const executionVersion=currentVersion();
  const sourceId=appendFact(evidence,'improve.decision',{id:decision.id,workspace:report.target.workspace,requestDigest,executionVersion,decision,decisions:decision.selections.map(s=>{const c=report.candidates.find(c=>c.id===s.candidateId)!;return {candidateId:c.id,mode:s.mode,problem:problemIdentity(c),condition:conditionIdentity(c),conditionFiles:conditionFiles(c)};})});
  await executeGroups({...options,signal},evidence,sourceId,decision.groups,executionVersion,guard,leases.map(l=>l.root));
 }finally{evidence?.close();for(const lease of leases.reverse())await lease.release();await owner.release();}
 return readImproveDecision(dataRoot,decision.id);
}

/** Explicit continuation can spend only previously authorized, untouched groups. */
export async function resumeImproveDecision(options:{dataRoot:string;id:string;resumeId:string;decisionSource:string;groupIds:string[];signal?:AbortSignal;fault?:(kind:string)=>void}){
 options={...options,groupIds:structuredClone(options.groupIds)};
 const {dataRoot,id}=options;if(!identifier(options.resumeId)||!Array.isArray(options.groupIds)||!options.groupIds.length||new Set(options.groupIds).size!==options.groupIds.length)throw Error('IMPROVE_RESUME_INVALID');
 const hash=decisionDigest({resumeId:options.resumeId,decisionSource:options.decisionSource,groupIds:options.groupIds});
 const old=improveFacts(dataRoot).find(f=>f.kind==='improve.resume'&&f.data.id===id&&f.data.resumeId===options.resumeId);
 if(old){if(old.data.requestDigest!==hash)throw Error('IMPROVE_RESUME_ID_REUSED');return readImproveDecision(dataRoot,id);}
 const abort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal,owner=await acquireOwner(dataRoot,error=>abort.abort(error));let evidence:Evidence|undefined,leases:Awaited<ReturnType<typeof workspaceLeases>>=[];
 try{
  const state=readImproveDecision(dataRoot,id),decision=state.decision as ImproveDecision;
  if(state.sourceId!==options.decisionSource||state.state!=='frozen'||state.groups.some((g:any)=>g.state==='unknown'||['unknown','frozen'].includes(g.formal?.state))||state.executionVersion!==currentVersion())throw Error('IMPROVE_RESUME_PRECONDITIONS_CHANGED');
  const groups=decision.groups.filter(g=>options.groupIds.includes(g.id));
  if(groups.length!==options.groupIds.length||!isDeepStrictEqual(groups.map(g=>g.id),options.groupIds)||groups.some(g=>state.groups.find((item:any)=>item.id===g.id)?.state!=='not-run'))throw Error('IMPROVE_RESUME_ONLY_INDEPENDENT_NOT_RUN');
  const pendingDecision={...decision,groups,selections:decision.selections.filter(s=>groups.some(g=>g.candidateIds.includes(s.candidateId)))};
  previewImproveDecision(dataRoot,pendingDecision);leases=await workspaceLeases(pendingDecision,error=>abort.abort(error));
  const guard=()=>{owner.assertHeld();for(const lease of leases)lease.assertHeld();};
  evidence=new Evidence(dataRoot,state.runId,kind=>{guard();options.fault?.(kind);});
  appendFact(evidence,'improve.resume',{id,resumeId:options.resumeId,requestDigest:hash,decisionSource:state.sourceId,groupIds:options.groupIds});
  await executeGroups({dataRoot,decision,signal,fault:options.fault},evidence,state.sourceId,groups,state.executionVersion,guard,leases.map(l=>l.root),true);
 }finally{evidence?.close();for(const lease of leases.reverse())await lease.release();await owner.release();}
 return readImproveDecision(dataRoot,id);
}

export async function restoreImproveSuggestion(options:{dataRoot:string;id:string;suppressionId:string;reason:string}){
 options=structuredClone(options);
 if(!identifier(options.id)||typeof options.reason!=='string'||!options.reason.trim()||options.reason.length>4096)throw Error('IMPROVE_RESTORE_INVALID');
 const request={id:options.id,suppressionId:options.suppressionId,reason:options.reason},hash=decisionDigest(request),facts=improveFacts(options.dataRoot),old=facts.find(f=>f.kind==='improve.restore'&&f.data.id===options.id);
 if(old){if(old.data.requestDigest!==hash)throw Error('IMPROVE_RESTORE_ID_REUSED');return old;}
 const owner=await acquireOwner(options.dataRoot,()=>{});let e:Evidence|undefined;
 try{
  owner.assertHeld();const suppression=listImproveSuppressions(options.dataRoot).find(s=>s.id===options.suppressionId);if(!suppression)throw Error('IMPROVE_SUPPRESSION_NOT_FOUND');
  const raced=improveFacts(options.dataRoot).find(f=>f.kind==='improve.restore'&&f.data.id===options.id);if(raced){if(raced.data.requestDigest!==hash)throw Error('IMPROVE_RESTORE_ID_REUSED');return raced;}
  e=new Evidence(options.dataRoot,suppression.runId,()=>owner.assertHeld());appendFact(e,'improve.restore',{...request,requestDigest:hash,workspace:suppression.problem.target.workspace,problem:suppression.problem,suppressionSource:suppression.sourceId});
 }finally{e?.close();await owner.release();}
 return improveFacts(options.dataRoot).find(f=>f.kind==='improve.restore'&&f.data.id===options.id)!;
}
