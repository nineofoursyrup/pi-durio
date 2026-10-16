import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { ReadOnlyTui, type TuiOptions } from '../src/tui/app.js';

const runId = '22222222-3333-4444-8555-666666666666';
const sessionId = '77777777-3333-4444-8555-666666666666';

class TestTerminal implements Terminal {
  columns = 160; rows = 40; kittyProtocolActive = false;
  input: (s: string) => void = () => {};
  start(input: (s: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {}
  hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {}
  clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

/** A closed record-only run: the test never needs a provider or a writable Harness. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durio-show-readonly-')));
  const workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace);
  const evidence = new Evidence(dataRoot, runId);
  evidence.append('task.accepted', { taskId: 'show-task', runId, sessionId, workspace, kind: 'coding', input: 'inspect README.md', authorization: { execution: 'trusted-local-coding', tools: ['read', 'write', 'edit', 'bash'] } });
  evidence.append('run.started', { taskId: 'show-task' });
  evidence.append('tool.intent', { attemptId: 'read-1', durableTaskId: 1, callId: 'read-1', tool: 'read', args: { path: 'README.md' } });
  evidence.append('tool.result', { attemptId: 'read-1', durableTaskId: 1, result: { content: [{ type: 'text', text: 'original fixture text' }] } });
  evidence.append('run.closed', { runId, status: 'completed', cleanup: 'confirmed' });
  evidence.close();
  return { root, workspace, dataRoot };
}

/** Detect any data-root write, including new records, attachments or source registrations. */
function contents(root: string): [string, string][] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name);
    return [path.slice(root.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')] as [string, string];
  }).sort(([a], [b]) => a.localeCompare(b));
}

function open(f: ReturnType<typeof fixture>, show: TuiOptions['show'] = { run: runId }) {
  const terminal = new TestTerminal(), copied: string[] = [];
  let providerCalls = 0;
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', show, terminal, widthCalibration: false,
    transport: async () => { providerCalls++; throw Error('show must not call a provider'); },
    copy: async text => { copied.push(text); return true; } });
  const key = (data: string) => terminal.input(data);
  const screen = () => app.screen().map(stripTerminalSequences).join('\n');
  app.start();
  return { app, key, screen, copied, calls: () => providerCalls };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('view did not become ready');
}

test('show trace keeps raw navigation and copy, but p cannot offer or execute a fixed-evidence write', async () => {
  const f = fixture(), before = contents(f.dataRoot), t = open(f);
  try {
    t.key('t'); t.key('\x1b[B');
    assert.match(t.screen(), /tool · read/);
    t.key('p');
    assert.match(t.screen(), /只读查看/);
    assert.doesNotMatch(t.screen(), /有任务运行中|写入一条固定记录/);
    // Enter must still open the selected span's originals, never confirm a write.
    t.key('\r');
    assert.match(t.screen(), /◆ trace 原文/);
    t.key('\t'); t.key('y');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(t.copied[0], /original fixture text/);
    t.key('\x1b'); t.key('\x1b');
    t.key('\x1b'); t.key('\x1b'); t.key('\x1b');
    t.key('must remain a draft'); t.key('\r');
    assert.match(t.screen(), /只读查看 · 不能提交/);
    assert.equal(t.calls(), 0);
    assert.deepEqual(contents(f.dataRoot), before);
    assert.equal(existsSync(`${f.dataRoot}.lock`), false);
  } finally { await t.app.exit(); }
  assert.deepEqual(contents(f.dataRoot), before, 'exit must not write product records either');
});

test('show blocks the improve new subcommand and the home-screen launch while retaining report navigation', async () => {
  const f = fixture(), before = contents(f.dataRoot), t = open(f);
  try {
    t.key('\x1b'); t.key('\x1b'); t.key('\x1b');
    t.key('/improve new --scope session --budget standard'); t.key('\r');
    assert.doesNotMatch(t.screen(), /新建 improve 分析|分析不执行任何候选 · 可看文件/);
    assert.match(t.screen(), /只读查看/);
    t.key('/improve'); t.key('\r');
    assert.match(t.screen(), /◆ improve/);
    assert.match(t.screen(), /新建分析/);
    t.key('\r');
    assert.match(t.screen(), /只读查看/);
    assert.doesNotMatch(t.screen(), /新建 improve 分析|分析不执行任何候选 · 可看文件/);
    // The next rows are read-only history and suppressions, still reachable in show.
    t.key('\x1b[B'); t.key('\r');
    assert.doesNotMatch(t.screen(), /新建分析/);
    t.key('\x1b'); t.key('\x1b[B'); t.key('\r');
    assert.doesNotMatch(t.screen(), /新建分析/);
    assert.equal(t.calls(), 0);
    assert.deepEqual(contents(f.dataRoot), before);
  } finally { await t.app.exit(); }
  assert.deepEqual(contents(f.dataRoot), before);
});

test('show session keeps command and storage actions read-only after returning from history', async () => {
  const f = fixture(), before = contents(f.dataRoot), t = open(f, { run: runId, session: sessionId });
  try {
    t.key('\x1b'); t.key('\x1b');
    for (const command of ['/acceptance --verdict pass', '/compact', '/follow-up', '/stop', '/improve restore report·C-01', '/improve continue report', '/improve rollback report·C-01', '/improve register eval cases.json', '/improve unregister self ./src']) {
      t.key(command); t.key('\r');
      assert.match(t.screen(), /只读查看/, command);
      assert.equal(t.calls(), 0, command);
      assert.deepEqual(contents(f.dataRoot), before, command);
    }
    t.key('/storage'); t.key('\r');
    await until(() => t.screen().includes('宿主记录'));
    t.key('\r');
    assert.match(t.screen(), /只读查看/);
    assert.doesNotMatch(t.screen(), /有任务运行中|清理预览/);
    assert.deepEqual(contents(f.dataRoot), before, 'storage preview itself must not write management records');
  } finally { await t.app.exit(); }
  assert.deepEqual(contents(f.dataRoot), before);
});
