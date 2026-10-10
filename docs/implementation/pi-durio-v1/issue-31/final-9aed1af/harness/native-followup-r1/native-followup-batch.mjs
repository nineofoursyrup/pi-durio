#!/usr/bin/env node
// User-launched targeted follow-up: composition + readonly on retained long-session.
// Preserves the original failed batch; no desktop automation or provider calls.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,readlinkSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
const [configArg]=process.argv.slice(2);
if(!configArg)throw Error('Usage: node native-batch.mjs FROZEN_CONFIG');
if(process.platform!=='darwin'||!process.stdin.isTTY||!process.stdout.isTTY||process.env.TERM_PROGRAM!=='Apple_Terminal')throw Error('ACTUAL_MACOS_TERMINAL_REQUIRED');
const digest=b=>createHash('sha256').update(b).digest('hex');
const configBytes=readFileSync(resolve(configArg)),config=JSON.parse(configBytes),out=resolve(config.output);
assert.equal(config.status,'FROZEN_FOR_LOCAL_NATIVE_FOLLOWUP');
assert.equal(config.node,process.execPath);assert.equal(config.nodeVersion,process.version);
assert.equal(config.harnesses['native-followup-batch.mjs'],digest(readFileSync(fileURLToPath(import.meta.url))));
const base=dirname(fileURLToPath(import.meta.url));
for(const [name,sha256] of Object.entries(config.harnesses))assert.equal(digest(readFileSync(join(base,name))),sha256,'HARNESS_CHANGED: '+name);
// This preflight warms filesystem caches. Reported launches are process-cold only.
const inventoryBytes=readFileSync(config.installInventory.path);assert.equal(digest(inventoryBytes),config.installInventory.sha256);
const inventory=JSON.parse(inventoryBytes);
assert.equal(resolve(inventory.root),resolve(config.install));
const installedPaths=[];function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){const path=join(dir,name),relative=join(prefix,name),stat=lstatSync(path);installedPaths.push(relative);if(stat.isDirectory()&&!stat.isSymbolicLink())walk(path,relative);}}walk(config.install);
assert.deepEqual(installedPaths.sort(),inventory.entries.map(r=>r.path).sort(),'INSTALL_FILE_SET_CHANGED');
for(const row of inventory.entries){const path=join(config.install,row.path),stat=lstatSync(path);if(row.type==='symlink'){assert.equal(stat.isSymbolicLink(),true);assert.equal(readlinkSync(path),row.target);}else{assert.equal(stat.mode&0o777,row.mode,'INSTALL_MODE_CHANGED: '+row.path);if(row.type==='directory')assert.equal(stat.isDirectory(),true);else{assert.equal(row.type,'file');assert.equal(stat.isFile(),true);assert.equal(stat.size,row.bytes);assert.equal(digest(readFileSync(path)),row.sha256,'INSTALL_CHANGED: '+row.path);}}}
// Bind this targeted follow-up to the immutable first failure and successful source.
const verifiedJson=reference=>{const bytes=readFileSync(reference.path);assert.equal(bytes.length,reference.bytes);assert.equal(digest(bytes),reference.sha256,'REFERENCE_CHANGED: '+reference.path);return JSON.parse(bytes);};
const originalConfig=verifiedJson(config.originalConfig),originalPlan=verifiedJson(config.originalBatchPlan),originalResult=verifiedJson(config.originalBatchResult);
assert.equal(originalPlan.configSha256,config.originalConfig.sha256);assert.deepEqual(originalPlan.config,originalConfig);
assert.equal(originalConfig.candidate,config.candidate);assert.equal(resolve(originalConfig.install),resolve(config.install));assert.deepEqual(originalConfig.installInventory,config.installInventory);assert.deepEqual(originalConfig.identity,config.identity);
assert.equal(originalResult.status,'MEASURED_WITH_FAILURES');assert.equal(originalResult.steps.find(x=>x.id==='composition')?.exitCode,1);assert.deepEqual(originalResult.notRun,['readonly-data']);
const sourceResult=verifiedJson(config.sourceLongSession.result),sourcePlan=verifiedJson(config.sourceLongSession.plan),sourceLarge=verifiedJson(config.sourceLongSession.largeOutput),identity=verifiedJson(config.identity);
assert.equal(sourceResult.status,'MEASURED');assert.equal(sourceResult.plan.sha256,config.sourceLongSession.plan.sha256);assert.equal(sourceResult.rounds.length,62);assert.equal(sourceResult.realProviderRequests,0);assert.equal(sourceLarge.actual.bytes,sourceLarge.expected.bytes);assert.equal(sourceLarge.actual.sha256,sourceLarge.expected.sha256);
assert.equal(resolve(dirname(config.sourceLongSession.result.path)),resolve(config.sourceLongSession.directory));assert.equal(resolve(config.sourceLongSession.directory),resolve(join(originalConfig.output,'long-session')));
assert.equal(sourcePlan.sourceBuild.sha256,identity.sourceBuild.sha256);assert.equal(identity.candidate,config.candidate);
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS: preserve and inspect the original batch');
mkdirSync(out,{recursive:true});
const save=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const ttyState=()=>{const r=spawnSync('/bin/stty',['-g'],{stdio:['inherit','pipe','pipe']});assert.equal(r.status,0);return r.stdout.toString().trim();};
const originalTty=ttyState();
const env={};for(const key of ['HOME','PATH','TERM','TERM_PROGRAM','TERM_PROGRAM_VERSION','LANG','LC_CTYPE','TMPDIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
save('plan',{at:new Date().toISOString(),config,configSha256:digest(configBytes),originalTty,loadAverage:loadavg(),terminal:{program:process.env.TERM_PROGRAM,version:process.env.TERM_PROGRAM_VERSION,columns:process.stdout.columns,rows:process.stdout.rows,profile:process.env.DURIO_TERMINAL_PROFILE??'UNKNOWN'},operator:'User launches this batch in actual macOS Terminal; subsequent fixture interactions are automated and are not human daily-use acceptance.',environmentNames:Object.keys(env),cacheNote:'Full installation read preflight warms caches; no machine-cold claim.'});
const steps=[['composition','native-composition.mjs'],['readonly-data','readonly-data.mjs']];
let failed=false,exception=null;const results=[];
try{
 for(const [id,script] of steps){
  console.log('\npi-durio local measurement: '+id+' (scripted local fixture; no provider)');
  const args=script==='readonly-data.mjs'?[config.install,config.sourceLongSession.directory,join(out,id)]:[config.install,join(out,id)];
  const before=ttyState(),loadBefore=loadavg(),start=performance.now(),result=spawnSync(process.execPath,[join(base,script),...args],{stdio:'inherit',env,timeout:660000});
  const after=ttyState(),resultPath=join(out,id,'result.json'),measurement=existsSync(resultPath)?JSON.parse(readFileSync(resultPath)):null;
  const row={id,script,elapsedMs:performance.now()-start,loadBefore,loadAfter:loadavg(),exitCode:result.status,signal:result.signal,error:result.error?String(result.error):null,measurementStatus:measurement?.status??null,ttyBefore:before,ttyAfter:after,ttyUnchanged:before===after};
  results.push(row);save(id+'-process',row);
  if(result.status!==0||result.signal||result.error||before!==after||!['MEASURED','PASS'].includes(row.measurementStatus)){failed=true;break;}
 }
}catch(error){failed=true;exception=String(error);}finally{
 const end=ttyState();if(end!==originalTty)spawnSync('/bin/stty',[originalTty],{stdio:'inherit'});
 save('result',{at:new Date().toISOString(),status:failed?'MEASURED_WITH_FAILURES':'MEASURED',exception,steps:results,notRun:steps.slice(results.length).map(x=>x[0]),ttyAtEndBeforeRepair:end,ttyOriginal:originalTty,ttyRepairNeeded:end!==originalTty,providerPolicy:'Only declared synthetic transport; credentials not inherited',humanAcceptance:'NOT CLAIMED'});
}
console.log('\nRetained native measurement evidence: '+out);process.exitCode=failed?1:0;
