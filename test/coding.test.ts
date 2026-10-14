import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { renameSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { runCodingTask, runReadTask, readRun } from '../src/runtime.js';
import { scriptedTransport as script } from '../src/offline.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'durio-coding-'));
  const workspace = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  return { workspace, dataRoot: join(root, 'data') };
}

test('public runtime repairs a real project with read/edit/write/bash and preserves existing user changes', async () => {
  const paths = await fixture();
  const original = '// User note: preserve this local change.\nexports.sum = (a, b) => a - b;\n';
  await writeFile(join(paths.workspace, 'sum.cjs'), original);
  await writeFile(join(paths.workspace, 'notes.txt'), 'Uncommitted user material');
  const check = "const assert = require('node:assert/strict'); const {sum} = require('./sum.cjs'); assert.equal(sum(2, 3), 5); console.log('sum check passed');\n";
  const transport = script([
    { name: 'read', args: { path: 'sum.cjs' } },
    { name: 'edit', args: { path: 'sum.cjs', edits: [{ oldText: 'a - b', newText: 'a + b' }] } },
    { name: 'write', args: { path: 'check.cjs', content: check } },
    { name: 'bash', args: { command: `'${process.execPath}' check.cjs` } }
  ]);
  const result = await runCodingTask({ ...paths, input: 'Fix sum and add/run its check, preserving existing user changes.', mode: 'offline', transport: transport.fetch });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(await readFile(join(paths.workspace, 'sum.cjs'), 'utf8'), original.replace('a - b', 'a + b'));
  assert.equal(await readFile(join(paths.workspace, 'notes.txt'), 'utf8'), 'Uncommitted user material');
  assert.equal(await readFile(join(paths.workspace, 'check.cjs'), 'utf8'), check);
  const page = await readRun(paths.dataRoot, result.runId);
  assert.deepEqual(page.records.filter(r => r.kind === 'tool.intent').map(r => (r.data as any).tool), ['read', 'edit', 'write', 'bash']);
  assert.equal(Buffer.concat(page.records.filter(r => r.kind === 'tool.output').map(r => Buffer.from((r.data as any).acquired.bytes, 'base64'))).toString(), 'sum check passed\n');
  assert.equal((page.records.find(r => r.kind === 'shell.completed')!.data as any).acquired.exitCode, 0);
  assert.equal(transport.calls.length, 5);
  assert.deepEqual(await readRun(paths.dataRoot, result.runId), page);
  assert.equal(transport.calls.length, 5);
  const summaries = page.records.filter(r => r.kind === 'tool.summary').map(r => r.data as any);
  assert.equal(summaries.length, 4);
  assert.ok(summaries.every(s => s.isError === false && page.records.some(r => r.seq === s.resultSeq && r.kind === 'tool.result')));
});

test('original output failure and cancellation stop a real in-flight producer without rerunning side effects', async () => {
  for (const action of ['fault', 'stop', 'exit'] as const) {
    const paths = await fixture();
    const source = "const fs=require('node:fs'); fs.appendFileSync('starts.txt','start\\n'); fs.writeFileSync('pid.txt',String(process.pid)); let n=0; setInterval(()=>{fs.appendFileSync('effects.txt','effect\\n'); process.stdout.write(`chunk-${++n}\\n`);},30);";
    await writeFile(join(paths.workspace, 'producer.cjs'), source);
    const controller = new AbortController();
    const transport = script([{ name: 'bash', args: { command: `exec '${process.execPath}' producer.cjs` } }, { name: 'write', args: { path: 'forbidden-after-stop.txt', content: 'must not happen' } }]);
    let outputs = 0;
    let disrupted = false;
    const originals = join(paths.dataRoot, 'objects');
    const result = await runCodingTask({ ...paths, input: 'Run producer until the test requests a stop.', mode: 'offline', transport: transport.fetch, signal: controller.signal, cancellation: action === 'stop' ? 'stop' : 'exit',
      fault: kind => {
        if (disrupted) { unlinkSync(originals); renameSync(`${originals}-preserved`, originals); disrupted = false; }
        if (action === 'fault' && kind === 'tool.output' && ++outputs === 3) {
          renameSync(originals, `${originals}-preserved`); writeFileSync(originals, 'force actual ENOTDIR on original persistence'); disrupted = true;
        }
      },
      onObservation: event => { if (action !== 'fault' && event.kind === 'tool.output' && ++outputs === 3) controller.abort(); } });
    assert.equal(result.status, action === 'stop' ? 'aborted' : 'unknown', JSON.stringify(result));
    assert.equal(result.cleanup, 'confirmed');
    assert.deepEqual(result.executionCleanup, { managedCommands: 'settled', started: 1, settled: 1, externalProcesses: 'unknown' });
    assert.equal(transport.calls.length, 1);
    assert.equal(await readFile(join(paths.workspace, 'starts.txt'), 'utf8'), 'start\n');
    const pid = Number(await readFile(join(paths.workspace, 'pid.txt'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const effects = await readFile(join(paths.workspace, 'effects.txt'), 'utf8');
    await setTimeout(120);
    assert.equal(await readFile(join(paths.workspace, 'effects.txt'), 'utf8'), effects);
    await assert.rejects(readFile(join(paths.workspace, 'forbidden-after-stop.txt')), /ENOENT/);
    const page = await readRun(paths.dataRoot, result.runId);
    if (action === 'fault') {
      assert.match(result.reason ?? '', /ENOTDIR/);
      assert.ok(page.records.some(r => r.kind === 'evidence.gap' && (r.data as any).failedKind === 'tool.output'));
    }
    const saved = Buffer.concat(page.records.filter(r => r.kind === 'tool.output').map(r => Buffer.from((r.data as any).acquired.bytes, 'base64'))).toString();
    // Cancellation may acquire more pipe data before the command exits; retain that entire contiguous prefix.
    const lines = saved.trimEnd().split('\n');
    assert.ok(lines.length >= (action === 'fault' ? 2 : 3));
    assert.equal(saved, lines.map((_line, i) => `chunk-${i + 1}\n`).join(''));
    assert.ok(effects.trimEnd().split('\n').length >= lines.length);
    assert.equal((page.records.find(r => r.kind === 'shell.completed')!.data as any).acquired.bytes, Buffer.byteLength(saved));
    assert.equal((page.records.find(r => r.kind === 'shell.completed')!.data as any).acquired.completeness, 'partial');
    if (action !== 'stop') await assert.rejects(runCodingTask({ ...paths, input: 'New work must not restart old pending', mode: 'offline', transport: transport.fetch }), /RECOVERY_REQUIRED/);
    assert.equal(transport.calls.length, 1);
  }
});

test('a failed shell check retains complete large output and an explicit error summary', async () => {
  const paths = await fixture();
  await writeFile(join(paths.workspace, 'failed-check.cjs'), "process.stdout.write('x'.repeat(128*1024)+'\\nCHECK FAILED\\n'); process.exitCode=7;");
  const transport = script([{ name: 'bash', args: { command: `'${process.execPath}' failed-check.cjs` } }]);
  const result = await runCodingTask({ ...paths, input: 'Run the failing check and report its actual result.', mode: 'offline', transport: transport.fetch });
  const page = await readRun(paths.dataRoot, result.runId);
  const output = Buffer.concat(page.records.filter(r => r.kind === 'tool.output').map(r => Buffer.from((r.data as any).acquired.bytes, 'base64'))).toString();
  assert.equal(output, 'x'.repeat(128 * 1024) + '\nCHECK FAILED\n');
  const shell = page.records.find(r => r.kind === 'shell.completed')!.data as any;
  assert.equal(shell.acquired.exitCode, 7);
  assert.equal(shell.acquired.completeness, 'complete');
  const summary = page.records.find(r => r.kind === 'tool.summary')!.data as any;
  assert.equal(summary.isError, true);
  assert.ok(summary.diagnostics.some((d: any) => d.code === 'full_output'));
  assert.match(JSON.stringify(page.records.find(r => r.seq === summary.errorSeq)), /Command exited with code 7/);
  assert.equal(transport.calls.length, 2);
});

test('shell receives an explicit immutable environment while file tools refuse undeclared targets', async () => {
  const paths = await fixture();
  const { symlink } = await import('node:fs/promises');
  const outside = join(paths.workspace, '..', 'outside.txt');
  await writeFile(outside, 'outside original');
  await symlink(outside, join(paths.workspace, 'alias.txt'));
  await writeFile(join(paths.workspace, 'env.cjs'), "console.log(JSON.stringify({keyPresent:'DEEPSEEK_API_KEY' in process.env,ambientPresent:'DURIO_AMBIENT_SECRET' in process.env,project:process.env.DURIO_PROJECT==='explicit-value',path:!!process.env.PATH,home:!!process.env.HOME}));");
  const previous = process.env.DURIO_AMBIENT_SECRET;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DURIO_AMBIENT_SECRET = 'not-inherited';
  process.env.DEEPSEEK_API_KEY = 'parent-model-key-not-inherited';
  const config = { version: 'test-project-env-v1', variables: { DURIO_PROJECT: 'explicit-value' } };
  const transport = script([
    { name: 'write', args: { path: 'alias.txt', content: 'unauthorized overwrite' } },
    { name: 'bash', args: { command: `'${process.execPath}' env.cjs` } }
  ]);
  try {
    const result = await runCodingTask({ ...paths, input: 'Check environment, never overwrite files outside this project.', mode: 'offline', transport: transport.fetch, toolEnvironment: config,
      onObservation: event => { if (event.kind === 'task.accepted') config.variables.DURIO_PROJECT = 'mutated-after-acceptance'; } });
    assert.equal(result.status, 'completed');
    assert.equal(await readFile(outside, 'utf8'), 'outside original');
    const page = await readRun(paths.dataRoot, result.runId);
    const output = Buffer.concat(page.records.filter(r => r.kind === 'tool.output').map(r => Buffer.from((r.data as any).acquired.bytes, 'base64'))).toString();
    assert.deepEqual(JSON.parse(output), { keyPresent: false, ambientPresent: false, project: true, path: true, home: true });
    const metadata = page.records.find(r => r.kind === 'execution.config')!.data as any;
    assert.deepEqual(metadata.toolEnvironment.names.includes('DURIO_PROJECT'), true);
    assert.doesNotMatch(JSON.stringify(metadata), /explicit-value|mutated-after-acceptance|not-inherited/);
    const summary = page.records.find(r => r.kind === 'tool.summary' && (r.data as any).tool === 'write')!.data as any;
    assert.equal(summary.isError, true);
    assert.ok(page.records.some(r => r.kind === 'tool.error' && r.seq === summary.errorSeq));
  } finally {
    if (previous === undefined) delete process.env.DURIO_AMBIENT_SECRET; else process.env.DURIO_AMBIENT_SECRET = previous;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('derived tool summaries degrade independently and read-only callers retain the same result semantics', async () => {
  const paths = await fixture();
  await writeFile(join(paths.workspace, 'README.md'), 'Read-only content\n'.repeat(3000));
  for (const fail of [false, true]) {
    const transport = script([{ name: 'read', args: { path: 'README.md' } }]);
    const result = await runReadTask({ ...paths, input: 'Read README.md', mode: 'offline', transport: transport.fetch,
      fault: kind => { if (fail && kind === 'tool.summary') throw new Error('derived summary unavailable'); } });
    assert.equal(result.status, 'completed');
    assert.equal(result.observation, fail ? 'degraded' : 'ok');
    assert.equal(transport.calls.length, 2);
    const page = await readRun(paths.dataRoot, result.runId);
    assert.equal(page.records.some(r => r.kind === 'tool.summary'), !fail);
    assert.equal(page.records.filter(r => r.kind === 'tool.result').length, 1);
    if (!fail) {
      const summary = page.records.find(r => r.kind === 'tool.summary')!.data as any;
      assert.ok(summary.truncation, 'upstream read truncation survives the bounded summary');
      assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 3072);
      assert.equal(summary.isError, false);
    }
  }
});

test('large output survives temporary spill removal and read-only pagination without growing model input', async () => {
  const paths = await fixture();
  const block = '榴莲-0123456789\n'.repeat(4096);
  await writeFile(join(paths.workspace, 'produce.cjs'), `process.stdout.write('BEGIN\\n'); for(let i=0;i<64;i++) process.stdout.write(${JSON.stringify(block)}); process.stdout.write('END\\n'); process.stderr.write('error-stream\\n');`);
  const transport = script([{ name: 'bash', args: { command: `'${process.execPath}' produce.cjs` } }]);
  const result = await runCodingTask({ ...paths, input: 'Run the output fixture and preserve its acquired output.', mode: 'offline', transport: transport.fetch });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(Buffer.byteLength(JSON.stringify(transport.calls[1])) < 200 * 1024, 'model sees only upstream bounded tail');
  let cursor = 0;
  const hash = createHash('sha256');
  let stdoutBytes = 0, stderr = '', pages = 0, maxChunk = 0, spill: string | undefined;
  do {
    const page = await readRun(paths.dataRoot, result.runId, { after: cursor, limit: 100 });
    pages++;
    for (const record of page.records) {
      const data = (record.data as any).acquired;
      if (record.kind === 'shell.completed') { spill = data.spillPath; assert.equal(data.completeness, 'complete'); }
      if (record.kind === 'tool.output') {
        const bytes = Buffer.from(data.bytes, 'base64');
        maxChunk = Math.max(maxChunk, bytes.length);
        if (data.stream === 'stdout') { hash.update(bytes); stdoutBytes += bytes.length; }
        else stderr += bytes.toString();
      }
    }
    cursor = page.next ?? 0;
  } while (cursor);
  assert.ok(pages > 2);
  assert.ok(maxChunk <= 16 * 1024);
  const expected = createHash('sha256').update('BEGIN\n');
  for (let i = 0; i < 64; i++) expected.update(block);
  expected.update('END\n');
  assert.equal(hash.digest('hex'), expected.digest('hex'));
  assert.equal(stdoutBytes, Buffer.byteLength(block) * 64 + 10);
  assert.equal(stderr, 'error-stream\n');
  assert.ok(spill, 'upstream used a temporary spill');
  await (await import('node:fs/promises')).rm(spill!);
  const reopened = await readRun(paths.dataRoot, result.runId);
  assert.equal((reopened.result as any).status, 'completed');
  assert.ok(reopened.records.some(r => r.kind === 'tool.output'));
  assert.equal(transport.calls.length, 2);
});

test('workspace ownership rejects aliases and overlapping roots across sessions and data roots before acceptance', async () => {
  const paths = await fixture();
  const { mkdir, symlink, access } = await import('node:fs/promises');
  await mkdir(join(paths.workspace, 'child'));
  const alias = `${paths.workspace}-alias`;
  await symlink(paths.workspace, alias);
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const first = runCodingTask({ ...paths, input: 'Hold this project for a coding task.', mode: 'offline', signal: controller.signal, cancellation: 'stop', transport: async (_url, init) => {
    ready();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  await started;
  try {
    const { spawnSync } = await import('node:child_process');
    const childRoot = await mkdtemp(join(tmpdir(), 'durio-process-conflict-'));
    const child = spawnSync(process.execPath, ['dist/src/cli.js', 'run', '--coding', '--workspace', alias, '--data-root', childRoot, '--prompt', 'Second writer', '--offline-demo'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 73, child.stderr);
    assert.match(child.stderr, /OWNER_CONFLICT/);
    assert.equal(existsSync(join(childRoot, 'host.sqlite')), false);
    for (const [i, workspace] of [alias, join(paths.workspace, 'child'), join(paths.workspace, '..')].entries()) {
      const dataRoot = await mkdtemp(join(tmpdir(), `durio-second-${i}-`));
      const other = script([]);
      await assert.rejects(runCodingTask({ workspace, dataRoot, input: 'Second writer', mode: 'offline', transport: other.fetch }), /OWNER_CONFLICT/);
      assert.equal(other.calls.length, 0);
      await assert.rejects(access(join(dataRoot, 'host.sqlite')), /ENOENT/);
    }
  } finally { controller.abort(); await first; }
  const next = script([]);
  assert.equal((await runCodingTask({ ...paths, dataRoot: `${paths.dataRoot}-after`, input: 'After confirmed release', mode: 'offline', transport: next.fetch })).status, 'completed');
  const { execFileSync } = await import('node:child_process');
  execFileSync('/usr/bin/git', ['init', '-q', paths.workspace]);
  await mkdir(join(paths.workspace, 'sibling'));
  const { acquireWorkspaceOwner } = await import('../src/workspace-ownership.js');
  const lease = await acquireWorkspaceOwner(join(paths.workspace, 'child'), error => { throw error; });
  try { await assert.rejects(acquireWorkspaceOwner(join(paths.workspace, 'sibling'), error => { throw error; }), /OWNER_CONFLICT/); }
  finally { await lease.release(); }
});

test('uncertain Git workspace identity blocks coding before any acceptance or model call', async () => {
  const paths = await fixture();
  await writeFile(join(paths.workspace, '.git'), 'gitdir: /definitely-missing-durio-git-directory\n');
  const transport = script([]);
  await assert.rejects(runCodingTask({ ...paths, input: 'Do not bypass a broken repository identity', mode: 'offline', transport: transport.fetch }), /WORKSPACE_IDENTITY_UNKNOWN/);
  assert.equal(transport.calls.length, 0);
  assert.equal(existsSync(join(paths.dataRoot, 'host.sqlite')), false);
});

test('coding from a Git subdirectory still keeps its data root outside the whole project', async () => {
  const paths = await fixture();
  const { execFileSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  execFileSync('/usr/bin/git', ['init', '-q', paths.workspace]);
  const nested = join(paths.workspace, 'src');
  await mkdir(nested);
  const dataRoot = join(paths.workspace, 'new-records');
  const transport = script([]);
  await assert.rejects(runCodingTask({ workspace: nested, dataRoot, input: 'Read this subtree', mode: 'offline', transport: transport.fetch }), /DATA_ROOT_INSIDE_PROJECT/);
  assert.equal(existsSync(dataRoot), false);
  assert.equal(transport.calls.length, 0);
});

test('writing an existing file requires a current observation and refuses intervening user edits', async () => {
  const paths = await fixture();
  await writeFile(join(paths.workspace, 'existing.txt'), 'original content');
  const transport = script([
    { name: 'write', args: { path: 'existing.txt', content: 'blind overwrite' } },
    { name: 'read', args: { path: 'existing.txt' } },
    { name: 'write', args: { path: 'existing.txt', content: 'stale overwrite' } }
  ]);
  const result = await runCodingTask({ ...paths, input: 'Preserve concurrent and existing user changes.', mode: 'offline', transport: transport.fetch,
    onObservation: event => { if (event.kind === 'tool.result') writeFileSync(join(paths.workspace, 'existing.txt'), 'a newer user edit'); } });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(paths.workspace, 'existing.txt'), 'utf8'), 'a newer user edit');
  const page = await readRun(paths.dataRoot, result.runId);
  assert.equal(page.records.filter(r => r.kind === 'tool.error').length, 2);
  assert.match(JSON.stringify(page.records), /WRITE_REQUIRES_READ/);
  assert.match(JSON.stringify(page.records), /FILE_CHANGED/);
});

test('coding tool calls in one model round execute sequentially even through file aliases', async () => {
  const paths = await fixture();
  await writeFile(join(paths.workspace, 'value.txt'), 'value = 1');
  await (await import('node:fs/promises')).symlink(join(paths.workspace, 'value.txt'), join(paths.workspace, 'alias.txt'));
  const transport = script([[
    { name: 'edit', args: { path: 'value.txt', edits: [{ oldText: 'value = 1', newText: 'value = 2' }] } },
    { name: 'edit', args: { path: 'alias.txt', edits: [{ oldText: 'value = 2', newText: 'value = 3' }] } }
  ]]);
  const result = await runCodingTask({ ...paths, input: 'Apply the two ordered edits.', mode: 'offline', transport: transport.fetch });
  assert.equal(await readFile(join(paths.workspace, 'value.txt'), 'utf8'), 'value = 3');
  const page = await readRun(paths.dataRoot, result.runId);
  assert.equal(page.records.filter(r => r.kind === 'tool.error').length, 0);
  assert.equal(transport.calls.length, 2);
});
