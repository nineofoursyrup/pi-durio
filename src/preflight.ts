import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, access, copyFile, chmod, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openHostReadonly, readObject, digest, type BlobRef } from './evidence.js';
import type { Cursor, TaskRecord, EntryRecord, SubmissionRecord, ConversationRecord, JsonObject, LiveState } from '@earendil-works/pi-durable';
import type { OwnerLease } from './ownership.js';
import { sessionRemovalVerified } from './storage-disposition.js';

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Caller holds the data-root owner and has no active source connection (before open or after confirmed close).
 * Copy a quiescent main+WAL pair, verify source/copy bytes, then touch ONLY the copy through SQLite/public storage.
 * This is not a live-backup API; active/uncertain writers must be blocked before calling it.
 */
export async function inspectSession(path: string, owner: OwnerLease) {
  owner.assertHeld();
  path = await realpath(path);
  const rel = relative(owner.path, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('INSPECTION_OUTSIDE_OWNER');
  const dir = await mkdtemp(join(tmpdir(), 'durio-inspect-'));
  const snapshot = join(dir, 'snapshot.sqlite');
  try {
    const parts = [path];
    try { await access(`${path}-wal`); parts.push(`${path}-wal`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const sourceFiles = [];
    for (const source of parts) {
      const sha256 = await hashFile(source);
      const destination = source === path ? snapshot : `${snapshot}-wal`;
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      if (await hashFile(destination) !== sha256 || await hashFile(source) !== sha256) throw new Error('RECOVERY_REQUIRED: source changed during quiescent snapshot');
      sourceFiles.push({ path: source, sha256 });
    }
    owner.assertHeld();
    const snapshotSha256 = await hashFile(snapshot);
    const storage = await openNodeSqliteStorage(snapshot);
    try {
      const pending: { kind: string; id: number; status: string }[] = [];
      const tasks: TaskRecord<any, any, any>[] = [];
      const submissions: SubmissionRecord[] = [];
      const entries: EntryRecord[] = [];
      const conversations: ConversationRecord[] = [];
      const agents: { conversationId: number; value: JsonObject }[] = [];
      const live: { conversationId: number; value: LiveState }[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const task of page.items) {
          tasks.push(task);
          if (task.state.status !== 'terminal') pending.push({ kind: task.kind, id: task.id, status: task.state.status });
        }
        cursor = page.next;
      } while (cursor);
      do {
        const page = await storage.scanSubmissions({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const item of page.items) {
          submissions.push(item);
          if (item.status === 'queued' || item.status === 'placed') pending.push({ kind: 'submission', id: item.id, status: item.status });
        }
        cursor = page.next;
      } while (cursor);
      const usage = [];
      do {
        const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
        for (const conversation of page.items) {
          conversations.push(conversation);
          let entryCursor: Cursor | undefined;
          do {
            const entriesPage = await storage.scanEntries({ conversationId: conversation.id }, 100, entryCursor, BACKGROUND_CONTEXT);
            entries.push(...entriesPage.items);
            entryCursor = entriesPage.next;
          } while (entryCursor);
          const agent = await storage.findDocument({ kind: 'pi.agent', scope: { kind: 'conversation', conversationId: conversation.id } }, 'current', BACKGROUND_CONTEXT);
          if (agent) {
            const content = await storage.document(agent.id, 'current', BACKGROUND_CONTEXT);
            if (content) agents.push({ conversationId: conversation.id, value: content.value });
          }
          const run = await storage.findDocument({ kind: 'pi.live', scope: {kind:'conversation',conversationId:conversation.id} },'current',BACKGROUND_CONTEXT);
          if (run) {const content=await storage.document(run.id,'current',BACKGROUND_CONTEXT);if(content)live.push({conversationId:conversation.id,value:content.value as LiveState});}
          const doc = await storage.findDocument({ kind: 'pi.usage', scope: { kind: 'conversation', conversationId: conversation.id } }, 'current', BACKGROUND_CONTEXT);
          if (doc) {
            const content = await storage.document(doc.id, 'current', BACKGROUND_CONTEXT);
            if (content) usage.push({ conversationId: conversation.id, documentId: doc.id, value: content.value });
          }
        }
        cursor = page.next;
      } while (cursor);
      // Recheck the complete pair, including WAL appearance/disappearance; never accept a changing source.
      const now = [path];
      try { await access(`${path}-wal`); now.push(`${path}-wal`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (JSON.stringify(now) !== JSON.stringify(parts)) throw new Error('RECOVERY_REQUIRED: source file set changed');
      for (const file of sourceFiles) if (await hashFile(file.path) !== file.sha256) throw new Error('RECOVERY_REQUIRED: source changed during inspection');
      owner.assertHeld();
      return { source: path, method: 'owner-fenced-quiescent-main-plus-wal-copy/public-storage-scan', snapshotSha256, sourceFiles, pending, usage, tasks, submissions, entries, conversations, agents, live };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function preflight(owner: OwnerLease) {
  const root = owner.path;
  owner.assertHeld();
  const reports: Awaited<ReturnType<typeof inspectSession>>[] = [];
  const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  let records: {seq:number;runId:string;kind:string;data:any}[] = [];
  try { await access(join(root,'host.sqlite')); }
  catch { if (sessions.length) throw new Error('RECOVERY_REQUIRED: missing host facts'); return reports; }
  const db = openHostReadonly(root);
  try { records = db.prepare('SELECT seq,run_id,kind,body FROM records ORDER BY seq').all().map(row => ({seq:Number(row.seq),runId:String(row.run_id),kind:String(row.kind),data:JSON.parse(readObject(root,JSON.parse(String(row.body)) as BlobRef).toString())})); }
  finally { db.close(); }
  const accepted = records.filter(record => record.kind === 'task.accepted');
  const resolved = new Set<string>();
  for (const dir of sessions) {
    if (!dir.isDirectory()) throw new Error('RECOVERY_REQUIRED: unexpected session storage alias');
    const path = join(root,'sessions',dir.name,'durable.sqlite');
    for (const marker of [join(root,'sessions',dir.name,'owner.json'),join(root,'sessions',`${dir.name}.lock`)]) {
      try { await access(marker); throw new Error('RECOVERY_REQUIRED: unresolved session owner'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const report = await inspectSession(path,owner);
    reports.push(report);
    const run = accepted.find(record => record.data.sessionId === dir.name);
    if (!run) throw new Error('RECOVERY_REQUIRED: session without host authorization identity');
    const history = records.filter(record => record.runId === run.runId);
    const ended = history.some(record => record.kind === 'recovery.ended' && record.data.sourceId === digest(JSON.stringify(report.sourceFiles)));
    if (ended) { resolved.add(run.runId); continue; }
    if (report.pending.length) throw new Error(`RECOVERY_REQUIRED: ${dir.name} has pending durable work`);
    const closed = history.findLast(record => record.kind === 'recovery.closed')?.data.result;
    const checked = history.findLast(record => record.kind === 'recovery.report')?.data;
    if (closed?.cleanup === 'confirmed' && closed.status !== 'unknown' || checked?.status === 'completed' && JSON.stringify(checked.session?.sourceFiles) === JSON.stringify(report.sourceFiles)) resolved.add(run.runId);
  }
  for (const record of records.filter(record => record.kind === 'run.started')) if (!sessions.some(dir => dir.name === record.data.sessionId)&&!sessionRemovalVerified(root,record.data.sessionId,records)) throw new Error('RECOVERY_REQUIRED: recorded session storage is missing or cleanup is incomplete');
  for(const start of records.filter(record=>record.kind==='compaction.started')){
    const history=records.filter(record=>record.runId===start.runId),closed=history.findLast(record=>record.kind==='compaction.closed'&&record.data.requestId===start.data.requestId)?.data.result;
    const snapshot=reports.find(report=>report.source===join(root,'sessions',start.data.source.sourceSessionId,'durable.sqlite'));
    const ended=snapshot&&history.some(record=>record.kind==='recovery.ended'&&record.data.sourceId===digest(JSON.stringify(snapshot.sourceFiles)));
    if(!ended&&(!closed||closed.cleanup!=='confirmed'||closed.status==='unknown'))throw Error('RECOVERY_REQUIRED: unresolved compaction close or cross-store gap');
  }
  for (const run of accepted) {
    if (resolved.has(run.runId)) continue;
    const receipt = records.findLast(record => record.runId === run.runId && record.kind === 'run.closed')?.data;
    if (!receipt) throw new Error('RECOVERY_REQUIRED: unconfirmed previous close or cross-store gap');
    if (receipt.cleanup !== 'confirmed' || receipt.status === 'unknown') throw new Error('RECOVERY_REQUIRED: unresolved original loss or termination');
  }
  return reports;
}
