import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { runRestricted, exportStopped } from '../boundary.mjs';

// A controller protocol fixture exercises host byte acquisition/teardown only.
// It does not claim VM isolation; the real VM checks below remain separate.
async function outputController(root, stream, payload, failStop = false, keepAlive = true) {
 const executable=join(root,'controller');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2),state=${JSON.stringify(join(root,'state.json'))};
 if(a[0]==='--version')console.log('version 1.4.1 ');
 else if(a[0]==='image')console.log(JSON.stringify([{configuration:{descriptor:{digest:'sha256:'+'a'.repeat(64)}}}]));
 else if(a[0]==='create'){const mounts=a.flatMap((v,i)=>v==='--mount'?[Object.fromEntries(a[i+1].split(',').map(p=>p.split('=')))]:[]);fs.writeFileSync(state,JSON.stringify({readOnly:true,resources:{memoryInBytes:536870912,cpus:1},image:{descriptor:{digest:'sha256:'+'a'.repeat(64)}},mounts:mounts.map(m=>({source:m.source,destination:m.target,options:m.readonly===undefined?['ro']:[]}))}));}
 else if(a[0]==='inspect'){const configuration=JSON.parse(fs.readFileSync(state));configuration.mounts.forEach(m=>m.options=m.destination==='/work'?[]:['ro']);console.log(JSON.stringify([{configuration,status:{state:'stopped'}}]));}
 else if(a[0]==='start'){process.${stream}.write(Buffer.from(${JSON.stringify(payload.subarray(0, payload.length-2).toString('base64'))},'base64'));setTimeout(()=>{process.${stream}.write(Buffer.from(${JSON.stringify(payload.subarray(-2).toString('base64'))},'base64'));if(${keepAlive})setInterval(()=>{},1000);},50);}
 else if(a[0]==='stop'&&${failStop})process.exit(72);
 else if(a[0]==='list')console.log('[]');
 `,{mode:0o700});return executable;
}

test('output limit preserves the complete acquired threshold event in both byte streams',async()=>{
 for(const stream of ['stdout','stderr']){
  const root=await mkdtemp(join(tmpdir(),'durio-output-bytes-')),input=join(root,'input');await mkdir(input);
  const cap=stream==='stdout'?16:1048576,payload=Buffer.concat([Buffer.alloc(cap-1,97),Buffer.from([0xff,0x80])]);
  const result=await runRestricted({image:'unused@sha256:'+'a'.repeat(64),inputDir:input,runDir:join(root,'run'),command:['unused'],timeoutMs:5000,protocolLimits:{inputBytes:16,responseBytes:16,lineBytes:1048576,totalBytes:16},containerExecutable:await outputController(root,stream,payload)});
  assert.equal(result.reason,'output_limit');assert.equal(result.terminated,true);
  assert.deepEqual(Buffer.concat(result.output[stream].chunks.map(chunk=>Buffer.from(chunk,'base64'))),payload);
  assert.equal(result.output[stream].bytes,payload.length);assert.equal(result.output[stream].displayTruncated,true);
  const reopened=JSON.parse(await readFile(join(root,'run/outcome.json'),'utf8'));
  assert.deepEqual(reopened.output,result.output);
 }
});

test('split UTF-8 decoding preserves protocol text while teardown uncertainty does not erase acquired bytes',async()=>{
 for(const failStop of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'durio-output-utf8-')),input=join(root,'input');await mkdir(input);
  const payload=Buffer.from('A🙂文');
  const result=await runRestricted({image:'unused@sha256:'+'a'.repeat(64),inputDir:input,runDir:join(root,'run'),command:['unused'],timeoutMs:5000,containerExecutable:await outputController(root,'stdout',payload,failStop,false)});
  assert.equal(result.stdout,'A🙂文');assert.deepEqual(Buffer.from(result.output.stdout.chunks[0],'base64'),payload);
  assert.equal(result.terminated,!failStop);assert.equal(result.reason,failStop?'termination_unconfirmed':null);
  if(failStop)await assert.rejects(exportStopped(result,[],join(root,'denied')),/termination_not_verified/);
 }
});

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

// No VM runs in these admission regressions. The actual boundary stages input,
// invokes a protocol controller and performs its normal cleanup sequence.
for(const phase of ['staging','create','configuration'])for(const trigger of ['deadline','cancelled'])test(`absolute admission: ${trigger} during ${phase} prevents the next side effect`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'durio-admission-')),input=join(root,'input');await mkdir(input);await writeFile(join(input,'fixed'),'fixed');
 const controller=await outputController(root,'stdout',Buffer.from('should not start'),false,false),marker=join(root,'cutoff');
 let source=await readFile(controller,'utf8');
 source=source.replace("const fs=require('node:fs');",`const fs=require('node:fs');if(process.argv[2]===${JSON.stringify(phase==='create'?'create':'inspect')})fs.writeFileSync(${JSON.stringify(marker)},'cutoff');`);
 await writeFile(controller,source);
 const abort=new AbortController(),now=Date.now(),deadline=new Date(now+60000).toISOString(),copy=fs.promises.cp;
 let expired=false;
 const trip=()=>{expired=true;if(trigger==='cancelled')abort.abort('test cancellation during preparation');};
 t.mock.method(Date,'now',()=>{if(phase!=='staging'&&existsSync(marker))trip();return now+(trigger==='deadline'&&expired?60001:0);});
 t.mock.method(fs.promises,'cp',async(...args)=>{const result=await copy(...args);if(phase==='staging')trip();return result;});syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await runRestricted({image:'unused@sha256:'+'a'.repeat(64),inputDir:input,runDir:join(root,'run'),command:['unused'],timeoutMs:5000,deadline,signal:abort.signal,containerExecutable:controller});
 assert.equal(result.status,'not-started');assert.equal(result.started,false);assert.equal(result.reason,trigger);
 assert.equal(result.admission.phase,phase==='staging'?'before-create':'before-start');
 assert.equal(result.terminated,phase!=='staging','no create must not claim external termination');
 assert.equal(result.control.some(c=>c.name==='create'),phase!=='staging');
 if(phase!=='staging')assert.deepEqual(result.control.slice(-4).map(c=>c.name),['stop','stopped','delete','absence']);
 const saved=JSON.parse(await readFile(join(root,'run/outcome.json'),'utf8'));assert.deepEqual(saved,result);
 await assert.rejects(exportStopped(result,['missing'],join(root,'export')));
});

test('absolute deadline truncates execution time without extending a sub-100ms remainder',async t=>{
 const root=await mkdtemp(join(tmpdir(),'durio-admission-timer-')),input=join(root,'input');await mkdir(input);
 const controller=await outputController(root,'stdout',Buffer.from('x'),false,true),now=Date.now();
 // Advance only once the configuration exists, leaving 20ms at actual start.
 t.mock.method(Date,'now',()=>now+(existsSync(join(root,'state.json'))?980:0));
 const start=performance.now();
 const result=await runRestricted({image:'unused@sha256:'+'a'.repeat(64),inputDir:input,runDir:join(root,'run'),command:['unused'],timeoutMs:5000,deadline:new Date(now+1000).toISOString(),containerExecutable:controller});
 assert.equal(result.reason,'timeout');assert.equal(result.started,true);assert.equal(result.terminated,true);assert.ok(performance.now()-start<3000,'5s relative timeout must be shortened by the absolute deadline');
});
