// Offline retained measurement for #125. Run after npm run build, without other
// tests/benchmarks: node scripts/measure-response-budget.mjs <1|8> <new-dir>.
// This measures host mediation plus guest decoding/provider consumption in one
// Node process. It is not a VM, whole-runtime, paid-model or statistical claim.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Evidence} from '../dist/src/evidence.js';
import {PersistentBudget,dispatchProvider} from '../dist/src/provider-boundary.js';
import {evalMediator} from '../dist/src/eval/mediator.js';
import {maxEvalOutputTokens,evalResponseBudget,EVAL_PROTOCOL_LIMITS} from '../dist/src/eval-response-budget.js';
import {providerResponseBytes} from '../dist/src/provider-response-budget.js';
import {fragmentedResponse,chunkedResponse} from '../dist/test/fixtures/provider-response.js';

globalThis.fetch=async()=>{throw Error('ISSUE125_NETWORK_FORBIDDEN');};
const maxRequests=Number(process.argv[2]),destination=process.argv[3];
if(![1,8].includes(maxRequests)||!destination)throw Error('Usage: node measure-response-budget.mjs <1|8> <new-dir>');
const directory=resolve(destination);mkdirSync(directory,{recursive:false});
const maxOutputTokens=maxEvalOutputTokens(maxRequests),baseline=process.memoryUsage(),rows=[];
const measure=(name)=>({name,...process.memoryUsage(),peakRssBytes:process.resourceUsage().maxRSS*1024});
const encoding=[];
for(const tool of [false,true])for(const escaped of [false,true]){
 const text=(escaped?'"\\\n\t':'xxxx').repeat(maxOutputTokens-1),raw=fragmentedResponse(text,{tool,completionTokens:maxOutputTokens}).bytes.toString();
 const output=JSON.stringify({status:200,contentType:'text/event-stream',body:raw}),line=JSON.stringify({kind:'model.response',id:100,output})+'\n';
 const rawBytes=Buffer.byteLength(raw),mediatorBytes=Buffer.byteLength(output),lineBytes=Buffer.byteLength(line);
 assert.ok(mediatorBytes<=Math.ceil(rawBytes*6/5)+4096);assert.ok(lineBytes<=Math.ceil(rawBytes*3/2)+8192);
 encoding.push({tool,escaped,rawBytes,mediatorBytes,lineBytes,mediatorRatio:mediatorBytes/rawBytes,lineRatio:lineBytes/rawBytes});
}
// Fill each data event to 512 bytes with SSE comments, then use the base for
// another comment. This deliberately reaches the shared finite budget exactly.
// Comment padding is synthetic stress, not a claim about typical event lengths.
const original=fragmentedResponse('xxxx'.repeat(maxOutputTokens-1),{completionTokens:maxOutputTokens}).bytes.toString();
const frames=original.split('\n\n').filter(Boolean).map(frame=>{
 if(frame==='data: [DONE]')return frame+'\n\n';
 const padded=frame+'\n:'+' '.repeat(Math.max(0,512-Buffer.byteLength(frame)-4))+'\n\n';
 assert.equal(Buffer.byteLength(padded),512);return padded;
});
let raw=frames.join('');const padding=providerResponseBytes(maxOutputTokens)-Buffer.byteLength(raw);
assert.ok(padding>=3&&padding<262144);raw=':'+' '.repeat(padding-3)+'\n\n'+raw;
const bytes=Buffer.from(raw);assert.equal(bytes.length,providerResponseBytes(maxOutputTokens));rows.push(measure('fixture-built'));
const evidence=new Evidence(join(directory,'host'),'measure');
const limits={maxRequests,maxTokens:maxRequests*(maxOutputTokens+500),maxRequestTokens:maxOutputTokens+500,deadline:new Date(Date.now()+120000).toISOString(),unknownUpperBound:null};
const plan={mode:'offline',maxOutputTokens,budget:limits,model:{endpoint:'https://offline.invalid'}},trial={id:'measure'},budget=new PersistentBudget(evidence,'measure',limits);
const mediator=evalMediator(plan,trial,budget,async()=>chunkedResponse(bytes,16381));
const envelopeBytes=[];
try{
 for(let id=1;id<=maxRequests;id++){
  const input=JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:maxOutputTokens,messages:[{role:'user',content:'Offline measurement'}]});
  const output=await mediator.request({input,maxOutputTokens,signal:new AbortController().signal});rows.push(measure('mediator-'+id));
  const line=JSON.stringify({kind:'model.response',id,output})+'\n';
  envelopeBytes.push({raw:bytes.length,mediator:Buffer.byteLength(output),line:Buffer.byteLength(line)});
  assert.ok(Buffer.byteLength(output)<=EVAL_PROTOCOL_LIMITS.responseBytes);assert.ok(Buffer.byteLength(line)<=evalResponseBudget(maxOutputTokens,maxRequests).responseLineBytes);
  const decoded=JSON.parse(JSON.parse(line).output);rows.push(measure('guest-decoded-'+id));
  const guest=await dispatchProvider({purpose:'generation',operationId:'measure',maxOutputTokens,transport:async()=>new Response(decoded.body,{status:decoded.status,headers:{'content-type':decoded.contentType}})},'https://offline.invalid');
  assert.equal(await guest.text(),raw);rows.push(measure('guest-consumed-'+id));
 }
 assert.equal(budget.snapshot().unknown,0);
 const result={scope:'offline host mediator + protocol roundtrip + guest provider boundary in one process; no VM or model inference',node:process.version,platform:process.platform,arch:process.arch,maxRequests,maxOutputTokens,limits:EVAL_PROTOCOL_LIMITS,estimate:evalResponseBudget(maxOutputTokens,maxRequests),encoding,envelopeBytes,baseline,peakRssBytes:process.resourceUsage().maxRSS*1024,rows,budget:budget.snapshot(),paidCalls:0};
 writeFileSync(join(directory,'measurement.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({directory,maxRequests,maxOutputTokens,peakRssBytes:result.peakRssBytes,encoding,envelopeBytes}));
}finally{evidence.close();}
