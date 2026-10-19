#!/usr/bin/env node
// Rebuild the native f26ae8f installation and derive Linux runtime, or verify a supplied copy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, sha256 } from '../redesign-terminal/common.mjs';

const [outputArg, linuxArg] = process.argv.slice(2);
if (!outputArg) throw Error('Usage: node scripts/fixtures/prepare-v1-candidate.mjs NEW_FROZEN_CANDIDATE [FROZEN_LINUX_RUNTIME]');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = resolve(outputArg), linux = linuxArg ? resolve(linuxArg) : undefined;
const manifest = readFileSync(new URL('./v1-frozen-build.json', import.meta.url));
assert.equal(sha256(manifest), '7cd21af10280ae331aa3b77df06588d398a2d343d6f2aed71725d39b84b05546', 'Portable frozen manifest SHA');
const frozen = JSON.parse(manifest.toString()), sorted = rows => rows.sort((a, b) => a.path.localeCompare(b.path));
if (linux) assert.equal(sha256(JSON.stringify(sorted(inventory(linux)))), frozen.linuxInventorySha256, 'Frozen Linux runtime input must match every file');
else execFileSync('/opt/homebrew/bin/container', ['image', 'inspect', frozen.image], { stdio: 'inherit' });
mkdirSync(output); // The output must be new; no old build is replaced.
const source = join(output, 'source'), pack = join(output, 'pack'), install = join(output, 'install');
mkdirSync(source); mkdirSync(pack); mkdirSync(install);
console.log('git archive', frozen.candidate, '->', source);
const archive = execFileSync('git', ['archive', frozen.candidate], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
console.log('npm ci --ignore-scripts: preserve the frozen esbuild launcher bytes');
execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: source, stdio: 'inherit' });
console.log('npm run build: f26ae8f source');
execFileSync('npm', ['run', 'build'], { cwd: source, stdio: 'inherit' });
assert.equal(sha256(readFileSync(join(source, 'dist/execution/source-build.json'))), frozen.sourceBuildSha256, 'Source/compiler/output manifest must match frozen SHA');
execFileSync(process.execPath, ['scripts/prepare-pack.mjs'], { cwd: source, stdio: 'inherit' });
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', pack], { cwd: source, stdio: 'inherit' });
execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(pack, 'pi-durio-0.1.0.tgz')], { cwd: install, stdio: 'inherit' });
const installed = sorted(inventory(join(install, 'node_modules/pi-durio')));
assert.equal(sha256(JSON.stringify(installed)), frozen.installedInventorySha256, 'Installed files and links must all match the frozen installation');
const runtime = join(output, 'linux-runtime');
if (linux) cpSync(linux, runtime, { recursive: true, verbatimSymlinks: true });
else {
  const prepared = join(output, 'linux-prepared');
  execFileSync(process.execPath, ['scripts/eval/prepare-runtime.mjs', prepared, frozen.image], { cwd: source, stdio: 'inherit' });
  mkdirSync(runtime);
  for (const name of ['package.json', 'package-lock.json', 'vendor', 'node_modules']) {
    cpSync(join(prepared, name), join(runtime, name), { recursive: true, verbatimSymlinks: true });
  }
  // 独立安装会按 package.json 的 bin 声明设置 cli.js 可执行权限；直接复制编译目录不等价。
  cpSync(join(install, 'node_modules/pi-durio/dist'), join(runtime, 'dist'), { recursive: true, verbatimSymlinks: true });
  const { environment } = JSON.parse(readFileSync(join(repo, 'docs/implementation/pi-durio-v1/delivery-f26ae8f/linux-runtime-derivation.json')));
  writeFileSync(join(runtime, 'eval-environment.json'), JSON.stringify(environment, null, 2) + '\n', { flag: 'wx' });
}
assert.equal(sha256(JSON.stringify(sorted(inventory(runtime)))), frozen.linuxInventorySha256);
const { describeImproveRuntime } = await import(join(install, 'node_modules/pi-durio/dist/src/improve-validation.js'));
assert.equal(describeImproveRuntime(runtime), frozen.linuxRuntimeIdentity);
writeFileSync(join(output, 'candidate-identity.json'), manifest, { flag: 'wx' });
console.log(JSON.stringify({ candidate: frozen.candidate, frozenManifestSha256: sha256(manifest), sourceBuildSha256: frozen.sourceBuildSha256, installedFiles: installed.length, installedInventorySha256: frozen.installedInventorySha256, linuxInventorySha256: frozen.linuxInventorySha256, output }, null, 2));
