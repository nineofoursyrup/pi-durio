/** Host binding for declared checks: retained cases, runtime identity and deadlines.
 * Product analysis imports the pure declaration module without this host graph. */
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {digest,readObject} from './evidence.js';
import {parseEvalAsset} from './improve-eval-assets.js';
import {sourceBytes,listRegisteredSources} from './improve-source.js';
import type {ImproveCandidate,ImproveReport} from './improve.js';
import {describeImproveRuntime,type FreshCheck,type ImproveCheck} from './improve-validation.js';
import {verifiedImage} from './eval/plan.js';
import {installedRuntimeFiles} from './eval/store.js';
import {hostPlanPrice} from './cost-estimate.js';
import {validateCandidateChecks,type CandidateCheck} from './improve-check-declaration.js';
export {validateCandidateChecks,type CandidateCheck,type CandidateFreshCheck} from './improve-check-declaration.js';

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
