// Independent offline wiring demonstration. Real Harness, tools, storage, processes and artifacts.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { renameSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { runCodingTask, readRun } from '../dist/src/runtime.js';
import { scriptedTransport } from '../dist/src/offline.js';

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
async function output(dataRoot, runId) {
  const hash = createHash('sha256');
  let cursor = 0, bytes = 0, chunks = 0, maxChunk = 0, shell, gap, artifact;
  do {
    const page = await readRun(dataRoot, runId, { after: cursor, limit: 100 });
    for (const record of page.records) {
      if (record.kind === 'execution.artifact') artifact = record.data.id;
      if (record.kind === 'evidence.gap') gap = record.data;
      if (record.kind === 'shell.completed') shell = record.data.acquired;
      if (record.kind === 'tool.output') {
        const data = Buffer.from(record.data.acquired.bytes, 'base64');
        hash.update(data); bytes += data.length; chunks++; maxChunk = Math.max(maxChunk, data.length);
      }
    }
    cursor = page.next ?? 0;
  } while (cursor);
  return { sha256: hash.digest('hex'), bytes, chunks, maxChunk, shell, gap, artifact };
}

if (process.argv[2] === '--reopen') {
  const result = await output(process.argv[3], process.argv[4]);
  assert.equal(result.sha256, process.argv[5]);
  console.log(JSON.stringify(result));
} else {
  if (!process.argv[2]) throw new Error('Usage: node scripts/demo-coding.mjs EVIDENCE_DIRECTORY');
  const destination = resolve(process.argv[2]);
  await mkdir(destination, { recursive: true });
  const root = await mkdtemp(join(destination, 'demo-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n');
  const run = (label, transport, options = {}) => runCodingTask({ workspace, dataRoot: join(root, label), input: 'Execute the explicitly scripted local fixture task and preserve evidence.', mode: 'offline', transport: transport.fetch, ...options });
  const initial = '// Existing user note must survive.\nexports.sum = (a,b) => a - b;\n';
  const check = "const assert = require('node:assert/strict'); assert.equal(require('./sum.cjs').sum(2,3),5); console.log('sum check passed');\n";
  await writeFile(join(workspace, 'sum.cjs'), initial);
  await writeFile(join(workspace, 'baseline-check.cjs'), check);
  await writeFile(join(root, 'original-sum.cjs'), initial);
  const baseline = spawnSync(process.execPath, ['baseline-check.cjs'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(baseline.status, 1);
  await save('baseline-check.json', { status: baseline.status, stdout: baseline.stdout, stderr: baseline.stderr });
  const codingTransport = scriptedTransport([
    { name: 'read', args: { path: 'sum.cjs' } },
    { name: 'edit', args: { path: 'sum.cjs', edits: [{ oldText: 'a - b', newText: 'a + b' }] } },
    { name: 'write', args: { path: 'check.cjs', content: check } },
    { name: 'bash', args: { command: `${quote(process.execPath)} check.cjs` } }
  ]);
  const coding = await run('coding-data', codingTransport);
  assert.equal(coding.status, 'completed');
  assert.equal(await readFile(join(workspace, 'sum.cjs'), 'utf8'), initial.replace('a - b', 'a + b'));
  const checked = spawnSync(process.execPath, ['check.cjs'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(checked.status, 0);
  await save('coding.json', { result: coding, output: await output(join(root, 'coding-data'), coding.runId), independentCheck: { status: checked.status, stdout: checked.stdout, stderr: checked.stderr }, calls: codingTransport.calls.length });

  await symlink(workspace, join(root, 'project-alias'));
  const cancellation = new AbortController();
  let notify;
  const ready = new Promise(resolve => { notify = resolve; });
  const holding = run('holder-data', { fetch: async (_url, init) => { notify(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('controlled stop')), { once: true })); } }, { signal: cancellation.signal, cancellation: 'stop' });
  await ready;
  let conflict;
  try {
    conflict = spawnSync(process.execPath, ['dist/src/cli.js', 'run', '--coding', '--workspace', join(root, 'project-alias'), '--data-root', join(root, 'contender-data'), '--prompt', 'Second writer', '--offline-demo'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(conflict.status, 73, conflict.stderr);
    assert.equal(existsSync(join(root, 'contender-data', 'host.sqlite')), false);
  } finally { cancellation.abort(); }
  const holder = await holding;
  await save('alias-conflict.json', { status: conflict.status, stderr: conflict.stderr, accepted: false, holder });

  await writeFile(join(workspace, 'large.cjs'), "process.stdout.write('BEGIN\\n'); const block='0123456789abcdef'.repeat(4096); for(let i=0;i<128;i++) process.stdout.write(block); process.stdout.write('END\\n');");
  const largeTransport = scriptedTransport([{ name: 'bash', args: { command: `${quote(process.execPath)} large.cjs` } }]);
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const large = await run('large-data', largeTransport, { onObservation: () => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); } });
  assert.equal(large.status, 'completed');
  const largeOutput = await output(join(root, 'large-data'), large.runId);
  const expected = createHash('sha256').update('BEGIN\n');
  for (let i = 0; i < 128; i++) expected.update('0123456789abcdef'.repeat(4096));
  expected.update('END\n');
  assert.equal(largeOutput.sha256, expected.digest('hex'));
  assert.equal(largeOutput.bytes, 8 * 1024 * 1024 + 10);
  await rm(largeOutput.shell.spillPath);
  const reopened = spawnSync(process.execPath, ['scripts/demo-coding.mjs', '--reopen', join(root, 'large-data'), large.runId, largeOutput.sha256], { encoding: 'utf8', timeout: 30000 });
  assert.equal(reopened.status, 0, reopened.stderr);
  await save('large-output.json', { result: large, output: largeOutput, temporarySpillRemoved: true, separateProcessReadback: JSON.parse(reopened.stdout), rss: { start: rssStart, peak: rssPeak, note: 'sampled host RSS, not a performance acceptance threshold' }, modelSecondRequestBytes: Buffer.byteLength(JSON.stringify(largeTransport.calls[1])) });

  await writeFile(join(workspace, 'producer.cjs'), "const fs=require('node:fs');fs.appendFileSync('starts.txt','start\\n');fs.writeFileSync('pid.txt',String(process.pid));let n=0;setInterval(()=>{fs.appendFileSync('effects.txt','effect\\n');process.stdout.write(`chunk-${++n}\\n`);},30);");
  const faultTransport = scriptedTransport([{ name: 'bash', args: { command: `exec ${quote(process.execPath)} producer.cjs` } }, { name: 'write', args: { path: 'must-not-exist.txt', content: 'forbidden after original loss' } }]);
  let count = 0, disrupted = false;
  const objects = join(root, 'fault-data', 'objects');
  const fault = await run('fault-data', faultTransport, { fault(kind) {
    if (disrupted) { unlinkSync(objects); renameSync(`${objects}-saved`, objects); disrupted = false; }
    if (kind === 'tool.output' && ++count === 3) { renameSync(objects, `${objects}-saved`); writeFileSync(objects, 'inject actual ENOTDIR'); disrupted = true; }
  } });
  assert.equal(fault.status, 'unknown');
  assert.match(fault.reason, /ENOTDIR/);
  assert.equal(faultTransport.calls.length, 1);
  assert.equal(await readFile(join(workspace, 'starts.txt'), 'utf8'), 'start\n');
  const pid = Number(await readFile(join(workspace, 'pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const effects = await readFile(join(workspace, 'effects.txt'), 'utf8');
  await setTimeout(150);
  assert.equal(await readFile(join(workspace, 'effects.txt'), 'utf8'), effects);
  assert.equal(existsSync(join(workspace, 'must-not-exist.txt')), false);
  const faultOutput = await output(join(root, 'fault-data'), fault.runId);
  assert.equal(faultOutput.gap.failedKind, 'tool.output');
  await save('disk-fault.json', { result: fault, output: faultOutput, producerPid: pid, pidAbsentAfterManagedExecSettled: true, stableArtifactsAfterSettled: true, starts: 1, calls: 1 });
  await save('report.json', { status: 'PASS', scope: 'offline transport with real public runtime/tools; no provider inference or billing', root, codingRun: coding.runId, largeRun: large.runId, faultRun: fault.runId, node: process.version, platform: process.platform, arch: process.arch, realProvider: 'NOT RUN', terminal: 'NOT RUN' });
  console.log(JSON.stringify({ status: 'PASS', root }));
}
