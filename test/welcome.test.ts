import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { TIPS, WelcomeScreen, readWelcomeFacts, renderWelcome, welcomeStatus, type WelcomeFacts } from '../src/tui/welcome.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';
import { acquireWorkspaceOwner } from '../src/workspace-ownership.js';
import { readDisplayIndex } from '../src/display-number.js';
import { runReadTask } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';

class TestTerminal implements Terminal {
  kittyProtocolActive = false; input: (s: string) => void = () => {};
  constructor(public columns = 132, public rows = 38) {}
  start(input: (s: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {}
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {}
  clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, ms = 15000) {
  for (const start = Date.now(); !check(); await wait(20)) if (Date.now() - start > ms) throw Error(`timeout: ${label}`);
}
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));

/** Text golden (same format as view-stack.test): characters per row, then style runs. Missing goldens are written on first run. */
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

const now = new Date(2026, 9, 15, 12, 0);
const facts: WelcomeFacts = {
  version: '0.1.0', build: 'f26ae8f', workspace: join(homedir(), 'code', 'shop-api'), lock: { state: 'free' },
  model: { id: 'deepseek-flash', api: 'openai-completions', host: 'api.deepseek.com' },
  execution: 'build f26ae8f · deps 9c1e · 指令 3f2a · 4 tools · improve 默认 1 项', dataRoot: join(homedir(), 'Library', 'Application Support', 'pi-durio'),
  sessions: [
    { label: 's-7f3a', improve: false, input: '修复购物车满减金额四舍五入', status: 'completed', at: new Date(2026, 9, 15, 10, 12).toISOString() },
    { label: 's-6c01', improve: false, input: '订单导出 CSV 增加时区列', status: 'unknown', at: new Date(2026, 9, 14, 22, 40).toISOString() },
    { label: 's-5e9b', improve: true, input: '测试重复运行成本', status: 'aborted', at: new Date(2026, 9, 9, 9, 0).toISOString() },
  ],
  tip: TIPS[0],
};

test('1a golden at 132×38 truecolor: welcome body above the input box, then the idle status line', () => {
  // 132×38 leaves 32 rows above the 3-row input box and the 3-row status area.
  const body = renderWelcome(facts, 132, 32, now, 'truecolor').lines;
  assertGolden(captureSnapshot([...body, welcomeStatus('deepseek-flash', 'ctx ≈863 / 1M', 132, 'truecolor')], 132, 33, 'truecolor'), 'welcome-132x38');
  const text = plain(body).join('\n');
  assert.match(text, /◢◣  █▀█ █ ▄ █▀▄ █ █ █▀█ █ █▀█/, 'two-row block mark, first row');
  assert.match(text, /◥◤  █▀▀ █   █▄▀ █▄█ █▀▄ █ █▄█/, 'two-row block mark, second row');
  assert.match(text, /本机 coding agent · v0\.1\.0 · f26ae8f/);
  assert.match(text, /工作区 +~\/code\/shop-api · ✓ 写入者锁可取得/);
  // Four aligned columns: number, first input line, status (right-aligned), time (right-aligned).
  assert.match(text, /s-7f3a {4}修复购物车满减金额四舍五入 +✓ 完成  今天 10:12 *$/m);
  assert.match(text, /s-6c01 {4}订单导出 CSV 增加时区列 +◈ 待恢复核对  昨天 22:40 *$/m);
  assert.match(text, /s-5e9b {4}improve · 测试重复运行成本 +◇ 已中止 +10-09 *$/m);
  const columns = (label: string) => { const line = plain(body).find(l => l.includes(label))!; return [line.indexOf(label), line.indexOf('完成') >= 0 ? line.indexOf('完成') + 2 : -1]; };
  assert.equal(columns('s-7f3a')[0], columns('s-6c01')[0], 'numbers share one column');
  assert.match(text, /Tip: 空闲时 Enter 提交新任务/);
  assert.match(stripTerminalSequences(welcomeStatus('deepseek-flash', 'ctx ≈863 / 1M', 132)), /^○ 空闲 · deepseek-flash · ctx ≈863 \/ 1M · 本会话 0 tok ≈ ¥0\.00 *$/);
});

test('1a collapses Tip, then recent sessions 3→1→hidden, then version details and data root, then the version line', () => {
  const seen: string[] = [];
  for (let height = 24; height >= 3; height--) {
    const text = plain(renderWelcome(facts, 80, height, now).lines).join('\n');
    const rows = (text.match(/s-[0-9a-f]{4} {4}/g) ?? []).length;
    const state = [text.includes('◢◣') ? 'block' : '', text.includes('Tip:') ? 'tip' : '', `sessions:${rows}`, text.includes('执行版本') ? 'details' : '', text.includes('本机 coding agent') ? 'version' : ''].filter(Boolean).join(' ');
    if (seen.at(-1) !== state) seen.push(state);
    // Always kept, whatever the height: the mark (two-row or one-row), workspace and model.
    assert.ok(text.includes('◢◣') || text.includes('◆ pi·durio'), `mark at height ${height}`);
    for (const kept of ['工作区', '模型']) assert.ok(text.includes(kept), `${kept} at height ${height}`);
    assert.equal(text.includes('执行版本'), text.includes('数据根'), `execution and data root collapse together at ${height}`);
  }
  // The block mark goes first (U1), then blank rows (U10, not visible in this summary), then the U1 order.
  assert.deepEqual(seen, ['block tip sessions:3 details version', 'tip sessions:3 details version', 'sessions:3 details version', 'sessions:1 details version', 'sessions:0 details version', 'sessions:0 version', 'sessions:0']);
});

test('a held writer lock shows the holder and the recovery method; read-only mode does not probe', () => {
  const holder = { state: 'held' as const, holder: { registered: '/w', path: join(homedir(), 'Library', 'Application Support', 'pi-durio', 'workspace-owners', 'ab'.repeat(32)), pid: 4312, host: 'mac', started: new Date(2026, 9, 15, 9, 30).toISOString() } };
  for (const width of [132, 80, 40]) {
    const text = plain(renderWelcome({ ...facts, lock: holder }, width, 30, now).lines);
    assert.ok(text.some(line => /✗ 被占用 · pid 4312 · mac · 今天 09:30/.test(line) || width < 60 && /✗ 被占用 · pid 4312/.test(line)), text.join('\n'));
    assert.ok(text.some(line => line.includes('恢复：等持有者结束后重开')), text.join('\n'));
    for (const line of text) assert.ok(visibleWidth(line) <= width);
  }
  assert.ok(plain(renderWelcome({ ...facts, lock: holder }, 132, 30, now).lines).join('').includes('workspace-owners/abab'));
  assert.match(plain(renderWelcome({ ...facts, lock: { state: 'readonly' } }, 132, 30, now).lines).join('\n'), /只读 · 不取写入者锁/);
});

test('clicking a recent session row opens that session; other rows do nothing', () => {
  const opened: string[] = [];
  const screen = new WelcomeScreen({ read: () => facts, coding: false, height: () => 30, open: session => opened.push(session), changed: () => {}, inspect: () => {} });
  const lines = plain(screen.render(132));
  const row = lines.findIndex(line => line.includes('s-6c01'));
  assert.equal(screen.handleMouse({ type: 'click', button: 'left', x: 10, y: lines.findIndex(line => line.includes('模型')), screenX: 0, screenY: 0, width: 132, height: 30, shift: false, alt: false, ctrl: false }), undefined);
  assert.deepEqual(screen.handleMouse({ type: 'click', button: 'left', x: 10, y: row, screenX: 0, screenY: row, width: 132, height: 30, shift: false, alt: false, ctrl: false }), { handled: true });
  assert.deepEqual(opened, ['s-6c01']);
});

test('with an empty input Up/Down select a recent session, Enter opens it, Esc or typing clears the selection', () => {
  const opened: string[] = [];
  const screen = new WelcomeScreen({ read: () => facts, coding: false, height: () => 30, open: session => opened.push(session), changed: () => {}, inspect: () => {} });
  const selectedRow = () => plain(screen.render(132)).find(line => line.includes('▏'));
  assert.equal(selectedRow(), undefined, 'nothing is selected at start');
  assert.equal(screen.key('\r'), false, 'Enter without a selection stays with the input (no submit of empty text)');
  assert.equal(screen.key('\x1b[B'), true); assert.match(selectedRow()!, /▏ s-7f3a/, 'Down selects the most recent session');
  assert.equal(screen.key('\x1b[B'), true); assert.match(selectedRow()!, /▏ s-6c01/);
  assert.equal(screen.key('\x1b[A'), true); assert.match(selectedRow()!, /▏ s-7f3a/);
  assert.equal(screen.key('\x1b[A'), true); assert.match(selectedRow()!, /▏ s-7f3a/, 'Up stops at the first row');
  assert.equal(screen.key('a'), false, 'a typed character goes to the input'); assert.equal(selectedRow(), undefined, 'and clears the selection');
  screen.key('\x1b[A'); assert.match(selectedRow()!, /▏ s-5e9b/, 'Up from no selection selects the last row');
  assert.equal(screen.key('\x1b'), true); assert.equal(selectedRow(), undefined, 'Esc clears the selection');
  screen.key('\x1b[B'); assert.equal(screen.key('\r'), true);
  assert.deepEqual(opened, ['s-7f3a']); assert.equal(selectedRow(), undefined);
  // The selected row carries bg.selected in colour tiers and reverse video without colour.
  screen.key('\x1b[B');
  const grid = captureSnapshot(renderWelcome(facts, 132, 30, now, 'truecolor', 's-7f3a').lines, 132, 30, 'truecolor');
  const row = grid.rows.find(cells => cells.map(c => c.char).join('').includes('s-7f3a'))!;
  assert.ok(row.filter(c => c.char !== ' ').every(c => c.bg === 'bg.selected'));
  assert.ok(captureSnapshot(renderWelcome(facts, 132, 30, now, 'none', 's-7f3a').lines, 132, 30, 'none').rows.some(cells => cells.some(c => c.char === '▏' && c.reverse)));
});

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-welcome-'))), workspace = join(root, 'project');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'Fixture\n');
  return { root, workspace, dataRoot: join(root, 'data') };
}

test('recent sessions come from session derivation: status of the last run, the branch session on its own row', async () => {
  const f = project(), base = { workspace: f.workspace, dataRoot: f.dataRoot, mode: 'offline' as const };
  const first = await runReadTask({ ...base, input: 'First task line\nsecond line', transport: demoTransport().fetch });
  // The earliest continuation stays in the session and is its last run; it fails.
  const failed = await runReadTask({ ...base, input: 'Continue and fail', contextRunId: first.runId, transport: async () => new Response('down', { status: 500 }) });
  assert.equal(failed.status, 'failed');
  // A second continuation of the same run starts a branch session.
  const branch = await runReadTask({ ...base, input: 'Alternative continuation', contextRunId: first.runId, transport: demoTransport().fetch });
  const index = readDisplayIndex(f.dataRoot);
  const read = readWelcomeFacts({ ...base, coding: false }, id => index.label('session', id), TIPS[1]);
  assert.ok(Array.isArray(read.sessions));
  assert.deepEqual(read.sessions.map(s => [s.label, s.input, s.status]), [
    [index.label('session', branch.sessionId), 'Alternative continuation', 'completed'],
    [index.label('session', first.sessionId), 'First task line', 'failed'],
  ]);
  const text = plain(renderWelcome({ ...read, lock: { state: 'readonly' } }, 132, 30).lines).join('\n');
  assert.match(text, new RegExp(`${index.label('session', first.sessionId)} +First task line +✗ 失败`));
  assert.match(text, new RegExp(`${index.label('session', branch.sessionId)} +Alternative continuation +✓ 完成`));
  assert.match(read.execution, /^build [0-9a-f]{7} · deps [0-9a-f]{4} · 指令 [0-9a-f]{4} · 1 tool$/);
  // Other workspaces' sessions are not listed.
  assert.deepEqual(readWelcomeFacts({ ...base, workspace: join(f.root, 'elsewhere'), coding: false }, id => id, TIPS[1]).sessions, []);
});

function app(f: ReturnType<typeof project>, terminal: TestTerminal, coding = true) {
  const tui = new ReadOnlyTui({ workspace: f.workspace, dataRoot: f.dataRoot, draftRoot: join(f.root, 'drafts'), mode: 'offline', transport: demoTransport().fetch, terminal, widthCalibration: false, copy: async () => true, coding });
  tui.start(); return tui;
}

test('80×24 and 40×12 do not overflow and keep the elements U1 always retains', async () => {
  for (const [columns, rows] of [[132, 38], [80, 24], [40, 12]]) {
    const f = project(), terminal = new TestTerminal(columns, rows), tui = app(f, terminal);
    try {
      await until(() => tui.screen().some(line => line.includes('写入者锁可取得')), `lock probe at ${columns}×${rows}`);
      const screen = plain(tui.screen());
      assert.equal(screen.length, rows);
      for (const line of screen) assert.ok(visibleWidth(line) <= columns, `${columns}×${rows} overflow: ${line}`);
      const text = screen.join('\n');
      assert.ok(text.includes('◢◣') || text.includes('◆ pi·durio'), `mark at ${columns}×${rows}\n${text}`);
      for (const kept of ['工作区', '写入者锁可取得', '模型', 'deepseek-flash', '○ 空闲', '? 帮助']) assert.ok(text.includes(kept), `${kept} at ${columns}×${rows}\n${text}`);
      // Input box: the two rules with the placeholder between them.
      assert.ok(screen.filter(line => /^ *─+ *$/.test(line)).length >= 2, text);
      assert.match(text, /描述要完成的修改/);
    } finally { await tui.exit(); }
  }
});

test('the probe takes no lock; a held writer lock shows its holder', async () => {
  const f = project(), terminal = new TestTerminal(), tui = app(f, terminal);
  try {
    await until(() => tui.screen().some(line => line.includes('写入者锁可取得')), 'free lock');
    // Another instance can still take the lock while the welcome screen is open.
    const lease = await acquireWorkspaceOwner(f.workspace, () => {});
    await lease.release();
  } finally { await tui.exit(); }
  const other = project(), lease = await acquireWorkspaceOwner(other.workspace, () => {});
  const held = app(other, new TestTerminal());
  try {
    await until(() => held.screen().some(line => line.includes('被占用')), 'held lock');
    const text = plain(held.screen()).join('\n');
    assert.match(text, new RegExp(`✗ 被占用 · pid ${process.pid}`));
    assert.match(text, /恢复：等持有者结束后重开/);
  } finally { await held.exit(); await lease.release(); }
  const readonly = app(project(), new TestTerminal(), false);
  try { assert.match(plain(readonly.screen()).join('\n'), /只读 · 不取写入者锁/); } finally { await readonly.exit(); }
});

test('in the app, Up/Down reach the recent sessions only while the input is empty; Enter opens the session layer', async () => {
  const f = project();
  await runReadTask({ workspace: f.workspace, dataRoot: f.dataRoot, mode: 'offline', input: 'Earlier task', transport: demoTransport().fetch });
  const terminal = new TestTerminal(132, 38), tui = app(f, terminal, false);
  try {
    await until(() => plain(tui.screen()).some(line => line.includes('Earlier task')), 'recent session listed');
    terminal.input('x'); terminal.input('\x1b[B');
    assert.ok(!plain(tui.screen()).some(line => line.includes('▏')), 'a draft keeps Up/Down in the input');
    terminal.input('\x7f'); terminal.input('\x1b[B');
    assert.ok(plain(tui.screen()).some(line => /▏ s-[0-9a-f]{4,} +Earlier task/.test(line)), plain(tui.screen()).join('\n'));
    terminal.input('\r');
    await until(() => plain(tui.screen()).some(line => /◆ history {2}s-/.test(line)), 'session layer opened');
  } finally { await tui.exit(); }
});

test('after the first task is accepted the welcome screen does not come back', async () => {
  const f = project(), terminal = new TestTerminal(), tui = app(f, terminal, false);
  try {
    assert.ok(plain(tui.screen()).some(line => line.includes('◢◣')));
    terminal.input('Read README.md'); terminal.input('\r');
    await until(() => !tui.screen().some(line => line.includes('◢◣') || line.includes('pi·durio')), 'welcome gone');
    await until(() => plain(tui.screen()).some(line => line.includes('✓ 完成')), 'task completed', 120000);
    await wait(200);
    const text = plain(tui.screen()).join('\n');
    assert.doesNotMatch(text, /◢◣|pi·durio|最近会话|Tip:/);
    assert.match(text, /◆ pi-durio .* 只读 · 任务 1 · ✓ 完成/);
  } finally { await tui.exit(); }
});
