export type DerivedTaskType = 'coding' | 'read';
const BY_EXECUTION: Record<string, DerivedTaskType> = { 'trusted-local-coding': 'coding', 'trusted-local-read-only': 'read' };

/**
 * Task type of an accepted task (`task.accepted` or follow-up `control.accepted` data), derived — v1 and
 * redesign records carry no taskType field. An eval trial's `origin.taskType` wins; otherwise it follows
 * `authorization.execution`. Improve analysis (`scoped-improve-analysis`) has none: it is kind=improve.
 */
export function taskTypeOf(accepted: { origin?: { taskType?: unknown }; authorization?: unknown } | null | undefined): string | null {
  if (typeof accepted?.origin?.taskType === 'string') return accepted.origin.taskType;
  const execution = (accepted?.authorization as { execution?: unknown } | undefined)?.execution;
  return typeof execution === 'string' ? BY_EXECUTION[execution] ?? null : null;
}
