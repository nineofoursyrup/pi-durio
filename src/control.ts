import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import type { Conversation, Harness, Submission, SubmissionRecord } from '@earendil-works/pi-durable';
import { readQueue, openHostReadonly, readObject, type ControlAdmission, type ControlKind, type ControlReceipt, type ControlTarget, type QueueItemFact } from './evidence.js';

export interface ControlInput { id:string; kind:ControlKind; input:string; target:ControlTarget }
export interface QueueDecision { id:string; requestId:string; action:'withdraw'|'reattach'; target:ControlTarget; receiptSeq:number }
export function findQueueItem(root:string,id:string):QueueItemFact|undefined {
  let after:number|undefined,through:number|undefined;
  do {const page=readQueue(root,{after,through,limit:200});const found=page.items.find(item=>item.requestId===id);if(found)return found;after=page.next??undefined;through=page.through;}while(after);
}
export function validControlId(value:string) {if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))throw Error('INVALID_CONTROL_ID');}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function previousQueueDecision(root:string,decision:QueueDecision) {
  const db=openHostReadonly(root);
  try {for(const row of db.prepare("SELECT body FROM records WHERE run_id=? AND kind='control.decision' ORDER BY seq").iterate(decision.target.runId)) {
    const data=JSON.parse(readObject(root,JSON.parse(String(row.body))).toString());
    if(data.decision?.id===decision.id){if(!same(data.decision,decision))throw Error('DECISION_ID_CONFLICT');return true;}
  }return false;}finally{db.close();}
}

/** Public host controller: no writable storage, Conversation or Harness handle escapes. */
export class TaskControl {
  private binding?:RunControls;
  target():ControlTarget|null {return this.binding?structuredClone(this.binding.target):null;}
  submit(input:ControlInput):Promise<QueueItemFact> {if(!this.binding)return Promise.reject(Error('CONTROL_NOT_RUNNING'));return this.binding.submit(structuredClone(input));}
  withdraw(decision:QueueDecision):Promise<QueueItemFact> {if(!this.binding)return Promise.reject(Error('CONTROL_NOT_RUNNING'));return this.binding.withdraw(structuredClone(decision));}
  /** @internal Runtime ownership only. */
  attach(binding:RunControls) {if(this.binding)throw Error('CONTROL_ALREADY_ATTACHED');this.binding=binding;}
  /** @internal */ detach(binding:RunControls) {if(this.binding===binding)this.binding=undefined;}
}

/** Host admission boundary around the public Pi submission API, never an agent loop. */
export class RunControls {
  private line:Promise<unknown>=Promise.resolve();
  private items=new Map<string,{admission:ControlAdmission;submission?:Submission;status:QueueItemFact['status']}>();
  private remove:()=>void;
  private closedReason?:string;
  readonly target:ControlTarget;
  constructor(private readonly options:{root:string;target:ControlTarget;version:ControlAdmission['executionVersion'];authorization:unknown;conversation:Conversation;harness:Harness;guard:()=>void;record:(kind:string,data:unknown)=>number;failure:(error:unknown)=>void}) {
    this.target=structuredClone(options.target);
    this.remove=options.harness.subscribeCommits(publication=>{
      try {for(const change of publication.changes)if(change.type==='submission'&&change.value.requestId&&this.items.has(change.value.requestId))this.observe(change.value);}
      catch(error){options.failure(error);}
    });
  }
  private serial<T>(action:()=>Promise<T>):Promise<T> {const next=this.line.then(action);this.line=next.catch(()=>{});return next;}
  private receipt(value:ControlReceipt) {this.options.record('control.receipt',value);const item=this.items.get(value.requestId);if(item)item.status=value.status;}
  private fact(id:string) {const fact=findQueueItem(this.options.root,id);if(!fact)throw Error('CONTROL_RECEIPT_MISSING');return fact;}
  private observe(value:SubmissionRecord) {
    const item=this.items.get(value.requestId!);if(!item)return;
    if(value.status==='placed'||value.status==='done'||value.status==='unanswered'&&value.entry!==undefined) {
      if(item.status!=='applied')this.receipt({requestId:value.requestId!,status:'applied',reason:'Pi committed this input to the original task transcript',upstream:{submissionId:value.id,status:value.status,entry:value.entry}});
    } else if(value.status==='queued'&&item.status==='dispatching')this.receipt({requestId:value.requestId!,status:'pending',reason:'Pi accepted; waiting for its tool-round boundary',upstream:{submissionId:value.id,status:value.status}});
    // An unanswered queue is frozen by explicit host handling below; it never becomes successful execution.
  }
  submit(input:ControlInput) {return this.serial(async()=>{
    validControlId(input.id);
    if(!input.input.trim()||Buffer.byteLength(input.input)>32768)throw Error('INPUT_LIMIT: provide 1–32768 bytes');
    if(!['steer','follow-up','compact','improve'].includes(input.kind))throw Error('INVALID_CONTROL_KIND');
    const existing=findQueueItem(this.options.root,input.id);
    if(existing){if(existing.kind!==input.kind||existing.input!==input.input||!same(existing.target,input.target))throw Error('CONTROL_ID_CONFLICT');return existing;}
    if(!same(input.target,this.target))throw Error('CONTROL_TARGET_CHANGED');
    if(input.id===this.target.taskId)throw Error('CONTROL_ID_CONFLICT');
    if(this.closedReason)throw Error(`CONTROL_FROZEN: ${this.closedReason}`);
    this.options.guard();
    if([...this.items.values()].filter(item=>item.status==='pending'||item.status==='dispatching').length>=128)throw Error('CONTROL_QUEUE_FULL: withdraw or finish pending work first');
    const admission:ControlAdmission={requestId:input.id,kind:input.kind,input:input.input,taskId:input.kind==='steer'?this.target.taskId:input.kind==='follow-up'?randomUUID():null,target:this.target,executionVersion:this.options.version,authorization:this.options.authorization};
    this.options.record('control.accepted',admission);
    const item:{admission:ControlAdmission;submission?:Submission;status:QueueItemFact['status']}={admission,status:'pending'};this.items.set(input.id,item);
    if(input.kind==='steer') {
      this.options.guard();
      this.receipt({requestId:input.id,status:'dispatching',reason:'Saved intent before Pi submission; a crash in this interval requires recovery'});
      try {
        item.submission=await this.options.conversation.submit({type:'input',content:input.input,requestId:input.id,whenBusy:'steer'},CTX);
        this.observe(await item.submission.status(CTX));
      } catch(error){this.receipt({requestId:input.id,status:'frozen',reason:`Submission outcome requires recovery: ${String(error)}`});throw error;}
    }
    return this.fact(input.id);
  });}
  withdraw(decision:QueueDecision) {return this.serial(async()=>{
    validControlId(decision.id);
    if(decision.action!=='withdraw'||!same(decision.target,this.target))throw Error('CONTROL_TARGET_CHANGED');
    if(previousQueueDecision(this.options.root,decision))return this.fact(decision.requestId);
    const fact=this.fact(decision.requestId);
    if(fact.receipt.seq!==decision.receiptSeq)throw Error('STALE_CONTROL_DECISION');
    this.options.record('control.decision',{decision});
    const item=this.items.get(decision.requestId);
    if(fact.status==='applied'||fact.status==='withdrawn')return fact;
    if(item?.submission) {
      const result=await item.submission.abort(CTX);
      const state=await item.submission.status(CTX);this.observe(state);
      if(result!=='aborted')return this.fact(decision.requestId);
    }
    this.receipt({requestId:decision.requestId,status:'withdrawn',reason:`Withdrawal committed for decision ${decision.id}`});
    return this.fact(decision.requestId);
  });}
  /** Closes admission synchronously before awaiting any storage operation. */
  freeze(reason:string) {
    this.closedReason??=reason;
    return this.serial(async()=>{
      for(const [requestId,item] of this.items) {
        if(item.status==='applied'||item.status==='withdrawn'||item.status==='frozen')continue;
        if(item.submission) {
          const result=await item.submission.abort(CTX);
          this.observe(await item.submission.status(CTX));
          if(result!=='aborted'&&this.fact(requestId).status==='applied')continue;
        }
        this.receipt({requestId,status:'frozen',reason});
      }
      const frozen=[...this.items.values()].filter(item=>item.status==='frozen');
      if(frozen.length)this.options.record('control.report',{status:'needs-decision',exitCode:75,reason,requestIds:frozen.map(item=>item.admission.requestId),options:['inspect','withdraw','reattach compatible completed-source follow-up','explicitly submit old text as new work']});
    });
  }
  async settleSteers() {
    // Serialize admission with finalization. Submissions accepted before this point remain part of this product task.
    await this.line;this.closedReason??='Original task is finishing';
    for(const item of this.items.values())if(item.admission.kind==='steer'&&item.submission&&item.status!=='withdrawn'&&item.status!=='frozen') {
      const settled=await item.submission.wait(CTX);this.observe(settled);if(settled.status!=='done')throw Error('STEER_UNANSWERED: supplementary input did not complete');
    }
  }
  pending() {return [...this.items.values()].filter(item=>item.admission.kind!=='steer'&&item.status==='pending').map(item=>this.fact(item.admission.requestId));}
  async drain() {this.closedReason??='Runtime is closing';await this.line;}
  close() {this.remove();}
}
