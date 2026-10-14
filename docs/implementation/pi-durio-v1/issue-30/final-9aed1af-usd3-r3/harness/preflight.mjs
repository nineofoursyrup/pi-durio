// Supplemental one-start gate. No product import or credential/environment lookup.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {file,json,sha} from './common.mjs';

export const BATCH='pi-durio-v1-live-r2-usd3-supplement';
export const CREDENTIAL_SOURCE='/Users/nineofour/Durio/api.env';
export const LIMITS=Object.freeze({maxRequests:32,maxTokens:2372501,cumulativeMaxRequests:47,cumulativeMaxTokens:2400000,usdCeiling:3,grantToStartMs:86400000,activeMs:3600000,starts:1});
export const STAGES=Object.freeze({eval:{maxRequests:24,maxTokens:1172501,maxRequestTokens:1052672,maxOutputTokens:4096},improve:{maxRequests:8,maxTokens:1200000,maxRequestTokens:1056768,maxOutputTokens:8192}});
export const PRIOR=Object.freeze({requests:15,knownTokens:27499,reservedTokens:0,unknown:0,conservativeEstimateUsd:0.0329988});
const PRIOR_MANIFEST='51ff05f19a55cd14653f1f00dc7a07d4bc5f9931b7107091ad5207ce0e269486';
const PRIOR_PROPOSAL='9753ea7302890d89f67be4723c5ed98e79c37c5ff5e493301c555947ff355037';
const CASES=['multi-file','regression','no-change'];
const WINDOW={grantToStartMs:86400000,activeMs:3600000,starts:1,definition:'One start within 24 hours of grant; immutable deadline start+60 minutes, including both stages. No resume or replacement batch after interruption or expiry.'};
const exact=entry=>assert.deepEqual(file(entry.path),entry,`FROZEN_CONTENT_CHANGED:${entry.path}`);

export function deriveProposal(original,output,observation,prior){
 const p=structuredClone(original);
 p.batchId=p.evalPlan.id=BATCH;
 p.evalPlan.purpose='One supplemental real-provider batch: three unchanged single trials after retained first failure; prior local-fix PASS reused; no first-attempt 4/4 or population claim';
 p.evalPlan.cases=p.evalPlan.cases.filter(c=>CASES.includes(c.id));
 p.evalPlan.trials=p.evalPlan.trials.filter(t=>CASES.includes(t.caseId)).map(t=>({...t,id:`v1-live-r2-${t.caseId}`}));
 p.evalPlan.budget.maxRequests=STAGES.eval.maxRequests;p.evalPlan.budget.maxTokens=STAGES.eval.maxTokens;
 p.evalDataRoot=join(output,'eval-data');p.evalDirectory=join(output,'live-eval');
 p.improve.dataRoot=join(output,'improve-data');p.improve.request.id='v1-live-r2-improve';
 p.aggregate.maxRequests=LIMITS.maxRequests;p.aggregate.maxTokens=LIMITS.maxTokens;p.aggregate.conservativePriceEstimateUsd=2.8470012;
 p.aggregate.cumulative={prior:PRIOR,maxRequests:47,maxTokens:2400000,conservativePriceEstimateUsd:2.88,requestedUsdCeiling:3};
 p.credential.readiness='PENDING_NEW_EXPLICIT_ONE_START; no credential read during preparation';
 p.providerRecheck=observation;
 p.supplement={priorEvidence:prior,reusedCase:'local-fix',retryOf:{'v1-live-r2-multi-file':'v1-live-r1-multi-file'},reporting:'Original STOPPED and first failure remain unchanged; supplemental coverage is reported separately'};
 return p;
}

export function verifyPrior(freeze){
 const prior=freeze.prior;
 for(const entry of [prior.manifest,prior.proposal,prior.paidStart,prior.batchResult,prior.liveResult,prior.readIndex,prior.diagnosis,prior.ledger])exact(entry);
 assert.equal(prior.manifest.sha256,PRIOR_MANIFEST,'PRIOR_MANIFEST_CHANGED');
 assert.equal(prior.proposal.sha256,PRIOR_PROPOSAL,'PRIOR_PROPOSAL_CHANGED');
 const original=json(prior.proposal.path),old=json(prior.manifest.path),result=json(prior.liveResult.path),ended=json(prior.batchResult.path),ledger=json(prior.ledger.path);
 assert.deepEqual(old.proposal,prior.proposal,'PRIOR_PROPOSAL_NOT_BOUND');
 assert.equal(json(prior.paidStart.path).manifest.sha256,PRIOR_MANIFEST,'PRIOR_START_NOT_BOUND');
 assert.equal(ended.status,'STOPPED');assert.equal(ended.improve,'not-run');
 assert.equal(result.planId,old.batchId);assert.equal(result.budget.requests,15);assert.equal(result.budget.dispatches,15);assert.equal(result.budget.knownTokens,27499);assert.equal(result.budget.missing,0);assert.equal(result.budget.boundsExceeded,0);assert.equal(result.budget.completeness,'known');
 assert.deepEqual(ledger.prior,PRIOR,'PRIOR_LEDGER_CHANGED');
 assert.equal(ledger.originalStatus,'STOPPED');assert.equal(ledger.localFixTrialId,'v1-live-r1-local-fix');assert.equal(ledger.failedTrialId,'v1-live-r1-multi-file');
 const local=result.trials.find(t=>t.id===ledger.localFixTrialId),failed=result.trials.find(t=>t.id===ledger.failedTrialId);
 assert.ok(local?.outcome.status==='completed'&&local.outcome.started&&local.outcome.valid&&local.grade?.judgment==='PASS'&&local.grade.outcome===local.outcome.source,'PRIOR_LOCAL_PASS_REQUIRED');
 assert.equal(local.outcome.source,ledger.localFixOutcome);assert.equal(local.grade.source,ledger.localFixGrade);
 assert.equal(failed?.outcome.status,'error');assert.equal(failed.grade?.judgment,'unknown');assert.deepEqual(failed.grade.checks,[{name:'scope',passed:true}]);
 assert.equal(failed.outcome.source,ledger.failedOutcome);assert.equal(failed.grade.source,ledger.failedGrade);
 assert.deepEqual(result.plan.cases,original.evalPlan.cases,'PRIOR_CASES_NOT_EXACT');
 assert.deepEqual(result.plan.runtime,original.evalPlan.runtime,'PRIOR_RUNTIME_NOT_EXACT');
 for(const row of json(prior.readIndex.path)){assert.notEqual(row.path,CREDENTIAL_SOURCE,'CREDENTIAL_NOT_EVIDENCE');exact(row);}
 return {old,original,result,ended,ledger};
}

export function preflight(freezeArg,grantArg){
 assert.ok(freezeArg&&grantArg,'EXPLICIT_NEW_PAID_GRANT_REQUIRED');
 const freezePath=resolve(freezeArg),grantPath=resolve(grantArg);
 assert.ok(existsSync(grantPath),'EXPLICIT_NEW_PAID_GRANT_REQUIRED');
 const freeze=json(freezePath),grant=json(grantPath);
 assert.equal(grant.paidApproved,true,'EXPLICIT_NEW_PAID_GRANT_REQUIRED');
 assert.equal(grant.manifestSha256,sha(readFileSync(freezePath)),'GRANT_MANIFEST_MISMATCH');
 assert.equal(grant.batchId,BATCH,'GRANT_BATCH_MISMATCH');assert.equal(freeze.batchId,BATCH,'MANIFEST_BATCH_MISMATCH');
 assert.deepEqual(grant.limits,LIMITS,'EXACT_SUPPLEMENT_LIMITS_REQUIRED');assert.deepEqual(freeze.limits,LIMITS,'MANIFEST_LIMITS_CHANGED');assert.deepEqual(freeze.stages,STAGES,'MANIFEST_STAGES_CHANGED');
 assert.equal(grant.credentialSource,CREDENTIAL_SOURCE,'PERMITTED_CREDENTIAL_SOURCE_REQUIRED');assert.equal(freeze.output,dirname(freezePath),'OUTPUT_MUST_BE_MANIFEST_DIRECTORY');
 for(const name of ['paid-start.json','authorized-plan.json'])assert.equal(existsSync(join(freeze.output,name)),false,'BATCH_ALREADY_STARTED');
 const here=dirname(fileURLToPath(import.meta.url));
 for(const name of ['run.mjs','common.mjs','preflight.mjs','supplement.mjs','launch.py'])assert.ok(freeze.harness.some(e=>e.path===join(here,name)),`HARNESS_NOT_FROZEN:${name}`);
 for(const entry of [freeze.proposal,freeze.artifact,...freeze.harness,freeze.caseSource,freeze.providerObservation,...freeze.supportingEvidence,...freeze.initialDataRoots])exact(entry);
 const {old,original,ended}=verifyPrior(freeze);
 assert.deepEqual(freeze.artifact,old.artifact,'PRODUCT_ARTIFACT_CHANGED');assert.deepEqual(freeze.fixture,old.fixture,'FIXTURE_CHANGED');assert.deepEqual(freeze.caseSource,old.caseSource,'CASES_CHANGED');
 assert.ok(grant.authorizationSource,'NEW_AUTHORIZATION_SOURCE_REQUIRED');exact(grant.authorizationSource);
 assert.notEqual(grant.authorizationSource.path,old.authorizationEvidence.path,'OLD_AUTHORIZATION_NOT_REUSABLE');
 const authorization=json(grant.authorizationSource.path);
 assert.equal(authorization.kind,'supplemental-one-start','NEW_AUTHORIZATION_KIND_REQUIRED');assert.equal(authorization.manifestSha256,grant.manifestSha256,'NEW_AUTHORIZATION_MANIFEST_REQUIRED');assert.equal(authorization.batchId,BATCH,'NEW_AUTHORIZATION_BATCH_REQUIRED');assert.deepEqual(authorization.limits,LIMITS,'NEW_AUTHORIZATION_LIMITS_REQUIRED');
 assert.equal(authorization.priorManifestSha256,PRIOR_MANIFEST,'PRIOR_AUTHORIZATION_LINK_REQUIRED');
 assert.ok(typeof authorization.exactHumanReply==='string'&&authorization.exactHumanReply.trim(),'EXACT_HUMAN_AUTHORIZATION_REQUIRED');assert.equal(grant.humanAuthorization,authorization.exactHumanReply,'EXACT_HUMAN_AUTHORIZATION_REQUIRED');assert.equal(grant.grantedAt,authorization.receivedAt,'NEW_GRANT_TIME_MUST_MATCH_SOURCE');
 const now=Date.now(),at=Date.parse(grant.grantedAt);
 assert.ok(Number.isFinite(at)&&at>Date.parse(ended.at)&&at<=now&&now-at<=LIMITS.grantToStartMs,'NEW_GRANT_EXPIRED_OR_INVALID');
 const proposal=json(freeze.proposal.path),artifact=json(freeze.artifact.path);
 assert.deepEqual(proposal,deriveProposal(original,freeze.output,freeze.providerObservation,freeze.prior),'PROPOSAL_NOT_EXACT_SUPPLEMENT');
 assert.equal(proposal.status,'PENDING_EXPLICIT_HUMAN_GRANT; not an executable paid plan');assert.deepEqual(proposal.window,WINDOW,'WINDOW_CHANGED');
 const e=proposal.evalPlan,i=proposal.improve.request;
 assert.deepEqual(e.trials.map(t=>t.caseId),CASES,'EXACT_THREE_TRIALS_REQUIRED');
 for(const [actual,expected]of [[e.budget,STAGES.eval],[i.limits,STAGES.improve]]){
  for(const key of ['maxRequests','maxTokens','maxRequestTokens'])assert.equal(actual[key],expected[key],`STAGE_LIMIT_CHANGED:${key}`);
  assert.ok(actual.maxTokens>=actual.maxRequestTokens,'STAGE_CANNOT_RESERVE_ONE_REQUEST');
 }
 assert.equal(e.maxOutputTokens,4096);assert.equal(i.limits.maxOutputTokens,8192);assert.equal(e.budget.deadline,null,'UNAUTHORIZED_DEADLINE');assert.equal(e.authorization.paid,false,'UNAUTHORIZED_PLAN');
 assert.deepEqual(e.budget.unknownUpperBound,{tokens:1052672,source:'https://api-docs.deepseek.com/api/list-models/'});assert.equal(e.trialTimeoutMs,300000);assert.equal(e.gradingTimeoutMs,30000);assert.equal(i.limits.maxDurationMs,300000);
 assert.equal(e.budget.maxRequests+i.limits.maxRequests,LIMITS.maxRequests);assert.equal(e.budget.maxTokens+i.limits.maxTokens,LIMITS.maxTokens);
 assert.equal(PRIOR.requests+LIMITS.maxRequests,LIMITS.cumulativeMaxRequests);assert.equal(PRIOR.knownTokens+PRIOR.reservedTokens+LIMITS.maxTokens,LIMITS.cumulativeMaxTokens);
 assert.deepEqual(e.model,{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'});assert.equal(e.price.currency,'USD');assert.equal(e.price.perMillionTokens,1.2);assert.equal(e.price.source,'https://api-docs.deepseek.com/quick_start/pricing/');
 const observation=json(freeze.providerObservation.path);assert.equal(observation.maximumListedUsdPerMillionAnyClass,1.2,'TARIFF_CHANGED');assert.equal(observation.contextTokens,1048576,'CONTEXT_BOUND_CHANGED');
 assert.equal(LIMITS.maxTokens*1.2/1000000,proposal.aggregate.conservativePriceEstimateUsd);assert.equal(LIMITS.cumulativeMaxTokens*1.2/1000000,proposal.aggregate.cumulative.conservativePriceEstimateUsd);assert.ok(proposal.aggregate.cumulative.conservativePriceEstimateUsd<=LIMITS.usdCeiling,'USD_CEILING_EXCEEDED');
 return {freezePath,grantPath,freeze,grant,proposal,artifact};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{preflight(...process.argv.slice(2));console.log('PREFLIGHT_PASS_NO_CREDENTIAL_ACCESS');}
 catch(error){console.error(`PREFLIGHT_DENIED: ${error.message}`);process.exitCode=1;}
}
