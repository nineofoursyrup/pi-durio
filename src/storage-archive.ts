import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './evidence.js';
import { records, decode } from './history.js';
import { acquireOwner, type OwnerLease } from './ownership.js';
import { DetailPage } from './detail-page.js';
import { forEachDirectory, inspectStorageState } from './storage-projection.js';
import { iterateFixedDependencies } from './fixed-evidence.js';
import { appendManagement, blobReferences, validateHostFormat } from './retention.js';
import { compressFile, expandFile, exists, hashFile, treeFiles, syncDir, saveJson, newDestination, publishDirectory, readJson, safeRelative, type StoredFile } from './storage-files.js';
import type { ManagementFault } from './storage.js';

interface ArchiveManifest {format:'pi-durio.archive';version:1;scope:'whole-root'|'attachments';sourceRoot:string;createdAt:string;files:StoredFile[];bytes:number;policy:string}
function excluded(path:string){return path==='owner.json'||path.endsWith('-shm');}
async function assertNoOwners(root:string) {
  await forEachDirectory(join(root,'sessions'),async entry=>{if(!entry.isDirectory||await exists(join(root,'sessions',entry.name,'owner.json'))||await exists(join(root,'sessions',`${entry.name}.lock`)))throw Error('ARCHIVE_UNRESOLVED_SESSION_OWNER');});
  if(await exists(join(root,'management-trash'))&&(await treeFiles(join(root,'management-trash'))).length)throw Error('ARCHIVE_INCOMPLETE_CLEANUP');
}
async function validateRoot(root:string,owner:OwnerLease) {
  validateHostFormat(root);await assertNoOwners(root);
  const availability=new Map<string,string>();
  for(const ref of records(root,{kinds:['evidence.availability']})){const data=decode(root,ref);if(data.sourceId)availability.set(data.sourceId,data.state);}
  let count=0,declaredUnavailable=0;
  for(const ref of records(root)) {
    if(++count>50000)throw Error('ARCHIVE_FACT_LIMIT');const data=decode(root,ref);
    if(availability.get(ref.id)==='cleaned'||availability.get(ref.id)==='archived'){declaredUnavailable++;continue;}
    // Plans are deletion identities, never claims that their former files remain present.
    if(ref.kind.startsWith('management.')||ref.kind==='evidence.availability'||ref.kind==='evidence.fixed')continue;
    for(const blob of blobReferences(data)){const actual=await hashFile(join(root,'objects',blob.sha256));if(actual.sha256!==blob.sha256||actual.bytes!==blob.bytes)throw Error('ARCHIVE_DEPENDENCY_CORRUPT');}
  }
  for(const blob of iterateFixedDependencies(root)){const actual=await hashFile(join(root,'objects',blob.sha256));if(actual.sha256!==blob.sha256||actual.bytes!==blob.bytes)throw Error('ARCHIVE_FIXED_CORRUPT');}
  const sessions=new DetailPage<{sessionId:string;conversations:number[];conversationCount:number;conversationIdSha256:string;tasks:number;submissions:number;pending:number}>();
  await forEachDirectory(join(root,'sessions'),async entry=>{
    const session=await inspectStorageState(join(root,'sessions',entry.name,'durable.sqlite'),owner,{conversationLimit:32,failOnLimit:false});
    if(!session.conversationCount)throw Error('UNSUPPORTED_OR_EMPTY_DURABLE_FORMAT');
    sessions.add({sessionId:entry.name,conversations:session.conversations,conversationCount:session.conversationCount,conversationIdSha256:session.conversationIdSha256,tasks:session.taskCount,submissions:session.submissionCount,pending:session.pendingCount});
  });
  return {hostRecords:count,declaredUnavailable,sessions:sessions.items,sessionSummary:sessions.summary(),detailSource:'Every session is retained in the verified manifest and restored public Storage; sessions is a bounded display page',execution:'Readability only. No Harness opened; pending execution still requires original-version and authorization recovery checks.'};
}
async function readManifest(archive:string):Promise<{manifest:ArchiveManifest;identity:string}> {
  const envelope=await readJson(join(archive,'manifest.json')),manifest=envelope.manifest as ArchiveManifest;
  if(manifest?.format!=='pi-durio.archive'||manifest.version!==1||!['whole-root','attachments'].includes(manifest.scope)||!Array.isArray(manifest.files)||manifest.files.length>50000||digest(JSON.stringify(manifest))!==envelope.identity)throw Error('UNSUPPORTED_ARCHIVE_FORMAT');
  const seen=new Set<string>();let bytes=0;
  for(const file of manifest.files) {
    safeRelative(file.path);if(seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('ARCHIVE_MANIFEST_INVALID');
    if(excluded(file.path)||file.path.endsWith('.lock')||file.path.includes('/owner.json'))throw Error('ARCHIVE_CONTAINS_OWNER');
    if(manifest.scope==='attachments'&&!/^objects\/[a-f0-9]{64}$/.test(file.path))throw Error('ARCHIVE_SCOPE_INVALID');
    seen.add(file.path);bytes+=file.bytes;
  }
  if(!Number.isSafeInteger(bytes)||bytes!==manifest.bytes)throw Error('ARCHIVE_SIZE_INVALID');return {manifest,identity:envelope.identity};
}
async function expandArchive(archive:string,destination:string,manifest:ArchiveManifest,fault?:ManagementFault) {
  for(const file of manifest.files){fault?.('before-restore',file.path);await expandFile(join(archive,'payload',`${file.sha256}.gz`),join(destination,file.path),file);}
  await syncDir(destination);
}
async function verifyRestored(root:string,manifest:ArchiveManifest) {
  const files=await treeFiles(root),key=(list:StoredFile[])=>JSON.stringify([...list].sort((a,b)=>a.path.localeCompare(b.path)).map(file=>[file.path,file.sha256,file.bytes]));
  if(key(files)!==key(manifest.files))throw Error('ARCHIVE_RESTORED_CONTENT_CHANGED');
  if(manifest.scope==='attachments')return {objects:files.length,bytes:manifest.bytes,execution:'No executable root in an attachment archive'};
  const owner=await acquireOwner(root,()=>{});try{return await validateRoot(root,owner);}finally{await owner.release();}
}
export async function verifyArchive(archive:string) {
  archive=await realpath(archive);const {manifest,identity}=await readManifest(archive),temporary=await realpath(await mkdtemp(join(tmpdir(),'durio-archive-verify-')));
  try {await expandArchive(archive,temporary,manifest);const readable=await verifyRestored(temporary,manifest);return {archive,identity,scope:manifest.scope,files:manifest.files.length,bytes:manifest.bytes,readable,verified:true};}
  finally{await rm(temporary,{recursive:true,force:true});}
}
/** Lossless whole-root archive explicitly includes every project in the shared host store.
 * Selected object archives are independent attachments. Neither operation removes its source. */
export async function archiveStorage(root:string,request:{destination:string;scope:'whole-root'|'attachments';objects?:string[]},options:{fault?:ManagementFault}={}) {
  root=await realpath(root);validateHostFormat(root);const destination=await newDestination(root,request.destination),owner=await acquireOwner(root,()=>{});
  const id=randomUUID(),staging=`${destination}.partial-${id}`;let created=false,reserved=false;
  try {
    await mkdir(`${destination}.lock`,{mode:0o700});reserved=true;
    await assertNoOwners(root);let files:StoredFile[];
    if(request.scope==='whole-root') {await validateRoot(root,owner);files=await treeFiles(root,{exclude:excluded});}
    else if(request.scope==='attachments') {
      if(!request.objects?.length||request.objects.length>100||new Set(request.objects).size!==request.objects.length)throw Error('ARCHIVE_OBJECT_SCOPE_REQUIRED');
      files=[];for(const sha of request.objects){if(!/^[a-f0-9]{64}$/.test(sha))throw Error('INVALID_OBJECT_ID');const actual=await hashFile(join(root,'objects',sha));if(actual.sha256!==sha)throw Error('EVIDENCE_CORRUPT');files.push({path:`objects/${sha}`,...actual});}
    }else throw Error('ARCHIVE_SCOPE_REQUIRED');
    const manifest:ArchiveManifest={format:'pi-durio.archive',version:1,scope:request.scope,sourceRoot:root,createdAt:new Date().toISOString(),files,bytes:files.reduce((n,f)=>n+f.bytes,0),policy:'Lossless gzip files with exact content identities. Source retained. Any cleanup is a separate preview and explicit commit. Whole-root includes all projects, host decisions and dependency objects. Restore never schedules pending work.'};
    await mkdir(staging,{mode:0o700});created=true;await mkdir(join(staging,'payload'),{mode:0o700});
    const done=new Set<string>();for(const file of files){owner.assertHeld();options.fault?.('before-archive',file.path);if(!done.has(file.sha256)){await compressFile(join(root,file.path),join(staging,'payload',`${file.sha256}.gz`));done.add(file.sha256);}}
    // Check main + WAL set and all source bytes after the entire capture, before publication.
    const now=request.scope==='whole-root'?await treeFiles(root,{exclude:excluded}):await Promise.all(files.map(async file=>({path:file.path,...await hashFile(join(root,file.path))})));
    if(JSON.stringify(now)!==JSON.stringify(files))throw Error('ARCHIVE_SOURCE_CHANGED');
    const identity=digest(JSON.stringify(manifest));await saveJson(join(staging,'manifest.json'),{identity,manifest});await syncDir(join(staging,'payload'));
    const verification=await verifyArchive(staging);owner.assertHeld();options.fault?.('before-publish');await publishDirectory(staging,destination);
    // Recording this receipt occurs after the captured root is fully verified, outside its snapshot.
    appendManagement(root,id,'management.archive',{destination,identity,scope:manifest.scope,files:files.length,bytes:manifest.bytes,sourceRetained:true});
    return {...verification,archive:destination,sourceRetained:true};
  }catch(error){if(created)try{await saveJson(join(staging,'failure.json'),{state:'failed',code:(error as NodeJS.ErrnoException).code??'ARCHIVE_VALIDATION_FAILED',sourceRetained:true});}catch{}throw error;}
  finally{if(reserved)await rm(`${destination}.lock`,{recursive:true,force:true});await owner.release();}
}
export async function restoreArchive(archive:string,destination:string,options:{fault?:ManagementFault}={}) {
  archive=await realpath(archive);destination=await newDestination(archive,destination);const {manifest,identity}=await readManifest(archive);
  // Reserve the final name before staging. A conflicting writer cannot claim it concurrently.
  await mkdir(`${destination}.lock`,{mode:0o700});const staging=`${destination}.partial-${randomUUID()}`;await mkdir(staging,{mode:0o700});
  try {await expandArchive(archive,staging,manifest,options.fault);const readable=await verifyRestored(staging,manifest);options.fault?.('before-publish');await publishDirectory(staging,destination);return {destination,archive,identity,scope:manifest.scope,files:manifest.files.length,bytes:manifest.bytes,readable,sourceRetained:true};}
  catch(error){try{await saveJson(join(staging,'failure.json'),{state:'failed',code:(error as NodeJS.ErrnoException).code??'RESTORE_VALIDATION_FAILED',sourceRetained:true});}catch{}throw error;}
  finally{await rm(`${destination}.lock`,{recursive:true,force:true});}
}
/** Current v1 migration is a verified same-format root relocation, never a cross-version resume. */
export async function migrateStorage(root:string,request:{destination:string;backup:string},options:{fault?:ManagementFault}={}) {
  const archive=await archiveStorage(root,{destination:request.backup,scope:'whole-root'},options);
  const restored=await restoreArchive(archive.archive,request.destination,options);
  return {...restored,backup:archive.archive,migration:'supported current host format + Pi public SQLite reader on copies; no private schema rewriting',executionAuthorized:false};
}
