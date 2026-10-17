#!/usr/bin/env node
/** Future user-launched controlled A2 only. Never invoke for PREP validation. */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem, release, loadavg } from 'node:os';
import { SCHEMA, verifyFrozen, fileRef, save, outputPath, rows, classifyWorker } from './core.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
try {
  const { values: v } = parseArgs({ options: { frozen: { type: 'string' }, out: { type: 'string' }, worker: { type: 'string' }, session: { type: 'string' }, 'verify-only': { type: 'boolean' } } });
  if (!v.frozen) throw Error('FROZEN_PLAN_AND_NEW_GRANT_REQUIRED');
  const checked = verifyFrozen(v.frozen), { plan, candidate } = checked;
  if (v['verify-only']) { console.log(JSON.stringify({ status: checked.status, measurement: 'NOT_RUN', synthetic: plan.synthetic })); process.exit(0); }
  // These guards precede workload import, filesystem output, stty and every subprocess.
  if (plan.synthetic) throw Error('SYNTHETIC_CANNOT_START_MEASUREMENT');
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.TERM_PROGRAM !== 'Apple_Terminal' || !process.stdin.isTTY || !process.stdout.isTTY) throw Error('REAL_MACOS_TERMINAL_REQUIRED');
  if (!v.out) throw Error('NEW_OUTPUT_REQUIRED');
  if (process.stdout.columns < 80 || process.stdout.rows < 24) throw Error('VIEWPORT_AT_LEAST_80x24_REQUIRED');
  const out = outputPath(v.out, [candidate], [v.frozen, checked.frozen.plan.path, checked.frozen.grant.path]);
  const binding = { candidateManifest: plan.candidateManifest, frozen: fileRef(v.frozen), synthetic: false };
  if (v.worker) {
    if (!['inventory', 'startup', 'idle', 'session', 'query'].includes(v.worker)) throw Error('UNKNOWN_MEASUREMENT_WORKER');
    if (existsSync(out)) throw Error('OUTPUT_ALREADY_EXISTS');
    // query accepts only a completed sibling session from this exact frozen plan.
    if (v.worker === 'query') {
      if (!v.session) throw Error('SESSION_REQUIRED');
      const parent = JSON.parse(readFileSync(join(resolve(v.session), 'result.json'), 'utf8'));
      if (parent.status !== 'MEASURED' || parent.binding?.frozen?.sha256 !== binding.frozen.sha256 || parent.binding?.candidateManifest?.sha256 !== plan.candidateManifest.sha256) throw Error('SESSION_BINDING_REQUIRED');
    }
    mkdirSync(out, { mode: 0o700 });
    const { runWorkload } = await import('./workloads.mjs');
    await runWorkload(v.worker, checked, out, binding, v.session); process.exit(0);
  }
  mkdirSync(out, { mode: 0o700 }); mkdirSync(join(out, 'home')); mkdirSync(join(out, 'tmp'));
  const environment = { at: new Date().toISOString(), machine: { chip: cpus()[0]?.model ?? null, system: release(), memoryBytes: totalmem() },
    node: process.version, nodeExecutable: process.execPath, platform: process.platform, arch: process.arch,
    terminal: { program: process.env.TERM_PROGRAM, version: process.env.TERM_PROGRAM_VERSION ?? null, columns: process.stdout.columns, rows: process.stdout.rows, term: process.env.TERM ?? null, ...plan.environment },
    loadBefore: loadavg(), cache: '完整安装核对预热文件缓存；未清缓存', process: '仅宿主 Node RSS；不含 Terminal.app、短暂子进程；采样峰值不是绝对峰值' };
  save(join(out, 'plan.json'), { ...binding, plan, environment });
  const stty = () => { const r = spawnSync('/bin/stty', ['-g'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' }); if (r.status !== 0) throw Error('STTY_UNAVAILABLE'); return r.stdout.trim(); };
  const originalTty = stty(), originalRaw = !!process.stdin.isRaw, dimensions = [process.stdout.columns, process.stdout.rows];
  const jobs = [['inventory', 'inventory'], ['startup', 'startup'], ...Array.from({ length: plan.workload.idleRepetitions }, (_, i) => [`idle-${i + 1}`, 'idle']), ['session', 'session'], ['query', 'query']];
  const env = { HOME: join(out, 'home'), TMPDIR: join(out, 'tmp'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  for (const name of ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'LANG', 'LC_CTYPE', 'COLORTERM', 'NO_COLOR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  const steps = [], metrics = [], began = performance.now(); let failure = null;
  try {
    for (const [id, worker] of jobs) {
      if (Date.now() >= Date.parse(plan.deadline) || performance.now() - began >= plan.workload.batchTimeoutMs) throw Error('BATCH_DEADLINE');
      if (process.stdout.columns !== dimensions[0] || process.stdout.rows !== dimensions[1]) throw Error('VIEWPORT_CHANGED');
      const start = performance.now(), loadBefore = loadavg();
      const args = [join(directory, 'measure.mjs'), '--frozen', resolve(v.frozen), '--worker', worker, '--out', join(out, id)];
      if (worker === 'query') args.push('--session', join(out, 'session'));
      const p = spawnSync(process.execPath, args, { stdio: 'inherit', env, timeout: Math.min(plan.workload.processTimeoutMs, plan.workload.batchTimeoutMs - (performance.now() - began), Date.parse(plan.deadline) - Date.now()), killSignal: 'SIGTERM' });
      const resultPath = join(out, id, 'result.json'), failurePath = join(out, id, 'failure.json');
      const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null, failed = existsSync(failurePath) ? JSON.parse(readFileSync(failurePath, 'utf8')) : null;
      const sttyAfter = stty(), rawAfter = !!process.stdin.isRaw;
      const outcome = classifyWorker({ worker, result, failure: failed, exitCode: p.status, signal: p.signal, error: p.error ? String(p.error) : null, terminalRestored: sttyAfter === originalTty && rawAfter === originalRaw });
      const row = { id, worker, result: result ? fileRef(resultPath) : null, failure: failed ? fileRef(failurePath) : null, firstFailure: outcome.firstFailure, exitCode: p.status, signal: p.signal, error: p.error ? String(p.error) : null, elapsedMs: performance.now() - start, loadBefore, loadAfter: loadavg(), sttyAfter, rawAfter, measurementStatus: outcome.measurementStatus };
      steps.push(row); save(join(out, `${id}-process.json`), row);
      metrics.push(...outcome.metrics);
      if (outcome.measurementStatus === 'FAIL') throw Error(`STEP_FAILED:${id}`);
    }
  } catch (error) { failure = String(error); }
  finally {
    let ttyAtEnd = null, ttyRepair = null;
    try { ttyAtEnd = stty(); if (ttyAtEnd !== originalTty) { const repair = spawnSync('/bin/stty', [originalTty], { stdio: 'inherit' }); ttyRepair = repair.status; } } catch (e) { failure ??= String(e); }
    const unresolved = rows().filter(row => !metrics.some(m => m.id === row.id) && !['keys', 'cost'].includes(row.id)).map(row => ({ ...row, reason: failure ?? '计划未运行该项' }));
    save(join(out, 'result.json'), { schema: `${SCHEMA}-result`, ...binding, status: failure ? 'MEASURED_WITH_FAILURES' : 'MEASURED',
      firstFailure: failure, environment, steps, notRun: jobs.slice(steps.length).map(([id]) => id), metrics: [...metrics, ...unresolved],
      tty: { originalTty, originalRaw, ttyAtEnd, ttyRepair }, realProvider: 'NOT_RUN', dailySnapshot: 'NOT_RUN', dailyAcceptance: '待接受' });
  }
  console.log(`A2 受控证据保留于 ${out}；真实日常 2c 与用户接受另记。`); if (failure) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', error: String(error.message), remaining: 'NOT_RUN' })); process.exitCode = 2; }
