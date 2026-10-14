#!/usr/bin/env node
// Exact runner/gate source with memory-only authorization, installed API, clock and outputs.
// No real grant, credential read, product execution, provider, restricted VM or persistent receipt.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {authenticationStop} from './harness/common.mjs';
const root=path.dirname(url.fileURLToPath(import.meta.url));
const resultPath=path.resolve(process.argv[2]);
assert.ok(resultPath.startsWith(root+'/'),'Result must stay inside new batch evidence');
assert.equal(fs.existsSync(resultPath),false,'Do not overwrite first check results');
const hash=b=>createHash('sha256').update(b).digest('hex'),cacheBytes=new Map();
const actualRead=p=>{p=String(p);assert.notEqual(p,'/Users/nineofour/Durio/api.env','REAL_CREDENTIAL_READ_FORBIDDEN');if(!cacheBytes.has(p))cacheBytes.set(p,fs.readFileSync(p));return cacheBytes.get(p);};
const manifestPath=path.join(root,'checked-manifest.json'),manifest=JSON.parse(actualRead(manifestPath));
for(const entry of manifest.harness)assert.equal(hash(actualRead(entry.path)),entry.sha256);
const baseProposal=JSON.parse(actualRead(manifest.proposal.path)),priorManifest=JSON.parse(actualRead(manifest.prior.manifest.path));
const grantPath='/OFFLINE_MEMORY_ONLY/supplement-grant.json',authorizationPath='/OFFLINE_MEMORY_ONLY/new-human-source.json';
const BASE=Date.parse('2026-10-10T06:30:00.000Z');
const results=[];
async function fixture(name,options={}){
 const effects=[],saved=new Map(),overrides=new Map(),handlers=new Map();let now=options.expiryOffset===undefined?BASE+1000:BASE+86400000-1;
 const writeVirtual=(p,v)=>overrides.set(p,Buffer.from(JSON.stringify(v,null,2)+'\n'));
 const freeze=structuredClone(manifest),proposal=structuredClone(baseProposal);
 const authorization={kind:'supplemental-one-start',manifestSha256:null,batchId:manifest.batchId,priorManifestSha256:manifest.prior.manifest.sha256,receivedAt:new Date(BASE).toISOString(),exactHumanReply:'OFFLINE FIXTURE ONLY: one supplemental start; no actual human grant',limits:structuredClone(manifest.limits)};
 const grant={paidApproved:true,manifestSha256:null,batchId:manifest.batchId,humanAuthorization:authorization.exactHumanReply,authorizationSource:null,credentialSource:'/Users/nineofour/Durio/api.env',grantedAt:authorization.receivedAt,limits:structuredClone(manifest.limits)};
 const read=p=>{p=String(p);return overrides.get(p)??(saved.has(p)?Buffer.from(JSON.stringify(saved.get(p),null,2)+'\n'):actualRead(p));};
 const file=p=>{const b=read(p);return {path:p,bytes:b.length,sha256:hash(b)};};
 if(options.mutate)options.mutate({freeze,proposal,grant,authorization,writeVirtual,file,saved,setNow:v=>{now=v;}});
 writeVirtual(freeze.proposal.path,proposal);freeze.proposal=file(freeze.proposal.path);
 writeVirtual(manifestPath,freeze);grant.manifestSha256=file(manifestPath).sha256;authorization.manifestSha256=grant.manifestSha256;
 writeVirtual(authorizationPath,authorization);if(!options.keepAuthorizationSource)grant.authorizationSource=file(authorizationPath);
 writeVirtual(grantPath,grant);
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const proc={argv:['node',path.join(root,'harness/run.mjs'),manifestPath,grantPath],env:new Proxy({DEEPSEEK_API_KEY:'literal-offline-fixture-only'},{get:(t,k)=>{if(k==='DEEPSEEK_API_KEY')effects.push('credential-lookup');return t[k];}}),on:(signal,fn)=>{handlers.set(signal,fn);},removeListener:(signal,fn)=>{assert.equal(handlers.get(signal),fn);handlers.delete(signal);},exitCode:0};
 const context=vm.createContext({Date:FakeDate,process:proc,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},fetch(){throw Error('NETWORK_FORBIDDEN');}});
 const parse=vm.runInContext('JSON.parse',context),clone=v=>parse(JSON.stringify(v));context.structuredClone=clone;
 const contextualFile=p=>clone(file(p)),json=p=>parse(read(p).toString());
 const bodyMap=new Map(),records=[];
 function fact(runId,kind,data){const seq=records.length+1,ref={sha256:`offline-${seq}`,bytes:0};bodyMap.set(ref.sha256,JSON.stringify(data));records.push({seq,runId,kind,ref});}
 function knownRequest(runId,id,tokens=150){fact(runId,'budget.reserve',{id,tokens:runId===proposal.evalPlan.id?1052672:1056768});fact(runId,'provider.dispatch',{id});fact(runId,'budget.settle',{id,tokens,status:'returned'});}
 let evaluation;
 const api={
  validation:{describeImproveRuntime:()=>JSON.parse(actualRead(freeze.artifact.path)).linuxRuntimeIdentity},
  improve:{validateImproveRequest:()=>effects.push('validate-improve'),readImproveReport:()=>clone({report:{state:'complete'},selected:[],execution:'not-started'})},
  eval:{prepareEval:async o=>{effects.push('prepareEval');assert.equal(o.budget.maxRequests,24);assert.equal(o.budget.maxTokens,1172501);assert.equal(o.trials.length,3);assert.equal(o.trials[0].id,'v1-live-r2-multi-file');return clone({plan:{...proposal.evalPlan,budget:o.budget,authorization:{...proposal.evalPlan.authorization,paid:o.paid}}});},runEval:async o=>{
   effects.push('runEval');
   evaluation={planId:proposal.evalPlan.id,trials:proposal.evalPlan.trials.map(t=>({...t,outcome:{started:true,valid:true,status:'completed',source:`offline-outcome-${t.id}`},grade:{judgment:'PASS',outcome:`offline-outcome-${t.id}`}})),counts:{passed:3},budget:{missing:0,boundsExceeded:0}};
   for(const t of evaluation.trials)knownRequest(proposal.evalPlan.id,t.id);
   if(options.scenario==='unknown-usage'){fact(proposal.evalPlan.id,'budget.reserve',{id:'offline-unknown',tokens:1052672});fact(proposal.evalPlan.id,'provider.dispatch',{id:'offline-unknown'});fact(proposal.evalPlan.id,'budget.settle',{id:'offline-unknown',tokens:null,status:'unknown'});evaluation.budget.missing=1;}
   if(options.scenario==='two-pass'){evaluation.trials[2].grade.judgment='unknown';evaluation.counts.passed=2;}
   if(options.scenario==='four-count'){evaluation.counts.passed=4;}
   if(options.scenario==='wrong-trial'){evaluation.trials[0].id='v1-live-r1-multi-file';}
   if(options.scenario==='failed-outcome'){
    evaluation.trials[0].outcome.status='error';evaluation.trials[0].grade.judgment='unknown';evaluation.counts.passed=2;
    fact(proposal.evalPlan.id,'eval.outcome',{status:'error'});o.fault('eval.budget-snapshot');assert.equal(o.signal.aborted,true);effects.push('first-failure-aborted');
   }
   if(options.scenario==='auth-stop'){
    fact(proposal.evalPlan.id,'provider.http',{id:'offline-http-401',status:401});o.fault('budget.reserve');throw Error('AUTH_STOP_DID_NOT_THROW');
   }
   if(options.scenario==='cancel'){
    handlers.get('SIGINT')();handlers.get('SIGINT')();handlers.get('SIGTERM')();assert.equal(o.signal.aborted,true);assert.ok(handlers.has('SIGINT')&&handlers.has('SIGTERM'));effects.push('cleanup-with-handlers');
   }
   return clone(evaluation);
  }},
  query:{readRunRecords:(dataRoot,runId,o)=>{
   if(options.scenario==='unavailable-ledger'&&o.kinds.includes('budget.settle'))throw Error('OFFLINE_CONTROLLED_READ_GAP');
   let found=records.filter(r=>r.runId===runId&&o.kinds.includes(r.kind));if(o.tail)found=found.slice(-o.limit);else found=found.filter(r=>r.seq>(o.after??0));const page=found.slice(0,o.limit);return clone({records:page,more:found.length>page.length});
  }},
  runtime:{readObject:(dataRoot,ref)=>{assert.ok(bodyMap.has(ref.sha256));return bodyMap.get(ref.sha256);},analyzeImprove:async o=>{
   effects.push('analyzeImprove');assert.equal(o.request.limits.maxRequests,8);assert.equal(o.request.limits.maxTokens,1200000);assert.equal(o.request.id,'v1-live-r2-improve');o.onObservation({runId:'offline-improve-run'});knownRequest('offline-improve-run','offline-improve-request',250);
   return clone({runId:'offline-improve-run',status:'completed',cleanup:'confirmed',improve:{state:'complete',id:o.request.id,revision:'offline-revision',candidates:options.scenario==='zero-candidate'?[]:[{id:'offline-candidate-not-real-content'}]}});
  }}
 };
 const common={json,file:contextualFile,sha:hash,save:(p,v)=>{assert.ok(p.startsWith(root+'/'),'No writes outside new output');assert.equal(saved.has(p),false,'NO_OVERWRITE');saved.set(p,JSON.parse(JSON.stringify(v)));},verifyInstallation(){effects.push('verify-installation');if(options.expiryOffset!==undefined)now=BASE+86400000+options.expiryOffset;},installed:async()=>{effects.push('installed');return api;},authenticationStop};
 const modules=new Map();
 function synthetic(id,exports){const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:id});modules.set(id,m);}
 synthetic('node:assert/strict',{default:assert});synthetic('node:fs',{readFileSync:read,existsSync:p=>overrides.has(String(p))||saved.has(String(p))||fs.existsSync(p)});synthetic('node:path',{dirname:path.dirname,join:path.join,resolve:path.resolve});synthetic('node:url',{fileURLToPath:url.fileURLToPath});synthetic('common',common);
 for(const name of ['preflight','supplement','run'])modules.set(name,new vm.SourceTextModule(actualRead(path.join(root,'harness',name+'.mjs')).toString(),{context,identifier:name,initializeImportMeta(meta){meta.url=url.pathToFileURL(path.join(root,'harness',name+'.mjs')).href;}}));
 await modules.get('run').link(id=>modules.get(id.startsWith('./')?id.slice(2,-4):id));
 let error=null;try{await modules.get('run').evaluate();}catch(e){error=e.message;}
 const result=saved.get(path.join(root,'batch-result.json')),paid=saved.get(path.join(root,'paid-start.json')),budget=saved.get(path.join(root,'cumulative-budget.json'));
 if(options.deny){assert.match(error,options.deny,name);assert.equal(effects.length,0,`${name}: denial must precede credential/install/product access`);assert.equal(result,undefined);}
 else if(options.expiryOffset>0){assert.match(error,/GRANT_EXPIRED_BEFORE_START/);assert.equal(paid,undefined);assert.deepEqual(effects,['verify-installation','installed','validate-improve']);}
 else{
  assert.equal(error,null,name);assert.ok(paid);assert.equal(Date.parse(paid.deadline)-Date.parse(paid.startedAt),3600000);assert.equal(paid.originalBatchStatus,'STOPPED');assert.equal(handlers.size,0,'Handlers removed only after receipts');
  if(options.noImprove){assert.equal(effects.includes('analyzeImprove'),false);assert.equal(result.improve,'not-run');}
  else {assert.equal(effects.includes('analyzeImprove'),true);assert.equal(result.status,options.scenario==='zero-candidate'?'STOPPED_NO_EXECUTABLE_CHAIN':'AWAITING_ACTUAL_CANDIDATE_SELECTION');}
  assert.equal(result.originalBatchStatus,'STOPPED');assert.equal(result.reusedPass,'v1-live-r1-local-fix');assert.ok(budget.chargedUpperTokens<=2400000);assert.equal(budget.prior.knownTokens,27499);
  if(options.scenario==='unknown-usage'){assert.equal(budget.stages[0].reservedTokens,1052672);assert.equal(budget.stages[0].unknown,1);assert.equal(budget.stages[1].entered,false);}
  if(options.scenario==='unavailable-ledger'){assert.equal(budget.chargedUpperTokens,2400000);assert.equal(budget.requestCompleteness,'unknown');assert.ok(budget.stages.every(s=>s.completeness==='unavailable-full-stage-held'));}
  if(options.scenario==='cancel'){assert.equal(result.status,'CANCELLED');assert.equal(proc.exitCode,130);assert.equal([...saved.keys()].filter(p=>p.endsWith('/cancellation-request.json')).length,1);}
  if(options.expiryOffset===0)assert.equal(paid.startedAt,new Date(BASE+86400000).toISOString());
 }
 results.push({name,status:'PASS',scope:'memory-only exact-source runner/gate fixture',error,effects,resultStatus:result?.status??null,cumulativeBudget:budget??null,actualRunnerFilesWritten:0});
}
try{
 await fixture('grant-false',{mutate:({grant})=>{grant.paidApproved=false;},deny:/EXPLICIT_NEW_PAID_GRANT_REQUIRED/});
 await fixture('old-40-request-grant',{mutate:({grant})=>{grant.limits.maxRequests=40;},deny:/EXACT_SUPPLEMENT_LIMITS_REQUIRED/});
 await fixture('old-authorization-source',{mutate:({grant})=>{grant.authorizationSource=priorManifest.authorizationEvidence;},keepAuthorizationSource:true,deny:/OLD_AUTHORIZATION_NOT_REUSABLE/});
 await fixture('new-grant-source-time-mismatch',{mutate:({grant})=>{grant.grantedAt=new Date(BASE+1).toISOString();},deny:/NEW_GRANT_TIME_MUST_MATCH_SOURCE/});
 await fixture('new-grant-before-original-stop',{mutate:({grant,authorization,setNow})=>{grant.grantedAt=authorization.receivedAt='2026-10-10T05:50:00Z';setNow(BASE);},deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('new-grant-expired',{mutate:({setNow})=>setNow(BASE+86400001),deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('new-grant-in-future',{mutate:({setNow})=>setNow(BASE-1),deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('repeat-start',{mutate:({saved})=>saved.set(path.join(root,'paid-start.json'),{offlinePrevious:true}),deny:/BATCH_ALREADY_STARTED/});
 await fixture('prior-result-tampered',{mutate:({freeze,writeVirtual})=>writeVirtual(freeze.prior.liveResult.path,{tampered:true}),deny:/FROZEN_CONTENT_CHANGED/});
 await fixture('prior-unknown-ledger-rejected',{mutate:({freeze,writeVirtual,file})=>{const p=freeze.prior.ledger.path,v=JSON.parse(actualRead(p));v.prior.unknown=1;writeVirtual(p,v);freeze.prior.ledger=file(p);},deny:/PRIOR_LEDGER_CHANGED/});
 await fixture('eval-stage-expanded',{mutate:({proposal})=>{proposal.evalPlan.budget.maxTokens=1200000;},deny:/PROPOSAL_NOT_EXACT_SUPPLEMENT/});
 await fixture('improve-truncated',{mutate:({proposal})=>{proposal.improve.request.limits.maxRequests=1;},deny:/PROPOSAL_NOT_EXACT_SUPPLEMENT/});
 await fixture('extra-fourth-trial',{mutate:({proposal})=>{proposal.evalPlan.trials.push({...proposal.evalPlan.trials[0],id:'unexpected-fourth'});},deny:/PROPOSAL_NOT_EXACT_SUPPLEMENT/});
 await fixture('expires-during-installation',{expiryOffset:1});
 await fixture('start-exactly-at-window-boundary',{expiryOffset:0});
 await fixture('exact-three-passes-enter-improve');
 await fixture('two-pass-does-not-enter-improve',{scenario:'two-pass',noImprove:true});
 await fixture('old-four-count-not-accepted',{scenario:'four-count',noImprove:true});
 await fixture('old-trial-id-not-accepted',{scenario:'wrong-trial',noImprove:true});
 await fixture('first-failure-cancels-and-retains',{scenario:'failed-outcome',noImprove:true});
 await fixture('unknown-usage-stops-and-retains-reservation',{scenario:'unknown-usage',noImprove:true});
 await fixture('http401-blocks-next-reservation',{scenario:'auth-stop',noImprove:true});
 await fixture('repeated-cancel-retains-cleanup-handlers',{scenario:'cancel',noImprove:true});
 await fixture('zero-candidate-kept-without-retry',{scenario:'zero-candidate'});
 await fixture('unavailable-ledger-holds-full-stage-allowances',{scenario:'unavailable-ledger'});
 const summary={status:'PASS',cases:results.length,manifestSha256:hash(actualRead(manifestPath)),scope:'Exact candidate source in node:vm JavaScript module sandbox; all grants/auth records/API/clock/receipts are memory-only fixtures. No actual credential, provider, restricted VM, installed product execution or paid-start.',results,realCredentialReads:0,newProviderRequests:0,restrictedVmStarts:0,actualRunnerFilesWritten:0,script:{path:url.fileURLToPath(import.meta.url),sha256:hash(fs.readFileSync(url.fileURLToPath(import.meta.url)))}};
 fs.writeFileSync(resultPath,JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:summary.status,cases:summary.cases,manifestSha256:summary.manifestSha256}));
}catch(error){
 fs.writeFileSync(resultPath,JSON.stringify({status:'FAIL',manifestSha256:hash(actualRead(manifestPath)),passedBeforeFirstFailure:results,error:{message:error.message,stack:error.stack},actualRunnerFilesWritten:0},null,2)+'\n',{flag:'wx',mode:0o600});throw error;
}
