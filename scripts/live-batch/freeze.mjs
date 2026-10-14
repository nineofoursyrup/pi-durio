#!/usr/bin/env node
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installed,json,save,file} from './common.mjs';
const [proposalArg,outArg]=process.argv.slice(2);
if(!outArg)throw Error('Usage: freeze.mjs CORRECTED_PROPOSAL NEW_FROZEN_MANIFEST');
const proposalPath=resolve(proposalArg),p=json(proposalPath),artifact=json(p.artifact.path),api=await installed(artifact.installation);
api.improve.validateImproveRequest(p.improve.request,'live');
if(p.evalPlan.authorization.paid!==false||p.evalPlan.budget.deadline!==null)throw Error('PENDING_AUTHORIZATION_REQUIRED');
const scripts=dirname(fileURLToPath(import.meta.url)),docs=resolve(scripts,'../../docs/implementation/pi-durio-v1/issue-30');
const manifest={version:1,batchId:p.batchId,status:'FROZEN_PENDING_HUMAN_GRANT',proposal:file(proposalPath),artifact:file(p.artifact.path),output:dirname(proposalPath),harness:['common.mjs','run.mjs','prepare.mjs','check-auth-stop.mjs','check-installation.mjs','freeze.mjs'].map(n=>file(join(scripts,n))),fixture:json(join(docs,'improve-fixture.json')),caseSource:file(join(docs,'cases.json')),providerObservation:file(join(docs,'provider-observation.json')),futureDecision:'Actual improve candidate is not selected. Unknown future content cannot be selected by this grant.'};
save(resolve(outArg),manifest);console.log(JSON.stringify(file(resolve(outArg))));
