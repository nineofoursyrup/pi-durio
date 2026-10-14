import {digest,readAcceptedTasks,type AcceptedTaskFact} from '../evidence.js';
import {records,decode,watermark,type EvidenceReference} from '../history.js';
import {selectAcceptance} from './acceptance.js';
import {taskClocks,durationSummary,type MetricFact} from './clocks.js';

export interface MetricsScope {from?:string;to?:string;asOf?:string;project?:string;taskType?:string;version?:string;source?:'ordinary'|'synthetic'|'diagnostic';through?:number;revisionOf?:string}
const taskKinds=['task.accepted','run.started','run.closed','recovery.started','recovery.closed','recovery.ended','recovery.report','execution.artifact','model.intent','model.response','tool.dispatch','tool.result','tool.error','task.phase','evidence.gap'];
const safeDecode=(root:string,ref:EvidenceReference):MetricFact=>{try{return{ref,data:decode(root,ref)};}catch(error){return{ref,data:{},missing:String(error)};}};
const countBy=(values:(string|null)[])=>Object.fromEntries([...new Set(values.map(v=>v??'unknown'))].sort().map(v=>[v,values.filter(x=>(x??'unknown')===v).length]));
export function ratio(numerator:number,denominator:number) {return{numerator,denominator,value:denominator?numerator/denominator:null,state:denominator?'known':'N/A',unit:'ratio'};}
function origin(data:any,sourceData?:any):{kind:string|null;source:string|null;taskType:string|null;parentTaskId:string|null;trialId:string|null} {
 const d=data.origin??{},legacy=data.taskKind??data.kind;
 const kind=d.kind??(['coding','eval','improve','maintenance'].includes(legacy)?legacy:data.mode?'coding':null);
 const source=d.source??data.sourceClass??(data.mode==='offline'?'synthetic':data.mode==='live'?'ordinary':sourceData?origin(sourceData).source:null);
 return{kind:kind??(data.kind==='follow-up'?'coding':null),source:source??null,taskType:d.taskType??data.taskType??null,parentTaskId:d.parentTaskId??data.parentTaskId??null,trialId:d.trialId??null};
}
function validate(input:MetricsScope) {
 for(const key of Object.keys(input))if(!['from','to','asOf','project','taskType','version','source','through','revisionOf'].includes(key))throw Error('INVALID_METRICS_SCOPE');
 const asOf=input.asOf??new Date().toISOString(),from=input.from??'1970-01-01T00:00:00.000Z',to=input.to??asOf;
 if([asOf,from,to].some(t=>!Number.isFinite(Date.parse(t)))||Date.parse(from)>Date.parse(to))throw Error('INVALID_METRICS_TIME');
 if(input.source&&!['ordinary','synthetic','diagnostic'].includes(input.source))throw Error('INVALID_METRICS_SOURCE');
 for(const key of ['project','taskType','version','revisionOf'] as const)if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]!.length))throw Error('INVALID_METRICS_SCOPE');
 return{...input,from,to,asOf,source:input.source??'ordinary'};
}
/** Snapshot is a received-evidence prefix. A wall-clock rollback never lets a
 * later append leak behind a historical cutoff. Exact seq can reproduce a report. */
function snapshotAt(root:string,asOf:string,requested?:number) {
 const current=watermark(root),maximum=requested??current;
 if(!Number.isSafeInteger(maximum)||maximum<0||maximum>current)throw Error('INVALID_METRICS_SNAPSHOT');
 let through=0,previous=-Infinity,rollback=false,blockedAt:string|null=null;
 for(const ref of records(root,{through:maximum})){
  const at=Date.parse(ref.at);if(!Number.isFinite(at)||at>Date.parse(asOf)){blockedAt=ref.id;break;}
  if(at<previous)rollback=true;previous=at;through=ref.seq;
 }
 return{current,through,blockedAt,rollback,policy:'acquisition sequence prefix bounded by asOf; never include later received evidence behind a rollback'};
}
function taskState(facts:MetricFact[],admission:MetricFact,task:AcceptedTaskFact,queue:MetricFact[]) {
 const started=facts.find(f=>f.ref.kind==='run.started'),close=facts.findLast(f=>['run.closed','recovery.closed','recovery.ended'].includes(f.ref.kind));
 const data=close?.data.result??close?.data;
 const confirmed=close?.ref.kind==='recovery.ended'||close&&data.cleanup==='confirmed'&&['completed','failed','aborted','cancelled','timed-out'].includes(data.status);
 const resumed=close&&facts.some(f=>f.ref.kind==='recovery.started'&&f.ref.seq>close.ref.seq);
 let end=confirmed&&!resumed?close:undefined;
 const receipt=queue.filter(f=>f.data.requestId===task.requestId).at(-1);
 if(!started&&receipt?.data.status==='withdrawn')end=receipt;
 const status=receipt&&end===receipt?'cancelled':end?.ref.kind==='recovery.ended'?'ended':resumed?'running':data?.status??receipt?.data.status??(started?'running':'accepted');
 return{started,ended:end,status,reason:receipt&&end===receipt?receipt.data.reason:data?.reason??receipt?.data.reason??(!end?'no confirmed termination':null),normal:!!started&&!!end&&data?.status==='completed'&&end.ref.kind!=='recovery.ended',terminationScope:'managed product execution; provider/external effects retain their original unknowns',admission:admission.ref.id};
}

/** Shared read-only input for #28/#29. No Harness, provider or writable DB is opened. */
export function queryTaskMetrics(root:string,input:MetricsScope={}) {
 const scope=validate(input),snapshot=snapshotAt(root,scope.asOf,scope.through),through=snapshot.through;
 const admissions:AcceptedTaskFact[]=[];let after:number|undefined;
 do {const page=readAcceptedTasks(root,{through,after,limit:200});admissions.push(...page.tasks.filter(t=>Date.parse(t.acceptedAt)>=Date.parse(scope.from)&&Date.parse(t.acceptedAt)<Date.parse(scope.to)));after=page.next??undefined;if(admissions.length>10000)throw Error('METRICS_SCOPE_TOO_LARGE: narrow the admission window');}while(after);
 const neededSequences=new Set(admissions.map(t=>t.acceptedSeq)),followups=new Set(admissions.filter(t=>t.kind==='follow-up').map(t=>t.requestId));
 const neededSourceRuns=new Set(admissions.flatMap(t=>t.target?[t.target.runId]:[])),admissionFacts:MetricFact[]=[];
 for(const ref of records(root,{through,kinds:['task.accepted','control.accepted']})){if(neededSequences.has(ref.seq)||ref.kind==='task.accepted'){const fact=safeDecode(root,ref);if(neededSequences.has(ref.seq)||neededSourceRuns.has(ref.runId)||followups.has(fact.data.queueRequestId))admissionFacts.push(fact);}}
 const receipts=[...records(root,{through,kinds:['control.receipt']})].map(ref=>safeDecode(root,ref));
 const excluded:{taskId:string;source:string;reasons:string[];kind:string|null;sourceClass:string|null;version:string|null;taskType:string|null}[]=[];
 const duplicates:{taskId:string;source:string;reason:string}[]=[];
 const tasks:ReturnType<typeof member>[]=[];
 const seen=new Map<string,AcceptedTaskFact>();
 function member(task:AcceptedTaskFact,admission:MetricFact,identity:ReturnType<typeof origin>,facts:MetricFact[],runId:string|null,version:string|null) {
  const state=taskState(facts,admission,task,receipts);
  const acceptance=selectAcceptance(root,task.taskId,runId,through,scope.asOf,admission.ref.runId);
  if(facts.some(f=>f.missing)){acceptance.outcome='unknown';acceptance.firstValid=null;acceptance.reasons.push('original source content unavailable');}
  return{taskId:task.taskId,requestId:task.requestId,runId:state.started?runId:null,evidenceRunId:runId??admission.ref.runId,project:admission.data.projectId??task.workspace,workspace:task.workspace,kind:identity.kind,sourceClass:identity.source,taskType:identity.taskType,parentTaskId:identity.parentTaskId,trialId:identity.trialId,version,expectedVersion:task.executionVersion?.artifactId??null,acceptedAt:task.acceptedAt,acceptedSource:admission.ref.id,startedSource:state.started?.ref.id??null,terminationSource:state.ended?.ref.id??null,status:state.status,reason:state.reason,normalCompleted:state.normal,terminated:!!state.ended,terminationScope:state.terminationScope,acceptance,clocks:taskClocks(admission,[...facts,...receipts.filter(r=>r.data.requestId===task.requestId)],state.started,state.ended,acceptance,scope.asOf),missing:facts.filter(f=>f.missing||f.ref.kind==='evidence.gap').map(f=>({source:f.ref.id,reason:f.missing??f.data.reason??'collection gap'})),sources:facts.map(f=>f.ref.id)};
 }
 for(const admitted of admissions) {
  const admission=admissionFacts.find(f=>f.ref.seq===admitted.acceptedSeq)!;
  const at=Date.parse(admitted.acceptedAt),reasons:string[]=[];
  if(at<Date.parse(scope.from)||at>=Date.parse(scope.to)){continue;}
  const previous=seen.get(admitted.taskId)??seen.get(`request:${admitted.requestId}`);
  if(previous){duplicates.push({taskId:admitted.taskId,source:admission.ref.id,reason:previous.input===admitted.input&&previous.workspace===admitted.workspace?'repeated immutable admission identity':'conflicting admission identity; first receipt retained, inspect sources'});continue;}
  seen.set(admitted.taskId,admitted);seen.set(`request:${admitted.requestId}`,admitted);
  const sourceAdmission=admissionFacts.find(f=>f.ref.kind==='task.accepted'&&f.ref.runId===admission.ref.runId);
  const identity=origin(admission.data,admission.ref.kind==='control.accepted'?sourceAdmission?.data:undefined);
  // A dispatch can commit task/start facts before its queue receipt is saved.
  const linked=admitted.kind==='follow-up'?admissionFacts.filter(f=>f.ref.kind==='task.accepted'&&f.data.queueRequestId===admitted.requestId&&f.data.taskId===admitted.taskId):[];
  const runId=admitted.kind==='follow-up'?(linked.length===1?linked[0].ref.runId:admitted.runId):admission.ref.runId;
  const facts=runId?[...records(root,{runId,through,kinds:taskKinds})].map(ref=>safeDecode(root,ref)):[];
  const started=facts.some(f=>f.ref.kind==='run.started'),version=started?facts.find(f=>f.ref.kind==='execution.artifact')?.data.id??null:null;
  const project=admission.data.projectId??admitted.workspace;
  if(scope.project&&scope.project!==project)reasons.push('project filter');
  if(identity.kind!=='coding')reasons.push(identity.kind?`separate ${identity.kind} work`:'unknown work kind');
  if(identity.source!==scope.source)reasons.push(identity.source?`separate ${identity.source} source`:'unknown source class');
  if(scope.taskType&&scope.taskType!==identity.taskType)reasons.push(identity.taskType?'task type filter':'unknown task type');
  if(scope.version&&scope.version!==version)reasons.push(version?'actual execution version filter':'unknown actual execution version');
  if(linked.length>1)reasons.push('ambiguous independent execution linkage');
  if(reasons.length){excluded.push({taskId:admitted.taskId,source:admission.ref.id,reasons,kind:identity.kind,sourceClass:identity.source,taskType:identity.taskType,version});continue;}
  tasks.push(member(admitted,admission,identity,facts,runId,version));
 }
 const N=tasks.length,B=tasks.filter(t=>!!t.startedSource).length,C=tasks.filter(t=>t.normalCompleted).length,G=tasks.filter(t=>t.acceptance.outcome!=='unknown').length,S=tasks.filter(t=>t.acceptance.outcome==='PASS').length;
 const counts={N,B,C,G,S,terminated:tasks.filter(t=>t.terminated).length};
 const rates={success:ratio(S,G),completion:ratio(C,N),coverage:ratio(G,N)};
 const clocks={execution:durationSummary(tasks.map(t=>t.clocks.execution)),executionByStatus:Object.fromEntries([...new Set(tasks.map(t=>t.status))].map(status=>[status,durationSummary(tasks.filter(t=>t.status===status).map(t=>t.clocks.execution))])),acceptance:durationSummary(tasks.map(t=>t.clocks.acceptance)),acceptanceByOutcome:Object.fromEntries(['PASS','FAIL','unknown'].map(outcome=>[outcome,durationSummary(tasks.filter(t=>(t.acceptance.firstValid?.outcome??'unknown')===outcome).map(t=>t.clocks.acceptance))]))};
 const report={schema:'pi-durio-task-metrics-v1',ruleVersion:'llmops-r1/task-acceptance-v1',scope:{...scope,through},snapshot,counts,rates,statusCounts:countBy(tasks.map(t=>t.status)),terminationReasons:countBy(tasks.filter(t=>t.terminated).map(t=>t.reason)),unknown:{taskTypes:tasks.filter(t=>!t.taskType).length,executionVersions:tasks.filter(t=>!t.version).length,acceptance:N-G},clocks,tasks,excluded,duplicates,limits:['Source class is selected explicitly; controlled eval and improve/maintenance are separate populations.','No feedback is unknown. Checks do not prove requirements they do not cover.','Cross-process/missing clock endpoints remain unknown; wall estimates are excluded from means.','Host records cover managed work; remote/external termination and unsaved observations may remain unknown.','Descriptive counts do not authorize changes, claim causal improvement, or establish daily-use acceptance.']};
 const id=`metrics:${digest(JSON.stringify({...report,snapshot:{...snapshot,current:through}}))}`;
 return{id,generatedAt:new Date().toISOString(),revisionOf:scope.revisionOf??null,...report};
}
export type TaskMetricsReport=ReturnType<typeof queryTaskMetrics>;
/** Readable output is a rendering of the same machine report, with every reference retained. */
export function formatTaskMetrics(report:TaskMetricsReport) {
 const percent=(r:ReturnType<typeof ratio>)=>r.value===null?'N/A':`${(r.value*100).toFixed(1)}%`;
 return `任务验收 · 只读 · ${report.id}\nN/B/C/G/S = ${report.counts.N}/${report.counts.B}/${report.counts.C}/${report.counts.G}/${report.counts.S}\n成功率 ${report.rates.success.numerator}/${report.rates.success.denominator} = ${percent(report.rates.success)} · 正常完成率 ${report.rates.completion.numerator}/${report.rates.completion.denominator} = ${percent(report.rates.completion)} · 验证覆盖 ${report.rates.coverage.numerator}/${report.rates.coverage.denominator} = ${percent(report.rates.coverage)}\n${JSON.stringify(report,null,2)}`;
}
