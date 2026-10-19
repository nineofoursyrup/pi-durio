import { test } from 'node:test';
import { dataRoot as v1DataRoot, names as v1Names } from './v1-runtime-fixture.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { inspectRecovery, runCodingTask } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { ReadOnlyTui } from '../src/tui/app.js';
import { RecoveryPanel, DISPOSITIONS, readRecoveryFacts, recoveryChecks, type RecoveryFacts } from '../src/tui/recovery.js';
import { overrideColorTierForTest } from '../src/tui/theme.js';
import { captureSnapshot, type SnapshotGrid } from '../src/tui/snapshot.js';

overrideColorTierForTest('truecolor');
process.env.TZ = 'Asia/Shanghai';
const plain = (line: string) => stripTerminalSequences(line);
const tick = () => new Promise(r => setTimeout(r, 30));
async function until(predicate: () => boolean, what = 'condition') { for (let i = 0; i < 600; i++) { if (predicate()) return; await tick(); } throw Error(`${what} timed out`); }

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false;
  input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {}
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

function assertGolden(grid: SnapshotGrid, name: string) {
  const masks: [RegExp, (m: string) => string][] = [[/\d\d:\d\d:\d\d/g, () => '00:00:00'], [/\d\d:\d\d/g, () => '00:00'], [/\b(s|r|q|ir|tc)-[0-9a-f]{4,}/g, m => m.replace(/(?<=-.*)[0-9a-f]/g, 'x')], [/ctx ≈?[\d.]+k?/g, m => m.replace(/\d/g, '9')]];
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
  if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); return; }
  assert.equal(text, readFileSync(path, 'utf8'), `snapshot ${name} changed; delete ${path} to accept`);
}

test('1c at 132×38 (golden); at 80×24 and 40×12 the always-kept elements stay and the status line is not covered', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-1c-'))), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace);
  const home = process.env.HOME; process.env.HOME = root; // ~/project in the header; the run and the check share one environment
  let results = 0;
  const first = scriptedTransport([{ name: 'write', args: { path: 'export.csv', content: 'id,tz\n' } }, { name: 'bash', args: { command: "printf 'migrating orders 1200/4810\\n'" } }]);
  const original = await runCodingTask({ workspace, dataRoot, input: '订单导出 CSV 增加时区列，并迁移历史数据', mode: 'offline', transport: first.fetch, fault: kind => { if (kind === 'tool.result' && ++results === 2) throw Error('result persistence failure'); } });
  assert.equal(original.status, 'unknown');
  const terminal = new TestTerminal();
  const app = new ReadOnlyTui({ workspace, dataRoot, runId: original.runId, draftRoot: join(root, 'drafts'), mode: 'offline', transport: scriptedTransport([]).fetch, terminal, widthCalibration: false, coding: true });
  const lines = () => app.screen().map(line => line.replace(/\x1b\]8;;[^\x07]*\x07/g, ''));
  const screen = () => lines().map(plain).join('\n');
  try {
    app.start();
    await until(() => screen().includes('未知 1/1'), 'panel');
    const shown = screen();
    assert.match(shown, /工作 +订单导出 CSV 增加时区列，并迁移历史数据 · 任务 1 · 第 2 轮/);
    assert.match(shown, /最后确认点 +✓ write export\.csv · \d\d:\d\d:\d\d 已提交结果/);
    assert.match(shown, /◈ bash printf 'migrating orders 1200\/4810\\n' · intent 已记录 \d\d:\d\d:\d\d，结果未提交 · 可能已产生影响/);
    assert.match(shown, /证据 +已收输出 27 B：“migrating orders 1200\/4810”/);
    assert.match(shown, /影响 +可能重复命令已产生的影响/);
    assert.match(shown, /result persistence failure/);
    assert.match(shown, /检查 +✓ 执行版本一致 · ✓ 授权仍适用 · ✓ 写入者锁可取得/);
    assert.match(shown, /▏ 1  重新核对（只读） +只重跑宿主检查，不运行命令、不调用模型/);
    assert.match(shown, /◈ 恢复核对/); assert.match(shown, /恢复核对进行中 · 输入不会提交/);
    assertGolden(captureSnapshot(lines(), 132, 38, 'truecolor'), '1c-132x38');
    for (const [columns, rows] of [[80, 24], [40, 12]] as const) {
      terminal.columns = columns; terminal.rows = rows; terminal.resize();
      const small = lines();
      assert.ok(small.length <= rows, `${columns}×${rows} rows`);
      for (const line of small) assert.ok(visibleWidth(line) <= columns, `${columns}×${rows}: ${plain(line)}`);
      const text = small.map(plain).join('\n');
      for (const kept of [/◆ pi-durio/, /工作 /, /未知 1\/1/, /检查 /, /✓ 执行版本一致/, /写入者锁可取得/, /1 {2}重新核对（只读）/, /2 {2}视为已完成/, /3 {2}从中断处继续/, /4 {2}结束旧工作，开新任务/, /只重跑宿主/, /Esc 返回查看/, /◈ 恢复核对/])
        assert.match(text, kept, `${columns}×${rows} keeps ${kept}`);
      if (columns === 80) assert.match(text, /\n +只重跑宿主检查/, 'below 100 columns the description moves under the name');
    }
  } finally { process.env.HOME = home; await app.exit(); }
});

function facts(over: Partial<RecoveryFacts>): RecoveryFacts {
  return { runId: 'r', snapshotId: 's', status: 'blocked', options: ['inspect', 'end'], work: { title: '迁移', round: 3 }, items: [{ taskId: 1, tool: 'bash', target: 'npm run migrate', dispatched: true }], prior: [], checks: [], frozen: { count: 0 }, otherSessions: [], unknownModelAttempts: 0, ...over };
}
const text = (panel: RecoveryPanel, width = 132) => panel.render(width, 60).map(plain).join('\n');

test('unavailable dispositions show the reason and code; ↑↓ skip them; external blocks allow only a recheck', () => {
  const blocked = new RecoveryPanel(facts({ checks: recoveryChecks(['Error: EXECUTION_VERSION_CHANGED: src/a.js', 'CURRENT_PERMISSION_CHANGED']) }));
  const shown = text(blocked, 200);
  assert.match(shown, /检查 +✗ 执行版本的文件已变化 · ✗ 授权的工具与原任务不同 · ✓ 写入者锁可取得  EXECUTION_VERSION_CHANGED CURRENT_PERMISSION_CHANGED/, '✗ first, codes at the end');
  assert.match(shown, /2 {2}视为已完成 +不可选 · 执行版本的文件已变化/); assert.match(shown, /3 {2}从中断处继续 +不可选 · 执行版本的文件已变化/);
  assert.match(shown, /4 {2}结束旧工作，开新任务 +旧 run 标记已结束/);
  blocked.handleInput('\x1b[B'); assert.equal(blocked.cursor, 3, '↓ skips the unavailable items');
  blocked.handleInput('2'); assert.equal(blocked.cursor, 3);
  assert.deepEqual(blocked.handleInput('\r'), { type: 'end' });

  const external = new RecoveryPanel(facts({ options: ['inspect', 'external-verification'], checks: recoveryChecks(['OTHER_SESSION_PENDING:abc', 'MYSTERY_CODE: x']), otherSessions: ['s-ab12'] }));
  const outside = text(external);
  assert.match(outside, /需先处理 +会话 s-ab12 有未完成的工作 · pi-durio resume s-ab12/);
  assert.match(outside, /✗ MYSTERY_CODE/, 'codes outside the table are shown as is');
  assert.match(outside, /4 {2}结束旧工作，开新任务 +不可选 · 会话 s-… 有未完成的工作/);
  external.handleInput('\x1b[B'); assert.equal(external.cursor, 0);
  assert.deepEqual(external.handleInput('\r'), { type: 'recheck' });
  // Narrow: descriptions under the name; checks wrap instead of truncating.
  const narrow = external.render(60, 60).map(plain);
  assert.ok(narrow.some(line => /^ {5}不可选 · /.test(line)));
  assert.ok(narrow.every(line => visibleWidth(line) <= 60));
});

test('zero unknowns offer continuing; height collapse keeps the always-kept rows down to 40×12', () => {
  const zero = new RecoveryPanel(facts({ status: 'needs-decision', options: ['inspect', 'continue', 'end'], items: [], checks: recoveryChecks([]) }));
  assert.ok(zero.zeroUnknown);
  assert.match(text(zero), /2 {2}视为已完成 +不可选 · 没有结果未提交的操作/);
  zero.handleInput('3'); assert.deepEqual(zero.handleInput('\r'), { type: 'continue' });
  const full = new RecoveryPanel(facts({ status: 'needs-decision', options: ['inspect', 'continue', 'end'], checks: recoveryChecks([]), frozen: { count: 2, first: { kind: 'follow-up', text: '补一份回滚脚本' } }, lastConfirmed: { tool: 'bash', target: 'npm test' } }));
  assert.match(text(full), /已冻结 +⧗ follow-up 补一份回滚脚本 · 2 项 · 不会自动接入/);
  const tight = full.render(40, 10).map(plain);
  assert.equal(tight.length, 10);
  for (const kept of [/^工作/, /^未知 1\/1/, /^检查/, /1 {2}重新核对/, /2 {2}视为已完成/, /3 {2}从中断处继续/, /4 {2}结束旧工作/, /只重跑宿主/, /Esc 返回查看/])
    assert.ok(tight.some(line => kept.test(line)), `${kept}: ${tight.join('\n')}`);
  assert.ok(!tight.some(line => /^已冻结|^最后确认点|^证据/.test(line)));
});

test('the v1 fixture shows a first-version skip as “跳过（首版处置）” with the original note', async () => {
  const dataRoot = v1DataRoot, ids = v1Names;
  const report = await inspectRecovery({ dataRoot, runId: ids['run.recovery-skip'] });
  const panel = new RecoveryPanel(readRecoveryFacts(dataRoot, [report]));
  assert.equal(panel.facts.items.length, 0, 'resolved items are not asked again');
  assert.match(panel.render(180, 20).map(plain).join('\n'), /你的决定 +此前 · write uncertain\.txt · 跳过（首版处置） · Fixture skip decision after an actual unsafe write with unavailable result/);
});


test('40×12 keeps all four dispositions and pages complete checks and selected action text', () => {
  const panel = new RecoveryPanel(facts({ checks: recoveryChecks(['Error: EXECUTION_VERSION_CHANGED: src/a.js', 'MYSTERY_RECOVERY_CONDITION_WITH_A_LONG_CODE']) }));
  panel.handleInput('4');
  const seen = new Set<string>(), checks = new Set<string>(), descriptions = new Set<string>();
  for (let page = 0; page < 30; page++) {
    const lines = panel.render(40, 10, 'none').map(plain), shown = lines.join('\n');
    assert.equal(lines.length,10);
    assert.ok(lines.every(line=>visibleWidth(line)<=40));
    for(const kept of [/^工作/m,/^未知 1\/1/m,/^检查/m,/1 {2}重新核对（只读）/,/2 {2}视为已完成/,/3 {2}从中断处继续/,/4 {2}结束旧工作，开新任务/,/Esc 返回查看/])assert.match(shown,kept);
    assert.match(shown,/n\/p.*\d+\/\d+/,'all remaining checks and selected text have a visible page entry');
    if(seen.has(shown))break;seen.add(shown);
    for(const line of lines.filter(line=>/^检查/.test(line)))checks.add(line.replace(/^检查 /,''));
    for(const line of lines.slice(lines.findIndex(line=>/4 {2}结束旧工作/.test(line))+1,-1))descriptions.add(line);
    panel.handleInput('n');
  }
  const all=[...checks,...descriptions].join('').replace(/\s/g,'');
  for(const value of ['EXECUTION_VERSION_CHANGED','MYSTERY_RECOVERY_CONDITION_WITH_A_LONG_CODE','执行版本的文件已变化','授权仍适用','写入者锁可取得',DISPOSITIONS[3].text])assert.ok(all.includes(value.replace(/\s/g,'')),value);
  const last=panel.render(40,10,'none').map(plain).join('\n');panel.handleInput('p');
  assert.notEqual(panel.render(40,10,'none').map(plain).join('\n'),last,'previous page works without changing the disposition');
  assert.equal(panel.cursor,3);assert.deepEqual(panel.handleInput('\r'),{type:'end'});
});


test('40×12 long completed notes keep the caret visible and use PgUp/PgDn without consuming note letters',()=>{
  const panel=new RecoveryPanel(facts({status:'needs-decision',options:['inspect','continue','end'],checks:recoveryChecks([])}));
  panel.handleInput('2');panel.handleInput('\r');
  const note='独立确认说明。'.repeat(20)+'最后确认';panel.handleInput(note);
  const render=()=>panel.render(40,10,'none').map(plain),shown=()=>render().join('\n');
  assert.match(shown(),/最后确认/,'typing follows the page containing the caret');
  assert.match(shown(),/PgUp\/Dn/);assert.doesNotMatch(shown(),/n\/p 详情/);
  assert.match(shown(),/Esc 取消说明/);
  const tail=shown();panel.handleInput('\x1b[5~');assert.notEqual(shown(),tail,'PageUp moves inside the note');
  for(let i=0;i<30;i++)panel.handleInput('\x1b[5~');
  const first=shown();assert.match(first,/说明（可选）/);
  const descriptions:string[]=[];
  for(let page=0;page<30;page++){
    const lines=render(),start=lines.findIndex(line=>/2 {2}视为已完成/.test(line))+1,end=lines.findIndex(line=>/3 {2}从中断处继续/.test(line));
    for(const line of lines.slice(start,end))descriptions.push(line);
    const before=shown();panel.handleInput('\x1b[6~');if(shown()===before)break;
  }
  assert.ok(descriptions.join('').replace(/\s/g,'').includes(note));
  panel.handleInput('n');panel.handleInput('p');assert.equal(panel.note,note+'np');assert.match(shown(),/最后确认np/);assert.ok(panel.render(40,10,'none').some(line=>line.includes('\x1b[7m')),'public Input cursor remains visible');
  const action=panel.handleInput('\r');assert.equal(action.type,'summary');if(action.type==='summary')assert.equal(action.resolutions[0].reason,note+'np');
});


test('recovery confirmation notes accept bracketed paste and public Input cursor editing',()=>{
  const panel=new RecoveryPanel(facts({status:'needs-decision',options:['inspect','continue','end'],checks:recoveryChecks([])}));
  panel.handleInput('2');panel.handleInput('\r');
  panel.handleInput('\x1b[200~已独立核对\x1b[201~');panel.handleInput('\x1b[D');panel.handleInput('结果');
  assert.equal(panel.note,'已独立核结果对');
  const action=panel.handleInput('\r');assert.equal(action.type,'summary');if(action.type==='summary')assert.equal(action.resolutions[0].reason,'已独立核结果对');
});


test('prior recovery reasons cannot emit terminal commands or control bytes', () => {
  const panel = new RecoveryPanel(facts({ prior: [{ tool: 'bash', target: 'true', choice: 'skip', reason: 'before\x1b]0;injected-title\x07after\x01' }] }));
  const rendered = panel.render(132, 30, 'none').join('\n');
  assert.doesNotMatch(rendered, /injected-title|\x01/);
  assert.match(plain(rendered), /beforeafter/);
});
