import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

// Exercise the unmodified entrypoint and common helpers. Only the installed
// public product API is a deterministic fixture: this is NOT a provider/VM test.
const fakeProduct = `
import {readFileSync} from 'node:fs';
const proposal=JSON.parse(readFileSync(process.env.BATCH_TEST_PROPOSAL,'utf8'));
const scenario=process.env.BATCH_TEST_SCENARIO;
const emit=phase=>process.send({phase});
async function managed(signal){
 emit('active');
 if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 emit('abort');
 await new Promise(resolve=>process.once('message',resolve));
 emit('closed');
}
export const describeImproveRuntime=()=> {if(scenario.startsWith('unfrozen-')||scenario.startsWith('tampered-'))throw Error('UNFROZEN_HARNESS_REACHED_INSTALLATION');return 'offline-fixture';};
export const validateImproveRequest=()=>{};
export async function prepareEval(options){
 emit('prepare');
 if(scenario==='prepare'){
  emit('active');
  await new Promise(resolve=>process.once('message',resolve));
  emit('closed');
 }
 return {plan:{...proposal.evalPlan,budget:options.budget,authorization:{...proposal.evalPlan.authorization,paid:options.paid}}};
}
export async function runEval({signal}){
 emit('eval');
 if(scenario==='improve')return {counts:{passed:4},trials:[]};
 await managed(signal);
 if(scenario==='eval-failed-cleanup')throw Error('OFFLINE_CLEANUP_FAILURE: side effects unknown');
 return {counts:{passed:1},trials:proposal.evalPlan.trials.map((t,i)=>({id:t.id,outcome:{status:i===0?'completed':i===1?'cancelled':'not-run'}})),remoteTermination:'unknown'};
}
export async function analyzeImprove({signal,cancellation}){
 emit('improve');
 if(cancellation!=='stop')throw Error('explicit cancellation must retain stop intent');
 await managed(signal);
 return {runId:'offline-analysis',status:'unknown',cleanup:'unknown',reason:'OFFLINE_CLEANUP_UNKNOWN',lifecycle:{storage:'unknown',owner:'retained',remoteTermination:'unknown'},improve:{state:'complete',id:'offline-improve',revision:1,candidates:[{id:'unselected'}]}};
}
export const readImproveReport=()=>null;
export const readRunRecords=()=>({records:[],more:false});
export const readObject=()=>{throw Error('no fixture objects');};
`;
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const file=(path:string)=>{const bytes=readFileSync(path);return{path,bytes:bytes.length,sha256:sha(bytes)};};
const write=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');

async function runFixture(name:string,signal:NodeJS.Signals,scenario=name){
 const evidence=process.env.PI_DURIO_TEST_EVIDENCE;
 if(evidence)mkdirSync(evidence,{recursive:true});
 const root=mkdtempSync(join(evidence??tmpdir(),`${name}-`));
 let runner=resolve('scripts/live-batch/run.mjs'),common=resolve('scripts/live-batch/common.mjs');
 if(scenario==='tampered-runner'){
  writeFileSync(join(root,'run.mjs'),readFileSync(runner));writeFileSync(join(root,'common.mjs'),readFileSync(common));
  runner=join(root,'run.mjs');common=join(root,'common.mjs');
 }
 const installation=join(root,'installation'),packageRoot=join(installation,'node_modules/pi-durio');
 mkdirSync(packageRoot,{recursive:true});
 write(join(installation,'package.json'),{private:true});
 write(join(packageRoot,'package.json'),{name:'pi-durio',type:'module',exports:Object.fromEntries(['.','./eval','./query','./offline','./improve','./improve-validation'].map(id=>[id,'./api.mjs']))});
 writeFileSync(join(packageRoot,'api.mjs'),fakeProduct);
 const producer=join(root,'producer.json');
 write(producer,{installed:['api.mjs','package.json'].map(path=>{const entry=file(join(packageRoot,path));return{...entry,path};})});
 const artifactPath=join(root,'artifact.json');
 write(artifactPath,{installation,linux:root,linuxRuntimeIdentity:'offline-fixture',producerIdentity:file(producer)});
 const trials=['done','cancelled','remaining-1','remaining-2'].map(id=>({id,version:'offline-fixture'}));
 const proposalPath=join(root,'proposal.json');
 write(proposalPath,{batchId:'offline-cancellation-fixture',status:'PENDING_EXPLICIT_HUMAN_GRANT; not an executable paid plan',window:{grantToStartMs:86400000,activeMs:3600000},evalPlan:{id:'offline-eval',purpose:'entrypoint cancellation test only',cases:[],trials,budget:{},authorization:{paid:false}},evalDataRoot:join(root,'eval-data'),evalDirectory:join(root,'execution'),improve:{dataRoot:join(root,'improve-data'),workspace:root,targetRunId:'offline-seed',request:{id:'offline-improve'}}});
 const manifest=join(root,'manifest.json');
 const harness=[file(runner),file(common)];
 if(scenario.startsWith('unfrozen-')){
  const previous=join(root,'previous-file.mjs');writeFileSync(previous,'// Previously frozen file; unchanged historical evidence.\n');
  harness[scenario==='unfrozen-runner'?0:1]=file(previous);
 }
 if(scenario==='tampered-runner')appendFileSync(runner,'\n// Simulated drift after the content was frozen.\n');
 write(manifest,{batchId:'offline-cancellation-fixture',output:root,proposal:file(proposalPath),artifact:file(artifactPath),harness,fixture:{fileHashes:{}}});
 const grant=join(root,'grant.json');
 write(grant,{paidApproved:true,manifestSha256:sha(readFileSync(manifest)),batchId:'offline-cancellation-fixture',humanAuthorization:'SYNTHETIC fixture for offline process test; no real paid grant',credentialSource:'literal offline placeholder; no credential read',limits:{maxRequests:40,maxTokens:4000000,usdCeiling:5,grantToStartMs:86400000,activeMs:3600000,starts:1},grantedAt:new Date().toISOString()});
 const events:string[]=[];let stdout='',stderr='',exited=false;
 const child=spawn(process.execPath,[runner,manifest,grant],{env:{PATH:process.env.PATH,DEEPSEEK_API_KEY:'offline-placeholder-not-a-credential',BATCH_TEST_PROPOSAL:proposalPath,BATCH_TEST_SCENARIO:scenario},stdio:['ignore','pipe','pipe','ipc']});
 assert.ok(child.stdout&&child.stderr);
 child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
 child.on('message',(message:any)=>events.push(message.phase));
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.on('close',(code,signal)=>{exited=true;resolve({code,signal});}));
 const waitFor=async(phase:string)=>{const deadline=Date.now()+10000;while(!events.includes(phase)){assert.equal(exited,false,`process exited before ${phase}: ${JSON.stringify({events,stdout,stderr})}`);assert.ok(Date.now()<deadline,`timed out waiting for ${phase}`);await new Promise(resolve=>setTimeout(resolve,10));}};
 let outcome;
 try{
  if(scenario.startsWith('unfrozen-')||scenario.startsWith('tampered-')){
   outcome=await closed;
   assert.equal(outcome.code,1);assert.match(stderr,scenario==='unfrozen-runner'?/RUNNER_NOT_FROZEN/:scenario==='unfrozen-common'?/COMMON_NOT_FROZEN/:/FROZEN_CONTENT_CHANGED/);
   assert.equal(existsSync(join(root,'paid-start.json')),false);
   assert.equal(events.includes('prepare'),false);
   return {root,result:null};
  }
  await waitFor('active');assert.ok(child.kill(signal));
  if(scenario!=='prepare')await waitFor('abort');
  else {
   const deadline=Date.now()+10000;
   while(!existsSync(join(root,'cancellation-request.json'))){assert.equal(exited,false);assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
  }
  assert.equal(existsSync(join(root,'batch-result.json')),false,'must await the existing product cleanup boundary');
  assert.equal(exited,false);
  assert.ok(child.kill(signal==='SIGINT'?'SIGTERM':'SIGINT'),'a repeated signal must not bypass cleanup');
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(exited,false,'must keep waiting for cleanup after a repeated signal');
  child.send('release-cleanup');
  outcome=await closed;
  assert.equal(outcome.signal,null,stderr);
  assert.equal(outcome.code,signal==='SIGINT'?130:143,stderr);
  assert.ok(events.includes('closed'),'result is only returned after fixture close');
  if(scenario!=='improve')assert.equal(events.includes('improve'),false,'remaining analysis must not start');
  if(scenario==='prepare')assert.equal(events.includes('eval'),false,'cancelled preparation must not admit eval');
  if(scenario.startsWith('eval-SIG')){
   const evaluation=JSON.parse(readFileSync(join(root,'live-eval-result.json'),'utf8'));
   assert.deepEqual(evaluation.trials.map((t:any)=>t.outcome.status),['completed','cancelled','not-run','not-run']);
  }
  const result=JSON.parse(readFileSync(join(root,'batch-result.json'),'utf8'));
  assert.equal(result.status,'CANCELLED');
  assert.equal(result.cancellation.signal,signal,'the first signal remains the cancellation reason');
  if(scenario!=='improve')assert.equal(result.improve,'not-run');
  if(scenario==='prepare')assert.equal(result.eval,'not-run');
  if(scenario==='eval-failed-cleanup')assert.match(result.error,/OFFLINE_CLEANUP_FAILURE/,'cancel must retain the failure');
  if(scenario==='improve'){
   const analysis=JSON.parse(readFileSync(join(root,'live-improve-result.json'),'utf8'));
   assert.equal(analysis.status,'unknown');assert.equal(analysis.cleanup,'unknown');
   assert.equal(result.cleanup,'unknown','must not conceal unresolved cleanup behind a returned candidate');
   assert.equal(result.analysisStatus,'unknown');
   assert.equal(result.lifecycle.owner,'retained');
  }
  assert.equal(result.remoteTermination,'unknown');
  return {root,result};
 }finally{
  if(!exited)child.kill('SIGKILL');
  outcome??=await closed;
  if(evidence)write(join(root,'process-evidence.json'),{scope:'Actual OS signals to original run.mjs; identity case separately copies/drifts the runner. Installed public product API is an offline fixture; no actual provider, VM, credential or paid authorization',events,stdout,stderr,outcome,entry:file(runner),common:file(common)});
  else rmSync(root,{recursive:true,force:true});
 }
}

for(const signal of ['SIGINT','SIGTERM'] as const)test(`live batch ${signal} waits for cleanup and retains cancelled/NOT RUN outcomes`,{timeout:15000},async()=>{await runFixture(`eval-${signal}`,signal);});
test('live batch cancellation during preparation never starts eval',{timeout:15000},async()=>{await runFixture('prepare','SIGINT');});
test('live batch cancellation retains a cleanup failure and does not start improve',{timeout:15000},async()=>{await runFixture('eval-failed-cleanup','SIGTERM');});
test('live batch improve cancellation retains unknown cleanup and never selects a returned candidate',{timeout:15000},async()=>{await runFixture('improve','SIGINT');});
test('live batch current runner and common helper must match the frozen harness',{timeout:15000},async()=>{for(const scenario of ['unfrozen-runner','unfrozen-common','tampered-runner'])await runFixture(scenario,'SIGINT');});
