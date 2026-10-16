import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence} from '../src/evidence.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {type EvalPlan,verifiedImage} from '../src/eval/plan.js';
import {ownPlanSource,type PlanSource} from '../src/eval/overview.js';
import {evalBlocked,evalGradeConfirmation,evalRunConfirmation,evalStoppedFact,samePlan} from '../src/tui/eval-operation.js';
import {ConfirmDialog} from '../src/tui/view-stack.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import {stripTerminalSequences,type Terminal} from '@earendil-works/pi-tui';
import {parseCommand} from '../src/tui/commands.js';
import {acquireOwner} from '../src/ownership.js';
import {fixEvidence} from '../src/fixed-evidence.js';
import {EvalCleanupTracker} from '../src/eval/cleanup.js';
import {exitSummary,tuiExitCode} from '../src/tui/exit-summary.js';
import {evalFacts} from '../src/eval/store.js';
import {verifyEvalBeforeStart} from '../src/eval/preflight.js';
import {runEval} from '../src/eval/runner.js';

function fixture(ended=false){
 const base=mkdtempSync(join(tmpdir(),'durio-eval-operation-')),root=join(base,'data'),workspace=join(base,'project');mkdirSync(workspace);
 const e=new Evidence(root,'eval-confirm'),plan:EvalPlan={id:e.runId,purpose:'固定诊断范围',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'fixed-runtime',manifest:e.blob('[]'),bytes:2},cases:structuredClone(representativeCases.slice(0,2)),trials:representativeCases.slice(0,2).map(c=>({id:c.id,caseId:c.id,version:'fixed-runtime',side:'candidate',repeat:1,pair:null})),budget:{maxRequests:12,maxTokens:12000,maxRequestTokens:1000,deadline:'2099-01-01T00:00:00Z',unknownUpperBound:null},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512,requestRetryLimit:0,price:{version:'cny-test',currency:'CNY',source:'test fixed peak price',perMillionTokens:10,consultedAt:'2026-10-17T00:00:00Z'},authorization:{paid:false,scope:'run-all-listed-trials'},environment:{node:'v24.8.0',isolation:'fixture only',cache:'fixed read-only',writable:'new trial'},mainObjective:'diagnostic',protection:['scope'],improvementConclusion:'not-evaluated'};
 e.append('eval.plan',plan);if(ended){e.append('eval.started',{});e.append('eval.closed',{stopReason:null});}e.close();return {base,root,workspace,plan,source:ownPlanSource(root,plan.id)};
}
const plain=(lines:string[])=>lines.map(stripTerminalSequences).join('\n');
class TestTerminal implements Terminal {
 columns=132;rows=38;kittyProtocolActive=false;input:(text:string)=>void=()=>{};
 start(input:(text:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}

test('eval commands only prefill confirmed scope and refuse expired, busy, read-only, owned or child plans',async()=>{
 const f=fixture(),before=readFileSync(join(f.root,'host.sqlite')),run=parseCommand(`/eval run ${f.source.label}`),grade=parseCommand(`/eval grade ${f.source.label} --case local-fix --case multi-file`);
 assert.deepEqual(run.path,['run']);assert.equal(grade.options.case,'local-fix,multi-file');
 const terminal=new TestTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')});
 try{app.start();terminal.input(`/eval run ${f.source.label}`);terminal.input('\r');const screen=plain(app.screen());assert.match(screen,/启动 eval/);assert.match(screen,/人民币高峰价上限 ≈\s*¥0\.12/);assert.match(screen,/2099-01-01/);assert.match(screen,/Enter 启动/);terminal.input('\x1b');assert.equal(readFileSync(join(f.root,'host.sqlite')).equals(before),true);
  const tiny=new ConfirmDialog(evalRunConfirmation(f.source,()=>undefined));tiny.render(40,6);assert.notEqual(tiny.handleInput('\r').type,'confirm');
  assert.match(evalBlocked(f.source,'run',{now:Date.parse('2100-01-01')})!,/截止时间已过/);
  assert.match(evalBlocked(f.source,'run',{busy:true})!,/有任务运行中/);assert.equal(evalBlocked(f.source,'run',{writeBlocked:'只读'}),'只读');
  const owner=await acquireOwner(f.root,()=>{});try{assert.match(evalBlocked(f.source,'run')!,/写入者锁被占用/);}finally{await owner.release();}
  const child:PlanSource={...f.source,origin:{reportId:'ir',decisionId:'d',label:'ir-1234·C-01@r1'}};assert.match(evalBlocked(child,'grade')!,/improve 发起/);
  assert.equal(samePlan(f.source,{...f.source,root:join(f.base,'other')}),false);assert.equal(samePlan(child,{...child,origin:{...child.origin!,decisionId:'another'}}),false);
 }finally{await app.exit();}
});

test('same-version grade selection defaults to unknown cases and remains a confirmation',()=>{
 const f=fixture(true),config=evalGradeConfirmation(f.source,undefined,()=>undefined);
 assert.deepEqual(config.choice!.selected,[0,1]);assert.match(config.fixed!.join('\n'),/不调用模型.*占用 VM/);assert.match(config.fixed!.join('\n'),/追加评分修订，原评分保留/);
 assert.deepEqual(evalGradeConfirmation(f.source,['local-fix'],()=>undefined).choice!.selected,[0]);assert.throws(()=>evalGradeConfirmation(f.source,['foreign'],()=>undefined),/CASE_NOT_FOUND/);
 const dialog=new ConfirmDialog(config);dialog.render(132,38);assert.equal(dialog.handleInput('\x1b').type,'cancel');
});

test('cleanup receipt distinguishes unconfirmed VM from released writer and identifies child-root summary',async()=>{
 const f=fixture(),tracker=new EvalCleanupTracker(f.root,f.plan.id,'run');tracker.receipt.owner='released';tracker.receipt.storage='closed';
 await tracker.execute(async()=>({id:'vm-unconfirmed',started:true,terminated:false,status:'invalid',reason:'termination_unconfirmed'}));
 const receipt=tracker.finish();assert.equal(receipt.cleanup,'unknown');assert.equal(receipt.owner,'released');
 const source={...f.source,root:join(f.base,'child'),label:'ep-child',origin:{reportId:'report',decisionId:'decision',label:'ir-parent·C-01@r1'}};
 const fact=evalStoppedFact(source,undefined,receipt);assert.deepEqual(fact.source,{root:source.root,id:source.id,label:'ep-child',origin:source.origin});
 const lines=await exitSummary(f.root,{workspace:f.workspace,elapsedMs:0,draftLines:0,terminalRestored:true,eval:fact,evalCleanup:receipt},132);
 assert.match(lines.join('\n'),/eval ep-child.*ir-parent/);assert.match(lines.join('\n'),/VM 状态未知.*写入者锁已释放/);assert.doesNotMatch(lines.join('\n'),/写入者锁保留/);assert.equal(tuiExitCode({eval:fact}),75);
 const lost=new EvalCleanupTracker(f.root,'lost','grade');await assert.rejects(lost.execute(async()=>{throw Error('no execution receipt');}));assert.equal(lost.finish().cleanup,'unknown');
});

test('runner final evidence uses its existing lease, with no release-and-reacquire gap',async()=>{
 const f=fixture(),owner=await acquireOwner(f.root,()=>{});
 try{const e=new Evidence(f.root,f.plan.id);const seq=e.append('eval.closed',{stopReason:null}),ref=e.db.prepare('SELECT body FROM records WHERE seq=?').get(seq)!;const source=`e1:${seq}:${JSON.parse(String(ref.body)).sha256}`;e.close();await fixEvidence(f.root,{id:'owned-final',sources:[source],purpose:'same runner lease'},owner);owner.assertHeld();await assert.rejects(acquireOwner(f.root,()=>{}),/OWNER_CONFLICT/);}finally{await owner.release();}
 const next=await acquireOwner(f.root,()=>{});await next.release();
});

test('asynchronous content verification rejects missing fixation and Esc discards a pending start without acquiring ownership',async()=>{
 const f=fixture();await assert.rejects(verifyEvalBeforeStart(f.root,f.plan.id),/EVAL_PLAN_NOT_FIXED/);
 let receipt:ReturnType<EvalCleanupTracker['finish']>|undefined;
 await assert.rejects(runEval({dataRoot:f.root,id:f.plan.id,directory:join(f.base,'invalid'),onCleanup:value=>{receipt=value;}}),/EVAL_PLAN_NOT_FIXED/);
 assert.equal(receipt?.cleanup,'confirmed');assert.equal(receipt?.owner,'not-acquired');assert.equal(receipt?.storage,'not-opened');assert.deepEqual(receipt?.executions,[]);
 const terminal=new TestTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')});
 try{app.start();terminal.input(`/eval run ${f.source.label}`);terminal.input('\r');terminal.input('\r');terminal.input('\x1b');const exit=await app.exit();assert.equal(evalFacts(f.root,f.plan.id).some(f=>f.kind==='eval.started'),false);assert.equal(exit.evalCleanup?.owner,'not-acquired');assert.deepEqual(exit.evalCleanup?.executions,[]);const owner=await acquireOwner(f.root,()=>{});await owner.release();}finally{await app.exit();}
});

test('headless eval resolves display numbers for report, run and grade with an omitted directory',()=>{
 const f=fixture(),before=evalFacts(f.root,f.plan.id).length;
 const cli=(action:string,args:string[]=[])=>spawnSync(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,'eval',action,f.source.label,'--data-root',f.root,...args],{encoding:'utf8'});
 const report=cli('report');assert.equal(report.status,0,report.stderr);assert.equal(JSON.parse(report.stdout).plan.id,f.plan.id);
 const run=cli('run');assert.notEqual(run.status,0);assert.match(run.stderr,/EVAL_PLAN_NOT_FIXED/);assert.doesNotMatch(run.stderr,/requires --directory/);
 const spec=join(f.base,'grade.json');writeFileSync(spec,JSON.stringify({revisionId:'empty',graders:{}}));const grade=cli('grade',['--spec',spec]);assert.notEqual(grade.status,0);assert.match(grade.stderr,/EVAL_PLAN_NOT_FIXED/);assert.doesNotMatch(grade.stderr,/requires --directory/);
 assert.equal(evalFacts(f.root,f.plan.id).length,before);
});
