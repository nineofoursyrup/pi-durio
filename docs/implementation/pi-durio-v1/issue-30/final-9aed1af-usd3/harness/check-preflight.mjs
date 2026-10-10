#!/usr/bin/env node
// Small subprocess fixtures: actual entrypoint and gate; only installed API is synthetic.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {file,json,save} from './common.mjs';
const here=dirname(fileURLToPath(import.meta.url)),batch=dirname(here),evidence=resolve(process.argv[2]??join(batch,'offline-checks'));
mkdirSync(evidence,{recursive:false});
const original=json(join(batch,'frozen-manifest.json')),originalProposal=json(original.proposal.path),template=json(join(batch,'grant-template-NOT-EXECUTABLE.json'));
const rows=[];
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
function fixture(name){
 const root=mkdtempSync(join(evidence,`${name}-`)),harness=join(root,'harness');mkdirSync(harness);
 for(const name of ['run.mjs','common.mjs','preflight.mjs','launch.py'])copyFileSync(join(here,name),join(harness,name));
 const events=join(root,'events.jsonl'),emit=`const emit=value=>appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');`;
 const proposal=structuredClone(originalProposal);proposal.evalDataRoot=join(root,'eval-data');proposal.evalDirectory=join(root,'live-eval');proposal.improve.dataRoot=join(root,'improve-data');
 const proposalPath=join(root,'proposal.json');write(proposalPath,proposal);
 const sourceCommon=JSON.stringify(join(here,'common.mjs'));
 writeFileSync(join(harness,'common.mjs'),`import {appendFileSync,readFileSync} from 'node:fs';
export {json,save,file,sha,authenticationStop} from ${sourceCommon};
${emit}
const proposal=JSON.parse(readFileSync(${JSON.stringify(proposalPath)},'utf8'));
export const verifyInstallation=()=>emit({kind:'verify-installation'});
export const installed=async()=>{
 emit({kind:'installed'});
 return {
  validation:{describeImproveRuntime:()=>${JSON.stringify(json(original.artifact.path).linuxRuntimeIdentity)}},
  improve:{validateImproveRequest:()=>emit({kind:'validate-improve'})},
  eval:{prepareEval:async options=>{emit({kind:'prepare',budget:options.budget});return {plan:{...proposal.evalPlan,budget:options.budget,authorization:{...proposal.evalPlan.authorization,paid:options.paid}}};},runEval:async()=>{emit({kind:'offline-eval'});return {counts:{passed:0},trials:[]};}},
  query:{readRunRecords:()=>({records:[],more:false})},runtime:{readObject:()=>{throw Error('unexpected object read');}}
 };
};
`);
 const probe=join(root,'probe.mjs');writeFileSync(probe,`import {appendFileSync} from 'node:fs';${emit}
const env=process.env;process.env=new Proxy(env,{get(target,key){if(key==='DEEPSEEK_API_KEY')emit({kind:'credential-lookup'});return target[key];}});
globalThis.fetch=()=>{emit({kind:'network-attempt'});throw Error('offline network forbidden');};
if(env.TEST_NOW)Date.now=()=>Number(env.TEST_NOW);
`);
 const manifest={...structuredClone(original),output:root,proposal:file(proposalPath),harness:['run.mjs','common.mjs','preflight.mjs','launch.py'].map(n=>file(join(harness,n)))};
 const manifestPath=join(root,'frozen-manifest.json'),grantPath=join(root,'explicit-human-grant.json');
 const grant={...structuredClone(template),paidApproved:true};delete grant.note;
 function refresh(){write(proposalPath,proposal);manifest.proposal=file(proposalPath);write(manifestPath,manifest);grant.manifestSha256=file(manifestPath).sha256;write(grantPath,grant);}
 refresh();
 return {root,harness,probe,events,proposal,manifest,grant,manifestPath,grantPath,refresh};
}
function invoke(f,extra={}){
 const child=spawnSync(process.execPath,['--import',f.probe,join(f.harness,'run.mjs'),f.manifestPath,f.grantPath],{encoding:'utf8',env:{PATH:process.env.PATH,DEEPSEEK_API_KEY:'offline-fixture-not-a-real-key',...extra},timeout:15000});
 assert.equal(child.error,undefined);assert.equal(child.signal,null);
 return {...child,events:existsSync(f.events)?readFileSync(f.events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
function denied(name,mutate,expected,extra){
 const f=fixture(name);mutate(f);f.refresh();
 const r=invoke(f,extra);assert.equal(r.status,1,r.stderr);assert.match(r.stderr,expected);assert.deepEqual(r.events,[],'denial must precede installed API, credential lookup, or provider access');
 assert.equal(existsSync(join(f.root,'paid-start.json')),name==='repeat-start');
 save(join(f.root,'result.json'),{status:'PASS',scope:'offline denial; actual runner/preflight; installed API replaced',exit:r.status,events:r.events,stderr:r.stderr});rows.push({name,status:'PASS',evidence:join(f.root,'result.json')});return f;
}
denied('grant-false',f=>{f.grant.paidApproved=false;},/EXPLICIT_PAID_GRANT_REQUIRED/);
denied('old-usd5-grant',f=>{f.grant.limits={...f.grant.limits,maxTokens:4000000,usdCeiling:5};},/EXACT_REVIEWED_LIMITS_REQUIRED/);
denied('eval-stage-expanded',f=>{f.proposal.evalPlan.budget.maxTokens=2000000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('improve-stage-expanded',f=>{f.proposal.improve.request.limits.maxTokens=2000000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('stage-redistributed',f=>{f.proposal.evalPlan.budget.maxTokens=1300000;f.proposal.improve.request.limits.maxTokens=1100000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('aggregate-expanded',f=>{f.proposal.aggregate.maxTokens=4000000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('request-expanded',f=>{f.proposal.evalPlan.budget.maxRequests=33;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('window-active-expanded',f=>{f.proposal.window.activeMs=7200000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('window-start-expanded',f=>{f.proposal.window.grantToStartMs=172800000;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('extra-starts',f=>{f.proposal.window.starts=2;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('price-lowered',f=>{f.proposal.evalPlan.price.perMillionTokens=0.6;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('price-increased',f=>{f.proposal.evalPlan.price.perMillionTokens=1.3;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('reservation-lowered',f=>{f.proposal.evalPlan.budget.maxRequestTokens=4096;},/PROPOSAL_NOT_EXACT_USD3_DERIVATIVE/);
denied('credential-path-changed',f=>{f.grant.credentialSource='/tmp/another.env';},/PERMITTED_CREDENTIAL_SOURCE_REQUIRED/);
denied('authorization-source-removed',f=>{delete f.grant.authorizationSource;},/AUTHORIZATION_SOURCE_REQUIRED/);
denied('grant-time-renewed',f=>{f.grant.grantedAt=new Date().toISOString();},/ORIGINAL_GRANT_TIME_REQUIRED/);
denied('repeat-start',f=>{write(join(f.root,'paid-start.json'),{prior:'offline fixture only'});},/BATCH_ALREADY_STARTED/);
denied('existing-authorized-plan',f=>{write(join(f.root,'authorized-plan.json'),{prior:'offline fixture only'});},/BATCH_ALREADY_STARTED/);
denied('grant-expired',()=>{},/GRANT_EXPIRED_OR_INVALID/,{TEST_NOW:String(Date.parse(template.grantedAt)+86400001)});
denied('grant-in-future',()=>{},/GRANT_EXPIRED_OR_INVALID/,{TEST_NOW:String(Date.parse(template.grantedAt)-1)});
{
 const f=fixture('valid-materialization'),r=invoke(f);assert.equal(r.status,1,r.stderr);
 assert.deepEqual(r.events.map(e=>e.kind),['verify-installation','installed','validate-improve','credential-lookup','prepare','offline-eval']);
 const plan=json(join(f.root,'authorized-plan.json')).plan;assert.equal(plan.budget.maxTokens,1200000);assert.equal(plan.budget.maxRequestTokens,1052672);assert.equal(plan.authorization.paid,true);
 const paid=json(join(f.root,'paid-start.json'));assert.equal(Date.parse(paid.deadline)-Date.parse(paid.startedAt),3600000);
 assert.equal(json(join(f.root,'batch-result.json')).improve,'not-run');
 const firstEvents=r.events.length,r2=invoke(f);assert.equal(r2.status,1);assert.match(r2.stderr,/BATCH_ALREADY_STARTED/);assert.equal(r2.events.length,firstEvents,'repeat must not touch credentials or product again');
 save(join(f.root,'result.json'),{status:'PASS',scope:'synthetic installed API; no provider/VM',events:r.events,repeatDenied:true});rows.push({name:'valid-materialization-and-repeat',status:'PASS',evidence:join(f.root,'result.json')});
}
for(const scenario of ['missing','false','positive']){
 const f=fixture(`wrapper-${scenario}`),marker=join(f.root,'credential-reader-called');
 if(scenario==='false'){f.grant.paidApproved=false;f.refresh();}
 if(scenario==='missing'){f.grantPath=join(f.root,'nonexistent-grant.json');}
 const bootstrap=`import importlib.util,pathlib,sys\ns=importlib.util.spec_from_file_location('launch',${JSON.stringify(join(f.harness,'launch.py'))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.ROOT=pathlib.Path(${JSON.stringify(f.root)});m.MANIFEST=pathlib.Path(${JSON.stringify(f.manifestPath)});m.GRANT=pathlib.Path(${JSON.stringify(f.grantPath)})\nm.CREDENTIAL_PATH=${JSON.stringify(join(f.root,'missing-credential.env'))}\n`+(scenario==='positive'?`pathlib.Path(m.CREDENTIAL_PATH).write_text('DEEPSEEK_API_KEY=offline-fixture-not-a-real-key\\n');pathlib.Path(m.CREDENTIAL_PATH).chmod(0o600)\n`:`def prohibited():\n pathlib.Path(${JSON.stringify(marker)}).write_text('accessed');raise RuntimeError('credential access forbidden')\nm.load_key=prohibited\n`)+`sys.argv=['launch.py'];sys.exit(m.main())\n`;
 const r=spawnSync('/usr/bin/python3',['-c',bootstrap],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:15000});
 assert.equal(r.error,undefined);assert.equal(r.status,1,r.stderr);assert.equal(existsSync(marker),false);assert.equal((r.stdout+r.stderr).includes('offline-fixture-not-a-real-key'),false);
 if(scenario==='positive')assert.equal(json(join(f.root,'authorized-plan.json')).plan.budget.maxTokens,1200000);
 else {assert.match(r.stderr,/EXPLICIT_PAID_GRANT_REQUIRED/);assert.equal(existsSync(f.events),false);assert.equal(existsSync(join(f.root,'paid-start.json')),false);}
 save(join(f.root,'result.json'),{status:'PASS',scenario,credentialReadBeforeGate:false,actualCredentialFileUsed:false,stdout:r.stdout,stderr:r.stderr});rows.push({name:`wrapper-${scenario}`,status:'PASS',evidence:join(f.root,'result.json')});
}
const summary={status:'PASS',cases:rows.length,rows,scope:'Offline subprocess gate and wrapper tests only; original run body and common authenticationStop preserved; installed API synthetic; no real key/provider/VM; positive uses literal fixture key',scripts:readdirSync(here).filter(n=>/\.(mjs|py)$/.test(n)).map(n=>file(join(here,n)))};
save(join(evidence,'summary.json'),summary);console.log(JSON.stringify({status:summary.status,cases:summary.cases,evidence}));
