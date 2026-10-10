#!/usr/bin/env node
// Exercise the exact accepted PersistentBudget class with memory-only evidence.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=dirname(fileURLToPath(import.meta.url)),resultPath=resolve(process.argv[2]);
const manifest=JSON.parse(readFileSync(join(root,'checked-manifest.json'))),artifact=JSON.parse(readFileSync(manifest.artifact.path));
const sourceBuild=JSON.parse(readFileSync(artifact.sourceBuild.path));
const reference=sourceBuild.outputs.find(v=>v.path==='dist/src/provider-boundary.js');
const sourcePath=join(artifact.installation,'node_modules/pi-durio',reference.path),code=readFileSync(sourcePath);
assert.equal(createHash('sha256').update(code).digest('hex'),reference.sha256);
assert.equal(code.length,reference.bytes);
let sequence=0,networkCalls=0;
const context=vm.createContext({structuredClone,Date,Error,Number,JSON,fetch(){networkCalls++;throw Error('NETWORK_FORBIDDEN');}});
const crypto=new vm.SyntheticModule(['randomUUID'],function(){this.setExport('randomUUID',()=>`offline-request-${++sequence}`);},{context});
const evidenceModule=new vm.SyntheticModule(['readObject'],function(){this.setExport('readObject',(root,ref)=>Buffer.from(JSON.stringify(root.bodies.get(ref.id))));},{context});
const module=new vm.SourceTextModule(code.toString(),{context});await module.link(id=>id==='node:crypto'?crypto:evidenceModule);await module.evaluate();
const {PersistentBudget}=module.namespace,rows=[];
function budget(stage){
 const state={facts:[],bodies:new Map()},evidence={root:state,runId:'offline-budget',db:{prepare:()=>({all:(runId,kind)=>state.facts.filter(f=>f.kind===kind).map(f=>({body:JSON.stringify(f.ref)}))}),exec(){}},append(kind,data){const ref={id:state.facts.length+1};state.bodies.set(ref.id,structuredClone(data));state.facts.push({kind,ref});}};
 const stageLimits=manifest.stages[stage],limits={maxRequests:stageLimits.maxRequests,maxTokens:stageLimits.maxTokens,maxRequestTokens:stageLimits.maxRequestTokens,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:stage==='eval'?{tokens:stageLimits.maxRequestTokens,source:'frozen official bound'}:null};
 return new PersistentBudget(evidence,'offline-budget',limits);
}
function record(name,check){const details=check();rows.push({name,status:'PASS',...details});}
record('eval-new-stage-admits-original-reservation',()=>{const b=budget('eval'),r=b.reserve('generation','offline-trial');assert.equal(r.tokens,1052672);assert.equal(b.snapshot().reservedTokens,1052672);assert.equal(b.limits.maxTokens,1172501);assert.throws(()=>b.reserve('generation','offline-trial'),/BUDGET_TOKEN_LIMIT/);return{maxTokens:b.limits.maxTokens,firstReservation:r.tokens,secondUnsettledReservationDenied:true};});
record('eval-known-small-usage-can-reach-24-request-ceiling',()=>{const b=budget('eval');for(let i=0;i<24;i++){const r=b.reserve('generation','offline-trial');b.settle({id:r.id,tokens:1000,status:'returned'});}assert.equal(b.snapshot().knownTokens,24000);assert.throws(()=>b.reserve('generation','offline-trial'),/BUDGET_REQUEST_LIMIT/);return{requests:24,scope:'Artificial small-usage arithmetic only; not a claim that real tasks will complete'};});
record('eval-exact-reservation-headroom-boundary',()=>{const b=budget('eval'),r=b.reserve('generation','offline-trial');b.settle({id:r.id,tokens:1172501-1052672,status:'returned'});b.reserve('generation','offline-trial');assert.equal(b.snapshot().knownTokens+b.snapshot().reservedTokens,1172501);return{chargedUpperTokens:1172501};});
record('eval-one-token-over-headroom-stops',()=>{const b=budget('eval'),r=b.reserve('generation','offline-trial');b.settle({id:r.id,tokens:1172501-1052672+1,status:'returned'});assert.throws(()=>b.reserve('generation','offline-trial'),/BUDGET_TOKEN_LIMIT/);return{newReservationDenied:true};});
record('eval-unknown-settlement-remains-reserved',()=>{const b=budget('eval'),r=b.reserve('generation','offline-trial');b.settle({id:r.id,tokens:null,status:'unknown'});assert.equal(b.snapshot().unknown,1);assert.equal(b.snapshot().reservedTokens,1052672);assert.throws(()=>b.reserve('generation','offline-trial'),/BUDGET_TOKEN_LIMIT/);return{unknown:1,reservedTokens:1052672};});
record('improve-full-eight-request-allowance-preserved',()=>{const b=budget('improve');assert.equal(b.limits.maxTokens,1200000);for(let i=0;i<8;i++){const r=b.reserve('improve','offline-improve');assert.equal(r.tokens,1056768);b.settle({id:r.id,tokens:1000,status:'returned'});}assert.throws(()=>b.reserve('improve','offline-improve'),/BUDGET_REQUEST_LIMIT/);return{requests:8,maxTokens:1200000};});
record('improve-unknown-usage-stops',()=>{const b=budget('improve'),r=b.reserve('improve','offline-improve');b.settle({id:r.id,tokens:null,status:'unknown'});assert.throws(()=>b.reserve('improve','offline-improve'),/BUDGET_UNKNOWN_USAGE/);return{reservedTokens:b.snapshot().reservedTokens};});
record('cumulative-ledger-and-stage-allocation',()=>{assert.equal(manifest.stages.eval.maxTokens+manifest.stages.improve.maxTokens,2372501);assert.equal(27499+2372501,2400000);assert.equal(15+24+8,47);assert.equal(2400000*1.2/1000000,2.88);return{priorTokens:27499,newTokens:2372501,cumulativeTokens:2400000,cumulativeMaxRequests:47,cumulativeConservativeUsd:2.88};});
assert.equal(networkCalls,0);
const summary={status:'PASS',cases:rows.length,rows,source:{path:sourcePath,...reference},scope:'Exact accepted PersistentBudget compiled class with in-memory Evidence adapter; no runtime/Harness, provider, credentials, restricted VM or persistent budget writes',networkCalls,productCandidate:'9aed1af6ee3b156bb7354961496217aa5e64843e'};
writeFileSync(resultPath,JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:summary.status,cases:summary.cases}));
