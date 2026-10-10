import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, readAcceptedTasks, readQueue, TaskControl, checkQueue, decideQueue, checkRecovery, recoverRun } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { recoveryRecords } from '../src/recovery.js';
import type { QueueItemFact } from '../src/evidence.js';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'durio-queue-')),workspace=join(root,'project');await mkdir(workspace);
  await writeFile(join(workspace,'wait.cjs'),"require('node:fs').appendFileSync('executions.txt','once\\n');console.log('started');setTimeout(()=>console.log('finished'),350);");
  return {workspace,dataRoot:join(root,'data')};
}

test('busy steer uses its original task, follow-up is accepted once before its own run, and withdrawal wins before Pi placement',async()=>{
  const paths=await fixture(),control=new TaskControl();
  const transport=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
  let actions:Promise<void>|undefined,follow:QueueItemFact|undefined,steer:QueueItemFact|undefined;
  const result=await runCodingTask({...paths,input:'Run the local fixture.',mode:'offline',transport:transport.fetch,control,onObservation:event=>{
    if(event.kind!=='tool.output'||actions)return;
    actions=(async()=>{
      const target=control.target()!;
      steer=await control.submit({id:'s1',kind:'steer',input:'Keep the original goal and report the output.',target});
      follow=await control.submit({id:'f1',kind:'follow-up',input:'Explain the result in the preceding context.',target});
      const duplicate=await control.submit({id:'f1',kind:'follow-up',input:'Explain the result in the preceding context.',target});
      assert.equal(duplicate.taskId,follow.taskId);assert.equal(follow.runId,null);assert.equal(follow.status,'pending');
      await assert.rejects(control.submit({id:'changed-project',kind:'follow-up',input:'must not retarget',target:{...target,workspace:join(paths.workspace,'elsewhere')}}),/CONTROL_TARGET_CHANGED/);
      const withdrawn=await control.submit({id:'w1',kind:'steer',input:'WITHDRAWN INPUT MUST NEVER ENTER CONTEXT',target});
      const receipt=await control.withdraw({id:'decision-w1',action:'withdraw',requestId:withdrawn.requestId,target,receiptSeq:withdrawn.receipt.seq});
      assert.equal(receipt.status,'withdrawn');
      const sample=readAcceptedTasks(paths.dataRoot);
      assert.equal(sample.tasks.length,2);assert.equal(sample.tasks[1].runId,null);
    })();
  }});
  await actions;
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.taskId,follow!.taskId);
  assert.notEqual(result.runId,follow!.target.runId);assert.notEqual(result.sessionId,follow!.target.sessionId);
  const sample=readAcceptedTasks(paths.dataRoot);assert.equal(sample.tasks.length,2);
  assert.equal(sample.tasks[1].acceptedSeq,follow!.acceptedSeq);assert.equal(sample.tasks[1].target!.sessionId,follow!.target.sessionId);
  const queue=readQueue(paths.dataRoot).items;
  assert.equal(queue.find(item=>item.requestId==='s1')!.status,'applied');assert.equal(queue.find(item=>item.requestId==='w1')!.status,'withdrawn');
  assert.equal(steer!.taskId,sample.tasks[0].taskId);
  assert.equal(await readFile(join(paths.workspace,'executions.txt'),'utf8'),'once\n');
  assert.equal(transport.calls.length,3);
  const last=JSON.stringify(transport.calls.at(-1));assert.match(last,/Keep the original goal/);assert.match(last,/finished/);assert.match(last,/Explain the result/);assert.doesNotMatch(last,/WITHDRAWN INPUT/);
  const records=recoveryRecords(paths.dataRoot,result.runId);
  assert.ok(records.some(record=>record.kind==='context.imported'));assert.equal(records.filter(record=>record.kind==='tool.intent').length,0);
  assert.equal(records.filter(record=>record.kind==='model.intent').length,1);
});

test('stop freezes steer, follow-up and management; later ordinary work cannot revive them and stopped-source reattachment is refused',async()=>{
  const paths=await fixture(),control=new TaskControl(),controller=new AbortController();
  const transport=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
  let actions:Promise<void>|undefined;
  const result=await runCodingTask({...paths,input:'Run the fixture until stopped.',mode:'offline',transport:transport.fetch,control,signal:controller.signal,cancellation:'stop',onObservation:event=>{
    if(event.kind!=='tool.output'||actions)return;
    actions=(async()=>{const target=control.target()!;
      for(const [id,kind] of [['stop-steer','steer'],['stop-follow','follow-up'],['stop-compact','compact']] as const)await control.submit({id,kind,input:`FROZEN ${id}`,target});
      controller.abort();
    })();
  }});await actions;
  assert.equal(result.status,'aborted',JSON.stringify(result));assert.equal(result.controls?.exitCode,75);
  assert.ok(readQueue(paths.dataRoot).items.every(item=>item.status==='frozen'));
  const later=scriptedTransport([]);
  assert.equal((await runCodingTask({...paths,input:'Only this new explicit task.',mode:'offline',transport:later.fetch})).status,'completed');
  assert.doesNotMatch(JSON.stringify(later.calls),/FROZEN/);
  const report=await checkQueue(paths.dataRoot);assert.equal(report.exitCode,75);
  const follow=report.items.find(item=>item.requestId==='stop-follow')!;
  await assert.rejects(decideQueue({dataRoot:paths.dataRoot,runId:result.runId,authorization:{workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']},decision:{id:'reattach-stop',requestId:follow.requestId,target:follow.target,receiptSeq:follow.receipt.seq,action:'reattach'},transport:later.fetch}),/QUEUE_SOURCE_NOT_COMPLETED/);
  const decision={id:'withdraw-frozen',requestId:follow.requestId,target:follow.target,receiptSeq:follow.receipt.seq,action:'withdraw' as const};
  const withdrawn=await decideQueue({dataRoot:paths.dataRoot,runId:result.runId,decision});
  assert.equal(withdrawn.status,'withdrawn');assert.deepEqual(await decideQueue({dataRoot:paths.dataRoot,runId:result.runId,decision}),withdrawn);
  assert.equal(later.calls.length,1);
});

test('failure leaves accepted independent work frozen; actual placement defeats a late withdrawal',async()=>{
  const paths=await fixture(),control=new TaskControl();
  const script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
  let actions:Promise<void>|undefined,late:Promise<void>|undefined,steer:QueueItemFact|undefined;
  const transport:typeof fetch=async(url,init)=>script.calls.length?new Response('fixture failure',{status:401}):script.fetch(url,init);
  const result=await runCodingTask({...paths,input:'Run then observe the fixture failure.',mode:'offline',transport,control,onObservation:event=>{
    if(event.kind==='tool.output'&&!actions)actions=(async()=>{const target=control.target()!;steer=await control.submit({id:'late-steer',kind:'steer',input:'Stay on this task',target});await control.submit({id:'after-fail',kind:'follow-up',input:'MUST STAY FROZEN',target});})();
    if(event.kind==='generation.request'&&steer&&!late)late=(async()=>{const fact=readQueue(paths.dataRoot).items.find(item=>item.requestId===steer!.requestId)!;const answer=await control.withdraw({id:'too-late',requestId:fact.requestId,action:'withdraw',target:fact.target,receiptSeq:fact.receipt.seq});assert.equal(answer.status,'applied');})();
  }});await actions;await late;
  assert.equal(result.status,'failed');assert.equal(readQueue(paths.dataRoot).items.find(item=>item.requestId==='after-fail')!.status,'frozen');
  assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,2);
});

test('completed-source follow-up requires an explicit compatible decision after reopening, and repeated decisions never repeat dispatch',async()=>{
  const paths=await fixture(),control=new TaskControl();
  const script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
  let actions:Promise<void>|undefined;
  const result=await runCodingTask({...paths,input:'Complete before a management barrier.',mode:'offline',transport:script.fetch,control,onObservation:event=>{
    if(event.kind!=='tool.output'||actions)return;
    actions=(async()=>{const target=control.target()!;await control.submit({id:'management','kind':'improve',input:'improve',target});await control.submit({id:'reopen-follow',kind:'follow-up',input:'Read the preceding result, without repeating its tool.',target});})();
  }});await actions;assert.equal(result.status,'completed');
  const report=await checkQueue(paths.dataRoot),item=report.items.find(item=>item.requestId==='reopen-follow')!;
  const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const};
  const decision={id:'decision-follow',action:'reattach' as const,requestId:item.requestId,target:item.target,receiptSeq:item.receipt.seq};
  const later=scriptedTransport([]);
  await assert.rejects(decideQueue({...paths,runId:result.runId,authorization,decision,transport:later.fetch}),/QUEUE_PREDECESSOR_UNRESOLVED/);
  const management=report.items.find(item=>item.requestId==='management')!;
  await decideQueue({...paths,runId:result.runId,decision:{id:'withdraw-barrier',action:'withdraw',requestId:management.requestId,target:management.target,receiptSeq:management.receipt.seq}});
  await assert.rejects(decideQueue({...paths,runId:result.runId,authorization:{...authorization,tools:['read']},decision,transport:later.fetch}),/QUEUE_AUTHORIZATION_CHANGED/);
  const next=await decideQueue({...paths,runId:result.runId,authorization,decision,transport:later.fetch});assert.equal(next.status,'completed');
  const again=await decideQueue({...paths,runId:result.runId,authorization,decision,transport:later.fetch});assert.equal(again.status,'applied');
  assert.equal(later.calls.length,1);assert.match(JSON.stringify(later.calls),/finished/);
  assert.equal(await readFile(join(paths.workspace,'executions.txt'),'utf8'),'once\n');
});

test('recovery recognizes committed steer inputs as the same run and never releases its frozen independent queue',async()=>{
  const paths=await fixture(),control=new TaskControl(),controller=new AbortController();
  const script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]);
  let actions:Promise<void>|undefined;
  const transport:typeof fetch=async(url,init)=>{
    if(script.calls.length)return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('fixture interruption')));controller.abort();});
    return script.fetch(url,init);
  };
  const original=await runCodingTask({...paths,input:'Original task',mode:'offline',transport,control,signal:controller.signal,cancellation:'exit',onObservation:event=>{
    if(event.kind!=='tool.output'||actions)return;
    actions=(async()=>{const target=control.target()!;await control.submit({id:'recover-steer',kind:'steer',input:'Complete the same task with this instruction',target});await control.submit({id:'recover-follow',kind:'follow-up',input:'FROZEN INDEPENDENT TEXT',target});})();
  }});await actions;assert.equal(original.status,'unknown');
  const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const};
  const report=await checkRecovery({...paths,runId:original.runId,authorization});assert.equal(report.status,'needs-decision',JSON.stringify(report));
  const next=scriptedTransport([]);
  const result=await recoverRun({...paths,runId:original.runId,authorization,decision:{id:'continue-original',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:next.fetch});
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal((result as any).taskId,original.taskId);assert.equal((result as any).runId,original.runId);
  assert.equal(next.calls.length,1);assert.match(JSON.stringify(next.calls),/Complete the same task/);assert.doesNotMatch(JSON.stringify(next.calls),/FROZEN INDEPENDENT/);
  assert.equal(readQueue(paths.dataRoot).items.find(item=>item.requestId==='recover-follow')!.status,'frozen');
  assert.equal(await readFile(join(paths.workspace,'executions.txt'),'utf8'),'once\n');
});

test('stopping a running follow-up preserves the first stop intent and freezes earlier-source siblings',async()=>{
  const paths=await fixture(),control=new TaskControl(),controller=new AbortController();
  let calls=0,cancellation:'stop'|'exit'='exit',actions:Promise<void>|undefined,initialRun:string|undefined;
  const transport:typeof fetch=async(url,init)=>{
    calls++;return scriptedTransport(calls===1||calls===3?[{name:'bash',args:{command:`'${process.execPath}' wait.cjs`}}]:[]).fetch(url,init);
  };
  const result=await runCodingTask({...paths,input:'First task',mode:'offline',transport,control,signal:controller.signal,get cancellation(){return cancellation;},onObservation:event=>{
    if(event.kind!=='tool.output')return;
    if(!actions)actions=(async()=>{initialRun=event.runId;const target=control.target()!;await control.submit({id:'next-to-stop',kind:'follow-up',input:'Run a new tool',target});await control.submit({id:'next-frozen',kind:'follow-up',input:'Must stay pending',target});})();
    else if(event.runId!==initialRun){cancellation='stop';controller.abort();}
  }});await actions;
  assert.equal(result.status,'aborted',JSON.stringify(result));assert.equal(result.lifecycle?.intent,'stop');assert.notEqual(result.runId,initialRun);
  assert.equal(readQueue(paths.dataRoot).items.find(item=>item.requestId==='next-frozen')!.status,'frozen');
  assert.equal(readAcceptedTasks(paths.dataRoot).tasks.length,3);assert.equal(calls,3);
});
