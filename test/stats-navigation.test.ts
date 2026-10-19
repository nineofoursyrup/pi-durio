import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { records, watermark } from '../src/history.js';
import { recordAcceptance } from '../src/metrics/index.js';
import { fixEvidence } from '../src/fixed-evidence.js';
import { loadEvalPlan, trialVersion } from '../src/eval/plan.js';
import { appendFact } from '../src/eval/store.js';
import { ownPlanSource, readPlanReport } from '../src/eval/overview.js';
import { ReadOnlyTui } from '../src/tui/app.js';
import { StatsBrowser } from '../src/tui/stats-browser.js';
import { statsMembers, statsExport } from '../src/tui/stats-drilldown.js';
import { readStats, statsRequest } from '../src/tui/stats.js';
import { EvalPlanView } from '../src/tui/eval.js';
import { EvidenceRawView } from '../src/tui/evidence-raw.js';

const key = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', tab: '\t' };
const text = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');
const all = () => statsRequest({ from: new Date(2000, 0, 1).toISOString(), to: new Date(2100, 0, 1).toISOString(), 'as-of': '2100-01-01T00:00:00.000Z', project: 'all', source: 'synthetic' }, '/fixture');
const temp = () => mkdtempSync(join(tmpdir(), 'durio-stats-navigation-'));
function task(root: string, id: string) {
  const e = new Evidence(root, id);
  e.append('task.accepted', { taskId: id, sessionId: id, workspace: '/fixture', input: 'known input', origin: { kind: 'coding', source: 'synthetic' } });
  e.append('run.started', {});
  e.append('tool.intent', { attemptId: `${id}-read`, durableTaskId: 1, callId: `${id}-read`, tool: 'read', args: { path: 'README.md' } });
  e.append('tool.result', { attemptId: `${id}-read`, durableTaskId: 1, result: { content: [{ type: 'text', text: `${id} original result` }] } });
  e.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  e.close();
}
const host = { open() {}, copy: async () => true, feedback() {}, changed() {} };

test('new feedback refreshes stats without losing the selected task; v and export retain the original failure and exclusions', () => {
  const root = temp(); task(root, 'first'); task(root, 'second');
  const duplicate = new Evidence(root, 'first');
  duplicate.append('task.accepted', { taskId: 'first', sessionId: 'first', workspace: '/fixture', input: 'duplicate', origin: { kind: 'coding', source: 'synthetic' } }); duplicate.close();
  const excluded = new Evidence(root, 'legacy'); excluded.append('task.accepted', { taskId: 'legacy', workspace: '/fixture', input: 'unknown origin' }); excluded.close();
  const source = { kind: 'human' as const, actor: 'fixture', statement: 'The stated necessary requirement was checked', refs: [] };
  const resultSource = [...records(root, { runId: 'second', kinds: ['run.closed'] })][0].id;
  recordAcceptance(root, { type: 'requirements', id: 'requirements', taskId: 'second', source, ruleVersion: 'fixture', necessary: [{ id: 'goal', description: 'known input' }] });
  recordAcceptance(root, { type: 'result', id: 'result', taskId: 'second', source, requirementsId: 'requirements', evidence: [resultSource] });
  const judgment = { type: 'judgment' as const, taskId: 'second', source, requirementsId: 'requirements', resultId: 'result', validity: 'valid' as const };
  recordAcceptance(root, { ...judgment, id: 'first-failure', findings: [{ requirementId: 'goal', outcome: 'FAIL', evidence: [resultSource] }] });
  const view = new StatsBrowser(root, '/fixture', all(), host), initial = view.stats!;
  assert.equal(initial.figures.acceptance.S, 0);
  view.handleInput(key.enter); view.handleInput(key.down);
  assert.equal(view.selectedTask?.taskId, 'second');
  const members = statsMembers(initial, 'acceptance');
  assert.deepEqual(members.slice(-2).map(m => m.classification), ['筛除', '重复受理']);
  assert.match(members[0].reasons.join(' '), /任务类型 unknown.*实际执行版本 unknown/);
  recordAcceptance(root, { ...judgment, id: 'correction', supersedes: ['first-failure'], reason: 'Original classification corrected from inspected facts', findings: [{ requirementId: 'goal', outcome: 'PASS', evidence: [resultSource] }] });
  view.refresh(new Date('2100-01-02T00:00:00.000Z'));
  assert.equal(view.selectedTask?.taskId, 'second'); assert.equal(view.stats!.figures.acceptance.S, 1);
  assert.ok(view.stats!.scope.through! > initial.scope.through!);
  const latest = statsExport(view.stats!);
  assert.equal(latest.task.excluded.length, 1); assert.equal(latest.task.duplicates.length, 1);
  assert.equal(latest.task.tasks[1].acceptance.history.find(h => h.id === 'first-failure')?.withdrawn, false, 'superseding retains the original judgment');
  assert.equal(latest.task.tasks[1].acceptance.history.length, 4);
  const revisionCount = view.stats!.revisions.length;
  view.back(); view.handleInput('v');
  assert.equal(view.stats!.scope.through, initial.scope.through); assert.equal(view.stats!.figures.acceptance.S, 0);
  assert.match(text(view.render(132, 38)), /旧修订/);
  assert.ok(!statsExport(view.stats!).task.tasks[1].acceptance.history.some(h => h.id === 'correction'));
  for (let i = 1; i < revisionCount && view.stats!.scope.through !== latest.scope.through; i++) view.handleInput('v');
  assert.equal(view.stats!.scope.through, latest.scope.through); assert.equal(view.stats!.figures.acceptance.S, 1);
});

const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/v1-records/data', import.meta.url));
async function plan(root: string, candidate: 'PASS' | 'FAIL') {
  const template = structuredClone(loadEvalPlan(fixtureRoot, 'fixture-eval-plan-1'));
  const id = template.id, e = new Evidence(root, id), runtime = { id: 'fixed-runtime', manifest: e.blob('[]'), bytes: 2 };
  template.runtime = runtime;
  template.comparison!.sides.baseline.runtime = runtime; template.comparison!.sides.candidate.runtime = runtime;
  template.trials = template.trials.map(trial => ({ ...trial, version: trialVersion(template, trial.side) }));
  delete template.environment.boundaryFiles; delete template.environment.hostFiles;
  const planSource = appendFact(e, 'eval.plan', template); e.close();
  await fixEvidence(root, { id: `eval-plan:${id}`, sources: [planSource], purpose: 'known stats regression plan' });
  const outcomes = new Evidence(root, id); let last = planSource;
  for (const trial of template.trials) {
    const outcome = appendFact(outcomes, 'eval.outcome', { trialId: trial.id, status: 'completed', started: true, valid: true, artifacts: [], isolation: null, timing: { taskMs: 1 } });
    last = appendFact(outcomes, 'eval.grade', { id: `grade-${trial.id}`, trialId: trial.id, outcome, graderVersion: template.cases.find(c => c.id === trial.caseId)!.grader.version, judgment: trial.side === 'baseline' ? 'PASS' : candidate, checks: [{ name: 'task', passed: trial.side === 'baseline' || candidate === 'PASS' }], reason: 'known fixture' });
  }
  outcomes.close();
  await fixEvidence(root, { id: `eval-outcomes:${id}`, sources: [last], purpose: 'known stats regression result' });
  return { id, ref: [...records(root, { kinds: ['eval.plan'] })][0], report: readPlanReport(ownPlanSource(root, id)).report };
}

test('identical parent and child ep numbers retain distinct sources and pinned R/V, V/P through later child work', async () => {
  const root = temp(), directory = join(root, 'validation'), child = join(directory, 'group', 'check-0', 'eval-data');
  const own = await plan(root, 'PASS'), owned = await plan(child, 'FAIL');
  const parent = new Evidence(root, 'analysis');
  parent.append('task.accepted', { taskId: 'analysis', sessionId: 'analysis', workspace: '/fixture', input: 'synthetic validation', origin: { kind: 'improve', source: 'synthetic' } });
  parent.append('improve.started', { request: { id: 'report' } });
  parent.append('improve.report', { id: 'report', runId: parent.runId, target: { workspace: '/fixture' }, candidates: [] });
  parent.append('improve.decision', { id: 'decision', decision: { reportId: 'report', directory, limits: { maxTokens: 0 }, groups: [{ id: 'group', candidateIds: [], checks: [{ kind: 'fresh' }] }] } }); parent.close();
  const decision = [...records(root, { kinds: ['improve.decision'] })][0], e = new Evidence(root, 'analysis');
  e.append('improve.eval', { id: 'decision', groupId: 'group', index: 0, kind: 'eval', dataRoot: child, planId: owned.id, planSource: { scope: 'child-data-root', dataRoot: child, sequence: owned.ref.seq, digest: owned.ref.ref.sha256 }, parent: { dataRoot: root, decisionSource: decision.id, decisionId: 'decision' } });
  e.append('improve.check', { id: 'decision', groupId: 'group', index: 0, dataRoot: child, planId: owned.id, reportOrigin: { dataRoot: child, planId: owned.id }, reportDocument: e.blob(JSON.stringify(owned.report)) }); e.close();
  const stats = readStats(root, all().scope);
  assert.equal(stats.plans.length, 2); assert.equal(stats.plans[0].source.label, stats.plans[1].source.label, 'same id intentionally collides across roots');
  assert.equal(stats.plans.find(p => p.source.root === root)!.R, 0);
  assert.ok(stats.plans.find(p => p.source.root === realpathSync(child))!.R > 0);
  const members = statsMembers(stats, 'regression'); assert.notEqual(members[0].key, members[1].key);
  assert.ok(members.some(m => m.label.includes('ir-')));
  const browser = new StatsBrowser(root, '/fixture', all(), host);
  for (const data of [key.down, key.down, key.down, key.down, key.enter]) browser.handleInput(data);
  assert.match(text(browser.render(132, 38)), /node-check-v1/);
  const later = new Evidence(child, owned.id); later.append('eval.grader-revision', { id: 'later', graders: {}, reason: 'later independent revision' }); later.close();
  for (const p of stats.plans) {
    const target = members.find(m => m.key === `${p.source.root}#${p.source.id}`)!.evidence()[0].target;
    assert.equal(target.kind, 'plan'); if (target.kind !== 'plan') throw Error('expected plan route');
    assert.equal(target.source.root, p.source.root);
    const view = new EvalPlanView(target.source, { openTrial() {} });
    assert.deepEqual(view.report!.comparison!.regression.counts, { planned: p.P, valid: p.V, regressed: p.R, regressionRate: p.V ? p.R / p.V : null, coverageRate: p.P ? p.V / p.P : null });
    assert.equal(view.live, false); assert.ok(view.report!.asOf <= target.source.through!);
    assert.ok(!view.report!.gradingRevisions.some(r => r.id === 'later'));
  }
  assert.equal(statsExport(stats).regression.find(p => p.source.root === realpathSync(child))!.source.origin!.decisionId, 'decision');
  assert.equal(own.id, owned.id);
});

test('cost evidence remains inspectable when an original disappears after the report is loaded', () => {
  const root = temp(); task(root, 'cost');
  const e = new Evidence(root, 'cost'); e.append('model.intent', { attemptId: 'request', allocation: 'task', purpose: 'generation' }); e.append('model.dispatch', { attemptId: 'request', transportEntered: true }); e.close();
  const stats = readStats(root, all().scope), ref = [...records(root, { kinds: ['model.intent'] })][0];
  unlinkSync(join(root, 'objects', ref.ref.sha256));
  const members = statsMembers(stats, 'cost');
  assert.equal(members.length, 1); assert.match(members[0].classification, /unknown/);
  assert.ok(members[0].evidence().some(e => e.target.kind === 'raw' && e.target.id === ref.id));
});

test('source originals page through long evidence and display controls without executing them', async () => {
  const root = temp(), e = new Evidence(root, 'long');
  e.append('tool.result', { result: 'begin\x1b[31m' + 'x'.repeat(40_000) + '\nend' }); e.close();
  const id = [...records(root, { kinds: ['tool.result'] })][0].id, copied: string[] = [];
  const view = new EvidenceRawView({ kind: 'raw', root, id }, { ...host, copy: async content => { copied.push(content); return true; } });
  assert.match(text(view.render(80, 24)), /第 1\/3 页/); assert.match(text(view.render(80, 24)), /␛\[31m/);
  view.handleInput('n'); view.handleInput('n'); assert.match(text(view.render(80, 24)), /第 3\/3 页/);
  view.handleInput('y'); await new Promise(resolve => setImmediate(resolve));
  assert.match(copied[0], /end/); view.handleInput('p'); assert.match(text(view.render(80, 24)), /第 2\/3 页/);
});

class TestTerminal implements Terminal {
  columns = 160; rows = 40; kittyProtocolActive = false; input: (s: string) => void = () => {};
  start(input: (s: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('show-mode stats returns from trace/raw and eval to the same evidence, member and table selection, allowing only copy/export', async () => {
  const root = temp(), workspace = join(root, 'workspace'); mkdirSync(workspace); task(root, 'first'); task(root, 'second'); await plan(root, 'FAIL');
  const before = readFileSync(join(root, 'host.sqlite')), through = watermark(root), terminal = new TestTerminal(), copied: string[] = [];
  let calls = 0;
  const app = new ReadOnlyTui({ dataRoot: root, workspace, draftRoot: join(root, 'drafts'), mode: 'offline', show: { run: 'first' }, terminal, widthCalibration: false, transport: async () => { calls++; throw Error('no provider'); }, copy: async data => { copied.push(data); return true; } });
  const screen = () => text(app.screen()), press = (...data: string[]) => data.forEach(value => terminal.input(value));
  try {
    app.start(); press(key.esc, key.esc, key.esc, all().command, key.enter); const table = screen(); assert.match(table, /◆ stats/);
    press(key.enter, key.down); const member = screen(); assert.match(member, /成员 2\//);
    press(key.enter); const evidence = screen(); press(key.enter); assert.match(screen(), /◆ trace/);
    press(key.down, 'p'); assert.match(screen(), /只读查看/); assert.doesNotMatch(screen(), /写入一条固定记录/);
    press(key.enter); assert.match(screen(), /◆ trace 原文/);
    press(key.tab, 'y'); await new Promise(resolve => setImmediate(resolve)); assert.match(copied[0], /second original result/);
    press(key.esc); assert.match(screen(), /◆ trace/); assert.doesNotMatch(screen(), /◆ trace 原文/);
    press(key.esc); assert.equal(screen(), evidence);
    press(key.esc); assert.equal(screen(), member);
    press(key.esc); assert.equal(screen(), table);
    press(key.down, key.down, key.down, key.down); const regression = screen();
    press(key.enter, key.enter); const planEvidence = screen(); press(key.enter); assert.match(screen(), /◆ eval/); assert.match(screen(), /stats 截止/);
    press(key.esc); assert.equal(screen(), planEvidence); press(key.esc, key.esc); assert.equal(screen(), regression);
    press('e', key.enter); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(copied.at(-1)!).schema, 'pi-durio-stats-v1');
    assert.equal(calls, 0); assert.equal(watermark(root), through); assert.deepEqual(readFileSync(join(root, 'host.sqlite')), before);
  } finally { await app.exit(); }
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), before);
});


test('project stats resolves known identities on a data root beyond the selection catalogue limit', async t => {
  const root = temp(), workspace = join(root, 'workspace'), project = join(root, 'recorded-project');
  mkdirSync(workspace);
  const evidence = new Evidence(root, 'large-catalogue');
  const body = evidence.blob(JSON.stringify({ taskId: 'old', workspace: '/other', origin: { kind: 'coding', source: 'synthetic' } })); evidence.close();
  const db = new DatabaseSync(join(root, 'host.sqlite'));
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)');
    for (let i = 0; i < 10001; i++) insert.run(`old-${i}`, 'task.accepted', '2000-01-01T00:00:00Z', JSON.stringify(body));
    db.exec('COMMIT');
  } finally { db.close(); }
  for (const input of [project, basename(workspace), 'other-project']) await t.test(input, async () => {
    const terminal = new TestTerminal();
    const app = new ReadOnlyTui({ dataRoot: root, workspace, draftRoot: join(root, 'drafts'), mode: 'offline', terminal, widthCalibration: false });
    try {
      app.start(); terminal.input(`/stats --from 2026-10-01 --project ${input}`); terminal.input(key.enter);
      if (input === 'other-project') {
        assert.doesNotMatch(text(app.screen()), /◆ stats/);
        assert.match(text(app.screen()), /STATS_CHOICES_TOO_LARGE/);
      } else {
        assert.match(text(app.screen()), /◆ stats/, 'an absolute identity or the current workspace name opens without a catalogue');
        assert.doesNotMatch(text(app.screen()), /STATS_CHOICES_TOO_LARGE/);
        terminal.input('/');
        assert.match(text(app.screen()), /选项列表超出上限/);
        assert.doesNotMatch(text(app.screen()), /日期.*缩小|日期、当前项目/);
        assert.match(text(app.screen()), /较小的数据根/);
      }
    } finally { await app.exit(); }
  });
});
