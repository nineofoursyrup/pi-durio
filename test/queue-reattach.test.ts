import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReadTask, decideQueue } from '../src/runtime.js';
import { Evidence, readObject, type ControlKind } from '../src/evidence.js';
import { findQueueItem } from '../src/control.js';
import { readRunRecords } from '../src/query.js';
import { readSessionChains } from '../src/session-chain.js';
import { readQueueReattachment, readOpenQueue } from '../src/queue.js';
import { scriptedTransport } from '../src/offline.js';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durio-queue-reattach-')), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'queue reattachment fixture');
  return { root, workspace: realpathSync(workspace), dataRoot };
}
function admit(dataRoot: string, runId: string, id: string, kind: ControlKind = 'follow-up', input = 'Follow-up under the current execution version') {
  const refs = readRunRecords(dataRoot, runId, { kinds: ['task.accepted', 'execution.artifact', 'execution.config'] }).records;
  const accepted = JSON.parse(readObject(dataRoot, refs.find(ref => ref.kind === 'task.accepted')!.ref).toString());
  const artifact = refs.find(ref => ref.kind === 'execution.artifact')!, config = refs.find(ref => ref.kind === 'execution.config')!;
  const evidence = new Evidence(dataRoot, runId);
  evidence.append('control.accepted', { requestId: id, kind, input, taskId: kind === 'follow-up' ? `${id}-task` : null, target: { workspace: accepted.workspace, sessionId: accepted.sessionId, taskId: accepted.taskId, runId }, executionVersion: { artifactId: JSON.parse(readObject(dataRoot, artifact.ref).toString()).id, artifactSeq: artifact.seq, configSeq: config.seq }, authorization: accepted.authorization });
  evidence.append('control.receipt', { requestId: id, status: 'frozen', reason: 'Synthetic completed-source queue for redesign behavior tests; not the v1 fixture' });
  evidence.close(); return findQueueItem(dataRoot, id)!;
}
function activate(dataRoot: string, workspace: string, instructions = 'Use a concise summary.') {
  const evidence = new Evidence(dataRoot, 'activation-fixture'), content = evidence.blob(instructions);
  evidence.append('improve.activation', { defaults: [{ current: { workspace, taskType: 'read', files: [{ targetId: 'agents', root: workspace, path: 'AGENTS.md', kind: 'prompt-skill', content }] } }] }); evidence.close();
}

test('changed-version follow-up is withdrawn and accepted once as a new task at the product-session tail, with later queue items still frozen', async () => {
  const f = fixture(), original = await runReadTask({ ...f, input: 'Original completed task', mode: 'offline', transport: scriptedTransport([]).fetch });
  const second = await runReadTask({ ...f, contextRunId: original.runId, input: 'Current completed tail', mode: 'offline', transport: scriptedTransport([]).fetch });
  const item = admit(f.dataRoot, original.runId, 'replace-follow');
  admit(f.dataRoot, second.runId, 'later-follow'); activate(f.dataRoot, f.workspace);
  const plan = readQueueReattachment(f.dataRoot, item, { workspace: f.workspace, mode: 'offline' });
  assert.equal(plan.state, 'ready'); if (plan.state !== 'ready') return;
  assert.equal(plan.confirmation.route, 'replace-follow-up'); assert.equal(plan.confirmation.tailRunId, second.runId);
  const transport = scriptedTransport([]), request = { dataRoot: f.dataRoot, runId: item.target.runId, authorization: plan.confirmation.authorization,
    decision: { id: 'confirm-replacement', requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'reattach' as const },
    confirmation: plan.confirmation, transport: transport.fetch };
  const result = await decideQueue(request);
  assert.equal(result.status, 'completed'); assert.ok('usage' in result); if (!('usage' in result)) return;
  assert.notEqual(result.taskId, item.taskId); assert.notEqual(result.runId, original.runId);
  const chains = readSessionChains(f.dataRoot);
  assert.equal(chains.sessionOfRun(result.runId)?.id, original.sessionId);
  assert.equal(chains.sessionOfRun(result.runId)?.number, 3);
  assert.deepEqual(chains.contextRunIds(result.runId), [original.runId, second.runId, result.runId]);
  assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'withdrawn');
  assert.equal(findQueueItem(f.dataRoot, 'later-follow')!.status, 'frozen');
  const acceptedRef = readRunRecords(f.dataRoot, result.runId, { kinds: ['task.accepted'] }).records[0];
  const accepted = JSON.parse(readObject(f.dataRoot, acceptedRef.ref).toString());
  assert.equal(accepted.replacesQueueRequestId, item.requestId); assert.equal(accepted.queueRequestId, undefined);
  assert.equal((await decideQueue(request)).status, 'withdrawn'); assert.equal(transport.calls.length, 1, 'repeating confirmation never submits the old text twice');
});


test('a compatible reattachment keeps its admitted task identity, while stale or widened confirmations cannot dispatch', async () => {
  const f = fixture(), original = await runReadTask({ ...f, input: 'Completed source', mode: 'offline', transport: scriptedTransport([]).fetch });
  const item = admit(f.dataRoot, original.runId, 'same-follow');
  const plan = readQueueReattachment(f.dataRoot, item, { workspace: f.workspace, mode: 'offline' });
  assert.equal(plan.state, 'ready'); if (plan.state !== 'ready') return;
  assert.equal(plan.confirmation.route, 'reattach');
  const transport = scriptedTransport([]), request = { dataRoot: f.dataRoot, runId: original.runId, authorization: plan.confirmation.authorization,
    confirmation: plan.confirmation, decision: { id: 'same-decision', requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'reattach' as const }, transport: transport.fetch };
  await assert.rejects(decideQueue({ ...request, authorization: { ...request.authorization, tools: ['read', 'write', 'edit', 'bash'] } }), /QUEUE_CONFIRMATION_CHANGED/);
  assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'frozen'); assert.equal(transport.calls.length, 0);
  const result = await decideQueue(request); assert.equal(result.status, 'completed'); assert.ok('taskId' in result && result.taskId === item.taskId);
  assert.equal(findQueueItem(f.dataRoot, item.requestId)!.status, 'applied');
  assert.equal((await decideQueue(request)).status, 'applied'); assert.equal(transport.calls.length, 1);

  const stale = admit(f.dataRoot, result.runId!, 'stale-follow'), before = readQueueReattachment(f.dataRoot, stale, { workspace: f.workspace, mode: 'offline' });
  assert.equal(before.state, 'ready'); if (before.state !== 'ready') return;
  activate(f.dataRoot, f.workspace);
  const staleRequest = { ...request, runId: stale.target.runId, authorization: before.confirmation.authorization, confirmation: before.confirmation,
    decision: { id: 'stale-decision', requestId: stale.requestId, target: stale.target, receiptSeq: stale.receipt.seq, action: 'reattach' as const } };
  await assert.rejects(decideQueue(staleRequest), /QUEUE_CONFIRMATION_CHANGED/);
  await assert.rejects(decideQueue({ ...staleRequest, confirmation: undefined }), /QUEUE_EXECUTION_VERSION_CHANGED/);
  assert.equal(findQueueItem(f.dataRoot, stale.requestId)!.status, 'frozen'); assert.equal(transport.calls.length, 1);
});

test('reattachment reasons cover earlier product-session admissions, dispatch uncertainty, ended/failed sources, recovery, cleaned context and changed compact', async () => {
  const f = fixture(), original = await runReadTask({ ...f, input: 'Completed reason source', mode: 'offline', transport: scriptedTransport([]).fetch });
  const tail = await runReadTask({ ...f, contextRunId: original.runId, input: 'Completed product-session tail', mode: 'offline', transport: scriptedTransport([]).fetch });
  const clone = () => { const root = mkdtempSync(join(tmpdir(), 'durio-queue-reason-')), dataRoot = join(root, 'data'); cpSync(f.dataRoot, dataRoot, { recursive: true }); return { ...f, root, dataRoot }; };
  const reason = (dataRoot: string, item: ReturnType<typeof admit>, busy?: string) => {
    const plan = readQueueReattachment(dataRoot, item, { workspace: f.workspace, mode: 'offline', busy });
    assert.equal(plan.state, 'blocked'); return plan.state === 'blocked' ? plan.reason : '';
  };
  {
    const c = clone(); admit(c.dataRoot, original.runId, 'earlier', 'steer');
    const item = admit(c.dataRoot, tail.runId, 'later');
    assert.match(reason(c.dataRoot, item), /前面还有 1 项未处理/);
    const chains = readSessionChains(c.dataRoot);
    assert.equal(chains.sessionOfRun(item.target.runId)!.id, original.sessionId);
    assert.notEqual(item.target.sessionId, original.sessionId, 'durable session identity is not the product session identity');
  }
  for (const kind of ['steer', 'follow-up', 'compact'] as const) {
    const c = clone(), item = admit(c.dataRoot, original.runId, `kind-${kind}`, kind);
    if (kind === 'steer') assert.match(reason(c.dataRoot, item), /steer 只能复制后重新提交/);
    else if (kind === 'compact') { activate(c.dataRoot, c.workspace); assert.match(reason(c.dataRoot, item), /执行版本已变 · 可撤回/); }
    else {
      assert.match(reason(c.dataRoot, item, '当前工作运行中'), /当前工作运行中/);
      const e = new Evidence(c.dataRoot, original.runId); e.append('control.receipt', { requestId: item.requestId, status: 'dispatching', reason: 'dispatch intent' }); e.append('control.receipt', { requestId: item.requestId, status: 'frozen', reason: 'interrupted after intent' }); e.close();
      assert.match(reason(c.dataRoot, findQueueItem(c.dataRoot, item.requestId)!), /上次派发结果未知/);
    }
  }
  for (const state of ['ended', 'failed', 'aborted', 'recovery', 'cleaned'] as const) {
    const c = clone(), item = admit(c.dataRoot, original.runId, `source-${state}`), e = new Evidence(c.dataRoot, state === 'recovery' ? tail.runId : original.runId);
    if (state === 'ended') e.append('recovery.ended', { result: { status: 'ended' } });
    else if (state === 'cleaned') { const ref = readRunRecords(c.dataRoot, original.runId, { kinds: ['context.snapshot'], tail: true, limit: 1 }).records[0]; const snapshot = JSON.parse(readObject(c.dataRoot, ref.ref).toString()); rmSync(join(c.dataRoot, 'objects', snapshot.messages.sha256)); }
    else e.append('run.closed', { status: state === 'recovery' ? 'unknown' : state, cleanup: state === 'recovery' ? 'unknown' : 'confirmed' });
    e.close();
    assert.match(reason(c.dataRoot, item), state === 'ended' ? /旧工作已结束/ : state === 'cleaned' ? /原文已清理/ : state === 'recovery' ? /恢复核对/ : /源任务未完成.*可复制后重新提交/);
    if (state === 'ended') await assert.rejects(decideQueue({ dataRoot: c.dataRoot, runId: original.runId, decision: { id: 'ended-withdraw', requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'withdraw' } }), /QUEUE_SOURCE_ENDED/);
  }
});

test('changed-version improve confirmation withdraws the old request only; it never submits an analysis automatically', async () => {
  const f = fixture(), original = await runReadTask({ ...f, input: 'Completed analysis source', mode: 'offline', transport: scriptedTransport([]).fetch });
  const item = admit(f.dataRoot, original.runId, 'old-analysis', 'improve', JSON.stringify({ id: 'old-analysis', purpose: 'Keep the original analysis goal' }));
  activate(f.dataRoot, f.workspace);
  const plan = readQueueReattachment(f.dataRoot, item, { workspace: f.workspace, mode: 'offline' });
  assert.equal(plan.state, 'ready'); if (plan.state !== 'ready') return;
  assert.equal(plan.confirmation.route, 'relaunch-improve');
  const result = await decideQueue({ dataRoot: f.dataRoot, runId: original.runId, authorization: plan.confirmation.authorization, confirmation: plan.confirmation,
    decision: { id: 'withdraw-old-analysis', requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'reattach' } });
  assert.equal(result.status, 'withdrawn');
  assert.equal(readSessionChains(f.dataRoot).list().items.length, 1);
  assert.equal(readRunRecords(f.dataRoot, original.runId, { kinds: ['improve.started'] }).records.length, 0);
});

test('the immutable v1 aborted queue refuses reattachment; withdrawal and a new task in an independent workspace never revive it', async () => {
  const sourceFixture = fileURLToPath(new URL('../../test/fixtures/v1-records', import.meta.url)), source = join(sourceFixture, 'data');
  const names = JSON.parse(readFileSync(join(sourceFixture, 'fixture-identity.json'), 'utf8')).names as Record<string, string>;
  const runId = names['run.frozen-source'], sessionId = names['session.frozen-source'], recordedWorkspace = readSessionChains(source).session(sessionId)!.workspace!;
  const root = mkdtempSync(join(tmpdir(), 'durio-queue-v1-')), workspace = join(root, 'project'), dataRoot = join(root, 'data'), originalBytes = readFileSync(join(source, 'host.sqlite'));
  cpSync(join(sourceFixture, 'workspace'), workspace, { recursive: true });
  mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
  cpSync(join(source, 'objects'), join(dataRoot, 'objects'), { recursive: true }); cpSync(join(source, 'host.sqlite'), join(dataRoot, 'host.sqlite'));
  cpSync(join(source, 'sessions', sessionId), join(dataRoot, 'sessions', sessionId), { recursive: true });
  const db = new DatabaseSync(join(dataRoot, 'host.sqlite')); db.prepare('DELETE FROM records WHERE run_id<>?').run(runId); db.close();
  const admissions = () => readRunRecords(dataRoot, runId, { kinds: ['task.accepted', 'control.accepted'] }).records.map(record => ({ ref: record.ref, bytes: readObject(dataRoot, record.ref) }));
  const originalAdmissions = admissions();
  // Refusal and withdrawal inspect original facts; neither needs the old workspace to exist.
  const items = readOpenQueue(dataRoot, recordedWorkspace); assert.ok(items.some(entry => entry.item.kind === 'follow-up')); assert.ok(items.some(entry => entry.item.kind === 'compact'));
  for (const { item } of items) {
    const plan = readQueueReattachment(dataRoot, item, { workspace: recordedWorkspace, mode: 'offline' });
    assert.equal(plan.state, 'blocked'); assert.match(plan.state === 'blocked' ? plan.reason : '', /源任务未完成/);
    await assert.rejects(decideQueue({ dataRoot, runId, authorization: { workspace: recordedWorkspace, mode: 'offline', tools: ['read', 'write', 'edit', 'bash'] },
      decision: { id: `refuse-${item.requestId}`, requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'reattach' }, transport: scriptedTransport([]).fetch }), /QUEUE_SOURCE_NOT_COMPLETED/);
    await decideQueue({ dataRoot, runId, decision: { id: `withdraw-${item.requestId}`, requestId: item.requestId, target: item.target, receiptSeq: item.receipt.seq, action: 'withdraw' } });
  }
  // New authorization belongs to this test's independent workspace, never the recorded one.
  const transport = scriptedTransport([]), next = await runReadTask({ dataRoot, workspace, input: 'Explicit task in an independent workspace after reviewing the aborted v1 queue', mode: 'offline', transport: transport.fetch });
  assert.equal(next.status, 'completed'); assert.notEqual(readSessionChains(dataRoot).sessionOfRun(next.runId)?.id, sessionId);
  const chains = readSessionChains(dataRoot), nextSession = chains.sessionOfRun(next.runId)!;
  assert.equal(chains.session(nextSession.id)?.workspace, realpathSync(workspace));
  assert.equal(readRunRecords(dataRoot, next.runId, { kinds: ['context.imported'] }).records.length, 0);
  assert.equal(readOpenQueue(dataRoot, recordedWorkspace).length, 0); assert.equal(transport.calls.length, 1);
  assert.deepEqual(admissions(), originalAdmissions);
  assert.deepEqual(readFileSync(join(source, 'host.sqlite')), originalBytes);
});
