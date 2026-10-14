#!/usr/bin/env node
// Exact source, memory-only fixture. No actual grant/product/provider/VM/credential.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {authenticationStop} from './harness/common.mjs';
import {deriveProposal,PURPOSE} from './harness/preflight.mjs';
const root=path.dirname(url.fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]);
assert.ok(out.startsWith(root+'/'));assert.equal(fs.existsSync(out),false);
const hash=b=>createHash('sha256').update(b).digest('hex'),cache=new Map();
const actual=p=>{p=String(p);assert.notEqual(p,'/Users/nineofour/Durio/api.env','CREDENTIAL_READ_FORBIDDEN');if(!cache.has(p))cache.set(p,fs.readFileSync(p));return cache.get(p);};
const preparation=JSON.parse(actual(path.join(root,'preparation.json'))),original=JSON.parse(actual(preparation.prior.proposal.path));
const manifestPath=path.join(root,'checked-manifest.json'),proposalPath=path.join(root,'proposed-batch-reviewed.json');
const grantPath='/OFFLINE_MEMORY_ONLY/new-grant.json',authPath='/OFFLINE_MEMORY_ONLY/new-auth.json',artifactPath=preparation.artifact.path,gatePath=preparation.candidateGate.path,proofPath='/OFFLINE_MEMORY_ONLY/independent-proof.json';
const BASE=Date.parse('2026-10-10T10:00:00.000Z'),results=[];
async function fixture(name,options={}){
 const effects=[],saved=new Map(),overrides=new Map(),handlers=new Map();let now=options.expiryOffset===undefined?BASE+1000:BASE+86400000-1;
 const write=(p,v)=>overrides.set(String(p),Buffer.from(JSON.stringify(v,null,2)+'\n'));
 const read=p=>overrides.get(String(p))??(saved.has(String(p))?Buffer.from(JSON.stringify(saved.get(String(p)),null,2)+'\n'):actual(p));
 const file=p=>({path:p,bytes:read(p).length,sha256:hash(read(p))});
 const freeze={...structuredClone(preparation),status:'FROZEN_IMPROVE_OUTPUT_CONTRACT_PENDING_NEW_EXPLICIT_ONE_START',harness:['run.mjs','common.mjs','preflight.mjs','ledger.mjs','launch.py','prepare-output.py'].map(n=>file(path.join(root,'harness',n)))};
 const artifact=JSON.parse(actual(preparation.artifact.path));freeze.artifact=structuredClone(preparation.artifact);
 const gate=JSON.parse(actual(preparation.candidateGate.path));freeze.candidateGate=structuredClone(preparation.candidateGate);
 const proposal=deriveProposal(original,root,freeze.artifact,freeze.providerObservation,freeze.prior,freeze.candidateGate,freeze.previousImprove);
 const authorization={kind:'improve-output-contract-one-start',author:'human-user',source:{kind:'codex-user-reply',requestToolCallId:'OFFLINE_MEMORY_ONLY_NOT_A_REAL_CALL'},manifestSha256:null,batchId:freeze.batchId,priorManifestSha256:freeze.previousImprove.manifest.sha256,priorBudgetSha256:freeze.previousImprove.cumulativeBudget.sha256,receivedAt:new Date(BASE).toISOString(),exactHumanReply:'OFFLINE MEMORY FIXTURE ONLY: no real approval',limits:freeze.limits};
 const grant={paidApproved:true,manifestSha256:null,batchId:freeze.batchId,humanAuthorization:authorization.exactHumanReply,authorizationSource:null,credentialSource:'/Users/nineofour/Durio/api.env',grantedAt:authorization.receivedAt,limits:structuredClone(freeze.limits)};
 options.mutate?.({freeze,proposal,artifact,gate,grant,authorization,write,file,saved,setNow:v=>now=v});
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
   effects.push('analyzeImprove');assert.equal(o.request.id,'v1-live-r4-improve');assert.equal(o.request.limits.maxRequests,8);assert.equal(o.request.limits.maxTokens,1200000);assert.equal(o.request.limits.maxOutputTokens,8192);o.onObservation({runId:'offline-improve-run'});
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
 synthetic('node:assert/strict',{default:assert});synthetic('node:fs',{readFileSync:(p,encoding)=>encoding?read(p).toString(encoding):read(p),existsSync:p=>overrides.has(String(p))||saved.has(String(p))||fs.existsSync(p)});synthetic('node:path',{dirname:path.dirname,join:path.join,resolve:path.resolve});synthetic('node:url',{fileURLToPath:url.fileURLToPath});synthetic('common',common);
 for(const name of ['preflight','ledger','run'])modules.set(name,new vm.SourceTextModule(actual(path.join(root,'harness',name+'.mjs')).toString(),{context,identifier:name,initializeImportMeta(meta){meta.url=url.pathToFileURL(path.join(root,'harness',name+'.mjs')).href;}}));
 const paidBefore=saved.get(path.join(root,'paid-start.json'));
 await modules.get('run').link(id=>modules.get(id.startsWith('./')?id.slice(2,-4):id));let error=null;try{await modules.get('run').evaluate();}catch(e){error=e.message;}
 const result=saved.get(path.join(root,'batch-result.json')),paid=saved.get(path.join(root,'paid-start.json')),budget=saved.get(path.join(root,'cumulative-budget.json'));
 if(options.deny){assert.match(error,options.deny,name);assert.equal(effects.length,0,'Must reject before installation/product/credential');assert.equal(paid,paidBefore);}
 else if(options.expiryOffset>0){assert.match(error,/GRANT_EXPIRED_BEFORE_START/);assert.equal(paid,undefined);assert.deepEqual(effects,['verify-installation','installed','validate-improve']);}
 else{
  assert.equal(error,null,name);assert.ok(paid);assert.equal(Date.parse(paid.deadline)-Date.parse(paid.startedAt),3600000);assert.equal(handlers.size,0);assert.equal(paid.priorUnknownReservationRetained,1056768);
  assert.equal(effects.filter(e=>e==='analyzeImprove').length,1);assert.equal(budget.prior.requests,41);assert.equal(budget.prior.knownTokens,106026);assert.equal(budget.prior.unknown,1);assert.equal(paid.priorBudget.sha256,freeze.previousImprove.cumulativeBudget.sha256);assert.equal(proposal.improve.request.purpose,PURPOSE);assert.equal(proposal.aggregate.conservativeUsdUpper,2.8353528);assert.equal(budget.prior.reservedTokens,1056768);assert.equal(budget.stages.length,1);assert.ok(budget.chargedUpperTokens<=2362794);if(result.selection!==undefined)assert.equal(result.selection,'none; paid grant does not select unknown future candidates');
  if(options.scenario==='new-unknown'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.reservedTokens,2113536);assert.equal(budget.stages[0].unknown,1);}
  else if(options.scenario==='unavailable-ledger'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.chargedUpperTokens,2362794);assert.equal(budget.requestCompleteness,'unknown');}
  else if(options.scenario==='bound-exceeded'){assert.equal(result.status,'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED');assert.equal(budget.boundExceeded,true);}
  else if(options.scenario==='cancel'){assert.equal(result.status,'CANCELLED');assert.equal(proc.exitCode,130);assert.equal([...saved.keys()].filter(p=>p.endsWith('cancellation-request.json')).length,1);}
  else if(['auth401','auth403','analysis-error'].includes(options.scenario)){assert.equal(result.status,'STOPPED');}
  else assert.equal(result.status,options.scenario==='zero-candidate'?'STOPPED_NO_EXECUTABLE_CHAIN':'AWAITING_ACTUAL_CANDIDATE_SELECTION');
  if(options.expiryOffset===0)assert.equal(paid.startedAt,new Date(BASE+86400000).toISOString());
 }
 results.push({name,status:'PASS',scope:'Exact-source memory-only fixture',error,effects,resultStatus:result?.status??null,cumulativeBudget:budget??null,actualRunnerWrites:0});
}
try{
 await fixture('valid-confirmed-input-and-latest-cumulative-accounting');
 await fixture('old-r2-batch-grant-denied',{mutate:({grant})=>grant.batchId='pi-durio-v1-live-r3-improve-repair',deny:/GRANT_BATCH_MISMATCH/});
 await fixture('old-r2-authorization-kind-denied',{mutate:({authorization})=>authorization.kind='improve-repair-one-start',deny:/NEW_AUTHORIZATION_KIND_REQUIRED/});
 await fixture('consumed-r2-source-denied',{mutate:({grant,freeze})=>grant.authorizationSource=freeze.previousImprove.authorizationSource,keepSource:true,deny:/LATEST_AUTHORIZATION_NOT_REUSABLE/});
 await fixture('grant-before-latest-closed-run-denied',{mutate:({authorization,grant})=>authorization.receivedAt=grant.grantedAt='2026-10-10T09:45:37.084Z',deny:/NEW_GRANT_EXPIRED_OR_INVALID/});
 await fixture('older-cumulative-ledger-not-latest-denied',{mutate:({freeze})=>freeze.previousImprove.cumulativeBudget=freeze.prior.cumulativeBudget,deny:/LATEST_LEDGER_REQUIRED/});
 await fixture('raw952-cannot-replace-old-unknown',{mutate:({freeze,write,file})=>{const p='/OFFLINE_MEMORY_ONLY/altered-ledger.json',d=JSON.parse(actual(freeze.previousImprove.cumulativeBudget.path));d.knownTokens+=952;d.reservedTokens=0;write(p,d);freeze.previousImprove.cumulativeBudget=file(p);},deny:/LATEST_LEDGER_REQUIRED/});
 await fixture('raw-draft-cannot-be-promoted',{mutate:({freeze,write,file})=>{const p='/OFFLINE_MEMORY_ONLY/altered-report.json',d=JSON.parse(actual(freeze.previousImprove.improveResult.path));d.improve.candidates=[{rawOnly:true}];write(p,d);freeze.previousImprove.improveResult=file(p);},deny:/1 !== 0/});
 await fixture('purpose-drift-denied',{mutate:({freeze,write,file})=>{write(freeze.purpose.path,'Return a candidate regardless of evidence.');freeze.purpose=file(freeze.purpose.path);},deny:/EXACT_APPROVED_PURPOSE_REQUIRED/});
 await fixture('protected-scope-widening-denied',{mutate:({proposal})=>proposal.improve.request.sources[0].paths.push('other.ts'),deny:/PROPOSAL_NOT_EXACT_INPUT_REVISION/});
 await fixture('new-unknown-keeps-old-reservation-and-stops',{scenario:'new-unknown'});
 await fixture('unavailable-new-ledger-holds-full-stage',{scenario:'unavailable-ledger'});
 const value={status:'PASS',cases:results.length,scope:'Exact source in node:vm module sandbox; candidate/grant/review records, API and receipts are artificial memory-only fixtures. Fixed product metadata are read-only; no real authorization or product execution implied.',results,realCredentialReads:0,newProviderRequests:0,newRestrictedVmStarts:0,actualRunnerWrites:0,sources:['preflight.mjs','ledger.mjs','run.mjs'].map(n=>({path:path.join(root,'harness',n),sha256:hash(actual(path.join(root,'harness',n)))}))};
 fs.writeFileSync(out,JSON.stringify(value,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:value.status,cases:value.cases}));
}catch(error){fs.writeFileSync(out,JSON.stringify({status:'FAIL',passed:results,error:{message:error.message,stack:error.stack}},null,2)+'\n',{flag:'wx'});throw error;}
