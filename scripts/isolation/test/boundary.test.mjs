import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRestricted, exportStopped } from '../boundary.mjs';

test('an unavailable isolation executable fails closed before candidate execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durio-unavailable-'));
  const input = join(root, 'input');
  await mkdir(input);
  await writeFile(join(input, 'run.mjs'), 'process.exit(99)');
  const result = await runRestricted({ image: 'unused@sha256:' + 'a'.repeat(64),
    inputDir: input, runDir: join(root, 'run'), command: ['node', '/input/run.mjs'],
    containerExecutable: '/definitely-not-an-isolation-executable', timeoutMs: 5_000 });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'isolation_unavailable');
  assert.equal(result.started, false);
  await assert.rejects(exportStopped(result, ['result.txt'], join(root, 'out')));
});

test('a forged termination record cannot authorize export', async () => {
  await assert.rejects(exportStopped({ terminated: true, workDir: '/tmp' }, [], '/tmp/not-created'));
});

test('real VM executes Node and terminates before a regular-file export', {
  skip: !process.env.DURIO_ISOLATION_IMAGE,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'durio-vm-test-'));
  const input = join(root, 'input');
  await mkdir(input);
  await writeFile(join(input, 'run.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync('/work/result.txt', '42');`);
  const result = await runRestricted({ image: process.env.DURIO_ISOLATION_IMAGE,
    inputDir: input, runDir: join(root, 'run'), command: ['node', '/input/run.mjs'], timeoutMs: 15_000 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.terminated, true);
  await exportStopped(result, ['result.txt'], join(root, 'out'));
  assert.equal(await readFile(join(root, 'out/result.txt'), 'utf8'), '42');
});

test('a real residual VM after a failed stop is invalid and cannot export', {
  skip: !process.env.DURIO_ISOLATION_IMAGE,
}, async t => {
  const root = await mkdtemp(join(process.env.DURIO_ISOLATION_EVIDENCE ?? tmpdir(), 'durio-stop-failure-'));
  t.diagnostic(`Retained evidence: ${root}`);
  const input = join(root, 'input'); await mkdir(input);
  await writeFile(join(input, 'run.mjs'), `
    const fs = await import('node:fs');
    fs.writeFileSync('/work/alive', 'x');
    setInterval(() => fs.appendFileSync('/work/alive', 'x'), 40);
  `);
  const wrapper = join(root, 'fail-stop');
  await writeFile(wrapper, `#!/opt/homebrew/bin/node\n
    if (process.argv[2] === 'stop') process.exit(72);
    const r = require('node:child_process').spawnSync('/opt/homebrew/bin/container', process.argv.slice(2), {stdio:'inherit'});
    process.exit(r.status ?? 73);
  `);
  await chmod(wrapper, 0o700);
  let result;
  try {
    result = await runRestricted({ image: process.env.DURIO_ISOLATION_IMAGE,
      inputDir: input, runDir: join(root, 'run'), command: ['node', '/input/run.mjs'],
      timeoutMs: 2500, containerExecutable: wrapper });
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'termination_unconfirmed');
    assert.equal(result.terminated, false);
    await assert.rejects(exportStopped(result, ['alive'], join(root, 'must-not-export')));
    const before = await readFile(join(root, 'run/work/alive'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    const after = await readFile(join(root, 'run/work/alive'), 'utf8');
    assert.ok(after.length > before.length, 'the negative fixture must contain actual surviving execution');
    await writeFile(join(root, 'residual-evidence.json'), JSON.stringify({ beforeBytes: before.length, afterBytes: after.length, exportDenied: true }));
  } finally {
    if (result?.id) {
      execFileSync('/opt/homebrew/bin/container', ['stop', '--time', '1', result.id]);
      execFileSync('/opt/homebrew/bin/container', ['delete', result.id]);
      const remaining = JSON.parse(execFileSync('/opt/homebrew/bin/container', ['list', '--all', '--format', 'json'], { encoding: 'utf8' }));
      assert.equal(remaining.some(item => item.id === result.id), false);
      await writeFile(join(root, 'cleanup.json'), JSON.stringify({ stopped: true, deleted: true, absent: true }));
    }
  }
});

test('host request count and cancellation bound concurrent guest requests', {
  skip: !process.env.DURIO_ISOLATION_IMAGE,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'durio-model-budget-'));
  const input = join(root, 'input'); await mkdir(input);
  await writeFile(join(input, 'run.mjs'), `
    for (const id of [1,2]) console.log(JSON.stringify({kind:'model.request',id,input:'x',maxOutputTokens:8}));
    setInterval(()=>{},1000);
  `);
  for (const pending of [false, true]) {
    let calls = 0, observedSignal;
    const result = await runRestricted({ image: process.env.DURIO_ISOLATION_IMAGE,
      inputDir: input, runDir: join(root, pending ? 'pending' : 'quota'), command: ['node', '/input/run.mjs'], timeoutMs: 2500,
      model: { maxRequests: 1, maxOutputTokens: 8, request: ({ signal }) => {
        calls++; observedSignal = signal;
        if (!pending) return '42';
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      } } });
    assert.equal(calls, 1);
    assert.equal(result.reason, pending ? 'timeout' : 'model_request_denied');
    assert.equal(result.terminated, true);
    assert.equal(observedSignal.aborted, true);
    assert.equal(result.modelRequests[0].status, pending ? 'unknown' : 'completed');
  }
});

test('unknown resource profiles are rejected before filesystem or controller effects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durio-profile-denied-'));
 await assert.rejects(runRestricted({image:'unused@sha256:'+'a'.repeat(64),inputDir:root,runDir:join(root,'not-created'),command:['node','--version'],timeoutMs:1000,resourceProfile:'unbounded'}),/invalid_resource_profile/);
});
test('fixed build resources and unchanged default resources are inspected before real execution',{skip:!process.env.DURIO_ISOLATION_IMAGE},async()=>{
 const root=await mkdtemp(join(tmpdir(),'durio-build-profile-')),input=join(root,'input');await mkdir(input);
 for(const [profile,bytes]of [['default',536870912],['typescript-build',1073741824]]){
  const result=await runRestricted({image:process.env.DURIO_ISOLATION_IMAGE,inputDir:input,runDir:join(root,profile),command:['node','--input-type=module','-e',"import v8 from'node:v8';console.log(JSON.stringify({heap:v8.getHeapStatistics().heap_size_limit,options:process.env.NODE_OPTIONS??null}));"],timeoutMs:15000,resourceProfile:profile});
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.terminated,true);assert.equal(result.resources.memoryBytes,bytes);assert.equal(result.observedResources.memoryBytes,bytes);
  const observed=JSON.parse(result.stdout);if(profile==='typescript-build'){assert.equal(observed.options,'--max-old-space-size=768');assert.ok(observed.heap>=768*1024*1024&&observed.heap<850*1024*1024);}else assert.equal(observed.options,null);
 }
});
