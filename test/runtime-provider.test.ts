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
 assert.equal(facts.filter(f=>f.kind==='model.response'&&(f.data as any).attemptId===attemptId).length,1);
 assert.equal(calls,2);assert.equal(budget.snapshot().requests,2);assert.equal(budget.snapshot().knownTokens,28);assert.notEqual(result.status,'completed');e.close();
});
