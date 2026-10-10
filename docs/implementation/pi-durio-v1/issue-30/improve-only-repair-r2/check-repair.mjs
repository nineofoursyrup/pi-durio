#!/usr/bin/env node
// Exact source, memory-only fixture. No actual grant/product/provider/VM/credential.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {authenticationStop} from './harness/common.mjs';
const root=path.dirname(url.fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]);
assert.ok(out.startsWith(root+'/'));assert.equal(fs.existsSync(out),false);
const hash=b=>createHash('sha256').update(b).digest('hex'),cache=new Map();
const actual=p=>{p=String(p);assert.notEqual(p,'/Users/nineofour/Durio/api.env','CREDENTIAL_READ_FORBIDDEN');if(!cache.has(p))cache.set(p,fs.readFileSync(p));return cache.get(p);};
const preparation=JSON.parse(actual(path.join(root,'preparation.json'))),original=JSON.parse(actual(preparation.prior.proposal.path));
const manifestPath=path.join(root,'checked-manifest.json'),proposalPath=path.join(root,'proposed-batch-reviewed.json');
const grantPath='/OFFLINE_MEMORY_ONLY/new-grant.json',authPath='/OFFLINE_MEMORY_ONLY/new-auth.json',artifactPath='/OFFLINE_MEMORY_ONLY/new-artifact.json',gatePath='/OFFLINE_MEMORY_ONLY/new-gate.json',proofPath='/OFFLINE_MEMORY_ONLY/independent-proof.json';
const BASE=Date.parse('2026-10-10T07:00:00.000Z'),results=[];
async function fixture(name,options={}){
 const effects=[],saved=new Map(),overrides=new Map(),handlers=new Map();let now=options.expiryOffset===undefined?BASE+1000:BASE+86400000-1;
 const write=(p,v)=>overrides.set(String(p),Buffer.from(JSON.stringify(v,null,2)+'\n'));
 const read=p=>overrides.get(String(p))??(saved.has(String(p))?Buffer.from(JSON.stringify(saved.get(String(p)),null,2)+'\n'):actual(p));
 const file=p=>({path:p,bytes:read(p).length,sha256:hash(read(p))});
 const freeze={...structuredClone(preparation),status:'FROZEN_IMPROVE_REPAIR_PENDING_NEW_EXPLICIT_ONE_START',harness:['run.mjs','common.mjs','preflight.mjs','ledger.mjs','launch.py','prepare-repair.py'].map(n=>file(path.join(root,'harness',n)))};
 const artifact={...JSON.parse(actual(original.artifact.path)),producer:'dddddddddddddddddddddddddddddddddddddddd',integratedSource:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'};write(artifactPath,artifact);freeze.artifact=file(artifactPath);
 const gate=JSON.parse(actual(path.join(root,'candidate-gate-template-NOT-FROZEN.json')));gate.status=gate.repairReview.status=gate.applicability.status='PASS';gate.candidate=artifact.integratedSource;
 write(proofPath,{status:'PASS',scope:'OFFLINE_MEMORY_ONLY_NOT_ACTUAL_REVIEW'});gate.repairReview.evidence=[file(proofPath)];gate.applicability.evidence=[file(proofPath)];write(gatePath,gate);freeze.candidateGate=file(gatePath);
 const improve=structuredClone(original.improve);improve.dataRoot=path.join(root,'improve-data');improve.request.id='v1-live-r3-improve';
 const proposal={status:'PENDING_EXPLICIT_NEW_HUMAN_GRANT; not an executable paid plan',batchId:freeze.batchId,artifact:freeze.artifact,improve,model:original.evalPlan.model,price:original.evalPlan.price,aggregate:{newRequests:8,newTokens:1200000,prior:{requests:34,knownTokens:61560,reservedTokens:1056768,unknown:1},cumulativeRequests:42,cumulativeChargedTokens:2318328,conservativeUsdUpper:2.7819936,usdCeiling:3},window:{grantToStartMs:86400000,activeMs:3600000,starts:1,definition:'One fresh improve-only start within 24 hours of the new grant; immutable deadline start+60 minutes. No resume or replacement after interruption, unknown usage or expiry.'},credential:{source:'/Users/nineofour/Durio/api.env',readiness:'PENDING_NEW_EXPLICIT_ONE_START; no credential read during preparation'},providerRecheck:freeze.providerObservation,prior:freeze.prior,candidateGate:freeze.candidateGate,stops:['Any authentication, cancellation, failed/incomplete report, new unknown usage, deadline or budget violation stops; no automatic retry or restart.','Zero candidates remain zero; no fabricated or silently substituted candidate.'],futureSelection:'Only a later explicit human choice of an actual report/revision/candidate may authorize candidate execution or writeback; the paid grant selects nothing.',eval:'No paid eval in this batch. Prior four different case PASS records retain their original product/run identities; affected applicability review is separate.',finding:'LIVE-USD3-R3-01',preservation:'Original r2 STOPPED, multi-file error/unknown and r3 STOPPED_NO_EXECUTABLE_CHAIN/UNKNOWN reservation remain immutable; raw 952 does not replace prior host accounting.'};
 const authorization={kind:'improve-repair-one-start',author:'human-user',source:{kind:'codex-user-reply',requestToolCallId:'OFFLINE_MEMORY_ONLY_NOT_A_REAL_CALL'},manifestSha256:null,batchId:freeze.batchId,priorManifestSha256:freeze.prior.manifest.sha256,priorBudgetSha256:freeze.prior.cumulativeBudget.sha256,receivedAt:new Date(BASE).toISOString(),exactHumanReply:'OFFLINE MEMORY FIXTURE ONLY: no real approval',limits:freeze.limits};
 const grant={paidApproved:true,manifestSha256:null,batchId:freeze.batchId,humanAuthorization:authorization.exactHumanReply,authorizationSource:null,credentialSource:'/Users/nineofour/Durio/api.env',grantedAt:authorization.receivedAt,limits:structuredClone(freeze.limits)};
 options.mutate?.({freeze,proposal,artifact,gate,grant,authorization,write,file,saved,setNow:v=>now=v});
 write(artifactPath,artifact);freeze.artifact=file(artifactPath);proposal.artifact=freeze.artifact;
 write(gatePath,gate);freeze.candidateGate=file(gatePath);proposal.candidateGate=freeze.candidateGate;
 write(proposalPath,proposal);freeze.proposal=file(proposalPath);write(manifestPath,freeze);
 grant.manifestSha256=file(manifestPath).sha256;authorization.manifestSha256=grant.manifestSha256;write(authPath,authorization);
 if(!options.keepSource)grant.authorizationSource=file(authPath);write(grantPath,grant);
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const proc={argv:['node',path.join(root,'harness/run.mjs'),manifestPath,grantPath],env:new Proxy({DEEPSEEK_API_KEY:'OFFLINE_LITERAL_NO_SECRET'},{get:(t,k)=>{if(k==='DEEPSEEK_API_KEY')effects.push('credential-lookup');return t[k];}}),on:(s,f)=>handlers.set(s,f),removeListener:(s,f)=>{assert.equal(handlers.get(s),f);handlers.delete(s);},exitCode:0};
 const context=vm.createContext({Date:FakeDate,process:proc,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},fetch(){throw Error('NETWORK_FORBIDDEN');}});
 const parse=vm.runInContext('JSON.parse',context),clone=v=>parse(JSON.stringify(v));context.structuredClone=clone;
 const bodies=new Map(),records=[];
 function fact(kind,data){const seq=records.length+1,ref={sha256:`fixture-${seq}`,bytes:0};bodies.set(ref.sha256,JSON.stringify(data));records.push({seq,kind,ref});}
 const api={improve:{validateImproveRequest:()=>effects.push('validate-improve'),readImproveReport:()=>clone({report:{state:'complete'},selected:[],execution:'not-started'})},
  eval:new Proxy({},{get(){throw Error('EVAL_FORBIDDEN');}}),validation:new Proxy({},{get(){throw Error('CANDIDATE_ACTION_FORBIDDEN');}}),
  query:{readRunRecords:(dataRoot,runId,o)=>{if(options.scenario==='unavailable-ledger'&&o.kinds.includes('budget.settle'))throw Error('OFFLINE_READ_GAP');const all=records.filter(r=>o.kinds.includes(r.kind)&&r.seq>(o.after??0));return clone({records:all.slice(0,o.limit),more:all.length>o.limit});}},
  runtime:{readObject:(dataRoot,ref)=>{assert.ok(bodies.has(ref.sha256));return bodies.get(ref.sha256);},analyzeImprove:async o=>{
   effects.push('analyzeImprove');assert.equal(o.request.id,'v1-live-r3-improve');assert.equal(o.request.limits.maxRequests,8);assert.equal(o.request.limits.maxTokens,1200000);assert.equal(o.request.limits.maxOutputTokens,8192);o.onObservation({runId:'offline-improve-run'});
   fact('budget.reserve',{id:'request-1',tokens:1056768});fact('provider.dispatch',{id:'request-1'});
   fact('budget.settle',{id:'request-1',tokens:options.scenario==='new-unknown'?null:options.scenario==='bound-exceeded'?1056769:952,status:options.scenario==='new-unknown'?'cancelled':'returned'});
   if(options.scenario==='auth401'||options.scenario==='auth403'){fact('provider.http',{id:'request-1',status:options.scenario==='auth401'?401:403});o.fault('budget.reserve');throw Error('AUTH_STOP_MISSED');}
   if(options.scenario==='cancel'){handlers.get('SIGINT')();handlers.get('SIGINT')();handlers.get('SIGTERM')();assert.ok(o.signal.aborted&&handlers.has('SIGINT')&&handlers.has('SIGTERM'));effects.push('cleanup-with-handlers');}
   if(options.scenario==='analysis-error')throw Error('OFFLINE_CONTROLLED_ANALYSIS_ERROR');
   return clone({runId:'offline-improve-run',status:'completed',cleanup:'confirmed',improve:{state:'complete',id:o.request.id,revision:'offline-revision',candidates:options.scenario==='zero-candidate'?[]:[{id:'not-a-real-candidate'}]}});
  }}
 };
 const common={json:p=>parse(read(p).toString()),file:p=>clone(file(p)),sha:hash,save:(p,v)=>{assert.ok(p.startsWith(root+'/'));assert.equal(saved.has(p),false);saved.set(p,JSON.parse(JSON.stringify(v)));},verifyInstallation:(p,expected)=>{if(p.endsWith('improve-data')){assert.ok(expected.length);return;}effects.push('verify-installation');if(options.expiryOffset!==undefined)now=BASE+86400000+options.expiryOffset;},installed:async()=>{effects.push('installed');return api;},authenticationStop};
 const modules=new Map();function synthetic(id,exports){modules.set(id,new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:id}));}
 synthetic('node:assert/strict',{default:assert});synthetic('node:fs',{readFileSync:read,existsSync:p=>overrides.has(String(p))||saved.has(String(p))||fs.existsSync(p)});synthetic('node:path',{dirname:path.dirname,join:path.join,resolve:path.resolve});synthetic('node:url',{fileURLToPath:url.fileURLToPath});synthetic('common',common);
 for(const name of ['preflight','ledger','run'])modules.set(name,new vm.SourceTextModule(actual(path.join(root,'harness',name+'.mjs')).toString(),{context,identifier:name,initializeImportMeta(meta){meta.url=url.pathToFileURL(path.join(root,'harness',name+'.mjs')).href;}}));
 const paidBefore=saved.get(path.join(root,'paid-start.json'));
 await modules.get('run').link(id=>modules.get(id.startsWith('./')?id.slice(2,-4):id));let error=null;try{await modules.get('run').evaluate();}catch(e){error=e.message;}
 const result=saved.get(path.join(root,'batch-result.json')),paid=saved.get(path.join(root,'paid-start.json')),budget=saved.get(path.join(root,'cumulative-budget.json'));
 if(options.deny){assert.match(error,options.deny,name);assert.equal(effects.length,0,'Must reject before installation/product/credential');assert.equal(paid,paidBefore);}
 else if(options.expiryOffset>0){assert.match(error,/GRANT_EXPIRED_BEFORE_START/);assert.equal(paid,undefined);assert.deepEqual(effects,['verify-installation','installed','validate-improve']);}
 else{
  assert.equal(error,null,name);assert.ok(paid);assert.equal(Date.parse(paid.deadline)-Date.parse(paid.startedAt),3600000);assert.equal(handlers.size,0);assert.equal(paid.priorUnknownReservationRetained,1056768);
  assert.equal(effects.filter(e=>e==='analyzeImprove').length,1);assert.equal(budget.prior.unknown,1);assert.equal(budget.prior.reservedTokens,1056768);assert.equal(budget.stages.length,1);assert.ok(budget.chargedUpperTokens<=2318328);if(result.selection!==undefined)assert.equal(result.selection,'none; paid grant does not select unknown future candidates');
  if(options.scenario==='new-unknown'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.reservedTokens,2113536);assert.equal(budget.stages[0].unknown,1);}
  else if(options.scenario==='unavailable-ledger'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.chargedUpperTokens,2318328);assert.equal(budget.requestCompleteness,'unknown');}
  else if(options.scenario==='bound-exceeded'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.boundExceeded,true);}
  else if(options.scenario==='cancel'){assert.equal(result.status,'CANCELLED');assert.equal(proc.exitCode,130);assert.equal([...saved.keys()].filter(p=>p.endsWith('cancellation-request.json')).length,1);}
  else if(['auth401','auth403','analysis-error'].includes(options.scenario)){assert.equal(result.status,'STOPPED');}
  else assert.equal(result.status,options.scenario==='zero-candidate'?'STOPPED_NO_EXECUTABLE_CHAIN':'AWAITING_ACTUAL_CANDIDATE_SELECTION');
  if(options.expiryOffset===0)assert.equal(paid.startedAt,new Date(BASE+86400000).toISOString());
 }
 results.push({name,status:'PASS',scope:'Exact-source memory-only fixture',error,effects,resultStatus:result?.status??null,cumulativeBudget:budget??null,actualRunnerWrites:0});
}
try{
 await fixture('false-grant',{mutate:({grant})=>grant.paidApproved=false,deny:/EXPLICIT_NEW_PAID_GRANT_REQUIRED/});
 await fixture('unfrozen-candidate',{mutate:({freeze})=>freeze.status='PREPARATION_ONLY',deny:/REPAIRED_CANDIDATE_NOT_FROZEN/});
 await fixture('old-supplement-grant',{mutate:({grant})=>grant.batchId='pi-durio-v1-live-r2-usd3-supplement',deny:/GRANT_BATCH_MISMATCH/});
 await fixture('old-larger-limits',{mutate:({grant})=>grant.limits.maxRequests=32,deny:/EXACT_REPAIR_LIMITS_REQUIRED/});
 await fixture('old-exact-authorization-source',{mutate:({grant})=>{const oldGrant=JSON.parse(actual(JSON.parse(actual(preparation.prior.paidStart.path)).grant.path));grant.authorizationSource=oldGrant.authorizationSource;},keepSource:true,deny:/OLD_AUTHORIZATION_NOT_REUSABLE/});
 await fixture('old-auth-kind',{mutate:({authorization})=>authorization.kind='supplemental-one-start',deny:/NEW_AUTHORIZATION_KIND_REQUIRED/});
 await fixture('grant-before-r3-ended',{mutate:({grant,authorization})=>grant.grantedAt=authorization.receivedAt='2026-10-10T06:41:35.850Z',deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('grant-expired',{mutate:({setNow})=>setNow(BASE+86400001),deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('grant-future',{mutate:({setNow})=>setNow(BASE-1),deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('grant-source-time-mismatch',{mutate:({grant})=>grant.grantedAt=new Date(BASE+1).toISOString(),deny:/NEW_GRANT_TIME_MUST_MATCH_SOURCE/});
 await fixture('old-budget-source',{mutate:({authorization})=>authorization.priorBudgetSha256='0'.repeat(64),deny:/PRIOR_UNKNOWN_LEDGER_LINK_REQUIRED/});
 await fixture('already-started',{mutate:({saved})=>saved.set(path.join(root,'paid-start.json'),{old:true}),deny:/BATCH_ALREADY_STARTED/});
 await fixture('prior-ledger-raw952-substitution',{mutate:({freeze,write,file})=>{const p=freeze.prior.cumulativeBudget.path,d=JSON.parse(actual(p));d.reservedTokens=0;d.knownTokens+=952;write(p,d);freeze.prior.cumulativeBudget=file(p);},deny:/PRIOR_LEDGER_CHANGED/});
 await fixture('same-old-product',{mutate:({artifact,gate})=>artifact.integratedSource=gate.candidate='9aed1af6ee3b156bb7354961496217aa5e64843e',deny:/REPAIRED_CANDIDATE_REQUIRED/});
 await fixture('producer-is-not-fixed-candidate',{mutate:({artifact,gate})=>gate.candidate=artifact.producer,deny:/CANDIDATE_GATE_BINDING_REQUIRED/});
 await fixture('repair-not-reviewed',{mutate:({gate})=>gate.repairReview.status='PENDING',deny:/PASS/});
 await fixture('prior-pass-relabelled',{mutate:({gate})=>gate.applicability.codingPasses[0].candidate='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',deny:/PRIOR_PASS_EXECUTION_IDENTITIES_CHANGED/});
 await fixture('improve-extra-requests',{mutate:({proposal})=>proposal.improve.request.limits.maxRequests=9,deny:/PROPOSAL_NOT_EXACT_IMPROVE_REPAIR/});
 await fixture('extra-paid-eval',{mutate:({proposal})=>proposal.evalPlan=original.evalPlan,deny:/PROPOSAL_NOT_EXACT_IMPROVE_REPAIR/});
 await fixture('expires-during-installation',{expiryOffset:1});
 await fixture('exact-window-boundary',{expiryOffset:0});
 await fixture('known-new-usage-prior-unknown-retained');
 await fixture('new-unknown-stops',{scenario:'new-unknown'});
 await fixture('provider-bound-exceeded',{scenario:'bound-exceeded'});
 await fixture('unavailable-ledger-full-new-stage-held',{scenario:'unavailable-ledger'});
 await fixture('http401-stops-next-reservation',{scenario:'auth401'});
 await fixture('http403-stops-next-reservation',{scenario:'auth403'});
 await fixture('repeated-cancel-keeps-cleanup-handlers',{scenario:'cancel'});
 await fixture('analysis-error-no-retry',{scenario:'analysis-error'});
 await fixture('zero-candidate-no-selection-or-retry',{scenario:'zero-candidate'});
 const value={status:'PASS',cases:results.length,scope:'Exact source in node:vm module sandbox; candidate/grant/review records, API and receipts are artificial memory-only fixtures. No real repaired candidate or authorization implied.',results,realCredentialReads:0,newProviderRequests:0,newRestrictedVmStarts:0,actualRunnerWrites:0,sources:['preflight.mjs','ledger.mjs','run.mjs'].map(n=>({path:path.join(root,'harness',n),sha256:hash(actual(path.join(root,'harness',n)))}))};
 fs.writeFileSync(out,JSON.stringify(value,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:value.status,cases:value.cases}));
}catch(error){fs.writeFileSync(out,JSON.stringify({status:'FAIL',passed:results,error:{message:error.message,stack:error.stack}},null,2)+'\n',{flag:'wx'});throw error;}
