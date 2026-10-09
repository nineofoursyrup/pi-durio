import {Evidence,digest,readAcceptedTasks} from '../evidence.js';
import {factClock} from '../fact-clock.js';
import {decode,records,resolveEvidence,watermark,type EvidenceReference} from '../history.js';
export interface FeedbackSource {kind:'human'|'action'|'unverified';actor:string;statement:string;refs:string[]}
export interface FeedbackBase {id:string;taskId:string;source:FeedbackSource;reason?:string}
export type FeedbackInput=FeedbackBase&({type:'observation';dimension:'intervention'|'rework';meaning:'correction'|'none'|'normal-authorization'|'clarification'|'new-requirement'|'improve-choice'|'complaint'|'unknown';occurredAt:string|null;requirements:string[];originalRequirement?:'unmet'|'unknown';correction?:'requested'|'started'|'completed'|'unknown';coverage?:{from:string;to:string};delivery?:string;repairTaskId?:string;repairSources?:string[];resultSources?:string[];revisionOf?:string}|{type:'withdraw';targets:string[];reason:string});
export interface FeedbackFact {ref:EvidenceReference;data:FeedbackInput&{requestIdentity:string;receivedAt:string;ruleVersion:string;basisThrough:number}}
export const feedbackKinds=['feedback.observation','feedback.withdraw'];
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const text=(x:unknown,max=32768):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max;
function ensure(x:unknown,message:string):asserts x {if(!x)throw Error(`INVALID_FEEDBACK: ${message}`);}
function task(root:string,id:string){let after:number|undefined;do{const p=readAcceptedTasks(root,{after,limit:200});const found=p.tasks.find(t=>t.taskId===id);if(found)return found;after=p.next??undefined;}while(after);throw Error('FEEDBACK_TASK_NOT_FOUND');}
export function feedbackHistory(root:string,runId:string,taskId:string,through:number){const facts:FeedbackFact[]=[],missing:{source:string;reason:string}[]=[];for(const ref of records(root,{runId,through,kinds:feedbackKinds})){try{const data=decode(root,ref);if(data.taskId===taskId)facts.push({ref,data});}catch(error){missing.push({source:ref.id,reason:String(error)});}}return{facts,missing};}
/** Optional explicit host/user input. Existing conversation/action refs and literal
 * statements are retained; no language classifier or model tool is registered. */
export function recordFeedback(root:string,input:FeedbackInput){
 ensure(input&&text(input.id,128)&&text(input.taskId,128),'identity required');ensure(['observation','withdraw'].includes(input.type),'operation required');
 ensure(input.source&&['human','action','unverified'].includes(input.source.kind)&&text(input.source.actor,256)&&text(input.source.statement)&&Array.isArray(input.source.refs),'original statement/action required');
 const admitted=task(root,input.taskId),admission=[...records(root,{after:admitted.acceptedSeq-1,through:admitted.acceptedSeq})][0],e=new Evidence(root,admission.runId);
 e.db.exec('BEGIN IMMEDIATE');try{
  const through=watermark(root),history=feedbackHistory(root,admission.runId,input.taskId,through);ensure(!history.missing.length,'original feedback unavailable; cannot append a revision');
  const identity=digest(JSON.stringify(input)),repeated=history.facts.find(f=>f.data.id===input.id);if(repeated){ensure(repeated.data.requestIdentity===identity,'ID conflicts with retained input');e.db.exec('COMMIT');return{source:repeated.ref.id,repeated:true};}
  if(input.type==='observation'&&!input.revisionOf&&input.source.refs.length){const {id:_id,...semantic}=input;const same=history.facts.find(f=>{const {id:_priorId,submitted:_submitted,requestIdentity:_request,receivedAt:_received,ruleVersion:_rule,basisThrough:_through,...prior}=f.data as FeedbackFact['data']&{submitted?:unknown};return f.data.type==='observation'&&digest(JSON.stringify(canonical(prior)))===digest(JSON.stringify(canonical(semantic)));});if(same){e.db.exec('COMMIT');return{source:same.ref.id,repeated:true};}}
  const ids=[...input.source.refs],byId=new Map(history.facts.map(f=>[f.data.id,f]));
  const get=(id:string)=>{const previous=byId.get(id);ensure(previous?.data.type==='observation','observation target missing');return previous;};
  if(input.type==='withdraw'){ensure(Array.isArray(input.targets)&&input.targets.length>0&&text(input.reason),'withdrawal targets and reason required');input.targets.forEach(get);}
  else{
   ensure(['intervention','rework'].includes(input.dimension)&&['correction','none','normal-authorization','clarification','new-requirement','improve-choice','complaint','unknown'].includes(input.meaning),'explicit dimension and meaning required');
   ensure(input.occurredAt===null||text(input.occurredAt)&&Number.isFinite(Date.parse(input.occurredAt)),'occurrence must be a reliable declared time or null');
   ensure(Array.isArray(input.requirements)&&input.requirements.every(id=>text(id)),'original requirements references required');ids.push(...input.requirements,...input.repairSources??[],...input.resultSources??[]);
   for(const id of input.requirements){const ref=resolveEvidence(root,id),data=decode(root,ref);ensure(['task.accepted','control.accepted','acceptance.requirements'].includes(ref.kind)&&data.taskId===input.taskId,'original requirements must belong to this task');}
   if(input.delivery)ids.push(input.delivery);
   if(input.revisionOf){const prior=get(input.revisionOf);ensure(prior.data.type==='observation'&&prior.data.dimension===input.dimension&&text(input.reason),'revision must retain its dimension and give reason');}
   if(input.originalRequirement!==undefined)ensure(['unmet','unknown'].includes(input.originalRequirement),'invalid requirement confirmation');
   if(input.correction!==undefined)ensure(['requested','started','completed','unknown'].includes(input.correction),'invalid correction state');
   if(input.coverage)ensure(text(input.coverage.from)&&text(input.coverage.to)&&Number.isFinite(Date.parse(input.coverage.from))&&Number.isFinite(Date.parse(input.coverage.to))&&Date.parse(input.coverage.from)<=Date.parse(input.coverage.to),'invalid declared coverage');
   if(input.repairTaskId)task(root,input.repairTaskId);
   if(input.source.kind==='action')ensure(input.source.refs.length>0,'verifiable action requires original evidence');
  }
  for(const id of ids)decode(root,resolveEvidence(root,id));
  const clock=factClock();
  if(input.type==='observation'){ensure(input.occurredAt===null||Date.parse(input.occurredAt)<=Date.parse(clock.wallTime),'future occurrence is not evidence');ensure(!input.coverage||Date.parse(input.coverage.to)<=Date.parse(clock.wallTime),'future coverage is not evidence');}
  const seq=e.append(`feedback.${input.type}`,{...input,submitted:input,requestIdentity:identity,receivedAt:clock.wallTime,ruleVersion:'explicit-feedback-v1',basisThrough:through});e.db.exec('COMMIT');return{source:[...records(root,{after:seq-1,through:seq})][0].id,repeated:false};
 }catch(error){e.db.exec('ROLLBACK');throw error;}finally{e.close();}
}
