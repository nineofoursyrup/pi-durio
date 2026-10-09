import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence} from '../src/evidence.js';
import {queryTaskMetrics} from '../src/metrics/index.js';
// Explicit known-fact fixture writer. These records are synthetic originals,
// inserted once with literal times; no real runtime timestamps are rewritten.
const t0=Date.parse('2026-01-01T09:00:00Z');
function fixture(){const root=mkdtempSync(join(tmpdir(),'durio-metric-clocks-'));return{root,e:new Evidence(root,'run')};}
function fact(e:Evidence,kind:string,minute:number,data:any={},processId:string|null='fixture-process',monotonicMs=minute*60000) {
 const at=new Date(t0+minute*60000).toISOString(),value={...data,...processId?{clock:{wallTime:at,processId,monotonicMs}}:{}},body=e.blob(JSON.stringify(value));
 const row=e.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(e.runId,kind,at,JSON.stringify(body));return`e1:${row.lastInsertRowid}:${body.sha256}`;
}
const scope={from:'2026-01-01T09:00:00Z',to:'2026-01-01T09:01:00Z',asOf:'2026-01-03T00:00:00Z',source:'synthetic' as const};
function admit(e:Evidence){return fact(e,'task.accepted',0,{taskId:'task',sessionId:'session',workspace:'/fixture',input:'fixture',origin:{kind:'coding',source:'synthetic'}});}
function grade(e:Evidence,evidence:string){
 const source={kind:'human',actor:'fixture user',statement:'Explicit final-result acceptance',refs:[]};
 const base={taskId:'task',source,requestIdentity:'fixture',receivedAt:'2026-01-02T09:00:00.000Z',occurredAt:'2026-01-02T09:00:00.000Z',timeSource:'host-receipt'};
 fact(e,'acceptance.requirements',1440,{...base,type:'requirements',id:'req',ruleVersion:'v1',necessary:[{id:'goal',description:'The agreed outcome'}]});
 fact(e,'acceptance.result',1440,{...base,type:'result',id:'result',requirementsId:'req',evidence:[evidence]});
 fact(e,'acceptance.judgment',1440,{...base,type:'judgment',id:'judgment',requirementsId:'req',resultId:'result',validity:'valid',findings:[{requirementId:'goal',outcome:'PASS',evidence:[evidence]}]});
}
test('literal 12-minute execution and 24-hour acceptance preserve queue/user/active portions without counting child overlaps twice',()=>{
 const{root,e}=fixture();admit(e);fact(e,'run.started',2);fact(e,'execution.artifact',2,{id:'actual'});
 fact(e,'model.intent',2,{attemptId:'m'});fact(e,'tool.dispatch',3,{attemptId:'nested'});fact(e,'tool.result',4,{attemptId:'nested'});fact(e,'model.response',5,{attemptId:'m'});
 fact(e,'task.phase',5,{id:'wait',phase:'user-wait',action:'start'});fact(e,'task.phase',8,{id:'wait',phase:'user-wait',action:'end'});
 fact(e,'tool.dispatch',8,{attemptId:'tool'});fact(e,'tool.result',12,{attemptId:'tool'});const closed=fact(e,'run.closed',12,{status:'completed',cleanup:'confirmed'});grade(e,closed);e.close();
 const report=queryTaskMetrics(root,scope),clocks=report.tasks[0].clocks;
 assert.equal(clocks.execution.milliseconds,12*60000);assert.equal(clocks.acceptance.milliseconds,24*3600000);
 assert.deepEqual(clocks.partition.measured,{queue:2*60000,'user-wait':3*60000,active:7*60000,'recovery-offline':0,unknown:0});assert.equal(clocks.partition.overlapMs,0);assert.equal(report.clocks.execution.valid,1);
 assert.equal(queryTaskMetrics(root,{...scope,to:scope.from}).counts.N,0);
});
test('same-task recovery spans no new admission; unfinished, cross-process and missing endpoints stay out of exact means',()=>{
 const{root,e}=fixture();admit(e);fact(e,'run.started',2);fact(e,'model.intent',2,{attemptId:'first'});fact(e,'model.response',3,{attemptId:'first'});fact(e,'run.closed',5,{status:'unknown',cleanup:'confirmed',lifecycle:{disposition:'resumable'}});fact(e,'recovery.report',6,{status:'needs-decision'});const before=Number(e.db.prepare('SELECT MAX(seq) AS n FROM records').get()!.n);
 assert.equal(queryTaskMetrics(root,scope).counts.terminated,0);assert.equal(queryTaskMetrics(root,scope).clocks.execution.pending,1);
 fact(e,'recovery.started',20,{},'second-process',10);fact(e,'model.intent',21,{attemptId:'retry'},'second-process',60010);fact(e,'model.response',22,{attemptId:'retry'},'second-process',120010);fact(e,'recovery.closed',30,{result:{status:'completed',cleanup:'confirmed'}},'second-process',600010);e.close();
 const report=queryTaskMetrics(root,scope);assert.equal(report.counts.N,1);assert.equal(report.counts.B,1);assert.equal(report.counts.C,1);assert.equal(report.clocks.execution.valid,0);assert.equal(report.clocks.execution.missing,1);assert.equal(report.tasks[0].clocks.execution.state,'unknown');assert.ok(report.tasks[0].clocks.segments.some(s=>s.kind==='recovery-offline'));
 const old=queryTaskMetrics(root,{...scope,through:before});assert.equal(old.counts.terminated,0);assert.equal(old.clocks.execution.mean,null);
 const asOf=queryTaskMetrics(root,{...scope,asOf:'2026-01-01T09:10:00Z'});assert.equal(asOf.counts.C,0);assert.equal(asOf.snapshot.through,before);
});
test('clock rollback cannot fabricate cross-process elapsed time, and incompatible overlapping phases become unknown',()=>{
 const{root,e}=fixture();admit(e);fact(e,'run.started',2);fact(e,'model.intent',2,{attemptId:'m'});fact(e,'task.phase',3,{id:'w',phase:'user-wait',action:'start'});fact(e,'task.phase',5,{id:'w',phase:'user-wait',action:'end'});fact(e,'model.response',6,{attemptId:'m'});fact(e,'run.closed',7,{status:'completed',cleanup:'confirmed'});e.close();
 const clocks=queryTaskMetrics(root,scope).tasks[0].clocks;assert.equal(clocks.partition.overlapMs,2*60000);assert.equal(clocks.partition.measured.unknown,3*60000);
 const f=fixture();admit(f.e);fact(f.e,'run.started',2);fact(f.e,'run.closed',-1,{status:'failed',cleanup:'confirmed'},'second-process',10);f.e.close();const report=queryTaskMetrics(f.root,scope);assert.equal(report.tasks[0].clocks.execution.milliseconds,null);assert.equal(report.tasks[0].clocks.execution.wallEstimateMs,null);assert.equal(report.tasks[0].clocks.rollback,true);
});
test('unstarted withdrawn follow-up remains in N and has an execution endpoint; expected version does not become actual',()=>{
 const{root,e}=fixture();const target={taskId:'parent',runId:'run',sessionId:'session',workspace:'/fixture'};fact(e,'task.accepted',-10,{...target,input:'parent',mode:'offline'});fact(e,'run.started',-9);fact(e,'run.closed',-1,{status:'completed',cleanup:'confirmed'});
 fact(e,'control.accepted',0,{kind:'follow-up',requestId:'queued',taskId:'task',input:'next',target,origin:{kind:'coding',source:'synthetic'},executionVersion:{artifactId:'expected-only',configSeq:0,artifactSeq:0}});fact(e,'control.accepted',.2,{kind:'steer',requestId:'steer',taskId:'parent',input:'direction',target});fact(e,'control.receipt',1,{requestId:'queued',status:'frozen',reason:'held'});fact(e,'control.receipt',3,{requestId:'queued',status:'withdrawn',reason:'explicit cancellation before start'});e.close();
 const report=queryTaskMetrics(root,scope);assert.deepEqual(report.counts,{N:1,B:0,C:0,G:0,S:0,terminated:1});assert.equal(report.tasks[0].clocks.execution.milliseconds,3*60000);assert.equal(report.tasks[0].version,null);assert.equal(report.rates.success.state,'N/A');assert.equal(report.rates.coverage.value,0);
 const filtered=queryTaskMetrics(root,{...scope,version:'expected-only'});assert.equal(filtered.counts.N,0);assert.ok(filtered.excluded[0].reasons.includes('unknown actual execution version'));assert.equal(filtered.rates.coverage.state,'N/A');
});

test('first host judgment survives wall rollback, while incomparable reported occurrences keep acceptance time unknown',()=>{
 for(const reported of [false,true]){const{root,e}=fixture();admit(e);fact(e,'run.started',1);const evidence=fact(e,'run.closed',2,{status:'completed',cleanup:'confirmed'}),source={kind:'human',actor:'fixture user',statement:'Explicit necessary result judgment',refs:[]};
  const base={taskId:'task',source,requestIdentity:'fixture',receivedAt:'2026-01-01T09:03:00Z',occurredAt:'2026-01-01T09:03:00Z',timeSource:'host-receipt'};
  fact(e,'acceptance.requirements',3,{...base,type:'requirements',id:'req',ruleVersion:'v1',necessary:[{id:'goal',description:'Required result'}]});fact(e,'acceptance.result',3,{...base,type:'result',id:'result',requirementsId:'req',evidence:[evidence]});
  const a=fact(e,'acceptance.judgment',10,{...base,receivedAt:'2026-01-01T09:10:00Z',occurredAt:'2026-01-01T09:10:00Z',type:'judgment',id:'first',requirementsId:'req',resultId:'result',validity:'valid',findings:[{requirementId:'goal',outcome:'PASS',evidence:[evidence]}]},'fixture-process',600000);
  fact(e,'acceptance.judgment',5,{...base,receivedAt:'2026-01-01T09:05:00Z',occurredAt:'2026-01-01T09:05:00Z',timeSource:reported?'reported-occurrence':'host-receipt',type:'judgment',id:'later',requirementsId:'req',resultId:'result',validity:'valid',findings:[{requirementId:'goal',outcome:'FAIL',evidence:[evidence]}]},'fixture-process',900000);e.close();
  const result=queryTaskMetrics(root,scope).tasks[0];assert.equal(result.acceptance.outcome,'FAIL');if(reported){assert.equal(result.clocks.acceptance.state,'unknown');assert.equal((result.acceptance as any).firstValidOrder.reliability,'unverified');}else{assert.equal(result.acceptance.firstValid?.source,a);assert.equal(result.clocks.acceptance.milliseconds,600000);assert.equal(result.clocks.acceptanceOutcome,'PASS');}
 }
});
