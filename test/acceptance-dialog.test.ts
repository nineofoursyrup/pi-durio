import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { records, watermark } from '../src/history.js';
import { readAcceptance, recordAcceptance } from '../src/metrics/acceptance.js';
import { queryTaskMetrics, queryFeedbackMetrics } from '../src/metrics/index.js';
import { AcceptanceDialog, annotationTarget, readAnnotation, saveAnnotation } from '../src/tui/acceptance.js';

const key = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b' };
const scope = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', asOf: '2100-01-01T00:00:00Z', source: 'synthetic' as const };
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'durio-acceptance-dialog-')), runId = randomUUID(), taskId = randomUUID(), sessionId = randomUUID();
 const e = new Evidence(root, runId);
 e.append('task.accepted', { taskId, sessionId, workspace: '/fixture', input: '按原要求完成结果', origin: { kind: 'coding', source: 'synthetic' } });
 e.append('run.started', {}); e.append('run.closed', { status: 'completed', cleanup: 'confirmed', answer: '交付的实际结果' }); e.close();
 return { root, runId, taskId, sessionId, acceptedSource: [...records(root, { kinds: ['task.accepted'] })][0].id };
}
const text = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');

test('optional annotation confirms explicit dimensions, preserves originals and revises without extending a young rework window into the future', () => {
 const target = fixture(), before = watermark(target.root), state = readAnnotation(target), dialog = new AcceptanceDialog(state);
 assert.equal(watermark(target.root), before, 'opening a form must not write');
 assert.match(text(dialog.render(132, 38)), /验收.*不记录/);
 assert.equal(dialog.handleInput(key.enter).type, 'noop', 'untouched default records nothing');
 dialog.handleInput('2'); dialog.handleInput(key.down); dialog.handleInput('2'); dialog.handleInput(key.down); dialog.handleInput('2');
 dialog.render(132, 38); assert.equal(dialog.handleInput(key.enter).type, 'confirm');
 const saved = saveAnnotation(state, dialog.submission);
 assert.equal(saved.sources.length, 5);
 const task = queryTaskMetrics(target.root, scope); assert.equal(task.counts.S, 1);
 const feedback = queryFeedbackMetrics(target.root, { ...scope, asOf: new Date().toISOString() });
 assert.equal(feedback.intervention.counts.Z, 1); assert.equal(feedback.rework.counts.immature, 1);
 const rework = feedback.rework.tasks[0].events[0];
 assert.ok(Date.parse(rework.input.coverage!.to) <= Date.parse(state.observedAt));
 assert.equal(queryFeedbackMetrics(target.root, scope).rework.counts.Ur, 1, 'partial absence does not mature into seven-day proof');
 const initial = readAcceptance(target.root, target.taskId);
 assert.equal(initial.find(f => f.data.type === 'requirements')!.data.source.kind, 'human');
 assert.deepEqual(initial.find(f => f.data.type === 'requirements')!.data.source.refs, [target.acceptedSource]);
 const reopened = new AcceptanceDialog(readAnnotation(target));
 assert.match(text(reopened.render(132, 38)), /◉ 2 通过/);
 reopened.handleInput('3');
 saveAnnotation(reopened.snapshot, reopened.submission);
 const revised = queryTaskMetrics(target.root, scope);
 assert.equal(revised.counts.S, 0); assert.equal(revised.tasks[0].acceptance.outcome, 'FAIL');
 assert.equal(readAcceptance(target.root, target.taskId).length, initial.length + 1);
 assert.ok(revised.tasks[0].acceptance.history.some(f => f.id === initial.at(-1)!.data.id && !f.withdrawn));
 assert.deepEqual(readAcceptance(target.root, target.taskId).slice(0, initial.length), initial, 'prior source bodies remain exact');
 for (const [w, h] of [[80, 24], [40, 12]]) {
  const lines = reopened.render(w, h); assert.ok(lines.length <= h); assert.ok(lines.every(line => visibleWidth(line) <= w));
  assert.match(text(lines), /写入记录/); assert.match(text(lines), /Esc 取消/);
 }
 reopened.render(40, 5); assert.equal(reopened.handleInput(key.enter).type, 'noop');
 assert.match(text(reopened.render(40, 5)), /窗口过小/);
});

test('CLI-declared necessary requirements stay individual; global verdict prefill cannot turn partial verification into PASS', () => {
 const target = fixture(), source = { kind: 'human' as const, actor: 'cli-user', statement: 'Declared original necessary requirements', refs: [target.acceptedSource] };
 recordAcceptance(target.root, { type: 'requirements', id: 'cli-requirements', taskId: target.taskId, ruleVersion: 'cli-rule', necessary: [{ id: 'first', description: '第一个必要要求' }, { id: 'rework', description: '第二个必要要求，身份可与 UI 字段同名' }], source });
 const original = readAcceptance(target.root, target.taskId)[0];
 const dialog = new AcceptanceDialog(readAnnotation(target), { verdict: 'pass' });
 assert.match(text(dialog.render(132, 38)), /须逐条确认/);
 assert.equal(dialog.handleInput(key.enter).type, 'noop');
 dialog.handleInput('2'); saveAnnotation(dialog.snapshot, dialog.submission);
 assert.equal(queryTaskMetrics(target.root, scope).tasks[0].acceptance.outcome, 'unknown');
 const next = new AcceptanceDialog(readAnnotation(target)); next.handleInput(key.down); next.handleInput('2');
 saveAnnotation(next.snapshot, next.submission);
 const after = queryTaskMetrics(target.root, scope);
 assert.equal(after.counts.S, 1);
 assert.deepEqual(after.tasks[0].acceptance.judgments.at(-1)!.findings.map(f => f.requirementId), ['first', 'rework']);
 assert.deepEqual(readAcceptance(target.root, target.taskId)[0], original, 'the explicit CLI contract is never replaced by a synthesized whole-task requirement');
 assert.equal(readAcceptance(target.root, target.taskId).filter(f => f.data.type === 'requirements').length, 1);
});

test('confirmation rechecks capability, ownership, selected identity and retained revisions before any append', () => {
 const target = fixture(), dialog = new AcceptanceDialog(readAnnotation(target), { verdict: 'pass' }), before = watermark(target.root);
 assert.throws(() => saveAnnotation(dialog.snapshot, dialog.submission, () => '结束后再记录'), /结束后再记录/);
 assert.equal(watermark(target.root), before);
 mkdirSync(`${target.root}.lock`); writeFileSync(join(target.root, 'owner.json'), 'external owner');
 try { assert.throws(() => saveAnnotation(dialog.snapshot, dialog.submission), /OWNER_CONFLICT/); }
 finally { rmSync(join(target.root, 'owner.json')); rmSync(`${target.root}.lock`, { recursive: true }); }
 assert.equal(watermark(target.root), before);
 assert.throws(() => readAnnotation({ ...target, taskId: 'different-task' }), /ANNOTATION_IDENTITY_CHANGED/);
 assert.throws(() => readAnnotation({ ...target, runId: 'different-run' }), /ANNOTATION_IDENTITY_CHANGED/);
 recordAcceptance(target.root, { type: 'requirements', id: 'later-rule', taskId: target.taskId, source: { kind: 'human', actor: 'cli-user', statement: 'A requirement was declared while the form was open', refs: [] }, ruleVersion: 'v1', necessary: [{ id: 'goal', description: 'Original task input' }] });
 const newer = watermark(target.root);
 assert.throws(() => saveAnnotation(dialog.snapshot, dialog.submission), /ANNOTATION_CHANGED/);
 assert.equal(watermark(target.root), newer);
 const rule = [...records(target.root, { kinds: ['acceptance.requirements'] })][0];
 unlinkSync(join(target.root, 'objects', rule.ref.sha256));
 assert.throws(() => readAnnotation(target), /acceptance original unavailable/);
 assert.equal(watermark(target.root), newer);
});

test('pending follow-ups and reopened recoveries remain blocked; a withdrawn unrun task binds only its real withdrawal fact', () => {
 const target = fixture(), other = fixture();
 assert.equal(annotationTarget(target.root, undefined, target.runId).taskId, target.taskId);
 assert.throws(() => annotationTarget(target.root, undefined, other.runId), /当前会话没有已结束/);
 let e = new Evidence(target.root, target.runId);
 e.append('control.accepted', { requestId: 'unrun', taskId: 'queued-task', kind: 'follow-up', input: 'Later task', target: { workspace: '/fixture', sessionId: target.sessionId, taskId: target.taskId, runId: target.runId }, executionVersion: { artifactId: 'v', configSeq: 0, artifactSeq: 0 }, authorization: {} });
 e.close();
 const unrun = annotationTarget(target.root, 'queued-task'); assert.equal(unrun.runId, null);
 assert.throws(() => readAnnotation(unrun), /未运行/);
 assert.equal(annotationTarget(target.root, undefined, target.runId).taskId, target.taskId);
 e = new Evidence(target.root, target.runId); e.append('recovery.started', {}); e.close();
 assert.throws(() => readAnnotation(target), /结束后再记录/);
 assert.throws(() => annotationTarget(target.root, undefined, target.runId), /当前会话没有已结束/);
 e = new Evidence(target.root, target.runId); e.append('control.receipt', { requestId: 'unrun', status: 'withdrawn', reason: 'Never run' }); e.close();
 const withdrawn = readAnnotation(unrun), dialog = new AcceptanceDialog(withdrawn, { verdict: 'fail' });
 assert.equal(withdrawn.target.runId, null); assert.match(text(dialog.render(132, 38)), /未运行.*已撤回/);
 assert.equal(withdrawn.startedSource, undefined);
 const saved = saveAnnotation(withdrawn, dialog.submission); assert.equal(saved.sources.length, 3);
 const after = queryTaskMetrics(target.root, scope).tasks.find(t => t.taskId === 'queued-task')!;
 assert.equal(after.runId, null); assert.equal(after.startedSource, null); assert.equal(after.normalCompleted, false);
 assert.equal(after.acceptance.outcome, 'FAIL');
 assert.deepEqual(after.acceptance.results[0].evidence, [[...records(target.root, { kinds: ['control.receipt'] })].at(-1)!.id]);
});


test('annotation note accepts pasted text and cursor edits; arrow keys can reveal the final explanation without PageDown', () => {
 const dialog = new AcceptanceDialog(readAnnotation(fixture()));
 for (let i = 0; i < 3; i++) dialog.handleInput(key.down);
 dialog.handleInput('\x1b[200~说明 AB\x1b[201~'); dialog.handleInput('\x1b[D'); dialog.handleInput('X');
 assert.equal(dialog.submission.note, '说明 AXB');
 for (let i = 0; i < 30; i++) { dialog.handleInput(key.down); dialog.render(40, 12); }
 assert.match(text(dialog.render(40, 12)), /首尾继续滚动/);
});
