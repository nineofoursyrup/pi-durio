import {mkdir,writeFile} from 'node:fs/promises';
import {readFileSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {Evidence,digest,readObject} from './evidence.js';
import type {ImproveCandidate} from './improve.js';
import {verifiedImage,prepareEval,runEval,type PrepareEvalOptions,type PrepareComparison} from './eval/runner.js';
import {installedRuntimeFiles,captureFiles,regularFiles} from './eval/store.js';

export interface ContentChange {targetId:string;path:string;content:string}
export interface DirectCheck {kind:'direct'|'regression'|'resource';program:string;timeoutMs:number;resource?:{direction:'lower'|'higher';delta:number;unit:string;basis:string}}
export interface FreshCheck {
 kind:'fresh';installation:string;runtimeIdentity:string;
 files:{targetId:string;path:string}[];
 options:Omit<PrepareEvalOptions,'dataRoot'|'id'|'installation'|'comparison'|'image'>;
 comparison:Omit<PrepareComparison,'sides'>;
}
export type ImproveCheck=DirectCheck|FreshCheck;
export interface ValidationGroup {id:string;candidateIds:string[];changes:ContentChange[];checks:ImproveCheck[]}
export function describeImproveRuntime(installation:string){
 const files=installedRuntimeFiles(installation).map(path=>{const bytes=readFileSync(join(installation,path));return {path,ref:{sha256:digest(bytes),bytes:bytes.length},mode:lstatSync(join(installation,path)).mode&0o777};});
 return digest(JSON.stringify(files));
}
export function groupReservation(group:ValidationGroup){return group.checks.reduce((n,c)=>({checks:n.checks+1,requests:n.requests+(c.kind==='fresh'?c.options.budget.maxRequests:0),tokens:n.tokens+(c.kind==='fresh'?c.options.budget.maxTokens:0)}),{checks:0,requests:0,tokens:0});}
const safePath=(path:unknown)=>typeof path==='string'&&/^[a-zA-Z0-9_@+.,=-]+(?:\/[a-zA-Z0-9_@+.,=-]+)*$/.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'||p==='.git'||p==='node_modules');
export function validateGroup(group:ValidationGroup,candidates:ImproveCandidate[],deadline:string){
 if(!group||!/^[-\w.]{1,64}$/.test(group.id)||['.','..'].includes(group.id)||!Array.isArray(group.candidateIds)||!group.candidateIds.length||new Set(group.candidateIds).size!==group.candidateIds.length||group.candidateIds.some(id=>!candidates.some(c=>c.id===id))||!Array.isArray(group.changes)||group.changes.length>80||!Array.isArray(group.checks)||!group.checks.length||group.checks.length>32||!Object.keys(group).every(k=>['id','candidateIds','changes','checks'].includes(k)))throw Error('IMPROVE_GROUP_INVALID');
 const selected=candidates.filter(c=>group.candidateIds.includes(c.id));
 if(selected.some(c=>!safePath(c.target.id)))throw Error('IMPROVE_TARGET_PATH_ID_INVALID');
 const names=new Set<string>();let bytes=0;
 for(const change of group.changes){
  if(!safePath(change.path)||!safePath(change.targetId)||typeof change.content!=='string'||!selected.some(c=>c.target.id===change.targetId&&c.scope.includes(change.path))||!Object.keys(change).every(k=>['targetId','path','content'].includes(k)))throw Error('IMPROVE_CHANGE_SCOPE_DENIED');
  const key=`${change.targetId}/${change.path}`;if(names.has(key))throw Error('IMPROVE_COMBINATION_CONTENT_CONFLICT: declare one final combined content for each path');names.add(key);bytes+=Buffer.byteLength(change.content);
 }
 if(bytes>1048576)throw Error('IMPROVE_CHANGE_SIZE_LIMIT');
 for(const c of selected)if(c.objective!=='validation'&&!group.changes.some(p=>p.targetId===c.target.id&&c.scope.includes(p.path)))throw Error('IMPROVE_CANDIDATE_CONTENT_REQUIRED');
 for(const check of group.checks){
  if(check.kind==='fresh'){
   if(!check.installation?.startsWith('/')||describeImproveRuntime(check.installation)!==check.runtimeIdentity)throw Error('IMPROVE_RUNTIME_CONTENT_DRIFT');
   const o=check.options;if(!o||!['offline','live'].includes(o.mode??'')||!o.budget||!['maxRequests','maxTokens','maxRequestTokens'].every(k=>Number.isSafeInteger((o.budget as any)[k])&&(o.budget as any)[k]>0)||Date.parse(o.budget.deadline)>Date.parse(deadline)||!Number.isFinite(Date.parse(o.budget.deadline))||!check.comparison||'sides' in check.comparison||!Array.isArray(check.files)||!check.files.length)throw Error('IMPROVE_FRESH_PLAN_INVALID');
   if(!Object.keys(o).every(k=>['purpose','mode','budget','trialTimeoutMs','gradingTimeoutMs','maxOutputTokens','cases','trials','paid','price'].includes(k)))throw Error('IMPROVE_FRESH_SCOPE_DENIED');
   if(!Object.keys(check).every(k=>['kind','installation','runtimeIdentity','files','options','comparison'].includes(k)))throw Error('IMPROVE_FRESH_SCOPE_DENIED');
   for(const file of check.files)if(!group.changes.some(p=>p.targetId===file.targetId&&p.path===file.path)||!selected.some(c=>c.target.id===file.targetId&&['prompt-skill','agent-config'].includes(c.target.kind)))throw Error('IMPROVE_FRESH_BINDING_REQUIRED: fresh instructions must come from the declared temporary prompt/config content');
   if(group.changes.some(p=>!check.files.some(f=>f.targetId===p.targetId&&f.path===p.path)))throw Error('IMPROVE_FRESH_COMBINATION_BINDING_REQUIRED: every changed part of this combination must enter both fixed comparison sides');
   if(selected.some(c=>c.target.kind==='eval-asset'))throw Error('IMPROVE_GRADER_CANDIDATE_COMPARISON_DENIED');
  }else if(!['direct','regression','resource'].includes(check.kind)||typeof check.program!=='string'||!check.program.trim()||Buffer.byteLength(check.program)>131072||!Number.isSafeInteger(check.timeoutMs)||check.timeoutMs<100||check.timeoutMs>300000||!Object.keys(check).every(k=>['kind','program','timeoutMs','resource'].includes(k))){throw Error('IMPROVE_CHECK_INVALID');}
  else if(check.kind==='resource'&&(!check.resource||!['lower','higher'].includes(check.resource.direction)||!Number.isFinite(check.resource.delta)||check.resource.delta<=0||!check.resource.unit||!check.resource.basis))throw Error('IMPROVE_RESOURCE_THRESHOLD_REQUIRED');
 }
 // A Markdown/config behavior change is never silently treated as a text lint.
 for(const c of selected){if(['prompt-skill','agent-config'].includes(c.target.kind)&&!group.checks.some(check=>check.kind==='fresh'&&check.files.some(f=>f.targetId===c.target.id&&c.scope.includes(f.path))))throw Error('IMPROVE_BEHAVIOR_FRESH_REQUIRED');
  if(c.objective==='bug'&&!group.checks.some(check=>['regression','fresh'].includes(check.kind)))throw Error('IMPROVE_REGRESSION_REQUIRED');
  if(c.objective==='performance'&&!group.checks.some(check=>['resource','fresh'].includes(check.kind)))throw Error('IMPROVE_PERFORMANCE_CHECK_REQUIRED');
 }
}

/** Host constructs only declared bytes; all candidate/check code runs in the
 * existing single VM boundary. Formal paths are never mounted into that VM. */
export async function validateImproveGroup(options:{evidence:Evidence;decisionSource:string;decisionId:string;group:ValidationGroup;candidates:ImproveCandidate[];directory:string;deadline:string;signal:AbortSignal;record:(kind:string,data:unknown)=>string;guard:()=>void}){
 const {evidence:e,group,directory,record,guard}=options,root=e.root;
 await mkdir(directory,{recursive:false,mode:0o700});
 const candidates=options.candidates.filter(c=>group.candidateIds.includes(c.id)),targets=[...new Map(candidates.map(c=>[c.target.id,c.target])).values()];
 const baseline=new Map<string,Buffer>(),content=new Map<string,Buffer>();
 for(const target of targets)for(const file of target.files){const key=`${target.id}/${file.path}`,bytes=readObject(root,file.content);baseline.set(key,bytes);content.set(key,bytes);}
 for(const change of group.changes)content.set(`${change.targetId}/${change.path}`,Buffer.from(change.content));
 const construction={targets:targets.map(t=>({id:t.id,workspace:t.workspace,baseline:t.baseline})),files:[...content].map(([path,bytes])=>({path,before:e.blob(baseline.get(path)!),after:e.blob(bytes)}))};
 record('improve.prepared',{groupId:group.id,construction,scope:'temporary copies only; formal target/default unchanged'});
 const checks:any[]=[];let effect='direct-checks-passed',state='completed',reason:string|null=null;
 const engine=await import(new URL('../execution/isolation/boundary.mjs',import.meta.url).href);
 for(let index=0;index<group.checks.length;index++){
  const check=group.checks[index];
  if(state!=='completed'){checks.push({index,kind:check.kind,state:'not-run',reason});continue;}
  guard();if(options.signal.aborted||Date.now()>=Date.parse(options.deadline)){state=options.signal.aborted?'cancelled':'failed';reason=options.signal.aborted?'cancelled':'IMPROVE_DEADLINE';checks.push({index,kind:check.kind,state,reason});continue;}
  const checkDirectory=join(directory,`check-${index}`);await mkdir(checkDirectory,{mode:0o700});
  record('improve.check-started',{groupId:group.id,index,kind:check.kind,directory:checkDirectory});
  try{
   if(check.kind==='fresh'){
    if(describeImproveRuntime(check.installation)!==check.runtimeIdentity)throw Error('IMPROVE_RUNTIME_CONTENT_DRIFT');
    const instructions=(files:Map<string,Buffer>)=>check.files.map(f=>`[${f.targetId}/${f.path}]\n${files.get(`${f.targetId}/${f.path}`)!.toString('utf8')}`).join('\n\n');
    const dataRoot=join(checkDirectory,'eval-data'),id=`improve-${digest(`${options.decisionId}/${group.id}/${index}`).slice(0,24)}`;
    const prepared=await prepareEval({...check.options,dataRoot,id,installation:check.installation,image:verifiedImage,comparison:{...check.comparison,sides:{baseline:{installation:check.installation,instructions:instructions(baseline)},candidate:{installation:check.installation,instructions:instructions(content)}}}});
    if(prepared.plan.runtime.id!==check.runtimeIdentity)throw Error('IMPROVE_RUNTIME_CONTENT_DRIFT');
    const link=record('improve.eval',{groupId:group.id,index,kind:'eval',dataRoot,planId:id,planSource:prepared.source,parent:{dataRoot:root,decisionSource:options.decisionSource,decisionId:options.decisionId},attribution:'improve validation; nested eval facts keep original kind/run/trial/attempt IDs; do not count as daily coding'});
    const report=await runEval({dataRoot,id,directory:join(checkDirectory,'execution'),signal:options.signal});
    guard();effect=report.improvement;
    const certain=report.trials.length===prepared.plan.trials.length&&report.trials.every(t=>t.outcome.valid&&['PASS','FAIL'].includes(t.grade?.judgment??''));
    const passed=certain&&report.trials.filter(t=>t.side==='candidate').every(t=>t.grade?.judgment==='PASS')&&report.comparison?.regression.pairs.every(p=>p.candidatePassed)!==false;
    state=!certain?'unknown':passed?'completed':'failed';reason=state==='completed'?null:'Fresh comparison incomplete, invalid, failed or missing evidence; original trials retained.';
    checks.push({index,kind:check.kind,state,reason,kindSource:'eval',dataRoot,planId:id,sourceId:link,report,requests:report.cost.requests,tokens:report.cost.knownTokens});
   }else{
    const input=join(checkDirectory,'input');await mkdir(input);
    for(const [key,bytes]of [...[...content].map(([k,v])=>[`targets/${k}`,v] as const),...[...baseline].map(([k,v])=>[`baseline/${k}`,v] as const)]){const path=join(input,key);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{flag:'wx',mode:0o444});}
    await writeFile(join(input,'check.mjs'),check.program,{flag:'wx',mode:0o444});
    const bootstrap="import {cp,chmod} from 'node:fs/promises'; await cp('/input/targets','/work/targets',{recursive:true}); await chmod('/work/targets',0o755); process.chdir('/work/targets'); await import('/input/check.mjs');";
    await writeFile(join(input,'bootstrap.mjs'),bootstrap,{flag:'wx',mode:0o444});
    const execution=await engine.runRestricted({image:verifiedImage,inputDir:input,runDir:join(checkDirectory,'execution'),command:['node','/input/bootstrap.mjs'],timeoutMs:Math.max(100,Math.min(check.timeoutMs,Date.parse(options.deadline)-Date.now())),signal:options.signal});
    guard();let artifacts:any[]=[];
    if(execution.terminated&&execution.status!=='invalid'){
     const names=regularFiles(join(checkDirectory,'execution/work/targets')).map(p=>`targets/${p}`),destination=join(checkDirectory,'export');
     await engine.exportStopped(execution,names,destination,{maxFiles:200,maxBytes:4194304});artifacts=captureFiles(e,destination,names).files;
     for(const [key,bytes]of content)if(!artifacts.some(f=>f.path===`targets/${key}`&&f.ref.sha256===digest(bytes)))throw Error('IMPROVE_CHECK_CHANGED_CANDIDATE: checks may not replace the fixed content under validation');
    }
    state=!execution.terminated||execution.status==='invalid'?'unknown':execution.reason==='cancelled'?'cancelled':execution.code===0?'completed':'failed';reason=execution.reason;
    let resource:any=null;
    if(check.kind==='resource'&&state==='completed'){
     resource=JSON.parse(execution.stdout.trim());
     if(![resource.baseline,resource.candidate].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)||typeof resource.protectionsPassed!=='boolean')throw Error('IMPROVE_RESOURCE_EVIDENCE_INVALID');
     const delta=check.resource!.direction==='lower'?resource.baseline-resource.candidate:resource.candidate-resource.baseline;
     effect=!resource.protectionsPassed||delta<=-check.resource!.delta?'退化':delta>=check.resource!.delta?'改善':'无明显差异';
     if(!resource.protectionsPassed){state='failed';reason='Declared resource protection failed';}
    }
    checks.push({index,kind:check.kind,state,reason,execution,executionRef:e.blob(JSON.stringify(execution)),artifacts,resource});
   }
  }catch(error){state=options.signal.aborted?'cancelled':'unknown';reason=String(error);checks.push({index,kind:check.kind,state,reason});}
  record('improve.check',{groupId:group.id,...checks.at(-1)});
 }
 if(state==='unknown'||state==='cancelled')effect='证据不足';else if(state==='failed'&&effect==='direct-checks-passed')effect='direct-checks-failed';
 return {state,reason,construction,checks,effect,scope:'Only the selected combination, fixed contents and restricted checks; no per-candidate causal credit or host-performance claim.',writeback:'not-written',activation:'not-enabled'};
}
