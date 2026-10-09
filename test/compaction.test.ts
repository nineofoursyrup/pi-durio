import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCodingTask,TaskControl,readAcceptedTasks,readQueue} from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {recoveryRecords} from '../src/recovery.js';

async function fixture(){const root=await mkdtemp(join(tmpdir(),'durio-compact-'));const workspace=join(root,'project');await mkdir(workspace);await writeFile(join(workspace,'wait.cjs'),"console.log('started');setTimeout(()=>console.log('finished'),250)");return {workspace,dataRoot:join(root,'data')};}
test('busy compact is deduplicated, steer reaches its tool boundary and maintenance creates no coding sample',async()=>{
 const paths=await fixture(),control=new TaskControl(),script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);let actions:Promise<void>|undefined;
 const result=await runCodingTask({...paths,input:'Run fixture',mode:'offline',transport:script.fetch,control,onObservation:e=>{if(e.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;const first=await control.submit({id:'compact-1',kind:'compact',input:'compact',target});const repeat=await control.submit({id:'compact-2',kind:'compact',input:'compact',target});assert.equal(repeat.requestId,first.requestId);await control.submit({id:'steer',kind:'steer',input:'KEEP STEERING',target});})();}});await actions;
 assert.equal(result.status,'completed');assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,1);
 assert.equal(readQueue(paths.dataRoot).items.find(i=>i.kind==='compact')?.status,'applied');
 assert.match(JSON.stringify(script.calls[1]),/KEEP STEERING/);assert.equal(script.calls.length,2,'short context is a public durable noop without provider dispatch');
 assert.ok(recoveryRecords(paths.dataRoot).some(r=>r.kind==='compaction.finished'&&(r.data as any).state==='noop'));
});

async function longSource(paths:Awaited<ReturnType<typeof fixture>>,extra:any={}){
 const base=scriptedTransport([]);
 const transport:typeof fetch=async(url,init)=>{const response=await base.fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.','FINAL '+ 'x'.repeat(90000)),{headers:{'content-type':'text/event-stream'}});};
 return runCodingTask({...paths,input:'ORIGINAL USER OBJECTIVE',mode:'offline',transport,...extra});
}
test('idle manual compaction uses the public summary submission, retains originals and deduplicates a repeated request',async()=>{
 const {compactContext}=await import('../src/runtime.js');const {readCompactions}=await import('../src/compaction.js');
 const paths=await fixture(),initial=await longSource(paths),summary=scriptedTransport([]);
 const options={...paths,runId:initial.runId,requestId:'idle-1',authorization:{workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const},transport:summary.fetch};
 const compact=await compactContext(options);
 assert.equal(compact.compaction?.state,'applied',JSON.stringify(compact));assert.equal(summary.calls.length,1);
 assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,1);
 const facts=recoveryRecords(paths.dataRoot,initial.runId);
 assert.ok(facts.some(r=>r.kind==='model.response'&&JSON.stringify(r.data).includes('x'.repeat(90000))));
 assert.ok(facts.some(r=>r.kind==='compaction.source'&&JSON.stringify(r.data).includes('ORIGINAL USER OBJECTIVE')));
 assert.equal((facts.findLast(r=>r.kind==='model.intent')?.data as any).allocation,'maintenance');
 assert.equal((facts.findLast(r=>r.kind==='model.intent')?.data as any).maintenanceRequestId,'idle-1');
 assert.ok(readCompactions(paths.dataRoot,initial.runId).items.some(r=>r.kind==='compaction.submission'&&(r.data as any).submission.status==='done'));
 assert.deepEqual((await compactContext(options)).compaction,compact.compaction);assert.equal(summary.calls.length,1);
 const noop=await compactContext({...options,requestId:'idle-2'});assert.equal(noop.compaction?.state,'noop');assert.equal(summary.calls.length,1);
});

test('manual summary is the verified context of a later independent task; wrong workspace never silently starts fresh',async()=>{
 const {compactContext}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),summary=scriptedTransport([]);
 await compactContext({...paths,runId:initial.runId,requestId:'prepare-next',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},transport:summary.fetch});
 const later=scriptedTransport([]),next=await runCodingTask({...paths,input:'NEXT INDEPENDENT TASK',contextRunId:initial.runId,mode:'offline',transport:later.fetch});
 assert.equal(next.status,'completed');assert.notEqual(next.runId,initial.runId);assert.notEqual(next.taskId,initial.taskId);
 assert.match(JSON.stringify(later.calls),/conversation history before this point was compacted/);assert.match(JSON.stringify(later.calls),/NEXT INDEPENDENT TASK/);
 assert.doesNotMatch(JSON.stringify(later.calls),/ORIGINAL USER OBJECTIVE/,'summary replaces source in model context but originals remain on disk');
 const other=join(paths.workspace,'nested');await mkdir(other);
 await assert.rejects(runCodingTask({...paths,workspace:other,input:'Do not silently start fresh',contextRunId:initial.runId,mode:'offline',transport:later.fetch}),/CONTEXT_EXECUTION_CONFIGURATION_CHANGED/);assert.equal(later.calls.length,1);
});

test('follow-up then compact then follow-up uses committed context lineage and preserves original admission target',async()=>{
 const paths=await fixture(),control=new TaskControl();let calls=0,actions:Promise<void>|undefined,originalRun:string|undefined;
 const first=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
 const transport:typeof fetch=async(url,init)=>{calls++;const body=JSON.parse(String(init?.body));if(calls<=2)return first.fetch(url,init);const response=await scriptedTransport([]).fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',calls===3?'FIRST FOLLOWUP RESULT '+'y'.repeat(90000):!body.tools?.length?'COMPACTED WORKFLOW SUMMARY':'LAST RESULT'),{headers:{'content-type':'text/event-stream'}});};
 const result=await runCodingTask({...paths,input:'original workflow',mode:'offline',transport,control,onObservation:e=>{if(e.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;originalRun=target.runId;for(const [id,kind,input] of [['first-follow','follow-up','FIRST FOLLOWUP'],['middle-compact','compact','compact'],['last-follow','follow-up','LAST FOLLOWUP']] as const)await control.submit({id,kind,input,target});})();}});await actions;
 assert.equal(result.status,'completed');assert.equal(calls,5);
 const queue=readQueue(paths.dataRoot).items;assert.ok(queue.every(i=>i.status==='applied'));assert.ok(queue.every(i=>i.target.runId===originalRun));
 const firstRun=queue.find(i=>i.requestId==='first-follow')!.runId!;
 const started=recoveryRecords(paths.dataRoot,firstRun).find(r=>r.kind==='compaction.started')?.data as any;
 assert.equal(started.admissionTarget.runId,originalRun);assert.equal(started.source.sourceRunId,firstRun);
 const imported=recoveryRecords(paths.dataRoot,result.runId).find(r=>r.kind==='context.imported')?.data as any;
 assert.equal(imported.source.sourceRunId,firstRun);assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,3);
 const lastIntent=recoveryRecords(paths.dataRoot,result.runId).find(r=>r.kind==='model.intent')?.data as any;
 assert.match(JSON.stringify(lastIntent.context),/COMPACTED WORKFLOW SUMMARY/);assert.match(JSON.stringify(lastIntent.context),/LAST FOLLOWUP/);
});

test('cancelling only the running manual task preserves the completed source and records the interrupted attempt',async()=>{
 const {compactContext}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),control=new TaskControl();let cancellation:Promise<unknown>|undefined,calls=0;
 const transport:typeof fetch=async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('controlled summary cancellation')),{once:true});const task=(recoveryRecords(paths.dataRoot,initial.runId).findLast(r=>r.kind==='compaction.task')!.data as any).taskId;cancellation=control.cancelCompaction({id:'cancel-one',taskId:task,target:control.target()!});});};
 const result=await compactContext({...paths,runId:initial.runId,requestId:'cancel-idle',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},control,transport});await cancellation;
 assert.equal(result.compaction?.state,'cancelled');assert.equal(calls,1);assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,1);
 const facts=recoveryRecords(paths.dataRoot,initial.runId);assert.equal((facts.find(r=>r.kind==='run.closed')!.data as any).status,'completed');assert.ok(facts.some(r=>r.kind==='model.response'&&(r.data as any).completeness==='partial'));
 assert.equal(readQueue(paths.dataRoot).items.find(i=>i.requestId==='cancel-idle')!.status,'withdrawn');
 const {queryUsage}=await import('../src/usage-query.js');const allocation=queryUsage(paths.dataRoot,[initial.runId]).requestAllocations.find(a=>a.maintenanceRequestId==='cancel-idle')!;assert.equal(allocation.dispatchState,'dispatched');assert.equal(allocation.completeness,'unknown');
});

test('manual interruption is frozen across reopen and ending its source never wakes the old task',async()=>{
 const {compactContext,checkRecovery,recoverRun}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),controller=new AbortController();let calls=0;
 const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const};
 const transport:typeof fetch=async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('controlled summary interruption')),{once:true});controller.abort();});};
 const interrupted=await compactContext({...paths,runId:initial.runId,requestId:'exit-idle',authorization,transport,signal:controller.signal,cancellation:'exit'});
 assert.equal(interrupted.status,'unknown');assert.equal(readQueue(paths.dataRoot).items.find(i=>i.requestId==='exit-idle')!.status,'frozen');
 const later=scriptedTransport([]);await assert.rejects(runCodingTask({...paths,input:'cannot revive pending',mode:'offline',transport:later.fetch}),/RECOVERY_REQUIRED/);
 const report=await checkRecovery({...paths,runId:initial.runId,authorization});assert.equal(report.status,'blocked');assert.ok(report.reasons.some(r=>r.startsWith('COMPACTION_FROZEN')));assert.ok(report.options.includes('end'));assert.equal(calls,1);
 const ended=await recoverRun({...paths,runId:initial.runId,authorization,decision:{id:'end-compact-source',snapshotId:report.snapshotId,action:'end'}});assert.equal(ended.status,'ended');
 await assert.rejects(compactContext({...paths,runId:initial.runId,requestId:'must-not-reopen',authorization,transport:later.fetch}),/QUEUE_PREDECESSOR_UNRESOLVED|COMPACTION_RECOVERY_REQUIRED/);
 assert.equal((await runCodingTask({...paths,input:'EXPLICIT NEW TASK',mode:'offline',transport:later.fetch})).status,'completed');assert.equal(later.calls.length,1);assert.doesNotMatch(JSON.stringify(later.calls),/ORIGINAL USER OBJECTIVE/);
});

test('actual automatic background summary becomes stale after newer overflow compaction and is never applied twice',async()=>{
 const paths=await fixture();await writeFile(join(paths.workspace,'README.md'),'read fixture');let generation=0,summary=0,releaseBackground!:()=>void;
 const background=new Promise<void>(resolve=>releaseBackground=resolve);const calls:any[]=[];
 const transport:typeof fetch=async(url,init)=>{
  const body=JSON.parse(String(init?.body));calls.push(body);
  if(body.tools?.length){generation++;
   if(generation<=2)return scriptedTransport([{name:'read',args:{path:'README.md'}}]).fetch(url,init);
   if(generation===3)return new Response(JSON.stringify({error:{message:'maximum context length exceeded',type:'invalid_request_error',code:'context_length_exceeded'}}),{status:400,headers:{'content-type':'application/json'}});
   await background;return scriptedTransport([]).fetch(url,init);
  }
  summary++;if(summary===1)await background;
  const response=await scriptedTransport([]).fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',summary===1?'OLDER SUMMARY':'NEWER SUMMARY'),{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runCodingTask({...paths,input:'read twice then complete',mode:'offline',transport,providerBoundary:{purpose:'generation',operationId:'stale-verification'},verificationCompaction:{reserveTokens:980000,keepRecentTokens:1},onObservation:e=>{if(e.kind==='compaction.finished'){const last=recoveryRecords(paths.dataRoot,e.runId).findLast(r=>r.kind==='compaction.finished')?.data as any;if(last?.state==='applied')releaseBackground();}}});
 assert.equal(result.status,'completed',JSON.stringify({status:result.status,reason:result.reason}));assert.equal(summary,2);assert.equal(generation,4);
 const facts=recoveryRecords(paths.dataRoot,result.runId),finished=facts.filter(r=>r.kind==='compaction.finished').map(r=>r.data as any);
 assert.ok(finished.some(f=>f.state==='stale'));assert.equal(finished.filter(f=>f.state==='applied').length,1);
 assert.equal(facts.filter(r=>r.kind==='model.intent'&&(r.data as any).purpose==='compaction').length,2);
 assert.equal(facts.filter(r=>r.kind==='model.response').length,6);assert.match(JSON.stringify(calls.at(-1)),/NEWER SUMMARY/);
});

test('incomplete summaries retain attempts and usage but never update the context',async()=>{
 const {compactContext,decideQueue}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),base=scriptedTransport([]);
 const transport:typeof fetch=async(url,init)=>{const response=await base.fetch(url,init);return new Response((await response.text()).replace('"finish_reason":"stop"','"finish_reason":"length"'),{headers:{'content-type':'text/event-stream'}});};
 const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const};
 const result=await compactContext({...paths,runId:initial.runId,requestId:'incomplete',authorization,transport});
 assert.equal(result.status,'failed');assert.equal(result.compaction?.state,'failed');assert.match(result.compaction?.reason??'',/incomplete/);
 const records=recoveryRecords(paths.dataRoot,initial.runId);assert.equal(records.filter(r=>r.kind==='compaction.generated').length,0);assert.equal(records.filter(r=>r.kind==='model.response').length,2);
 const item=readQueue(paths.dataRoot).items.find(i=>i.requestId==='incomplete')!;assert.equal(item.status,'frozen');
 const withdrawn=await decideQueue({...paths,runId:initial.runId,decision:{id:'withdraw-failure',requestId:item.requestId,action:'withdraw',target:item.target,receiptSeq:item.receipt.seq}});assert.equal(withdrawn.status,'withdrawn');
 const retry=await compactContext({...paths,runId:initial.runId,requestId:'explicit-new-attempt',authorization,transport:base.fetch});assert.equal(retry.compaction?.state,'applied');
 assert.equal(recoveryRecords(paths.dataRoot,initial.runId).filter(r=>r.kind==='compaction.finished'&&(r.data as any).state==='failed').length,1,'first failure remains');
});

test('manual usage is maintenance while authoritative session totals are projected once',async()=>{
 const {compactContext}=await import('../src/runtime.js');const {queryUsage}=await import('../src/usage-query.js');const paths=await fixture(),initial=await longSource(paths),summary=scriptedTransport([]);
 await compactContext({...paths,runId:initial.runId,requestId:'cost-maintenance',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},transport:summary.fetch});
 const usage=queryUsage(paths.dataRoot,[initial.runId]);assert.equal(usage.totals.tokens,28);assert.equal(usage.items[0].runId,null);assert.match(usage.items[0].attribution,/maintenance/);
 const allocations=usage.requestAllocations;assert.equal(allocations.length,2);assert.equal(allocations.filter(a=>a.allocation==='maintenance').length,1);assert.equal(allocations.find(a=>a.allocation==='maintenance')!.scope,'maintenance:cost-maintenance');
 assert.equal((allocations.find(a=>a.allocation==='maintenance')!.reportedUsage as any).totalTokens,14);assert.deepEqual(queryUsage(paths.dataRoot,[initial.runId]).totals,usage.totals);
});

test('automatic generated-but-unplaced summary is frozen across whole-Harness recovery and ordinary submission',async()=>{
 const {checkRecovery}=await import('../src/runtime.js');const paths=await fixture();await writeFile(join(paths.workspace,'README.md'),'fixture');const controller=new AbortController();let generation=0,summary=0;
 const transport:typeof fetch=async(url,init)=>{const payload=JSON.parse(String(init?.body));if(!payload.tools?.length){summary++;return scriptedTransport([]).fetch(url,init);}generation++;if(generation===1)return scriptedTransport([{name:'read',args:{path:'README.md'}}]).fetch(url,init);return new Promise((_resolve,reject)=>{if(init!.signal!.aborted){reject(Error('exit'));return;}init!.signal!.addEventListener('abort',()=>reject(Error('exit')),{once:true});});};
 const result=await runCodingTask({...paths,input:'read then hold',mode:'offline',transport,providerBoundary:{purpose:'generation',operationId:'freeze-auto'},verificationCompaction:{reserveTokens:980000,keepRecentTokens:1},signal:controller.signal,cancellation:'exit',onObservation:e=>{if(e.kind==='compaction.generated')controller.abort();}});
 assert.equal(result.status,'unknown');assert.equal(summary,1);
 const facts=recoveryRecords(paths.dataRoot,result.runId);assert.ok(facts.some(r=>r.kind==='compaction.generated'));assert.equal(facts.filter(r=>r.kind==='compaction.finished'&&(r.data as any).state==='applied').length,0);
 const report=await checkRecovery({...paths,runId:result.runId,authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']}});
 assert.ok(report.compactions?.some(c=>c.submissionStatus==='queued'));assert.ok(report.reasons.some(r=>r.startsWith('COMPACTION_FROZEN')));
 const next=scriptedTransport([]);await assert.rejects(runCodingTask({...paths,input:'ordinary input',mode:'offline',transport:next.fetch}),/RECOVERY_REQUIRED/);assert.equal(next.calls.length,0);
});

test('cancelling an active queued compaction resolves only that item and later follow-up still runs',async()=>{
 const paths=await fixture(),control=new TaskControl();let generation=0,summary=0,actions:Promise<void>|undefined,cancellation:Promise<unknown>|undefined;
 const first=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
 const transport:typeof fetch=async(url,init)=>{const body=JSON.parse(String(init?.body));
  if(body.tools?.length){generation++;if(generation===1)return first.fetch(url,init);const response=await scriptedTransport([]).fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',generation===2?'source '+'z'.repeat(90000):'followup survived'),{headers:{'content-type':'text/event-stream'}});}
  summary++;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('cancel summary only')),{once:true});const target=control.target()!;const task=(recoveryRecords(paths.dataRoot,target.runId).findLast(r=>r.kind==='compaction.task')!.data as any).taskId;cancellation=control.cancelCompaction({id:'cancel-queued-summary',taskId:task,target});});
 };
 const result=await runCodingTask({...paths,input:'original',mode:'offline',transport,control,onObservation:e=>{if(e.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;await control.submit({id:'cancel-queued',kind:'compact',input:'compact',target});await control.submit({id:'surviving-followup',kind:'follow-up',input:'continue after cancelled maintenance',target});})();}});await actions;await cancellation;
 assert.equal(result.status,'completed');assert.equal(result.answer,'followup survived');assert.equal(generation,3);assert.equal(summary,1);
 const queue=readQueue(paths.dataRoot).items;assert.equal(queue.find(i=>i.requestId==='cancel-queued')!.status,'withdrawn');assert.equal(queue.find(i=>i.requestId==='surviving-followup')!.status,'applied');assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,2);
});

test('a late cancellation loses to committed summary placement and never claims rollback',async()=>{
 const {compactContext}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),control=new TaskControl(),summary=scriptedTransport([]);let cancellation:Promise<any>|undefined;
 const result=await compactContext({...paths,runId:initial.runId,requestId:'placement-wins',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},transport:summary.fetch,control,onObservation:e=>{if(e.kind==='compaction.finished'&&!cancellation){const f=recoveryRecords(paths.dataRoot,initial.runId).findLast(r=>r.kind==='compaction.finished')?.data as any;if(f?.state==='applied')cancellation=control.cancelCompaction({id:'too-late',taskId:f.taskId,target:control.target()!});}}});
 assert.equal(result.compaction?.state,'applied');assert.equal((await cancellation)?.state,'applied');assert.equal(summary.calls.length,1);assert.equal(readQueue(paths.dataRoot).items[0].status,'applied');
});

test('frozen unexecuted compact reattaches to the proven completed follow-up context',async()=>{
 const {checkQueue,decideQueue}=await import('../src/runtime.js');
 const paths=await fixture(),control=new TaskControl();let actions:Promise<void>|undefined,calls=0;
 const first=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
 const transport:typeof fetch=async(url,init)=>{if(++calls<=2)return first.fetch(url,init);const response=await scriptedTransport([]).fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.','REATTACHED FOLLOWUP '+ 'z'.repeat(90000)),{headers:{'content-type':'text/event-stream'}});};
 const done=await runCodingTask({...paths,input:'Complete source chain',mode:'offline',transport,control,onObservation:e=>{if(e.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;for(const [id,kind,input] of [['reattach-first','follow-up','FIRST'],['reattach-barrier','improve','improve'],['reattach-compact','compact','compact']] as const)await control.submit({id,kind,input,target});})();}});await actions;
 const report=await checkQueue(paths.dataRoot),item=report.items.find(i=>i.requestId==='reattach-compact')!,barrier=report.items.find(i=>i.requestId==='reattach-barrier')!;
 assert.equal(item.status,'frozen');assert.notEqual(done.runId,item.target.runId);
 await decideQueue({...paths,runId:barrier.target.runId,decision:{id:'remove-reattach-barrier',requestId:barrier.requestId,target:barrier.target,receiptSeq:barrier.receipt.seq,action:'withdraw'}});
 const summary=scriptedTransport([]),request={...paths,runId:item.target.runId,authorization:{workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const},decision:{id:'explicit-reattach-compact',requestId:item.requestId,target:item.target,receiptSeq:item.receipt.seq,action:'reattach' as const},transport:summary.fetch};
 const result=await decideQueue(request);assert.equal(result.status,'completed');assert.ok('compaction' in result&&result.compaction?.state==='applied');assert.ok('runId' in result&&result.runId===done.runId);assert.match(JSON.stringify(summary.calls),/\[User\]: FIRST/);
 assert.equal((await decideQueue(request)).status,'applied');assert.equal(summary.calls.length,1);assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,2);
});

test('frozen compact cannot jump over a failed dispatched follow-up to reuse an older completed context',async()=>{
 const {checkQueue,decideQueue}=await import('../src/runtime.js');const paths=await fixture(),control=new TaskControl();let actions:Promise<void>|undefined,calls=0;
 const first=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
 const transport:typeof fetch=async(url,init)=>++calls<=2?first.fetch(url,init):new Response(JSON.stringify({error:{message:'controlled preceding failure'}}),{status:400,headers:{'content-type':'application/json'}});
 const result=await runCodingTask({...paths,input:'Complete before failed follow-up',mode:'offline',transport,control,onObservation:e=>{if(e.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;await control.submit({id:'failed-predecessor',kind:'follow-up',input:'FAIL',target});await control.submit({id:'after-failed-predecessor',kind:'compact',input:'compact',target});})();}});await actions;assert.equal(result.status,'failed');
 const item=(await checkQueue(paths.dataRoot)).items.find(i=>i.kind==='compact')!,summary=scriptedTransport([]);
 await assert.rejects(decideQueue({...paths,runId:item.target.runId,authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},decision:{id:'refuse-old-context',requestId:item.requestId,target:item.target,receiptSeq:item.receipt.seq,action:'reattach'},transport:summary.fetch}),/COMPACTION_CONTEXT_SOURCE_NOT_COMPLETED/);assert.equal(summary.calls.length,0);
});

test('manual maintenance keeps the original dispatch capability and exhausted persistent budget',async()=>{
 const {compactContext}=await import('../src/runtime.js');const {PersistentBudget}=await import('../src/provider-boundary.js');const {Evidence}=await import('../src/evidence.js');
 const paths=await fixture(),ledger=new Evidence(join(paths.workspace,'budget-ledger'),'budget-host');
 const budget=new PersistentBudget(ledger,'original-budget',{maxRequests:1,maxTokens:100,maxRequestTokens:25,unknownUpperBound:null,deadline:new Date(Date.now()+60000).toISOString()});let dispatched=0;
 const providerBoundary={budget,purpose:'generation' as const,operationId:'original-operation',onDispatch:()=>{dispatched++;}};
 try{const initial=await longSource(paths,{providerBoundary});assert.equal(initial.status,'completed');assert.equal(dispatched,1);
 const summary=scriptedTransport([]),result=await compactContext({...paths,runId:initial.runId,requestId:'budget-maintenance',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},transport:summary.fetch,providerBoundary});
 assert.equal(result.status,'failed');assert.equal(summary.calls.length,0);assert.equal(dispatched,1);assert.equal(budget.snapshot().requests,1);
 const facts=recoveryRecords(paths.dataRoot,initial.runId),operation=facts.findLast(r=>r.kind==='compaction.started')!.data as any;
 assert.equal(operation.providerOperation.parentOperationId,'original-operation');assert.equal(operation.providerOperation.operationId,'maintenance:budget-maintenance');assert.equal(operation.providerOperation.budgetId,'original-budget');assert.throws(()=>budget.check(),/BUDGET_REQUEST_LIMIT/);assert.equal(budget.snapshot().knownTokens,14);
 assert.equal(facts.filter(r=>r.kind==='model.dispatch').length,1,'a denied attempt never reaches the actual transport');
 const denied=facts.findLast(r=>r.kind==='model.dispatch-failed')?.data as any;assert.equal(denied.dispatched,false);assert.equal(denied.reason,'BUDGET_REQUEST_LIMIT');
 const {queryUsage}=await import('../src/usage-query.js');const usage=queryUsage(paths.dataRoot,[initial.runId]);assert.equal(usage.items[0].requestCoverage?.dispatches,1);assert.equal(usage.items[0].completeness,'known');
 const allocation=usage.requestAllocations.find(a=>a.maintenanceRequestId==='budget-maintenance') as any;assert.equal(allocation.dispatchState,'not-dispatched');assert.equal(allocation.completeness,'not-applicable');assert.equal(allocation.dispatchFailure.reason,'BUDGET_REQUEST_LIMIT');
 }finally{ledger.close();}
});

test('duplicates admitted during manual summary generation retain their stable alias and input identity',async()=>{
 const {compactContext}=await import('../src/runtime.js');const paths=await fixture(),initial=await longSource(paths),control=new TaskControl(),summary=scriptedTransport([]);let duplicate:Promise<void>|undefined;
 const transport:typeof fetch=async(url,init)=>{duplicate=(async()=>{const target=control.target()!,input={id:'running-duplicate',kind:'compact' as const,input:'compact',target};assert.equal((await control.submit(input)).requestId,'running-canonical');assert.equal((await control.submit(input)).requestId,'running-canonical');await assert.rejects(control.submit({...input,input:'conflicting retry'}),/CONTROL_ID_CONFLICT/);})();await duplicate;return summary.fetch(url,init);};
 const result=await compactContext({...paths,runId:initial.runId,requestId:'running-canonical',authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},control,transport});await duplicate;assert.equal(result.compaction?.state,'applied');assert.equal(summary.calls.length,1);
 assert.equal(recoveryRecords(paths.dataRoot,initial.runId).filter(r=>r.kind==='control.coalesced'&&(r.data as any).id==='running-duplicate').length,1);assert.equal(readQueue(paths.dataRoot).items.filter(i=>i.kind==='compact').length,1);
});
