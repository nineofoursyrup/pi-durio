import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Evidence, readAcceptedTasks, readQueue } from '../src/evidence.js';

test('readonly task membership includes queued, frozen and withdrawn follow-ups once and keeps an as-of snapshot across pages',()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-control-facts-')),source=new Evidence(root,'source-run');
  const target={workspace:'/fixture',sessionId:'source-session',taskId:'first-task',runId:'source-run'};
  source.append('task.accepted',{...target,input:'first',authorization:{tools:['read']}});
  source.append('run.started',{sessionId:'source-session',taskId:'first-task'});
  const admission={input:'queued',target,executionVersion:{artifactId:'fixture-version',configSeq:1,artifactSeq:2},authorization:{tools:['read']}};
  source.append('control.accepted',{...admission,kind:'steer',requestId:'steer',taskId:'first-task'});
  source.append('control.accepted',{...admission,kind:'follow-up',requestId:'follow',taskId:'second-task'});
  source.append('control.accepted',{...admission,kind:'follow-up',requestId:'withdraw',taskId:'third-task'});
  source.append('control.receipt',{requestId:'withdraw',status:'withdrawn',reason:'explicit withdrawal'});
  const page=readAcceptedTasks(root,{limit:1});
  assert.equal(page.tasks[0].taskId,'first-task');assert.ok(page.next);
  source.append('control.receipt',{requestId:'follow',status:'applied',reason:'actual run.started',execution:{runId:'next-run',sessionId:'next-session'}});
  const execution=new Evidence(root,'next-run');
  execution.append('task.accepted',{taskId:'second-task',queueRequestId:'follow',sessionId:'next-session',input:'queued'});
  execution.append('run.started',{taskId:'second-task',sessionId:'next-session'});
  const before=readAcceptedTasks(root,{after:page.next!,through:page.through});
  assert.equal(before.tasks.length,2);assert.equal(before.tasks[0].runId,null);assert.equal(before.tasks[1].status,'withdrawn');
  const after=readAcceptedTasks(root);
  assert.equal(after.tasks.length,3);assert.equal(after.tasks[1].runId,'next-run');
  assert.equal(after.tasks[1].target?.sessionId,'source-session');assert.equal(after.tasks[1].execution?.sessionId,'next-session');
  assert.equal(after.tasks[1].acceptedSeq,before.tasks[0].acceptedSeq);assert.equal(after.tasks[1].acceptedAt,before.tasks[0].acceptedAt);
  const oldQueue=readQueue(root,{through:page.through});
  assert.equal(oldQueue.items.find(item=>item.requestId==='follow')!.status,'pending');
  source.append('control.receipt',{requestId:'steer',status:'frozen',reason:'stop'});
  assert.equal(readQueue(root).items.find(item=>item.requestId==='steer')!.status,'frozen');
  assert.equal(readQueue(root,{through:page.through}).items.find(item=>item.requestId==='steer')!.status,'pending');
  execution.close();source.close();
});

test('an accepted task can fail before run.started without acquiring a run; queued follow-up never inherits its source outcome',()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-admission-failure-')),source=new Evidence(root,'admission-run');
  source.append('task.accepted',{taskId:'first',sessionId:'session',workspace:'/fixture',input:'first'});
  source.append('control.accepted',{kind:'follow-up',requestId:'later',taskId:'second',input:'second',target:{workspace:'/fixture',sessionId:'session',taskId:'first',runId:'admission-run'},authorization:null,executionVersion:{artifactId:'version',artifactSeq:0,configSeq:0}});
  const before=readAcceptedTasks(root);
  source.append('run.closed',{status:'failed',reason:'harness open failed before start'});
  const after=readAcceptedTasks(root);
  assert.equal(after.tasks[0].status,'failed');assert.equal(after.tasks[0].reason,'harness open failed before start');assert.equal(after.tasks[0].runId,null);assert.equal(after.tasks[0].execution,null);
  assert.equal(after.tasks[1].status,'pending');assert.equal(after.tasks[1].runId,null);
  assert.equal(readAcceptedTasks(root,{through:before.through}).tasks[0].status,'accepted');source.close();
});
