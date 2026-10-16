import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  ConfirmDialog, LoadingState, PresetFilter, TOO_SMALL_TO_CONFIRM,
  fixedFrame, hintLine, statusEmpty, statusError, truncateMiddle, viewKey, widthTier, wrapAuthorized, escHint,
} from '../src/tui/view-stack.js';
import { captureSnapshot, snapshotText, type SnapshotGrid } from '../src/tui/snapshot.js';

const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Text golden: each row's characters, then its style runs (fg/bg/bold). Missing goldens are written on first run. */
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

const longBody = Array.from({ length: 30 }, (_, i) => `正文第 ${i + 1} 行 · 中间各行在框内滚动`);
const fixedLines = ['影响：删除 3 个会话存储 · 不可撤销 · 宿主记录保留，trace 中对应原文标“已清理”', '费用：不调用模型 · ≤ 0 请求 · ≈¥0'];

test('view-layer global keys follow T6: Esc back, Ctrl+C stop, Ctrl+L redraw, others inert', () => {
  assert.equal(viewKey('\x1b'), 'back');
  assert.equal(viewKey('\x03'), 'stop');
  assert.equal(viewKey('\x0c'), 'redraw');
  for (const key of ['\x04', '\x0f', '\x14', '\x12', '?']) assert.equal(viewKey(key), 'inert', JSON.stringify(key));
  for (const key of ['a', '\r', ' ', '1', '/', '\x1b[A']) assert.equal(viewKey(key), undefined, JSON.stringify(key));
  assert.equal(escHint(1), 'Esc 返回会话'); assert.equal(escHint(2), 'Esc 返回上层');
});

test('confirm dialog keeps fixed lines at 80x24 and 40x12 while the middle scrolls inside the box', () => {
  for (const [columns, rows] of [[80, 24], [40, 12]]) {
    const dialog = new ConfirmDialog({ title: '删除会话存储', action: '删除', body: longBody, fixed: fixedLines });
    const lines = plain(dialog.render(columns, rows));
    const width = Math.min(columns - 4, 88);
    assert.ok(lines.length <= rows, `${columns}x${rows} fits`);
    for (const line of lines) assert.equal(visibleWidth(line), width, `${columns}x${rows}: ${line}`);
    assert.match(lines[0], /^╭─+╮$/); assert.match(lines.at(-1)!, /^╰─+╯$/);
    assert.match(lines[1], /删除会话存储/);
    assert.match(lines.at(-2)!, /Enter 删除 · Esc 取消/);
    // Authorization content wraps, never truncates: every fixed character is present.
    const joined = lines.map(line => line.slice(2, -2)).join('').replace(/\s/g, '');
    for (const text of fixedLines) assert.ok(joined.includes(text.replace(/\s/g, '')), `${columns}x${rows} keeps ${text}`);
    assert.ok(!lines.join('\n').includes('正文第 30 行'), 'body scrolls instead of pushing fixed lines out');
    for (let i = 0; i < 40; i++) dialog.handleInput('\x1b[B');
    const scrolled = plain(dialog.render(columns, rows));
    assert.ok(scrolled.join('\n').includes('正文第 30 行'));
    assert.ok(scrolled.map(line => line.slice(2, -2)).join('').replace(/\s/g, '').includes('不可撤销'), 'fixed lines stay while scrolled');
    assert.equal(dialog.handleInput('\r').type, 'confirm');
  }
  assert.equal(ConfirmDialog.width(132), 88); assert.equal(ConfirmDialog.width(80), 76); assert.equal(ConfirmDialog.width(40), 36);
});

test('confirm dialog disables Enter with the reason on the last line when fixed lines cannot fit or a conflict exists', () => {
  const small = new ConfirmDialog({ title: '删除', action: '删除', body: longBody, fixed: fixedLines });
  const lines = plain(small.render(40, 6));
  assert.ok(lines.length <= 6);
  assert.ok(lines.slice(-3, -1).map(line => line.slice(2, -2)).join('').replace(/\s/g, '').includes(`Enter${TOO_SMALL_TO_CONFIRM}·Esc取消`), 'the reason wraps instead of dropping Esc');
  assert.equal(small.handleInput('\r').type, 'noop');
  assert.equal(small.handleInput('\x1b').type, 'cancel');
  // Growing the window re-enables Enter.
  small.render(80, 24); assert.equal(small.handleInput('\r').type, 'confirm');

  // Bind the style contract to explicit tiers instead of the shell's color environment.
  for (const [tier, enterStyle] of [
    ['truecolor', /\x1b\[38;2;65;65;65mEnter /],
    ['256color', /\x1b\[38;5;238mEnter /],
    ['none', /\x1b\[2mEnter /],
  ] as const) {
    const conflict = new ConfirmDialog({ title: '启动 eval', action: '启动', fixed: ['≤ 24 请求 · ≈¥0.40'], disabled: '截止时间已过' });
    const conflictLines = conflict.render(80, 24, tier);
    assert.match(plain(conflictLines).at(-2)!, /Enter 截止时间已过 · Esc 取消/);
    assert.match(conflictLines.at(-2)!, enterStyle, `${tier}: disabled Enter uses fg.gutter`);
    assert.equal(conflict.handleInput('\r').type, 'noop');
  }
});

test('single choice uses digits and ◉/○; multi choice uses space, ↑↓ and [✓]/[ ], skipping disabled options', () => {
  const single = new ConfirmDialog({ title: '恢复处置', action: '确认', choice: { mode: 'single', options: [{ label: '重新核对' }, { label: '释放锁', disabled: '持有者仍在运行' }, { label: '结束旧工作' }], selected: [0] } });
  assert.match(plain(single.render(80, 24)).join('\n'), /◉ 1 重新核对[\s\S]*○ 2 释放锁 · 不可选 · 持有者仍在运行[\s\S]*○ 3 结束旧工作/);
  assert.equal(single.handleInput('2').type, 'noop');
  assert.equal(single.handleInput('3').type, 'handled');
  assert.deepEqual(single.handleInput('\r'), { type: 'confirm', selected: [2] });

  const multi = new ConfirmDialog({ title: '重评分', action: '重评分', choice: { mode: 'multi', options: [{ label: 'case-a ?' }, { label: 'case-b', disabled: '未运行' }, { label: 'case-c' }], selected: [0] }, disabled: selected => selected.length ? undefined : '尚未选择' });
  assert.match(plain(multi.render(80, 24)).join('\n'), /\[✓\] case-a[\s\S]*\[ \] case-c/);
  multi.handleInput(' '); assert.match(plain(multi.render(80, 24)).at(-2)!, /Enter 尚未选择/);
  assert.equal(multi.handleInput('\r').type, 'noop');
  multi.handleInput('\x1b[B'); multi.handleInput(' ');
  assert.deepEqual(multi.handleInput('\r'), { type: 'confirm', selected: [2] }, '↓ skips the disabled option');
});

test('loading state appears only after 200ms; Esc cancellation discards the result', async () => {
  let renders = 0;
  const fast = new LoadingState('统计', '数据根', () => renders++);
  assert.equal(await fast.track(wait(50).then(() => 'done')), 'done');
  await wait(220); assert.equal(fast.isShowing, false); assert.equal(renders, 0, 'fast work never shows a loading state');

  const slow = new LoadingState('统计', '数据根', () => renders++);
  const result = slow.track(wait(400).then(() => 'late'));
  await wait(260); assert.equal(slow.isShowing, true); assert.ok(renders > 0);
  assert.match(stripTerminalSequences(slow.renderLine(40)), /^⠋|^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 统计中 · 数据根/);
  slow.cancel(); assert.equal(slow.isShowing, false);
  assert.equal(await result, undefined, 'result after Esc is discarded');
  const failing = new LoadingState('核对', undefined, () => {});
  await assert.rejects(failing.track(Promise.reject(Error('BOOM'))), /BOOM/);
});

test('hint line keeps Esc rightmost, drops from its left, and instant feedback replaces the hints', () => {
  const items = ['↑↓ 选择', 'Enter 打开', 'n/p 翻页'];
  assert.equal(stripTerminalSequences(hintLine(items, 60, { esc: 'Esc 返回会话' })).trimEnd(), '↑↓ 选择 · Enter 打开 · n/p 翻页 · Esc 返回会话');
  assert.equal(stripTerminalSequences(hintLine(items, 35, { esc: 'Esc 返回会话' })).trimEnd(), '↑↓ 选择 · Enter 打开 · Esc 返回会话');
  assert.equal(stripTerminalSequences(hintLine(items, 12, { esc: 'Esc 返回会话' })).trimEnd(), 'Esc 返回会话');
  assert.equal(stripTerminalSequences(hintLine(items, 60, { esc: 'Esc 返回上层', feedback: '有任务运行中，结束后再固定' })).trimEnd(), '有任务运行中，结束后再固定 · Esc 返回上层');
  assert.equal(stripTerminalSequences(hintLine(['Enter 提交', '/ 命令', 'Ctrl+R 历史', '? 帮助'], 24, { keepLast: '? 帮助' })).trimEnd(), 'Enter 提交 · ? 帮助');
});

test('narrow-terminal helpers: two breakpoints, middle path elision, wrapped authorization, fixed header and footer', () => {
  assert.deepEqual([widthTier(132), widthTier(100), widthTier(99), widthTier(60), widthTier(59), widthTier(40)], ['wide', 'wide', 'medium', 'medium', 'narrow', 'narrow']);
  const path = '/Users/someone/projects/pi-durio/.pi-durio/prompts/coding.md';
  const short = truncateMiddle(path, 24);
  assert.equal(visibleWidth(short), 24); assert.ok(short.startsWith('/Users/so')); assert.ok(short.endsWith('coding.md')); assert.ok(short.includes('…'));
  assert.equal(truncateMiddle('短路径', 10), '短路径');
  assert.ok(visibleWidth(truncateMiddle('中文路径/很长很长很长很长/文件.md', 11)) <= 11);
  const wrapped = wrapAuthorized('上限约 ¥1.20（按最坏情况预留）· ≤16 请求 · ≤10 分钟', 12);
  assert.ok(wrapped.length > 1); assert.equal(wrapped.join('').replace(/\s/g, ''), '上限约¥1.20（按最坏情况预留）·≤16请求·≤10分钟');
  const frame = fixedFrame(['head'], Array.from({ length: 10 }, (_, i) => `b${i}`), ['foot'], 5, 99);
  assert.deepEqual(frame.lines, ['head', 'b7', 'b8', 'b9', 'foot']); assert.equal(frame.offset, 7);
  assert.deepEqual(fixedFrame(['h1', 'h2'], ['b'], ['f'], 2, 0).lines, ['h1', 'f'], 'footer survives first');
});

test('error and empty states: reason code kept verbatim without control characters, no 0 or N/A', () => {
  const [line, next] = plain(statusError('范围过大 · 受理任务超过 10000 个', 'METRICS_SCOPE_TOO_LARGE\x1b[31m\x07', '/ 缩小时间或项目范围', 60));
  assert.equal(line.trimEnd(), '✗ 范围过大 · 受理任务超过 10000 个 · METRICS_SCOPE_TOO_LARGE');
  assert.equal(next.trimEnd(), '  / 缩小时间或项目范围');
  const empty = stripTerminalSequences(statusEmpty('近 7 天 · 当前项目', '日常受理样本', 60, '/ 调整范围')).trimEnd();
  assert.equal(empty, '在 近 7 天 · 当前项目 内没有 日常受理样本 · / 调整范围');
  assert.doesNotMatch(empty, /N\/A|\b0\b/);
});

test('preset filter: presets by default, input only after choosing custom; typed ? stays text', () => {
  const filter = new PresetFilter([
    { key: 'time', label: '时间', options: [{ label: '近 7 天' }, { label: '近 30 天' }, { label: '全部' }, { label: '自定义', custom: { kind: 'input', placeholder: 'MM-DD..MM-DD', validate: text => /^\d{2}-\d{2}\.\.\d{2}-\d{2}$/.test(text) ? undefined : '日期写 MM-DD..MM-DD' } }] },
    { key: 'project', label: '项目', options: [{ label: '当前' }, { label: '全部' }, { label: '列表', custom: { kind: 'list', items: ['/work/a', '/work/b'] } }] },
    { key: 'status', label: '状态', options: [{ label: '全部' }, { label: '完成' }, { label: '失败' }], selected: 0 },
  ]);
  assert.match(plain(filter.render(80)).join('\n'), /› 时间\s+◉ 近 7 天  ○ 近 30 天  ○ 全部  ○ 自定义/);
  assert.equal(filter.handleInput('2'), 'handled');
  assert.equal(filter.isEditing, false);
  filter.handleInput('4'); assert.equal(filter.handleInput('\r'), 'handled'); assert.equal(filter.isEditing, true);
  for (const c of '10-01..?') filter.handleInput(c);
  filter.handleInput('\r'); assert.match(plain(filter.render(80)).join('\n'), /✗ 日期写 MM-DD\.\.MM-DD/);
  filter.handleInput('\x7f'); for (const c of '10-08') filter.handleInput(c); filter.handleInput('\r');
  assert.equal(filter.isEditing, false);
  filter.handleInput('\x1b[B'); filter.handleInput('3');
  assert.equal(filter.handleInput('\r'), 'handled', 'unfilled list choice opens the list first');
  filter.handleInput('\x1b[B'); filter.handleInput('\r');
  assert.equal(filter.handleInput('\r'), 'apply');
  assert.deepEqual(filter.result, { time: { option: 3, value: '10-01..10-08' }, project: { option: 2, value: '/work/b' }, status: { option: 0 } });
  assert.match(plain(filter.render(80)).join('\n'), /◉ 自定义：10-01\.\.10-08/);
  // Narrow: options wrap onto aligned continuation rows instead of being cut.
  const narrow = plain(filter.render(30));
  assert.ok(narrow.length > 3); assert.ok(narrow.join('').includes('自定义：10-01..10-08'));
  assert.equal(filter.handleInput('\x1b'), 'cancel');
});

test('snapshots: confirm dialog (80x24, 40x12, too small), error and empty states', () => {
  const dialog = () => new ConfirmDialog({ title: '删除会话存储', action: '删除', body: ['将删除以下单元：', 's-3f2a · 会话存储 12 MB', 's-9c01 · 会话存储 4 MB'], choice: { mode: 'multi', options: [{ label: 's-3f2a' }, { label: 's-9c01' }, { label: '未归属附件', disabled: '仍被引用' }], selected: [0, 1] }, fixed: fixedLines });
  for (const [w, h, name] of [[80, 24, 'confirm-80x24'], [40, 12, 'confirm-40x12'], [40, 7, 'confirm-40x7-too-small']] as const)
    assertGolden(captureSnapshot(dialog().render(w, h, 'truecolor'), ConfirmDialog.width(w), h, 'truecolor'), name);
  assertGolden(captureSnapshot(statusError('范围过大 · 受理任务超过 10000 个', 'METRICS_SCOPE_TOO_LARGE', '/ 缩小时间或项目范围', 60, 'truecolor'), 60, 2, 'truecolor'), 'status-error');
  assertGolden(captureSnapshot([statusEmpty('近 7 天 · 当前项目', '日常受理样本', 60, '/ 调整范围', 'truecolor')], 60, 1, 'truecolor'), 'status-empty');
});
