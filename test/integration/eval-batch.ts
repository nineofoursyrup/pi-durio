/** Explicit prepared-runtime integration gate. The fixture uses only the fixed
 * offline provider. It is not a native Terminal or model-quality acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence,readObject} from '../../src/evidence.js';
import {captureImproveSources,registerImproveSource} from '../../src/improve-source.js';
import type {ImproveCandidate,ImproveReport} from '../../src/improve.js';
import {deriveImproveDecision} from '../../src/improve-decisions.js';
import {ImproveBatchController} from '../../src/improve-batch.js';
import {improveFacts,readImproveDecision} from '../../src/improve-history.js';
import type {CandidateFreshCheck} from '../../src/improve-check-plan.js';
import {representativeCases} from '../../src/eval/fixtures.js';
import {prepareEval} from '../../src/eval/plan.js';
import {evalFacts} from '../../src/eval/store.js';
import {evalReport} from '../../src/eval/runner.js';
import {listPlanSources,readPlanReport,ownPlanSource,type PlanSource} from '../../src/eval/overview.js';
import {ReadOnlyTui,type TuiExit} from '../../src/tui/app.js';
import {acquireOwner} from '../../src/ownership.js';
import {probeWorkspaceOwner} from '../../src/workspace-ownership.js';
import {readAcceptedTasks,readQueue} from '../../src/runtime.js';
import {stripTerminalSequences,type Terminal} from '@earendil-works/pi-tui';

const installation=process.env.DURIO_EVAL82_RUNTIME;
if(!installation)throw Error('EVAL_RUNTIME_REQUIRED: use scripts/eval/verify-tui-batch.mjs PREPARED_RUNTIME NEW_EVIDENCE_DIR');
class BatchTerminal implements Terminal {
 columns=160;rows=50;kittyProtocolActive=false;restored=false;input:(text:string)=>void=()=>{};
 start(input:(text:string)=>void){this.input=input;}stop(){this.restored=true;}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
const plain=(lines:string[])=>lines.map(stripTerminalSequences).join('\n');
async function until(predicate:()=>boolean,message:()=>string,limit=60000){const end=Date.now()+limit;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error(message());}
function evidence(name:string,value:unknown){const body=JSON.stringify(value,null,2);console.log(`${name}: ${body}`);if(process.env.DURIO_EVAL82_EVIDENCE)writeFileSync(join(process.env.DURIO_EVAL82_EVIDENCE,`${name}.json`),body+'\n',{flag:'wx'});}
function freshFixture(paused=false,two=false){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'durio-eval82-'))),workspace=join(base,'project'),prompt=join(base,'prompt'),assets=join(base,'assets'),root=join(base,'data');for(const p of [workspace,prompt,assets])mkdirSync(p);
 writeFileSync(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');writeFileSync(join(prompt,'instructions.md'),'Inspect the evidence.\n');
 const fixture=structuredClone(representativeCases.find(c=>c.id===(paused?'regression':'local-fix'))!);
 if(paused)fixture.files['mean.ts']="import {writeFileSync} from 'node:fs';writeFileSync('/work/eval82-started','runtime VM entered');await new Promise(r=>setTimeout(r,30000));\n"+fixture.files['mean.ts'];
 writeFileSync(join(assets,'cases.json'),JSON.stringify({schema:1,id:'cases',version:'v1',kind:'cases',value:[fixture]}));registerImproveSource(root,workspace,{kind:'eval-asset',root:assets,paths:['cases.json']});
 const e=new Evidence(root,'analysis-fixture'),sources=captureImproveSources(e,workspace,[{id:'prompt',kind:'prompt-skill',root:prompt,paths:['instructions.md']},{id:'project',kind:'project',paths:['math.mjs']},{id:'cases',kind:'eval-asset',root:assets,paths:['cases.json']}],'fixture-version');
 assert.ok(sources.targets.every(t=>t.state==='verified'),JSON.stringify(sources.targets));
 const check:CandidateFreshCheck={kind:'fresh',benefit:'diagnostic',assets:[{targetId:'cases',path:'cases.json',caseIds:[fixture.id]}],mode:'offline',comparison:{kind:'deterministic',repetitions:1,repetitionBasis:'One fixed A/B pair verifies execution wiring only.',change:'One prompt instruction; same prepared runtime.',hypothesis:'Fixed provider is a no-difference oracle.',roles:{[fixture.id]:'objective'},objective:{metric:'requests',direction:'lower',delta:0.1,basis:'A ten-percent request reduction would be meaningful.'},protections:[{id:'task',kind:'hard',check:'task',cases:[fixture.id]},{id:'scope',kind:'hard',check:'scope',cases:[fixture.id]}],trialBudget:{maxRequests:6,maxTokens:6144}},budget:{maxRequests:12,maxTokens:12288,maxRequestTokens:1024,maxDurationMs:180000},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512};
 const candidate:ImproveCandidate={id:'candidate:prompt',display:'R1',revision:'candidate-r1',title:'检查 prompt 接线',problem:'需要独立的固定 oracle',objective:'bug',target:sources.targets[0],facts:[{claim:'固定原指令',evidence:[sources.targets[0].files[0].sourceId]}],hypotheses:['固定 provider 应无明显差异'],successCounterexamples:[],gaps:[],mechanismsReviewed:['instructions.md'],steps:['替换一行指令'],scope:['instructions.md'],validation:{method:'fresh',checks:['固定 A/B 配对'],budget:'每侧最多 6 请求',protections:['task','scope']},risks:['仅验证接线'],rollback:'保留 baseline',activation:{writeback:true,enable:false,conditions:['检查通过'],timing:'后续任务'},dependencies:[],conflicts:[],replacements:[{path:'instructions.md',content:'Inspect the fixed evidence carefully.\n'}],structuredChecks:[check],execution:'not-started',effect:'unverified',selection:'unselected',suggestionOnly:false};
 const candidates=[candidate];if(two)candidates.push({...structuredClone(candidate),id:'candidate:project',display:'R2',revision:'candidate-r2',title:'独立后组',target:sources.targets[1],replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],scope:['math.mjs'],structuredChecks:[{kind:'regression',program:'throw Error("later group must not run")',timeoutMs:30000}]});
 const report:ImproveReport={selectionContract:'declared-v1',id:'eval82-report',revision:'report-r1',kind:'improve',runId:e.runId,target:{workspace,sessionId:'session-fixture',taskId:'task-fixture',runId:'coding-fixture'},request:{id:'eval82-report',purpose:'固定 oracle',limits:{maxRequests:16,maxTokens:2162688,maxRequestTokens:1081344,maxDurationMs:600000,maxOutputTokens:32768}},state:'complete',startedAt:'2026-10-17T00:00:00Z',cutoff:0,deadline:'2026-10-17T00:10:00Z',summary:'合成来源，只验证接线',candidates,selected:[],gaps:[],evidence:[],targets:sources.targets,queryBounds:{maxRuns:1,maxRecords:40,maxEvidenceBytes:32768,maxSourceBytes:32768},budget:{requests:0,knownTokens:0,reservedTokens:0,unknown:0,violation:false} as ImproveReport['budget'],reason:null};
 e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();return{base,root,workspace,prompt,fixture,report};
}
async function assertReleased(root:string){const owner=await acquireOwner(root,()=>{});await owner.release();}
function assertVMs(source:PlanSource){const report=readPlanReport(source).report,executions=report.trials.flatMap(t=>[t.outcome.isolation,t.grade?.execution].filter(Boolean).map(ref=>JSON.parse(readObject(source.root,ref).toString())));assert.ok(executions.some(x=>x.started));assert.ok(executions.every(x=>x.terminated||x.started===false&&x.status==='not-started'),JSON.stringify(executions));return executions.map(x=>({id:x.id,started:x.started,terminated:x.terminated,reason:x.reason}));}

test('fresh declaration binds and prepares a real fixed A/B pair, with separate VM/session identities and parent snapshot',async()=>{
 const f=freshFixture(),decision=deriveImproveDecision(f.root,f.report.id,[{candidateId:f.report.candidates[0].id,mode:'validate-only'}],{id:'healthy-pair',directory:join(f.base,'healthy'),installation}),batch=new ImproveBatchController(f.root);
 const result=await batch.start(decision),source=listPlanSources(f.root).find(s=>s.origin?.decisionId===decision.id)!;assert.ok(source);const read=readPlanReport(source),report=read.report;
 assert.equal(read.from,'snapshot');assert.equal(source.root,join(f.base,'healthy/g1/check-0/eval-data'));assert.equal(report.counts.planned,2);assert.equal(report.counts.completed,2);assert.equal(report.counts.passed,2);assert.equal(report.improvement,'无明显差异');
 const executions=assertVMs(source);assert.equal(executions.filter(x=>x.started).length,4);assert.equal(new Set(executions.map(x=>x.id)).size,4);
 const guests=report.trials.map(t=>JSON.parse(readObject(source.root,t.outcome.runtimeResult).toString()));assert.notEqual(guests[0].sessionId,guests[1].sessionId);
 assert.ok(batch.evalCleanup.every(r=>r.cleanup==='confirmed'&&r.owner==='released'&&r.storage==='closed'));assert.equal(batch.cleanup?.owner,'released');assert.ok(batch.cleanup?.workspaces.every(w=>w.released));await assertReleased(f.root);await assertReleased(source.root);
 evidence('healthy-fresh',{root:f.root,directory:decision.directory,source,resultState:result.state,counts:report.counts,verdict:report.improvement,executions,sessionIds:guests.map(g=>g.sessionId),evalCleanup:batch.evalCleanup,batchCleanup:batch.cleanup});
});

for(const action of ['stop','exit'] as const)test(`TUI nested fresh ${action} waits for a live VM and cancels the entire submission`,async()=>{
 const f=freshFixture(true,true),terminal=new BatchTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts'),improveRuntime:installation}),screen=()=>plain(app.screen()),key=(data:string)=>terminal.input(data);let exit:TuiExit|undefined;
 try{
  app.start();key(`/improve ${f.report.id} --validate C-01 C-02`);key('\r');assert.match(screen(),/提交汇总/);assert.equal(app.improveBatch.running,false);key('\r');await until(()=>app.improveBatch.running,screen);
  await until(()=>listPlanSources(f.root).some(s=>s.origin?.decisionId===app.improveBatch.origin?.decisionId),()=>JSON.stringify(improveFacts(f.root).slice(-3)));
  const source=listPlanSources(f.root).find(s=>s.origin?.decisionId===app.improveBatch.origin?.decisionId)!,origin=source.origin!,state=readImproveDecision(f.root,origin.decisionId),directory=state.decision.directory!;
  assert.equal(state.decision.groups.length,2);key('\r');assert.match(screen(),/◆ eval/);
  const first=evalReport(source.root,source.id).plan.trials[0].id,marker=join(directory,`g1/check-0/execution/${first}-execution/work/eval82-started`);
  await until(()=>existsSync(marker),()=>JSON.stringify({screen:screen(),state:readImproveDecision(f.root,origin.decisionId)}));assert.equal(app.improveBatch.canStop(origin),true);
  let settled=false;
  if(action==='stop'){key('\x03');assert.match(screen(),/整个 improve 提交批次.*剩余项不启动/);key('\x03');await until(()=>!app.improveBatch.running,screen);exit=await app.exit();}
  else{const closing=app.exit();void closing.then(()=>{settled=true;});await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(terminal.restored,false);assert.equal(await app.exit(),await closing);exit=await closing;}
  const ended=readImproveDecision(f.root,origin.decisionId),report=evalReport(source.root,source.id),executions=assertVMs(source);
  assert.deepEqual(ended.groups.map((g:any)=>g.state),['cancelled','not-run']);assert.equal(improveFacts(f.root).filter(f=>f.kind==='improve.group-started').length,1);assert.equal(existsSync(join(directory,'g2')),false);assert.equal(report.batch.stopReason,'cancelled');assert.equal(report.trials[0].outcome.status,'cancelled');
  assert.equal(exit.eval?.cleanup,'confirmed');assert.equal(exit.eval?.source?.root,source.root);assert.deepEqual(exit.eval?.source?.origin,source.origin);assert.match(exit.summary.join('\n'),/eval ep-.*ir-.*已停止/);assert.doesNotMatch(exit.summary.join('\n'),/写入者锁保留/);assert.equal(terminal.restored,true);await assertReleased(f.root);await assertReleased(source.root);assert.equal((await probeWorkspaceOwner(f.workspace)).holder,null);assert.equal((await probeWorkspaceOwner(f.prompt)).holder,null);
  evidence(`nested-${action}`,{root:f.root,directory,source,marker,groups:ended.groups.map((g:any)=>({id:g.id,state:g.state})),executions,evalCleanup:app.improveBatch.evalCleanup,batchCleanup:app.improveBatch.cleanup,exit});
 }finally{await app.exit();}
});

test('own TUI eval completes, retains input without acceptance, and same-version regrade appends without provider requests',async()=>{
 const f=freshFixture(),prepared=await prepareEval({dataRoot:f.root,id:'own-plan',purpose:'own batch and additive grading',mode:'offline',installation,cases:[f.fixture],budget:{maxRequests:6,maxTokens:6144,maxRequestTokens:1024,deadline:new Date(Date.now()+180000).toISOString(),unknownUpperBound:null},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512}),source=ownPlanSource(f.root,prepared.plan.id),terminal=new BatchTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')}),screen=()=>plain(app.screen()),key=(data:string)=>terminal.input(data);
 try{app.start();key(`/eval run ${source.label}`);key('\r');assert.match(screen(),/Enter 启动/);assert.equal(evalFacts(f.root,source.id).some(f=>f.kind==='eval.started'),false);key('\r');await until(()=>evalFacts(f.root,source.id).some(f=>f.kind==='eval.started'),screen);await assert.rejects(acquireOwner(f.root,()=>{}),/OWNER_CONFLICT/);
  key('\x1b');key('eval 期间保留的输入');key('\r');assert.match(screen(),/eval 期间保留的输入/);assert.match(screen(),/文字保留，未受理/);assert.equal(readAcceptedTasks(f.root).tasks.length,0);assert.equal(readQueue(f.root).items.length,0);
  await until(()=>/eval.*已结束/.test(screen()),screen,120000);const original=evalReport(f.root,source.id);assert.equal(original.counts.passed,1);assert.match(screen(),/eval 期间保留的输入/);const requests=original.cost.requests;assert.equal(requests,4);
  key('\x15');key(`/eval grade ${source.label} --case local-fix`);key('\r');assert.match(screen(),/不调用模型/);key('\r');await until(()=>evalReport(f.root,source.id).regrading?.state==='completed',screen);
  const revised=evalReport(f.root,source.id);assert.equal(revised.gradingRevisions.length,1);assert.equal(revised.trials[0].gradeHistory.length,2);assert.equal(revised.trials[0].outcome.source,original.trials[0].outcome.source);assert.equal(revised.cost.requests,requests);assert.equal(revised.trials[0].grade.graderVersion,original.trials[0].grade.graderVersion);
  const exit=await app.exit();assert.equal(exit.eval,undefined,'viewing/completing a batch is not a stop fact');assert.equal(exit.evalCleanup?.cleanup,'confirmed');await assertReleased(f.root);evidence('own-run-grade',{root:f.root,source,requests,revision:revised.regrading,exit});
 }finally{await app.exit();}
});

test('own TUI batch stop waits for the actual runtime VM, releases its writer and preserves later trials as not-run',async()=>{
 const f=freshFixture(true),prepared=await prepareEval({dataRoot:f.root,id:'own-stop',purpose:'own stop after a real VM marker',mode:'offline',installation,cases:[f.fixture],trials:['first','later'].map(id=>({id,caseId:f.fixture.id,side:'candidate',repeat:1,pair:null})),budget:{maxRequests:12,maxTokens:12288,maxRequestTokens:1024,deadline:new Date(Date.now()+180000).toISOString(),unknownUpperBound:null},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512}),source=ownPlanSource(f.root,prepared.plan.id),terminal=new BatchTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')}),screen=()=>plain(app.screen()),key=(data:string)=>terminal.input(data);
 try{app.start();key(`/eval run ${source.label}`);key('\r');key('\r');await until(()=>evalFacts(f.root,source.id).some(f=>f.kind==='eval.started'),screen);const directory=evalFacts(f.root,source.id).find(f=>f.kind==='eval.started')!.data.directory,marker=join(directory,'first-execution/work/eval82-started');await until(()=>existsSync(marker),screen);await assert.rejects(acquireOwner(f.root,()=>{}),/OWNER_CONFLICT/);key('\x03');key('\x03');const exit=await app.exit(),report=evalReport(f.root,source.id),executions=assertVMs(source);
  assert.equal(report.batch.stopReason,'cancelled');assert.deepEqual(report.trials.map(t=>t.outcome.status),['cancelled','not-run']);assert.equal(evalFacts(f.root,source.id).filter(f=>f.kind==='eval.trial-started').length,1);assert.equal(exit.eval?.cleanup,'confirmed');assert.equal(exit.eval?.source?.root,f.root);assert.equal(exit.evalCleanup?.owner,'released');assert.match(exit.summary.join('\n'),/eval ep-.*已停止/);await assertReleased(f.root);evidence('own-stop',{root:f.root,source,directory,marker,executions,exit});
 }finally{await app.exit();}
});
