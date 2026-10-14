import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, GenerationTask, ToolTask, UsageDoc, type EntryId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runCodingTask, inspectRecovery, readRecoveryDetail, recoverRun } from '../src/runtime.js';
import { scriptedTransport } from '../src/offline.js';
import { acquireOwner } from '../src/ownership.js';
import { Evidence, digest } from '../src/evidence.js';
import { inspectClosedSession } from '../src/storage-projection.js';
import { queryUsage } from '../src/usage-query.js';
import { recoveryFixture as fixture, uncertainTools } from './fixtures/recovery-projection.js';
import { records, decode } from '../src/history.js';

test('a genuine completed target session with 64 MiB originals is inspected under a 48 MiB heap without loading transcript history', async t => {
  const f = await fixture();
  const owner = await acquireOwner(f.dataRoot, () => {});
  const session = createSession(await openNodeSqliteStorage(f.path));
  // Real admission/submission/agent/usage/version came from the offline run. Extra originals use only public Session commits.
  for (let i = 0; i < 1024; i++) await session.commit(tx => tx.appendEntry(f.conversationId, { kind: 'fixture.retained-original', data: { ordinal: i, original: 'x'.repeat(65536) } }), context);
  await session.close(context); await owner.release();
  const before = digest(await readFile(f.path));
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', `import {inspectRecovery} from './dist/src/recovery.js';const r=await inspectRecovery(${JSON.stringify({ dataRoot: f.dataRoot, runId: f.result.runId })});console.log(JSON.stringify(r));process.exit(r.status==='completed'?0:1);`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `${child.signal}: ${child.stderr}`);
  const report = JSON.parse(child.stdout);
  assert.equal(report.session.pendingCount, 0); assert.equal(report.session.submissionCount, 1);
  assert.ok(child.stdout.length < 10000); assert.equal(digest(await readFile(f.path)), before);
  t.diagnostic(JSON.stringify({fixture:{dataRoot:f.dataRoot,runId:f.result.runId,sessionId:f.result.sessionId,sourceSha256:before,retainedOriginalBytes:67108864},heapMiB:48,reportBytes:Buffer.byteLength(child.stdout)}));
});

test('ordinary confirmed close keeps a bounded receipt beyond the old 2 MiB snapshot seam without changing acquired output or usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'durio-close-projection-')), workspace = join(root, 'project'), dataRoot = join(root, 'data'); await mkdir(workspace);
  const answer = 'x'.repeat(1100000); let calls = 0;
  const transport: typeof fetch = async () => {
    const delta = ++calls === 1 ? { tool_calls: [{ index: 0, id: 'large-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'large.txt', content: answer }) } }] } : { content: answer };
    const frame = (choices: unknown[], usage?: unknown) => ({ id: 'large-offline', model: 'deepseek-flash', choices, ...(usage ? { usage } : {}) });
    const frames = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }]), frame([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await runCodingTask({ workspace, dataRoot, input: 'Controlled large response', mode: 'offline', transport });
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.cleanup, 'confirmed'); assert.equal(result.answer?.length, answer.length); assert.equal(digest(result.answer!), digest(answer));
  assert.equal(calls, 2); assert.equal(result.usage.value!.models['deepseek/deepseek-flash'].input, 20);
  const receipts = [...records(dataRoot, { runId: result.runId, kinds: ['durable.closed-snapshot'] })].map(ref => decode(dataRoot, ref));
  assert.ok(receipts.length >= 1); assert.ok(receipts.every(receipt => Buffer.byteLength(JSON.stringify(receipt)) < 10000));
  const durable = await openNodeSqliteStorage(join(dataRoot, 'sessions', result.sessionId, 'durable.sqlite'));
  let bytes = 0, cursor;
  do { const page = await durable.scanEntries({ conversationId: 1 as any }, 8, cursor, context); for (const entry of page.items) bytes += Buffer.byteLength(JSON.stringify(entry)); cursor = page.next; } while (cursor);
  await durable.close(context); assert.ok(bytes > 2 * 1024 * 1024, `retained original bytes: ${bytes}`);
  t.diagnostic(JSON.stringify({fixture:{dataRoot,runId:result.runId,sessionId:result.sessionId,originalEntryBytes:bytes,answerSha256:digest(answer)},receiptBytes:receipts.map(receipt=>Buffer.byteLength(JSON.stringify(receipt))),inputTokens:result.usage.value!.models['deepseek/deepseek-flash'].input}));
});

test('all public usage documents survive a projected close, retaining the first document and query attribution without duplicate totals', async () => {
  const f = await fixture(), owner = await acquireOwner(f.dataRoot, () => {});
  const session = createSession(await openNodeSqliteStorage(f.path));
  const second = await session.commit(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    const usage = await tx.doc(UsageDoc, conversation.id);
    usage.models['deepseek/deepseek-flash'] = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return conversation.id;
  }, context);
  await session.close(context);
  const evidence = new Evidence(f.dataRoot, f.result.runId);
  try {
    const projected = await inspectClosedSession(f.path, owner, receipt => evidence.append('durable.closed-snapshot', receipt));
    assert.equal((projected.firstUsage as any).models['deepseek/deepseek-flash'].input, 10);
    assert.equal(projected.usageCount, 2);
    evidence.append('run.closed', f.result);
    const first = queryUsage(f.dataRoot, [f.result.runId]);
    await inspectClosedSession(f.path, owner, receipt => evidence.append('durable.closed-snapshot', receipt)); evidence.append('run.closed', f.result);
    const next = queryUsage(f.dataRoot, [f.result.runId]);
    assert.equal(next.items.length, 2); assert.ok(next.items.some(doc => doc.conversationId === second));
    assert.deepEqual(next.totals, first.totals);
    assert.equal(next.items.reduce((sum, doc) => sum + doc.value.models['deepseek/deepseek-flash'].input, 0), 17);
    assert.ok(next.items.every(doc => doc.completeness === 'known'));
  } finally { evidence.close(); await owner.release(); }
});

test('paged unknown tools retain complete decision coverage, original navigation and stale snapshot rejection', async () => {
  const f = await fixture(true), ids = await uncertainTools(f, 40), options = { dataRoot: f.dataRoot, runId: f.result.runId, authorization: f.authorization };
  const first = await inspectRecovery(options); assert.equal(first.status, 'needs-decision', JSON.stringify(first));
  assert.equal(first.tools.length, 32); assert.equal(first.details!.tools.count, 40); assert.equal(first.details!.unresolvedTools, 40);
  const second = await inspectRecovery({ ...options, page: { offset: 32, snapshotId: first.snapshotId } });
  assert.equal(second.snapshotId, first.snapshotId); assert.equal(second.tools.length, 8); assert.equal(second.tools.at(-1)!.taskId, ids.at(-1));
  const authorizationFile=join(f.root,'authorization.json');await import('node:fs/promises').then(fs=>fs.writeFile(authorizationFile,JSON.stringify(f.authorization)));
  const cli=spawnSync(process.execPath,['dist/src/cli.js','recover','--inspect','--run',f.result.runId,'--data-root',f.dataRoot,'--authorization',authorizationFile,'--after','32','--snapshot',first.snapshotId],{encoding:'utf8',timeout:30000});
  assert.equal(cli.status,75,cli.stderr);assert.equal(JSON.parse(cli.stdout).tools.length,8);assert.equal(JSON.parse(cli.stdout).snapshotId,first.snapshotId);
  const detail = await readRecoveryDetail({ ...options, snapshotId: first.snapshotId, entryId: second.tools.at(-1)!.assistantEntryId!, limit: 100 });
  assert.equal(detail.text.length, 100); assert.equal(detail.next, 100);
  const later = await readRecoveryDetail({ ...options, snapshotId: first.snapshotId, entryId: detail.entryId!, offset: detail.next!, limit: 4096 });
  assert.equal(later.sha256, detail.sha256);
  const taskDetail = await readRecoveryDetail({...options,snapshotId:first.snapshotId,taskId:ids.at(-1)!,limit:4096});
  assert.match(taskDetail.text,/late-original-/); assert.equal((second.tools.at(-1)!.args as any).reference.taskId,ids.at(-1));
  const transport = scriptedTransport([]);
  const resolutions = first.tools.map(tool => ({ taskId: tool.taskId, choice: 'skip' as const, reason: 'Controlled decision for visible page' }));
  const denied = await recoverRun({ ...options, decision: { id: 'only-visible', snapshotId: first.snapshotId, action: 'continue', acceptAdditionalModelAttempts: true, resolutions }, transport: transport.fetch });
  assert.equal(denied.status, 'needs-decision'); assert.ok('reasons' in denied && denied.reasons.some(reason => reason.includes('8 unresolved'))); assert.equal(transport.calls.length, 0);
  await assert.rejects(inspectRecovery({ ...options, page: { offset: 32, snapshotId: 'stale' } }), /STALE_RECOVERY_SNAPSHOT/);
  const owner = await acquireOwner(f.dataRoot, () => {}), evidence = new Evidence(f.dataRoot, f.result.runId);
  evidence.append('run.abort-intent', { action: 'stop' }); evidence.close(); await owner.release();
  await assert.rejects(readRecoveryDetail({ ...options, snapshotId: first.snapshotId, entryId: detail.entryId }), /STALE_RECOVERY_SNAPSHOT/);
  const stopped = await inspectRecovery(options); assert.equal(stopped.status, 'blocked'); assert.ok(stopped.reasons.some(reason => reason.includes('STOP_INTENT_PRESERVED')));
});

test('late-page foreign submissions/tasks and missing assistant or outcome block both continuation and ending', async () => {
  const f = await fixture(true); await uncertainTools(f, 40);
  const owner = await acquireOwner(f.dataRoot, () => {}), storage = await openNodeSqliteStorage(f.path), session = createSession(storage);
  await session.commit(async tx => {
    for (let i = 0; i < 40; i++) { const entry = await tx.appendEntry(f.conversationId, { kind: 'fixture.settled' }); await tx.createSubmission({ type: 'write', status: 'done', conversationId: f.conversationId, requestId: `settled-${i}`, entry: entry.id }); }
    const foreign = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await tx.createTask(GenerationTask, {}, { ownership: { kind: 'conversation' }, conversationId: foreign.id });
    await tx.createSubmission({ type: 'input', status: 'queued', conversationId: foreign.id, requestId: 'foreign-late' });
    for(let i=0;i<40;i++)await tx.createTask(ToolTask, { assistant: 999999 as EntryId, callId: `missing-${i}` }, { ownership: { kind: 'conversation' }, conversationId: foreign.id });
    const corrupt=await tx.appendEntry(foreign.id,{kind:'pi.assistant',model:[{role:'user',content:'wrong assistant shape',timestamp:1}]});
    await tx.createTask(ToolTask,{assistant:corrupt.id,callId:'corrupt'},{ownership:{kind:'conversation'},conversationId:foreign.id});
  }, context);
  const tool = (await storage.scanTasks({ kind: 'pi.tool' }, 1, undefined, context)).items[0];
  await storage.commit([{ type: 'task', value: { ...tool, memos: undefined, state: { status: 'terminal', outcome: { status: 'completed', result: { entryId: 999998 } } } } }], context);
  const corruptOutcome=await session.commit(tx=>tx.appendEntry(f.conversationId,{kind:'pi.tool-result',model:[{role:'user',content:'wrong result shape',timestamp:1}]}),context);
  const secondTool=(await storage.scanTasks({kind:'pi.tool'},2,undefined,context)).items[1];
  await storage.commit([{type:'task',value:{...secondTool,memos:undefined,state:{status:'terminal',outcome:{status:'completed',result:{entryId:corruptOutcome.id}}}}}],context);
  await session.close(context); await owner.release();
  const options = { dataRoot: f.dataRoot, runId: f.result.runId, authorization: f.authorization }, report = await inspectRecovery(options);
  assert.equal(report.status, 'blocked'); assert.ok(report.details!.reasons.count > 32); assert.equal(report.reasons.length,32);
  assert.deepEqual(report.options,['inspect','external-verification']);
  const later=await inspectRecovery({...options,page:{offset:32,snapshotId:report.snapshotId}});
  assert.ok(later.reasons.includes('OTHER_PENDING_SUBMISSION')); assert.ok(later.reasons.includes('OTHER_PENDING_TASK_OR_UNSUPPORTED_DEFINITION'));
  assert.ok(report.reasons.some(reason => reason.startsWith('DURABLE_TOOL_IDENTITY_MISSING'))); assert.ok(report.reasons.some(reason => reason.startsWith('DURABLE_TOOL_OUTCOME_MISSING')));
  const transport = scriptedTransport([]);
  for (const action of ['continue', 'end'] as const) { const refused = await recoverRun({ ...options, decision: { id: `foreign-${action}`, snapshotId: report.snapshotId, action, acceptAdditionalModelAttempts: true }, transport: transport.fetch }); assert.equal(refused.status, 'blocked'); }
  assert.equal(transport.calls.length, 0);
});
