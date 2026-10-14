import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Evidence, digest } from '../src/evidence.js';
import { Harness, createRegistry, GenerationTask } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { acquireOwner } from '../src/ownership.js';
import { preflight } from '../src/preflight.js';
import { records } from '../src/history.js';

const child = `
  import { preflight } from './dist/src/preflight.js';
  import { acquireOwner } from './dist/src/ownership.js';
  import { recoveryRecords } from './dist/src/recovery.js';
  const owner = await acquireOwner(process.argv[1], error => { throw error; });
  try {
    global.gc();
    const before = process.memoryUsage();
    const report = process.argv[2] === 'recovery'
      ? { count: recoveryRecords(process.argv[1], 'historical-output').length }
      : await preflight(owner);
    console.log(JSON.stringify({ report, before, after: process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS }));
  } finally { await owner.release(); }
`;

test('admission does not materialize unrelated historical output under a constrained heap', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-preflight-output-')));
  const evidence = new Evidence(root, 'historical-output');
  for (let index = 0; index < 1536; index++) evidence.append('tool.output', {
    toolCallId: 'historical', acquired: { index, offset: index * 16384, stream: 'stdout', encoding: 'base64', bytes: Buffer.alloc(16384, 97 + index % 26).toString('base64') },
  });
  evidence.close();
  const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=24', '--input-type=module', '-e', child, root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `Historical output is not admission state. ${result.signal}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).report.sessionCount, 0);
  const recovery = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=24', '--input-type=module', '-e', child, root, 'recovery'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(recovery.status, 0, `Recovery fact selection is also bounded. ${recovery.signal}\n${recovery.stderr}`);
  assert.equal(JSON.parse(recovery.stdout).report.count, 1536);
});

async function session(root: string, name: string, entries = 0) {
  const storagePath = join(root, 'sessions', name, 'durable.sqlite');
  const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models: createModels(), registry: createRegistry() }, context);
  const conversation = await harness.root(context);
  await conversation.commit(async tx => {
    for (let i = 0; i < entries; i++) {
      const entry = await tx.appendEntry(conversation.id, { kind: 'fixture.history', data: { original: 'x'.repeat(65536), i } });
      await tx.createSubmission({ type: 'write', status: 'done', conversationId: conversation.id, entry: entry.id, requestId: `closed-${i}` });
    }
  }, context);
  await harness.close(context);
  const evidence = new Evidence(root, name);
  evidence.append('task.accepted', { taskId: name, sessionId: name });
  evidence.append('run.started', { sessionId: name, conversationId: conversation.id });
  evidence.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  evidence.close();
  return { storagePath, conversationId: conversation.id };
}
async function admitted(root: string) {
  const owner = await acquireOwner(root, () => {});
  try { return await preflight(owner); } finally { await owner.release(); }
}

test('admission discards long transcripts across sessions and rejects a late pending submission or foreign task', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-preflight-sessions-')));
  // Four 8 MiB transcripts exceed the child heap if whole-session reports remain resident.
  for (let i = 0; i < 4; i++) await session(root, `session-${i}`, 128);
  const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=24', '--input-type=module', '-e', child, root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).report.sessionCount, 4);
  const path = join(root, 'sessions', 'session-3', 'durable.sqlite'), before = digest(await readFile(path));
  await admitted(root);
  assert.equal(digest(await readFile(path)), before, 'admission preserves the source database');
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const pending = await other.commit(tx => tx.createSubmission({ type: 'write', status: 'queued', conversationId: other.id, requestId: 'late-summary' }), context);
  await harness.close(context);
  await assert.rejects(admitted(root), /pending durable work/);
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  const foreign = await reopened.conversation(other.id, context);
  await foreign!.commit(async tx => {
    const entry = await tx.appendEntry(other.id, { kind: 'fixture.settled-summary' });
    tx.placeSubmission(pending.id, entry.id);
    for (let i = 0; i < 129; i++) await tx.createTask(GenerationTask, {}, { ownership: { kind: 'conversation' } });
  }, context);
  await reopened.close(context);
  // Public Storage writes create 128 terminal fixture tasks followed by one pending task.
  // No scheduler/model/tool is invoked to synthesize these independent admission states.
  const storage = await openNodeSqliteStorage(path);
  const tasks = await storage.scanTasks({}, 129, undefined, context);
  await storage.commit(tasks.items.slice(0, 128).map(task => ({ type: 'task' as const, value: { ...task, memos: undefined, state: { status: 'terminal' as const, outcome: { status: 'completed' as const, result: null } } } })), context);
  await storage.close(context);
  await assert.rejects(admitted(root), /pending durable work/);
});

test('missing or corrupt admission authority and close facts never become a successful admission', async () => {
  for (const kind of ['task.accepted', 'run.closed']) for (const fault of ['missing', 'corrupt']) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-preflight-facts-')));
    await session(root, 'closed');
    const ref = [...records(root, { kinds: [kind] })][0];
    const path = join(root, 'objects', ref.ref.sha256);
    if (fault === 'missing') await unlink(path); else await writeFile(path, 'tampered fact');
    await assert.rejects(admitted(root), /ENOENT|EVIDENCE_CORRUPT/);
  }
});
