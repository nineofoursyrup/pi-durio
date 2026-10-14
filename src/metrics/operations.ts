import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {digest,readObject} from '../evidence.js';
import {records,decode,resolveEvidence,watermark,type EvidenceReference} from '../history.js';
import {queryTaskMetrics,type MetricsScope} from './report.js';
import {costReport} from './costs.js';
import {faultReport} from './faults.js';
export interface OperationFact {ref:EvidenceReference;data:any;missing?:string}
export interface OperationRun {root:string;parentImprove?:{dataRoot:string;decisionId:string;decisionSource:string;linkSource:string};id:string;facts:OperationFact[];admission?:OperationFact;kind:string;source:string|null;project:string|null}
const excludedKinds=new Set(['model.payload','model.provider-event','model.fetch-intent','generation.request','context.snapshot','compaction.source','durable.closed-snapshot','tool.output','shell.stdout','shell.stderr','eval.content','execution.artifact']);
/** Read bounded original facts. There is no writable store, execution or classifier. */
export function operationRuns(root:string,through:number) {
 const runs=new Map<string,OperationRun>();let count=0,bytes=0;
 for(const ref of records(root,{through})){
  if(excludedKinds.has(ref.kind))continue;bytes+=ref.ref.bytes;if(++count>30000||bytes>32*1024*1024)throw Error('OPERATIONS_SCOPE_TOO_LARGE');
  let run=runs.get(ref.runId);if(!run){run={root,id:ref.runId,facts:[],kind:'unknown',source:null,project:null};runs.set(ref.runId,run);}
  let f:OperationFact;try{f={ref,data:decode(root,ref)};}catch(error){f={ref,data:{},missing:String(error)};}
  run.facts.push(f);
  if(ref.kind==='task.accepted'&&!run.admission){run.admission=f;const d=f.data;run.kind=d.origin?.kind??d.taskKind??d.kind??(d.mode?'coding':'unknown');run.source=d.origin?.source??d.sourceClass??(d.mode==='offline'?'synthetic':d.mode==='live'?'ordinary':null);run.project=d.projectId??d.workspace??null;}
  if(ref.kind==='eval.plan'){run.kind='eval';run.source=f.data.mode==='offline'?'synthetic':f.data.mode==='live'?'ordinary':null;}
 }
 return [...runs.values()];
}
export function queryOperationsMetrics(root:string,scope:MetricsScope={}) {
 const sample=queryTaskMetrics(root,scope),parentRuns=operationRuns(root,sample.scope.through);
 const children=ownedChildren(root,sample,parentRuns),runs=[...parentRuns,...children.runs];
 const included=runs.filter(r=>(r.source===sample.scope.source||r.source===null)&&(!sample.scope.project||r.project===sample.scope.project||r.project===null));
 const body={schema:'pi-durio-operations-metrics-v1',ruleVersion:'llmops-r1/cost-fault-v1',sample,costs:costReport(root,sample,included,children.gaps.filter(g=>included.some(r=>r.root===root&&r.id===g.runId))),faults:faultReport(root,sample,included),ownedChildren:{snapshots:children.snapshots,gaps:children.gaps},excludedRuns:runs.filter(r=>!included.includes(r)).map(r=>({runId:r.id,kind:r.kind,source:r.source,reason:'source/project filter'})),limits:['Estimates are not bills; currencies are never implicitly converted.','Known-part/S is partial, not a final amount or a proven lower bound.','Daily accepted coding tasks, formal eval plans, synthetic and diagnostic sources remain separate.','Only acquired host boundaries are observable; SDK/provider hidden attempts are not guessed.','Read-only reports do not invoke execution, models, grading, or append cost entries.']};
 const {generatedAt,...sampleIdentity}=sample;
 return {id:`operations:${digest(JSON.stringify({...body,sample:{...sampleIdentity,snapshot:{...sample.snapshot,current:sample.scope.through}}}))}`,generatedAt:new Date().toISOString(),...body};
}
export type OperationsMetricsReport=ReturnType<typeof queryOperationsMetrics>;
export function formatOperationsMetrics(report:OperationsMetricsReport){const f=report.faults;return `成本与故障 · 只读 · ${report.id}\n样本 N/B/S = ${report.sample.counts.N}/${report.sample.counts.B}/${report.sample.counts.S} · 全样本成本 ${report.costs.sample.state}\n${Object.entries(report.costs.sample.currencies).map(([currency,v])=>`${currency} 已知 ${v.knownAmount} / S${report.sample.counts.S}：${v.perSuccess.state} ${v.perSuccess.value??'unknown'}；已知部分/S ${v.perSuccess.knownPartPerSuccess??'N/A'}（非下界）`).join('\n')}\n故障 B/F/Zf/Uf = ${f.tasks.counts.B}/${f.tasks.counts.F}/${f.tasks.counts.Zf}/${f.tasks.counts.Uf}\n${JSON.stringify(report,null,2)}`;}

/** Follow only host-owned, parent-decision-bound child roots. A retained parent
 * report fixes the child sequence; a bare link exposes only the fixed plan. */
function ownedChildren(root:string,sample:ReturnType<typeof queryTaskMetrics>,parents:OperationRun[]) {
 const children:OperationRun[]=[],snapshots:any[]=[],gaps:{runId:string;source:string;reason:string;mayAffectSample:boolean}[]=[],seen=new Set<string>();
 for(const parentRun of parents)for(const link of parentRun.facts.filter(f=>f.ref.kind==='improve.eval')){
  try{
   const d=link.data,p=d.parent,s=d.planSource;
   if(!p||typeof p.dataRoot!=='string'||realpathSync(p.dataRoot)!==realpathSync(root)||!s||s.scope!=='child-data-root'||s.dataRoot!==d.dataRoot||!Number.isSafeInteger(s.sequence)||s.sequence<1||!/^[a-f0-9]{64}$/.test(s.digest))throw Error('unverified scoped parent/child reference');
   const decision=parentRun.facts.find(f=>f.ref.id===p.decisionSource&&f.ref.kind==='improve.decision'&&f.data.id===p.decisionId&&f.ref.seq<link.ref.seq),value=decision?.data.decision;
   if(!value||typeof value.directory!=='string'||!/^[-\w.]{1,64}$/.test(d.groupId)||['.','..'].includes(d.groupId)||!Number.isSafeInteger(d.index)||d.index<0||value.groups?.find((g:any)=>g.id===d.groupId)?.checks?.[d.index]?.kind!=='fresh')throw Error('child is not an owned fresh-eval check');
   const expected=join(value.directory,d.groupId,`check-${d.index}`,'eval-data');
   if(resolve(expected)!==resolve(d.dataRoot)||realpathSync(d.dataRoot)!==join(realpathSync(value.directory),d.groupId,`check-${d.index}`,'eval-data'))throw Error('child root path is changed or aliased');
   const childRoot=realpathSync(d.dataRoot),key=`${childRoot}#${d.planId}`;
   if(seen.has(key))continue;if(seen.size>=50)throw Error('owned child query limit');seen.add(key);
   const planId=`e1:${s.sequence}:${s.digest}`,planRef=resolveEvidence(childRoot,planId),plan=decode(childRoot,planRef);
   if(planRef.kind!=='eval.plan'||planRef.runId!==d.planId||plan.id!==d.planId)throw Error('child fixed plan identity mismatch');
   const check=parentRun.facts.findLast(f=>f.ref.kind==='improve.check'&&f.data.id===p.decisionId&&f.data.groupId===d.groupId&&f.data.index===d.index&&f.data.planId===d.planId&&f.data.dataRoot===d.dataRoot&&f.data.reportOrigin?.dataRoot===d.dataRoot&&f.data.reportOrigin?.planId===d.planId);
   let maximum=s.sequence;
   if(check){if(check.data.reportDocument?.bytes>4*1024*1024)throw Error('child report snapshot too large');const report=JSON.parse(readObject(root,check.data.reportDocument).toString());if(report.planId!==d.planId||report.planSource!==planId||!Number.isSafeInteger(report.asOf)||report.asOf<s.sequence||report.asOf>watermark(childRoot))throw Error('child report snapshot identity/cutoff mismatch');maximum=report.asOf;}
   else gaps.push({runId:parentRun.id,source:link.ref.id,reason:'parent cutoff has no retained child execution snapshot; only fixed plan is visible, later child work remains unknown',mayAffectSample:false});
   let through=0;for(const ref of records(childRoot,{through:maximum})){if(!Number.isFinite(Date.parse(ref.at))||Date.parse(ref.at)>Date.parse(sample.scope.asOf))break;through=ref.seq;}
   const childRuns=operationRuns(childRoot,through).filter(r=>r.id===d.planId);
   for(const run of childRuns){run.project=parentRun.project??decision?.data.workspace??null;run.parentImprove={dataRoot:root,decisionId:p.decisionId,decisionSource:p.decisionSource,linkSource:link.ref.id};}
   children.push(...childRuns);snapshots.push({dataRoot:childRoot,planId:d.planId,planSource:s,through,maximum,asOf:sample.scope.asOf,parentSource:link.ref.id,parentCheckSource:check?.ref.id??null,basis:'parent-retained child report sequence, bounded by the same acquisition asOf; no child writes or recursive directory scanning'});
  }catch(error){gaps.push({runId:parentRun.id,source:link.ref.id,reason:String(error),mayAffectSample:false});}
 }
 return{runs:children,snapshots,gaps};
}
