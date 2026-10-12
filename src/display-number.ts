import { openHostReadonly, readObject } from './evidence.js';

/**
 * Display numbers are human-facing handles only. They are derived when shown and
 * resolved back to the full identity on input; records and machine output keep full identities.
 */
export type DisplayKind = 'session' | 'run';
export const DISPLAY_PREFIXES: Record<DisplayKind, string> = { session: 's', run: 'r' };
const MIN_HEX = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_INPUT = new RegExp(`^(${Object.values(DISPLAY_PREFIXES).join('|')})-[0-9a-f]{${MIN_HEX},}$`, 'i');

export interface DisplayObject { kind: DisplayKind; id: string; project: string | null; at: string | null }
export interface DisplayCandidate extends DisplayObject { display: string }
export type DisplayResolution =
  | { status: 'found'; object: DisplayObject }
  | { status: 'ambiguous'; kind: DisplayKind; input: string; candidates: DisplayCandidate[] }
  | { status: 'not-found'; kind: DisplayKind; input: string };

/** The hexadecimal part the display number is cut from: a UUID without hyphens, lowercase. */
export function displayHex(id: string) {
  if (!UUID.test(id)) throw Error(`DISPLAY_IDENTITY_UNSUPPORTED: ${id}`);
  return id.replaceAll('-', '').toLowerCase();
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

/** A snapshot of the identities in one data root, per kind. Lengths depend on this snapshot. */
export class DisplayIndex {
  private readonly kinds = new Map<DisplayKind, Map<string, DisplayObject>>();
  constructor(objects: Iterable<DisplayObject>) {
    for (const object of objects) {
      const kind = this.kinds.get(object.kind) ?? new Map<string, DisplayObject>();
      this.kinds.set(object.kind, kind);
      if (!kind.has(object.id)) kind.set(object.id, object);
    }
  }
  private objects(kind: DisplayKind) { return this.kinds.get(kind) ?? new Map<string, DisplayObject>(); }
  has(kind: DisplayKind, id: string) { return this.objects(kind).has(id); }
  label(kind: DisplayKind, id: string) { return displayNumber(kind, id, this.objects(kind).keys()); }
  /** Exact full identity, or exact prefix match of a display number of this kind. Never fuzzy. */
  resolve(kind: DisplayKind, input: string): DisplayResolution {
    const objects = this.objects(kind), exact = objects.get(input);
    if (exact) return { status: 'found', object: exact };
    const prefix = `${DISPLAY_PREFIXES[kind]}-`;
    if (!DISPLAY_INPUT.test(input) || !input.toLowerCase().startsWith(prefix)) return { status: 'not-found', kind, input };
    const hex = input.slice(prefix.length).toLowerCase();
    const matches = [...objects.values()].filter(object => displayHex(object.id).startsWith(hex));
    if (matches.length === 1) return { status: 'found', object: matches[0] };
    if (!matches.length) return { status: 'not-found', kind, input };
    const candidates = matches.map(object => ({ ...object, display: this.label(kind, object.id) })).sort((a, b) => a.display.localeCompare(b.display));
    return { status: 'ambiguous', kind, input, candidates };
  }
}

/** Readonly scan of host facts: product runs and their sessions from `task.accepted`. */
export function readDisplayIndex(root: string) {
  let db: ReturnType<typeof openHostReadonly>;
  try { db = openHostReadonly(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new DisplayIndex([]); throw error; }
  // Copy rows out first so the shared read lock is not held while originals are decoded.
  let rows: Record<string, unknown>[];
  try { rows = db.prepare("SELECT run_id,at,body FROM records WHERE kind='task.accepted' ORDER BY seq").all() as Record<string, unknown>[]; }
  finally { db.close(); }
  const objects: DisplayObject[] = [];
  for (const row of rows) {
    const runId = String(row.run_id), at = String(row.at);
    if (!UUID.test(runId)) continue;
    const data = JSON.parse(readObject(root, JSON.parse(String(row.body))).toString());
    const project = data.projectId ?? data.workspace ?? null;
    objects.push({ kind: 'run', id: runId, project, at });
    if (typeof data.sessionId === 'string' && UUID.test(data.sessionId)) objects.push({ kind: 'session', id: data.sessionId, project, at });
  }
  return new DisplayIndex(objects);
}

export class DisplayInputError extends Error {
  readonly code: 'DISPLAY_AMBIGUOUS' | 'DISPLAY_NOT_FOUND';
  readonly candidates: DisplayCandidate[];
  constructor(resolution: Exclude<DisplayResolution, { status: 'found' }>) {
    const { kind, input } = resolution, ambiguous = resolution.status === 'ambiguous';
    const candidates = ambiguous ? resolution.candidates : [];
    super(ambiguous
      ? `DISPLAY_AMBIGUOUS: ${input} matches ${candidates.length} ${kind}s; nothing was executed. Use a longer display number: ${candidates.map(c => `${c.display} (${c.kind} · project ${c.project ?? 'unknown'} · ${c.at ?? 'time unknown'})`).join('; ')}`
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
export function resolveDisplayInput(root: string, kind: DisplayKind, input: string) {
  if (!DISPLAY_INPUT.test(input)) return input;
  const resolution = readDisplayIndex(root).resolve(kind, input);
  if (resolution.status !== 'found') throw new DisplayInputError(resolution);
  return resolution.object.id;
}
