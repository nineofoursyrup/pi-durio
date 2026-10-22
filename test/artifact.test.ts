import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureArtifact, verifyArtifact } from '../src/artifact.js';
import { Evidence, readObject, digest } from '../src/evidence.js';
import { runReadTask, readRun } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';

test('fresh execution capture yields to terminal input while retaining verifiable material', async () => {
  const root=mkdtempSync(join(tmpdir(),'durio-artifact-')),workspace=join(root,'project');mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Capture fixture\n');
  const evidence=new Evidence(join(root,'data'),'capture');
  let ticks=0;const timer=setInterval(()=>ticks++,1);
  try {
    const start=performance.now(),artifact=await captureArtifact(evidence,workspace),elapsed=performance.now()-start;
    assert.ok(ticks>0,`execution capture blocked terminal input for its entire ${elapsed.toFixed(1)} ms`);
    verifyArtifact(evidence.root,artifact);
    assert.ok(artifact.files.some(file=>file.path==='package.json'));
    assert.ok(artifact.files.some(file=>file.path==='dist/execution/source-build.json'));
  } finally {clearInterval(timer);evidence.close();}
});

test('asynchronous objects verify existing bytes and retain corruption failures', async () => {
  const root=mkdtempSync(join(tmpdir(),'durio-artifact-object-')),evidence=new Evidence(root,'capture');
  try {
    const bytes=Buffer.from('Original execution material\n'),ref=await evidence.blobAsync(bytes);
    assert.deepEqual(ref,{sha256:digest(bytes),bytes:28});
    assert.deepEqual(readObject(root,ref),bytes);
    assert.deepEqual(await evidence.blobAsync(bytes),ref);
    writeFileSync(join(root,'objects',ref.sha256),'changed');
    await assert.rejects(evidence.blobAsync(bytes),/EVIDENCE_CORRUPT/);
  } finally {evidence.close();}
});

test('capture failure waits for outstanding object writes before returning', async t => {
  const root=mkdtempSync(join(tmpdir(),'durio-artifact-failure-')),evidence=new Evidence(root,'capture');
  let active=0,first=true;
  t.mock.method(evidence,'blobAsync',async()=>{
    active++;const fail=first;first=false;
    try {await new Promise(resolve=>setTimeout(resolve,fail?1:30));if(fail)throw Error('fixture object fsync failed');return {sha256:'fixture',bytes:0};}
    finally {active--;}
  });
  try {await assert.rejects(captureArtifact(evidence,root),/fixture object fsync failed/);assert.equal(active,0,'no object writes may outlive capture failure and ownership release');}
  finally {evidence.close();}
});

test('cancelling during asynchronous capture releases the caller hold after writes and prevents provider dispatch', async t => {
  const root=mkdtempSync(join(tmpdir(),'durio-artifact-stop-')),workspace=join(root,'project');mkdirSync(workspace);
  const controller=new AbortController(),transport=demoTransport(),blob=Evidence.prototype.blobAsync;
  let entered!:()=>void,unblock!:()=>void,releases=0,active=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{unblock=resolve;});
  t.mock.method(Evidence.prototype,'blobAsync',async function(this:Evidence,bytes:string|Uint8Array){
    active++;entered();try{await blocked;return await blob.call(this,bytes);}finally{active--;}
  });
  const running=runReadTask({workspace,dataRoot:join(root,'data'),input:'probe',mode:'offline',transport:transport.fetch,signal:controller.signal,cancellation:'stop',
    beforeArtifactCapture:async()=>()=>{assert.equal(active,0);releases++;}});
  await started;controller.abort();unblock();
  const result=await running;
  assert.equal(result.status,'aborted');assert.equal(result.cleanup,'confirmed');assert.equal(releases,1);assert.equal(transport.calls.length,0);
  const saved=await readRun(join(root,'data'),result.runId);
  assert.equal(saved.records.some(record=>record.kind==='execution.artifact'),false,'a cancelled capture is not admitted for execution');
});
