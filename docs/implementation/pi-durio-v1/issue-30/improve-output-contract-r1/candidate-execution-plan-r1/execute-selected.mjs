#!/usr/bin/env node
// One approved, exact public #25 decision. No analysis, provider setup or rollback.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,cpSync,lstatSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {file,json,save,sha,verifyInstallation} from './common.mjs';

const root=dirname(fileURLToPath(import.meta.url)),manifestPath=join(root,'frozen-plan-manifest.json');
const manifest=json(manifestPath),authorizationPath=resolve(process.argv[2]??join(root,'actual-selection.json'));
// Deny before product imports, target operations, copy, temporary work or any receipt writes.
const authorization=json(authorizationPath);
assert.equal(authorization.authorized,true,'EXPLICIT_CANDIDATE_CHOICE_REQUIRED');
assert.equal(authorization.choice,'execute-declared-scope','EXACT_EXECUTE_CHOICE_REQUIRED');
assert.equal(authorization.manifestSha256,file(manifestPath).sha256,'SELECTION_MANIFEST_MISMATCH');
assert.equal(authorization.author,'human-user','DIRECT_HUMAN_SOURCE_REQUIRED');
assert.equal(authorization.source?.kind,'codex-user-reply','DIRECT_HUMAN_SOURCE_REQUIRED');
assert.ok(typeof authorization.source?.requestToolCallId==='string'&&authorization.source.requestToolCallId.trim(),'ACTUAL_SOURCE_REFERENCE_REQUIRED');
assert.ok(typeof authorization.exactHumanReply==='string'&&authorization.exactHumanReply.trim(),'ACTUAL_HUMAN_REPLY_REQUIRED');
assert.equal(authorization.acknowledgesOriginalReasoningError,true,'ORIGINAL_REASONING_CAVEAT_REQUIRED');
assert.equal(authorization.starts,1,'ONE_ATTEMPT_ONLY');
for(const input of manifest.inputs)assert.deepEqual(file(input.path),input,'FROZEN_INPUT_CHANGED:'+input.path);
const plan=json(manifest.plan.path),draft=json(manifest.decisionDraft.path),seed=json(manifest.closedSeed.path),artifact=json(plan.productArtifact.path);
assert.equal(root,manifest.root,'FIXED_PLAN_LOCATION_CHANGED');
assert.equal(draft.authorized,false);assert.equal(draft.actualChoice,null);assert.equal(draft.draftDecision.limits.deadline,null);
const require=createRequire(join(artifact.installation,'package.json'));
const installedIdentity=json(artifact.producerIdentity.path);
assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);
verifyInstallation(join(artifact.installation,'node_modules/pi-durio'),installedIdentity.installed);
assert.deepEqual(file(artifact.sourceBuild.path),artifact.sourceBuild);
verifyInstallation(seed.root,seed.files);
for(const f of plan.candidate.target.files)assert.equal(sha(readFileSync(join(plan.candidate.target.workspace,f.path))),f.sha256,'FORMAL_BASELINE_CHANGED');
const dataRoot=plan.data.clone,work=draft.draftDecision.directory;
assert.ok(!existsSync(dataRoot)&&!existsSync(work)&&!existsSync(join(root,'execution-start.json')),'ALREADY_ENTERED_OR_WORK_EXISTS');
assert.equal(realpathSync(dirname(dataRoot)),root);assert.equal(realpathSync(dirname(work)),root);
assert.ok(!seed.files.some(f=>f.symlink||f.path==='api.env'||f.path.endsWith('-wal')||f.path.endsWith('-shm')),'CLOSED_ORDINARY_SEED_REQUIRED');
const grantTime=Date.parse(authorization.grantedAt),startedAt=new Date();
assert.ok(Number.isFinite(grantTime)&&grantTime<=startedAt.getTime()&&startedAt.getTime()-grantTime<=plan.time.grantToStartMs,'SELECTION_EXPIRED_OR_FUTURE');
const deadline=new Date(startedAt.getTime()+plan.time.activeMs).toISOString();
const decision=structuredClone(draft.draftDecision);decision.limits.deadline=deadline;
save(join(root,'execution-start.json'),{manifest:file(manifestPath),authorization:file(authorizationPath),startedAt:startedAt.toISOString(),deadline,decisionId:decision.id,clonedBaseline:manifest.closedSeed,cloneGlobalCutoff:seed.globalCutoff,priorCumulativeRequests:45,newProviderBudget:0,scope:'one fixed regression and conditional clamp.ts writeback; consumed on entry; no retry'});
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('CANDIDATE_DEADLINE')),plan.time.activeMs);
let cancellation=null,stage='clone',result,api,improve,query;
const cancel=signal=>{cancellation??={signal,at:new Date().toISOString()};controller.abort(Error(signal));};
const onInt=()=>cancel('SIGINT'),onTerm=()=>cancel('SIGTERM');process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
try{
  controller.signal.throwIfAborted();
  cpSync(seed.root,dataRoot,{recursive:true,force:false,errorOnExist:true,dereference:false});
  verifyInstallation(seed.root,seed.files);verifyInstallation(dataRoot,seed.files);
  for(const f of seed.files)assert.notEqual(lstatSync(join(seed.root,f.path)).ino,lstatSync(join(dataRoot,f.path)).ino,'CLONE_MUST_NOT_SHARE_FILE_INODES');
  save(join(root,'clone-receipt.json'),{closedTree:manifest.closedSeed,source:seed.root,dataRoot,exactBytes:true,independentInodes:true,globalCutoff:seed.globalCutoff,inheritedProviderDispatches:plan.data.cloneOriginalProviderDispatches,newProviderRequests:0,accounting:'The inherited 4 provider records belong to the already counted cumulative 45 requests. They are not new expense.'});
  controller.signal.throwIfAborted();stage='public-preview';
  const load=id=>import(pathToFileURL(require.resolve(id)).href);
  api=await load('pi-durio/improve-decisions');improve=await load('pi-durio/improve');query=await load('pi-durio/query');
  const canonical=json(plan.report.canonicalSource.path).improve;
  const cloned=improve.readImproveReport(dataRoot,decision.reportId);
  assert.deepEqual(cloned.report,canonical,'CLONED_REPORT_OR_CANDIDATE_CHANGED');assert.deepEqual(cloned.decisions,[],'CLONE_MUST_BE_UNSELECTED');
  save(join(root,'authorized-decision.json'),decision);
  save(join(root,'public-preview.json'),api.previewImproveDecision(dataRoot,decision));
  controller.signal.throwIfAborted();stage='public-submit';
  const submitted=await api.submitImproveDecision({dataRoot,decision,signal:controller.signal});
  save(join(root,'submitted-result.json'),submitted);
  stage='readonly-reopen';
  const reopened=api.readImproveDecision(dataRoot,decision.id),report=improve.readImproveReport(dataRoot,decision.reportId);
  save(join(root,'reopened-decision.json'),reopened);save(join(root,'reopened-report.json'),report);
  assert.deepEqual(reopened,submitted,'DECISION_READBACK_CHANGED');assert.deepEqual(report.report,canonical,'ORIGINAL_CANONICAL_REPORT_CHANGED');
  const newRecords=[];let after=seed.globalCutoff;
  for(;;){const page=query.readRunRecords(dataRoot,canonical.runId,{after,limit:50});newRecords.push(...page.records);if(!page.more)break;after=page.records.at(-1).seq;}
  save(join(root,'new-records-index.json'),{afterExclusive:seed.globalCutoff,runId:canonical.runId,records:newRecords,copiedHistoryExcluded:true});
  assert.equal(newRecords.filter(r=>r.kind.startsWith('provider.')||r.kind.startsWith('budget.')||r.kind==='model.dispatch').length,0,'UNEXPECTED_NEW_PROVIDER_OR_BUDGET_RECORD');
  assert.equal(reopened.state,'completed','CANDIDATE_DECISION_NOT_COMPLETED');assert.equal(reopened.writeback,'written');assert.equal(reopened.activation,'not-enabled');
  assert.equal(reopened.groups.length,1);assert.equal(reopened.groups[0].result.checks.length,1);
  assert.equal(reopened.groups[0].result.checks[0].state,'completed');assert.equal(reopened.groups[0].result.checks[0].execution.terminated,true);
  const finalFiles=plan.candidate.target.files.map(f=>file(join(plan.candidate.target.workspace,f.path)));
  for(const f of finalFiles)assert.equal(f.sha256,f.path.endsWith('/clamp.ts')?plan.writeback.after:plan.writeback.protected[f.path.slice(plan.candidate.target.workspace.length+1)],'FORMAL_READBACK_CHANGED');
  save(join(root,'formal-file-readback.json'),{files:finalFiles,clampWriteback:'exact-validated-bytes',protected:'unchanged',activation:'not-enabled'});
  verifyInstallation(seed.root,seed.files);
  result={status:'COMPLETED_EXACT_PROJECT_WRITEBACK',stage,decisionId:decision.id,dataRoot,scope:['clamp.ts'],checkCount:1,newProviderRequests:0,newTokens:0,priorCumulativeRequests:45,cumulativeChargedUpperUsd:1.4248548,activation:'not-enabled',effect:'direct-checks-passed; no model quality or performance claim',originalAnalysisTreeUnchanged:true,originalReasoningErrorPreserved:true};
}catch(error){
  result={status:'STOPPED_NO_RETRY',stage,error:String(error),decisionId:decision.id,dataRoot,remaining:'not-run; no retry, continuation or automatic rollback',writeback:'inspect original receipts; may be not-written, partial or unknown',candidateAcceptance:'not claimed'};
  if(api&&stage!=='clone')try{save(join(root,'failure-decision-readback.json'),api.readImproveDecision(dataRoot,decision.id));}catch(readError){result.readbackError=String(readError);}
}finally{
  clearTimeout(timer);
  if(cancellation)result={...result,status:'CANCELLED_NO_RETRY',cancellation};
  process.exitCode=result?.status==='COMPLETED_EXACT_PROJECT_WRITEBACK'?0:1;
  try{save(join(root,'execution-result.json'),{...result,at:new Date().toISOString(),deadline,firstFailuresRetained:true,rollbackAuthorized:false});}
  catch(error){process.exitCode=1;throw error;}
  finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);}
}
console.log(JSON.stringify(result));
