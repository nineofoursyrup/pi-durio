import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {Evidence,readObject,type BlobRef} from '../evidence.js';
import {acquireOwner} from '../ownership.js';
import {fixEvidence,verifyFixed} from '../fixed-evidence.js';
import {appendFact,captureFiles,installedRuntimeFiles,evalFacts,type ContentFile} from './store.js';
import {representativeCases,type EvalCase} from './fixtures.js';
import type {BudgetLimits} from '../provider-boundary.js';
export const verifiedImage='pi-durio-eval@sha256:7cfd5ced23d374c1c17d6848c192965f3f4daa6f6f10a6e8d88ae408b559b37c';
export type ControlledScenario='pass'|'necessary-fail'|'grader-crash'|'unknown-usage'|'service-error'|'original-error'|'boundary'|'export-link'|'timeout'|'auto-compaction';
export interface EvalTrial {id:string;caseId:string;version:string;side:string;repeat:number;pair:string|null;scenario?:ControlledScenario;replaces?:string}
export interface EvalPlan {
 id:string;purpose:string;mode:'offline'|'live';model:{provider:'deepseek';id:'deepseek-flash';endpoint:'https://api.deepseek.com/chat/completions'};
 image:string;runtime:{id:string;manifest:BlobRef;bytes:number};cases:EvalCase[];trials:EvalTrial[];
 budget:BudgetLimits;trialTimeoutMs:number;gradingTimeoutMs:number;maxOutputTokens:number;requestRetryLimit:0;
 price:{version:string;source:string;currency:'USD';perMillionTokens:number};
 authorization:{scope:'run-all-listed-trials';paid:boolean};environment:{node:string;isolation:string;writable:string;cache:string;boundaryFiles?:ContentFile[]};
 mainObjective:string;protection:string[];improvementConclusion:'not-evaluated';
}
export function validatePlan(plan:EvalPlan){
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(plan.id)||!plan.purpose||!['offline','live'].includes(plan.mode)||plan.model.provider!=='deepseek'||plan.model.id!=='deepseek-flash'||plan.model.endpoint!=='https://api.deepseek.com/chat/completions'||!/^\S+@sha256:[a-f0-9]{64}$/.test(plan.image))throw Error('INVALID_EVAL_PLAN');
 if(plan.trials.length<1||plan.trials.length>32||new Set(plan.trials.map(t=>t.id)).size!==plan.trials.length||plan.cases.length>16||new Set(plan.cases.map(c=>c.id)).size!==plan.cases.length)throw Error('INVALID_EVAL_TRIALS');
 for(const trial of plan.trials){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(trial.id)||!plan.cases.some(c=>c.id===trial.caseId)||trial.version!==plan.runtime.id||!trial.side||!Number.isSafeInteger(trial.repeat)||trial.repeat<1)throw Error('INVALID_EVAL_TRIAL');}
 for(const fixture of plan.cases){if(!fixture.input.trim()||!fixture.grader.version||!fixture.grader.required.length||!fixture.grader.program||!fixture.dependencyLock||Object.keys(fixture.files).length>24)throw Error('INVALID_EVAL_CASE');for(const path of [...Object.keys(fixture.files),...Object.keys(fixture.dirty),...fixture.writable])if(!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path)||path.split('/').some(p=>p==='.'||p==='..'))throw Error('INVALID_EVAL_CASE_PATH');}
 if(![plan.trialTimeoutMs,plan.gradingTimeoutMs].every(n=>Number.isSafeInteger(n)&&n>=100&&n<=300000)||!Number.isSafeInteger(plan.maxOutputTokens)||plan.maxOutputTokens<1||plan.maxOutputTokens>16384||plan.requestRetryLimit!==0||!plan.price.version||!plan.price.source||plan.price.currency!=='USD'||!Number.isFinite(plan.price.perMillionTokens)||plan.price.perMillionTokens<0||plan.authorization.scope!=='run-all-listed-trials')throw Error('INVALID_EVAL_LIMITS');
 if(![plan.budget.maxRequests,plan.budget.maxTokens,plan.budget.maxRequestTokens].every(n=>Number.isSafeInteger(n)&&n>0)||plan.budget.maxRequests>100||plan.budget.maxRequestTokens>plan.budget.maxTokens||!Number.isFinite(Date.parse(plan.budget.deadline)))throw Error('INVALID_EVAL_BUDGET');
 if(plan.mode==='live'&&(!plan.authorization.paid||!plan.budget.unknownUpperBound||plan.trials.some(t=>t.scenario)||plan.budget.maxRequestTokens<1_048_576+plan.maxOutputTokens||plan.budget.unknownUpperBound.tokens<1_048_576+plan.maxOutputTokens||!plan.budget.unknownUpperBound.source.startsWith('https://api-docs.deepseek.com/')||plan.price.version==='offline-zero-v1'))throw Error('LIVE_EVAL_REQUIRES_PAID_AUTHORIZATION_AND_PROVEN_TOKEN_BOUND');
}
export interface PrepareEvalOptions {dataRoot:string;id?:string;purpose:string;mode?:'offline'|'live';image?:string;budget:BudgetLimits;trialTimeoutMs?:number;gradingTimeoutMs?:number;maxOutputTokens?:number;cases?:EvalCase[];trials?:Omit<EvalTrial,'version'>[];paid?:boolean;price?:EvalPlan['price'];installation?:string}
export async function prepareEval(options:PrepareEvalOptions){
 const id=options.id??randomUUID(),root=options.dataRoot;await mkdir(root,{recursive:true,mode:0o700});const owner=await acquireOwner(root,()=>{});let evidence:Evidence|undefined,source:string,plan:EvalPlan;
 try{owner.assertHeld();evidence=new Evidence(root,id,()=>owner.assertHeld());if(evalFacts(root,id).length)throw Error('EVAL_PLAN_ID_EXISTS');
  const installation=options.installation??fileURLToPath(new URL('../../../',import.meta.url));
  const environment=JSON.parse(readFileSync(join(installation,'eval-environment.json'),'utf8'));
  if(environment.platform!=='linux'||environment.arch!=='arm64'||environment.node!=='v24.8.0'||environment.image!==(options.image??verifiedImage))throw Error('EVAL_RUNTIME_PREPARATION_REQUIRED: use scripts/eval/prepare-runtime.mjs for the fixed Linux image');
  const runtime=captureFiles(evidence,installation,installedRuntimeFiles(installation));
  const boundaryFiles=captureFiles(evidence,fileURLToPath(new URL('../../execution/isolation/',import.meta.url)),['boundary.mjs','export.mjs','restrict.py']).files;
  const cases=structuredClone(options.cases??representativeCases);
  const trials=options.trials??cases.map(c=>({id:randomUUID(),caseId:c.id,side:'candidate',repeat:1,pair:null,...(options.mode==='live'?{}:{scenario:'pass' as const})}));
  plan={id,purpose:options.purpose,mode:options.mode??'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:options.image??verifiedImage,runtime:{id:runtime.id,manifest:evidence.blob(JSON.stringify(runtime.files)),bytes:runtime.bytes},cases,trials:trials.map(t=>({...t,version:runtime.id})),budget:options.budget,trialTimeoutMs:options.trialTimeoutMs??90000,gradingTimeoutMs:options.gradingTimeoutMs??30000,maxOutputTokens:options.maxOutputTokens??2048,requestRetryLimit:0,price:options.price??{version:'offline-zero-v1',source:'deterministic local transport; no model inference or paid network',currency:'USD',perMillionTokens:0},authorization:{scope:'run-all-listed-trials',paid:options.paid??false},environment:{node:'v24.8.0',isolation:'Apple container 1.4.1 VM + namespace/capability/seccomp',writable:'fresh session, HOME, TMPDIR, cache, workspace and data-root each trial',cache:'fixed read-only dependencies only',boundaryFiles},mainObjective:'task requirements',protection:['fixture initial state','declared writable scope','isolation','complete acquired originals'],improvementConclusion:'not-evaluated'};
  validatePlan(plan);source=appendFact(evidence,'eval.plan',plan);
 }finally{evidence?.close();await owner.release();}
 const fixed=await fixEvidence(root,{id:`eval-plan:${id}`,sources:[source!],purpose:'retain complete eval plan, fixture/grader content and execution dependency bytes before execution'});
 return {plan:plan!,source:source!,fixed:fixed.source};
}
export function loadEvalPlan(root:string,id:string){const facts=evalFacts(root,id),fact=facts.find(f=>f.kind==='eval.plan');if(!fact)throw Error('EVAL_PLAN_NOT_FOUND');const plan=fact.data as EvalPlan;validatePlan(plan);return plan;}
export function runtimeContent(root:string,plan:EvalPlan):ContentFile[]{return JSON.parse(readObject(root,plan.runtime.manifest).toString());}
