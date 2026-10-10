import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,readObject} from '../src/evidence.js';
import {PersistentBudget,dispatchProvider} from '../src/provider-boundary.js';
import OpenAI from 'openai';

const usageFrame='data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n';
async function checkSettlement(chunks:string[],ending:'eof'|'cancel'|'abort'|'abort-eof'|'reason'|'error'|'cancel-error'|'abort-during-cancel',known:number|null,status=200){
 const root=mkdtempSync(join(tmpdir(),'durio-budget-framing-')),e=new Evidence(root,'batch');
 const limits={maxRequests:3,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null};
 const budget=new PersistentBudget(e,'budget',limits),abort=new AbortController();let source!:ReadableStreamDefaultController<Uint8Array>;
 const response=await dispatchProvider({budget,purpose:'improve',operationId:'framing',transport:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){source=controller;for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));},cancel(){if(ending==='cancel-error')throw Error('OFFLINE_CANCEL_FAILURE');if(ending==='abort-during-cancel')abort.abort();}}),{status,headers:{'content-type':'text/event-stream'}})},'https://offline.invalid',{signal:abort.signal});
 const reader=response.body!.getReader();
 try{
  for(const _chunk of chunks)assert.equal((await reader.read()).done,false);
  if(ending==='eof'||ending==='abort-eof'){if(ending==='abort-eof')abort.abort();source.close();assert.equal((await reader.read()).done,true);}
  else if(ending==='error'){source.error(Error('OFFLINE_TRANSPORT_FAILURE'));await assert.rejects(reader.read(),/OFFLINE_TRANSPORT_FAILURE/);}
  else if(ending==='cancel-error')await assert.rejects(reader.cancel(),/OFFLINE_CANCEL_FAILURE/);
  else{if(ending==='abort')abort.abort();await reader.cancel(ending==='reason'?'explicit stop':undefined);}
  const snapshot=budget.snapshot();assert.equal(snapshot.knownTokens,known??0);assert.equal(snapshot.unknown,known===null?1:0);assert.equal(snapshot.reservedTokens,known===null?25:0);
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM records WHERE kind='budget.settle'").get()!.n,1);
  if(known===null)assert.throws(()=>budget.check(),/BUDGET_UNKNOWN_USAGE/);else assert.doesNotThrow(()=>budget.check());
  e.close();const reopened=new Evidence(root,'batch');try{assert.deepEqual(new PersistentBudget(reopened,'budget',limits).snapshot(),snapshot);}finally{reopened.close();}
 }finally{if(e.db.isOpen)e.close();}
}

test('installed SDK completion sentinel closes a live SSE body without discarding known usage or blocking the next request',async()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-budget-sdk-terminal-')),e=new Evidence(root,'batch');
 const limits={maxRequests:3,maxTokens:6000,maxRequestTokens:2000,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null};
 const budget=new PersistentBudget(e,'budget',limits),cancellations:{reason:unknown;aborted:boolean}[]=[];let calls=0;
 const transport:typeof fetch=async(_url,init)=>{
  calls++;
  const usage=calls===1?{prompt_tokens:923,completion_tokens:29,total_tokens:952}:{prompt_tokens:5,completion_tokens:2,total_tokens:7};
  const raw=`data: ${JSON.stringify({id:'offline-terminal',choices:[],usage})}\n\ndata: [DONE]\n\n`;
  // Keep the transport open after the exact usage -> DONE order. The installed
  // SDK must close it at the sentinel, before transport EOF can settle it.
  return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(raw));},cancel(reason){cancellations.push({reason,aborted:init?.signal?.aborted??false});}}),{headers:{'content-type':'text/event-stream'}});
 };
 const client=new OpenAI({apiKey:'offline-fixture',baseURL:'https://offline.invalid',maxRetries:0,fetch:(url,init)=>dispatchProvider({budget,purpose:'improve',operationId:'offline-improve',transport},url,init)});
 try{
  const consume=async()=>{let reported:number|undefined;const stream=await client.chat.completions.create({model:'offline-fixture',messages:[{role:'user',content:'fixture'}],stream:true});for await(const chunk of stream){if(chunk.usage)reported=chunk.usage.total_tokens;}return reported;};
  assert.equal(await consume(),952);
  assert.deepEqual(cancellations,[{reason:undefined,aborted:false}]);
  assert.equal(budget.snapshot().knownTokens,952);assert.equal(budget.snapshot().unknown,0);
  assert.equal(await consume(),7);assert.equal(calls,2);assert.equal(budget.snapshot().knownTokens,959);
 }finally{e.close();}
});

test('raw SSE terminal framing survives chunk splits, CRLF and CR while EOF and normal consumer close settle once',async()=>{
 for(const ending of ['cancel','eof'] as const){
  const raw=usageFrame+'data: [DONE]\n\n';
  await checkSettlement([raw.slice(0,15),raw.slice(15,-5),raw.slice(-5,-2),raw.slice(-2)],ending,7);
  const crlf=raw.replaceAll('\n','\r\n');
  await checkSettlement([...crlf],ending,7);
  await checkSettlement([raw.replaceAll('\n','\r')],ending,7);
  await checkSettlement(['data: {"usage":null}\n\ndata: {"usage":\ndata: {"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n'],ending,7);
 }
});

test('incomplete or anomalous SSE keeps its unknown reservation at EOF and consumer close',async()=>{
 const invalid=[
  'data: [DONE]\n\n', // Missing raw usage, regardless of any SDK mirror.
  usageFrame, // Usage is not completion.
  usageFrame+'data: [DON',
  usageFrame+'data: [DONE]\n', // No event delimiter.
  usageFrame+'data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":8}}\n\ndata: [DONE]\n\n',
  usageFrame+'data: {"usage":{"prompt_tokens":-1,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  'data: {"usage":{"prompt_tokens":9007199254740991,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
  usageFrame+'data: {"usage":{"prompt_tokens":6,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  usageFrame+'data: {"usage":{}}\n\ndata: [DONE]\n\n',
  usageFrame+'data: malformed JSON\n\ndata: [DONE]\n\n',
  usageFrame+'event: error\ndata: [DONE]\n\n',
  usageFrame+'data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n',
  usageFrame+'data: [DONE]\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
 ];
 for(const ending of ['eof','cancel'] as const)for(const raw of invalid)await checkSettlement([raw],ending,null);
});

test('abort, explicit cancellation, HTTP errors and transport failures stay unknown even after raw usage and DONE',async()=>{
 const raw=usageFrame+'data: [DONE]\n\n';
 for(const ending of ['abort','abort-eof','reason','error'] as const)await checkSettlement([raw],ending,null);
 for(const ending of ['eof','cancel'] as const)await checkSettlement([raw],ending,null,503);
 await checkSettlement([usageFrame],'error',null);
});

test('a failed consumer cleanup or abort during it cannot release a reservation from terminal usage',async()=>{
 for(const ending of ['cancel-error','abort-during-cancel'] as const)await checkSettlement([usageFrame+'data: [DONE]\n\n'],ending,null);
});

test('consumer cancellation retains bytes already acquired by a pending read',async()=>{
 const e=new Evidence(mkdtempSync(join(tmpdir(),'durio-budget-acquired-')),'batch'),budget=new PersistentBudget(e,'budget',{maxRequests:3,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 let source!:ReadableStreamDefaultController<Uint8Array>;
 try{
  const response=await dispatchProvider({budget,purpose:'improve',operationId:'acquired',transport:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){source=controller;}}))},'https://offline.invalid');
  const reader=response.body!.getReader(),pending=reader.read(),raw=usageFrame;
  source.enqueue(new TextEncoder().encode(raw));await reader.cancel('explicit stop');await pending;
  const rows=e.db.prepare("SELECT body FROM records WHERE kind='provider.bytes'").all();assert.equal(rows.length,1);
  const fact=JSON.parse(readObject(e.root,JSON.parse(String(rows[0].body))).toString());assert.equal(readObject(e.root,fact.bytes).toString(),raw);
  assert.equal(budget.snapshot().unknown,1);assert.equal(budget.snapshot().reservedTokens,25);
 }finally{e.close();}
});

test('non-SSE JSON keeps its existing EOF behavior without inventing usage from another response format',async()=>{
 const e=new Evidence(mkdtempSync(join(tmpdir(),'durio-budget-json-')),'batch'),budget=new PersistentBudget(e,'budget',{maxRequests:3,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 const raw=JSON.stringify({usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});
 try{const response=await dispatchProvider({budget,purpose:'generation',operationId:'json',transport:async()=>new Response(raw,{headers:{'content-type':'application/json'}})},'https://offline.invalid');assert.equal(await response.text(),raw);assert.equal(budget.snapshot().unknown,1);assert.throws(()=>budget.check(),/BUDGET_UNKNOWN_USAGE/);}finally{e.close();}
});

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

test('response limit preserves the acquired offending bytes and never refunds its dispatch',async()=>{
 const e=new Evidence(mkdtempSync(join(tmpdir(),'durio-budget-limit-')),'batch'),budget=new PersistentBudget(e,'budget',{maxRequests:5,maxTokens:100,maxRequestTokens:25,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null});
 const original='data: '+JSON.stringify({choices:[],extra:'x'.repeat(100)})+'\n\n';
 const response=await dispatchProvider({budget,purpose:'generation',operationId:'trial',maxResponseBytes:16,transport:async()=>new Response(original)},'https://api.deepseek.com/chat/completions',{body:'{}'});
 await assert.rejects(response.text(),/PROVIDER_RESPONSE_LIMIT/);
 const rows=e.db.prepare("SELECT body FROM records WHERE kind='provider.bytes'").all();assert.equal(rows.length,1);
 const {readObject}=await import('../src/evidence.js');const fact=JSON.parse(readObject(e.root,JSON.parse(String(rows[0].body))).toString());assert.equal(readObject(e.root,fact.bytes).toString(),original);
 assert.equal(budget.snapshot().requests,1);assert.equal(budget.snapshot().unknown,1);assert.throws(()=>budget.check(),/BUDGET_UNKNOWN_USAGE/);e.close();
});
