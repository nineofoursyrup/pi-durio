import { openHostReadonly, readObject, digest, type HostReadonlySnapshot } from './evidence.js';
import { readObjectRange } from './query.js';
import { readSessionChains } from './session-chain.js';

/**
 * Display numbers are human-facing handles only. They are derived when shown and
 * resolved back to the full identity on input; records and machine output keep full identities.
 */
export type DisplayKind = 'session' | 'run' | 'task' | 'improve-report' | 'eval-plan' | 'queue-request';
export const DISPLAY_PREFIXES: Record<DisplayKind, string> = { session: 's', run: 'r', task: 't', 'improve-report': 'ir', 'eval-plan': 'ep', 'queue-request': 'q' };
const MIN_HEX = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_INPUT = new RegExp(`^(${Object.values(DISPLAY_PREFIXES).join('|')})-[0-9a-f]{${MIN_HEX},}$`, 'i');

export interface DisplayObject { kind: DisplayKind; id: string; project: string | null; at: string | null }
export interface DisplayCandidate extends DisplayObject { display: string }
export type DisplayResolution =
  | { status: 'found'; object: DisplayObject }
  | { status: 'ambiguous'; kind: DisplayKind; input: string; candidates: DisplayCandidate[] }
  | { status: 'not-found'; kind: DisplayKind; input: string };

/**
 * The hexadecimal part the display number is cut from: a UUID without hyphens, lowercase;
 * any other identity (a user-chosen plan, report or queue request ID) by the SHA-256 hex of the identity string.
 */
export function displayHex(id: string) {
  return UUID.test(id) ? id.replaceAll('-', '').toLowerCase() : digest(id);
}

/** Shortest prefix of at least 4 hex digits that no other same-kind identity in `peers` shares. */
export function displayNumber(kind: DisplayKind, id: string, peers: Iterable<string>) {
  const hex = displayHex(id);
  let length = MIN_HEX;
  for (const peer of peers) {
    if (peer === id) continue;
    const other = displayHex(peer);
    let common = 0;
    while (common < hex.length && hex[common] === other[common]) common++;
    length = Math.max(length, common + 1);
  }
  return `${DISPLAY_PREFIXES[kind]}-${hex.slice(0, length)}`;
}

/** The fields of an improve candidate that its display number is derived from. */
export interface DisplayCandidateRef { id: string; revision: string; display: string }

/** A snapshot of the identities in one data root, per kind. Lengths depend on this snapshot. */
export class DisplayIndex {
  private readonly kinds = new Map<DisplayKind, Map<string, DisplayObject>>();
  /** Distinct revisions per improve candidate ID, in record order. */
  constructor(objects: Iterable<DisplayObject>, private readonly revisions = new Map<string, string[]>()) {
    for (const object of objects) {
      const kind = this.kinds.get(object.kind) ?? new Map<string, DisplayObject>();
      this.kinds.set(object.kind, kind);
      if (!kind.has(object.id)) kind.set(object.id, object);
    }
  }
  private objects(kind: DisplayKind) { return this.kinds.get(kind) ?? new Map<string, DisplayObject>(); }
  has(kind: DisplayKind, id: string) { return this.objects(kind).has(id); }
  label(kind: DisplayKind, id: string) { return displayNumber(kind, id, this.objects(kind).keys()); }
  /** `tc-<run hex>-<NN>`: the run's hex part as long as its current `r-` number; 1-based ordinal, at least two digits. */
  toolCall(runId: string, ordinal: number) {
    return `tc-${this.label('run', runId).slice(DISPLAY_PREFIXES.run.length + 1)}-${String(ordinal).padStart(2, '0')}`;
  }
  /**
   * `C-<NN>@r<n>`: NN is the in-report number recorded as `R<NN>`; n is the 1-based position of this
   * revision among the distinct revisions of the same candidate ID in this data root.
   */
  candidate(candidate: DisplayCandidateRef) {
    const revisions = this.revisions.get(candidate.id) ?? [], position = revisions.indexOf(candidate.revision);
    return `C-${candidate.display.replace(/^R/, '').padStart(2, '0')}@r${position < 0 ? revisions.length + 1 : position + 1}`;
  }
  /** A candidate referenced outside its report: `<ir- number>·C-<NN>@r<n>`. */
  qualifiedCandidate(reportId: string, candidate: DisplayCandidateRef) { return `${this.label('improve-report', reportId)}·${this.candidate(candidate)}`; }
  /**
   * Exact full identity, or exact prefix match of a display number of this kind. Never fuzzy.
   * A user-chosen identity shaped like a display number (`ep-0a1b`) never shadows another object's display number.
   */
  resolve(kind: DisplayKind, input: string): DisplayResolution {
    const objects = this.objects(kind), exact = objects.get(input), prefix = `${DISPLAY_PREFIXES[kind]}-`;
    const hex = input.slice(prefix.length).toLowerCase();
    const prefixed = DISPLAY_INPUT.test(input) && input.toLowerCase().startsWith(prefix)
      ? [...objects.values()].filter(object => object !== exact && displayHex(object.id).startsWith(hex)) : [];
    const matches = exact ? [exact, ...prefixed] : prefixed;
    if (matches.length === 1) return { status: 'found', object: matches[0] };
    if (!matches.length) return { status: 'not-found', kind, input };
    // Each candidate's number is longer than the input, so typing it cannot hit the same ambiguity again.
    const candidates = matches.map(object => {
      const length = Math.max(this.label(kind, object.id).length - prefix.length, hex.length + 1);
      return { ...object, display: `${prefix}${displayHex(object.id).slice(0, length)}` };
    }).sort((a, b) => a.display.localeCompare(b.display));
    return { status: 'ambiguous', kind, input, candidates };
  }
}

/** A full identity that is not a UUID; its detail header names it once as “原 id …”. */
export function isUserChosenId(id: string) { return !UUID.test(id); }

/**
 * Readonly scan of host facts in one data root: product runs, sessions (derived chains: only a session's
 * first task contributes its sessionId), accepted tasks (`task.accepted`, follow-up `control.accepted`),
 * queue requests (`control.accepted`), improve reports (`improve.started`), eval plans (`eval.plan`; plans
 * have no project) and improve candidate revisions (`improve.report`).
 */
export function readDisplayIndex(root: string, snapshot?: HostReadonlySnapshot) {
  let db: ReturnType<typeof openHostReadonly>;
  try { db = snapshot?.database ?? openHostReadonly(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new DisplayIndex([]); throw error; }
  // Ordinary opens release the shared lock before decoding; a report keeps its
  // explicit snapshot until ID resolution and report formatting both finish.
  let rows: Record<string, unknown>[];
  const chains = readSessionChains(root, {}, snapshot);
  try { rows = db.prepare("SELECT run_id,kind,at,body FROM records WHERE kind IN ('task.accepted','control.accepted','improve.started','improve.report','eval.plan') AND seq<=? ORDER BY seq").all(chains.through) as Record<string, unknown>[]; }
  finally { if (!snapshot) db.close(); }
  const objects: DisplayObject[] = [], revisions = new Map<string, string[]>();
  for (const row of rows) {
    const runId = String(row.run_id), at = String(row.at), kind = String(row.kind);
    if (kind === 'eval.plan') { objects.push({ kind: 'eval-plan', id: runId, project: null, at }); continue; }
    const data = JSON.parse(readObject(root, JSON.parse(String(row.body))).toString());
    if (kind === 'task.accepted') {
      const project = data.projectId ?? data.workspace ?? null;
      if (UUID.test(runId)) objects.push({ kind: 'run', id: runId, project, at });
      if (typeof data.sessionId === 'string' && UUID.test(data.sessionId) && chains.isHead(runId)) objects.push({ kind: 'session', id: data.sessionId, project, at });
      if (typeof data.taskId === 'string') objects.push({ kind: 'task', id: data.taskId, project, at });
    } else if (kind === 'control.accepted') {
      if (typeof data.requestId === 'string') objects.push({ kind: 'queue-request', id: data.requestId, project: data.target?.workspace ?? null, at });
      if (data.kind === 'follow-up' && typeof data.taskId === 'string') objects.push({ kind: 'task', id: data.taskId, project: data.target?.workspace ?? null, at });
    } else if (kind === 'improve.started') {
      if (typeof data.request?.id === 'string') objects.push({ kind: 'improve-report', id: data.request.id, project: data.target?.workspace ?? null, at });
    } else {
      for (const candidate of [...(data.candidates ?? []), ...(data.suppressed ?? []).map((s: { candidate: unknown }) => s.candidate)] as DisplayCandidateRef[]) {
        const list = revisions.get(candidate.id) ?? [];
        if (!list.includes(candidate.revision)) list.push(candidate.revision);
        revisions.set(candidate.id, list);
      }
    }
  }
  return new DisplayIndex(objects, revisions);
}

/**
 * Per-run ordinals keyed by attempt ID. Model requests (`model.intent`) are numbered 1-based in record
 * order, compaction requests included. Tool calls are numbered by logical call: attempts of the same
 * durable tool task (a re-execution after recovery) keep the call's original number. Recovery
 * continuations of the same run continue both counts.
 */
export function readRunOrdinals(root: string, runId: string) {
  const ordinals = { tool: new Map<string, number>(), model: new Map<string, number>() };
  let db: ReturnType<typeof openHostReadonly>;
  try { db = openHostReadonly(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ordinals; throw error; }
  let rows: Record<string, unknown>[];
  try { rows = db.prepare("SELECT kind,body FROM records WHERE run_id=? AND kind IN ('tool.intent','model.intent') ORDER BY seq").all(runId) as Record<string, unknown>[]; }
  finally { db.close(); }
  let models = 0, calls = 0;
  const byTask = new Map<number, number>();
  for (const row of rows) {
    const ref = JSON.parse(String(row.body)), model = row.kind === 'model.intent', ordinal = model ? ++models : 0;
    // Intents are written with attemptId (then durableTaskId) first; a model intent also carries its whole context, so read only the head.
    const head = /^\{"attemptId":"([^"\\]+)"(?:,"durableTaskId":(\d+))?/.exec(readObjectRange(root, ref, { limit: 256 }).bytes.toString('utf8'));
    const data = head ? { attemptId: head[1], durableTaskId: head[2] === undefined ? undefined : Number(head[2]) } : JSON.parse(readObject(root, ref).toString());
    if (typeof data.attemptId !== 'string') continue;
    if (model) { ordinals.model.set(data.attemptId, ordinal); continue; }
    const task = typeof data.durableTaskId === 'number' ? data.durableTaskId : undefined;
    const call = task !== undefined && byTask.has(task) ? byTask.get(task)! : ++calls;
    if (task !== undefined) byTask.set(task, call);
    ordinals.tool.set(data.attemptId, call);
  }
  return ordinals;
}

/** `llm #<n>`: the 1-based position of a model request among the run's model requests. */
export function modelRequestNumber(ordinal: number) { return `llm #${ordinal}`; }

export class DisplayInputError extends Error {
  readonly code: 'DISPLAY_AMBIGUOUS' | 'DISPLAY_NOT_FOUND';
  readonly candidates: DisplayCandidate[];
  constructor(resolution: Exclude<DisplayResolution, { status: 'found' }>) {
    const { kind, input } = resolution, ambiguous = resolution.status === 'ambiguous';
    const candidates = ambiguous ? resolution.candidates : [];
    super(ambiguous
      ? `DISPLAY_AMBIGUOUS: ${input} matches ${candidates.length} ${kind}s; nothing was executed. Use a longer display number: ${candidates.map(c => `${c.display} (${c.kind} · project ${c.project ?? '—'} · ${c.at ?? 'time unknown'})`).join('; ')}`
      : `DISPLAY_NOT_FOUND: no ${kind} matches ${input} in this data root (${kind} display numbers start with ${DISPLAY_PREFIXES[kind]}-)`);
    this.code = ambiguous ? 'DISPLAY_AMBIGUOUS' : 'DISPLAY_NOT_FOUND';
    this.candidates = candidates;
  }
}

/**
 * Shared input entry for CLI arguments and TUI commands. A display number is resolved to its
 * unique full identity or rejected before any action; other input (a full identity) is returned
 * unchanged for the command's own lookup.
 */
export function resolveDisplayInput(root: string, kind: DisplayKind, input: string, snapshot?: HostReadonlySnapshot) {
  if (!DISPLAY_INPUT.test(input)) return input;
  const resolution = readDisplayIndex(root, snapshot).resolve(kind, input);
  if (resolution.status !== 'found') throw new DisplayInputError(resolution);
  return resolution.object.id;
}
