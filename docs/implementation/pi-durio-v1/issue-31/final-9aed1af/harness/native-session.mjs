#!/usr/bin/env node
// Automated local workload in actual macOS Terminal. No provider/network calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync,lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const [installArg,outArg]=process.argv.slice(2);
if(!installArg||!outArg)throw Error('Usage: node native-session.mjs INSTALL_ROOT NEW_OUTPUT');
if(process.platform!=='darwin'||!process.stdin.isTTY||!process.stdout.isTTY||process.env.TERM_PROGRAM!=='Apple_Terminal')throw Error('ACTUAL_MACOS_TERMINAL_REQUIRED');
const install=resolve(installArg),out=resolve(outArg);
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
mkdirSync(out);const workspace=join(out,'workspace'),dataRoot=join(out,'data');mkdirSync(workspace);
const hash=b=>createHash('sha256').update(b).digest('hex');
const ref=p=>{const b=readFileSync(p);return{path:p,bytes:b.length,sha256:hash(b)};};
const save=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
const event=data=>appendFileSync(join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),performanceMs:performance.now(),...data})+'\n',{mode:0o600});
function inventory(root){
 const rows=[];
 function walk(dir,relative=''){for(const name of readdirSync(dir).sort()){const p=join(dir,name),r=join(relative,name),s=lstatSync(p);if(s.isSymbolicLink())rows.push({path:r,kind:'symlink',target:readlinkSync(p)});else if(s.isDirectory())walk(p,r);else if(s.isFile())rows.push({path:r,kind:'file',bytes:s.size,allocated:s.blocks*512,sha256:hash(readFileSync(p))});}}
 if(existsSync(root))walk(root);return{rows,logicalBytes:rows.reduce((n,r)=>n+(r.bytes??0),0),allocatedByPathBytes:rows.reduce((n,r)=>n+(r.allocated??0),0)};
}
const large=Buffer.alloc(1024*1024,0x78);Buffer.from('DURIO_BEGIN\n').copy(large,0);Buffer.from('\nDURIO_MIDDLE\n').copy(large,512*1024);Buffer.from('\nDURIO_END\n').copy(large,large.length-11);
writeFileSync(join(workspace,'README.md'),'Fixed local measurement fixture; synthetic transport, no model inference.\n');
writeFileSync(join(workspace,'counter.cjs'),'exports.value = 0;\n');
writeFileSync(join(workspace,'large.bin'),large);
writeFileSync(join(workspace,'large.cjs'),"process.stdout.write(require('node:fs').readFileSync('large.bin'));\n");
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const plan=Array.from({length:60},(_,i)=>{
 const round=i+1,cycle=Math.floor(i/3),kind=i%3;
 const check = `require('node:assert/strict').equal(require('./counter.cjs').value,${cycle+1});console.log('counter-${cycle+1}-ok')`;
 const steps=kind===0?[{name:'read',args:{path:'README.md'}}]:kind===1?[{name:'edit',args:{path:'counter.cjs',edits:[{oldText:`exports.value = ${cycle};`,newText:`exports.value = ${cycle+1};`}]}}]:[{name:'bash',args:{command:quote(process.execPath)+' -e '+quote(check)}}];
 return{round,kind:['read','edit','check'][kind],prompt:`Measure round ${round}: ${['read README.md','increment the declared local counter','check the declared local counter'][kind]}.`,steps};
});
const require=createRequire(join(install,'package.json')),product=require.resolve('pi-durio/tui');
save('plan.json',{at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),product:ref(product),sourceBuild:ref(join(install,'node_modules/pi-durio/dist/execution/source-build.json')),node:process.execPath,nodeVersion:process.version,
 terminal:{program:process.env.TERM_PROGRAM,version:process.env.TERM_PROGRAM_VERSION??null,term:process.env.TERM,columns:process.stdout.columns,rows:process.stdout.rows},
 repetitions:plan,minimumDurationMs:300000,minimumRoundIntervalMs:5000,perRoundTimeoutMs:60000,overallTimeoutMs:900000,
 navigation:'After every ten rounds: /history, capture visible frame, Escape, /bottom. Native ProcessTerminal is retained; automated text and Enter travel through its captured normal input callback. Width calibration remains enabled; no private app fields are used.',
 largeOutput:{prompt:'Measure fixed 1 MiB output, then preserve original bytes.',steps:[{name:'bash',args:{command:`${quote(process.execPath)} large.cjs`}}],bytes:large.length,sha256:hash(large)},
 fixture:inventory(workspace),measurements:'Host Node RSS every second; actual storage inventory before tasks, after first and each ten rounds, and after large output. Query/export measurements are a separate read-only harness.',
 limits:['Automated native UI composition, not a human usability or #32 acceptance result.','Synthetic transport has no inference/network latency; payload size is measured but synthetic usage is not a real token estimate.','Host RSS excludes Terminal.app and transient child processes; peak is sampled, not a proof of the absolute peak.','Public screen snapshots, event logging and synchronous storage hashing add disclosed unseparated overhead.','Only five minutes and sixty rounds are characterized; no hours-long stability claim.']});
save('storage-empty.json',inventory(dataRoot));
const {ReadOnlyTui}=await import(pathToFileURL(product).href);
const productRequire=createRequire(product);
const {ProcessTerminal,stripTerminalSequences}=await import(pathToFileURL(productRequire.resolve('@earendil-works/pi-tui')).href);
const {scriptedTransport}=await import(pathToFileURL(require.resolve('pi-durio/offline')).href);
const {readAcceptedTasks}=await import(pathToFileURL(require.resolve('pi-durio')).href);
const {readRunRecords,readObjectRange}=await import(pathToFileURL(require.resolve('pi-durio/query')).href);
function readJson(ref){const parts=[];for(let offset=0;;){const page=readObjectRange(dataRoot,ref,{offset,limit:16384});parts.push(page.bytes);if(page.next===null)break;offset=page.next;}return JSON.parse(Buffer.concat(parts).toString());}
const terminal=new ProcessTerminal(),originalStart=terminal.start.bind(terminal);let inject;
terminal.start=(input,resize)=>{inject=data=>{event({kind:'automated-input',data});input(data);};return originalStart(input,resize);};
let active,app,closed=false,firstFrame=null,phase='startup',syntheticRequests=0;
const samples=[],rounds=[],originalWrite=process.stdout.write;
process.stdout.write=function(chunk,...args){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));if(firstFrame===null&&b.toString().includes('pi-durio ·'))firstFrame=performance.now();return originalWrite.call(this,chunk,...args);};
const sampleTimer=setInterval(()=>{const sample={performanceMs:performance.now(),phase,rssBytes:process.memoryUsage().rss};samples.push(sample);event({kind:'rss',...sample});},1000);
const deadline=setTimeout(()=>{event({kind:'overall-timeout'});void app?.exit();},900000);
async function until(fn,ms=60000){const end=performance.now()+ms;while(performance.now()<end){if(closed)throw Error('APP_CLOSED_EARLY');const value=fn();if(value)return value;await delay(100);}throw Error('MEASUREMENT_WAIT_TIMEOUT');}
const screen=()=>app.screen().map(stripTerminalSequences).join('\n');
async function enter(text){inject(text);await delay(750);inject('\r');}
async function runTask(item){
 active=scriptedTransport(item.steps);const begun=performance.now();await enter(item.prompt);
 const accepted=await until(()=>{if(!existsSync(join(dataRoot,'host.sqlite')))return null;return readAcceptedTasks(dataRoot,{limit:200}).tasks.find(t=>t.input===item.prompt&&['completed','failed','aborted','unknown'].includes(t.status));});
 assert.equal(accepted.status,'completed');await until(()=>screen().includes('已完成'));
 const facts=readRunRecords(dataRoot,accepted.runId,{limit:50,kinds:['tool.result','tool.error','shell.completed']});
 assert.equal(facts.more,false);assert.equal(facts.records.filter(r=>r.kind==='tool.error').length,0);
 const results=facts.records.filter(r=>r.kind==='tool.result').map(r=>readJson(r.ref));assert.equal(results.length,1);assert.notEqual(results[0].result.isError,true);
 const shells=facts.records.filter(r=>r.kind==='shell.completed').map(r=>readJson(r.ref).acquired);if(item.steps[0].name==='bash'){assert.equal(shells.length,1);assert.equal(shells[0].exitCode,0);assert.equal(shells[0].completeness,'complete');}
 const row={...item,runId:accepted.runId,elapsedMs:performance.now()-begun,requests:active.calls.length,payloadBytes:active.calls.map(p=>Buffer.byteLength(JSON.stringify(p))),toolResults:facts.records,visibleLines:app.screen().length,visibleBytes:Buffer.byteLength(screen())};
 event({kind:'round',...row});active=null;return row;
}
try{
 app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(out,'drafts'),mode:'offline',coding:true,terminal,transport:async(...args)=>{if(!active)throw Error('UNPLANNED_SYNTHETIC_DISPATCH');syntheticRequests++;return active.fetch(...args);}});
 void app.closed.then(()=>{closed=true;});app.start();await until(()=>firstFrame!==null);await delay(1500);phase='long-session';const began=performance.now();
 for(const item of plan){const begin=performance.now();const row=await runTask(item);rounds.push(row);save(`round-${String(item.round).padStart(2,'0')}.json`,row);
  if(item.round===1||item.round%10===0)save(`storage-round-${item.round}.json`,inventory(dataRoot));
  if(item.round%10===0){await enter('/history');await delay(750);save(`history-round-${item.round}.json`,{screen:screen(),lines:app.screen().length});inject('\x1b');await delay(750);await enter('/bottom');await delay(750);}
  await delay(Math.max(0,5000-(performance.now()-begin)));
 }
 assert.ok(performance.now()-began>=300000);assert.equal(readFileSync(join(workspace,'counter.cjs'),'utf8'),'exports.value = 20;\n');
 phase='large-output';const largeRun=await runTask({round:61,kind:'large-output',prompt:'Measure fixed 1 MiB output, then preserve original bytes.',steps:[{name:'bash',args:{command:`${quote(process.execPath)} large.cjs`}}]});
 const outputHash=createHash('sha256');let after=0,bytes=0,chunks=0;
 for(;;){const p=readRunRecords(dataRoot,largeRun.runId,{after,limit:50,kinds:['tool.output']});for(const item of p.records){after=item.seq;const chunksJson=[];for(let offset=0;;){const part=readObjectRange(dataRoot,item.ref,{offset,limit:16384});chunksJson.push(part.bytes);if(part.next===null)break;offset=part.next;}const value=JSON.parse(Buffer.concat(chunksJson).toString()),b=Buffer.from(value.acquired.bytes,'base64');outputHash.update(b);bytes+=b.length;chunks++;}if(!p.more)break;}
 const actual={bytes,chunks,sha256:outputHash.digest('hex')};assert.equal(actual.bytes,large.length);assert.equal(actual.sha256,hash(large));
 save('large-output.json',{...largeRun,actual,expected:{bytes:large.length,sha256:hash(large)},visible:{lines:app.screen().length,bytes:Buffer.byteLength(screen()),text:screen()}});save('storage-large-output.json',inventory(dataRoot));
 phase='post-output-input';const final=await runTask({round:62,kind:'read',prompt:'Measure ordinary input after the large output.',steps:[{name:'read',args:{path:'README.md'}}]});rounds.push(largeRun,final);
 phase='exit';const exit=await app.exit();assert.equal(exit.error,undefined);assert.equal(exit.widthCalibration?.status,'measured');
 save('result.json',{at:new Date().toISOString(),status:'MEASURED',plan:ref(join(out,'plan.json')),firstFrame,rounds,samples,syntheticRequests,realProviderRequests:0,longSessionDurationMs:performance.now()-began,peakObservedRssBytes:Math.max(...samples.map(s=>s.rssBytes)),exit,storage:inventory(dataRoot)});
}catch(error){save('failure.json',{at:new Date().toISOString(),error:String(error),phase,rounds,samples,syntheticRequests,firstFrame});process.exitCode=1;}
finally{clearInterval(sampleTimer);clearTimeout(deadline);if(app)await app.exit();process.stdout.write=originalWrite;}
console.log('Native session evidence retained: '+out);
