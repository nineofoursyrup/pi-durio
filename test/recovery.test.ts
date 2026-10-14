import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadTask, runCodingTask, readRun, inspectRecovery, checkRecovery, recoverRun, settleRecoveryOwners } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { digest, Evidence } from '../src/evidence.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'durio-recovery-'));
  const workspace = join(root, 'project'), dataRoot = join(root, 'data');
  await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'Recovery fixture\n');
  return { root, workspace, dataRoot };
}
async function contents(root: string): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  async function walk(path: string, prefix = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${item.name}`;
      if (item.isDirectory()) await walk(join(path,item.name), `${key}/`);
      else files[key] = digest(await readFile(join(path,item.name)));
    }
  }
  await walk(root); return files;
}
test('reopening committed results scans all durable receipts without rewriting sources, replay or usage', async () => {
  const paths = await fixture();
  const transport = scriptedTransport([{ name: 'write', args: { path: 'once.txt', content: 'one effect' } }]);
  const result = await runCodingTask({ ...paths, input: 'Write once', mode: 'offline', transport: transport.fetch });
  assert.equal(result.status, 'completed');
  const before = await contents(paths.dataRoot);
  const report = await inspectRecovery({ dataRoot: paths.dataRoot, runId: result.runId });
  assert.equal(report.status, 'completed');
  assert.equal(report.exitCode, 0);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(await contents(paths.dataRoot), before);
  assert.deepEqual((await readRun(paths.dataRoot, result.runId)).result, JSON.parse(JSON.stringify(result)));
  assert.equal(await readFile(join(paths.workspace,'once.txt'),'utf8'), 'one effect');
});

async function interruptedRead() {
  const paths=await fixture();const controller=new AbortController();
  const result=await runReadTask({...paths,input:'Read the fixture',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('interrupted')));controller.abort();})});
  const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read'] as const};
  return {paths,result,authorization};
}
test('permission/configuration/content drift stays read-only; explicit end quarantines the exact old store and permits a new task',async()=>{
  const {paths,result,authorization}=await interruptedRead();
  const denied={...authorization,tools:[]};
  const before=await contents(paths.dataRoot);
  const report=await inspectRecovery({...paths,runId:result.runId,authorization:denied});
  assert.equal(report.status,'blocked');assert.ok(report.reasons.includes('CURRENT_PERMISSION_CHANGED'));
  assert.deepEqual(await contents(paths.dataRoot),before);
  const transport=scriptedTransport([]);
  const refused=await recoverRun({...paths,runId:result.runId,authorization:denied,decision:{id:'no-permission',action:'continue',snapshotId:report.snapshotId,acceptAdditionalModelAttempts:true},transport:transport.fetch});
  assert.equal(refused.status,'blocked');assert.equal(transport.calls.length,0);
  const ended=await recoverRun({...paths,runId:result.runId,authorization:denied,decision:{id:'end-old',action:'end',snapshotId:report.snapshotId}});
  assert.equal(ended.status,'ended');
  const fresh=await runReadTask({...paths,input:'A newly authorized task',mode:'offline',transport:transport.fetch});
  assert.equal(fresh.status,'completed');assert.notEqual(fresh.runId,result.runId);
  assert.equal(((await readRun(paths.dataRoot,result.runId)).result as any).status,'unknown');

  const changed=await interruptedRead();
  const original=await readRun(changed.paths.dataRoot,changed.result.runId);
  const config=original.records.find(r=>r.kind==='execution.config')!.data as any;
  const evidence=new Evidence(changed.paths.dataRoot,changed.result.runId);
  evidence.append('execution.config',{...config,instructions:'Changed execution instructions'});evidence.close();
  const drift=await inspectRecovery({...changed.paths,runId:changed.result.runId,authorization:changed.authorization});
  assert.ok(drift.reasons.includes('EXECUTION_CONFIGURATION_CHANGED'));
  const {rm}=await import('node:fs/promises');
  const artifact=original.records.find(r=>r.kind==='execution.artifact')!.data as any;
  await rm(join(changed.paths.dataRoot,'objects',artifact.files[0].sha256));
  const missing=await inspectRecovery({...changed.paths,runId:changed.result.runId,authorization:changed.authorization});
  assert.equal(missing.status,'blocked');assert.ok(missing.reasons.some(reason=>reason.includes('ENOENT')));
});

test('the whole Harness is checked: managing one run never schedules another conversation or queued submission',async()=>{
  const {paths,result,authorization}=await interruptedRead();
  const {Harness,createRegistry,GenerationTask}=await import('@earendil-works/pi-durable');
  const {createModels}=await import('@earendil-works/pi-ai');
  const {BACKGROUND_CONTEXT:context}=await import('@earendil-works/chord/context');
  const {openNodeSqliteStorage}=await import('@earendil-works/pi-durable/storage/sqlite/node');
  const {acquireOwner}=await import('../src/ownership.js');
  const owner=await acquireOwner(paths.dataRoot,()=>{});
  const harness=await Harness.open(await openNodeSqliteStorage(join(paths.dataRoot,'sessions',result.sessionId,'durable.sqlite')),{models:createModels(),registry:createRegistry()},context);
  const foreign=await harness.createConversation({ownership:{kind:'ownerless'}},context);
  await foreign.commit(async tx=>{await tx.createTask(GenerationTask,{},{ownership:{kind:'conversation'}});await tx.createSubmission({type:'input',status:'queued',conversationId:foreign.id,requestId:'foreign'});},context);
  const original=await harness.root(context);
  await original.commit(tx=>tx.createTask(GenerationTask,{},{ownership:{kind:'conversation'}}),context);
  await harness.close(context);await owner.release();
  const before=await contents(paths.dataRoot);
  const report=await inspectRecovery({...paths,runId:result.runId,authorization});
  assert.equal(report.status,'blocked');assert.ok(report.reasons.includes('OTHER_PENDING_TASK_OR_UNSUPPORTED_DEFINITION'));assert.ok(report.reasons.includes('OTHER_PENDING_SUBMISSION'));assert.ok(report.reasons.includes('OTHER_PENDING_TASK_OUTSIDE_ACCEPTED_RUN'));
  assert.deepEqual(await contents(paths.dataRoot),before);
  const transport=scriptedTransport([]);
  for(const action of ['continue','end'] as const){const blocked=await recoverRun({...paths,runId:result.runId,authorization,decision:{id:`foreign-${action}`,snapshotId:report.snapshotId,action,acceptAdditionalModelAttempts:true},transport:transport.fetch});assert.equal(blocked.status,'blocked');}
  assert.equal(transport.calls.length,0);
  await assert.rejects(runReadTask({...paths,input:'No bypass through new submit',mode:'offline',transport:transport.fetch}),/RECOVERY_REQUIRED/);
});

test('a stale decision cannot consume new facts; model retries retain unknown usage and their eight-attempt budget',async()=>{
  const {paths,result,authorization}=await interruptedRead();
  const report=await checkRecovery({...paths,runId:result.runId,authorization});
  const evidence=new Evidence(paths.dataRoot,result.runId);
  evidence.append('model.intent',{attemptId:'independent-new-fact',ordinal:2});evidence.close();
  const transport=scriptedTransport([]);
  await assert.rejects(recoverRun({...paths,runId:result.runId,authorization,decision:{id:'stale',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:transport.fetch}),/STALE_RECOVERY_DECISION/);
  const current=await checkRecovery({...paths,runId:result.runId,authorization});
  assert.equal(current.remainingModelAttempts,6);assert.ok(current.unknownModelAttempts.includes('independent-new-fact'));
  const recovered=await recoverRun({...paths,runId:result.runId,authorization,decision:{id:'current',snapshotId:current.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:transport.fetch});
  assert.equal(recovered.status,'completed');assert.equal((recovered as any).usage.completeness,'partial');
});

test('a retained owner needs observed managed cleanup as well as explicit disposition; raw crash and active owner remain fenced',async()=>{
  const {spawnSync}=await import('node:child_process');
  for(const mode of ['late-close','crash'] as const) {
    const paths=await fixture();
    const program=`import {runReadTask} from './dist/src/runtime.js';
      const controller=new AbortController();let respond;
      const result=await runReadTask(${JSON.stringify({...paths,input:'Hold provider',mode:'offline',cancellation:'exit',cleanupTimeoutMs:10})}&&{
        ...${JSON.stringify({...paths,input:'Hold provider',mode:'offline',cancellation:'exit',cleanupTimeoutMs:10})},signal:controller.signal,
        onObservation:event=>{if(${JSON.stringify(mode)}==='crash'&&event.kind==='model.dispatch'){console.log(JSON.stringify({runId:event.runId}));process.kill(process.pid,'SIGKILL');}},
        transport:async()=>new Promise(resolve=>{respond=resolve;controller.abort();})
      });
      console.log(JSON.stringify(result));
      respond(new Response('data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}}));
      setTimeout(()=>process.exit(0),120);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:process.cwd(),encoding:'utf8'});
    if(mode==='late-close')assert.equal(child.status,0,child.stderr);else assert.equal(child.signal,'SIGKILL');
    const output=JSON.parse(child.stdout.trim());
    const options={...paths,runId:output.runId,authorization:{workspace:paths.workspace,mode:'offline' as const,tools:['read'] as const}};
    const blocked=await checkRecovery(options);
    assert.equal(blocked.status,'blocked');assert.equal(blocked.persistence,'saved-separate-owner-report');
    const markers=blocked.ownerClaims!;assert.ok(markers.length);
    const decision={id:'dispose-owner',snapshotId:blocked.snapshotId,action:'confirm-cleanup' as const,acceptUnknownExternalEffects:true};
    const settled=await settleRecoveryOwners({...options,decision});
    if(mode==='crash') {
      assert.ok(settled.reasons.some(reason=>reason.includes('CLEANUP_EVIDENCE_REQUIRED')));
      for(const claim of markers)assert.equal(digest(await readFile(join(claim.path,'owner.json'))),claim.markerSha256);
    } else {
      for(const claim of markers)await assert.rejects(readFile(join(claim.path,'owner.json')),/ENOENT/);
      assert.deepEqual(await settleRecoveryOwners({...options,decision}),settled);
      const report=await checkRecovery(options);assert.equal(report.status,'needs-decision',JSON.stringify(report));
      const next=scriptedTransport([]);
      const done=await recoverRun({...options,decision:{id:'after-confirmed-close',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:next.fetch});
      assert.equal(done.status,'completed');assert.notEqual((done as any).usage.completeness,'known');
      assert.equal(((await readRun(paths.dataRoot,output.runId)).result as any).cleanup,'unknown');
    }
  }
  const active=await interruptedRead();
  const {acquireOwner}=await import('../src/ownership.js');
  const owner=await acquireOwner(active.paths.dataRoot,()=>{});
  try {
    const report=await inspectRecovery({...active.paths,runId:active.result.runId});
    await assert.rejects(settleRecoveryOwners({...active.paths,runId:active.result.runId,decision:{id:'cannot-steal',snapshotId:report.snapshotId,action:'confirm-cleanup',acceptUnknownExternalEffects:true}}),/OWNER_IDENTITY_UNVERIFIED|OWNER_STILL_ALIVE/);
    owner.assertHeld();
  } finally {await owner.release();}
});

test('headless recovery saves a machine-readable input request and true readonly inspect changes no source',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {paths,result,authorization}=await interruptedRead();
  const auth=join(paths.root,'authorization.json');await writeFile(auth,JSON.stringify(authorization));
  const cli=['dist/src/cli.js','recover','--run',result.runId,'--data-root',paths.dataRoot,'--authorization',auth];
  const before=await contents(paths.dataRoot);
  const inspect=spawnSync(process.execPath,[...cli,'--inspect'],{encoding:'utf8'});
  assert.equal(inspect.status,75,inspect.stderr);assert.equal(JSON.parse(inspect.stdout).status,'needs-decision');
  assert.deepEqual(await contents(paths.dataRoot),before);
  const check=spawnSync(process.execPath,cli,{encoding:'utf8'});
  assert.equal(check.status,75,check.stderr);const report=JSON.parse(check.stdout);assert.equal(report.persistence,'saved');
  const saved=(await readRun(paths.dataRoot,result.runId)).records.filter(r=>r.kind==='recovery.report');
  assert.ok(saved.some(r=>(r.data as any).snapshotId===report.snapshotId));
  const decision=join(paths.root,'decision.json');await writeFile(decision,JSON.stringify({id:'cli-continue',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true}));
  const continued=spawnSync(process.execPath,[...cli,'--decision',decision,'--offline-demo'],{encoding:'utf8'});
  assert.equal(continued.status,0,continued.stderr);assert.equal(JSON.parse(continued.stdout).status,'completed');
});

test('cross-store admission gaps use the committed request identity and never blindly submit it again',async()=>{
  for(const failure of ['submission.intent','submission.accepted']) {
    const paths=await fixture();let once=true;
    const result=await runReadTask({...paths,input:'Read once',mode:'offline',transport:scriptedTransport([]).fetch,fault:kind=>{if(kind===failure&&once){once=false;throw new Error(`first admission failure:${failure}`);}}});
    const authorization={workspace:paths.workspace,mode:'offline' as const,tools:['read'] as const};
    const report=await checkRecovery({...paths,runId:result.runId,authorization});
    const transport=scriptedTransport([]);
    const recovered=await recoverRun({...paths,runId:result.runId,authorization,decision:{id:'admission-check',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:transport.fetch});
    if(failure==='submission.intent') {
      assert.equal(recovered.status,'blocked');assert.equal(transport.calls.length,0);assert.ok((recovered as any).reasons.some((reason:string)=>reason.startsWith('CROSS_STORE_GAP')));
    }else{
      assert.equal(recovered.status,'completed',JSON.stringify(recovered));
      assert.equal((await inspectRecovery({...paths,runId:result.runId})).session!.submissionCount,1);
      const page=await readRun(paths.dataRoot,result.runId);assert.equal(page.records.filter(r=>r.kind==='submission.intent').length,1);assert.equal(page.records.filter(r=>r.kind==='submission.accepted').length,0);assert.equal((page.result as any).status,'unknown');
    }
  }
});

test('explicit continuation after a pre-dispatch exit preserves the original unknown and performs the authorized effect once', async () => {
  const paths = await fixture();
  const stop = new AbortController();
  const initial = scriptedTransport([{ name: 'bash', args: { command: 'printf effect >> effects.txt' } }]);
  const result = await runCodingTask({ ...paths, input: 'Append exactly one effect', mode: 'offline', transport: initial.fetch,
    signal: stop.signal, cancellation: 'exit', onObservation: event => { if (event.kind === 'tool.intent') stop.abort(); } });
  assert.equal(result.status, 'unknown');
  await assert.rejects(readFile(join(paths.workspace, 'effects.txt')), /ENOENT/);
  const authorization = { workspace: paths.workspace, mode: 'offline' as const, tools: ['read', 'write', 'edit', 'bash'] as const };
  const report = await checkRecovery({ ...paths, runId: result.runId, authorization });
  assert.equal(report.status, 'needs-decision', JSON.stringify(report));
  assert.ok(report.tools.some(tool => tool.fact === 'not-dispatched'));
  const transport = scriptedTransport([{ name: 'bash', args: { command: 'printf effect >> effects.txt' } }]);
  const decision = { id: 'continue-safe', snapshotId: report.snapshotId, action: 'continue' as const, acceptAdditionalModelAttempts: true };
  const continued = await recoverRun({ ...paths, runId: result.runId, authorization, decision, transport: transport.fetch });
  assert.equal(continued.status, 'completed', JSON.stringify(continued));
  assert.equal(await readFile(join(paths.workspace, 'effects.txt'), 'utf8'), 'effect');
  assert.equal(((await readRun(paths.dataRoot, result.runId)).result as any).status, 'unknown');
  const calls = transport.calls.length;
  const repeated = await recoverRun({ ...paths, runId: result.runId, authorization, decision, transport: transport.fetch });
  assert.deepEqual(repeated, JSON.parse(JSON.stringify(continued)));
  assert.equal(transport.calls.length, calls);
});

test('a completed effect without its durable commit continues with read-only capabilities even for equivalent new calls', async () => {
  const paths = await fixture();
  const stop = new AbortController();
  const first = scriptedTransport([{ name: 'bash', args: { command: 'printf effect >> effects.txt' } }]);
  const result = await runCodingTask({ ...paths, input: 'Append once', mode:'offline', transport:first.fetch, signal:stop.signal,cancellation:'exit',onObservation:event => {if(event.kind==='tool.result')stop.abort();} });
  assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),'effect');
  const authorization = { workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const };
  const report = await checkRecovery({...paths,runId:result.runId,authorization});
  assert.equal(report.status,'needs-decision',JSON.stringify(report));
  assert.ok(report.tools.some(tool => tool.fact==='completed-uncommitted'));
  const again = scriptedTransport([{name:'bash',args:{command:'echo -n effect >> ./effects.txt'}},{name:'write',args:{path:'equivalent.txt',content:'must not write'}}]);
  const recovered = await recoverRun({...paths,runId:result.runId,authorization,decision:{id:'no-repeat',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:again.fetch});
  assert.equal(recovered.status,'completed',JSON.stringify(recovered));
  assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),'effect');
  await assert.rejects(readFile(join(paths.workspace,'equivalent.txt')),/ENOENT/);
  const records = await readRun(paths.dataRoot,result.runId);
  assert.equal((records.result as any).status,'unknown');
  assert.equal(records.records.filter(r => r.kind==='recovery.capability-denied').length,2);
  assert.ok(records.records.some(r=>r.kind==='recovery.closed'));
});

test('unknown post-effect outcome needs durable headless input; an explicit retry keeps original failure and its duplicate risk', async () => {
  const paths = await fixture();
  const first = scriptedTransport([{name:'bash',args:{command:'printf effect >> effects.txt'}}]);
  let fail = true;
  const result = await runCodingTask({...paths,input:'Append once',mode:'offline',transport:first.fetch,fault:kind=>{if(kind==='tool.result'&&fail){fail=false;throw new Error('first result persistence failure');}}});
  assert.equal(result.status,'unknown');
  const authorization = {workspace:paths.workspace,mode:'offline' as const,tools:['read','write','edit','bash'] as const};
  const report = await checkRecovery({...paths,runId:result.runId,authorization});
  const uncertain = report.tools.find(tool=>tool.fact==='unknown')!;
  assert.ok(uncertain,JSON.stringify(report));
  const again = scriptedTransport([{name:'bash',args:{command:'printf effect >> effects.txt'}}]);
  const denied = await recoverRun({...paths,runId:result.runId,authorization,decision:{id:'missing-choice',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:again.fetch});
  assert.equal(denied.status,'needs-decision');
  assert.equal((denied as any).exitCode,75);
  assert.equal(again.calls.length,0);
  assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),'effect');
  const decision = {id:'explicit-risk',snapshotId:report.snapshotId,action:'continue' as const,acceptAdditionalModelAttempts:true,resolutions:[{taskId:uncertain.taskId,choice:'retry' as const,reason:'Operator accepts that the earlier append may have occurred and another append may duplicate it.'}]};
  const retried = await recoverRun({...paths,runId:result.runId,authorization,decision,transport:again.fetch});
  assert.equal(retried.status,'completed',JSON.stringify(retried));
  assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),'effecteffect');
  assert.notEqual((retried as any).usage.completeness,'known');
  const page = await readRun(paths.dataRoot,result.runId);
  assert.equal((page.result as any).status,'unknown');
  assert.ok(page.records.some(r=>r.kind==='evidence.gap'));
  assert.ok(page.records.some(r=>r.kind==='recovery.decision'&&(r.data as any).decision.id==='explicit-risk'));
});
