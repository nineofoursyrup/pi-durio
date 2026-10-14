#!/usr/bin/env node
/** Real headless NDJSON adapter + public Pi runtime, with deterministic offline transport only. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [packageRootArg,evidenceRootArg]=process.argv.slice(2);
if(!packageRootArg||!evidenceRootArg)throw Error('Usage: node scripts/demo-control.mjs PACKAGE_ROOT NEW_EVIDENCE_ROOT');
const packageRoot=resolve(packageRootArg),evidenceRoot=resolve(evidenceRootArg),workspace=join(evidenceRoot,'project'),dataRoot=join(evidenceRoot,'data');
mkdirSync(evidenceRoot,{recursive:false});mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Headless queue fixture original context\n');
const {readAcceptedTasks,readQueue}=await import(pathToFileURL(join(packageRoot,'dist/src/runtime.js')).href);
const child=spawn(process.execPath,[join(packageRoot,'dist/src/cli.js'),'control','--workspace',workspace,'--data-root',dataRoot,'--prompt','Read README in coding mode','--coding','--offline-demo'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8'}});
let stdout='',stderr='',buffer='',sent=false;
child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let message;try{message=JSON.parse(line);}catch{continue;}if(message.ready&&!sent){sent=true;child.stdin.end(JSON.stringify({action:'follow-up',id:'headless-follow',input:'Explain the original context without repeating its read.',target:message.ready})+'\n');}}});
child.stderr.on('data',chunk=>{stderr+=chunk;});
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
writeFileSync(join(evidenceRoot,'stdout.jsonl'),stdout);writeFileSync(join(evidenceRoot,'stderr.log'),stderr);
assert.equal(code,0,stdout+'\n'+stderr);assert.equal(sent,true);
const messages=stdout.trim().split('\n').map(line=>JSON.parse(line)),accepted=messages.find(message=>message.control)?.control,result=messages.find(message=>message.result)?.result;
assert.ok(accepted);assert.equal(accepted.runId,null);assert.equal(accepted.status,'pending');assert.equal(result.status,'completed');assert.equal(result.taskId,accepted.taskId);assert.notEqual(result.runId,accepted.target.runId);
const tasks=readAcceptedTasks(dataRoot).tasks,queue=readQueue(dataRoot).items;
assert.equal(tasks.length,2);assert.equal(queue[0].status,'applied');assert.equal(tasks[1].acceptedSeq,accepted.acceptedSeq);
const report={status:'PASS',method:'headless CLI stdin/stdout with public Pi and offline transport',packageRoot,dataRoot,workspace,code,accepted,result,tasks,queue,paidProvider:'NOT RUN'};
writeFileSync(join(evidenceRoot,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,evidenceRoot,tasks:tasks.length,followUpRun:result.runId}));
