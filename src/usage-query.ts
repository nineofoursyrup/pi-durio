import { records, decode, watermark, boundedInteger } from './history.js';

/** A latest committed pi.usage document replaces its earlier cumulative projections.
 * Values are never differenced into runs or combined with model.response usage. */
export function queryUsage(root:string,runIds:readonly string[],through=watermark(root)) {
  if(!runIds.length||runIds.length>50)throw Error('USAGE_SCOPE_REQUIRED');
  boundedInteger(through);const selected=new Set(runIds),sessions=new Map<string,Set<string>>(),runSession=new Map<string,string>();
  for(const ref of records(root,{through,kinds:['task.accepted']})) {const data=decode(root,ref);if(typeof data.sessionId!=='string')continue;if(selected.has(ref.runId)&&!sessions.has(data.sessionId))sessions.set(data.sessionId,new Set());}
  // Keep selected session ownership; do not retain unbounded unrelated run identities.
  runSession.clear();
  for(const ref of records(root,{through,kinds:['task.accepted']})) {const data=decode(root,ref);if(sessions.has(data.sessionId)){if(runSession.size>=10000&&!runSession.has(ref.runId))throw Error('USAGE_SCOPE_LIMIT');sessions.get(data.sessionId)!.add(ref.runId);runSession.set(ref.runId,data.sessionId);}}
  const docs=new Map<string,{source:string;sessionId:string;conversationId:number;documentId:number|null;value:any;completeness:string;seq:number}>();
  let documentBytes=0;const sizes=new Map<string,number>();
  const setDoc=(key:string,doc:NonNullable<ReturnType<typeof docs.get>>)=>{const bytes=Buffer.byteLength(JSON.stringify(doc.value));documentBytes+=bytes-(sizes.get(key)??0);if(documentBytes>4*1024*1024||docs.size>=500&&!docs.has(key))throw Error('USAGE_SCOPE_LIMIT');sizes.set(key,bytes);docs.set(key,doc);};
  const gaps:string[]=[];let gapsOmitted=0;const gap=(id:string)=>{if(gaps.length<50)gaps.push(id);else gapsOmitted++;};
  for(const ref of records(root,{through,kinds:['durable.closed-snapshot','usage.projection','run.closed','recovery.closed']})) {
    const sessionId=runSession.get(ref.runId);if(!sessionId)continue;
    let data:any;try{data=decode(root,ref);}catch{gap(ref.id);continue;}
    if(ref.kind==='durable.closed-snapshot')for(const usage of data.usage??[]) {
      const key=`${sessionId}:${usage.conversationId}`;
      if(docs.size>=500&&!docs.has(key))throw Error('USAGE_SCOPE_LIMIT');
      const previous=docs.get(key);setDoc(key,{source:ref.id,sessionId,conversationId:usage.conversationId,documentId:usage.documentId,value:usage.value,completeness:previous?.completeness??'unknown',seq:ref.seq});
    }
    if(ref.kind==='usage.projection') {
      const key=`${sessionId}:${data.conversationId}`;const previous=docs.get(key);
      setDoc(key,{source:ref.id,sessionId,conversationId:data.conversationId,documentId:previous?.documentId??null,value:data.value,completeness:data.completeness??'unknown',seq:ref.seq});
    }
    if(ref.kind==='run.closed'||ref.kind==='recovery.closed') {
      const usage=(data.result??data).usage;
      // A scope-level unknown cannot be repaired by normalized SDK zero placeholders.
      for(const doc of docs.values())if(doc.sessionId===sessionId)doc.completeness=usage?.completeness??'unknown';
    }
  }
  const categories=new Map<string,{reports:number;cacheRead:number;cacheWrite:number;dispatches:number;unverifiedDispatchIntents:number;reportedResponses:number;sources:string[];omitted:number}>();
  const committedThrough=new Map<string,number>();for(const doc of docs.values())committedThrough.set(doc.sessionId,Math.max(committedThrough.get(doc.sessionId)??0,doc.seq));
  for(const ref of records(root,{through,kinds:['model.dispatch','model.response','model.provider-event']})) {
    const sessionId=runSession.get(ref.runId);if(!sessionId||ref.seq>(committedThrough.get(sessionId)??0))continue;
    const visible=categories.get(sessionId)??{reports:0,cacheRead:0,cacheWrite:0,dispatches:0,unverifiedDispatchIntents:0,reportedResponses:0,sources:[],omitted:0};
    categories.set(sessionId,visible);
    let data:any;try{data=decode(root,ref);}catch{gap(ref.id);continue;}
    if(ref.kind==='model.dispatch'){if(data.transportEntered===true)visible.dispatches++;else visible.unverifiedDispatchIntents++;continue;}
    if(ref.kind==='model.response'){if(data.usage==='reported')visible.reportedResponses++;continue;}
    const raw=data.event?.usage;if(!raw||typeof raw!=='object')continue;visible.reports++;
    if(visible.sources.length<50)visible.sources.push(ref.id);else visible.omitted++;
    if(typeof raw.prompt_cache_hit_tokens==='number'||typeof raw.prompt_tokens_details?.cached_tokens==='number'||typeof raw.cache_read_input_tokens==='number')visible.cacheRead++;
    if(typeof raw.cache_creation_input_tokens==='number'||typeof raw.cache_write_tokens==='number')visible.cacheWrite++;
  }
  const maintenanceSessions=new Set<string>(),attempts=new Map<string,{source:string;at:string;runId:string;sessionId:string;purpose:string;allocation:string;maintenanceRequestId:string|null;response?:string;reportedUsage?:unknown;estimatedCost?:unknown;completeness:string;dispatchState:'unknown'|'dispatched'|'not-dispatched';dispatchSource?:string;dispatchFailure?:{source:string;reason:string};}>();
  let attemptsOmitted=0;
  for(const ref of records(root,{through,kinds:['model.intent','model.response','model.dispatch','model.dispatch-failed']})){
    const sessionId=runSession.get(ref.runId);if(!sessionId)continue;
    let data:any;try{data=decode(root,ref);}catch{gap(ref.id);continue;}
    if(ref.kind==='model.intent'){
      if(data.allocation==='maintenance')maintenanceSessions.add(sessionId);
      if(attempts.size>=200){attemptsOmitted++;continue;}
      attempts.set(data.attemptId,{source:ref.id,at:ref.at,runId:ref.runId,sessionId,purpose:data.purpose??'unknown',allocation:data.allocation??'unknown',maintenanceRequestId:data.maintenanceRequestId??null,completeness:'unknown',dispatchState:'unknown'});
    }else {
      const item=attempts.get(data.attemptId);if(!item)continue;
      if(ref.kind==='model.dispatch'){if(data.transportEntered===true){item.dispatchState='dispatched';item.dispatchSource=ref.id;if(item.completeness==='not-applicable')item.completeness='unknown';}continue;}
      if(ref.kind==='model.dispatch-failed'){item.dispatchFailure={source:ref.id,reason:data.reason};if(data.dispatched===false&&data.attemptDispatched===false&&item.dispatchState!=='dispatched'){item.dispatchState='not-dispatched';item.dispatchSource=ref.id;item.completeness='not-applicable';}continue;}
      item.response=ref.id;if(item.dispatchState==='not-dispatched')continue;item.completeness=data.usage==='reported'?'reported':'unknown';
      if(data.usage==='reported'){item.reportedUsage=data.message?.usage;item.estimatedCost={value:data.message?.usage?.cost??null,kind:'estimate',currency:'USD',source:'@earendil-works/pi-ai@1.1.0 model price catalog applied to this acquired response',observedAt:ref.at};}
    }
  }
  const items=[...docs.values()].map(doc=>{
    const raw=categories.get(doc.sessionId);
    const singleConversation=[...docs.values()].filter(other=>other.sessionId===doc.sessionId).length===1;
    return {...doc,scope:`session:${doc.sessionId}/conversation:${doc.conversationId}`,runId:!maintenanceSessions.has(doc.sessionId)&&sessions.get(doc.sessionId)?.size===1?[...sessions.get(doc.sessionId)!][0]:null,attribution:maintenanceSessions.has(doc.sessionId)?'session contains independent maintenance; cumulative usage is not the original task cost':sessions.get(doc.sessionId)?.size===1?'single recorded run in session':'unattributed cumulative session usage',value:doc.completeness==='unknown'?null:doc.value,requestCoverage:raw?{scope:`session:${doc.sessionId}`,dispatches:raw.dispatches,unverifiedDispatchIntents:raw.unverifiedDispatchIntents,reportedResponses:raw.reportedResponses,boundary:'configured host transport entry; eval provider counts require trusted outer mediation evidence'}:null,categorySources:raw?.sources??[],categorySourcesOmitted:raw?.omitted??0,categoryCoverage:{cacheRead:singleConversation&&!!raw?.reports&&raw.cacheRead===raw.reports?'reported':'not fully reported',cacheWrite:singleConversation&&!!raw?.reports&&raw.cacheWrite===raw.reports?'reported':'not fully reported',reasoning:'optional output subset; never added to total'}};
  });
  const totals:{input:number|null;output:number|null;cacheRead:number|null;cacheWrite:number|null;tokens:number|null;estimatedUSD:number|null}={input:null,output:null,cacheRead:null,cacheWrite:null,tokens:null,estimatedUSD:null};
  const add=(key:keyof typeof totals,value:unknown)=>{if(typeof value==='number'&&Number.isFinite(value)&&value>=0)totals[key]=(totals[key]??0)+value;};
  for(const item of items)if(item.value){
    for(const model of Object.values(item.value.models??{}) as any[]){for(const key of ['input','output','cacheRead','cacheWrite'] as const){if((key==='cacheRead'||key==='cacheWrite')&&model[key]===0&&item.categoryCoverage[key]!=='reported')continue;add(key,model[key]);}add('tokens',model.totalTokens);add('estimatedUSD',model.cost?.total);}
    for(const tool of Object.values(item.value.tools??{}) as any[])add('estimatedUSD',tool.cost?.total);
  }
  const missingRuns=runIds.filter(id=>!runSession.has(id));
  return {runIds:[...runIds],through,items,totals,requestAllocations:[...attempts].map(([attemptId,value])=>({attemptId,...value,scope:value.allocation==='maintenance'?`maintenance:${value.maintenanceRequestId}`:value.allocation==='task'?`run:${value.runId}`:value.allocation==='improve'?`improve:${value.runId}`:'unknown'})),attemptsOmitted,allocationRule:'Acquired responses show proven request purpose and source, separately from latest committed cumulative pi.usage. Never add both or difference cumulative documents into task/maintenance costs. Host-proven non-dispatch is not-applicable; entered transport failures remain unknown. Runtime transport entry does not prove eval provider dispatch.',completeness:items.length>0&&!missingRuns.length&&items.every(i=>i.completeness==='known'&&(!i.requestCoverage||i.requestCoverage.unverifiedDispatchIntents===0&&i.requestCoverage.dispatches<=i.requestCoverage.reportedResponses)&&i.categoryCoverage.cacheRead==='reported'&&i.categoryCoverage.cacheWrite==='reported')&&!gaps.length?'known':items.some(i=>i.value)?'partial':'unknown',missingRuns,gaps,gapsOmitted,price:{kind:'estimate',currency:'USD',source:'original pi.usage / Pi model catalog; not billing; normalized missing categories limit coverage'},rules:'Latest acquired committed document once per session/conversation; reasoning is an output subset and is not added. Unattributed session values are not run totals. Unknown values remain null. Positive counters retain known partial usage; unsupported normalized zeros are not promoted to reported zero. Multiple conversations without precise category-event attribution retain unknown breakdown.'};
}
