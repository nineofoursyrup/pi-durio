#!/usr/bin/env node
// Freeze the declared input delta only; no product import, credentials or actual grant.
import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {json,file,save} from './common.mjs';
import {BATCH,PURPOSE,LIMITS,STAGES,deriveProposal,verifyPrior,verifyCandidateGate} from './preflight.mjs';
const output=dirname(dirname(fileURLToPath(import.meta.url))),base=json(join(output,'preparation.json'));
for(const name of ['checked-manifest.json','frozen-manifest.json','explicit-human-grant.json','paid-start.json','authorized-plan.json'])assert.equal(existsSync(join(output,name)),false,'ALREADY_FROZEN_OR_STARTED');
assert.equal(readFileSync(base.purpose.path,'utf8'),PURPOSE+'\n');assert.deepEqual(file(base.purpose.path),base.purpose);
const artifact=json(base.artifact.path),identity=json(artifact.producerIdentity.path);
assert.equal(artifact.integratedSource,'f26ae8f4b8039608a1fa796e1c69da4d8173d112');assert.equal(identity.candidate,artifact.integratedSource);assert.deepEqual(file(artifact.producerIdentity.path),artifact.producerIdentity);assert.deepEqual(file(artifact.sourceBuild.path),artifact.sourceBuild);
const manifest={version:5,batchId:BATCH,status:'FROZEN_IMPROVE_OUTPUT_CONTRACT_PENDING_NEW_EXPLICIT_ONE_START',output,artifact:base.artifact,candidateGate:base.candidateGate,purpose:base.purpose,harness:readdirSync(join(output,'harness')).sort().filter(n=>n.endsWith('.mjs')||n.endsWith('.py')).map(n=>file(join(output,'harness',n))),fixture:base.fixture,providerObservation:base.providerObservation,limits:LIMITS,stages:STAGES,prior:base.prior,previousImprove:base.previousImprove,initialDataRoots:base.initialDataRoots,initialSeedTree:base.initialSeedTree,supportingEvidence:[...base.supportingEvidence,...['check-input-revision.mjs','input-check-r1.json','check-reuse.json','revision-delta.json'].map(n=>file(join(output,n)))],seedProvenance:base.seedProvenance,futureDecision:base.futureDecision,changes:base.changes,execution:'Exactly one future improve analysis after a fresh direct human grant; no eval or candidate action'};
const prior=verifyPrior(manifest);verifyCandidateGate(manifest,artifact,prior.passes);
const proposal=deriveProposal(prior.original,output,base.artifact,base.providerObservation,base.prior,base.candidateGate,base.previousImprove);
save(join(output,'proposed-batch-reviewed.json'),proposal);manifest.proposal=file(join(output,'proposed-batch-reviewed.json'));save(join(output,'checked-manifest.json'),manifest);
const checked=file(join(output,'checked-manifest.json'));
for(const name of ['grant','authorization-source'])save(join(output,name+'-template-FROZEN-NOT-EXECUTABLE.json'),{...json(join(output,name+'-template-NOT-EXECUTABLE.json')),manifestSha256:checked.sha256});
save(join(output,'candidate-binding-check.json'),{status:'PASS_SAME_FIXED_PRODUCT_NO_EXECUTION',candidate:artifact.integratedSource,producer:artifact.producer,artifact:base.artifact,sourceBuild:artifact.sourceBuild,candidateGate:base.candidateGate,purpose:base.purpose,checkedManifest:checked});
console.log(JSON.stringify({status:'CHECKED_DRAFT_BOUND_NOT_STARTED',checkedManifest:checked,candidate:artifact.integratedSource}));
