import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { runRestricted, exportStopped } from './boundary.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runProbe({ evidenceDir, image }) {
  await mkdir(evidenceDir, { mode: 0o700 });
  evidenceDir = await realpath(evidenceDir);
  const report = { schema: 1, scope: 'issue-12 mechanism probe only; product eval NOT VERIFIED',
    image, status: 'invalid', scenarios: [], startedAt: new Date().toISOString(),
    mechanism: 'Apple container 1.4.1 + Linux unshare/setpriv + fixed libseccomp socket policy' };
  const homeCanary = await mkdtemp(join(homedir(), '.durio-isolation-probe-'));
  const trusted = join(evidenceDir, 'trusted');
  await mkdir(trusted);
  const shared = join(trusted, 'shared-git');
  await mkdir(shared);
  const targets = [
    ['host_home_credential', join(homeCanary, 'credential')],
    ['other_trial_history', join(trusted, 'other-trial-answer')],
    ['original_grader', join(trusted, 'grader.mjs')],
    ['hidden_expected', join(trusted, 'expected.txt')],
    ['shared_git', join(shared, 'HEAD')],
    ['original_fixture', join(trusted, 'fixture.txt')],
    ['trusted_report', join(trusted, 'report.json')],
  ].map(([name, path]) => ({ name, path }));
  const contents = new Map();
  for (const { path } of targets) {
    const value = `synthetic-canary-${randomUUID()}`;
    contents.set(path, value); await writeFile(path, value, { flag: 'wx' });
  }
  const socket = join(homeCanary, 'control.sock');
  let controlConnections = 0;
  const server = net.createServer(client => { controlConnections++; client.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  // A dedicated sacrificial host process, never an unrelated app or agent PID.
  const sentinelFile = join(trusted, 'sentinel-signal');
  const sentinel = spawn(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], 'unchanged');
    process.on('SIGUSR1',()=>require('node:fs').writeFileSync(process.argv[1],'signaled'));
    setInterval(()=>{},1000);
  `, sentinelFile], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  await sleep(100);
  const previousSecret = process.env.DURIO_PROBE_SECRET;
  process.env.DURIO_PROBE_SECRET = `synthetic-provider-key-${randomUUID()}`;
  let providerCalls = 0;
  const model = { maxRequests: 1, maxOutputTokens: 8, request: async ({ input, maxOutputTokens }) => {
    if (!process.env.DURIO_PROBE_SECRET || input !== 'Return the literal integer 42.' || maxOutputTokens !== 8) throw new Error('invalid_stub_request');
    providerCalls++;
    return '42';
  } };
  const assertClean = async () => {
    for (const [path, expected] of contents) if (await readFile(path, 'utf8') !== expected) throw new Error('trusted_asset_pollution');
    if (controlConnections !== 0 || await readFile(sentinelFile, 'utf8') !== 'unchanged') throw new Error('host_control_channel_reached');
  };
  try {
    const plan = { image, orderedScenarios: ['good', 'bad-score', 'timeout', 'bad-model', 'symlink'],
      expected: { good: 'PASS', 'bad-score': 'FAIL', timeout: 'timeout', 'bad-model': 'model_request_denied', symlink: 'invalid_export' },
      hiddenExpected: '42\n', credential: 'synthetic only', timeoutMs: 12000, modelBudget: { requests: 1, maxOutputTokens: 8 },
      targets, hostPid: sentinel.pid, socket };
    await writeFile(join(trusted, 'plan.json'), json(plan), { flag: 'wx' });
    for (const mode of plan.orderedScenarios) {
      const scenarioDir = join(evidenceDir, mode);
      await mkdir(scenarioDir);
      const inputDir = join(scenarioDir, 'fixture'); await mkdir(inputDir);
      for (const file of ['probe.mjs', 'native-probe.py']) await copyFile(join(fixtures, file), join(inputDir, file));
      await writeFile(join(inputDir, 'public-test.mjs'), 'console.log("public example only");');
      await writeFile(join(inputDir, 'probe-input.json'), json({ mode, targets, socket, hostPid: sentinel.pid }));
      const beforeCalls = providerCalls;
      const execution = await runRestricted({ image, inputDir, runDir: join(scenarioDir, 'execution'),
        command: ['node', '/input/probe.mjs'], timeoutMs: mode === 'timeout' ? 2500 : 12000, model });
      const scenario = { mode, status: 'invalid', execution: { id: execution.id, status: execution.status,
        reason: execution.reason, terminated: execution.terminated }, providerCalls: providerCalls - beforeCalls };
      report.scenarios.push(scenario);
      if (execution.status === 'invalid' || !execution.terminated) throw new Error(execution.reason ?? 'execution_boundary_unknown');
      await assertClean();
      if (mode === 'bad-model') {
        if (execution.reason !== 'model_request_denied' || scenario.providerCalls !== 0) throw new Error('unauthorized_model_action');
        scenario.status = 'PASS'; continue;
      }
      const exportDir = join(scenarioDir, 'export');
      scenario.probeFiles = await exportStopped(execution, ['probes.json', 'descendant.json', 'heartbeat.txt', 'public-test.mjs'], exportDir);
      const probes = JSON.parse(await readFile(join(exportDir, 'probes.json'), 'utf8'));
      const descendant = JSON.parse(await readFile(join(exportDir, 'descendant.json'), 'utf8'));
      for (const native of [probes.nativeEvidence, descendant]) {
        if (native.uid !== 1000 || native.gid !== 1000 || !/^NoNewPrivs:\s+1$/m.test(native.status) ||
            !/^Seccomp:\s+2$/m.test(native.status) ||
            ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].some(field => !new RegExp(`^${field}:\\s+0+$`, 'm').test(native.status)) ||
            native.networkDevices.split('\n').some(line => /^\s*[^ :]+:/.test(line) && !/^\s*lo:/.test(line))) {
          throw new Error('restriction_state_mismatch');
        }
      }
      scenario.probes = [...probes.results, ...descendant.results.map(item => ({ ...item, name: `descendant:${item.name}` }))];
      const missed = scenario.probes.filter(item => item.blocked !== true);
      if (missed.length) throw new Error(`boundary_probe_failed:${missed.map(item => item.name).join(',')}`);
      const heartbeat = await readFile(join(scenarioDir, 'execution/work/heartbeat.txt'), 'utf8');
      await sleep(250);
      if (heartbeat !== await readFile(join(scenarioDir, 'execution/work/heartbeat.txt'), 'utf8')) throw new Error('residual_execution');
      scenario.residualCheck = { beforeHash: hash(heartbeat), afterHash: hash(await readFile(join(scenarioDir, 'execution/work/heartbeat.txt'))),
        stoppedThenDeleted: true, elapsedMs: 250 };
      if (mode === 'timeout') {
        if (execution.reason !== 'timeout') throw new Error('timeout_not_preserved');
        scenario.status = 'PASS'; continue;
      }
      if (mode === 'symlink') {
        try { await exportStopped(execution, ['program.mjs'], join(scenarioDir, 'artifacts')); }
        catch (error) { scenario.exportRejection = error.message; scenario.status = 'PASS'; scenario.trialValidity = 'invalid'; }
        if (scenario.status !== 'PASS') throw new Error('unsafe_export_accepted');
        continue;
      }
      if (execution.status !== 'completed') throw new Error('execution_failed');
      const artifacts = join(scenarioDir, 'artifacts');
      scenario.artifacts = await exportStopped(execution, ['program.mjs'], artifacts);
      // Scoring receives safe copies and public measurement code, never hidden values.
      const gradingInput = join(scenarioDir, 'grading-input'); await mkdir(gradingInput);
      await copyFile(join(artifacts, 'program.mjs'), join(gradingInput, 'program.mjs'));
      await copyFile(join(fixtures, 'native-probe.py'), join(gradingInput, 'native-probe.py'));
      const grading = await runRestricted({ image, inputDir: gradingInput, runDir: join(scenarioDir, 'grading'),
        command: ['node', '/input/program.mjs'], timeoutMs: 10000 });
      scenario.grading = { status: grading.status, reason: grading.reason, terminated: grading.terminated, id: grading.id };
      if (grading.status !== 'completed' || !grading.terminated) throw new Error('ungradable');
      if (mode === 'good') {
        const measurements = join(scenarioDir, 'measurements');
        await exportStopped(grading, ['grading-probes.json'], measurements);
        const gradingProbes = JSON.parse(await readFile(join(measurements, 'grading-probes.json'), 'utf8'));
        if (gradingProbes.some(item => item.blocked !== true)) throw new Error('grading_boundary_failed');
        scenario.grading.probes = gradingProbes;
      }
      // Actual host-observed process exit and stdout are the measurement. The
      // candidate-written measurement.json/PASS log must not authorize a grade.
      const measurement = { code: grading.code, stdout: grading.stdout, stderr: grading.stderr };
      scenario.measurement = measurement;
      scenario.trustedGrade = measurement.code === 0 && measurement.stdout === plan.hiddenExpected ? 'PASS' : 'FAIL';
      if (scenario.trustedGrade !== plan.expected[mode]) throw new Error('trusted_scoring_mismatch');
      await assertClean();
      scenario.status = 'PASS';
    }
    report.status = 'PASS';
  } catch (error) {
    report.reason = error.message;
    const completed = new Set(report.scenarios.map(item => item.mode));
    for (const mode of ['good', 'bad-score', 'timeout', 'bad-model', 'symlink']) {
      if (!completed.has(mode)) report.scenarios.push({ mode, status: 'NOT_RUN', reason: 'prior_boundary_failure' });
    }
  } finally {
    sentinel.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.DURIO_PROBE_SECRET; else process.env.DURIO_PROBE_SECRET = previousSecret;
    await rm(homeCanary, { recursive: true });
    report.providerCalls = providerCalls;
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceDir, 'report.json'), json(report), { flag: 'wx' });
    await writeFile(join(evidenceDir, 'report.md'), `# #12 隔离探查\n\n结果：${report.status}\n\n${report.scope}\n\n` +
      report.scenarios.map(item => `- ${item.mode}: ${item.status}; ${item.execution?.reason ?? item.reason ?? item.trustedGrade ?? ''}`).join('\n') +
      `\n\n确定性宿主模型替身调用：${providerCalls}；付费模型调用：0。\n` + (report.reason ? `\n停止原因：${report.reason}\n` : ''), { flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/isolation/probe.mjs <new-evidence-directory> <immutable-image-reference>');
  const report = await runProbe({ evidenceDir: resolve(process.argv[2]), image: process.argv[3] });
  console.log(JSON.stringify({ status: report.status, reason: report.reason, evidenceDir: resolve(process.argv[2]) }));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
