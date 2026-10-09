import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Harness, createRegistry, GenerationTask } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Evidence, digest, readRun } from '../src/evidence.js';
import { records, readEvidence, decode } from '../src/history.js';
import { fixEvidence, unfixEvidence, verifyFixed } from '../src/fixed-evidence.js';
import { acquireOwner } from '../src/ownership.js';
import { preflight } from '../src/preflight.js';
import { previewCleanup, commitCleanup, readCleanup, storageUsage, archiveStorage, restoreArchive, migrateStorage, verifyArchive } from '../src/storage.js';
import { treeFiles, exists } from '../src/storage-files.js';
import { StorageView } from '../src/tui/storage.js';

async function fixture(name='a') {
  const base=await realpath(await mkdtemp(join(tmpdir(),'durio-storage-'))),root=join(base,'data');await mkdir(root);
  const owner=await acquireOwner(root,()=>{}),sessionId=`session-${name}`;
  const harness=await Harness.open(await openNodeSqliteStorage(join(root,'sessions',sessionId,'durable.sqlite')),{models:createModels(),registry:createRegistry()},context);
  const conversation=await harness.root(context);await harness.close(context);await owner.release();
  const evidence=new Evidence(root,name);evidence.append('task.accepted',{taskId:`task-${name}`,sessionId,workspace:join(base,'project'),input:'own fixture'});
  evidence.append('run.started',{sessionId,conversationId:conversation.id});
  const payload=evidence.blob('sensitive original fixture output\n'.repeat(2000));const second=evidence.blob('independent second attachment');
  evidence.append('check.result',{payload,exitCode:7});evidence.append('check.result',{payload:second,exitCode:0});evidence.append('run.closed',{status:'failed',cleanup:'confirmed',reason:'fixture failed check',usage:{completeness:'unknown'}});evidence.close();
  const source=[...records(root,{kinds:['check.result']})][0];return {base,root,sessionId,runId:name,payload,second,source};
}
async function admitted(root:string){const owner=await acquireOwner(root,()=>{});try{return await preflight(owner);}finally{await owner.release();}}
const preview=(root:string,id:string,units:string[])=>previewCleanup(root,{id,units,reason:'explicit own fixture cleanup'});

test('fixed dependency closure blocks cleanup; explicit release is idempotent and other fixation still protects shared objects',async()=>{
  const f=await fixture(),one=await fixEvidence(f.root,{id:'one',sources:[f.source.id],purpose:'fixture'}),two=await fixEvidence(f.root,{id:'two',sources:[f.source.id],purpose:'fixture'});
  const blocked=await preview(f.root,'protected',[`session:${f.sessionId}`,`object:${f.payload.sha256}`]);assert.equal(blocked.plan.units.length,0);assert.equal(blocked.plan.blocked.length,2);
  const release={id:'release-one',fixedEvidenceId:one.source,reason:'explicit fixture release'};
  await unfixEvidence(f.root,release);assert.equal((await unfixEvidence(f.root,release)).repeated,true);assert.equal(verifyFixed(f.root,one.source).state,'released');assert.equal(verifyFixed(f.root,two.source).state,'protected');
  await assert.rejects(fixEvidence(f.root,{id:'one',sources:[f.source.id],purpose:'fixture'}),/RELEASED/);
  assert.equal((await preview(f.root,'still-fixed',[`object:${f.payload.sha256}`])).plan.units.length,0);
  await unfixEvidence(f.root,{id:'release-two',fixedEvidenceId:two.source,reason:'explicit release'});
  assert.equal((await preview(f.root,'manifest-retained',[`object:${one.manifest.sha256}`])).plan.units.length,0);
  const allowed=await preview(f.root,'released',[`object:${f.payload.sha256}`]);assert.equal(allowed.plan.bytes,f.payload.bytes);
  assert.equal((await commitCleanup(f.root,{id:'released',identity:allowed.identity})).status,'completed');
  assert.equal(readEvidence(f.root,f.source.id).state,'cleaned');assert.equal(((await readRun(f.root,f.runId)).result as {status:string}).status,'failed');
  const deletionFacts=[...records(f.root)].filter(r=>r.kind.startsWith('management.')).map(r=>decode(f.root,r));assert.doesNotMatch(JSON.stringify(deletionFacts),/sensitive original fixture output/);
});

test('preview is immutable and explicit commit cannot expand scope or ignore later fixed protection',async()=>{
  const f=await fixture(),p=await preview(f.root,'p',[`object:${f.payload.sha256}`]);assert.equal(await exists(join(f.root,'objects',f.payload.sha256)),true);
  await assert.rejects(commitCleanup(f.root,{id:'p',identity:'no'}),/STALE/);
  await assert.rejects(preview(f.root,'p',[`object:${f.second.sha256}`]),/CONFLICT/);
  await fixEvidence(f.root,{id:'later',sources:[f.source.id],purpose:'fixed after preview'});
  await assert.rejects(commitCleanup(f.root,{id:'p',identity:p.identity}),/PROTECTED/);assert.equal(await exists(join(f.root,'objects',f.payload.sha256)),true);
});

test('whole-session removal preserves facts and permits a later new task only with complete matching removal evidence',async()=>{
  const f=await fixture(),p=await preview(f.root,'session',[`session:${f.sessionId}`]);assert.equal(p.plan.units.length,1);assert.ok(p.plan.units[0].inspection!.conversations.length);
  const originalBody=await readFile(join(f.root,'objects',f.source.ref.sha256));
  const done=await commitCleanup(f.root,{id:'session',identity:p.identity});assert.equal(done.status,'completed');assert.equal(await exists(join(f.root,'sessions',f.sessionId)),false);assert.deepEqual(await admitted(f.root),[]);
  assert.deepEqual(await readFile(join(f.root,'objects',f.source.ref.sha256)),originalBody);assert.equal(readEvidence(f.root,f.source.id).state,'complete');
  assert.equal((await commitCleanup(f.root,{id:'session',identity:p.identity})).status,'completed');
  const e=new Evidence(f.root,f.runId);e.append('control.accepted',{requestId:'late',kind:'compact',input:'compact',target:{workspace:'/fixture',sessionId:f.sessionId,taskId:'task-a',runId:f.runId}});e.close();
  await assert.rejects(admitted(f.root),/missing|incomplete/);
});

test('frozen host request and pending summary in another conversation each protect the whole shared session and its attachments',async()=>{
  const f=await fixture(),e=new Evidence(f.root,f.runId);e.append('control.accepted',{requestId:'q',kind:'compact',target:{workspace:'/fixture',sessionId:f.sessionId,taskId:'task-a',runId:f.runId},input:'compact'});e.append('control.receipt',{requestId:'q',status:'frozen',reason:'stop'});e.close();
  const protectedPlan=await preview(f.root,'queued',[`session:${f.sessionId}`,`object:${f.payload.sha256}`]);assert.equal(protectedPlan.plan.units.length,0);assert.match(JSON.stringify(protectedPlan.plan.blocked),/queue:frozen/);
  const g=await fixture('other'),owner=await acquireOwner(g.root,()=>{});
  const h=await Harness.open(await openNodeSqliteStorage(join(g.root,'sessions',g.sessionId,'durable.sqlite')),{models:createModels(),registry:createRegistry()},context);
  const other=await h.createConversation({ownership:{kind:'ownerless'}},context);
  await other.commit(async tx=>{await tx.createTask(GenerationTask,{},{ownership:{kind:'conversation'}});await tx.createSubmission({type:'write',status:'queued',conversationId:other.id,requestId:'summary'});},context);
  await h.close(context);await owner.release();const pending=await preview(g.root,'pending',[`session:${g.sessionId}`,`object:${g.payload.sha256}`]);assert.equal(pending.plan.units.length,0);assert.match(JSON.stringify(pending.plan.blocked),/durable-pending/);
});

test('partial cleanup preserves every part and resumes same operation after delete-before-receipt and disk faults',async()=>{
  const f=await fixture(),p=await preview(f.root,'partial',[`object:${f.payload.sha256}`,`object:${f.second.sha256}`]);let fired=false;
  const failed=await commitCleanup(f.root,{id:'partial',identity:p.identity},{fault:point=>{if(point==='after-delete'&&!fired){fired=true;throw Object.assign(Error('disk full'),{code:'ENOSPC'});}}});
  assert.equal(failed.status,'partial');assert.equal(failed.parts[0].status,'failed');assert.equal(failed.parts[1].status,'not-run');assert.equal(await exists(join(f.root,'objects',f.second.sha256)),true);
  const done=await commitCleanup(f.root,{id:'partial',identity:p.identity});assert.equal(done.status,'completed');assert.equal(done.plan.bytes,f.payload.bytes+f.second.bytes);
  assert.equal(readEvidence(f.root,f.source.id).state,'cleaned');assert.match(JSON.stringify([...records(f.root,{kinds:['management.file-result']})].map(r=>decode(f.root,r))),/absent-after-recorded-intent/);
  const g=await fixture(),session=await preview(g.root,'interrupted-session',[`session:${g.sessionId}`]);
  const stopped=await commitCleanup(g.root,{id:'interrupted-session',identity:session.identity},{fault:point=>{if(point==='after-stage')throw Error('simulated interrupt');}});assert.equal(stopped.status,'partial');await assert.rejects(admitted(g.root),/missing|incomplete/);
  assert.equal((await commitCleanup(g.root,{id:'interrupted-session',identity:session.identity})).status,'completed');assert.deepEqual(await admitted(g.root),[]);
});

test('lossless whole-root and attachment archives verify actual restore and preserve source identities',async()=>{
  const f=await fixture(),before=await treeFiles(f.root),archive=await archiveStorage(f.root,{destination:join(f.base,'archive'),scope:'whole-root'});
  assert.equal(archive.verified,true);assert.equal(archive.sourceRetained,true);assert.equal(archive.files,before.length);
  const restored=await restoreArchive(archive.archive,join(f.base,'restored'));assert.equal(restored.scope,'whole-root');assert.deepEqual(await treeFiles(restored.destination),before);
  assert.equal(((await readRun(restored.destination,f.runId)).result as {status:string}).status,'failed');assert.equal((await verifyArchive(archive.archive)).identity,archive.identity);
  await assert.rejects(restoreArchive(archive.archive,restored.destination),/DESTINATION_EXISTS/);
  const attachment=await archiveStorage(f.root,{destination:join(f.base,'attachment'),scope:'attachments',objects:[f.payload.sha256]});
  const objectRestore=await restoreArchive(attachment.archive,join(f.base,'object-restore'));assert.deepEqual(await readFile(join(objectRestore.destination,'objects',f.payload.sha256)),await readFile(join(f.root,'objects',f.payload.sha256)));
  assert.equal((await storageUsage(f.root)).retention.includes('No automatic'),true);
});

test('migration includes a nonempty committed WAL and unknown format or disk failure retains the source',async()=>{
  const f=await fixture(),dbPath=join(f.root,'sessions',f.sessionId,'durable.sqlite');
  // A fixture child exits after a public durable commit, leaving a quiescent WAL to capture.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import{Harness,createRegistry}from'@earendil-works/pi-durable';import{createModels}from'@earendil-works/pi-ai';import{BACKGROUND_CONTEXT as c}from'@earendil-works/chord/context';import{openNodeSqliteStorage}from'@earendil-works/pi-durable/storage/sqlite/node';const h=await Harness.open(await openNodeSqliteStorage(process.argv[1]),{models:createModels(),registry:createRegistry()},c);await h.createConversation({ownership:{kind:'ownerless'}},c);process.exit(0);`,dbPath],{cwd:resolve('.'),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const wal=await readFile(`${dbPath}-wal`);assert.ok(wal.length>0);const original=await treeFiles(f.root,{exclude:path=>path.endsWith('-shm')});
  const moved=await migrateStorage(f.root,{backup:join(f.base,'backup'),destination:join(f.base,'migrated')});assert.equal(moved.executionAuthorized,false);assert.deepEqual(await readFile(join(moved.destination,'sessions',f.sessionId,'durable.sqlite-wal')),wal);assert.deepEqual(await treeFiles(moved.destination,{exclude:p=>p.endsWith('-shm')}),original);
  assert.ok('sessions'in moved.readable&&moved.readable.sessions[0].conversations.length>=2);
  const before=await readFile(dbPath);await assert.rejects(archiveStorage(f.root,{destination:join(f.base,'disk-failure'),scope:'whole-root'},{fault:point=>{if(point==='before-archive')throw Object.assign(Error('full'),{code:'ENOSPC'});}}),/full/);assert.deepEqual(await readFile(dbPath),before);
  const g=await fixture('unknown');await writeFile(join(g.root,'sessions',g.sessionId,'durable.sqlite'),'unsupported fixture');const unknownBefore=await treeFiles(g.root);
  await assert.rejects(migrateStorage(g.root,{backup:join(g.base,'unknown-backup'),destination:join(g.base,'unknown-migration')}));assert.deepEqual(await treeFiles(g.root),unknownBefore);assert.equal(await exists(join(g.base,'unknown-migration')),false);assert.equal(((await readRun(g.root,g.runId)).result as {status:string}).status,'failed');
});

test('broken fixed manifest, unknown host format, active ownership and alias never become empty protection',async()=>{
  const f=await fixture(),fixed=await fixEvidence(f.root,{id:'fixed',sources:[f.source.id],purpose:'fixture'});await writeFile(join(f.root,'objects',fixed.manifest.sha256),'broken');
  await assert.rejects(preview(f.root,'bad',[`object:${f.payload.sha256}`]),/CORRUPT/);
  const g=await fixture(),owner=await acquireOwner(g.root,()=>{});await assert.rejects(preview(g.root,'owner',[`session:${g.sessionId}`]),/OWNER_CONFLICT/);await owner.release();
  const db=new DatabaseSync(join(g.root,'host.sqlite'));db.exec('PRAGMA user_version=999');db.close();const before=await treeFiles(g.root);await assert.rejects(migrateStorage(g.root,{backup:join(g.base,'backup'),destination:join(g.base,'moved')}),/UNSUPPORTED_HOST_FORMAT/);assert.deepEqual(await treeFiles(g.root),before);
  const h=await fixture('alias'),original=join(h.root,'objects',h.payload.sha256),external=join(h.base,'external');await writeFile(external,await readFile(original));await unlink(original);await symlink(external,original);
  await assert.rejects(preview(h.root,'alias',[`object:${h.payload.sha256}`]),/ALIAS/);assert.equal((await readFile(external)).length,h.payload.bytes);
});

test('released installation bytes retain manifest provenance and are eligible only after all fixed scopes release',async()=>{
  const f=await fixture(),data=await readFile('package.json'),e=new Evidence(f.root,f.runId),sha=digest(data);
  const inventory=e.blob(JSON.stringify([{path:'package.json',sha256:sha,bytes:data.length}]));e.append('execution.artifact',{id:'fixture-artifact',installation:inventory});e.close();
  const fixed=await fixEvidence(f.root,{id:'installed',sources:[f.source.id],purpose:'installed byte retention'});assert.equal(await exists(join(f.root,'objects',sha)),true);
  assert.equal((await preview(f.root,'before-release',[`object:${sha}`])).plan.units.length,0);
  await unfixEvidence(f.root,{id:'release-installed',fixedEvidenceId:fixed.source,reason:'explicit release'});
  const p=await preview(f.root,'after-release',[`object:${sha}`]);assert.equal(p.plan.units.length,1);assert.equal((await commitCleanup(f.root,{id:p.plan.id,identity:p.identity})).status,'completed');assert.equal(await exists(join(f.root,'objects',sha)),false);
});

test('TUI management requires a rendered preview and CLI readback uses the same durable operation',async()=>{
  const f=await fixture(),view=new StorageView(f.root);await view.ready;
  assert.match(view.render(38,8).join('\n'),/存储管理/);await view.handleInput('\r');assert.equal(await exists(join(f.root,'sessions',f.sessionId)),true);
  await view.handleInput('c');await view.handleInput('\r');assert.equal(await exists(join(f.root,'sessions',f.sessionId)),true,'Enter before preview rendering cannot delete');
  assert.match(view.render(38,8).join('\n'),/Enter/);await view.handleInput('\r');assert.equal(await exists(join(f.root,'sessions',f.sessionId)),false);
  const operations=[...records(f.root,{kinds:['management.preview']})].map(r=>decode(f.root,r));const id=operations[0].id;
  const cli=spawnSync(process.execPath,['dist/src/cli.js','storage','status','--data-root',f.root,'--id',id],{cwd:resolve('.'),encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).status,'completed');
  const history=spawnSync(process.execPath,['dist/src/cli.js','history','--data-root',f.root],{cwd:resolve('.'),encoding:'utf8'});assert.equal(history.status,0,history.stderr);assert.equal(JSON.parse(history.stdout).items[0].status,'failed');
  const missing=spawnSync(process.execPath,['dist/src/cli.js','storage','commit','--data-root',f.root,'--id',id],{cwd:resolve('.'),encoding:'utf8'});assert.notEqual(missing.status,0);assert.match(missing.stderr,/requires --confirm/);
});
