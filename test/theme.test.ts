import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { HardwareCursorEditor } from '../src/tui/cursor.js';
import { demoTransport } from '../src/offline.js';
import {
  detectColorTier, overrideColorTierForTest,
  fgSgr, bgSgr, styledLine, SPINNER_FRAMES, SPINNER_INTERVAL_MS,
  statusText, GLYPHS, COLOR_TIER,
  type ColorTier,
} from '../src/tui/theme.js';
import {
  captureSnapshot, snapshotContains, linesContainSgr,
  assertMatchesGolden, type SnapshotGrid,
} from '../src/tui/snapshot.js';

// ─── TestTerminal ─────────────────────────────────────────────────────────────

class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; writes: string[] = []; stopped = false;
  input: (s:string)=>void = ()=>{}; resize: ()=>void = ()=>{};
  start(input:(s:string)=>void, resize:()=>void) { this.input=input; this.resize=resize; }
  stop() { this.stopped=true; }
  async drainInput() {}
  write(value:string) { this.writes.push(value); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {}
  clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'durio-theme-'));
  const workspace=join(root,'project'); mkdirSync(workspace);
  writeFileSync(join(workspace,'README.md'),'Fixture\n');
  const terminal=new TestTerminal();
  const transport=demoTransport();
  const app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot:join(root,'drafts'),mode:'offline',transport:transport.fetch,terminal,widthCalibration:false,copy:async()=>true});
  app.start();
  return {root,workspace,terminal,transport,app};
}

// ─── 档位判定 ──────────────────────────────────────────────────────────────────

test('detectColorTier: NO_COLOR 非空 → none', () => {
  assert.equal(detectColorTier({'NO_COLOR':'1'}), 'none');
  assert.equal(detectColorTier({'NO_COLOR':'yes','COLORTERM':'truecolor'}), 'none'); // NO_COLOR 优先
});

test('detectColorTier: COLORTERM=truecolor → truecolor', () => {
  assert.equal(detectColorTier({'COLORTERM':'truecolor'}), 'truecolor');
  assert.equal(detectColorTier({'COLORTERM':'24bit'}), 'truecolor');
  assert.equal(detectColorTier({'COLORTERM':'TRUECOLOR'}), 'truecolor'); // 大小写不敏感
});

test('detectColorTier: 其他情况 → 256color', () => {
  assert.equal(detectColorTier({}), '256color');
  assert.equal(detectColorTier({'COLORTERM':'256color'}), '256color');
  assert.equal(detectColorTier({'TERM':'xterm-256color'}), '256color');
});

// ─── SGR 输出 ──────────────────────────────────────────────────────────────────

test('fgSgr truecolor 包含 38;2', () => {
  const sgr = fgSgr('fg.primary', 'truecolor');
  assert.match(sgr, /\x1b\[38;2;\d+;\d+;\d+m/, 'truecolor fg 应包含 38;2;r;g;b');
  assert.match(sgr, /225;225;225/, 'fg.primary hex #e1e1e1 = 225');
});

test('bgSgr truecolor 包含 48;2', () => {
  const sgr = bgSgr('bg.base', 'truecolor');
  assert.match(sgr, /\x1b\[48;2;20;20;20m/, 'bg.base #141414 = 20,20,20');
});

test('fgSgr 256color 包含 38;5', () => {
  const sgr = fgSgr('fg.primary', '256color');
  assert.match(sgr, /\x1b\[38;5;\d+m/, '256color fg 应包含 38;5;n');
});

test('bgSgr 256color 背景层顺序正确', () => {
  assert.match(bgSgr('bg.base', '256color'), /\x1b\[48;5;233m/);
  assert.match(bgSgr('bg.zebra', '256color'), /\x1b\[48;5;234m/);
  assert.match(bgSgr('bg.block', '256color'), /\x1b\[48;5;235m/);
  assert.match(bgSgr('bg.selected', '256color'), /\x1b\[48;5;236m/);
});

test('bgSgr none 不输出颜色', () => {
  const sgr = bgSgr('bg.base', 'none');
  assert.equal(sgr, '', '无色档不应有 bg SGR');
});

test('fgSgr none 使用属性替代颜色', () => {
  const sgr = fgSgr('fg.label', 'none');
  assert.match(sgr, /\x1b\[2m/, 'fg.label 无色档应输出 dim');
});

test('fgSgr none 无颜色属性的 token 返回空', () => {
  const sgr = fgSgr('fg.primary', 'none');
  assert.equal(sgr, '', 'fg.primary 无色档无替代属性');
});

// ─── 256 色 drop ───────────────────────────────────────────────────────────────

test('bg.diffDel 和 bg.diffAdd 在 256 色档不输出颜色', () => {
  assert.equal(bgSgr('bg.diffDel', '256color'), '');
  assert.equal(bgSgr('bg.diffAdd', '256color'), '');
});

// ─── styledLine ────────────────────────────────────────────────────────────────

test('styledLine truecolor 输出含 38;2 和 48;2', () => {
  const line = styledLine([{text:'pi-durio',fg:'fg.primary'}], 20, undefined, 'truecolor');
  assert.match(line, /38;2/, 'styledLine truecolor 应含 38;2 前景');
  assert.match(line, /48;2/, 'styledLine truecolor 应含 48;2 背景（bg.base fill）');
});

test('styledLine 256color 输出含 38;5 和 48;5', () => {
  const line = styledLine([{text:'pi-durio',fg:'fg.primary'}], 20, undefined, '256color');
  assert.match(line, /38;5/, 'styledLine 256color 应含 38;5 前景');
  assert.match(line, /48;5/, 'styledLine 256color 应含 48;5 背景');
});

test('styledLine none 不输出颜色 SGR', () => {
  const line = styledLine([{text:'pi-durio',fg:'fg.primary'}], 20, undefined, 'none');
  assert.doesNotMatch(line, /38;[25]|48;[25]/, '无色档不应有颜色 SGR');
});

test('styledLine 填满宽度', () => {
  const line = styledLine([{text:'AB'}], 10, undefined, 'truecolor');
  const plain = stripTerminalSequences(line);
  assert.equal(plain.length, 10, 'styledLine 应填满指定宽度');
});

// ─── 状态字形 ──────────────────────────────────────────────────────────────────

test('statusText idle 包含 ○ 字形', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('idle', false, undefined, 0, '', tier);
    assert.ok(text.includes(GLYPHS.idle), `idle 状态应含 ○（tier=${tier}）`);
  }
});

test('statusText completed 包含 ✓ 字形', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('idle', false, {status:'completed'}, 0, '', tier);
    assert.ok(text.includes(GLYPHS.ok), `completed 状态应含 ✓（tier=${tier}）`);
  }
});

test('statusText failed 包含 ✗ 字形', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('idle', false, {status:'failed'}, 0, '', tier);
    assert.ok(text.includes(GLYPHS.err), `failed 状态应含 ✗（tier=${tier}）`);
  }
});

test('statusText aborted 包含 ◇ 字形', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('idle', false, {status:'aborted'}, 0, '', tier);
    assert.ok(text.includes(GLYPHS.aborted), `aborted 状态应含 ◇（tier=${tier}）`);
  }
});

test('statusText recovery 包含 ◈ 字形', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('idle', true, undefined, 0, '', tier);
    assert.ok(text.includes(GLYPHS.warn), `recovery 状态应含 ◈（tier=${tier}）`);
  }
});

test('statusText running 包含 spinner 帧', () => {
  for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
    const text = statusText('running', false, undefined, 3, '', tier);
    assert.ok(SPINNER_FRAMES.some(f => text.includes(f)), `running 状态应含 spinner 帧（tier=${tier}）`);
  }
});

// ─── spinner ───────────────────────────────────────────────────────────────────

test('SPINNER_FRAMES 恰好 10 帧', () => {
  assert.equal(SPINNER_FRAMES.length, 10);
});

test('SPINNER_INTERVAL_MS 为 80', () => {
  assert.equal(SPINNER_INTERVAL_MS, 80);
});

test('SPINNER_FRAMES 包含 braille 字符', () => {
  for (const frame of SPINNER_FRAMES) {
    const cp = frame.codePointAt(0)!;
    assert.ok(cp >= 0x2800 && cp <= 0x28FF, `${frame} 应是 braille 字符（U+28xx）`);
  }
});

// ─── 会话屏快照（SGR 验证） ────────────────────────────────────────────────────

test('会话屏 truecolor 档快照包含 38;2 和 48;2', async () => {
  const saved = COLOR_TIER;
  overrideColorTierForTest('truecolor');
  try {
    const f = fixture();
    try {
      const lines = f.app.screen();
      assert.ok(linesContainSgr(lines, /38;2/), '真彩色档应含 38;2（前景）');
      assert.ok(linesContainSgr(lines, /48;2/), '真彩色档应含 48;2（背景）');
    } finally { await f.app.exit(); }
  } finally { overrideColorTierForTest(saved); }
});

test('会话屏 256color 档快照包含 38;5 和 48;5，背景层编号正确', async () => {
  const saved = COLOR_TIER;
  overrideColorTierForTest('256color');
  try {
    const f = fixture();
    try {
      const lines = f.app.screen();
      assert.ok(linesContainSgr(lines, /38;5/), '256色档应含 38;5（前景）');
      assert.ok(linesContainSgr(lines, /48;5/), '256色档应含 48;5（背景）');
      // bg.base 应为 233
      assert.ok(linesContainSgr(lines, /48;5;233/), '256色档背景层基础应为 233（bg.base）');
    } finally { await f.app.exit(); }
  } finally { overrideColorTierForTest(saved); }
});

test('会话屏 none 档快照不含颜色 SGR', async () => {
  const saved = COLOR_TIER;
  overrideColorTierForTest('none');
  try {
    const f = fixture();
    try {
      const lines = f.app.screen();
      const hasColor = linesContainSgr(lines, /38;[25]|48;[25]/);
      assert.ok(!hasColor, '无色档不应有颜色 SGR');
    } finally { await f.app.exit(); }
  } finally { overrideColorTierForTest(saved); }
});

// ─── 任何档位下状态字形存在（快照断言） ──────────────────────────────────────

for (const tier of ['truecolor','256color','none'] as ColorTier[]) {
  test(`会话屏 ${tier} 档快照包含状态字形`, async () => {
    const saved = COLOR_TIER;
    overrideColorTierForTest(tier);
    try {
      const f = fixture();
      try {
        const lines = f.app.screen();
        const combined = lines.join('');
        const plainText = stripTerminalSequences(combined);
        // idle 状态应有 ○
        assert.ok(plainText.includes(GLYPHS.idle), `${tier} 档应有 ○（idle 字形）`);
      } finally { await f.app.exit(); }
    } finally { overrideColorTierForTest(saved); }
  });
}

// ─── 快照工具：字符网格与 golden ──────────────────────────────────────────────

test('captureSnapshot 解析 ANSI 行并标注 token', () => {
  const line = styledLine([{text:'pi',fg:'fg.primary'},{text:'-durio',fg:'fg.faint'}], 20, undefined, 'truecolor');
  const grid = captureSnapshot([line], 20, 1, 'truecolor');
  assert.equal(grid.rows.length, 1);
  assert.equal(grid.rows[0].length, 20);
  // 前两字符 'p' 和 'i' 应有 fg.primary token
  assert.equal(grid.rows[0][0].char, 'p');
  assert.equal(grid.rows[0][0].fg, 'fg.primary');
});

test('captureSnapshot none 档不标 token', () => {
  const line = styledLine([{text:'hello',fg:'fg.primary'}], 10, undefined, 'none');
  const grid = captureSnapshot([line], 10, 1, 'none');
  // 无色档没有颜色 token
  for (const cell of grid.rows[0]) {
    assert.ok(!cell.fg || !cell.fg.includes(';2;'), '无色档不应有颜色 token');
  }
});

test('assertMatchesGolden 初次运行保存 golden，再次运行通过', () => {
  const tmpDir = mkdtempSync(join(tmpdir(),'durio-golden-'));
  const goldenPath = join(tmpDir, 'test.golden.json');
  const line = styledLine([{text:'hello'}], 10, undefined, 'truecolor');
  const grid = captureSnapshot([line], 10, 1, 'truecolor');

  // 初次：golden 不存在时保存
  assert.ok(!existsSync(goldenPath));
  assertMatchesGolden(grid, goldenPath);
  assert.ok(existsSync(goldenPath), 'golden 应已创建');

  // 再次：与 golden 一致应通过
  assertMatchesGolden(grid, goldenPath);
});

test('assertMatchesGolden 内容不一致时抛出差异', () => {
  const tmpDir = mkdtempSync(join(tmpdir(),'durio-golden-'));
  const goldenPath = join(tmpDir, 'mismatch.golden.json');
  const line1 = styledLine([{text:'hello'}], 10, undefined, 'truecolor');
  const line2 = styledLine([{text:'world'}], 10, undefined, 'truecolor');
  const grid1 = captureSnapshot([line1], 10, 1, 'truecolor');
  const grid2 = captureSnapshot([line2], 10, 1, 'truecolor');

  assertMatchesGolden(grid1, goldenPath); // 保存
  assert.throws(() => assertMatchesGolden(grid2, goldenPath), /Snapshot mismatch/);
});

test('snapshotContains 能检测字形', () => {
  const line = styledLine([{text:`${GLYPHS.ok} 已完成`}], 20, undefined, 'truecolor');
  const grid = captureSnapshot([line], 20, 1, 'truecolor');
  assert.ok(snapshotContains(grid, GLYPHS.ok));
  assert.ok(!snapshotContains(grid, GLYPHS.err));
});
