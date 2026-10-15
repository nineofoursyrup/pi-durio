import { readdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { records, decode } from './history.js';
import { blobReferences } from './retention.js';
import { readSessionChains, type SessionSummary } from './session-chain.js';
import { exists, treeFiles } from './storage-files.js';

/** One storage unit as the TUI groups it; `id` is the cleanup unit id (`session:<durable id>` / `object:<sha256>`). */
export interface GroupedUnit { id: string; kind: 'session' | 'object'; bytes: number; /** Task number in its session (durable stores only). */ task?: number }
/**
 * A row of the storage view (#60 §5): one derived session (会话), or every unit no single session owns.
 * Cleanup units stay the durable session store and attachments (E9); grouping only chooses them.
 */
export interface StorageGroup {
  key: string; kind: 'session' | 'unowned';
  session: SessionSummary | null; units: GroupedUnit[]; sessionBytes: number; attachmentBytes: number;
}
export interface StorageTotals { host: number; sessions: number; attachments: number; incomplete: number; other: number; total: number }

/**
 * Readonly grouping of the cleanup units of one data root; takes no lock. A unit belongs to a session when every
 * run that references it belongs to that session (a durable store via its runs' `task.accepted.sessionId`, an
 * attachment via the facts that reference it). Units of several sessions or of none — including attachments
 * referenced only by non-session facts — form the single “未归属附件” row, so selecting one session never removes
 * what another session still references. Host fact bodies are never units.
 */
export async function storageGroups(root: string) {
  if (await exists(root)) root = await realpath(root);
  const bodies = new Set<string>(), objectRuns = new Map<string, Set<string>>(), runSessions = new Map<string, string>();
  let facts = 0;
  if (await exists(join(root, 'host.sqlite'))) for (const source of records(root)) {
    if (++facts > 50000) throw Error('STORAGE_FACT_LIMIT');
    bodies.add(source.ref.sha256);
    const data = decode(root, source);
    // Same attribution as the retention projection: management plans and availability marks claim nothing.
    // A cleanup plan blob is part of the host record of that operation, never a session's attachment.
    if (source.kind.startsWith('management.')) { if (source.kind === 'management.preview' && typeof data.plan?.sha256 === 'string') bodies.add(data.plan.sha256); continue; }
    if (source.kind === 'evidence.availability') continue;
    if (source.kind === 'task.accepted' && typeof data.sessionId === 'string') runSessions.set(source.runId, data.sessionId);
    for (const ref of blobReferences(data)) { let runs = objectRuns.get(ref.sha256); if (!runs) objectRuns.set(ref.sha256, runs = new Set()); runs.add(source.runId); }
  }
  const totals: StorageTotals = { host: 0, sessions: 0, attachments: 0, incomplete: 0, other: 0, total: 0 };
  const units: { unit: GroupedUnit; runs: Iterable<string> }[] = [];
  for (const file of await treeFiles(root, { hash: false, exclude: path => path === 'owner.json' || path.endsWith('.lock') })) {
    totals.total += file.bytes;
    if (file.path.startsWith('host.sqlite')) totals.host += file.bytes;
    else if (file.path.startsWith('sessions/')) totals.sessions += file.bytes;
    else if (file.path.startsWith('management-trash/')) totals.incomplete += file.bytes;
    else if (file.path.startsWith('objects/')) {
      // Fact bodies are host records, counted with them; the rest are attachments.
      const sha = file.path.slice(8);
      if (bodies.has(sha)) totals.host += file.bytes;
      else { totals.attachments += file.bytes; units.push({ unit: { id: `object:${sha}`, kind: 'object', bytes: file.bytes }, runs: objectRuns.get(sha) ?? [] }); }
    } else totals.other += file.bytes;
  }
  const durableRuns = new Map<string, string[]>();
  for (const [run, session] of runSessions) { const list = durableRuns.get(session) ?? []; list.push(run); durableRuns.set(session, list); }
  const sessions = await readdir(join(root, 'sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  for (const name of sessions) {
    const path = join(root, 'sessions', name);
    if (!(await lstat(path)).isDirectory()) continue;
    const files = await treeFiles(path, { hash: false });
    units.push({ unit: { id: `session:${name}`, kind: 'session', bytes: files.reduce((n, f) => n + f.bytes, 0) }, runs: durableRuns.get(name) ?? [] });
  }
  const chains = readSessionChains(root), groups = new Map<string, StorageGroup>();
  const unowned: StorageGroup = { key: 'unowned', kind: 'unowned', session: null, units: [], sessionBytes: 0, attachmentBytes: 0 };
  for (const { unit, runs } of units) {
    const owners = new Set([...runs].map(run => chains.sessionOfRun(run)?.id ?? null));
    const owner = owners.size === 1 ? [...owners][0] : null;
    let group = unowned;
    if (owner !== null) {
      if (unit.kind === 'session') unit.task = Math.min(...[...runs].map(run => chains.sessionOfRun(run)!.number));
      group = groups.get(owner) ?? { key: `session:${owner}`, kind: 'session', session: chains.session(owner), units: [], sessionBytes: 0, attachmentBytes: 0 };
      groups.set(owner, group);
    }
    group.units.push(unit);
    if (unit.kind === 'session') group.sessionBytes += unit.bytes; else group.attachmentBytes += unit.bytes;
  }
  // Newest activity first, as the history list orders sessions.
  const list = [...groups.values()].sort((a, b) => b.session!.lastSeq - a.session!.lastSeq);
  if (unowned.units.length) list.push(unowned);
  return { root, totals, groups: list };
}

/**
 * Units of the CLI's `session:<s- number>`: the durable stores of every task of that derived session. A full id
 * stays one durable store as before; a session with no store left yields its first store, which preview reports
 * as not found.
 */
export async function sessionStorageUnits(root: string, sessionId: string) {
  const group = (await storageGroups(root)).groups.find(item => item.key === `session:${sessionId}`);
  const own = group?.units.filter(unit => unit.kind === 'session').map(unit => unit.id) ?? [];
  return own.length ? own : [`session:${sessionId}`];
}
