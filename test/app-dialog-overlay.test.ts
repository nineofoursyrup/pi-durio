import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { captureSnapshot } from '../src/tui/snapshot.js';
import { dimForOverlay, styledLine, overrideColorTierForTest } from '../src/tui/theme.js';
import type { ConfirmConfig } from '../src/tui/view-stack.js';
import { ImproveLaunchDialog } from '../src/tui/improve-launch.js';

class TestTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false;
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('app dialog dims session and full-view backgrounds, and yields to the small-window notice', async () => {
  overrideColorTierForTest('truecolor');
  const root = mkdtempSync(join(tmpdir(), 'durio-app-overlay-')), workspace = join(root, 'project'); mkdirSync(workspace);
  const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', coding: false, terminal, widthCalibration: false });
  const text = () => app.screen().map(stripTerminalSequences).join('\n');
  const config: ConfirmConfig = { title: '确认测试动作', action: '继续', body: ['固定的测试说明'], fixed: ['只检查弹层 · 不计费'] };
  const open = () => (app as any).openConfirm(config, () => {});
  function assertDimmedHeader(title: string) {
    const lines = app.screen(), row = lines.find(line => stripTerminalSequences(line).includes(title));
    assert.ok(row, `missing header ${title}`);
    const cells = captureSnapshot([row], terminal.columns, 1, 'truecolor').rows[0].filter(cell => cell.char.trim());
    assert.ok(cells.length);
    for (const cell of cells) { assert.equal(cell.fg, 'fg.gutter'); assert.equal(cell.bg, undefined); assert.equal(cell.bold, undefined); }
  }
  try {
    app.start(); assert.match(text(), /pi·durio/);
    open(); assert.match(text(), /确认测试动作/); assertDimmedHeader('pi·durio');
    terminal.input('\x1b'); terminal.input('/help'); terminal.input('\r');
    assert.match(text(), /^帮助/);
    open(); assertDimmedHeader('帮助');
    terminal.columns = 39; terminal.rows = 11; terminal.resize();
    assert.match(text(), /窗口过小/); assert.match(text(), /Esc 关闭确认框/); assert.doesNotMatch(text(), /Ctrl\+C 中止/); assert.doesNotMatch(text(), /确认测试动作|^帮助/m);
    terminal.columns = 132; terminal.rows = 38; terminal.resize();
    assert.match(text(), /确认测试动作/); assertDimmedHeader('帮助');
  } finally { await app.exit(); }
});

test('hidden or newly undersized dialogs cannot confirm after a terminal resize, including nested source removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-app-hidden-dialog-')), workspace = join(root, 'project'); mkdirSync(workspace);
  const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', coding: false, terminal, widthCalibration: false });
  const text = () => app.screen().map(stripTerminalSequences).join('\n');
  let confirmed = 0, removed = 0;
  try {
    app.start();
    for (const [columns, rows] of [[40, 6], [39, 38], [40, 12]]) {
      terminal.columns = 132; terminal.rows = 38; terminal.resize();
      (app as any).openConfirm({ title: '授权边界', action: '继续', fixed: Array.from({ length: 5 }, () => '影响与费用上限必须完整显示给用户后才能确认') }, () => confirmed++);
      assert.match(text(), /授权边界/);
      terminal.columns = columns; terminal.rows = rows; terminal.resize();
      // Enter can arrive before the pending redraw, so no screen() call here.
      terminal.input('\r'); assert.equal(confirmed, 0);
      terminal.input('\x1b');
      terminal.columns = 132; terminal.rows = 38; terminal.resize();
      assert.doesNotMatch(text(), /授权边界/);
    }
    const registration = { id: 'registered-eval', workspace, kind: 'eval-asset' as const, root: workspace, paths: ['cases.json'], fingerprints: [], registeredAt: new Date(0).toISOString() };
    const box = new ImproveLaunchDialog({ visible: { project: [], enabled: [], files: 0, omitted: 0, taskType: null }, registrations: [registration], queued: false, register: () => registration, remove: () => removed++, complete: value => ({ text: value, matches: 0 }) });
    (app as any).openDialog(box, () => confirmed++);
    terminal.input('\x1b[B'); terminal.input('\x1b[B'); terminal.input('\x1b[3~');
    assert.match(text(), /移除来源登记/);
    terminal.columns = 40; terminal.rows = 6; terminal.resize();
    assert.match(text(), /窗口过小/);
    terminal.input('\r'); assert.equal(removed, 0); assert.equal(confirmed, 0);
    terminal.input('\x1b');
    terminal.columns = 132; terminal.rows = 38; terminal.resize();
    assert.match(text(), /新建 improve 分析/); assert.doesNotMatch(text(), /移除来源登记/);
    terminal.input('\x1b[3~'); assert.match(text(), /移除来源登记/);
    terminal.input('\r'); assert.equal(removed, 1); assert.equal(confirmed, 0);
  } finally { await app.exit(); }
});

for (const tier of ['truecolor', '256color', 'none'] as const) test(`full-screen confirmation dims every background cell after padding (${tier})`, async () => {
  overrideColorTierForTest(tier);
  const root = mkdtempSync(join(tmpdir(), 'durio-full-overlay-')), workspace = join(root, 'project'); mkdirSync(workspace);
  const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', coding: false, terminal, widthCalibration: false });
  try {
    app.start(); terminal.input('/help'); terminal.input('\r');
    (app as any).openConfirm({ title: '确认最终帧', action: '继续', body: ['固定说明'] }, () => {});
    const grid = captureSnapshot(app.screen(), terminal.columns, terminal.rows, tier);
    const top = grid.rows.findIndex(row => row.some(cell => cell.char === '╭'));
    const bottom = grid.rows.findIndex(row => row.some(cell => cell.char === '╰'));
    assert.ok(top >= 0 && bottom > top);
    const left = grid.rows[top].findIndex(cell => cell.char === '╭'), right = grid.rows[top].findIndex(cell => cell.char === '╮');
    assert.ok(right > left);
    let textCells = 0;
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      if (y >= top && y <= bottom && x >= left && x <= right) continue;
      const cell = grid.rows[y][x];
      assert.equal(cell.bg, undefined, `background at ${x},${y}`);
      if (cell.char.trim()) {
        textCells++;
        if (tier === 'none') assert.equal(cell.dim, true, `text dim at ${x},${y}`);
        else assert.equal(cell.fg, 'fg.gutter', `text color at ${x},${y}`);
      }
    }
    assert.ok(textCells > 0);
    const padding = captureSnapshot([dimForOverlay(styledLine([], 8, 'bg.base', tier), tier)], 8, 1, tier);
    assert.ok(padding.rows[0].every(cell => cell.bg === undefined));
  } finally { await app.exit(); overrideColorTierForTest('truecolor'); }
});


test('the exit draft panel yields to the undersized-window notice and returns after resize', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-exit-overlay-')), workspace = join(root, 'project'); mkdirSync(workspace);
  const terminal = new TestTerminal(), app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', coding: false, terminal, widthCalibration: false });
  const text = () => app.screen().map(stripTerminalSequences).join('\n');
  try {
    app.start(); terminal.input('draft'); terminal.input('\x03'); terminal.input('/exit'); terminal.input('\r');
    assert.match(text(), /退出并保留草稿/);
    terminal.columns = 39; terminal.rows = 11; terminal.resize();
    assert.match(text(), /窗口过小/); assert.doesNotMatch(text(), /退出并保留草稿/);
    terminal.columns = 132; terminal.rows = 38; terminal.resize();
    assert.match(text(), /退出并保留草稿/);
  } finally { await app.exit(); }
});
