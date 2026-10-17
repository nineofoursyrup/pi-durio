/** Loaded only AFTER measure.mjs verifies the frozen plan, grant, identity and native gate.
 * Derived methods: issue-31 final-f26ae8f M1-M4. No old harness is executed or edited.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, readlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { SCHEMA, fileRef, readRef, save, summarize } from './core.mjs';
const digest = b => createHash('sha256').update(b).digest('hex');
const metric = (id, value, reason = null) => ({ id, status: 'MEASURED', value, reason });
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
function inventory(root) {
  const rows = [], inodes = new Set(); let uniqueAllocatedBytes = 0;
  const walk = p => { for (const name of readdirSync(p).sort()) { const full = join(p, name), stat = lstatSync(full), path = relative(root, full);
    if (stat.isSymbolicLink()) rows.push({ path, target: readlinkSync(full), kind: 'symlink' });
    else if (stat.isDirectory()) walk(full);
    else if (stat.isFile()) { const inode = `${stat.dev}:${stat.ino}`; if (!inodes.has(inode)) { inodes.add(inode); uniqueAllocatedBytes += stat.blocks * 512; } rows.push({ path, bytes: stat.size, allocated: stat.blocks * 512, sha256: digest(readFileSync(full)) }); }
    else throw Error(`UNSUPPORTED_FILE:${path}`);
  } };
  if (existsSync(root)) walk(root);
  return { rows, bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0), allocatedByPath: rows.reduce((n, r) => n + (r.allocated ?? 0), 0), uniqueAllocatedBytes, allocatedLimit: '不代表 APFS 克隆、快照或共享区块的唯一物理占盘' };
}
function tarEntries(bytes) {
  const unpacked = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 }), rows = [];
  const string = b => b.toString('utf8').split('\0')[0];
  for (let offset = 0; offset + 512 <= unpacked.length;) {
    const h = unpacked.subarray(offset, offset + 512); if (h.every(b => b === 0)) break;
    const size = parseInt(string(h.subarray(124, 136)).trim(), 8); if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > unpacked.length) throw Error('DISTRIBUTION_TAR_INVALID');
    const type = string(h.subarray(156, 157)) || '0', prefix = string(h.subarray(345, 500)), name = string(h.subarray(0, 100));
    if (!['0', '5', '2', '1'].includes(type)) throw Error(`DISTRIBUTION_TAR_EXTENSION_UNSUPPORTED:${type}`);
    const data = unpacked.subarray(offset + 512, offset + 512 + size);
    rows.push({ path: prefix ? `${prefix}/${name}` : name, type, bytes: size, ...(type === '0' ? { sha256: digest(data) } : { target: string(h.subarray(157, 257)) }) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return rows;
}
export async function runWorkload(kind, checked, out, binding, session) {
  const { plan, candidate } = checked, w = plan.workload, root = candidate.installation.root, metrics = [], observations = {};
  const load = path => import(pathToFileURL(join(root, path)).href);
  const record = (name, value) => save(join(out, `${name}.json`), value);
  const start = { at: new Date().toISOString(), load: loadavg(), node: process.version, kind, binding, workload: w };
  record('plan', start);
  try {
    if (kind === 'inventory') {
      const build = JSON.parse(readFileSync(join(root, 'dist/execution/source-build.json'), 'utf8'));
      const count = files => ({ files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), physicalLines: files.every(f => Number.isSafeInteger(f.physicalLines)) ? files.reduce((n, f) => n + f.physicalLines, 0) : null });
      const own = build.inputs.filter(f => f.path.startsWith('src/'));
      metrics.push(metric('code', { sourceBuild: candidate.source.sourceBuildSha256, product: count(own), groups: [...new Set(own.map(f => dirname(f.path)))].map(directory => ({ directory, ...count(own.filter(f => dirname(f.path) === directory)) })).sort((a, b) => b.physicalLines - a.physicalLines),
        tests: count(build.inputs.filter(f => f.path.startsWith('test/') && !f.path.startsWith('test/fixtures/') && /\.[cm]?[jt]sx?$/.test(f.path))),
        allScripts: count(build.inputs.filter(f => f.path.startsWith('scripts/'))), packagedScripts: count(build.inputs.filter(f => /^scripts\/(eval|isolation)\//.test(f.path))), widthPatch: count(build.inputs.filter(f => f.path === 'vendor/pi-tui/width-overrides.patch')),
        basis: 'src/** 含 src/eval、空行和注释；tests 不含 fixture/snapshot；全部维护 scripts 与随包脚本分列、不重复加入产品总数；不计未跟踪设计原件' }));
      const installed = inventory(root), distribution = readRef(plan.distribution, false), entries = tarEntries(distribution);
      assert.equal(entries.find(e => e.path === 'package/dist/execution/source-build.json')?.sha256, candidate.source.sourceBuildSha256, 'DISTRIBUTION_BUILD_MISMATCH');
      metrics.push(metric('installation', { root, ...installed, boundary: readRef(plan.installationEvidence), node: { path: process.execPath, bytes: lstatSync(process.execPath).size, counted: false }, native: installed.rows.filter(r => r.path.endsWith('.node')), developmentDependencies: 'excluded per fixed installation evidence' }));
      metrics.push(metric('distribution', { source: plan.distribution, compressedBytes: distribution.length, unpackedFileBytes: entries.filter(e => e.type === '0').reduce((n, e) => n + e.bytes, 0), entries }));
    } else if (kind === 'startup') {
      const cli = join(root, 'dist/src/cli.js'), rows = [];
      const env = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'dumb' };
      for (const [id, args] of [['help', ['--help']], ['missing-store-history', ['history', '--data-root', join(out, 'absent-data'), '--format', 'json']]]) {
        for (let n = 1; n <= w.startupRepetitions; n++) {
          const loadBefore = loadavg(), begin = performance.now();
          const p = spawnSync(process.execPath, [cli, ...args], { cwd: out, env, timeout: w.taskTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
          const elapsedMs = performance.now() - begin, stdout = p.stdout ?? Buffer.alloc(0), stderr = p.stderr ?? Buffer.alloc(0);
          const prefix = `${id}-${n}`; writeFileSync(join(out, `${prefix}.stdout`), stdout, { flag: 'wx' }); writeFileSync(join(out, `${prefix}.stderr`), stderr, { flag: 'wx' });
          const failed = p.status !== 0 || !!p.signal || !!p.error;
          const row = { id, n, status: failed ? 'FAIL' : 'MEASURED', value: elapsedMs, reason: p.error ? String(p.error) : null, loadBefore, loadAfter: loadavg(), exitCode: p.status, signal: p.signal,
            stdout: fileRef(join(out, `${prefix}.stdout`)), stderr: fileRef(join(out, `${prefix}.stderr`)), history: id === 'missing-store-history' && !failed ? JSON.parse(stdout.toString()) : null };
          rows.push(row); record(prefix, row); if (failed) throw Error(`STARTUP_FAILED:${prefix}`);
        }
      }
      assert.equal(existsSync(join(out, 'absent-data')), false);
      metrics.push(metric('startup', { rows, groups: ['help', 'missing-store-history'].map(id => ({ id, ...summarize(rows.filter(r => r.id === id)) })), basis: 'parent spawn→exit；每次新进程，未清缓存；不是机器冷启动或 native 首帧；空库 missing 不能证明无历史' }));
    } else if (kind === 'idle' || kind === 'session') {
      const workspace = join(out, 'workspace'), dataRoot = join(out, 'data'); mkdirSync(workspace);
      writeFileSync(join(workspace, 'README.md'), 'Controlled local synthetic transport workload. No inference or daily acceptance.\n', { flag: 'wx' });
      const { ReadOnlyTui } = await load('dist/src/tui/app.js'), { ProcessTerminal, stripTerminalSequences } = await load('node_modules/@earendil-works/pi-tui/dist/index.js');
      const { scriptedTransport } = await load('dist/src/offline.js'), { readRunRecords, readObjectRange } = await load('dist/src/query.js');
      const { readAcceptedTasks } = await load('dist/src/runtime.js');
      const { processMeasurements, readSelfRecords, selfStorage } = await load('dist/src/self-measurement.js');
      const terminal = new ProcessTerminal(), oldStart = terminal.start.bind(terminal); let inject, active, app, closed = false, calls = 0, acceptedAfter = 0;
      terminal.start = (input, resize) => { inject = input; return oldStart(input, resize); };
      const rss = [], rounds = [], checkpoints = [], inputs = []; let timer;
      const rawInput = d => inputs.push({ ms: performance.now(), bytes: Buffer.from(d).toString('base64') }); process.stdin.on('data', rawInput);
      const readJson = ref => { const chunks = []; for (let offset = 0;;) { const page = readObjectRange(dataRoot, ref, { offset, limit: 16384 }); chunks.push(page.bytes); if (page.next === null) break; offset = page.next; } return JSON.parse(Buffer.concat(chunks).toString()); };
      const wait = async predicate => { const end = performance.now() + w.taskTimeoutMs; while (performance.now() < end) { if (closed) throw Error('APP_CLOSED_EARLY'); const result = predicate(); if (result) return result; await delay(100); } throw Error('TASK_TIMEOUT'); };
      const checkpoint = async label => { const files = inventory(dataRoot), facts = { value: readSelfRecords(dataRoot, candidate.source.sourceBuildSha256), source: 'records', basis: 'controlled snapshot', samples: 1 };
        const storage = await selfStorage(dataRoot, facts), value = { label, at: new Date().toISOString(), files, storage }; checkpoints.push(value); record(`storage-${label}`, value); };
      const task = async (id, steps) => {
        active = scriptedTransport(steps); const input = `Controlled A2 ${id}`, begin = performance.now(); inject(input); await delay(100); inject('\r');
        const accepted = await wait(() => existsSync(join(dataRoot, 'host.sqlite')) && readAcceptedTasks(dataRoot, { after: acceptedAfter, limit: 200 }).tasks.find(t => t.input === input && ['completed', 'failed', 'aborted', 'unknown'].includes(t.status)));
        acceptedAfter = accepted.acceptedSeq;
        const row = { id, accepted, elapsedMs: performance.now() - begin, payloadBytes: active.calls.map(p => Buffer.byteLength(JSON.stringify(p))) }; rounds.push(row);
        assert.equal(accepted.status, 'completed');
        const facts = readRunRecords(dataRoot, accepted.runId, { limit: 50, kinds: ['tool.result', 'tool.error', 'shell.completed'] });
        assert.equal(facts.more, false); assert.equal(facts.records.filter(r => r.kind === 'tool.error').length, 0);
        const results = facts.records.filter(r => r.kind === 'tool.result').map(r => readJson(r.ref)); assert.equal(results.length, 1); assert.notEqual(results[0].result.isError, true);
        if (steps[0].name === 'bash') { const shell = facts.records.filter(r => r.kind === 'shell.completed').map(r => readJson(r.ref).acquired); assert.equal(shell.length, 1); assert.equal(shell[0].exitCode, 0); assert.equal(shell[0].completeness, 'complete'); }
        const closure = readRunRecords(dataRoot, accepted.runId, { kinds: ['run.closed'], limit: 1 });
        assert.equal(closure.records.length, 1); assert.equal(readJson(closure.records[0].ref).cleanup, 'confirmed');
        // run.closed precedes ownership release. The public idle footer is set only
        // after runtime resolves and app.applyResult runs; fixed sleeps cannot prove it.
        row.idleFooter = await wait(() => app.screen().slice(-8).map(stripTerminalSequences).find(line => line.includes('Enter 提交')));
        row.closeReceipt = closure.records[0]; active = null; record(id, row); return row;
      };
      try {
        app = new ReadOnlyTui({ workspace, dataRoot, draftRoot: join(out, 'drafts'), mode: 'offline', coding: kind === 'session', terminal,
          transport: async (...args) => { if (!active) throw Error('UNPLANNED_PROVIDER_DISPATCH'); calls++; return active.fetch(...args); } });
        void app.closed.then(() => { closed = true; }); timer = setInterval(() => rss.push({ ms: performance.now(), value: process.memoryUsage().rss, status: 'MEASURED' }), w.rssIntervalMs);
        app.start(); await wait(() => processMeasurements.snapshot().firstFrameMs !== null);
        const firstFrameMs = processMeasurements.snapshot().firstFrameMs, began = performance.now();
        if (kind === 'idle') { await delay(w.idleMs); assert.equal(calls, 0); metrics.push(metric('idle', { firstFrameMs, observedMs: performance.now() - began, rss: summarize(rss), inputs, basis: 'Node timeOrigin→同步内容帧 stdout 写出；输入字节可能含 CPR/focus，不据此推断人工输入' })); }
        else {
          writeFileSync(join(workspace, 'counter.cjs'), 'exports.value = 0;\n', { flag: 'wx' });
          await checkpoint('empty');
          for (let n = 0; n < w.sessionRounds; n++) {
            const begin = performance.now(), cycle = Math.floor(n / 3), step = n % 3;
            const steps = step === 0 ? [{ name: 'read', args: { path: 'README.md' } }] : step === 1 ? [{ name: 'edit', args: { path: 'counter.cjs', edits: [{ oldText: `exports.value = ${cycle};`, newText: `exports.value = ${cycle + 1};` }] } }] : [{ name: 'bash', args: { command: `${quote(process.execPath)} -e ${quote(`require('node:assert/strict').equal(require('./counter.cjs').value,${cycle + 1})`)}` } }];
            await task(`round-${n + 1}`, steps); if (n === 0 || (n + 1) % 10 === 0) { await checkpoint(`round-${n + 1}`); inject('/history'); await delay(100); inject('\r'); await delay(300); inject('\x1b'); }
            await delay(Math.max(0, w.roundIntervalMs - (performance.now() - begin)));
          }
          await delay(Math.max(0, w.minimumSessionMs - (performance.now() - began)));
          assert.equal(readFileSync(join(workspace, 'counter.cjs'), 'utf8'), `exports.value = ${w.sessionRounds / 3};\n`);
          const large = Buffer.alloc(w.largeOutputBytes, 120); Buffer.from('DURIO_BEGIN\n').copy(large); Buffer.from('\nDURIO_END\n').copy(large, large.length - 11);
          writeFileSync(join(workspace, 'large.bin'), large, { flag: 'wx' });
          const big = await task('large-output-task', [{ name: 'bash', args: { command: `${quote(process.execPath)} -e ${quote("process.stdout.write(require('node:fs').readFileSync('large.bin'))")}` } }]);
          const acquired = createHash('sha256'); let after = 0, bytes = 0, chunks = 0;
          for (;;) { const page = readRunRecords(dataRoot, big.accepted.runId, { after, limit: 50, kinds: ['tool.output'] }); for (const item of page.records) { after = item.seq; const b = Buffer.from(readJson(item.ref).acquired.bytes, 'base64'); acquired.update(b); bytes += b.length; chunks++; } if (!page.more) break; }
          const actual = { bytes, chunks, sha256: acquired.digest('hex') }, expected = { bytes: large.length, sha256: digest(large) };
          record('large-output', { ...big, actual, expected }); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
          const following = await task('following-read', [{ name: 'read', args: { path: 'README.md' } }]);
          await checkpoint('final');
          metrics.push(metric('session', { durationMs: performance.now() - began, rounds, rss: summarize(rss), scope: 'host Node only, sampled peak; five-minute reference is not hours-long stability; input payload bytes are not real token usage' }));
          metrics.push(metric('growth', { checkpoints, growthBytes: checkpoints.at(-1).files.bytes - checkpoints[0].files.bytes, totalMeaning: '现存受控数据根总量之差；完整原文保留，不等于上下文长度' }));
          metrics.push(metric('originals', { checkpoints: checkpoints.map(c => ({ label: c.label, value: c.storage.value?.originals ?? null, wrapper: c.storage })), growthBytes: checkpoints.at(-1).storage.value.originals - checkpoints[0].storage.value.originals, basis: 'sessions + attachments + retained raw-body facts；表示副本不按内容去重，正常完整原文单列' }));
          metrics.push(metric('largeOutput', { runId: big.accepted.runId, actual, expected, following })); observations.dataRoot = dataRoot;
        }
        const exit = await app.exit(); assert.equal(exit.error, undefined); assert.equal(exit.widthCalibration?.status, 'measured'); observations.exit = exit;
      } finally { clearInterval(timer); process.stdin.off('data', rawInput); if (app) await app.exit(); record('native-observations', { rss, rounds, checkpoints, inputs, syntheticRequests: calls }); }
    } else if (kind === 'query') {
      const parent = JSON.parse(readFileSync(join(session, 'result.json'), 'utf8')), dataRoot = parent.observations.dataRoot;
      const large = JSON.parse(readFileSync(join(session, 'large-output.json'), 'utf8')), api = await load('dist/src/query.js');
      const before = inventory(dataRoot), queries = [], exports = [], first = api.queryEvidence(dataRoot, large.accepted.runId, { limit: 20, kinds: ['tool.output'] }).items[0]; assert.ok(first);
      record('source-before', before);
      for (let i = 0; i < w.queryCycles * 3; i++) {
        const method = ['queryHistory', 'queryEvidence', 'readEvidence'][i % 3], args = i % 3 === 0 ? [dataRoot, {}, { limit: 10 }] : i % 3 === 1 ? [dataRoot, large.accepted.runId, { limit: 20 }] : [dataRoot, first.id, { limit: 1024, decodedOutput: true }];
        const begin = performance.now(), result = api[method](...args), row = { method, arguments: args, value: performance.now() - begin, status: 'MEASURED', result };
        queries.push(row); record(`query-${i + 1}`, row);
      }
      for (let i = 1; i <= w.exportRepetitions; i++) {
        const path = join(out, `output-${i}.bin`), beforeUsage = process.resourceUsage(), begin = performance.now(), fd = openSync(path, 'wx', 0o600), hash = createHash('sha256'); let after = 0, bytes = 0;
        try { for (;;) { const page = api.readRunRecords(dataRoot, large.accepted.runId, { after, limit: 50, kinds: ['tool.output'] }); for (const item of page.records) {
          after = item.seq; const parts = []; for (let offset = 0;;) { const p = api.readObjectRange(dataRoot, item.ref, { offset, limit: 16384 }); parts.push(p.bytes); if (p.next === null) break; offset = p.next; }
          const data = Buffer.from(JSON.parse(Buffer.concat(parts).toString()).acquired.bytes, 'base64'); for (let n = 0; n < data.length;) n += writeSync(fd, data, n, data.length - n); hash.update(data); bytes += data.length;
        } if (!page.more) break; } } finally { closeSync(fd); }
        const row = { value: performance.now() - begin, status: 'MEASURED', bytes, sha256: hash.digest('hex'), beforeUsage, afterUsage: process.resourceUsage() }; exports.push(row); record(`export-${i}`, row);
        assert.equal(bytes, large.expected.bytes); assert.equal(row.sha256, large.expected.sha256);
      }
      const after = inventory(dataRoot); record('source-after', after); assert.deepEqual(after, before);
      metrics.push(metric('query', { samples: queries, groups: ['queryHistory', 'queryEvidence', 'readEvidence'].map(method => ({ method, ...summarize(queries.filter(q => q.method === method)) })), sourceUnchanged: true }));
      metrics.push(metric('acquisition', { ...summarize(exports), sourceUnchanged: true, boundary: '枚举/已验证公开分页读取/JSON/base64解码/写出至 close；未 fsync、未清缓存；不是孤立磁盘延迟' }));
    }
    record('result', { schema: `${SCHEMA}-worker`, status: 'MEASURED', binding, metrics, observations, start, endedAt: new Date().toISOString(), loadAfter: loadavg() });
  } catch (error) {
    record('failure', { schema: `${SCHEMA}-worker-failure`, binding, kind, error: String(error), metrics, observations, at: new Date().toISOString() });
    throw error;
  }
}
