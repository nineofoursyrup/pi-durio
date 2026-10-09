import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runReadTask, readRun } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';

test('rejecting an in-project data root does not mutate the read-only project through direct or symlink paths', async () => {
  const { mkdir, symlink, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'durio-invalid-root-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await symlink(workspace, join(root, 'alias'));
  const transport = demoTransport();
  for (const path of [workspace, join(root, 'alias')]) {
    await assert.rejects(runReadTask({ dataRoot: join(path, 'new', 'data'), workspace, input: 'Read README.md', mode: 'offline', transport: transport.fetch }), /DATA_ROOT_INSIDE_PROJECT/);
    assert.deepEqual(await readdir(workspace), []);
  }
  assert.equal(transport.calls.length, 0);
});

test('real Harness reads the fixture, commits usage, and reopens without executing', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-run-'));
  const workspace = resolve('test/fixtures/project');
  const transport = demoTransport();
  const result = await runReadTask({ dataRoot, workspace, input: 'Read README.md', mode: 'offline', transport: transport.fetch });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.answer ?? '', /fruit count is 7/);
  assert.equal(transport.calls.length, 2);
  assert.equal(result.mode, 'offline');
  assert.equal(result.usage.completeness, 'known');
  assert.equal(result.usage.source, 'pi.usage');
  assert.equal(result.usage.value!.models['deepseek/deepseek-flash'].input, 20);
  const first = await readRun(dataRoot, result.runId);
  assert.deepEqual(await readRun(dataRoot, result.runId), first);
  assert.equal(transport.calls.length, 2);
  assert.ok(first.records.some(r => r.kind === 'tool.result'));
  const requests = first.records.filter(r => r.kind === 'model.payload');
  assert.equal(requests.length, 2);
  assert.ok(first.records.some(r => r.kind === 'read.bytes'));
  assert.ok(first.records.some(r => r.kind === 'execution.artifact'));
  assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# Orchard\n\nOrchard counts ripe durians. The fixture\'s expected fruit count is 7.\n');
});

test('original persistence failure cancels the active provider and blocks all later work', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-fault-'));
  const transport = demoTransport();
  let failed = false;
  const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport: transport.fetch,
    fault: kind => { if (kind === 'model.provider-event' && !failed) { failed = true; throw new Error('injected original persistence failure'); } } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'confirmed');
  assert.equal(result.usage.completeness, 'unknown');
  assert.equal(transport.calls.length, 1);
  assert.equal((await readRun(dataRoot, result.runId)).records.filter(r => r.kind === 'tool.intent').length, 0);
  await assert.rejects(runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Try again', mode: 'offline', transport: transport.fetch }), /RECOVERY_REQUIRED/);
  assert.equal(transport.calls.length, 1);
});

test('stop and exit await the in-flight provider while preserving acquired partial content and unknown usage', async () => {
  for (const cancellation of ['stop', 'exit'] as const) {
    const dataRoot = await mkdtemp(join(tmpdir(), `durio-${cancellation}-`));
    const controller = new AbortController();
    let terminated = false;
    let calls = 0;
    const transport: typeof fetch = async (_url, init) => {
      calls++;
      const bytes = new TextEncoder().encode('data: {"id":"partial","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"Acquired partial"},"finish_reason":null}]}\n\n');
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(bytes);
          init!.signal!.addEventListener('abort', () => { setTimeout(() => { terminated = true; stream.error(new Error('cancelled')); }, 30); }, { once: true });
        }
      }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport, signal: controller.signal, cancellation,
      onObservation: event => { if (event.kind === 'model.provider-event') controller.abort(); } });
    assert.equal(terminated, true);
    assert.equal(calls, 1);
    assert.equal(result.status, cancellation === 'stop' ? 'aborted' : 'unknown', JSON.stringify(result));
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.usage.completeness, 'unknown');
    assert.equal(result.usage.value, null);
    const view = await readRun(dataRoot, result.runId);
    assert.match(JSON.stringify(view.records), /Acquired partial/);
    if (cancellation === 'exit') await assert.rejects(runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'retry', mode: 'offline', transport }), /RECOVERY_REQUIRED/);
  }
});

test('derived observation failure leaves the authoritative runtime result intact', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-observation-'));
  const transport = demoTransport();
  const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport: transport.fetch, onObservation: () => { throw new Error('telemetry unavailable'); } });
  assert.equal(result.status, 'completed');
  assert.equal(result.observation, 'degraded');
  assert.equal(transport.calls.length, 2);
});

test('missing auth fails before acceptance and invalid auth is explicit without fallback or leaked key', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-auth-'));
  await assert.rejects(runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'live', apiKey: '' }), /AUTH_MISSING/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(dataRoot, 'host.sqlite')), false);
  let calls = 0;
  const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport: async () => {
    calls++;
    return Response.json({ error: { message: 'Invalid API key offline-transport-placeholder', type: 'authentication_error' } }, { status: 401 });
  } });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /AUTH_REJECTED/);
  assert.equal(result.usage.value, null);
  assert.equal(calls, 1);
  const view = await readRun(dataRoot, result.runId);
  assert.doesNotMatch(JSON.stringify(view), /offline-transport-placeholder/);
  // Includes the upstream DB: sanitizing only our display would still leak persisted authentication errors.
  for (const path of [join(dataRoot, 'sessions', result.sessionId, 'durable.sqlite')]) assert.doesNotMatch((await readFile(path)).toString(), /offline-transport-placeholder/);
});

test('a failed Harness initialization closes allocated storage before releasing ownership', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-open-failure-'));
  const transport = demoTransport();
  const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport: transport.fetch,
    fault: kind => { if (kind === 'harness.open') throw new Error('injected Harness initialization failure'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanup, 'confirmed');
  assert.equal(transport.calls.length, 0);
  const { existsSync } = await import('node:fs');
  // A read-only SQLite inspection may create empty WAL/SHM sidecars. An unclosed writer retains its migration WAL.
  const wal = join(dataRoot, 'sessions', result.sessionId, 'durable.sqlite-wal');
  if (existsSync(wal)) assert.equal((await readFile(wal)).byteLength, 0);
  assert.equal(existsSync(`${dataRoot}.lock`), false);
});

test('second process using an alias is rejected before any writable storage opens', async () => {
  const { symlink, readdir } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-owner-'));
  const aliases = await mkdtemp(join(tmpdir(), 'durio-alias-'));
  const alias = join(aliases, 'data');
  await symlink(dataRoot, alias);
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const transport: typeof fetch = async (_url, init) => {
    ready();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  const first = runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport, signal: controller.signal, cancellation: 'stop' });
  await started;
  try {
    const before = await readdir(join(dataRoot, 'sessions'));
    const child = spawnSync(process.execPath, ['dist/src/cli.js', 'run', '--workspace', resolve('test/fixtures/project'), '--data-root', alias, '--prompt', 'Second request', '--offline-demo'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 73, child.stderr);
    assert.match(child.stderr, /OWNER_CONFLICT/);
    assert.deepEqual(await readdir(join(dataRoot, 'sessions')), before);
  } finally { controller.abort(); await first; }
});

test('read-only snapshot inspection never changes original DB and separate runs never repeat earlier usage', async () => {
  const { stat } = await import('node:fs/promises');
  const { inspectSession } = await import('../src/preflight.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-inspect-'));
  const transport = demoTransport();
  const options = { dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline' as const, transport: transport.fetch };
  const first = await runReadTask(options);
  const path = join(dataRoot, 'sessions', first.sessionId, 'durable.sqlite');
  const bytes = await readFile(path);
  const mtime = (await stat(path)).mtimeMs;
  const { acquireOwner } = await import('../src/ownership.js');
  const owner = await acquireOwner(dataRoot, error => { throw error; });
  const snapshot = await inspectSession(path, owner);
  await owner.release();
  assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.usage.length, 1);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path)).mtimeMs, mtime);
  const second = await runReadTask(options);
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.usage.value!.models['deepseek/deepseek-flash'].input, 20);
  assert.equal(transport.calls.length, 4);
  assert.deepEqual(await readFile(path), bytes);
});

test('model tool requests cannot acquire write capabilities', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-capability-'));
  const workspace = await mkdtemp(join(tmpdir(), 'durio-project-'));
  await writeFile(join(workspace, 'README.md'), 'Keep this file unchanged.');
  const fixture = demoTransport();
  let first = true;
  const transport: typeof fetch = async (url, init) => {
    const response = await fixture.fetch(url, init);
    if (!first) return response;
    first = false;
    const body = (await response.text()).replace('\\"name\\":\\"read\\"', '\\"name\\":\\"write\\"');
    // SSE is ordinary JSON here; the function name itself is not nested in a JSON string.
    return new Response(body.replace('"name":"read"', '"name":"write"'), { headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await runReadTask({ dataRoot, workspace, input: 'Read README.md', mode: 'offline', transport });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), 'Keep this file unchanged.');
  assert.match(result.answer ?? '', /[Uu]nknown tool|not available|not found/);
});

test('show and preflight do not create or change source files, including SQLite sidecars', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { inspectSession } = await import('../src/preflight.js');
  const { acquireOwner } = await import('../src/ownership.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-readonly-tree-'));
  const transport = demoTransport();
  const result = await runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport: transport.fetch });
  async function tree(path: string): Promise<unknown[]> {
    const output = [];
    for (const file of await readdir(path, { withFileTypes: true })) {
      if (file.name === 'owner.json') continue;
      const full = join(path, file.name);
      if (file.isDirectory()) output.push([file.name, await tree(full)]);
      else output.push([file.name, (await stat(full)).mtimeMs, createHash('sha256').update(await readFile(full)).digest('hex')]);
    }
    return output;
  }
  const before = await tree(dataRoot);
  await readRun(dataRoot, result.runId);
  const owner = await acquireOwner(dataRoot, error => { throw error; });
  try { await inspectSession(join(dataRoot, 'sessions', result.sessionId, 'durable.sqlite'), owner); } finally { await owner.release(); }
  assert.deepEqual(await tree(dataRoot), before);
  assert.equal(transport.calls.length, 2);
});

test('cancellation after a committed tool round retains known usage without inventing the unfinished request usage', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'durio-partial-usage-'));
  const controller = new AbortController();
  const fixture = demoTransport();
  let calls = 0;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const transport: typeof fetch = async (url, init) => {
    calls++;
    if (calls === 1) return fixture.fetch(url, init);
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  const running = runReadTask({ dataRoot, workspace: resolve('test/fixtures/project'), input: 'Read README.md', mode: 'offline', transport, signal: controller.signal, cancellation: 'stop' });
  await pending;
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'aborted');
  assert.equal(result.usage.completeness, 'partial');
  assert.equal(result.usage.value!.models['deepseek/deepseek-flash'].input, 10);
  assert.equal(calls, 2);
  const original = await readRun(dataRoot, result.runId);
  assert.deepEqual(await readRun(dataRoot, result.runId), original);
  assert.equal(calls, 2);
});
