import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence} from '../src/evidence.js';
import {records} from '../src/history.js';
import {recordAcceptance,queryTaskMetrics} from '../src/metrics/index.js';
const root=()=>mkdtempSync(join(tmpdir(),'durio-metrics-'));
const scope={from:'2000-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z',asOf:'2100-01-01T00:00:00Z',source:'synthetic' as const};
function accepted(root:string,n:number,start=true,status?:string){const e=new Evidence(root,`run-${n}`);e.append('task.accepted',{taskId:`task-${n}`,sessionId:`session-${n}`,workspace:'/fixture',input:'known facts',taskKind:'coding',sourceClass:'synthetic'});if(start){e.append('run.started',{});e.append('execution.artifact',{id:'v1'});}if(status)e.append('run.closed',{status,cleanup:'confirmed',reason:status==='failed'?'known error':null});e.close();}
async function judgment(root:string,n:number,outcome:'PASS'|'FAIL') {const taskId=`task-${n}`,source={kind:'human' as const,actor:'fixture user',statement:'Explicit judgment of the stated necessary requirement',refs:[]};const evidence=[...records(root,{runId:`run-${n}`,kinds:['run.closed']})][0].id;
 await recordAcceptance(root,{type:'requirements',id:`req-${n}`,taskId,occurredAt:new Date().toISOString(),source,ruleVersion:'v1',necessary:[{id:'goal',description:'Deliver the agreed result'}]});
 await recordAcceptance(root,{type:'result',id:`result-${n}`,taskId,occurredAt:new Date().toISOString(),source,requirementsId:`req-${n}`,evidence:[evidence]});
 return recordAcceptance(root,{type:'judgment',id:`judgment-${n}`,taskId,occurredAt:new Date().toISOString(),source,requirementsId:`req-${n}`,resultId:`result-${n}`,findings:[{requirementId:'goal',outcome,evidence:[evidence]}],validity:'valid'});
}
test('accepted 10/8/6/5/4 example counts unstarted tasks and keeps error-but-gradable separate from completion',async()=>{const r=root();for(let n=0;n<10;n++)accepted(r,n,n<8,n<6?'completed':n<8?'failed':undefined);for(let n=0;n<4;n++)await judgment(r,n,'PASS');await judgment(r,6,'FAIL');const report=queryTaskMetrics(r,scope);assert.deepEqual(report.counts,{N:10,B:8,C:6,G:5,S:4,terminated:8});assert.equal(report.rates.success.value,0.8);assert.equal(report.rates.completion.value,0.6);assert.equal(report.rates.coverage.value,0.5);assert.equal(report.tasks[6].acceptance.outcome,'FAIL');assert.equal(report.tasks[4].acceptance.outcome,'unknown');assert.equal(report.tasks[8].version,null);});

test('judgment revisions preserve first failure, disputes, withdrawals, changed requirements and old snapshots',async()=>{
 const r=root();accepted(r,0,true,'completed');const first=await judgment(r,0,'FAIL');const original=queryTaskMetrics(r,scope);const source={kind:'human' as const,actor:'user',statement:'Explicit re-evaluation of the same final result',refs:[]};
 const evidence=[...records(r,{runId:'run-0',kinds:['run.closed']})][0].id;
 const pass={type:'judgment' as const,id:'later-pass',taskId:'task-0',source,requirementsId:'req-0',resultId:'result-0',findings:[{requirementId:'goal',outcome:'PASS' as const,evidence:[evidence]}],validity:'valid' as const};
 const receipt=recordAcceptance(r,pass);assert.equal(recordAcceptance(r,pass).repeated,true);assert.throws(()=>recordAcceptance(r,{...pass,source:{...source,statement:'changed input'}}),/ID conflicts/);
 let report=queryTaskMetrics(r,scope);assert.equal(report.counts.G,1);assert.equal(report.counts.S,0);assert.equal(report.tasks[0].acceptance.conflict,true);assert.equal(report.tasks[0].acceptance.firstValid?.source,first.source);
 const e=new Evidence(r,'run-0');e.append('feedback.rework',{reason:'original requirement correction requested'});e.close();assert.equal(queryTaskMetrics(r,scope).tasks[0].acceptance.firstValid?.source,first.source);
 recordAcceptance(r,{type:'dispute',id:'dispute',taskId:'task-0',source,targets:['judgment-0'],reason:'The purported failure evidence validity is uncertain'});
 report=queryTaskMetrics(r,scope);assert.equal(report.counts.G,0);assert.ok(report.tasks[0].acceptance.judgments.some(j=>j.outcome==='FAIL'));
 recordAcceptance(r,{type:'withdraw',id:'withdraw',taskId:'task-0',source,targets:['judgment-0'],reason:'Failure checked and explicitly withdrawn; original retained'});
 report=queryTaskMetrics(r,scope);assert.equal(report.counts.S,1);assert.equal(report.tasks[0].acceptance.firstValid?.source,receipt.source);assert.equal(report.tasks[0].acceptance.history.find(h=>h.id==='judgment-0')?.withdrawn,true);
 assert.equal(queryTaskMetrics(r,{...scope,through:original.scope.through}).id,original.id);
 recordAcceptance(r,{type:'requirements',id:'req-new',taskId:'task-0',source,ruleVersion:'v2',necessary:[{id:'goal',description:'New necessary requirement'}],revisionOf:'req-0',reason:'Explicit changed scope'});
 report=queryTaskMetrics(r,scope);assert.equal(report.counts.G,0);assert.equal(report.tasks[0].acceptance.requirementsChanged,true);
 recordAcceptance(r,{type:'withdraw',id:'withdraw-rule',taskId:'task-0',source,targets:['req-new'],reason:'New rule is invalid; cannot silently restore the old standard'});
 assert.equal(queryTaskMetrics(r,scope).counts.G,0);
});

test('incomplete, contaminated, faulty and unverified feedback remain unknown; a reliable necessary failure is enough',async()=>{
 const r=root();accepted(r,0,true,'completed');const source={kind:'human' as const,actor:'user',statement:'Two explicitly necessary requirements',refs:[]},evidence=[...records(r,{runId:'run-0',kinds:['run.closed']})][0].id;
 recordAcceptance(r,{type:'requirements',id:'req',taskId:'task-0',source,ruleVersion:'v1',necessary:[{id:'a',description:'Correctness'},{id:'b',description:'Preservation'}]});
 recordAcceptance(r,{type:'result',id:'result',taskId:'task-0',source,requirementsId:'req',evidence:[evidence]});
 for(const validity of ['valid','contaminated','faulty','insufficient'] as const){recordAcceptance(r,{type:'judgment',id:`partial-${validity}`,taskId:'task-0',source,requirementsId:'req',resultId:'result',findings:[{requirementId:'a',outcome:validity==='valid'?'PASS':'FAIL',evidence:[evidence]}],validity});}
 recordAcceptance(r,{type:'judgment',id:'thanks',taskId:'task-0',source:{...source,kind:'unverified',statement:'Thanks! The model says done.'},requirementsId:'req',resultId:'result',findings:[{requirementId:'a',outcome:'PASS',evidence:[evidence]},{requirementId:'b',outcome:'PASS',evidence:[evidence]}],validity:'valid'});
 assert.equal(queryTaskMetrics(r,scope).counts.G,0);
 recordAcceptance(r,{type:'judgment',id:'necessary-failure',taskId:'task-0',source,requirementsId:'req',resultId:'result',findings:[{requirementId:'a',outcome:'FAIL',evidence:[evidence]}],validity:'valid'});
 assert.equal(queryTaskMetrics(r,scope).counts.G,1);assert.equal(queryTaskMetrics(r,scope).counts.S,0);
});

test('withdrawing a superseding judgment or result never resurrects the invalid prior judgment',async()=>{
 const r=root();accepted(r,0,true,'completed');await judgment(r,0,'FAIL');const source={kind:'human' as const,actor:'user',statement:'The original judgment was erroneous',refs:[]},evidence=[...records(r,{runId:'run-0',kinds:['run.closed']})][0].id;
 recordAcceptance(r,{type:'judgment',id:'replacement',taskId:'task-0',source,requirementsId:'req-0',resultId:'result-0',findings:[{requirementId:'goal',outcome:'PASS',evidence:[evidence]}],validity:'valid',supersedes:['judgment-0'],reason:'Invalid original classification'});
 assert.equal(queryTaskMetrics(r,scope).counts.S,1);
 recordAcceptance(r,{type:'withdraw',id:'withdraw-replacement',taskId:'task-0',source,targets:['replacement'],reason:'Replacement also unsupported'});
 assert.equal(queryTaskMetrics(r,scope).counts.G,0);
 recordAcceptance(r,{type:'result',id:'new-result',taskId:'task-0',source,requirementsId:'req-0',evidence:[evidence],revisionOf:'result-0',reason:'New execution produced a different result'});
 recordAcceptance(r,{type:'withdraw',id:'withdraw-result',taskId:'task-0',source,targets:['new-result'],reason:'Result incorrectly attributed'});
 assert.equal(queryTaskMetrics(r,scope).tasks[0].acceptance.results.length,0);
});

test('populations, missing identity and duplicate admissions remain explicit; filters never use expected queued version',()=>{
 const r=root();accepted(r,0,true,'completed');accepted(r,1,false);
 for(const [kind,source]of [['eval','eval'],['improve','synthetic'],['maintenance','synthetic'],['coding','diagnostic']] as const){const e=new Evidence(r,kind+source);e.append('task.accepted',{taskId:kind+source,sessionId:'s',workspace:'/fixture',input:'separate population',origin:{kind,source}});e.close();}
 const legacy=new Evidence(r,'legacy');legacy.append('task.accepted',{taskId:'unknown',sessionId:'s',workspace:'/fixture',input:'no origin'});legacy.close();
 const repeated=new Evidence(r,'run-0');repeated.append('task.accepted',{taskId:'task-0',sessionId:'session-0',workspace:'/fixture',input:'known facts',taskKind:'coding',sourceClass:'synthetic'});repeated.close();
 const report=queryTaskMetrics(r,scope);assert.equal(report.counts.N,2);assert.equal(report.excluded.length,5);assert.equal(report.duplicates.length,1);assert.equal(report.unknown.taskTypes,2);assert.equal(report.unknown.executionVersions,1);
 assert.ok(report.excluded.some(t=>t.reasons.includes('unknown work kind')));assert.equal(queryTaskMetrics(r,{...scope,version:'v1'}).counts.N,1);assert.equal(queryTaskMetrics(r,{...scope,taskType:'bugfix'}).counts.N,0);assert.ok(queryTaskMetrics(r,{...scope,taskType:'bugfix'}).excluded.some(t=>t.reasons.includes('unknown task type')));
});

test('a later reliable failure changes the aggregate outcome but does not move an unwithdrawn first determinate judgment clock',async()=>{
 const r=root();accepted(r,0,true,'completed');const first=await judgment(r,0,'PASS'),evidence=[...records(r,{runId:'run-0',kinds:['run.closed']})][0].id;
 recordAcceptance(r,{type:'judgment',id:'later-failure',taskId:'task-0',source:{kind:'human',actor:'user',statement:'Reliable necessary failure found in the same unchanged final result',refs:[]},requirementsId:'req-0',resultId:'result-0',findings:[{requirementId:'goal',outcome:'FAIL',evidence:[evidence]}],validity:'valid'});
 const task=queryTaskMetrics(r,scope).tasks[0];assert.equal(task.acceptance.outcome,'FAIL');assert.equal(task.acceptance.conflict,true);assert.equal(task.acceptance.firstValid?.source,first.source);assert.equal(task.clocks.acceptanceOutcome,'PASS');
});
