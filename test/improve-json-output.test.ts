import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as runtime from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {IMPROVE_INSTRUCTIONS,offlineImproveTransport,readImproveReport,type ImproveRequest} from '../src/improve.js';
import {recoveryRecords} from '../src/recovery.js';
import {digest} from '../src/evidence.js';
import {candidateExecutable} from '../src/improve-contract.js';
import {deriveImproveDecision,previewImproveDecision} from '../src/improve-decisions.js';

const limits={maxRequests:3,maxTokens:30000,maxRequestTokens:10000,maxDurationMs:30000,maxOutputTokens:2048};
const report={summary:'Synthetic JSON contract check; no model inference or A1 evidence.',candidates:[],gaps:['Synthetic evidence only.']};
const json=JSON.stringify(report,null,2)+'\n';
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'durio-improve-json-'))),workspace=join(root,'project'),dataRoot=join(root,'data');
 await mkdir(workspace);await writeFile(join(workspace,'README.md'),'Synthetic JSON contract fixture.\n');
 const coding=scriptedTransport([]),source=await runtime.runCodingTask({workspace,dataRoot,input:'Synthetic source task',mode:'offline',transport:coding.fetch});
 assert.equal(source.status,'completed',JSON.stringify(source));return {root,workspace,dataRoot,source,coding};
}
function answerTransport(answer:string,finish='stop',steps:Parameters<typeof scriptedTransport>[0]=[{name:'evidence_summary',args:{}}]){
 const base=scriptedTransport(steps);
 return {calls:base.calls,fetch:(async(url,init)=>{
  const response=await base.fetch(url,init),body=(await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',()=>JSON.stringify(answer).slice(1,-1)).replace('"finish_reason":"stop"',()=>`"finish_reason":"${finish}"`);
  assert.ok(body.endsWith('data: [DONE]\n\n'));
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch};
}
function assertPayloads(dataRoot:string,runId:string,calls:unknown[]){
 const facts=[...recoveryRecords(dataRoot,runId)],payloads=facts.filter(f=>f.kind==='model.payload');
 assert.equal(payloads.length,calls.length);
 for(const [index,fact] of payloads.entries()){
  const saved=fact.data as any,intent=facts.find(f=>f.kind==='model.fetch-intent'&&(f.data as any).attemptId===saved.attemptId)!.data as any;
  const sent=facts.find(f=>f.kind==='model.dispatch'&&(f.data as any).attemptId===saved.attemptId)!.data as any;
  assert.deepEqual(saved.payload,calls[index]);assert.deepEqual(saved.payload,JSON.parse(intent.body));assert.equal(sent.body,intent.body);
  assert.ok(fact.seq<facts.find(f=>f.kind==='model.fetch-intent'&&(f.data as any).attemptId===saved.attemptId)!.seq);
  assert.match(saved.transform,/@earendil-works\/pi-ai@1\.1\.0\/openai-completions/);
  assert.doesNotMatch(JSON.stringify(saved),/"(?:authorization|api.?key|headers)"\s*:/i);
  assert.doesNotMatch(JSON.stringify(saved),/offline-transport-placeholder/);
 }
 return payloads.map(f=>f.data as any);
}
async function assertReopen(f:Awaited<ReturnType<typeof fixture>>,request:ImproveRequest,result:runtime.RunResult,provider:{calls:unknown[];fetch:typeof fetch}){
 const before=digest(await readFile(join(f.dataRoot,'host.sqlite'))),count=provider.calls.length;
 const saved=readImproveReport(f.dataRoot,request.id),again=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport:provider.fetch});
 assert.equal(saved.result.answer,result.answer);assert.equal(again.answer,result.answer);assert.equal(again.improve?.revision,result.improve?.revision);
 assert.deepEqual(saved.report?.selected,[]);assert.equal(saved.execution,'not-started');assert.equal(saved.activation,'not-enabled');
 assert.equal(provider.calls.length,count);assert.equal(digest(await readFile(join(f.dataRoot,'host.sqlite'))),before);
}

test('improve sends JSON Output with SSE, restricted tools and the existing output cap, and records the effective payload',async()=>{
 const f=await fixture(),provider=offlineImproveTransport(),request={id:'json-output',purpose:'Check synthetic JSON output',limits};
 const result=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport:provider.fetch});
 assert.equal(result.improve?.state,'complete',JSON.stringify(result));assert.equal(provider.calls.length,2);
 for(const payload of provider.calls as any[]){
  assert.deepEqual(payload.response_format,{type:'json_object'});assert.equal(payload.stream,true);assert.equal(payload.stream_options.include_usage,true);assert.equal(payload.max_tokens,2048);
  assert.deepEqual(payload.tools.map((t:any)=>t.function.name).sort(),['evidence_read','evidence_summary','source_view']);
  assert.ok(payload.tools.every((t:any)=>t.type==='function'));
  const instructions=payload.messages.find((m:any)=>m.role==='system').content;
  assert.ok(instructions.includes(IMPROVE_INSTRUCTIONS));assert.match(instructions,/only one JSON object/);assert.match(instructions,/Do not add explanation/);assert.match(instructions,/code fences/);assert.match(instructions,/\bjson\b/);
 }
 const example=IMPROVE_INSTRUCTIONS.match(/Format example[^\n]*?(\{"summary"[^\n]*?\})/);assert.ok(example,'the instructions include a parseable JSON format example');
 const shape=JSON.parse(example[1]);assert.deepEqual(shape.candidates,[]);assert.match(shape.summary,/^<.*>$/);assert.ok(shape.gaps.every((gap:string)=>/^<.*>$/.test(gap)));
 assert.match(IMPROVE_INSTRUCTIONS,/never copy this as a real analysis result/);
 for(const saved of assertPayloads(f.dataRoot,result.runId,provider.calls))assert.match(saved.transform,/pi-durio\/improve-json-output-v1/);
 for(const payload of f.coding.calls as any[])assert.equal(Object.hasOwn(payload,'response_format'),false);
 assertPayloads(f.dataRoot,f.source.runId,f.coding.calls);
 assert.equal(result.improve?.budget.requests,2);assert.equal(result.improve?.budget.knownTokens,28);assert.equal(result.improve?.budget.unknown,0);
 await assertReopen(f,request,result,provider);
});

test('automatic compaction inside the improve run shares its budget without receiving JSON Output',async()=>{
 const f=await fixture(),generation=answerTransport(json,'stop',[{name:'evidence_summary',args:{}},{name:'evidence_summary',args:{}}]),summary=scriptedTransport([]),calls:unknown[]=[];
 const transport:typeof fetch=async(url,init)=>{
  const payload=JSON.parse(String(init?.body));calls.push(payload);
  if(!payload.tools?.length)return summary.fetch(url,init);
  const response=await generation.fetch(url,init);
  if(generation.calls.length!==1)return response;
  // Synthetic context size and usage trigger the actual upstream compaction policy.
  const body=(await response.text()).split('\n\n').map(frame=>{
   if(!frame.startsWith('data: {'))return frame;
   const value=JSON.parse(frame.slice(6));
   if(value.choices[0]?.delta.tool_calls)value.choices[0].delta.content='Synthetic context padding. '.repeat(4000);
   if(value.usage)value.usage={prompt_tokens:1048000,completion_tokens:4,total_tokens:1048004};
   return `data: ${JSON.stringify(value)}`;
  }).join('\n\n');
  return new Response(body,{headers:response.headers});
 };
 const request={id:'json-compaction',purpose:'Synthetic same-run compaction isolation',limits:{...limits,maxRequests:4,maxTokens:5000000,maxRequestTokens:1100000,maxOutputTokens:32768}};
 const result=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport});
 assert.equal(result.improve?.state,'complete',JSON.stringify(result));assert.equal(summary.calls.length,1);assert.equal(generation.calls.length,3);
 const facts=[...recoveryRecords(f.dataRoot,result.runId)],saved=assertPayloads(f.dataRoot,result.runId,calls);
 for(const entry of saved){
  const intent=facts.find(f=>f.kind==='model.intent'&&(f.data as any).attemptId===entry.attemptId)!.data as any;
  assert.equal(entry.payload.stream,true);
  if(intent.purpose==='compaction'){
   assert.equal(Object.hasOwn(entry.payload,'response_format'),false);assert.doesNotMatch(entry.transform,/improve-json-output/);assert.equal(entry.payload.max_tokens,13107);
  }else{assert.equal(intent.purpose,'improve');assert.deepEqual(entry.payload.response_format,{type:'json_object'});assert.equal(entry.payload.max_tokens,32768);}
 }
 assert.equal(facts.filter(f=>f.kind==='model.intent'&&(f.data as any).purpose==='compaction').length,1);
 assert.equal(result.improve?.budget.requests,4);assert.equal(result.improve?.budget.knownTokens,1048046);assert.equal(result.improve?.budget.unknown,0);
});

test('eval ordinary generation keeps its trusted provider boundary and receives no JSON Output',async()=>{
 const f=await fixture(),provider=scriptedTransport([]);
 const result=await runtime.runReadTask({workspace:f.workspace,dataRoot:f.dataRoot,input:'Synthetic eval generation',mode:'offline',taskOrigin:{kind:'eval',source:'synthetic'},providerBoundary:{purpose:'eval-runtime',operationId:'synthetic-eval',maxOutputTokens:64},transport:provider.fetch});
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(provider.calls.length,1);
 const payload=provider.calls[0] as any;assert.equal(Object.hasOwn(payload,'response_format'),false);assert.equal(payload.stream,true);assert.equal(payload.max_tokens,64);
 for(const entry of assertPayloads(f.dataRoot,result.runId,provider.calls))assert.doesNotMatch(entry.transform,/improve-json-output/);
});

for(const variant of [
 {name:'pure-json-zero-candidates',answer:json,complete:true},
 {name:'explanation-and-fence',answer:`我收集的证据已足够。这是合成格式回归。\n\n\`\`\`json\n${json}\`\`\``,complete:false},
 {name:'fence-only',answer:`\`\`\`json\n${json}\`\`\``,complete:false},
 {name:'explanation-only',answer:`合成说明。\n${json}`,complete:false},
 {name:'malformed-json',answer:'{"summary":"synthetic","candidates":[],"gaps":[}',complete:false},
 {name:'empty-content',answer:'',complete:false},
 {name:'truncated-json',answer:'{"summary":"synthetic","candidates":[',finish:'length',complete:false},
 {name:'oversized-report',answer:' '.repeat(131073),complete:false,reason:/IMPROVE_REPORT_LIMIT/}
])test(`strict improve report keeps the original answer: ${variant.name}`,async()=>{
 const f=await fixture(),provider=answerTransport(variant.answer,variant.finish),request={id:variant.name,purpose:'Synthetic strict JSON regression',limits:{...limits,maxRequests:2}};
 const result=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport:provider.fetch});
 assert.equal(result.improve?.state,variant.complete?'complete':'incomplete',JSON.stringify(result));assert.equal(result.answer,variant.answer);
 assert.deepEqual(result.improve?.candidates,[]);assert.deepEqual(result.improve?.selected,[]);
 if(variant.complete){assert.equal(result.improve?.reason,null);assert.equal(result.improve?.summary,report.summary);}else assert.match(result.improve?.reason??'',variant.reason??/SyntaxError/);
 assert.equal(provider.calls.length,2);assert.equal(result.improve?.budget.requests,2);assert.equal(result.improve?.budget.knownTokens,28);assert.equal(result.improve?.budget.unknown,0);
 const response=[...recoveryRecords(f.dataRoot,result.runId)].filter(f=>f.kind==='model.response').at(-1)!.data as any;
 assert.equal(response.message.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n'),variant.answer);
 await assertReopen(f,request,result,provider);
});

test('valid JSON still rejects invalid candidate contracts, unacquired citations, unknown targets and undeclared scope',async()=>{
 const f=await fixture();
 const candidate={title:'Synthetic suggestion',problem:'Synthetic contract check',objective:'maintenance',targetId:'project',facts:[{claim:'Acquired summary',evidence:[] as string[]}],hypotheses:[],successCounterexamples:[],gaps:['No actual inference'],mechanismsReviewed:['README.md'],steps:['Review declared source'],scope:['README.md'],validation:{method:'direct',checks:['Review content'],budget:'No model calls',protections:['Preserve content']},risks:['Synthetic only'],rollback:'Keep original bytes',activation:{writeback:true,enable:false,conditions:['Explicit selection and checks'],timing:'After user selection'},dependencies:[],conflicts:[]};
 for(const variant of ['candidate-contract','citation','target','scope','suggestion-only','missing-replacements','missing-checks','executable'] as const){
  const base=answerTransport('','stop'),provider={calls:base.calls,fetch:(async(url,init)=>{
   const payload=JSON.parse(String(init?.body)),reply=payload.messages.find((m:any)=>m.role==='tool');
   if(!reply)return base.fetch(url,init);
   const c={...candidate,facts:[{claim:'Acquired summary',evidence:[JSON.parse(reply.content).sourceId]}],
    ...(['missing-checks','executable'].includes(variant)?{replacements:[{path:'README.md',before:'Synthetic JSON contract fixture.',content:'Updated synthetic fixture.'}]}:{}),
    ...(['missing-replacements','executable'].includes(variant)?{structuredChecks:[{kind:'direct',program:'throw Error("analysis must never execute a check")',timeoutMs:1000}]}:{})};
   if(variant==='candidate-contract')c.validation={...c.validation,checks:[]};
   if(variant==='citation')c.facts[0].evidence=['e1:unacquired'];
   if(variant==='target')c.targetId='not-registered';
   if(variant==='scope')c.scope=['outside.md'];
   const response=await base.fetch(url,init),answer=JSON.stringify({...report,candidates:[c]});
   return new Response((await response.text()).replace('"content":""',()=>`"content":${JSON.stringify(answer)}`),{headers:response.headers});
  }) as typeof fetch};
  const request={id:variant,purpose:'Synthetic candidate contract regression',limits,sources:[{id:'project',kind:'project' as const,paths:['README.md']}]};
  const result=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport:provider.fetch});
  const valid=['suggestion-only','missing-replacements','missing-checks','executable'].includes(variant);
  assert.equal(result.improve?.state,valid?'complete':'incomplete',JSON.stringify(result));assert.equal(provider.calls.length,2);
  if(valid){
   const saved=result.improve!.candidates[0];assert.equal(saved.suggestionOnly,variant!=='executable');assert.equal(candidateExecutable(saved),variant==='executable');assert.equal(saved.selection,'unselected');assert.equal(saved.execution,'not-started');assert.equal(saved.effect,'unverified');
   if(saved.suggestionOnly)for(const mode of ['validate-only','execute-declared-scope'] as const)assert.throws(()=>previewImproveDecision(f.dataRoot,deriveImproveDecision(f.dataRoot,request.id,[{candidateId:saved.id,mode}],{id:mode,directory:join(f.root,mode)})),/SUGGESTION_ONLY/);
  }else{
   assert.deepEqual(result.improve?.candidates,[]);
   assert.match(result.improve?.reason??'',variant==='target'?/IMPROVE_CANDIDATE_TARGET_INVALID/:variant==='scope'?/IMPROVE_CANDIDATE_SCOPE_DENIED/:/IMPROVE_CANDIDATE_CONTRACT_INCOMPLETE/);
  }
  assert.equal(await readFile(join(f.workspace,'README.md'),'utf8'),'Synthetic JSON contract fixture.\n');
  assert.equal([...recoveryRecords(f.dataRoot,result.runId)].filter(f=>/^improve\.(decision|validation|write|activation)/.test(f.kind)).length,0);
  await assertReopen(f,request,result,provider);
 }
});

test('cancellation retains the acquired original response and readonly reopen cannot request a repaired report',async()=>{
 const f=await fixture(),provider=answerTransport(json),abort=new AbortController();let responses=0;
 const request={id:'cancelled-json',purpose:'Synthetic cancellation retention',limits};
 const result=await runtime.analyzeImprove({workspace:f.workspace,dataRoot:f.dataRoot,targetRunId:f.source.runId,request,mode:'offline',transport:provider.fetch,signal:abort.signal,cancellation:'stop',onObservation:event=>{if(event.kind==='model.response'&&++responses===2)abort.abort();}});
 assert.equal(result.status,'aborted',JSON.stringify(result));assert.equal(result.improve?.state,'incomplete');assert.equal(provider.calls.length,2);
 const facts=[...recoveryRecords(f.dataRoot,result.runId)],response=facts.filter(f=>f.kind==='model.response').at(-1)!.data as any;
 assert.equal(response.message.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n'),json);
 await assertReopen(f,request,result,provider);
 assert.deepEqual([...recoveryRecords(f.dataRoot,result.runId)],facts);
});
