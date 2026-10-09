import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {PersistentBudget,dispatchProvider} from '../src/provider-boundary.js';

test('one persisted budget admits generation, compaction, retry and grading; reopening never resets reservations',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-budget-')),e=new Evidence(root,'batch');
 const limits={maxRequests:4,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null};
 let budget=new PersistentBudget(e,'budget',limits),calls=0;
 const fetcher:typeof fetch=async()=>{calls++;return new Response('data: '+JSON.stringify({usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}})+'\n\ndata: [DONE]\n\n');};
 for(const purpose of ['generation','compaction','generation','grading'] as const){await (await dispatchProvider({budget,purpose,operationId:'op',transport:fetcher},'https://api.deepseek.com/chat/completions',{method:'POST',body:'{}'})).text();}
 e.close();const reopened=new Evidence(root,'batch');budget=new PersistentBudget(reopened,'budget',limits);
 await assert.rejects(dispatchProvider({budget,purpose:'grading',operationId:'other',transport:fetcher},'https://api.deepseek.com/chat/completions',{body:'{}'}),/BUDGET_REQUEST_LIMIT/);
 assert.equal(calls,4);assert.equal(budget.snapshot().knownTokens,28);assert.equal(budget.snapshot().requests,4);reopened.close();
});

test('unknown and cancelled requests retain admission across restart and block new work without a proven bound',async()=>{
 for(const failure of ['unknown','cancelled']){
  const root=mkdtempSync(join(tmpdir(),'durio-budget-')),e=new Evidence(root,'batch');
  const limits={maxRequests:5,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null};
  const budget=new PersistentBudget(e,'budget',limits);let calls=0;
  const transport:typeof fetch=async()=>{calls++;return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n');};
  const response=await dispatchProvider({budget,purpose:'generation',operationId:'trial-1',transport},'https://api.deepseek.com/chat/completions',{body:'{}'});
  if(failure==='cancelled')await response.body!.cancel();else await response.text();
  await assert.rejects(dispatchProvider({budget,purpose:'compaction',operationId:'trial-1',transport},'https://api.deepseek.com/chat/completions',{body:'{}'}),/BUDGET_UNKNOWN_USAGE/);
  assert.equal(calls,1);assert.equal(budget.snapshot().requests,1);assert.equal(budget.snapshot().reservedTokens,25);assert.equal(budget.snapshot().knownTokens,0);e.close();
 }
});
test('budget rejects expired plans and never sends when acquired original cannot be retained',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-budget-'));let fail=false,calls=0;
 const e=new Evidence(root,'batch',kind=>{if(fail&&kind==='provider.dispatch')throw Error('ORIGINAL_DISK_FULL');});
 const limits={maxRequests:5,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null};
 const budget=new PersistentBudget(e,'budget',limits);fail=true;
 await assert.rejects(dispatchProvider({budget,purpose:'grading',operationId:'grade',transport:async()=>{calls++;return new Response('');}},'https://api.deepseek.com/chat/completions',{body:'{}'}),/ORIGINAL_DISK_FULL/);
 assert.equal(calls,0);assert.equal(budget.snapshot().requests,1);assert.equal(budget.snapshot().unknown,1);e.close();
 const e2=new Evidence(mkdtempSync(join(tmpdir(),'durio-budget-')),'batch');
 const expired=new PersistentBudget(e2,'expired',{...limits,deadline:'2020-01-01T00:00:00.000Z'});assert.throws(()=>expired.reserve('generation','op'),/BUDGET_DEADLINE/);e2.close();
});
