import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCodingTask,compactContext,readAcceptedTasks} from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {records,decode,watermark} from '../src/history.js';
import {recordAcceptance,recordCostEstimate,queryOperationsMetrics} from '../src/metrics/index.js';
import {MetricsView} from '../src/tui/metrics.js';
const scope={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z',asOf:'2100-01-01T00:00:00Z',source:'synthetic' as const};
function withoutGenerated(r:any):any{if(Array.isArray(r))return r.map(withoutGenerated);if(r&&typeof r==='object')return Object.fromEntries(Object.entries(r).filter(([k])=>k!=='generatedAt').map(([k,v])=>[k,withoutGenerated(v)]));return r;}
test('actual public runtime success/failure/cancel/manual maintenance share immutable CLI/TUI/export reports and retain no-usage gaps',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'durio-operations-actual-')),dataRoot=join(dir,'data'),workspace=join(dir,'project');mkdirSync(workspace);let calls=0;
 const script=scriptedTransport([{name:'write',args:{path:'result.txt',content:'ready'}}]);
 const result=await runCodingTask({workspace,dataRoot,input:'Write result.txt with ready',mode:'offline',transport:async(url,init)=>{calls++;const r=await script.fetch(url,init);return new Response((await r.text()).replace('Controlled response: inspect actual tool evidence for acceptance.','Retained original '+'x'.repeat(90000)),{headers:r.headers});}});
 assert.equal(result.status,'completed');assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'ready');
 const source={kind:'human' as const,actor:'test host',statement:'The agreed result file is exactly ready; actual local tool evidence inspected',refs:[]};const evidence=[...records(dataRoot,{runId:result.runId,kinds:['tool.result']})].map(r=>r.id);
 recordAcceptance(dataRoot,{type:'requirements',id:'req',taskId:result.taskId,source,ruleVersion:'content-v1',necessary:[{id:'goal',description:'result.txt contains ready'}]});recordAcceptance(dataRoot,{type:'result',id:'result',taskId:result.taskId,source,requirementsId:'req',evidence});recordAcceptance(dataRoot,{type:'judgment',id:'pass',taskId:result.taskId,source,requirementsId:'req',resultId:'result',findings:[{requirementId:'goal',outcome:'PASS',evidence}],validity:'valid'});
 const beforeMaintenance=queryOperationsMetrics(dataRoot,scope),summary=scriptedTransport([]);const compact=await compactContext({dataRoot,runId:result.runId,requestId:'manual',authorization:{workspace,mode:'offline',tools:['read','write','edit','bash']},transport:async(u,i)=>{calls++;return summary.fetch(u,i);}});assert.equal(compact.compaction?.state,'applied');assert.equal(readAcceptedTasks(dataRoot).tasks.length,1);
 const failed=await runCodingTask({workspace,dataRoot,input:'Controlled provider failure',mode:'offline',transport:async()=>{calls++;return new Response('controlled service failure',{status:401});}});assert.equal(failed.status,'failed');
 const abort=new AbortController();const cancelled=await runCodingTask({workspace,dataRoot,input:'Controlled normal cancellation',mode:'offline',signal:abort.signal,cancellation:'stop',transport:async(_u,i)=>{calls++;return new Promise<Response>((_,reject)=>{i!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});},onObservation:e=>{if(e.kind==='model.dispatch')setTimeout(()=>abort.abort(),0);}});assert.equal(cancelled.status,'aborted');
 const initial=queryOperationsMetrics(dataRoot,scope);assert.equal(initial.sample.counts.N,3);assert.equal(initial.sample.counts.S,1);assert.equal(initial.costs.requests.filter(r=>r.kind==='maintenance').length,1);assert.equal(initial.costs.sample.requestIds.includes(initial.costs.requests.find(r=>r.kind==='maintenance')!.id),false);assert.equal(initial.costs.requests.filter(r=>r.runId===result.runId&&r.kind==='coding').length,beforeMaintenance.costs.requests.length);
 for(const r of initial.costs.requests.filter(r=>r.amount!==null)){recordCostEstimate(dataRoot,{id:`estimate-${r.source}`,requestSource:r.source,amount:r.amount!,currency:'USD',price:{source:'Explicit controlled fixture catalog estimate, not paid usage',version:'test-catalog-v1',effectiveAt:'2000-01-01T00:00:00Z',provider:'deepseek',model:'deepseek-flash'},usageSources:r.usageSources,reason:'Attach explicit fixture tariff provenance without changing actual response usage'});}
 const report=queryOperationsMetrics(dataRoot,scope);assert.equal(report.costs.sample.state,'partial');assert.equal(report.faults.tasks.counts.F,1);assert.equal(report.faults.tasks.counts.faultTerminated,1);assert.equal(report.faults.tasks.counts.Zf,2);assert.equal(report.faults.attempts.model.counts.cancelled,1);
 const before=readFileSync(join(dataRoot,'host.sqlite')),seq=watermark(dataRoot),callCount=calls;
 const cli=(args:string[])=>spawnSync(process.execPath,['dist/src/cli.js','operations','--data-root',dataRoot,'--scope',JSON.stringify(scope),...args],{encoding:'utf8',maxBuffer:4*1024*1024});
 const output=cli([]);assert.equal(output.status,0,output.stderr);assert.deepEqual(withoutGenerated(JSON.parse(output.stdout)),withoutGenerated(report));const text=cli(['--format','text']);assert.equal(text.status,0,text.stderr);assert.match(text.stdout,/成本与故障/);const destination=join(dir,'export.json');assert.equal(cli(['--destination',destination]).status,0);assert.deepEqual(withoutGenerated(JSON.parse(readFileSync(destination,'utf8'))),withoutGenerated(report));
 const view=new MetricsView(dataRoot,scope);view.handleInput('o');assert.deepEqual(withoutGenerated(view.operationsReport),withoutGenerated(report));view.handleInput('e');view.handleInput('\r');view.render(120,60);assert.equal(watermark(dataRoot),seq);assert.deepEqual(readFileSync(join(dataRoot,'host.sqlite')),before);assert.equal(calls,callCount);
});
