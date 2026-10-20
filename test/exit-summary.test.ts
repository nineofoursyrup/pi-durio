import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { exitSummary, tuiExitCode, ProcessCleanupReceipts, type ExitSummaryFacts } from '../src/tui/exit-summary.js';
import type { RunResult } from '../src/runtime.js';

const runId = '11111111-2222-4333-8444-555555555555';
/** 摘要内容：去掉序列与左侧 `┃`，略去“继续 / 原文”之前的空行（U6）。 */
const content = async (...args: Parameters<typeof exitSummary>) => (await exitSummary(...args)).map(line => stripTerminalSequences(line).replace(/^┃ ?/, '')).filter(Boolean);
const sessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
function fixture(input = '完成修改') {
  const root = mkdtempSync(join(tmpdir(), 'durio-exit-summary-')), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  const evidence = new Evidence(dataRoot, runId);
  evidence.append('task.accepted', { taskId: 'exit-task', sessionId, input, workspace, authorization: { tools: ['read'] } });
  evidence.append('run.started', {});
  evidence.append('context.snapshot', { messages: evidence.blob('[]') });
  const facts: ExitSummaryFacts = { workspace, runId, elapsedMs: 848_000, draftLines: 0, terminalRestored: true };
  return { root, workspace, dataRoot, evidence, facts };
}
function result(status: RunResult['status'], cleanup: RunResult['cleanup']): RunResult {
  return { runId, sessionId, taskId: 'exit-task', mode: 'offline', status, cleanup, observation: 'ok',
    lifecycle: { intent: status === 'unknown' ? 'exit' : null, disposition: status === 'unknown' ? 'resumable' : status, cleanupTimeoutMs: 10000, storage: cleanup === 'confirmed' ? 'closed' : 'unknown', owner: cleanup === 'confirmed' ? 'release-after-host-close' : 'retained', remoteTermination: 'unknown' },
    usage: { source: 'pi.usage', scope: 'task', completeness: 'unknown', value: null, cost: { kind: 'estimate', currency: 'USD', source: 'test', observedAt: '2026-10-17T00:00:00Z' } },
  };
}

test('completed task and no-task exits have bounded human summaries with factual next steps', async () => {
  const f = fixture();
  f.evidence.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  f.evidence.close();
  assert.deepEqual(await content(f.dataRoot, f.facts, 132), [
    '◆ pi-durio 已退出 · 会话 s-6666 · 用时 14m 08s',
    '✓ 任务 1 完成 · 完成修改',
    '◇ 本会话 0 tok ≈ ¥0.00（估算 · 非账单）',
    '◇ 写入者锁未取得 · storage 未打开 · 终端已恢复',
    '继续  pi-durio resume s-6666     原文  pi-durio show s-6666 --trace',
  ]);
  assert.deepEqual(await content(join(f.root, 'empty-data'), { ...f.facts, runId: undefined, elapsedMs: 2400 }, 132), [
    '◆ pi-durio 已退出 · 用时 0m 02s',
    '◇ 写入者锁未取得 · storage 未打开 · 终端已恢复',
  ]);
});

test('all optional rows fit eight lines, sanitize user text, and count every frozen kind across queue pages', async () => {
  const f = fixture('\x1b]0;fake title\x07\x1b[31m完成\x1b[0m\t修改\r不得显示第二行');
  const target = { workspace: f.workspace, runId, sessionId, taskId: 'exit-task' };
  for (let i = 0; i < 205; i++) {
    const requestId = `frozen-${i}`, kind = ['steer', 'follow-up', 'compact', 'improve'][i % 4];
    f.evidence.append('control.accepted', { requestId, kind, input: '\x1b[31m首项\x1b[0m\x07\n不得显示', target });
    f.evidence.append('control.receipt', { requestId, status: i === 204 ? 'withdrawn' : 'frozen', reason: 'Application exit' });
  }
  const closed = result('completed', 'confirmed');
  f.evidence.append('run.closed', closed); f.evidence.close();
  const facts: ExitSummaryFacts = { ...f.facts, cleanup: closed, draftLines: 3, eval: { planId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', trial: 3, total: 12, cost: { amounts: { CNY: 0.08 }, unknownRequests: 1, partial: false }, state: 'stopped', cleanup: 'confirmed' } };
  const lines = await content(f.dataRoot, facts, 132);
  assert.equal(lines.length, 8);
  assert.equal((await exitSummary(f.dataRoot, facts, 132)).length, 10, 'eight rows plus the top margin and the blank row before the next step');
  assert.equal(lines[1], '✓ 任务 1 完成 · 完成修改');
  assert.equal(lines[2], '⧗ 204 项已冻结 · 「首项」· 不会自动接入');
  assert.equal(lines[3], '◇ 草稿已保存 · 3 行 · 下次 /restore 恢复');
  assert.equal(lines[4], 'eval ep-bbbb 已停止于 trial 3/12 · ≈ ¥0.08 +1 unknown');
  assert.equal(lines[7], '原文  pi-durio show s-6666 --trace', 'frozen work prevents continuation');
  assert.doesNotMatch(lines.join(''), /[\x00-\x1f\x7f-\x9f]|不得显示|fake title/);
  for (const width of [132, 80, 40, 1]) {
    const narrow = await exitSummary(f.dataRoot, facts, width);
    assert.equal(narrow.length, 10);
    assert.equal(narrow[0], '');
    assert.ok(narrow.every(line => visibleWidth(line) <= width));
  }
  const failed = await content(f.dataRoot, { ...facts, terminalRestored: false, eval: { ...facts.eval!, state: 'unconfirmed', cleanup: 'unknown' } }, 132);
  assert.match(failed[4], /停止未确认/);
  assert.match(failed[6], /清理未确认|恢复未确认/);
  assert.match(failed[6], /reset/);
});

test('interrupted and unconfirmed cleanup exits preserve recovery status; failed or stopped tasks offer originals only', async () => {
  for (const [status, cleanup] of [['unknown', 'confirmed'], ['unknown', 'unknown'], ['failed', 'confirmed'], ['aborted', 'confirmed']] as const) {
    const f = fixture(), closed = result(status, cleanup);
    f.evidence.append('run.closed', closed); f.evidence.close();
    const lines = await content(f.dataRoot, { ...f.facts, cleanup: closed }, 132);
    assert.equal(lines[1], status === 'unknown' ? '◈ 任务 1 已中断 · 待恢复核对' : `${status === 'failed' ? '✗' : '◇'} 任务 1 ${status === 'failed' ? '失败' : '已中止'} · 完成修改`);
    assert.equal(lines[3], cleanup === 'unknown' ? '✗ 清理未确认 · 写入者锁保留 · pi-durio resume s-6666 核对 · 终端已恢复' : '◇ 写入者锁已释放 · storage 已关闭 · 终端已恢复');
    assert.equal(lines[4], `${status === 'unknown' ? '恢复核对  pi-durio resume s-6666     ' : ''}原文  pi-durio show s-6666 --trace`);
    assert.doesNotMatch(lines.join('\n'), /检查.*通过|Read back:|"tui"/);
  }
});

test('file totals count successful edit/write results once per file, excluding bash effects, failures and unresolved intents', async () => {
  const f = fixture(), e = f.evidence;
  const write = (attemptId: string, tool: string, path: string, previous: string | null, content: string) => {
    e.append('tool.intent', { attemptId, tool, args: tool === 'bash' ? { command: 'generated a file; 33/33 tests passed' } : { path } });
    e.append('file.write-intent', { toolAttempt: { attemptId }, acquired: { path: join(f.workspace, path), previous: previous === null ? null : Buffer.from(previous).toString('base64'), content: Buffer.from(content).toString('base64') } });
    e.append('tool.result', { attemptId, result: { content: [{ type: 'text', text: 'written' }] } });
  };
  write('write-a', 'write', 'a.txt', 'old 1\nold 2\n', 'new 1\nnew 2\nnew 3\n');
  e.append('tool.intent', { attemptId: 'edit-a', tool: 'edit', args: { path: './a.txt' } });
  const editResult = { attemptId: 'edit-a', result: { details: { diff: ' 1 keep\n-2 old\n+2 new' } } };
  e.append('tool.result', editResult); e.append('tool.result', editResult);
  write('write-b', 'write', 'b.txt', null, 'one\ntwo');
  write('bash-effect', 'bash', 'shell.txt', null, 'not a file-tool result\n');
  e.append('tool.intent', { attemptId: 'failed', tool: 'edit', args: { path: 'failed.txt' } });
  e.append('tool.error', { attemptId: 'failed', error: 'no match' });
  e.append('tool.intent', { attemptId: 'unknown', tool: 'write', args: { path: 'unknown.txt', content: 'unconfirmed' } });
  e.append('run.closed', result('completed', 'confirmed')); e.close();
  const lines = await content(f.dataRoot, f.facts, 132);
  assert.equal(lines[1], '✓ 任务 1 完成 · 完成修改 · 2 文件 +6 −3');
  assert.doesNotMatch(lines.join('\n'), /shell\.txt|unknown\.txt|33\/33|检查/);
});

test('TUI exit code mapping retains success, failure, stop, recovery and queued-work statuses', () => {
  assert.equal(tuiExitCode({}), 0);
  assert.equal(tuiExitCode({ result: result('completed', 'confirmed') }), 0);
  assert.equal(tuiExitCode({ result: result('failed', 'confirmed') }), 1);
  assert.equal(tuiExitCode({ result: result('aborted', 'confirmed') }), 130);
  assert.equal(tuiExitCode({ result: result('unknown', 'confirmed') }), 75);
  assert.equal(tuiExitCode({ result: result('unknown', 'unknown') }), 75);
  assert.equal(tuiExitCode({ result: { ...result('completed', 'confirmed'), controls: { status: 'needs-decision', exitCode: 75, requestIds: ['q'], reason: 'frozen' } } }), 75);
  assert.equal(tuiExitCode({ result: result('completed', 'confirmed'), error: 'terminal restoration failed' }), 1);
});

test('ending old work is distinct from stopping and absent current-process cleanup is not reported as clean', async () => {
  const f = fixture();
  f.evidence.append('run.closed', result('unknown', 'unknown'));
  f.evidence.append('recovery.ended', { runId }); f.evidence.close();
  const facts = { ...f.facts, cleanupAttempted: true };
  const lines = await content(f.dataRoot, facts, 132);
  assert.equal(lines[1], '◇ 任务 1 已结束 · 完成修改');
  assert.match(lines[3], /清理结果未取得.*状态未知/);
  assert.doesNotMatch(lines[3], /已释放|已关闭|未取得 · storage 未打开/);
  assert.equal(lines[4], '原文  pi-durio show s-6666 --trace');
});

test('process cleanup follows committed receipt order within each run and keeps unrelated unknowns', () => {
  const f=fixture(), receipts=new ProcessCleanupReceipts(), otherRun='12345678-1111-4222-8333-444444444444';
  const unknown=result('unknown','unknown'), confirmed=result('completed','confirmed');
  f.evidence.append('run.closed',unknown);receipts.observe(f.dataRoot,{kind:'run.closed',runId});
  const other=new Evidence(f.dataRoot,otherRun), otherResult={...confirmed,runId:otherRun};
  other.append('run.closed',otherResult);receipts.observe(f.dataRoot,{kind:'run.closed',runId:otherRun});
  assert.equal(receipts.result(otherResult)?.runId,runId);
  assert.equal(receipts.result(otherResult)?.cleanup,'unknown');
  f.evidence.append('lifecycle.late-close',{storage:'closed',owner:'retained',recoveryRequired:true});
  receipts.observe(f.dataRoot,{kind:'lifecycle.late-close',runId});
  assert.equal(receipts.result(otherResult)?.cleanup,'unknown');
  f.evidence.append('recovery.closed',{result:confirmed});receipts.observe(f.dataRoot,{kind:'recovery.closed',runId});
  assert.equal(receipts.result(otherResult),otherResult);
  receipts.observe(f.dataRoot,{kind:'run.closed',runId});
  assert.equal(receipts.result(otherResult),otherResult,'an older run.closed cannot replace the newer recovery receipt');
  const missing='99999999-1111-4222-8333-444444444444';receipts.observe(f.dataRoot,{kind:'run.closed',runId:missing});
  assert.equal(receipts.result(otherResult),undefined,'unavailable process receipt cannot be turned into clean');
  other.close();f.evidence.close();
});

test('eval cleanup unknown controls exit 75 independently of coding result', () => {
  const evaluation = { planId:'child-plan', trial:1, total:2, cost:{amounts:{CNY:0},unknownRequests:0,partial:false}, state:'unconfirmed' as const,cleanup:'unknown' as const };
  assert.equal(tuiExitCode({eval:evaluation} as Parameters<typeof tuiExitCode>[0]),75);
});
