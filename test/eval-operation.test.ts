import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence} from '../src/evidence.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {type EvalPlan,verifiedImage} from '../src/eval/plan.js';
import {ownPlanSource,resolvePlanSource,type PlanSource} from '../src/eval/overview.js';
import {evalBlocked,evalGradeConfirmation,evalRunConfirmation,evalStoppedFact,readEvalProgress,samePlan} from '../src/tui/eval-operation.js';
import {ConfirmDialog} from '../src/tui/view-stack.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import {stripTerminalSequences,type Terminal} from '@earendil-works/pi-tui';
import {parseCommand} from '../src/tui/commands.js';
import {acquireOwner} from '../src/ownership.js';
import {fixEvidence} from '../src/fixed-evidence.js';
import {EvalCleanupTracker} from '../src/eval/cleanup.js';
import {exitSummary,tuiExitCode} from '../src/tui/exit-summary.js';
import {evalFacts,appendFact} from '../src/eval/store.js';
import {verifyEvalBeforeStart} from '../src/eval/preflight.js';
import {evalReport,runEval} from '../src/eval/runner.js';
import {captureSnapshot} from '../src/tui/snapshot.js';
import {COLOR_TIER,overrideColorTierForTest} from '../src/tui/theme.js';

function fixture(ended=false,id='eval-confirm'){
 const base=mkdtempSync(join(tmpdir(),'durio-eval-operation-')),root=join(base,'data'),workspace=join(base,'project');mkdirSync(workspace);
 const e=new Evidence(root,id),plan:EvalPlan={id:e.runId,purpose:'固定诊断范围',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'fixed-runtime',manifest:e.blob('[]'),bytes:2},cases:structuredClone(representativeCases.slice(0,2)),trials:representativeCases.slice(0,2).map(c=>({id:c.id,caseId:c.id,version:'fixed-runtime',side:'candidate',repeat:1,pair:null})),budget:{maxRequests:12,maxTokens:12000,maxRequestTokens:1000,deadline:'2099-01-01T00:00:00Z',unknownUpperBound:null},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512,requestRetryLimit:0,price:{version:'cny-test',currency:'CNY',source:'test fixed peak price',perMillionTokens:10,consultedAt:'2026-10-17T00:00:00Z'},authorization:{paid:false,scope:'run-all-listed-trials'},environment:{node:'v24.8.0',isolation:'fixture only',cache:'fixed read-only',writable:'new trial'},mainObjective:'diagnostic',protection:['scope'],improvementConclusion:'not-evaluated'};
 e.append('eval.plan',plan);if(ended){e.append('eval.started',{});e.append('eval.closed',{stopReason:null});}e.close();return {base,root,workspace,plan,source:ownPlanSource(root,plan.id)};
}
const plain=(lines:string[])=>lines.map(stripTerminalSequences).join('\n');
class TestTerminal implements Terminal {
 columns=132;rows=38;kittyProtocolActive=false;input:(text:string)=>void=()=>{};
 start(input:(text:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}

test('eval preparation paints the full loading view in every color tier',async t=>{
 const f=fixture(),terminal=new TestTerminal(),previousTier=COLOR_TIER;
 const app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')});
 try {
  app.start();t.mock.timers.enable({apis:['setTimeout','setInterval']});
  terminal.input(`/eval run ${f.source.label}`);terminal.input('\r');terminal.input('\r');
  // Advance the loading delay before the async runner can start a VM.
  t.mock.timers.tick(200);
  for(const tier of ['truecolor','256color','none'] as const)for(const [width,height]of [[132,38],[80,24],[40,12]]) {
   overrideColorTierForTest(tier);terminal.columns=width;terminal.rows=height;
   const lines=app.screen();assert.match(plain(lines),/核对内容中/);
   for(const [y,row]of captureSnapshot(lines,width,height,tier).rows.entries())for(const [x,cell]of row.entries())
    assert.equal(cell.bg,tier==='none'?undefined:'bg.base',`${tier} ${width}×${height} cell ${x},${y}`);
   if(tier==='none')assert.doesNotMatch(lines.join(''),/\x1b\[(?:38|48);/);
  }
 } finally {t.mock.timers.reset();await app.exit();overrideColorTierForTest(previousTier);}
});

test('eval status redraws follow durable trial progress without rereading fixed execution payloads',async t=>{
 const f=fixture(),e=new Evidence(f.root,f.plan.id),payload=e.blob(Buffer.alloc(65536,7));e.append('eval.content',{files:[{path:'runtime-fixture',ref:payload}]});e.close();
 const planFact=evalFacts(f.root,f.plan.id).find(f=>f.kind==='eval.plan')!;
 await fixEvidence(f.root,{id:`eval-plan:${f.plan.id}`,sources:[planFact.source],purpose:'fixed progress regression input'});
 const payloadPath=join(f.root,'objects',payload.sha256),realOpen=fs.openSync,realRead=fs.readFileSync;let payloadReads=0;
 const opened=t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if(String(args[0])===payloadPath)payloadReads++;return Reflect.apply(realOpen,fs,args);});
 const read=t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{if(String(args[0])===payloadPath)payloadReads++;return Reflect.apply(realRead,fs,args);});syncBuiltinESMExports();
 const terminal=new TestTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')});
 try{
  assert.equal(evalReport(f.root,f.plan.id).planAvailability,'protected');assert.ok(payloadReads>0,'the formal report checks the fixed payload');
  app.start();terminal.input(`/eval run ${f.source.label}`);terminal.input('\r');terminal.input('\r');
  // Leave the plan panel and cancel preparation before the first async runner turn.
  // The pending operation still renders its status, without starting a VM.
  terminal.input('\x1b');payloadReads=0;
  assert.match(plain(app.screen()),/trial 0\/2/);assert.match(plain(app.screen()),/trial 0\/2/);
  assert.equal(payloadReads,0,'spinner/status frames must not verify fixed execution content');
  const updates=new Evidence(f.root,f.plan.id);try{
   updates.append('eval.trial-started',{trialId:'local-fix'});updates.append('eval.trial-started',{trialId:'local-fix'});updates.append('eval.trial-started',{trialId:'foreign'});
   assert.match(plain(app.screen()),/trial 1\/2/);
   updates.append('eval.outcome',{trialId:'local-fix',started:false,status:'budget-stopped',valid:false});
   assert.match(plain(app.screen()),/trial 0\/2/);
   updates.append('eval.outcome',{trialId:'multi-file',started:true,status:'completed',valid:true});
   assert.match(plain(app.screen()),/trial 1\/2/);assert.equal(payloadReads,0,'progress updates must not reopen fixed payloads');
  }finally{updates.close();}
 }finally{opened.mock.restore();read.mock.restore();syncBuiltinESMExports();const exit=await app.exit();assert.deepEqual(exit.evalCleanup?.executions,[]);}
 const before=readFileSync(join(f.root,'host.sqlite'));writeFileSync(payloadPath,Buffer.alloc(payload.bytes,8));
 assert.match(evalReport(f.root,f.plan.id).planAvailability,/EVAL_PLAN_CONTENT_UNAVAILABLE/);assert.deepEqual(readFileSync(join(f.root,'host.sqlite')),before,'content tampering changes no database facts');
});

test('eval progress keeps root, plan and acquisition boundaries with report started semantics',()=>{
 const f=fixture(),otherRoot=fixture(),e=new Evidence(f.root,f.plan.id),planSeq=evalFacts(f.root,f.plan.id).find(f=>f.kind==='eval.plan')!.seq;
 let startedSeq:number,outcomeSeq:number;
 try{
  startedSeq=e.append('eval.trial-started',{trialId:'local-fix'});e.append('eval.trial-started',{trialId:'local-fix'});e.append('eval.trial-started',{trialId:'foreign'});
  outcomeSeq=e.append('eval.outcome',{trialId:'local-fix',started:false,status:'budget-stopped',valid:false});
  e.append('eval.outcome',{trialId:'local-fix',started:true,status:'completed',valid:true});e.append('eval.trial-started',{trialId:'local-fix'});
  e.append('eval.outcome',{trialId:'multi-file',started:true,status:'completed',valid:true});e.append('eval.outcome',{trialId:'foreign',started:true,status:'completed',valid:true});
 }finally{e.close();}
 const other=new Evidence(f.root,'other-plan');try{other.append('eval.plan',{...f.plan,id:'other-plan',trials:f.plan.trials.slice(0,1)});other.append('eval.trial-started',{trialId:'local-fix'});}finally{other.close();}
 assert.throws(()=>readEvalProgress({...f.source,through:planSeq-1}),/EVAL_PLAN_NOT_FOUND/);
 assert.deepEqual(readEvalProgress({...f.source,through:planSeq}),[0,2]);
 assert.deepEqual(readEvalProgress({...f.source,through:startedSeq}),[1,2]);
 assert.deepEqual(readEvalProgress({...f.source,through:outcomeSeq}),[0,2]);
 assert.deepEqual(readEvalProgress(f.source),[1,2]);
 const report=evalReport(f.root,f.plan.id);assert.equal(readEvalProgress(f.source)[0],report.counts.started);
 assert.deepEqual(readEvalProgress(otherRoot.source),[0,2],'the same plan id in another root has independent progress');
 assert.deepEqual(readEvalProgress({...f.source,id:'other-plan'}),[1,1],'another plan in the same root has independent scope');
 assert.deepEqual(readEvalProgress({...f.source,through:startedSeq}),[1,2],'reading live or other plans does not advance a pinned source');
});

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
  assert.equal(samePlan(f.source,{...f.source,root:join(f.base,'other')}),false);assert.equal(samePlan(child,{...child,origin:{...child.origin!,decisionId:'another'}}),false);assert.equal(samePlan({...child,origin:{...child.origin!,groupId:'g1'}},{...child,origin:{...child.origin!,groupId:'g2'}}),false);
 }finally{await app.exit();}
});

test('same-version grade defaults select only valid executed cases with unknown judgments',async()=>{
 const f=fixture(true),planSource=evalFacts(f.root,f.plan.id).find(f=>f.kind==='eval.plan')!.source;
 await fixEvidence(f.root,{id:`eval-plan:${f.plan.id}`,sources:[planSource],purpose:'fixed grade defaults fixture'});
 const e=new Evidence(f.root,f.plan.id);
 const valid=appendFact(e,'eval.outcome',{trialId:'local-fix',started:true,status:'completed',valid:true,artifacts:[]});
 appendFact(e,'eval.grade',{trialId:'local-fix',outcome:valid,judgment:'unknown'});
 const invalid=appendFact(e,'eval.outcome',{trialId:'multi-file',started:true,status:'invalid',valid:false,artifacts:[]});e.close();
 await fixEvidence(f.root,{id:`eval-outcomes:${f.plan.id}`,sources:[invalid],purpose:'fixed acquired outcomes'});
 const config=evalGradeConfirmation(f.source,undefined,()=>undefined);
 assert.deepEqual(config.choice!.selected,[0]);assert.match(config.fixed!.join('\n'),/不调用模型.*占用 VM/);assert.match(config.fixed!.join('\n'),/追加评分修订，原评分保留/);
 assert.deepEqual(evalGradeConfirmation(f.source,['local-fix'],()=>undefined).choice!.selected,[0]);assert.throws(()=>evalGradeConfirmation(f.source,['foreign'],()=>undefined),/CASE_NOT_FOUND/);
 const dialog=new ConfirmDialog(config);dialog.render(132,38);assert.equal(dialog.handleInput('\x1b').type,'cancel');
});

test('expired eval plans still open a disabled confirmation and Enter writes no execution facts',async()=>{
 const f=fixture(),expired={...f.plan,id:'expired-plan',budget:{...f.plan.budget,deadline:'2000-01-01T00:00:00Z'}},e=new Evidence(f.root,expired.id);e.append('eval.plan',expired);e.close();
 const source=ownPlanSource(f.root,expired.id),before=readFileSync(join(f.root,'host.sqlite')),terminal=new TestTerminal(),app=new ReadOnlyTui({dataRoot:f.root,workspace:f.workspace,mode:'offline',terminal,widthCalibration:false,draftRoot:join(f.base,'drafts')});
 try{app.start();terminal.input(`/eval run ${source.label}`);terminal.input('\r');const screen=plain(app.screen());assert.match(screen,/启动 eval/);assert.match(screen,/计划截止时间已过，需新建计划/);terminal.input('\r');assert.equal(evalFacts(f.root,expired.id).some(f=>f.kind==='eval.started'),false);assert.deepEqual(readFileSync(join(f.root,'host.sqlite')),before);}
 finally{await app.exit();}
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


test('never-run cases are not selected for same-outcome regrading',()=>{
 const f=fixture(true);assert.deepEqual(evalGradeConfirmation(f.source,undefined,()=>undefined).choice!.selected,[]);
});

test('eval display resolution opens improve child plans and rejects ambiguous displayed numbers',()=>{
 const f=fixture(),child=fixture(false,'eval-child'),e=new Evidence(f.root,'parent-analysis');
 e.append('improve.started',{request:{id:'parent-report'}});
 e.append('improve.report',{id:'parent-report',runId:e.runId,target:{workspace:f.workspace},candidates:[]});
 e.append('improve.decision',{id:'child-decision',decision:{reportId:'parent-report',groups:[{id:'g1',candidateIds:[]}],limits:{maxTokens:0}}});
 e.append('improve.eval',{parent:{decisionId:'child-decision'},groupId:'g1',planId:child.plan.id,dataRoot:child.root});e.close();
 assert.equal(resolvePlanSource(f.root,child.source.label).root,child.root);
 assert.equal(resolvePlanSource(f.root,child.plan.id).origin!.reportId,'parent-report');
 const collision=fixture(false,'eval-child'),link=new Evidence(f.root,'parent-analysis');
 link.append('improve.eval',{parent:{decisionId:'child-decision'},groupId:'g1',planId:collision.plan.id,dataRoot:collision.root});link.close();
 assert.throws(()=>resolvePlanSource(f.root,child.source.label),/AMBIGUOUS/,'two roots with the same full plan id are not guessed');
});

test('eval plan commands retain longer display prefixes and case-insensitive display input',()=>{
 const id='abcde100-0000-4000-8000-000000000001',f=fixture(false,id);
 assert.equal(resolvePlanSource(f.root,'ep-abcde100').id,id);
 assert.equal(resolvePlanSource(f.root,'EP-ABCDE100').id,id);
 assert.equal(resolvePlanSource(f.root,id).id,id);
 assert.throws(()=>resolvePlanSource(f.root,'ep-abc'),/NOT_FOUND/);
});

test('eval plan commands do not let display-shaped full ids shadow a longer display prefix',()=>{
 const f=fixture(false,'abcde100-0000-4000-8000-000000000001'),shaped='ep-abcde100',e=new Evidence(f.root,shaped);e.append('eval.plan',{...f.plan,id:shaped});e.close();
 assert.throws(()=>resolvePlanSource(f.root,shaped),/AMBIGUOUS/);
 assert.equal(resolvePlanSource(f.root,f.plan.id).id,f.plan.id);
 assert.equal(resolvePlanSource(f.root,ownPlanSource(f.root,shaped).label).id,shaped);
});
