import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence,digest} from '../src/evidence.js';
import {fixEvidence} from '../src/fixed-evidence.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {verifiedImage,validatePlan,type EvalPlan} from '../src/eval/plan.js';
import {evalReport,formatEvalReport} from '../src/eval/runner.js';
import {appendFact,evalFacts} from '../src/eval/store.js';
import {PersistentBudget} from '../src/provider-boundary.js';
import {evalMediator} from '../src/eval/mediator.js';
import {EvalView} from '../src/tui/eval.js';
function plan(e:Evidence):EvalPlan{return{id:'plan',purpose:'test fixed reporting',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'content-v1',manifest:e.blob('[]'),bytes:2},cases:representativeCases,trials:['good','failure','grader-error','not-run'].map(id=>({id,caseId:'local-fix',version:'content-v1',side:'candidate',repeat:1,pair:null})),budget:{maxRequests:8,maxTokens:1000,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null},trialTimeoutMs:1000,gradingTimeoutMs:1000,maxOutputTokens:32,requestRetryLimit:0,price:{version:'test',source:'controlled',currency:'USD',perMillionTokens:0},authorization:{scope:'run-all-listed-trials',paid:false},environment:{node:'v24.8.0',isolation:'fixture only',writable:'new',cache:'empty'},mainObjective:'requirements',protection:['originals'],improvementConclusion:'not-evaluated'};}

test('report preserves all planned identities, grader errors and first failure; missing actual evidence removes eligibility',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-eval-report-')),e=new Evidence(root,'plan');const p=plan(e),source=appendFact(e,'eval.plan',p),artifact=e.blob('original product');e.close();await fixEvidence(root,{id:'eval-plan:plan',sources:[source],purpose:'test fixed plan'});
 const facts=new Evidence(root,'plan');
 for(const [trialId,status,judgment]of [['good','completed','PASS'],['failure','error','FAIL'],['grader-error','completed','unknown']]){const outcome=appendFact(facts,'eval.outcome',{trialId,status,started:true,valid:true,artifacts:[{path:'project/a.ts',ref:artifact}],isolation:null,timing:{preparationMs:1,taskMs:2}});appendFact(facts,'eval.grade',{id:trialId,trialId,outcome,graderVersion:'v1',judgment,reason:judgment==='unknown'?'grader crashed':'fixed rule',checks:[],at:new Date().toISOString()});}
 facts.close();const report=evalReport(root,'plan');assert.deepEqual(report.counts,{planned:4,started:3,completed:2,gradable:2,passed:1,passRate:0.5,completionRate:0.5,coverageRate:0.5});assert.equal(report.trials[3].outcome.status,'not-run');assert.equal(report.trials[2].grade.judgment,'unknown');assert.match(formatEvalReport(report),/grader crashed/);
 const before=readFileSync(join(root,'host.sqlite'));const view=new EvalView(root,'plan');assert.ok(view.render(80,24).join('\n').includes('Eval'));view.handleInput('e');view.handleInput('\r');assert.match(view.render(80,24).join('\n'),/e1:/);view.handleInput('n');view.handleInput('p');view.handleInput('b');assert.deepEqual(readFileSync(join(root,'host.sqlite')),before);
 unlinkSync(join(root,'objects',artifact.sha256));const missing=evalReport(root,'plan');assert.equal(missing.counts.gradable,0);assert.equal(missing.trials[0].grade.judgment,'PASS');assert.equal(missing.trials[0].outcome.valid,false);assert.equal(missing.trials[1].gradeHistory[0].judgment,'FAIL');
});
test('mediator denies guest endpoint/model/structure changes before any provider dispatch and unknown usage blocks new trial requests',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-mediator-')),e=new Evidence(root,'plan'),p=plan(e);const budget=new PersistentBudget(e,'plan',p.budget);let calls=0;
 const transport:typeof fetch=async()=>{calls++;return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n');};const mediator=evalMediator(p,p.trials[0],budget,transport),signal=new AbortController().signal;
 const payload={model:'deepseek-flash',stream:true,max_tokens:32,messages:[{role:'user',content:'hello'}]};
 for(const bad of [{...payload,url:'http://localhost'},{...payload,model:'other'},{...payload,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://localhost'}}]}]}])await assert.rejects(mediator.request({input:JSON.stringify(bad),maxOutputTokens:32,signal}),/DENIED/);
 assert.equal(calls,0);await mediator.request({input:JSON.stringify(payload),maxOutputTokens:32,signal});await assert.rejects(mediator.request({input:JSON.stringify(payload),maxOutputTokens:32,signal}),/BUDGET_UNKNOWN_USAGE/);assert.equal(calls,1);e.close();
});
test('paid plan needs a fixed provider upper bound before dispatch, not only an after-the-fact exceeded marker',()=>{
 const e=new Evidence(mkdtempSync(join(tmpdir(),'durio-live-plan-')),'plan'),p=plan(e);p.mode='live';p.authorization.paid=true;p.budget.unknownUpperBound={tokens:100,source:'https://api-docs.deepseek.com/quick_start/pricing/'};assert.throws(()=>validatePlan(p),/PROVEN_TOKEN_BOUND/);e.close();
});

 test('owner loss and oversized guest payload are rejected before dispatch; HTTP failure stays a service failure with missing cost',async()=>{
 const e=new Evidence(mkdtempSync(join(tmpdir(),'durio-mediator-')),'plan'),p=plan(e),budget=new PersistentBudget(e,'plan',p.budget);let held=false,calls=0;
 const mediator=evalMediator(p,p.trials[0],budget,async()=>{calls++;return new Response('{"error":"outage"}',{status:503});},()=>{if(!held)throw Error('OWNER_LOST');});
 const signal=new AbortController().signal,payload={model:'deepseek-flash',stream:true,max_tokens:32,messages:[{role:'user',content:'hello'}]};
 await assert.rejects(mediator.request({input:JSON.stringify(payload),maxOutputTokens:32,signal}),/OWNER_LOST/);held=true;
 await assert.rejects(mediator.request({input:'x'.repeat(262145),maxOutputTokens:32,signal}),/EVAL_MEDIATOR_LIMIT/);assert.equal(calls,0);
 await mediator.request({input:JSON.stringify(payload),maxOutputTokens:32,signal});assert.equal(mediator.lastError,'PROVIDER_HTTP_503');assert.equal(budget.snapshot().requests,1);assert.equal(budget.snapshot().unknown,1);e.close();
 });
