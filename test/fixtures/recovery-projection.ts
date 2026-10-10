import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, ToolTask, LiveDoc, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runReadTask, readRun } from '../../src/runtime.js';
import { scriptedTransport } from '../../src/offline.js';
import { acquireOwner } from '../../src/ownership.js';
import { Evidence } from '../../src/evidence.js';

export async function recoveryFixture(interrupted = false) {
  const root = await mkdtemp(join(tmpdir(), 'durio-target-projection-'));
  const workspace = join(root, 'project'), dataRoot = join(root, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'README.md'), 'Original retained fixture\n');
  const controller = new AbortController();
  const transport = interrupted ? async (_url: any, init: any) => new Promise<Response>((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(Error('offline interruption'))); controller.abort(); }) : scriptedTransport([]).fetch;
  const result = await runReadTask({ workspace, dataRoot, input: 'Controlled public Pi fixture', mode: 'offline', transport, ...(interrupted ? { signal: controller.signal, cancellation: 'exit' as const } : {}) });
  assert.equal(result.status, interrupted ? 'unknown' : 'completed');
  const conversationId = (await readRun(dataRoot, result.runId)).records.find(record => record.kind === 'run.started')!.data as any;
  return { root, workspace, dataRoot, result, conversationId: conversationId.conversationId, path: join(dataRoot, 'sessions', result.sessionId, 'durable.sqlite'), authorization: { workspace, mode: 'offline' as const, tools: ['read'] as const } };
}

/** Complete public-Storage crash fixture: real interrupted generation/agent/input; explicit new tool
 * records under that generation, immutable assistant identities, execute checkpoints, and dispatch facts.
 * No scheduler or external effect is executed while manufacturing the uncertain crash state. */
export async function uncertainTools(f: Awaited<ReturnType<typeof recoveryFixture>>, count: number) {
  const owner = await acquireOwner(f.dataRoot, () => {}), storage = await openNodeSqliteStorage(f.path), session = createSession(storage);
  const generation = (await storage.scanTasks({ kind: 'pi.generation' }, 1, undefined, context)).items[0];
  const ids: TaskId[] = [], assistant = await storage.mintId<EntryId>();
  const calls = Array.from({ length: count }, (_, i) => ({ type: 'toolCall' as const, id: `uncertain-${i}`, name: 'read', arguments: { path: 'README.md', note: i === count - 1 ? 'late-original-'.repeat(1000) : 'controlled' } }));
  await storage.commit([{ type: 'entry', value: { id: assistant, conversationId: f.conversationId, byTaskId: generation.id, kind: 'pi.assistant', model: [{ role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: calls }] } }], context);
  for (const call of calls) ids.push(await session.commit(tx => tx.createTask(ToolTask, { assistant, callId: call.id }, { ownership: { kind: 'task', taskId: generation.id }, conversationId: f.conversationId }), context));
  for (let i = 0; i < ids.length; i++) {
    const task = (await storage.task(ids[i], context))!;
    await storage.commit([{ type: 'task', value: { ...task, state: { status: 'pending', checkpoint: { phase: 'execute', arguments: calls[i].arguments, replay: 'unsafe' } } } }], context);
  }
  await storage.commit([{ type: 'task', value: { ...generation, state: { status: 'waiting', checkpoint: { phase: 'tools', assistant, tools: ids, pending: [] }, on: ids, policy: 'allSettled' } } }], context);
  await session.commit(async tx => { const live = await tx.doc(LiveDoc, f.conversationId); delete live.generation; live.tools = calls.map((call, i) => ({ callId: call.id, name: call.name, taskId: ids[i], status: 'pending' })); }, context);
  await session.close(context);
  const evidence = new Evidence(f.dataRoot, f.result.runId);
  try { for (const id of ids) evidence.append('tool.dispatch', { durableTaskId: id, attemptId: `fixture-${id}` }); } finally { evidence.close(); await owner.release(); }
  return ids;
}

