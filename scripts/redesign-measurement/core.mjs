/** #94 PREP: JSON, identities and reports only. No product, process launch or measurement import. */
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { sha256 } from '../redesign-terminal/common.mjs';
import { verifyManifest } from '../redesign-terminal/verify.mjs';
import { report as projectLiveReport } from '../redesign-live/core.mjs';

export const SCHEMA = 'pi-durio-redesign-measurement-v1';
const directory = dirname(fileURLToPath(import.meta.url));
const refSlot = () => ({ path: null, sha256: null });
const text = v => typeof v === 'string' && !!v.trim() && !/[\x00\x1b\x7f]/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const number = v => Number.isFinite(v) && v >= 0;
const iso = v => typeof v === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const within = (root, path) => { const r = relative(root, path); return !r || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const copy = v => structuredClone(v);

export const METRICS = [
  ['code', '自有维护代码与统计边界', 'files / physical lines'],
  ['installation', '生产安装（含 SDK/原生依赖；不含外部 Node/开发依赖）', 'bytes'],
  ['distribution', '压缩分发及解包清单', 'bytes'],
  ['startup', '进程冷启动；未清 OS 缓存，不含 Terminal 绘制', 'ms'],
  ['idle', '受控原生空闲 RSS 与首帧', 'bytes / ms'],
  ['session', '受控代表长会话 RSS', 'bytes'],
  ['growth', '记录总量增长与检查点', 'bytes'],
  ['originals', '正常保留完整原文增长（表示副本，不去重）', 'bytes'],
  ['query', '只读查询耗时', 'ms'],
  ['acquisition', '完整输出取得、解码、写入至 close（无 fsync）', 'ms'],
  ['largeOutput', '固定大输出原文一致与后续普通输入', 'bytes'],
  ['cost', 'coding / eval / improve / maintenance 用量与人民币估算', 'CNY / tokens'],
  ['keys', '真实 Terminal 日常 2c 按键到 stdout 重绘', 'ms'],
];
export const rows = () => METRICS.map(([id, label, unit]) => ({ id, label, unit, status: 'NOT_RUN', value: null, reason: '尚未取得当前最终候选的适用证据', evidence: [] }));
export function planTemplate() {
  return { schema: `${SCHEMA}-plan`, id: null, synthetic: false, candidateManifest: refSlot(),
    workload: { startupRepetitions: null, idleRepetitions: null, idleMs: null, rssIntervalMs: null, sessionRounds: null,
      minimumSessionMs: null, roundIntervalMs: null, largeOutputBytes: null, queryCycles: null, exportRepetitions: null,
      taskTimeoutMs: null, processTimeoutMs: null, batchTimeoutMs: null },
    referenceMethod: { source: '首版 issue-31 final-f26ae8f；仅口径参考，不是本次授权或测量结果', startup: 'help / missing-store history 各 7 次', idle: '3 次，各至少 30 s，1 Hz RSS', session: '60 轮 read/edit/check，至少 5 min；1 MiB 输出及后续 read', query: '3 种查询各 10 次；5 次完整输出取得写入' },
    distribution: refSlot(), installationEvidence: refSlot(),
    environment: { terminalProfile: null, font: null, loadConditions: null, cachePolicy: null, process: null },
    thresholds: { policy: null, criteria: [] },
    deadline: null, nodeExecutable: null,
    limits: ['本地合成 transport；不请求真实模型或 VM', '计入观测/哈希开销，不推断孤立 tracing 开销', '全量安装核对会预热文件缓存；不是机器冷启动', '计量与用户接受分开；2c 日常快照不能替代受控样本'],
  };
}
export const grantTemplate = () => ({ schema: `${SCHEMA}-grant`, approved: false, planSha256: null, by: null, statement: null, at: null, expiresAt: null, scope: 'controlled-local-A2-only; no provider, VM or daily acceptance' });
export const acceptanceTemplate = () => ({ schema: `${SCHEMA}-acceptance`, status: '待接受', candidateManifest: refSlot(), report: refSlot(), technicalEvidence: [], measurementEvidence: [],
  user: null, at: null, exactHumanStatement: null, build: null, scope: null, requestedCorrections: [],
  rule: '技术验收与测量完成后由用户本机日用并明确接受；要求先修正仍待接受。反馈、计划、fixture 和本脚本不生成接受。' });
export const dailyTemplate = () => ({ schema: `${SCHEMA}-daily-input`, synthetic: false, candidateManifest: refSlot(), self: refSlot(),
  provenance: { kind: 'daily-terminal-session', user: null, capturedAt: null, statement: null, terminal: null },
  note: '由真实日常 Terminal 会话 /stats --self → e 导出；受控负载/静态 gallery/synthetic 不能填真实日常槽' });
export const reportTemplate = () => ({ schema: `${SCHEMA}-report-input`, candidateManifest: refSlot(), controlled: [], daily: [], liveReport: null,
  omissions: {}, note: '只引用原始文件/hash；每次生成新报告，不覆盖首败。未取得项目填明原因；不手填测量数字。' });
export const installationTemplate = () => ({ schema: `${SCHEMA}-installation`, candidateManifest: refSlot(), kind: null, node: 'excluded', nativeDependencies: 'included', devDependencies: null,
  command: null, at: null, evidence: [], note: '未来执行者提供独立生产安装命令/原日志。开发 checkout 不能充当生产安装体积。' });

function ordinary(path) {
  const p = resolve(path);
  if (/(?:^|\/)(?:api\.env|\.env(?:\.[^/]*)?|auth\.json|credentials[^/]*)$/i.test(p)) throw Error('CREDENTIAL_FILE_FORBIDDEN');
  const s = lstatSync(p); if (!s.isFile() || s.isSymbolicLink() || realpathSync(p) !== p) throw Error('ORDINARY_FILE_REQUIRED');
  return p;
}
export function fileRef(path) { const p = ordinary(path); return { path: p, sha256: sha256(readFileSync(p)) }; }
export function json(path) { const p = ordinary(path); if (!p.endsWith('.json') || lstatSync(p).size > 32 * 1024 * 1024) throw Error('BOUNDED_JSON_REQUIRED'); return JSON.parse(readFileSync(p, 'utf8')); }
export function readRef(ref, asJson = true) {
  if (!isAbsolute(ref?.path ?? '') || !hash(ref.sha256) || fileRef(ref.path).sha256 !== ref.sha256) throw Error('FIXED_FILE_CHANGED_OR_MISSING');
  return asJson ? json(ref.path) : readFileSync(ref.path);
}
export function manifest(ref) { readRef(ref); return verifyManifest(ref.path); }
function canonicalNew(path) { const requested = resolve(path); return join(realpathSync(dirname(requested)), basename(requested)); }
export function outputPath(path, manifests = [], inputs = []) {
  const p = canonicalNew(path), sourceRoot = realpathSync(join(directory, '../..'));
  const roots = [sourceRoot, ...manifests.flatMap(m => [m.source.root, m.installation.root, m.harness.root])];
  if (roots.some(root => within(realpathSync(root), p)) || inputs.some(input => p === realpathSync(input))) throw Error('OUTPUT_INSIDE_PROTECTED_INPUT');
  return p;
}
export function save(path, value, manifests = [], inputs = []) {
  const p = outputPath(path, manifests, inputs); writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return p;
}

export function validate(planPath, grantPath, { now = Date.now() } = {}) {
  const plan = json(planPath), issues = []; let candidate, installation;
  const need = (ok, code) => { if (!ok) issues.push(code); };
  need(plan.schema === `${SCHEMA}-plan` && text(plan.id) && typeof plan.synthetic === 'boolean', 'PLAN_ID_REQUIRED');
  try { candidate = manifest(plan.candidateManifest); need(candidate.synthetic === plan.synthetic, 'SYNTHETIC_PROVENANCE_MISMATCH'); } catch (e) { issues.push(`CANDIDATE:${e.message}`); }
  const w = plan.workload ?? {};
  for (const key of Object.keys(planTemplate().workload)) need(positive(w[key]), `WORKLOAD_REQUIRED:${key}`);
  need(w.sessionRounds % 3 === 0 && w.largeOutputBytes >= 64 && w.largeOutputBytes <= 16 * 1024 * 1024, 'CONTROLLED_WORKLOAD_BOUNDS');
  need(w.idleMs >= w.rssIntervalMs && w.processTimeoutMs > w.idleMs && w.processTimeoutMs > w.minimumSessionMs && w.processTimeoutMs > w.taskTimeoutMs && w.batchTimeoutMs > w.processTimeoutMs, 'TIMEOUT_ORDER');
  need(['report-only-no-hard-threshold', 'operator-defined'].includes(plan.thresholds?.policy) && Array.isArray(plan.thresholds?.criteria) && (plan.thresholds.policy !== 'operator-defined' || plan.thresholds.criteria.length > 0 && plan.thresholds.criteria.every(text)), 'THRESHOLD_POLICY_REQUIRED');
  need(['terminalProfile', 'font', 'loadConditions', 'cachePolicy', 'process'].every(k => text(plan.environment?.[k])), 'ENVIRONMENT_AND_PROCESS_REQUIRED');
  need(iso(plan.deadline) && Date.parse(plan.deadline) > now, 'DEADLINE_REQUIRED');
  need(plan.nodeExecutable === process.execPath, 'NODE_EXECUTABLE_REQUIRED');
  if (candidate) need(candidate.runtime.node === process.version && candidate.runtime.platform === process.platform && candidate.runtime.arch === process.arch, 'RUNTIME_CHANGED');
  try { readRef(plan.distribution, false); } catch (e) { issues.push(`DISTRIBUTION:${e.message}`); }
  try {
    installation = readRef(plan.installationEvidence);
    need(installation.schema === `${SCHEMA}-installation` && equal(installation.candidateManifest, plan.candidateManifest) && installation.kind === 'independent-production-install' && installation.node === 'excluded' && installation.nativeDependencies === 'included' && installation.devDependencies === 'excluded' && text(installation.command) && iso(installation.at) && installation.evidence?.length > 0, 'PRODUCTION_INSTALLATION_REQUIRED');
    for (const ref of installation.evidence ?? []) readRef(ref, false);
  } catch (e) { issues.push(`INSTALLATION:${e.message}`); }
  let grant;
  try {
    grant = grantPath ? json(grantPath) : null;
    need(grant?.schema === `${SCHEMA}-grant` && grant.approved === true && grant.planSha256 === fileRef(planPath).sha256 && text(grant.by) && text(grant.statement) && iso(grant.at) && Date.parse(grant.at) <= now && iso(grant.expiresAt) && Date.parse(grant.expiresAt) >= Date.parse(plan.deadline) && grant.scope === grantTemplate().scope, 'NEW_EXPLICIT_AUTHORIZATION_REQUIRED');
  } catch (e) { issues.push(`AUTHORIZATION:${e.message}`); }
  return { status: issues.length ? 'BLOCKED' : plan.synthetic ? 'SYNTHETIC_VALID' : 'PREP_VALID', issues, plan, candidate, grant, measurement: 'NOT_RUN' };
}
export function harness() { return ['core.mjs', 'cli.mjs', 'measure.mjs', 'workloads.mjs', 'README.md', '../redesign-terminal/common.mjs', '../redesign-terminal/verify.mjs', '../redesign-live/core.mjs'].map(name => fileRef(join(directory, name))); }
export function freeze(planPath, grantPath, out) {
  const checked = validate(planPath, grantPath); if (checked.issues.length) throw Error(`PLAN_BLOCKED:${checked.issues.join(',')}`);
  const value = { schema: `${SCHEMA}-frozen`, plan: fileRef(planPath), grant: fileRef(grantPath), candidateManifest: checked.plan.candidateManifest,
    harness: harness(), synthetic: checked.plan.synthetic, createdAt: new Date().toISOString(), status: 'PREP_FROZEN_NOT_RUN' };
  save(out, value, [checked.candidate], [planPath, grantPath]); return value;
}
export function verifyFrozen(path) {
  const frozen = json(path); if (frozen.schema !== `${SCHEMA}-frozen`) throw Error('FROZEN_SCHEMA');
  readRef(frozen.plan); readRef(frozen.grant);
  if (!equal(frozen.harness, harness())) throw Error('MEASUREMENT_HARNESS_CHANGED');
  for (const r of frozen.harness) readRef(r, false);
  const checked = validate(frozen.plan.path, frozen.grant.path); if (checked.issues.length) throw Error(`PLAN_BLOCKED:${checked.issues.join(',')}`);
  if (!equal(frozen.candidateManifest, checked.plan.candidateManifest) || frozen.synthetic !== checked.plan.synthetic) throw Error('FROZEN_BINDING_CHANGED');
  return { frozen, ...checked };
}

/** Summarize supplied observations only. Missing/failed samples stay in the raw array. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.some(s => !s || !['MEASURED', 'FAIL', 'UNKNOWN', 'NOT_RUN'].includes(s.status) || s.value !== null && !number(s.value) || s.value === null && !text(s.reason))) throw Error('SAMPLE_VALUE_OR_REASON_REQUIRED');
  const values = samples.filter(s => number(s.value)).map(s => s.value).sort((a, b) => a - b), n = values.length;
  return { samples: copy(samples), count: samples.length, observed: n, missing: samples.length - n, failures: samples.filter(s => s.status === 'FAIL').length,
    min: n ? values[0] : null, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.ceil((n - 1) / 2)]) / 2 : null, max: n ? values.at(-1) : null };
}
/** An attempted worker is never NOT_RUN merely because it failed before result.json. */
export function classifyWorker({ worker, result, failure, exitCode, signal, error, terminalRestored }) {
  const ids = { inventory: ['code', 'installation', 'distribution'], startup: ['startup'], idle: ['idle'], session: ['session', 'growth', 'originals', 'largeOutput'], query: ['query', 'acquisition'] }[worker];
  if (!ids) throw Error('UNKNOWN_WORKER');
  const passed = result?.status === 'MEASURED' && exitCode === 0 && !signal && !error && terminalRestored;
  const firstFailure = passed ? null : failure?.error ?? error ?? `STEP_FAILED:${worker}; exit=${exitCode}; signal=${signal}; terminalRestored=${terminalRestored}`;
  const metrics = copy(result?.metrics ?? failure?.metrics ?? []);
  if (!passed) for (const id of ids) metrics.push({ id, status: 'FAIL', value: null, reason: firstFailure });
  return { measurementStatus: passed ? 'MEASURED' : 'FAIL', firstFailure, metrics };
}
function selfValid(value, candidate) {
  if (value.schema !== 'pi-durio-self-v1' || !iso(value.at) || !iso(value.exportedAt) || value.environment?.build !== null && value.environment?.build !== candidate.source.sourceBuildSha256) throw Error('SELF_SCHEMA_OR_BUILD_MISMATCH');
  const wrapped = [value.installation, value.firstFrame, value.keys, value.memory, value.peak, value.query, value.cost, value.facts, ...Object.values(value.code ?? {})];
  if (value.storage !== undefined) wrapped.push(value.storage);
  for (const v of wrapped) if (!v || !Object.hasOwn(v, 'value') || !['process', 'records', 'build-manifest'].includes(v.source) || typeof v.basis !== 'string' || v.samples !== null && (!Number.isSafeInteger(v.samples) || v.samples < 0)) throw Error('SELF_WRAPPER_REQUIRED');
  const k = value.keys.value;
  if (k !== null && (!Number.isSafeInteger(k.samples) || k.samples < 0 || k.samples !== value.keys.samples || k.samples === 0 && k.p50 !== null || k.samples > 0 && !number(k.p50) || k.samples < 20 && k.p95 !== null || k.samples >= 20 && !number(k.p95))) throw Error('SELF_KEY_SAMPLE_CONTRACT');
  if (!Array.isArray(value.notMeasured) || !text(value.limitation)) throw Error('SELF_LIMITATIONS_REQUIRED');
}
export function attachSelf(inputPath, out) {
  const input = json(inputPath), candidate = manifest(input.candidateManifest), snapshot = readRef(input.self);
  if (input.schema !== `${SCHEMA}-daily-input` || input.synthetic !== candidate.synthetic || input.provenance?.kind !== 'daily-terminal-session') throw Error('DAILY_PROVENANCE_REQUIRED');
  selfValid(snapshot, candidate);
  const real = !input.synthetic && snapshot.environment.build !== null && snapshot.environment.terminal === 'Terminal.app' && input.provenance.terminal === 'Terminal.app' && text(input.provenance.user) && text(input.provenance.statement) && iso(input.provenance.capturedAt);
  const dir = outputPath(out, [candidate], [inputPath, input.self.path]); mkdirSync(dir, { mode: 0o700 });
  const raw = join(dir, 'original-self.json'); writeFileSync(raw, readRef(input.self, false), { flag: 'wx', mode: 0o600 });
  const value = { schema: `${SCHEMA}-daily-attachment`, candidateManifest: input.candidateManifest, synthetic: input.synthetic,
    input: fileRef(inputPath), original: input.self, raw: fileRef(raw), provenance: copy(input.provenance),
    status: input.synthetic ? 'SYNTHETIC_ONLY' : real ? 'SUPPLIED_DAILY_SNAPSHOT' : 'EVIDENCE_INSUFFICIENT', controlledA2: 'NOT_RUN',
    limitation: '保留原 JSON 字节及全部 wrapper；仅日常快照，不能替代受控 A2。记录来源声明，不独立证明用户操作。' };
  save(join(dir, 'attachment.json'), value, [candidate]); return value;
}

export function report(inputPath) {
  const input = json(inputPath), candidate = manifest(input.candidateManifest);
  if (input.schema !== `${SCHEMA}-report-input` || !Array.isArray(input.controlled) || !Array.isArray(input.daily)) throw Error('REPORT_INPUT_SCHEMA');
  const result = { schema: `${SCHEMA}-report`, candidateManifest: copy(input.candidateManifest), candidate: copy(candidate.candidate), synthetic: candidate.synthetic,
    input: fileRef(inputPath), metrics: rows(), controlled: [], daily: [], live: null, acceptance: acceptanceTemplate(),
    status: 'INCOMPLETE', claim: '仅汇总所提供证据，不作独立测量、技术验收或用户接受；数值不等于达到轻量阈值。' };
  for (const row of result.metrics) if (text(input.omissions?.[row.id])) row.reason = input.omissions[row.id];
  for (const ref of input.controlled) {
    const value = readRef(ref);
    if (value.schema !== `${SCHEMA}-result` || !equal(value.candidateManifest, input.candidateManifest) || value.synthetic !== candidate.synthetic || !Array.isArray(value.metrics) || !Array.isArray(value.steps) || !Array.isArray(value.notRun)) throw Error('CONTROLLED_BINDING_REQUIRED');
    const frozen = readRef(value.frozen), fixed = readRef(frozen.plan), grant = readRef(frozen.grant);
    if (frozen.schema !== `${SCHEMA}-frozen` || !equal(frozen.candidateManifest, input.candidateManifest) || frozen.synthetic !== value.synthetic || fixed.schema !== `${SCHEMA}-plan` || !equal(fixed.candidateManifest, input.candidateManifest) || fixed.synthetic !== value.synthetic || grant.schema !== `${SCHEMA}-grant` || grant.approved !== true || grant.planSha256 !== frozen.plan.sha256 || !Array.isArray(frozen.harness) || !frozen.harness.length) throw Error('CONTROLLED_PLAN_MISMATCH');
    // Historical reporting is allowed after expiry, but its original grant and
    // harness bytes must still match; it does not authorize another execution.
    for (const helper of frozen.harness) readRef(helper, false);
    result.controlled.push({ ref: copy(ref), value: copy(value) });
    for (const metric of value.metrics) {
      const row = result.metrics.find(r => r.id === metric.id && !['keys', 'cost'].includes(r.id));
      if (!row || !['MEASURED', 'FAIL', 'UNKNOWN', 'NOT_RUN'].includes(metric.status) || !Object.hasOwn(metric, 'value') || metric.value === null && (metric.status === 'MEASURED' || !text(metric.reason))) throw Error('CONTROLLED_METRIC_INVALID');
      row.evidence.push({ ref: copy(ref), metric: copy(metric) });
      row.value = row.evidence.map(e => e.metric); // Preserve every batch and first failure, not only a last-success summary.
      row.status = candidate.synthetic ? 'SYNTHETIC_ONLY' : row.evidence.some(e => e.metric.status === 'FAIL') ? 'FAIL' : row.evidence.every(e => e.metric.status === 'MEASURED') ? 'MEASURED' : 'EVIDENCE_INSUFFICIENT';
      row.reason = candidate.synthetic ? 'synthetic 只验证报告处理；本候选未实测' : '全部批次逐项保留；不得将后续成功覆盖首败';
    }
  }
  for (const ref of input.daily) {
    const attachment = readRef(ref), originalInput = readRef(attachment.input), snapshot = readRef(attachment.raw);
    if (attachment.schema !== `${SCHEMA}-daily-attachment` || !equal(attachment.candidateManifest, input.candidateManifest) || attachment.synthetic !== candidate.synthetic || !equal(originalInput.candidateManifest, input.candidateManifest) || originalInput.synthetic !== attachment.synthetic || !equal(originalInput.provenance, attachment.provenance) || !equal(originalInput.self, attachment.original) || attachment.original.sha256 !== attachment.raw.sha256) throw Error('DAILY_BINDING_REQUIRED');
    selfValid(snapshot, candidate);
    const real = !candidate.synthetic && snapshot.environment.build !== null && snapshot.environment.terminal === 'Terminal.app' && originalInput.provenance?.terminal === 'Terminal.app' && text(originalInput.provenance?.user) && text(originalInput.provenance?.statement) && iso(originalInput.provenance?.capturedAt);
    result.daily.push({ ref: copy(ref), attachment: copy(attachment), snapshot: copy(snapshot) });
    const row = result.metrics.find(r => r.id === 'keys'); row.evidence.push(copy(ref));
    row.value = result.daily.map(d => ({ at: d.snapshot.at, exportedAt: d.snapshot.exportedAt, environment: d.snapshot.environment, keys: d.snapshot.keys, source: d.ref }));
    row.status = candidate.synthetic ? 'SYNTHETIC_ONLY' : real && snapshot.keys.value?.samples > 0 ? 'SUPPLIED_DAILY_SNAPSHOT' : 'EVIDENCE_INSUFFICIENT';
    row.reason = '仅进程收到输入→stdout 同步内容帧；无逐次样本数组，不能重建分位数或代替受控 A2';
  }
  if (input.liveReport) {
    const value = readRef(input.liveReport);
    if (value.schema !== 'pi-durio-redesign-live-v1-report' || !equal(value.candidateManifest, input.candidateManifest) || !equal(value.candidate, candidate.candidate) || value.paths?.length !== 3 || !['coding', 'improve', 'eval'].every(path => value.paths.filter(p => p.path === path).length === 1)) throw Error('LIVE_REPORT_BINDING_REQUIRED');
    readRef(value.input);
    if (!equal(value, projectLiveReport(value.input.path))) throw Error('LIVE_REPORT_PROJECTION_CHANGED');
    // #93 is authoritative for its projection. Keep all statuses, observations, watermarks and cost gaps verbatim.
    result.live = { ref: copy(input.liveReport), value: copy(value) };
    const row = result.metrics.find(r => r.id === 'cost'); row.evidence.push(copy(input.liveReport));
    row.value = { reportCost: copy(value.cost), paths: copy(value.paths), maintenance: { value: null, reason: '三条 A1 路径不证明独立维护用量或 A2 固定负载的费用；若无适用证据保持 unknown' }, currency: 'CNY', conversion: '无汇率换算；历史原币种另列' };
    row.status = candidate.synthetic ? 'SYNTHETIC_ONLY' : 'PARTIAL'; row.reason = '只引用 A1 三路径成本事实；不自动完成 A2 分项用量、负载与重复要求';
  }
  result.acceptance.candidateManifest = copy(input.candidateManifest);
  result.status = candidate.synthetic ? 'SYNTHETIC_ONLY' : 'INCOMPLETE';
  return result;
}
