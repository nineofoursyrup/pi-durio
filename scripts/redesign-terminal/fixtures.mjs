/** Small, explicit synthetic display inputs. Never calls a provider, tool, VM or measurement API. */
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const at = '2026-10-17T02:00:00.000Z';
export const load = (root, path) => import(pathToFileURL(join(root, path)).href);
export const totals = (amount, unknownRequests = 0) => ({ amounts: amount === null ? {} : { CNY: amount }, unknownRequests, partial: unknownRequests > 0 });
/** The six independent worked examples from stats-view.test.ts, combined by the product renderer. */
export function statsFigures(state = 'six-oracles') {
  const result = {
    acceptance: { N: 10, B: 8, C: 6, G: 5, S: 4 }, cost: totals(80),
    clocks: { execution: { mean: 720000, valid: 6, total: 10 }, acceptance: { mean: 86400000, valid: 5, total: 10 }, segments: [{ kind: 'queue', meanMs: 120000 }, { kind: 'user-wait', meanMs: 180000 }, { kind: 'active', meanMs: 420000 }] },
    intervention: { Ni: 8, I: 2, Z: 3, U: 3, openPositive: 0 },
    regression: [{ label: 'ep-c03e', at, P: 4, V: 3, R: 1 }],
    rework: { Nr: 3, Rr: 1, Zr: 1, Ur: 1, immaturePositive: 1 }, faults: { B: 8, F: 2, Zf: 5, Uf: 1 },
    spend: { rows: ['coding', 'eval', 'improve', 'maintenance', 'unassigned'].map((kind, i) => ({ kind, totals: totals([80, 20, 10, 5, 3][i]), tokens: [412000, 96000, 51000, 24000, 14000][i] })), total: { totals: totals(118), tokens: 597000 } },
  };
  if (state === 'zero') { result.acceptance = { N: 0, B: 0, C: 0, G: 0, S: 0 }; result.cost = totals(null); result.intervention = { Ni: 0, I: 0, Z: 0, U: 0, openPositive: 0 }; result.regression = []; result.rework = { Nr: 0, Rr: 0, Zr: 0, Ur: 0, immaturePositive: 0 }; result.faults = { B: 0, F: 0, Zf: 0, Uf: 0 }; result.clocks.execution = { mean: null, valid: 0, total: 0 }; result.clocks.acceptance = { mean: null, valid: 0, total: 0 }; result.clocks.segments = []; result.spend = { rows: [], total: { totals: totals(0), tokens: 0 } }; }
  if (state === 'unknown') { result.cost = totals(null, 2); result.intervention = { Ni: 8, I: 0, Z: 0, U: 8, openPositive: 0 }; result.spend.total.totals = totals(118, 2); }
  return result;
}
const value = (data, source = 'process', samples = null) => ({ value: data, source, samples, basis: 'SYNTHETIC layout fixture; not a measurement' });
export function selfFixture() {
  return { schema: 'pi-durio-self-v1', at,
    environment: { build: 'a'.repeat(64), chip: 'Synthetic CPU', system: 'synthetic', node: 'synthetic', terminal: 'Synthetic layout', terminalVersion: null, columns: 132, rows: 38, dataRoot: '/synthetic/data', uptimeMs: 240000 },
    code: { product: value({ files: 12, lines: 600, groups: [{ directory: 'src/tui/', files: 5, lines: 300 }, { directory: 'src/', files: 4, lines: 150 }, { directory: 'src/eval/', files: 2, lines: 100 }] }, 'build-manifest'), scripts: value({ files: 3, lines: 100 }, 'build-manifest'), patch: value({ files: 1, lines: 53 }, 'build-manifest'), tests: value({ files: 10, lines: 200 }, 'build-manifest'), dependencies: value({ count: 5, exact: true }, 'build-manifest') },
    installation: value(10485760, 'records'), firstFrame: value(null, 'process', 0), keys: value({ samples: 0, p50: null, p95: null }, 'process', 0), memory: value({ bytes: 10485760, state: '空闲' }), peak: value({ bytes: 20971520, tasks: 2, toolOutputBytes: 1024 }),
    query: value({ ms: 3, runs: 2, more: false, coverage: { missing: 0, snapshot: 1, current: 1, stale: false, scanned: 2, index: 'synthetic', emptyMeans: 'synthetic' } }, 'records', 1),
    cost: value({ scope: { from: '2026-10-11T16:00:00.000Z', to: '2026-10-18T16:00:00.000Z', asOf: at, source: 'ordinary', through: 1 }, spend: statsFigures().spend, gaps: [] }, 'records', 1), facts: value(null, 'records'), notMeasured: ['分发体积', '冷启动 p50/p95', '受控空闲 / 长会话 RSS', '输出取得写入耗时 / 大输出'].map(name => ({ name, value: null, samples: 0, source: 'external', reason: 'PREP: NOT_RUN', status: '产品内不测 · 见 A2 报告' })) };
}

export async function createFixtures(packageRoot, directory) {
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'project'));
  const workspace = realpathSync(join(directory, 'project')), dataRoot = join(directory, 'data');
  writeFileSync(join(workspace, 'math.mjs'), 'export const add=(a,b)=>a-b;\n', { flag: 'wx' });
  const { Evidence, digest } = await load(packageRoot, 'dist/src/evidence.js');
  const { appendFact } = await load(packageRoot, 'dist/src/eval/store.js');
  const { representativeCases } = await load(packageRoot, 'dist/src/eval/fixtures.js');
  const { verifiedImage, trialVersion } = await load(packageRoot, 'dist/src/eval/plan.js');
  const { pairedTrials } = await load(packageRoot, 'dist/src/eval/comparison.js');
  // These are display facts, not acquired host observations. Write a fresh fixture
  // with fixed synthetic clocks; Evidence.append deliberately stamps real clocks.
  let syntheticTick = 0;
  const displayEvidence = id => {
    const evidence = new Evidence(dataRoot, id);
    evidence.append = (kind, data) => {
      const body = /^(task\.accepted|run\.|model\.|tool\.)/.test(kind) ? { ...data, clock: { processId: 'synthetic-display-clock', monotonicMs: ++syntheticTick * 1000, wallTime: at } } : data;
      const ref = evidence.blob(JSON.stringify(body));
      return Number(evidence.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(id, kind, at, JSON.stringify(ref)).lastInsertRowid);
    };
    return evidence;
  };
  const runId = '11111111-2222-4333-8444-555555555555', sessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const e = displayEvidence(runId);
  e.append('task.accepted', { taskId: 'synthetic-task', sessionId, workspace, input: '修复加法（合成显示输入）', authorization: { tools: ['read'] } });
  e.append('run.started', {}); e.append('context.snapshot', { messages: e.blob('[]') });
  e.append('model.intent', { attemptId: 'model-1', durableTaskId: 1, purpose: 'generation' });
  e.append('model.response', { attemptId: 'model-1', purpose: 'generation', message: { content: [{ type: 'text', text: '检查已保留的合成事实。' }] }, completeness: 'complete' });
  e.append('tool.intent', { attemptId: 'read-1', durableTaskId: 2, tool: 'read', args: { path: 'math.mjs' } });
  e.append('tool.result', { attemptId: 'read-1', durableTaskId: 2, result: { content: [{ type: 'text', text: 'export const add=(a,b)=>a-b;\n' }] } });
  e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close();
  const analysis = displayEvidence('synthetic-analysis'), target = { workspace, sessionId, taskId: 'synthetic-task', runId };
  const original = analysis.blob('export const add=(a,b)=>a-b;\n');
  const sources = { targets: [{ id: 'project', kind: 'project', workspace: '/synthetic/shop-api', files: [{ path: 'math.mjs', ...original, content: original, sourceId: `synthetic:${original.sha256}`, state: 'available', reason: [] }], baseline: 'b'.repeat(64), applicableVersion: 'synthetic-version', state: 'verified', gaps: [] }] };
  const candidate = { id: 'candidate:one', display: 'R1', revision: 'candidate-rev-1', title: '修复加法', problem: '加法用了减法', objective: 'bug', target: sources.targets[0], facts: [{ claim: '2 + 3 返回 -1（合成事实）', evidence: [sources.targets[0].files[0].sourceId] }], hypotheses: ['运算符误写'], successCounterexamples: [], gaps: ['仅为显示 fixture'], mechanismsReviewed: ['math.mjs'], steps: ['把减法改为加法'], scope: ['math.mjs'], validation: { method: 'regression', checks: ['正负数加法'], budget: '一次检查', protections: ['其他文件不变'] }, risks: ['合成样例'], rollback: '恢复保留的原文件', activation: { writeback: true, enable: false, conditions: ['回归通过'], timing: '后续任务读取新文件' }, dependencies: [], conflicts: [], replacements: [{ path: 'math.mjs', content: 'export const add=(a,b)=>a+b;\n' }], structuredChecks: [{ kind: 'regression', program: 'console.log("synthetic; never executed by PREP")', timeoutMs: 30000 }], execution: 'not-started', effect: 'unverified', selection: 'unselected', suggestionOnly: false };
  const report = { id: 'synthetic-report', revision: 'report-rev-1', kind: 'improve', runId: analysis.runId, target, request: { id: 'synthetic-report', purpose: '显示准备', limits: { maxRequests: 16, maxTokens: 2162688, maxRequestTokens: 1081344, maxDurationMs: 600000, maxOutputTokens: 32768 } }, state: 'complete', startedAt: at, cutoff: 0, deadline: '2099-01-01T00:00:00.000Z', summary: '合成候选，不代表执行或验证', candidates: [candidate], selected: [], gaps: [], evidence: [], targets: sources.targets, queryBounds: { maxRuns: 1, maxRecords: 40, maxEvidenceBytes: 32768, maxSourceBytes: 32768 }, budget: { requests: 0, knownTokens: 0, reservedTokens: 0, unknown: 0, violation: false }, reason: null };
  analysis.append('improve.started', { request: { id: report.id }, target }); analysis.append('improve.report', report); analysis.close();
  const pe = displayEvidence('synthetic-plan'), runtime = { id: 'synthetic-runtime', manifest: pe.blob('[]'), bytes: 2 };
  const comparison = { kind: 'deterministic', repetitions: 1, repetitionBasis: 'synthetic display oracle', change: 'instructions', hypothesis: 'fewer requests', roles: { 'local-fix': 'objective', 'no-change': 'protection' }, objective: { metric: 'requests', direction: 'lower', delta: 0.1, basis: 'synthetic', }, protections: [{ id: 'scope', kind: 'hard', check: 'scope', cases: ['local-fix', 'no-change'] }], trialBudget: { maxRequests: 4, maxTokens: 1000 }, scale: 'relative', sides: { baseline: { runtime, instructions: 'A' }, candidate: { runtime, instructions: 'B' } } };
  const plan = { id: 'synthetic-plan', purpose: '合成显示计划 · 不执行', mode: 'offline', model: { provider: 'deepseek', id: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' }, image: verifiedImage, runtime, cases: representativeCases.filter(c => ['local-fix', 'no-change'].includes(c.id)), trials: [], comparison, budget: { maxRequests: 100, maxTokens: 64000, maxRequestTokens: 100, deadline: '2099-01-01T00:00:00.000Z', unknownUpperBound: null }, trialTimeoutMs: 1000, gradingTimeoutMs: 1000, maxOutputTokens: 32, requestRetryLimit: 0, price: { version: 'synthetic-only', source: 'synthetic', currency: 'CNY', perMillionTokens: 1 }, authorization: { scope: 'run-all-listed-trials', paid: false }, environment: { node: 'synthetic', isolation: 'synthetic', writable: 'fixed', cache: 'none' }, mainObjective: 'requests', protection: ['scope'], improvementConclusion: 'not-evaluated' };
  plan.trials = pairedTrials(plan.id, ['local-fix', 'no-change'], 1).map(t => ({ ...t, version: trialVersion(plan, t.side) }));
  appendFact(pe, 'eval.plan', plan); appendFact(pe, 'eval.started', { planId: plan.id, at, directory: '/synthetic' });
  const trial = plan.trials[0]; appendFact(pe, 'eval.trial-started', { trialId: trial.id, at });
  const outcome = appendFact(pe, 'eval.outcome', { trialId: trial.id, status: 'completed', started: true, valid: true, reason: null, artifacts: [], isolation: null, timing: { preparationMs: 1, taskMs: 2, gradingMs: 0 } });
  appendFact(pe, 'eval.grade', { id: 'synthetic-grade', trialId: trial.id, outcome, graderVersion: plan.cases.find(c => c.id === trial.caseId).grader.version, judgment: 'PASS', reason: 'synthetic oracle; not executed', checks: [], at });
  appendFact(pe, 'eval.closed', { at, budget: {}, stopReason: 'synthetic-display-stop' }); pe.close();
  return { workspace, dataRoot, runId, sessionId, report, plan, digest };
}

export async function renderers(packageRoot, fixture) {
  const theme = await load(packageRoot, 'dist/src/tui/theme.js');
  const frame = await load(packageRoot, 'dist/src/tui/view-stack.js');
  const welcome = await load(packageRoot, 'dist/src/tui/welcome.js');
  const session = await load(packageRoot, 'dist/src/tui/session-screen.js');
  const { HardwareCursorEditor } = await load(packageRoot, 'dist/src/tui/cursor.js');
  const pi = await load(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js');
  const { RecoveryPanel, disabledInputLines } = await load(packageRoot, 'dist/src/tui/recovery.js');
  const { ImproveSelectionView } = await load(packageRoot, 'dist/src/tui/improve-selection.js');
  const { StatsView } = await load(packageRoot, 'dist/src/tui/stats.js');
  const { SelfView } = await load(packageRoot, 'dist/src/tui/self.js');
  const { TraceView } = await load(packageRoot, 'dist/src/tui/trace.js');
  const { EvalPlanView } = await load(packageRoot, 'dist/src/tui/eval.js');
  const { ownPlanSource } = await load(packageRoot, 'dist/src/eval/overview.js');
  const { exitSummary } = await load(packageRoot, 'dist/src/tui/exit-summary.js');
  const fakeTerminal = { columns: 132, rows: 38, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const tui = new pi.TuiAltScreen(fakeTerminal), editor = new HardwareCursorEditor(tui, { borderColor: theme.makeBorderColor('border.input'), selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s } });
  editor.placeholder = () => '描述要完成的修改…   / 命令  @ 文件  Shift+Enter 换行';
  const welcomeFacts = { version: '0.1.0', build: 'synthetic', workspace: '/synthetic/shop-api', lock: { state: 'free' }, model: { id: 'deepseek-flash', api: 'openai-completions', host: 'api.deepseek.com' }, execution: '合成显示输入 · 不代表验收', dataRoot: '/synthetic/data', sessions: [{ label: 's-6666', improve: false, input: '修复购物车舍入', status: 'completed', at }], tip: welcome.TIPS[0] };
  const recovery = new RecoveryPanel({ runId: 'r-1111', snapshotId: 'synthetic', status: 'blocked', options: ['inspect', 'continue', 'end'], work: { title: '迁移（合成未知）', task: 1, round: 3 }, items: [{ taskId: 1, tool: 'bash', target: 'npm run migrate', dispatched: true }], prior: [], checks: [{ ok: true, text: '合成宿主检查' }], frozen: { count: 2, first: { kind: 'follow-up', text: '检查剩余项' } }, otherSessions: [], unknownModelAttempts: 0 });
  const refusal = () => { throw Error('DISPLAY_FIXTURE_CANNOT_EXECUTE'); };
  const selection = new ImproveSelectionView(fixture.dataRoot, fixture.report.id, refusal, () => {}, { now: () => Date.parse(at), submitBlocked: () => 'PREP fixture 不执行' });
  const trace = new TraceView(fixture.dataRoot, fixture.runId), evaluation = new EvalPlanView(ownPlanSource(fixture.dataRoot, fixture.plan.id), { openTrial() {} }, { now: () => Date.parse(at) });
  const request = { scope: { from: '2026-09-17T16:00:00.000Z', to: '2026-10-17T16:00:00.000Z', asOf: at, source: 'ordinary', project: '/synthetic/shop-api' }, command: '/stats' };
  const samples = { snapshot: () => ({ firstFrameMs: null, keys: { samples: 0, p50: null, p95: null } }) };
  const self = new SelfView(fixture.dataRoot, { changed() {}, feedback() {}, export() {} }, { read: () => selfFixture(), storage: async () => value({ total: 10240, tasks: 2, perTask: 5120, originals: 2048, breakdown: { host: 8192, sessions: 2048, attachments: 0, incomplete: 0, other: 0, total: 10240 } }, 'records'), samples, now: () => new Date(at) });
  await self.ready;
  const empty = (width, tier) => theme.styledLine([], width, undefined, tier);
  const pad = (lines, width, height, tier) => { if (lines.length > height) throw Error('FIXTURE_FRAME_OVERFLOW'); return [...lines, ...Array.from({ length: height - lines.length }, () => empty(width, tier))]; };
  async function render(id, width, height, tier = 'truecolor', state = 'six-oracles') {
    theme.overrideColorTierForTest(tier);
    if (id === '1a') return [...welcome.renderWelcome(welcomeFacts, width, height - 5, new Date(at), tier).lines, ...editor.render(width), welcome.welcomeStatus('deepseek-flash', 'ctx ≈863 / 1M', width, tier), frame.hintLine(['Enter 提交', '/ 命令', 'Ctrl+R 历史', '? 帮助'], width, { keepLast: '? 帮助', tier })];
    if (id === '1b') {
      const header = { workspace: '/synthetic/shop-api', readOnly: false, session: 's-6666', run: 'r-1111', task: 1, round: 3 }, status = session.statusParts({ phase: 'running', recovery: false, round: 3, retry: false, elapsedMs: 42000, frame: 0 }), narrow = session.narrowing(width, header, status);
      const tool = session.toolLines({ kind: 'tool', tool: 'bash', args: 'npm test', argKind: 'command', state: 'error', startedAt: at, summary: 'exit 1 · 20 行', output: { lines: ['FAIL expected 80.00 received 80.01'], total: 20, end: 'tail' } }, width, false, Date.parse(at), 0, tier);
      const body = [...session.userLines('修复购物车舍入（合成显示）', width, false, tier), ...session.assistantLines('改为以分为单位，检查仍有一项失败。', width, tier), tool.row, ...tool.body, ...(tool.paging ? [tool.paging] : [])];
      return [session.headerLine(header, width, narrow.headerRight, tier), ...pad(body.slice(0, height - 7), width, height - 7, tier), session.statusLine(status, width, narrow.statusHint, tier), ...editor.render(width), session.usageLine('deepseek-flash', 'ctx ≈863 / 1M', '本任务', 1800, '≈¥0.01', width, tier), frame.hintLine(['Enter steer', 'Ctrl+X Enter follow-up', 'Ctrl+C 中止', 'Ctrl+O 展开'], width, { tier })];
    }
    if (id === '1c') {
      // Current ReadOnlyTui.recoveryPlan: preserve header/status, then collapse
      // transcript, disabled editor, usage, hints in that order. No missing chrome is padded away.
      const available = height - 2, full = recovery.fullHeight(width);
      const input = available >= full + 5, usage = available >= full + 2, hints = available >= full + 1;
      const panelHeight = hints ? full : available;
      const header = { workspace: '/synthetic/shop-api', readOnly: false, session: 's-6666', run: 'r-1111', task: 1, round: 3 };
      const status = session.statusParts({ phase: 'idle', recovery: true, round: 3, retry: false, elapsedMs: 42000, frame: 0 }), narrow = session.narrowing(width, header, status);
      const tail = [...recovery.render(width, panelHeight, tier), session.statusLine(status, width, narrow.statusHint, tier), ...(input ? disabledInputLines('', width, tier) : []), ...(usage ? [session.usageLine('deepseek-flash', 'ctx ≈863 / 1M', '本任务', 1800, '≈¥0.01', width, tier)] : []), ...(hints ? [frame.hintLine(['Ctrl+R 历史', 'Ctrl+T trace', '? 帮助'], width, { tier })] : [])];
      return [session.headerLine(header, width, narrow.headerRight, tier), ...pad([], width, height - 1 - tail.length, tier), ...tail];
    }
    if (id === '1f') { const lines = await exitSummary(fixture.dataRoot, { workspace: fixture.workspace, runId: fixture.runId, elapsedMs: 848000, draftLines: 0, terminalRestored: true }, width); return [...lines, ...Array(height - lines.length).fill('')]; }
    if (['1d', '1e', '2a', '2b', '2c'].includes(id)) {
      // Use the public TuiAltScreen compositor with the exact openPanel geometry
      // from this candidate. A component's short body is not a full-screen golden.
      const base = await render('1b', width, height, tier), terminal = { ...fakeTerminal, columns: width, rows: height };
      const host = new pi.TuiAltScreen(terminal, true);
      host.setLayoutRoot({ invalidate() {}, render: () => base });
      const component = { invalidate() {}, render: w => {
        const h = Math.max(2, Math.floor(height * 0.9) - 2);
        if (id === '1d') return selection.render(w, h);
        if (id === '1e') { const figures = statsFigures(state); return new StatsView(request, () => ({ scope: request.scope, sample: { N: figures.acceptance.N, excluded: 3 }, versions: { ids: ['synthetic'], unknown: 0 }, figures })).render(w, h, tier); }
        if (id === '2c') return self.render(w, h, tier);
        const overlayHeight = Math.max(3, Math.floor(height * 0.9) - 1);
        return id === '2a' ? trace.render(w, overlayHeight, 'Esc 返回会话') : evaluation.render(w, overlayHeight, tier);
      } };
      host.showOverlay(component, { width: '96%', maxHeight: '90%', anchor: 'center' });
      try { host.start(); host.renderNow(true); return host.getScreenLines(); } finally { host.stop(); }
    }
    throw Error(`UNKNOWN_SCREEN:${id}`);
  }
  return { pi, theme, render, close() { self.cancel(); } };
}
