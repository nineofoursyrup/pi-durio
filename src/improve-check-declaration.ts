/** Pure analysis declarations; no runtime inventory, host eval or execution. */
import type {SourceTarget} from './improve-source.js';
import type {DirectCheck} from './improve-validation.js';
import {pairedTrials,validateComparison,type ComparisonPlan} from './eval-comparison-plan.js';
import {evalTrialRequests,maxEvalOutputTokens} from './eval-response-budget.js';

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
  if(!only(c,['kind','benefit','assets','mode','comparison','budget','trialTimeoutMs','gradingTimeoutMs','maxOutputTokens','effectiveTask'])||!['offline','live'].includes(c.mode)||!timeout(c.trialTimeoutMs)||!timeout(c.gradingTimeoutMs)||!positive(c.maxOutputTokens)||c.effectiveTask!==undefined&&!['read','coding'].includes(c.effectiveTask))throw Error('IMPROVE_FRESH_DECLARATION_INVALID');
  const b=c.budget;
  if(!b||!only(b,['maxRequests','maxTokens','maxRequestTokens','maxDurationMs'])||!Object.values(b).every(positive)||Object.keys(b).length!==4||b.maxRequests>100||b.maxRequestTokens>b.maxTokens||b.maxDurationMs>3600000||c.mode==='live'&&b.maxRequestTokens<1048576+c.maxOutputTokens)throw Error('IMPROVE_FRESH_BUDGET_INVALID');
  if(!Array.isArray(c.assets)||!c.assets.length||c.assets.length>16||c.assets.some((a:any)=>!a||!only(a,['targetId','path','caseIds'])||!Array.isArray(a.caseIds)||!a.caseIds.length||a.caseIds.some((id:any)=>typeof id!=='string')||!targets.some(t=>t.id===a.targetId&&t.kind==='eval-asset'&&t.state==='verified'&&t.files.some(f=>f.path===a.path&&f.state==='available'))))throw Error('IMPROVE_FRESH_REGISTERED_CASES_REQUIRED');
  if(!c.comparison||!only(c.comparison,['kind','repetitions','repetitionBasis','change','hypothesis','roles','objective','protections','trialBudget']))throw Error('IMPROVE_FRESH_DECLARATION_INVALID');
  const ids=c.assets.flatMap((a:any)=>a.caseIds) as string[];
  if(new Set(ids).size!==ids.length||ids.length>16||ids.length*c.comparison.repetitions*2>32)throw Error('IMPROVE_FRESH_CASES_INVALID');
  const runtime={id:'host-bound-at-summary',manifest:{sha256:'host-bound',bytes:0},bytes:0};
  validateComparison({...c.comparison,scale:'relative',sides:{baseline:{runtime,instructions:''},candidate:{runtime,instructions:''}}},ids,pairedTrials('declaration',ids,c.comparison.repetitions),b);
  if(c.maxOutputTokens>maxEvalOutputTokens(evalTrialRequests(c)))throw Error('IMPROVE_FRESH_DECLARATION_INVALID');
 }
}
