import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StdinBuffer, TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence, readObject } from '../src/evidence.js';
import { fixEvidence } from '../src/fixed-evidence.js';
import { appendFact, evalFacts } from '../src/eval/store.js';
import { representativeCases } from '../src/eval/fixtures.js';
import { trialVersion, validatePlan, verifiedImage, type EvalPlan } from '../src/eval/plan.js';
import { evalReport, formatEvalReport, regradeEval } from '../src/eval/runner.js';
import { ownPlanSource } from '../src/eval/overview.js';
import { EvalPlanView, trialGlyph, trialNote } from '../src/tui/eval.js';
import { fullScreenHeight, showFullScreen } from '../src/tui/fullscreen.js';
import { TerminalWidthGate } from '../src/tui/width-gate.js';
import { acquireOwner, hasOwnerMarker } from '../src/ownership.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durio-eval-pending-')), id = 'pending', evidence = new Evidence(root, id);
  const plan: EvalPlan = { id, purpose: '分阶段结果', mode: 'offline', model: { provider: 'deepseek', id: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' }, image: verifiedImage,
    runtime: { id: 'fixed-runtime', manifest: evidence.blob('[]'), bytes: 2 }, cases: representativeCases.filter(c => c.id === 'no-change'), trials: [],
    budget: { maxRequests: 4, maxTokens: 4000, maxRequestTokens: 1000, deadline: '2099-01-01T00:00:00Z', unknownUpperBound: null }, trialTimeoutMs: 1000, gradingTimeoutMs: 1000, maxOutputTokens: 32, requestRetryLimit: 0,
    price: { version: 'synthetic', source: 'synthetic', currency: 'CNY', perMillionTokens: 10 }, authorization: { scope: 'run-all-listed-trials', paid: false },
    environment: { node: process.version, isolation: 'synthetic facts only; no VM', writable: 'new fixture', cache: 'none' }, mainObjective: 'diagnostic', protection: ['scope'], improvementConclusion: 'not-evaluated' };
  const trial = { id: 'no-change-1', caseId: 'no-change', side: 'candidate', repeat: 1, pair: null, version: trialVersion(plan, 'candidate') };
  plan.trials = [trial]; validatePlan(plan);
  const source = appendFact(evidence, 'eval.plan', plan); evidence.close();
  await fixEvidence(root, { id: `eval-plan:${id}`, sources: [source], purpose: 'fixed synthetic plan' });
  const facts = new Evidence(root, id), artifact = facts.blob('Readable outcome bytes');
  const start = () => { appendFact(facts, 'eval.started', { at: '2026-10-24T01:00:00Z' }); appendFact(facts, 'eval.trial-started', { trialId: trial.id }); };
  const outcome = (valid = true) => appendFact(facts, 'eval.outcome', { trialId: trial.id, status: valid ? 'completed' : 'invalid', started: true, valid, reason: valid ? null : 'actual_boundary_probe_failed', runtimeResult: null, artifacts: [{ path: 'project/result.txt', ref: artifact }], isolation: null, timing: { preparationMs: 1, taskMs: 2, gradingMs: 0 } });
  const grade = (source: string, judgment = 'PASS') => appendFact(facts, 'eval.grade', { id: 'known-grade', trialId: trial.id, outcome: source, graderVersion: plan.cases[0].grader.version, judgment, reason: judgment === 'unknown' ? 'grader crashed' : 'known result', checks: [{ name: 'scope', passed: true }], at: '2026-10-24T01:00:01Z' });
  const close = () => appendFact(facts, 'eval.closed', { at: '2026-10-24T01:00:02Z', budget: {}, stopReason: null });
  const fix = (source: string) => fixEvidence(root, { id: `eval-outcomes:${id}`, sources: [source], purpose: 'fixed synthetic outcomes' });
  return { root, id, facts, artifact, start, outcome, grade, close, fix };
}

// Controlled CPR oracle, independent of the product's measured-width table.
// Full paints are retained so a blocked frame cannot masquerade as a physical refresh.
class EvalTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; frames: string[] = [];
  input: (data: string) => void = () => {};
  hold?: string; held: (() => void)[] = [];
  private buffer = new StdinBuffer();
  constructor() { this.buffer.on('data', data => this.input(data)); }
  start(input: (data: string) => void) { this.input = input; }
  write(data: string) {
    if (data.includes('◆ ') && data.includes('eval')) this.frames.push(stripTerminalSequences(data));
    const query = /\x1b\[2;1H\x1b\[2K([^\x1b]*)\x1b\[6n/.exec(data);
    if (!query) return;
    const sample = query[1];
    const width = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sample)]
      .reduce((n, { segment }) => n + (/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/.test(segment) ? 2 : 1), 0);
    const respond = () => this.buffer.process(`\x1b[2;${width + 1}R\x1b[?1;2c`);
    if (sample === this.hold) this.held.push(respond); else queueMicrotask(respond);
  }
  release() { this.hold = undefined; for (const respond of this.held.splice(0)) respond(); }
  stop() {} async drainInput() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('condition timed out');
}

for (const measured of [false, true]) test(`outcome → grade → closed → fixed stays pending until protected, width gate ${measured ? 'on' : 'off'}`, async t => {
  const f = await fixture(); let runningHere = true;
  const view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} }, { runningHere: () => runningHere });
  const terminal = new EvalTerminal(), tui = new TuiAltScreen(terminal, true);
  tui.setLayoutRoot({ invalidate() {}, render: () => [] });
  showFullScreen(tui, terminal, { invalidate() {}, render: width => view.render(width, fullScreenHeight(terminal.rows)) });
  const gate = measured ? new TerminalWidthGate({ terminal, tui, sources: () => [], priorityInput: () => false, context: () => f.id, ready() {}, retain() { assert.fail('unexpected retained input'); } }) : undefined;
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const frames: { stage: string; text: string; report: ReturnType<typeof evalReport> }[] = [];
  const capture = async (stage: string, blocked = false) => {
    now += 1001; tui.renderNow(true);
    if (!blocked) await until(() => !gate?.blocked);
    frames.push({ stage, text: terminal.frames.at(-1)!, report: view.report! });
  };
  try {
    tui.start(); await capture('not-run');
    f.start(); view.refresh(); await capture('started');
    const outcome = f.outcome(); await capture('outcome');
    f.grade(outcome); await capture('grade');
    if (gate) terminal.hold = '束';
    const closed = f.close(); await capture('closed', measured);
    if (gate) {
      await until(() => terminal.held.length === 1);
      assert.equal(gate.blocked, true);
      assert.equal(terminal.frames.at(-1), frames.find(f => f.stage === 'grade')!.text, 'the gate retains the previous physical frame');
    }
    await f.fix(closed); runningHere = false; await capture('fixed', measured);
    terminal.release(); await until(() => !gate?.blocked);
    if (!gate) tui.renderNow(true);
    const finalText = terminal.frames.at(-1)!;
    assert.equal(trialGlyph(frames[0].report.trials[0]), 'not-run');
    assert.equal(trialNote(frames[1].report.trials[0]), '未取得结果');
    for (const stage of ['outcome', 'grade', 'closed']) {
      const frame = frames.find(f => f.stage === stage)!, trial = frame.report.trials[0];
      assert.equal(trialGlyph(trial), 'unknown', `${stage}: readable pending evidence is not invalid`);
      assert.match(trialNote(trial)!, stage === 'outcome' ? /待评分/ : /待固定/);
      assert.doesNotMatch(trialNote(trial)!, /不可读|损坏|污染/);
      assert.doesNotMatch(frame.text, /证据不可读|trial 无效|trial 无法评分/);
      assert.match(frame.text, stage === 'outcome' ? /待评分/ : /待固定/);
      assert.equal(frame.report.counts.passed, 0); assert.equal(frame.report.counts.gradable, 0); assert.equal(frame.report.counts.passRate, null);
      assert.equal(trial.outcome.status, 'completed'); assert.equal(trial.outcome.source, outcome);
      assert.equal(readObject(f.root, f.artifact).toString(), 'Readable outcome bytes');
    }
    assert.equal(view.report!.counts.passed, 1, 'fixed evidence refreshes automatically after the batch closes');
    assert.equal(view.report!.counts.gradable, 1); assert.equal(view.report!.counts.passRate, 1);
    assert.equal(trialGlyph(view.report!.trials[0]), 'pass'); assert.equal(view.live, false);
    assert.doesNotMatch(finalText, /待评分|待固定|证据不可读/);
    assert.equal(frames.find(f => f.stage === 'outcome')!.report.trials[0].grade, null, 'later grades do not rewrite a captured earlier report');
    assert.equal(frames.find(f => f.stage === 'grade')!.report.trials[0].grade.judgment, 'PASS');
    assert.deepEqual(evalFacts(f.root, f.id).filter(f => ['eval.outcome', 'eval.grade', 'eval.closed'].includes(f.kind)).map(f => f.kind), ['eval.outcome', 'eval.grade', 'eval.closed']);
  } finally { terminal.release(); gate?.beginClose(); await gate?.settle(); tui.stop(); gate?.dispose(); f.facts.close(); }
});

for (const history of [false, true]) test(`${history ? 'historical' : 'released-owner'} closed outcomes without fixing report an actionable error and stop refreshing`, async () => {
  const f = await fixture();
  try {
    if (!history) {
      const owner = await acquireOwner(f.root, () => {});
      try { f.start(); const outcome = f.outcome(); f.grade(outcome); f.close(); }
      finally { await owner.release(); }
    } else { const outcome = f.outcome(); f.grade(outcome); f.close(); }
    const before = readFileSync(join(f.root, 'host.sqlite'));
    const view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} }, { runningHere: () => false });
    const text = stripTerminalSequences(view.render(132, 38, 'none').join('\n')), report = view.report!, trial = report.trials[0];
    assert.equal(trialNote(trial), '固定未完成');
    assert.equal(trialGlyph(trial), 'invalid'); assert.equal(view.live, false);
    assert.match(text, /固定未完成/); assert.match(text, /pi-durio eval report 查看原因/);
    assert.doesNotMatch(text, /待评分|待固定|证据不可读/);
    assert.doesNotMatch(trialNote(trial)!, /不可读|损坏|污染/);
    assert.match(formatEvalReport(evalReport(f.root, f.id), f.root), /固定未完成/);
    assert.equal(report.counts.passed, 0); assert.equal(report.counts.gradable, 0); assert.equal(report.counts.passRate, null);
    assert.equal(trial.outcome.status, 'completed'); assert.equal(trial.grade.judgment, 'PASS');
    assert.equal(readObject(f.root, f.artifact).toString(), 'Readable outcome bytes');
    assert.equal(hasOwnerMarker(f.root), false);
    assert.equal(evalFacts(f.root, f.id).some(fact => fact.kind === 'eval.fix-failed'), false);
    assert.deepEqual(readFileSync(join(f.root, 'host.sqlite')), before, 'reporting an incomplete fix does not append or migrate facts');
  } finally { f.facts.close(); }
});

test('a closed batch stays pending while its owner is held, then stops after release without fixing', async t => {
  const f = await fixture(), owner = await acquireOwner(f.root, () => {});
  let released = false, now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    f.start(); const outcome = f.outcome(); f.grade(outcome); f.close();
    const before = readFileSync(join(f.root, 'host.sqlite'));
    const view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} }, { runningHere: () => false });
    const text = stripTerminalSequences(view.render(132, 38, 'none').join('\n'));
    assert.equal(trialNote(view.report!.trials[0]), '待固定'); assert.equal(view.live, true);
    assert.match(text, /待固定/); assert.doesNotMatch(text, /固定未完成|证据不可读/);
    assert.equal(view.report!.counts.passed, 0); assert.equal(view.report!.counts.gradable, 0);
    owner.assertHeld();
    await owner.release(); released = true; now += 1001;
    const stopped = stripTerminalSequences(view.render(132, 38, 'none').join('\n'));
    assert.match(stopped, /固定未完成/); assert.match(stopped, /pi-durio eval report 查看原因/);
    assert.doesNotMatch(stopped, /待固定|待评分|证据不可读/); assert.equal(view.live, false);
    assert.deepEqual(readFileSync(join(f.root, 'host.sqlite')), before, 'polling never writes failure facts or takes ownership');
  } finally { if (!released) await owner.release(); f.facts.close(); }
});

test('a killed owner leaves readable outcomes and stale markers but cannot keep fixing live', async t => {
  const f = await fixture();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireOwner } from ${JSON.stringify(new URL('../src/ownership.js', import.meta.url).href)}; await acquireOwner(process.argv[1], () => {}); process.send('ready'); process.on('message', () => {});`, f.root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let exited = false, now = Date.now(); t.mock.method(Date, 'now', () => now);
  const exit = once(child, 'exit');
  try {
    await once(child, 'message');
    f.start(); const outcome = f.outcome(); f.grade(outcome); f.close();
    const view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} }, { runningHere: () => false });
    assert.equal(trialNote(view.report!.trials[0]), '待固定'); assert.equal(view.live, true);
    child.kill('SIGKILL'); await exit; exited = true;
    assert.equal(hasOwnerMarker(f.root), true, 'SIGKILL leaves the owner markers for explicit recovery');
    const before = readFileSync(join(f.root, 'owner.json')), database = readFileSync(join(f.root, 'host.sqlite'));
    now += 1001;
    const text = stripTerminalSequences(view.render(132, 38, 'none').join('\n'));
    assert.match(text, /固定未完成/); assert.match(text, /pi-durio eval report 查看原因/);
    assert.doesNotMatch(text, /待固定|待评分|证据不可读/); assert.equal(view.live, false);
    assert.equal(readObject(f.root, f.artifact).toString(), 'Readable outcome bytes');
    assert.deepEqual(readFileSync(join(f.root, 'owner.json')), before, 'stale claims are never replaced or removed by a reader');
    assert.deepEqual(readFileSync(join(f.root, 'host.sqlite')), database);
  } finally { if (!exited) { child.kill('SIGKILL'); await exit; } f.facts.close(); }
});

for (const failure of ['missing', 'corrupt'] as const) test(`real ${failure} evidence stays excluded with an actionable note`, async () => {
  const f = await fixture();
  try {
    f.start(); const outcome = f.outcome(); f.grade(outcome); const closed = f.close();
    if (failure === 'missing') unlinkSync(join(f.root, 'objects', f.artifact.sha256));
    if (failure === 'corrupt') writeFileSync(join(f.root, 'objects', f.artifact.sha256), 'Changed outcome bytes!');
    await assert.rejects(f.fix(closed), failure === 'corrupt' ? /EVIDENCE_CORRUPT/ : /ENOENT/);
    const report = evalReport(f.root, f.id), trial = report.trials[0], before = readFileSync(join(f.root, 'host.sqlite'));
    const view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} });
    const text = stripTerminalSequences(view.render(132, 38, 'none').join('\n'));
    assert.equal(report.counts.passed, 0); assert.equal(report.counts.gradable, 0); assert.equal(trialGlyph(trial), 'invalid');
    assert.match(text, /证据不可读/);
    assert.match(text, /pi-durio eval report 查看原因/);
    assert.doesNotMatch(text, /待固定|待评分/);
    assert.equal(trial.grade.judgment, 'PASS', 'the raw grade remains recorded, even when formal eligibility is lost');
    assert.match(formatEvalReport(report, f.root), /EVIDENCE_CORRUPT|ENOENT/);
    assert.deepEqual(readFileSync(join(f.root, 'host.sqlite')), before, 'reporting errors is read-only');
  } finally { f.facts.close(); }
});

test('a failed fixed-evidence write records the failure instead of waiting forever', async () => {
  const f = await fixture();
  try {
    // Invalid outcomes cannot enter the grading VM. The real regrade path only
    // retains host records here; a missing dependency makes its final fixing fail.
    f.start(); f.outcome(false); const closed = f.close(); await f.fix(closed);
    unlinkSync(join(f.root, 'objects', f.artifact.sha256));
    const grader = evalReport(f.root, f.id).plan.cases[0].grader;
    await assert.rejects(regradeEval({ dataRoot: f.root, id: f.id, directory: join(f.root, 'regrade'), revisionId: 'fix-failure', graders: { 'no-change': { ...grader, version: 'fix-failure-v2' } } }), /ENOENT/);
    const failure = evalFacts(f.root, f.id).at(-1)!;
    assert.equal(failure.kind, 'eval.fix-failed'); assert.equal(failure.data.id, 'eval-grade:pending:fix-failure'); assert.match(failure.data.reason, /ENOENT/);
    const report = evalReport(f.root, f.id), view = new EvalPlanView(ownPlanSource(f.root, f.id), { openTrial() {} });
    const text = stripTerminalSequences(view.render(132, 38, 'none').join('\n'));
    assert.equal(report.counts.passed, 0); assert.equal(report.counts.gradable, 0); assert.equal(trialGlyph(report.trials[0]), 'invalid');
    assert.match(text, /固定失败/); assert.match(text, /EVAL_FIX_FAILED/); assert.match(text, /pi-durio eval report 查看原因/);
    assert.doesNotMatch(text, /待固定|待评分/); assert.equal(view.live, false);
    assert.equal(report.trials[0].gradeHistory.length, 0, 'an invalid execution never starts a grading VM');
  } finally { f.facts.close(); }
});

test('invalid execution and an unknown grade retain their distinct meanings while evidence is pending', async () => {
  const invalid = await fixture(), ungradable = await fixture();
  try {
    invalid.start(); invalid.outcome(false);
    const bad = evalReport(invalid.root, invalid.id).trials[0];
    assert.equal(trialGlyph(bad), 'invalid'); assert.equal(trialNote(bad), '无效');
    ungradable.start(); const outcome = ungradable.outcome(); ungradable.grade(outcome, 'unknown');
    const closed = ungradable.close(); await ungradable.fix(closed);
    const report = evalReport(ungradable.root, ungradable.id), trial = report.trials[0];
    assert.equal(trialGlyph(trial), 'unknown'); assert.equal(trialNote(trial), '无法评分');
    assert.equal(report.counts.gradable, 0); assert.equal(report.counts.passed, 0);
    assert.match(formatEvalReport(report, ungradable.root), /grader crashed/);
  } finally { invalid.facts.close(); ungradable.facts.close(); }
});
