/** Analysis declares checks and numerical budgets; the host binds retained case
 * bytes, current runtime and deadlines. This module does not execute or install. */
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {digest,readObject} from './evidence.js';
import {parseEvalAsset} from './improve-eval-assets.js';
import {sourceBytes,listRegisteredSources,type SourceTarget} from './improve-source.js';
import type {ImproveCandidate,ImproveReport} from './improve.js';
import {describeImproveRuntime,type DirectCheck,type FreshCheck,type ImproveCheck} from './improve-validation.js';
import {pairedTrials,validateComparison,type ComparisonPlan} from './eval/comparison.js';
import {verifiedImage} from './eval/plan.js';
import {installedRuntimeFiles} from './eval/store.js';
import {hostPlanPrice} from './cost-estimate.js';

export interface CandidateFreshCheck {
 kind:'fresh';benefit?:'required'|'diagnostic';
 assets:{targetId:string;path:string;caseIds:string[]}[];
 mode:'offline'|'live';
 comparison:Omit<ComparisonPlan,'sides'|'scale'>;
 budget:{maxRequests:number;maxTokens:number;maxRequestTokens:number;maxDurationMs:number};
 trialTimeoutMs:number;gradingTimeoutMs:number;maxOutputTokens:number;
 effectiveTask?:'read'|'coding';
}
export type CandidateCheck=DirectCheck|CandidateFreshCheck;
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const timeout=(n:unknown)=>positive(n)&&n>=100&&n<=300000;
const only=(value:object,names:string[])=>Object.keys(value).every(k=>names.includes(k));
export function validateCandidateChecks(value:unknown,targets:SourceTarget[]):asserts value is CandidateCheck[] {
 if(!Array.isArray(value)||value.length>32)throw Error('IMPROVE_STRUCTURED_CHECK_INVALID');
 for(const c of value) {
  if(!c||c.benefit!==undefined&&!['required','diagnostic'].includes(c.benefit))throw Error('IMPROVE_STRUCTURED_CHECK_INVALID');
  if(c.kind!=='fresh') {
   if(!['direct','regression','resource'].includes(c.kind)||!only(c,['kind','program','timeoutMs','resource','benefit'])||typeof c.program!=='string'||!c.program.trim()||Buffer.byteLength(c.program)>131072||!timeout(c.timeoutMs))throw Error('IMPROVE_STRUCTURED_CHECK_INVALID');
   if(c.kind==='resource'&&(!c.resource||!only(c.resource,['direction','delta','unit','basis'])||!['lower','higher'].includes(c.resource.direction)||!Number.isFinite(c.resource.delta)||c.resource.delta<=0||!c.resource.unit||!c.resource.basis))throw Error('IMPROVE_RESOURCE_THRESHOLD_REQUIRED');
   if(c.kind!=='resource'&&(c.resource!==undefined||c.benefit!==undefined))throw Error('IMPROVE_STRUCTURED_CHECK_INVALID');
   continue;
  }
  if(!only(c,['kind','benefit','assets','mode','comparison','budget','trialTimeoutMs','gradingTimeoutMs','maxOutputTokens','effectiveTask'])||!['offline','live'].includes(c.mode)||!timeout(c.trialTimeoutMs)||!timeout(c.gradingTimeoutMs)||!positive(c.maxOutputTokens)||c.maxOutputTokens>16384||c.effectiveTask!==undefined&&!['read','coding'].includes(c.effectiveTask))throw Error('IMPROVE_FRESH_DECLARATION_INVALID');
  const b=c.budget;
  if(!b||!only(b,['maxRequests','maxTokens','maxRequestTokens','maxDurationMs'])||!Object.values(b).every(positive)||Object.keys(b).length!==4||b.maxRequests>100||b.maxRequestTokens>b.maxTokens||b.maxDurationMs>3600000||c.mode==='live'&&b.maxRequestTokens<1048576+c.maxOutputTokens)throw Error('IMPROVE_FRESH_BUDGET_INVALID');
  if(!Array.isArray(c.assets)||!c.assets.length||c.assets.length>16||c.assets.some((a:any)=>!a||!only(a,['targetId','path','caseIds'])||!Array.isArray(a.caseIds)||!a.caseIds.length||a.caseIds.some((id:any)=>typeof id!=='string')||!targets.some(t=>t.id===a.targetId&&t.kind==='eval-asset'&&t.state==='verified'&&t.files.some(f=>f.path===a.path&&f.state==='available'))))throw Error('IMPROVE_FRESH_REGISTERED_CASES_REQUIRED');
  if(!c.comparison||!only(c.comparison,['kind','repetitions','repetitionBasis','change','hypothesis','roles','objective','protections','trialBudget']))throw Error('IMPROVE_FRESH_DECLARATION_INVALID');
  const ids=c.assets.flatMap((a:any)=>a.caseIds) as string[];
  if(new Set(ids).size!==ids.length||ids.length>16||ids.length*c.comparison.repetitions*2>32)throw Error('IMPROVE_FRESH_CASES_INVALID');
  const runtime={id:'host-bound-at-summary',manifest:{sha256:'host-bound',bytes:0},bytes:0};
  validateComparison({...c.comparison,scale:'relative',sides:{baseline:{runtime,instructions:''},candidate:{runtime,instructions:''}}},ids,pairedTrials('declaration',ids,c.comparison.repetitions),b);
 }
}

/** No directory-name/remote discovery. This is a host-configured prepared runtime
 * (default dataRoot/eval-runtime), and its build must be this process's build. */
export function bindCandidateCheck(root:string,report:ImproveReport,candidates:ImproveCandidate[],check:CandidateCheck,deadline:string,installation=join(root,'eval-runtime')):ImproveCheck {
 validateCandidateChecks([check],report.targets);
 if(check.kind!=='fresh')return structuredClone(check);
 const registrations=listRegisteredSources(root,report.target.workspace);
 const cases=check.assets.flatMap(a=>{
  const target=report.targets.find(t=>t.id===a.targetId)!,file=target.files.find(f=>f.path===a.path)!;
  if(!registrations.some(r=>r.kind==='eval-asset'&&r.root===target.workspace&&r.fingerprints.some(f=>f.path===a.path&&f.sha256===file.sha256)))throw Error('IMPROVE_FRESH_REGISTERED_CASES_REQUIRED');
  if(digest(sourceBytes(target.workspace!,a.path))!==file.sha256)throw Error('IMPROVE_FRESH_CASE_BASELINE_DRIFT');
  const asset=parseEvalAsset(readObject(root,file.content));if(asset.kind!=='cases'||a.caseIds.some(id=>!asset.value.some(c=>c.id===id)))throw Error('IMPROVE_FRESH_CASES_INVALID');
  return a.caseIds.map(id=>asset.value.find(c=>c.id===id)!);
 });
 if(!existsSync(join(installation,'eval-environment.json')))throw Error(`IMPROVE_FRESH_RUNTIME_NOT_PREPARED: ${installation}`);
 const environment=JSON.parse(readFileSync(join(installation,'eval-environment.json'),'utf8'));
 if(environment.platform!=='linux'||environment.arch!=='arm64'||environment.node!=='v24.8.0'||environment.image!==verifiedImage)throw Error('IMPROVE_FRESH_RUNTIME_NOT_PREPARED');
 const buildBytes=readFileSync(new URL('../execution/source-build.json',import.meta.url));
 if(!readFileSync(join(installation,'dist/execution/source-build.json')).equals(buildBytes))throw Error('IMPROVE_RUNTIME_CONTENT_DRIFT');
 const build=JSON.parse(buildBytes.toString()),files=installedRuntimeFiles(installation);
 for(const path of files.filter(path=>path.startsWith('dist/')&&path!=='dist/execution/source-build.json'||path==='package.json')) {
  const expected=(path==='package.json'?build.inputs:build.outputs).find((file:any)=>file.path===path),bytes=sourceBytes(installation,path,8*1024*1024);
  if(!expected||expected.bytes!==bytes.length||expected.sha256!==digest(bytes))throw Error(`IMPROVE_RUNTIME_CONTENT_DRIFT: ${path}`);
 }
 const {maxDurationMs:_,...budget}=check.budget;
 const result:FreshCheck={kind:'fresh',...(check.benefit?{benefit:check.benefit}:{}),installation,runtimeIdentity:describeImproveRuntime(installation),
  files:candidates.flatMap(c=>(c.replacements??[]).map(r=>({targetId:c.target.id,path:r.path}))),
  comparison:{...structuredClone(check.comparison),scale:'relative'},...(check.effectiveTask?{effectiveTask:check.effectiveTask}:{}),
  options:{purpose:`improve ${report.id} · ${candidates.map(c=>c.display).join(' + ')}`,mode:check.mode,cases,
   budget:{...budget,deadline,unknownUpperBound:check.mode==='live'?{tokens:budget.maxRequestTokens,source:'https://api-docs.deepseek.com/quick_start/pricing'}:null},
   trialTimeoutMs:check.trialTimeoutMs,gradingTimeoutMs:check.gradingTimeoutMs,maxOutputTokens:check.maxOutputTokens,paid:check.mode==='live',
   price:check.mode==='live'?hostPlanPrice('deepseek','deepseek-flash'):{version:'offline-zero-cny-v1',source:'deterministic local transport; no model inference or paid network',currency:'CNY',perMillionTokens:0}}};
 return result;
}

/** Absolute values for resource probes retain their declared unit. Fresh d/δ
 * follows new eval plans: relative ratios, except task-pass's pass difference. */
export function candidateCheckDuration(check:CandidateCheck){return check.kind==='fresh'?check.budget.maxDurationMs:check.timeoutMs;}
