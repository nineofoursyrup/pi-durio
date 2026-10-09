import lockfile from 'proper-lockfile';
import { mkdir, realpath, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';

export async function acquireOwner(path: string, onCompromised: (error: Error) => void) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const ownerPath = join(canonical, 'owner.json');
  // Never steal a stale lock automatically. proper-lockfile may remove its lock
  // directory during process exit; owner.json persists until our confirmed release.
  // Either marker therefore requires a separate recovery decision.
  for (const marker of [`${canonical}.lock`, ownerPath]) try {
    await access(marker);
    const owner = await readFile(ownerPath, 'utf8').catch(() => 'unknown owner');
    throw new Error(`OWNER_CONFLICT ${canonical}: ${owner}. Stop the holder; inspect pending work before manual stale-lock recovery.`);
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let release: () => Promise<void>;
  let held = true;
  try { release = await lockfile.lock(canonical, { stale: Number.MAX_SAFE_INTEGER, update: 1000, retries: 0, onCompromised: error => { held = false; onCompromised(error); } }); }
  catch { throw new Error(`OWNER_CONFLICT ${canonical}: concurrent owner; inspect owner.json and pending work`); }
  try { await writeFile(ownerPath, JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() }), { mode: 0o600 }); }
  catch (error) { await release(); throw error; }
  return { path: canonical, assertHeld() { if (!held) throw new Error('OWNER_LOST'); }, async release() { if (!held) throw new Error('OWNER_LOST: cannot release unconfirmed ownership'); await release(); await rm(ownerPath, { force: true }); held = false; } };
}

export type OwnerLease = Awaited<ReturnType<typeof acquireOwner>>;
