import { mkdtemp, rm, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Storage, Cursor, ConversationId, JsonObject, TaskId } from '@earendil-works/pi-durable';
import { inspectSnapshot } from './preflight.js';
import type { OwnerLease } from './ownership.js';

/** Only the public read surface is available inside the fenced copy's lifetime. */
export type StorageReader = Pick<Storage, 'scanEntries' | 'scanTasks' | 'scanSubmissions' | 'scanConversations' | 'entry' | 'task' | 'submission' | 'submissionByRequest' | 'findDocument' | 'document'>;
export async function withProjectionIndex<T>(use: (index: DatabaseSync) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'durio-projection-'));
  let index: DatabaseSync | undefined;
  try {
    index = new DatabaseSync(join(dir, 'index.sqlite'));
    index.exec('PRAGMA cache_size=-1024; PRAGMA temp_store=FILE;');
    return await use(index);
  } finally { try { index?.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
}
/** Deterministic directory traversal without a history-sized name array. */
export async function forEachDirectory(path: string, visit: (entry: { name: string; isDirectory: boolean }) => Promise<void>) {
  await withProjectionIndex(async index => {
    index.exec('CREATE TABLE entries(name TEXT PRIMARY KEY, directory INTEGER NOT NULL)');
    const directory = await opendir(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (directory) for await (const entry of directory) index.prepare('INSERT INTO entries VALUES(?,?)').run(entry.name, Number(entry.isDirectory()));
    for (const row of index.prepare('SELECT name,directory FROM entries ORDER BY name').iterate()) await visit({ name: String(row.name), isDirectory: !!row.directory });
  });
}
export async function* scanTasks(storage: StorageReader) {
  let cursor: Cursor | undefined;
  do { const page = await storage.scanTasks({}, 32, cursor, context); yield* page.items; cursor = page.next; } while (cursor);
}
export async function* scanSubmissions(storage: StorageReader) {
  let cursor: Cursor | undefined;
  do { const page = await storage.scanSubmissions({}, 32, cursor, context); yield* page.items; cursor = page.next; } while (cursor);
}
export async function* scanConversations(storage: StorageReader) {
  let cursor: Cursor | undefined;
  do { const page = await storage.scanConversations({}, 32, cursor, context); yield* page.items; cursor = page.next; } while (cursor);
}
export async function conversationDocument(storage: StorageReader, conversationId: ConversationId, kind: string) {
  const doc = await storage.findDocument({ kind, scope: { kind: 'conversation', conversationId } }, 'current', context);
  const content = doc && await storage.document(doc.id, 'current', context);
  return content ? { conversationId, documentId: doc!.id, value: content.value } : undefined;
}
async function stateCounts(storage: StorageReader) {
  let taskCount = 0, submissionCount = 0, pendingCount = 0;
  const pending: { kind: string; id: number; status: string }[] = [];
  const add = (kind: string, id: number, status: string) => { pendingCount++; if (pending.length < 32) pending.push({ kind, id, status }); };
  for await (const task of scanTasks(storage)) { taskCount++; if (task.state.status !== 'terminal') add(task.kind, task.id, task.state.status); }
  for await (const submission of scanSubmissions(storage)) { submissionCount++; if (['queued', 'placed'].includes(submission.status)) add('submission', submission.id, submission.status); }
  return { taskCount, submissionCount, pendingCount, pending };
}
/** Management plans already have explicit finite limits. Exceeding the projection limit fails closed. */
export async function inspectStorageState(path: string, owner: OwnerLease, options: { conversationLimit?: number; failOnLimit?: boolean } = {}) {
  return inspectSnapshot(path, owner, async storage => {
    const counts = await stateCounts(storage), conversations: number[] = [];
    let conversationCount = 0; const identity = createHash('sha256');
    for await (const conversation of scanConversations(storage)) {
      conversationCount++; identity.update(`${conversation.id}\n`);
      if (conversations.length < (options.conversationLimit ?? 50000)) conversations.push(conversation.id);
      else if (options.failOnLimit !== false) throw Error('STORAGE_CONVERSATION_LIMIT');
      // Management's readability/protection check still validates every retained entry and the
      // same document families as the former inspector; only their accumulation is removed.
      let cursor: Cursor | undefined;
      do { const page = await storage.scanEntries({ conversationId: conversation.id }, 8, cursor, context); cursor = page.next; } while (cursor);
      for (const kind of ['pi.agent', 'pi.live', 'pi.usage']) await conversationDocument(storage, conversation.id, kind);
    }
    return { ...counts, conversations, conversationCount, conversationIdSha256: identity.digest('hex') };
  });
}
/** Each receipt is a projection with durable source identities, never another copy of transcript originals.
 * Spool all usage documents, then publish only after the final source fence succeeds. The first document
 * still supplies runtime's session usage; every document retains queryUsage's attribution/dedup semantics.
 */
export async function inspectClosedSession(path: string, owner: OwnerLease, receipt: (value: unknown) => void) {
  return withProjectionIndex(async index => {
    index.exec('CREATE TABLE usage(ordinal INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const snapshot = await inspectSnapshot(path, owner, async storage => {
      const counts = await stateCounts(storage);
      let conversationCount = 0, usageCount = 0;
      for await (const conversation of scanConversations(storage)) {
        conversationCount++;
        const usage = await conversationDocument(storage, conversation.id, 'pi.usage');
        if (usage) index.prepare('INSERT INTO usage VALUES(?,?)').run(usageCount++, JSON.stringify(usage));
      }
      return { ...counts, conversationCount, usageCount, projection: 'state-counts-and-usage-documents/v1' };
    });
    let firstUsage: JsonObject | undefined;
    for (const row of index.prepare('SELECT body FROM usage ORDER BY ordinal').iterate()) {
      const usage = JSON.parse(String(row.body)); firstUsage ??= usage.value;
      receipt({ ...snapshot, usage: [usage] });
    }
    receipt({ ...snapshot, usage: [] });
    return { ...snapshot, firstUsage };
  });
}
export async function inspectCompaction(path: string, owner: OwnerLease, taskId?: number) {
  return inspectSnapshot(path, owner, async storage => {
    const task = taskId === undefined ? undefined : await storage.task(taskId as TaskId, context);
    const outcome = task?.state.status === 'terminal' ? task.state.outcome : undefined;
    const result = outcome?.status === 'completed' ? outcome.result as any : undefined;
    const summary = result?.submissionId === undefined ? undefined : await storage.submission(result.submissionId, context);
    return { outcome, result, summary };
  });
}
