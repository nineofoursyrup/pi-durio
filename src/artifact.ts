import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, type Evidence } from './evidence.js';

export function captureArtifact(evidence: Evidence, workspace: string) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const save = (path: string, label: string) => files.push({ path: label, ...evidence.blob(readFileSync(path)) });
  save(join(root, 'package.json'), 'package.json');
  save(join(root, 'dist', 'execution', 'package-lock.json'), 'package-lock.json');
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) walk(child); else save(child, relative(root, child)); } };
  walk(join(root, 'dist', 'src'));
  const dependencies = ['@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/chord'].map(name => {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
    const path = join(directory, 'package.json');
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    save(path, `dependencies/${name}/package.json`);
    return { name, version: metadata.version };
  });
  let git: unknown;
  try {
    const command = (args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git = { head: command(['rev-parse', 'HEAD']).trim(), status: command(['status', '--porcelain=v1', '--untracked-files=all', '--', '.']), diff: evidence.blob(command(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--', '.'])), completeness: 'tracked diff acquired; untracked and unread file content not snapshotted' };
  } catch { git = { completeness: 'unavailable or not a Git workspace' }; }
  return { id: digest(JSON.stringify(files)), files, dependencies, node: process.version, platform: process.platform, arch: process.arch, workspace: resolve(workspace), git, dependencyContent: 'Exact lockfile with tarball integrity retained; installed manifests acquired. Registry artifacts required to reinstall. No claim of fully offline reconstruction.' };
}
