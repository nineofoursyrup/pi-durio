// Offline acceptance: public Pi runtime + real child processes, streams and SQLite.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { runCodingTask, runReadTask, readRun, waitForRun } from '../dist/src/runtime.js';
import { writeHeadlessResult, exitHostIfUnconfirmed } from '../dist/src/headless-lifecycle.js';
import { scriptedTransport } from '../dist/src/offline.js';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function allRecords(dataRoot, runId) {
  const records = []; let after = 0, result;
  do { const page = await readRun(dataRoot, runId, { after }); records.push(...page.records); result = page.result; after = page.next ?? 0; } while (after);
  return { result, records };
}
async function treeHash(root) {
  const hash = createHash('sha256');
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name); if (entry.isDirectory()) await visit(path); else { hash.update(path.slice(root.length)); hash.update(await readFile(path)); }
    }
  }
  await visit(root); return hash.digest('hex');
}
async function project(root, label) {
  const workspace = join(root, label, 'project'), dataRoot = join(root, label, 'data'); await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'producer.cjs'), `const fs=require('node:fs'); const cp=require('node:child_process'); fs.writeFileSync('parent.pid',String(process.pid)); fs.appendFileSync('starts.txt','start\\n'); const child=cp.spawn(process.execPath,['child.cjs',process.argv[2]],{stdio:['ignore','pipe','pipe']}); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on('close',()=>console.log('parent-finished'));`);
  await writeFile(join(workspace, 'child.cjs'), `const fs=require('node:fs'); fs.writeFileSync('child.pid',String(process.pid));let n=0;const t=setInterval(()=>{fs.appendFileSync('effects.txt','child-'+(++n)+'\\n');console.log('child-'+n);if(process.argv[2]==='finish'&&n===5)clearInterval(t);},30);`);
  return { workspace, dataRoot };
}

if (process.argv[2] === '--crash-worker') {
  const [workspace, dataRoot] = process.argv.slice(3);
  const transport = scriptedTransport([{ name: 'bash', args: { command: `${quote(process.execPath)} producer.cjs crash` } }]);
  let sent = false;
  await runCodingTask({ workspace, dataRoot, input: 'Controlled crash fixture; preserve actual effects', mode: 'offline', transport: transport.fetch,
    onObservation: event => { if (!sent && event.kind === 'tool.output') { sent = true; process.send({ ready: true, runId: event.runId }); } }
  });
} else if (process.argv[2] === '--timeout-worker') {
  const [workspace, dataRoot] = process.argv.slice(3), controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  setInterval(() => {}, 1000); // An actual active handle must not make the headless host hang.
  const result = await runReadTask({ workspace, dataRoot, input: 'Hold the controlled transport through cleanup', mode: 'offline', signal: controller.signal, cancellation: 'exit', cleanupTimeoutMs: 50,
    transport: async () => new Promise(() => { process.send({ ready: true }); }) });
  writeHeadlessResult(result);
} else if (process.argv[2] === '--tui-timeout-worker') {
  const [workspace, dataRoot] = process.argv.slice(3);
  const { ReadOnlyTui } = await import('../dist/src/tui/app.js');
  class ObservedTerminal {
    columns = 80; rows = 24; kittyProtocolActive = false; stopped = false; cursorShown = false; writes = [];
    input = () => {}; start(input) { this.input = input; } stop() { this.stopped = true; } async drainInput() {}
    write(value) { this.writes.push(value); } showCursor() { this.cursorShown = true; }
    moveBy() {} hideCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  }
  const terminal = new ObservedTerminal();
  setInterval(() => {}, 1000);
  const app = new ReadOnlyTui({ workspace, dataRoot, draftRoot: `${dataRoot}-drafts`, mode: 'offline', terminal,
    transport: async () => new Promise(() => { process.send({ ready: true }); }) });
  app.start(); terminal.input('Hold until explicit exit'); terminal.input('\r');
  const exit = await app.closed, result = exit.result;
  assert.equal(terminal.stopped, true); assert.equal(terminal.cursorShown, true); assert.ok(terminal.writes.join('').includes('\x1b[?1049l'));
  await save(`${dataRoot}-terminal-cleanup.json`, { stopped: terminal.stopped, cursorShown: terminal.cursorShown, alternateBufferDisabled: true, actualMacTerminal: false });
  console.log(JSON.stringify({ tui: 'closed', runId: result.runId, sessionId: result.sessionId, status: result.status, cleanup: result.cleanup, usage: result.usage.completeness, draftSaved: exit.draftSaved }));
  exitHostIfUnconfirmed(result);
} else if (process.argv[2] === '--reopen') {
  const [dataRoot, runId] = process.argv.slice(3); const before = await treeHash(dataRoot); const view = await allRecords(dataRoot, runId);
  const after = await treeHash(dataRoot); assert.equal(after, before);
  console.log(JSON.stringify({ ...view, readonly: { before, after, equal: true } }));
} else {
  if (!process.argv[2]) throw new Error('Usage: node scripts/demo-lifecycle.mjs EVIDENCE_DIRECTORY');
  const destination = resolve(process.argv[2]); await mkdir(destination, { recursive: true }); const root = await mkdtemp(join(destination, 'demo-'));
  const results = [];
  for (const action of ['finish', 'stop', 'exit', 'timeout']) {
    const paths = await project(root, action), controller = new AbortController();
    const transport = scriptedTransport([{ name: 'bash', args: { command: `${quote(process.execPath)} producer.cjs ${action}`, ...(action === 'timeout' ? { timeout: 0.2 } : {}) } }]);
    const result = await runCodingTask({ ...paths, input: 'Run the explicit child fixture; keep failures and acquired originals', mode: 'offline', transport: transport.fetch, signal: controller.signal, cancellation: action === 'stop' ? 'stop' : 'exit',
      onObservation: event => { if ((action === 'stop' || action === 'exit') && event.kind === 'tool.output') controller.abort(); }
    });
    const effects = await readFile(join(paths.workspace, 'effects.txt'), 'utf8'); await delay(120); assert.equal(await readFile(join(paths.workspace, 'effects.txt'), 'utf8'), effects);
    if (action === 'finish') assert.equal(effects, 'child-1\nchild-2\nchild-3\nchild-4\nchild-5\n');
    assert.equal(await readFile(join(paths.workspace, 'starts.txt'), 'utf8'), 'start\n');
    const view = await allRecords(paths.dataRoot, result.runId);
    assert.equal(result.status, action === 'stop' ? 'aborted' : action === 'exit' ? 'unknown' : 'completed');
    assert.equal(result.cleanup, 'confirmed');
    if (action === 'timeout') assert.match(JSON.stringify(view.records.filter(r => r.kind === 'tool.error')), /Command timed out/);
    const childPids = await Promise.all(['parent.pid', 'child.pid'].map(async file => Number(await readFile(join(paths.workspace, file), 'utf8'))));
    childPids.forEach(pid => assert.throws(() => process.kill(pid, 0), /ESRCH/));
    const reopened = spawnSync(process.execPath, [process.argv[1], '--reopen', paths.dataRoot, result.runId], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(reopened.status, 0, reopened.stderr); await writeFile(join(root, action, 'reopened.json'), reopened.stdout);
    await save(join(root, action, 'result.json'), { result, effects, childPids, transportCalls: transport.calls.length, artifact: view.records.find(r => r.kind === 'execution.artifact').data.id });
    results.push({ action, result, targetStable: true, pidCheckSupportingOnly: childPids, readonlyReopen: true });
  }
  // In-flight streaming preserves acquired text and leaves absent usage unknown.
  {
    const paths = await project(root, 'stream'), controller = new AbortController(); let transportStopped = false;
    const result = await runReadTask({ ...paths, input: 'Acquire the controlled partial stream', mode: 'offline', signal: controller.signal, cancellation: 'stop', transport: async (_url, init) => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"id":"stream","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"actual partial stream 原文"},"finish_reason":null}]}\n\n'));
      init.signal.addEventListener('abort', () => setTimeout(() => { transportStopped = true; stream.error(new Error('cancelled transport')); }, 25), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }), onObservation: event => { if (event.kind === 'model.provider-event') controller.abort(); } });
    const view = await allRecords(paths.dataRoot, result.runId); assert.equal(transportStopped, true); assert.equal(result.status, 'aborted'); assert.equal(result.usage.completeness, 'unknown'); assert.match(JSON.stringify(view.records), /actual partial stream 原文/);
    await save(join(root, 'stream', 'view.json'), view); results.push({ action: 'stream', result, transportStopped });
  }
  // A caller cancelling its wait creates neither stop intent nor another request.
  {
    const paths = await project(root, 'wait'), script = scriptedTransport([]), waiter = new AbortController(); let unlock; const gate = new Promise(resolve => { unlock = resolve; });
    const running = runReadTask({ ...paths, input: 'The caller stops waiting, work continues', mode: 'offline', transport: async (...args) => { await gate; return script.fetch(...args); } });
    const waiting = waitForRun(running, waiter.signal); waiter.abort(); await assert.rejects(waiting); unlock(); const result = await running;
    assert.equal(result.status, 'completed'); assert.equal(script.calls.length, 1); await save(join(root, 'wait', 'view.json'), await allRecords(paths.dataRoot, result.runId)); results.push({ action: 'wait-only', result, requests: script.calls.length });
  }
  // A crash leaves a real detached shell/child writing after the host PID is gone.
  {
    const paths = await project(root, 'crash');
    // After one readiness observation, residual work only writes its real target;
    // otherwise closing the host's pipe could stop the fixture through EPIPE.
    await writeFile(join(paths.workspace, 'producer.cjs'), `const fs=require('node:fs'); const cp=require('node:child_process'); fs.writeFileSync('parent.pid',String(process.pid)); fs.appendFileSync('starts.txt','start\\n'); const child=cp.spawn(process.execPath,['child.cjs'],{stdio:'ignore'}); const ready=setInterval(()=>{if(fs.existsSync('effects.txt')){clearInterval(ready); console.log('ready');}},10); child.on('close',()=>{});`);
    await writeFile(join(paths.workspace, 'child.cjs'), `const fs=require('node:fs'); fs.writeFileSync('child.pid',String(process.pid)); let n=0;setInterval(()=>fs.appendFileSync('effects.txt','residual-'+(++n)+'\\n'),30);`);
    const worker = spawn(process.execPath, [process.argv[1], '--crash-worker', paths.workspace, paths.dataRoot], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes; });
    const [message] = await once(worker, 'message'); const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
    const parentPid = Number(await readFile(join(paths.workspace, 'parent.pid'), 'utf8'));
    const childPid = Number(await readFile(join(paths.workspace, 'child.pid'), 'utf8'));
    const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(parentPid)], { encoding: 'utf8' }).trim());
    assert.ok(pgid > 1 && pgid !== process.pid);
    try {
      const before = await readFile(join(paths.workspace, 'effects.txt'), 'utf8'); await delay(120); const after = await readFile(join(paths.workspace, 'effects.txt'), 'utf8'); assert.ok(after.length > before.length, 'residual effects demonstrably continued');
      const view = await allRecords(paths.dataRoot, message.runId); assert.equal(view.result.status, 'unknown'); assert.equal(view.records.some(r => r.kind === 'run.closed'), false);
      for (const dataRoot of [paths.dataRoot, `${paths.dataRoot}-different`]) await assert.rejects(runCodingTask({ ...paths, dataRoot, input: 'Do not bypass unresolved crash', mode: 'offline', transport: scriptedTransport([]).fetch }), /OWNER_CONFLICT/);
      const reopened = spawnSync(process.execPath, [process.argv[1], '--reopen', paths.dataRoot, message.runId], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); assert.equal(reopened.status, 0, reopened.stderr);
      await writeFile(join(root, 'crash', 'reopened.json'), reopened.stdout);
      await save(join(root, 'crash', 'residual.json'), { hostPid: worker.pid, hostExit: 'SIGKILL', parentPid, childPid, pgid, before, after, stderr, ownerFile: existsSync(join(paths.dataRoot, 'owner.json')), newExecutionBlocked: true });
      results.push({ action: 'crash', result: view.result, residualGrowth: after.length - before.length, newExecutionBlocked: true, readonlyReopen: true });
    } finally { try { process.kill(-pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    // Fixture cleanup does not rewrite history, release any owner, or authorize recovery.
  }
  // Use the CLI's exact completion adapter with a live interval and hung transport.
  {
    const paths = await project(root, 'cleanup-timeout');
    const worker = spawn(process.execPath, [process.argv[1], '--timeout-worker', paths.workspace, paths.dataRoot], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = ''; worker.stdout.on('data', bytes => { stdout += bytes; }); worker.stderr.on('data', bytes => { stderr += bytes; });
    await once(worker, 'message'); const exited = once(worker, 'exit'); worker.kill('SIGTERM'); const [code] = await exited;
    assert.equal(code, 75, stderr); const result = JSON.parse(stdout); assert.equal(result.cleanup, 'unknown'); assert.match(result.reason, /CLEANUP_TIMEOUT/);
    const view = await allRecords(paths.dataRoot, result.runId); assert.equal(view.result.status, 'unknown');
    assert.equal(existsSync(join(paths.dataRoot, 'owner.json')), true);
    await assert.rejects(runReadTask({ ...paths, input: 'No automatic recovery after host timeout', mode: 'offline', transport: scriptedTransport([]).fetch }), /OWNER_CONFLICT/);
    await save(join(root, 'cleanup-timeout', 'view.json'), { ...view, exitCode: code, stderr, lockDirectoryAfterExit: existsSync(`${paths.dataRoot}.lock`), persistentOwner: true });
    results.push({ action: 'cleanup-timeout-headless', result, exitCode: code, activeIntervalDidNotHang: true, ownerRetained: true });
  }
  // TUI entry restores its adapter before the same bounded host-exit function.
  {
    const paths = await project(root, 'tui-cleanup-timeout');
    const worker = spawn(process.execPath, [process.argv[1], '--tui-timeout-worker', paths.workspace, paths.dataRoot], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = ''; worker.stdout.on('data', bytes => { stdout += bytes; }); worker.stderr.on('data', bytes => { stderr += bytes; });
    await once(worker, 'message'); const exited = once(worker, 'exit'); worker.kill('SIGTERM'); const [code] = await exited;
    assert.equal(code, 75, stderr); assert.ok(Buffer.byteLength(stdout) < 2048); const summary = JSON.parse(stdout);
    assert.equal(summary.tui, 'closed'); assert.equal(summary.cleanup, 'unknown');
    const terminal = JSON.parse(await readFile(`${paths.dataRoot}-terminal-cleanup.json`, 'utf8'));
    const view = await allRecords(paths.dataRoot, summary.runId); assert.equal(view.result.lifecycle.owner, 'retained');
    await save(join(root, 'tui-cleanup-timeout', 'view.json'), { ...view, summary, terminal, exitCode: code, stderr });
    results.push({ action: 'cleanup-timeout-tui-adapter', summary, terminal, exitCode: code, activeIntervalDidNotHang: true, ownerRetained: true });
  }
  await save(join(root, 'summary.json'), { status: 'PASS', scope: 'offline public-runtime lifecycle; no provider inference or billing', node: process.version, platform: process.platform, arch: process.arch, results });
  console.log(JSON.stringify({ root, summary: join(root, 'summary.json'), status: 'PASS', cases: results.length }));
}
