import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runReadTask, readRun } from '../src/runtime.js';

const fixture = async () => ({ dataRoot: await mkdtemp(join(tmpdir(), 'durio-lifecycle-')), workspace: resolve('test/fixtures/project') });

test('first cancellation intent remains stop despite a later exit request during cleanup', async () => {
  const paths = await fixture();
  const controller = new AbortController();
  let action: 'stop' | 'exit' = 'stop';
  let calls = 0;
  const result = await runReadTask({ ...paths, input: 'Wait for cancellation', mode: 'offline', signal: controller.signal,
    get cancellation() { return action; },
    transport: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { action = 'exit'; controller.abort(); setTimeout(() => reject(new Error('cancelled')), 20); }, { once: true });
        controller.abort();
      });
    }
  });
  assert.equal(result.status, 'aborted', JSON.stringify(result));
  const view = await readRun(paths.dataRoot, result.runId);
  assert.equal(view.records.filter(r => r.kind === 'run.abort-intent').length, 1);
  assert.equal(view.records.filter(r => r.kind === 'run.exit-intent').length, 0);
  assert.ok(view.records.some(r => r.kind === 'lifecycle.processing'));
  assert.equal(calls, 1);
});

test('cleanup deadline keeps unknown and ownership while a late transport response remains writable', async () => {
  const paths = await fixture();
  const controller = new AbortController();
  let respond!: (response: Response) => void;
  let runId = '';
  const result = await runReadTask({ ...paths, input: 'Hold the transport', mode: 'offline', signal: controller.signal, cancellation: 'exit', cleanupTimeoutMs: 30,
    transport: async () => new Promise(resolve => { respond = resolve; controller.abort(); }),
    onObservation: event => { runId = event.runId; }
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'unknown');
  assert.match(result.reason!, /CLEANUP_TIMEOUT/);
  await assert.rejects(runReadTask({ ...paths, input: 'Cannot steal an owner', mode: 'offline', transport: async () => { throw new Error('must not dispatch'); } }), /OWNER_CONFLICT/);
  respond(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  for (let i = 0; i < 100; i++) {
    const view = await readRun(paths.dataRoot, runId);
    if (view.records.some(r => r.kind === 'lifecycle.late-close')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const view = await readRun(paths.dataRoot, runId);
  const receipt = view.records.find(r => r.kind === 'run.closed')!;
  assert.ok(view.records.some(r => r.kind === 'model.http' && r.seq > receipt.seq), 'late HTTP response metadata retained after timeout');
  assert.equal((view.result as any).cleanup, 'unknown');
  assert.ok(view.records.some(r => r.kind === 'lifecycle.late-close'));
  assert.equal(view.records.filter(r => r.kind === 'model.intent').length, 1);
  await assert.rejects(runReadTask({ ...paths, input: 'Late close is not recovery approval', mode: 'offline', transport: async () => { throw new Error('must not dispatch'); } }), /OWNER_CONFLICT/);
});

test('cancelling only a caller wait leaves the task running and does not create another attempt', async () => {
  const paths = await fixture();
  const { waitForRun } = await import('../src/runtime.js');
  const { scriptedTransport } = await import('../src/offline.js');
  const script = scriptedTransport([]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const running = runReadTask({ ...paths, input: 'Continue without this waiter', mode: 'offline', transport: async (...args) => { started(); await gate; return script.fetch(...args); } });
  await ready;
  const waiting = new AbortController();
  const waiter = waitForRun(running, waiting.signal);
  waiting.abort();
  await assert.rejects(waiter, /abort|cancel/i);
  assert.equal(script.calls.length, 0);
  release();
  const result = await waitForRun(running);
  assert.equal(result.status, 'completed');
  assert.equal(script.calls.length, 1);
  const view = await readRun(paths.dataRoot, result.runId);
  assert.equal(view.records.filter(r => /intent/.test(r.kind) && /abort|exit/.test(r.kind)).length, 0);
});

test('a request cancelled before acceptance never opens a run or dispatches', async () => {
  const paths = await fixture();
  await assert.rejects(runReadTask({ ...paths, input: 'Already cancelled', mode: 'offline', signal: AbortSignal.abort(), cancellation: 'stop', transport: async () => { throw new Error('must not dispatch'); } }), /RUN_CANCELLED_BEFORE_ACCEPTANCE/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(paths.dataRoot, 'host.sqlite')), false);
});

test('owner evidence fences an unconfirmed process exit even when the lock library removed its lock directory', async () => {
  const { spawnSync } = await import('node:child_process');
  const { acquireOwner } = await import('../src/ownership.js');
  const paths = await fixture();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquireOwner} from './dist/src/ownership.js'; await acquireOwner(${JSON.stringify(paths.dataRoot)}, () => {}); process.exit(0);`], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(child.status, 0, child.stderr);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(`${paths.dataRoot}.lock`), false, 'library exit cleanup removed the advisory directory');
  assert.equal(existsSync(join(paths.dataRoot, 'owner.json')), true, 'persistent owner is still unresolved');
  await assert.rejects(acquireOwner(paths.dataRoot, () => {}), /OWNER_CONFLICT/);
});

test('initialization and acceptance races freeze the first intent and stop all new dispatch', async () => {
  for (const during of ['initialization', 'acceptance'] as const) {
    const paths = await fixture();
    const controller = new AbortController();
    let action: 'stop' | 'exit' = 'stop';
    let calls = 0;
    const options = { ...paths, input: 'Stop before dispatch', mode: 'offline' as const, signal: controller.signal,
      get cancellation() { return action; }, transport: async () => { calls++; throw new Error('must not dispatch'); },
      onObservation(event: { kind: string }) { if (during === 'acceptance' && event.kind === 'task.accepted') { controller.abort(); action = 'exit'; } }
    };
    const running = runReadTask(options);
    if (during === 'initialization') {
      controller.abort(); action = 'exit';
      await assert.rejects(running, /RUN_CANCELLED_BEFORE_ACCEPTANCE: stop/);
    } else {
      const result = await running;
      assert.equal(result.status, 'aborted', JSON.stringify(result));
      const page = await readRun(paths.dataRoot, result.runId);
      assert.equal(page.records.filter(r => r.kind === 'run.abort-intent').length, 1);
      assert.equal(page.records.filter(r => r.kind === 'submission.accepted').length, 0);
    }
    assert.equal(calls, 0);
  }
});

test('stop failure and storage close failure preserve unknown, original failure and ownership', async () => {
  for (const faultAt of ['conversation.abort', 'storage.close']) {
    const paths = await fixture();
    const controller = new AbortController();
    const result = await runReadTask({ ...paths, input: 'Exercise a real shutdown boundary', mode: 'offline', signal: controller.signal, cancellation: 'stop',
      transport: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); controller.abort(); }),
      fault: kind => { if (kind === faultAt) throw new Error(`injected ${faultAt} failure`); }
    });
    assert.equal(result.status, 'unknown');
    assert.equal(result.cleanup, 'unknown');
    assert.match(result.reason!, new RegExp(`injected ${faultAt} failure`));
    const page = await readRun(paths.dataRoot, result.runId);
    assert.equal(page.records.filter(r => r.kind === 'run.abort-intent').length, 1);
    assert.ok(page.records.some(r => r.kind === (faultAt === 'conversation.abort' ? 'lifecycle.abort-failed' : 'lifecycle.close-failed')));
    assert.equal(result.lifecycle?.owner, 'retained');
    await assert.rejects(runReadTask({ ...paths, input: 'Unsafe retry', mode: 'offline', transport: async () => { throw new Error('must not dispatch'); } }), /OWNER_CONFLICT/);
  }
});

test('real long command and child finish or cancel before storage closes, retaining actual target effects', async () => {
  const { writeFile, readFile, mkdir } = await import('node:fs/promises');
  const { runCodingTask } = await import('../src/runtime.js');
  const { scriptedTransport } = await import('../src/offline.js');
  for (const action of ['finish', 'stop', 'exit', 'timeout'] as const) {
    const root = await mkdtemp(join(tmpdir(), `durio-child-${action}-`));
    const workspace = join(root, 'project');
    await mkdir(workspace);
    await writeFile(join(workspace, 'child.cjs'), `const fs=require('node:fs'); let n=0; fs.writeFileSync('child.pid',String(process.pid)); const t=setInterval(()=>{ fs.appendFileSync('effects.txt','child-'+(++n)+'\\n'); console.log('child-'+n); if(process.argv[2]==='finish' && n===5)clearInterval(t); },30);`);
    await writeFile(join(workspace, 'parent.cjs'), `const fs=require('node:fs'); const cp=require('node:child_process'); fs.writeFileSync('parent.pid',String(process.pid)); fs.appendFileSync('starts.txt','start\\n'); const child=cp.spawn(process.execPath,['child.cjs',process.argv[2]],{stdio:['ignore','pipe','pipe']}); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on('close',()=>console.log('parent-finished'));`);
    const controller = new AbortController();
    const transport = scriptedTransport([{ name: 'bash', args: { command: `'${process.execPath}' parent.cjs ${action}`, ...(action === 'timeout' ? { timeout: 0.2 } : {}) } }, { name: 'write', args: { path: 'after.txt', content: 'new work' } }]);
    const result = await runCodingTask({ workspace, dataRoot: join(root, 'data'), input: 'Run the controlled child process fixture', mode: 'offline', transport: transport.fetch, signal: controller.signal, cancellation: action === 'stop' ? 'stop' : 'exit',
      onObservation: event => { if ((action === 'stop' || action === 'exit') && event.kind === 'tool.output') controller.abort(); }
    });
    assert.equal(result.cleanup, 'confirmed', JSON.stringify(result));
    assert.equal(result.status, action === 'stop' ? 'aborted' : action === 'exit' ? 'unknown' : 'completed');
    assert.equal(await readFile(join(workspace, 'starts.txt'), 'utf8'), 'start\n');
    const effects = await readFile(join(workspace, 'effects.txt'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await readFile(join(workspace, 'effects.txt'), 'utf8'), effects);
    for (const name of ['child.pid', 'parent.pid']) assert.throws(() => process.kill(Number((readFileSync(join(workspace, name)))), 0), /ESRCH/);
    if (action === 'finish') assert.equal(effects, 'child-1\nchild-2\nchild-3\nchild-4\nchild-5\n');
    const page = await readRun(join(root, 'data'), result.runId);
    const shell = page.records.find(r => r.kind === 'shell.completed')!;
    assert.ok(shell.seq < page.records.find(r => r.kind === 'lifecycle.storage-closing')!.seq);
    if (action === 'stop' || action === 'exit') {
      assert.equal(transport.calls.length, 1);
      await assert.rejects(readFile(join(workspace, 'after.txt')), /ENOENT/);
      const snapshot = page.records.find(r => r.kind === 'durable.closed-snapshot')!.data as any;
      assert.equal(snapshot.pending.length === 0, action === 'stop');
    }
    if (action === 'timeout') {
      assert.equal((shell.data as any).acquired.code, 'timeout');
      assert.match(JSON.stringify(page.records.filter(r => r.kind === 'tool.error')), /Command timed out/);
    }
  }
});

import { readFileSync } from 'node:fs';

test('a cancellation at the final model or shell dispatch boundary cannot launch that operation', async () => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const { runCodingTask } = await import('../src/runtime.js');
  const { scriptedTransport } = await import('../src/offline.js');
  for (const boundary of ['model.dispatch', 'shell.started']) {
    const root = await mkdtemp(join(tmpdir(), 'durio-dispatch-stop-'));
    const workspace = join(root, 'project');
    await mkdir(workspace);
    const controller = new AbortController();
    const script = scriptedTransport([{ name: 'bash', args: { command: 'printf forbidden > forbidden.txt' } }]);
    const result = await runCodingTask({ workspace, dataRoot: join(root, 'data'), input: 'Stop at dispatch', mode: 'offline', transport: script.fetch, signal: controller.signal, cancellation: 'stop',
      onObservation: event => { if (event.kind === boundary) controller.abort(); }
    });
    assert.equal(result.status, 'aborted');
    if (boundary === 'model.dispatch') assert.equal(script.calls.length, 0);
    else await assert.rejects(readFile(join(workspace, 'forbidden.txt')), /ENOENT/);
  }
});

test('headless SIGINT and SIGTERM show processing and persist distinct first intent', async () => {
  const { spawn } = await import('node:child_process');
  const { openHostReadonly } = await import('../src/evidence.js');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const paths = await fixture();
    const child = spawn(process.execPath, ['dist/src/cli.js', 'run', '--workspace', paths.workspace, '--data-root', paths.dataRoot, '--prompt', 'Read README.md', '--offline-demo', '--cleanup-timeout-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    let accepted = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      try { const db = openHostReadonly(paths.dataRoot); try { accepted = Boolean(db.prepare("SELECT run_id FROM records WHERE kind='task.accepted'").get()); } finally { db.close(); } } catch { /* Waiting for actual acceptance. */ }
      if (accepted) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(accepted, true, stderr);
    child.kill(signal);
    const code = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 75, stdout + stderr);
    assert.match(stderr, /"state":"processing"/);
    const result = JSON.parse(stdout);
    assert.equal(result.lifecycle.intent, signal === 'SIGINT' ? 'stop' : 'exit');
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(((await readRun(paths.dataRoot, result.runId)).result as any).status, signal === 'SIGINT' ? 'aborted' : 'unknown');
  }
});

test('lost owner heartbeat stops dispatch and retains unknown without releasing unconfirmed ownership', async () => {
  const paths = await fixture();
  const { rm } = await import('node:fs/promises');
  let dispatches = 0;
  const result = await runReadTask({ ...paths, input: 'Hold until the owner is compromised', mode: 'offline', transport: async (_url, init) => {
    dispatches++;
    await rm(`${paths.dataRoot}.lock`, { recursive: true });
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled after owner lost')), { once: true }));
  } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'unknown');
  assert.equal(dispatches, 1);
  const view = await readRun(paths.dataRoot, result.runId);
  assert.ok(view.records.some(r => r.kind === 'lifecycle.owner-lost'));
  assert.equal((view.result as any).lifecycle.owner, 'retained');
  await assert.rejects(runReadTask({ ...paths, input: 'Do not steal owner identity', mode: 'offline', transport: async () => { throw new Error('must not dispatch'); } }), /OWNER_CONFLICT/);
});
