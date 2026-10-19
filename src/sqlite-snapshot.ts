/** Quiescent SQLite main/WAL copy mechanics. Callers supply their own authorization fence. */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { StorageReader } from './storage-projection.js';

export const snapshotChanged = () => Error('RECOVERY_SNAPSHOT_CHANGED: source changed; recheck before deciding');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function snapshotStamp(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Error('RECOVERY_SOURCE_ALIAS');
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode]);
}
async function file(path: string) {
  const before = await snapshotStamp(path), hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (await snapshotStamp(path) !== before) throw snapshotChanged();
  return { path, sha256: hash.digest('hex'), stamp: before };
}
export async function assertSnapshotPathAbsent(path: string, reason: string) {
  try { await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
  throw Error(reason);
}
export async function snapshotFiles(path: string) {
  await assertSnapshotPathAbsent(`${path}-journal`, 'RECOVERY_JOURNAL_UNRESOLVED');
  const parts = [await file(path)];
  try { parts.push(await file(`${path}-wal`)); } catch (error) { if (!missing(error)) throw error; }
  return parts;
}

/** Source SQLite is never opened: only the verified disposable copy is opened through public storage. */
export async function inspectQuiescentSnapshot<T>(path: string, fence: () => void | Promise<void>, inspect: (storage: StorageReader) => Promise<T>) {
  await fence();
  const before = await snapshotFiles(path), dir = await mkdtemp(join(tmpdir(), 'durio-inspect-'));
  const snapshot = join(dir, 'snapshot.sqlite');
  try {
    for (const source of before) {
      const destination = source.path === path ? snapshot : `${snapshot}-wal`;
      await copyFile(source.path, destination); await chmod(destination, 0o600);
      if ((await file(destination)).sha256 !== source.sha256) throw snapshotChanged();
    }
    const verify = async () => {
      if (JSON.stringify(before) !== JSON.stringify(await snapshotFiles(path))) throw snapshotChanged();
      await fence();
    };
    await verify();
    const storage = await openNodeSqliteStorage(snapshot);
    try {
      const details = await inspect(storage); await verify();
      return { source: path, snapshotSha256: before[0].sha256, sourceFiles: before.map(({ path, sha256 }) => ({ path, sha256 })), ...details };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Admission reads state only and discards each bounded public-storage page. */
export async function inspectAdmissionState(storage: StorageReader) {
  let taskCursor, submissionCursor, pending = 0, taskCount = 0, submissionCount = 0;
  do {
    const page = await storage.scanTasks({}, 32, taskCursor, BACKGROUND_CONTEXT);
    for (const task of page.items) { taskCount++; if (task.state.status !== 'terminal') pending++; }
    taskCursor = page.next;
  } while (taskCursor);
  do {
    const page = await storage.scanSubmissions({}, 32, submissionCursor, BACKGROUND_CONTEXT);
    for (const submission of page.items) { submissionCount++; if (submission.status === 'queued' || submission.status === 'placed') pending++; }
    submissionCursor = page.next;
  } while (submissionCursor);
  return { pending, taskCount, submissionCount };
}
