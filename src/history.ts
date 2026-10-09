import { openHostReadonly, readObject, digest, readAcceptedTasks, type AcceptedTaskFact, type BlobRef } from './evidence.js';
import { readObjectRange, readTextPage } from './query.js';

export type Availability = 'complete'|'source-not-returned'|'collection-gap'|'archived'|'cleaned'|'corrupt'|'temporarily-unreadable';
export interface EvidenceReference { id:string; runId:string; seq:number; kind:string; at:string; ref:BlobRef }
export interface HistoryFilter { project?:string; session?:string; from?:string; to?:string; kind?:string; taskType?:string; status?:string; reason?:string; version?:string; provider?:string; model?:string; completeness?:string }
export interface HistoryCursor { snapshot:number; after:number; filter:string }
export const reference = (row:any):EvidenceReference => { const ref=JSON.parse(String(row.body)); return {id:`e1:${row.seq}:${ref.sha256}`,runId:String(row.run_id),seq:Number(row.seq),kind:String(row.kind),at:String(row.at),ref}; };
export function boundedInteger(n:number,min=0,max=Number.MAX_SAFE_INTEGER) { if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('INVALID_QUERY_RANGE');return n; }
export function watermark(root:string) { const db=openHostReadonly(root);try{return Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM records').get()!.n);}finally{db.close();} }
export function* records(root:string,options:{runId?:string;through?:number;after?:number;kinds?:readonly string[]}={}) {
  let after=boundedInteger(options.after??0);const through=boundedInteger(options.through??watermark(root));
  for(;;) {
    const db=openHostReadonly(root);let rows;
    try{rows=db.prepare(`SELECT * FROM records WHERE seq>? AND seq<=? ${options.runId?'AND run_id=?':''} ${options.kinds?.length?`AND kind IN (${options.kinds.map(()=>'?').join(',')})`:''} ORDER BY seq LIMIT 32`).all(after,through,...options.runId?[options.runId]:[],...options.kinds??[]);}
    finally{db.close();}
    if(!rows.length)return;
    for(const row of rows){after=Number(row.seq);yield reference(row);}
  }
}
export function decode(root:string,ref:EvidenceReference):any { if(ref.ref.bytes>2*1024*1024)throw Error('EVIDENCE_RECORD_LIMIT');return JSON.parse(readObject(root,ref.ref).toString()); }
export function resolveEvidence(root:string,id:string):EvidenceReference {
  const match=/^e1:([1-9][0-9]*):([a-f0-9]{64})$/.exec(id);if(!match)throw Error('INVALID_EVIDENCE_ID');
  const db=openHostReadonly(root);try{const row=db.prepare('SELECT * FROM records WHERE seq=?').get(boundedInteger(Number(match[1]),1));if(!row)throw Error('EVIDENCE_NOT_FOUND');const ref=reference(row);if(ref.id!==id)throw Error('EVIDENCE_ID_CHANGED');return ref;}finally{db.close();}
}
function errorState(error:unknown):Availability { return String(error).includes('CORRUPT')?'corrupt':(error as NodeJS.ErrnoException).code==='ENOENT'?'collection-gap':'temporarily-unreadable'; }
export function readEvidence(root:string,id:string,options:{offset?:number;limit?:number;decodedOutput?:boolean}={}) {
  const source=resolveEvidence(root,id);
  let declared:Availability|undefined;
  for(const ref of records(root,{kinds:['evidence.availability']})) {const data=decode(root,ref);if(data.sourceId===id||data.sha256===source.ref.sha256)declared=data.state;}
  if(declared==='cleaned'||declared==='archived')return {source,state:declared,display:'unavailable',error:declared==='cleaned'?'Explicitly cleaned; original judgment remains historical':'Archived; restoration required for this original'};
  try {
    if(options.decodedOutput) {
      const data=decode(root,source);const acquired=data.acquired??data;
      if(acquired.encoding!=='base64'||typeof acquired.bytes!=='string')throw Error('NOT_ENCODED_OUTPUT');
      const bytes=Buffer.from(acquired.bytes,'base64'),offset=boundedInteger(options.offset??0),limit=boundedInteger(options.limit??4096,1,16384);
      return {source,state:'complete' as Availability,display:offset+limit<bytes.length||offset>0?'truncated':'complete',encoding:'base64',bytes:bytes.subarray(offset,offset+limit).toString('base64'),offset,total:bytes.length,next:offset+limit<bytes.length?offset+limit:null};
    }
    const page=readTextPage(root,source.ref,options.offset??0,options.limit??4096);
    return {source,state:'complete' as Availability,display:page.next!==null||page.offset>0?'truncated':'complete',...page};
  }catch(error){if(String(error).includes('INVALID')||String(error).includes('NOT_ENCODED'))throw error;return {source,state:errorState(error),display:'unavailable',error:String(error)};}
}

const summaryKinds=['task.accepted','execution.artifact','execution.config','run.closed','recovery.closed','recovery.ended','recovery.report','evidence.gap','model.intent','model.response','usage.projection','evidence.availability'];
export function summarizeRun(root:string,runId:string,through=watermark(root)) {
  let accepted:any,artifact:any,config:any,closed:any,recovery:any,first:EvidenceReference|undefined,last=0;
  let attempts=0,responses=0,missingOmitted=0;const missing:string[]=[];const gap=(id:string)=>{if(missing.length<50)missing.push(id);else missingOmitted++;};let availability:Availability='complete';
  for(const ref of records(root,{runId,through,kinds:summaryKinds})) {
    last=ref.seq;let data:any;try{data=decode(root,ref);}catch(error){availability=errorState(error);gap(ref.id);continue;}
    if(ref.kind==='task.accepted'){accepted=data;first??=ref;}
    if(ref.kind==='execution.artifact')artifact=data;
    if(ref.kind==='execution.config')config=data;
    if(ref.kind==='run.closed')closed=data;
    if(ref.kind==='recovery.closed'||ref.kind==='recovery.ended'||ref.kind==='recovery.report')recovery={source:ref.id,...data};
    if(ref.kind==='evidence.gap'){availability='collection-gap';gap(ref.id);}
    if(ref.kind==='evidence.availability'&&['archived','cleaned','corrupt','temporarily-unreadable'].includes(data.state))availability=data.state;
    if(ref.kind==='model.intent')attempts++;
    if(ref.kind==='model.response')responses++;
  }
  if(attempts>responses&&availability==='complete')availability='source-not-returned';
  return {runId,taskId:accepted?.taskId??null,sessionId:accepted?.sessionId??null,project:accepted?.projectId??accepted?.workspace??null,workspace:accepted?.workspace??null,kind:accepted?.kind??'coding',taskType:accepted?.taskType??null,at:first?.at??null,seq:first?.seq??0,source:first?.id??null,status:closed?.status??'unknown',reason:closed?.reason??(closed?null:'No confirmed close receipt'),version:artifact?.id??null,provider:config?.model?.provider??null,model:config?.model?.id??null,completeness:availability,usage:closed?.usage?.completeness??'unknown',attempts,responses,recovery:recovery??null,updatedThrough:last,missing,missingOmitted};
}
export type HistorySummary = Omit<ReturnType<typeof summarizeRun>,'runId'> & {runId:string|null; acceptedTask:AcceptedTaskFact};
function matches(row:HistorySummary,filter:HistoryFilter) {
  return Object.entries(filter).every(([key,value])=>{
    if(value===undefined)return true;
    if(key==='session')return row.sessionId===value;
    if(key==='from')return row.at!==null&&Date.parse(row.at)>=Date.parse(value);
    if(key==='to')return row.at!==null&&Date.parse(row.at)<Date.parse(value);
    return String((row as any)[key])===value;
  });
}
export function queryHistory(root:string,filter:HistoryFilter={},options:{limit?:number;cursor?:HistoryCursor}={}) {
  for(const key of Object.keys(filter))if(!['project','session','from','to','kind','taskType','status','reason','version','provider','model','completeness'].includes(key))throw Error('INVALID_QUERY_FILTER');
  if(Object.values(filter).some(value=>value!==undefined&&typeof value!=='string'))throw Error('INVALID_QUERY_FILTER');
  for(const key of ['from','to'] as const)if(filter[key]!==undefined&&!Number.isFinite(Date.parse(filter[key]!)))throw Error('INVALID_QUERY_TIME');
  if(filter.from&&filter.to&&Date.parse(filter.from)>Date.parse(filter.to))throw Error('INVALID_QUERY_TIME_RANGE');
  const limit=boundedInteger(options.limit??20,1,50);let current:number;
  try{current=watermark(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {filter,items:[] as HistorySummary[],next:null,coverage:{snapshot:0,current:0,stale:true,scanned:0,missing:1,index:'host evidence store unavailable',emptyMeans:'missing source; no absence conclusion'}};}
  const snapshot=options.cursor?.snapshot??current;
  boundedInteger(snapshot,0,current);const filterId=digest(JSON.stringify(Object.entries(filter).filter(([,v])=>v!==undefined).sort()));
  if(options.cursor&&options.cursor.filter!==filterId)throw Error('QUERY_CURSOR_SCOPE_CHANGED');
  let after=boundedInteger(options.cursor?.after??0);const items:HistorySummary[]=[];let scanned=0,missing=0,more=false;
  let exhausted=false;
  while(items.length<limit&&scanned<500&&!exhausted) {
    const page=readAcceptedTasks(root,{through:snapshot,after,limit:Math.min(32,limit-items.length)});
    for(const task of page.tasks) {
      after=task.acceptedSeq;scanned++;
      const db=openHostReadonly(root);let source:EvidenceReference;
      try{source=reference(db.prepare('SELECT * FROM records WHERE seq=?').get(task.acceptedSeq));}finally{db.close();}
      const initial=decode(root,source);
      const base=summarizeRun(root,task.runId??source.runId,snapshot);
      // A queued request retains its original target and its own acceptance. It never
      // inherits the target run's outcome, usage or run identity.
      const row:HistorySummary={...base,runId:task.runId,taskId:task.taskId,sessionId:task.execution?.sessionId??task.target?.sessionId??initial.sessionId??null,project:initial.projectId??task.workspace,workspace:task.workspace,kind:initial.taskKind??(task.kind==='follow-up'?'coding':initial.kind??'coding'),taskType:initial.taskType??null,at:task.acceptedAt,seq:task.acceptedSeq,source:source.id,status:task.status,reason:task.reason,version:task.executionVersion?.artifactId??null,acceptedTask:task};
      if(!task.runId&&task.kind==='follow-up'){row.attempts=0;row.responses=0;row.usage='unknown';row.recovery=null;row.completeness='complete';row.missing=[];row.missingOmitted=0;}
      if(row.missing.length)missing++;
      if(matches(row,filter))items.push(row);
    }
    exhausted=page.next===null;
    more=!exhausted;
  }
  return {filter,items,next:more?{snapshot,after,filter:filterId}:null,coverage:{snapshot,current,stale:snapshot<current,scanned,missing,index:'rebuilt from immutable host facts; durable-only or unsaved facts may be missing',emptyMeans:'no matching acquired facts in this scanned range'}};
}
export function queryEvidence(root:string,runId:string,options:{after?:number;snapshot?:number;limit?:number;kinds?:readonly string[]}={}) {
  const snapshot=options.snapshot??watermark(root),limit=boundedInteger(options.limit??20,1,50),items:EvidenceReference[]=[];let more=false;
  boundedInteger(snapshot,0,watermark(root));if(options.kinds&&(options.kinds.length>32||options.kinds.some(kind=>typeof kind!=='string')))throw Error('INVALID_QUERY_KINDS');
  for(const ref of records(root,{runId,through:snapshot,after:options.after,kinds:options.kinds})){if(items.length===limit){more=true;break;}items.push(ref);}
  return {runId,snapshot,items,next:more?items.at(-1)!.seq:null,current:watermark(root)};
}

/** Attempt projections use acquired source rows, never create another trace or usage ledger. */
export function queryAttempts(root:string,runId:string,options:{after?:number;snapshot?:number;limit?:number}={}) {
  const page=queryEvidence(root,runId,{...options,kinds:['model.intent','tool.intent']});
  const items=page.items.map(source=>{
    const intent=decode(root,source);const related:EvidenceReference[]=[],requests:EvidenceReference[]=[],gaps:string[]=[];let terminal:EvidenceReference|undefined,terminalData:any,dispatches=0,omitted=0;
    for(const ref of records(root,{runId,through:page.snapshot,after:source.seq})){
      let data:any;try{data=decode(root,ref);}catch{if(gaps.length<32)gaps.push(ref.id);continue;}if(data.attemptId!==intent.attemptId&&data.toolAttempt?.attemptId!==intent.attemptId)continue;
      if(related.length<32)related.push(ref);else omitted++;
      if(ref.kind==='model.dispatch'||ref.kind==='tool.dispatch'){dispatches++;if(requests.length<50)requests.push(ref);}
      if(['model.response','tool.result','tool.error'].includes(ref.kind)){terminal=ref;terminalData=data;}
    }
    return {id:intent.attemptId,source,kind:source.kind==='model.intent'?'model':'tool',purpose:intent.purpose??null,durableTaskId:intent.durableTaskId??null,model:intent.model??null,tool:intent.tool??null,startedAt:source.at,endedAt:terminal?.at??null,terminal:terminal??null,status:terminal?terminalData.message?.stopReason==='aborted'?'cancelled':terminal.kind==='tool.error'||terminalData.message?.errorMessage||terminalData.result?.isError?'failed':'returned':'unknown',observableRequests:dispatches,requests,requestIdentity:'dispatch record ID; SDK-internal requests not exposed here remain unknown',usage:terminalData?.usage??'unknown',related,omitted,gaps,nextRelated:omitted?related.at(-1)?.seq:null};
  });return {...page,items};
}
