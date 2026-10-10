#!/usr/bin/env node
// Preparation harness only. Run once against an independently frozen installation.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadavg} from 'node:os';

const [installArg,outputArg] = process.argv.slice(2);
if (!installArg || !outputArg) throw Error('Usage: node process-startup.mjs INSTALL_ROOT NEW_OUTPUT');
const install = resolve(installArg), out = resolve(outputArg);
if (existsSync(out)) throw Error('OUTPUT_ALREADY_EXISTS: preserve the original measurement');
const cli = join(install,'node_modules/pi-durio/dist/src/cli.js');
const sourceBuild = join(install,'node_modules/pi-durio/dist/execution/source-build.json');
const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const ref = path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const save = (name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
mkdirSync(out);mkdirSync(join(out,'home'));mkdirSync(join(out,'tmp'));
const environment = {HOME:join(out,'home'),TMPDIR:join(out,'tmp'),PATH:dirname(process.execPath)+':/usr/bin:/bin',LANG:'en_US.UTF-8',TERM:'dumb'};
const plan = {at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),node:process.execPath,nodeVersion:process.version,
 cli:ref(cli),sourceBuild:ref(sourceBuild),environment,
 workloads:[{id:'help',arguments:['--help'],repetitions:7},{id:'missing-store-history',arguments:['history','--data-root',join(out,'absent-data-root'),'--format','json'],repetitions:7}],
 timeoutMs:30000,outputLimitBytes:2*1024*1024,
 method:'New child process each repetition, measured by parent hrtime from spawnSync call through child termination. Outputs go to pipes. No OS cache purge; not machine-cold and not native screen latency.',
 limitations:['The absent-store history path must retain missing-source coverage; it is not a successful query of an initialized dataset.','Each process gets only the listed minimal environment; no inherited model key or user HOME.','No provider/runtime task is requested; local scheduling and process exit costs are included.']};
save('plan.json',plan);
const rows=[];
for(const workload of plan.workloads){
 for(let repetition=1;repetition<=workload.repetitions;repetition++){
  const loadBefore=loadavg(),begin=process.hrtime.bigint();
  const result=spawnSync(process.execPath,[cli,...workload.arguments],{env:environment,cwd:out,timeout:plan.timeoutMs,maxBuffer:plan.outputLimitBytes});
  const elapsedMs=Number(process.hrtime.bigint()-begin)/1e6;
  const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
  const prefix=`${workload.id}-${repetition}`;
  writeFileSync(join(out,prefix+'.stdout'),stdout,{flag:'wx'});writeFileSync(join(out,prefix+'.stderr'),stderr,{flag:'wx'});
  let interpretation=null;
  if(workload.id==='missing-store-history'){
   try {const value=JSON.parse(stdout.toString());interpretation={items:value.items?.length,coverage:value.coverage};}
   catch(error){interpretation={parseError:String(error)};}
  }
  const row={workload:workload.id,repetition,elapsedMs,loadBefore,loadAfter:loadavg(),exitCode:result.status,signal:result.signal,error:result.error?String(result.error):null,
   stdout:{bytes:stdout.length,sha256:hash(stdout)},stderr:{bytes:stderr.length,sha256:hash(stderr)},interpretation};
  rows.push(row);save(prefix+'.json',row);
 }
}
const summary=plan.workloads.map(workload=>{
 const samples=rows.filter(row=>row.workload===workload.id),durations=samples.map(row=>row.elapsedMs).sort((a,b)=>a-b);
 return {workload:workload.id,repetitions:samples.length,failures:samples.filter(row=>row.exitCode!==0||row.error||row.signal).length,
  minMs:durations[0],medianMs:durations[Math.floor(durations.length/2)],maxMs:durations.at(-1),
  firstObservedMs:samples[0].elapsedMs,allObservedMs:samples.map(row=>row.elapsedMs)};
});
const result={at:new Date().toISOString(),plan:ref(join(out,'plan.json')),rows,summary,
 absentDataRootStillAbsent:!existsSync(join(out,'absent-data-root')),
 limits:plan.limitations,status:rows.every(row=>row.exitCode===0&&!row.error&&!row.signal)?'MEASURED':'MEASURED_WITH_FAILURES',
 interpretation:'No numeric acceptance threshold. Every sample, including failures, is retained; these values only characterize the two named local process paths.'};
save('result.json',result);console.log(JSON.stringify({output:out,summary,status:result.status}));
