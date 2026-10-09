// Run from a clean independent npm installation. Public package exports only.
// Usage: node acceptance-demo.mjs /absolute/install-root /absolute/new-evidence-dir
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const installed=resolve(process.argv[2]),out=resolve(process.argv[3]);
mkdirSync(out,{recursive:false,mode:0o700});
const require=createRequire(join(installed,'package.json'));
const load=async name=>import(pathToFileURL(require.resolve(name)).href);
const {runCodingTask}=await load('pi-durio');
const {scriptedTransport}=await load('pi-durio/offline');
const {queryEvidence,readEvidence}=await load('pi-durio/query');
const {recordAcceptance,queryTaskMetrics}=await load('pi-durio/metrics');
const {ReadOnlyTui}=await load('pi-durio/tui');
const workspace=join(out,'project'),dataRoot=join(out,'data');mkdirSync(workspace);
const save=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const body=ref=>{let offset=0,text='';for(;;){const page=readEvidence(dataRoot,ref.id,{offset,limit:16384});assert.equal(page.state,'complete');assert.equal(typeof page.text,'string');text+=page.text;if(page.next===null)return JSON.parse(text);assert.ok(text.length<2*1024*1024);offset=page.next;}};
let calls=0;
const outcomes=[];
for(const fail of [false,true]){
 const command=fail?'exit 7':'test "$(cat result.txt)" = ready';
 const script=scriptedTransport(fail?[{name:'bash',args:{command}}]:[{name:'write',args:{path:'result.txt',content:'ready'}},{name:'bash',args:{command}}]);
 let localCalls=0,taskId,error;
 const source={kind:'human',actor:'synthetic acceptance host',statement:'Fixed necessary requirement declared before execution; controlled fixture evidence',refs:[]};
 const result=await runCodingTask({workspace,dataRoot,input:fail?'Run the declared failing check once':'Write result.txt containing ready, then check it',mode:'offline',transport:async(url,init)=>{calls++;localCalls++;return fail&&localCalls>1?new Response('controlled failure',{status:401}):script.fetch(url,init);},onObservation:event=>{
  if(event.kind!=='task.accepted')return;
  try{const ref=queryEvidence(dataRoot,event.runId,{kinds:['task.accepted']}).items[0];taskId=body(ref).taskId;recordAcceptance(dataRoot,{type:'requirements',id:`${taskId}-req`,taskId,source:{...source,refs:[ref.id]},ruleVersion:'fixed-command-v1',necessary:[{id:'goal',description:fail?'Declared check passes':'The result is exactly ready',check:{command,passExitCodes:[0],failExitCodes:[1,7]}}]});}catch(value){error=String(value);}
 }});
 assert.equal(error,undefined);assert.equal(result.status,fail?'failed':'completed');
 const check=queryEvidence(dataRoot,result.runId,{kinds:['shell.completed']}).items[0];assert.equal(body(check).acquired.exitCode,fail?7:0);
 recordAcceptance(dataRoot,{type:'result',id:`${taskId}-result`,taskId,source,requirementsId:`${taskId}-req`,evidence:[check.id]});
 recordAcceptance(dataRoot,{type:'judgment',id:`${taskId}-judgment`,taskId,source:{kind:'checks',actor:'trusted fixed-rule host',statement:'Use actual acquired exit code under the predeclared rule',refs:[check.id]},requirementsId:`${taskId}-req`,resultId:`${taskId}-result`,findings:[{requirementId:'goal',outcome:'PASS',evidence:[check.id]}],validity:'valid'});
 const artifact=queryEvidence(dataRoot,result.runId,{kinds:['execution.artifact']}).items[0];
 outcomes.push({runId:result.runId,taskId,status:result.status,check:check.id,artifact:artifact.id,artifactId:body(artifact).id,sourceClass:'synthetic',requests:localCalls});
}
assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'ready');
const scope={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z',asOf:new Date().toISOString(),source:'synthetic'};
const report=queryTaskMetrics(dataRoot,scope);assert.deepEqual(report.counts,{N:2,B:2,C:1,G:2,S:1,terminated:2});save('report-original.json',report);
const content=report=>{const{generatedAt,...rest}=report;return rest;};
const cliPath=join(installed,'node_modules','pi-durio','dist','src','cli.js');
const cli=args=>{const result=spawnSync(process.execPath,[cliPath,...args,'--data-root',dataRoot],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
const before=sha(join(dataRoot,'host.sqlite')),beforeCalls=calls;
assert.deepEqual(content(JSON.parse(cli(['metrics','--scope',JSON.stringify(scope)]))),content(report));
assert.match(cli(['metrics','--scope',JSON.stringify(scope),'--format','text']),/成功率 1\/2 = 50.0%/);
const exported=join(out,'report-export.json');cli(['metrics','--scope',JSON.stringify(scope),'--destination',exported]);
assert.deepEqual(content(JSON.parse(readFileSync(exported,'utf8'))),content(report));
class ComponentTerminal{columns=100;rows=30;kittyProtocolActive=false;input=()=>{};start(input){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}
const terminal=new ComponentTerminal(),app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(out,'drafts'),mode:'offline',transport:async()=>{throw Error('unexpected view-time provider call');},terminal,widthCalibration:false});
app.start();try{terminal.input('/metrics '+JSON.stringify(scope));terminal.input('\r');assert.match(app.screen().join('\n'),/任务指标/);terminal.input('e');terminal.input('\r');terminal.input('\x1b');}finally{await app.exit();}
const afterQueries=sha(join(dataRoot,'host.sqlite'));assert.equal(calls,beforeCalls);assert.equal(afterQueries,before);
const correction={type:'withdraw',id:'explicit-correction',taskId:outcomes[0].taskId,source:{kind:'human',actor:'synthetic user',statement:'Withdraw this judgment after explicit evidence review',refs:[outcomes[0].check]},targets:[`${outcomes[0].taskId}-judgment`],reason:'Known correction path fixture'};
save('correction-input.json',correction);cli(['acceptance','--spec',join(out,'correction-input.json')]);
const revised=queryTaskMetrics(dataRoot,{...scope,asOf:new Date().toISOString(),revisionOf:report.id});assert.equal(revised.counts.G,1);assert.equal(revised.counts.S,0);save('report-revised.json',revised);
assert.equal(queryTaskMetrics(dataRoot,{...scope,through:report.scope.through}).id,report.id);
assert.deepEqual(content(JSON.parse(readFileSync(exported,'utf8'))),content(report));assert.equal(calls,beforeCalls);
save('result.json',{status:'PASS',node:process.version,platform:process.platform,arch:process.arch,installed,publicExports:['pi-durio','pi-durio/offline','pi-durio/query','pi-durio/metrics','pi-durio/tui'],outcomes,counts:report.counts,revisedCounts:revised.counts,requests:calls,readonly:{hostHashBefore:before,hostHashAfterQueries:afterQueries,additionalProviderCalls:0},notRun:['paid/live provider','native macOS Terminal product acceptance','daily-use acceptance'],interpretation:'Real public runtime and local tools under an explicit controlled offline provider; separate from the 10/8/6/5/4 known-fact arithmetic fixture.'});
console.log(JSON.stringify({status:'PASS',evidence:out,counts:report.counts,requests:calls}));
