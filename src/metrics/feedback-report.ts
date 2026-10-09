import {digest} from '../evidence.js';
import {decode,records,resolveEvidence,type EvidenceReference} from '../history.js';
import {feedbackHistory,type FeedbackFact} from './feedback.js';
import {queryTaskMetrics,ratio,type MetricsScope,type TaskMetricsReport} from './report.js';
const DAY=24*60*60*1000,WINDOW=7*DAY;
type Task=TaskMetricsReport['tasks'][number];
function available(root:string,id:string,through:number){try{const ref=resolveEvidence(root,id);if(ref.seq>through)return false;decode(root,ref);return true;}catch{return false;}}
function deliveryFacts(root:string,task:Task,through:number){
 const facts:{ref:EvidenceReference;data:any}[]=[],missing:{source:string;reason:string}[]=[];
 for(const ref of records(root,{runId:task.evidenceRunId,through,kinds:['run.started','run.closed','recovery.closed','recovery.ended']})){try{facts.push({ref,data:decode(root,ref)});}catch(error){missing.push({source:ref.id,reason:String(error)});}}
 const start=facts.find(f=>f.ref.id===task.startedSource),normal=facts.filter(f=>{const d=f.data.result??f.data;return start&&f.ref.seq>start.ref.seq&&['run.closed','recovery.closed'].includes(f.ref.kind)&&d.status==='completed'&&d.cleanup==='confirmed'&&typeof d.answer==='string'&&!!d.answer.trim();});
 const first=normal[0],uncertain=missing.some(m=>!first||Number(m.source.split(':')[1])<first.ref.seq);
 const delivery=first&&!uncertain?{source:first.ref.id,at:first.ref.at,answerSource:first.ref.id,clock:first.data.clock??null,definition:'first host normal completion with retained result/conclusion; acceptance is separate'}:null;
 const terminal=facts.find(f=>start&&f.ref.seq>start.ref.seq&&(f.ref.kind==='recovery.ended'||['completed','failed','aborted','cancelled','timed-out'].includes((f.data.result??f.data).status)&&(f.data.result??f.data).cleanup==='confirmed'));
 const end=first&&(!terminal||first.ref.seq<=terminal.ref.seq)?first:terminal;
 return{delivery,redeliveries:normal.slice(1).map(f=>({source:f.ref.id,at:f.ref.at})),start:start?{source:start.ref.id,at:start.ref.at}:null,end:end?{source:end.ref.id,at:end.ref.at}:null,missing,uncertain};
}
function assessments(root:string,task:Task,through:number,asOf:string){
 const admission=resolveEvidence(root,task.acceptedSource),history=feedbackHistory(root,admission.runId,task.taskId,through);
 const withdrawn=new Set(history.facts.flatMap(f=>f.data.type==='withdraw'?f.data.targets:[])),superseded=new Set(history.facts.flatMap(f=>f.data.type==='observation'&&f.data.revisionOf?[f.data.revisionOf]:[]));
 const branchRoots=new Set<string>();for(const f of history.facts){if(f.data.type!=='observation'||!f.data.revisionOf)continue;const revisionOf=f.data.revisionOf;if(history.facts.filter(p=>p.data.type==='observation'&&p.data.revisionOf===revisionOf).length>1)branchRoots.add(revisionOf);}
 const ancestor=(f:FeedbackFact):string[]=>{const path:string[]=[];let at=f;while(at.data.type==='observation'&&at.data.revisionOf&&!path.includes(at.data.revisionOf)){const revisionOf=at.data.revisionOf;path.push(revisionOf);const next=history.facts.find(p=>p.data.id===revisionOf);if(!next)break;at=next;}return path;};
 const items=history.facts.filter(f=>f.data.type==='observation').map(f=>{
  const d=f.data;if(d.type!=='observation')throw Error('UNREACHABLE');
  const sources=[...d.source.refs,...d.requirements,...d.repairSources??[],...d.resultSources??[],...d.delivery?[d.delivery]:[]];
  const missing=sources.filter(id=>!available(root,id,through)),conflict=ancestor(f).some(id=>branchRoots.has(id));
  const active=!withdrawn.has(d.id)&&!superseded.has(d.id),reasons:string[]=[];
  if(!active)reasons.push(withdrawn.has(d.id)?'explicitly withdrawn':'superseded; original retained');
  if(conflict)reasons.push('unresolved revision branches');if(missing.length)reasons.push('original evidence unavailable');
  if(d.ruleVersion!=='explicit-feedback-v1')reasons.push('unsupported classification rule');
  if(d.source.kind==='unverified')reasons.push('unverified/ambiguous feedback');
  if(!d.requirements.length)reasons.push('original requirement scope unknown');
  if(d.occurredAt!==null&&Date.parse(d.occurredAt)>Date.parse(asOf))reasons.push('occurrence is after asOf');
  const trusted=active&&!conflict&&!missing.length&&d.ruleVersion==='explicit-feedback-v1'&&d.source.kind!=='unverified'&&d.requirements.length>0;
  let classification:'positive'|'negative'|'excluded'|'unknown'='unknown';
  if(trusted&&d.meaning==='correction'&&d.originalRequirement==='unmet'&&['requested','started','completed'].includes(d.correction??''))classification='positive';
  else if(trusted&&d.meaning==='none'&&d.source.kind==='human'&&d.coverage)classification='negative';
  else if(trusted&&['normal-authorization','clarification','new-requirement','improve-choice'].includes(d.meaning))classification='excluded';
  else if(active)reasons.push('explicit confirmed correction or whole-period human absence evidence unavailable');
  return{id:d.id,source:f.ref.id,seq:f.ref.seq,active,conflict,classification,reasons,missing,input:d,occurredAt:d.occurredAt,receivedAt:f.ref.at,sourceRefs:sources};
 });
 return{items,history:history.facts.map(f=>({id:f.data.id,type:f.data.type,source:f.ref.id,receivedAt:f.ref.at,input:f.data,withdrawn:withdrawn.has(f.data.id),superseded:superseded.has(f.data.id)})),missing:history.missing};
}
function rates(positive:number,negative:number,unknown:number){const n=positive+negative+unknown;return{rate:ratio(positive,n),coverage:ratio(positive+negative,n),completeRate:n?(unknown?'unknown':'known'):'N/A',logicalRange:n?[positive/n,(positive+unknown)/n]:null,rangeMeaning:'logical bounds, not a confidence interval'};}
/** Query only. Intervention uses admission population; rework independently uses
 * first-delivery population, including tasks admitted before the window. */
export function queryFeedbackMetrics(root:string,input:MetricsScope={}){
 const sample=queryTaskMetrics(root,input),scope=sample.scope;
 const deliverySample=queryTaskMetrics(root,{...scope,from:'1970-01-01T00:00:00.000Z',to:scope.asOf});
 const all=[...new Map([...sample.tasks,...deliverySample.tasks].map(t=>[t.taskId,t])).values()];
 const details=all.map(task=>({taskId:task.taskId,runId:task.runId,version:task.version,project:task.project,acceptedSource:task.acceptedSource,acceptedAt:task.acceptedAt,acceptance:task.acceptance.outcome,requirementsChanged:task.acceptance.requirementsChanged,requirements:task.acceptance.requirements,results:task.acceptance.results,...deliveryFacts(root,task,scope.through),feedback:assessments(root,task,scope.through,scope.asOf)}));
 const select=(detail:typeof details[number],dimension:'intervention'|'rework',from:string|null,to:string|null)=>detail.feedback.items.filter(e=>e.active&&e.input.dimension===dimension).map(e=>{
  let position='unknown-time';const at=e.occurredAt===null?NaN:Date.parse(e.occurredAt);
  if(Number.isFinite(at)&&at>Date.parse(scope.asOf))position='after-asOf';
  else if(from&&Number.isFinite(at)){position=at<Date.parse(from)?'before-window':to&&at>=Date.parse(to)?'outside-window':'inside-window';}
  // Intervention ending point is inclusive; a human rescue at that receipt is still during execution.
  if(dimension==='intervention'&&to&&at===Date.parse(to))position='inside-window';
  const linked=dimension==='intervention'||!e.input.delivery||e.input.delivery===detail.delivery?.source;
  const negative=e.classification==='negative'&&!!from&&!!to&&!!e.input.coverage&&Date.parse(e.input.coverage.from)<=Date.parse(from)&&Date.parse(e.input.coverage.to)>=Date.parse(to)&&e.occurredAt!==null&&Date.parse(e.occurredAt)>=Date.parse(to)&&Date.parse(e.occurredAt)<=Date.parse(scope.asOf);
  const observedPositive=e.classification==='positive'&&position==='inside-window'&&linked;
  const positive=observedPositive&&!detail.feedback.missing.length;
  return{...e,position,linked,observedPositive,positive,negative:negative&&linked};
 });
 const members=new Set(sample.tasks.map(t=>t.taskId));
 const interventionTasks=details.filter(t=>members.has(t.taskId)).map(t=>{const events=select(t,'intervention',t.start?.at??null,t.end?.at??null),positive=events.some(e=>e.positive),negative=events.some(e=>e.negative)&&!t.feedback.missing.length&&!t.missing.length&&!events.some(e=>e.classification==='positive'&&e.position==='unknown-time'||e.conflict);return{...t,events,state:!t.start?'unstarted':!t.end?'open':positive?'I':negative?'Z':'U',positive};});
 const Ni=interventionTasks.filter(t=>!['open','unstarted'].includes(t.state)).length,I=interventionTasks.filter(t=>t.state==='I').length,Z=interventionTasks.filter(t=>t.state==='Z').length,U=Ni-I-Z;
 const reworkTasks=details.filter(t=>t.delivery&&Date.parse(t.delivery.at)>=Date.parse(scope.from)&&Date.parse(t.delivery.at)<Date.parse(scope.to)).map(t=>{
  const end=new Date(Date.parse(t.delivery!.at)+WINDOW).toISOString(),events=select(t,'rework',t.delivery!.at,end),positive=events.some(e=>e.positive),mature=Date.parse(scope.asOf)>=Date.parse(end),negative=events.some(e=>e.negative)&&!t.feedback.missing.length&&!events.some(e=>e.classification==='positive'&&e.position==='unknown-time'||e.conflict);
  return{...t,window:{from:t.delivery!.at,to:end,unit:'ms',duration:WINDOW,bounds:'[from,to)'},mature,positive,events,state:!mature?'immature':positive?'Rr':negative?'Zr':'Ur'};
 });
 const Nr=reworkTasks.filter(t=>t.mature).length,Rr=reworkTasks.filter(t=>t.state==='Rr').length,Zr=reworkTasks.filter(t=>t.state==='Zr').length,Ur=Nr-Rr-Zr;
 const report={schema:'pi-durio-feedback-metrics-v1',ruleVersion:'llmops-r1/explicit-feedback-v1',scope,snapshot:sample.snapshot,intervention:{selection:'acceptedAt in [from,to); observations start through first delivery or true termination',counts:{Ni,I,Z,U,events:interventionTasks.filter(t=>!['open','unstarted'].includes(t.state)).flatMap(t=>t.events.filter(e=>e.positive)).length,unstarted:interventionTasks.filter(t=>t.state==='unstarted').length,open:interventionTasks.filter(t=>t.state==='open').length,openPositive:interventionTasks.filter(t=>t.state==='open'&&t.positive).length},...rates(I,Z,U),tasks:interventionTasks,excluded:sample.excluded},rework:{selection:'first host delivery in [from,to), independent of admission window; acceptance not required',counts:{Nr,Rr,Zr,Ur,events:reworkTasks.filter(t=>t.mature).flatMap(t=>t.events.filter(e=>e.positive)).length,immature:reworkTasks.filter(t=>!t.mature).length,immaturePositive:reworkTasks.filter(t=>!t.mature&&t.positive).length},...rates(Rr,Zr,Ur),tasks:reworkTasks,excluded:[...deliverySample.excluded,...details.filter(t=>!t.delivery||Date.parse(t.delivery.at)<Date.parse(scope.from)||Date.parse(t.delivery.at)>=Date.parse(scope.to)).map(t=>({taskId:t.taskId,source:t.acceptedSource,reasons:[!t.delivery?'no reliable host normal delivery':'first delivery outside selection window'],delivery:t.delivery,feedback:t.feedback,missing:t.missing}))]},limits:['Explicit feedback is scoped human/action evidence, not model classification or a mandatory task rating.','No complaint, complete logs, steer counts, PASS or file changes prove absence of rescue or rework.','Occurrence time is declared; acquisition prefix and asOf bound when evidence was known. Missing times retain unknown window attribution.','Redelivery never resets the seven-day window. New repair tasks retain their own identity and cost.','Wall-clock timestamps determine these calendar windows; clock gaps and missing originals remain visible.','Descriptive observations do not establish model causality, authorize rollback, or replace controlled eval regression or human daily-use acceptance.']};
 const id=`feedback:${digest(JSON.stringify({...report,snapshot:{...report.snapshot,current:scope.through}}))}`;
 return{id,generatedAt:new Date().toISOString(),revisionOf:scope.revisionOf??null,...report};
}
export type FeedbackMetricsReport=ReturnType<typeof queryFeedbackMetrics>;
export function formatFeedbackMetrics(r:FeedbackMetricsReport){const p=(v:ReturnType<typeof ratio>)=>v.value===null?'N/A':`${(v.value*100).toFixed(1)}%`;return `人工介入与交付后返工 · 只读 · ${r.id}\n介入 ${r.intervention.counts.I}/${r.intervention.counts.Ni} = ${p(r.intervention.rate)} · 覆盖 ${p(r.intervention.coverage)} · 未知 ${r.intervention.counts.U}\n成熟返工 ${r.rework.counts.Rr}/${r.rework.counts.Nr} = ${p(r.rework.rate)} · 覆盖 ${p(r.rework.coverage)} · 未知 ${r.rework.counts.Ur} · 未成熟阳性 ${r.rework.counts.immaturePositive}\n${JSON.stringify(r,null,2)}`;}
