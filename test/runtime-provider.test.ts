import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {PersistentBudget} from '../src/provider-boundary.js';
import {runReadTask,readRun} from '../src/runtime.js';
import {demoTransport,scriptedTransport} from '../src/offline.js';

test('actual upstream automatic compaction uses the same budget and result-only completion is recorded once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-auto-budget-')),e=new Evidence(join(root,'budget'),'budget');
 const budget=new PersistentBudget(e,'common',{maxRequests:2,maxTokens:200,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 const normal=demoTransport(),summary=scriptedTransport([]);let calls=0;
 const transport:typeof fetch=async(url,init)=>{calls++;const payload=JSON.parse(String(init?.body));return payload.tools?.length?normal.fetch(url,init):summary.fetch(url,init);};
 const result=await runReadTask({dataRoot:join(root,'data'),workspace:resolve('test/fixtures/project'),input:'Read README.md and report its contents.',mode:'offline',transport,providerBoundary:{purpose:'generation',operationId:'task',budget},verificationCompaction:{reserveTokens:999999,keepRecentTokens:1}});
 const facts=(await readRun(join(root,'data'),result.runId)).records;
 const compact=facts.filter(f=>f.kind==='model.intent'&&(f.data as any).purpose==='compaction');
 assert.equal(compact.length,1,JSON.stringify(facts.map(f=>({kind:f.kind,data:f.kind==='model.intent'?f.data:undefined}))));
 const attemptId=(compact[0].data as any).attemptId;
 assert.equal((compact[0].data as any).durableTaskId,null);
 assert.match((compact[0].data as any).durableTaskSource,/unknown/);
 assert.equal(facts.filter(f=>f.kind==='model.response'&&(f.data as any).attemptId===attemptId).length,1);
 assert.equal(calls,2);assert.equal(budget.snapshot().requests,2);assert.equal(budget.snapshot().knownTokens,28);assert.notEqual(result.status,'completed');e.close();
});

test('budgeted run identity cannot be resumed through an unbudgeted recovery entry',async()=>{
 const {recoverRun}=await import('../src/runtime.js');
 const root=mkdtempSync(join(tmpdir(),'durio-boundary-recovery-')),e=new Evidence(join(root,'budget'),'budget');
 const budget=new PersistentBudget(e,'persisted',{maxRequests:2,maxTokens:100,maxRequestTokens:50,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 const controller=new AbortController();let calls=0;
 const transport:typeof fetch=async(_url,init)=>{calls++;controller.abort();throw Error('controlled interrupted dispatch');};
 const result=await runReadTask({dataRoot:join(root,'data'),workspace:resolve('test/fixtures/project'),input:'Read README.md',mode:'offline',transport,signal:controller.signal,providerBoundary:{purpose:'generation',operationId:'original',budget}});
 const records=(await readRun(join(root,'data'),result.runId)).records;
 const config=records.find(f=>f.kind==='execution.config')!.data as any;
 assert.equal(config.providerBoundary.budget.id,'persisted');
 await assert.rejects(recoverRun({dataRoot:join(root,'data'),runId:result.runId,decision:{id:'retry',snapshotId:'unused',action:'continue'},authorization:{workspace:resolve('test/fixtures/project'),mode:'offline',tools:['read']},transport}),/PROVIDER_BOUNDARY_RECOVERY_REQUIRED/);
 assert.equal(calls,1);assert.equal(budget.snapshot().requests,1);e.close();
});
