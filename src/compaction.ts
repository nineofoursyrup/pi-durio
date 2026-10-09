import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { CompactionTask, CompactionEntry, hook, type Harness, type Conversation, type TaskId, type CompactionResult, type SubmissionRecord } from '@earendil-works/pi-durable';
import { records, decode, watermark } from './history.js';

export { compactContext } from './runtime.js';
export type { CompactOptions } from './runtime.js';
export type CompactionState='noop'|'generated'|'applied'|'stale'|'cancelled'|'failed'|'interrupted';
export interface CompactionResultFact { requestId:string|null; taskId:number; state:CompactionState; submissionId?:number; entryId?:number; reason?:string }

/** Read-only facts, bounded at a stable host watermark. No Harness is opened. */
export function readCompactions(root:string,runId:string,options:{after?:number;through?:number;limit?:number}={}) {
 const through=options.through??watermark(root),limit=options.limit??50;
 if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('COMPACTION_PAGE_LIMIT');
 const items=[];let next:number|null=null;
 for(const ref of records(root,{through,runId})) {
  if(ref.seq<=(options.after??0)||!ref.kind.startsWith('compaction.')&&ref.kind!=='recovery.compaction-frozen')continue;
  if(items.length===limit){next=items.at(-1)!.seq;break;}
  items.push({seq:ref.seq,kind:ref.kind,source:ref.id,data:decode(root,ref)});
 }
 return {runId,through,items,next,retention:'Original records retained; context compaction does not release disk space'};
}

/** Observes public Pi commits; it never selects a cut, generates a summary or schedules a replacement loop. */
export class CompactionFacts {
 private harness?:Harness;
 private remove?:()=>void;
 private tasks=new Map<number,{reason:string;requestId:string|null}>();
 private submissions=new Map<number,number>();
 private results=new Map<number,CompactionResultFact>();
 private seen=new Set<string>();
 private manualRequest:string|null=null;
 constructor(private readonly record:(kind:string,data:unknown)=>number,private readonly guard:()=>void,private readonly failure:(error:unknown)=>void){}
 readonly hook=hook(CompactionTask,{beforeCompact:(range,api)=>{
  this.guard();
  this.record('compaction.source',{taskId:api.taskId,conversationId:api.conversationId,trigger:range.reason==='manual'?'manual':'automatic',reason:range.reason,requestId:this.tasks.get(api.taskId)?.requestId??this.manualRequest,entries:range.entries,firstKept:range.firstKept,messages:range.messages,transform:'@earendil-works/pi-durable@1.1.0 public beforeCompact; source messages before upstream serialization; tool text may be truncated in actual model.intent'});
  return undefined;
 }});
 attach(harness:Harness){this.harness=harness;this.remove=harness.subscribeCommits(p=>{try{for(const change of p.changes){
   if(change.type==='entry'&&change.value.kind===CompactionEntry.kind)this.once(`summary-entry:${change.value.id}`,'compaction.summary',{durableCommit:p.seq,entry:change.value,source:'public committed CompactionEntry'});
   if(change.type==='document'&&change.record.kind==='pi.inbox'&&Array.isArray(change.value?.items))for(const item of change.value.items as any[])if(item.mode==='write'&&item.entry?.kind===CompactionEntry.kind)this.once(`summary-pending:${item.id}`,'compaction.summary',{durableCommit:p.seq,submissionId:item.id,entryDraft:item.entry,source:'public committed InboxDoc; generated but not yet placed'});
   if(change.type==='task'&&change.value.kind==='pi.compaction'){
    const t=change.value,input=t.input as {reason:string};
    if(!this.tasks.has(t.id)){const requestId=input.reason==='manual'?this.manualRequest:null;this.tasks.set(t.id,{reason:input.reason,requestId});this.record('compaction.task',{taskId:t.id,conversationId:t.conversationId,owner:t.owner??null,trigger:input.reason==='manual'?'manual':'automatic',reason:input.reason,requestId});}
    const state=t.state as any;
    if(state.checkpoint?.phase==='summarize')this.once(`boundary:${t.id}:${state.checkpoint.attempt}`,'compaction.boundary',{taskId:t.id,...state.checkpoint});
    if(state.status==='terminal'){
     const result=state.outcome?.result as CompactionResult|undefined;
     if(result?.submissionId!==undefined){this.once(`generated:${t.id}`,'compaction.generated',{durableCommit:p.seq,taskId:t.id,requestId:this.tasks.get(t.id)?.requestId??null,submissionId:result.submissionId});this.submissions.set(result.submissionId,t.id);this.finish(t.id,'generated',{submissionId:result.submissionId});}
     else if(result?.entryId!==undefined){this.once(`generated:${t.id}`,'compaction.generated',{durableCommit:p.seq,taskId:t.id,requestId:this.tasks.get(t.id)?.requestId??null,entryId:result.entryId});this.finish(t.id,'applied',{entryId:result.entryId});}
     else this.finish(t.id,state.outcome?.status==='completed'?'noop':state.outcome?.status==='aborted'?'cancelled':'failed',{reason:state.outcome?.error?.message});
    }
   }
   if(change.type==='submission'&&change.value.type==='write'&&change.value.requestId?.startsWith('compaction:'))this.submission(change.value);
  }}catch(error){this.failure(error);}});}
 private once(key:string,kind:string,data:unknown){if(this.seen.has(key))return;this.record(kind,data);this.seen.add(key);}
 private finish(taskId:number,state:CompactionState,extra:Partial<CompactionResultFact>={}){
  // A publication may order the placed submission before its terminal task.
  if(state==='generated'&&['applied','stale','cancelled'].includes(this.results.get(taskId)?.state??''))return;
  const result={requestId:this.tasks.get(taskId)?.requestId??null,taskId,state,...extra};
  this.once(`result:${taskId}:${state}`,'compaction.finished',result);this.results.set(taskId,result);
 }
 private submission(s:SubmissionRecord){const taskId=this.submissions.get(s.id)??Number(s.requestId!.slice('compaction:'.length));if(!this.tasks.has(taskId))return;this.submissions.set(s.id,taskId);
  this.once(`submission:${s.id}:${s.status}:${s.entry}`,'compaction.submission',{taskId,submission:s});
  if(s.entry!==undefined)this.finish(taskId,'applied',{submissionId:s.id,entryId:s.entry});
  else if(s.status==='unanswered')this.finish(taskId,s.reason==='stale'?'stale':s.reason==='aborted'?'cancelled':'failed',{submissionId:s.id,reason:s.reason});
 }
 async manual(conversation:Conversation,requestId:string,onTask:(id:TaskId<CompactionResult>)=>void){
  this.guard();this.manualRequest=requestId;
  const taskId=await conversation.compact(undefined,CTX);onTask(taskId);
  await this.harness!.waitForTask(taskId,CTX);
  await this.refresh(taskId);
  return this.results.get(taskId)!;
 }
 private async refresh(taskId:number){
  const task=await this.harness!.getTask(taskId as TaskId<CompactionResult>,CTX);
  if(task?.state.status==='terminal'&&task.state.outcome.status==='completed'&&task.state.outcome.result.submissionId!==undefined){const s=await this.harness!.submission(task.state.outcome.result.submissionId,CTX);if(s)this.submission(await s.status(CTX));}
 }
 async settle(){for(const id of this.tasks.keys()){this.guard();await this.harness!.waitForTask(id as TaskId,CTX);await this.refresh(id);}}
 async cancel(taskId:TaskId<CompactionResult>){
  // abortTask and submission.abort are specific to this operation; no conversation abort.
  if(!this.tasks.has(taskId))throw Error('COMPACTION_TASK_NOT_OWNED');
  await this.harness!.abortTask(taskId,CTX);await this.harness!.waitForTask(taskId,CTX);
  const task=await this.harness!.getTask(taskId,CTX);
  if(task?.state.status==='terminal'&&task.state.outcome.status==='completed'&&task.state.outcome.result.submissionId!==undefined){const s=await this.harness!.submission(task.state.outcome.result.submissionId,CTX);if(s){await s.abort(CTX);this.submission(await s.status(CTX));}}
  return this.results.get(taskId);
 }
 close(){this.remove?.();}
}
