// Fresh improve-only grant gate. No product import or credential/environment lookup.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {file,json,sha,verifyInstallation} from './common.mjs';

export const BATCH='pi-durio-v1-live-r3-improve-repair';
export const REQUEST='v1-live-r3-improve';
export const CREDENTIAL_SOURCE='/Users/nineofour/Durio/api.env';
export const LIMITS=Object.freeze({maxRequests:8,maxTokens:1200000,cumulativeMaxRequests:42,cumulativeMaxTokens:2318328,usdCeiling:3,grantToStartMs:86400000,activeMs:3600000,starts:1});
export const STAGES=Object.freeze({improve:{maxRequests:8,maxTokens:1200000,maxRequestTokens:1056768,maxOutputTokens:8192}});
export const PRIOR=Object.freeze({requests:34,knownTokens:61560,reservedTokens:1056768,unknown:1});
export const OLD_CANDIDATE='9aed1af6ee3b156bb7354961496217aa5e64843e';
const PRIOR_MANIFEST='07ed36fdeb17f24d7e8d6caea0db4efd41dd31111fa7ef6ea4cb0a51daa0251e';
const PRIOR_LEDGER='07e58fa36dc54441da52658e2eed29a0ad35eff233b8b2817bc28b2fe1e3b997';
const WINDOW={grantToStartMs:86400000,activeMs:3600000,starts:1,definition:'One fresh improve-only start within 24 hours of the new grant; immutable deadline start+60 minutes. No resume or replacement after interruption, unknown usage or expiry.'};
const exact=entry=>assert.deepEqual(file(entry.path),entry,`FROZEN_CONTENT_CHANGED:${entry.path}`);

export function deriveProposal(original,output,artifact,observation,prior,candidateGate){
 const improve=structuredClone(original.improve);improve.dataRoot=join(output,'improve-data');improve.request.id=REQUEST;
 return {status:'PENDING_EXPLICIT_NEW_HUMAN_GRANT; not an executable paid plan',batchId:BATCH,artifact,improve,
  model:structuredClone(original.evalPlan.model),price:structuredClone(original.evalPlan.price),
  aggregate:{newRequests:8,newTokens:1200000,prior:PRIOR,cumulativeRequests:42,cumulativeChargedTokens:2318328,conservativeUsdUpper:2.7819936,usdCeiling:3},window:WINDOW,
  credential:{source:CREDENTIAL_SOURCE,readiness:'PENDING_NEW_EXPLICIT_ONE_START; no credential read during preparation'},providerRecheck:observation,prior,candidateGate,
  stops:['Any authentication, cancellation, failed/incomplete report, new unknown usage, deadline or budget violation stops; no automatic retry or restart.','Zero candidates remain zero; no fabricated or silently substituted candidate.'],
  futureSelection:'Only a later explicit human choice of an actual report/revision/candidate may authorize candidate execution or writeback; the paid grant selects nothing.',
  eval:'No paid eval in this batch. Prior four different case PASS records retain their original product/run identities; affected applicability review is separate.',
  finding:'LIVE-USD3-R3-01',preservation:'Original r2 STOPPED, multi-file error/unknown and r3 STOPPED_NO_EXECUTABLE_CHAIN/UNKNOWN reservation remain immutable; raw 952 does not replace prior host accounting.'};
}

export function verifyPrior(freeze){
 const p=freeze.prior;
 for(const entry of [p.manifest,p.proposal,p.paidStart,p.batchResult,p.evalResult,p.improveResult,p.cumulativeBudget,p.postrunReport,p.protectedIndex,p.firstBatchResult,p.firstEvalResult,p.codeBindings])exact(entry);
 assert.equal(p.manifest.sha256,PRIOR_MANIFEST,'PRIOR_MANIFEST_CHANGED');assert.equal(p.cumulativeBudget.sha256,PRIOR_LEDGER,'PRIOR_LEDGER_CHANGED');
 const old=json(p.manifest.path),original=json(p.proposal.path),ended=json(p.batchResult.path),budget=json(p.cumulativeBudget.path),evaluation=json(p.evalResult.path),analysis=json(p.improveResult.path),first=json(p.firstEvalResult.path);
 assert.deepEqual(old.proposal,p.proposal,'PRIOR_PROPOSAL_NOT_BOUND');assert.equal(json(p.paidStart.path).manifest.sha256,PRIOR_MANIFEST,'PRIOR_START_NOT_BOUND');
 assert.equal(ended.status,'STOPPED_NO_EXECUTABLE_CHAIN');assert.equal(ended.candidates,0);assert.equal(ended.reason,'TASK_UNANSWERED');
 assert.equal(analysis.improve.reason,'BUDGET_UNKNOWN_USAGE');assert.equal(analysis.improve.candidates.length,0);assert.equal(analysis.improve.selected.length,0);
 assert.deepEqual({requests:budget.knownRequests,knownTokens:budget.knownTokens,reservedTokens:budget.reservedTokens,unknown:budget.stages.reduce((n,s)=>n+s.unknown,0)},PRIOR,'EXACT_PRIOR_WITH_UNKNOWN_REQUIRED');
 assert.equal(budget.chargedUpperTokens,1118328);assert.equal(budget.boundExceeded,false);assert.equal(budget.requestCompleteness,'known');
 assert.equal(evaluation.trials.length,3);assert.deepEqual(evaluation.trials.map(t=>t.id),['v1-live-r2-multi-file','v1-live-r2-regression','v1-live-r2-no-change']);
 const passes=[first.trials.find(t=>t.id==='v1-live-r1-local-fix'),...evaluation.trials];
 for(const t of passes)assert.ok(t?.outcome.status==='completed'&&t.outcome.started&&t.outcome.valid&&t.grade?.judgment==='PASS'&&t.grade.outcome===t.outcome.source,'PRIOR_PASS_IDENTITY_REQUIRED');
 const failed=first.trials.find(t=>t.id==='v1-live-r1-multi-file');assert.equal(failed.outcome.status,'error');assert.equal(failed.grade.judgment,'unknown');assert.equal(json(p.firstBatchResult.path).status,'STOPPED');
 // Only immutable closed-batch evidence is rechecked. Live worktree source files
 // in the diagnosis's observation index are historical snapshots, not freeze inputs.
 const protectedInputs=json(p.protectedIndex.path);
 assert.ok(protectedInputs.entries.length>0,'PRIOR_PROTECTED_INPUTS_REQUIRED');
 for(const row of protectedInputs.entries){assert.ok(p.protectedRoots.some(root=>row.path.startsWith(root+'/')),'PRIOR_INDEX_OUTSIDE_CLOSED_EVIDENCE');assert.notEqual(row.path,CREDENTIAL_SOURCE,'CREDENTIAL_NOT_EVIDENCE');exact(row);}
 const bindings=json(p.codeBindings.path);assert.equal(bindings.previousCandidate,OLD_CANDIDATE);assert.equal(bindings.immutableBindings.length,9);assert.equal(bindings.sourceSnapshots.length,3);for(const entry of bindings.immutableBindings)exact(entry);for(const row of bindings.sourceSnapshots){assert.equal(row.gitCandidate,OLD_CANDIDATE);exact(row.retained);}
 return {old,original,ended,passes};
}

export function verifyCandidateGate(freeze,artifact,passes){
 exact(freeze.candidateGate);const gate=json(freeze.candidateGate.path);
 assert.equal(gate.status,'PASS','CANDIDATE_GATE_NOT_PASS');assert.equal(gate.finding,'LIVE-USD3-R3-01');assert.equal(gate.candidate,artifact.integratedSource,'CANDIDATE_GATE_BINDING_REQUIRED');assert.notEqual(gate.candidate,OLD_CANDIDATE,'REPAIRED_CANDIDATE_REQUIRED');
 assert.equal(gate.previousCandidate,OLD_CANDIDATE);assert.equal(gate.repairReview.status,'PASS');assert.equal(gate.applicability.status,'PASS');
 assert.deepEqual(gate.applicability.codingPasses,passes.map(t=>({trialId:t.id,outcome:t.outcome.source,grade:t.grade.source,candidate:OLD_CANDIDATE})),'PRIOR_PASS_EXECUTION_IDENTITIES_CHANGED');
 assert.equal(gate.applicability.nativeDisposition,'RETAIN_ORIGINAL_EXECUTION_IDENTITY_WITH_BOUNDED_APPLICABILITY','NATIVE_APPLICABILITY_REQUIRED');
 assert.ok(gate.repairReview.evidence.length&&gate.applicability.evidence.length,'INDEPENDENT_GATE_EVIDENCE_REQUIRED');
 for(const entry of [...gate.repairReview.evidence,...gate.applicability.evidence])exact(entry);
 return gate;
}

export function preflight(freezeArg,grantArg){
 assert.ok(freezeArg&&grantArg,'EXPLICIT_NEW_PAID_GRANT_REQUIRED');
 const freezePath=resolve(freezeArg),grantPath=resolve(grantArg);
 assert.ok(existsSync(grantPath),'EXPLICIT_NEW_PAID_GRANT_REQUIRED');
 const freeze=json(freezePath),grant=json(grantPath);
 assert.equal(grant.paidApproved,true,'EXPLICIT_NEW_PAID_GRANT_REQUIRED');assert.equal(freeze.status,'FROZEN_IMPROVE_REPAIR_PENDING_NEW_EXPLICIT_ONE_START','REPAIRED_CANDIDATE_NOT_FROZEN');
 assert.equal(grant.manifestSha256,sha(readFileSync(freezePath)),'GRANT_MANIFEST_MISMATCH');
 assert.equal(grant.batchId,BATCH,'GRANT_BATCH_MISMATCH');assert.equal(freeze.batchId,BATCH,'MANIFEST_BATCH_MISMATCH');
 assert.deepEqual(grant.limits,LIMITS,'EXACT_REPAIR_LIMITS_REQUIRED');assert.deepEqual(freeze.limits,LIMITS,'MANIFEST_LIMITS_CHANGED');assert.deepEqual(freeze.stages,STAGES,'MANIFEST_STAGES_CHANGED');
 assert.equal(grant.credentialSource,CREDENTIAL_SOURCE,'PERMITTED_CREDENTIAL_SOURCE_REQUIRED');assert.equal(freeze.output,dirname(freezePath),'OUTPUT_MUST_BE_MANIFEST_DIRECTORY');
 for(const name of ['paid-start.json','authorized-plan.json'])assert.equal(existsSync(join(freeze.output,name)),false,'BATCH_ALREADY_STARTED');
 const here=dirname(fileURLToPath(import.meta.url));
 for(const name of ['run.mjs','common.mjs','preflight.mjs','ledger.mjs','launch.py'])assert.ok(freeze.harness.some(e=>e.path===join(here,name)),`HARNESS_NOT_FROZEN:${name}`);
 for(const entry of [freeze.proposal,freeze.artifact,...freeze.harness,freeze.providerObservation,...freeze.supportingEvidence,...freeze.initialDataRoots])exact(entry);
 const {old,original,ended,passes}=verifyPrior(freeze);
 const proposal=json(freeze.proposal.path),artifact=json(freeze.artifact.path);
 assert.deepEqual(freeze.fixture,old.fixture,'FIXTURE_CHANGED');verifyCandidateGate(freeze,artifact,passes);
 verifyInstallation(proposal.improve.dataRoot,freeze.initialSeedTree);
 assert.ok(grant.authorizationSource,'NEW_AUTHORIZATION_SOURCE_REQUIRED');exact(grant.authorizationSource);
 const oldGrant=json(freeze.prior.paidStart.path).grant;assert.notEqual(grant.authorizationSource.path,oldGrant.path,'OLD_AUTHORIZATION_NOT_REUSABLE');const oldAuthorization=json(oldGrant.path).authorizationSource;assert.notEqual(grant.authorizationSource.path,oldAuthorization.path,'OLD_AUTHORIZATION_NOT_REUSABLE');
 const authorization=json(grant.authorizationSource.path);
 assert.equal(authorization.author,'human-user','HUMAN_USER_AUTHORIZATION_REQUIRED');
 assert.equal(authorization.source?.kind,'codex-user-reply','DIRECT_USER_REPLY_SOURCE_REQUIRED');
 assert.ok(typeof authorization.source.requestToolCallId==='string'&&authorization.source.requestToolCallId.trim(),'AUTHORIZATION_REQUEST_TOOL_CALL_REQUIRED');
 assert.equal(authorization.kind,'improve-repair-one-start','NEW_AUTHORIZATION_KIND_REQUIRED');assert.equal(authorization.manifestSha256,grant.manifestSha256,'NEW_AUTHORIZATION_MANIFEST_REQUIRED');assert.equal(authorization.batchId,BATCH,'NEW_AUTHORIZATION_BATCH_REQUIRED');assert.deepEqual(authorization.limits,LIMITS,'NEW_AUTHORIZATION_LIMITS_REQUIRED');
 assert.equal(authorization.priorManifestSha256,PRIOR_MANIFEST,'PRIOR_AUTHORIZATION_LINK_REQUIRED');assert.equal(authorization.priorBudgetSha256,PRIOR_LEDGER,'PRIOR_UNKNOWN_LEDGER_LINK_REQUIRED');
 assert.ok(typeof authorization.exactHumanReply==='string'&&authorization.exactHumanReply.trim(),'EXACT_HUMAN_AUTHORIZATION_REQUIRED');assert.equal(grant.humanAuthorization,authorization.exactHumanReply,'EXACT_HUMAN_AUTHORIZATION_REQUIRED');assert.equal(grant.grantedAt,authorization.receivedAt,'NEW_GRANT_TIME_MUST_MATCH_SOURCE');
 const now=Date.now(),at=Date.parse(grant.grantedAt);assert.ok(Number.isFinite(at)&&at>Date.parse(ended.at)&&at<=now&&now-at<=LIMITS.grantToStartMs,'NEW_GRANT_EXPIRED_OR_INVALID');
 assert.deepEqual(proposal,deriveProposal(original,freeze.output,freeze.artifact,freeze.providerObservation,freeze.prior,freeze.candidateGate),'PROPOSAL_NOT_EXACT_IMPROVE_REPAIR');
 const i=proposal.improve.request;assert.equal(i.id,REQUEST);assert.deepEqual(i.limits,{...STAGES.improve,maxDurationMs:300000});
 assert.ok(i.limits.maxTokens>=i.limits.maxRequestTokens,'STAGE_CANNOT_RESERVE_ONE_REQUEST');
 assert.equal(PRIOR.requests+LIMITS.maxRequests,LIMITS.cumulativeMaxRequests);assert.equal(PRIOR.knownTokens+PRIOR.reservedTokens+LIMITS.maxTokens,LIMITS.cumulativeMaxTokens);
 assert.deepEqual(proposal.model,{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'});assert.equal(proposal.price.currency,'USD');assert.equal(proposal.price.perMillionTokens,1.2);assert.equal(proposal.price.source,'https://api-docs.deepseek.com/quick_start/pricing/');
 const observation=json(freeze.providerObservation.path);assert.equal(observation.maximumListedUsdPerMillionAnyClass,1.2,'TARIFF_CHANGED');assert.equal(observation.contextTokens,1048576,'CONTEXT_BOUND_CHANGED');
 assert.equal(LIMITS.cumulativeMaxTokens*12/10000000,proposal.aggregate.conservativeUsdUpper);assert.ok(proposal.aggregate.conservativeUsdUpper<=LIMITS.usdCeiling,'USD_CEILING_EXCEEDED');
 return {freezePath,grantPath,freeze,grant,proposal,artifact};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{preflight(...process.argv.slice(2));console.log('PREFLIGHT_PASS_NO_CREDENTIAL_ACCESS');}
 catch(error){console.error(`PREFLIGHT_DENIED: ${error.message}`);process.exitCode=1;}
}
