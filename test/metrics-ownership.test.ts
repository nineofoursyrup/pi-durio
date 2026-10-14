import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,symlinkSync,realpathSync,existsSync,renameSync,rmSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {Evidence,digest} from '../src/evidence.js';
import {records} from '../src/history.js';
import {acquireOwner,withOwnerSync} from '../src/ownership.js';
import {recordAcceptance,recordFeedback,recordCostEstimate} from '../src/metrics/index.js';

function fixture(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'durio-metrics-owner-'))),root=join(base,'data');mkdirSync(root);
 const e=new Evidence(root,'run');
 e.append('task.accepted',{taskId:'task',sessionId:'session',workspace:base,input:'Original required result',origin:{kind:'coding',source:'synthetic'}});
 e.append('tool.intent',{attemptId:'attempt'});e.append('tool.result',{attemptId:'attempt'});e.close();
 const refs=[...records(root)],source={kind:'human' as const,actor:'fixture host',statement:'Explicit original requirement',refs:[refs[0].id]};
 const acceptance={type:'requirements' as const,id:'requirements',taskId:'task',source,ruleVersion:'v1',necessary:[{id:'goal',description:'Original required result'}]};
 const feedback={type:'observation' as const,id:'feedback',taskId:'task',source,dimension:'intervention' as const,meaning:'clarification' as const,requirements:[refs[0].id],occurredAt:null};
 const cost={id:'cost',requestSource:refs[1].id,amount:1,currency:'USD',price:{source:'fixture tariff',version:'v1',effectiveAt:'2000-01-01T00:00:00Z',provider:'fixture',model:'fixture'},usageSources:[refs[2].id],reason:'Explicit fixture estimate'};
 const inputs={acceptance,feedback,'cost-estimate':cost};
 for(const [name,input]of Object.entries(inputs))writeFileSync(join(base,`${name}.json`),JSON.stringify(input));
 return{base,root,inputs};
}
function inventory(root:string):unknown[]{return readdirSync(root).sort().map(name=>{const path=join(root,name),stat=lstatSync(path);return{name,type:stat.isDirectory()?'directory':'file',content:stat.isDirectory()?inventory(path):digest(readFileSync(path))};});}
function child(root:string,base:string,command:string,entry:'api'|'cli'){
 const args=entry==='cli'?['dist/src/cli.js',command,'--data-root',root,'--spec',join(base,`${command}.json`)]:['--input-type=module','-e',`import{readFileSync}from'node:fs';import{recordAcceptance,recordFeedback,recordCostEstimate}from'./dist/src/metrics/index.js';const f={acceptance:recordAcceptance,feedback:recordFeedback,'cost-estimate':recordCostEstimate}[process.argv[3]];console.log(JSON.stringify(f(process.argv[1],JSON.parse(readFileSync(process.argv[2],'utf8')))));`,root,join(base,`${command}.json`),command];
 return spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000});
}

test('a second API or CLI process cannot write any metrics fact through the root or its alias while the data owner is held',async()=>{
 const f=fixture(),alias=join(f.base,'alias');symlinkSync(f.root,alias);
 const owner=await acquireOwner(f.root,()=>{});
 try{
  const before=inventory(f.root),attempts=[];
  for(const root of [f.root,alias])for(const entry of ['api','cli'] as const)for(const command of Object.keys(f.inputs)){
   const result=child(root,f.base,command,entry);attempts.push({root,entry,command,rejected:result.status!==0&&/OWNER_CONFLICT/.test(result.stderr)});
  }
  assert.deepEqual(attempts.filter(a=>!a.rejected),[],'every valid competing write must fail with OWNER_CONFLICT');
  assert.deepEqual(inventory(f.root),before,'rejection precedes any writable database open or original append');
 }finally{await owner.release();}
});

function writes(f:ReturnType<typeof fixture>,root=f.root){return[
 ()=>recordAcceptance(root,f.inputs.acceptance),
 ()=>recordFeedback(root,f.inputs.feedback),
 ()=>recordCostEstimate(root,f.inputs['cost-estimate']),
];}
test('idle host writes remain synchronous, idempotent and release ownership after success or invalid input',()=>{
 const f=fixture();
 for(const write of writes(f)){
  const first=write();assert.equal(first.repeated,false);assert.equal(typeof first.source,'string');
  assert.equal(write().repeated,true);
  assert.equal(existsSync(join(f.root,'owner.json')),false);assert.equal(existsSync(`${f.root}.lock`),false);
 }
 const before=inventory(f.root);
 assert.throws(()=>recordAcceptance(f.root,{...f.inputs.acceptance,ruleVersion:'conflicting'}),/ID conflicts/);
 assert.throws(()=>recordFeedback(f.root,{...f.inputs.feedback,meaning:'unknown'}),/ID conflicts/);
 assert.throws(()=>recordCostEstimate(f.root,{...f.inputs['cost-estimate'],amount:2}),/ID_CONFLICT/);
 assert.deepEqual(inventory(f.root),before);
 for(const command of Object.keys(f.inputs)){const result=child(f.root,f.base,command,'cli');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).repeated,true);}
 assert.equal(existsSync(`${f.root}.lock`),false);
});
test('only a live registered owner for the same canonical root is borrowed, and release immediately excludes reuse',async()=>{
 const f=fixture(),other=fixture(),alias=join(f.base,'alias');symlinkSync(f.root,alias);
 const owner=await acquireOwner(f.root,()=>{}),marker=readFileSync(join(f.root,'owner.json'));
 // Even this process's genuine token copied onto a different root grants nothing.
 writeFileSync(join(other.root,'owner.json'),marker);
 const before=inventory(other.root);
 for(const write of writes(other))assert.throws(write,/OWNER_CONFLICT/);
 assert.deepEqual(inventory(other.root),before);
 for(const write of writes(f,alias))assert.equal(write().repeated,false);
 owner.assertHeld();assert.deepEqual(readFileSync(join(f.root,'owner.json')),marker);
 const releasing=owner.release();
 for(const write of writes(f))assert.throws(write,/OWNER_LOST/);
 await releasing;
 for(const write of writes(f))assert.equal(write().repeated,true);
});
test('a missing claim or replaced lock cannot authorize writes or delete another owner on release',async()=>{
 for(const fault of ['claim','lock']){
  const f=fixture(),compromised:Error[]=[];const owner=await acquireOwner(f.root,error=>compromised.push(error));
  if(fault==='claim')rmSync(join(f.root,'owner.json'));
  else{renameSync(`${f.root}.lock`,`${f.root}.original-lock`);mkdirSync(`${f.root}.lock`);writeFileSync(join(f.root+'.lock','foreign-owner'),'retain');}
  const before=inventory(f.root);
  for(const write of writes(f))assert.throws(write,/OWNER_LOST/);
  assert.deepEqual(inventory(f.root),before);assert.equal(compromised.length,1);
  await assert.rejects(owner.release(),/OWNER_LOST/);
  if(fault==='lock')assert.equal(readFileSync(join(f.root+'.lock','foreign-owner'),'utf8'),'retain');
 }
});
test('stale markers are never stolen and cleanup failures remain visible and block reuse',async()=>{
 const stale=fixture();mkdirSync(`${stale.root}.lock`);utimesSync(`${stale.root}.lock`,new Date(0),new Date(0));
 const before=inventory(stale.root);
 for(const write of writes(stale))assert.throws(write,/OWNER_CONFLICT/);
 assert.deepEqual(inventory(stale.root),before);assert.equal(existsSync(`${stale.root}.lock`),true);
 const f=fixture(),owner=await acquireOwner(f.root,()=>{});writeFileSync(join(`${f.root}.lock`,'obstruction'),'prevent release');
 await assert.rejects(owner.release(),/ENOTEMPTY/);
 assert.equal(existsSync(join(f.root,'owner.json')),true);
 for(const write of writes(f))assert.throws(write,/OWNER_LOST/);
});
test('readonly metrics CLI reports do not acquire ownership or change originals while a writer holds the root',async()=>{
 const f=fixture(),owner=await acquireOwner(f.root,()=>{});
 try{
  const before=inventory(f.root);
  for(const command of ['metrics','operations','feedback-report']){
   const result=spawnSync(process.execPath,['dist/src/cli.js',command,'--data-root',f.root],{encoding:'utf8',timeout:10000});
   assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(result.stdout).id);
  }
  assert.deepEqual(inventory(f.root),before);owner.assertHeld();
 }finally{await owner.release();}
});

test('competing identical receipts stay atomic and a rejected writer can retry without a duplicate original',{timeout:20000},async()=>{
 const f=fixture();
 for(const command of Object.keys(f.inputs)){
  const contenders=Array.from({length:2},()=>{
   const program=`import{readFileSync}from'node:fs';import{recordAcceptance,recordFeedback,recordCostEstimate}from'./dist/src/metrics/index.js';const f={acceptance:recordAcceptance,feedback:recordFeedback,'cost-estimate':recordCostEstimate}[process.argv[3]];process.once('message',()=>{try{console.log(JSON.stringify({ok:true,result:f(process.argv[1],JSON.parse(readFileSync(process.argv[2],'utf8')))}));}catch(error){console.log(JSON.stringify({ok:false,error:String(error)}));}process.disconnect();});process.send('ready');`;
   const processChild=spawn(process.execPath,['--input-type=module','-e',program,f.root,join(f.base,`${command}.json`),command],{stdio:['ignore','pipe','pipe','ipc']});
   let stdout='',stderr='';processChild.stdout!.on('data',chunk=>stdout+=chunk);processChild.stderr!.on('data',chunk=>stderr+=chunk);
   const ready=new Promise<void>((resolve,reject)=>{processChild.once('message',()=>resolve());processChild.once('error',reject);});
   const closed=new Promise<any>((resolve,reject)=>{processChild.once('error',reject);processChild.once('close',code=>{try{assert.equal(code,0,stderr);resolve(JSON.parse(stdout));}catch(error){reject(error);}});});
   return{processChild,ready,closed};
  });
  await Promise.all(contenders.map(c=>c.ready));for(const c of contenders)c.processChild.send('write');
  const results=await Promise.all(contenders.map(c=>c.closed));assert.ok(results.some(r=>r.ok));
  for(const result of results)if(!result.ok)assert.match(result.error,/OWNER_CONFLICT/);
  const retry=child(f.root,f.base,command,'api');assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).repeated,true);
 }
 assert.deepEqual([...records(f.root)].map(r=>r.kind),['task.accepted','tool.intent','tool.result','acceptance.requirements','feedback.observation','cost.estimate']);
});
test('a short write exposes both operation and release failures and retains its ownership marker',()=>{
 const f=fixture(),operation=Error('explicit operation failure');
 assert.throws(()=>withOwnerSync(f.root,()=>{writeFileSync(join(`${f.root}.lock`,'obstruction'),'prevent release');throw operation;}),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.errors[0],operation);assert.match(String(error.errors[1]),/ENOTEMPTY/);return true;
 });
 assert.equal(existsSync(join(f.root,'owner.json')),true);
 for(const write of writes(f))assert.throws(write,/OWNER_LOST/);
});
