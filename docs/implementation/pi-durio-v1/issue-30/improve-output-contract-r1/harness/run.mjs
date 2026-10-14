#!/usr/bin/env node
// Exactly one fresh improve analysis; no eval, selection, validation or writeback.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {installed,authenticationStop,json,save,file,sha,verifyInstallation} from './common.mjs';
import {preflight,verifyPrior,verifyCandidateGate} from './preflight.mjs';
import {stageLedger,cumulativeLedger} from './ledger.mjs';
const {freezePath,grantPath,freeze,grant,proposal,artifact}=preflight(...process.argv.slice(2));
const identity=json(artifact.producerIdentity.path);
assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);
verifyInstallation(join(artifact.installation,'node_modules/pi-durio'),identity.installed);
assert.deepEqual(file(artifact.sourceBuild.path),artifact.sourceBuild,'SOURCE_BUILD_CHANGED');
const api=await installed(artifact.installation);
for(const [path,hash]of Object.entries(freeze.fixture.fileHashes))assert.equal(sha(readFileSync(join(proposal.improve.workspace,path))),hash,`FIXTURE_CHANGED:${path}`);
api.improve.validateImproveRequest(proposal.improve.request,'live');
const prior=verifyPrior(freeze);verifyCandidateGate(freeze,artifact,prior.passes);
const startedAt=new Date(),grantTime=Date.parse(grant.grantedAt);
assert.ok(Number.isFinite(grantTime)&&grantTime<=startedAt.getTime()&&startedAt.getTime()-grantTime<=proposal.window.grantToStartMs,'GRANT_EXPIRED_BEFORE_START');
assert.ok(process.env.DEEPSEEK_API_KEY?.trim(),'AUTH_MISSING: load only the human-permitted source into DEEPSEEK_API_KEY');
const deadline=new Date(startedAt.getTime()+proposal.window.activeMs).toISOString(),output=freeze.output;
save(join(output,'paid-start.json'),{batchId:proposal.batchId,manifest:file(freezePath),grant:file(grantPath),startedAt:startedAt.toISOString(),deadline,credentialSource:grant.credentialSource,credentialValue:'never retained',scope:'one new improve-only start; no eval or automatic resume; new unknown usage stops',priorBudget:freeze.previousImprove.cumulativeBudget,cumulativeLimits:freeze.limits,priorUnknownReservationRetained:1056768});
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('BATCH_DEADLINE')),Math.max(1,Date.parse(deadline)-Date.now()));
let stage='prepare',result,cancellation=null,cancellationRecordError=null,improveEntered=false,analysisRunId=null;
const cancel=signal=>{if(cancellation)return;cancellation={signal,at:new Date().toISOString(),remoteTermination:'unknown'};try{save(join(output,'cancellation-request.json'),cancellation);}catch(error){cancellationRecordError=String(error);}controller.abort(Error(`BATCH_${signal}`));};
const onInterrupt=()=>cancel('SIGINT'),onTerminate=()=>cancel('SIGTERM');
process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
try{
 save(join(output,'authorized-plan.json'),{proposal:file(freeze.proposal.path),grant:file(grantPath),request:proposal.improve.request,deadline,scope:'Exactly one improve analysis; no evaluation or candidate selection'});
 controller.signal.throwIfAborted();stage='improve';improveEntered=true;
 const guard=authenticationStop(api,proposal.improve.dataRoot,()=>analysisRunId,controller);
 const analysis=await api.runtime.analyzeImprove({workspace:proposal.improve.workspace,dataRoot:proposal.improve.dataRoot,targetRunId:proposal.improve.targetRunId,request:proposal.improve.request,mode:'live',signal:controller.signal,cancellation:'stop',onObservation:event=>{analysisRunId=event.runId;},fault:kind=>{if(analysisRunId)guard.fault(kind);}});
 save(join(output,'live-improve-result.json'),analysis);
 const reopened=api.improve.readImproveReport(proposal.improve.dataRoot,proposal.improve.request.id);save(join(output,'reopened-improve-report.json'),reopened);
 result={status:!controller.signal.aborted&&analysis.status==='completed'&&analysis.cleanup==='confirmed'&&analysis.improve?.state==='complete'&&analysis.improve.candidates.length?'AWAITING_ACTUAL_CANDIDATE_SELECTION':'STOPPED_NO_EXECUTABLE_CHAIN',stage,runId:analysis.runId,analysisStatus:analysis.status,cleanup:analysis.cleanup,lifecycle:analysis.lifecycle??null,reportId:analysis.improve?.id??null,reportRevision:analysis.improve?.revision??null,candidates:analysis.improve?.candidates.length??0,selection:'none; paid grant does not select unknown future candidates',reason:guard.stopped??analysis.reason??null};
}catch(error){result={status:'STOPPED',stage,error:String(error),cleanup:'unknown',...(stage!=='improve'?{improve:'not-run'}:{}),remaining:'not-run; no automatic repeat'};}
finally{
 clearTimeout(timer);
 try{const accounting=cumulativeLedger(stageLedger(api,proposal.improve.dataRoot,analysisRunId,'improve',improveEntered));save(join(output,'cumulative-budget.json'),accounting);result={...result,cumulativeBudget:file(join(output,'cumulative-budget.json'))};if(improveEntered&&(accounting.stages[0].completeness!=='known'||accounting.stages[0].unknown!==0||accounting.boundExceeded))result={...result,status:'STOPPED_BUDGET_INCOMPLETE_OR_EXCEEDED',budgetDisposition:'New stage usage must be known and within bounds; old prior UNKNOWN remains conservatively reserved'};}
 catch(error){result={...result,status:'STOPPED_BUDGET_RECEIPT_FAILURE',cumulativeBudgetError:String(error),budgetCompleteness:'unknown',budgetDisposition:'Unknown; no restart or extra allowance',remaining:'not-run; no automatic repeat or candidate execution'};}
 if(cancellation)result={...result,status:'CANCELLED',cancellation,cancellationRecordError,remaining:'not-run; no automatic repeat'};
 process.exitCode=cancellation?(cancellation.signal==='SIGINT'?130:143):result?.status==='AWAITING_ACTUAL_CANDIDATE_SELECTION'?0:1;
 try{save(join(output,'batch-result.json'),{...result,at:new Date().toISOString(),deadline,remoteTermination:'unknown',firstFailuresRetained:true,priorUnknownReservationRetained:1056768,modelIdentity:'Requested alias is not immutable served model proof; inspect retained raw response',cost:'Only host settlements and retained UNKNOWN reservations; SDK mirrors are never added'});}
 finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);}
}
console.log(JSON.stringify(result));
