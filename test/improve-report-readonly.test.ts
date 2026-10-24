import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {setImmediate as tick} from 'node:timers/promises';
import {Evidence,digest,openHostReadonly} from '../src/evidence.js';
import {runCodingTask,analyzeImprove} from '../src/runtime.js';
import {offlineImproveTransport} from '../src/improve.js';
import {scriptedTransport} from '../src/offline.js';
import {readDisplayIndex} from '../src/display-number.js';
import {workspaceOwnerRegistry} from '../src/workspace-ownership.js';
import {acquireOwner} from '../src/ownership.js';

function snapshot(root:string) {
 const entries:any[]=[];
 function walk(path:string){
  if(!existsSync(path))return;
  const s=statSync(path),name=relative(root,path);
  entries.push(s.isDirectory()?{path:name,type:'directory',mode:s.mode,ino:s.ino}:{path:name,mode:s.mode,ino:s.ino,mtimeMs:s.mtimeMs,sha256:digest(readFileSync(path))});
  if(s.isDirectory())for(const name of readdirSync(path).sort())walk(join(path,name));
 }
 walk(root);walk(root+'.lock');return entries;
}

// The preload observes the real CLI without replacing its storage/runtime. A
// synchronous pipe handshake puts the writer's lock before the first SELECT.
function readerProbe(root:string,fault?:{errcode?:number;message:string;sql?:string}) {
 const path=join(root,'reader-probe.mjs');
 writeFileSync(path,`
  import {DatabaseSync,constants} from 'node:sqlite';
  import {appendFileSync,writeSync,readSync} from 'node:fs';
  const trace=process.env.DURIO_REPORT_TRACE;
  const fault=${JSON.stringify(fault??null)};
  const emit=value=>appendFileSync(trace,JSON.stringify(value)+'\\n');
  const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
  const observed=new WeakSet();let signalled=false;
  function observe(db){
   if(observed.has(db))return;observed.add(db);
   db.setAuthorizer((action,arg1,arg2)=>{emit({event:'authorize',action,arg1,arg2});return constants.SQLITE_OK;});
  }
  function signal(sql){
   if(!signalled&&/\\bSELECT\\b/i.test(sql)){
    signalled=true;writeSync(3,'ready\\n');readSync(4,Buffer.alloc(1),0,1,null);
   }
  }
  DatabaseSync.prototype.prepare=function(sql){
   observe(this);emit({event:'prepare',sql});signal(sql);
   if(fault?.sql===sql)throw Object.assign(Error(fault.message),{errcode:fault.errcode});
   try{
    const statement=prepare.call(this,sql),all=statement.all;
    statement.all=function(...args){
     const rows=all.apply(this,args);
     if(process.env.DURIO_REPORT_CHECKPOINT&&args.includes('improve.started')){
      delete process.env.DURIO_REPORT_CHECKPOINT;writeSync(3,'snapshot\\n');readSync(4,Buffer.alloc(1),0,1,null);
     }
     return rows;
    };
    return statement;
   }
   catch(error){emit({event:'sqlite-error',errcode:error.errcode,message:error.message});throw error;}
  };
  DatabaseSync.prototype.exec=function(sql){observe(this);emit({event:'exec',sql});signal(sql);if(fault&&!fault.sql&&/\\bSELECT\\b/i.test(sql))throw Object.assign(Error(fault.message),{errcode:fault.errcode});return exec.call(this,sql);};
  globalThis.fetch=async()=>{emit({event:'network'});throw Error('REPORT_NETWORK_FORBIDDEN');};
 `);
 return path;
}

async function query(root:string,dataRoot:string,probe:string,label:string,id:string,ready:()=>void=()=>{},format='json',action='report',checkpoint?:()=>Promise<void>) {
 const trace=join(root,label+'.trace.jsonl'),args=['--import',probe,'dist/src/cli.js','improve',action,...action==='report'?['--id',id,'--format',format]:[],'--data-root',dataRoot];
 writeFileSync(trace,'');
 const child=spawn(process.execPath,args,{timeout:15000,env:{HOME:homedir(),PATH:process.env.PATH,LANG:'en_US.UTF-8',DURIO_REPORT_TRACE:trace,...checkpoint?{DURIO_REPORT_CHECKPOINT:'1'}:{}},stdio:['ignore','pipe','pipe','pipe','pipe']});
 const stdout:Buffer[]=[],stderr:Buffer[]=[];let began=performance.now();
 child.stdout!.on('data',bytes=>stdout.push(bytes));child.stderr!.on('data',bytes=>stderr.push(bytes));
 const handshakes:Promise<void>[]=[];
 child.stdio[3]!.on('data',bytes=>{
  const handshake=(async()=>{
   if(String(bytes).trim()==='ready'){began=performance.now();ready();}else await checkpoint!();
   (child.stdio[4] as NodeJS.WritableStream).write('x');
  })();handshakes.push(handshake);handshake.catch(()=>child.kill('SIGKILL'));
 });
 const status=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 await Promise.all(handshakes);
 const result={args,status,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString(),readDurationMs:performance.now()-began};
 writeFileSync(join(root,label+'.receipt.json'),JSON.stringify(result,null,2)+'\n');
 const events=readFileSync(trace,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 // SELECT, READ, FUNCTION, connection-local busy_timeout and a read transaction
 // are the only operations this viewer may perform.
 for(const event of events.filter(e=>e.event==='authorize'))assert.ok([20,21,31].includes(event.action)||event.action===19&&event.arg1==='busy_timeout'||event.action===22&&['BEGIN','ROLLBACK'].includes(event.arg1),JSON.stringify(event));
 assert.ok(!events.some(e=>e.event==='network'));
 return result;
}

test('actual report CLI has one bounded readonly wait while offline analysis owns the root',{timeout:120000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-report-readonly-'))),workspace=join(root,'project'),dataRoot=join(root,'data');
 mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Controlled report concurrency fixture.\n');
 const artifacts=process.env.DURIO_REPORT_TEST_ARTIFACTS??root;
 mkdirSync(artifacts,{recursive:true});
 const probe=readerProbe(root),sourceProvider=scriptedTransport([]);
 t.mock.method(globalThis,'fetch',async()=>{throw Error('REPORT_TEST_NETWORK_FORBIDDEN');});
 const source=await runCodingTask({workspace,dataRoot,input:'Synthetic source without tools',mode:'offline',transport:sourceProvider.fetch});
 assert.equal(source.status,'completed',JSON.stringify(source));
 let writer:Evidence|undefined;
 const append=Evidence.prototype.append;
 t.mock.method(Evidence.prototype,'append',function(this:Evidence,kind:string,data:unknown){const seq=append.call(this,kind,data);if(this.root===dataRoot&&kind==='improve.started')writer=this;return seq;});
 let proceed!:()=>void,ready!:()=>void;
 const released=new Promise<void>(resolve=>{proceed=resolve;}),paused=new Promise<void>(resolve=>{ready=resolve;});
 const provider=offlineImproveTransport(),id='bounded-report';let entered=0;
 const running=analyzeImprove({workspace,dataRoot,targetRunId:source.runId,mode:'offline',request:{id,purpose:'Inspect concurrent committed state',limits:{maxRequests:8,maxTokens:2048,maxRequestTokens:256,maxDurationMs:120000,maxOutputTokens:128}},transport:async(url,init)=>{entered++;if(entered===1){ready();await released;}return provider.fetch(url,init);}});
 t.after(async()=>{if(writer?.db.isOpen&&writer.db.isTransaction)writer.db.exec('ROLLBACK');proceed();await running;});
 await Promise.race([paused,running.then(result=>assert.fail('Analysis ended before pause: '+JSON.stringify(result)))]);
 assert.ok(writer);const active=writer;
 const ownerPath=join(workspaceOwnerRegistry,digest(workspace));
 const files=()=>({data:snapshot(dataRoot),owner:snapshot(ownerPath)});
 const display=readDisplayIndex(dataRoot).label('improve-report',id);
 writeFileSync(join(artifacts,'identity.json'),JSON.stringify({root,workspace,dataRoot,id,display,analysisRunId:active.runId,pid:process.pid},null,2)+'\n');
 const checkRunning=(result:Awaited<ReturnType<typeof query>>)=>{
  assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
  assert.equal(value.id,id);assert.equal(value.state,'interrupted-or-running');assert.equal(value.report,null);assert.equal(value.result,null);
 };
 for(const phase of ['unlocked','reserved','short-exclusive','persistent-exclusive','autocommit'] as const)await t.test(phase,async()=>{
  const before=files();let expected=before,timer:ReturnType<typeof setTimeout>|undefined,writing=false,writes=0,loop:Promise<void>|undefined;
  if(phase==='reserved')active.db.exec('BEGIN IMMEDIATE');
  if(phase.includes('exclusive'))active.db.exec('BEGIN EXCLUSIVE');
  try{
   const result=await query(artifacts,dataRoot,probe,phase,phase==='short-exclusive'?display:id,()=>{
    if(phase==='short-exclusive')timer=setTimeout(()=>active.db.exec('ROLLBACK'),150);
    if(phase==='autocommit'){
     writing=true;loop=(async()=>{while(writing){active.append('test.concurrent-autocommit',{synthetic:true});writes++;expected=files();await tick();}})();
    }
   });
   if(phase==='persistent-exclusive'){
    assert.equal(result.status,75,result.stderr);assert.equal(result.stdout,'');
    const error=JSON.parse(result.stderr).error;
    assert.equal(error.code,'IMPROVE_REPORT_TEMPORARILY_UNREADABLE');assert.match(error.message,/retry/i);
    assert.ok(result.readDurationMs>=900&&result.readDurationMs<2000,JSON.stringify(result));
   }else{
    checkRunning(result);
    if(phase==='short-exclusive')assert.ok(result.readDurationMs>=120&&result.readDurationMs<2000,JSON.stringify(result));
   }
  }finally{
   writing=false;await loop;if(timer)clearTimeout(timer);
   if(active.db.isTransaction)active.db.exec('ROLLBACK');
   assert.deepEqual(files(),expected,'only the controlled autocommit writer may change files; report preserves bytes, metadata and owners');
  }
  if(phase==='autocommit')assert.ok(writes>0);
  assert.equal(entered,1);assert.equal(provider.calls.length,0);assert.equal(sourceProvider.calls.length,1);
 });
 await t.test('other readonly commands keep zero waiting',async()=>{
  const db=openHostReadonly(dataRoot);try{assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,0);assert.throws(()=>db.prepare("INSERT INTO records(run_id,kind,at,body) VALUES('x','x','x','x')").run(),error=>(error as {errcode:number}).errcode===8);}finally{db.close();}
  const before=files();active.db.exec('BEGIN EXCLUSIVE');
  try{const result=await query(artifacts,dataRoot,probe,'list-default',id,()=>{},'json','list');assert.equal(result.status,1);assert.match(result.stderr,/database is locked/);assert.ok(result.readDurationMs<900);}
  finally{active.db.exec('ROLLBACK');assert.deepEqual(files(),before);}
 });
 proceed();const completed=await running;
 assert.equal(completed.improve?.state,'complete',JSON.stringify(completed));assert.equal(entered,2);assert.equal(provider.calls.length,2);assert.equal(completed.improve?.budget.knownTokens,28);
 await t.test('completed JSON and text reports preserve the final report and all files',async()=>{
  const before=files(),first=await query(artifacts,dataRoot,probe,'final-json',id),second=await query(artifacts,dataRoot,probe,'final-repeat',display);
  assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);assert.equal(first.stdout,second.stdout);
  const {clock,...saved}=JSON.parse(first.stdout).report;assert.deepEqual(saved,completed.improve);
  const text=await query(artifacts,dataRoot,probe,'final-text',display,()=>{},'text');assert.equal(text.status,0,text.stderr);assert.match(text.stdout,/Controlled zero-candidate report/);
  assert.deepEqual(files(),before);assert.equal(provider.calls.length,2);assert.equal(sourceProvider.calls.length,1);
 });
});

test('report keeps one committed phase while a concurrent completion is pending',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-report-snapshot-'))),dataRoot=join(root,'data'),artifacts=process.env.DURIO_REPORT_TEST_ARTIFACTS?join(process.env.DURIO_REPORT_TEST_ARTIFACTS,'snapshot'):root;
 mkdirSync(artifacts,{recursive:true});
 const owner=await acquireOwner(dataRoot,error=>assert.fail(String(error)));t.after(()=>owner.release());
 const id='phase-report',runId='phase-analysis',e=new Evidence(dataRoot,runId);
 e.append('improve.started',{request:{id},target:{workspace:root}});e.close();
 const writerPath=join(root,'completion-writer.mjs');
 writeFileSync(writerPath,`
  import {writeSync,readSync} from 'node:fs';
  import {Evidence} from ${JSON.stringify(new URL('../src/evidence.js',import.meta.url).href)};
  const e=new Evidence(${JSON.stringify(dataRoot)},${JSON.stringify(runId)});
  e.db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  e.append('improve.report',{id:${JSON.stringify(id)},state:'complete',revision:'concurrent-completion',evidence:[]});
  e.append('run.closed',{status:'completed'});
  try{e.db.exec('COMMIT');writeSync(3,'committed\\n');}
  catch(error){
   if(error.errcode!==5)throw error;
   writeSync(3,'blocked\\n');readSync(4,Buffer.alloc(1),0,1,null);e.db.exec('PRAGMA busy_timeout=1000; COMMIT');
  }
  e.close();
 `);
 let writer:ReturnType<typeof spawn>|undefined,writerDone:Promise<number|null>|undefined,checkpointFiles:ReturnType<typeof snapshot>|undefined;
 t.after(async()=>{if(writer?.exitCode===null)writer.kill('SIGKILL');await writerDone;});
 const result=await query(artifacts,dataRoot,readerProbe(root),'pending-completion',id,()=>{},'json','report',async()=>{
  writer=spawn(process.execPath,[writerPath],{timeout:15000,env:{HOME:homedir(),PATH:process.env.PATH},stdio:['ignore','ignore','pipe','pipe','pipe']});
  let stderr='';writer.stderr!.on('data',bytes=>{stderr+=bytes;});
  writerDone=new Promise<number|null>((resolve,reject)=>{writer!.once('error',reject);writer!.once('close',resolve);});
  const phase=await Promise.race([new Promise<string>(resolve=>writer!.stdio[3]!.once('data',bytes=>resolve(String(bytes).trim()))),writerDone.then(code=>assert.fail(`Writer ended before checkpoint: ${code} ${stderr}`))]);
  assert.equal(phase,'blocked','a later commit cannot replace the snapshot between report phases');
  checkpointFiles=snapshot(dataRoot);
 });
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).state,'interrupted-or-running');assert.equal(JSON.parse(result.stdout).report,null);assert.equal(JSON.parse(result.stdout).result,null);
 assert.ok(result.readDurationMs<2000,JSON.stringify(result));assert.deepEqual(snapshot(dataRoot),checkpointFiles,'query leaves the pending writer journal, files and owner unchanged');
 (writer!.stdio[4] as NodeJS.WritableStream).write('x');assert.equal(await writerDone,0);
 const before=snapshot(dataRoot),final=await query(artifacts,dataRoot,readerProbe(root),'committed-completion',id);
 assert.equal(final.status,0,final.stderr);assert.equal(JSON.parse(final.stdout).state,'complete');assert.equal(JSON.parse(final.stdout).result.status,'completed');assert.deepEqual(snapshot(dataRoot),before);
});

test('report distinguishes SQLite busy codes from missing, corrupt, journal and ID errors',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-report-errors-'))),artifacts=process.env.DURIO_REPORT_TEST_ARTIFACTS?join(process.env.DURIO_REPORT_TEST_ARTIFACTS,'errors'):root;
 mkdirSync(artifacts,{recursive:true});
 for(const kind of ['missing','missing-display','unsupported-journal','corrupt-database','corrupt-object','unknown-id','unknown-display','extended-busy','locked-code','locked-message','availability-busy'] as const)await t.test(kind,async()=>{
  const dataRoot=join(root,kind),id=kind.endsWith('display')?'ir-ffffffff':'unknown';
  if(kind!=='missing'&&kind!=='missing-display'){
   const e=new Evidence(dataRoot,'error-fixture');
   if(kind==='corrupt-object'){e.append('improve.started',{request:{id}});const file=readdirSync(join(dataRoot,'objects'))[0];writeFileSync(join(dataRoot,'objects',file),'damaged object');}
   if(kind==='availability-busy'){
    const seq=e.append('test.source',{synthetic:true}),ref=JSON.parse(String(e.db.prepare('SELECT body FROM records WHERE seq=?').get(seq)!.body));
    e.append('improve.started',{request:{id}});e.append('improve.report',{id,state:'complete',evidence:[`e1:${seq}:${ref.sha256}`]});
   }
   e.close();
   if(kind==='unsupported-journal'||kind==='corrupt-database'){
    const path=join(dataRoot,'host.sqlite'),bytes=readFileSync(path);
    if(kind==='unsupported-journal'){bytes[18]=2;bytes[19]=2;}else bytes[100]=0xff;
    writeFileSync(path,bytes);
   }
  }
  const fault=kind==='extended-busy'?{errcode:261,message:'Controlled contention without a lock message'}:kind==='locked-code'?{errcode:6,message:'database table is locked'}:kind==='locked-message'?{message:'database is locked'}:kind==='availability-busy'?{errcode:5,message:'Controlled availability contention',sql:'SELECT * FROM records WHERE seq=?'}:undefined;
  const before=snapshot(dataRoot),result=await query(artifacts,dataRoot,readerProbe(root,fault),kind,id),error=JSON.parse(result.stderr).error;
  const expected={missing:['ENOENT',1],'missing-display':['DISPLAY_NOT_FOUND',1],'unsupported-journal':['RECOVERY_REQUIRED',75],'corrupt-database':['database',1],'corrupt-object':['EVIDENCE_CORRUPT',1],'unknown-id':['IMPROVE_REPORT_NOT_FOUND',1],'unknown-display':['DISPLAY_NOT_FOUND',1],'extended-busy':['IMPROVE_REPORT_TEMPORARILY_UNREADABLE',75],'locked-code':['database',1],'locked-message':['database',1],'availability-busy':['IMPROVE_REPORT_TEMPORARILY_UNREADABLE',75]}[kind];
  assert.equal(error.code,expected[0],result.stderr);assert.equal(result.status,expected[1],result.stderr);assert.equal(result.stdout,'');assert.deepEqual(snapshot(dataRoot),before);
 });
 await t.test('queued report remains pending without opening a writer',async()=>{
  const dataRoot=join(root,'queued'),e=new Evidence(dataRoot,'source-run'),id='queued-report';
  e.append('control.accepted',{requestId:id,kind:'improve',input:'Inspect evidence',taskId:null,target:{workspace:root,runId:'source-run',sessionId:'source-session',taskId:'source-task'},executionVersion:{artifactId:'fixture',configSeq:0,artifactSeq:0},authorization:{tools:['read']}});e.close();
  const before=snapshot(dataRoot),result=await query(artifacts,dataRoot,readerProbe(root),'queued',id);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).state,'pending');assert.equal(JSON.parse(result.stdout).report,null);assert.deepEqual(snapshot(dataRoot),before);
 });
});
