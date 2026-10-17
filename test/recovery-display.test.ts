import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, readdir, readFile, lstat, realpath, rmdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { Evidence, digest, readQueue } from '../src/evidence.js';
import { ReadOnlyTui } from '../src/tui/app.js';
import { inspectRecoveryForDisplay, recoverRun } from '../src/runtime.js';
import { acquireOwner } from '../src/ownership.js';
import { preflight } from '../src/preflight.js';
import { Drafts } from '../src/tui/drafts.js';

// Small persisted public-storage fixture: no runtime artifact capture, model or tools.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-recovery-display-')));
  const workspace = join(root, 'project'), dataRoot = join(root, 'data');
  await mkdir(workspace);
  const runId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID();
  const path = join(dataRoot, 'sessions', sessionId, 'durable.sqlite');
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  const conversation = await harness.root(context);
  await conversation.commit(tx => tx.createSubmission({ type: 'input', status: 'queued', conversationId: conversation.id, requestId: taskId }), context);
  await harness.close(context);
  const evidence = new Evidence(dataRoot, runId), target = { workspace, runId, sessionId, taskId };
  evidence.append('task.accepted', { ...target, input: '展示恢复原件', mode: 'offline', authorization: { tools: ['read'] } });
  evidence.append('run.started', { sessionId, conversationId: conversation.id });
  evidence.append('run.closed', { status: 'unknown', cleanup: 'confirmed' });
  evidence.append('control.accepted', { requestId: 'unapplied', taskId: 'next-task', kind: 'follow-up', input: '必须仍待明确处置', target, executionVersion: { artifactId: 'fixture', artifactSeq: 0, configSeq: 0 }, authorization: { tools: ['read'] } });
  evidence.close();
  return { root, workspace, dataRoot, runId, sessionId, path };
}

async function originalState(root: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  async function visit(path: string) {
    const info = await lstat(path);
    rows.push([path, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.isDirectory() ? 'directory' : digest(await readFile(path))]);
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return rows;
}

class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  input: (value: string) => void = () => {}; resize: () => void = () => {};
  start(input: (value: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('display did not settle');
}

test('opening and rechecking recovery preserve original files, directories, pending controls and owner paths', async t => {
  const f = await fixture(), terminal = new TestTerminal();
  const app = new ReadOnlyTui({ ...f, draftRoot: join(f.root, 'drafts'), mode: 'offline', terminal, widthCalibration: false });
  const screen = () => app.screen().map(stripTerminalSequences).join('\n');
  const before = await originalState(f.dataRoot);
  try {
    app.start();
    await until(() => screen().includes('4  结束旧工作'));
    assert.deepEqual(await originalState(f.dataRoot), before, 'even temporary owner-marker creation/deletion changes original directory identity');
    assert.equal(readQueue(f.dataRoot).items[0].status, 'pending', 'display cannot write a frozen control receipt');
    const originalCopy = fs.copyFile;
    let entered = false, released!: () => void;
    const pause = new Promise<void>(resolve => { released = resolve; });
    const mock = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
      if (String(args[0]) === f.path) { entered = true; await pause; }
      return Reflect.apply(originalCopy, fs, args);
    }); syncBuiltinESMExports();
    try {
      terminal.input('\r');
      // Observe this inspection's loading state before accepting its returned panel.
      await until(() => entered && screen().includes('恢复核对中'));
      released();
      await until(() => !screen().includes('恢复核对中') && screen().includes('4  结束旧工作'));
    } finally { released(); mock.mock.restore(); syncBuiltinESMExports(); }
    // The next explicit inspection must also be purely observational.
    assert.deepEqual(await originalState(f.dataRoot), before);
    terminal.input('4');terminal.input('\r');
    assert.match(screen(),/╭/);assert.match(screen(),/╰/);
    assert.match(screen(),/◆ pi-durio/,'U12 confirmation remains centered over the visible session');
    terminal.input('\x1b');assert.doesNotMatch(screen(),/╭/);
    assert.deepEqual(await originalState(f.dataRoot),before,'opening a confirmation still grants no execution authority');
    const owner = await acquireOwner(f.dataRoot, () => {});
    try { await assert.rejects(preflight(owner), /RECOVERY_REQUIRED/, 'display cannot authorize an unrelated new task'); }
    finally { await owner.release(); }
    const authorization = { workspace:f.workspace, mode:'offline' as const, tools:['read'] as const };
    const report = await inspectRecoveryForDisplay({ ...f, authorization });
    const ended = await recoverRun({ ...f, authorization, decision:{ id:'explicit-end', action:'end', snapshotId:report.snapshotId } });
    assert.equal(ended.status,'ended','explicit decision rechecks under the real owner');
    assert.equal(readQueue(f.dataRoot).items[0].status,'frozen','T4 still freezes unapplied inputs at explicit disposition');
  } finally { await app.exit(); }
});

test('display refuses live and unidentified original locks without changing them', async () => {
  const f = await fixture(), owner = await acquireOwner(f.dataRoot, () => {});
  try {
    const before = await originalState(f.dataRoot);
    const report = await inspectRecoveryForDisplay(f);
    assert.equal(report.status, 'blocked'); assert.equal(report.ownerCleanup?.status,'running');
    assert.deepEqual(await originalState(f.dataRoot), before); owner.assertHeld();
  } finally { await owner.release(); }
  const lock = `${f.path.slice(0, -'/durable.sqlite'.length)}.lock`;
  await mkdir(lock);
  try {
    const before = await originalState(f.dataRoot), report = await inspectRecoveryForDisplay(f);
    assert.equal(report.status,'blocked'); assert.equal(report.ownerCleanup?.reason,'OWNER_IDENTITY_UNVERIFIED');
    assert.deepEqual(await originalState(f.dataRoot),before);
  } finally { await rmdir(lock); }
});

test('display rejects host/session changes and an owner appearing while the temporary copy is being read', async t => {
  for (const mutation of ['host', 'sessions', 'owner'] as const) await t.test(mutation, async t => {
    const f = await fixture(), originalCopy = fs.copyFile;
    let mutated = false, owner: Awaited<ReturnType<typeof acquireOwner>> | undefined;
    const mock = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
      await Reflect.apply(originalCopy, fs, args);
      if (String(args[0]) === f.path && !mutated) {
        mutated = true;
        if (mutation === 'host') { const evidence = new Evidence(f.dataRoot, f.runId); evidence.append('model.intent',{attemptId:'concurrent'}); evidence.close(); }
        if (mutation === 'sessions') await mkdir(join(f.dataRoot,'sessions',randomUUID()));
        if (mutation === 'owner') owner = await acquireOwner(f.dataRoot, () => {});
      }
    }); syncBuiltinESMExports();
    try {
      const report = await inspectRecoveryForDisplay(f);
      assert.equal(mutated, true);
      assert.equal(report.status, 'blocked');
      assert.ok(!report.options.includes('continue') && !report.options.includes('end'));
      if (mutation === 'host') assert.match(report.reasons.join(' '), /RECOVERY_SNAPSHOT_CHANGED/);
      if (mutation === 'owner') { assert.equal(report.ownerCleanup?.status, 'running'); owner!.assertHeld(); }
    } finally { mock.mock.restore(); syncBuiltinESMExports(); await owner?.release(); }
  });
});

test('slow initial checks and rechecks show loading only after 200ms and cannot reopen after Esc or a new view', async t => {
  for (const [entry, action] of [['initial','escape'],['recheck','escape'],['initial','help'],['recheck','history']] as const) await t.test(`${entry}/${action}`, async t => {
    const f = await fixture(), terminal = new TestTerminal(), draftRoot = join(f.root,'drafts');
    new Drafts(draftRoot,f.workspace,f.dataRoot).save('保留的恢复草稿');
    const app = new ReadOnlyTui({ ...f, runId:undefined, draftRoot, mode:'offline', terminal, widthCalibration:false });
    const screen = () => app.screen().map(stripTerminalSequences).join('\n');
    app.start();terminal.input('保留的恢复草稿');terminal.input('\x12');
    if (entry === 'recheck') { terminal.input('c'); await until(() => screen().includes('4  结束旧工作')); }
    const originalCopy = fs.copyFile;
    let entered = false, released!:()=>void;
    const pause = new Promise<void>(resolve=>{released=resolve;});
    const mock = t.mock.method(fs,'copyFile',async(...args:Parameters<typeof fs.copyFile>)=>{
      if(String(args[0])===f.path){entered=true;await pause;}
      return Reflect.apply(originalCopy,fs,args);
    });syncBuiltinESMExports();
    try {
      terminal.input(entry==='initial'?'c':'\r');
      assert.doesNotMatch(screen(),/恢复核对中/,'loading is not an immediate flash');
      await until(()=>entered); await new Promise(resolve=>setTimeout(resolve,230));
      assert.match(screen(),/恢复核对中/);
      if(action==='escape')terminal.input('\x1b');
      else terminal.input(action==='help'?'?':'\x12');
      const after=screen();
      assert.doesNotMatch(after,/恢复核对中/);
      if(action==='escape'){assert.match(after,/Enter 打开恢复核对/);assert.match(after,/草稿已保留/);}
      else assert.match(after,action==='help'?/帮助/:/历史/);
      released(); await new Promise(resolve=>setTimeout(resolve,100));
      const late=screen();
      assert.doesNotMatch(late,/4  结束旧工作|恢复核对中/,'a superseded result must not reclaim the session or view');
      if(action==='escape') {
        assert.match(late,/◈ 恢复核对/);
        terminal.input('/run must-not-submit\r');
        assert.equal(readQueue(f.dataRoot).items.length,1,'closing the panel does not enable submission');
      } else assert.match(late,action==='help'?/帮助/:/历史/);
      assert.equal(new Drafts(draftRoot,f.workspace,f.dataRoot).latest(),'保留的恢复草稿');
    } finally {released();mock.mock.restore();syncBuiltinESMExports();await app.exit();}
  });
});


test('an older failed check cannot clear a newer check or publish an obsolete error', async t => {
  const f=await fixture(),terminal=new TestTerminal();
  const app=new ReadOnlyTui({...f,draftRoot:join(f.root,'drafts'),mode:'offline',terminal,widthCalibration:false});
  const screen=()=>app.screen().map(stripTerminalSequences).join('\n');
  const copy=fs.copyFile;
  let entered=0,releaseOld!:()=>void,releaseNew!:()=>void;
  const oldWait=new Promise<void>(resolve=>{releaseOld=resolve;}),newWait=new Promise<void>(resolve=>{releaseNew=resolve;});
  const mock=t.mock.method(fs,'copyFile',async(...args:Parameters<typeof fs.copyFile>)=>{
    if(String(args[0])===f.path){const call=++entered;if(call===1){await oldWait;throw Error('obsolete-copy-failure');}if(call===2)await newWait;}
    return Reflect.apply(copy,fs,args);
  });syncBuiltinESMExports();
  try {
    app.start();await until(()=>entered===1);
    terminal.input('\x1b');terminal.input('\r');await until(()=>entered===2);
    await new Promise(resolve=>setTimeout(resolve,230));assert.match(screen(),/恢复核对中/);
    releaseOld();await new Promise(resolve=>setTimeout(resolve,80));
    assert.match(screen(),/恢复核对中/,'old finally cannot clear the current loading state');
    assert.doesNotMatch(screen(),/obsolete-copy-failure/);
    releaseNew();await until(()=>screen().includes('4  结束旧工作'));
    assert.doesNotMatch(screen(),/恢复核对中|obsolete-copy-failure/);
  } finally {releaseOld();releaseNew();mock.mock.restore();syncBuiltinESMExports();await app.exit();}
});


test('the display read boundary cannot replace verification and always releases after a verification failure', async () => {
  const f=await fixture();let entered=0,released=0;
  const report=await inspectRecoveryForDisplay({...f,beforeExecutionRead:async()=>{entered++;return()=>{released++;};}});
  assert.equal(entered,1);assert.equal(released,1);
  assert.equal(report.status,'blocked');assert.match(report.reasons.join(' '),/EXECUTION_CONTENT_UNAVAILABLE/);
  assert.ok(!report.options.includes('continue'),'a no-op scheduling callback cannot authorize missing execution material');
});
