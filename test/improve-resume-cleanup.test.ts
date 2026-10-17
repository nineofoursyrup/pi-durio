import {saveDeclaredFixture} from './helpers/improve-fixture.js';
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Evidence} from '../src/evidence.js';
import {captureImproveSources,registerImproveSource} from '../src/improve-source.js';
import {acquireOwner} from '../src/ownership.js';
import type {EvalCleanupReceipt} from '../src/eval/cleanup.js';
import type {ImproveDecision} from '../src/improve-decisions.js';

// Only the validation seam is replaced here. This covers receipt forwarding and
// active-group authority using real host facts/leases, and makes no VM claim.
if(!process.execArgv.includes('--experimental-test-module-mocks')){
 test('resume receipt and active-group host contract',()=>{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{encoding:'utf8',env});process.stdout.write(output);assert.match(output,/# tests 1\n/);assert.match(output,/# pass 1\n/);
 });
}else{
 const validationUrl=new URL('../src/improve-validation.js',import.meta.url),actual=await import(validationUrl.href+'?receipt-contract');
 let began:()=>void=()=>{};
 const receipts:EvalCleanupReceipt[]=[];
 mock.module(validationUrl.href,{namedExports:{...actual,validateImproveGroup:async(options:any)=>{
  const receipt:EvalCleanupReceipt={dataRoot:join(options.evidence.root,options.group.id),planId:`contract-${options.group.id}`,operation:'run',storage:'not-opened',owner:'not-acquired',executions:[],cleanup:'confirmed'};
  receipts.push(receipt);options.onEvalCleanup?.(receipt);began();
  if(options.group.id==='g2')await new Promise<void>(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',()=>resolve(),{once:true});});
  return {state:'cancelled',reason:'contract cancellation',construction:{},checks:[],effect:'证据不足',conclusion:{allChecksPassed:false,allRequiredBenefitsMet:false}};
 }}});
 const {ImproveBatchController}=await import('../src/improve-batch.js');
 const {readImproveDecision,improveFacts}=await import('../src/improve-history.js');
 function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-resume-receipts-'))),dataRoot=join(root,'data'),workspace=join(root,'project'),other=join(root,'independent');mkdirSync(workspace);mkdirSync(other);
  writeFileSync(join(workspace,'first.mjs'),'export const value=0;\n');writeFileSync(join(other,'second.mjs'),'export const value=0;\n');
  registerImproveSource(dataRoot,workspace,{kind:'eval-asset',root:other,paths:['second.mjs']});
  const e=new Evidence(dataRoot,'analysis'),targets=captureImproveSources(e,workspace,[{id:'first',kind:'project',paths:['first.mjs']},{id:'second',kind:'eval-asset',root:other,paths:['second.mjs']}],'receipt-contract').targets;
  const candidates=['first','second'].map((name,i)=>({id:`candidate:${name}`,revision:'r1',display:`R${i+1}`,title:name,objective:'bug',target:targets[i],scope:[`${name}.mjs`],steps:['Check exact replacement'],dependencies:[],conflicts:[],suggestionOnly:false}));
  const report={id:'report',revision:'r1',runId:e.runId,target:{workspace,runId:'source'},candidates,targets,state:'complete',evidence:[]};e.append('improve.started',{request:{id:report.id},target:report.target});e.close();
  const decision:ImproveDecision={id:'decision',reportId:report.id,reportRevision:report.revision,selections:candidates.map(c=>({candidateId:c.id,candidateRevision:c.revision,target:c.target,steps:c.steps,mode:'validate-only'})),directory:join(root,'validation'),groups:candidates.map((c,i)=>({id:`g${i+1}`,candidateIds:[c.id],changes:[{targetId:c.target.id,path:c.scope[0],content:'export const value=1;\n'}],checks:[{kind:'regression',timeoutMs:1000,program:'throw Error("validation seam fixture must not execute")'}]})),limits:{deadline:new Date(Date.now()+60000).toISOString(),maxChecks:2,maxRequests:0,maxTokens:0}};
  saveDeclaredFixture(dataRoot,report,decision);
  return {dataRoot,decision};
 }
 test('resume forwards only current receipts and an old completed-attempt group cannot stop the current group',async t=>{
  const f=fixture(),batch=new ImproveBatchController(f.dataRoot),currentCleanup=()=>batch.cleanup,currentReceipts=()=>batch.evalCleanup,first=await batch.start(f.decision);
  t.after(async()=>{if(batch.running)await batch.stop(batch.origin!);});
  assert.equal(first.groups[0].state,'cancelled');assert.equal(first.groups[1].state,'not-run');assert.equal(currentCleanup()?.owner,'released');assert.deepEqual(currentReceipts(),[receipts[0]]);
  const started=new Promise<void>(resolve=>{began=resolve;}),done=batch.resume({id:f.decision.id,resumeId:'resume-g2',decisionSource:first.sourceId,groupIds:['g2']});
  assert.equal(currentCleanup(),undefined,'new continuation discards the earlier host cleanup receipt');assert.deepEqual(currentReceipts(),[],'new continuation discards earlier child receipts');
  await started;
  const origin={reportId:f.decision.reportId,decisionId:f.decision.id},old={...origin,groupId:'g1'},current={...origin,groupId:'g2'};
  assert.equal(batch.canStop(origin),true);assert.equal(batch.canStop(old),false);assert.equal(batch.canStop(current),true);assert.equal((await batch.stop(old)).stopped,false);assert.equal(batch.running,true);
  assert.equal((await batch.stop(current)).stopped,true);await done;
  assert.deepEqual(currentReceipts(),[receipts[1]]);assert.equal(currentReceipts()[0].planId,'contract-g2');assert.equal(currentCleanup()?.storage,'closed');assert.equal(currentCleanup()?.owner,'released');assert.ok(currentCleanup()?.workspaces.every(w=>w.released));
  assert.deepEqual(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.group-started').map(f=>f.data.groupId),['g1','g2']);assert.equal(readImproveDecision(f.dataRoot,f.decision.id).groups[1].state,'cancelled');
  const owner=await acquireOwner(f.dataRoot,()=>{});await owner.release();
 });
}
