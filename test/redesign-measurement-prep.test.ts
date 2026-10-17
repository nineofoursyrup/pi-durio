import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Only tiny, explicitly synthetic JSON/files. Product modules are poison pills.
// No performance sampler, native terminal, product task, provider or VM executes.
const prep = await import(pathToFileURL(resolve('scripts/redesign-measurement/core.mjs')).href);
const live = await import(pathToFileURL(resolve('scripts/redesign-live/core.mjs')).href);
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-redesign-measurement-prep-'))), source = join(root, 'source'), installation = join(root, 'installation'), harness = join(root, 'terminal-harness');
  mkdirSync(source); mkdirSync(join(installation, 'dist/execution'), { recursive: true }); mkdirSync(join(installation, 'dist/src/tui'), { recursive: true }); mkdirSync(harness);
  const poison = "throw Error('PRODUCT_IMPORT_FORBIDDEN');\n";
  writeFileSync(join(installation, 'dist/src/tui/app.js'), poison); writeFileSync(join(harness, 'native.mjs'), poison);
  const buildPath = join(installation, 'dist/execution/source-build.json'); write(buildPath, { synthetic: true, inputs: [] });
  const manifestPath = join(root, 'manifest.json'), manifest = { schema: 'pi-durio-redesign-terminal-v1', candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, source: { root: source, sourceBuildSha256: prep.fileRef(buildPath).sha256 },
    installation: { root: installation, files: ['dist/src/tui/app.js', 'dist/execution/source-build.json'].map(path => ({ path, sha256: prep.fileRef(join(installation, path)).sha256 })) },
    harness: { root: harness, files: [{ path: 'native.mjs', sha256: prep.fileRef(join(harness, 'native.mjs')).sha256 }] }, runtime: { node: process.version, platform: process.platform, arch: process.arch }, synthetic: true, nativeAcceptance: 'NOT_RUN' };
  write(manifestPath, manifest); const candidateManifest = prep.fileRef(manifestPath);
  const distribution = join(root, 'synthetic-package.tgz'), installLog = join(root, 'synthetic-install.log'); writeFileSync(distribution, 'SYNTHETIC metadata, never measured'); writeFileSync(installLog, 'SYNTHETIC installation declaration only');
  const installationPath = join(root, 'installation.json'); write(installationPath, { ...prep.installationTemplate(), candidateManifest, kind: 'independent-production-install', devDependencies: 'excluded', command: 'SYNTHETIC fixture; no install execution', at: '2026-10-17T00:00:00Z', evidence: [prep.fileRef(installLog)] });
  const now = Date.now(), plan = { ...prep.planTemplate(), id: 'synthetic-A2', synthetic: true, candidateManifest,
    workload: { startupRepetitions: 2, idleRepetitions: 1, idleMs: 3, rssIntervalMs: 1, sessionRounds: 3, minimumSessionMs: 8, roundIntervalMs: 1, largeOutputBytes: 64, queryCycles: 2, exportRepetitions: 2, taskTimeoutMs: 20, processTimeoutMs: 30, batchTimeoutMs: 50 },
    distribution: prep.fileRef(distribution), installationEvidence: prep.fileRef(installationPath), environment: { terminalProfile: 'SYNTHETIC', font: 'SYNTHETIC', loadConditions: 'No workload executes', cachePolicy: 'SYNTHETIC', process: 'JSON validation only' },
    thresholds: { policy: 'report-only-no-hard-threshold', criteria: [] }, deadline: new Date(now + 600000).toISOString(), nodeExecutable: process.execPath };
  const planPath = join(root, 'plan.json'), grantPath = join(root, 'grant.json'), grant = { ...prep.grantTemplate(), approved: true, by: 'SYNTHETIC fixture', statement: 'SYNTHETIC ONLY, no actual authorization', at: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 601000).toISOString() };
  const persist = () => { write(planPath, plan); grant.planSha256 = prep.fileRef(planPath).sha256; write(grantPath, grant); }; persist();
  return { root, source, installation, manifestPath, candidateManifest, manifest, plan, planPath, grant, grantPath, persist, now };
}
function selfFixture(f: ReturnType<typeof fixture>) {
  const measured = (value: any, source = 'records', samples: number | null = 1) => ({ value, source, samples, basis: 'SYNTHETIC fixture only', ...(value === null ? { reason: 'unknown in this synthetic fixture' } : {}) });
  return { schema: 'pi-durio-self-v1', at: '2026-10-17T00:00:00Z', exportedAt: '2026-10-17T00:01:00Z', environment: { build: f.manifest.source.sourceBuildSha256, terminal: 'Terminal.app', terminalVersion: null, chip: 'SYNTHETIC', system: 'UNKNOWN', node: 'SYNTHETIC', columns: 132, rows: 38, dataRoot: '/synthetic/no-data', uptimeMs: 12 },
    code: { product: measured(null, 'build-manifest', null), scripts: measured(null, 'build-manifest', null), patch: measured(null, 'build-manifest', null), tests: measured(null, 'build-manifest', null), dependencies: measured(null, 'build-manifest', null) },
    installation: measured(null, 'records', null), firstFrame: measured(null, 'process', 0), keys: measured({ samples: 2, p50: 3, p95: null }, 'process', 2), memory: measured({ bytes: 12, state: '空闲' }, 'process'), peak: measured({ bytes: 15, tasks: null, toolOutputBytes: null }, 'process'),
    query: measured({ ms: 1, runs: 0, more: false, coverage: { snapshot: 9, current: 11, stale: true, missing: ['synthetic-source'], emptyMeans: 'unknown' } }),
    cost: measured({ scope: { from: '2026-10-11', to: '2026-10-18', asOf: '2026-10-17T00:00:00Z', through: 9, source: 'ordinary' }, spend: { rows: [], total: { totals: { amounts: { USD: 0.2 }, unknownRequests: 2, partial: true }, tokens: 12 } }, gaps: [{ runId: 'synthetic', source: null, reason: 'unknown usage', mayAffectSample: true }] }),
    facts: measured({ tasks: null, through: 9 }), notMeasured: [{ name: '冷启动', value: null, samples: 0, source: 'external', status: '产品内不测 · 见 A2 报告', reason: 'not measured' }], exportQueue: { value: '无', source: 'process', samples: null }, limitation: 'SYNTHETIC daily snapshot contract only; not controlled A2', unknownFutureField: { keep: true } };
}

test('unfilled templates and expired/mismatched plans refuse; same batch deadline is absolute', () => {
  const f = fixture(), empty = join(f.root, 'empty.json'); write(empty, prep.planTemplate());
  assert.equal(prep.validate(empty).status, 'BLOCKED'); assert.equal(prep.acceptanceTemplate().status, '待接受');
  assert.equal(prep.validate(f.planPath, f.grantPath).status, 'SYNTHETIC_VALID');
  assert.equal(prep.validate(f.planPath, f.grantPath, { now: Date.parse(f.plan.deadline) - 1 }).status, 'SYNTHETIC_VALID', 'worker need not reserve a second whole batch window');
  assert.ok(prep.validate(f.planPath, f.grantPath, { now: Date.parse(f.plan.deadline) }).issues.includes('DEADLINE_REQUIRED'));
  f.grant.approved = false; f.persist(); assert.ok(prep.validate(f.planPath, f.grantPath).issues.includes('NEW_EXPLICIT_AUTHORIZATION_REQUIRED'));
  f.grant.approved = true; f.plan.synthetic = false; f.persist(); assert.ok(prep.validate(f.planPath, f.grantPath).issues.includes('SYNTHETIC_PROVENANCE_MISMATCH'));
});

test('frozen PREP never launches synthetic workloads; all script entrypoints parse without product import', () => {
  const f = fixture(), frozen = join(f.root, 'frozen.json'); prep.freeze(f.planPath, f.grantPath, frozen);
  for (const name of ['core.mjs', 'cli.mjs', 'measure.mjs', 'workloads.mjs']) {
    const p = spawnSync(process.execPath, ['--check', resolve('scripts/redesign-measurement', name)], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
  }
  const script = resolve('scripts/redesign-measurement/measure.mjs'), run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const verified = run(['--frozen', frozen, '--verify-only']); assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).measurement, 'NOT_RUN');
  const out = join(f.root, 'must-not-start'), refused = run(['--frozen', frozen, '--out', out]); assert.equal(refused.status, 2); assert.match(refused.stderr, /SYNTHETIC_CANNOT_START_MEASUREMENT/); assert.equal(existsSync(out), false);
  assert.throws(() => prep.freeze(f.planPath, f.grantPath, frozen), /EEXIST/);
  f.plan.environment.font = 'modified'; f.persist(); assert.throws(() => prep.verifyFrozen(frozen), /FIXED_FILE_CHANGED/);
});

test('outputs cannot alter source or aliases, frozen inputs or prior evidence', () => {
  const f = fixture();
  assert.throws(() => prep.save(join(f.source, 'evidence.json'), {}, [f.manifest]), /OUTPUT_INSIDE_PROTECTED_INPUT/);
  const alias = join(f.root, 'source-alias'); symlinkSync(f.source, alias);
  assert.throws(() => prep.save(join(alias, 'evidence.json'), {}, [f.manifest]), /OUTPUT_INSIDE_PROTECTED_INPUT/);
  const prior = join(f.root, 'prior.json'); prep.save(prior, { firstFailure: 'keep' }, [f.manifest]); assert.throws(() => prep.save(prior, {}, [f.manifest]), /EEXIST/);
  assert.equal(JSON.parse(readFileSync(prior, 'utf8')).firstFailure, 'keep');
  assert.throws(() => prep.save(f.planPath, {}, [f.manifest], [f.planPath]), /OUTPUT_INSIDE_PROTECTED_INPUT/);
});

test('2c import preserves original bytes, wrappers, missing storage, currencies and unknowns without A2 promotion', () => {
  const f = fixture(), snapshot = selfFixture(f), self = join(f.root, 'daily-self.json'); writeFileSync(self, JSON.stringify(snapshot) + '\n\n');
  const input = { ...prep.dailyTemplate(), synthetic: true, candidateManifest: f.candidateManifest, self: prep.fileRef(self) }, inputPath = join(f.root, 'daily-input.json'); write(inputPath, input);
  const out = join(f.root, 'daily-attachment'); const attachment = prep.attachSelf(inputPath, out);
  assert.equal(attachment.status, 'SYNTHETIC_ONLY'); assert.equal(attachment.controlledA2, 'NOT_RUN'); assert.deepEqual(readFileSync(attachment.raw.path), readFileSync(self));
  const reportInput = { ...prep.reportTemplate(), candidateManifest: f.candidateManifest, daily: [prep.fileRef(join(out, 'attachment.json'))] }, reportPath = join(f.root, 'report-input.json'); write(reportPath, reportInput);
  const result = prep.report(reportPath); assert.deepEqual(result.daily[0].snapshot, snapshot); assert.equal(result.metrics.find((m: any) => m.id === 'startup').value, null); assert.equal(result.acceptance.status, '待接受');
  snapshot.keys.value.p95 = 9; write(self, snapshot); input.self = prep.fileRef(self); write(inputPath, input); assert.throws(() => prep.attachSelf(inputPath, join(f.root, 'bad-p95')), /SELF_KEY_SAMPLE_CONTRACT/);
  snapshot.keys.value.p95 = null; snapshot.environment.build = f.manifest.candidate.commit; write(self, snapshot); input.self = prep.fileRef(self); write(inputPath, input); assert.throws(() => prep.attachSelf(inputPath, join(f.root, 'bad-build')), /SELF_SCHEMA_OR_BUILD_MISMATCH/);
});

test('aggregation and failed worker accounting keep first failures and partial observations', () => {
  const samples = [{ status: 'MEASURED', value: 1 }, { status: 'FAIL', value: 4, reason: 'failed sample retained' }, { status: 'MEASURED', value: 9 }, { status: 'MEASURED', value: 3 }, { status: 'UNKNOWN', value: null, reason: 'no timing' }];
  const result = prep.summarize(samples); assert.equal(result.median, 3.5); assert.equal(result.observed, 4); assert.equal(result.missing, 1); assert.equal(result.failures, 1); assert.deepEqual(result.samples, samples);
  assert.throws(() => prep.summarize([{ status: 'UNKNOWN', value: null }]), /SAMPLE_VALUE_OR_REASON_REQUIRED/);
  const partial = { id: 'query', status: 'MEASURED', value: { ms: 1 } }, failed = prep.classifyWorker({ worker: 'query', result: null, failure: { error: 'first failure', metrics: [partial] }, exitCode: 1, signal: null, error: null, terminalRestored: true });
  assert.equal(failed.measurementStatus, 'FAIL'); assert.equal(failed.firstFailure, 'first failure'); assert.deepEqual(failed.metrics[0], partial); assert.equal(failed.metrics.find((m: any) => m.id === 'acquisition').status, 'FAIL');
  assert.equal(prep.classifyWorker({ worker: 'idle', result: { status: 'MEASURED', metrics: [] }, failure: null, exitCode: 0, signal: null, error: null, terminalRestored: false }).measurementStatus, 'FAIL');
});

test('report preserves controlled first-failure samples and #93 raw path/cost projection separately', () => {
  const f = fixture(), frozenPath = join(f.root, 'frozen.json'); prep.freeze(f.planPath, f.grantPath, frozenPath);
  const controlledPath = join(f.root, 'controlled.json'), controlled = { schema: `${prep.SCHEMA}-result`, candidateManifest: f.candidateManifest, frozen: prep.fileRef(frozenPath), synthetic: true, status: 'MEASURED_WITH_FAILURES', steps: [{ id: 'startup', measurementStatus: 'FAIL' }], notRun: ['idle'], firstFailure: 'original failure', metrics: [{ id: 'startup', status: 'FAIL', value: null, reason: 'original failure' }] }; write(controlledPath, controlled);
  const livePlan = { ...live.planTemplate('coding'), synthetic: true, candidateManifest: f.candidateManifest }, livePlanPath = join(f.root, 'live-plan.json'); write(livePlanPath, livePlan);
  const observationsPath = join(f.root, 'live-observations.json'), observations = { ...live.observationTemplate(), candidateManifest: f.candidateManifest, plans: [prep.fileRef(livePlanPath)], observations: [{ id: 'synthetic-first-failure', planSha256: prep.fileRef(livePlanPath).sha256, at: '2026-10-17T00:00:00Z', status: 'FAIL', evidence: [], cost: {}, firstFailure: 'keep-original' }] }; write(observationsPath, observations);
  const livePath = join(f.root, 'live-report.json'), liveValue = live.report(observationsPath); write(livePath, liveValue);
  const input = { ...prep.reportTemplate(), candidateManifest: f.candidateManifest, controlled: [prep.fileRef(controlledPath)], liveReport: prep.fileRef(livePath) }, inputPath = join(f.root, 'report-input.json'); write(inputPath, input);
  const result = prep.report(inputPath); assert.equal(result.status, 'SYNTHETIC_ONLY'); assert.deepEqual(result.live.value, liveValue); assert.equal(result.live.ref.sha256, prep.fileRef(livePath).sha256); assert.equal(result.controlled[0].value.firstFailure, 'original failure');
  assert.equal(result.metrics.find((m: any) => m.id === 'idle').status, 'NOT_RUN'); assert.equal(result.metrics.find((m: any) => m.id === 'cost').value.maintenance.value, null); assert.equal(result.acceptance.exactHumanStatement, null);
  write(controlledPath, { ...controlled, metrics: [{ id: 'startup', status: 'MEASURED' }] }); input.controlled = [prep.fileRef(controlledPath)]; write(inputPath, input); assert.throws(() => prep.report(inputPath), /CONTROLLED_METRIC_INVALID/);
  write(controlledPath, { ...controlled, metrics: [{ id: 'startup', status: 'MEASURED', value: null, reason: 'missing is not measured' }] }); input.controlled = [prep.fileRef(controlledPath)]; write(inputPath, input); assert.throws(() => prep.report(inputPath), /CONTROLLED_METRIC_INVALID/);
  write(controlledPath, controlled); input.controlled = [prep.fileRef(controlledPath)]; write(inputPath, input);
  const grantBytes = readFileSync(f.grantPath); write(f.grantPath, { ...f.grant, approved: false }); assert.throws(() => prep.report(inputPath), /FIXED_FILE_CHANGED/); writeFileSync(f.grantPath, grantBytes);
  liveValue.paths[0].realStatus = 'PASS'; write(livePath, liveValue); input.liveReport = prep.fileRef(livePath); write(inputPath, input); assert.throws(() => prep.report(inputPath), /LIVE_REPORT_PROJECTION_CHANGED/);
  controlled.synthetic = false; write(controlledPath, controlled); input.controlled = [prep.fileRef(controlledPath)]; write(inputPath, input); assert.throws(() => prep.report(inputPath), /CONTROLLED_BINDING_REQUIRED/);
});
