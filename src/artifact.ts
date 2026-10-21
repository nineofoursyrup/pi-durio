import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, readObject, type Evidence } from './evidence.js';

const artifactRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Original installed bytes must still be available and match; a lock hash alone never passes recovery. */
function installationFiles() {
  const lock = JSON.parse(readFileSync(join(artifactRoot, 'dist/execution/package-lock.json'), 'utf8'));
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue; // Nested packages have their own lock entry.
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error('EXECUTION_INSTALLATION_ALIAS: unsupported package file alias');
    }
  };
  for (const [path, metadata] of Object.entries(lock.packages) as [string, {dev?: boolean;optional?:boolean}][]) {
    if (!path || metadata.dev) continue;
    if (!existsSync(join(artifactRoot,path))) { if (metadata.optional) continue; throw new Error('EXECUTION_INSTALLATION_MISSING'); }
    walk(join(artifactRoot,path));
  }
  return files;
}
function installationInventory() {
  return installationFiles().map(path=>{const bytes=readFileSync(path);return {path:relative(artifactRoot,path),sha256:digest(bytes),bytes:bytes.length};});
}

/** Preserve manifest order and bound open files/buffers; settle all in-flight writes before releasing ownership on failure. */
async function captureFiles<T,R>(items:readonly T[],read:(item:T)=>Promise<R>):Promise<R[]> {
  const result:R[]=[];let next=0,failed=false,failure:unknown;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(!failed) {
      const index=next++;if(index>=items.length)return;
      try {result[index]=await read(items[index]);} catch(error){failed=true;failure=error;}
    }
  }));
  if(failed)throw failure;
  return result;
}

/** Own build, exact lock and direct dependency manifests, in recording order; `save` captures each file. */
function collectBuild(save: (path: string, label: string) => void) {
  const root = artifactRoot;
  save(join(root, 'package.json'), 'package.json');
  save(join(root, 'dist', 'execution', 'package-lock.json'), 'package-lock.json');
  save(join(root, 'dist', 'execution', 'source-build.json'), 'dist/execution/source-build.json');
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) walk(child); else save(child, relative(root, child)); } };
  walk(join(root, 'dist', 'src'));
  return ['@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/chord'].map(name => {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
    const path = join(directory, 'package.json');
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    save(path, `dependencies/${name}/package.json`);
    return { name, version: metadata.version };
  });
}

export async function captureArtifact(evidence: Evidence, workspace: string) {
  const buildFiles:{path:string;label:string}[]=[];
  const dependencies = collectBuild((path,label)=>buildFiles.push({path,label}));
  const files=await captureFiles(buildFiles,async({path,label})=>({path:label,...await evidence.blobAsync(await readFile(path))}));
  let git: unknown;
  try {
    const command = (args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git = { head: command(['rev-parse', 'HEAD']).trim(), status: command(['status', '--porcelain=v1', '--untracked-files=all', '--', '.']), diff: evidence.blob(command(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--', '.'])), completeness: 'tracked diff acquired; untracked and unread file content not snapshotted' };
  } catch { git = { completeness: 'unavailable or not a Git workspace' }; }
  const inventory=await captureFiles(installationFiles(),async path=>{const bytes=await readFile(path);return {path:relative(artifactRoot,path),sha256:digest(bytes),bytes:bytes.length};});
  const installation = await evidence.blobAsync(JSON.stringify(inventory));
  return { id: digest(JSON.stringify(files)), files, installation, dependencies, node: process.version, platform: process.platform, arch: process.arch, workspace: resolve(workspace), git, dependencyContent: 'Own build and exact lock content retained. Recovery also reacquires every installed production package byte and verifies it against the original inventory; missing or changed bytes block. Inventory alone cannot reconstruct an absent installation.' };
}

export function verifyArtifact(root: string, artifact: Awaited<ReturnType<typeof captureArtifact>>) {
  if (!artifact?.installation || !Array.isArray(artifact.files)) throw new Error('EXECUTION_CONTENT_UNAVAILABLE: original installation inventory missing');
  if (artifact.node !== process.version || artifact.platform !== process.platform || artifact.arch !== process.arch) throw new Error('EXECUTION_PLATFORM_CHANGED');
  for (const file of artifact.files) {
    const original = readObject(root, file);
    const path = file.path === 'package-lock.json' ? 'dist/execution/package-lock.json' : file.path.startsWith('dependencies/') ? `node_modules/${file.path.slice('dependencies/'.length)}` : file.path;
    if (!readFileSync(join(artifactRoot, path)).equals(original)) throw new Error(`EXECUTION_VERSION_CHANGED: ${file.path}`);
  }
  const original = readObject(root, artifact.installation);
  if (!original.equals(Buffer.from(JSON.stringify(installationInventory())))) throw new Error('EXECUTION_INSTALLATION_CHANGED: original dependency content is not available in this installation');
}

/**
 * The build identity a new task started now would record (`execution.artifact` id, Node and platform),
 * computed without writing any object. The installation inventory digest walks every installed production
 * package (about a second when cold), so it is a separate call.
 */
export function currentBuild() {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  collectBuild((path, label) => { const bytes = readFileSync(path); files.push({ path: label, sha256: digest(bytes), bytes: bytes.length }); });
  return { id: digest(JSON.stringify(files)), node: process.version, platform: process.platform, arch: process.arch };
}
export function currentInstallation() { return digest(JSON.stringify(installationInventory())); }
