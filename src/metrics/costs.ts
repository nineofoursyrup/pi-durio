import {Evidence,digest,readObject} from '../evidence.js';
import {decode,records,resolveEvidence,watermark} from '../history.js';
import {queryUsage} from '../usage-query.js';
import type {TaskMetricsReport} from './report.js';
import type {OperationRun} from './operations.js';
export interface CostEstimateInput {id:string;requestSource:string;amount:number;currency:string;price:{source:string;version:string;effectiveAt:string;provider:string;model:string};usageSources:string[];reason:string;revisionOf?:string}
/** An explicit sourced estimate/re-estimate is an original host fact, not a new ledger.
 * Caller supplies the declared tariff/calculation; this does not claim provider billing. */
export function recordCostEstimate(root:string,input:CostEstimateInput){
 if(!input||!input.id||input.id.length>256||!input.reason||input.reason.length>4096||!Number.isFinite(input.amount)||input.amount<0||!/^\w{3,12}$/.test(input.currency)||!input.price?.source||!input.price.version||!Number.isFinite(Date.parse(input.price.effectiveAt))||!input.price.provider||!input.price.model||!Array.isArray(input.usageSources)||!input.usageSources.length||input.usageSources.length>500)throw Error('INVALID_COST_ESTIMATE');
 const request=resolveEvidence(root,input.requestSource),data=decode(root,request);
 if(Date.parse(input.price.effectiveAt)>Date.parse(request.at))throw Error('PRICE_NOT_EFFECTIVE_AT_REQUEST');
 const model=request.kind==='provider.dispatch'?[...records(root,{runId:request.runId,through:request.seq,kinds:['eval.plan']})].map(ref=>decode(root,ref)).at(-1)?.model:data.model;
 if(model&&(model.provider!==input.price.provider||model.id!==input.price.model))throw Error('PRICE_MODEL_SCOPE_CHANGED');
 if(!['model.intent','provider.dispatch','tool.intent'].includes(request.kind))throw Error('COST_REQUEST_REQUIRED');
 for(const id of input.usageSources){const ref=resolveEvidence(root,id),value=decode(root,ref);if(ref.runId!==request.runId||request.kind==='model.intent'&&(ref.kind!=='model.response'||value.attemptId!==data.attemptId||value.usage!=='reported')||request.kind==='provider.dispatch'&&(!['provider.bytes','budget.settle'].includes(ref.kind)||value.id!==data.id)||request.kind==='tool.intent'&&(ref.kind!=='tool.result'||value.attemptId!==data.attemptId))throw Error('COST_USAGE_LINK_REQUIRED');}
 const e=new Evidence(root,request.runId);try{e.db.exec('BEGIN IMMEDIATE');const previous=[...records(root,{runId:request.runId,kinds:['cost.estimate']})].map(ref=>({ref,data:decode(root,ref)}));const same=previous.find(p=>p.data.id===input.id);if(same){if(JSON.stringify(same.data.input)!==JSON.stringify(input))throw Error('COST_ESTIMATE_ID_CONFLICT');e.db.exec('ROLLBACK');return{source:same.ref.id,repeated:true};}
 if(input.revisionOf&&!previous.some(p=>p.data.id===input.revisionOf&&p.data.requestSource===input.requestSource))throw Error('COST_ESTIMATE_REVISION_REQUIRED');
 const value={...input,input,kind:'estimate',method:'explicit-sourced-estimate-v1',receivedAt:new Date().toISOString()};const seq=e.append('cost.estimate',value);e.db.exec('COMMIT');return{source:`e1:${seq}:${digest(JSON.stringify(value))}`,repeated:false};}catch(error){try{e.db.exec('ROLLBACK');}catch{}throw error;}finally{e.close();}
}
export interface CostRequest {id:string;dataRoot:string;parentImprove:OperationRun['parentImprove']|null;runId:string;taskId:string|null;kind:string;stage:string|null;side:string|null;at:string;source:string;dispatchSources:string[];usageSources:string[];purpose:string;currency:string|null;amount:number|null;state:'complete'|'partial'|'unknown'|'not-applicable';gaps:string[];history:any[];price:any;association:string;usage:unknown}
const validAmount=(n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function costReport(parentRoot:string,sample:TaskMetricsReport,runs:OperationRun[],childGaps:{runId:string;source:string;reason:string;mayAffectSample:boolean}[]=[]){
 const sessionUsage=new Map<string,any>(),sessionEstimates:any[]=[];
 const requests:CostRequest[]=[],gaps:{runId:string;source:string|null;reason:string;mayAffectSample:boolean}[]=[...childGaps];
 const taskByRun=new Map(sample.tasks.map(t=>[t.evidenceRunId,t]));const through=sample.scope.through;
 for(const run of runs){
  const root=run.root,task=root===parentRoot?taskByRun.get(run.id):undefined,facts=run.facts;
  const runThrough=Math.max(0,...facts.map(f=>f.ref.seq));
  const issue=(reason:string,source:string|null=null)=>gaps.push({runId:run.id,source,reason,mayAffectSample:!!task||run.kind==='unknown'});
  for(const f of facts)if(f.missing||f.ref.kind==='evidence.gap')issue(f.missing??f.data.reason??'original collection gap',f.ref.id);
  // Reuse #19 allocation and usage provenance; never sum its cumulative session documents.
  let allocations:ReturnType<typeof queryUsage>['requestAllocations']=[];
  if(run.admission){try{const u=queryUsage(root,[run.id],runThrough);for(const item of u.items)sessionUsage.set(`${root}#${item.sessionId}/${item.conversationId}`,{dataRoot:root,...item,role:'separate cumulative evidence; never added to request totals'});allocations=u.requestAllocations.filter(a=>a.runId===run.id);if(u.attemptsOmitted)issue('request allocation limit reached');for(const id of u.gaps)issue('usage source unavailable',id);}catch(error){issue(`usage query unavailable: ${String(error)}`);}}
  for(const f of facts.filter(f=>f.ref.kind==='usage.estimate'))sessionEstimates.push({dataRoot:root,source:f.ref.id,...f.data,role:'retained scope estimate; not allocated or added to request totals'});
  const intents=facts.filter(f=>f.ref.kind==='model.intent');
  for(const intent of intents){const d=intent.data,allocation=allocations.find(a=>a.attemptId===d.attemptId),dispatches=facts.filter(f=>f.ref.kind==='model.dispatch'&&f.data.attemptId===d.attemptId&&f.data.transportEntered===true),responses=facts.filter(f=>f.ref.kind==='model.response'&&f.data.attemptId===d.attemptId),response=responses.at(-1),manual=d.allocation==='maintenance'||!!d.maintenanceRequestId&&facts.some(f=>f.ref.kind==='compaction.started'&&f.data.requestId===d.maintenanceRequestId),unassigned=!manual&&!['task','coding','improve','eval','shared'].includes(d.allocation);
   const shared=d.allocation==='shared'&&run.kind!=='shared',unowned=unassigned||shared;
   const kind=manual?'maintenance':shared?'shared':unassigned?'unknown':run.kind,request:CostRequest={id:`${root}#${intent.ref.id}`,dataRoot:root,parentImprove:run.parentImprove??null,runId:run.id,taskId:!manual&&!unowned&&task?task.taskId:null,kind,stage:kind==='eval'?'execution':null,side:null,at:dispatches[0]?.ref.at??intent.ref.at,source:intent.ref.id,dispatchSources:dispatches.map(f=>f.ref.id),usageSources:response?[response.ref.id]:[],purpose:d.purpose??'unknown',currency:null,amount:null,state:'unknown',gaps:[],history:[],price:null,association:manual?'independent manual maintenance':unowned?'unassigned/shared request purpose/allocation; may belong to coding sample':task?'accepted coding sample':run.kind==='unknown'?'unassigned; may belong to coding sample':`separate ${run.kind} work`,usage:allocation?.reportedUsage??(response?.data.usage==='reported'?response.data.message?.usage??null:null)};
   if(allocation?.dispatchState==='not-dispatched'&&!dispatches.length){request.state='not-applicable';request.gaps=[];requests.push(request);continue;}
   if(unowned||run.kind==='unknown')issue('unassigned/shared request may belong to the accepted sample',intent.ref.id);
   if(!dispatches.length)request.gaps.push('transport entry not proven');if(dispatches.length>1)request.gaps.push('multiple observable requests share one model response; per-request usage incomplete');
   if(responses.length>1&&new Set(responses.map(r=>JSON.stringify(r.data.message?.usage))).size>1)request.gaps.push('conflicting usage for one model request identity');
   if(!response||response.data.usage!=='reported')request.gaps.push('usage missing or request in flight');
   const original=response?.data.message?.usage?.cost?.total;
   if(validAmount(original)&&response?.data.usage==='reported'){request.currency='USD';request.amount=original;request.price={source:'@earendil-works/pi-ai@1.1.0 model price catalog',version:'1.1.0',effectiveAt:null,observedAt:response.ref.at,provider:d.model?.provider??null,model:d.model?.id??null,currency:'USD'};request.history.push({source:response.ref.id,amount:original,currency:'USD',price:request.price});request.gaps.push('original catalog effective time is unavailable');}
   applyEstimate(root,request,facts);
   requests.push(request);
  }
  // Trusted host mediation is authoritative for formal eval; guest claims never create fees.
  for(const dispatch of facts.filter(f=>f.ref.kind==='provider.dispatch')){
   const d=dispatch.data;
   // A same-run provider wrapper and model transport are two views of one request.
   const linked=intents.find(f=>f.data.providerOperationId===d.operationId&&facts.some(m=>m.ref.kind==='model.dispatch'&&m.data.attemptId===f.data.attemptId&&m.ref.seq>dispatch.ref.seq&&m.ref.seq<(facts.find(n=>n.ref.kind==='provider.dispatch'&&n.ref.seq>dispatch.ref.seq)?.ref.seq??Infinity)));
   if(linked)continue;
   const settlement=facts.find(f=>f.ref.kind==='budget.settle'&&f.data.id===d.id),usage=facts.filter(f=>f.ref.kind==='provider.bytes'&&f.data.id===d.id),plan=facts.find(f=>f.ref.kind==='eval.plan')?.data,trial=plan?.trials?.find((t:any)=>t.id===d.operationId);
   const request:CostRequest={id:`${root}#${dispatch.ref.id}`,dataRoot:root,parentImprove:run.parentImprove??null,source:dispatch.ref.id,runId:run.id,taskId:null,kind:run.kind,stage:d.purpose==='grading'?'grading':d.purpose==='eval-runtime'?'execution':null,side:trial?.side??null,at:dispatch.ref.at,dispatchSources:[dispatch.ref.id],usageSources:usage.map(f=>f.ref.id),purpose:d.purpose,currency:null,amount:null,state:'unknown',gaps:[],history:[],price:null,association:`trusted host ${run.kind} operation ${d.operationId}`,usage:settlement?{tokens:settlement.data.tokens,source:settlement.ref.id}:null};
   if(settlement?.data.tokens===null||!settlement)request.gaps.push('usage missing or request in flight');
   if(!usage.length)request.gaps.push('original provider usage bytes unavailable');
   for(const f of usage)try{readObject(root,f.data.bytes);}catch{request.gaps.push(`provider bytes unavailable: ${f.ref.id}`);}
   if(plan?.price&&validAmount(settlement?.data.tokens)){request.amount=settlement!.data.tokens*plan.price.perMillionTokens/1e6;request.currency=plan.price.currency;request.price={...plan.price,effectiveAt:plan.price.effectiveAt??null,provider:plan.model?.provider??null,model:plan.model?.id??null};request.history.push({source:facts.find(f=>f.ref.kind==='eval.plan')!.ref.id,amount:request.amount,currency:request.currency,price:request.price});if(!request.price.effectiveAt)request.gaps.push('original catalog effective time is unavailable');}
   else request.gaps.push('price unavailable');applyEstimate(root,request,facts);requests.push(request);
  }
  // A recorded external tool fee uses the same attempt identity and estimator contract.
  for(const intent of facts.filter(f=>f.ref.kind==='tool.intent'&&facts.some(e=>e.ref.kind==='cost.estimate'&&e.data.requestSource===f.ref.id))){
   const response=facts.findLast(f=>f.ref.kind==='tool.result'&&f.data.attemptId===intent.data.attemptId),dispatch=facts.find(f=>f.ref.kind==='tool.dispatch'&&f.data.attemptId===intent.data.attemptId);
   const request:CostRequest={id:`${root}#${intent.ref.id}`,dataRoot:root,parentImprove:run.parentImprove??null,runId:run.id,taskId:task?.taskId??null,kind:run.kind,stage:run.kind==='eval'?'execution':null,side:null,source:intent.ref.id,at:dispatch?.ref.at??intent.ref.at,dispatchSources:dispatch?[dispatch.ref.id]:[],usageSources:response?[response.ref.id]:[],purpose:'recorded tool fee',currency:null,amount:null,state:'unknown',gaps:dispatch?[]:['tool dispatch unknown'],history:[],price:null,association:'explicit tool fee; not local machine or human depreciation',usage:null};applyEstimate(root,request,facts);requests.push(request);
  }
  if(!intents.length&&[...sessionUsage.values()].some(u=>u.dataRoot===root&&u.runId===run.id&&u.value))issue('cumulative usage has no provable request allocation; retained separately');
  for(const d of facts.filter(f=>f.ref.kind==='model.dispatch'&&!intents.some(i=>i.data.attemptId===f.data.attemptId)))issue('orphan request dispatch has no readable intent/ownership',d.ref.id);
  if(task&&!task.terminated)issue('sample execution not terminated; provisional cost');
  if(task?.startedSource&&!intents.length&&!facts.some(f=>f.ref.kind==='provider.dispatch')&&!facts.some(f=>f.ref.kind==='run.closed'&&f.data.lifecycle?.storage==='closed'))issue('no proof that no chargeable work occurred');
 }
 function aggregate(selected:CostRequest[],extra:typeof gaps,denominator?:number){
  const incomplete=selected.some(r=>r.state!=='complete'&&r.state!=='not-applicable')||extra.length>0;
  const amounts:Record<string,number>={};for(const r of selected)if(r.currency&&r.amount!==null)amounts[r.currency]=(amounts[r.currency]??0)+r.amount;
  const state=incomplete?(Object.keys(amounts).length?'partial':'unknown'):'complete';
  const currencies=Object.fromEntries(Object.entries(amounts).map(([currency,knownAmount])=>[currency,{knownAmount,perSuccess:{state:denominator===undefined?'N/A':denominator===0?'N/A':state,value:denominator&&state==='complete'?knownAmount/denominator:null,knownPartPerSuccess:denominator?knownAmount/denominator:null,denominator:denominator??null,unit:`${currency}/successful task`,interpretation:'partial estimate, not a proven lower bound; no currency conversion'}}]));
  return{state,perSuccessState:denominator===undefined||denominator===0?'N/A':state,currencies,requestIds:selected.map(r=>r.id),gaps:extra,missingRequests:selected.filter(r=>r.gaps.length).map(r=>({id:r.id,gaps:r.gaps})),groups:Object.fromEntries([...new Set(selected.map(r=>r.kind))].sort().map(kind=>[kind,selected.filter(r=>r.kind===kind).map(r=>r.id)]))};
 }
 const sampleRequests=requests.filter(r=>r.taskId!==null),periodRequests=requests.filter(r=>Date.parse(r.at)>=Date.parse(sample.scope.from)&&Date.parse(r.at)<Date.parse(sample.scope.to));
 return{sample:{...aggregate(sampleRequests,gaps.filter(g=>g.mayAffectSample),sample.counts.S),basis:'all accepted sample tasks accumulated through same asOf; denominator is current effective S',sampleId:sample.id},period:{...aggregate(periodRequests,gaps),basis:'request transport occurrence in [from,to), all selected work kinds; never divided by admission sample S'},requests,gaps,sessionUsage:[...sessionUsage.values()],sessionEstimates,evalStages:runs.filter(r=>r.kind==='eval').map(r=>({dataRoot:r.root,planId:r.id,parentImprove:r.parentImprove??null,stages:Object.fromEntries(['preparation','execution','grading'].map(stage=>[stage,{requests:requests.filter(q=>q.dataRoot===r.root&&q.runId===r.id&&q.stage===stage).map(q=>q.id),sources:r.facts.filter(f=>stage==='preparation'?f.ref.kind==='eval.preparation':stage==='grading'?['eval.grade','eval.timing'].includes(f.ref.kind):['eval.trial-started','eval.outcome'].includes(f.ref.kind)).map(f=>f.ref.id)}])),basis:'same request IDs as the total; deterministic preparation/grading do not create additional model charges'})),rule:'raw request identity once; cumulative session pi.usage is evidence, not an additional cost; explicit sourced estimates append revisions'};
}
function applyEstimate(root:string,request:CostRequest,facts:OperationRun['facts']){
 const revisions=facts.filter(f=>f.ref.kind==='cost.estimate'&&f.data.requestSource===request.source);
 request.history.push(...revisions.map(f=>({source:f.ref.id,...f.data})));const superseded=new Set(revisions.map(f=>f.data.revisionOf));const active=revisions.filter(f=>!superseded.has(f.data.id));
 if(active.length>1){request.gaps.push('conflicting estimate revisions');request.amount=null;request.currency=null;}
 if(active.length===1){const f=active[0];let valid=f.data.method==='explicit-sourced-estimate-v1'&&validAmount(f.data.amount)&&typeof f.data.currency==='string'&&!!f.data.price?.source&&!!f.data.price?.version&&!!f.data.price?.provider&&!!f.data.price?.model&&Number.isFinite(Date.parse(f.data.price?.effectiveAt))&&Date.parse(f.data.price.effectiveAt)<=Date.parse(request.at)&&Array.isArray(f.data.usageSources)&&f.data.usageSources.length>0;for(const id of f.data.usageSources??[])try{decode(root,resolveEvidence(root,id));}catch{valid=false;}
  if(valid){request.amount=f.data.amount;request.currency=f.data.currency;request.price={...f.data.price,currency:f.data.currency,observedAt:f.ref.at};request.gaps=request.gaps.filter(g=>!['original catalog effective time is unavailable','price unavailable'].includes(g));}else request.gaps.push('estimate metadata or usage source unavailable');
 }
 if(request.amount===null&&!request.gaps.includes('price unavailable'))request.gaps.push('price unavailable');request.state=request.gaps.length?(request.amount===null?'unknown':'partial'):'complete';
}
