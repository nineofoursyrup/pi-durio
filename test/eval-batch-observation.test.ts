import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForPhase,completedAndIdle} from './integration/eval-batch-observation.js';

test('visible completion needs the idle status row while preserved input feedback may still cover the footer hints',()=>{
 const event='  ✓ eval ep-1 已结束 · 不判改善 · /eval ep-1 查看',feedback='  eval 批次运行中 · 文字保留，未受理';
 assert.equal(completedAndIdle([event,'  ○ 空闲  ','  eval 期间保留的输入',feedback].join('\n'),/eval.*已结束/),true);
 assert.equal(completedAndIdle([event,'  ⠹ eval ep-1','说明文字包含 ○ 空闲',feedback].join('\n'),/eval.*已结束/),false);
 assert.equal(completedAndIdle(['  ○ 空闲  ',feedback].join('\n'),/eval.*已结束/),false);
});

test('a persisted failure ends marker observation immediately with the original receipt',async()=>{
 let pauses=0;
 const receipt={root:'/fixture/data',planId:'fixed-plan',source:'e1:8:original',data:{status:'preparation-error',isolation:{sha256:'original-vm-receipt'}}};
 await assert.rejects(waitForPhase('live VM marker',new Date(600000).toISOString(),()=>({state:'ended',receipt}),{now:()=>100,pause:async()=>{pauses++;}}),error=>{
  assert.match(String(error),/EVAL82_PHASE_ENDED/);assert.match(String(error),/original-vm-receipt/);assert.match(String(error),/preparation-error/);return true;
 });
 assert.equal(pauses,0);
});

test('later phases share the persisted absolute deadline and cannot renew the remaining observation time',async()=>{
 let now=750;const sleeps:number[]=[],clock={now:()=>now,pause:async(ms:number)=>{sleeps.push(ms);now+=ms;}},deadline=new Date(1000).toISOString();
 assert.equal(await waitForPhase('source link',deadline,()=>({state:'ready',value:'linked'}),clock),'linked');
 await assert.rejects(waitForPhase('live VM marker',deadline,()=>({state:'pending',detail:'same plan'}),clock),/EVAL82_OBSERVATION_DEADLINE/);
 assert.deepEqual(sleeps,[250]);assert.equal(now,1000);
 await assert.rejects(waitForPhase('late marker',deadline,()=>({state:'ready',value:'too late'}),clock),/EVAL82_OBSERVATION_DEADLINE/);
});
