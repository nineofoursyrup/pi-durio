import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runCodingTask,readAcceptedTasks} from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {records,decode,watermark} from '../src/history.js';
import {recordAcceptance,queryTaskMetrics,type AcceptanceInput} from '../src/metrics/index.js';
import {MetricsView} from '../src/tui/metrics.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import {stripTerminalSequences,type Terminal} from '@earendil-works/pi-tui';
const content=(report:any)=>{const{generatedAt,...rest}=report;return rest;};
const scope={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z',asOf:'2100-01-01T00:00:00Z',source:'synthetic' as const};
class TestTerminal implements Terminal {
 columns=100;rows=30;kittyProtocolActive=false;input:(s:string)=>void=()=>{};
 start(input:(s:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function actualCheck(fail=false) {
 const root=mkdtempSync(join(tmpdir(),'durio-metrics-runtime-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);
 const command=fail?'exit 7':'test "$(cat result.txt)" = ready';
 const script=scriptedTransport(fail?[{name:'bash',args:{command}}]:[{name:'write',args:{path:'result.txt',content:'ready'}},{name:'bash',args:{command}}]);
 let calls=0,taskId='',admissionError:unknown;
 const transport:typeof fetch=async(url,init)=>{calls++;if(fail&&calls>1)return new Response('controlled provider failure',{status:401});return script.fetch(url,init);};
 const source={kind:'human' as const,actor:'controlled fixture host',statement:'The necessary requirement and fixed check are declared before execution',refs:[] as string[]};
 const result=await runCodingTask({workspace,dataRoot,input:fail?'Run the known failing check':'Create result.txt containing ready and run the exact check',mode:'offline',transport,onObservation:event=>{
  if(event.kind==='task.accepted'){try{const ref=[...records(dataRoot,{runId:event.runId,kinds:['task.accepted']})][0];taskId=decode(dataRoot,ref).taskId;recordAcceptance(dataRoot,{type:'requirements',id:'req',taskId,source:{...source,refs:[ref.id]},ruleVersion:'literal-check-v1',necessary:[{id:'goal',description:fail?'The fixed business check succeeds':'result.txt contains exactly ready',check:{command,passExitCodes:[0],failExitCodes:[7,1]}}]});}catch(error){admissionError=error;}}
 }});
 assert.equal(admissionError,undefined);assert.equal(result.status,fail?'failed':'completed');
 const shell=[...records(dataRoot,{runId:result.runId,kinds:['shell.completed']})][0];
 assert.equal(decode(dataRoot,shell).acquired.exitCode,fail?7:0);
 recordAcceptance(dataRoot,{type:'result',id:'result',taskId,source,requirementsId:'req',evidence:[shell.id]});
 const input:AcceptanceInput={type:'judgment',id:'actual-check',taskId,source:{kind:'checks',actor:'fixed shell-exit rule',statement:'Read actual acquired host check under the predeclared rule',refs:[shell.id]},requirementsId:'req',resultId:'result',findings:[{requirementId:'goal',outcome:'PASS',evidence:[shell.id]}],validity:'valid'};
 Object.assign(input,{assessment:{method:'pretend',outcome:'PASS',findings:input.findings}});
 recordAcceptance(dataRoot,input);
 return{root,workspace,dataRoot,result,taskId,shell,input,get calls(){return calls;}};
}
test('public runtime actual check supports PASS; headless/TUI/reopen/export share a read-only report and retain exact facts',async()=>{
 const f=await actualCheck(),report=queryTaskMetrics(f.dataRoot,scope),calls=f.calls;
 assert.deepEqual(report.counts,{N:1,B:1,C:1,G:1,S:1,terminated:1});assert.equal(readFileSync(join(f.workspace,'result.txt'),'utf8'),'ready');assert.equal(report.tasks[0].sourceClass,'synthetic');assert.equal(report.tasks[0].clocks.execution.state,'measured');assert.equal(report.tasks[0].clocks.acceptance.state,'measured');
 assert.equal(queryTaskMetrics(f.dataRoot).counts.N,0);assert.match(queryTaskMetrics(f.dataRoot).excluded[0].reasons.join(' '),/synthetic/);
 const hostBefore=readFileSync(join(f.dataRoot,'host.sqlite')),seq=watermark(f.dataRoot);
 const cli=(args:string[])=>spawnSync(process.execPath,['dist/src/cli.js',...args,'--data-root',f.dataRoot],{encoding:'utf8'});
 const machine=cli(['metrics','--scope',JSON.stringify(scope)]);assert.equal(machine.status,0,machine.stderr);assert.deepEqual(content(JSON.parse(machine.stdout)),content(report));
 const readable=cli(['metrics','--scope',JSON.stringify(scope),'--format','text']);assert.equal(readable.status,0,readable.stderr);assert.match(readable.stdout,/成功率 1\/1 = 100.0%/);assert.match(readable.stdout,new RegExp(report.id));
 const destination=join(f.root,'report.json');const exported=cli(['metrics','--scope',JSON.stringify(scope),'--destination',destination]);assert.equal(exported.status,0,exported.stderr);assert.deepEqual(content(JSON.parse(readFileSync(destination,'utf8'))),content(report));assert.notEqual(cli(['metrics','--scope',JSON.stringify(scope),'--destination',destination]).status,0);
 const view=new MetricsView(f.dataRoot,scope);assert.deepEqual(content(view.report),content(report));view.handleInput('e');view.handleInput('\r');assert.ok(view.render(120,80).join('\n').includes('task.accepted'));view.handleInput('b');view.handleInput('b');view.handleInput('r');assert.equal(view.report.counts.G,0);
 const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace:f.workspace,dataRoot:f.dataRoot,draftRoot:join(f.root,'drafts'),mode:'offline',transport:async()=>{throw Error('report must never call provider');},terminal,widthCalibration:false});app.start();
 try{terminal.input('/metrics '+JSON.stringify(scope));terminal.input('\r');assert.match(app.screen().map(stripTerminalSequences).join('\n'),/任务指标 · 只读/);terminal.input('\x1b');terminal.input('/compact');terminal.input('\r');assert.match(app.screen().map(stripTerminalSequences).join('\n'),/压缩需要活动|没有可压缩|没有活动|compact|任务/);}finally{await app.exit();}
 assert.equal(f.calls,calls);assert.equal(watermark(f.dataRoot),seq);assert.deepEqual(readFileSync(join(f.dataRoot,'host.sqlite')),hostBefore);
 // Explicit correction input appends once, and a new report links back to all old revisions.
 const correction={type:'withdraw',id:'withdraw-check',taskId:f.taskId,source:{kind:'human',actor:'fixture user',statement:'Withdraw this judgment only; keep the original check',refs:[f.shell.id]},targets:['actual-check'],reason:'Explicit evidence review'};
 const file=join(f.root,'correction.json');writeFileSync(file,JSON.stringify(correction));assert.equal(cli(['acceptance','--spec',file]).status,0);const revised=queryTaskMetrics(f.dataRoot,scope);assert.equal(revised.counts.G,0);assert.notEqual(revised.id,report.id);assert.deepEqual(content(JSON.parse(readFileSync(destination,'utf8'))),content(report));assert.equal(queryTaskMetrics(f.dataRoot,{...scope,through:seq}).id,report.id);
});
test('public failed run can be gradable FAIL from an actual fixed check; missing evidence later becomes unknown',async()=>{
 const f=await actualCheck(true),report=queryTaskMetrics(f.dataRoot,scope);
 assert.deepEqual(report.counts,{N:1,B:1,C:0,G:1,S:0,terminated:1});assert.equal(report.tasks[0].acceptance.outcome,'FAIL');assert.equal(report.tasks[0].acceptance.judgments[0].findings[0].outcome,'FAIL');assert.equal(report.tasks[0].clocks.acceptanceOutcome,'FAIL');
 // The original claimed PASS was never trusted over the acquired exit result.
 const original=decode(f.dataRoot,[...records(f.dataRoot,{kinds:['acceptance.judgment']})][0]);assert.equal(original.findings[0].outcome,'PASS');assert.equal(original.assessment.outcome,'FAIL');assert.equal(original.assessment.ruleVersion,'literal-check-v1');assert.equal(original.assessment.method,'necessary-requirements-v1/fixed-shell-exit-v1');assert.ok(original.assessment.sourceRefs.includes(f.shell.id));
 const started=[...records(f.dataRoot,{runId:f.result.runId,kinds:['shell.started']})][0];unlinkSync(join(f.dataRoot,'objects',started.ref.sha256));const missingStart=queryTaskMetrics(f.dataRoot,scope);assert.equal(missingStart.counts.G,0);assert.ok(original.assessment.sourceRefs.includes(started.id));assert.match(missingStart.tasks[0].acceptance.reasons.join(' '),/unavailable/);
 unlinkSync(join(f.dataRoot,'objects',f.shell.ref.sha256));const missing=queryTaskMetrics(f.dataRoot,scope);assert.equal(missing.counts.G,0);assert.match(missing.tasks[0].acceptance.reasons.join(' '),/unavailable/);
 assert.equal(readAcceptedTasks(f.dataRoot).tasks.length,1);
});
