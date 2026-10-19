/** M7/U13: explicit, optional task annotations. Reading the form never takes a writer lease. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { matchesKey } from '@earendil-works/pi-tui';
import { digest, readAcceptedTasks, type AcceptedTaskFact } from '../evidence.js';
import { decode, records, resolveEvidence, watermark } from '../history.js';
import { readSessionChains } from '../session-chain.js';
import { withOwnerSync } from '../ownership.js';
import { readDisplayIndex } from '../display-number.js';
import { readAcceptance, recordAcceptance, selectAcceptance, type AcceptanceInput, type AcceptanceFact, type Verdict } from '../metrics/acceptance.js';
import { feedbackHistory, recordFeedback, type FeedbackInput, type FeedbackFact, type OccurrenceInterval } from '../metrics/feedback.js';
import { COLOR_TIER, type ColorTier } from './theme.js';
import { ConfirmDialog, SingleLineInput, wrapAuthorized, type ConfirmResult } from './view-stack.js';

export interface AnnotationTarget { root: string; taskId: string; runId: string | null; acceptedSource: string; sessionId?: string | null }
export interface AnnotationPrefill { verdict?: 'pass' | 'fail' | 'unknown'; intervention?: 'none' | 'yes' | 'unknown'; rework?: 'none' | 'yes' | 'unknown'; note?: string }
type Finding = 'unrecorded' | Verdict;
type Feedback = 'unrecorded' | 'none' | 'yes' | 'unknown';
interface Values { findings: Record<string, Finding>; intervention: Feedback; rework: Feedback; note: string }
export interface AnnotationSubmission extends Values { changed: string[] }
type Observation = FeedbackFact & { data: FeedbackFact['data'] & Extract<FeedbackInput, { type: 'observation' }> };
const DAY = 24 * 60 * 60 * 1000;
export const ANNOTATION_IMPACT = '写入记录 · 不调用模型 · 再记一次即为更正，原记录保留';
export const ANNOTATION_RUNNING = '结束后再记录';
const fail = (message: string): never => { throw Error(message); };
const UNRUN = '该任务未运行且尚未结束，不能补记结果';
function admissions(root: string, through: number) {
 const found: AcceptedTaskFact[] = []; let after: number | undefined;
 do { const page = readAcceptedTasks(root, { through, after, limit: 200 }); found.push(...page.tasks); after = page.next ?? undefined; if (found.length > 10000) fail('补记查询超过上限 · 请缩小数据根范围'); } while (after);
 return found;
}
function currentFeedback(facts: FeedbackFact[], dimension: 'intervention' | 'rework') {
 const replaced = new Set(facts.flatMap(f => f.data.type === 'observation' && f.data.revisionOf ? [f.data.revisionOf] : []));
 const withdrawn = new Set(facts.flatMap(f => f.data.type === 'withdraw' ? f.data.targets : []));
 return facts.filter((f): f is Observation => f.data.type === 'observation' && f.data.dimension === dimension && !replaced.has(f.data.id) && !withdrawn.has(f.data.id));
}
function noteOf(fact?: AcceptanceFact | FeedbackFact) {
 try { const statement = JSON.parse(fact?.data.source.statement ?? ''); return statement.form === 'pi-durio-annotation-v1' && typeof statement.note === 'string' ? statement.note : ''; } catch { return ''; }
}
function valueOf(facts: Observation[]): Feedback {
 if (!facts.length) return 'unrecorded';
 const value = facts[0].data;
 if (facts.length !== 1 || value.source.kind === 'unverified') return 'unknown';
 return value.meaning === 'none' ? 'none' : value.meaning === 'correction' && value.originalRequirement === 'unmet' && ['requested', 'started', 'completed'].includes(value.correction ?? '') ? 'yes' : 'unknown';
}

/** Preserve the exact selected admission and run, including null for an unrun follow-up. */
export function annotationTarget(root: string, taskId?: string, currentRunId?: string): AnnotationTarget {
 const through = watermark(root), tasks = admissions(root, through), chains = readSessionChains(root, { through });
 const targetOf = (task: AcceptedTaskFact): AnnotationTarget => {
  const admission = [...records(root, { after: task.acceptedSeq - 1, through: task.acceptedSeq })][0];
  return { root, taskId: task.taskId, runId: task.runId, acceptedSource: admission.id, sessionId: chains.sessionOfRun(task.runId ?? task.target?.runId ?? admission.runId)?.id ?? task.target?.sessionId };
 };
 if (taskId) {
  const task = tasks.find(t => t.taskId === taskId) ?? fail('找不到该任务 · ACCEPTANCE_TASK_NOT_FOUND');
  return targetOf(task);
 }
 const session = currentRunId && chains.sessionOfRun(currentRunId)?.id;
 if (!session) fail('当前会话没有已结束的任务');
 for (const task of tasks.toReversed()) {
  const target = targetOf(task); if (target.sessionId !== session) continue;
  try { readAnnotation(target); return target; }
  catch (error) { if (!(error instanceof Error) || ![ANNOTATION_RUNNING, UNRUN].includes(error.message)) throw error; }
 }
 return fail('当前会话没有已结束的任务');
}

export function readAnnotation(target: AnnotationTarget, now = new Date()) {
 const root = realpathSync(target.root), through = watermark(root), selected = resolveEvidence(root, target.acceptedSource), selectedData = decode(root, selected);
 if (!['task.accepted', 'control.accepted'].includes(selected.kind) || selectedData.taskId !== target.taskId) fail('任务身份已变化 · ANNOTATION_IDENTITY_CHANGED');
 const task = admissions(root, through).find(t => t.taskId === target.taskId) ?? fail('找不到该任务 · ACCEPTANCE_TASK_NOT_FOUND');
 const admission = [...records(root, { after: task.acceptedSeq - 1, through: task.acceptedSeq })][0];
 // Executed follow-ups have both an original control admission and a linked task admission.
 if (admission.id !== selected.id && !(task.kind === 'follow-up' && selected.kind === 'task.accepted' && selectedData.queueRequestId === task.requestId && selected.runId === task.runId)) fail('受理来源已变化 · ANNOTATION_IDENTITY_CHANGED');
 if (target.runId !== task.runId) fail('运行身份已变化 · ANNOTATION_IDENTITY_CHANGED');
 const runId = target.runId, evidenceRunId = runId ?? (task.kind === 'task' ? admission.runId : undefined);
 const sessionId = readSessionChains(root, { through }).sessionOfRun(runId ?? task.target?.runId ?? admission.runId)?.id ?? null;
 if (target.sessionId && target.sessionId !== sessionId) fail('会话身份已变化 · ANNOTATION_IDENTITY_CHANGED');
 const lifecycle = evidenceRunId ? [...records(root, { runId: evidenceRunId, through, kinds: ['run.started', 'run.closed', 'recovery.started', 'recovery.closed', 'recovery.ended'] })].map(ref => ({ ref, data: decode(root, ref) })) : [];
 const start = lifecycle.find(f => f.ref.kind === 'run.started');
 let end = lifecycle.findLast(f => ['run.closed', 'recovery.closed', 'recovery.ended'].includes(f.ref.kind));
 if (!evidenceRunId && task.kind === 'follow-up' && task.receipt.kind === 'control.receipt') {
  const ref = [...records(root, { after: task.receipt.seq - 1, through: task.receipt.seq })][0], data = decode(root, ref);
  if (data.requestId === task.requestId && data.status === 'withdrawn') end = { ref, data };
 }
 const result = end?.data.result ?? end?.data;
 if (!end || lifecycle.some(f => f.ref.kind === 'recovery.started' && f.ref.seq > end!.ref.seq) || !['recovery.ended', 'control.receipt'].includes(end.ref.kind) && !(result.cleanup === 'confirmed' && ['completed', 'failed', 'aborted', 'cancelled', 'timed-out'].includes(result.status))) fail(runId ? ANNOTATION_RUNNING : UNRUN);
 const terminal = end!;
 const delivery = start && lifecycle.find(f => f.ref.seq > start.ref.seq && ['run.closed', 'recovery.closed'].includes(f.ref.kind) && (f.data.result ?? f.data).status === 'completed' && (f.data.result ?? f.data).cleanup === 'confirmed' && typeof (f.data.result ?? f.data).answer === 'string' && !!(f.data.result ?? f.data).answer.trim());
 const history = readAcceptance(root, task.taskId, through), feedback = feedbackHistory(root, admission.runId, task.taskId, through);
 if (feedback.missing.length) fail('反馈原件不可读取，不能追加更正 · INVALID_FEEDBACK');
 const selectedAcceptance = selectAcceptance(root, task.taskId, runId, through, now.toISOString(), admission.runId);
 const rule = selectedAcceptance.requirements.length === 1 ? history.find(f => f.data.id === selectedAcceptance.requirements[0].id) : undefined;
 const product = selectedAcceptance.results.length === 1 ? history.find(f => f.data.id === selectedAcceptance.results[0].id) : undefined;
 let acceptanceBlocked: string | undefined;
 if (!rule && history.some(f => f.data.type === 'requirements') || selectedAcceptance.results.length > 1 || !product && history.some(f => f.data.type === 'result')) acceptanceBlocked = '要求或结果已撤回/分支冲突，请先通过 CLI 核对';
 if (selectedAcceptance.reasons.some(reason => /validity disputed|evidence unavailable/.test(reason))) acceptanceBlocked = '要求或结果依据不可用，请先通过 CLI 核对';
 const necessary = rule?.data.type === 'requirements' ? rule.data.necessary : [{ id: 'original-task-input', description: task.input.length <= 4096 ? task.input : `原任务完整输入（见 ${admission.id}）` }];
 const reuseProduct = product?.data.type === 'result' && product.data.requirementsId === rule?.data.id && product.ref.seq > terminal.ref.seq ? product : undefined;
 const superseded = new Set(history.flatMap(f => f.data.type === 'judgment' ? f.data.supersedes ?? [] : []));
 const withdrawn = new Set(history.flatMap(f => f.data.type === 'withdraw' ? f.data.targets : []));
 const judgments = reuseProduct && rule ? history.filter(f => f.data.type === 'judgment' && f.data.resultId === reuseProduct.data.id && f.data.requirementsId === rule.data.id && !superseded.has(f.data.id) && !withdrawn.has(f.data.id)) : [];
 const findings: Record<string, Finding> = {};
 for (const requirement of necessary) {
  const values = judgments.map(j => selectedAcceptance.judgments.find(a => a.id === j.data.id)?.findings.find(f => f.requirementId === requirement.id)?.outcome ?? 'unknown');
  findings[requirement.id] = !values.length ? 'unrecorded' : new Set(values).size === 1 ? values[0] : 'unknown';
 }
 const intervention = currentFeedback(feedback.facts, 'intervention'), rework = currentFeedback(feedback.facts, 'rework');
 const observedAt = now.toISOString(), interventionEnd = delivery?.ref.at ?? terminal.ref.at;
 const interventionWindow: OccurrenceInterval | undefined = start && { from: start.ref.at, to: interventionEnd, bounds: '[]' };
 const reworkEnd = delivery && new Date(Date.parse(delivery.ref.at) + 7 * DAY).toISOString();
 const reworkWindow: OccurrenceInterval | undefined = delivery && { from: delivery.ref.at, to: Date.parse(reworkEnd!) <= now.getTime() ? reworkEnd! : observedAt, bounds: Date.parse(reworkEnd!) <= now.getTime() ? '[)' : '[]' };
 const invalidWindow = (window?: OccurrenceInterval) => !window || Date.parse(window.from) > Date.parse(window.to) || Date.parse(window.to) > now.getTime();
 const feedbackBlocked = {
  intervention: intervention.length > 1 ? '已有多条独立介入观察，请通过 CLI 逐项核对' : !start ? '没有任务开始事实，不能补记人工介入' : invalidWindow(interventionWindow) ? '介入阶段时间不可确认' : undefined,
  rework: rework.length > 1 ? '已有多条独立返工观察，请通过 CLI 逐项核对' : !delivery ? '没有宿主首次交付，不能补记交付后返工' : invalidWindow(reworkWindow) ? '返工观察时间不可确认' : undefined,
 };
 const latest = [...judgments, ...intervention, ...rework].toSorted((a, b) => a.ref.seq - b.ref.seq).at(-1);
 const initial: Values = { findings, intervention: valueOf(intervention), rework: valueOf(rework), note: noteOf(latest) };
 const bound = { ...target, root, runId, sessionId };
 const implicitRule = rule?.data.type === 'requirements' && rule.data.ruleVersion === 'original-task-input-v1' && rule.data.source.actor === 'tui-user';
 return { target: bound, label: readDisplayIndex(root).label('task', task.taskId), observedAt, through, input: task.input, admissionSource: admission.id, terminalSource: terminal.ref.id, startedSource: start?.ref.id, deliverySource: delivery?.ref.id,
  necessary, declared: !!rule && !implicitRule, rule, product, reuseProduct, judgments, history, feedback: feedback.facts, currentFeedback: { intervention, rework }, initial,
  status: start ? `宿主已结束 · ${result.status ?? 'ended'}` : `未运行 · ${terminal.ref.kind === 'control.receipt' ? '已撤回' : '已终止'} · 仅引用结束事实，不表示执行完成`,
  interventionWindow, reworkWindow, reworkMature: !!reworkEnd && Date.parse(reworkEnd) <= now.getTime(), reworkEnd, acceptanceBlocked, feedbackBlocked,
  identity: digest(JSON.stringify({ target: bound, admission: admission.id, terminal: terminal.ref.id, lifecycle: lifecycle.map(f => f.ref.id), acceptance: history.map(f => f.ref.id), feedback: feedback.facts.map(f => f.ref.id) })) };
}
export type AnnotationSnapshot = ReturnType<typeof readAnnotation>;
function changes(snapshot: AnnotationSnapshot, value: AnnotationSubmission) {
 const noteChanged = value.note !== snapshot.initial.note;
 return { acceptance: Object.values(value.findings).some(v => v !== 'unrecorded') && (noteChanged || snapshot.necessary.some(r => value.changed.includes(`requirement:${r.id}`))),
  intervention: value.intervention !== 'unrecorded' && (noteChanged || value.changed.includes('intervention')),
  rework: value.rework !== 'unrecorded' && (noteChanged || value.changed.includes('rework')) };
}
function source(action: string, note: string, refs: string[], scope?: OccurrenceInterval) {
 return { kind: 'human' as const, actor: 'tui-user', statement: JSON.stringify({ form: 'pi-durio-annotation-v1', action, note, ...(scope ? { scope } : {}) }), refs };
}
export class AnnotationWriteError extends Error {
 constructor(readonly sources: string[], cause: unknown) { super(`补记未全部写入：${String(cause)}`, { cause }); }
}

/** A single verified writer lease encloses the re-read and every existing append API. */
export function saveAnnotation(snapshot: AnnotationSnapshot, value: AnnotationSubmission, blocked: () => string | undefined = () => undefined) {
 const guard = () => { const reason = blocked(); if (reason) fail(reason); };
 guard();
 return withOwnerSync(snapshot.target.root, root => {
  guard();
  const current = readAnnotation(snapshot.target, new Date(snapshot.observedAt));
  if (current.identity !== snapshot.identity) fail('任务或补记记录已变化，请重新打开补记框 · ANNOTATION_CHANGED');
  const changed = changes(snapshot, value);
  if (changed.acceptance && snapshot.acceptanceBlocked) fail(snapshot.acceptanceBlocked);
  for (const dimension of ['intervention', 'rework'] as const) if (changed[dimension] && snapshot.feedbackBlocked[dimension]) fail(snapshot.feedbackBlocked[dimension]!);
  const sources: string[] = [], id = () => randomUUID(), taskId = snapshot.target.taskId, reason = value.note || '用户在补记框中明确更正，原记录保留';
  try {
   if (changed.acceptance) {
    let requirementsId = snapshot.rule?.data.id;
    if (!requirementsId) {
     requirementsId = id(); sources.push(recordAcceptance(root, { type: 'requirements', id: requirementsId, taskId, source: source('以原任务完整输入为唯一必要要求', value.note, [snapshot.admissionSource]), ruleVersion: 'original-task-input-v1', necessary: snapshot.necessary }).source);
    }
    let resultId = snapshot.reuseProduct?.data.id;
    if (!resultId) {
     resultId = id(); sources.push(recordAcceptance(root, { type: 'result', id: resultId, taskId, source: source('绑定所选任务的宿主结束结果', value.note, [snapshot.terminalSource]), requirementsId, evidence: [snapshot.terminalSource], ...(snapshot.product ? { revisionOf: snapshot.product.data.id, reason } : {}) }).source);
    }
    const findings = snapshot.necessary.flatMap(r => { const outcome = value.findings[r.id]; return outcome && outcome !== 'unrecorded' ? [{ requirementId: r.id, outcome, evidence: snapshot.reuseProduct?.data.type === 'result' ? snapshot.reuseProduct.data.evidence : [snapshot.terminalSource] }] : []; });
    sources.push(recordAcceptance(root, { type: 'judgment', id: id(), taskId, source: source('逐条确认必要要求；不记录项不表示已验证', value.note, [snapshot.admissionSource, snapshot.terminalSource]), requirementsId, resultId, validity: 'valid', findings, ...(snapshot.judgments.length ? { supersedes: snapshot.judgments.map(j => j.data.id), reason } : {}) }).source);
   }
   for (const dimension of ['intervention', 'rework'] as const) {
    if (!changed[dimension]) continue;
    const choice = value[dimension], scope = (dimension === 'intervention' ? snapshot.interventionWindow : snapshot.reworkWindow)!, previous = snapshot.currentFeedback[dimension][0];
    const input: FeedbackInput = { type: 'observation', id: id(), taskId, dimension, meaning: choice === 'yes' ? 'correction' : choice === 'none' ? 'none' : 'unknown',
     source: source(`${dimension === 'intervention' ? '首次交付前为原要求纠错、手工修复或接管' : '交付后原要求未满足，已提出或开始纠正'}：${choice}`, value.note, [snapshot.admissionSource, snapshot.terminalSource], scope),
     requirements: [snapshot.rule?.ref.id ?? snapshot.admissionSource], occurredAt: choice === 'none' ? snapshot.observedAt : null,
     ...(choice === 'yes' ? { originalRequirement: 'unmet', correction: dimension === 'intervention' ? 'started' : 'requested', occurredDuring: scope } : choice === 'none' ? { coverage: { from: scope.from, to: scope.to } } : {}),
     ...(dimension === 'rework' ? { delivery: snapshot.deliverySource } : {}), resultSources: [snapshot.terminalSource], ...(previous ? { revisionOf: previous.data.id, reason } : {}) };
    sources.push(recordFeedback(root, input).source);
   }
  } catch (error) { if (sources.length) throw new AnnotationWriteError(sources, error); throw error; }
  return { sources };
 });
}

/** Three logical single-choice rows, or one row per declared necessary requirement. */
export class AcceptanceDialog {
 private readonly values: Values;
 private readonly touched = new Set<string>();
 private cursor = 0;
 private readonly frame: ConfirmDialog;
 private readonly note: SingleLineInput;
 private readonly prefillHint?: string;
 constructor(readonly snapshot: AnnotationSnapshot, prefill: AnnotationPrefill = {}) {
  this.values = structuredClone(snapshot.initial);
  if (prefill.note !== undefined) this.values.note = prefill.note.slice(0, 1000);
  if (prefill.verdict) {
   if (snapshot.declared) this.prefillHint = `预填验收：${prefill.verdict} · 已声明要求，须逐条确认`;
   else { const id = snapshot.necessary[0].id; this.values.findings[id] = prefill.verdict === 'unknown' ? 'unknown' : prefill.verdict.toUpperCase() as Verdict; this.touched.add(`requirement:${id}`); }
  }
  for (const dimension of ['intervention', 'rework'] as const) if (prefill[dimension]) { this.values[dimension] = prefill[dimension]; this.touched.add(dimension); }
  this.note = new SingleLineInput(this.values.note, 1000);
  this.frame = new ConfirmDialog({
   title: `补记 ${snapshot.label}`, action: '保存补记', fixed: [ANNOTATION_IMPACT], disabled: () => this.blockedReason,
   bodyRows: inner => this.body(inner).map(item => ({ segments: [{ text: item.text, fg: item.row === this.cursor ? 'fg.primary' : 'fg.body' }], cursor: item.row === this.cursor })),
  });
 }
 get submission(): AnnotationSubmission { return { ...structuredClone(this.values), changed: [...this.touched] }; }
 private get rowIds() { return [...this.snapshot.necessary.map(r => `requirement:${r.id}`), 'intervention', 'rework', 'note']; }
 get disabledReason() { return this.frame.disabledReason; }
 private get blockedReason() {
  const changed = changes(this.snapshot, this.submission);
  if (changed.acceptance && this.snapshot.acceptanceBlocked) return this.snapshot.acceptanceBlocked;
  for (const d of ['intervention', 'rework'] as const) if (changed[d] && this.snapshot.feedbackBlocked[d]) return this.snapshot.feedbackBlocked[d];
  return Object.values(changed).some(Boolean) ? undefined : '没有需要写入的改动';
 }
 handleInput(data: string): ConfirmResult {
  if (matchesKey(data, 'escape')) return { type: 'cancel' };
  if (matchesKey(data, 'enter')) return this.disabledReason ? { type: 'noop' } : { type: 'confirm', selected: [] };
  if (matchesKey(data, 'up') || matchesKey(data, 'shift+tab')) { if (this.cursor === 0) this.frame.scrollBy(-1); else { this.cursor--; this.frame.revealCursor(); } return { type: 'handled' }; }
  if (matchesKey(data, 'down') || matchesKey(data, 'tab')) { if (this.cursor === this.rowIds.length - 1) this.frame.scrollBy(1); else { this.cursor++; this.frame.revealCursor(); } return { type: 'handled' }; }
  if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) { this.frame.scrollBy(matchesKey(data, 'pageUp') ? -3 : 3); return { type: 'handled' }; }
  const row = this.rowIds[this.cursor];
  if (row === 'note') {
   this.note.handleInput(data); this.values.note = this.note.getValue();
  } else {
   const options = row === 'intervention' || row === 'rework' ? ['unrecorded', 'none', 'yes', 'unknown'] as const : ['unrecorded', 'PASS', 'FAIL', 'unknown'] as const;
   const requirementId = row.slice('requirement:'.length);
   const current = row === 'intervention' || row === 'rework' ? this.values[row] : this.values.findings[requirementId];
   const index = /^[1-4]$/.test(data) ? Number(data) - 1 : matchesKey(data, 'left') ? options.findIndex(v => v === current) - 1 : matchesKey(data, 'right') ? options.findIndex(v => v === current) + 1 : -1;
   if (index < 0 || index >= options.length) return { type: 'noop' };
   if (row === 'intervention' || row === 'rework') this.values[row] = options[index] as Feedback; else this.values.findings[requirementId] = options[index] as Finding;
   this.touched.add(row);
  }
  return { type: 'handled' };
 }
 render(columns: number, rows: number, tier: ColorTier = COLOR_TIER): string[] {
  return this.frame.render(columns, rows, tier);
 }
 private body(inner: number) {
  const out: { text: string; row?: number }[] = [];
  const add = (text: string, row?: number) => out.push(...wrapAuthorized(text, inner).map(text => ({ text, row })));
  add(this.snapshot.status);
  if (this.prefillHint) add(this.prefillHint);
  this.snapshot.necessary.forEach((requirement, row) => {
   const selected = this.values.findings[requirement.id];
   const choices: [Finding, string][] = [['unrecorded', '不记录'], ['PASS', '通过'], ['FAIL', '未通过'], ['unknown', '无法判断']];
   add(`${row === this.cursor ? '›' : ' '} 验收${this.snapshot.declared ? ` · 要求 ${row + 1}` : ''}  ${choices.map(([value, label], i) => `${selected === value ? '◉' : '○'} ${i + 1} ${label}`).join('  ')}`, row);
   add(`要求：${requirement.description}`, row);
  });
  for (const [offset, dimension] of (['intervention', 'rework'] as const).entries()) {
   const row = this.snapshot.necessary.length + offset, selected = this.values[dimension];
   const choices: [Feedback, string][] = [['unrecorded', '不记录'], ['none', '没有'], ['yes', '有'], ['unknown', '不确定']];
   add(`${row === this.cursor ? '›' : ' '} ${dimension === 'intervention' ? '人工介入 · 首次交付前' : '交付后返工'}  ${choices.map(([value, label], i) => `${selected === value ? '◉' : '○'} ${i + 1} ${label}`).join('  ')}`, row);
   const scope = dimension === 'intervention' ? this.snapshot.interventionWindow : this.snapshot.reworkWindow;
   if (scope) add(`声明范围 ${scope.bounds[0]}${scope.from}, ${scope.to}${scope.bounds[1]}`, row);
   if (dimension === 'intervention') add('“有”指为原要求纠错、手工修复或接管；正常授权、澄清和新需求不计。', row);
   else add(this.snapshot.reworkMature ? '首次交付起 7 天；“有”指原要求未满足，已提出或开始纠正。' : '未满 7 天 · 仅声明截至打开时的观察；“没有”不表示全窗无返工。', row);
   if (this.snapshot.feedbackBlocked[dimension]) add(this.snapshot.feedbackBlocked[dimension]!, row);
  }
  add('说明（选填） · Ctrl+A 清空');
  if (this.cursor === this.rowIds.length - 1) out.push({ text: this.note.render(inner)[0], row: this.cursor });
  else add(this.values.note || '直接输入', this.rowIds.length - 1);
  if (this.snapshot.acceptanceBlocked) add(this.snapshot.acceptanceBlocked);
  add('↑↓ 换行（首尾继续滚动） · 数字键选择');
  return out;
 }
}
