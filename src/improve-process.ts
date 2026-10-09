import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {join,isAbsolute,relative} from 'node:path';
import {Evidence,digest} from './evidence.js';
import {improveFacts,readImproveDecision} from './improve-history.js';
import {appendFact} from './eval/store.js';
import {acquireOwner} from './ownership.js';
import {acquireWorkspaceOwner} from './workspace-ownership.js';
import {assertWorkspaceUnfenced} from './workspace-fence.js';
import {verifyImproveBuild,verifyBuildSource,type ImproveBuildPair} from './improve-build.js';
import type {ImproveSelection} from './improve-decisions.js';

export interface BuildEntry {decisionId:string;groupId:string;buildId:string;directory:string;entry:string}
export interface BuildDefault {workspace:string;revision:string;current:BuildEntry|null}
export interface BuildDefaultChange {previous:BuildDefault;current:BuildDefault}
const snapshot=(workspace:string,current:BuildEntry|null):BuildDefault=>({workspace,current,revision:digest(JSON.stringify({workspace,current}))});
export function readImproveBuildDefault(root:string,workspace:string):BuildDefault{
 let current:BuildEntry|null=null;try{for(const f of improveFacts(root))if(f.kind==='improve.build-activation'&&f.data.change.current.workspace===workspace)current=f.data.change.current.current;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return snapshot(workspace,current);
}
export function assertBuildDefault(root:string,change:BuildDefaultChange){if(readImproveBuildDefault(root,change.previous.workspace).revision!==change.previous.revision)throw Error('IMPROVE_BUILD_DEFAULT_CHANGED');}
export function planBuildDefault(root:string,decisionId:string,groupId:string,selections:ImproveSelection[],build?:ImproveBuildPair):BuildDefaultChange|null{
 const requested=selections.filter(s=>s.formal?.newProcess);if(!requested.length)return null;if(!build)throw Error('IMPROVE_SELF_BUILD_REQUIRED');
 const request=requested[0].formal!.newProcess!;if(requested.some(s=>s.formal!.newProcess!.workspace!==request.workspace||s.formal!.newProcess!.baseline!==request.baseline))throw Error('IMPROVE_BUILD_ACTIVATION_COMBINATION_MISMATCH');
 const previous=readImproveBuildDefault(root,request.workspace);if(previous.revision!==request.baseline)throw Error('IMPROVE_BUILD_DEFAULT_CHANGED');
 return {previous,current:snapshot(request.workspace,{decisionId,groupId,buildId:build.candidate.id,directory:build.candidate.directory,entry:build.candidate.entry})};
}
export interface ImproveBuildLaunch {dataRoot:string;id:string;decisionId:string;decisionSource:string;groupId:string;buildId:string;side:'baseline'|'candidate';authorization:{workspace:string;mode:'offline'|'live';tools:readonly string[]};operation:{kind:'help'}|{kind:'run';taskType:'read'|'coding';input:string;dataRoot:string};timeoutMs:number;signal?:AbortSignal}
function priorLaunch(root:string,id:string){const facts=improveFacts(root),start=facts.find(f=>f.kind==='improve.process-request'&&f.data.launchId===id);if(!start)return null;const result=facts.findLast(f=>f.kind==='improve.process-result'&&f.data.launchId===id);return {request:start.data.requestDigest,result:result?.data.result??{state:'unknown',reason:'A process was requested without a confirmed completion; never launched again',requestSource:start.sourceId}};}
/** A separate human launch starts only a NEW task or help process. Existing
 * pending work is never opened, migrated, or supplied to the selected build. */
export async function launchImproveBuild(input:ImproveBuildLaunch):Promise<any>{
 const o={...structuredClone({...input,signal:undefined}),signal:input.signal},request={...o,signal:undefined},requestDigest=digest(JSON.stringify(request));
 if(!/^[-\w.]{1,80}$/.test(o.id)||!['baseline','candidate'].includes(o.side)||!Number.isSafeInteger(o.timeoutMs)||o.timeoutMs<100||o.timeoutMs>300000||!o.authorization||!['offline','live'].includes(o.authorization.mode)||!Array.isArray(o.authorization.tools)||!o.operation||!['help','run'].includes(o.operation.kind))throw Error('IMPROVE_BUILD_LAUNCH_INVALID');
 const auth=o.authorization;if(!Object.keys(auth).every(k=>['workspace','mode','tools'].includes(k))||!Object.keys(o.operation).every(k=>(o.operation.kind==='help'?['kind']:['kind','taskType','input','dataRoot']).includes(k))||!isAbsolute(auth.workspace)||realpathSync(auth.workspace)!==auth.workspace)throw Error('IMPROVE_BUILD_AUTHORIZATION_CHANGED');
 const required=o.operation.kind==='run'&&o.operation.taskType==='coding'?['read','write','edit','bash']:['read'];if(auth.tools.length!==required.length||required.some(tool=>!auth.tools.includes(tool)))throw Error('IMPROVE_BUILD_AUTHORIZATION_CHANGED');
 if(o.operation.kind==='run'&&(!['read','coding'].includes(o.operation.taskType)||typeof o.operation.input!=='string'||!o.operation.input.trim()||o.operation.input.length>100000||o.operation.dataRoot!==o.dataRoot))throw Error('IMPROVE_BUILD_LAUNCH_INVALID');
 const previous=priorLaunch(o.dataRoot,o.id);if(previous){if(previous.request!==requestDigest)throw Error('IMPROVE_PROCESS_ID_REUSED');return previous.result;}
 let runId:string,build:ImproveBuildPair['candidate'],pair:ImproveBuildPair,sourceSide:'baseline'|'candidate';const owner=await acquireOwner(o.dataRoot,()=>{});let e:Evidence|undefined;
 try{
  owner.assertHeld();const raced=priorLaunch(o.dataRoot,o.id);if(raced){if(raced.request!==requestDigest)throw Error('IMPROVE_PROCESS_ID_REUSED');return raced.result;}
  const state=readImproveDecision(o.dataRoot,o.decisionId),group=state.groups.find((g:any)=>g.id===o.groupId);runId=state.runId;
  if(state.sourceId!==o.decisionSource||!group?.build||group.formal?.state!=='completed')throw Error('IMPROVE_BUILD_NOT_FORMALLY_AVAILABLE');pair=group.build;build=pair[o.side];sourceSide=group.rollback?.state==='completed'?'baseline':'candidate';
  if(build.id!==o.buildId)throw Error('IMPROVE_BUILD_SELECTION_CHANGED');
  if(o.side==='candidate'&&(group.rollback?.state==='completed'||readImproveBuildDefault(o.dataRoot,auth.workspace).current?.buildId!==build.id))throw Error('IMPROVE_BUILD_NOT_SELECTED_FOR_NEW_PROCESS');
  const selected=state.decision.selections.find((s:any)=>s.target.id===pair.targetId);if(!selected?.formal?.newProcess||selected.formal.newProcess.workspace!==auth.workspace)throw Error('IMPROVE_BUILD_AUTHORIZATION_CHANGED');
  for(const directory of [pair.baseline.directory,pair.candidate.directory]){const rel=relative(directory,auth.workspace);if(rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'))throw Error('IMPROVE_BUILD_WORKSPACE_OVERLAP');}
  const lease=await acquireWorkspaceOwner(pair.sourceRoot,()=>{});
  try{owner.assertHeld();lease.assertHeld();assertWorkspaceUnfenced(pair.sourceRoot);assertWorkspaceUnfenced(auth.workspace);verifyBuildSource(o.dataRoot,pair,group.rollback?.state==='completed'?'baseline':'candidate');verifyImproveBuild(o.dataRoot,build);if(o.signal?.aborted)throw Error('IMPROVE_BUILD_LAUNCH_CANCELLED');
   e=new Evidence(o.dataRoot,runId,()=>owner.assertHeld());appendFact(e,'improve.process-request',{id:o.decisionId,groupId:o.groupId,launchId:o.id,requestDigest,request,buildId:build.id,entry:join(build.directory,build.entry),scope:'Explicit new process only; no existing run/session passed and no current process replacement'});
  }finally{await lease.release();}
 }finally{e?.close();await owner.release();}
 const record=async(kind:string,data:any)=>{const lease=await acquireOwner(o.dataRoot,()=>{});let evidence:Evidence|undefined;try{evidence=new Evidence(o.dataRoot,runId!,()=>lease.assertHeld());return appendFact(evidence,kind,{id:o.decisionId,groupId:o.groupId,launchId:o.id,...data});}finally{evidence?.close();await lease.release();}};
 const args=o.operation.kind==='help'?['--help']:['run','--workspace',auth.workspace,'--data-root',o.operation.dataRoot,'--prompt',o.operation.input,...(o.operation.taskType==='coding'?['--coding']:[]),...(auth.mode==='offline'?['--offline-demo']:[])];
 // Recheck after asynchronous journal/lease cleanup immediately before spawn.
 if(realpathSync(auth.workspace)!==auth.workspace)throw Error('IMPROVE_BUILD_AUTHORIZATION_CHANGED');
 assertWorkspaceUnfenced(pair!.sourceRoot);assertWorkspaceUnfenced(auth.workspace);verifyBuildSource(o.dataRoot,pair!,sourceSide!);
 if(o.side==='candidate'&&readImproveBuildDefault(o.dataRoot,auth.workspace).current?.buildId!==build!.id)throw Error('IMPROVE_BUILD_NOT_SELECTED_FOR_NEW_PROCESS');
 verifyImproveBuild(o.dataRoot,build!);if(o.signal?.aborted)throw Error('IMPROVE_BUILD_LAUNCH_CANCELLED');
 const child=spawn(process.execPath,[join(build!.directory,build!.entry),...args],{cwd:auth.workspace,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,...(auth.mode==='live'&&process.env.DEEPSEEK_API_KEY?{DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY}:{})}});
 const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
 let stdout='',stderr='',error:string|null=null,reason:string|null=null,killTimer:NodeJS.Timeout|undefined;
 const signalGroup=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch(err){if((err as NodeJS.ErrnoException).code!=='ESRCH')error=String(err);}};
 const stop=(why:string)=>{if(reason)return;reason=why;signalGroup('SIGTERM');killTimer=setTimeout(()=>signalGroup('SIGKILL'),5000);};const abort=()=>stop('cancelled');o.signal?.addEventListener('abort',abort,{once:true});if(o.signal?.aborted)abort();const timer=setTimeout(()=>stop('timeout'),o.timeoutMs);
 child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>1048576){stdout=stdout.slice(0,1048576);stop('output-limit');}});child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>1048576){stderr=stderr.slice(0,1048576);stop('output-limit');}});child.on('error',err=>{error=String(err);});
 let spawned:string|null=null;try{spawned=child.pid?await record('improve.process-started',{buildId:build!.id,pid:child.pid,parentPid:process.pid,entry:join(build!.directory,build!.entry),args,observation:'OS child spawn with immediately verified executable/dependency bytes; task outcome is a separate result'}):null;}catch(err){error=String(err);stop('journal-failure');}
 const code=await closed;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);o.signal?.removeEventListener('abort',abort);
 const result={state:error||reason||code!==0?'failed':'completed',pid:child.pid??null,parentPid:process.pid,buildId:build!.id,entry:join(build!.directory,build!.entry),started:spawned,code,reason,error,stdout,stderr,scope:'New process invocation and its exit observed. Process completion alone does not establish task acceptance or improvement; prior pending runs were not opened.'};
 await record('improve.process-result',{result});return result;
}
