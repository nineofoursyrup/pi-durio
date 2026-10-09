import { readdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Evidence, openHostReadonly, readObject, readQueue, type BlobRef } from './evidence.js';
import { records, decode, type EvidenceReference } from './history.js';
import { iterateFixedDependencies, unfixedEvidence } from './fixed-evidence.js';
import { inspectSession } from './preflight.js';
import type { OwnerLease } from './ownership.js';
import { exists, treeFiles, hashFile, type StoredFile } from './storage-files.js';

export interface StorageUnit {
  id:string;kind:'session'|'object';bytes:number;files:StoredFile[];
  runIds:string[];sources:string[];protectedBy:string[];
  inspection?:{conversations:number[];tasks:number;submissions:number;pending:number;sourceFiles:{path:string;sha256:string}[]};
}
export interface RetentionState {units:StorageUnit[];blockers:string[];recordBodies:Set<string>;runSessions:Map<string,string>;}
export function validateHostFormat(root:string) {
  const db=openHostReadonly(root);
  try {
    const version=db.prepare('PRAGMA user_version').get();
    const columns=db.prepare('PRAGMA table_info(records)').all().map(row=>`${row.name}:${row.type}`);
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
    if(Number(version?.user_version)!==0||tables.length!==1||tables[0]!=='records'||JSON.stringify(columns)!==JSON.stringify(['seq:INTEGER','run_id:TEXT','kind:TEXT','at:TEXT','body:TEXT']))throw Error('UNSUPPORTED_HOST_FORMAT');
    const check=db.prepare('PRAGMA quick_check').get();if(check?.quick_check!=='ok')throw Error('HOST_INTEGRITY_FAILURE');
  }finally{db.close();}
}
export function blobReferences(value:unknown):BlobRef[] {
  const result:BlobRef[]=[];
  const visit=(item:any)=>{if(!item||typeof item!=='object')return;if(typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256)&&Number.isSafeInteger(item.bytes)&&item.bytes>=0){result.push({sha256:item.sha256,bytes:item.bytes});return;}for(const child of Object.values(item))visit(child);};visit(value);return result;
}
function sourceReferences(value:unknown):string[] {
  const output:string[]=[];const visit=(item:unknown)=>{if(typeof item==='string'&&/^e1:[1-9][0-9]*:[a-f0-9]{64}$/.test(item))output.push(item);else if(item&&typeof item==='object')for(const child of Object.values(item))visit(child);};visit(value);return output;
}
/** Strict fail-closed protection projection. Host bodies are facts, never a disposable index.
 * Limits fail explicitly; an incomplete projection never authorizes deletion. */
export async function retentionState(root:string,owner:OwnerLease,options:{skipSessions?:Set<string>}={}):Promise<RetentionState> {
  owner.assertHeld();validateHostFormat(root);
  const blockers:string[]=[],recordBodies=new Set<string>(),runSessions=new Map<string,string>();
  const objects=new Map<string,{ref:BlobRef;sources:Set<string>;runs:Set<string>}>(),facts=new Map<string,{source:EvidenceReference;refs:BlobRef[];links:string[]}>();
  const fixedFacts:{source:EvidenceReference;data:any}[]=[];let dependencyEdges=0;
  const formal=new Map<string,{id:string;groupId:string;refs:BlobRef[]}>(),reverted=new Set<string>(),defaults=new Map<string,{workspace:string;taskType:string;refs:BlobRef[]}>();
  const versions:{reason:string;refs:BlobRef[]}[]=[];
  const byRun=new Map<string,string[]>(),closed=new Map<string,any>(),protectedRuns=new Map<string,Set<string>>();
  const addRun=(run:string,why:string)=>{let reasons=protectedRuns.get(run);if(!reasons)protectedRuns.set(run,reasons=new Set());reasons.add(why);};
  const add=(ref:BlobRef,source:EvidenceReference)=>{let item=objects.get(ref.sha256);if(!item)objects.set(ref.sha256,item={ref,sources:new Set(),runs:new Set()});if(item.ref.bytes!==ref.bytes)throw Error('CONFLICTING_OBJECT_IDENTITY');item.sources.add(source.id);item.runs.add(source.runId);};
  for(const source of records(root)) {
    if(facts.size>=50000)throw Error('RETENTION_FACT_LIMIT');recordBodies.add(source.ref.sha256);const data=decode(root,source),refs=blobReferences(data);
    const links=sourceReferences(data);dependencyEdges+=refs.length+links.length;if(dependencyEdges>200000)throw Error('RETENTION_DEPENDENCY_LIMIT');
    facts.set(source.id,{source,refs,links});if(source.kind==='evidence.fixed')fixedFacts.push({source,data});let list=byRun.get(source.runId);if(!list)byRun.set(source.runId,list=[]);list.push(source.id);
    add(source.ref,source);
    // Management plans contain deletion identities, not new protection claims.
    if(!source.kind.startsWith('management.')&&source.kind!=='evidence.availability')for(const ref of refs)add(ref,source);
    if(source.kind==='task.accepted')runSessions.set(source.runId,data.sessionId);
    if(source.kind==='run.closed'||source.kind==='recovery.closed')closed.set(source.runId,data.result??data);
    if(source.kind==='recovery.report'&&data.status!=='completed'&&data.status!=='ended')addRun(source.runId,'recovery-needs-decision');
    const groupKey=JSON.stringify([data.id,data.groupId]);
    if(source.kind==='improve.formal-started')formal.set(groupKey,{id:data.id,groupId:data.groupId,refs});
    if(source.kind==='improve.rollback'&&data.state==='completed')reverted.add(groupKey);
    if(source.kind==='improve.activation')for(const change of data.defaults??[]){const current=change.current;defaults.set(JSON.stringify([current.workspace,current.taskType]),{workspace:current.workspace,taskType:current.taskType,refs:blobReferences(current)});}
    if(['improve.build-content','improve.build','improve.build-started','improve.eval-asset'].includes(source.kind))versions.push({reason:`improve-version:${data.id}:${data.groupId}`,refs});
  }
  // Retain the released manifest as decision evidence; release only its payload scope.
  const protectedObjects=new Map<string,Set<string>>();
  const protect=(sha:string,why:string)=>{let reasons=protectedObjects.get(sha);if(!reasons)protectedObjects.set(sha,reasons=new Set());reasons.add(why);};
  for(const sha of recordBodies)protect(sha,'host-fact-body');
  // Exact rollback and future new-task defaults still consume these original
  // payloads after the analysis run closes. Derive protection from the existing
  // journal; completed rollback releases only that batch, not a current default.
  for(const [key,value]of formal)if(!reverted.has(key))for(const ref of value.refs)protect(ref.sha256,`improve-formal:${value.id}:${value.groupId}`);
  for(const value of defaults.values())for(const ref of value.refs)protect(ref.sha256,`improve-active-default:${value.workspace}:${value.taskType}`);
  for(const version of versions)for(const ref of version.refs)protect(ref.sha256,version.reason);
  for(const fact of fixedFacts) {
    const manifest=JSON.parse(readObject(root,fact.data.manifest).toString());
    if(manifest.version!==1||!Array.isArray(manifest.runs)||!Array.isArray(manifest.objects))throw Error('FIX_MANIFEST_INVALID');
    protect(fact.data.manifest.sha256,'fixed-decision-manifest');
    // A released fixation still supplies provenance for its formerly retained payload;
    // otherwise installed dependencies copied by fixation would become undeletable orphans.
    for(const ref of manifest.objects){if(++dependencyEdges>200000)throw Error('RETENTION_DEPENDENCY_LIMIT');add(ref,fact.source);}
    if(!unfixedEvidence(root,fact.source.id))for(const run of manifest.runs)addRun(run,`fixed:${fact.source.id}`);
  }
  for(const ref of iterateFixedDependencies(root))protect(ref.sha256,'fixed-dependency');
  for(const run of runSessions.keys()) {
    const result=closed.get(run);
    if(!result||result.cleanup!=='confirmed'||!['completed','failed','aborted'].includes(result.status))addRun(run,'unfinished-or-unconfirmed-close');
  }
  let after:number|undefined,through:number|undefined;
  do {const page=readQueue(root,{after,through,limit:100});through=page.through;
    for(const item of page.items)if(['pending','dispatching','frozen'].includes(item.status)){addRun(item.target.runId,`queue:${item.status}:${item.requestId}`);if(item.runId)addRun(item.runId,`queue:${item.status}:${item.requestId}`);}
    after=page.next??undefined;
  }while(after!==undefined);
  const units:StorageUnit[]=[];
  const sessionDirs=await readdir(join(root,'sessions'),{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
  for(const dir of sessionDirs) {
    if(!dir.isDirectory()){blockers.push('unexpected-session-entry');continue;}
    if(options.skipSessions?.has(dir.name))continue;
    const id=`session:${dir.name}`,runIds=[...runSessions].filter(([,session])=>session===dir.name).map(([run])=>run);
    const protectedBy:string[]=[],sessionPath=join(root,'sessions',dir.name);
    if(!runIds.length)protectedBy.push('session-without-host-identity');
    if(await exists(join(sessionPath,'owner.json'))||await exists(`${sessionPath}.lock`))protectedBy.push('unresolved-session-owner');
    let files:StoredFile[]=[],inspection:StorageUnit['inspection'];
    try {
      files=(await treeFiles(sessionPath)).map(file=>({...file,path:`sessions/${dir.name}/${file.path}`}));
      if(files.some(file=>!['durable.sqlite','durable.sqlite-wal','durable.sqlite-shm'].includes(file.path.split('/').at(-1)!)))protectedBy.push('unknown-session-file');
      if(!protectedBy.includes('unresolved-session-owner')) {
        const report=await inspectSession(join(sessionPath,'durable.sqlite'),owner);
        if(!report.conversations.length)protectedBy.push('unknown-or-empty-session-format');
        inspection={conversations:report.conversations.map(c=>c.id),tasks:report.tasks.length,submissions:report.submissions.length,pending:report.pending.length,sourceFiles:report.sourceFiles};
        if(report.pending.length)protectedBy.push('durable-pending-in-whole-session');
      }
    }catch(error){protectedBy.push(`session-unreadable:${String(error).slice(0,300)}`);}
    for(const run of runIds)for(const reason of protectedBy)addRun(run,reason);
    units.push({id,kind:'session',bytes:files.reduce((n,f)=>n+f.bytes,0),files,runIds,sources:runIds.flatMap(run=>byRun.get(run)??[]),protectedBy,inspection});
  }
  // A dependent unresolved/fixed source protects its explicitly linked evidence scope too.
  const pending=[...protectedRuns.keys()],visited=new Set<string>();
  while(pending.length){const run=pending.shift()!;if(visited.has(run))continue;visited.add(run);
    for(const id of byRun.get(run)??[]) {const fact=facts.get(id)!;protect(fact.source.ref.sha256,`protected-run:${run}`);for(const ref of fact.refs)protect(ref.sha256,`protected-run:${run}`);
      for(const link of fact.links){const target=facts.get(link);if(!target){blockers.push(`missing-dependent-source:${link}`);continue;}if(!protectedRuns.has(target.source.runId)){addRun(target.source.runId,`dependency-of:${run}`);pending.push(target.source.runId);}}
    }
  }
  for(const unit of units)unit.protectedBy=[...new Set([...unit.protectedBy,...unit.runIds.flatMap(run=>[...protectedRuns.get(run)??[]])])];
  for(const file of await treeFiles(join(root,'objects'),{hash:false})) {
    if(!/^[a-f0-9]{64}$/.test(file.path)){blockers.push('unknown-object-file');continue;}
    const item=objects.get(file.path),reasons=[...protectedObjects.get(file.path)??[]];
    if(!item)reasons.push('unattributed-object: explicit provenance required');
    // A blob can be shared by many completed and incomplete sessions.
    for(const run of item?.runs??[])for(const reason of protectedRuns.get(run)??[])reasons.push(reason);
    units.push({id:`object:${file.path}`,kind:'object',bytes:file.bytes,files:[{path:`objects/${file.path}`,sha256:file.path,bytes:file.bytes}],runIds:[...item?.runs??[]],sources:[...item?.sources??[]],protectedBy:[...new Set(reasons)]});
  }
  owner.assertHeld();return {units,blockers:[...new Set(blockers)],recordBodies,runSessions};
}
export function appendManagement(root:string,id:string,kind:string,data:unknown) {const evidence=new Evidence(root,`management:${id}`);try{return evidence.append(kind,data);}finally{evidence.close();}}
export async function verifyFiles(root:string,files:StoredFile[]) {for(const file of files){const actual=await hashFile(join(root,file.path));if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error('STALE_MANAGEMENT_PREVIEW');}}

/** Usage never claims an active tree is a stable snapshot. Deep protection inspection is preview's job. */
export async function storageUsage(root:string,options:{after?:number;limit?:number}={}) {
  if(await exists(root))root=await realpath(root);
  const after=options.after??0,limit=options.limit??20;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_QUERY_RANGE');
  const totals:Record<string,{files:number;bytes:number}>={},units:{id:string;bytes:number;projects?:string[]}[]=[],bodies=new Set<string>(),projects=new Map<string,Set<string>>();
  let factCount=0;
  if(await exists(join(root,'host.sqlite')))for(const ref of records(root)){if(++factCount>50000)throw Error('STORAGE_FACT_LIMIT');bodies.add(ref.ref.sha256);if(ref.kind==='task.accepted'){const data=decode(root,ref);let list=projects.get(data.sessionId);if(!list)projects.set(data.sessionId,list=new Set());if(typeof data.workspace==='string')list.add(data.workspace);}}
  for(const file of await treeFiles(root,{hash:false,exclude:path=>path==='owner.json'||path.endsWith('.lock')})) {
    const category=file.path.startsWith('objects/')?'objects':file.path.startsWith('sessions/')?'sessions':file.path.startsWith('management-trash/')?'incomplete-cleanup':file.path.startsWith('host.sqlite')?'host-facts':'other-retained';
    totals[category]??={files:0,bytes:0};totals[category].files++;totals[category].bytes+=file.bytes;
    if(category==='objects'&&!bodies.has(file.path.slice(8)))units.push({id:`object:${file.path.slice(8)}`,bytes:file.bytes});
  }
  const sessions=await readdir(join(root,'sessions')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
  for(const session of sessions){const path=join(root,'sessions',session);if(!(await lstat(path)).isDirectory())continue;const files=await treeFiles(path,{hash:false});units.unshift({id:`session:${session}`,bytes:files.reduce((n,f)=>n+f.bytes,0),projects:[...projects.get(session)??[]]});}
  return {root,totals,units:units.slice(after,after+limit),next:after+limit<units.length?after+limit:null,totalUnits:units.length,consistency:'read-only live usage; preview obtains ownership and inspects complete sessions',retention:'No automatic expiry or capacity eviction. Context compaction never deletes history.',limits:'Host facts and their body objects are retained. Cleanup supports whole completed sessions and explicitly referenced independent attachments. Whole-root archive includes every project in this data root; attachment archive requires explicit object IDs.'};
}
