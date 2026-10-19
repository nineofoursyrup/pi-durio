#!/usr/bin/env node
/**
 * Supplement the immutable v1-records fixture with an actual f26ae8f readonly
 * recovery denial. Run under the shared check.lock; no container or provider.
 *
 * node scripts/fixtures/generate-v1-readonly-denial.mjs NEW_OUTPUT FROZEN_CANDIDATE
 * FROZEN_CANDIDATE contains the portable candidate-identity.json and rebuilt install/.
 * Both the old installation and the old v1-records directory stay read-only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const candidate = 'f26ae8f4b8039608a1fa796e1c69da4d8173d112';
const tree = 'ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0';
const identityHash = '7cd21af10280ae331aa3b77df06588d398a2d343d6f2aed71725d39b84b05546';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const file = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha256(bytes) }; };
const [outputArg, frozenArg] = process.argv.slice(2);
assert.ok(outputArg && frozenArg, 'Usage: generate-v1-readonly-denial.mjs NEW_OUTPUT FROZEN_CANDIDATE');
const output = resolve(outputArg), frozen = realpathSync(frozenArg);
assert.equal(existsSync(output), false, 'Refuse to replace any existing fixture');
const install = join(frozen, 'install/node_modules/pi-durio');
const identityPath = join(frozen, 'candidate-identity.json');
assert.equal(file(identityPath).sha256, identityHash, 'Use the frozen final-candidate-f26ae8f identity');
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
assert.equal(identity.candidate, candidate);
assert.equal(file(join(install, 'dist/execution/source-build.json')).sha256, identity.sourceBuildSha256, 'The rebuilt source/compiler/output manifest matches the frozen SHA');

function inventory(root) {
  const entries = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), info = lstatSync(path), label = relative(root, path);
      if (info.isDirectory()) walk(path);
      else if (info.isSymbolicLink()) entries.push({ path: label, symlink: readlinkSync(path) });
      else { assert.ok(info.isFile(), `Unsupported entry: ${path}`); entries.push({ path: label, ...file(path) }); }
    }
  }
  walk(root);
  return entries;
}
const sorted = entries => [...entries].sort((a, b) => a.path.localeCompare(b.path));
function verifyInstallation() {
  const actual = sorted(inventory(install));
  const content = actual.map(row => ({ path: row.path, sha256: row.symlink ? `link:${row.symlink}` : row.sha256 }));
  assert.equal(sha256(JSON.stringify(content)), identity.installedInventorySha256, 'Frozen runtime and dependencies must exactly match their portable manifest');
  return { entries: actual.length, inventorySha256: sha256(JSON.stringify(actual)) };
}
const installed = verifyInstallation();
const originalFixture = fileURLToPath(new URL('../../test/fixtures/v1-records/', import.meta.url));
const originalBefore = inventory(originalFixture);
const space = statfsSync(tmpdir());
assert.ok(space.bavail * space.bsize >= 30 * 1024 ** 3, 'At least 30 GiB free is required before generation');

// Only these verified old modules create records. The current build is never imported.
// An accidentally omitted injected transport must fail before any network request.
globalThis.fetch = async () => { throw Error('FIXTURE_NETWORK_FORBIDDEN'); };
const load = path => import(pathToFileURL(join(install, path)).href);
const { runCodingTask, checkRecovery, recoverRun } = await load('dist/src/runtime.js');
const { scriptedTransport } = await load('dist/src/offline.js');
const { records, decode } = await load('dist/src/history.js');
const work = await mkdtemp(join(tmpdir(), 'durio-v1-readonly-denial-'));
const workspace = join(work, 'project'), dataRoot = join(work, 'data');
await mkdir(workspace);
const target = 'target.txt', before = 'first authorized effect\n', attempted = 'forbidden replacement during readonly recovery\n';
await writeFile(join(workspace, 'README.md'), 'Offline v1 readonly recovery denial fixture.\n');
// Start with an absent target: v1 requires a prior read before replacing an
// existing file. The first authorized tool call creates the bytes we preserve.

const stop = new AbortController();
const initialTransport = scriptedTransport([{ name: 'write', args: { path: target, content: before } }]);
const initial = await runCodingTask({
  workspace, dataRoot, input: 'Write the first authorized effect once.', mode: 'offline',
  transport: initialTransport.fetch, signal: stop.signal, cancellation: 'exit',
  onObservation: event => { if (event.kind === 'tool.result') stop.abort(); },
});
assert.equal(initial.status, 'unknown', JSON.stringify(initial));
assert.equal(readFileSync(join(workspace, target), 'utf8'), before);
const originalRecords = [...records(dataRoot, { runId: initial.runId })];
// Decode every original now, so a missing/corrupt object cannot be blessed by its ref.
for (const ref of originalRecords) decode(dataRoot, ref);
const authorization = { workspace, mode: 'offline', tools: ['read', 'write', 'edit', 'bash'] };
const report = await checkRecovery({ dataRoot, runId: initial.runId, authorization });
assert.equal(report.status, 'needs-decision', JSON.stringify(report));
assert.ok(report.tools.some(tool => tool.fact === 'completed-uncommitted'), 'Interrupt after the real write, before durable completion');

// A different write is essential: current duplicate-call protection would allow it.
// f26ae8f instead permits scoped reads only after a completed-uncommitted effect.
const continuation = scriptedTransport([
  { name: 'write', args: { path: target, content: attempted } },
  { name: 'read', args: { path: target } },
]);
const decisionId = 'v1-readonly-denial';
const recovered = await recoverRun({
  dataRoot, runId: initial.runId, authorization,
  decision: { id: decisionId, snapshotId: report.snapshotId, action: 'continue', acceptAdditionalModelAttempts: true },
  transport: continuation.fetch,
});
assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
assert.equal(readFileSync(join(workspace, target), 'utf8'), before, 'Recovery must not replace the original bytes');
assert.match(JSON.stringify(continuation.calls), /CAPABILITY_DENIED: recovery continuation allows read only/);
const finalRecords = [...records(dataRoot, { runId: initial.runId })];
assert.deepEqual(finalRecords.slice(0, originalRecords.length), originalRecords, 'Original record references stay unchanged');
for (const ref of originalRecords) decode(dataRoot, ref);
const facts = finalRecords.map(ref => ({ ref, data: decode(dataRoot, ref) }));
const started = facts.find(fact => fact.ref.kind === 'recovery.started');
assert.deepEqual(started.data.capabilities, ['read']);
const denied = facts.filter(fact => fact.ref.kind === 'recovery.capability-denied');
assert.equal(denied.length, 1);
assert.equal(denied[0].data.tool, 'write');
assert.equal(denied[0].data.decisionId, decisionId);
assert.equal(denied[0].data.reason, 'completed or skipped uncertain effect; this continuation permits scoped reads only');
assert.equal(denied[0].data.duplicate, undefined);
assert.deepEqual(facts.filter(fact => fact.ref.kind === 'tool.dispatch' && fact.ref.seq > started.ref.seq).map(fact => fact.data.tool), ['read']);
assert.equal(facts.find(fact => fact.ref.kind === 'run.closed').data.status, 'unknown', 'Original unknown result is not rewritten');
assert.deepEqual(verifyInstallation(), installed, 'Generation must not change the frozen installation');
assert.deepEqual(inventory(originalFixture), originalBefore, 'Generation must not change v1-records');

await mkdir(output); // NEW_OUTPUT must still not exist; no overwrite/replacement path.
await cp(dataRoot, join(output, 'data'), { recursive: true, errorOnExist: true, force: false });
await cp(workspace, join(output, 'workspace'), { recursive: true, errorOnExist: true, force: false });
const proof = {
  schema: 1,
  generatedBy: candidate, tree,
  scope: 'Offline synthetic transport; real frozen runtime, Harness, SQLite and recovery; no model inference or paid request',
  source: { identity: { path: identityPath, ...file(identityPath) }, sourceBuild: { path: 'dist/execution/source-build.json', sha256: identity.sourceBuildSha256 }, installation: { path: install, ...installed } },
  generator: { path: 'scripts/fixtures/generate-v1-readonly-denial.mjs', ...file(fileURLToPath(import.meta.url)) },
  environment: { node: process.version, platform: process.platform, arch: process.arch, work },
  names: { run: initial.runId, session: initial.sessionId, decision: decisionId, snapshot: report.snapshotId },
  scenario: { initialStatus: initial.status, recoveredStatus: recovered.status, originalFact: 'completed-uncommitted', target, before, attempted, after: readFileSync(join(workspace, target), 'utf8'), targetSha256: file(join(workspace, target)).sha256, initialRequests: initialTransport.calls.length, recoveryRequests: continuation.calls.length },
  originalRecords, readonlyStart: started, denial: denied[0], finalRecordCount: finalRecords.length,
  originalFixture: { files: originalBefore.length, inventorySha256: sha256(JSON.stringify(originalBefore)), unchanged: true },
  files: inventory(output),
};
await writeFile(join(output, 'fixture-identity.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, work, runId: initial.runId, denied: denied[0], targetSha256: proof.scenario.targetSha256, originalRecordsRetained: originalRecords.length, files: proof.files.length }, null, 2));
