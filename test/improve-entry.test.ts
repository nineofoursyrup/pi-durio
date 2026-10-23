import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { runReadTask, analyzeImprove } from '../src/runtime.js';
import { offlineImproveTransport, readImproveReport, type ImproveRequest } from '../src/improve.js';
import { scriptedTransport } from '../src/offline.js';
import { completePath, improveBudgetAmount, improveHome, improveLimits, improveRequest, improveVisibleFiles, isFirstVersionReport, registerFromInput } from '../src/improve-entry.js';
import { listRegisteredSources,unregisterImproveSource } from '../src/improve-source.js';
import { ImproveLaunchDialog } from '../src/tui/improve-launch.js';
import { overrideColorTierForTest } from '../src/tui/theme.js';
import { captureSnapshot, type SnapshotGrid } from '../src/tui/snapshot.js';
import { ReadOnlyTui } from '../src/tui/app.js';

overrideColorTierForTest('truecolor');
const plain = (line: string) => stripTerminalSequences(line);
const tick = () => new Promise(r => setTimeout(r, 30));
async function until(predicate: () => boolean, what = 'condition') { for (let i = 0; i < 600; i++) { if (predicate()) return; await tick(); } throw Error(`${what} timed out`); }
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-improve-entry-'))), workspace = join(root, 'project'), data = join(root, 'data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'readme\n'); writeFileSync(join(workspace, 'a.ts'), 'export const a = 1;\n');
  return { root, workspace, data };
}
const read = (workspace: string, data: string, steps: { name: string; args: unknown }[], contextRunId?: string) =>
  runReadTask({ workspace, dataRoot: data, input: 'inspect', mode: 'offline', transport: scriptedTransport(steps).fetch, contextRunId });

test('budget tiers: standard ≤16 requests, 32k output, 2.16M total, 10 minutes; large doubles each; worst-case CNY bound', () => {
  assert.deepEqual(improveLimits('standard'), { maxRequests: 16, maxOutputTokens: 32768, maxRequestTokens: 1081344, maxTokens: 2162688, maxDurationMs: 600000 });
  assert.deepEqual(improveLimits('large'), { maxRequests: 32, maxOutputTokens: 65536, maxRequestTokens: 1114112, maxTokens: 4325376, maxDurationMs: 1200000 });
  assert.equal(improveBudgetAmount('standard')!.amount.toFixed(2), '17.30');
  assert.equal(improveBudgetAmount('large')!.amount.toFixed(2), '34.60');
});

test('scope tiers decide the evidence runs: the whole context chain, plus same-type runs only within 7 or 30 days', async () => {
  const p = project();
  const other = await read(p.workspace, p.data, []);
  const first = await read(p.workspace, p.data, []), second = await read(p.workspace, p.data, [], first.runId);
  const analyze = async (id: string, window: 0 | 7 | 30) => {
    const request: ImproveRequest = { id, purpose: 'find', limits: improveLimits('standard'), window, sources: [{ id: 'project', kind: 'project', paths: [] }] };
    await analyzeImprove({ dataRoot: p.data, workspace: p.workspace, targetRunId: second.runId, request, mode: 'offline', transport: offlineImproveTransport().fetch });
    return readImproveReport(p.data, id).started.scope.runIds as string[];
  };
  const chain = await analyze('chain-only', 0);
  assert.deepEqual(chain.slice(0, 2), [second.runId, first.runId], 'target first, then the rest of the chain');
  assert.ok(!chain.includes(other.runId), 'session scope excludes unrelated same-type runs');
  assert.ok((await analyze('seven-days', 7)).includes(other.runId), 'the 7-day tier adds same-project same-type runs');
});

test('visible files are the chain runs’ read or changed project files, most recent first; deleted ones are not counted', async () => {
  const p = project();
  writeFileSync(join(p.workspace, 'gone.ts'), 'x\n');
  const first = await read(p.workspace, p.data, [{ name: 'read', args: { path: 'a.ts' } }, { name: 'read', args: { path: 'gone.ts' } }]);
  const second = await read(p.workspace, p.data, [{ name: 'read', args: { path: join(p.workspace, 'README.md') } }, { name: 'read', args: { path: '../outside.txt' } }], first.runId);
  rmSync(join(p.workspace, 'gone.ts'));
  const visible = improveVisibleFiles(p.data, p.workspace, second.runId);
  assert.deepEqual(visible.project, ['README.md', 'a.ts']); assert.equal(visible.files, 2); assert.equal(visible.omitted, 0); assert.equal(visible.taskType, 'read');
  const request = improveRequest('r1', { scope: '7d', budget: 'standard', sources: [], focus: ' ' }, visible);
  assert.equal(request.purpose, '找出本会话中可改进之处'); assert.equal(request.window, 7);
  assert.deepEqual(request.sources, [{ id: 'project', kind: 'project', paths: ['README.md', 'a.ts'] }]);
});

test('registering a new path: eval <dir> is fingerprinted once, Tab completes paths, bad input says how to write it', () => {
  const p = project();
  mkdirSync(join(p.workspace, 'evals')); writeFileSync(join(p.workspace, 'evals', 'case.json'), '{}');
  assert.deepEqual(completePath(p.workspace, 'eval ev'), { text: 'eval evals/', matches: 1 });
  const registration = registerFromInput(p.data, p.workspace, 'eval evals');
  assert.deepEqual([registration.kind, registration.root, registration.paths], ['eval-asset', join(p.workspace, 'evals'), ['case.json']]);
  assert.equal(registerFromInput(p.data, p.workspace, 'eval evals').id, registration.id, 'the same registration is reused');
  assert.equal(listRegisteredSources(p.data, p.workspace).length, 1);
  assert.throws(() => registerFromInput(p.data, p.workspace, 'evals'), /IMPROVE_REGISTER_INPUT/);
  // The launch box checks a new registration and counts its files.
  const dialog = new ImproveLaunchDialog({ visible: { project: [], enabled: [], files: 0, omitted: 0, taskType: 'read' }, registrations: [], queued: false, register: input => registerFromInput(p.data, p.workspace, input), remove:id=>unregisterImproveSource(p.data,id), complete: input => completePath(p.workspace, input) });
  const cramped = dialog.render(40, 6);
  assert.match(cramped.map(plain).join('\n'), /Enter 窗口过小，无法确认/);
  const footer = captureSnapshot(cramped, 40, cramped.length, 'truecolor').rows.find(row => row.map(cell => cell.char).join('').includes('Enter'))!;
  assert.equal(footer.find(cell => cell.char === 'E')!.fg, 'fg.faint', 'disabled launch Enter remains readable');
  assert.equal(dialog.handleInput('\r').type, 'noop');
  dialog.render(132, 38);
  for (const key of ['\x1b[B', '\x1b[B', '\r', ...'eval ev', '\t', '\r']) dialog.handleInput(key);
  assert.equal(dialog.choice.sources[0]?.id, registration.id); assert.equal(dialog.files, 1);
  assert.match(dialog.render(132, 38).map(plain).join('\n'), /\[✓\] eval 资产 .*case\.json/);
  dialog.handleInput('\x1b[3~');assert.equal(listRegisteredSources(p.data,p.workspace).length,1,'Delete only opens a confirmation');assert.equal(dialog.choice.sources.length,1);
  const removal=dialog.render(132,38).map(plain).join('\n'),unwrapped=removal.replace(/[\s│╭╮╰╯─]/g,'');assert.match(removal,/移除来源登记/);assert.ok(unwrapped.includes(registration.root));assert.ok(unwrapped.includes('不删除目录或文件'));
  dialog.handleInput('\x1b');assert.equal(listRegisteredSources(p.data,p.workspace).length,1,'Esc preserves the source registration');
  dialog.handleInput('\x1b[3~');dialog.render(40,6);dialog.handleInput('\r');assert.equal(listRegisteredSources(p.data,p.workspace).length,1,'an undersized confirmation cannot remove a source');
  dialog.render(132,38);assert.notEqual(dialog.handleInput('\r').type,'confirm','removal confirmation never submits an analysis');assert.equal(listRegisteredSources(p.data,p.workspace).length,0);assert.equal(dialog.choice.sources.length,0);
});

/** Synthetic report records: a redesign report (candidates with replacements) and a first-version one. */
function reports(data: string, workspace: string, targetRunId: string) {
  const write = (id: string, candidates: object[]) => {
    const evidence = new Evidence(data, `improve-${id}`);
    evidence.append('improve.started', { request: { id }, target: { workspace, runId: targetRunId, sessionId: 's', taskId: 't' }, kind: 'improve' });
    evidence.append('improve.report', { id, kind: 'improve', state: 'complete', startedAt: '2026-10-15T09:30:00.000Z', target: { workspace, runId: targetRunId }, candidates, suppressed: [] });
    evidence.db.close();
  };
  const candidate = (n: number, executable: boolean) => ({ id: `candidate:${n}`, display: `R${n}`, title: `c${n}`, ...(executable ? { replacements: [], structuredChecks: [] } : {}) });
  write('fixture-v1', [candidate(1, false)]);
  write('fixture-new', [candidate(1, true), candidate(2, true), candidate(3, false)]);
  const decision = new Evidence(data, 'improve-decision');
  decision.append('improve.decision', { id: 'd1', decision: { reportId: 'fixture-new', groups: [{id:'validation',candidateIds:['candidate:2']}], limits: {maxTokens:0} }, decisions: [{ candidateId: 'candidate:1', mode: 'defer', problem: { target: { workspace, kind: 'project' }, paths: [], key: 'k' } }, { candidateId: 'candidate:2', mode: 'validate-only' }] });
  decision.append('improve.validation',{id:'d1',groupId:'validation',state:'completed',result:{conclusion:{allChecksPassed:true,allRequiredBenefitsMet:true}}});
  decision.db.close();
}

test('first layer facts: first-version reports never pending; only passed validation remains selectable', async () => {
  const p = project(), task = await read(p.workspace, p.data, []);
  reports(p.data, p.workspace, task.runId);
  const facts = improveHome(p.data, p.workspace);
  assert.deepEqual(facts.pending.map(r => [r.id, r.candidates, r.undecided]), [['fixture-new', 3, 2]]);
  assert.equal(facts.reports, 2); assert.equal(facts.suppressions, 0);
  assert.equal(isFirstVersionReport({ candidates: [{ title: 'x' }] as never, suppressed: [] }), true);
});

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {}
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function assertGolden(grid: SnapshotGrid, name: string) {
  const masks: [RegExp, (m: string) => string][] = [[/\d\d-\d\d \d\d:\d\d/g, () => '00-00 00:00'], [/\d\d:\d\d/g, () => '00:00'], [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, () => '⠋'], [/\b(s|r|q|ir|tc)-[0-9a-f]{4,}/g, m => m.replace(/(?<=-.*)[0-9a-f]/g, 'x')], [/ctx ≈?[\d.]+k?/g, m => m.replace(/\d/g, '9')]];
  const rows = grid.rows.map((row, index) => {
    let text = row.map(cell => cell.char).join('');
    for (const [pattern, replace] of masks) text = text.replace(pattern, replace);
    const runs: string[] = []; let start = 0;
    const style = (c: (typeof row)[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${text}|\n   ${runs.join(' ; ')}`;
  });
  const text = `${grid.width}x${grid.height} ${grid.tier}\n${rows.join('\n')}\n`;
  const dir = join(process.cwd(), 'test', 'fixtures', 'snapshots'), path = join(dir, `${name}.txt`);
  if (process.env.UPDATE_IMPROVE_GOLDENS==='1'||!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); return; }
  assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}

test('improve first layer and launch box at 132×38 (golden); 80×24 and 40×12 never overflow', async () => {
  const p = project(), home = process.env.HOME;
  process.env.HOME = p.root;
  const terminal = new TestTerminal();
  const app = new ReadOnlyTui({ workspace: p.workspace, dataRoot: p.data, draftRoot: join(p.root, 'drafts'), mode: 'offline', transport: scriptedTransport([{ name: 'read', args: { path: 'a.ts' } }]).fetch, terminal, widthCalibration: false, copy: async () => true });
  const lines = () => app.screen().map(line => line.replace(/\x1b\]8;;[^\x07]*\x07/g, ''));
  const screen = () => lines().map(plain).join('\n');
  const fits = (columns: number, rows: number) => {
    terminal.columns = columns; terminal.rows = rows; terminal.resize();
    const shown = lines();
    assert.ok(shown.length <= rows, `${columns}×${rows} rows`);
    for (const line of shown) assert.ok(visibleWidth(line) <= columns, `${columns}×${rows}: ${plain(line)}`);
    terminal.columns = 132; terminal.rows = 38; terminal.resize();
  };
  try {
    app.start();
    terminal.input('看一下 a.ts'); terminal.input('\r');
    await until(() => screen().includes('✓ 完成'), 'task');
    const { readAcceptedTasks } = await import('../src/evidence.js');
    reports(p.data, p.workspace, readAcceptedTasks(p.data).tasks[0].runId!);
    terminal.input('/improve'); terminal.input('\r');
    assert.match(screen(), /◆ improve  ~\/project +分析不执行候选/);
    assert.match(screen(), /› ir-[0-9a-f]{4,} · \d\d-\d\d \d\d:\d\d · 来自 s-[0-9a-f]{4,} · 候选 3 · 未决 2/, 'a pending report is selected by default');
    assert.match(screen(), /新建分析/); assert.match(screen(), /历史报告 · 2 份/); assert.match(screen(), /建议抑制 · 没有生效的抑制/);
    assertGolden(captureSnapshot(lines(), 132, 38, 'truecolor'), 'improve-home-132x38');
    fits(80, 24); fits(40, 12);
    terminal.input('\x1b[B'); terminal.input('\r');
    assert.match(screen(), /分析不执行任何候选 · 可看文件 1（省略 0）/);
    assert.match(screen(), /◉ 2 本会话 \+ 近 7 天同类/); assert.match(screen(), /◉ 1 标准/);
    assertGolden(captureSnapshot(lines(), 132, 38, 'truecolor'), 'improve-launch-132x38');
    fits(80, 24); fits(40, 12);
    // Budget tier changes the fixed line; Esc cancels without running anything.
    terminal.input('\x1b[B'); terminal.input('2');
    assert.match(screen(), /上限约 ¥34\.60（按最坏情况预留） · ≤32 请求 · ≤20 分钟/);
    terminal.input('\x1b'); assert.doesNotMatch(screen(), /新建 improve 分析/);
  } finally { process.env.HOME = home; await app.exit(); }
});


test('queued session-scope analysis captures files used before actual start while explicit headless paths stay fixed',async()=>{
 const p=project(),task=await read(p.workspace,p.data,[{name:'read',args:{path:'README.md'}}]);
 const visible=improveVisibleFiles(p.data,p.workspace,task.runId),request=improveRequest('queued-source-scope',{scope:'session',budget:'standard',sources:[],focus:''},visible);
 const later=new Evidence(p.data,task.runId);later.append('tool.intent',{tool:'read',args:{path:'a.ts'}});later.close();
 await analyzeImprove({dataRoot:p.data,workspace:p.workspace,targetRunId:task.runId,request,mode:'offline',transport:offlineImproveTransport().fetch});
 assert.deepEqual(readImproveReport(p.data,request.id).report!.targets.find(t=>t.id==='project')!.files.map(f=>f.path),['a.ts','README.md']);
 const explicit={...request,id:'explicit-source-scope'};delete explicit.sourceScope;
 await analyzeImprove({dataRoot:p.data,workspace:p.workspace,targetRunId:task.runId,request:explicit,mode:'offline',transport:offlineImproveTransport().fetch});
 assert.deepEqual(readImproveReport(p.data,explicit.id).report!.targets.find(t=>t.id==='project')!.files.map(f=>f.path),['README.md']);
});

test('launch focus and registration input preserve bracketed paste and cursor edits',()=>{
 const p=project(),dialog=new ImproveLaunchDialog({visible:{project:[],enabled:[],files:0,omitted:0,taskType:'read'},registrations:[],queued:false,register:input=>registerFromInput(p.data,p.workspace,input),remove:id=>unregisterImproveSource(p.data,id),complete:input=>completePath(p.workspace,input)});
 for(const key of ['\x1b[B','\x1b[B','\x1b[B','\x1b[200~hello world\x1b[201~','\x1b[D','!'])dialog.handleInput(key);
 assert.equal(dialog.choice.focus,'hello worl!d');
});

test('launch path completion places subsequent typing after the completed directory before registration',()=>{
 const p=project();mkdirSync(join(p.workspace,'evals','subdir'),{recursive:true});writeFileSync(join(p.workspace,'evals','subdir','case.json'),'{}');
 const dialog=new ImproveLaunchDialog({visible:{project:[],enabled:[],files:0,omitted:0,taskType:'read'},registrations:[],queued:false,register:input=>registerFromInput(p.data,p.workspace,input),remove:id=>unregisterImproveSource(p.data,id),complete:input=>completePath(p.workspace,input)});
 for(const key of ['\x1b[B','\x1b[B','\r','eval ev','\t','subdir','\r'])dialog.handleInput(key);
 assert.equal(dialog.choice.sources[0]?.root,join(p.workspace,'evals','subdir'));
 assert.equal(listRegisteredSources(p.data,p.workspace).length,1);
});
