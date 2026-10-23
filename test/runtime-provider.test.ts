import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {PersistentBudget} from '../src/provider-boundary.js';
import {runReadTask,readRun} from '../src/runtime.js';
import {demoTransport,scriptedTransport} from '../src/offline.js';
import {fragmentedResponse,chunkedResponse,issue124JSON} from './fixtures/provider-response.js';

test('actual upstream automatic compaction uses the same budget and result-only completion is recorded once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-auto-budget-')),e=new Evidence(join(root,'budget'),'budget');
 const budget=new PersistentBudget(e,'common',{maxRequests:2,maxTokens:200,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 const normal=demoTransport(),summary=scriptedTransport([]);let calls=0;
 const transport:typeof fetch=async(url,init)=>{calls++;const payload=JSON.parse(String(init?.body));return payload.tools?.length?normal.fetch(url,init):summary.fetch(url,init);};
 // The high reserve triggers compaction; its output remains within a legal cap.
 const result=await runReadTask({dataRoot:join(root,'data'),workspace:resolve('test/fixtures/project'),input:'Read README.md and report its contents.',mode:'offline',transport,providerBoundary:{purpose:'generation',operationId:'task',budget,maxOutputTokens:32},verificationCompaction:{reserveTokens:999999,keepRecentTokens:1}});
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

test('inherited output limits cover long automatic compaction and preserve unknown reservations',async()=>{
 for(const usage of [true,false]){
  const root=mkdtempSync(join(tmpdir(),'durio-long-compaction-')),e=new Evidence(join(root,'budget'),'budget');
  const budget=new PersistentBudget(e,'common',{maxRequests:3,maxTokens:30000,maxRequestTokens:10000,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
  const normal=demoTransport();let summaries=0;const sentLimits:number[]=[];
  const transport:typeof fetch=async(url,init)=>{const payload=JSON.parse(String(init?.body));sentLimits.push(payload.max_tokens);if(payload.tools?.length)return normal.fetch(url,init);summaries++;return chunkedResponse(fragmentedResponse(issue124JSON,{usage}).bytes,64003);};
  try{
   const result=await runReadTask({dataRoot:join(root,'data'),workspace:resolve('test/fixtures/project'),input:'Read README.md and report its contents.',mode:'offline',transport,providerBoundary:{purpose:'generation',operationId:'task',budget,maxOutputTokens:6000},verificationCompaction:{reserveTokens:999999,keepRecentTokens:1}});
   const facts=[];let after:number|undefined;
   do{const page=await readRun(join(root,'data'),result.runId,{after});facts.push(...page.records);after=page.next??undefined;}while(after);
   const compaction=facts.find(f=>f.kind==='model.response'&&(f.data as any).purpose==='compaction')?.data as any;
   assert.equal(summaries,1);assert.ok(sentLimits.every(n=>n===6000));assert.equal(compaction?.message.stopReason,'stop');
   assert.equal(compaction.message.content[0].text,issue124JSON);assert.equal(compaction.usage,usage?'reported':'unknown');
   assert.equal(budget.snapshot().unknown,usage?0:1);assert.equal(budget.snapshot().reservedTokens,usage?0:10000);
   if(!usage){assert.equal(sentLimits.length,2);assert.equal(result.status,'failed');assert.throws(()=>budget.check(),/BUDGET_UNKNOWN_USAGE/);assert.equal((facts.findLast(f=>f.kind==='model.dispatch-failed')?.data as any).reason,'BUDGET_UNKNOWN_USAGE');}
  }finally{e.close();}
 }
});
