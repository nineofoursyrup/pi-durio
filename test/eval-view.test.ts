import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence, digest } from '../src/evidence.js';
import { fixEvidence } from '../src/fixed-evidence.js';
import { appendFact, regularFiles } from '../src/eval/store.js';
import { representativeCases } from '../src/eval/fixtures.js';
import { loadEvalPlan, trialVersion, validatePlan, verifiedImage, type EvalPlan } from '../src/eval/plan.js';
import { BASELINE_ZERO, compareTrials, pairedTrials, type ComparisonPlan, type ComparisonTrial } from '../src/eval/comparison.js';
import { evalReport } from '../src/eval/runner.js';
import { listPlanSources, ownPlanSource, planState, readPlanReport } from '../src/eval/overview.js';
import { EvalListView, EvalPlanView, caseRows, formatDelta, planCells, verdict } from '../src/tui/eval.js';
import { SELF_REPORTED, TrialTraceView } from '../src/tui/eval-trial.js';
import { overrideColorTierForTest, COLOR_TIER } from '../src/tui/theme.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';
import { runCodingTask } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { readTrace } from '../src/trace.js';
import { ReadOnlyTui } from '../src/tui/app.js';

const fixtureData = fileURLToPath(new URL('../../test/fixtures/v1-records/data', import.meta.url));
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));
function withTier<T>(tier: typeof COLOR_TIER, body: () => T) { const previous = COLOR_TIER; overrideColorTierForTest(tier); try { return body(); } finally { overrideColorTierForTest(previous); } }
function assertGolden(grid: SnapshotGrid, name: string) {
  const rows = grid.rows.map((row, index) => {
    const runs: string[] = []; let start = 0;
    const style = (c: (typeof row)[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${snapshotText(grid)[index]}|\n   ${runs.join(' ; ')}`;
  });
  const text = `${grid.width}x${grid.height} ${grid.tier}\n${rows.join('\n')}\n`;
  const dir = join(process.cwd(), 'test', 'fixtures', 'snapshots'), path = join(dir, `${name}.txt`);
  if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); return; }
  assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}
const noHost = { openTrial() {} };

// ─── 合成计划（已知结果，不运行 VM） ─────────────────────────────────────────

type Outcome = { status: string; valid?: boolean; judgment?: 'PASS' | 'FAIL' | 'unknown'; requests?: number; artifacts?: { path: string; ref: any }[] } | null;
interface Spec { cases: Record<string, 'objective' | 'protection'>; reps: number; metric?: ComparisonPlan['objective']['metric']; delta?: number; scale?: 'relative'; outcome: (t: { caseId: string; side: string; repeat: number }) => Outcome; stopReason?: string | null; started?: boolean; single?: boolean }
async function planRoot(spec: Spec, root = mkdtempSync(join(tmpdir(), 'durio-2b-'))) {
  const id = 'plan-2b', e = new Evidence(root, id);
  const runtime = { id: 'fixed-runtime', manifest: e.blob('[]'), bytes: 2 };
  const caseIds = Object.keys(spec.cases);
  const comparison: ComparisonPlan | undefined = spec.single ? undefined : {
    kind: 'deterministic', repetitions: spec.reps, repetitionBasis: 'controlled known-result fixture', change: 'instructions', hypothesis: 'fewer requests',
    roles: spec.cases, objective: { metric: spec.metric ?? 'requests', direction: 'lower', delta: spec.delta ?? 0.1, basis: 'fixture threshold' },
    protections: [{ id: 'scope', kind: 'hard', check: 'scope', cases: caseIds }], trialBudget: { maxRequests: 4, maxTokens: 1000 },
    ...(spec.scale ? { scale: spec.scale } : {}),
    sides: { baseline: { runtime, instructions: 'A' }, candidate: { runtime, instructions: 'B' } },
  };
  const p: EvalPlan = { id, purpose: 'core-v1 fixture', mode: 'offline', model: { provider: 'deepseek', id: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' }, image: verifiedImage, runtime, cases: representativeCases.filter(c => caseIds.includes(c.id)), trials: [], comparison, budget: { maxRequests: 100, maxTokens: 64000, maxRequestTokens: 100, deadline: '2099-01-01T00:00:00.000Z', unknownUpperBound: null }, trialTimeoutMs: 1000, gradingTimeoutMs: 1000, maxOutputTokens: 32, requestRetryLimit: 0, price: { version: 'known-price-v1', source: 'synthetic', currency: 'USD', perMillionTokens: 1000 }, authorization: { scope: 'run-all-listed-trials', paid: false }, environment: { node: 'v24.8.0', isolation: 'synthetic', writable: 'fixed', cache: 'none' }, mainObjective: 'requests', protection: ['scope'], improvementConclusion: 'not-evaluated' };
  p.trials = (spec.single ? caseIds.flatMap(caseId => Array.from({ length: spec.reps }, (_, i) => ({ id: `${caseId}-${i + 1}`, caseId, side: 'candidate', repeat: i + 1, pair: null }))) : pairedTrials(id, caseIds, spec.reps)).map(t => ({ ...t, version: trialVersion(p, t.side) }));
  validatePlan(p);
  const source = appendFact(e, 'eval.plan', p); e.close();
  await fixEvidence(root, { id: `eval-plan:${id}`, sources: [source], purpose: 'synthetic 2b plan' });
  const facts = new Evidence(root, id);
  let last = source;
  if (spec.started !== false) {
    last = appendFact(facts, 'eval.started', { planId: id, directory: '/tmp/fixture', at: '2026-10-16T01:00:00.000Z' });
    for (const t of p.trials) {
      const o = spec.outcome(t);
      if (!o) continue;
      appendFact(facts, 'eval.trial-started', { trialId: t.id, at: '2026-10-16T01:00:01.000Z' });
      if (o.status === 'unknown') continue;
      const outcome = appendFact(facts, 'eval.outcome', { trialId: t.id, status: o.status, started: true, valid: o.valid ?? true, reason: null, artifacts: o.artifacts ?? [], isolation: null, timing: { preparationMs: 1200, taskMs: 3400, gradingMs: 0 } });
      if (o.judgment) appendFact(facts, 'eval.grade', { id: `g-${t.id}`, trialId: t.id, outcome, graderVersion: p.cases.find(c => c.id === t.caseId)!.grader.version, judgment: o.judgment, reason: 'synthetic', checks: [{ name: 'scope', passed: true }], at: '2026-10-16T01:00:02.000Z' });
      appendFact(facts, 'eval.timing', { trialId: t.id, gradingMs: 800 });
      for (let i = 0; i < (o.requests ?? (t.side === 'baseline' ? 2 : 1)); i++) {
        const rid = `${t.id}-${i}`;
        facts.append('budget.reserve', { id: rid, budgetId: id, operationId: t.id, purpose: 'eval-runtime', tokens: 100 });
        facts.append('provider.dispatch', { id: rid, operationId: t.id });
        facts.append('provider.bytes', { id: rid, bytes: facts.blob('data: {"model":"controlled-v1"}\n\n') });
        facts.append('budget.settle', { id: rid, budgetId: id, tokens: 10, status: 'returned' });
        appendFact(facts, 'eval.provider-link', { trialId: t.id, guestDispatchOrdinal: i + 1, hostDispatchId: rid });
      }
    }
    if (spec.stopReason !== undefined) last = appendFact(facts, 'eval.closed', { at: '2026-10-16T01:06:12.000Z', budget: {}, stopReason: spec.stopReason });
  }
  facts.close();
  await fixEvidence(root, { id: `eval-outcomes:${id}`, sources: [last], purpose: 'synthetic 2b outcomes' });
  return { root, id, plan: p };
}

// ─── oracle：d 与 δ（V8） ────────────────────────────────────────────────────

function comparisonTrial(caseId: string, side: 'baseline' | 'candidate', metrics: Partial<ComparisonTrial['metrics']>, judgment = 'PASS'): ComparisonTrial {
  const id = `${caseId}-1-${side}`;
  return { id, caseId, repeat: 1, side, pair: `${caseId}-1`, version: side, outcome: { source: `o-${id}`, valid: true, status: 'completed' }, grade: { judgment, graderVersion: 'v1', outcome: `o-${id}`, checks: [{ name: 'scope', passed: true }, { name: 'task', passed: judgment === 'PASS' }] }, metrics: { requests: 4, tokens: 40, cost: 1, taskMs: 100, ...metrics }, metricReasons: {} };
}

test('relative d: baseline denominator, baseline 0 is not comparable, task-pass stays a pass difference', () => {
  const plan: ComparisonPlan = { kind: 'deterministic', repetitions: 1, repetitionBasis: 'controlled', change: 'c', hypothesis: 'h', roles: { fix: 'objective' }, objective: { metric: 'requests', direction: 'lower', delta: 0.4, basis: 'b' }, protections: [{ id: 'scope', kind: 'hard', check: 'scope', cases: ['fix'] }], trialBudget: { maxRequests: 8, maxTokens: 800 }, scale: 'relative', sides: { baseline: { runtime: { id: 'a', manifest: { sha256: 'a', bytes: 1 }, bytes: 1 }, instructions: '' }, candidate: { runtime: { id: 'b', manifest: { sha256: 'b', bytes: 1 }, bytes: 1 }, instructions: '' } } };
  const run = (before: number, after: number) => compareTrials(plan, [comparisonTrial('fix', 'baseline', { requests: before }), comparisonTrial('fix', 'candidate', { requests: after })]);
  assert.equal(run(4, 2).pairs[0].delta, 0.5); assert.equal(run(4, 2).conclusion, '改善');
  assert.equal(run(4, 3).pairs[0].delta, 0.25); assert.equal(run(4, 3).conclusion, '无明显差异');
  const zero = run(0, 2);
  assert.equal(zero.pairs[0].delta, null); assert.equal(zero.pairs[0].exclusion, BASELINE_ZERO); assert.equal(zero.conclusion, '证据不足', 'a non-comparable pair does not enter the decision');
  // 软保护容忍度同口径：0.5 为 baseline 的一半。
  const soft = { ...plan, protections: [...plan.protections, { id: 'time', kind: 'soft' as const, metric: 'taskMs' as const, direction: 'lower' as const, tolerance: 0.5, basis: 'b', cases: ['fix'] }] };
  const slow = compareTrials(soft, [comparisonTrial('fix', 'baseline', { taskMs: 100 }), comparisonTrial('fix', 'candidate', { requests: 2, taskMs: 140 })]);
  assert.equal(slow.regression.pairs.find(p => p.requirement === 'time')!.delta, -0.4); assert.equal(slow.regression.pairs.find(p => p.requirement === 'time')!.regressed, false);
  const zeroSoft = compareTrials(soft, [comparisonTrial('fix', 'baseline', { taskMs: 0 }), comparisonTrial('fix', 'candidate', { requests: 2, taskMs: 140 })]);
  assert.equal(zeroSoft.regression.pairs.find(p => p.requirement === 'time')!.reason, BASELINE_ZERO);
  const pass = compareTrials({ ...plan, objective: { metric: 'task-pass', direction: 'higher', delta: 1, basis: 'b' } }, [comparisonTrial('fix', 'baseline', {}, 'FAIL'), comparisonTrial('fix', 'candidate', {})]);
  assert.equal(pass.pairs[0].delta, 1);
  assert.equal(formatDelta({ plan: { comparison: plan } as EvalPlan }, 'requests', 0.18), '+18%');
  assert.equal(formatDelta({ plan: { comparison: plan } as EvalPlan }, 'task-pass', 1), '+1');
});

test('first-version plan (#66 fixture) keeps the absolute δ with units', () => {
  const v1 = loadEvalPlan(fixtureData, 'fixture-eval-plan-1').comparison!;
  assert.equal(v1.scale, undefined, 'the v1 plan carries no relative scale');
  const asRequests: ComparisonPlan = { ...v1, repetitionBasis: 'deterministic fixture', objective: { ...v1.objective, metric: 'requests', direction: 'lower', delta: 1 }, protections: [{ id: 'scope', kind: 'hard', check: 'scope', cases: ['local-fix'] }] };
  const trials = [comparisonTrial('local-fix', 'baseline', { requests: 4 }), comparisonTrial('local-fix', 'candidate', { requests: 2 })];
  const absolute = compareTrials(asRequests, trials);
  assert.equal(absolute.pairs[0].delta, 2); assert.equal(absolute.conclusion, '改善');
  const relative = compareTrials({ ...asRequests, scale: 'relative' }, trials);
  assert.equal(relative.pairs[0].delta, 0.5); assert.equal(relative.conclusion, '无明显差异');
  const plan = { plan: { comparison: asRequests, price: { currency: 'USD' } } as EvalPlan };
  assert.equal(formatDelta(plan, 'requests', 2), '+2 请求'); assert.equal(formatDelta(plan, 'requests', 1, false), '1 请求');
  assert.equal(formatDelta(plan, 'cost', -0.02), '−$0.02'); assert.equal(formatDelta(plan, 'taskMs', 1200), '+1.2s');
  // 首版夹具本身：task-pass，δ = 1（通过差，无单位）。
  const report = evalReport(fixtureData, 'fixture-eval-plan-1');
  assert.equal(planCells(report).find(c => c.label === '门槛')!.value, '每配对 d ≥ δ = 1');
  assert.equal(planCells(report).find(c => c.label === '预算')!.value, '8 请求 · < $0.01');
});

test('new plans prepared by the host carry the relative scale', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/eval/plan.ts', import.meta.url)), 'utf8');
  assert.match(source, /scale:'relative' as const/);
});

// ─── 判定框与矩阵 ────────────────────────────────────────────────────────────

test('verdict reasons are composed from facts; glyphs carry validity and grading only', async () => {
  const { root, id } = await planRoot({
    cases: { 'local-fix': 'objective', 'no-change': 'protection' }, reps: 1, scale: 'relative', stopReason: 'actual_boundary_probe_failed',
    outcome: t => t.caseId === 'no-change' ? null : t.side === 'candidate' ? { status: 'invalid', valid: false } : { status: 'completed', judgment: 'PASS' },
  });
  const report = evalReport(root, id);
  assert.equal(planState(report), 'stopped');
  const v = verdict(report);
  assert.equal(v.conclusion, '证据不足');
  assert.deepEqual(v.reasons.slice(0, 3), ['计划未完成', '1 个 trial 无效', '保护案例未运行']);
  const rows = caseRows(report);
  assert.deepEqual(rows[0].trials.map(t => t.glyph), ['pass', 'invalid']);
  assert.deepEqual(rows[1].trials.map(t => t.glyph), ['not-run', 'not-run']);
  assert.match(rows[0].note, /B r1 无效/); assert.equal(rows[1].note, '未运行');
  assert.match(rows[1].category, /仅保护/);
  // 执行状态写在说明里：超时是 FAIL 字形 + “超时”，取消且无评分是 ? + “取消”。
  const timed = await planRoot({ cases: { 'local-fix': 'objective' }, reps: 2, scale: 'relative', stopReason: null, outcome: t => t.side === 'candidate' && t.repeat === 2 ? { status: 'cancelled', judgment: 'unknown' } : t.side === 'candidate' ? { status: 'timeout', judgment: 'FAIL' } : { status: 'completed', judgment: 'PASS' } });
  const row = caseRows(evalReport(timed.root, timed.id))[0];
  assert.deepEqual(row.trials.map(t => t.glyph), ['pass', 'pass', 'fail', 'unknown']);
  assert.match(row.note, /B r1 超时 · B r2 取消/);
  // 单侧计划：未设对照，不判改善。
  const single = await planRoot({ single: true, cases: { 'local-fix': 'objective' }, reps: 2, stopReason: null, outcome: () => ({ status: 'completed', judgment: 'PASS' }) });
  const s = evalReport(single.root, single.id);
  assert.equal(verdict(s).conclusion, '不判改善'); assert.equal(verdict(s).reasons[0], '未设对照，不判改善');
  assert.deepEqual(planCells(s).map(c => c.value).slice(0, 3), ['无对照', '无对照', '无对照']);
  // 改善：原因写出全部配对达到门槛。
  const good = await planRoot({ cases: { 'local-fix': 'objective' }, reps: 2, scale: 'relative', stopReason: null, outcome: () => ({ status: 'completed', judgment: 'PASS' }) });
  const g = verdict(evalReport(good.root, good.id));
  assert.equal(g.conclusion, '改善'); assert.match(g.reasons.join(' · '), /全部 2 个主目标配对 d ≥ δ/);
  assert.equal(caseRows(evalReport(good.root, good.id))[0].note, '2/2 配对 ≥ δ');
});

let golden: ReturnType<typeof planRoot> | undefined;
function goldenPlan() {
  return golden ??= planRoot({
    cases: { 'local-fix': 'objective', 'multi-file': 'objective', 'no-change': 'protection' }, reps: 2, scale: 'relative', stopReason: 'actual_boundary_probe_failed',
    outcome: t => {
      if (t.caseId === 'no-change') return t.repeat === 1 ? { status: 'completed', judgment: 'PASS' } : t.repeat === 2 && t.side === 'candidate' ? { status: 'invalid', valid: false } : t.repeat === 2 ? { status: 'completed', judgment: 'PASS' } : null;
      if (t.caseId === 'multi-file' && t.side === 'candidate' && t.repeat === 2) return { status: 'cancelled', judgment: 'unknown' };
      return { status: 'completed', judgment: 'PASS' };
    },
  });
}

test('2b plan layer golden at 132x38', async () => {
  const { root, id } = await goldenPlan();
  const before = readFileSync(join(root, 'host.sqlite'));
  const view = new EvalPlanView(ownPlanSource(root, id), noHost);
  const lines = withTier('truecolor', () => view.render(132, 38, 'truecolor'));
  assert.equal(lines.length, 38);
  const text = plain(lines).join('\n');
  for (const part of ['◆ eval', '离线受控 · 不判模型质量', '按案例 2 个版本', '每配对 d ≥ δ = 10%', '硬约束 1 · 软约束 0 · 3 案例', 'd 请求数', '+50%', '2/2 配对 ≥ δ', 'B r2 取消', 'B r2 无效', '两侧计数', '通过率 = 通过/可评分', '含两侧、失败与压缩', '当前判定', '证据不足', '◇ 已停止于 trial', '不续跑', 'eval 费用单列，不计入 /stats'])
    assert.ok(text.includes(part), `missing ${part}\n${text}`);
  assertGolden(captureSnapshot(lines, 132, 38, 'truecolor'), '2b-132x38');
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), before, 'viewing is read-only');
});

test('narrow terminals: every trial stays selectable and opens with Enter; nothing overflows', async () => {
  const { root, id, plan } = await goldenPlan();
  for (const [w, h] of [[99, 38], [80, 24], [56, 30], [40, 12]] as const) {
    const opened = new Set<string>();
    const view = new EvalPlanView(ownPlanSource(root, id), { openTrial: (_s, _r, trialId) => opened.add(trialId) });
    withTier('none', () => {
      for (let ci = 0; ci < plan.cases.length; ci++) {
        for (let ti = 0; ti < 4; ti++) {
          const lines = view.render(w, h, 'none');
          assert.equal(lines.length, h, `${w}x${h} height`);
          for (const l of lines) assert.ok(visibleWidth(l) <= w, `${w}x${h} overflow: ${stripTerminalSequences(l)}`);
          view.handleInput('\r'); view.handleInput('\x1b[C');
        }
        for (let ti = 0; ti < 4; ti++) view.handleInput('\x1b[D');
        view.handleInput('\x1b[B');
      }
    });
    assert.deepEqual([...opened].sort(), plan.trials.map(t => t.id).sort(), `${w}x${h}: every trial opened`);
  }
  // 小于 100：四格 2×2、说明列移到底栏上方的摘要行；小于 60：字形之间不加空格。
  const view = new EvalPlanView(ownPlanSource(root, id), noHost);
  const medium = plain(withTier('none', () => view.render(80, 38, 'none'))).join('\n');
  assert.match(medium, /主目标 {2}请求数 ↓/); assert.doesNotMatch(medium, /类型/); assert.match(medium, /local-fix · A r1 ✓ · 2\/2 配对 ≥ δ/);
  const narrow = plain(withTier('none', () => view.render(50, 38, 'none'))).join('\n');
  assert.match(narrow, /A ✓✓ +B ✓✓/);
});

test('v1 fixture: list and plan layers read the first-version plan without writes', () => {
  const before = readFileSync(join(fixtureData, 'host.sqlite'));
  const sources = listPlanSources(fixtureData);
  assert.equal(sources.length, 1);
  let opened: string | undefined;
  const list = new EvalListView(fixtureData, { openPlan: s => { opened = s.id; } });
  const text = plain(withTier('none', () => list.render(132, 38, 'none'))).join('\n');
  assert.match(text, new RegExp(`› ${sources[0].label} · v1 fixture eval plan.* · 运行中 · 证据不足`));
  list.handleInput('\r'); assert.equal(opened, 'fixture-eval-plan-1');
  const plan = plain(withTier('none', () => new EvalPlanView(sources[0], noHost).render(132, 38, 'none'))).join('\n');
  assert.match(plan, /未结束 · 不在本 TUI 运行/); assert.match(plan, /A r1 未取得结果/); assert.match(plan, /A \? +B ·/);
  assert.match(plan, /每配对 d ≥ δ = 1/); assert.match(plan, /≈ \$|< \$/);
  assert.deepEqual(readFileSync(join(fixtureData, 'host.sqlite')), before);
  const empty = plain(new EvalListView(mkdtempSync(join(tmpdir(), 'durio-2b-empty-')), { openPlan() {} }).render(100, 10)).join('\n');
  assert.match(empty, /还没有 eval 计划 · 新建用 pi-durio eval plan，或 improve 的 fresh 对照/);
});

// ─── trial trace（V7） ───────────────────────────────────────────────────────

test('trial trace: restricted-side raw beside host-mediated usage; fallback lists host records only', async () => {
  // 受限侧：一次离线 coding 任务写出的数据根，按导出格式（data/…）保留为 trial 产物。
  const base = mkdtempSync(join(tmpdir(), 'durio-2b-trial-')), workspace = join(base, 'project'), guest = join(base, 'guest-data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'Trial fixture\n');
  const transport = scriptedTransport([{ name: 'read', args: { path: 'README.md' } }]);
  const run = await runCodingTask({ dataRoot: guest, workspace, input: 'read once', mode: 'offline', transport: transport.fetch });
  const restricted = readTrace(guest, run.runId).spans.filter(s => s.kind === 'llm').map(s => s.llm!.tokens);
  assert.equal(restricted.length, 2);
  const evalRoot = join(base, 'eval');
  // 产物按内容寻址放进 eval 数据根的 objects（与 captureFiles 相同的引用，省去逐个 fsync）。
  mkdirSync(join(evalRoot, 'objects'), { recursive: true });
  const captured = regularFiles(guest).map(path => { const bytes = readFileSync(join(guest, path)), sha256 = digest(bytes); writeFileSync(join(evalRoot, 'objects', sha256), bytes); return { path: `data/${path}`, ref: { sha256, bytes: bytes.length } }; });
  const { root, id } = await planRoot({ cases: { 'local-fix': 'objective' }, reps: 1, scale: 'relative', stopReason: null, outcome: t => t.side === 'baseline' ? { status: 'completed', judgment: 'PASS', requests: 2, artifacts: captured } : { status: 'completed', judgment: 'PASS', requests: 2 } }, evalRoot);
  const source = ownPlanSource(root, id), { report } = readPlanReport(source);
  const baseline = report.trials.find(t => t.side === 'baseline')!.id;
  const before = regularFiles(root).map(path => [path, digest(readFileSync(join(root, path)))]);
  const beforeGuest = regularFiles(guest).map(path => [path, digest(readFileSync(join(guest, path)))]);
  const providerCalls = transport.calls.length, copied: string[] = [];
  const view = new TrialTraceView(source, report, baseline, undefined, async text => { copied.push(text); return true; });
  await view.opened;
  assert.deepEqual(view.timing, { preparationMs: 1200, taskMs: 3400, gradingMs: 800 });
  const text = plain(withTier('none', () => view.render(160, 38, 'Esc 返回上层'))).join('\n');
  assert.match(text, new RegExp(SELF_REPORTED));
  assert.match(text, /宿主计时 {2}准备 1\.2s · 任务 3\.4s · 评分 0\.80s · 宿主中介 2 次请求 · 20 tok/);
  // 宿主每次 10 tok；受限侧自报不同时两者并列并标明。
  if (restricted.some(t => t !== 10)) assert.match(text, /不一致 · #1 宿主 10 \/ 受限侧自报 \S+ tok/);
  assert.match(text, /run r-/);
  assert.match(text, /llm/);
  for (let i = 0; i < 10 && view.selectedSpan?.kind !== 'tool'; i++) view.handleInput('\x1b[B');
  assert.equal(view.selectedSpan?.tool?.name, 'read');
  const selected = view.selectedSpan!.key;
  view.handleInput('p');
  assert.match(plain(view.render(160, 38, 'Esc 返回上层')).join('\n'), /只读查看 · trial 原文副本不能固定为证据/);
  view.handleInput('\r');
  assert.match(plain(view.render(160, 38, 'Esc 返回上层')).join('\n'), /◆ trace 原文/);
  view.handleInput('\t'); view.handleInput('y');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(copied[0], /Trial fixture/, 'raw bytes come from the restricted copy, whose record ids do not exist in the host eval root');
  for (const [width, height] of [[132, 38], [80, 24], [40, 12]]) {
    const lines = view.render(width, height, 'Esc 返回上层');
    assert.equal(lines.length, height);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.match(plain(lines).at(-1)!, /Esc 返回上层/);
  }
  view.handleInput('\x1b');
  assert.doesNotMatch(plain(view.render(160, 38, 'Esc 返回上层')).join('\n'), /◆ trace 原文/);
  assert.equal(view.selectedSpan?.key, selected, 'Esc returns to the same span without closing the copy');
  view.close();

  // The app must give Esc to the nested raw layer before popping the trial view.
  class TestTerminal implements Terminal {
    columns = 160; rows = 40; kittyProtocolActive = false; input: (s: string) => void = () => {};
    start(input: (s: string) => void) { this.input = input; }
    stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
    clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  }
  const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace, dataRoot: root, draftRoot: join(base, 'drafts'), mode: 'offline', show: { run: run.runId }, terminal, widthCalibration: false,
    transport: async () => { throw Error('viewing trial originals cannot call a provider'); }, copy: async text => { copied.push(text); return true; } });
  const screen = () => plain(app.screen()).join('\n'), key = (data: string) => terminal.input(data);
  try {
    app.start(); key(`/eval ${source.label}`); key('\r'); key('\r');
    for (let i = 0; i < 200 && !/run r-/.test(screen()); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(screen(), /◆ trial/);
    assert.match(screen(), /run r-/);
    for (let i = 0; i < 10 && !/tool · read/.test(screen()); i++) key('\x1b[B');
    assert.match(screen(), /tool · read/);
    key('p'); assert.match(screen(), /trial 原文副本不能固定为证据/);
    key('\r'); assert.match(screen(), /◆ trace 原文/);
    key('\t'); key('y'); await new Promise(resolve => setImmediate(resolve));
    assert.match(copied.at(-1)!, /Trial fixture/);
    key('\x1b'); assert.match(screen(), /◆ trial/); assert.doesNotMatch(screen(), /◆ trace 原文/);
    key('\x1b'); assert.doesNotMatch(screen(), /◆ trial/);
  } finally { await app.exit(); }
  assert.equal(transport.calls.length, providerCalls);
  assert.deepEqual(regularFiles(root).map(path => [path, digest(readFileSync(join(root, path)))]), before);
  assert.deepEqual(regularFiles(guest).map(path => [path, digest(readFileSync(join(guest, path)))]), beforeGuest);

  const missing = new TrialTraceView(source, report, report.trials.find(t => t.side === 'candidate')!.id);
  await missing.opened;
  const fallback = plain(withTier('none', () => missing.render(120, 30, 'Esc 返回上层'))).join('\n');
  assert.match(fallback, /✗ 未导出受限侧记录 · RESTRICTED_RAW_MISSING/);
  assert.match(fallback, /只列宿主记录/); assert.match(fallback, /#1 · 已派发 · 10 tok/); assert.match(fallback, /#2 · 已派发 · 10 tok/);
  missing.close();
});
