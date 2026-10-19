import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { Evidence, readQueue } from '../src/evidence.js';
import { readContinuation } from '../src/continuation.js';
import { readSessionChains } from '../src/session-chain.js';
import { inspectRecovery } from '../src/runtime.js';
import { readWelcomeFacts, renderWelcome } from '../src/tui/welcome.js';
import { readRecoveryFacts } from '../src/tui/recovery.js';
import { StorageView } from '../src/tui/storage.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durio-session-review-')), workspace = join(root, 'project'), dataRoot = join(root, 'data');
  mkdirSync(workspace);
  return { workspace, dataRoot };
}

test('welcome and continuation agree on unknown cleanup, ended work, and completed improve sessions', () => {
  const f = fixture();
  for (const runId of ['unclean', 'ended', 'improve']) {
    const e = new Evidence(f.dataRoot, runId);
    e.append('task.accepted', { runId, sessionId: `${runId}-session`, taskId: `${runId}-task`, workspace: f.workspace, input: runId, ...(runId === 'improve' ? { kind: 'improve' } : {}), authorization: { execution: 'trusted-local-read-only', tools: ['read'] } });
    e.append('run.closed', { status: 'completed', cleanup: runId === 'unclean' ? 'unknown' : 'confirmed' });
    if (runId === 'ended') e.append('recovery.ended', { runId });
    e.close();
  }
  const facts = readWelcomeFacts({ ...f, coding: false, mode: 'offline' }, id => id, 'tip');
  assert.ok(Array.isArray(facts.sessions));
  assert.deepEqual(Object.fromEntries(facts.sessions.map(session => [session.input, session.status])), { improve: 'completed', ended: 'ended', unclean: 'unknown' });
  const shown = renderWelcome({ ...facts, lock: { state: 'readonly' } }, 132, 30, new Date()).lines.map(stripTerminalSequences).join('\n');
  assert.match(shown, /unclean.*待恢复核对/); assert.match(shown, /ended.*已结束/);
  assert.equal(readContinuation(f.dataRoot, 'unclean-session')?.state, 'recovery');
  const improve = readContinuation(f.dataRoot, 'improve-session');
  assert.equal(improve?.state, 'blocked');
  if (improve?.state === 'blocked') { assert.match(improve.reason, /improve 分析自成会话/); assert.doesNotMatch(improve.reason, /任务未完成/); }
});

test('recovery displays pending and dispatching admissions without changing their durable status', async () => {
  const f = fixture(), runId = 'recovery-run', e = new Evidence(f.dataRoot, runId);
  const target = { workspace: f.workspace, runId, sessionId: 'recovery-session', taskId: 'recovery-task' };
  e.append('task.accepted', { ...target, input: 'interrupted', authorization: { tools: ['read'] } });
  e.append('run.closed', { status: 'unknown', cleanup: 'confirmed' });
  for (const [requestId, status] of [['pending', 'pending'], ['dispatching', 'dispatching'], ['frozen', 'frozen'], ['withdrawn', 'withdrawn']] as const) {
    e.append('control.accepted', { requestId, kind: 'follow-up', input: requestId, target });
    if (status !== 'pending') e.append('control.receipt', { requestId, status, reason: 'test' });
  }
  e.close();
  const before = readQueue(f.dataRoot).items, report = await inspectRecovery({ dataRoot: f.dataRoot, runId });
  const facts = readRecoveryFacts(f.dataRoot, [report], { queue: before });
  assert.equal(facts.frozen.count, 3); assert.equal(facts.frozen.first?.text, 'pending');
  assert.deepEqual(readQueue(f.dataRoot).items.map(item => [item.requestId, item.status]), before.map(item => [item.requestId, item.status]));
});

test('storage last activity uses a later session fact rather than task acceptance', async () => {
  const f = fixture(), e = new Evidence(f.dataRoot, 'activity-run');
  e.append('task.accepted', { runId: 'activity-run', sessionId: 'activity-session', taskId: 'activity-task', workspace: f.workspace, input: 'later activity' });
  e.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  e.close();
  mkdirSync(join(f.dataRoot, 'sessions', 'activity-session'), { recursive: true });
  const db = new DatabaseSync(join(f.dataRoot, 'host.sqlite'));
  db.prepare("UPDATE records SET at=? WHERE kind='task.accepted'").run('2020-01-02T01:02:00.000Z');
  db.prepare("UPDATE records SET at=? WHERE kind='run.closed'").run('2021-03-04T05:06:00.000Z'); db.close();
  const last = new Date(readSessionChains(f.dataRoot).session('activity-session')!.lastAt), pad = (n: number) => String(n).padStart(2, '0');
  const expected = `${pad(last.getMonth() + 1)}-${pad(last.getDate())} ${pad(last.getHours())}:${pad(last.getMinutes())}`;
  const view = new StorageView(f.dataRoot, { changed() {}, busy: () => false, feedback() {}, confirm() {}, writeBlocked: () => undefined });
  await view.ready;
  const row = view.render(160, 30).map(stripTerminalSequences).find(line => line.includes('later activity'));
  assert.ok(row?.trimEnd().endsWith(expected), row);
});
