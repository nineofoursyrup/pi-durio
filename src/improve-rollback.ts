import {sourceBytes} from './improve-source.js';
import {Evidence,readObject,digest} from './evidence.js';
import {acquireOwner} from './ownership.js';
import {acquireWorkspaceOwner} from './workspace-ownership.js';
import {improveFacts,readImproveDecision} from './improve-history.js';
import {appendFact} from './eval/store.js';
import {replaceExact,assertFileIdentity,type FormalFile} from './improve-formal.js';
import {readImproveDefaults,type DefaultChange} from './improve-defaults.js';
import {workspaceFences,setWorkspaceFence,clearWorkspaceFence,type WorkspaceFence} from './workspace-fence.js';

import {readImproveBuildDefault,type BuildDefaultChange} from './improve-process.js';
import {verifyImproveBuild,verifyBuildSource,type ImproveBuildPair} from './improve-build.js';

export interface ImproveRollback {dataRoot:string;id:string;rollbackId:string;decisionSource:string;groupIds:string[];reason:string;fault?:(kind:string)=>void;signal?:AbortSignal}
/** Explicit file compensation only. No process, Git, provider or external
 * effects are undone; later user bytes/default choices are never overwritten. */
export async function rollbackImproveDecision(input:ImproveRollback){
 const o={...input,groupIds:structuredClone(input.groupIds)},request={id:o.id,rollbackId:o.rollbackId,decisionSource:o.decisionSource,groupIds:o.groupIds,reason:o.reason},requestDigest=digest(JSON.stringify(request));
 if(!/^[-\w.]{1,80}$/.test(o.rollbackId)||!Array.isArray(o.groupIds)||!o.groupIds.length||new Set(o.groupIds).size!==o.groupIds.length||typeof o.reason!=='string'||!o.reason.trim()||o.reason.length>4096)throw Error('IMPROVE_ROLLBACK_INVALID');
 const prior=improveFacts(o.dataRoot).find(f=>f.kind==='improve.rollback-request'&&f.data.rollbackId===o.rollbackId);
 if(prior){if(prior.data.requestDigest!==requestDigest)throw Error('IMPROVE_ROLLBACK_ID_REUSED');return readImproveDecision(o.dataRoot,o.id);}
 const owner=await acquireOwner(o.dataRoot,()=>{}),leases:Awaited<ReturnType<typeof acquireWorkspaceOwner>>[]=[];let e:Evidence|undefined;
 try{
  const facts=improveFacts(o.dataRoot),state=readImproveDecision(o.dataRoot,o.id);
  if(state.sourceId!==o.decisionSource)throw Error('IMPROVE_ROLLBACK_DECISION_CHANGED');
  const raced=facts.find(f=>f.kind==='improve.rollback-request'&&f.data.rollbackId===o.rollbackId);if(raced){if(raced.data.requestDigest!==requestDigest)throw Error('IMPROVE_ROLLBACK_ID_REUSED');return state;}
  const groups=o.groupIds.map(id=>{const start=facts.find(f=>f.data.id===o.id&&f.kind==='improve.formal-started'&&f.data.groupId===id);if(!start)throw Error('IMPROVE_ROLLBACK_NO_FORMAL_WORK');return {id,files:start.data.files as FormalFile[],fences:start.data.fences as WorkspaceFence[],defaults:start.data.defaults as DefaultChange[],build:state.groups.find((g:any)=>g.id===id)?.build as ImproveBuildPair|undefined,buildChange:start.data.buildChange as BuildDefaultChange|null,activated:facts.some(f=>f.data.id===o.id&&f.kind==='improve.activation'&&f.data.groupId===id&&f.data.state==='new-default')};});
  for(const root of [...new Set(groups.flatMap(g=>g.fences.map(f=>f.workspace)))].sort())leases.push(await acquireWorkspaceOwner(root,()=>{}));
  const guard=()=>{owner.assertHeld();for(const l of leases)l.assertHeld();if(o.signal?.aborted)throw Error('IMPROVE_ROLLBACK_CANCELLED');};
  for(const g of groups){for(const fence of g.fences)for(const found of workspaceFences(fence.workspace))if(found.dataRoot!==fence.dataRoot||found.decisionSource!==fence.decisionSource||!o.groupIds.includes(found.groupId))throw Error('IMPROVE_FOREIGN_RECOVERY_FENCE');
   for(const f of g.files){assertFileIdentity(f.identity);const now=sourceBytes(f.root,f.path);if(!now.equals(readObject(o.dataRoot,f.after))&&!now.equals(readObject(o.dataRoot,f.before)))throw Error(`IMPROVE_ROLLBACK_USER_EDIT: ${f.root}/${f.path}; preserve later content`);}
   if(g.build){verifyImproveBuild(o.dataRoot,g.build.baseline);verifyImproveBuild(o.dataRoot,g.build.candidate);verifyBuildSource(o.dataRoot,g.build,'either');}
   if(g.buildChange){const current=readImproveBuildDefault(o.dataRoot,g.buildChange.current.workspace);if(current.revision!==g.buildChange.current.revision&&current.revision!==g.buildChange.previous.revision)throw Error('IMPROVE_ROLLBACK_BUILD_DEFAULT_CHANGED');}
   if(g.activated)for(const d of g.defaults){const current=readImproveDefaults(o.dataRoot,d.current.workspace,d.current.taskType);if(current.revision!==d.current.revision&&current.revision!==d.previous.revision)throw Error('IMPROVE_ROLLBACK_DEFAULT_CHANGED');}
  }
  e=new Evidence(o.dataRoot,state.runId,kind=>{guard();o.fault?.(kind);});const record=(kind:string,data:any)=>appendFact(e!,kind,{id:o.id,rollbackId:o.rollbackId,...data});
  record('improve.rollback-request',{...request,requestDigest,scope:'Restore exact retained file bytes/default snapshot only; no external effect rollback'});
  for(const g of groups){
   for(const fence of g.fences)if(!workspaceFences(fence.workspace).length)setWorkspaceFence(fence);
   try{
    for(const [index,f]of g.files.entries()){
     guard();record('improve.rollback-intent',{groupId:g.id,index,file:f});guard();const now=sourceBytes(f.root,f.path),before=readObject(o.dataRoot,f.before),after=readObject(o.dataRoot,f.after);assertFileIdentity(f.identity);
     if(!now.equals(before))replaceExact(f.root,f.path,after,before,f.identity);
     record('improve.rollback-result',{groupId:g.id,index,state:'restored',file:f,previousFact:'Original write success/unknown is preserved; current exact bytes are now confirmed'});
    }
    if(g.activated){for(const d of g.defaults){const current=readImproveDefaults(o.dataRoot,d.current.workspace,d.current.taskType);if(current.revision!==d.current.revision&&current.revision!==d.previous.revision)throw Error('IMPROVE_ROLLBACK_DEFAULT_CHANGED');}record('improve.activation',{groupId:g.id,state:'rolled-back',defaults:g.defaults.map(d=>({previous:d.current,current:d.previous})),timing:'Subsequent new tasks only; running and pending work remain on their original profile'});}
    if(g.build)verifyBuildSource(o.dataRoot,g.build,'baseline');
    if(g.buildChange){const current=readImproveBuildDefault(o.dataRoot,g.buildChange.current.workspace);if(current.revision!==g.buildChange.current.revision&&current.revision!==g.buildChange.previous.revision)throw Error('IMPROVE_ROLLBACK_BUILD_DEFAULT_CHANGED');record('improve.build-activation',{groupId:g.id,state:'rolled-back',change:{previous:g.buildChange.current,current:g.buildChange.previous},timing:'Future explicit launches only; existing processes untouched'});}
    record('improve.rollback',{groupId:g.id,state:'completed',reason:o.reason,externalEffects:'not undone or inferred'});for(const fence of g.fences)clearWorkspaceFence(fence);
   }catch(error){try{record('improve.rollback',{groupId:g.id,state:'frozen',reason:String(error)});}catch{}throw error;}
  }
 }finally{e?.close();for(const l of leases.reverse())await l.release();await owner.release();}
 return readImproveDecision(o.dataRoot,o.id);
}
