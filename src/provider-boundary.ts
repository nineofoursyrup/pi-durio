import {randomUUID} from 'node:crypto';
import {Evidence,readObject} from './evidence.js';

export type RequestPurpose='generation'|'compaction'|'grading'|'eval-runtime';
export interface BudgetLimits {
 maxRequests:number; maxTokens:number; maxRequestTokens:number; deadline:string;
 /** A trusted, fixed upper bound with provenance. Null means any unreported usage blocks continuation. */
 unknownUpperBound:{tokens:number;source:string}|null;
}
interface Reservation {id:string;purpose:RequestPurpose;operationId:string;tokens:number;at:string}
interface Settlement {id:string;tokens:number|null;status:'returned'|'error'|'cancelled'|'unknown';reason?:string}
/** Admission facts live in the existing Evidence store, not a second usage ledger.
 * The caller holds the existing root owner for this object's entire lifetime. */
export class PersistentBudget {
 readonly limits:BudgetLimits;
 constructor(readonly evidence:Evidence,readonly id:string,limits:BudgetLimits) {
  if(!id||![limits.maxRequests,limits.maxTokens,limits.maxRequestTokens].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isFinite(Date.parse(limits.deadline))||limits.maxRequestTokens>limits.maxTokens||limits.unknownUpperBound&&(!Number.isSafeInteger(limits.unknownUpperBound.tokens)||limits.unknownUpperBound.tokens<limits.maxRequestTokens||!limits.unknownUpperBound.source))throw Error('INVALID_BUDGET');
  this.limits=structuredClone(limits);
  const previous=this.facts('budget.plan')[0];
  if(previous){if(JSON.stringify(previous.limits)!==JSON.stringify(limits))throw Error('BUDGET_PLAN_CHANGED');}
  else evidence.append('budget.plan',{id,limits});
 }
 private facts(kind:string):any[]{return this.evidence.db.prepare('SELECT body FROM records WHERE run_id=? AND kind=? ORDER BY seq').all(this.evidence.runId,kind).map(row=>JSON.parse(readObject(this.evidence.root,JSON.parse(String(row.body))).toString())).filter(f=>f.budgetId===this.id||f.id===this.id);}
 snapshot(){
  const reservations=this.facts('budget.reserve') as (Reservation&{budgetId:string})[],settlements=this.facts('budget.settle') as (Settlement&{budgetId:string})[];
  let knownTokens=0,reservedTokens=0,unknown=0,violation=false;
  for(const request of reservations){const settlement=settlements.find(s=>s.id===request.id);if(settlement?.tokens!==null&&settlement?.tokens!==undefined){knownTokens+=settlement.tokens;if(settlement.tokens>request.tokens)violation=true;}else{unknown++;reservedTokens+=this.limits.unknownUpperBound?.tokens??request.tokens;}}
  return {requests:reservations.length,knownTokens,reservedTokens,unknown,violation,completeness:unknown?'unknown':'known',deadline:this.limits.deadline};
 }
 check(){const state=this.snapshot();if(Date.now()>=Date.parse(this.limits.deadline))throw Error('BUDGET_DEADLINE');if(state.violation)throw Error('BUDGET_PROVIDER_BOUND_EXCEEDED');if(state.unknown&&!this.limits.unknownUpperBound)throw Error('BUDGET_UNKNOWN_USAGE');if(state.requests>=this.limits.maxRequests)throw Error('BUDGET_REQUEST_LIMIT');if(state.knownTokens+state.reservedTokens+(this.limits.unknownUpperBound?.tokens??this.limits.maxRequestTokens)>this.limits.maxTokens)throw Error('BUDGET_TOKEN_LIMIT');return state;}
 reserve(purpose:RequestPurpose,operationId:string){
  this.evidence.db.exec('BEGIN IMMEDIATE');
  try{this.check();const request:Reservation={id:randomUUID(),purpose,operationId,tokens:this.limits.unknownUpperBound?.tokens??this.limits.maxRequestTokens,at:new Date().toISOString()};this.evidence.append('budget.reserve',{budgetId:this.id,...request});this.evidence.db.exec('COMMIT');return request;}
  catch(error){this.evidence.db.exec('ROLLBACK');throw error;}
 }
 settle(value:Settlement){if(value.tokens!==null&&(!Number.isSafeInteger(value.tokens)||value.tokens<0))throw Error('INVALID_PROVIDER_USAGE');if(this.facts('budget.settle').some(f=>f.id===value.id))throw Error('BUDGET_ALREADY_SETTLED');this.evidence.append('budget.settle',{budgetId:this.id,...value});}
}
export interface ProviderBoundary {budget?:PersistentBudget;purpose:RequestPurpose;operationId:string;transport?:typeof fetch;onDispatch?:(id:string)=>void;maxResponseBytes?:number}
/** The one actual-dispatch gate: SDK retries and compaction fetches use the same call. */
export async function dispatchProvider(boundary:ProviderBoundary|undefined,url:Parameters<typeof fetch>[0],init?:RequestInit):Promise<Response>{
 if(!boundary)return fetch(url,init);
 if(init?.signal?.aborted)throw Error('PROVIDER_CANCELLED_BEFORE_DISPATCH');
 const reservation=boundary.budget?.reserve(boundary.purpose,boundary.operationId),id=reservation?.id??randomUUID();
 const evidence=boundary.budget?.evidence;
 let settled=false;
 const settle=(tokens:number|null,status:Settlement['status'],reason?:string)=>{if(settled)return;settled=true;boundary.budget?.settle({id,tokens,status,...reason?{reason}:{}});};
 try{
  evidence?.append('provider.dispatch',{id,purpose:boundary.purpose,operationId:boundary.operationId,url:String(url),method:init?.method,body:typeof init?.body==='string'?evidence.blob(init.body):null});
  boundary.onDispatch?.(id);
  const response=await (boundary.transport??fetch)(url,init);
  evidence?.append('provider.http',{id,status:response.status});
  const reader=response.body?.getReader();if(!reader){settle(null,'unknown','empty response');return response;}
  const decoder=new TextDecoder();let pending='',total=0,tokens:number|null=null;
  const parse=(line:string)=>{if(!line.startsWith('data:'))return;try{const event=JSON.parse(line.slice(5));const usage=event.usage;if(Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens)&&usage.prompt_tokens>=0&&usage.completion_tokens>=0)tokens=usage.prompt_tokens+usage.completion_tokens;}catch{/* acquired raw bytes remain authoritative */}};
  const body=new ReadableStream<Uint8Array>({
   async pull(controller){try{const next=await reader.read();if(next.done){pending+=decoder.decode();for(const line of pending.split('\n'))parse(line);settle(tokens,response.ok?'returned':'error');controller.close();return;}
    total+=next.value.length;if(total>(boundary.maxResponseBytes??1_048_576))throw Error('PROVIDER_RESPONSE_LIMIT');
    evidence?.append('provider.bytes',{id,bytes:evidence.blob(next.value)});pending+=decoder.decode(next.value,{stream:true});let index;while((index=pending.indexOf('\n'))>=0){parse(pending.slice(0,index));pending=pending.slice(index+1);}if(pending.length>262144)throw Error('PROVIDER_FRAME_LIMIT');controller.enqueue(next.value);
   }catch(error){try{settle(null,init?.signal?.aborted?'cancelled':'error',String(error));}finally{await reader.cancel().catch(()=>{});controller.error(error);}}},
   async cancel(reason){try{settle(null,'cancelled',String(reason));}finally{await reader.cancel(reason);}}
  });return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch(error){settle(null,init?.signal?.aborted?'cancelled':'error',String(error));throw error;}
}
