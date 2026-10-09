import type {BlobRef} from '../evidence.js';
import {validateTaskProfile,type EffectiveTask} from '../task-profile.js';

export type Metric='requests'|'tokens'|'cost'|'taskMs'|'task-pass';
export interface RuntimeContent {id:string;manifest:BlobRef;bytes:number}
export interface ComparisonPlan {
 kind:'deterministic'|'stochastic'; repetitions:number; repetitionBasis:string;
 change:string; hypothesis:string;
 roles:Record<string,'objective'|'protection'>;
 objective:{metric:Metric;direction:'lower'|'higher';delta:number|null;basis:string};
 protections:({id:string;kind:'hard';check:string;cases:string[]}|{id:string;kind:'soft';metric:Exclude<Metric,'task-pass'>;direction:'lower'|'higher';tolerance:number;basis:string;cases:string[]})[];
 trialBudget:{maxRequests:number;maxTokens:number};
 sides:Record<'baseline'|'candidate',{runtime:RuntimeContent;instructions:string;effectiveTask?:EffectiveTask}>;
}
export interface ComparisonTrial {
 id:string;caseId:string;repeat:number;side:string;pair:string|null;version:string;
 outcome:{source?:string;status:string;valid:boolean;reason?:string|null;timing?:{taskMs:number}};
 grade:{judgment:string;graderVersion:string;outcome:string;revision?:string;checks:{name:string;passed:boolean}[]}|null;
 metrics:Record<Exclude<Metric,'task-pass'>,number|null>;metricReasons:Partial<Record<Metric,string>>;
 modelIdentity?:{returned:string[];missing:number};
}
export function validateComparison(plan:ComparisonPlan,caseIds:string[],trials:{id:string;caseId:string;repeat:number;side:string;pair:string|null}[],budget:{maxRequests:number;maxTokens:number}){
 const metrics=['requests','tokens','cost','taskMs','task-pass'];
 if(!['deterministic','stochastic'].includes(plan.kind)||!Number.isSafeInteger(plan.repetitions)||plan.repetitions<1||!plan.change||!plan.hypothesis||!metrics.includes(plan.objective.metric)||!['lower','higher'].includes(plan.objective.direction)||plan.objective.delta!==null&&(!known(plan.objective.delta)||plan.objective.delta<=0))throw Error('INVALID_COMPARISON_OBJECTIVE');
 if(Object.keys(plan.roles).length!==caseIds.length||caseIds.some(id=>!['objective','protection'].includes(plan.roles[id]))||!Object.values(plan.roles).includes('objective'))throw Error('INVALID_COMPARISON_ROLES');
 if(!plan.protections.length||new Set(plan.protections.map(p=>p.id)).size!==plan.protections.length)throw Error('INVALID_COMPARISON_PROTECTIONS');
 for(const p of plan.protections)if(!p.id||!p.cases.length||new Set(p.cases).size!==p.cases.length||p.cases.some(id=>!caseIds.includes(id))||!(p.kind==='hard'?typeof p.check==='string'&&p.check.length>0:p.kind==='soft'&&metrics.includes(p.metric)&&String(p.metric)!=='task-pass'&&['lower','higher'].includes(p.direction)&&known(p.tolerance)))throw Error('INVALID_COMPARISON_PROTECTION');
 for(const side of ['baseline','candidate'] as const)if(!plan.sides[side].runtime.id||!plan.sides[side].runtime.manifest||typeof plan.sides[side].instructions!=='string')throw Error('INVALID_COMPARISON_SIDE');
 for(const side of ['baseline','candidate'] as const){const e=plan.sides[side].effectiveTask;if(e){if(!['read','coding'].includes(e.type)||Object.keys(e).some(k=>!['type','profile'].includes(k)))throw Error('INVALID_EFFECTIVE_TASK');validateTaskProfile(e.profile);}}
 if(plan.sides.baseline.effectiveTask?.type!==plan.sides.candidate.effectiveTask?.type)throw Error('COMPARISON_TASK_TYPE_CHANGED');
 if(![plan.trialBudget.maxRequests,plan.trialBudget.maxTokens].every(n=>Number.isSafeInteger(n)&&n>0)||budget.maxRequests<plan.trialBudget.maxRequests*trials.length||budget.maxTokens<plan.trialBudget.maxTokens*trials.length)throw Error('COMPARISON_REQUIRES_FULL_PER_TRIAL_BUDGET');
 const schedule=pairedTrials('validation',caseIds,plan.repetitions);
 if(trials.length!==schedule.length||trials.some((t,i)=>t.caseId!==schedule[i].caseId||t.repeat!==schedule[i].repeat||t.side!==schedule[i].side||!t.pair))throw Error('INVALID_COMPARISON_ORDER');
 const seen=new Set<string>();for(let i=0;i<trials.length;i+=2){if(trials[i].pair!==trials[i+1].pair||seen.has(trials[i].pair!))throw Error('INVALID_COMPARISON_PAIR');seen.add(trials[i].pair!);}
}
export function pairedTrials(id:string,caseIds:string[],repetitions:number){
 let ordinal=0;return caseIds.flatMap(caseId=>Array.from({length:repetitions},(_,i)=>{const pair=`${id}-pair-${++ordinal}`,sides=ordinal%2?['baseline','candidate']:['candidate','baseline'];return sides.map(side=>({id:`${pair}-${side}`,caseId,side,repeat:i+1,pair}));}).flat());
}
const known=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
function judgment(trial:ComparisonTrial|undefined){return !!trial?.outcome.valid&&trial.grade?.outcome===trial.outcome.source&&['PASS','FAIL'].includes(trial.grade?.judgment??'');}
function sameGrader(a:ComparisonTrial,b:ComparisonTrial){return !!a.grade&&!!b.grade&&a.grade.graderVersion===b.grade.graderVersion&&a.grade.revision===b.grade.revision;}
function difference(a:number,b:number,direction:'lower'|'higher'){return direction==='lower'?a-b:b-a;}
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
  const reason=!valid?'missing, invalid, duplicate, unpaired or inconsistent grading':!efficiency(plan.objective.metric,a,b)?'efficiency requires both tasks to pass':!known(before)||!known(after)?(a?.metricReasons[plan.objective.metric]??b?.metricReasons[plan.objective.metric]??'missing trusted metric'):null;
  const metricGaps=[a,b].flatMap(t=>t?Object.entries(t.metrics).filter(([,value])=>!known(value)).map(([name])=>`${t.id}: ${t.metricReasons[name as Metric]??'missing trusted '+name}`):['missing trial']);
  if(a?.modelIdentity?.missing||b?.modelIdentity?.missing)metricGaps.push('returned model identity unavailable');
  if(a?.modelIdentity&&b?.modelIdentity&&JSON.stringify(a.modelIdentity.returned)!==JSON.stringify(b.modelIdentity.returned))metricGaps.push('returned model identities differ between paired sides');
  return {caseId,role,repeat,id:a?.pair??b?.pair??`${caseId}:${repeat}`,baseline:a?.id??null,candidate:b?.id??null,valid,before,after,delta:!reason?difference(before!,after!,plan.objective.direction):null,exclusion:reason,metricGaps};
 }));
 const protections=plan.protections.flatMap(rule=>pairs.filter(p=>rule.cases.includes(p.caseId)).map(pair=>{
  const a=trials.find(t=>t.id===pair.baseline),b=trials.find(t=>t.id===pair.candidate);
  let before:boolean|number|null,after:boolean|number|null,d:number|null=null;
  if(rule.kind==='hard'){before=a?.grade?.checks.find(c=>c.name===rule.check)?.passed??null;after=b?.grade?.checks.find(c=>c.name===rule.check)?.passed??null;}
  else{before=metric(a,rule.metric);after=metric(b,rule.metric);if(known(before)&&known(after))d=difference(before,after,rule.direction);}
  // Requirement judgments stand alone: baseline overall FAIL/unknown does not erase a passing check.
  const reason=!comparable(a,b)?'invalid boundary/evidence, missing side or inconsistent grader':rule.kind==='hard'?(before!==true?'baseline requirement not passing':typeof after!=='boolean'?'candidate requirement unknown':null):!efficiency(rule.metric,a,b)?'efficiency requires both tasks to pass':d===null?'missing trusted metric':null;
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
