#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { schema, sha256, verifyInventory } from './common.mjs';

/** Read-only: no product import, fixture creation, credential lookup or subprocess. */
export function verifyManifest(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (manifest.schema !== schema || !/^[a-f0-9]{40}$/.test(manifest.candidate?.commit) || !/^[a-f0-9]{40}$/.test(manifest.candidate?.tree) || typeof manifest.synthetic !== 'boolean') throw Error('INVALID_TERMINAL_MANIFEST');
  verifyInventory(manifest.installation.root, manifest.installation.files, 'INSTALLATION');
  verifyInventory(manifest.harness.root, manifest.harness.files, 'HARNESS');
  if (sha256(readFileSync(join(manifest.installation.root, 'dist/execution/source-build.json'))) !== manifest.source.sourceBuildSha256) throw Error('SOURCE_BUILD_CHANGED');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { manifest: { type: 'string' } } });
  if (!values.manifest) throw Error('Usage: node verify.mjs --manifest PREP/manifest.json');
  const manifest = verifyManifest(values.manifest);
  console.log(JSON.stringify({ verified: true, candidate: manifest.candidate, synthetic: manifest.synthetic, nativeAcceptance: 'NOT_RUN' }));
}
