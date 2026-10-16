import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { records } from '../src/history.js';
import { readTrace } from '../src/trace.js';
import { RawContent, RAW_PAGE_BYTES } from '../src/trace-raw.js';
import { TraceView, type TraceHost } from '../src/tui/trace.js';
import { TraceRawView, outputItem, visibleControls } from '../src/tui/trace-raw.js';
import { overrideColorTierForTest, COLOR_TIER } from '../src/tui/theme.js';
import { readDisplayIndex } from '../src/display-number.js';
import { ReadOnlyTui } from '../src/tui/app.js';
import { scriptedTransport } from '../src/offline.js';
import type { ConfirmConfig } from '../src/tui/view-stack.js';

const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));
function withTier<T>(tier: typeof COLOR_TIER, body: () => T) { const previous = COLOR_TIER; overrideColorTierForTest(tier); try { return body(); } finally { overrideColorTierForTest(previous); } }

const runId = '22222222-3333-4444-8555-666666666666';
// 16 KiB 分块边界正好切在“中”字中间；输出含 ESC、BEL、CR 与 C1 控制字符。
const STDOUT = 'a'.repeat(RAW_PAGE_BYTES - 1) + '中文 tail\n\x1b[31mred\x1b[0m\x07bell\rover\x9bc1\n';
const ERROR_TEXT = '\x1b]0;pwned\x07Command exited with code 1';

function fixture() {
  const dataRoot = join(mkdtempSync(join(tmpdir(), 'durio-trace-raw-')), 'data');
  const e = new Evidence(dataRoot, runId);
  e.append('task.accepted', { taskId: 'task-raw', runId, sessionId: 'session-raw', authorization: { tools: ['read', 'write', 'edit', 'bash'] } });
  e.append('run.started', { taskId: 'task-raw' });
  // read：送模内容被截短（tool.summary.truncation），原文完整。
  e.append('tool.intent', { attemptId: 'r1', durableTaskId: 1, callId: 'r1', tool: 'read', args: { path: 'README.md' } });
  e.append('tool.dispatch', { attemptId: 'r1', durableTaskId: 1, tool: 'read' });
  e.append('tool.result', { attemptId: 'r1', durableTaskId: 1, result: { content: [{ type: 'text', text: 'line 1\nline 2' }] } });
  e.append('tool.summary', { attemptId: 'r1', durableTaskId: 1, truncation: { truncated: true, totalLines: 3000 } });
  // bash：stdout 两个分块，失败退出。
  e.append('tool.intent', { attemptId: 'b1', durableTaskId: 2, callId: 'b1', tool: 'bash', args: { command: 'make test\nsecond line' } });
  e.append('tool.dispatch', { attemptId: 'b1', durableTaskId: 2, tool: 'bash' });
  e.append('shell.started', { toolAttempt: { attemptId: 'b1', durableTaskId: 2 }, acquired: { command: 'make test', environmentNames: ['HOME', 'PATH'] } });
  const bytes = Buffer.from(STDOUT);
  for (let offset = 0; offset < bytes.length; offset += RAW_PAGE_BYTES)
    e.append('tool.output', { toolAttempt: { attemptId: 'b1', durableTaskId: 2 }, acquired: { stream: 'stdout', encoding: 'base64', bytes: bytes.subarray(offset, offset + RAW_PAGE_BYTES).toString('base64') } });
  e.append('shell.completed', { toolAttempt: { attemptId: 'b1', durableTaskId: 2 }, acquired: { exitCode: 1, completeness: 'complete' } });
  e.append('tool.error', { attemptId: 'b1', durableTaskId: 2, error: ERROR_TEXT });
  // write：结果原文已被显式清理。
  e.append('tool.intent', { attemptId: 'w1', durableTaskId: 3, callId: 'w1', tool: 'write', args: { path: 'out.txt', content: 'x' } });
  e.append('tool.dispatch', { attemptId: 'w1', durableTaskId: 3, tool: 'write' });
  e.append('tool.result', { attemptId: 'w1', durableTaskId: 3, result: { content: [{ type: 'text', text: 'wrote out.txt' }] } });
  e.append('run.closed', { runId, status: 'failed' });
  e.close();
  const cleaned = [...records(dataRoot, { runId, kinds: ['tool.result'] })].at(-1)!;
  const management = new Evidence(dataRoot, runId);
  management.append('evidence.availability', { sourceId: cleaned.id, state: 'cleaned', reason: 'explicit cleanup' });
  management.close();
  return dataRoot;
}

function host(busy = false) {
  const state = { feedback: [] as string[], confirms: [] as { config: ConfirmConfig; run: () => Promise<void> }[], raw: [] as string[], copied: [] as string[], busy };
  const traceHost: TraceHost = { busy: () => state.busy, feedback: text => state.feedback.push(text), confirm: (config, run) => state.confirms.push({ config, run }), changed() {}, openRaw: span => state.raw.push(span.key) };
  const rawHost = { copy: async (text: string) => { state.copied.push(text); return true as const; }, feedback: (text: string) => state.feedback.push(text), changed() {} };
  return { state, traceHost, rawHost };
}

test('raw items: decoded text, per-item state, 送模截断 note, 已清理, and UTF-8-safe 16 KiB pages', () => {
  const root = fixture(), trace = readTrace(root, runId);
  const [read, bash, write] = trace.spans.filter(span => span.kind === 'tool');
  assert.deepEqual(bash.raws.map(raw => raw.label), ['参数', 'stdout', 'stderr', '错误']);
  assert.equal(read.raws.find(raw => raw.label === '送模内容')!.note, '送模截断 · 原文完整');
  assert.equal(write.raws.find(raw => raw.label === '送模内容')!.state, 'cleaned');

  const args = new RawContent(root, bash.raws[0]).page(0);
  assert.equal(args.text, 'command:\n  make test\n  second line', 'arguments are decoded, not wrapped in JSON');
  const stdout = new RawContent(root, bash.raws[1]);
  assert.equal(stdout.pages, 2);
  assert.equal(stdout.page(0).text + stdout.page(1).text, STDOUT, 'pages split on chunk boundaries keep the multi-byte character whole');
  assert.match(stdout.page(0).text, /中$/);
  const cleaned = new RawContent(root, write.raws.find(raw => raw.label === '送模内容')!).page(0);
  assert.equal(cleaned.state, 'cleaned'); assert.equal(cleaned.text, ''); assert.match(cleaned.error!, /^已清理/);
  assert.equal(outputItem(bash), 'stdout');
  assert.equal(outputItem(read), '送模内容');
});

test('raw layer: Tab switches items, n/p pages, y copies the current page, control characters never reach the terminal', async () => {
  const root = fixture(), { state, traceHost, rawHost } = host();
  const view = new TraceView(root, runId, () => false, traceHost);
  const bash = view.trace.spans.find(span => span.tool?.name === 'bash')!;
  view.select(bash.key);
  view.handleInput('\r');
  assert.deepEqual(state.raw, [bash.key], 'Enter on a span opens the raw layer');
  const raw = new TraceRawView(root, view, bash.key, rawHost, outputItem(bash));
  const render = (width = 132, height = 30) => withTier('truecolor', () => raw.render(width, height, 'Esc 返回上层'));
  let lines = render();
  assert.equal(lines.length, 30);
  let text = plain(lines).join('\n');
  assert.match(text, /◆ trace 原文 {2}run r-\S+ · tc-\S+-02 bash · attempt 1/);
  assert.match(text, / 参数 {2} stdout {2} stderr {2} 错误 /);
  assert.match(text, /● 完整取得 · 第 1\/2 页 · 共 \d+ B/);
  assert.match(plain(lines).at(-1)!, /^Tab 切换 · ↑↓ 滚动 · n\/p 翻页 · y 复制 · Esc 返回上层 *$/);
  raw.handleInput('n');
  text = plain(render()).join('\n');
  assert.match(text, /第 2\/2 页/);
  assert.match(text, /␛\[31mred␛\[0m␇bell␍over\\x9bc1/, 'control characters are shown as visible glyphs');
  for (const line of render()) {
    const residue = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.doesNotMatch(residue, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'only our own SGR sequences reach the terminal');
  }
  raw.handleInput('n');
  assert.equal(state.feedback.at(-1), '已是最后一页');
  raw.handleInput('y'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.copied.at(-1), new RawContent(root, bash.raws[1]).page(1).text, 'y copies the original page text');
  assert.match(state.feedback.at(-1)!, /^已复制 stdout 第 2\/2 页/);
  raw.handleInput('\t');
  assert.match(plain(render()).join('\n'), /（空）/, 'an empty stderr says so');
  raw.handleInput('\t');
  text = plain(render()).join('\n'); assert.match(text, /␛\]0;pwned␇Command exited with code 1/);
  raw.handleInput('\x1b[Z'); raw.handleInput('\x1b[Z'); raw.handleInput('\x1b[Z');
  assert.match(plain(render()).join('\n'), /command: *\n   make test *\n   second line/);
  for (const [width, height] of [[99, 30], [59, 20], [40, 12]] as const) {
    const narrow = withTier('none', () => raw.render(width, height, 'Esc 返回上层'));
    assert.equal(narrow.length, height);
    for (const line of plain(narrow)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  // 宽度小于 100：没有详情栏，原文层顶部先显示完整详情。
  assert.match(plain(withTier('none', () => raw.render(99, 40, 'Esc 返回上层'))).join('\n'), /tool · bash .*\n.*命令/);
  assert.equal(visibleControls('a\tb\r\nc'), 'a    b\nc');
});

test('cleaned and truncated items are labelled in the raw layer', () => {
  const root = fixture(), { rawHost } = host();
  const view = new TraceView(root, runId);
  const [read, , write] = view.trace.spans.filter(span => span.kind === 'tool');
  const shown = (key: string, item: string) => plain(withTier('none', () => new TraceRawView(root, view, key, rawHost, item).render(132, 20, 'Esc 返回上层'))).join('\n');
  const truncated = shown(read.key, '送模内容');
  assert.match(truncated, /◐ 完整取得 · 送模截断 · 原文完整 · 第 1\/1 页/);
  assert.match(truncated, /\n line 1 *\n line 2 *\n/);
  const cleaned = shown(write.key, '送模内容');
  assert.match(cleaned, /◐ 已清理 · 第 1\/1 页/);
  assert.match(cleaned, /已清理 · 显式清理后原文不可取得，宿主记录保留/);
});

test('p pins the selected span: busy or a held writer lock only hints; confirm writes once; pinned spans show 已固定', async () => {
  const root = fixture(), { state, traceHost } = host(true);
  const view = new TraceView(root, runId, () => false, traceHost);
  const bash = view.trace.spans.find(span => span.tool?.name === 'bash')!;
  view.select(bash.key);
  view.handleInput('p');
  assert.equal(state.feedback.at(-1), '有任务运行中，结束后再固定'); assert.equal(state.confirms.length, 0);
  state.busy = false;
  const lock = `${realpathSync(root)}.lock`; mkdirSync(lock);
  view.handleInput('p');
  assert.equal(state.feedback.at(-1), '有任务运行中，结束后再固定', 'another process holding the writer lock: no dialog'); assert.equal(state.confirms.length, 0);
  rmSync(lock, { recursive: true });
  view.handleInput('p');
  assert.equal(state.confirms.length, 1);
  const { config, run } = state.confirms[0];
  const label = readDisplayIndex(root).label('run', runId);
  assert.equal(config.title, '固定为证据');
  assert.ok(config.body!.includes(`用途 trace：${label} ${view.spanName(bash)}`), config.body!.join('\n'));
  assert.match(config.fixed!.join('\n'), /整个 run \S+ 截至此刻的全部原文与执行版本安装文件/);
  await run();
  assert.equal(state.feedback.at(-1), '已固定为证据');
  const fixed = [...records(root, { kinds: ['evidence.fixed'] })];
  assert.equal(fixed.length, 1);
  const detail = plain(withTier('none', () => view.render(220, 38, 'Esc 返回会话'))).join('\n');
  assert.match(detail, /证据 +已固定/);
  assert.match(detail, /↑↓ span · Enter 原文 · p 固定为证据 · Esc 返回会话/);
  view.handleInput('p');
  assert.equal(state.confirms.length, 1, 'already pinned: only a hint'); assert.equal(state.feedback.at(-1), '已固定为证据 · 不重复固定');
  // 其他 span 未固定；新开的视图从固定记录读出“已固定”。
  const again = new TraceView(root, runId, () => false, traceHost);
  again.select(bash.key);
  assert.match(plain(withTier('none', () => again.render(220, 38, 'Esc 返回会话'))).join('\n'), /证据 +已固定/);
  again.select(view.trace.spans.find(span => span.tool?.name === 'read')!.key);
  assert.doesNotMatch(plain(withTier('none', () => again.render(220, 38, 'Esc 返回会话'))).join('\n'), /已固定/);
});

class TestTerminal implements Terminal {
  columns = 140; rows = 40; kittyProtocolActive = false; writes: string[] = [];
  input: (s: string) => void = () => {}; resize: () => void = () => {};
  start(input: (s: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(value: string) { this.writes.push(value); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise(r => setTimeout(r, 30));
async function until(predicate: () => boolean) { for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); } throw Error('condition timed out'); }

test('/details and 分页查看 open 2a directly in the raw layer; Esc returns to the list, then to the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-details-')), workspace = join(root, 'project');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'details fixture\n');
  writeFileSync(join(workspace, 'fail.cjs'), "for (let i = 0; i < 30; i++) console.log('case ' + i); process.exit(1);");
  const script = scriptedTransport([{ name: 'bash', args: { command: `'${process.execPath}' fail.cjs` } }]);
  const terminal = new TestTerminal(), copied: string[] = [];
  const app = new ReadOnlyTui({ workspace, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', transport: script.fetch, terminal, widthCalibration: false, coding: true, copy: async text => { copied.push(text); return true; } });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n'), key = (data: string) => terminal.input(data);
  app.start();
  try {
    key('Run failing check'); key('\r');
    await until(() => screen().includes('分页查看'));
    await until(() => !/运行中|⠋|⠙/.test(screen().split('\n').at(-5) ?? '') && screen().includes('完成') || screen().includes('失败'));
    key('/details tc-0-99'); key('\r');
    assert.doesNotMatch(screen(), /trace 原文/, 'a bad tc number opens no view');
    assert.match(screen(), /参数有误：没有找到 r-0|参数有误：.*tc-0-99/);
    key('\x03'); key('/details'); key('\r');
    await until(() => screen().includes('trace 原文')).catch(error => { throw Error(`${error}\n${screen()}`); });
    assert.match(screen(), /\[?stdout\]?/); assert.match(screen(), /case 29/);
    assert.match(screen(), /Tab 切换 · ↑↓ 滚动 · n\/p 翻页 · y 复制 · Esc 返回上层/);
    key('y'); await until(() => copied.length === 1);
    assert.match(copied[0], /^case 0\n/);
    key('\x1b');
    assert.match(screen(), /↑↓ span · Enter 原文 · p 固定为证据 · Esc 返回会话/, 'Esc returns to the list layer');
    assert.match(screen(), /│ tool · bash/, 'the tool span stays selected');
    key('\x1b');
    assert.doesNotMatch(screen(), /◆ trace/, 'second Esc returns to the session');
    // “分页查看”：点击该行进入原文层。
    const rows = app.screen().map(stripTerminalSequences), row = rows.findIndex(line => line.includes('分页查看'));
    assert.ok(row >= 0, rows.join('\n'));
    const col = rows[row].indexOf('分页查看');
    key(`\x1b[<0;${visibleWidth(rows[row].slice(0, col)) + 2};${row + 1}M`); key(`\x1b[<0;${visibleWidth(rows[row].slice(0, col)) + 2};${row + 1}m`);
    await until(() => screen().includes('trace 原文'));
    assert.match(screen(), /case 29/);
    key('\x1b'); key('\x1b');
    assert.doesNotMatch(screen(), /◆ trace/);
  } finally { await app.exit(); }
});
