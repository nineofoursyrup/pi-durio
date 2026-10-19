import { mkdtemp, opendir, rm, access, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './evidence.js';
import { records, decode, watermark } from './history.js';
import type { StorageReader } from './storage-projection.js';
import { inspectQuiescentSnapshot, inspectAdmissionState } from './sqlite-snapshot.js';
import type { OwnerLease } from './ownership.js';
import { sessionRemovalVerified } from './storage-disposition.js';

/** Owner-authorized inspection; only the verified copy is opened through public storage. */
export async function inspectSnapshot<T>(path: string, owner: OwnerLease, inspect: (storage: StorageReader) => Promise<T>) {
  owner.assertHeld();
  path = await realpath(path);
  const rel = relative(owner.path, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('INSPECTION_OUTSIDE_OWNER');
  return { ...await inspectQuiescentSnapshot(path, () => owner.assertHeld(), inspect), method: 'owner-fenced-quiescent-main-plus-wal-copy/public-storage-scan' };
}

export async function inspectAdmission(path: string, owner: OwnerLease) {
  return inspectSnapshot(path, owner, inspectAdmissionState);
}

export async function preflight(owner: OwnerLease, options: { runId?: string } = {}) {
  const root = owner.path;
  owner.assertHeld();
  let through: number;
  try { through = watermark(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const sessions = await opendir(join(root, 'sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (sessions) for await (const _ of sessions) throw new Error('RECOVERY_REQUIRED: missing host facts');
    return { sessionCount: 0, hostThrough: 0, selectedSession: null };
  }
  // This is a disposable, disk-backed join index, never a second source of facts.
  // Retaining even minimal reports in an array grows with the number of old sessions.
  const dir = await mkdtemp(join(tmpdir(), 'durio-admission-'));
  let index: DatabaseSync | undefined;
  try {
    index = new DatabaseSync(join(dir, 'index.sqlite'));
    index.exec(`PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
      CREATE TABLE accepted(seq INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT);
      CREATE INDEX accepted_session ON accepted(session_id,seq);
      CREATE INDEX accepted_run ON accepted(run_id,seq);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, source_id TEXT, resolved_run_id TEXT);
      CREATE INDEX sessions_resolved ON sessions(resolved_run_id);`);
    const facts = (kinds: string[], runId?: string) => records(root, { kinds, runId, through });
    // Do not let a valid later disposition conceal damaged admission/cleanup authority.
    // Unrelated original output is checked by the history reader, not by new-task admission.
    for (const ref of facts(['run.closed', 'recovery.ended', 'recovery.closed', 'recovery.report', 'compaction.closed',
      'management.session-removed', 'management.preview', 'management.commit', 'management.part-result', 'management.file-result'])) decode(root, ref);
    const last = (kind: string, runId: string, matches: (data: any) => boolean = () => true) => {
      let value: any;
      for (const ref of facts([kind], runId)) { const data = decode(root, ref); if (matches(data)) value = data; }
      return value;
    };
    const ended = (runId: string, sourceId: string) => {
      let found = false;
      for (const ref of facts(['recovery.ended'], runId)) if (decode(root, ref).sourceId === sourceId) found = true;
      return found;
    };
    for (const ref of facts(['task.accepted'])) {
      const data = decode(root, ref);
      index.prepare('INSERT INTO accepted VALUES(?,?,?)').run(ref.seq, ref.runId, data.sessionId ?? null);
    }
    const selectedId = options.runId ? index.prepare('SELECT session_id FROM accepted WHERE run_id=? ORDER BY seq LIMIT 1').get(options.runId)?.session_id : undefined;
    let sessionCount = 0, selectedSession: { source: string; pending: number } | null = null;
    const sessions = await opendir(join(root, 'sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (sessions) for await (const session of sessions) {
      if (!session.isDirectory()) throw new Error('RECOVERY_REQUIRED: unexpected session storage alias');
      for (const marker of [join(root, 'sessions', session.name, 'owner.json'), join(root, 'sessions', `${session.name}.lock`)]) {
        try { await access(marker); throw new Error('RECOVERY_REQUIRED: unresolved session owner'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const report = await inspectAdmission(join(root, 'sessions', session.name, 'durable.sqlite'), owner);
      if (session.name === selectedId) selectedSession = { source: report.source, pending: report.pending };
      const run = index.prepare('SELECT run_id FROM accepted WHERE session_id=? ORDER BY seq LIMIT 1').get(session.name);
      if (!run) throw new Error('RECOVERY_REQUIRED: session without host authorization identity');
      const runId = String(run.run_id), sourceId = digest(JSON.stringify(report.sourceFiles));
      let resolved = ended(runId, sourceId);
      if (!resolved) {
        if (report.pending) throw new Error(`RECOVERY_REQUIRED: ${session.name} has pending durable work`);
        const closed = last('recovery.closed', runId)?.result;
        const checked = last('recovery.report', runId);
        resolved = closed?.cleanup === 'confirmed' && closed.status !== 'unknown' || checked?.status === 'completed' && JSON.stringify(checked.session?.sourceFiles) === JSON.stringify(report.sourceFiles);
      }
      index.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.name, sourceId, resolved ? runId : null);
      sessionCount++;
    }
    for (const ref of facts(['run.started'])) {
      const data = decode(root, ref);
      if (!index.prepare('SELECT 1 FROM sessions WHERE id=?').get(data.sessionId ?? null) && !sessionRemovalVerified(root, data.sessionId, through)) throw new Error('RECOVERY_REQUIRED: recorded session storage is missing or cleanup is incomplete');
    }
    for (const ref of facts(['compaction.started'])) {
      const start = decode(root, ref);
      const closed = last('compaction.closed', ref.runId, data => data.requestId === start.requestId)?.result;
      const snapshot = index.prepare('SELECT source_id FROM sessions WHERE id=?').get(start.source.sourceSessionId);
      if (!(snapshot && ended(ref.runId, String(snapshot.source_id))) && (!closed || closed.cleanup !== 'confirmed' || closed.status === 'unknown')) throw new Error('RECOVERY_REQUIRED: unresolved compaction close or cross-store gap');
    }
    for (const run of index.prepare('SELECT run_id FROM accepted ORDER BY seq').iterate()) {
      const runId = String(run.run_id);
      if (index.prepare('SELECT 1 FROM sessions WHERE resolved_run_id=? LIMIT 1').get(runId)) continue;
      const receipt = last('run.closed', runId);
      if (!receipt) throw new Error('RECOVERY_REQUIRED: unconfirmed previous close or cross-store gap');
      if (receipt.cleanup !== 'confirmed' || receipt.status === 'unknown') throw new Error('RECOVERY_REQUIRED: unresolved original loss or termination');
    }
    owner.assertHeld();
    return { sessionCount, hostThrough: through, selectedSession };
  } finally {
    try { index?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
