#!/usr/bin/env node
// Read-only public query / explicit local full-output acquisition measurements.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,readdirSync,readlinkSync,openSync,writeSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [installArg,sessionArg,outArg]=process.argv.slice(2);
if(!installArg||!sessionArg||!outArg)throw Error('Usage: node readonly-data.mjs INSTALL_ROOT MEASURED_NATIVE_SESSION NEW_OUTPUT');
const install=resolve(installArg),session=resolve(sessionArg),out=resolve(outArg),dataRoot=join(session,'data');
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
const parent=JSON.parse(readFileSync(join(session,'result.json'),'utf8'));
assert.equal(parent.status,'MEASURED');const large=JSON.parse(readFileSync(join(session,'large-output.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex'),ref=p=>{const b=readFileSync(p);return{path:p,bytes:b.length,sha256:sha(b)};};
const save=(name,v)=>writeFileSync(join(out,name),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
function inventory(root){const rows=[];function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){const p=join(dir,name),r=join(prefix,name),s=lstatSync(p);if(s.isSymbolicLink())rows.push({path:r,kind:'symlink',target:readlinkSync(p)});else if(s.isDirectory())walk(p,r);else if(s.isFile())rows.push({path:r,bytes:s.size,sha256:sha(readFileSync(p))});}}walk(root);return rows;}
mkdirSync(out);const require=createRequire(join(install,'package.json'));
const product=require.resolve('pi-durio/query');
save('plan.json',{at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),product:ref(product),sourceBuild:ref(join(install,'node_modules/pi-durio/dist/execution/source-build.json')),node:process.execPath,nodeVersion:process.version,parentResult:ref(join(session,'result.json')),largeOutput:ref(join(session,'large-output.json')),
 queryWorkload:'30 in-process calls in ten repeated cycles: history limit 10, large-run evidence limit 20, first acquired output evidence decoded slice limit 1024. Exact API arguments are retained for each call.',
 exportWorkload:'Five explicit streaming acquisitions to new local binary files of every large-run tool.output acquired byte, read through the installed public readRunRecords and readObjectRange APIs. This harness composes bounded product reads; it is not a claim that the CLI export command provides a whole-run binary export.',
 readOnly:'Hash complete dataRoot path/file/link inventory before and after. Exports and measurements are written outside the retained dataRoot.',
 timing:'Each query measures synchronous public call elapsed time. Each export measures enumeration, validated public object reads, JSON/base64 decode and output writes through close. OS cache is not purged; fsync is not requested.',
 limits:['No network/model time.','The recorded Node resourceUsage deltas apply to this process, and are OS-reported counters, not isolated filesystem latency.','No counterfactual without tracing, so tracing overhead is not separately measured.','Five exports read the same retained data in order; cache effects are retained.']});
const before=inventory(dataRoot);save('source-before.json',before);
const api=await import(pathToFileURL(product).href);
const refs=api.queryEvidence(dataRoot,large.runId,{limit:20,kinds:['tool.output']});assert.ok(refs.items.length);
const queries=[],exports=[];
try{
 for(let i=0;i<30;i++){
  const kind=i%3,method=['queryHistory','queryEvidence','readEvidence'][kind];
  const args=kind===0?[dataRoot,{}, {limit:10}]:kind===1?[dataRoot,large.runId,{limit:20}]:[dataRoot,refs.items[0].id,{limit:1024,decodedOutput:true}];
  const begin=performance.now(),value=api[method](...args),elapsedMs=performance.now()-begin;
  if(kind===0)assert.ok(value.items.length<=10);if(kind===1)assert.ok(value.items.length<=20);if(kind===2){assert.equal(value.state,'complete');assert.ok(Buffer.from(value.bytes,'base64').length<=1024);}
  const text=JSON.stringify(value);queries.push({index:i+1,method,arguments:args,elapsedMs,outputBytes:Buffer.byteLength(text),outputSha256:sha(text)});
  save(`query-${String(i+1).padStart(2,'0')}.json`,{measurement:queries.at(-1),result:value});
 }
 for(let i=1;i<=5;i++){
  const path=join(out,`large-output-${i}.bin`),usageBefore=process.resourceUsage(),begin=performance.now();
  const fd=openSync(path,'wx',0o600),hash=createHash('sha256');let after=0,bytes=0,chunks=0;
  try{for(;;){const p=api.readRunRecords(dataRoot,large.runId,{after,limit:50,kinds:['tool.output']});for(const item of p.records){after=item.seq;const raw=[];for(let offset=0;;){const part=api.readObjectRange(dataRoot,item.ref,{offset,limit:16384});raw.push(part.bytes);if(part.next===null)break;offset=part.next;}const value=JSON.parse(Buffer.concat(raw).toString()),b=Buffer.from(value.acquired.bytes,'base64');for(let written=0;written<b.length;)written+=writeSync(fd,b,written,b.length-written);hash.update(b);bytes+=b.length;chunks++;}if(!p.more)break;}}finally{closeSync(fd);}
  const elapsedMs=performance.now()-begin,usageAfter=process.resourceUsage(),sha256=hash.digest('hex');
  const row={repetition:i,path,elapsedMs,bytes,chunks,sha256,resourceUsageBefore:usageBefore,resourceUsageAfter:usageAfter,resourceUsageCounterDelta:Object.fromEntries(['userCPUTime','systemCPUTime','fsRead','fsWrite','voluntaryContextSwitches','involuntaryContextSwitches'].map(k=>[k,usageAfter[k]-usageBefore[k]]))};
  exports.push(row);save(`export-${i}.json`,row);assert.equal(bytes,large.expected.bytes);assert.equal(sha256,large.expected.sha256);
 }
 const after=inventory(dataRoot);save('source-after.json',after);assert.deepEqual(after,before);
 save('result.json',{at:new Date().toISOString(),status:'MEASURED',queries,exports,sourceUnchanged:true,plan:ref(join(out,'plan.json'))});
}catch(error){save('failure.json',{at:new Date().toISOString(),status:'MEASURED_WITH_FAILURES',error:String(error),queries,exports,sourceAfter:inventory(dataRoot)});throw error;}
console.log(JSON.stringify({output:out,queries:queries.length,exports:exports.length,status:'MEASURED'}));
