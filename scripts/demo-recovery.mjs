import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runCodingTask, runReadTask, readRun, inspectRecovery, checkRecovery, recoverRun } from '../dist/src/runtime.js';
import { scriptedTransport } from '../dist/src/offline.js';
import { digest } from '../dist/src/evidence.js';
import { Harness, createRegistry, GenerationTask } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { acquireOwner } from '../dist/src/ownership.js';

const output=process.argv[2];if(!output)throw new Error('Provide an evidence directory');
await mkdir(resolve(output),{recursive:true});const root=await mkdtemp(join(resolve(output),'demo-'));
const cases=[];
async function setup(name){const base=join(root,name),workspace=join(base,'project'),dataRoot=join(base,'data');await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'README.md'),'Independent recovery demo\n');return{base,workspace,dataRoot};}
async function hashSources(dataRoot){const result={};for(const name of await readdir(dataRoot)){if(name.endsWith('.sqlite'))result[name]=digest(await readFile(join(dataRoot,name)));}for(const session of await readdir(join(dataRoot,'sessions'))){for(const file of await readdir(join(dataRoot,'sessions',session))){result[`${session}/${file}`]=digest(await readFile(join(dataRoot,'sessions',session,file)));}}return result;}
async function save(name,value){await writeFile(join(root,`${name}.json`),JSON.stringify(value,null,2));}
for(const point of ['before-dispatch','after-effect','committed']){
  const paths=await setup(point),controller=new AbortController();let once=true;
  const transport=scriptedTransport([{name:'bash',args:{command:'printf x >> effects.txt'}}]);
  const first=await runCodingTask({...paths,input:'Append a single x to effects.txt',mode:'offline',transport:transport.fetch,signal:controller.signal,cancellation:'exit',
    onObservation:event=>{if(point==='before-dispatch'&&event.kind==='tool.intent')controller.abort();},
    fault:kind=>{if(once&&((point==='after-effect'&&kind==='tool.result')||(point==='committed'&&kind==='run.closed'))){once=false;throw new Error(`retained-first-failure:${point}`);}}
  });
  const authorization={workspace:paths.workspace,mode:'offline',tools:['read','write','edit','bash']};
  const options={...paths,runId:first.runId,authorization};
  await save(`${point}-original`,await readRun(paths.dataRoot,first.runId));
  const before=await hashSources(paths.dataRoot);const inspected=await inspectRecovery(options);assert.deepEqual(await hashSources(paths.dataRoot),before);
  const report=await checkRecovery(options);await save(`${point}-report`,report);
  if(point==='committed'){
    assert.equal(report.status,'completed');assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),'x');assert.equal(transport.calls.length,2);
    const fresh=await runReadTask({...paths,input:'A separately accepted read request',mode:'offline',transport:scriptedTransport([]).fetch});assert.equal(fresh.status,'completed');
    cases.push({point,result:'PASS',root:paths.base,runId:first.runId,firstStatus:first.status,effects:'x',recoveryModelCalls:0,sourceUnchanged:true,committedResultsReused:true,usageRecounted:false});
  }else{
    const next=scriptedTransport([{name:'bash',args:{command:'printf x >> effects.txt'}}]);
    const unknown=report.tools.find(tool=>tool.fact==='unknown');
    if(unknown){const refused=await recoverRun({...options,decision:{id:'missing-user-choice',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true},transport:next.fetch});assert.equal(refused.exitCode,75);assert.equal(next.calls.length,0);await save(`${point}-needs-input`,refused);}
    const decision={id:'explicit-continue',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true,...(unknown?{resolutions:[{taskId:unknown.taskId,choice:'retry',reason:'Independent operator explicitly accepts a possible second append; this is not proof that the first append failed.'}]}:{})};
    const recovered=await recoverRun({...options,decision,transport:next.fetch});assert.equal(recovered.status,'completed');
    const expected=point==='after-effect'?'xx':'x';assert.equal(await readFile(join(paths.workspace,'effects.txt'),'utf8'),expected);
    const requests=next.calls.length;await recoverRun({...options,decision,transport:next.fetch});assert.equal(next.calls.length,requests);
    const after=await readRun(paths.dataRoot,first.runId);assert.equal(after.result.status,'unknown');await save(`${point}-after`,after);
    cases.push({point,result:'PASS',root:paths.base,runId:first.runId,firstStatus:first.status,effects:expected,recoveryModelCalls:requests,sourceUnchanged:true,repeatedDecisionDispatched:0,unknownPreserved:true});
  }
}
{
  const paths=await setup('foreign-pending'),controller=new AbortController();
  const first=await runReadTask({...paths,input:'Interrupted read',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new Error('cancelled')));controller.abort();})});
  const owner=await acquireOwner(paths.dataRoot,()=>{});const harness=await Harness.open(await openNodeSqliteStorage(join(paths.dataRoot,'sessions',first.sessionId,'durable.sqlite')),{models:createModels(),registry:createRegistry()},context);
  const foreign=await harness.createConversation({ownership:{kind:'ownerless'}},context);await foreign.commit(tx=>tx.createTask(GenerationTask,{},{ownership:{kind:'conversation'}}),context);await harness.close(context);await owner.release();
  const options={...paths,runId:first.runId,authorization:{workspace:paths.workspace,mode:'offline',tools:['read']}};
  const report=await checkRecovery(options);assert.equal(report.status,'blocked');const transport=scriptedTransport([]);
  const sources=await hashSources(paths.dataRoot);const entries=[];
  for(const action of ['resume','submit','compact','wait','abort']){
    await assert.rejects(recoverRun({...options,decision:{id:`no-${action}`,action,snapshotId:report.snapshotId,acceptAdditionalModelAttempts:true},transport:transport.fetch}),/INVALID_RECOVERY_ACTION/);entries.push({action,result:'not exposed as recovery actions; rejected before Harness open'});
  }
  for(const action of ['continue','end'])assert.equal((await recoverRun({...options,decision:{id:action,action,snapshotId:report.snapshotId,acceptAdditionalModelAttempts:true},transport:transport.fetch})).status,'blocked');
  assert.equal(transport.calls.length,0);
  const after=await hashSources(paths.dataRoot);for(const [key,value] of Object.entries(sources)){if(key!=='host.sqlite')assert.equal(after[key],value);}
  const runtime=await import('../dist/src/runtime.js');assert.equal('Harness' in runtime,false);
  cases.push({point:'foreign-pending',result:'PASS',root:paths.base,runId:first.runId,modelCalls:0,durableBytesUnchanged:true,entries,publicRuntimeExports:Object.keys(runtime)});await save('foreign-pending-report',report);
}
await save('summary',{status:'PASS',cases,scope:'Real public Pi 1.1.0 Harness, SQLite and shell effects; deterministic offline provider transport only. No paid provider inference, no Terminal acceptance.',originals:'All first failures, original unknown/partial facts and separate decisions retained under each data root.'});
console.log(JSON.stringify({status:'PASS',cases:cases.length,evidence:join(root,'summary.json')}));
