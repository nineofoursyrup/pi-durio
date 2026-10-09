import {queryAttempts,decode} from '../history.js';
import {ratio,type TaskMetricsReport} from './report.js';
import type {OperationFact,OperationRun} from './operations.js';
export type AttemptOutcome='error'|'normal'|'cancelled'|'planned-stop'|'open'|'unknown';
export interface FaultAttempt {id:string;dataRoot:string;runId:string;taskId:string|null;kind:'model'|'tool';intentSource:string;source:string;outcome:AttemptOutcome;reason:string;terminal:string|null;raw:any;nonzero:boolean;classificationRule:string;sources:string[];purpose:string|null;operationIdentity:string|null}
export interface FaultEvent {id:string;dataRoot:string;runId:string;taskId:string|null;category:'model'|'tool'|'execution'|'grader'|'observation';source:string;reason:string;recovered:boolean;resolutionSource:string|null}
export function faultReport(parentRoot:string,sample:TaskMetricsReport,runs:OperationRun[]){
 const attempts:FaultAttempt[]=[],events:FaultEvent[]=[],undispatched:any[]=[],gaps:any[]=[];
 const tasksByRun=new Map(sample.tasks.map(t=>[t.evidenceRunId,t]));
 for(const run of runs){const root=run.root,task=root===parentRoot?tasksByRun.get(run.id):undefined,facts=run.facts;let after:number|undefined;
  const through=Math.max(0,...facts.map(f=>f.ref.seq));
  const manualAt=(seq:number)=>facts.some(f=>f.ref.kind==='compaction.started'&&f.ref.seq<seq&&!facts.some(end=>end.ref.kind==='compaction.closed'&&end.data.requestId===f.data.requestId&&end.ref.seq<seq));
  try{do{const page=queryAttempts(root,run.id,{snapshot:through,after,limit:50});
   for(const a of page.items){const intent=decode(root,a.source),manual=intent.allocation==='maintenance',taskId=manual?null:task?.taskId??null;
    if(!a.observableRequests){undispatched.push({runId:run.id,taskId,id:a.id,kind:a.kind,state:a.dispatchState,source:a.source.id,reason:a.dispatchFailure?.reason??'no proven actual dispatch'});continue;}
    for(const request of a.requests){const next=a.requests.find(r=>r.seq>request.seq),related=facts.filter(f=>f.ref.seq>request.seq&&f.ref.seq<(next?.seq??Infinity)&&(f.data.attemptId===a.id||f.data.toolAttempt?.attemptId===a.id));
     const result=related.findLast(f=>['model.response','tool.result','tool.error'].includes(f.ref.kind));
     let outcome:AttemptOutcome='unknown',reason='No determinate acquired result';const failed=related.find(f=>f.ref.kind==='model.dispatch-failed'&&f.data.dispatched===true||f.ref.kind==='model.http'&&f.data.status>=400||f.ref.kind==='tool.error');
     const abort=task?.terminated&&['aborted','cancelled'].includes(task.status)&&facts.some(f=>f.ref.kind==='lifecycle.abort-settled');
     const abortIntent=facts.find(f=>f.ref.kind==='run.abort-intent');
     const cancellationFailure=abort&&abortIntent&&failed&&failed.ref.seq>abortIntent.ref.seq&&result?.data.message?.stopReason==='aborted'&&!related.some(f=>f.ref.kind==='model.http'&&f.data.status>=400);
     const shell=related.findLast(f=>f.ref.kind==='shell.completed'),raw=result?{kind:result.ref.kind,stopReason:result.data.message?.stopReason??null,error:result.data.message?.errorMessage??result.data.error??null,isError:result.data.result?.isError??null,exitCode:shell?.data.acquired?.exitCode??null}:null;const exit=shell?.data.acquired?.exitCode;
     if(cancellationFailure){outcome='cancelled';reason='host confirmed normal managed cancellation after explicit stop; remote outcome remains unknown';}
     else if(failed){outcome='error';reason=failed.data.reason??failed.data.error??`HTTP ${failed.data.status}`;}
     else if(a.kind==='model'&&result){const stop=result.data.message?.stopReason;if(stop==='error'||result.data.message?.errorMessage&&stop!=='aborted'){outcome='error';reason=result.data.message?.errorMessage??'model error result';}else if(stop==='aborted'){outcome=abort?'cancelled':'unknown';reason=abort?'host confirmed normal managed cancellation; remote outcome remains unknown':'aborted response without confirmed normal cancellation';}else if(stop==='length'){outcome='planned-stop';reason='provider confirmed configured output limit; not a runtime fault';}else if(['stop','toolUse'].includes(stop)){outcome='normal';reason='normal acquired model result';}}
     else if(a.kind==='tool'&&result){
      if(shell?.data.acquired?.error){outcome=abort?'cancelled':'error';reason=shell.data.acquired.error;}
      else if(result.ref.kind==='tool.error'){outcome='error';reason=result.data.error;}
      else if(result.data.result?.isError!==true){outcome='normal';reason='normal acquired tool result';}
      else if(typeof exit==='number'&&isBusinessCheck(facts,a.source.seq,intent.args?.command,exit)){outcome='normal';reason='predeclared business check exit; separate acceptance finding';}
      else{outcome='unknown';reason='tool error result requires purpose semantics; nonzero/expected no-match is not automatically a runtime fault';}
     }else if(!task?.terminated){outcome='open';reason='no terminal result; managed work still open';}
     if(abort&&!result&&!failed){outcome='cancelled';reason='host confirmed managed abort; no prior error; remote completion unproven';}
     const item:FaultAttempt={id:`${root}#${request.id}`,dataRoot:root,runId:run.id,taskId,kind:a.kind as 'model'|'tool',intentSource:a.source.id,source:request.id,outcome,reason,terminal:result?.ref.id??null,raw,nonzero:typeof exit==='number'&&exit!==0,classificationRule:'llmops-r1/host-boundary-fault-v1',sources:[a.source.id,request.id,...related.map(f=>f.ref.id)],purpose:a.purpose,operationIdentity:intent.durableTaskId===undefined||intent.durableTaskId===null?null:`${a.kind}:${intent.durableTaskId}:${a.kind==='tool'?intent.callId??'unknown':''}`};attempts.push(item);
     if(outcome==='error')events.push({id:`${root}#${request.id}`,dataRoot:root,runId:run.id,taskId,category:item.kind,source:failed?.ref.id??result!.ref.id,reason,recovered:false,resolutionSource:null});
    }
    if(a.omitted||a.gaps.length)gaps.push({runId:run.id,source:a.source.id,reason:'attempt source projection incomplete',missing:a.gaps});
   }
   after=page.next??undefined;
  }while(after);}catch(error){gaps.push({runId:run.id,reason:String(error)});}
  // Formal eval uses the trusted outer provider record, never guest transport claims.
  if(run.kind==='eval'&&!facts.some(f=>f.ref.kind==='model.intent'))for(const dispatch of facts.filter(f=>f.ref.kind==='provider.dispatch')){
   const d=dispatch.data,settled=facts.find(f=>f.ref.kind==='budget.settle'&&f.data.id===d.id),http=facts.find(f=>f.ref.kind==='provider.http'&&f.data.id===d.id);
   const status=settled?.data.status,outcome:AttemptOutcome=status==='error'||http?.data.status>=400?'error':status==='returned'?'normal':status==='cancelled'?'cancelled':!settled?'open':'unknown';
   const item:FaultAttempt={id:`${root}#${dispatch.ref.id}`,dataRoot:root,runId:run.id,taskId:null,kind:'model',intentSource:dispatch.ref.id,source:dispatch.ref.id,outcome,reason:settled?.data.reason??`trusted outer provider ${status??'unsettled'}`,terminal:settled?.ref.id??null,raw:{status:status??null,httpStatus:http?.data.status??null},nonzero:false,classificationRule:'llmops-r1/trusted-outer-provider-v1',sources:[dispatch.ref.id,...settled?[settled.ref.id]:[],...http?[http.ref.id]:[]],purpose:d.purpose,operationIdentity:`eval:${d.operationId}`};attempts.push(item);
   if(outcome==='error')events.push({id:item.id,dataRoot:root,runId:run.id,taskId:null,category:'model',source:settled?.ref.id??http!.ref.id,reason:item.reason,recovered:false,resolutionSource:null});
  }
  for(const f of facts){let category:FaultEvent['category']|undefined,reason:string|undefined;
   if(['lifecycle.abort-failed','lifecycle.close-failed','lifecycle.timeout','lifecycle.owner-lost'].includes(f.ref.kind)){category='execution';reason=f.data.reason;}
   if(f.ref.kind==='evidence.gap'){category='execution';reason=`original collection failed: ${f.data.reason}`;}
   if(f.ref.kind==='eval.grade'&&f.data.judgment==='unknown'&&/error|failed|crash|timeout|isolation/i.test(f.data.reason)){category='grader';reason=f.data.reason;}
   if(['run.closed','recovery.closed'].includes(f.ref.kind)&&(f.data.result??f.data).observation==='degraded'){category='observation';reason='derived observation degraded; original execution result remains separate';}
   if(f.ref.kind==='eval.outcome'&&['service-error','original-error','timeout','preparation-error','invalid'].includes(f.data.status)){category='execution';reason=`eval ${f.data.status}: ${f.data.reason??'see original outcome'}`;}
   if(['observation.degraded','observation.error'].includes(f.ref.kind)){category='observation';reason=f.data.reason;}
   if(category)events.push({id:`${root}#${f.ref.id}`,dataRoot:root,runId:run.id,taskId:category==='grader'||category==='observation'||manualAt(f.ref.seq)?null:task?.taskId??null,category,source:f.ref.id,reason:reason??f.ref.kind,recovered:false,resolutionSource:null});
   if(f.missing)gaps.push({runId:run.id,source:f.ref.id,reason:f.missing});
  }
 }
 // Successful later responses prove the attempt recovered only within the same managed run.
 for(const event of events){const sourceSeq=Number(event.source.split(':')[1]),failed=attempts.find(a=>a.id===event.id),later=failed?.operationIdentity?attempts.find(a=>a.dataRoot===event.dataRoot&&a.runId===event.runId&&a.taskId===event.taskId&&a.operationIdentity===failed.operationIdentity&&a.outcome==='normal'&&Number(a.source.split(':')[1])>sourceSeq):undefined;if(later){event.recovered=true;event.resolutionSource=later.terminal;}}
 const members=sample.tasks.filter(t=>t.startedSource).map(t=>{const own=events.filter(e=>e.dataRoot===parentRoot&&e.taskId===t.taskId&&['model','tool','execution'].includes(e.category)),seen=attempts.filter(a=>a.dataRoot===parentRoot&&a.taskId===t.taskId),run=runs.find(r=>r.root===parentRoot&&r.id===t.evidenceRunId),close=run?.facts.findLast(f=>f.ref.id===t.terminationSource),end=close?.data.result??close?.data;
  const incomplete=!t.terminated||t.missing.length>0||gaps.some(g=>g.runId===t.evidenceRunId)||seen.some(a=>['open','unknown'].includes(a.outcome))||undispatched.some(a=>a.taskId===t.taskId&&a.state==='unknown')||!['ok','degraded'].includes(end?.observation)||end?.lifecycle?.storage!=='closed';
  const category=own.length?'F':incomplete?'Uf':'Zf';
  const lastModel=seen.filter(a=>a.kind==='model').at(-1),settled=run?.facts.findLast(f=>f.ref.kind==='submission.settled');
  // Current host maps a non-done submission and last HTTP 401/403 to AUTH_REJECTED,
  // otherwise a terminal model error maps to TASK_UNANSWERED. Keep these original
  // facts linked; an unrelated historical failure is insufficient.
  const lastHttp=run?.facts.findLast(f=>f.ref.kind==='model.http');
  const hostCause=settled&&settled.data.status!=='done'&&lastModel?.outcome==='error'&&(
   end?.reason==='AUTH_REJECTED: DeepSeek rejected credentials; no provider fallback'&&[401,403].includes(lastHttp?.data.status)||end?.reason==='TASK_UNANSWERED'&&lastModel.raw?.stopReason==='error');
  const terminalFault=own.find(e=>end?.faultSource===e.source||typeof end?.reason==='string'&&e.reason.length>0&&end.reason.includes(e.reason)||hostCause&&e.id===lastModel?.id);
  const terminationBasis=terminalFault?[terminalFault.source,t.terminationSource!,...(hostCause?[settled!.ref.id,...lastHttp?[lastHttp.ref.id]:[]]:[])]:[];
  return{taskId:t.taskId,runId:t.runId,status:t.status,category,events:own.map(e=>e.id),faultTerminated:t.terminated&&t.status==='failed'&&!!terminalFault,terminationBasis,terminationRule:'literal fault source/reason or fixed host non-done submission mapping; never history alone',faultTermination:t.terminated&&t.status==='failed'?(terminalFault?'confirmed':own.length?'unknown':'no observed causal fault'):'not fault terminated',recoveredEvents:own.filter(e=>e.recovered).length,unresolvedEvents:own.filter(e=>!e.recovered).length,observationComplete:!incomplete,terminationSource:t.terminationSource,scope:'host managed execution only; provider hidden attempts and unmanaged effects unknown'};
 });
 const B=members.length,F=members.filter(t=>t.category==='F').length,Zf=members.filter(t=>t.category==='Zf').length,Uf=B-F-Zf,terminated=members.filter(t=>t.faultTerminated).length;
 function summary(items:FaultAttempt[]){const n=items.length,counts=Object.fromEntries((['error','normal','cancelled','planned-stop','open','unknown'] as const).map(k=>[k,items.filter(i=>i.outcome===k).length]));return{started:n,counts,observedErrors:ratio(counts.error,n),coverage:ratio(counts.error+counts.normal+counts.cancelled+counts['planned-stop'],n),completeErrorRate:n===0?'N/A':counts.open+counts.unknown?'unknown':'known',rawNonzero:items.filter(i=>i.nonzero).length};}
 const daily=attempts.filter(a=>a.taskId!==null);
 const otherRuns=[...new Set(attempts.filter(a=>a.taskId===null).map(a=>`${a.dataRoot}#${a.runId}`))].map(key=>{const items=attempts.filter(a=>`${a.dataRoot}#${a.runId}`===key&&a.taskId===null);return{dataRoot:items[0].dataRoot,runId:items[0].runId,model:summary(items.filter(a=>a.kind==='model')),tool:summary(items.filter(a=>a.kind==='tool'))};});
 return{tasks:{counts:{B,F,Zf,Uf,faultTerminated:terminated},observedFaults:ratio(F,B),faultTermination:ratio(terminated,B),coverage:ratio(F+Zf,B),faultTerminationUnknown:members.filter(t=>t.faultTermination==='unknown').length,completeFaultTerminationRate:members.some(t=>t.faultTermination==='unknown')?'unknown':B?'known':'N/A',completeFaultRate:B===0?'N/A':Uf?'unknown':'known',logicalRange:B?{lower:F/B,upper:(F+Uf)/B,interpretation:'logical bounds, not a statistical confidence interval'}:null,members,unstarted:sample.tasks.filter(t=>!t.startedSource).map(t=>({taskId:t.taskId,status:t.status,events:events.filter(e=>e.dataRoot===parentRoot&&e.taskId===t.taskId)}))},attempts:{model:summary(daily.filter(a=>a.kind==='model')),tool:summary(daily.filter(a=>a.kind==='tool')),items:attempts,undispatched},events,gaps,separate:{attemptSummaries:otherRuns,grader:events.filter(e=>e.category==='grader'),observation:events.filter(e=>e.category==='observation'),otherWorkAttempts:attempts.filter(a=>a.taskId===null)}};
}
function isBusinessCheck(facts:OperationFact[],intentSeq:number,command:unknown,exit:number){return facts.some(f=>f.ref.kind==='acceptance.requirements'&&f.ref.seq<intentSeq&&(f.data.necessary??[]).some((r:any)=>r.check?.command===command&&[...r.check.passExitCodes??[],...r.check.failExitCodes??[]].includes(exit)));}
