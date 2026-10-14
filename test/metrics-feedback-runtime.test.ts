import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runCodingTask,readAcceptedTasks} from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {records,decode,watermark} from '../src/history.js';
import {recordFeedback,queryFeedbackMetrics} from '../src/metrics/index.js';
import {MetricsView} from '../src/tui/metrics.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import type {Terminal} from '@earendil-works/pi-tui';
class TestTerminal implements Terminal {columns=110;rows=30;kittyProtocolActive=false;input:(s:string)=>void=()=>{};start(input:(s:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}
const content=(x:any):any=>Array.isArray(x)?x.map(content):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='generatedAt').map(([k,v])=>[k,content(v)])):x;
test('real public delivery, explicit correction and independent repair retain identities; CLI/TUI/export only read the same report',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-feedback-runtime-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);let calls=0;
 const initial=scriptedTransport([{name:'write',args:{path:'result.txt',content:'broken'}}]);const result=await runCodingTask({workspace,dataRoot,input:'Write result.txt containing exactly ready and deliver the result',mode:'offline',transport:async(u,i)=>{calls++;return initial.fetch(u,i);}});assert.equal(result.status,'completed');assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'broken');
 const admission=[...records(dataRoot,{runId:result.runId,kinds:['task.accepted']})][0],close=[...records(dataRoot,{runId:result.runId,kinds:['run.closed']})][0];assert.equal(decode(dataRoot,close).answer,result.answer);
 const check=spawnSync('/bin/sh',['-c','test "$(cat result.txt)" = ready'],{cwd:workspace});assert.equal(check.status,1);
 const statement='The original request required ready, but the delivered file contains broken. Please correct that original requirement.';
 const occurrence=new Date().toISOString();recordFeedback(dataRoot,{type:'observation',id:'request-repair',taskId:result.taskId,dimension:'rework',meaning:'correction',source:{kind:'human',actor:'controlled test operator',statement,refs:[admission.id,close.id]},requirements:[admission.id],delivery:close.id,occurredAt:occurrence,originalRequirement:'unmet',correction:'requested'});
 const scope={source:'synthetic' as const,asOf:new Date().toISOString()},old=queryFeedbackMetrics(dataRoot,scope);assert.equal(old.rework.counts.immaturePositive,1);assert.equal(old.rework.counts.Nr,0);assert.equal(old.rework.tasks[0].acceptance,'unknown');assert.equal(old.rework.tasks[0].delivery?.source,close.id);
 const script=scriptedTransport([{name:'read',args:{path:'result.txt'}},{name:'write',args:{path:'result.txt',content:'ready'}},{name:'bash',args:{command:'test "$(cat result.txt)" = ready'}}]);const repair=await runCodingTask({workspace,dataRoot,input:'Correct the previously delivered result.txt to the original requirement: ready; run the check',mode:'offline',transport:async(u,i)=>{calls++;return script.fetch(u,i);}});assert.equal(repair.status,'completed');assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'ready');assert.notEqual(repair.taskId,result.taskId);assert.equal(readAcceptedTasks(dataRoot).tasks.length,2);
 const repairClose=[...records(dataRoot,{runId:repair.runId,kinds:['run.closed']})][0],repairCheck=[...records(dataRoot,{runId:repair.runId,kinds:['shell.completed']})][0];
 const input={type:'observation' as const,id:'repair-completed',taskId:result.taskId,dimension:'rework' as const,meaning:'correction' as const,source:{kind:'human' as const,actor:'controlled test operator',statement,refs:[admission.id,close.id]},requirements:[admission.id],delivery:close.id,occurredAt:occurrence,originalRequirement:'unmet' as const,correction:'completed' as const,repairTaskId:repair.taskId,repairSources:[repairCheck.id],resultSources:[repairClose.id],revisionOf:'request-repair',reason:'Actual separate repair task completed; preserve original request occurrence'};
 const spec=join(root,'feedback.json');writeFileSync(spec,JSON.stringify(input));
 const cli=(args:string[])=>spawnSync(process.execPath,['dist/src/cli.js',...args,'--data-root',dataRoot],{encoding:'utf8',maxBuffer:8*1024*1024});
 const recorded=cli(['feedback','--spec',spec]);assert.equal(recorded.status,0,recorded.stderr);const repeated=cli(['feedback','--spec',spec]);assert.equal(JSON.parse(repeated.stdout).repeated,true);
 const finalScope={source:'synthetic' as const,asOf:new Date().toISOString()},report=queryFeedbackMetrics(dataRoot,finalScope);assert.equal(report.rework.counts.immature,2);assert.equal(report.rework.counts.immaturePositive,1);assert.equal(report.rework.tasks[0].events[0].input.repairTaskId,repair.taskId);
 const before=readFileSync(join(dataRoot,'host.sqlite')),seq=watermark(dataRoot),beforeCalls=calls;
 const machine=cli(['feedback-report','--scope',JSON.stringify(finalScope)]);assert.equal(machine.status,0,machine.stderr);assert.deepEqual(content(JSON.parse(machine.stdout)),content(report));
 const readable=cli(['feedback-report','--scope',JSON.stringify(finalScope),'--format','text']);assert.equal(readable.status,0,readable.stderr);assert.match(readable.stdout,/成熟返工 0\/0 = N\/A/);
 const destination=join(root,'report.json');assert.equal(cli(['feedback-report','--scope',JSON.stringify(finalScope),'--destination',destination]).status,0);assert.deepEqual(content(JSON.parse(readFileSync(destination,'utf8'))),content(report));assert.notEqual(cli(['feedback-report','--scope',JSON.stringify(finalScope),'--destination',destination]).status,0);
 const view=new MetricsView(dataRoot,finalScope);view.handleInput('f');assert.deepEqual(content(view.feedbackReport),content(report));view.handleInput('e');view.handleInput('\r');assert.match(view.render(110,100).join('\n'),/task.accepted/);view.handleInput('b');view.handleInput('b');view.handleInput('r');assert.ok(view.feedbackReport!.scope.through<report.scope.through);
 const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false,transport:async()=>{throw Error('readonly report called provider');}});app.start();try{terminal.input('/metrics '+JSON.stringify(finalScope));terminal.input('\r');terminal.input('f');assert.match(app.screen().join('\n'),/人工介入与交付后返工/);terminal.input('o');assert.match(app.screen().join('\n'),/成本与故障/);terminal.input('f');assert.match(app.screen().join('\n'),/人工介入与交付后返工/);}finally{await app.exit();}
 assert.equal(calls,beforeCalls);assert.equal(watermark(dataRoot),seq);assert.deepEqual(readFileSync(join(dataRoot,'host.sqlite')),before);assert.equal(queryFeedbackMetrics(dataRoot,old.scope).id,old.id);
});
