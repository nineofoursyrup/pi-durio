import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Evidence } from '../src/evidence.js';
import { readDisplayIndex } from '../src/display-number.js';

test('actual CLI show --trace keeps read-only capability while raw navigation and copying remain available', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'durio-cli-show-')), runId = '11111111-2222-4333-8444-555555555555', sessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const evidence = new Evidence(dataRoot, runId);
  evidence.append('task.accepted', { runId, sessionId, taskId: 'cli-show-task', input: 'Read README', workspace: process.cwd(), authorization: { tools: ['read'] } });
  evidence.append('run.started', {});
  evidence.append('tool.intent', { attemptId: 'read-1', durableTaskId: 1, tool: 'read', args: { path: 'README.md' } });
  evidence.append('tool.result', { attemptId: 'read-1', durableTaskId: 1, result: { content: [{ type: 'text', text: 'Readable original' }] } });
  evidence.append('run.closed', { runId, status: 'completed', cleanup: 'confirmed' });
  evidence.close();
  const before = readFileSync(join(dataRoot, 'host.sqlite')), display = readDisplayIndex(dataRoot);
  // Intercept only the terminal adapter. The actual CLI parses/resolves the supplied
  // arguments and passes its unmodified options to the real application.
  const childSource = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { stripTerminalSequences } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))};
    const [dataRoot, target, runId] = process.argv.slice(2);
    const appUrl = new URL(${JSON.stringify(new URL('../src/tui/app.js', import.meta.url).href)});
    const { ReadOnlyTui } = await import(appUrl.href);
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    let invoked = false;
    mock.module(appUrl.href, { namedExports: { runTui: async options => {
      invoked = true;
      class Terminal {
        columns = 132; rows = 38; kittyProtocolActive = false; input = () => {};
        start(input) { this.input = input; } stop() {} async drainInput() {} write() {}
        moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
      }
      const terminal = new Terminal(), copied = [];
      const app = new ReadOnlyTui({ ...options, terminal, widthCalibration: false, draftRoot: dataRoot + '-drafts', copy: async text => { copied.push(text); return true; } });
      const screen = () => app.screen().map(stripTerminalSequences).join('\\n');
      try {
        app.start();
        assert.match(screen(), /◆ trace/);
        terminal.input('\\x1b[B');
        terminal.input('p');
        assert.match(screen(), /只读查看 · 不能提交、写入记录或启动工作/);
        assert.doesNotMatch(screen(), /固定证据 · 确认/);
        terminal.input('\\r');
        assert.match(screen(), /trace 原文/);
        terminal.input('y');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(copied.some(text => text.includes('README.md')));
        terminal.input('\\x1b'); terminal.input('\\x1b');
        terminal.input('/improve new'); terminal.input('\\r');
        assert.match(screen(), /只读查看 · 不能提交、写入记录或启动工作/);
        assert.doesNotMatch(screen(), /分析范围 · 空格切换/);
        assert.equal(options.show.run, runId);
        assert.equal(options.trace, runId);
        return await app.exit();
      } finally { await app.exit(); }
    } } });
    process.argv = [process.execPath, 'dist/src/cli.js', 'show', target, '--trace', '--data-root', dataRoot];
    await import(${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)});
    process.on('beforeExit', () => assert.equal(invoked, true));
  `;
  const harness = join(dataRoot, 'cli-show-harness.mjs');
  writeFileSync(harness, childSource);
  for (const target of [display.label('run', runId), display.label('session', sessionId)]) {
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', harness, dataRoot, target, runId], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const lines = child.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 8);
    assert.match(lines[0], /^◆ pi-durio 已退出/);
    assert.match(child.stdout, /原文  pi-durio show s-/);
    assert.doesNotMatch(child.stdout, /Read back:|"tui"|[\x1b\x07]/);
    assert.deepEqual(readFileSync(join(dataRoot, 'host.sqlite')), before, 'viewing cannot append pins or analysis records');
  }
});
