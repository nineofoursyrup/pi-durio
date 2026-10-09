import { mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Evidence, digest, readObject } from './evidence.js';
import { records, decode, resolveEvidence } from './history.js';
import { acquireOwner, type OwnerLease } from './ownership.js';
import { appendManagement, retentionState, validateHostFormat, verifyFiles, type StorageUnit } from './retention.js';
import { exists, hashFile, syncDir, type StoredFile } from './storage-files.js';

export { storageUsage } from './retention.js';
export { archiveStorage, restoreArchive, migrateStorage, verifyArchive } from './storage-archive.js';
export { unfixEvidence } from './fixed-evidence.js';
export interface CleanupRequest {id:string;units:string[];reason:string}
export interface CleanupPlan {version:1;id:string;root:string;request:CleanupRequest;createdAt:string;units:StorageUnit[];blocked:{id:string;reasons:string[]}[];bytes:number;loss:string}
export type ManagementFault=(point:string,unit?:string)=>void;
function validId(id:string){if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))throw Error('INVALID_MANAGEMENT_ID');}
function planRecord(root:string,id:string) {for(const source of records(root,{runId:`management:${id}`,kinds:['management.preview']}))return decode(root,source);return null;}
function loadPlan(root:string,id:string):{plan:CleanupPlan;identity:string} {
  validId(id);const saved=planRecord(root,id);if(!saved)throw Error('MANAGEMENT_PREVIEW_NOT_FOUND');
  if(saved.plan.bytes>16*1024*1024)throw Error('MANAGEMENT_PLAN_LIMIT');
  const bytes=readObject(root,saved.plan),plan=JSON.parse(bytes.toString()) as CleanupPlan;
  if(plan.version!==1||plan.id!==id||digest(bytes)!==saved.identity||!Array.isArray(plan.units))throw Error('MANAGEMENT_PLAN_INVALID');
  return {plan,identity:saved.identity};
}
function managementFacts(root:string,id:string) {return [...records(root,{runId:`management:${id}`} )].map(source=>({source,...decode(root,source)}));}
/** Preview writes only its immutable plan. No implicit default, expiry, or context compaction caller. */
export async function previewCleanup(root:string,request:CleanupRequest) {
  validId(request.id);if(!request.units.length||request.units.length>100||new Set(request.units).size!==request.units.length||!request.reason.trim()||request.reason.length>2048)throw Error('CLEANUP_SCOPE_REQUIRED');
  root=await realpath(root);validateHostFormat(root);const owner=await acquireOwner(root,()=>{});
  try {
    const previous=planRecord(root,request.id);
    if(previous){const saved=loadPlan(root,request.id);if(JSON.stringify(saved.plan.request)!==JSON.stringify(request))throw Error('MANAGEMENT_ID_CONFLICT');return {...saved,repeated:true};}
    const state=await retentionState(root,owner),units:StorageUnit[]=[],blocked:CleanupPlan['blocked']=[];
    for(const id of request.units) {
      const unit=state.units.find(item=>item.id===id),reasons=[...state.blockers,...unit?.protectedBy??[]];
      if(!unit)reasons.push('unit-not-found');
      if(reasons.length)blocked.push({id,reasons});else {await verifyFiles(root,unit!.files);units.push(unit!);}
    }
    const plan:CleanupPlan={version:1,id:request.id,root,request,createdAt:new Date().toISOString(),units,blocked,bytes:units.reduce((n,u)=>n+u.bytes,0),loss:'Permanently removes exactly the listed session files/attachments. Retained facts and past judgments stay; listed source references become unavailable. No summary replaces originals. Host fact bodies are retained.'};
    const bytes=JSON.stringify(plan);if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('MANAGEMENT_PLAN_LIMIT');const identity=digest(bytes);
    owner.assertHeld();const evidence=new Evidence(root,`management:${request.id}`);
    try {const ref=evidence.blob(bytes);evidence.append('management.preview',{id:request.id,identity,plan:ref,bytes:plan.bytes,eligible:units.map(u=>u.id),blocked:blocked.map(u=>u.id)});}finally{evidence.close();}
    return {plan,identity,repeated:false};
  }finally{await owner.release();}
}
export function readCleanup(root:string,id:string) {
  const {plan,identity}=loadPlan(root,id),facts=managementFacts(root,id);
  const parts=plan.units.map(unit=>{const result=facts.findLast(f=>f.source.kind==='management.part-result'&&f.unitId===unit.id);return {id:unit.id,bytes:unit.bytes,status:result?.status??'not-run',reason:result?.reason??null};});
  return {id,identity,plan,parts,status:parts.length&&parts.every(p=>p.status==='completed')?'completed':facts.some(f=>f.source.kind==='management.commit')?'partial':'previewed'};
}
function sameFiles(a:StoredFile[],b:StoredFile[]) {return JSON.stringify(a.map(f=>[f.path,f.sha256,f.bytes]).sort())===JSON.stringify(b.map(f=>[f.path,f.sha256,f.bytes]).sort());}
async function deleteUnit(root:string,id:string,identity:string,unit:StorageUnit,owner:OwnerLease,fault?:ManagementFault) {
  let facts=managementFacts(root,id),intent=facts.find(f=>f.source.kind==='management.part-intent'&&f.unitId===unit.id);
  if(!intent) {owner.assertHeld();appendManagement(root,id,'management.part-intent',{unitId:unit.id,identity,files:unit.files,runIds:unit.runIds,inspection:unit.inspection??null});fault?.('after-intent',unit.id);}
  const sessionId=unit.kind==='session'?unit.id.slice(8):null;
  const sourceDir=sessionId?join(root,'sessions',sessionId):null,stagedDir=sessionId?join(root,'management-trash',id,sessionId):null;
  if(sourceDir&&stagedDir) {
    if(await exists(sourceDir)) {
      if(await exists(stagedDir))throw Error('CLEANUP_STAGING_CONFLICT');
      await verifyFiles(root,unit.files);await mkdir(join(root,'management-trash',id),{recursive:true,mode:0o700});
      owner.assertHeld();await rename(sourceDir,stagedDir);await syncDir(join(root,'sessions'));await syncDir(join(root,'management-trash',id));fault?.('after-stage',unit.id);
    }else if(!intent)throw Error('CLEANUP_SOURCE_MISSING');
  }
  for(const file of unit.files) {
    owner.assertHeld();facts=managementFacts(root,id);
    const done=facts.find(f=>f.source.kind==='management.file-result'&&f.unitId===unit.id&&f.path===file.path);
    const path=stagedDir?join(stagedDir,file.path.split('/').slice(2).join('/')):join(root,file.path);
    if(done){if(await exists(path))throw Error('CLEANUP_DELETED_CONTENT_REAPPEARED');continue;}
    let state='absent-after-recorded-intent';
    if(await exists(path)) {
      const actual=await hashFile(path);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error('CLEANUP_CONTENT_CHANGED');
      fault?.('before-delete',file.path);owner.assertHeld();await unlink(path);await syncDir(stagedDir??join(root,'objects'));state='deleted';fault?.('after-delete',file.path);
    }
    appendManagement(root,id,'management.file-result',{unitId:unit.id,path:file.path,sha256:file.sha256,bytes:file.bytes,state});
  }
  if(stagedDir&&await exists(stagedDir))await rmdir(stagedDir);
  owner.assertHeld();
  // Minimal deletion facts never duplicate the removed original content.
  const evidence=new Evidence(root,`management:${id}`);evidence.db.exec('BEGIN IMMEDIATE');
  try {
    if(sessionId)evidence.append('management.session-removed',{version:1,operationId:id,previewIdentity:identity,sessionId,state:'cleaned',runIds:unit.runIds,files:unit.files,inspection:unit.inspection,protectedBy:[],complete:true});
    const affected=unit.kind==='session'?unit.runIds.map(runId=>({runId,sourceId:undefined})):unit.sources.map(sourceId=>({runId:resolveEvidence(root,sourceId).runId,sourceId}));
    for(const {sourceId,runId} of affected) {
      // Attribute the availability to the original run; history retains the old judgment.
      const data={sourceId,sessionId,unitId:unit.id,state:'cleaned',operationId:id,reason:'explicit cleanup',scope:unit.kind==='session'?'durable session unavailable; host facts retained':'referenced attachment unavailable; host fact retained'};
      const body=evidence.blob(JSON.stringify(data));
      evidence.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(runId,'evidence.availability',new Date().toISOString(),JSON.stringify(body));
    }
    evidence.append('management.part-result',{unitId:unit.id,status:'completed',bytes:unit.bytes,identity});evidence.db.exec('COMMIT');
  }catch(error){evidence.db.exec('ROLLBACK');throw error;}finally{evidence.close();}
}
/** The identity is the explicit confirmation token returned by preview; retries keep the same operation. */
export async function commitCleanup(root:string,request:{id:string;identity:string},options:{fault?:ManagementFault}={}) {
  root=await realpath(root);const saved=loadPlan(root,request.id);if(saved.plan.root!==root||saved.identity!==request.identity)throw Error('STALE_MANAGEMENT_PREVIEW');
  const owner=await acquireOwner(root,()=>{});
  try {
    const facts=managementFacts(root,request.id),completed=new Set(facts.filter(f=>f.source.kind==='management.part-result'&&f.status==='completed').map(f=>f.unitId));
    const intents=new Set(facts.filter(f=>f.source.kind==='management.part-intent').map(f=>f.unitId));
    const remaining=saved.plan.units.filter(unit=>!completed.has(unit.id));
    if(!remaining.length)return readCleanup(root,request.id);
    const skipSessions=new Set<string>();for(const unit of remaining)if(unit.kind==='session'&&intents.has(unit.id)&&!await exists(join(root,'sessions',unit.id.slice(8))))skipSessions.add(unit.id.slice(8));
    const current=await retentionState(root,owner,{skipSessions});if(current.blockers.length)throw Error(`CLEANUP_PROTECTION_UNKNOWN:${current.blockers.join(',')}`);
    const ownAvailability=new Set<string>();
    for(const source of records(root,{kinds:['evidence.availability']}))if(decode(root,source).operationId===request.id)ownAvailability.add(source.id);
    // Validate the complete remaining scope before the first destructive action.
    for(const unit of remaining) {
      const now=current.units.find(item=>item.id===unit.id);
      if(now?.protectedBy.length)throw Error(`CLEANUP_PROTECTED:${unit.id}:${now.protectedBy.join(',')}`);
      if(!intents.has(unit.id)) {if(!now||!sameFiles(unit.files,now.files)||JSON.stringify(unit.sources)!==JSON.stringify(now.sources.filter(id=>!ownAvailability.has(id)))||JSON.stringify(unit.runIds)!==JSON.stringify(now.runIds))throw Error('STALE_MANAGEMENT_PREVIEW');await verifyFiles(root,unit.files);}
      else if(!now&&unit.kind==='session') {
        // Re-check host/queue/fixed protection after an interrupted staged deletion.
        for(const candidate of current.units)if(candidate.kind==='object'&&candidate.runIds.some(run=>unit.runIds.includes(run))&&candidate.protectedBy.some(reason=>reason!=='host-fact-body'&&reason!=='fixed-decision-manifest'))throw Error('CLEANUP_PROTECTED_AFTER_INTERRUPTION');
      }
    }
    owner.assertHeld();if(!facts.some(f=>f.source.kind==='management.commit'))appendManagement(root,request.id,'management.commit',{id:request.id,identity:request.identity,units:saved.plan.units.map(u=>u.id),reason:saved.plan.request.reason});
    for(const unit of remaining) {
      try {await deleteUnit(root,request.id,request.identity,unit,owner,options.fault);}
      catch(error) {try{appendManagement(root,request.id,'management.part-result',{unitId:unit.id,status:'failed',reason:storageFailure(error),identity:request.identity});}catch{/* Disk failure can also prevent its receipt. Durable intent stays. */}break;}
    }
    return readCleanup(root,request.id);
  }finally{await owner.release();}
}
function storageFailure(error:unknown) {const code=(error as NodeJS.ErrnoException).code;return code??(error instanceof Error?error.message.split(':')[0]:'MANAGEMENT_FAILURE');}
