#!/usr/bin/env node
// Supplemental batch; original results and fixed product remain unchanged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {installed,authenticationStop,json,save,file,sha,verifyInstallation} from './common.mjs';
import {preflight,verifyPrior} from './preflight.mjs';
import {requireThreePasses,stageLedger,cumulativeLedger} from './supplement.mjs';
const {freezePath,grantPath,freeze,grant,proposal,artifact}=preflight(...process.argv.slice(2));
const identity=json(artifact.producerIdentity.path);
assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);
verifyInstallation(join(artifact.installation,'node_modules/pi-durio'),identity.installed);
const api=await installed(artifact.installation);
assert.equal(api.validation.describeImproveRuntime(artifact.linux),artifact.linuxRuntimeIdentity,'LINUX_RUNTIME_CHANGED');
const fixture=freeze.fixture;for(const [path,hash]of Object.entries(fixture.fileHashes))assert.equal(sha(readFileSync(join(proposal.improve.workspace,path))),hash,`FIXTURE_CHANGED:${path}`);
api.improve.validateImproveRequest(proposal.improve.request,'live');
verifyPrior(freeze); // Slow installation checks cannot hide a changed prior ledger or first failure.
const startedAt=new Date(),grantTime=Date.parse(grant.grantedAt);
// Installation/runtime validation may consume the remaining grant window.
// Admission uses this exact saved timestamp; never renew the human grant.
assert.ok(Number.isFinite(grantTime)&&grantTime<=startedAt.getTime()&&startedAt.getTime()-grantTime<=proposal.window.grantToStartMs,'GRANT_EXPIRED_BEFORE_START');
assert.ok(process.env.DEEPSEEK_API_KEY?.trim(),'AUTH_MISSING: load only the human-permitted source into DEEPSEEK_API_KEY');
const deadline=new Date(startedAt.getTime()+proposal.window.activeMs).toISOString();
const output=freeze.output;
save(join(output,'paid-start.json'),{batchId:proposal.batchId,manifest:file(freezePath),grant:file(grantPath),startedAt:startedAt.toISOString(),deadline,credentialSource:grant.credentialSource,credentialValue:'never retained',scope:'one new supplemental start; all SDK retries and compactions share stage budgets; no resume',priorLedger:freeze.prior.ledger,cumulativeLimits:freeze.limits,reusedLocalFix:'v1-live-r1-local-fix',originalBatchStatus:'STOPPED'});
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('BATCH_DEADLINE')),Math.max(1,Date.parse(deadline)-Date.now()));
let stage='prepare',result,cancellation=null,cancellationRecordError=null;
let evalEntered=false,improveEntered=false,analysisRunId=null;
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
 stage='eval';evalEntered=true;
 const evaluation=await api.eval.runEval({dataRoot:proposal.evalDataRoot,id:p.id,directory:proposal.evalDirectory,signal:controller.signal,fault:stopFailedTrial});
 save(join(output,'live-eval-result.json'),evaluation);
 if(controller.signal.aborted){result={status:'STOPPED',stage,reason:guard.stopped??String(controller.signal.reason),improve:'not-run'};}
 else{
  requireThreePasses(evaluation,p);
  stage='improve';improveEntered=true;
  const improveGuard=authenticationStop(api,proposal.improve.dataRoot,()=>analysisRunId,controller);
  const analysis=await api.runtime.analyzeImprove({workspace:proposal.improve.workspace,dataRoot:proposal.improve.dataRoot,targetRunId:proposal.improve.targetRunId,request:proposal.improve.request,mode:'live',signal:controller.signal,cancellation:'stop',onObservation:event=>{analysisRunId=event.runId;},fault:kind=>{if(analysisRunId)improveGuard.fault(kind);}});
  save(join(output,'live-improve-result.json'),analysis);
  const reopened=api.improve.readImproveReport(proposal.improve.dataRoot,proposal.improve.request.id);save(join(output,'reopened-improve-report.json'),reopened);
  result={status:!controller.signal.aborted&&analysis.status==='completed'&&analysis.cleanup==='confirmed'&&analysis.improve?.state==='complete'&&analysis.improve.candidates.length?'AWAITING_ACTUAL_CANDIDATE_SELECTION':'STOPPED_NO_EXECUTABLE_CHAIN',stage,runId:analysis.runId,analysisStatus:analysis.status,cleanup:analysis.cleanup,lifecycle:analysis.lifecycle??null,reportId:analysis.improve?.id??null,reportRevision:analysis.improve?.revision??null,candidates:analysis.improve?.candidates.length??0,selection:'none; paid grant does not select unknown future candidates',reason:improveGuard.stopped??analysis.reason??null};
 }
}catch(error){result={status:'STOPPED',stage,error:String(error),cleanup:'unknown',...(stage!=='improve'?{improve:'not-run'}:{}),...(stage==='prepare'?{eval:'not-run'}:{}),remaining:'not-run; no automatic repeat or new trial'};}
finally{
 clearTimeout(timer);
 try{
  const accounting=cumulativeLedger(stageLedger(api,proposal.evalDataRoot,proposal.evalPlan.id,'eval',evalEntered),stageLedger(api,proposal.improve.dataRoot,analysisRunId,'improve',improveEntered));
  save(join(output,'cumulative-budget.json'),accounting);result={...result,cumulativeBudget:file(join(output,'cumulative-budget.json')),originalBatchStatus:'STOPPED',reusedPass:'v1-live-r1-local-fix'};
 }catch(error){result={...result,cumulativeBudgetError:String(error),budgetDisposition:'Unknown; no restart or extra allowance'};}
 if(cancellation)result={...result,status:'CANCELLED',cancellation,cancellationRecordError,remaining:'not-run; no automatic repeat or new trial'};
 process.exitCode=cancellation?(cancellation.signal==='SIGINT'?130:143):result?.status==='AWAITING_ACTUAL_CANDIDATE_SELECTION'?0:1;
 try{save(join(output,'batch-result.json'),{...result,at:new Date().toISOString(),deadline,remoteTermination:'unknown',firstFailuresRetained:true,modelIdentity:'Requested alias is not immutable served model proof; inspect retained raw response',cost:'Use host stage budget facts; guest coding mirrors eval usage and must not be summed again'});}
 finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);}
}
console.log(JSON.stringify(result));
