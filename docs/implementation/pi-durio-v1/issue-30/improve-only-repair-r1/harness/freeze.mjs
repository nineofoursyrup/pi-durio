#!/usr/bin/env node
// Freeze only after the coordinator provides actual repaired artifact and review gates.
// No product import, credential lookup, provider request or grant creation.
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {json,file,save} from './common.mjs';
import {BATCH,LIMITS,STAGES,OLD_CANDIDATE,deriveProposal,verifyPrior,verifyCandidateGate} from './preflight.mjs';
const output=dirname(dirname(fileURLToPath(import.meta.url)));
const [artifactArg,gateArg,observationArg]=process.argv.slice(2);
assert.ok(artifactArg&&gateArg,'ACTUAL_REPAIRED_ARTIFACT_AND_INDEPENDENT_GATES_REQUIRED');
for(const name of ['checked-manifest.json','frozen-manifest.json','explicit-human-grant.json','paid-start.json','authorized-plan.json'])assert.equal(existsSync(join(output,name)),false,'PREPARATION_OR_RUN_ALREADY_FROZEN');
const base=json(join(output,'preparation.json')),artifactEntry=file(resolve(artifactArg)),artifact=json(artifactEntry.path),gateEntry=file(resolve(gateArg));
assert.notEqual(artifact.producer,OLD_CANDIDATE);assert.match(artifact.producer,/^[a-f0-9]{40}$/);assert.notEqual(artifact.integratedSource,OLD_CANDIDATE);assert.match(artifact.integratedSource,/^[a-f0-9]{40}$/);
const identity=json(artifact.producerIdentity.path);assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);assert.equal(identity.candidate,artifact.integratedSource);assert.deepEqual(file(artifact.sourceBuild.path),artifact.sourceBuild);
const observation=observationArg?file(resolve(observationArg)):base.providerObservation;
const manifest={version:4,batchId:BATCH,status:'FROZEN_IMPROVE_REPAIR_PENDING_NEW_EXPLICIT_ONE_START',artifact:artifactEntry,candidateGate:gateEntry,output,harness:readdirSync(join(output,'harness')).sort().filter(n=>n.endsWith('.mjs')||n.endsWith('.py')).map(n=>file(join(output,'harness',n))),fixture:base.fixture,providerObservation:observation,limits:LIMITS,stages:STAGES,prior:base.prior,initialDataRoots:base.initialDataRoots,initialSeedTree:base.initialSeedTree,supportingEvidence:[...base.supportingEvidence,...['check-r5.json','wrapper-check-r3.json','check-repair.mjs','check-wrapper.py','artifact-binding-precheck.json','check-r1.json','check-r2.json','check-r1-source.mjs','check-r2-source.mjs','check-r2-preflight-source.mjs'].map(name=>file(join(output,name)))],seedProvenance:base.seedProvenance,futureDecision:base.futureDecision,previousFinding:'LIVE-USD3-R3-01',execution:'One improve-only analysis after a fresh explicit grant; no eval or candidate action'};
const prior=verifyPrior(manifest);verifyCandidateGate(manifest,artifact,prior.passes);
const proposal=deriveProposal(prior.original,output,artifactEntry,observation,manifest.prior,gateEntry);
save(join(output,'proposed-batch-reviewed.json'),proposal);manifest.proposal=file(join(output,'proposed-batch-reviewed.json'));
save(join(output,'checked-manifest.json'),manifest);
// Final frozen bytes follow identity checks; independent review must assess them before any grant.
const draft=file(join(output,'checked-manifest.json'));
save(join(output,'grant-template-FROZEN-NOT-EXECUTABLE.json'),{...json(join(output,'grant-template-NOT-EXECUTABLE.json')),manifestSha256:draft.sha256});
save(join(output,'authorization-source-template-FROZEN-NOT-EXECUTABLE.json'),{...json(join(output,'authorization-source-template-NOT-EXECUTABLE.json')),manifestSha256:draft.sha256});
save(join(output,'candidate-binding-check.json'),{status:'PASS',candidate:artifact.integratedSource,producer:artifact.producer,artifact:artifactEntry,producerIdentity:artifact.producerIdentity,sourceBuild:artifact.sourceBuild,candidateGate:gateEntry,checkedManifest:draft,reviewedOldPasses:prior.passes.map(t=>t.id),scope:'Read-only metadata/content identity binding; no product execution, credential, provider or VM. Harness independent review still required.'});
console.log(JSON.stringify({status:'CHECKED_DRAFT_BOUND_NOT_STARTED',checkedManifest:draft,candidate:artifact.integratedSource,producer:artifact.producer}));
