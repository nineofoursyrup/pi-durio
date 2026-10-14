#!/usr/bin/env node
/** The only paid entry. Missing/changed grant, expired window or existing start
 * fails before plan materialization, credential use or provider authentication. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installed,authenticationStop,json,save,file,sha,verifyInstallation} from './common.mjs';
const [freezeArg,grantArg]=process.argv.slice(2);
if(!grantArg)throw Error('Usage: run.mjs FROZEN_MANIFEST EXPLICIT_HUMAN_GRANT');
const freezePath=resolve(freezeArg),grantPath=resolve(grantArg),freeze=json(freezePath),grant=json(grantPath);
assert.equal(grant.paidApproved,true,'EXPLICIT_PAID_GRANT_REQUIRED');
assert.equal(grant.manifestSha256,sha(readFileSync(freezePath)),'GRANT_MANIFEST_MISMATCH');
assert.equal(grant.batchId,freeze.batchId);
assert.ok(typeof grant.humanAuthorization==='string'&&grant.humanAuthorization.trim(),'retain exact human authorization');
assert.ok(typeof grant.credentialSource==='string'&&grant.credentialSource.trim(),'explicit permitted credential source required');
const runner=fileURLToPath(import.meta.url),common=join(dirname(runner),'common.mjs');
for(const [path,reason]of [[runner,'RUNNER_NOT_FROZEN'],[common,'COMMON_NOT_FROZEN']])assert.ok(freeze.harness.some(entry=>entry.path===path),reason);
for(const entry of [freeze.proposal,freeze.artifact,...freeze.harness])assert.deepEqual(file(entry.path),entry,`FROZEN_CONTENT_CHANGED: ${entry.path}`);
const proposal=json(freeze.proposal.path),artifact=json(freeze.artifact.path);
assert.deepEqual(grant.limits,{maxRequests:40,maxTokens:4000000,usdCeiling:5,grantToStartMs:86400000,activeMs:3600000,starts:1},'EXACT_REVIEWED_LIMITS_REQUIRED');
const grantedAt=Date.parse(grant.grantedAt),now=Date.now();
assert.ok(Number.isFinite(grantedAt)&&grantedAt<=now&&now-grantedAt<=proposal.window.grantToStartMs,'GRANT_EXPIRED_OR_INVALID');
assert.equal(proposal.status,'PENDING_EXPLICIT_HUMAN_GRANT; not an executable paid plan');
const identity=json(artifact.producerIdentity.path);
assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);
verifyInstallation(join(artifact.installation,'node_modules/pi-durio'),identity.installed);
const api=await installed(artifact.installation);
assert.equal(api.validation.describeImproveRuntime(artifact.linux),artifact.linuxRuntimeIdentity,'LINUX_RUNTIME_CHANGED');
const fixture=freeze.fixture;for(const [path,hash]of Object.entries(fixture.fileHashes))assert.equal(sha(readFileSync(join(proposal.improve.workspace,path))),hash,`FIXTURE_CHANGED:${path}`);
api.improve.validateImproveRequest(proposal.improve.request,'live');
assert.ok(process.env.DEEPSEEK_API_KEY?.trim(),'AUTH_MISSING: load only the human-permitted source into DEEPSEEK_API_KEY');
const startedAt=new Date(),deadline=new Date(startedAt.getTime()+proposal.window.activeMs).toISOString();
const output=freeze.output;
save(join(output,'paid-start.json'),{batchId:proposal.batchId,manifest:file(freezePath),grant:file(grantPath),startedAt:startedAt.toISOString(),deadline,credentialSource:grant.credentialSource,credentialValue:'never retained',scope:'one start; all SDK retries and compactions share stage budgets; no resume'});
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('BATCH_DEADLINE')),Math.max(1,Date.parse(deadline)-Date.now()));
let stage='prepare',result,cancellation=null,cancellationRecordError=null;
const cancel=signal=>{
 if(cancellation)return;
 cancellation={signal,at:new Date().toISOString(),remoteTermination:'unknown'};
 try{save(join(output,'cancellation-request.json'),cancellation);}catch(error){cancellationRecordError=String(error);}
 controller.abort(Error(`BATCH_${signal}`));
};
const onInterrupt=()=>cancel('SIGINT'),onTerminate=()=>cancel('SIGTERM');
// Keep both handlers until the awaited API has finished its existing cleanup
// boundary and the batch receipt is saved. Repeated signals never force exit.
process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
try{
 const p=proposal.evalPlan;
 const prepared=await api.eval.prepareEval({dataRoot:proposal.evalDataRoot,id:p.id,purpose:p.purpose,mode:'live',installation:artifact.linux,cases:p.cases,trials:p.trials.map(({version,...trial})=>trial),budget:{...p.budget,deadline},trialTimeoutMs:p.trialTimeoutMs,gradingTimeoutMs:p.gradingTimeoutMs,maxOutputTokens:p.maxOutputTokens,paid:true,price:p.price});
 const expected={...p,budget:{...p.budget,deadline},authorization:{...p.authorization,paid:true}};
 assert.deepEqual(JSON.parse(JSON.stringify(prepared.plan)),JSON.parse(JSON.stringify(expected)),'MATERIALIZED_PLAN_DIFFERS_FROM_REVIEWED_CONTENT');
 save(join(output,'authorized-plan.json'),prepared);
 save(join(output,'authorization-difference.json'),{proposal:file(freeze.proposal.path),grant:file(grantPath),changes:[{path:'evalPlan.authorization.paid',before:false,after:true},{path:'evalPlan.budget.deadline',before:null,after:deadline}]});
 controller.signal.throwIfAborted();
 const guard=authenticationStop(api,proposal.evalDataRoot,p.id,controller);
 const stopFailedTrial=kind=>{
  guard.fault(kind);
  if(!['eval.budget-snapshot','eval.timing'].includes(kind))return;
  const rows=api.query.readRunRecords(proposal.evalDataRoot,p.id,{tail:true,limit:1,kinds:[kind==='eval.timing'?'eval.grade':'eval.outcome']}).records;
  if(!rows.length)return;const fact=JSON.parse(api.runtime.readObject(proposal.evalDataRoot,rows[0].ref));
  if(kind==='eval.timing'?fact.judgment!=='PASS':fact.status!=='completed')controller.abort(Error('BATCH_TRIAL_NOT_PASS'));
 };
 stage='eval';
 const evaluation=await api.eval.runEval({dataRoot:proposal.evalDataRoot,id:p.id,directory:proposal.evalDirectory,signal:controller.signal,fault:stopFailedTrial});
 save(join(output,'live-eval-result.json'),evaluation);
 if(controller.signal.aborted||evaluation.counts.passed!==4){result={status:'STOPPED',stage,reason:guard.stopped??String(controller.signal.reason??'Not all four fixed requirements passed'),improve:'not-run'};}
 else{
  stage='improve';let analysisRunId=null;
  const improveGuard=authenticationStop(api,proposal.improve.dataRoot,()=>analysisRunId,controller);
  const analysis=await api.runtime.analyzeImprove({workspace:proposal.improve.workspace,dataRoot:proposal.improve.dataRoot,targetRunId:proposal.improve.targetRunId,request:proposal.improve.request,mode:'live',signal:controller.signal,cancellation:'stop',onObservation:event=>{analysisRunId=event.runId;},fault:kind=>{if(analysisRunId)improveGuard.fault(kind);}});
  save(join(output,'live-improve-result.json'),analysis);
  const reopened=api.improve.readImproveReport(proposal.improve.dataRoot,proposal.improve.request.id);save(join(output,'reopened-improve-report.json'),reopened);
  result={status:!controller.signal.aborted&&analysis.status==='completed'&&analysis.cleanup==='confirmed'&&analysis.improve?.state==='complete'&&analysis.improve.candidates.length?'AWAITING_ACTUAL_CANDIDATE_SELECTION':'STOPPED_NO_EXECUTABLE_CHAIN',stage,runId:analysis.runId,analysisStatus:analysis.status,cleanup:analysis.cleanup,lifecycle:analysis.lifecycle??null,reportId:analysis.improve?.id??null,reportRevision:analysis.improve?.revision??null,candidates:analysis.improve?.candidates.length??0,selection:'none; paid grant does not select unknown future candidates',reason:improveGuard.stopped??analysis.reason??null};
 }
}catch(error){result={status:'STOPPED',stage,error:String(error),cleanup:'unknown',...(stage!=='improve'?{improve:'not-run'}:{}),...(stage==='prepare'?{eval:'not-run'}:{}),remaining:'not-run; no automatic repeat or new trial'};}
finally{
 clearTimeout(timer);
 if(cancellation)result={...result,status:'CANCELLED',cancellation,cancellationRecordError,remaining:'not-run; no automatic repeat or new trial'};
 process.exitCode=cancellation?(cancellation.signal==='SIGINT'?130:143):result?.status==='AWAITING_ACTUAL_CANDIDATE_SELECTION'?0:1;
 try{save(join(output,'batch-result.json'),{...result,at:new Date().toISOString(),deadline,remoteTermination:'unknown',firstFailuresRetained:true,modelIdentity:'Requested alias is not immutable served model proof; inspect retained raw response',cost:'Use host stage budget facts; guest coding mirrors eval usage and must not be summed again'});}
 finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);}
}
console.log(JSON.stringify(result));
