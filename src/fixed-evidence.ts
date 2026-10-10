import { createReadStream, openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Evidence, readObject, type BlobRef, digest } from './evidence.js';
import { acquireOwner } from './ownership.js';
import { records, decode, watermark, resolveEvidence } from './history.js';
import { readObjectRange } from './query.js';
import { queryUsage } from './usage-query.js';

const installRoot=fileURLToPath(new URL('../../',import.meta.url));
function refs(value:any,visit:(ref:BlobRef)=>void) {
  if(!value||typeof value!=='object')return;
  if(typeof value.sha256==='string'&&Number.isSafeInteger(value.bytes)&&value.bytes>=0){visit(value);return;}
  for(const item of Object.values(value))refs(item,visit);
}
function fixedManifest(root:string,ref:BlobRef) {
  if(ref.bytes>8*1024*1024)throw Error('FIX_MANIFEST_LIMIT');
  const manifest=JSON.parse(readObject(root,ref).toString());
  if(manifest.version!==1||!Array.isArray(manifest.objects)||manifest.objects.length>20000)throw Error('FIX_MANIFEST_INVALID');
  return manifest as {version:1;objects:BlobRef[];scope:string;sources:string[];snapshot:number;runs:string[]};
}
/** Copy only a caller-declared immutable dependency whose bytes match an acquired inventory.
 * Streaming prevents installed binary size from becoming memory growth. */
async function retainFile(root:string,path:string,expected:BlobRef) {
  const destination=join(root,'objects',expected.sha256);
  if(existsSync(destination)){readObjectRange(root,expected,{limit:1});return;}
  const temporary=`${destination}.${randomUUID()}`,fd=openSync(temporary,'wx',0o600),hash=createHash('sha256');let bytes=0;
  try {for await(const chunk of createReadStream(path)){const data=Buffer.from(chunk);hash.update(data);bytes+=data.length;let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset,data.length-offset);}fsyncSync(fd);}
  catch(error){closeSync(fd);unlinkSync(temporary);throw error;}
  closeSync(fd);if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256){unlinkSync(temporary);throw Error('FIXED_DEPENDENCY_CHANGED');}
  renameSync(temporary,destination);const directory=openSync(join(root,'objects'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export interface FixRequest { id:string; sources:readonly string[]; dependencies?:readonly string[]; purpose:string; }
/** Fixed facts protect verified content, not just a link. No runtime/session is opened. */
export async function fixEvidence(root:string,request:FixRequest) {
  if(!request.id.trim()||request.id.length>128||!request.purpose.trim()||!request.sources.length||request.sources.length+(request.dependencies?.length??0)>50)throw Error('FIX_SCOPE_REQUIRED');
  // Existence checked before acquireOwner can create a directory.
  watermark(root);const owner=await acquireOwner(root,()=>{});let evidence:Evidence|undefined;
  try {
    const requestIdentity=digest(JSON.stringify(request));
    for(const ref of records(root,{kinds:['evidence.fixed']})){const data=decode(root,ref);if(data.id===request.id){if(data.requestIdentity!==requestIdentity)throw Error('FIX_ID_CONFLICT');const check=verifyFixed(root,ref.id);if(check.state!=='protected')throw Error(`FIXED_CONTENT_${check.state.toUpperCase()}`);return {source:ref.id,...data,repeated:true};}}
    const snapshot=watermark(root),selected=[...request.sources,...request.dependencies??[]].map(id=>resolveEvidence(root,id));
    if(selected.some(source=>source.kind==='evidence.fixed'))throw Error('FIX_ALREADY_FIXED: use verifyFixed and the existing fixed evidence ID');
    const runs=new Set(selected.map(ref=>ref.runId));const dependencies=new Map<string,BlobRef>(),sourceIds:string[]=[];
    const protect=(ref:BlobRef)=>{if(dependencies.size>=20000&&!dependencies.has(ref.sha256))throw Error('FIX_DEPENDENCY_LIMIT');readObjectRange(root,ref,{limit:1});dependencies.set(ref.sha256,{sha256:ref.sha256,bytes:ref.bytes});};
    // Dependency closure deliberately covers each selected source run through the snapshot:
    // original input, tool/check output, recovered decisions, config, artifact and acquired initial state.
    for(const runId of runs)for(const ref of records(root,{runId,through:snapshot})) {
      owner.assertHeld();if(ref.kind==='evidence.fixed'||ref.kind==='usage.estimate')continue;
      if(sourceIds.length>=20000)throw Error('FIX_SOURCE_LIMIT');sourceIds.push(ref.id);protect(ref.ref);const data=decode(root,ref);refs(data,protect);
      if(ref.kind==='execution.artifact'&&data.installation) {
        const inventory=JSON.parse(readObject(root,data.installation).toString());
        if(!Array.isArray(inventory)||inventory.length>20000)throw Error('FIX_INSTALLATION_INVALID');
        for(const file of inventory) {
          const candidate=resolve(installRoot,file.path),rel=relative(installRoot,candidate);
          if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel)||realpathSync(candidate)!==candidate)throw Error('FIX_INSTALLATION_ALIAS');
          await retainFile(root,candidate,file);protect(file);
        }
      }
    }
    owner.assertHeld();evidence=new Evidence(root,selected[0].runId);evidence.db.exec('BEGIN IMMEDIATE');
    try {
      const manifest=evidence.blob(JSON.stringify({version:1,snapshot,sources:sourceIds,objects:[...dependencies.values()],runs:[...runs],scope:'all acquired records and referenced content of selected runs through snapshot, including verified installed execution dependencies; not a complete project snapshot'}));
      const fact={id:request.id,requestIdentity,purpose:request.purpose,selected:[...request.sources],declaredDependencies:[...request.dependencies??[]],snapshot,manifest,objects:dependencies.size,bytes:[...dependencies.values()].reduce((n,r)=>n+r.bytes,0),state:'protected'};
      owner.assertHeld();const seq=evidence.append('evidence.fixed',fact);evidence.db.exec('COMMIT');return {source:`e1:${seq}:${digest(JSON.stringify(fact))}`,...fact,repeated:false};
    }catch(error){evidence.db.exec('ROLLBACK');throw error;}
  } finally {evidence?.close();await owner.release();}
}
export function verifyFixed(root:string,id:string) {
  const source=resolveEvidence(root,id);if(source.kind!=='evidence.fixed')throw Error('NOT_FIXED_EVIDENCE');
  const release=unfixedEvidence(root,id);if(release)return {source:id,state:'released',release};
  try{const fact=decode(root,source),manifest=fixedManifest(root,fact.manifest);for(const ref of manifest.objects)readObjectRange(root,ref,{limit:1});return {source:id,state:'protected',manifest:fact.manifest,scope:manifest.scope,objects:manifest.objects.length};}
  catch(error){return {source:id,state:String(error).includes('CORRUPT')?'corrupt':'missing',error:String(error)};}
}
/** Cleanup implementations consume this closure and must retain the manifest itself too. */
export function* iterateFixedDependencies(root:string) {
  for(const source of records(root,{kinds:['evidence.fixed']})){const fact=decode(root,source);yield source.ref;yield fact.manifest as BlobRef;const manifest=fixedManifest(root,fact.manifest);if(!unfixedEvidence(root,source.id))yield* manifest.objects;}
}
export function unfixedEvidence(root:string,fixedEvidenceId:string) {
  for(const source of records(root,{kinds:['evidence.unfixed']})){const data=decode(root,source);if(data.fixedEvidenceId===fixedEvidenceId)return {source:source.id,...data};}
  return null;
}
/** An explicit release affects only this fixation. Other fixed scopes still protect shared content. */
export async function unfixEvidence(root:string,request:{id:string;fixedEvidenceId:string;reason:string}) {
  if(!request.id.trim()||request.id.length>128||!request.reason.trim()||request.reason.length>2048)throw Error('UNFIX_SCOPE_REQUIRED');
  watermark(root);const owner=await acquireOwner(root,()=>{});let evidence:Evidence|undefined;
  try {
    const source=resolveEvidence(root,request.fixedEvidenceId);if(source.kind!=='evidence.fixed')throw Error('NOT_FIXED_EVIDENCE');
    const requestIdentity=digest(JSON.stringify(request));
    for(const ref of records(root,{kinds:['evidence.unfixed']})){const data=decode(root,ref);if(data.id===request.id){if(data.requestIdentity!==requestIdentity)throw Error('UNFIX_ID_CONFLICT');return {source:ref.id,...data,repeated:true};}}
    const previous=unfixedEvidence(root,source.id);if(previous)throw Error('FIX_ALREADY_RELEASED');
    // Keep and validate the original manifest even when some payload is already missing.
    // A broken manifest cannot be interpreted as an empty protection set.
    const fact=decode(root,source);fixedManifest(root,fact.manifest);
    owner.assertHeld();evidence=new Evidence(root,source.runId);evidence.db.exec('BEGIN IMMEDIATE');
    try{const data={...request,requestIdentity,state:'released'},seq=evidence.append('evidence.unfixed',data);evidence.db.exec('COMMIT');return {source:`e1:${seq}:${digest(JSON.stringify(data))}`,...data,repeated:false};}
    catch(error){evidence.db.exec('ROLLBACK');throw error;}
  }finally{evidence?.close();await owner.release();}
}
export function fixedDependencies(root:string) {
  const dependencies=new Map<string,BlobRef>();
  for(const ref of iterateFixedDependencies(root)){if(dependencies.size>=20000&&!dependencies.has(ref.sha256))throw Error('FIX_PROTECTION_QUERY_LIMIT: consume iterateFixedDependencies');dependencies.set(ref.sha256,ref);}
  return [...dependencies.values()];
}
export async function estimateUsage(root:string,request:{id:string;runIds:string[];through:number;price:{version:string;source:string;currency:'USD';effectiveAt:string;perMillion:{input:number;output:number;cacheRead:number;cacheWrite:number}}}) {
  if(!request.id||!request.price.version||!request.price.source||!Number.isFinite(Date.parse(request.price.effectiveAt))||request.price.currency!=='USD'||Object.values(request.price.perMillion).some(n=>!Number.isFinite(n)||n<0))throw Error('INVALID_PRICE_VERSION');
  const projection=queryUsage(root,request.runIds,request.through),rates=request.price.perMillion;
  const parts=Object.entries(rates).map(([key,price])=>({key,tokens:projection.totals[key as keyof typeof rates],price}));
  const known=parts.filter(part=>part.tokens!==null);const value=known.length?known.reduce((sum,part)=>sum+part.tokens!*part.price/1e6,0):null;
  const fact={...request,sourceIds:projection.items.map(item=>item.source),kind:'estimate',method:'known token categories times declared per-million prices; reasoning already included in output; original tool/catalog estimate retained separately',value,completeness:projection.completeness,missing:parts.filter(part=>part.tokens===null).map(part=>part.key)};
  const owner=await acquireOwner(root,()=>{});let evidence:Evidence|undefined;
  try{for(const ref of records(root,{kinds:['usage.estimate']})){const previous=decode(root,ref);if(previous.id===request.id){if(digest(JSON.stringify(previous))!==digest(JSON.stringify(fact)))throw Error('ESTIMATE_ID_CONFLICT');return {source:ref.id,...previous,repeated:true};}}
    owner.assertHeld();evidence=new Evidence(root,request.runIds[0]);const seq=evidence.append('usage.estimate',fact);return {source:`e1:${seq}:${digest(JSON.stringify(fact))}`,...fact,repeated:false};
  }finally{evidence?.close();await owner.release();}
}
