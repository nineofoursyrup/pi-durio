// External USD 3 batch gate. No product import, environment lookup or credential read.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {file,json,sha} from './common.mjs';

export const LIMITS=Object.freeze({maxRequests:40,maxTokens:2400000,usdCeiling:3,grantToStartMs:86400000,activeMs:3600000,starts:1});
export const STAGES=Object.freeze({eval:{maxRequests:32,maxTokens:1200000,maxRequestTokens:1052672,maxOutputTokens:4096},improve:{maxRequests:8,maxTokens:1200000,maxRequestTokens:1056768,maxOutputTokens:8192}});
export const CREDENTIAL_SOURCE='/Users/nineofour/Durio/api.env';
const OLD_MANIFEST='d5272b244660c2a54a2fc70d1f5c50785ed20edf92a3dfb78a7e24ef7dfb3a22';
const OLD_PROPOSAL='6af625fa56de175368f5e0063b43ee13bdef095a59a3cc4c9736684001afa877';
const WINDOW={grantToStartMs:86400000,activeMs:3600000,starts:1,definition:'One start within 24 hours of grant; immutable deadline start+60 minutes, including both stages. No resume or replacement batch after interruption or expiry.'};

export function deriveProposal(original,output,observation){
 const p=structuredClone(original);
 p.batchId='pi-durio-v1-live-r1-usd3';p.evalPlan.id=p.batchId;
 p.evalPlan.budget.maxTokens=STAGES.eval.maxTokens;
 p.improve.request.limits.maxTokens=STAGES.improve.maxTokens;
 p.evalDataRoot=join(output,'eval-data');p.evalDirectory=join(output,'live-eval');
 // Seed facts bind the original real workspace. Analysis is read-only there.
 p.improve.dataRoot=join(output,'improve-data');
 p.aggregate.maxTokens=LIMITS.maxTokens;p.aggregate.conservativePriceEstimateUsd=2.88;p.aggregate.requestedUsdCeiling=LIMITS.usdCeiling;
 p.credential.source=CREDENTIAL_SOURCE;
 p.credential.readiness='USER_SOURCE_AUTHORIZED; contents not read during preparation; readiness confirmation required before execution';
 p.providerRecheck=observation;
 return p;
}

export function preflight(freezeArg,grantArg){
 assert.ok(freezeArg&&grantArg,'EXPLICIT_PAID_GRANT_REQUIRED');
 const freezePath=resolve(freezeArg),grantPath=resolve(grantArg);
 assert.ok(existsSync(grantPath),'EXPLICIT_PAID_GRANT_REQUIRED');
 const freeze=json(freezePath),grant=json(grantPath);
 assert.equal(grant.paidApproved,true,'EXPLICIT_PAID_GRANT_REQUIRED');
 assert.equal(grant.manifestSha256,sha(readFileSync(freezePath)),'GRANT_MANIFEST_MISMATCH');
 assert.equal(grant.batchId,freeze.batchId,'GRANT_BATCH_MISMATCH');
 assert.deepEqual(grant.limits,LIMITS,'EXACT_REVIEWED_LIMITS_REQUIRED');
 assert.deepEqual(freeze.limits,LIMITS,'MANIFEST_LIMITS_CHANGED');
 assert.deepEqual(freeze.stages,STAGES,'MANIFEST_STAGES_CHANGED');
 assert.equal(grant.credentialSource,CREDENTIAL_SOURCE,'PERMITTED_CREDENTIAL_SOURCE_REQUIRED');
 assert.equal(freeze.output,dirname(freezePath),'OUTPUT_MUST_BE_MANIFEST_DIRECTORY');
 const here=dirname(fileURLToPath(import.meta.url));
 for(const name of ['run.mjs','common.mjs','preflight.mjs','launch.py'])assert.ok(freeze.harness.some(e=>e.path===join(here,name)),`HARNESS_NOT_FROZEN:${name}`);
 for(const entry of [freeze.proposal,freeze.artifact,...freeze.harness,freeze.caseSource,freeze.providerObservation,freeze.authorizationEvidence,freeze.derivation.originalManifest,...freeze.supportingEvidence])assert.deepEqual(file(entry.path),entry,`FROZEN_CONTENT_CHANGED:${entry.path}`);
 assert.equal(freeze.derivation.originalManifest.sha256,OLD_MANIFEST,'ORIGINAL_MANIFEST_CHANGED');
 const old=json(freeze.derivation.originalManifest.path);
 assert.equal(old.proposal.sha256,OLD_PROPOSAL,'ORIGINAL_PROPOSAL_CHANGED');
 assert.deepEqual(file(old.proposal.path),old.proposal,'ORIGINAL_PROPOSAL_CHANGED');
 assert.deepEqual(freeze.artifact,old.artifact,'PRODUCT_ARTIFACT_CHANGED');
 assert.deepEqual(freeze.fixture,old.fixture,'FIXTURE_CHANGED');
 assert.deepEqual(freeze.caseSource,old.caseSource,'CASES_CHANGED');
 for(const output of [old.output,freeze.output])for(const name of ['paid-start.json','authorized-plan.json'])assert.equal(existsSync(join(output,name)),false,'BATCH_ALREADY_STARTED');
 const authorization=json(freeze.authorizationEvidence.path);
 assert.equal(authorization.receivedAt,'2026-10-10T05:34:25.010886Z','AUTHORIZATION_SOURCE_CHANGED');
 assert.equal(authorization.budgetAuthorization.exactHumanReply,'额度不超过3 usd','AUTHORIZATION_SOURCE_CHANGED');
 assert.equal(grant.humanAuthorization,authorization.budgetAuthorization.exactHumanReply,'EXACT_HUMAN_AUTHORIZATION_REQUIRED');
 assert.deepEqual(grant.authorizationSource,freeze.authorizationEvidence,'AUTHORIZATION_SOURCE_REQUIRED');
 assert.equal(grant.grantedAt,authorization.receivedAt,'ORIGINAL_GRANT_TIME_REQUIRED');
 const now=Date.now(),at=Date.parse(grant.grantedAt);
 assert.ok(Number.isFinite(at)&&at<=now&&now-at<=LIMITS.grantToStartMs,'GRANT_EXPIRED_OR_INVALID');
 const proposal=json(freeze.proposal.path),original=json(old.proposal.path),artifact=json(freeze.artifact.path);
 assert.deepEqual(proposal,deriveProposal(original,freeze.output,freeze.providerObservation),'PROPOSAL_NOT_EXACT_USD3_DERIVATIVE');
 assert.equal(freeze.batchId,proposal.batchId,'MANIFEST_BATCH_MISMATCH');
 assert.equal(proposal.status,'PENDING_EXPLICIT_HUMAN_GRANT; not an executable paid plan');
 assert.deepEqual(proposal.window,WINDOW,'WINDOW_CHANGED');
 const e=proposal.evalPlan,i=proposal.improve.request;
 for(const [actual,expected]of [[e.budget,STAGES.eval],[i.limits,STAGES.improve]]){
  for(const key of ['maxRequests','maxTokens','maxRequestTokens'])assert.equal(actual[key],expected[key],`STAGE_LIMIT_CHANGED:${key}`);
  assert.ok(actual.maxTokens>=actual.maxRequestTokens,'STAGE_CANNOT_RESERVE_ONE_REQUEST');
 }
 assert.equal(e.maxOutputTokens,STAGES.eval.maxOutputTokens,'EVAL_OUTPUT_CHANGED');
 assert.equal(i.limits.maxOutputTokens,STAGES.improve.maxOutputTokens,'IMPROVE_OUTPUT_CHANGED');
 assert.equal(e.budget.deadline,null,'UNAUTHORIZED_DEADLINE');assert.equal(e.authorization.paid,false,'UNAUTHORIZED_PLAN');
 assert.deepEqual(e.budget.unknownUpperBound,{tokens:1052672,source:'https://api-docs.deepseek.com/api/list-models/'},'UNKNOWN_USAGE_BOUND_CHANGED');
 assert.equal(e.trialTimeoutMs,300000);assert.equal(e.gradingTimeoutMs,30000);assert.equal(i.limits.maxDurationMs,300000);
 assert.equal(e.budget.maxRequests+i.limits.maxRequests,proposal.aggregate.maxRequests,'REQUEST_SUM_MISMATCH');
 assert.equal(e.budget.maxTokens+i.limits.maxTokens,proposal.aggregate.maxTokens,'TOKEN_SUM_MISMATCH');
 assert.equal(proposal.aggregate.maxRequests,LIMITS.maxRequests);assert.equal(proposal.aggregate.maxTokens,LIMITS.maxTokens);
 assert.deepEqual(e.model,{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},'MODEL_CHANGED');
 assert.equal(e.price.currency,'USD');assert.equal(e.price.perMillionTokens,1.2);assert.equal(e.price.source,'https://api-docs.deepseek.com/quick_start/pricing/');
 const observation=json(freeze.providerObservation.path);
 assert.equal(observation.maximumListedUsdPerMillionAnyClass,1.2,'TARIFF_CHANGED');assert.equal(observation.contextTokens,1048576,'CONTEXT_BOUND_CHANGED');
 assert.equal(proposal.aggregate.maximumListedUsdPerMillionTokens,e.price.perMillionTokens,'PRICE_MISMATCH');
 const estimate=proposal.aggregate.maxTokens*e.price.perMillionTokens/1000000;
 assert.equal(estimate,proposal.aggregate.conservativePriceEstimateUsd,'ESTIMATE_MISMATCH');
 assert.equal(proposal.aggregate.requestedUsdCeiling,LIMITS.usdCeiling);assert.ok(estimate<=LIMITS.usdCeiling,'USD_CEILING_EXCEEDED');
 return {freezePath,grantPath,freeze,grant,proposal,artifact};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{preflight(...process.argv.slice(2));console.log('PREFLIGHT_PASS_NO_CREDENTIAL_ACCESS');}
 catch(error){console.error(`PREFLIGHT_DENIED: ${error.message}`);process.exitCode=1;}
}
