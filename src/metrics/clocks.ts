import type {FactClock} from '../fact-clock.js';
import type {EvidenceReference} from '../history.js';
export interface MetricFact {ref:EvidenceReference;data:any;missing?:string}
export interface TimePoint {at:string;clock:FactClock|null;source:string}
export interface Duration {state:'measured'|'unknown'|'pending';milliseconds:number|null;wallEstimateMs:number|null;reason:string|null;from:TimePoint;to:TimePoint|null}
export function point(fact:MetricFact):TimePoint {return{at:fact.ref.at,clock:validClock(fact.data?.clock)?fact.data.clock:null,source:fact.ref.id};}
function validClock(clock:any):clock is FactClock {return typeof clock?.processId==='string'&&!!clock.processId&&typeof clock.monotonicMs==='number'&&Number.isFinite(clock.monotonicMs)&&clock.monotonicMs>=0&&Number.isFinite(Date.parse(clock.wallTime));}
/** Raw wall time is retained as an estimate; only same-incarnation monotonic spans are exact. */
export function duration(from:TimePoint,to:TimePoint|null,asOf:string,rollback=false):Duration {
 if(!to)return{state:'pending',milliseconds:null,wallEstimateMs:!rollback&&Number.isFinite(Date.parse(asOf)-Date.parse(from.at))&&Date.parse(asOf)>=Date.parse(from.at)?Date.parse(asOf)-Date.parse(from.at):null,reason:'missing endpoint; open waiting excluded from completed statistics',from,to};
 const wall=Date.parse(to.at)-Date.parse(from.at),a=from.clock,b=to.clock;
 if(a&&b&&a.processId===b.processId&&b.monotonicMs>=a.monotonicMs)return{state:'measured',milliseconds:b.monotonicMs-a.monotonicMs,wallEstimateMs:Number.isFinite(wall)&&wall>=0?wall:null,reason:rollback||wall<0?'wall clock rollback observed; monotonic duration retained':null,from,to};
 return{state:'unknown',milliseconds:null,wallEstimateMs:!rollback&&Number.isFinite(wall)&&wall>=0?wall:null,reason:rollback||wall<0?'wall clock rollback; no comparable monotonic endpoints':!a||!b?'monotonic endpoint missing; wall time unverified':'cross-process wall time unverified',from,to};
}
export type SegmentKind='queue'|'user-wait'|'active'|'recovery-offline';
export interface Segment {kind:SegmentKind;start:TimePoint;end:TimePoint|null;duration:Duration}
export function taskClocks(admission:MetricFact,facts:MetricFact[],started:MetricFact|undefined,ended:MetricFact|undefined,acceptance:{firstValid:{source:string;occurredAt:string;clock:FactClock|null;outcome:string}|null},asOf:string) {
 const start=point(admission),finish=ended?point(ended):null;
 const chronological=[admission,...facts.filter(f=>f.ref.seq>admission.ref.seq)].sort((a,b)=>a.ref.seq-b.ref.seq);
 const rollback=chronological.some((f,i)=>i>0&&Date.parse(f.ref.at)<Date.parse(chronological[i-1].ref.at));
 const execution=duration(start,finish,asOf,rollback);
 const first=acceptance.firstValid;
 const accepted=duration(start,first?{source:first.source,at:first.occurredAt,clock:first.clock}:null,asOf,rollback);
 const segments:Segment[]=[];
 const add=(kind:SegmentKind,a:TimePoint,b:TimePoint|null)=>segments.push({kind,start:a,end:b,duration:duration(a,b,asOf,rollback)});
 add('queue',start,started?point(started):finish);
 const pending=new Map<string,{kind:SegmentKind;point:TimePoint}>();
 for(const fact of facts) {
  if(ended&&fact.ref.seq>ended.ref.seq)continue;
  const d=fact.data,k=fact.ref.kind;
  if(k==='model.intent'&&d.attemptId)pending.set(`model:${d.attemptId}`,{kind:'active',point:point(fact)});
  if(k==='tool.dispatch'&&d.attemptId)pending.set(`tool:${d.attemptId}`,{kind:'active',point:point(fact)});
  const key=k==='model.response'?`model:${d.attemptId}`:['tool.result','tool.error'].includes(k)?`tool:${d.attemptId}`:null;
  if(key&&pending.has(key)){const a=pending.get(key)!;add(a.kind,a.point,point(fact));pending.delete(key);}
  if(k==='run.closed'&&(d.status==='unknown'||d.cleanup!=='confirmed'))pending.set('recovery',{kind:'recovery-offline',point:point(fact)});
  if(k==='recovery.report'&&!pending.has('recovery')&&d.status!=='completed'&&d.status!=='ended')pending.set('recovery',{kind:'recovery-offline',point:point(fact)});
  if(k==='recovery.started'&&pending.has('recovery')){add('recovery-offline',pending.get('recovery')!.point,point(fact));pending.delete('recovery');}
  // Explicit host phase boundaries are optional. No wait is guessed from steer,
  // tool text, lack of output or the interval between two arbitrary messages.
  if(k==='task.phase'&&['user-wait','recovery-offline'].includes(d.phase)&&d.id){if(d.action==='start')pending.set(`phase:${d.id}`,{kind:d.phase,point:point(fact)});if(d.action==='end'&&pending.has(`phase:${d.id}`)){const a=pending.get(`phase:${d.id}`)!;add(a.kind,a.point,point(fact));pending.delete(`phase:${d.id}`);}}
 }
 for(const a of pending.values())add(a.kind,a.point,null);
 // Sweep on the parent's exact monotonic axis. Overlapping child active spans
 // form a union; mutually exclusive phase overlaps are unresolved time.
 const axis=start.clock?.processId,total=execution.milliseconds;
 const usable=segments.filter(s=>s.end&&s.start.clock?.processId===axis&&s.end.clock?.processId===axis&&s.duration.state==='measured');
 const bounds=total===null?[]:[0,total,...usable.flatMap(s=>[s.start.clock!.monotonicMs-start.clock!.monotonicMs,s.end!.clock!.monotonicMs-start.clock!.monotonicMs])].filter(n=>n>=0&&n<=total).sort((a,b)=>a-b);
 const measured:Record<SegmentKind|'unknown',number|null>={queue:0,'user-wait':0,active:0,'recovery-offline':0,unknown:total===null?null:0};
 let overlapMs=0;
 for(let i=1;i<bounds.length;i++){const a=bounds[i-1],b=bounds[i];if(a===b)continue;const covered=new Set(usable.filter(s=>s.start.clock!.monotonicMs-start.clock!.monotonicMs<=a&&s.end!.clock!.monotonicMs-start.clock!.monotonicMs>=b).map(s=>s.kind));if(covered.size===1)measured[[...covered][0]]!+=b-a;else {measured.unknown!+=b-a;if(covered.size>1)overlapMs+=b-a;}}
 // For unknown parent spans, retain measured segments but do not fabricate their
 // sum as a complete duration or sum potentially overlapping subprocesses.
 if(total===null)for(const kind of ['queue','user-wait','active','recovery-offline'] as const)measured[kind]=!started&&kind==='active'?0:null;
 return{execution,acceptance:accepted,acceptanceOutcome:first?.outcome??'unknown',rollback,segments,partition:{unit:'ms',measured,overlapMs,totalState:total===null?'unknown':'partial',scope:'measured non-overlapping portions of managed task execution; uncovered time and unsupported waits remain unknown; external process termination is not inferred'}};
}
export function durationSummary(values:Duration[]) {
 const measured=values.flatMap(v=>v.state==='measured'&&v.milliseconds!==null?[v.milliseconds]:[]).sort((a,b)=>a-b);
 const percentile=(p:number)=>measured.length?measured[Math.max(0,Math.ceil(measured.length*p)-1)]:null;
 return{unit:'ms',state:!values.length?'N/A':measured.length===values.length?'known':measured.length?'partial':'unknown',total:values.length,valid:measured.length,missing:values.length-measured.length,pending:values.filter(v=>v.state==='pending').length,sum:measured.length?measured.reduce((n,v)=>n+v,0):null,mean:measured.length?measured.reduce((n,v)=>n+v,0)/measured.length:null,p50:percentile(.5),p95:percentile(.95),method:'nearest rank; measured completed endpoints only; open waiting excluded'};
}
