#!/usr/bin/env node
/** Human-run diagnostic: Terminal CPR is the oracle; Pi's width is only the value under test. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';

export function consumeCPR(buffer) {
  const match=/\x1b\[(\d+);(\d+)R/.exec(buffer);
  return match?{row:Number(match[1]),column:Number(match[2]),response:match[0]}:undefined;
}
export function comparePosition(sample, report, libraryWidth, expectedRow) {
  if(report.row!==expectedRow)return {sample,status:'UNKNOWN',reason:'Terminal changed rows; width cannot be inferred'};
  const terminalWidth=report.column-1;
  return {sample,status:terminalWidth===libraryWidth?'WIDTH_AGREES':'WIDTH_MISMATCH',terminalWidth,libraryWidth,response:report.response};
}
const {values}=parseArgs({options:{manifest:{type:'string'},'self-test':{type:'boolean'},'verify-only':{type:'boolean'}}});
if(values['self-test']) {
  assert.equal(consumeCPR('\x1b[4;'),undefined);
  assert.deepEqual(consumeCPR('\x1b[4;10R'),{row:4,column:10,response:'\x1b[4;10R'});
  assert.equal(comparePosition('A👩‍💻é中B',{row:4,column:10,response:'\x1b[4;10R'},7,4).status,'WIDTH_MISMATCH');
  assert.equal(comparePosition('A👩‍💻é中B',{row:4,column:8,response:'\x1b[4;8R'},7,4).status,'WIDTH_AGREES');
  assert.equal(comparePosition('A👩‍💻é中B',{row:5,column:8,response:'\x1b[5;8R'},7,4).status,'UNKNOWN');
  console.log('PASS diagnostic parser/comparator self-test; synthetic responses, no Terminal validation');
  process.exit(0);
}
if(!values.manifest)throw Error('Usage: node terminal-width-diagnostic.mjs --manifest /absolute/candidate-r4/manifest.json');
const manifestPath=resolve(values.manifest),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const verified=spawnSync(process.execPath,[join(manifestPath,'..','terminal-validation.mjs'),'--manifest',manifestPath,'--verify-only'],{encoding:'utf8'});
if(verified.status!==0)throw Error(`CANDIDATE_VERIFY_FAILED: ${verified.stderr}`);
const {visibleWidth}=await import(pathToFileURL(join(manifest.packageRoot,'node_modules/@earendil-works/pi-tui/dist/index.js')).href);
if(values['verify-only']){console.log(verified.stdout.trim());process.exit(0);}
if(process.platform!=='darwin'||process.arch!=='arm64'||process.env.TERM_PROGRAM!=='Apple_Terminal'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('REAL_MACOS_TERMINAL_REQUIRED: 请在本人 macOS Terminal.app 运行，不要修改 TERM_PROGRAM');
if(process.stdout.columns<40||process.stdout.rows<12)throw Error('请先把 Terminal 窗口放大到至少 40×12');
const evidence=join(manifest.evidenceRoot,'width-repair','manual',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(evidence,{recursive:true,mode:0o700});
const sha=data=>createHash('sha256').update(data).digest('hex');
const stty=()=>spawnSync('/bin/stty',['-g'],{stdio:['inherit','pipe','pipe'],encoding:'utf8'}).stdout.trim();
const before={raw:!!process.stdin.isRaw,stty:stty()};
const report={candidate:manifest.commit,manifest:manifestPath,manifestSha256:sha(readFileSync(manifestPath)),scriptSha256:sha(readFileSync(new URL(import.meta.url))),at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,TERM_PROGRAM:process.env.TERM_PROGRAM,TERM_PROGRAM_VERSION:process.env.TERM_PROGRAM_VERSION,TERM:process.env.TERM,LANG:process.env.LANG,columns:process.stdout.columns,rows:process.stdout.rows,os:spawnSync('/usr/bin/sw_vers',[],{encoding:'utf8'}).stdout},before,samples:[],status:'UNKNOWN',paidProvider:'NOT RUN'};
writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log('最小格宽诊断：约 3 秒，自动显示测试文字并读取 Terminal 回报。期间请不要输入；Ctrl+C 可取消。');
let pending,buffer='',sequence=0,active=false;
const output=[];
function write(data){output.push(data);process.stdout.write(data);}
function onData(chunk){
  const data=chunk.toString('utf8');
  if(data.includes('\x03')){pending?.reject(Error('OPERATOR_CANCELLED'));return;}
  buffer=(buffer+data).slice(-4096);const result=consumeCPR(buffer);
  if(result&&pending){const current=pending;pending=undefined;buffer='';current.resolve(result);}
}
function query(){
  buffer='';const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(pending?.id===id)pending=undefined;reject(Error('CPR_TIMEOUT: 未取得真实 Terminal 列号'));},1500);
    pending={id,resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};
    write('\x1b[6n');
  });
}
const onSignal=()=>pending?.reject(Error('SIGNAL_CANCELLED'));
process.on('SIGTERM',onSignal);process.on('SIGHUP',onSignal);
try {
  process.stdin.setRawMode(true);process.stdin.on('data',onData);process.stdin.resume();
  active=true;write('\x1b[?1049h\x1b[?25l\x1b[2J');
  const samples=['AB','中','é','👩','💻','👩‍💻','A👩‍💻é中B','A👩‍💻é中B。'];
  for(let i=0;i<samples.length;i++) {
    const sample=samples[i],row=i+2;
    write(`\x1b[${row};1H\x1b[2K${sample}`);
    const result=await query();
    report.samples.push(comparePosition(sample,result,visibleWidth(sample),row));
  }
  // Replay the exact r4 text prefix naturally, then replay its recorded CUP column.
  // The report compares independent CPR to that real captured command, not to a second width formula.
  const source=join(manifest.evidenceRoot,'manual','2026-10-09T11-19-18-936Z','cursor');
  const events=readFileSync(join(source,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const inputIndex=events.findIndex(e=>e.event==='input'&&e.data==='\x1b[200~A👩‍💻é中B\x1b[201~');
  const frameEvent=events.slice(inputIndex+1).find(e=>e.event==='terminal-write');
  if(inputIndex<0||!frameEvent)throw Error('RECORDED_FRAME_MISSING');
  const ansi=readFileSync(join(source,'terminal-output.ansi'));
  const frame=ansi.subarray(frameEvent.offset,frameEvent.offset+frameEvent.bytes).toString('utf8');
  const marker=/\x1b\[(\d+);(\d+)H\x1b\[\?25h/.exec(frame);
  if(!marker||!frame.includes('A👩‍💻é中B '))throw Error('RECORDED_FRAME_UNEXPECTED');
  write('\x1b[10;1H\x1b[2KA👩‍💻é中B');const natural=await query();
  write(`\x1b[10;${marker[2]}H`);const positioned=await query();
  report.replay={source,frameSha256:sha(frame),ansiSha256:sha(ansi),offset:frameEvent.offset,bytes:frameEvent.bytes,recordedCursor:{row:Number(marker[1]),column:Number(marker[2])},natural,positioned,status:natural.row!==10||positioned.row!==10?'UNKNOWN':natural.column===positioned.column?'NO_CARET_MISMATCH_REPRODUCED':'CARET_MISMATCH_REPRODUCED'};
  report.status=report.replay.status;
} catch(error){report.error=error.message;report.status='UNKNOWN';}
finally {
  if(active)write('\x1b[0m\x1b[?25h\x1b[?1049l');
  process.stdin.removeListener('data',onData);process.stdin.setRawMode(before.raw);process.stdin.pause();
  process.removeListener('SIGTERM',onSignal);process.removeListener('SIGHUP',onSignal);
  report.after={raw:!!process.stdin.isRaw,stty:stty()};report.rawRestored=before.raw===report.after.raw;report.sttyRestored=before.stty===report.after.stty;
  writeFileSync(join(evidence,'output.ansi'),output.join(''),{mode:0o600});
  writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
}
console.log(`\n${report.status}\n${report.samples.map(s=>`${JSON.stringify(s.sample)}: Terminal=${s.terminalWidth??'?'} / Pi=${s.libraryWidth??'?'} ${s.status}`).join('\n')}\n证据：${evidence}`);
if(report.error)console.log(report.error);
// Keep a natural rendering visible for the sole optional visual observation.
console.log('自然输出（没有在 emoji 后插入空格）：|A👩‍💻é中B|');
const prompt=createInterface({input:process.stdin,output:process.stdout});
try{report.observation=(await prompt.question('若这一行也在 emoji 后有空白，请写 yes；没有则 no；不确定直接 Enter：')).trim()||'UNKNOWN';}
finally{prompt.close();writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2),{mode:0o600});}
console.log(`完成，请返回证据目录：${evidence}`);
