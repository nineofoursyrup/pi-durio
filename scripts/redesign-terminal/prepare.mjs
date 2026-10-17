#!/usr/bin/env node
import { readFileSync, mkdirSync, cpSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { inventory, save, schema, sha256, templates } from './common.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, package: { type: 'string' }, out: { type: 'string' }, synthetic: { type: 'boolean', default: false } } });
if (!values.source || !values.package || !values.out) throw Error('Usage: node prepare.mjs --source CLEAN_CANDIDATE --package INSTALLED_ROOT --out NEW_PREP_DIR [--synthetic]');
const source = realpathSync(values.source), installed = realpathSync(values.package), requested = resolve(values.out);
const output = join(realpathSync(dirname(requested)), basename(requested)), harnessSource = realpathSync(dirname(fileURLToPath(import.meta.url)));
for (const root of [source, installed, harnessSource]) { const r = relative(root, output); if (!r || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) throw Error('OUTPUT_MUST_BE_OUTSIDE_CANDIDATE'); }
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const candidate = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
const buildBytes = readFileSync(join(installed, 'dist/execution/source-build.json'));
if (!values.synthetic) {
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw Error('CANDIDATE_TRACKED_DIRTY');
  const build = JSON.parse(buildBytes), tracked = new Set(git(['ls-files', '-z']).split('\0'));
  // Same explicit sets as build-artifact.mjs; importing it would rebuild and is forbidden here.
  const collect = (root, paths, lines = false) => {
    const result = [];
    function walk(path) { const stat = lstatSync(join(root, path)); if (stat.isSymbolicLink()) throw Error(`BUILD_INPUT_ALIAS:${path}`); if (stat.isDirectory()) { for (const name of readdirSync(join(root, path)).sort()) walk(join(path, name)); } else if (stat.isFile()) { const bytes = readFileSync(join(root, path)); result.push({ path, sha256: sha256(bytes), bytes: bytes.length, ...(lines ? { physicalLines: bytes.reduce((n, b) => n + (b === 10 ? 1 : 0), 0) + (bytes.length && bytes.at(-1) !== 10 ? 1 : 0) } : {}) }); } else throw Error(`BUILD_INPUT_TYPE:${path}`); }
    for (const path of paths) walk(path); return result;
  };
  const inputs = collect(source, ['src', 'test', 'scripts', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json'], true);
  if (inputs.some(e => !tracked.has(e.path))) throw Error('CANDIDATE_UNTRACKED_BUILD_INPUT');
  const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
  const compiler = collect(source, Object.entries(lock.packages).filter(([path, metadata]) => path && metadata.dev).map(([path]) => path).sort());
  const outputs = collect(installed, ['dist/src', 'dist/execution/package-lock.json', 'dist/execution/isolation']);
  for (const [name, expected] of Object.entries({ inputs, compiler, outputs })) if (JSON.stringify(build[name]) !== JSON.stringify(expected)) throw Error(`SOURCE_BUILD_${name.toUpperCase()}_CHANGED`);
}
const files = inventory(installed);
mkdirSync(output, { mode: 0o700 }); // Existing directory is always refused, including a partial attempt.
const harness = join(output, 'harness');
cpSync(harnessSource, harness, { recursive: true, errorOnExist: true, force: false });
const manifest = { schema, createdAt: new Date().toISOString(), candidate, source: { root: source, sourceBuildSha256: sha256(buildBytes) }, installation: { root: installed, files }, harness: { root: harness, files: inventory(harness) }, runtime: { node: process.version, platform: process.platform, arch: process.arch }, synthetic: values.synthetic, nativeAcceptance: 'NOT_RUN' };
save(join(output, 'manifest.json'), manifest);
for (const [name, value] of Object.entries(templates())) save(join(output, name), { ...value, candidate, manifestSha256: sha256(readFileSync(join(output, 'manifest.json'))) });
console.log(JSON.stringify({ prepared: output, candidate, nativeAcceptance: 'NOT_RUN', next: 'verify.mjs --manifest manifest.json; see harness/README.md' }));
