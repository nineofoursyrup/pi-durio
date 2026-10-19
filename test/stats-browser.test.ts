import test from 'node:test';
import assert from 'node:assert/strict';
import { statsRequest } from '../src/tui/stats.js';
import { parseCommand } from '../src/tui/commands.js';

const now = new Date('2026-10-17T05:06:07.000Z');
test('stats project names resolve to the current project and the displayed command preserves the cutoff', () => {
  const request = statsRequest({ project: 'shop-api' }, '/code/shop-api', now);
  assert.equal(request.scope.project, '/code/shop-api');
  const replay = statsRequest(parseCommand(request.command, undefined, now).options, '/code/shop-api', new Date('2026-10-18T00:00:00.000Z'));
  assert.deepEqual(replay.scope, request.scope, 'replaying the displayed command must not advance as_of');
});

import { fileURLToPath } from 'node:url';
import { records } from '../src/history.js';
import { ownPlanSource, readPlanReport } from '../src/eval/overview.js';
import { EvalPlanView } from '../src/tui/eval.js';
const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/v1-records/data', import.meta.url));
test('a plan opened from an earlier stats cutoff cannot expose later trial results', () => {
  const plan = [...records(fixtureRoot, { kinds: ['eval.plan'] })].find(ref => readPlanReport(ownPlanSource(fixtureRoot, ref.runId)).report.comparison)!;
  assert.ok(plan);
  const source = { ...ownPlanSource(fixtureRoot, plan.runId), through: plan.seq };
  const view = new EvalPlanView(source, { openTrial() {} });
  assert.equal(view.report!.comparison!.regression.counts.valid, 0, 'at the plan receipt no trial result was known');
  assert.equal(view.report!.asOf, plan.seq);
  assert.equal(view.live, false, 'stats drilldown remains fixed at the stats cutoff');
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { resolveProjectFilter } from '../src/tui/project-filter.js';
import { StatsFilter, statsChoices } from '../src/tui/stats-filter.js';
import { DatabaseSync } from 'node:sqlite';
import { Evidence } from '../src/evidence.js';
import { StatsBrowser } from '../src/tui/stats-browser.js';
import { ExportDialog } from '../src/tui/export-dialog.js';
import { readStats } from '../src/tui/stats.js';
import { statsExport, type StatsTarget } from '../src/tui/stats-drilldown.js';
import { watermark } from '../src/history.js';
const keys = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', tab: '\t' };
const screen = (view: { render(w: number, h: number): string[] }, w = 132, h = 38) => view.render(w, h).map(stripTerminalSequences).join('\n');
const allRequest = () => statsRequest({ from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', 'as-of': '2100-01-01T00:00:00.000Z', source: 'synthetic', project: 'all' }, '/fixture', now);

test('project filter uses exact identities, rejects ambiguous basenames, and retains quoted paths in equivalent commands', () => {
  assert.throws(() => resolveProjectFilter('shared', '/a/shared', ['/b/shared']), /项目名称有歧义/);
  assert.equal(resolveProjectFilter('/a/shared', '/a/shared', ['/b/shared']), '/a/shared');
  assert.equal(resolveProjectFilter('second', '/a/shared', ['/b/second']), '/b/second');
  assert.throws(() => resolveProjectFilter('missing', '/a/shared'), /找不到项目/);
  const request = statsRequest({ project: '/code/shop "one"', type: 'task one' }, '/here', now);
  assert.deepEqual(statsRequest(parseCommand(request.command, undefined, now).options, '/here', now).scope, request.scope);
});

test('preset filters and the displayed stats command select the same five dimensions and snapshot', () => {
  const initial = statsRequest({ snapshot: '42' }, '/code/current', now);
  const choices = { projects: ['/code/current', '/elsewhere/other'], types: ['coding', 'read'], versions: ['build-a', 'build-b'] };
  const filter = new StatsFilter(initial, '/code/current', choices), pick = (...data: string[]) => data.forEach(d => filter.preset.handleInput(d));
  pick('1', keys.down, '3', keys.enter, keys.down, keys.enter, keys.down, '3', keys.down, '2', keys.enter, keys.down, keys.enter, keys.down, '2', keys.enter, keys.down, keys.enter);
  const chosen = filter.request!;
  assert.equal(chosen.scope.project, '/elsewhere/other');
  assert.equal(chosen.scope.source, 'diagnostic');
  assert.equal(chosen.scope.taskType, 'read');
  assert.equal(chosen.scope.version, 'build-b');
  assert.equal(chosen.scope.through, 42);
  assert.deepEqual(statsRequest(parseCommand(chosen.command, undefined, now).options, '/code/current', new Date('2027-01-01T00:00:00Z'), choices.projects).scope, chosen.scope);
  assert.equal(filter.preset.handleInput(keys.enter), 'apply');
  const custom = new StatsFilter(initial, '/code/current', choices);
  for (const d of ['5', keys.enter, '2026-10-01 2026-10-12', keys.enter]) custom.preset.handleInput(d);
  assert.equal(custom.request!.scope.from, new Date(2026, 9, 1).toISOString());
  assert.equal(custom.request!.scope.to, new Date(2026, 9, 12).toISOString());
});

test('an active filter value remains visible even when no current metadata lists it', () => {
  const request = statsRequest({ project: '/retired/project', type: 'retired-type', version: 'retired-build' }, '/here', now);
  const filter = new StatsFilter(request, '/here', { projects: ['/here'], types: [], versions: [] });
  const rendered = filter.preset.render(132).map(stripTerminalSequences).join('\n');
  assert.match(rendered, /retired-type/); assert.match(rendered, /retired-build/);
  assert.deepEqual(filter.request!.scope, request.scope);
});

test('export defaults to clipboard, refuses existing files, and writes the same JSON only to a new file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'durio-stats-export-')), notices: string[] = [], copied: string[] = []; let done = 0;
  const value = { scope: { source: 'ordinary' }, unknown: 1 };
  const host = { copy: async (text: string) => { copied.push(text); return true; }, feedback: (text: string) => notices.push(text), changed() {}, done() { done++; } };
  const config = { title: 'stats', value, suggestedPath: './stats.json', cwd };
  await new ExportDialog(config, host).handleInput(keys.enter);
  assert.deepEqual(JSON.parse(copied[0]), value); assert.equal(done, 1);
  writeFileSync(join(cwd, 'stats.json'), 'immutable existing report');
  const file = new ExportDialog(config, host);
  await file.handleInput(keys.down); await file.handleInput(keys.enter);
  assert.equal(readFileSync(join(cwd, 'stats.json'), 'utf8'), 'immutable existing report');
  assert.match(notices.at(-1)!, /文件已存在/); assert.equal(done, 1);
  await file.handleInput('\x01'); await file.handleInput('./stats-new.json'); await file.handleInput(keys.enter);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'stats-new.json'), 'utf8')), value); assert.equal(done, 2);
});

test('stats members, evidence and raw pages preserve selection and never switch tabs below the table', () => {
  const opened: StatsTarget[] = [], before = readFileSync(join(fixtureRoot, 'host.sqlite')), seq = watermark(fixtureRoot);
  const view = new StatsBrowser(fixtureRoot, '/fixture', allRequest(), { open: target => opened.push(target), copy: async () => true, feedback() {}, changed() {} });
  const table = screen(view);
  view.handleInput(keys.enter); view.handleInput(keys.tab);
  assert.equal(view.tab, 'metrics'); assert.equal(view.selectedTask?.taskId, view.stats!.reports.task.tasks[1].taskId);
  const member = screen(view);
  view.handleInput(keys.enter); const evidence = screen(view);
  view.handleInput(keys.enter); assert.equal(opened[0]?.kind, 'run'); assert.equal(screen(view), evidence);
  view.handleInput(keys.down); view.handleInput(keys.enter);
  assert.equal(view.layer, 'raw'); assert.match(screen(view), /记录原文/);
  view.handleInput(keys.tab); assert.equal(view.tab, 'metrics');
  view.back(); view.handleInput(keys.up); assert.equal(screen(view), evidence);
  view.back(); assert.equal(screen(view), member);
  view.back(); assert.equal(screen(view), table);
  const exported = statsExport(view.stats!);
  assert.equal(exported.task.id, view.stats!.reports.task.id);
  assert.equal(exported.operations.ruleVersion, 'llmops-r1/cost-fault-v1');
  assert.deepEqual(exported.periodSpend.requestIds, view.stats!.reports.operations.costs.period.requestIds);
  assert.equal(watermark(fixtureRoot), seq); assert.deepEqual(readFileSync(join(fixtureRoot, 'host.sqlite')), before);
});

test('scope overflow still permits a narrower preset query while forbidding export', () => {
  const notices: string[] = [];
  const view = new StatsBrowser(fixtureRoot, '/fixture', statsRequest({}, '/fixture', now), { open() {}, copy: async () => true, feedback: text => notices.push(text), changed() {} }, {
    read(root, scope) { if (Date.parse(scope.to) - Date.parse(scope.from) > 8 * 86400000) throw Error('METRICS_SCOPE_TOO_LARGE'); return readStats(root, scope); },
    choices: () => ({ projects: ['/fixture'], types: [], versions: [] }),
  });
  assert.equal(view.exportable, false); view.handleInput('e'); assert.equal(view.layer, 'table'); assert.match(notices.at(-1)!, /缩小范围/);
  view.handleInput('/'); assert.equal(view.layer, 'filter'); view.handleInput('1'); view.handleInput(keys.enter);
  assert.equal(view.layer, 'table'); assert.equal(view.exportable, true);
  for (const [w, h] of [[132, 38], [80, 24], [40, 12]]) {
    view.handleInput('/'); const lines = view.render(w, h);
    assert.equal(lines.length, h); assert.match(stripTerminalSequences(lines[0]), /指标.*本机实测/);
    for (const line of lines) assert.ok(visibleWidth(line) <= w);
    view.back();
  }
});


test('stats export retains full regression identities while omitting every display-only label', () => {
  const stats = readStats(fixtureRoot, allRequest().scope);
  assert.ok(stats.plans.length);
  const exported = statsExport({ ...stats, plans: stats.plans.map(plan => ({ ...plan, label: 'ep-display', source: { ...plan.source, label: 'ep-display', origin: { label: 'ir-display', reportId: 'report-full-id', decisionId: 'decision-full-id', groupId: 'group' } } })) });
  assert.doesNotMatch(JSON.stringify(exported.regression), /ep-display|ir-display/);
  assert.equal(exported.regression[0].source.id, stats.plans[0].source.id);
  assert.deepEqual(exported.regression[0].source.origin, { reportId: 'report-full-id', decisionId: 'decision-full-id', groupId: 'group' });
});

test('stats choices stop before returning partial selection metadata when count or bytes exceed their bounds', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-choices-bound-')), e = new Evidence(root, 'r');
  const small = e.blob('{"workspace":"/a"}'), large = e.blob(JSON.stringify({ id: 'build', padding: 'x'.repeat(1100000) })); e.close();
  const db = new DatabaseSync(join(root, 'host.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)');
    db.exec('BEGIN'); for (let i = 0; i < 10001; i++) insert.run('r', 'task.accepted', '2000-01-01T00:00:00Z', JSON.stringify(small)); db.exec('COMMIT');
    assert.throws(() => statsChoices(root, '/here'), error => {
      assert.match(String(error), /STATS_CHOICES_TOO_LARGE/);
      assert.doesNotMatch(String(error), /日期/);
      assert.match(String(error), /较小的数据根/);
      return true;
    });
    db.exec('DELETE FROM records; BEGIN'); for (let i = 0; i < 31; i++) insert.run('r', 'execution.artifact', '2000-01-01T00:00:00Z', JSON.stringify(large)); db.exec('COMMIT');
    assert.throws(() => statsChoices(root, '/here'), /STATS_CHOICES_TOO_LARGE/);
    const before = watermark(root);
    const view = new StatsBrowser(root, '/here', statsRequest({}, '/here', now), { open() {}, copy: async () => true, feedback() {}, changed() {} }, {
      read(dataRoot, scope) { if (Date.parse(scope.to) - Date.parse(scope.from) > 8 * 86400000) throw Error('METRICS_SCOPE_TOO_LARGE'); return readStats(dataRoot, scope); },
    });
    assert.equal(view.exportable, false);
    view.handleInput('/'); assert.equal(view.layer, 'filter');
    assert.match(screen(view), /选项列表超出上限/);
    view.handleInput('1'); view.handleInput(keys.enter);
    assert.equal(view.layer, 'table'); assert.equal(view.exportable, true);
    assert.equal(watermark(root), before, 'shrinking a view never writes records');
  } finally { db.close(); }
});

test('export loading waits 200ms, animates, and cancellation discards late feedback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let resolve!: (value: boolean) => void, changed = 0, done = 0; const notices: string[] = [];
  const pending = new Promise<boolean>(finish => { resolve = finish; });
  const view = new ExportDialog({ title: 'stats', value: {}, suggestedPath: 'stats.json', cwd: '/tmp' }, {
    copy: () => pending, changed() { changed++; }, feedback(text) { notices.push(text); }, done() { done++; },
  });
  const task = view.handleInput('\r');
  const text = () => view.render(80, 24).map(stripTerminalSequences).join('\n');
  t.mock.timers.tick(199); assert.doesNotMatch(text(), /导出中/);
  t.mock.timers.tick(1); assert.match(text(), /⠋ 导出中/);
  t.mock.timers.tick(80); assert.match(text(), /⠙ 导出中/);
  view.cancel(); const before = changed; t.mock.timers.tick(800); resolve(true); await task;
  assert.equal(changed, before); assert.equal(done, 0); assert.deepEqual(notices, []);
});
