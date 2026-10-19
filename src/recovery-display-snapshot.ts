import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { forEachDirectory, type StorageReader } from './storage-projection.js';
import { inspectQuiescentSnapshot, inspectAdmissionState, snapshotFiles as pair, snapshotStamp as stamp, assertSnapshotPathAbsent as absent } from './sqlite-snapshot.js';

/** A display reader never takes this lock. Unknown, stale and live markers all block it. */
export async function assertDisplayOwnerAbsent(path: string) {
  await absent(`${path}.lock`, 'OWNER_CONFLICT: unresolved display source owner');
  await absent(join(path, 'owner.json'), 'OWNER_CONFLICT: unresolved display source owner');
}
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
  return inspectQuiescentSnapshot(path, checkOwners, inspect);
}

export async function inspectDisplayAdmission(path: string, root: string) {
  return inspectDisplaySnapshot(path, root, inspectAdmissionState);
}
