/**
 * 2b 的取数（U8、V7）：列表层的计划来源（主数据根与 improve 发起的子数据根）、计划报告、trial 的宿主中介记录，
 * 以及受限侧原文副本。只读：不取锁、不写记录、不调用模型。视图在 `src/tui/eval.ts` 与 `src/tui/eval-trial.ts`。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHostReadonly, readObject, type BlobRef } from '../evidence.js';
import { DisplayIndex, DisplayInputError, readDisplayIndex } from '../display-number.js';
import { readImproveReport } from '../improve.js';
import { evalReport } from './runner.js';
import { evalFacts } from './store.js';

export type EvalReport = ReturnType<typeof evalReport>;
export type EvalReportTrial = EvalReport['trials'][number];

/** 一份计划的来源。improve 发起的计划在该决定的临时目录（子数据根）里，报告快照在主数据根。 */
export interface PlanSource {
  /** 计划所在的数据根（improve 发起的为子数据根） */
  root: string;
  id: string;
  /** 计划所在数据根中的 `ep-` 号 */
  label: string;
  /** 固定计划的时间（列表倒序） */
  at: string;
  /** improve 发起：`ir-…·C-01@r1`；手动计划为 null */
  origin: { label: string; reportId: string; decisionId: string; groupId?: string } | null;
  /** improve 发起且已结束：主数据根中 `improve.check` 保留的报告快照 */
  snapshot: { root: string; ref: BlobRef } | null;
  /** A stats drilldown is pinned to this source-root acquisition sequence. */
  through?: number;
}

/**
 * 列表层的来源：主数据根最近 50 份计划，加上主数据根 `improve.eval` 记录指向的最近 50 份 improve 发起的计划，
 * 按固定时间倒序。只读主数据根；子数据根只在读报告时打开。
 */
export function listPlanSources(root: string, options: { through?: number; limit?: number | null } = {}): PlanSource[] {
  const through = options.through ?? Number.MAX_SAFE_INTEGER, limit = options.limit === null ? -1 : options.limit ?? 50;
  let db: ReturnType<typeof openHostReadonly>;
  try { db = openHostReadonly(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  let plans: Record<string, unknown>[], links: Record<string, unknown>[], checks: Record<string, unknown>[], decisions: Record<string, unknown>[];
  try {
    plans = db.prepare("SELECT run_id,at FROM records WHERE kind='eval.plan' AND seq<=? ORDER BY seq DESC LIMIT ?").all(through, limit);
    links = db.prepare("SELECT at,body FROM records WHERE kind='improve.eval' AND seq<=? ORDER BY seq DESC LIMIT ?").all(through, limit);
    checks = links.length ? db.prepare("SELECT body FROM records WHERE kind='improve.check' AND seq<=? ORDER BY seq").all(through) : [];
    decisions = links.length ? db.prepare("SELECT body FROM records WHERE kind='improve.decision' AND seq<=? ORDER BY seq").all(through) : [];
  } finally { db.close(); }
  const decode = (row: Record<string, unknown>) => JSON.parse(readObject(root, JSON.parse(String(row.body))).toString());
  const index = readDisplayIndex(root);
  const own: PlanSource[] = plans.map(row => ({ root, id: String(row.run_id), label: index.label('eval-plan', String(row.run_id)), at: String(row.at), origin: null, snapshot: null }));
  const checkFacts = checks.map(decode), decisionFacts = decisions.map(decode), reports = new Map<string, ReturnType<typeof readImproveReport>['report']>();
  const improve = links.map(decode).map((link, i): PlanSource => {
    const decision = decisionFacts.find(f => f.id === link.parent?.decisionId)?.decision;
    const group = decision?.groups?.find((g: any) => g.id === link.groupId);
    let origin: PlanSource['origin'] = null;
    if (decision) {
      if (!reports.has(decision.reportId)) reports.set(decision.reportId, readImproveReport(root, decision.reportId).report);
      const candidates = (group?.candidateIds ?? []).map((id: string) => reports.get(decision.reportId)?.candidates.find(c => c.id === id)).filter(Boolean);
      const first = candidates[0] ? index.qualifiedCandidate(decision.reportId, candidates[0]) : index.label('improve-report', decision.reportId);
      origin = { label: `${first}${candidates.length > 1 ? ` +${candidates.length - 1}` : ''}`, reportId: decision.reportId, decisionId: link.parent.decisionId, groupId: link.groupId };
    }
    const check = checkFacts.findLast(f => f.planId === link.planId && f.dataRoot === link.dataRoot && f.reportDocument);
    let label = 'ep-?';
    try { if (existsSync(join(link.dataRoot, 'host.sqlite'))) label = readDisplayIndex(link.dataRoot).label('eval-plan', link.planId); } catch { /* 子数据根不可读：只用快照 */ }
    return { root: link.dataRoot, id: link.planId, label, at: String(links[i].at), origin, snapshot: check ? { root, ref: check.reportDocument } : null };
  });
  return [...own, ...improve].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Resolve displayed plans across the parent and improve child roots. Ambiguous
 * short numbers are never guessed; the full id remains accepted. */
export function resolvePlanSource(root:string,input:string):PlanSource {
 const sources=listPlanSources(root,{limit:null}),index=new DisplayIndex(sources.map(source=>({kind:'eval-plan' as const,id:source.id,project:null,at:source.at})));
 const resolution=index.resolve('eval-plan',input);
 if(resolution.status!=='found')throw new DisplayInputError(resolution);
 const matches=sources.filter(source=>source.id===resolution.object.id);
 if(matches.length!==1)throw Error(`EVAL_PLAN_AMBIGUOUS: ${input}; 多个数据根含相同计划 id，请从 /eval 列表选择具体来源`);
 return matches[0];
}

/** 主数据根中的一份计划（`/eval ep-号`）。 */
export function ownPlanSource(root: string, id: string): PlanSource {
  const found = listPlanSources(root).find(s => s.root === root && s.id === id);
  if (found) return found;
  return { root, id, label: readDisplayIndex(root).label('eval-plan', id), at: '', origin: null, snapshot: null };
}

/**
 * 读计划报告。improve 发起且已结束的计划读主数据根的报告快照（子数据根可能已清理）；
 * 其余从计划所在数据根实时读（`asOf` 为旧报告修订）。
 */
export function readPlanReport(source: PlanSource, options: { asOf?: number } = {}): { report: EvalReport; from: 'live' | 'snapshot' } {
  const asOf = source.through === undefined ? options.asOf : Math.min(options.asOf ?? source.through, source.through);
  if (source.snapshot) {
    const report: EvalReport = JSON.parse(readObject(source.snapshot.root, source.snapshot.ref).toString());
    if (asOf === undefined || report.asOf <= asOf) return { report, from: 'snapshot' };
  }
  return { report: evalReport(source.root, source.id, { asOf }), from: 'live' };
}

export type PlanState = 'not-started' | 'running' | 'ended' | 'stopped';
export const PLAN_STATE_LABEL: Record<PlanState, string> = { 'not-started': '未开始', running: '运行中', ended: '已结束', stopped: '已停止' };
/**
 * 批次状态：没有 `eval.started` 为未开始；有而没有 `eval.closed` 为运行中（本进程或其他进程运行，或已中断）；
 * 关闭时带停止原因为已停止，否则已结束。首版报告快照没有 `batch`、或只有结果没有 `eval.started`（合成记录）：按试次推断（有未运行的为已停止）。
 */
export function planState(report: EvalReport): PlanState {
  const batch = (report as Partial<EvalReport>).batch;
  if (batch?.startedAt) return !batch.startedAt ? 'not-started' : !batch.closedAt ? 'running' : batch.stopReason ? 'stopped' : 'ended';
  if (!report.trials.some(t => t.outcome.started || t.outcome.status !== 'not-run')) return 'not-started';
  if (report.trials.some(t => t.outcome.status === 'unknown')) return 'running';
  return report.trials.some(t => t.outcome.status === 'not-run') ? 'stopped' : 'ended';
}

// ─── trial 的宿主记录（V7） ─────────────────────────────────────────────────

/** 宿主中介的一次模型请求：按受限侧请求序位（`eval.provider-link.guestDispatchOrdinal`）对应。 */
export interface HostRequest {
  /** 受限侧请求序位；没有派发记录的预留为 null */
  ordinal: number | null;
  id: string;
  dispatched: boolean;
  /** 宿主结算的 token；未结算或未知为 null */
  tokens: number | null;
  /** 按计划固定单价折算；无价或用量未知为 null */
  amount: number | null;
  currency: string | null;
}
/** 宿主侧三段计时（ms）；未记录为 null。 */
export interface HostTiming { preparationMs: number | null; taskMs: number | null; gradingMs: number | null }

export function hostRequests(source: PlanSource, report: EvalReport, trialId: string): HostRequest[] {
  const trial = report.trials.find(t => t.id === trialId);
  if (!trial) return [];
  let links: { hostDispatchId: string; guestDispatchOrdinal: number }[] = [];
  try { links = evalFacts(source.root, source.id).filter(f => f.kind === 'eval.provider-link' && f.data.trialId === trialId).map(f => f.data); } catch { /* 子数据根已清理：只能按派发顺序对应 */ }
  const price = report.plan.price;
  let fallback = 0;
  return trial.requests.map((r: any) => {
    const link = links.find(l => l.hostDispatchId === r.id), dispatched = !!r.dispatch;
    const tokens = typeof r.settled?.tokens === 'number' ? r.settled.tokens : null;
    return {
      ordinal: link ? link.guestDispatchOrdinal : dispatched && !links.length ? ++fallback : null,
      id: String(r.id), dispatched, tokens,
      amount: tokens !== null && price ? tokens * price.perMillionTokens / 1e6 : null,
      currency: price?.currency ?? null,
    };
  });
}
export function hostTiming(trial: EvalReportTrial): HostTiming {
  const t = trial.outcome.timing as { preparationMs?: number; taskMs?: number } | undefined;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  return { preparationMs: trial.outcome.started ? ok(t?.preparationMs) : null, taskMs: trial.outcome.started && trial.outcome.status !== 'unknown' ? ok(t?.taskMs) : null, gradingMs: ok(trial.gradingMs) };
}

// ─── 受限侧原文副本（V7） ───────────────────────────────────────────────────

/** 受限侧导出的数据根副本：在宿主临时目录里只读打开；`close()` 删除副本。 */
export interface RestrictedCopy { root: string; runId: string; close(): Promise<void> }

/**
 * 把 trial 导出的 `data/` 文件复制到宿主临时目录，先用 SQLite 防御设置（defensive、trusted_schema=OFF、只读）
 * 核对副本再交给 trace 模型。打不开时抛出带原因的错误，由视图改为只列宿主记录。
 */
export async function openRestrictedCopy(source: PlanSource, trial: EvalReportTrial): Promise<RestrictedCopy> {
  if (!trial.outcome.started) throw Error('TRIAL_NOT_STARTED: trial 未运行，没有受限侧原文');
  const artifacts = ((trial.outcome as { artifacts?: { path: string; ref: BlobRef }[] }).artifacts ?? []).filter(f => f.path.startsWith('data/'));
  if (!artifacts.some(f => f.path === 'data/host.sqlite')) throw Error('RESTRICTED_RAW_MISSING: 未导出受限侧记录');
  if (source.origin && !existsSync(join(source.root, 'host.sqlite'))) throw Error('RESTRICTED_RAW_CLEANED: 原文不可取得 · improve 决定的临时目录已清理');
  const directory = await mkdtemp(join(tmpdir(), 'pi-durio-trial-'));
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    for (const file of artifacts) {
      const relative = file.path.slice('data/'.length);
      if (!/^[a-zA-Z0-9_@+.,=-]+(?:\/[a-zA-Z0-9_@+.,=-]+)*$/.test(relative) || relative.split('/').some(p => p === '.' || p === '..')) throw Error(`RESTRICTED_RAW_PATH: ${relative}`);
      const to = join(directory, relative);
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, readObject(source.root, file.ref), { flag: 'wx', mode: 0o400 });
    }
    const db = new DatabaseSync(join(directory, 'host.sqlite'), { readOnly: true, defensive: true } as ConstructorParameters<typeof DatabaseSync>[1]);
    let runId: string | undefined;
    try {
      db.exec('PRAGMA trusted_schema=OFF');
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      if (Object.values(check ?? {})[0] !== 'ok') throw Error('RESTRICTED_RAW_CORRUPT: 受限侧记录未通过完整性检查');
      runId = (db.prepare("SELECT run_id FROM records WHERE kind='run.started' ORDER BY seq LIMIT 1").get() as { run_id?: string } | undefined)?.run_id;
    } finally { db.close(); }
    if (!runId) throw Error('RESTRICTED_RUN_MISSING: 受限侧记录中没有 run');
    return { root: directory, runId, close };
  } catch (error) { await close(); throw error; }
}
