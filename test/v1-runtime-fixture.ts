import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by the U14 readers. The immutable archive is unpacked once per test file.
const archiveDir = fileURLToPath(new URL('../../test/fixtures/v1-runtime-records', import.meta.url));
const archive = JSON.parse(readFileSync(join(archiveDir, 'archive.json'), 'utf8')) as { sha256: string; parts: string[] };
const compressed = Buffer.concat(archive.parts.map(part => readFileSync(join(archiveDir, part))));
assert.equal(createHash('sha256').update(compressed).digest('hex'), archive.sha256);
export const fixtureDir = mkdtempSync(join(tmpdir(), 'durio-v1-records-test-'));
execFileSync('tar', ['-xzf', '-', '-C', fixtureDir], { input: compressed });
export const dataRoot = join(fixtureDir, 'data');
export const identity = JSON.parse(readFileSync(join(fixtureDir, 'fixture-identity.json'), 'utf8')) as {
  names: Record<string, string>; generatedBy: string; provenance: string;
};
assert.equal(identity.generatedBy, 'f26ae8f');
assert.equal(identity.provenance, 'runtime-generated');
export const names = identity.names;
const denialArchive = JSON.parse(readFileSync(join(archiveDir, 'readonly-denial-archive.json'), 'utf8')) as { sha256: string; parts: string[]; identitySha256: string };
const denialBytes = Buffer.concat(denialArchive.parts.map(part => readFileSync(join(archiveDir, part))));
assert.equal(createHash('sha256').update(denialBytes).digest('hex'), denialArchive.sha256);
export const readonlyDenialDir = join(fixtureDir, 'readonly-denial');
mkdirSync(readonlyDenialDir);
execFileSync('tar', ['-xzf', '-', '-C', readonlyDenialDir], { input: denialBytes });
assert.equal(createHash('sha256').update(readFileSync(join(readonlyDenialDir, 'fixture-identity.json'))).digest('hex'), denialArchive.identitySha256);
const before = [fixtureDir].map(root => ({ root, files:
  readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name);
    return [path, createHash('sha256').update(readFileSync(path)).digest('hex')] as const;
  }),
}));
after(() => {
  try {
    for (const { root, files } of before) {
      assert.equal(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length, files.length, 'U14 reads must not add records or lock files');
      for (const [path, hash] of files) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, `U14 reads must preserve ${path}`);
    }
  } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
});
