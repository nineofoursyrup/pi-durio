#!/usr/bin/env node
/** Real installed runner/VM with synthetic HTTP only; never authenticates. */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {installed,authenticationStop,save} from './common.mjs';
const [installArg,linuxArg,outArg,reuseRoot]=process.argv.slice(2);
if(!outArg)throw Error('Usage: check-auth-stop.mjs INSTALL LINUX_RUNTIME NEW_OUTPUT');
const api=await installed(resolve(installArg)),out=resolve(outArg);mkdirSync(out);
const results=[];
for(const status of [401,403]){
 const dataRoot=reuseRoot?resolve(reuseRoot):join(out,'data'),id=`synthetic-auth-${status}-${Date.now()}`,controller=new AbortController();
 const guard=authenticationStop(api,dataRoot,id,controller);
 await api.eval.prepareEval({dataRoot,id,purpose:'Synthetic HTTP auth failure must stop all remaining listed trials independently of usage body',installation:resolve(linuxArg),mode:'offline',budget:{maxRequests:8,maxTokens:100000,maxRequestTokens:256,deadline:new Date(Date.now()+900000).toISOString(),unknownUpperBound:{tokens:256,source:'synthetic bound for controlled response'}},trialTimeoutMs:60000,maxOutputTokens:128,trials:[{id:`auth-${status}-first`,caseId:'local-fix',side:'candidate',repeat:1,pair:null},{id:`auth-${status}-must-not-start`,caseId:'multi-file',side:'candidate',repeat:1,pair:null}]});
 let calls=0;
 const raw='data: '+JSON.stringify({usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n';
 const report=await api.eval.runEval({dataRoot,id,directory:join(out,`execution-${status}`),signal:controller.signal,fault:guard.fault,transportForTrial:()=>async()=>{calls++;return new Response(raw,{status,headers:{'content-type':'text/event-stream'}});}});
 save(join(out,`report-${status}.json`),report);
 assert.equal(calls,1,'auth failure cannot dispatch a second request despite settled usage');
 assert.equal(report.trials[1].outcome.status,'not-run');assert.equal(report.trials[1].outcome.started,false);
 const facts=api.query.readRunRecords(dataRoot,id,{limit:50,kinds:['provider.http','provider.bytes','budget.settle','budget.reserve']}).records.map(r=>({kind:r.kind,data:JSON.parse(api.runtime.readObject(dataRoot,r.ref))}));
 assert.equal(facts.filter(r=>r.kind==='budget.reserve').length,1);
 assert.equal(facts.find(r=>r.kind==='budget.settle').data.tokens,2,'usage-bearing error must not be the reason the batch stops');
 const acquired=facts.filter(r=>r.kind==='provider.bytes').map(r=>api.runtime.readObject(dataRoot,r.data.bytes));assert.equal(Buffer.concat(acquired).toString(),raw);
 assert.equal(guard.stopped.reason,`PROVIDER_HTTP_${status}`);
 results.push({status,calls,stop:guard.stopped,first:report.trials[0].outcome.status,remaining:report.trials[1].outcome.status,rawPreserved:true,settledTokens:2});
}
save(join(out,'summary.json'),{status:'PASS',provenance:'Synthetic HTTP responses through real installed runner, budget ledger and restricted VM. No real provider requests or credential reads.',results});console.log(JSON.stringify(results));
