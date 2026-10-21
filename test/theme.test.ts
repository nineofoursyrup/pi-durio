import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CombinedAutocompleteProvider, CURSOR_MARKER, TuiAltScreen, stripTerminalSequences, truncateToWidth, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { HardwareCursorEditor } from '../src/tui/cursor.js';
import { disabledInputLines } from '../src/tui/recovery.js';
import { demoTransport } from '../src/offline.js';
import {
  detectColorTier, overrideColorTierForTest,
  fgSgr, bgSgr, styledLine, SPINNER_FRAMES, SPINNER_INTERVAL_MS,
  dimForOverlay, GLYPHS, COLOR_TIER,
  type ColorTier, type TokenName,
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

test('styledLine none keeps selected rows reversed across segments and padding, with explicit background overrides', () => {
  const line = styledLine([{text:'A',fg:'fg.label',bold:true},{text:'B'},{text:'C',bg:'bg.base'},{text:'D'}], 6, 'bg.selected', 'none');
  const cells = captureSnapshot([line, styledLine([{text:'E',bg:'bg.selected'},{text:'F'}],6,undefined,'none')], 6, 2, 'none').rows;
  assert.deepEqual(cells[0].map(cell=>!!cell.reverse), [true,true,false,true,true,true]);
  assert.deepEqual(cells[1].map(cell=>!!cell.reverse), [true,false,false,false,false,false]);
  assert.equal(cells[0][0].dim,true); assert.equal(cells[0][0].bold,true);
  assert.equal(!!cells[0][1].dim,false); assert.equal(!!cells[0][1].bold,false);
  assert.doesNotMatch(line, /\x1b\[(?:[349][0-9]|(?:38|48);)[^m]*m/);
  assert.ok(line.endsWith('\x1b[0m'),'selection cannot leak to the next line');
});

test('styledLine 填满宽度', () => {
  const line = styledLine([{text:'AB'}], 10, undefined, 'truecolor');
  const plain = stripTerminalSequences(line);
  assert.equal(plain.length, 10, 'styledLine 应填满指定宽度');
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


test('styledLine keeps bold and dim local to each segment and clears both for padding', () => {
  for (const tier of ['truecolor', '256color', 'none'] as const) {
    const grid = captureSnapshot([styledLine([{ text: 'A', bold: true, dim: true }, { text: 'B', fg: 'fg.body' }], 4, undefined, tier)], 4, 1, tier);
    assert.equal(grid.rows[0][0].bold, true); assert.equal(grid.rows[0][0].dim, true);
    for (const cell of grid.rows[0].slice(1)) { assert.equal(cell.bold, undefined); assert.equal(cell.dim, undefined); }
  }
});

test('truncation ellipses retain the segment background, including wide-character boundaries and explicit overrides', () => {
  const cases: { text: string; width: number; expected: string; background: TokenName }[] = [
    { text: 'ABCDEFGH', width: 6, expected: 'ABC...', background: 'bg.base' },
    { text: truncateToWidth('ABCDEFGH', 6, '…'), width: 6, expected: 'ABCDE…', background: 'bg.block' },
    { text: '中中中中', width: 6, expected: '中... ', background: 'bg.base' },
    { text: truncateToWidth('中中中中', 4, '…'), width: 4, expected: '中… ', background: 'bg.block' },
  ];
  for (const tier of ['truecolor', '256color'] as const) {
    for (const entry of cases) {
      const line = styledLine([{ text: entry.text, fg: 'fg.body' }], entry.width, entry.background, tier);
      assert.equal(stripTerminalSequences(line), entry.expected);
      assert.equal(visibleWidth(line), entry.width);
      const cells = captureSnapshot([line], entry.width, 1, tier).rows[0];
      assert.ok(cells.every(cell => cell.bg === entry.background), `${tier}: ${entry.expected}`);
    }
    const line = styledLine([{ text: truncateToWidth('ABCDEFGH', 6, '…'), bg: 'bg.block' }, { text: 'Z' }], 8, 'bg.selected', tier);
    const cells = captureSnapshot([line], 8, 1, tier).rows[0];
    assert.equal(stripTerminalSequences(line), 'ABCDE…Z ');
    assert.ok(cells.slice(0, 6).every(cell => cell.bg === 'bg.block'), 'explicit code background includes the ellipsis');
    assert.ok(cells.slice(6).every(cell => cell.bg === 'bg.selected'), 'following segment and padding return to the line background');
  }
});

test('truncation background recovery leaves the no-color tier color-free and preserves its visible text', () => {
  for (const [text, width, expected] of [
    ['ABCDEFGH', 6, 'ABC...'],
    [truncateToWidth('中中中中', 4, '…'), 4, '中… '],
  ] as const) {
    const line = styledLine([{ text, fg: 'fg.body', bg: 'bg.block' }], width, 'bg.selected', 'none');
    assert.equal(stripTerminalSequences(line), expected);
    assert.equal(visibleWidth(line), width);
    assert.doesNotMatch(line, /\x1b\[(?:[0-9;]*;)?(?:38|48);/);
    assert.ok(captureSnapshot([line], width, 1, 'none').rows[0].every(cell => cell.bg === undefined));
  }
});

test('overlay dim removes selected background and original colors in every color tier', () => {
  for (const tier of ['truecolor', '256color', 'none'] as const) {
    const original = styledLine([{ text: '中文 A', fg: 'ac.err', bold: true }], 8, 'bg.selected', tier);
    const dimmed = dimForOverlay(original, tier), grid = captureSnapshot([dimmed], 8, 1, tier);
    assert.equal(stripTerminalSequences(dimmed), stripTerminalSequences(original));
    for (const cell of grid.rows[0]) { assert.equal(cell.bg, tier === 'none' ? undefined : 'bg.base'); assert.equal(cell.bold, undefined); assert.equal(cell.reverse, undefined); }
    if (tier === 'none') assert.ok(grid.rows[0].every(cell => cell.dim));
    else assert.ok(grid.rows[0].every(cell => cell.fg === 'fg.gutter'));
  }
});

test('input frames stay closed and keep their base background around text and the hardware caret', () => {
  const saved = COLOR_TIER, terminal = new TestTerminal(), tui = new TuiAltScreen(terminal, true);
  const identity = (text: string) => text;
  try {
    for (const tier of ['truecolor', '256color', 'none'] as const) {
      overrideColorTierForTest(tier);
      const editor = new HardwareCursorEditor(tui, { borderColor: text => fgSgr('border.input') + text + '\x1b[0m', selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
      editor.focused = true;
      for (const text of ['', '中é', '第一行\n第二行']) {
        editor.setText(text);
        const lines = editor.render(40), plain = lines.map(stripTerminalSequences);
        assert.match(plain[0], /^╭─+╮$/);
        assert.match(plain.at(-1)!, /^╰─+╯$/);
        assert.ok(plain.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│')));
        const grid = captureSnapshot(lines, 40, lines.length, tier);
        assert.ok(grid.rows.every(row => row.every(cell => cell.bg === (tier === 'none' ? undefined : 'bg.base'))));
      }
      editor.setText(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
      assert.match(stripTerminalSequences(editor.render(40)[0]), /^╭.*↑.*╮$/, 'hidden-line counts remain inside the rounded border');
      editor.setText('中éX'); editor.render(40);
      editor.handleMouse({ type: 'click', button: 'left', x: 5, y: 1, screenX: 5, screenY: 1, width: 40, height: 3, shift: false, alt: false, ctrl: false });
      editor.handleInput('!');
      assert.equal(editor.getText(), '中!éX', 'the new left border does not shift mouse insertion into the next grapheme');
      const disabled = disabledInputLines('保留草稿', 40, tier), grid = captureSnapshot(disabled, 40, 3, tier);
      assert.match(stripTerminalSequences(disabled[0]), /^╭─+╮$/);
      assert.match(stripTerminalSequences(disabled[2]), /^╰─+╯$/);
      if (tier === 'truecolor') {
        assert.equal(grid.rows[0][0].fg, 'border.off');
        assert.equal(grid.rows[1][1].fg, 'ac.brand');
      }
    }
  } finally { overrideColorTierForTest(saved); }
});

test('autocomplete stays above the closed input frame with aligned menu rows, base backgrounds and mouse selection', async () => {
  const saved = COLOR_TIER, terminal = new TestTerminal(), tui = new TuiAltScreen(terminal, true);
  terminal.rows = 38; terminal.columns = 60;
  const identity = (text: string) => text;
  const root = mkdtempSync(join(tmpdir(), 'durio-theme-completion-'));
  writeFileSync(join(root, 'history'), ''); writeFileSync(join(root, 'stats'), '');
  try {
    for (const tier of ['truecolor', '256color', 'none'] as const) {
      overrideColorTierForTest(tier);
      for (const prefix of ['', '第一行\n', Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行\n`).join('')]) {
        const editor = new HardwareCursorEditor(tui, {
          borderColor: text => fgSgr('border.input') + text + '\x1b[0m',
          selectList: { selectedPrefix: identity, selectedText: text => `\x1b[7m${text}\x1b[27m`, description: identity, scrollInfo: identity, noMatch: identity },
        }, { autocompleteMaxVisible: 2 });
        const menu = editor.separateAutocomplete(() => 3);
        editor.focused = true;
        editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
          { name: 'history', description: '浏览历史' }, { name: 'stats', description: '统计' },
        ], root, null));
        editor.setText(prefix);
        // Slash completion is first-line only; explicit file completion also works after scrolling.
        editor.handleInput(prefix ? './' : '/');
        if (prefix) editor.handleInput('\t');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(editor.isShowingAutocomplete(), true, 'the public provider opens the real two-item menu');
        const menuLines = menu.render(40), inputLines = editor.render(40), lines = [...menuLines, ...inputLines];
        const plain = lines.map(stripTerminalSequences), top = menuLines.length, bottom = lines.length - 1;
        assert.equal(top, 2, 'the menu component renders both candidates separately from the input frame');
        assert.match(plain[top], /^╭.*╮$/);
        assert.match(plain[bottom], /^╰.*╯$/);
        assert.ok(plain.slice(top + 1, bottom).every(line => line.startsWith('│') && line.endsWith('│')));
        if (!prefix) assert.equal(bottom - top, 2, 'single-line input keeps exactly three frame rows');
        if (prefix.split('\n').length > 20) assert.match(plain[top], /↑/, 'the scroll count remains in the frame');
        assert.ok(plain.slice(0, top).every(line => !line.startsWith('│') && !line.endsWith('│')), 'menu rows stay outside the closed frame');
        assert.ok(lines.every(line => visibleWidth(line) === 40));
        assert.match(plain[0], /^   → history/, 'the menu shares the input content column after the new left margin');
        assert.match(plain[1], /^     stats/);
        const grid = captureSnapshot(lines, 40, lines.length, tier);
        assert.ok(grid.rows.slice(0, top).every(row => row.every(cell => cell.bg === (tier === 'none' ? undefined : 'bg.base'))));
        assert.equal(grid.rows[0][3].reverse, true, 'menu selection retains its independent reverse style');
        assert.equal(lines.join('').split(CURSOR_MARKER).length - 1, 1, 'the focused editor retains one hardware cursor marker');
        assert.ok(grid.rows.slice(top + 1, bottom).every(row => row.every(cell => !cell.reverse)), 'the input has no competing painted caret');
        if (tier === 'none') assert.doesNotMatch(lines.join(''), /\x1b\[(?:[0-9;]*;)?(?:38|48);/);
        menu.handleMouse!({ type: 'click', button: 'left', x: 5, y: 1, screenX: 5, screenY: 1, width: 40, height: menuLines.length, shift: false, alt: false, ctrl: false });
        assert.equal(editor.getText(), prefix ? prefix + './stats' : '/stats ', 'clicking the second displayed item applies that completion');
        assert.equal(editor.isShowingAutocomplete(), false);
      }
    }
  } finally { overrideColorTierForTest(saved); rmSync(root, { recursive: true, force: true }); }
});

test('a compact menu adds the count for three unscrolled candidates at the product visibility setting and maps only candidate rows to clicks', async () => {
  const saved=COLOR_TIER,terminal=new TestTerminal(),tui=new TuiAltScreen(terminal,true),identity=(text:string)=>text;
  try {
    for(const tier of ['truecolor','256color','none'] as const){
      overrideColorTierForTest(tier);
      const editor=new HardwareCursorEditor(tui,{borderColor:identity,selectList:{selectedPrefix:identity,selectedText:text=>`\x1b[7m${text}\x1b[27m`,description:identity,scrollInfo:identity,noMatch:identity}},{autocompleteMaxVisible:2});
      editor.focused=true;
      const menu=editor.separateAutocomplete(()=>2);
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{name:'alpha'},{name:'bravo'},{name:'delta'}],process.cwd(),null));
      editor.handleInput('/');await new Promise<void>(resolve=>setImmediate(resolve));
      editor.handleInput('\x1b[B');
      const lines=menu.render(40),plain=lines.map(stripTerminalSequences),grid=captureSnapshot(lines,40,lines.length,tier);
      assert.equal(lines.length,2);assert.match(plain[0],/^   → bravo/);assert.match(plain[1],/^     \(2\/3\)/);
      assert.equal(grid.rows[0][3].reverse,true);
      assert.ok(grid.rows.every(row=>row.every(cell=>cell.bg===(tier==='none'?undefined:'bg.base'))));
      const mouse={type:'click' as const,button:'left' as const,x:5,y:1,screenX:5,screenY:1,width:40,height:2,shift:false,alt:false,ctrl:false};
      menu.handleMouse!(mouse);assert.equal(editor.getText(),'/','the count is not a completion target');
      menu.handleMouse!({...mouse,y:0,screenY:0});assert.equal(editor.getText(),'/bravo ','the compact row maps to the displayed candidate');
    }
  } finally {overrideColorTierForTest(saved);}
});

test('snapshots place Chinese and emoji in terminal columns and resolve quantized foreground tokens', () => {
  const grid = captureSnapshot([styledLine([{ text: '中😀e\u0301X', fg: 'ac.brand' }], 7, undefined, '256color')], 7, 1, '256color');
  assert.deepEqual(grid.rows[0].map(cell => cell.char), ['中', '', '😀', '', 'e\u0301', 'X', ' ']);
  assert.equal(grid.rows[0][0].fg, 'ac.brand'); assert.equal(grid.rows[0][5].fg, 'ac.brand');
  assert.equal(grid.rows[0][0].bg, 'bg.base');
  assert.deepEqual(captureSnapshot(['中中'], 3, 1, 'none').rows[0].map(cell => cell.char), ['中', '', ' ']);
  assert.deepEqual(captureSnapshot(['中中\x1b[0mX'], 3, 1, 'none').rows[0].map(cell => cell.char), ['中', '', ' '], 'later ANSI chunks cannot fill a clipped wide glyph');
  const framed = captureSnapshot(['\x1b_pi:c\x07\x1b[1;0m\x1b]8;;https://example.test\x07字\x1b]8;;\x07'], 2, 1, 'none').rows[0];
  assert.deepEqual(framed.map(cell => cell.char), ['字', '']); assert.equal(framed[0].bold, undefined);
});
