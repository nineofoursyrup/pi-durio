import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import fs, {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,readObject} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {verifiedImage,type EvalPlan} from '../src/eval/plan.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {appendFact,captureFiles,regularFiles} from '../src/eval/store.js';
import {fixEvidence} from '../src/fixed-evidence.js';

// Module mocking only routes the fixed real boundary through a protocol CLI.
// It never fabricates an execution result or claims real VM isolation.
if(!process.execArgv.includes('--experimental-test-module-mocks')){
 test('improve deadline and pre-bootstrap failure regressions through the real boundary',()=>{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{encoding:'utf8',env});process.stdout.write(output);assert.match(output,/# tests 10\n/);assert.match(output,/# pass 10\n/);
 });
}else{
 const boundaryUrl=new URL('../execution/isolation/boundary.mjs',import.meta.url);
 const actual=await import(boundaryUrl.href+'?controller-regression');
 let controller='',calls=0,lastOptions:any;
 mock.module(boundaryUrl.href,{namedExports:{runRestricted:async(options:any)=>{calls++;lastOptions=options;return actual.runRestricted({...options,containerExecutable:controller});},exportStopped:actual.exportStopped}});
 const {submitImproveDecision,readImproveDecision}=await import('../src/improve-decisions.js');
 async function fixture(mode:string){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-deadline-check-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');await mkdir(workspace);await writeFile(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');
  const e=new Evidence(dataRoot,'analysis'),target=captureImproveSources(e,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version').targets[0];
  const candidate={id:'candidate:one',revision:'r1',display:'R1',title:'Fix addition',objective:'bug',target,scope:['math.mjs'],steps:['Check exact addition'],dependencies:[],conflicts:[],suggestionOnly:false};
  const report={id:'report',revision:'r1',runId:e.runId,target:{workspace,runId:'run',taskId:'task',sessionId:'session'},candidates:[candidate],targets:[target],state:'complete',evidence:[]};e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();
  const decision:any={id:'decision',reportId:report.id,reportRevision:report.revision,selections:[{candidateId:candidate.id,candidateRevision:candidate.revision,target,steps:candidate.steps,mode:'validate-only'}],directory:join(directory,'validation'),groups:[{id:'group',candidateIds:[candidate.id],changes:[{targetId:'project',path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],checks:[{kind:'regression',timeoutMs:1000,program:'throw Error("controller fixture must not execute candidate code")'},{kind:'direct',timeoutMs:1000,program:'throw Error("must remain not-run")'}]}],limits:{deadline:new Date(Date.now()+60000).toISOString(),maxChecks:2,maxRequests:0,maxTokens:0}};
  controller=join(directory,'controller');calls=0;
  await writeFile(controller,`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),state=${JSON.stringify(join(directory,'controller-state.json'))},digest=${JSON.stringify(verifiedImage.split('@')[1])};
if(a[0]==='--version')console.log('version 1.4.1 ');
else if(a[0]==='image')console.log(JSON.stringify([{configuration:{descriptor:{digest}}}]));
else if(a[0]==='create'){const mounts=a.flatMap((v,i)=>v==='--mount'?[Object.fromEntries(a[i+1].split(',').map(p=>p.split('=')))]:[]);fs.writeFileSync(state,JSON.stringify({readOnly:true,resources:{memoryInBytes:536870912,cpus:1},image:{descriptor:{digest}},mounts:mounts.map(m=>({source:m.source,destination:m.target,options:m.target==='/work'?[]:['ro']}))}));}
else if(a[0]==='inspect')console.log(JSON.stringify([{configuration:JSON.parse(fs.readFileSync(state)),status:{state:'stopped'}}]));
else if(a[0]==='start'){fs.writeFileSync(${JSON.stringify(join(directory,'started'))},'started');process.stdout.write(Buffer.from([65,255,128]));${mode==='eval-grading'?`const config=JSON.parse(fs.readFileSync(state)),work=config.mounts.find(m=>m.destination==='/work').source,input=config.mounts.find(m=>m.destination==='/input').source,guest=JSON.parse(fs.readFileSync(input+'/trial.json'));for(const [path,content]of Object.entries({...guest.files,...guest.dirty})){fs.mkdirSync(require('node:path').dirname(work+'/project/'+path),{recursive:true});fs.writeFileSync(work+'/project/'+path,content);}fs.mkdirSync(work+'/data');fs.writeFileSync(work+'/data/host.sqlite','fixture');fs.writeFileSync(work+'/product-result.json',JSON.stringify({status:'completed'}));`:mode==='success-missing'?'':"setInterval(()=>{},1000);"}}
else if(a[0]==='stop'&&${mode==='unconfirmed'})process.exit(72);
else if(a[0]==='list')console.log('[]');
`,{mode:0o700});
  return {directory,workspace,dataRoot,decision};
 }
 for(const trigger of ['deadline','cancelled'])test(`improve ${trigger} during input preparation persists refusal and freezes remaining checks`,async t=>{
  const f=await fixture(trigger),abort=new AbortController(),now=Date.now(),write=fs.promises.writeFile;let prepared=false;
  t.mock.method(Date,'now',()=>now+(trigger==='deadline'&&prepared?120000:0));
  t.mock.method(fs.promises,'writeFile',async(...args:Parameters<typeof write>)=>{const result=await write(...args);if(String(args[0]).endsWith('/check-0/input/bootstrap.mjs')){prepared=true;if(trigger==='cancelled')abort.abort();}return result;});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision,signal:abort.signal}),check=result.groups[0].result.checks[0];
  assert.equal(prepared,true);assert.equal(calls,1);assert.equal(lastOptions.deadline,f.decision.limits.deadline);assert.equal(lastOptions.timeoutMs,1000);
  assert.equal(check.state,trigger==='cancelled'?'cancelled':'failed');assert.equal(check.reason,trigger);assert.equal(check.execution.status,'not-started');assert.equal(check.execution.started,false);assert.equal(check.execution.terminated,false);assert.deepEqual(check.execution.control,[]);
  assert.equal(result.groups[0].result.checks[1].state,'not-run');assert.equal(existsSync(join(f.directory,'started')),false);
  assert.deepEqual(readImproveDecision(f.dataRoot,f.decision.id).groups[0].result.checks[0],check);
 });
 for(const mode of ['timeout','cancelled','unconfirmed','success-missing'])test(`improve retains ${mode} execution when bootstrap never creates targets`,async t=>{
  const f=await fixture(mode),abort=new AbortController();
  const timer=mode==='cancelled'?setInterval(()=>{if(existsSync(join(f.directory,'started')))abort.abort();},10):undefined;t.after(()=>clearInterval(timer));
  const result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision,signal:abort.signal}),check=result.groups[0].result.checks[0];
  assert.equal(calls,1);assert.equal(check.state,mode==='cancelled'?'cancelled':mode==='unconfirmed'||mode==='success-missing'?'unknown':'failed');
  if(mode!=='success-missing')assert.equal(check.reason,mode==='unconfirmed'?'termination_unconfirmed':mode);else assert.match(check.reason,/ENOENT/);
  assert.equal(result.groups[0].result.checks[1].state,'not-run');
  const reopened=readImproveDecision(f.dataRoot,f.decision.id).groups[0].result.checks[0],execution=JSON.parse(readObject(f.dataRoot,reopened.executionRef).toString());
  const original=JSON.parse(await readFile(join(f.directory,'validation/group/check-0/execution/outcome.json'),'utf8'));
  assert.equal(execution.reason,original.reason);assert.deepEqual(execution.control,original.control);assert.equal(execution.terminated,mode!=='unconfirmed');
  const acquired=Buffer.concat(original.output.stdout.chunks.map((chunk:string)=>Buffer.from(chunk,'base64')));
  assert.deepEqual(Buffer.concat(execution.output.stdout.chunks.map((ref:any)=>readObject(f.dataRoot,ref))),acquired);if(mode!=='cancelled')assert.deepEqual(acquired,Buffer.from([65,255,128]));
  assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
 });
 const {runEval}=await import('../src/eval/runner.js');
 for(const mode of ['deadline','cancelled','eval-grading','eval-timeout'])test(`eval shared boundary preserves ${mode} cutoff through staged runtime or grading`,async t=>{
  const f=await fixture(mode),abort=new AbortController(),e=new Evidence(f.dataRoot,'plan'),host=fileURLToPath(new URL('../src/',import.meta.url)),boundary=fileURLToPath(new URL('../execution/isolation/',import.meta.url));
  const plan:EvalPlan={id:'plan',purpose:'Controller-only admission regression; no runtime or VM claim',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'fixture',manifest:e.blob('[]'),bytes:2},cases:[representativeCases[0]],trials:['first','remaining'].map(id=>({id,caseId:representativeCases[0].id,version:'fixture',side:'candidate',repeat:1,pair:null})),budget:{maxRequests:2,maxTokens:1000,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null},trialTimeoutMs:1000,gradingTimeoutMs:1000,maxOutputTokens:32,requestRetryLimit:0,price:null,authorization:{scope:'run-all-listed-trials',paid:false},environment:{node:'v24.8.0',isolation:'controller fixture only',writable:'new',cache:'empty',hostFiles:captureFiles(e,host,regularFiles(host)).files,boundaryFiles:captureFiles(e,boundary,['boundary.mjs','export.mjs','restrict.py']).files},mainObjective:'requirements',protection:['originals'],improvementConclusion:'not-evaluated'};
  const source=appendFact(e,'eval.plan',plan);e.close();await fixEvidence(f.dataRoot,{id:'eval-plan:plan',sources:[source],purpose:'fixed controller regression plan'});
  const now=Date.now(),write=fs.promises.writeFile;let expired=false;
  t.mock.method(Date,'now',()=>now+((expired||mode==='eval-timeout'&&existsSync(join(f.directory,'started')))?120000:0));
  t.mock.method(fs.promises,'writeFile',async(...args:Parameters<typeof write>)=>{const result=await write(...args),path=String(args[0]);if(mode==='eval-grading'?path.endsWith('/check.mjs'):path.endsWith('/first-input/trial.json')&&mode!=='eval-timeout'){if(mode==='cancelled')abort.abort();else expired=true;}return result;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const report=await runEval({dataRoot:f.dataRoot,id:'plan',directory:join(f.directory,'eval'),signal:abort.signal}),outcome=report.trials[0].outcome;
  assert.equal(lastOptions.deadline,plan.budget.deadline);assert.equal(lastOptions.timeoutMs,1000);assert.equal(calls,mode==='eval-grading'?2:1);assert.equal(report.trials[1].outcome.status,'not-run');
  if(mode==='eval-grading'){assert.equal(outcome.status,'completed');assert.match(report.trials[0].grade!.reason,/grader deadline before start/);const execution=JSON.parse(readObject(f.dataRoot,report.trials[0].grade!.execution!).toString());assert.equal(execution.started,false);assert.equal(execution.terminated,false);}
  else {assert.equal(outcome.status,mode==='cancelled'?'cancelled':'budget-stopped');assert.equal(outcome.reason,mode==='eval-timeout'?'BUDGET_DEADLINE':mode);const execution=JSON.parse(readObject(f.dataRoot,outcome.isolation!).toString());assert.equal(execution.started,mode==='eval-timeout');assert.equal(execution.terminated,mode==='eval-timeout');if(mode==='eval-timeout')assert.equal(execution.reason,'timeout');}
 });

}
