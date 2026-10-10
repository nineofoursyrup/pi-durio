#!/usr/bin/env node
/** Human-only cold reopen recheck; headless preparation is separately labelled. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,readlinkSync,openSync,writeSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
const {values}=parseArgs({options:{manifest:{type:'string'},'verify-only':{type:'boolean'},'prepare-only':{type:'boolean'}}});
if(!values.manifest)throw Error('Usage: node recovery-start-terminal-validation.mjs --manifest /absolute/manifest.json [--verify-only|--prepare-only]');
const manifestPath=resolve(values.manifest),manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes),sha=value=>createHash('sha256').update(value).digest('hex');
if(sha(readFileSync(new URL(import.meta.url)))!==manifest.runnerSha256)throw Error('CANDIDATE_RUNNER_CHANGED');
function inventory(root){const files=[];function walk(relative=''){for(const name of readdirSync(join(root,relative)).sort()){const path=join(relative,name),full=join(root,path),stat=lstatSync(full);if(stat.isDirectory())walk(path);else if(stat.isSymbolicLink())files.push({path,sha256:`link:${readlinkSync(full)}`});else if(stat.isFile())files.push({path,sha256:sha(readFileSync(full))});else throw Error(`CANDIDATE_UNEXPECTED_FILE_TYPE: ${path}`);}}walk();return files;}
const actual=inventory(manifest.packageRoot),expectedPaths=new Set(manifest.files.map(file=>file.path)),actualPaths=new Set(actual.map(file=>file.path));
const missing=[...expectedPaths].filter(path=>!actualPaths.has(path)),extra=[...actualPaths].filter(path=>!expectedPaths.has(path));
if(missing.length||extra.length||expectedPaths.size!==manifest.files.length)throw Error(`CANDIDATE_FILE_SET_CHANGED: missing ${JSON.stringify(missing)}; extra ${JSON.stringify(extra)}`);
for(const file of manifest.files)if(actual.find(item=>item.path===file.path)?.sha256!==file.sha256)throw Error(`CANDIDATE_CHANGED: ${file.path}`);
if(values['verify-only']){console.log(JSON.stringify({verified:true,commit:manifest.commit,files:actual.length,packageRoot:manifest.packageRoot}));process.exit(0);}
if(!values['prepare-only']&&(process.platform!=='darwin'||process.arch!=='arm64'||process.env.TERM_PROGRAM!=='Apple_Terminal'||!process.stdin.isTTY||!process.stdout.isTTY))throw Error('REAL_MACOS_TERMINAL_REQUIRED');
const root=join(manifest.evidenceRoot,values['prepare-only']?'headless-preparation':'manual',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(root,{recursive:true,mode:0o700});
const save=(name,value)=>writeFileSync(join(root,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Cold recovery startup fixture; deterministic offline transport only.\n',{flag:'wx'});
const binding={candidate:manifest.commit,manifest:manifestPath,manifestSha256:sha(manifestBytes),runnerSha256:manifest.runnerSha256,packageRoot:manifest.packageRoot};
save('environment.json',{at:new Date().toISOString(),...binding,node:process.version,platform:process.platform,arch:process.arch,TERM_PROGRAM:process.env.TERM_PROGRAM??null,columns:process.stdout.columns??null,rows:process.stdout.rows??null,paidProvider:'NOT RUN'});
const {runCodingTask,TaskControl,readQueue,readAcceptedTasks,readRun}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/runtime.js')).href);
const {scriptedTransport}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/offline.js')).href);
const controller=new AbortController(),control=new TaskControl();let prepRequests=0,admissions;
console.log('准备独立 stopped + frozen fixture（headless，不计入原生按键验收）…');
const original=await runCodingTask({workspace,dataRoot,input:'恢复启动准备',mode:'offline',control,signal:controller.signal,cancellation:'stop',transport:async(_url,init)=>new Promise((_resolve,reject)=>{
  prepRequests++;init.signal.addEventListener('abort',()=>reject(Error('headless fixture stop')),{once:true});
  admissions=(async()=>{const target=control.target();assert.ok(target);for(const [id,kind,input] of [['frozen-follow','follow-up','冻结后续'],['frozen-compact','compact','冻结压缩']])await control.submit({id,kind,input,target});controller.abort();})();
  admissions.catch(reject);
})});await admissions;
const frozen=readQueue(dataRoot,{limit:200}).items;
assert.equal(original.status,'aborted');assert.equal(original.cleanup,'confirmed');assert.equal(prepRequests,1);assert.equal(frozen.length,2);assert.ok(frozen.every(item=>item.status==='frozen'&&item.target.runId===original.runId));
save('preparation.json',{at:new Date().toISOString(),...binding,method:'Real public offline coding runtime and TaskControl; headless fixture preparation only',native:'NOT RUN',workspace,dataRoot,original,prepRequests,queue:frozen,fixtureFiles:[...inventory(workspace).map(file=>({...file,path:join('project',file.path)})),...inventory(dataRoot).map(file=>({...file,path:join('data',file.path)}))]});
if(values['prepare-only']){console.log(JSON.stringify({prepared:true,native:'NOT RUN',root,runId:original.runId,queue:frozen.length}));process.exit(0);}
console.log(`\n#17 恢复启动 + 新任务补测 · 候选 ${manifest.commit}\n1. 按 Enter 冷重开；等待恢复面板。应直接显示，不需要 Ctrl+L。\n2. 在恢复面板按 e 明确结束旧工作；等出现 ended。\n3. 输入“全新任务”并按 Enter；等显示已完成。\n4. 输入 /queue 回车，用 → 查看两项旧请求仍为冻结；Esc 关闭。\n5. 输入 /exit 回车退出。若有草稿退出确认面板，再按 Enter。\n每次等画面稳定再按键。若启动显示 WIDTH_CPR_TIMEOUT，保留首次失败；可以 Ctrl+L 后继续其余动作，评分请填 F 并说明。\n无需重做 queue-stop、IME、复制或窗口缩放。`);
const question=createInterface({input:process.stdin,output:process.stdout});await question.question('按 Enter 开始：');question.close();
const {ReadOnlyTui}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/tui/app.js')).href);
const {ProcessTerminal}=await import(pathToFileURL(join(manifest.packageRoot,'node_modules/@earendil-works/pi-tui/dist/index.js')).href);
const terminal=new ProcessTerminal(),start=terminal.start.bind(terminal),events=openSync(join(root,'input.jsonl'),'wx',0o600),output=openSync(join(root,'output.ansi'),'wx',0o600);
const inputs=[],prompts=[];terminal.start=(input,resize)=>start(data=>{const event={at:new Date().toISOString(),data};inputs.push(event);writeSync(events,JSON.stringify(event)+'\n');input(data);},resize);
const stty=()=>{const result=spawnSync('/bin/stty',['-g'],{stdio:['inherit','pipe','pipe'],encoding:'utf8'});if(result.status!==0)throw Error(`STTY_READ_FAILED: ${result.stderr}`);return result.stdout.trim();};
const before={raw:!!process.stdin.isRaw,stty:stty()},stdout=process.stdout.write;
process.stdout.write=function(...args){writeSync(output,typeof args[0]==='string'?args[0]:Buffer.from(args[0]));return stdout.apply(this,args);};
let result;
try{const app=new ReadOnlyTui({workspace,dataRoot,runId:original.runId,mode:'offline',coding:true,terminal,draftRoot:join(root,'drafts'),transport:async(url,init)=>{prompts.push(JSON.parse(String(init.body)));return scriptedTransport([]).fetch(url,init);}});try{app.start();result=await app.closed;}finally{await app.exit();}}
finally{process.stdout.write=stdout;closeSync(events);closeSync(output);}
const after={raw:!!process.stdin.isRaw,stty:stty()},tasks=readAcceptedTasks(dataRoot,{limit:200}).tasks,queue=readQueue(dataRoot,{limit:200}).items,source=await readRun(dataRoot,original.runId),newTask=tasks.find(task=>task.input==='全新任务'),ansi=readFileSync(join(root,'output.ansi'),'utf8');
const requiredFacts={
  recoveryReportSaved:source.records.some(record=>record.kind==='recovery.report'),
  noWidthTimeout:!ansi.includes('WIDTH_CPR_TIMEOUT'),noRetryNeeded:!inputs.some(input=>input.data==='\x0c'),measured:result.widthCalibration?.status==='measured',
  sourceExplicitlyEnded:tasks.find(task=>task.runId===original.runId)?.status==='ended',sourceOriginalPreserved:source.result.status==='aborted',
  newTaskCompleted:!!newTask&&newTask.runId!==original.runId&&newTask.status==='completed'&&result.result?.runId===newTask.runId&&result.result.status==='completed',
  newTaskOnly:prompts.length===1&&prompts[0].messages.findLast(message=>message.role==='user')?.content==='全新任务'&&!JSON.stringify(prompts).includes('冻结后续')&&!JSON.stringify(prompts).includes('冻结压缩'),
  oldQueueFrozen:frozen.every(previous=>queue.some(item=>item.requestId===previous.requestId&&item.status==='frozen'&&item.target.runId===original.runId)),
  rawRestored:before.raw===after.raw,sttyRestored:before.stty===after.stty
};
save('provider-payloads.json',prompts);save('machine.json',{at:new Date().toISOString(),...binding,result,before,after,tasks,queue,source,providerRequests:prompts.length,requiredFacts,requiredFactsComplete:Object.values(requiredFacts).every(value=>value===true),nativeObservation:'UNVERIFIED by machine facts'});
console.log(`\n必需事实 ${Object.values(requiredFacts).every(value=>value===true)}；raw/stty ${requiredFacts.rawRestored}/${requiredFacts.sttyRestored}；证据 ${root}`);
const gaps=Object.entries(requiredFacts).filter(([,value])=>value!==true).map(([key])=>key);if(gaps.length)console.log('未满足：'+gaps.join(', '));
const response=createInterface({input:process.stdin,output:process.stdout});const answer=await response.question('P=全部观察通过 / F=失败 / U=未知，可直接附中文说明：');response.close();
const status={P:'PASS',F:'FAIL',U:'UNKNOWN'}[answer.trim().charAt(0).toUpperCase()]??'UNKNOWN';
save('operator.json',{at:new Date().toISOString(),...binding,status,answer,source:'human macOS Terminal operator'});
save('workflow.json',{...binding,operator:status,machine:Object.values(requiredFacts).every(value=>value===true)?'PASS':'FAIL',accepted:status==='PASS'&&Object.values(requiredFacts).every(value=>value===true),paidProvider:'NOT RUN',notes:'Headless preparation is separate. Original failures and r1 evidence are retained; native cold start and actual new task are separate required facts.'});
console.log(`完成记录：${root}`);
