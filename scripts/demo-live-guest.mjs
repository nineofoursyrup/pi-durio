#!/usr/bin/env node
// Diagnostic only: actual live-mode guest/runtime, offline host mediator. No
// network provider, real credential or paid-eval authorization is involved.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import assert from 'node:assert/strict';
const [installArg,linuxArg,outArg]=process.argv.slice(2);if(!outArg)throw Error('Usage: INDEPENDENT_INSTALL_ROOT LINUX_RUNTIME NEW_EVIDENCE_DIRECTORY');
const install=realpathSync(resolve(installArg)),linux=realpathSync(resolve(linuxArg)),out=resolve(outArg),require=createRequire(join(install,'package.json'));
const src=dirname(require.resolve('pi-durio')),load=async path=>import(pathToFileURL(join(src,path)).href),runtime=await load('runtime.js');
const {Evidence}=await load('evidence.js'),{PersistentBudget}=await load('provider-boundary.js'),{evalMediator}=await load('eval/mediator.js'),{scriptedTransport}=await load('offline.js');
const boundary=await load('../execution/isolation/boundary.mjs');
mkdirSync(out);const inputDir=join(out,'input');mkdirSync(inputDir);const save=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2));
const guest={trialId:'diagnostic-live-guest',mode:'live',prompt:'Read README.md and explain its content.',files:{'README.md':'Preserved diagnostic fixture\n','package.json':'{"name":"diagnostic-guest","version":"1.0.0"}'},maxOutputTokens:512};
writeFileSync(join(inputDir,'trial.json'),JSON.stringify(guest));
const e=new Evidence(join(out,'host-data'),'diagnostic-live-guest'),limits={maxRequests:2,maxTokens:2048,maxRequestTokens:1024,deadline:new Date(Date.now()+120000).toISOString(),unknownUpperBound:null},budget=new PersistentBudget(e,'diagnostic',limits),transport=scriptedTransport([{name:'read',args:{path:'README.md'}}]);
const plan={mode:'offline',budget:limits,maxOutputTokens:512,model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'}},mediator=evalMediator(plan,{id:guest.trialId},budget,transport.fetch);
// Existing host refusal remains intact; only the isolated diagnostic guest's
// mode is live. This is not a live eval plan or a provider override exception.
assert.throws(()=>evalMediator({...plan,mode:'live'},{id:guest.trialId},budget,transport.fetch),/LIVE_TRANSPORT_OVERRIDE_DENIED/);
const image=JSON.parse(readFileSync(join(linux,'eval-environment.json'))).image;
const execution=await boundary.runRestricted({image,inputDir,runDir:join(out,'execution'),dependenciesDir:linux,command:['node','/deps/dist/src/eval/guest.js'],timeoutMs:90000,model:mediator,protocolLimits:{inputBytes:262144,responseBytes:1048576,lineBytes:1048576,totalBytes:8388608}});
save('execution',execution);save('host-budget',budget.snapshot());save('payloads',transport.calls);e.close();
function files(root,prefix=''){return readdirSync(join(root,prefix)).sort().flatMap(name=>{const path=join(prefix,name),s=lstatSync(join(root,path));if(s.isSymbolicLink())throw Error('Diagnostic export refuses symlink');return s.isDirectory()?files(root,path):[path];});}
const work=join(out,'execution/work'),names=[];for(const part of ['project','data'])if(existsSync(join(work,part)))names.push(...files(join(work,part)).map(path=>`${part}/${path}`));for(const name of ['product-result.json','product-error.json'])if(existsSync(join(work,name)))names.push(name);
const exported=join(out,'export');if(execution.terminated&&execution.status!=='invalid')save('export',await boundary.exportStopped(execution,names,exported,{maxFiles:20000,maxBytes:134217728}));
const product=existsSync(join(exported,'product-result.json'))?JSON.parse(readFileSync(join(exported,'product-result.json'))):null,error=existsSync(join(exported,'product-error.json'))?JSON.parse(readFileSync(join(exported,'product-error.json'))):null;
const records=product?(await runtime.readRun(join(exported,'data'),product.runId,{limit:100})).records:[],config=records.find(record=>record.kind==='execution.config')?.data;
save('report',{status:product?.status==='completed'?'PASS':'FAIL',classification:'DIAGNOSTIC: live-mode guest to offline controlled host mediator; no paid/provider evidence',product,error,config,requests:transport.calls.length,hostLiveOverrideRejected:true,isolationTerminated:execution.terminated,artifactSource:linux});
assert.equal(execution.terminated,true);assert.equal(product?.status,'completed',JSON.stringify(error));assert.equal(config.mode,'live');assert.equal(transport.calls.length,2);assert.ok(records.some(record=>record.kind==='model.dispatch'));
console.log('PASS: actual live-mode guest/runtime reached the controlled host mediator and retained its output; no paid provider call.');
