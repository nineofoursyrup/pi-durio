/** Metric members and their evidence routes. Full identities are kept separately from display numbers. */
import { decode, resolveEvidence } from '../history.js';
import { readDisplayIndex, readRunOrdinals, type DisplayKind } from '../display-number.js';
import { type CostRequest } from '../metrics/costs.js';
import { type PlanSource } from '../eval/overview.js';
import { type StatsSnapshot, type SpendKind, metricRows, spendRows, spendKind } from './stats.js';
import { readSessionChains } from '../session-chain.js';

export type StatsRow = 'acceptance' | 'cost' | 'clocks' | 'intervention' | 'regression' | 'rework' | 'faults' | SpendKind | 'total';
export interface StatsTaskTarget { root: string; taskId: string; runId: string | null; acceptedSource: string; sessionId?: string | null }
export type StatsTarget =
  | { kind: 'run'; root: string; runId: string }
  | { kind: 'plan'; source: PlanSource }
  | { kind: 'raw'; root: string; id: string }
  | { kind: 'report'; title: string; value: unknown };
export interface StatsEvidence { key: string; label: string; detail: string; target: StatsTarget }
export interface StatsMember {
  key: string;
  label: string;
  classification: string;
  reasons: string[];
  task?: StatsTaskTarget;
  evidence(): StatsEvidence[];
}
const METRICS: StatsRow[] = ['acceptance', 'cost', 'clocks', 'intervention', 'regression', 'rework', 'faults'];
export function statsRows(stats: StatsSnapshot): { key: StatsRow; label: string }[] {
  return [...metricRows(stats.figures).map((row, i) => ({ key: METRICS[i], label: row.label })), ...spendRows(stats.figures).map(row => ({ key: row.kind, label: row.label }))];
}
const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id))];

export function statsMembers(stats: StatsSnapshot, row: StatsRow): StatsMember[] {
  const { task, operations: ops, feedback } = stats.reports, root = stats.root;
  const indexes = new Map<string, ReturnType<typeof readDisplayIndex>>();
  const label = (kind: DisplayKind, id: string, dataRoot = root) => {
    if (!indexes.has(dataRoot)) indexes.set(dataRoot, readDisplayIndex(dataRoot));
    return indexes.get(dataRoot)!.label(kind, id);
  };
  const raw = (dataRoot: string, ids: (string | null | undefined)[]): StatsEvidence[] => unique(ids).map(id => {
    let title = id, detail = '来源不可读取';
    try {
      const ref = resolveEvidence(dataRoot, id); title = `#${ref.seq} ${ref.kind}`;
      let source = 'host';
      try { const data = decode(dataRoot, ref); source = data.source?.kind ?? data.method ?? source; } catch { source = 'unknown'; }
      detail = `来源 ${source} · 收到 ${ref.at}`;
    } catch { /* Keep the reference inspectable when its original is missing. */ }
    return { key: `${dataRoot}#${id}`, label: title, detail: `${detail} · ${dataRoot}`, target: { kind: 'raw', root: dataRoot, id } };
  });
  const report = (title: string, value: unknown): StatsEvidence => ({ key: `report:${title}`, label: title, detail: '派生报告 · 不替代原始事实', target: { kind: 'report', title, value } });
  const run = (runId: string | null, dataRoot = root): StatsEvidence[] => runId ? [{ key: `${dataRoot}#run:${runId}`, label: `run ${label('run', runId, dataRoot)}`, detail: '打开 trace · 查看运行原文', target: { kind: 'run', root: dataRoot, runId } }] : [];
  let chains: ReturnType<typeof readSessionChains> | undefined;
  const target = (t: { taskId: string; runId: string | null; acceptedSource: string }): StatsTaskTarget => {
    chains ??= readSessionChains(root, { through: stats.scope.through });
    let sessionId = t.runId ? chains.sessionOfRun(t.runId)?.id : undefined;
    if (!sessionId) { try { const ref = resolveEvidence(root, t.acceptedSource), data = decode(root, ref); sessionId = chains.sessionOfRun(data.target?.runId ?? ref.runId)?.id; } catch {} }
    return { root, taskId: t.taskId, runId: t.runId, acceptedSource: t.acceptedSource, sessionId: sessionId ?? null };
  };
  const taskReasons = (t: typeof task.tasks[number]) => [t.reason, !t.taskType ? '任务类型 unknown' : `类型 ${t.taskType}`, !t.version ? '实际执行版本 unknown' : `执行版本 ${t.version}`].filter((r): r is string => !!r);

  if (row === 'regression') return stats.plans.map(plan => ({
    key: `${plan.source.root}#${plan.source.id}`, label: plan.label, classification: `R/V = ${plan.R}/${plan.V}（P=${plan.P}）· V/P = ${plan.V}/${plan.P}`,
    reasons: [plan.R ? '有新增回归' : plan.V ? '有效配对未观察到新增回归' : '尚无有效配对', `截止 #${plan.source.through} · ${plan.source.root}`],
    evidence: () => [
      { key: `${plan.source.root}#plan:${plan.source.id}`, label: plan.label, detail: `eval 计划 · 与统计行相同截止 #${plan.source.through}`, target: { kind: 'plan', source: plan.source } },
      ...raw(plan.source.root, [plan.report.planSource, ...plan.report.gradingRevisions.map(r => String(r.source))]),
      report('回归配对与判定（报告）', plan.report.comparison),
    ],
  }));

  if (row === 'cost' || !METRICS.includes(row)) {
    const ids = new Set(row === 'cost' ? ops.costs.sample.requestIds : ops.costs.period.requestIds);
    const requests = ops.costs.requests.filter(r => ids.has(r.id) && (row === 'cost' || row === 'total' || spendKind(r.kind) === row));
    const ordinals = new Map<string, ReturnType<typeof readRunOrdinals>>();
    const requestLabel = (r: CostRequest) => {
      const source = stats.planSources.find(s => s.root === r.dataRoot && s.id === r.runId);
      if (source) return `${source.label}${source.origin ? ` · ${source.origin.label}` : ''} · 请求 #${r.source.split(':')[1]}`;
      const key = `${r.dataRoot}#${r.runId}`;
      let request = `请求 #${r.source.split(':')[1]}`;
      try {
        if (!ordinals.has(key)) ordinals.set(key, readRunOrdinals(r.dataRoot, r.runId));
        const data = decode(r.dataRoot, resolveEvidence(r.dataRoot, r.source));
        const ordinal = ordinals.get(key)!.model.get(data.attemptId);
        if (ordinal !== undefined) request = `llm #${ordinal}`;
      } catch { /* A retained report can outlive its original; keep its stable source route. */ }
      return `${label('run', r.runId, r.dataRoot)} · ${request}`;
    };
    const members: StatsMember[] = requests.map(r => ({
      key: r.id, label: requestLabel(r), classification: `${r.kind} · ${r.state}`,
      reasons: r.gaps.length ? r.gaps : [r.association],
      evidence: () => {
        const source = stats.planSources.find(s => s.root === r.dataRoot && s.id === r.runId);
        return [
          ...(source ? [{ key: `${source.root}#plan:${source.id}`, label: source.label, detail: source.origin?.label ?? 'eval 计划', target: { kind: 'plan' as const, source } }] : run(r.runId, r.dataRoot)),
          ...raw(r.dataRoot, [r.source, ...r.dispatchSources, ...r.usageSources, ...r.history.map(h => h.source)]),
          report('费用请求与估算依据（报告）', r),
        ];
      },
    }));
    // A missing request/ownership is part of the explanation, not a zero-cost task.
    const gaps = row === 'cost' ? ops.costs.sample.gaps : row === 'total' ? ops.costs.period.gaps : [];
    for (const [i, gap] of gaps.entries()) members.push({ key: `gap:${i}`, label: `范围缺口 ${label('run', gap.runId)}`, classification: 'unknown / partial', reasons: [gap.reason], evidence: () => [...raw(root, [gap.source]), report('范围缺口（报告）', gap)] });
    return members;
  }

  if (row === 'intervention' || row === 'rework') {
    return feedback[row].tasks.map(t => ({
      key: t.taskId, label: label('task', t.taskId), classification: `${t.state}${t.positive && ['open', 'immature'].includes(t.state) ? ' · 阳性另列' : ''}`, task: target(t),
      reasons: [...new Set(t.events.flatMap(e => e.reasons)), ...t.events.length ? [] : ['没有足够反馈，保留 unknown'], ...t.requirementsChanged ? ['必要要求已变 · 不可比'] : []],
      evidence: () => [
        ...run(t.runId), ...raw(root, [t.acceptedSource, t.start?.source, t.end?.source, t.delivery?.source, ...t.feedback.history.map(h => h.source), ...t.feedback.items.flatMap(e => e.sourceRefs), ...t.feedback.missing.map(m => m.source)]),
        report(`${row === 'intervention' ? '人工介入' : '返工'}覆盖与分类（报告）`, t),
      ],
    }));
  }

  if (row === 'faults') return ops.faults.tasks.members.map(t => ({
    key: t.taskId, label: label('task', t.taskId), classification: t.category,
    reasons: [t.observationComplete ? '宿主管理范围观测完整' : '观测不完整，保留 unknown', t.faultTermination],
    evidence: () => [
      ...run(t.runId),
      ...raw(root, [t.terminationSource, ...t.terminationBasis, ...ops.faults.events.filter(e => e.taskId === t.taskId && e.dataRoot === root).flatMap(e => [e.source, e.resolutionSource]), ...ops.faults.attempts.items.filter(a => a.taskId === t.taskId && a.dataRoot === root).flatMap(a => a.sources)]),
      report('故障事件与分类依据（报告）', { ...t, events: ops.faults.events.filter(e => e.taskId === t.taskId && e.dataRoot === root) }),
    ],
  }));

  const members: StatsMember[] = task.tasks.map(t => ({
    key: t.taskId, label: label('task', t.taskId), classification: row === 'acceptance' ? t.acceptance.outcome : `执行 ${t.clocks.execution.state} · 验收 ${t.clocks.acceptance.state}`,
    ...(row === 'acceptance' ? { task: target(t) } : {}),
    reasons: [...(row === 'acceptance' ? t.acceptance.reasons : [t.clocks.execution.reason, t.clocks.acceptance.reason].filter((r): r is string => !!r)), ...taskReasons(t), ...t.acceptance.requirementsChanged ? ['必要要求已变 · 不可比'] : []],
    evidence: () => [
      ...run(t.runId),
      ...raw(root, [t.acceptedSource, ...t.acceptance.history.map(h => h.source), ...t.acceptance.judgments.flatMap(j => j.sourceRefs), ...t.acceptance.results.flatMap(r => r.evidence), ...t.acceptance.missingSources.map(m => m.source), ...(row === 'clocks' ? t.sources : [t.startedSource, t.terminationSource])]),
      report(row === 'acceptance' ? '验收规则与判定（报告）' : '双时钟定义与分段（报告）', row === 'acceptance' ? t.acceptance : t.clocks),
    ],
  }));
  if (row === 'acceptance') {
    for (const [i, t] of task.excluded.entries()) members.push({ key: `excluded:${i}:${t.taskId}`, label: label('task', t.taskId), classification: '筛除', reasons: [...t.reasons, `种类 ${t.kind ?? 'unknown'} · 来源 ${t.sourceClass ?? 'unknown'} · 类型 ${t.taskType ?? 'unknown'} · 执行版本 ${t.version ?? 'unknown'}`], evidence: () => [...raw(root, [t.source]), report('筛除依据（报告）', t)] });
    for (const [i, t] of task.duplicates.entries()) members.push({ key: `duplicate:${i}:${t.taskId}`, label: label('task', t.taskId), classification: '重复受理', reasons: [t.reason], evidence: () => raw(root, [t.source]) });
  } else if (row === 'clocks') members.push({ key: 'clock-summary', label: '时钟分布与定义', classification: 'p50 / p95 · PASS/FAIL · 状态分组', reasons: ['仅计已测出的完成项；未结束等待与跨进程时钟缺口保留'], evidence: () => [report('双时钟汇总（报告）', task.clocks)] });
  return members;
}

/** One JSON document; reports retain independent identities, rule versions and unknown/excluded members. */
export function statsExport(stats: StatsSnapshot) {
  return {
    schema: 'pi-durio-stats-v1', scope: stats.scope,
    task: stats.reports.task, operations: stats.reports.operations, feedback: stats.reports.feedback,
    periodSpend: { ...stats.reports.operations.costs.period, ...stats.figures.spend },
    regression: stats.plans.map(({ source: { label: _display, origin, ...source }, report, at, P, V, R }) => ({
      source: { ...source, origin: origin && { reportId: origin.reportId, decisionId: origin.decisionId, ...(origin.groupId ? { groupId: origin.groupId } : {}) } },
      at, P, V, R, report,
    })),
  };
}
