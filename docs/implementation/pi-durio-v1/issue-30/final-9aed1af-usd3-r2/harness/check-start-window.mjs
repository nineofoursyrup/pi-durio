#!/usr/bin/env node
// Reproduce the independent review's clock-boundary probe with exact frozen source.
// node:vm is only a JavaScript module sandbox, not a product/restricted VM launch.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const root=path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const rawRead=p=>{assert.notEqual(String(p),'/Users/nineofour/Durio/api.env','real credentials forbidden');return fs.readFileSync(p);};
const manifestPath=path.join(root,'frozen-manifest.json'),manifest=JSON.parse(rawRead(manifestPath));
for(const entry of manifest.harness)assert.equal(hash(rawRead(entry.path)),entry.sha256);
const template=JSON.parse(rawRead(path.join(root,'grant-template-NOT-EXECUTABLE.json')));
const virtualGrant='/OFFLINE_MEMORY_ONLY/grant.json',grant={...template,paidApproved:true};delete grant.note;
const expiry=Date.parse(grant.grantedAt)+86400000;
async function probe(offset){
 let now=expiry-1;const effects=[],saved=new Map();
 class TestDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const proc={argv:['node',path.join(root,'harness/run.mjs'),manifestPath,virtualGrant],env:new Proxy({DEEPSEEK_API_KEY:'synthetic-clock-fixture'}, {get:(t,k)=>{if(k==='DEEPSEEK_API_KEY')effects.push({kind:'synthetic-credential-lookup',at:new TestDate().toISOString()});return t[k];}}),on(){},removeListener(){},exitCode:0};
 const context=vm.createContext({Date:TestDate,process:proc,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}}});
 const parse=vm.runInContext('JSON.parse',context);context.structuredClone=value=>parse(JSON.stringify(value));
 const read=p=>p===virtualGrant?Buffer.from(JSON.stringify(grant)):rawRead(p);
 const json=p=>parse(read(p).toString());
 const file=p=>{const b=read(p);return parse(JSON.stringify({path:p,bytes:b.length,sha256:hash(b)}));};
 const proposal=json(manifest.proposal.path),artifact=json(manifest.artifact.path);
 const api={validation:{describeImproveRuntime:()=>artifact.linuxRuntimeIdentity},improve:{validateImproveRequest(){}},eval:{prepareEval:async options=>{effects.push({kind:'prepareEval',at:new TestDate().toISOString()});return {plan:{...proposal.evalPlan,budget:options.budget,authorization:{...proposal.evalPlan.authorization,paid:options.paid}}};},runEval:async()=>{effects.push({kind:'runEval',at:new TestDate().toISOString()});return {counts:{passed:0}};}},query:{readRunRecords:()=>({records:[],more:false})},runtime:{readObject(){throw Error('not expected');}}};
 const common={json,file,sha:hash,save:(p,v)=>{assert.equal(saved.has(p),false);saved.set(p,v);},verifyInstallation(){effects.push({kind:'installation-check-synthetic-delay',from:new TestDate().toISOString()});now=expiry+offset;},installed:async()=>api,authenticationStop:()=>({stopped:null,fault(){}})};
 const cache=new Map();
 function synthetic(id,exports){const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:id});cache.set(id,m);return m;}
 synthetic('node:assert/strict',{default:assert});synthetic('node:fs',{readFileSync:read,existsSync:p=>p===virtualGrant||fs.existsSync(p)});synthetic('node:path',{dirname:path.dirname,join:path.join,resolve:path.resolve});synthetic('node:url',{fileURLToPath:url.fileURLToPath});synthetic('common',common);
 const preflight=new vm.SourceTextModule(rawRead(path.join(root,'harness/preflight.mjs')).toString(),{context,identifier:'preflight',initializeImportMeta(meta){meta.url=url.pathToFileURL(path.join(root,'harness/preflight.mjs')).href;}});cache.set('preflight',preflight);
 const runner=new vm.SourceTextModule(rawRead(path.join(root,'harness/run.mjs')).toString(),{context,identifier:'runner'});
 await runner.link(id=>cache.get(id==='./common.mjs'?'common':id==='./preflight.mjs'?'preflight':id));
 let error=null;try{await runner.evaluate();}catch(caught){error=caught.message;}
 const paid=saved.get(path.join(root,'paid-start.json')),authorized=saved.has(path.join(root,'authorized-plan.json'));
 if(offset>0){
  assert.match(error,/GRANT_EXPIRED_BEFORE_START/);assert.equal(paid,undefined);assert.equal(authorized,false);
  assert.deepEqual(effects.map(e=>e.kind),['installation-check-synthetic-delay']);
 }else{
  assert.equal(error,null);assert.equal(paid.startedAt,new Date(expiry+offset).toISOString());assert.equal(authorized,true);
  assert.equal(Date.parse(paid.deadline)-Date.parse(paid.startedAt),3600000);
  assert.deepEqual(effects.map(e=>e.kind),['installation-check-synthetic-delay','synthetic-credential-lookup','prepareEval','runEval']);
 }
 return {name:offset>0?'expires-during-preparation':'valid-start-at-original-window-boundary',status:'PASS',preflightAt:new Date(expiry-1).toISOString(),grantExpiresAt:new Date(expiry).toISOString(),afterInstallationAt:new Date(expiry+offset).toISOString(),paidStartCreated:!!paid,authorizedPlanCreated:authorized,error,effects};
}
const results=[await probe(1),await probe(0)];
const result={status:'PASS',cases:results.length,manifestSha256:hash(rawRead(manifestPath)),scope:'Exact frozen run/preflight source evaluated with memory-only API/clock/output fixtures; no real grant, credential, product import, provider, restricted VM, build or paid-start file',results,actualFilesWrittenByRunner:0,realCredentialRead:false,providerRequests:0};
fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,cases:result.cases}));
