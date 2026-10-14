import lockfile from 'proper-lockfile';
import { mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { realpathSync, readFileSync, writeFileSync, rmSync, lstatSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// Only leases acquired here enter this registry. PID/owner.json, or a caller's
// structurally similar object, cannot grant same-process write access.
const owners = new Map<string, ReturnType<typeof leaseState>>();
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && !b.isSymbolicLink();
const lockOptions = { stale: Number.MAX_SAFE_INTEGER, update: 1000, retries: 0 };
function rejectExisting(canonical: string) {
  for (const marker of [`${canonical}.lock`, join(canonical, 'owner.json')]) {
    try { lstatSync(marker); } catch (error) { if (missing(error)) continue; throw error; }
    let owner = 'unknown owner';
    try { owner = readFileSync(join(canonical, 'owner.json'), 'utf8'); } catch {}
    throw new Error(`OWNER_CONFLICT ${canonical}: ${owner}. Stop the holder; inspect pending work before manual stale-lock recovery.`);
  }
  if (owners.has(canonical)) throw new Error(`OWNER_LOST ${canonical}: unconfirmed prior ownership; inspect pending work`);
}
function leaseState(canonical: string, onCompromised: (error: Error) => void) {
  const ownerPath = join(canonical, 'owner.json');
  const rootIdentity = lstatSync(canonical), lockIdentity = lstatSync(`${canonical}.lock`);
  const claim = Object.freeze({ pid: process.pid, host: hostname(), started: new Date().toISOString(), token: randomUUID() });
  const body = JSON.stringify(claim);
  let state: 'held' | 'releasing' | 'lost' | 'released' = 'held';
  let compromised = onCompromised;
  const assertLock = () => {
    if (!sameFile(rootIdentity, lstatSync(canonical)) || !sameFile(lockIdentity, lstatSync(`${canonical}.lock`))) throw new Error('OWNER_LOST: root or lock replaced');
  };
  const assertClaim = () => { if (readFileSync(ownerPath, 'utf8') !== body) throw new Error('OWNER_LOST: claim replaced'); };
  const lose = (error: Error) => { state = 'lost'; compromised(error); };
  const assertHeld = () => {
    if (state !== 'held') throw new Error(`OWNER_LOST: ${state}`);
    try { assertLock(); assertClaim(); }
    catch (error) { const lost = new Error('OWNER_LOST: active lease no longer matches root, lock and claim', { cause: error }); lose(lost); throw lost; }
  };
  return { path: canonical, claim, body, ownerPath, lose, assertLock, assertClaim, assertHeld,
    setOnCompromised(listener: (error: Error) => void) { compromised = listener; if (state !== 'held') listener(new Error('OWNER_LOST')); },
    beginRelease() { assertHeld(); state = 'releasing'; },
    released() { state = 'released'; owners.delete(canonical); },
  };
}
function cleanupFailure(error: unknown, cleanup: unknown): never {
  throw new AggregateError([error, cleanup], 'OWNER_CLEANUP_FAILED: ownership remains unconfirmed');
}

export async function acquireOwner(path: string, onCompromised: (error: Error) => void) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  rejectExisting(canonical);
  let lease: ReturnType<typeof leaseState> | undefined;
  let release: () => Promise<void>;
  try { release = await lockfile.lock(canonical, { ...lockOptions, onCompromised: error => lease ? lease.lose(error) : onCompromised(error) }); }
  catch (cause) { throw new Error(`OWNER_CONFLICT ${canonical}: concurrent owner; inspect owner.json and pending work`, { cause }); }
  lease = leaseState(canonical, onCompromised);
  try { await writeFile(lease.ownerPath, lease.body, { mode: 0o600, flag: 'wx' }); }
  catch (error) { try { lease.assertLock(); await release(); } catch (cleanup) { cleanupFailure(error, cleanup); } throw error; }
  owners.set(canonical, lease);
  const active = lease;
  return { path: canonical, claim: active.claim, setOnCompromised: active.setOnCompromised, assertHeld: active.assertHeld,
    async release() {
      active.beginRelease();
      await release();
      active.assertClaim();
      await rm(active.ownerPath);
      active.released();
    },
  };
}

/** Synchronous host mutation: borrow a verified lease or hold the same lock for
 * the complete callback, including closing every writable handle. */
export function withOwnerSync<T>(path: string, write: (canonical: string) => T): T {
  // Metrics mutate an existing data root; a missing/invalid target is not created.
  const canonical = realpathSync(path), current = owners.get(canonical);
  if (current) { current.assertHeld(); return write(canonical); }
  rejectExisting(canonical);
  let lease: ReturnType<typeof leaseState> | undefined;
  let release: () => void;
  try { release = lockfile.lockSync(canonical, { ...lockOptions, onCompromised: error => lease?.lose(error) }); }
  catch (cause) { throw new Error(`OWNER_CONFLICT ${canonical}: concurrent owner; inspect owner.json and pending work`, { cause }); }
  lease = leaseState(canonical, () => {});
  try { writeFileSync(lease.ownerPath, lease.body, { mode: 0o600, flag: 'wx' }); }
  catch (error) { try { lease.assertLock(); release(); } catch (cleanup) { cleanupFailure(error, cleanup); } throw error; }
  owners.set(canonical, lease);
  let failed = false, failure: unknown;
  try { lease.assertHeld(); return write(canonical); }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { lease.beginRelease(); release(); lease.assertClaim(); rmSync(lease.ownerPath); lease.released(); }
    catch (cleanup) { if (failed) cleanupFailure(failure, cleanup); throw cleanup; }
  }
}

export type OwnerLease = Awaited<ReturnType<typeof acquireOwner>>;
