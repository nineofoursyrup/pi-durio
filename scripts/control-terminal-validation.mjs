#!/usr/bin/env node
/** Human-run #17 macOS Terminal evidence. No UI automation and no model network access. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,readlinkSync,openSync,writeSync,closeSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
const {values}=parseArgs({options:{manifest:{type:'string'},'verify-only':{type:'boolean'}}});
if(!values.manifest)throw Error('Usage: node control-terminal-validation.mjs --manifest /absolute/manifest.json [--verify-only]');
const manifest=JSON.parse(readFileSync(resolve(values.manifest),'utf8')),sha=value=>createHash('sha256').update(value).digest('hex');
if(sha(readFileSync(new URL(import.meta.url)))!==manifest.runnerSha256)throw Error('CANDIDATE_RUNNER_CHANGED');
const actual=[];
function walk(relative=''){for(const name of readdirSync(join(manifest.packageRoot,relative)).sort()){const path=join(relative,name),full=join(manifest.packageRoot,path),stat=lstatSync(full);if(stat.isDirectory())walk(path);else if(stat.isSymbolicLink())actual.push({path,sha256:`link:${readlinkSync(full)}`});else if(stat.isFile())actual.push({path,sha256:sha(readFileSync(full))});else throw Error(`UNSUPPORTED_FILE: ${path}`);}}
walk();if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw Error('CANDIDATE_INSTALLATION_CHANGED');
if(values['verify-only']){console.log(JSON.stringify({verified:true,commit:manifest.commit,files:actual.length,packageRoot:manifest.packageRoot}));process.exit(0);}
if(process.platform!=='darwin'||process.arch!=='arm64'||process.env.TERM_PROGRAM!=='Apple_Terminal'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('REAL_MACOS_TERMINAL_REQUIRED');
const root=join(manifest.evidenceRoot,'manual',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(root,{recursive:true,mode:0o700});
const workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);
writeFileSync(join(workspace,'README.md'),'#17 deterministic local fixture; no inference or network.\n');
writeFileSync(join(workspace,'queue.cjs'),"const fs=require('node:fs');fs.appendFileSync('queue-starts.txt','once\\n');console.log('QUEUE TOOL WAITING: enter steer and two follow-ups, withdraw the first follow-up');const timer=setInterval(()=>{if(fs.existsSync('release-queue.txt')){clearInterval(timer);console.log('QUEUE TOOL FINISHED ONCE');}},100);");
writeFileSync(join(workspace,'stop.cjs'),"const fs=require('node:fs');fs.appendFileSync('stop-starts.txt','once\\n');console.log('STOP TOOL WAITING: queue follow-up and /compact, then Ctrl+C');setInterval(()=>{},1000);");
writeFileSync(join(root,'environment.json'),JSON.stringify({at:new Date().toISOString(),candidate:manifest.commit,manifest:resolve(values.manifest),node:process.version,platform:process.platform,arch:process.arch,TERM_PROGRAM:process.env.TERM_PROGRAM,TERM_PROGRAM_VERSION:process.env.TERM_PROGRAM_VERSION,columns:process.stdout.columns,rows:process.stdout.rows,paidProvider:'NOT RUN; deterministic transport'},null,2));
writeFileSync(join(root,'plan.json'),JSON.stringify({candidate:manifest.commit,native:'NOT RUN until operator observations',items:['Q1 busy steer and independent follow-up/withdraw','Q2 Ctrl+X and Ctrl+C native delivery','Q3 stop freezes queue and is not idle-exit first press','Q4 reopen recovery panel does not unlock; explicit end and new task do not consume old queue']},null,2));
const {ReadOnlyTui}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/tui/app.js')).href);
const {scriptedTransport}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/offline.js')).href);
const {readQueue,readAcceptedTasks,readRun}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/runtime.js')).href);
const {ProcessTerminal}=await import(pathToFileURL(join(manifest.packageRoot,'node_modules/@earendil-works/pi-tui/dist/index.js')).href);
const prompts=[];let request=0;
const transport=async(url,init)=>{
  const payload=JSON.parse(String(init.body));prompts.push(payload);request++;
  const user=payload.messages.findLast(message=>message.role==='user')?.content;
  const hasTool=payload.messages.some(message=>message.role==='tool');
  const command=!hasTool&&String(user).includes('队列开始')?'queue.cjs':!hasTool&&String(user).includes('停止开始')?'stop.cjs':undefined;
  return scriptedTransport(command?[{name:'bash',args:{command:`'${process.execPath.replaceAll("'","'\\''")}' ${command}`}}]:[]).fetch(url,init);
};
const stty=()=>spawnSync('/bin/stty',['-g'],{stdio:['inherit','pipe','pipe'],encoding:'utf8'}).stdout.trim();
const queue=()=>{try{return readQueue(dataRoot,{limit:200}).items;}catch{return [];}};
const release=setInterval(()=>{const items=queue();if(items.filter(item=>item.kind==='follow-up').length>=2&&items.some(item=>item.kind==='follow-up'&&item.status==='withdrawn')&&!existsSync(join(workspace,'release-queue.txt')))writeFileSync(join(workspace,'release-queue.txt'),'Fixture released after saved queue withdrawal; no UI automation\n');},150);
async function phase(name,runId,steps){
  const folder=join(root,name);mkdirSync(folder);
  console.log(`\n#17 ${name} · 候选 ${manifest.commit}\n${steps.join('\n')}\n每次输入先等画面稳定再按提交键；显示校准提示未应用时，确认画面后重新按该次键。\n只输入本卡 fixture 文本；无需重复 IME/复制/缩放验收。`);
  const question=createInterface({input:process.stdin,output:process.stdout});await question.question('按 Enter 开始：');question.close();
  const events=openSync(join(folder,'input.jsonl'),'wx',0o600),screen=openSync(join(folder,'output.ansi'),'wx',0o600);
  const terminal=new ProcessTerminal(),start=terminal.start.bind(terminal);const controls=[];
  terminal.start=(input,resize)=>start(data=>{const event={at:new Date().toISOString(),data};writeSync(events,JSON.stringify(event)+'\n');if(['\x03','\x18','\r'].includes(data))controls.push(event);input(data);},resize);
  const before={raw:!!process.stdin.isRaw,stty:stty()},beforeRequests=request;
  const stdout=process.stdout.write;process.stdout.write=function(...args){writeSync(screen,typeof args[0]==='string'?args[0]:Buffer.from(args[0]));return stdout.apply(this,args);};
  let result;
  try{const app=new ReadOnlyTui({workspace,dataRoot,mode:'offline',coding:true,runId,transport,terminal,draftRoot:join(root,'drafts')});try{app.start();result=await app.closed;}finally{await app.exit();}}
  finally{process.stdout.write=stdout;closeSync(events);closeSync(screen);}
  const after={raw:!!process.stdin.isRaw,stty:stty()},tasks=readAcceptedTasks(dataRoot,{limit:200}).tasks,items=queue();
  const readback=result.result?await readRun(dataRoot,result.result.runId):undefined;
  const firstTask=tasks.find(task=>task.input==='队列开始'),follow=items.find(item=>item.input==='保留后续'),withdrawn=items.find(item=>item.input==='撤回后续'),steer=items.find(item=>item.input==='补充当前任务'),stopTask=tasks.find(task=>task.input==='停止开始');
  const sourceFacts=firstTask?.runId?await readRun(dataRoot,firstTask.runId):undefined;
  const stopFacts=stopTask?.runId?await readRun(dataRoot,stopTask.runId):undefined;
  const stopClosed=stopFacts?.records.findLast(record=>record.kind==='run.closed');
  const requiredFacts=name==='queue-stop'?{
    codingAccepted:firstTask?.authorization?.execution==='trusted-local-coding',
    actualBash:sourceFacts?.records.some(record=>record.kind==='tool.intent'&&record.data.tool==='bash')===true,
    actualLocalEffect:existsSync(join(workspace,'queue-starts.txt'))&&readFileSync(join(workspace,'queue-starts.txt'),'utf8')==='once\n',
    steerSameTask:steer?.status==='applied'&&steer.taskId===firstTask?.taskId,
    withdrawn:withdrawn?.status==='withdrawn'&&!JSON.stringify(prompts).includes('撤回后续'),
    independentFollow:follow?.status==='applied'&&follow.runId&&follow.runId!==firstTask?.runId&&follow.taskId!==firstTask?.taskId&&tasks.find(task=>task.taskId===follow.taskId)?.status==='completed',
    ctrlXDelivered:controls.filter(input=>input.data==='\x18').length>=3,ctrlCDelivered:controls.some(input=>input.data==='\x03'),
    actualStopTool:existsSync(join(workspace,'stop-starts.txt'))&&readFileSync(join(workspace,'stop-starts.txt'),'utf8')==='once\n'&&stopFacts?.result.executionCleanup?.started===1,
    separateIdleExitPair:!!stopClosed&&controls.filter(input=>input.data==='\x03'&&input.at>=stopClosed.at).length>=2,
    stopped:stopTask?.status==='aborted'&&result.result?.status==='aborted',
    frozenFollow:items.some(item=>item.input==='冻结后续'&&item.status==='frozen'),frozenManagement:items.some(item=>item.kind==='compact'&&item.status==='frozen')
  }:{
    sourceExplicitlyEnded:stopTask?.status==='ended'&&runId===stopTask.runId,
    sourceOriginalPreserved:(await readRun(dataRoot,runId)).result.status==='aborted',
    newTaskOnly:request-beforeRequests===1&&tasks.findLast(task=>task.input==='全新任务')?.status==='completed'&&!JSON.stringify(prompts.slice(beforeRequests)).includes('冻结后续')&&!JSON.stringify(prompts.slice(beforeRequests)).includes('不得执行'),
    oldQueueFrozen:items.some(item=>item.input==='冻结后续'&&item.status==='frozen')&&items.some(item=>item.kind==='compact'&&item.status==='frozen')
  };
  const machine={result,controls,before,after,rawRestored:before.raw===after.raw,sttyRestored:before.stty===after.stty,tasks,queue:items,readback,providerRequests:request,requiredFacts,requiredFactsComplete:Object.values(requiredFacts).every(value=>value===true),nativeObservation:'UNVERIFIED by machine facts'};
  writeFileSync(join(folder,'machine.json'),JSON.stringify(machine,null,2));
  console.log(`\n${name} 已退出；raw/stty ${machine.rawRestored}/${machine.sttyRestored}；必需运行事实 ${machine.requiredFactsComplete}；证据 ${folder}`);
  if(!machine.requiredFactsComplete)console.log('缺口：'+Object.entries(requiredFacts).filter(([,value])=>value!==true).map(([key])=>key).join(', '));
  const response=createInterface({input:process.stdin,output:process.stdout});
  const answer=await response.question('本阶段各步骤是否符合观察？P=全通过 / F=失败 / U=有未核实项，请附失败或未知步骤：');response.close();
  const status=/^P(?:$|[\s:：])/i.test(answer.trim())?'PASS':/^F(?:$|[\s:：])/i.test(answer.trim())?'FAIL':'UNKNOWN';
  writeFileSync(join(folder,'operator.json'),JSON.stringify({at:new Date().toISOString(),candidate:manifest.commit,name,status,answer,source:'human macOS Terminal operator'},null,2));
  return {machine,status};
}
let first,second;
try {
  first=await phase('queue-stop',undefined,[
    '1. 输入“队列开始”回车。等 bash 显示进行中后，输入“补充当前任务”回车。',
    '2. 输入“撤回后续”，Ctrl+X 后按 Enter；再输入“保留后续”，Ctrl+X 后按 Enter。',
    '3. 输入 /queue 回车；方向键 → 选第二项“撤回后续”，按 w。看到已撤回后 Esc 关闭。fixture 此时会释放工具。',
    '4. 等待已完成。/queue 中原 steer 已接入、撤回后续已撤回、保留后续有自己的新 run；Esc 关闭。',
    '5. 输入“停止开始”回车，等 bash 进行中。输入“冻结后续”，Ctrl+X 后 Enter；输入 /compact 回车。',
    '6. 按 Ctrl+C 中止；可在中止中再按一次，不能退出。等已中止，/queue 检查两项冻结；Esc 关闭。',
    '7. 空闲先按一次 Ctrl+C：这一次不能退出。800ms 内再按一次 Ctrl+C 退出。'
  ]);
  const stopped=first.machine.tasks.findLast(task=>task.status==='aborted'&&task.runId);
  if(first.status==='PASS'&&first.machine.requiredFactsComplete&&stopped)second=await phase('reopen-recovery',stopped.runId,[
    '1. 自动重开刚才已中止的工作，恢复面板应显示原状态、最后确认点、未知、证据与动作影响。',
    '2. Esc 关闭；输入“不得执行”回车，应保持只读限制，不调用模型或工具。',
    '3. 按一次 Ctrl+C 保存并清空草稿；输入 /recover 回车，再按 e 明确结束旧工作（不回滚已经发生的效果）。',
    '4. 状态显示 ended 后，输入“全新任务”回车；应只运行这项新任务。/queue 仍显示旧“冻结后续”和 compact 为冻结。',
    '5. Esc 关闭队列；输入 /exit 回车，若弹出草稿退出面板，再按 Enter 确认退出。'
  ]);
}finally{clearInterval(release);writeFileSync(join(root,'provider-payloads.json'),JSON.stringify(prompts,null,2));}
writeFileSync(join(root,'workflow.json'),JSON.stringify({candidate:manifest.commit,first:first?.status??'NOT RUN',second:second?.status??'NOT RUN',paidProvider:'NOT RUN',notes:'Runtime facts and operator ratings are separate. Original failures and unknowns are retained.'},null,2));
console.log(`证据目录：${root}\n请将此目录发回协调 chat。未运行/未观察项目仍为 NOT RUN/UNKNOWN。`);
