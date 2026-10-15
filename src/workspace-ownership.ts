import { realpath, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { digest } from './evidence.js';
import { acquireOwner, type OwnerLease } from './ownership.js';

// Shared by all product data roots/sessions for this OS user; not a run-controlled option.
export const workspaceOwnerRegistry = join(homedir(), 'Library', 'Application Support', 'pi-durio', 'workspace-owners');
const registry = workspaceOwnerRegistry;
const contains = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
};

export async function resolveWorkspaceRoot(workspace: string) {
  let root = await realpath(workspace);
  try {
    const gitRoot = execFileSync('/usr/bin/git', ['-C', root, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    }).trim();
    root = await realpath(gitRoot);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; code?: string };
    if (failure.status !== 128 || !String(failure.stderr).includes('fatal: not a git repository (or any of the parent directories): .git')) {
      throw new Error(`WORKSPACE_IDENTITY_UNKNOWN: cannot resolve Git root for ${root}; ${failure.code ?? String(failure.stderr ?? error).trim()}`);
    }
    // Only a confirmed non-repository uses the caller's explicitly declared root.
  }
  return root;
}

export interface WorkspaceHolder { registered: string; path: string; pid?: number; host?: string; started?: string }
/**
 * Read-only R2 probe (welcome screen): the protocol holder whose registered root overlaps `workspace`, or null.
 * Takes neither the registry gate nor any lock, so it can race a concurrent acquire; acceptance still decides.
 * A marker with a missing or unreadable registration counts as held, as acquisition would refuse it.
 */
export async function probeWorkspaceOwner(workspace: string): Promise<{ root: string; holder: WorkspaceHolder | null }> {
  const root = await resolveWorkspaceRoot(workspace);
  let entries;
  try { entries = await readdir(registry, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root, holder: null }; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const path = join(registry, entry.name);
    let held = false;
    for (const marker of [`${path}.lock`, join(path, 'owner.json')]) {
      try { await access(marker); held = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!held) continue;
    const registered = await readFile(join(path, 'workspace.json'), 'utf8').then(text => String(JSON.parse(text).root), () => '');
    if (registered && !contains(root, registered) && !contains(registered, root)) continue;
    const owner = await readFile(join(path, 'owner.json'), 'utf8').then(text => JSON.parse(text), () => ({}));
    return { root, holder: { registered, path, pid: typeof owner.pid === 'number' ? owner.pid : undefined, host: typeof owner.host === 'string' ? owner.host : undefined, started: typeof owner.started === 'string' ? owner.started : undefined } };
  }
  return { root, holder: null };
}

export async function acquireWorkspaceOwner(workspace: string, onCompromised: (error: Error) => void) {
  const root = await resolveWorkspaceRoot(workspace);
  await mkdir(registry, { recursive: true, mode: 0o700 });
  let gate: OwnerLease | undefined;
  for (let attempt = 0; !gate; attempt++) {
    try { gate = await acquireOwner(registry, onCompromised); }
    catch (error) { if (attempt >= 50 || !String(error).includes('OWNER_CONFLICT')) throw error; await setTimeout(20); }
  }
  try {
    gate.assertHeld();
    for (const entry of await readdir(registry, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(registry, entry.name);
      let unresolved = false;
      for (const marker of [`${path}.lock`, join(path, 'owner.json')]) {
        try { await access(marker); unresolved = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!unresolved) continue;
      // Missing/corrupt registration with an active lock is uncertain, never an invitation to take ownership.
      const registered = JSON.parse(await readFile(join(path, 'workspace.json'), 'utf8')) as { root: string };
      if (contains(root, registered.root) || contains(registered.root, root)) {
        const holder = await readFile(join(path, 'owner.json'), 'utf8').catch(() => 'unknown holder');
        throw new Error(`OWNER_CONFLICT workspace ${root} overlaps ${registered.root}: ${holder}. Stop the holder and inspect pending work; never remove a stale lock solely because its PID disappeared.`);
      }
    }
    const path = join(registry, digest(root));
    gate.assertHeld();
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, 'workspace.json'), JSON.stringify({ root }), { mode: 0o600 });
    const lease = await acquireOwner(path, onCompromised);
    return { ...lease, root };
  } finally { await gate.release(); }
}
