/** Shared authorization and process facts for 2b operations. No ownership is
 * acquired while a confirmation is open; the runner owns its real lease. */
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {newEvalDirectory} from '../eval/directory.js';
import {openHostReadonly,readObject} from '../evidence.js';
import {formatAmount,type CostTotals} from '../cost-estimate.js';
import {evalReport,regradeEval,runEval} from '../eval/runner.js';
import {loadEvalPlan,validatePlan,type EvalPlan} from '../eval/plan.js';
import {planState,readPlanReport,type PlanSource,type EvalReport} from '../eval/overview.js';
import type {EvalCleanupReceipt} from '../eval/cleanup.js';
import type {ConfirmConfig} from './view-stack.js';
import type {EvalExitFact} from './exit-summary.js';

export type EvalAction='run'|'grade';
export const samePlan=(a:PlanSource,b:PlanSource)=>a.root===b.root&&a.id===b.id&&a.origin?.reportId===b.origin?.reportId&&a.origin?.decisionId===b.origin?.decisionId&&a.origin?.groupId===b.origin?.groupId;
/** Status-only counts from acquired facts, without verifying fixed execution content.
 * No completion, grading or evidence-protection conclusion is returned here. */
export function readEvalProgress(source:PlanSource):[number,number] {
  const db=openHostReadonly(source.root),started=new Set<string>(),outcomes=new Map<string,boolean>();let plan:EvalPlan|undefined;
  try {
    for(const row of db.prepare("SELECT kind,body FROM records WHERE run_id=? AND seq<=? AND kind IN ('eval.plan','eval.trial-started','eval.outcome') ORDER BY seq").iterate(source.id,source.through??Number.MAX_SAFE_INTEGER)) {
      const data=JSON.parse(readObject(source.root,JSON.parse(String(row.body))).toString());
      if(row.kind==='eval.plan')plan??=data;
      else if(row.kind==='eval.trial-started')started.add(data.trialId);
      else if(!outcomes.has(data.trialId))outcomes.set(data.trialId,!!data.started);
    }
  } finally {db.close();}
  if(!plan)throw Error('EVAL_PLAN_NOT_FOUND');validatePlan(plan);
  return [plan.trials.filter(trial=>outcomes.has(trial.id)?outcomes.get(trial.id):started.has(trial.id)).length,plan.trials.length];
}
export function evalBlocked(source:PlanSource,action:EvalAction,host:{writeBlocked?:string;busy?:boolean;now?:number}={}) {
  if(host.writeBlocked)return host.writeBlocked;
  if(host.busy)return '有任务运行中，结束后再启动';
  if(source.origin)return action==='grade'?'improve 发起的计划不能在此重评分':'improve 发起的计划由提交批次启动';
  if(source.through!==undefined)return '固定报告快照只读 · 从 /eval 打开当前计划';
  if(existsSync(`${source.root}.lock`)||existsSync(join(source.root,'owner.json')))return '数据根写入者锁被占用 · 只读跟踪';
  const report=readPlanReport(source).report,state=planState(report);
  if(action==='run')return state!=='not-started'?'一份计划只运行一次 · 停止后不续跑':Date.parse(report.plan.budget.deadline)<=(host.now??Date.now())?'截止时间已过，不能启动':undefined;
  return state==='running'?'批次运行中，不能重评分':state==='not-started'?'计划尚未运行，不能重评分':undefined;
}
export function evalRunConfirmation(source:PlanSource,blocked:()=>string|undefined):ConfirmConfig {
  const {plan}=readPlanReport(source).report,c=plan.comparison,price=plan.price;
  const cost=price?formatAmount(plan.budget.maxTokens*price.perMillionTokens/1e6,price.currency):'unknown';
  return {title:`启动 eval ${source.label}`,action:'启动',wrapBody:true,
    body:[`目的：${plan.purpose}`,`案例：${plan.cases.map(x=>`${x.id} (${c?.roles[x.id]??'诊断'})`).join(' · ')}`,
      `顺序：${plan.trials.map(t=>`${t.id}: ${t.side}/r${t.repeat}`).join(' → ')}`,
      ...(c?[`A ${c.sides.baseline.runtime.id} · B ${c.sides.candidate.runtime.id}`,`变更：${c.change} · 假设：${c.hypothesis}`,`主目标：${c.objective.metric} ${c.objective.direction} · δ ${c.objective.delta} · ${c.objective.basis}`,
        ...c.protections.map(p=>`保护 ${p.id}：${p.kind} · ${'check' in p?p.check:`${p.metric} ${p.direction} ${p.tolerance}`} · ${p.cases.join(', ')}`)]:[`runtime ${plan.runtime.id} · 无对照，只诊断`]),
      `模型：${plan.model.provider}/${plan.model.id} · ${plan.mode}`,`隔离：${plan.image}`,`初态/lock/dirty、grader 与依赖均按已固定内容 · ${plan.cases.map(x=>`${x.id} grader ${x.grader.version}`).join(' · ')}`,
      `缓存：${plan.environment.cache} · 可写：${plan.environment.writable}`,`每 trial ${plan.trialTimeoutMs/1000}s · 评分 ${plan.gradingTimeoutMs/1000}s · 请求重试 ${plan.requestRetryLimit}`,
      `总预算 ${plan.budget.maxRequests} 请求 / ${plan.budget.maxTokens} tok · 单请求 ${plan.budget.maxRequestTokens} tok${c?` · 每侧 ${c.trialBudget.maxRequests} 请求 / ${c.trialBudget.maxTokens} tok`:''}`],
    fixed:[`${plan.mode==='offline'?'离线受控 · 不调用付费模型':'将执行固定计划全部 trial'} · 停止后不续跑`,`${price?.currency==='USD'?'首版美元固定上限':'人民币高峰价上限'} ${cost} · ${price?.version??'未固定价目'} · 估算非账单`,`截止时间 ${plan.budget.deadline}`],disabled:blocked};
}
export function evalGradeConfirmation(source:PlanSource,requested:string[]|undefined,blocked:()=>string|undefined):ConfirmConfig {
  const report=readPlanReport(source).report,cases=report.plan.cases;
  if(requested?.some(id=>!cases.some(c=>c.id===id)))throw Error('EVAL_CASE_NOT_FOUND');
  const selected=cases.flatMap((c,i)=>(requested?requested.includes(c.id):report.trials.some(t=>t.caseId===c.id&&(!t.grade||t.grade.judgment==='unknown')))?[i]:[]);
  return {title:`重评分 ${source.label}`,action:'重评分',wrapBody:true,body:['只对已取得的同一 outcome 使用当前报告中的同版本 grader。'],choice:{mode:'multi',options:cases.map(c=>({label:`${c.id} · grader ${report.gradingRevisions.findLast(r=>r.graders[c.id])?.graders[c.id].version??c.grader.version}`})),selected},fixed:[`不调用模型 · 占用 VM，最长约 ${report.trials.length} × ${report.plan.gradingTimeoutMs/1000}s 评分超时`,`追加评分修订，原评分保留 · 模型费用 ¥0.00`],disabled:indices=>blocked()??(!indices.length?'至少选择一个案例':undefined)};
}
export async function executeEval(source:PlanSource,action:EvalAction,cases:string[]|undefined,signal:AbortSignal,onCleanup:(receipt:EvalCleanupReceipt)=>void,onPrepared?:()=>void){
  const directory=await newEvalDirectory();
  if(action==='run')return runEval({dataRoot:source.root,id:source.id,directory,signal,onCleanup,onPrepared});
  const report=evalReport(source.root,source.id),plan=loadEvalPlan(source.root,source.id);
  const graders=Object.fromEntries(plan.cases.filter(c=>cases?.includes(c.id)).map(c=>[c.id,report.gradingRevisions.findLast(r=>r.graders[c.id])?.graders[c.id]??c.grader]));
  return regradeEval({dataRoot:source.root,id:source.id,directory,revisionId:randomUUID(),graders,signal,onCleanup});
}
export function evalStoppedFact(source:PlanSource,report:EvalReport|undefined,receipt:EvalCleanupReceipt|undefined):EvalExitFact {
  const cost:CostTotals=report?{amounts:report.cost.price&&report.cost.knownValue!==null?{[report.cost.price.currency]:report.cost.knownValue}:{},unknownRequests:report.cost.missing,partial:false}:{amounts:{},unknownRequests:1,partial:false};
  const identity={root:source.root,id:source.id,label:source.label,origin:source.origin};
  const base={source:identity,planId:source.id,trial:report?.counts.started??0,total:report?.counts.planned??0,cost,receipt};
  return receipt?.cleanup==='confirmed'?{...base,state:'stopped',cleanup:'confirmed'}:{...base,state:'unconfirmed',cleanup:'unknown'};
}
