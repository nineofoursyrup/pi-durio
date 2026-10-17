/** Pure comparison declarations shared by product analysis and host eval. */
import type {BlobRef} from './evidence.js';
import {validateTaskProfile,type EffectiveTask} from './task-profile.js';

export type Metric='requests'|'tokens'|'cost'|'taskMs'|'task-pass';
export interface RuntimeContent {id:string;manifest:BlobRef;bytes:number}
export interface ComparisonPlan {
 kind:'deterministic'|'stochastic'; repetitions:number; repetitionBasis:string;
 change:string; hypothesis:string;
 roles:Record<string,'objective'|'protection'>;
 objective:{metric:Metric;direction:'lower'|'higher';delta:number|null;basis:string};
 protections:({id:string;kind:'hard';check:string;cases:string[]}|{id:string;kind:'soft';metric:Exclude<Metric,'task-pass'>;direction:'lower'|'higher';tolerance:number;basis:string;cases:string[]})[];
 trialBudget:{maxRequests:number;maxTokens:number};
 /** `relative`（改版新计划）：费用、请求数、token、耗时的 d 以 baseline 为分母，baseline 为 0 不可比；task-pass 仍为通过差。
  * 缺省为首版旧计划：保留绝对 d 与 δ（V8）。软保护容忍度同口径。 */
 scale?:'relative';
 sides:Record<'baseline'|'candidate',{runtime:RuntimeContent;instructions:string;effectiveTask?:EffectiveTask}>;
}
export function validateComparison(plan:ComparisonPlan,caseIds:string[],trials:{id:string;caseId:string;repeat:number;side:string;pair:string|null}[],budget:{maxRequests:number;maxTokens:number}){
 const metrics=['requests','tokens','cost','taskMs','task-pass'];
 if(plan.scale!==undefined&&plan.scale!=='relative')throw Error('INVALID_COMPARISON_SCALE');
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
