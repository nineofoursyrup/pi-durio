import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, realpath, mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { forEachDirectory, scanSubmissions, scanTasks, type StorageReader } from './storage-projection.js';

const changed = () => Error('RECOVERY_SNAPSHOT_CHANGED: display source changed; recheck before deciding');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function stamp(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Error('RECOVERY_SOURCE_ALIAS');
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode]);
}
async function file(path: string) {
  const before = await stamp(path), hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (await stamp(path) !== before) throw changed();
  return { path, sha256: hash.digest('hex'), stamp: before };
}
async function absent(path: string, reason: string) {
  try { await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
  throw Error(reason);
}
/** A display reader never takes this lock. Unknown, stale and live markers all block it. */
export async function assertDisplayOwnerAbsent(path: string) {
  await absent(`${path}.lock`, 'OWNER_CONFLICT: unresolved display source owner');
  await absent(join(path, 'owner.json'), 'OWNER_CONFLICT: unresolved display source owner');
}
async function pair(path: string) {
  // A rollback journal needs recovery, which this observation must not perform.
  await absent(`${path}-journal`, 'RECOVERY_JOURNAL_UNRESOLVED');
  const parts = [await file(path)];
  try { parts.push(await file(`${path}-wal`)); } catch (error) { if (!missing(error)) throw error; }
  return parts;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Optimistic display-only observation identity. Includes host facts, every session's main/WAL
 * pair, directory identities and the session set. It is never an owner lease or admission grant.
 * A writer observed before/after the scan, source replacement or a changed file set fails closed.
 */
export async function recoveryDisplayIdentity(root: string) {
  await assertDisplayOwnerAbsent(root);
  const hash = createHash('sha256');
  hash.update(await stamp(root, true));
  hash.update(JSON.stringify(await pair(join(root, 'host.sqlite'))));
  const sessions = join(root, 'sessions');
  hash.update(await stamp(sessions, true));
  await forEachDirectory(sessions, async entry => {
    if (!entry.isDirectory) throw Error('SESSION_STORAGE_ALIAS');
    const path = join(sessions, entry.name);
    await assertDisplayOwnerAbsent(path);
    hash.update(JSON.stringify([entry.name, await stamp(path, true), await pair(join(path, 'durable.sqlite'))]));
  });
  await assertDisplayOwnerAbsent(root);
  return hash.digest('hex');
}

/** Display-only public-storage scan of a verified temporary copy. Unlike inspectSnapshot,
 * this has no execution authority and cannot be used by preflight/prepareRecovery. The original
 * is opened only as bytes; SQLite opens only the disposable main/WAL copy.
 */
export async function inspectDisplaySnapshot<T>(path: string, root: string, inspect: (storage: StorageReader) => Promise<T>) {
  path = await realpath(path);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('INSPECTION_OUTSIDE_DISPLAY_ROOT');
  const checkOwners = async () => { await assertDisplayOwnerAbsent(root); await assertDisplayOwnerAbsent(dirname(path)); };
  await checkOwners();
  const before = await pair(path), dir = await mkdtemp(join(tmpdir(), 'durio-display-'));
  const snapshot = join(dir, 'snapshot.sqlite');
  try {
    for (const source of before) {
      const destination = source.path === path ? snapshot : `${snapshot}-wal`;
      await copyFile(source.path, destination); await chmod(destination, 0o600);
      if ((await file(destination)).sha256 !== source.sha256) throw changed();
    }
    if (!same(before, await pair(path))) throw changed();
    await checkOwners();
    const storage = await openNodeSqliteStorage(snapshot);
    try {
      const details = await inspect(storage);
      if (!same(before, await pair(path))) throw changed();
      await checkOwners();
      return { source: path, sourceFiles: before.map(({ path, sha256 }) => ({ path, sha256 })), ...details };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function inspectDisplayAdmission(path: string, root: string) {
  return inspectDisplaySnapshot(path, root, async storage => {
    let pending = 0, taskCount = 0, submissionCount = 0;
    for await (const task of scanTasks(storage)) { taskCount++; if (task.state.status !== 'terminal') pending++; }
    for await (const submission of scanSubmissions(storage)) { submissionCount++; if (submission.status === 'queued' || submission.status === 'placed') pending++; }
    return { pending, taskCount, submissionCount };
  });
}
