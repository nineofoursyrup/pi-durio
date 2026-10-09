import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, access, copyFile, chmod, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openHostReadonly, readObject, type BlobRef } from './evidence.js';
import type { Cursor } from '@earendil-works/pi-durable';
import type { OwnerLease } from './ownership.js';

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Caller holds the data-root owner and has no active source connection (before open or after confirmed close).
 * Copy a quiescent main+WAL pair, verify source/copy bytes, then touch ONLY the copy through SQLite/public storage.
 * This is not a live-backup API; active/uncertain writers must be blocked before calling it.
 */
export async function inspectSession(path: string, owner: OwnerLease) {
  owner.assertHeld();
  path = await realpath(path);
  const rel = relative(owner.path, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('INSPECTION_OUTSIDE_OWNER');
  const dir = await mkdtemp(join(tmpdir(), 'durio-inspect-'));
  const snapshot = join(dir, 'snapshot.sqlite');
  try {
    const parts = [path];
    try { await access(`${path}-wal`); parts.push(`${path}-wal`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const sourceFiles = [];
    for (const source of parts) {
      const sha256 = await hashFile(source);
      const destination = source === path ? snapshot : `${snapshot}-wal`;
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      if (await hashFile(destination) !== sha256 || await hashFile(source) !== sha256) throw new Error('RECOVERY_REQUIRED: source changed during quiescent snapshot');
      sourceFiles.push({ path: source, sha256 });
    }
    owner.assertHeld();
    const snapshotSha256 = await hashFile(snapshot);
    const storage = await openNodeSqliteStorage(snapshot);
    try {
      const pending: { kind: string; id: number; status: string }[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const task of page.items) if (task.state.status !== 'terminal') pending.push({ kind: task.kind, id: task.id, status: task.state.status });
        cursor = page.next;
      } while (cursor);
      do {
        const page = await storage.scanSubmissions({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const item of page.items) if (item.status === 'queued' || item.status === 'placed') pending.push({ kind: 'submission', id: item.id, status: item.status });
        cursor = page.next;
      } while (cursor);
      const usage = [];
      do {
        const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const conversation of page.items) {
          const doc = await storage.findDocument({ kind: 'pi.usage', scope: { kind: 'conversation', conversationId: conversation.id } }, 'current', BACKGROUND_CONTEXT);
          if (doc) {
            const content = await storage.document(doc.id, 'current', BACKGROUND_CONTEXT);
            if (content) usage.push({ conversationId: conversation.id, documentId: doc.id, value: content.value });
          }
        }
        cursor = page.next;
      } while (cursor);
      return { source: path, method: 'owner-fenced-quiescent-main-plus-wal-copy/public-storage-scan', snapshotSha256, sourceFiles, pending, usage };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function preflight(owner: OwnerLease) {
  const root = owner.path;
  owner.assertHeld();
  const reports = [];
  const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  for (const dir of sessions) {
    if (!dir.isDirectory()) throw new Error('RECOVERY_REQUIRED: unexpected session storage alias');
    const path = join(root, 'sessions', dir.name, 'durable.sqlite');
    await access(path).catch(() => { throw new Error('RECOVERY_REQUIRED: missing session storage'); });
    const report = await inspectSession(path, owner);
    reports.push(report);
    if (report.pending.length) throw new Error(`RECOVERY_REQUIRED: ${dir.name} has pending durable work`);
  }
  try { await access(join(root, 'host.sqlite')); } catch { if (sessions.length) throw new Error('RECOVERY_REQUIRED: missing host facts'); return reports; }
  const db = openHostReadonly(root);
  try {
    const accepted = db.prepare("SELECT body FROM records WHERE kind='task.accepted'").all().map(row => JSON.parse(readObject(root, JSON.parse(String(row.body)) as BlobRef).toString()));
    const knownSessions = new Set(accepted.map(record => record.sessionId));
    for (const dir of sessions) if (!knownSessions.has(dir.name)) throw new Error('RECOVERY_REQUIRED: session without host authorization identity');
    const started = db.prepare("SELECT body FROM records WHERE kind='run.started'").all().map(row => JSON.parse(readObject(root, JSON.parse(String(row.body)) as BlobRef).toString()));
    for (const record of started) if (!sessions.some(dir => dir.name === record.sessionId)) throw new Error('RECOVERY_REQUIRED: recorded session storage is missing');
    const rows = db.prepare("SELECT run_id FROM records WHERE kind='task.accepted' AND run_id NOT IN (SELECT run_id FROM records WHERE kind='run.closed')").all();
    if (rows.length) throw new Error('RECOVERY_REQUIRED: unconfirmed previous close or cross-store gap');
    const receipts = db.prepare("SELECT body FROM records WHERE kind='run.closed'").all();
    for (const row of receipts) {
      const receipt = JSON.parse(readObject(root, JSON.parse(String(row.body)) as BlobRef).toString());
      if (receipt.cleanup !== 'confirmed' || receipt.status === 'unknown') throw new Error('RECOVERY_REQUIRED: unresolved original loss or termination');
    }
  } finally { db.close(); }
  return reports;
}
