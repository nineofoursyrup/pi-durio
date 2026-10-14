#!/usr/bin/env node
// Declared headless resource workload. Actual public Pi execution, synthetic transport only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync,lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadavg} from 'node:os';
const [installArg,outArg]=process.argv.slice(2);
if(!installArg||!outArg)throw Error('Usage: node headless-session.mjs INSTALL_ROOT NEW_OUTPUT');
const install=resolve(installArg),out=resolve(outArg);
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
mkdirSync(out);const workspace=join(out,'workspace'),dataRoot=join(out,'data');mkdirSync(workspace);
const sha=b=>createHash('sha256').update(b).digest('hex');
const ref=p=>{const b=readFileSync(p);return{path:p,bytes:b.length,sha256:sha(b)};};
const save=(name,v)=>writeFileSync(join(out,name),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const event=v=>appendFileSync(join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),performanceMs:performance.now(),...v})+'\n',{mode:0o600});
function inventory(root){
 const rows=[];function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){const p=join(dir,name),r=join(prefix,name),s=lstatSync(p);if(s.isSymbolicLink())rows.push({path:r,kind:'symlink',target:readlinkSync(p)});else if(s.isDirectory())walk(p,r);else if(s.isFile())rows.push({path:r,kind:'file',bytes:s.size,allocated:s.blocks*512,sha256:sha(readFileSync(p))});}}
 if(existsSync(root))walk(root);return{rows,logicalBytes:rows.reduce((n,r)=>n+(r.bytes??0),0),allocatedByPathBytes:rows.reduce((n,r)=>n+(r.allocated??0),0)};
}
const large=Buffer.alloc(1024*1024,0x78);Buffer.from('DURIO_BEGIN\n').copy(large,0);Buffer.from('\nDURIO_MIDDLE\n').copy(large,512*1024);Buffer.from('\nDURIO_END\n').copy(large,large.length-11);
writeFileSync(join(workspace,'README.md'),'Fixed headless local measurement fixture; synthetic transport, no model inference.\n');
writeFileSync(join(workspace,'counter.cjs'),'exports.value = 0;\n');writeFileSync(join(workspace,'large.bin'),large);
writeFileSync(join(workspace,'large.cjs'),"process.stdout.write(require('node:fs').readFileSync('large.bin'));\n");
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const plan=Array.from({length:60},(_,i)=>{
 const round=i+1,cycle=Math.floor(i/3),kind=i%3,check=`require('node:assert/strict').equal(require('./counter.cjs').value,${cycle+1});console.log('counter-${cycle+1}-ok')`;
 const steps=kind===0?[{name:'read',args:{path:'README.md'}}]:kind===1?[{name:'edit',args:{path:'counter.cjs',edits:[{oldText:`exports.value = ${cycle};`,newText:`exports.value = ${cycle+1};`}]}}]:[{name:'bash',args:{command:quote(process.execPath)+' -e '+quote(check)}}];
 return{round,kind:['read','edit','check'][kind],prompt:`Headless measure round ${round}: ${['read README.md','increment the declared local counter','check the declared local counter'][kind]}.`,steps};
});
const require=createRequire(join(install,'package.json')),product=require.resolve('pi-durio');
save('plan.json',{at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),product:ref(product),sourceBuild:ref(join(install,'node_modules/pi-durio/dist/execution/source-build.json')),node:process.execPath,nodeVersion:process.version,workload:'headless installed runCodingTask, one host process, 60 completed contexts followed by a 1 MiB tool output and ordinary next context',terminal:'NOT_USED; native Terminal acceptance remains separate',idleDurationMs:30000,repetitions:plan,minimumLongDurationMs:300000,minimumRoundIntervalMs:5000,perRoundTimeoutMs:60000,overallTimeoutMs:900000,largeOutput:{bytes:large.length,sha256:sha(large),command:quote(process.execPath)+' large.cjs'},fixture:inventory(workspace),loadBefore:loadavg(),limits:['Synthetic transport has no provider inference/network latency; usage is synthetic, never a bill or real token estimate.','Host Node RSS excludes shell/tool child processes and Terminal.app; one-second samples may miss short peaks.','Fixture creation, event logging and synchronous storage hashing add disclosed unseparated overhead.','No TUI or native Terminal rendering, IME, key handling, or daily-use acceptance is measured.','Five-minute process lifetime is not hours-long stability evidence.','Originals are retained; expected disk growth is not a leak claim.']});
save('storage-empty.json',inventory(dataRoot));
const {runCodingTask}=await import(pathToFileURL(product).href);
const {scriptedTransport}=await import(pathToFileURL(require.resolve('pi-durio/offline')).href);
const {readRunRecords,readObjectRange}=await import(pathToFileURL(require.resolve('pi-durio/query')).href);
function readJson(body){const parts=[];for(let offset=0;;){const page=readObjectRange(dataRoot,body,{offset,limit:16384});parts.push(page.bytes);if(page.next===null)break;offset=page.next;}return JSON.parse(Buffer.concat(parts).toString());}
let phase='idle',syntheticRequests=0,contextRunId,activeController,stopReason;
const samples=[],rounds=[];
const sampleTimer=setInterval(()=>{const s={performanceMs:performance.now(),phase,rssBytes:process.memoryUsage().rss,loadAverage:loadavg()};samples.push(s);event({kind:'rss',...s});},1000);
const requestStop=reason=>{stopReason??=reason;activeController?.abort(reason);};
const onInt=()=>requestStop('SIGINT'),onTerm=()=>requestStop('SIGTERM');process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
const deadline=setTimeout(()=>requestStop('OVERALL_TIMEOUT'),900000);
async function pause(ms){for(let left=ms;left>0;left-=Math.min(left,200)){if(stopReason)throw Error(stopReason);await delay(Math.min(left,200));}}
async function runOne(item){
 if(stopReason)throw Error(stopReason);const transport=scriptedTransport(item.steps),controller=new AbortController();activeController=controller;
 const timer=setTimeout(()=>controller.abort('ROUND_TIMEOUT'),60000),begin=performance.now();let result;
 try{result=await runCodingTask({workspace,dataRoot,input:item.prompt,mode:'offline',contextRunId,signal:controller.signal,cancellation:'stop',transport:async(...args)=>{syntheticRequests++;return transport.fetch(...args);}});}finally{clearTimeout(timer);activeController=undefined;}
 event({kind:'task-result',round:item.round,result});assert.equal(controller.signal.aborted,false,'ROUND_CANCELLED');assert.equal(result.status,'completed');assert.equal(result.cleanup,'confirmed');contextRunId=result.runId;
 const facts=readRunRecords(dataRoot,result.runId,{limit:50,kinds:['tool.result','tool.error','shell.completed']});assert.equal(facts.more,false);assert.equal(facts.records.filter(r=>r.kind==='tool.error').length,0);
 const toolResults=facts.records.filter(r=>r.kind==='tool.result').map(r=>readJson(r.ref));assert.equal(toolResults.length,1);assert.notEqual(toolResults[0].result.isError,true);
 if(item.steps[0].name==='bash'){const shells=facts.records.filter(r=>r.kind==='shell.completed').map(r=>readJson(r.ref).acquired);assert.equal(shells.length,1);assert.equal(shells[0].exitCode,0);assert.equal(shells[0].completeness,'complete');}
 const row={...item,runId:result.runId,sessionId:result.sessionId,elapsedMs:performance.now()-begin,requests:transport.calls.length,payloadBytes:transport.calls.map(p=>Buffer.byteLength(JSON.stringify(p))),result,toolResults:facts.records};event({kind:'round',...row});return row;
}
let longStarted=null,sixtyRoundsDurationMs=null;
try{
 await pause(30000);phase='long-session';longStarted=performance.now();
 for(const item of plan){const begin=performance.now(),row=await runOne(item);rounds.push(row);save(`round-${String(item.round).padStart(2,'0')}.json`,row);if(item.round===1||item.round%10===0)save(`storage-round-${item.round}.json`,inventory(dataRoot));await pause(Math.max(0,5000-(performance.now()-begin)));}
 sixtyRoundsDurationMs=performance.now()-longStarted;assert.ok(sixtyRoundsDurationMs>=300000);assert.equal(readFileSync(join(workspace,'counter.cjs'),'utf8'),'exports.value = 20;\n');
 phase='large-output';const big=await runOne({round:61,kind:'large-output',prompt:'Headless measure fixed 1 MiB output and retain all acquired bytes.',steps:[{name:'bash',args:{command:quote(process.execPath)+' large.cjs'}}]});rounds.push(big);
 const outputHash=createHash('sha256');let after=0,bytes=0,chunks=0;
 for(;;){const page=readRunRecords(dataRoot,big.runId,{after,limit:50,kinds:['tool.output']});for(const item of page.records){after=item.seq;const value=readJson(item.ref),b=Buffer.from(value.acquired.bytes,'base64');outputHash.update(b);bytes+=b.length;chunks++;}if(!page.more)break;}
 const actual={bytes,chunks,sha256:outputHash.digest('hex')};assert.equal(actual.bytes,large.length);assert.equal(actual.sha256,sha(large));save('large-output.json',{...big,actual,expected:{bytes:large.length,sha256:sha(large)}});save('storage-large-output.json',inventory(dataRoot));
 phase='post-output-context';const final=await runOne({round:62,kind:'read',prompt:'Headless measure ordinary next context after the large output.',steps:[{name:'read',args:{path:'README.md'}}]});rounds.push(final);
 phase='finished';save('result.json',{at:new Date().toISOString(),status:'MEASURED',workload:'HEADLESS_PUBLIC_RUNTIME_SYNTHETIC_TRANSPORT',plan:ref(join(out,'plan.json')),rounds,samples,syntheticRequests,realProviderRequests:0,sixtyRoundsDurationMs,totalAfterIdleMs:performance.now()-longStarted,peakObservedRssBytes:Math.max(...samples.map(s=>s.rssBytes)),storage:inventory(dataRoot),nativeTerminal:'NOT_RUN',dailyUseAcceptance:'NOT_GRANTED'});
}catch(error){save('failure.json',{at:new Date().toISOString(),status:'MEASURED_WITH_FAILURES',error:String(error),phase,stopReason,rounds,samples,syntheticRequests,longStarted,sixtyRoundsDurationMs,remainingPlan:plan.filter(x=>!rounds.some(y=>y.round===x.round)).map(x=>({round:x.round,status:'NOT RUN'})),realProviderRequests:0,nativeTerminal:'NOT_RUN'});process.exitCode=1;}
finally{clearInterval(sampleTimer);clearTimeout(deadline);process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);}
console.log(JSON.stringify({output:out,completedRounds:rounds.length,realProviderRequests:0,nativeTerminal:'NOT_RUN'}));
