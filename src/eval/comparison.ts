import type {Metric,ComparisonPlan} from '../eval-comparison-plan.js';
export {validateComparison,pairedTrials,type Metric,type RuntimeContent,type ComparisonPlan} from '../eval-comparison-plan.js';

export interface ComparisonTrial {
 id:string;caseId:string;repeat:number;side:string;pair:string|null;version:string;
 outcome:{source?:string;status:string;valid:boolean;reason?:string|null;timing?:{taskMs:number}};
 grade:{judgment:string;graderVersion:string;outcome:string;revision?:string;checks:{name:string;passed:boolean}[]}|null;
 metrics:Record<Exclude<Metric,'task-pass'>,number|null>;metricReasons:Partial<Record<Metric,string>>;
 modelIdentity?:{returned:string[];missing:number};
}
const known=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
function judgment(trial:ComparisonTrial|undefined){return !!trial?.outcome.valid&&trial.grade?.outcome===trial.outcome.source&&['PASS','FAIL'].includes(trial.grade?.judgment??'');}
function sameGrader(a:ComparisonTrial,b:ComparisonTrial){return !!a.grade&&!!b.grade&&a.grade.graderVersion===b.grade.graderVersion&&a.grade.revision===b.grade.revision;}
function difference(a:number,b:number,direction:'lower'|'higher'){return direction==='lower'?a-b:b-a;}
export const BASELINE_ZERO='baseline is 0; relative d not comparable';
/** 配对差值 d（正为更好）。relative 口径下效率指标以 baseline 为分母，baseline 为 0 返回 null（不可比）。 */
export function pairDelta(plan:Pick<ComparisonPlan,'scale'>,metric:Metric,before:number,after:number,direction:'lower'|'higher'){
 const d=difference(before,after,direction);
 if(plan.scale!=='relative'||metric==='task-pass')return d;
 return before===0?null:d/before;
}
/** Pure arithmetic over already verified host facts. The runner supplies evidence validity. */
export function compareTrials(plan:ComparisonPlan,trials:ComparisonTrial[],externalGaps:string[]=[]){
 const eligible=(t:ComparisonTrial|undefined)=>!!t?.outcome.valid&&!!t.grade&&t.grade.outcome===t.outcome.source;
 const metric=(t:ComparisonTrial|undefined,key:Metric)=>key==='task-pass'?(judgment(t)?(t!.grade!.judgment==='PASS'?1:0):null):t?.metrics[key]??null;
 const comparable=(a:ComparisonTrial|undefined,b:ComparisonTrial|undefined)=>!!a&&!!b&&eligible(a)&&eligible(b)&&sameGrader(a,b)&&!!a.pair&&a.pair===b.pair;
 const efficiency=(key:Metric,a:ComparisonTrial|undefined,b:ComparisonTrial|undefined)=>key==='task-pass'||a?.grade?.judgment==='PASS'&&b?.grade?.judgment==='PASS';
 const pairs=Object.entries(plan.roles).flatMap(([caseId,role])=>Array.from({length:plan.repetitions},(_,index)=>{
  const repeat=index+1,as=trials.filter(t=>t.caseId===caseId&&t.repeat===repeat&&t.side==='baseline'),bs=trials.filter(t=>t.caseId===caseId&&t.repeat===repeat&&t.side==='candidate'),a=as[0],b=bs[0];
  const valid=as.length===1&&bs.length===1&&comparable(a,b)&&judgment(a)&&judgment(b);
  const before=metric(a,plan.objective.metric),after=metric(b,plan.objective.metric);
  const d=known(before)&&known(after)?pairDelta(plan,plan.objective.metric,before,after,plan.objective.direction):null;
  const reason=!valid?'missing, invalid, duplicate, unpaired or inconsistent grading':!efficiency(plan.objective.metric,a,b)?'efficiency requires both tasks to pass':!known(before)||!known(after)?(a?.metricReasons[plan.objective.metric]??b?.metricReasons[plan.objective.metric]??'missing trusted metric'):d===null?BASELINE_ZERO:null;
  const metricGaps=[a,b].flatMap(t=>t?Object.entries(t.metrics).filter(([,value])=>!known(value)).map(([name])=>`${t.id}: ${t.metricReasons[name as Metric]??'missing trusted '+name}`):['missing trial']);
  if(a?.modelIdentity?.missing||b?.modelIdentity?.missing)metricGaps.push('returned model identity unavailable');
  if(a?.modelIdentity&&b?.modelIdentity&&JSON.stringify(a.modelIdentity.returned)!==JSON.stringify(b.modelIdentity.returned))metricGaps.push('returned model identities differ between paired sides');
  return {caseId,role,repeat,id:a?.pair??b?.pair??`${caseId}:${repeat}`,baseline:a?.id??null,candidate:b?.id??null,valid,before,after,delta:!reason?d:null,exclusion:reason,metricGaps};
 }));
 const protections=plan.protections.flatMap(rule=>pairs.filter(p=>rule.cases.includes(p.caseId)).map(pair=>{
  const a=trials.find(t=>t.id===pair.baseline),b=trials.find(t=>t.id===pair.candidate);
  let before:boolean|number|null,after:boolean|number|null,d:number|null=null;
  let zero=false;
  if(rule.kind==='hard'){before=a?.grade?.checks.find(c=>c.name===rule.check)?.passed??null;after=b?.grade?.checks.find(c=>c.name===rule.check)?.passed??null;}
  else{before=metric(a,rule.metric);after=metric(b,rule.metric);if(known(before)&&known(after)){d=pairDelta(plan,rule.metric,before,after,rule.direction);zero=d===null;}}
  // Requirement judgments stand alone: baseline overall FAIL/unknown does not erase a passing check.
  const reason=!comparable(a,b)?'invalid boundary/evidence, missing side or inconsistent grader':rule.kind==='hard'?(before!==true?'baseline requirement not passing':typeof after!=='boolean'?'candidate requirement unknown':null):!efficiency(rule.metric,a,b)?'efficiency requires both tasks to pass':zero?BASELINE_ZERO:d===null?'missing trusted metric':null;
  const valid=reason===null,regressed=valid&&(rule.kind==='hard'?after===false:d! < -rule.tolerance);
  const candidatePassed=eligible(b)&&(rule.kind==='hard'?after===true:valid&&!regressed);
  return {requirement:rule.id,caseId:pair.caseId,repeat:pair.repeat,kind:rule.kind,before,after,delta:d,valid,regressed,candidatePassed,reason};
 }));
 const P=protections.length,V=protections.filter(p=>p.valid).length,R=protections.filter(p=>p.regressed).length;
 const objectives=pairs.filter(p=>p.role==='objective');
 const allComplete=trials.length===pairs.length*2&&pairs.every(p=>p.valid)&&trials.every(t=>t.outcome.status==='completed');
 const evidenceGaps=[...externalGaps,...pairs.flatMap(p=>p.metricGaps)],metricsComplete=evidenceGaps.length===0;
 const delta=plan.objective.delta,threshold=known(delta)&&delta>0&&!!plan.objective.basis&&plan.protections.every(p=>p.kind==='hard'||!!p.basis);
 const repeated=!!plan.repetitionBasis&&(plan.kind==='deterministic'||plan.repetitions>=2);
 const hardRegressions=protections.filter(p=>p.kind==='hard'&&p.regressed).map(p=>`${p.requirement}/${p.caseId}/${p.repeat}`);
 // A new task correctness failure is also a hard constraint. Infrastructure/cancellation is not causal evidence.
 for(const p of pairs){const a=trials.find(t=>t.id===p.baseline),b=trials.find(t=>t.id===p.candidate);if(p.valid&&a?.grade?.judgment==='PASS'&&b?.grade?.judgment==='FAIL'&&['completed','error','timeout'].includes(b.outcome.status)&&['completed','error','timeout'].includes(a.outcome.status))hardRegressions.push(`task/${p.caseId}/${p.repeat}`);}
 const softRegressions=plan.protections.filter(rule=>rule.kind==='soft').flatMap(rule=>rule.cases.filter(caseId=>{const ps=protections.filter(p=>p.requirement===rule.id&&p.caseId===caseId);return ps.length===plan.repetitions&&ps.every(p=>p.valid&&p.regressed);}).map(caseId=>`${rule.id}/${caseId}`));
 const candidateFailures=trials.filter(t=>t.side==='candidate'&&t.grade&&(t.grade.judgment==='FAIL'||plan.protections.some(p=>p.kind==='hard'&&p.cases.includes(t.caseId)&&t.grade!.checks.some(c=>c.name===p.check&&!c.passed)))).map(t=>({trial:t.id,judgment:t.grade!.judgment,evidenceValid:t.outcome.valid}));
 let conclusion:'改善'|'退化'|'无明显差异'|'证据不足'='证据不足',reason='Plan incomplete, invalid, missing or contradictory comparison evidence';
 if(hardRegressions.length){conclusion='退化';reason='New evidenced hard regression; missing other trials cannot erase it';}
 else if(allComplete&&metricsComplete&&repeated&&(softRegressions.length||threshold&&objectives.length>0&&objectives.every(p=>p.delta!==null&&p.delta<=-delta!))){conclusion='退化';reason='Completed valid repeated comparison consistently exceeds a degradation boundary';}
 else if(allComplete&&metricsComplete&&repeated&&threshold&&objectives.length>0&&trials.filter(t=>t.side==='candidate').every(t=>t.grade?.judgment==='PASS')&&protections.every(p=>p.candidatePassed)){
  if(objectives.every(p=>p.delta!==null&&p.delta>=delta!)){conclusion='改善';reason='Every objective pair meets the predefined improvement threshold; all protections pass';}
  else if(objectives.every(p=>p.delta!==null&&p.delta> -delta!&&p.delta<delta!)){conclusion='无明显差异';reason='Every objective pair lies strictly within the predefined interval';}
 }
 return {conclusion,reason,scope:'Only this fixed combination, cases, repetitions and restricted environment; no population, future stability or ordinary-host claim',allComplete,metricsComplete,evidenceGaps,thresholdValid:threshold,repetitionValid:repeated,validPairs:pairs.filter(p=>p.valid).length,pairs,candidateFailures,hardRegressions,softRegressions,regression:{counts:{planned:P,valid:V,regressed:R,regressionRate:V?R/V:null,coverageRate:P?V/P:null},pairs:protections}};
}
