import {submitImproveDecision,resumeImproveDecision,type ImproveDecision,type ImproveResume} from './improve-decisions.js';
import {readImproveDecision,improveFacts} from './improve-history.js';

export type ImproveBatchOrigin={reportId:string;decisionId:string};
export type ImproveDecisionState=ReturnType<typeof readImproveDecision>;
/** One host-owned cancellation signal for the entire submission, including any
 * nested eval. stop() settles only after submit's finally has released ownership
 * and the running restricted operation has finished its cleanup. */
export class ImproveBatchController {
 private active?:{origin:ImproveBatchOrigin;abort:AbortController;done:Promise<ImproveDecisionState>;decision:ImproveDecision;startedAt:number};
 private lastProgress?:{at:number;value:[number,number]};
 constructor(readonly dataRoot:string){}
 get elapsedMs(){return this.active?Date.now()-this.active.startedAt:undefined;}
 get running(){return this.active!==undefined;}
 get origin(){return this.active?.origin;}
 canStop(origin:ImproveBatchOrigin|null|undefined){return !!origin&&!!this.active&&origin.reportId===this.active.origin.reportId&&origin.decisionId===this.active.origin.decisionId;}
 start(decision:ImproveDecision,signal?:AbortSignal):Promise<ImproveDecisionState> {
  if(this.active)throw Error('IMPROVE_BATCH_ALREADY_RUNNING');
  this.lastProgress=undefined;
  const abort=new AbortController(),origin={reportId:decision.reportId,decisionId:decision.id};
  const done=submitImproveDecision({dataRoot:this.dataRoot,decision,signal:signal?AbortSignal.any([abort.signal,signal]):abort.signal}).finally(()=>{if(this.active?.origin===origin)this.active=undefined;});
  this.active={origin,abort,done,decision:structuredClone(decision),startedAt:Date.now()};
  return done;
 }
 /** Continuation stays in the same process-wide batch cancellation boundary. */
 resume(input:ImproveResume,signal?:AbortSignal):Promise<ImproveDecisionState> {
  if(this.active)throw Error('IMPROVE_BATCH_ALREADY_RUNNING');
  const decision=readImproveDecision(this.dataRoot,input.id).decision as ImproveDecision;
  this.lastProgress=undefined;
  const abort=new AbortController(),origin={reportId:decision.reportId,decisionId:decision.id};
  const done=resumeImproveDecision({...input,dataRoot:this.dataRoot,signal:signal?AbortSignal.any([abort.signal,signal]):abort.signal}).finally(()=>{if(this.active?.origin===origin)this.active=undefined;});
  this.active={origin,abort,done,decision:structuredClone(decision),startedAt:Date.now()};
  return done;
 }
 /** A foreign/non-running origin is never stopped. Repeated calls join cleanup. */
 async stop(origin:ImproveBatchOrigin):Promise<{stopped:boolean;state?:ImproveDecisionState;error?:string}> {
  if(!this.canStop(origin))return {stopped:false};
  const active=this.active!;active.abort.abort();
  try{return {stopped:true,state:await active.done};}catch(error){return {stopped:true,error:String(error)};}
 }
 progress():[number,number]|undefined {
  const active=this.active;if(!active)return;
  if(this.lastProgress&&Date.now()-this.lastProgress.at<250)return this.lastProgress.value;
  const total=active.decision.groups.length;
  if(!total)return [0,0];
  const started=improveFacts(this.dataRoot).filter(f=>f.kind==='improve.group-started'&&f.data.id===active.origin.decisionId).length;
  this.lastProgress={at:Date.now(),value:[Math.min(total,started),total]};return this.lastProgress.value;
 }
}
