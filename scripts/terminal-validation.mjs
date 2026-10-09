#!/usr/bin/env node
/** Human-run macOS Terminal acceptance. This never drives Terminal.app or synthesizes UI input. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{manifest:{type:'string'},scenario:{type:'string'},'verify-only':{type:'boolean'}}});
if(!values.manifest)throw Error('Usage: node scripts/terminal-validation.mjs --manifest /absolute/candidate.json [--scenario cursor|normal|stop|esc|exit|fault]');
const manifest=JSON.parse(readFileSync(resolve(values.manifest),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
if(sha(readFileSync(new URL(import.meta.url)))!==manifest.runnerSha256)throw Error('CANDIDATE_RUNNER_CHANGED');
const actualPaths=[];
function inventory(relative=''){for(const name of readdirSync(join(manifest.packageRoot,relative))){const path=join(relative,name),stat=lstatSync(join(manifest.packageRoot,path));if(stat.isDirectory())inventory(path);else if(stat.isFile()||stat.isSymbolicLink())actualPaths.push(path);else throw Error(`CANDIDATE_UNEXPECTED_FILE_TYPE: ${path}`);}}
inventory();
const expectedPaths=new Set(manifest.files.map(entry=>entry.path)),actualSet=new Set(actualPaths);
const missing=[...expectedPaths].filter(path=>!actualSet.has(path)),extra=actualPaths.filter(path=>!expectedPaths.has(path));
if(missing.length||extra.length||expectedPaths.size!==manifest.files.length)throw Error(`CANDIDATE_FILE_SET_CHANGED: missing ${JSON.stringify(missing)}; extra ${JSON.stringify(extra)}`);
for(const entry of manifest.files){const file=join(manifest.packageRoot,entry.path);const stat=lstatSync(file);const actual=stat.isSymbolicLink()?`link:${readlinkSync(file)}`:sha(readFileSync(file));if(actual!==entry.sha256)throw Error(`CANDIDATE_CHANGED: ${entry.path}`);}
if(values['verify-only']){console.log(JSON.stringify({verified:true,commit:manifest.commit,files:manifest.files.length,packageRoot:manifest.packageRoot}));process.exit(0);}
if(process.platform!=='darwin'||process.arch!=='arm64'||process.env.TERM_PROGRAM!=='Apple_Terminal'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('REAL_MACOS_TERMINAL_REQUIRED: 在 macOS Terminal.app 中运行本命令；其他终端不作为本票验收');
const root=join(manifest.evidenceRoot,'manual',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(root,{recursive:true,mode:0o700});
const environment={at:new Date().toISOString(),candidate:manifest.commit,manifest:resolve(values.manifest),node:process.version,platform:process.platform,arch:process.arch,TERM:process.env.TERM,TERM_PROGRAM:process.env.TERM_PROGRAM,TERM_PROGRAM_VERSION:process.env.TERM_PROGRAM_VERSION,locale:process.env.LANG,os:spawnSync('/usr/bin/sw_vers',[],{encoding:'utf8'}).stdout};
writeFileSync(join(root,'environment.json'),JSON.stringify(environment,null,2));
const {ReadOnlyTui,copyToMacClipboard}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/tui/app.js')).href);
const {demoTransport}=await import(pathToFileURL(join(manifest.packageRoot,'dist/src/offline.js')).href);
const {ProcessTerminal}=await import(pathToFileURL(join(manifest.packageRoot,'node_modules/@earendil-works/pi-tui/dist/index.js')).href);
const scenarios=values.scenario?[values.scenario]:['normal','stop','esc','exit','fault'];
for(const scenario of scenarios)if(!['cursor','normal','stop','esc','exit','fault'].includes(scenario))throw Error(`Unknown scenario ${scenario}`);
writeFileSync(join(root,'plan.json'),JSON.stringify({candidate:manifest.commit,scenarios,terminalObservations:'NOT RUN until the operator reports them',paidProvider:'NOT RUN; deterministic offline transport only'},null,2));
for(const scenario of scenarios){
  const folder=join(root,scenario),workspace=join(folder,'project'),dataRoot=join(folder,'data');mkdirSync(workspace,{recursive:true});
  writeFileSync(join(workspace,'README.md'),'# Terminal 验收 fixture\n果实数量 7；中文 👩‍💻 é 宽字符；只读。\n'+Array.from({length:2300},(_,i)=>`第 ${String(i).padStart(4,'0')} 行：中文👩‍💻 é | 可复制的长输出 | fruit count 7`).join('\n'));
  const steps=scenario==='cursor'?[
    '1. 直接复制粘贴这段测试文字：A👩‍💻é中B。确认未提交；只出现一个输入光标，左右移动时没有旧光标残留。',
    '2. Ctrl+A，向右两次，再 Ctrl+D；应得到 A👩‍💻中B（é 整簇删除）。Ctrl+C 清草稿。',
    '3. 输入几行文字（Ctrl+J 换行，至少六行）；检查末行光标。缩小到 40×12 左右再恢复，光标应仍在当前插入位置。',
    '4. F2 打开菜单，Esc 返回；Ctrl+L 重绘；切换窗口再返回。菜单中没有遗留的编辑光标，返回后位置和草稿保持。再用中文输入法组合并选择候选，确认没有误提交且候选窗贴近输入位置。',
    '5. Ctrl+C 清草稿，输入“读取 README”并 Enter；输出时键入“保留草稿”，观察只有一个光标，重绘不在其他行闪出光标。',
    '6. F2 → exit → Enter 确认退出；检查原终端的光标和普通输入已恢复。'
  ]:scenario==='normal'?[
    '1. 先用中文输入法组合“读取 README”，选择候选时按 Enter；观察它仅确认候选、不提交。',
    '2. 添加 👩‍💻、é、中文；分别 Shift+Enter、Ctrl+J、反斜杠后 Enter 换行；粘贴两行，确认不提交。',
    '3. 提交请求后立即写“保留草稿”，按 Enter；应保留且未受理。',
    '4. 输出期间 PageUp/鼠标上滚，确认不跟随、不抢输入焦点；F2→bottom 返回最新。',
    '5. 拖选已显示的输出，应复制；粘贴到输入区查看文本（本脚本也核对本次复制后的 pbpaste）。',
    '6. Ctrl+O 查看原文，n/p 翻片，左右换记录，↑↓滚动，y 复制；Esc 关闭。F2/help 和 /help 补全可导航。',
    '7. 缩放到 40×12 附近、再更小并恢复，记录可用最小字符格；检查输入、菜单、宽字符和工具失败/截断标记。',
    '8. 完成后 Ctrl+L 重绘；在 A👩‍💻中B 的 emoji 前 Ctrl+D 应删完整字符簇。Ctrl+C 清草稿，/restore 恢复。F2→exit，Esc 返回；再 F2→exit 确认退出。'
  ]:scenario==='stop'?['提交一个请求后，在“运行中”按 Ctrl+C；应先显示中止中，再已中止/unknown。等待期间再按 Ctrl+C 不退出。完成后空闲 Ctrl+C 两次退出。']:scenario==='esc'?['提交一个请求；F2 打开菜单，Esc 只关菜单；再按 Esc 中止。确认真实状态后退出。']:scenario==='exit'?['提交一个请求；保持空输入，Ctrl+D，等超过 800ms，再 Ctrl+D 不应退出；按方向键/切换窗口使确认失效，再试。最后 800ms 内两次 Ctrl+D 请求退出，等待清理。']:['提交一个请求；约 1.2 秒后 fixture 触发可捕获故障，观察恢复到原终端缓冲区、可见光标、可正常输入。'];
  console.log(`\n候选 ${manifest.commit}\n场景 ${scenario}，证据 ${folder}\n${steps.join('\n')}\n本次仅记录测试输入/显示；剪贴板会被测试复制覆盖。`);
  const ready=createInterface({input:process.stdin,output:process.stdout});await ready.question('按 Enter 开始（请勿输入私人信息）：');ready.close();
  const stty=()=>spawnSync('/bin/stty',['-g'],{stdio:['inherit','pipe','pipe'],encoding:'utf8'}).stdout.trim();
  const before={raw:!!process.stdin.isRaw,stty:stty(),columns:process.stdout.columns,rows:process.stdout.rows};
  const eventsFd=openSync(join(folder,'events.jsonl'),'wx',0o600),screenFd=openSync(join(folder,'terminal-output.ansi'),'wx',0o600);
  const event=data=>writeSync(eventsFd,JSON.stringify({at:new Date().toISOString(),...data})+'\n');
  const terminal=new ProcessTerminal(),originalStart=terminal.start.bind(terminal);
  terminal.start=(input,resize)=>originalStart(data=>{event({event:'input',data,columns:terminal.columns,rows:terminal.rows});input(data);},()=>{event({event:'resize',columns:terminal.columns,rows:terminal.rows});resize();});
  let outputOffset=0;
  const originalWrite=process.stdout.write;process.stdout.write=function(...args){const data=typeof args[0]==='string'?args[0]:Buffer.from(args[0]);const bytes=Buffer.byteLength(data);event({event:'terminal-write',offset:outputOffset,bytes});writeSync(screenFd,data);outputOffset+=bytes;return originalWrite.apply(this,args);};
  const fixture=demoTransport();let calls=0,cancelled=false;const timers=new Set();
  const transport=async(url,init)=>{
    calls++;event({event:'provider-request',ordinal:calls});
    const original=await fixture.fetch(url,init),chunks=(await original.text()).split('\n\n').filter(Boolean);
    const expanded=chunks.flatMap(chunk=>{if(!chunk.startsWith('data: {'))return[chunk+'\n\n'];const value=JSON.parse(chunk.slice(6));const content=value.choices?.[0]?.delta?.content;if(!content)return[chunk+'\n\n'];return Array.from({length:Math.ceil(content.length/120)},(_,index)=>'data: '+JSON.stringify({...value,choices:[{...value.choices[0],delta:{content:content.slice(index*120,index*120+120)}}]})+'\n\n');});
    if(scenario==='fault'){const timer=setTimeout(()=>{timers.delete(timer);throw Error('TERMINAL_VALIDATION_CAPTURED_FAULT');},1200);timers.add(timer);}
    return new Response(new ReadableStream({start(stream){
      let stopped=false;const schedule=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);};
      const abort=()=>{if(stopped)return;stopped=true;cancelled=true;event({event:'provider-cancellation-received'});schedule(()=>{event({event:'provider-stream-terminated'});stream.error(new Error('offline transport cancelled'));},200);};
      init.signal.addEventListener('abort',abort,{once:true});
      const send=()=>{if(stopped)return;const text=expanded.shift();if(text){stream.enqueue(new TextEncoder().encode(text));schedule(send,15);}else{stopped=true;init.signal.removeEventListener('abort',abort);stream.close();event({event:'provider-stream-completed'});}};
      schedule(send,scenario==='normal'||scenario==='cursor'?1500:45000);
    }}),{headers:{'content-type':'text/event-stream'}});
  };
  const clipboard=[];
  const copy=async text=>{const copied=await copyToMacClipboard(text);const readback=copied===true?spawnSync('/usr/bin/pbpaste',[],{encoding:'utf8'}):undefined;const observed={copied,bytes:Buffer.byteLength(text),sha256:sha(text),readbackEqual:readback?.status===0&&readback.stdout===text};clipboard.push(observed);event({event:'clipboard',...observed});return copied;};
  let result;
  try{const app=new ReadOnlyTui({workspace,dataRoot,mode:'offline',transport,terminal,copy,draftRoot:join(root,'drafts')});try{app.start();result=await app.closed;}finally{await app.exit();}}
  finally{for(const timer of timers)clearTimeout(timer);process.stdout.write=originalWrite;closeSync(screenFd);}
  const after={raw:!!process.stdin.isRaw,stty:stty(),columns:process.stdout.columns,rows:process.stdout.rows};
  let readback;
  if(result?.result){const child=spawnSync(process.execPath,[join(manifest.packageRoot,'dist/src/cli.js'),'show','--data-root',dataRoot,'--run',result.result.runId],{encoding:'utf8',maxBuffer:4*1024*1024});writeFileSync(join(folder,'headless.json'),child.stdout);writeFileSync(join(folder,'headless.stderr'),child.stderr);const parsed=child.status===0?JSON.parse(child.stdout):undefined;readback={status:child.status,sameResult:parsed&&JSON.stringify(parsed.result)===JSON.stringify(result.result)};}
  const machine={scenario,result,calls,cancelled,clipboard,before,after,rawRestored:before.raw===after.raw,sttyRestored:before.stty===after.stty,readback,note:'Machine checks do not prove IME, glyph layout, visual original-buffer restoration, or native copy selection.'};
  writeFileSync(join(folder,'machine.json'),JSON.stringify(machine,null,2));event({event:'scenario-finished'});closeSync(eventsFd);
  console.log(`\n场景 ${scenario} 已退出；raw/stty 恢复：${machine.rawRestored}/${machine.sttyRestored}；headless 同一结果：${readback?.sameResult??'无运行结果'}。`);
  const report=createInterface({input:process.stdin,output:process.stdout});
  const observed=await report.question(scenario==='cursor'?'请填写光标复测（PASS/FAIL/UNKNOWN：单光标、重绘闪动、菜单/焦点恢复、多行缩放、IME 候选位置、é 粘贴与删除、退出恢复；失败请写步骤）：\n':'请填写本场景观察（PASS/FAIL/UNKNOWN + 原因；normal 请分别写 IME、多行键位、字符簇、复制、焦点、缩放最小格宽、退出原缓冲区）：\n');report.close();
  writeFileSync(join(folder,'operator-observation.json'),JSON.stringify({at:new Date().toISOString(),scenario,candidate:manifest.commit,reportedBy:'human-terminal-operator',observation:observed||'UNKNOWN: no observation supplied'},null,2));
}
console.log(`证据已保存：${root}\n请将目录发回协调 chat；任何未明确观察的项目继续保持 UNKNOWN。`);
