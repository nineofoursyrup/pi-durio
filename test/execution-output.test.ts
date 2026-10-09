import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeImproveProcess} from '../src/improve-process.js';
import {Evidence,readObject} from '../src/evidence.js';
import {retainExecutionOutput,executionPreview} from '../src/execution-output.js';
import {records} from '../src/history.js';
import {fixEvidence,verifyFixed} from '../src/fixed-evidence.js';
import {previewCleanup} from '../src/storage.js';
import {readObjectRange} from '../src/query.js';

test('selected process keeps all acquired output bytes and fixed evidence protects every block',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durio-output-retained-'));
 for(const stream of ['stdout','stderr']){
  const child=spawn(process.execPath,['-e',`process.${stream}.write(Buffer.alloc(1048575,97));setTimeout(()=>{process.${stream}.write(Buffer.from([0xff,0x80]));setInterval(()=>{},1000)},80);`],{detached:true,stdio:['ignore','pipe','pipe']});
  const execution=await observeImproveProcess(child,{timeoutMs:10000,recordStarted:async()=>null});
  assert.equal(execution.reason,'output-limit');assert.equal(execution.state,'failed');
  const expected=Buffer.concat([Buffer.alloc(1048575,97),Buffer.from([0xff,0x80])]);
  assert.deepEqual(Buffer.concat(execution.output[stream].chunks.map((s:string)=>Buffer.from(s,'base64'))),expected);
  const e=new Evidence(root,`output-${stream}`);retainExecutionOutput(e,execution,{launchId:stream});
  e.append('improve.process-result',{result:executionPreview(execution)});e.close();
  assert.deepEqual(Buffer.concat(execution.output[stream].chunks.map((ref:any)=>readObject(root,ref))),expected);
  assert.ok(execution.output[stream].chunks.every((ref:any)=>ref.bytes<=65536));
  const first=execution.output[stream].chunks[0],page=readObjectRange(root,first,{offset:65534,limit:2});assert.equal(page.bytes.toString(),'aa');
  const source=[...records(root,{runId:`output-${stream}`,kinds:['improve.process-result']})][0];
  const fixed=await fixEvidence(root,{id:`fixed-${stream}`,sources:[source.id],purpose:'Retain actual acquired process bytes'});
  assert.equal(verifyFixed(root,fixed.source).state,'protected');
  const units=[...new Set<string>(execution.output[stream].chunks.map((ref:any)=>`object:${ref.sha256}`))];
  const preview=await previewCleanup(root,{id:`preview-${stream}`,units,reason:'Explicit preview only'});
  assert.equal(preview.plan.units.length,0);assert.equal(preview.plan.blocked.length,units.length);
  assert.ok(preview.plan.blocked.every(unit=>unit.reasons.includes('fixed-dependency')));
 }
});

test('cancellation and failed start journaling retain acquired bytes while stopping the child',async()=>{
 for(const failure of ['cancelled','journal-failure']){
  const controller=new AbortController();
  const child=spawn(process.execPath,['-e',`process.stdout.write('started🙂');setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','pipe']});
  if(failure==='cancelled')child.stdout!.once('data',()=>setImmediate(()=>controller.abort()));
  const execution=await observeImproveProcess(child,{timeoutMs:10000,signal:controller.signal,recordStarted:async()=>{if(failure==='journal-failure'){await new Promise(resolve=>setTimeout(resolve,150));throw Error('CONTROLLED_JOURNAL_FAILURE');}return 'start-source';}});
  assert.equal(execution.reason,failure);assert.equal(execution.state,'failed');assert.equal(execution.sourceEnd,'stopped-before-eof');
  assert.equal(Buffer.concat(execution.output.stdout.chunks.map((s:string)=>Buffer.from(s,'base64'))).toString(),'started🙂');
  assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
 }
});

test('output receipt failure keeps original blocks and does not publish retained completeness',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durio-output-failure-'));
 const child=spawn(process.execPath,['-e',`process.stderr.write(Buffer.from([0,255,128]));`],{detached:true,stdio:['ignore','pipe','pipe']});
 const execution=await observeImproveProcess(child,{timeoutMs:10000,recordStarted:async()=>null}),before=structuredClone(execution.output);
 const e=new Evidence(root,'failed-output',kind=>{if(kind==='execution.output')throw Error('CONTROLLED_OUTPUT_RECEIPT_FAILURE');});
 assert.throws(()=>retainExecutionOutput(e,execution,{launchId:'failed'}),/CONTROLLED_OUTPUT_RECEIPT_FAILURE/);e.close();
 assert.deepEqual(execution.output,before);assert.equal([...records(root)].length,0);
 assert.deepEqual(Buffer.from(execution.output.stderr.chunks[0],'base64'),Buffer.from([0,255,128]));
 assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});

test('timeout still escalates to SIGKILL after a child ignores SIGTERM',async()=>{
 const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','pipe']});
 const execution=await observeImproveProcess(child,{timeoutMs:250,recordStarted:async()=>null});
 assert.equal(execution.reason,'timeout');assert.equal(execution.stdout,'ready');assert.equal(child.signalCode,'SIGKILL');
 assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});
