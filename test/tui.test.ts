import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CURSOR_MARKER, TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui, exitCostSummary } from '../src/tui/app.js';
import { HardwareCursorEditor } from '../src/tui/cursor.js';
import { demoTransport, scriptedTransport } from '../src/offline.js';
import { readRun, readQueue, readAcceptedTasks, runReadTask } from '../src/runtime.js';
import { resolveDisplayInput, readDisplayIndex } from '../src/display-number.js';
import { readSessionChains } from '../src/session-chain.js';

class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; writes: string[] = []; stopped = false;
  input: (s:string)=>void = ()=>{}; resize: ()=>void = ()=>{};
  start(input: (s:string)=>void, resize: ()=>void) { this.input=input; this.resize=resize; }
  stop() { this.stopped=true; }
  async drainInput() {}
  write(value:string) { this.writes.push(value); }
  moveBy() {} hideCursor() { this.write('\x1b[?25l'); } showCursor() { this.write('\x1b[?25h'); } clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise(r => setTimeout(r,30));
async function until(predicate:()=>boolean) { for(let i=0;i<200;i++) { if(predicate()) return; await tick(); } throw Error('condition timed out'); }
function fixture(override?: typeof fetch,coding=false) {
  const root=mkdtempSync(join(tmpdir(),'durio-tui-')); const workspace=join(root,'project'); mkdirSync(workspace); writeFileSync(join(workspace,'README.md'),'Fixture 中文 👩‍💻 é\n');
  const terminal=new TestTerminal(); const transport=demoTransport();
  const app=new ReadOnlyTui({ workspace, dataRoot:join(root,'data'), draftRoot:join(root,'drafts'), mode:'offline', transport:override??transport.fetch, terminal, widthCalibration:false, copy:async()=>true,coding });
  const screen=()=>app.screen().map(stripTerminalSequences).join('\n'); app.start();
  return {root,workspace,terminal,transport,app,screen};
}

test('non-terminal CLI rejection does not emit terminal modes into a pipeline', () => {
  const child=spawnSync(process.execPath,['dist/src/cli.js','--workspace','test/fixtures/project','--offline-demo'],{encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/TUI_REQUIRES_TERMINAL/);assert.equal(child.stdout,'');
  const readOnly=spawnSync(process.execPath,[join(process.cwd(),'dist/src/cli.js'),'--offline-demo','--read-only'],{cwd:'test/fixtures/project',encoding:'utf8'});
  assert.equal(readOnly.status,1);assert.match(readOnly.stderr,/TUI_REQUIRES_TERMINAL/);assert.equal(readOnly.stdout,'');
});

test('coding UI delivers busy Enter and Ctrl+X Enter to authoritative queue facts, supports withdrawal and keeps history readonly',async()=>{
  const script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' hold.cjs`}}]);
  const f=fixture(script.fetch,true),key=(data:string)=>f.terminal.input(data),root=join(f.root,'data');
  writeFileSync(join(f.workspace,'hold.cjs'),"require('node:fs').writeFileSync('started.txt','started');console.log('holding');setTimeout(()=>console.log('released'),1800);");
  try {
    key('Run local coding tool');key('\r');await until(()=>existsSync(join(f.workspace,'started.txt')));
    key('Keep this original task');key('\r');await until(()=>readQueue(root).items.length===1);
    key('Follow-up to withdraw');key('\x18');key('\r');await until(()=>readQueue(root).items.length===2);
    assert.equal(readAcceptedTasks(root).tasks.length,2);assert.equal(readAcceptedTasks(root).tasks[1].runId,null);
    key('/queue');key('\r');key('\x1b[C');key('w');await until(()=>readQueue(root).items[1].status==='withdrawn');
    key('\x1b');key('Follow-up to execute');key('\x18');key('\r');await until(()=>readQueue(root).items.length===3);
    await until(()=>f.screen().includes('✓ 完成'));
    assert.equal(script.calls.length,3);assert.doesNotMatch(JSON.stringify(script.calls),/Follow-up to withdraw/);assert.match(JSON.stringify(script.calls.at(-1)),/Keep this original task/);
    key('/older');key('\r');key('readonly history input');key('\r');assert.match(f.screen(),/只读历史/);assert.equal(script.calls.length,3);
    key('\x03');key('\x03');const exit=await f.app.closed;assert.equal(exit.result?.status,'completed');
  }finally{await f.app.exit();}
});

test('closing the recovery panel cannot unlock execution; explicit end preserves original unknown before a new task',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-tui-recovery-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'recovery fixture');
  const controller=new AbortController();
  const original=await runReadTask({workspace,dataRoot,input:'Interrupted task',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('interrupted')));controller.abort();})});
  const terminal=new TestTerminal(),transport=demoTransport();
  const app=new ReadOnlyTui({workspace,dataRoot,runId:original.runId,draftRoot:join(root,'drafts'),mode:'offline',transport:transport.fetch,terminal,widthCalibration:false});app.start();
  const key=(data:string)=>terminal.input(data),screen=()=>app.screen().map(stripTerminalSequences).join('\n');
  try {
    // 0 项未知（退出时中断、清理已确认）：面板直接给出“继续旧工作”确认。
    await until(()=>screen().includes('继续旧工作'));assert.match(screen(),/续跑可能新增模型请求费用/);
    key('\x1b');assert.match(screen(),/恢复核对 · 只读/);assert.match(screen(),/2  视为已完成/);assert.match(screen(),/不可选 · 没有结果未提交的操作/);
    assert.match(screen(),/◈ 恢复核对/,'the status line stays below the panel');
    key('\x1b');assert.doesNotMatch(screen(),/恢复核对 · 只读/);assert.match(screen(),/◈ 恢复核对/);assert.match(screen(),/Enter 打开恢复核对/);
    // 输入框禁用：不接受文字与 `/` 命令。
    key('must not run');key('/stats');assert.doesNotMatch(screen(),/must not run|\/stats/);assert.match(screen(),/恢复核对进行中 · 输入不会提交/);assert.equal(transport.calls.length,0);
    key('\r');await until(()=>screen().includes('继续旧工作'));key('\x1b');
    key('4');key('\r');await until(()=>screen().includes('结束旧工作，开新任务'));assert.match(screen(),/新任务开启新会话，不接续旧上下文/);
    key('\r');await until(()=>screen().includes('旧工作已结束'));
    assert.equal(transport.calls.length,0);assert.equal(((await readRun(dataRoot,original.runId)).result as {status:string}).status,'unknown');
    key('New explicit task');key('\r');await until(()=>screen().includes('✓ 完成'));assert.equal(transport.calls.length,2);
    const fresh=readAcceptedTasks(dataRoot).tasks.find(task=>task.runId&&task.runId!==original.runId)!;
    assert.ok(!(await readRun(dataRoot,fresh.runId!)).records.some(r=>r.kind==='context.imported'),'the new task does not continue the old context');
    assert.notEqual(readSessionChains(dataRoot).sessionOfRun(fresh.runId!)!.id,readSessionChains(dataRoot).sessionOfRun(original.runId)!.id);
  }finally{await app.exit();}
});

test('editor keeps graphemes, multiline and recoverable drafts; overlays consume exits and double-key confirmation expires', async () => {
  const f=fixture(); const key=(s:string)=>f.terminal.input(s);
  try {
    key('A👩‍💻中B'); key('\x01'); key('\x1b[C'); key('\x04');
    assert.match(f.screen(),/A中B/);
    key('\x03'); assert.match(f.screen(),/草稿已保留/);
    key('暂不受理');key('\x18');key('\r');assert.equal(f.transport.calls.length,0);assert.match(f.screen(),/暂不受理/);key('\x03');
    key('x'); key('\x03'); assert.equal(f.terminal.stopped,false);
    key('/restore'); key('\r'); assert.match(f.screen(),/x/);
    key('\x03'); key('/help'); key('\r'); key('\x04'); key('\x04'); assert.equal(f.terminal.stopped,false);
    key('\x1b'); key('\x04'); key('x'); key('\x03'); assert.equal(f.terminal.stopped,false);
    key('\x04'); await new Promise(r=>setTimeout(r,850)); key('\x04'); assert.equal(f.terminal.stopped,false);
    key('\x04'); await f.app.closed; assert.equal(f.terminal.stopped,true);
    assert.match(f.terminal.writes.join(''),/\x1b\[\?1049l/);
  } finally { await f.app.exit(); }
});

test('viewport/focus changes invalidate confirmations, and explicit /exit preserves the saved draft', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    for(const change of ['\x1b[O','\x1b[5~','\x1b[<64;5;5M']) {
      key('\x04'); key(change); key('\x04'); assert.equal(f.terminal.stopped,false);
      key('x');key('\x7f');
    }
    key('需要保留的草稿');key('\x03');key('/exit');key('\r');
    assert.match(f.screen(),/退出并保留草稿/);
    key('\x1b');key('/restore');key('\r');assert.match(f.screen(),/需要保留的草稿/);
    key('\x03');key('/exit');key('\r');key('\r');
    const result=await f.app.closed; assert.equal(result.draftSaved,true);
    assert.equal(f.transport.calls.length,0);
  } finally {await f.app.exit();}
});

test('in-flight stop waits for actual stream cancellation; repeated keys and modal Esc do not grant exit', async () => {
  let calls=0,terminated=false;
  const transport:typeof fetch=async(_url,init)=>{calls++;return new Response(new ReadableStream({
    start(stream){stream.enqueue(new TextEncoder().encode('data: {"id":"partial","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"仍在运行的中文输出"},"finish_reason":null}]}\n\n'));init!.signal!.addEventListener('abort',()=>setTimeout(()=>{terminated=true;stream.error(new Error('cancelled'));},60),{once:true});}
  }),{headers:{'content-type':'text/event-stream'}});};
  const f=fixture(transport),key=(s:string)=>f.terminal.input(s);
  try {
    key('Read');key('\r');await until(()=>calls===1);
    key('保留');key('\x12');key('\x1b');assert.equal(terminated,false);
    key('\x03');assert.match(f.screen(),/中止中/);key('\x03');assert.equal(f.terminal.stopped,false);
    await until(()=>f.screen().includes('已中止'));assert.equal(terminated,true);assert.equal(calls,1);
    key('\x03');assert.equal(f.terminal.stopped,false);key('\x03');
    const exit=await f.app.closed;assert.equal(exit.result?.status,'aborted');assert.equal(exit.result?.cleanup,'confirmed');assert.equal(exit.result?.usage.completeness,'unknown');
  } finally {await f.app.exit();}
});

test('controlled exit of a running task preserves unknown result and restores the terminal after closure', async () => {
  let started=false,terminated=false;
  const transport:typeof fetch=async(_url,init)=>{started=true;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>setTimeout(()=>{terminated=true;reject(new Error('cancelled'));},60),{once:true}));};
  const f=fixture(transport),key=(s:string)=>f.terminal.input(s);
  key('Read');key('\r');await until(()=>started);key('\x04');key('\x04');
  assert.equal(f.terminal.stopped,false);
  const result=await f.app.closed;assert.equal(terminated,true);assert.equal(result.result?.status,'unknown');assert.equal(result.result?.cleanup,'confirmed');
  assert.match(f.terminal.writes.join(''),/\x1b\[\?1004l/);
});

test('real runtime facts stream into bounded read-only UI without changing drafts, usage or executing busy text', async () => {
  const f=fixture(); const key=(s:string)=>f.terminal.input(s);
  try {
    assert.match(f.screen(),/○ 空闲 · deepseek-flash · ctx ≈\d+ \/ 1M · 本会话 0 tok/,'before acceptance: welcome status line with the estimated fixed prefix');
    key('\x1b[200~中文\n第二行\x1b[201~'); assert.equal(f.transport.calls.length,0);
    key('\n'); key('第三行\\'); key('\r'); assert.equal(f.transport.calls.length,0);
    key('\r'); key('保留草稿'); key('\r');
    await until(()=>f.screen().includes('✓ 完成'));
    assert.match(f.screen(),/保留草稿/); assert.equal(f.transport.calls.length,2);
    assert.doesNotMatch(f.screen(),/model\.provider-event|tool\.summary|attemptId|"runId"/);
    assert.equal(f.screen().match(/Offline fixture readback/g)?.length,1);
    // Header, status notice and readback use display numbers; the full identity resolves from them.
    assert.doesNotMatch(f.screen(),/[a-f0-9]{8}-[a-f0-9]{4}-/);
    // 1b header: workspace, session and run display numbers; task N and the terminal state on the right.
    const shown=f.screen().match(/◆ pi-durio .* · 会话 s-[0-9a-f]{4,} · run (r-[0-9a-f]{4,}) +只读 · 任务 1 · ✓ 完成/)?.[1]; assert.ok(shown,f.screen());
    // Tool rows: glyph · tool · argument · system-held fact (read line count); folded by default.
    assert.match(f.screen(),/✓ read README\.md 1 行/);assert.doesNotMatch(f.screen(),/^ {4}Fixture 中文/m);
    const runId=resolveDisplayInput(join(f.root,'data'),'run',shown); assert.equal(runId,readAcceptedTasks(join(f.root,'data')).tasks[0].runId);
    const before=await readRun(join(f.root,'data'),runId);
    // Ctrl+O expands every tool row, again folds them; neither executes anything.
    key('\x0f'); assert.match(f.screen(),/^ {4}Fixture 中文/m); key('\x0f'); assert.doesNotMatch(f.screen(),/^ {4}Fixture 中文/m);
    key('\x0c'); key('\x1b'); assert.equal(f.transport.calls.length,2);
    assert.deepEqual(await readRun(join(f.root,'data'),runId),before);
    // Idle footer: this session's usage (the chain's runs); tok = input incl. cache hits + output.
    assert.match(f.screen(),/deepseek-flash · offline · ctx 14 \/ 1M · 本会话 28 tok < ¥0\.01/,'final reply usage is exact');
    key('\x03'); key('\x03'); const closed=await f.app.closed;
    assert.equal(closed.result?.status,'completed'); assert.equal(closed.result?.cleanup,'confirmed');
    assert.match(exitCostSummary(join(f.root,'data'),closed.result!),/^本次会话 s-[0-9a-f]{4,} 费用 < ¥0\.01（估算 · 非账单）$/);
    // Without a live runtime the latest reported total stands in, marked as an estimate.
    const terminal=new TestTerminal(),viewer=new ReadOnlyTui({workspace:f.workspace,dataRoot:join(f.root,'data'),runId,draftRoot:join(f.root,'drafts'),mode:'offline',transport:f.transport.fetch,terminal,widthCalibration:false});viewer.start();
    // Opening a run starts its recovery check; a completed run needs no panel.
    const shownViewer=()=>viewer.screen().map(stripTerminalSequences).join('\n');
    try{await until(()=>shownViewer().includes('ctx ≈14 / 1M')&&!shownViewer().includes('恢复核对'));}finally{await viewer.exit();}
  } finally { await f.app.exit(); }
});

test('usage line and exit summary show CNY estimates with unknown and partial requests', async () => {
  // Rewrites the offline fixture's usage frame per call; undefined drops it so usage stays unknown.
  const demo=demoTransport(),usages:(Record<string,number>|undefined)[]=[
    {prompt_tokens:1_000_000,completion_tokens:1_000_000,total_tokens:2_000_000,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1_000_000},undefined,
    {prompt_tokens:10,completion_tokens:4,total_tokens:14}];
  let call=0;
  const transport:typeof fetch=async(url,init)=>{
    const usage=usages[call++],frames=(await (await demo.fetch(url,init)).text()).split('\n\n');
    const body=frames.flatMap(frame=>!frame.includes('"usage"')?[frame]:usage?[`data: ${JSON.stringify({...JSON.parse(frame.slice(6)),usage})}`]:[]).join('\n\n');
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
  };
  const f=fixture(transport),key=(s:string)=>f.terminal.input(s),dataRoot=join(f.root,'data');
  f.terminal.columns=140;f.terminal.resize();
  try {
    key('Read the readme');key('\r');await until(()=>f.screen().includes('✓ 完成'));
    // 1M cache-miss input plus 1M output: ¥10.00 at peak, ¥5.00 off-peak; the second response has no usage.
    assert.match(f.screen(),/ · 本会话 2M tok ≈ ¥(10|5)\.00 \+1 unknown\s*\n/);
    const first=(await readRun(dataRoot,readAcceptedTasks(dataRoot).tasks[0].runId!)).result as {sessionId:string};
    key('Again');key('\r');await until(()=>readAcceptedTasks(dataRoot).tasks.length===2&&f.screen().includes('✓ 完成')&&f.screen().includes('partial'));
    // The idle footer sums the session's chain; the new run lacks a cache-hit count, so the sum is partial.
    assert.match(f.screen(),/ · 本会话 2M tok ≈ ¥(10|5)\.00 \+1 unknown partial\s*\n/);
    key('\x03');key('\x03');const closed=await f.app.closed;
    assert.match(exitCostSummary(dataRoot,closed.result!),/^本次会话 s-[0-9a-f]{4,} 费用 < ¥0\.01 partial（估算 · 非账单）$/);
    assert.match(exitCostSummary(dataRoot,{...closed.result!,sessionId:first.sessionId}),/费用 ≈ ¥(10|5)\.00 \+1 unknown（估算 · 非账单）$/);
  } finally { await f.app.exit(); }
});

test('streaming preserves a paused viewport, fixed draft and bounded windows across resize and detail navigation', async () => {
  let source:ReadableStreamDefaultController<Uint8Array>|undefined;
  const encode=(text:string)=>new TextEncoder().encode(`data: ${JSON.stringify({id:'stream',model:'deepseek-flash',choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`);
  const transport:typeof fetch=async()=>new Response(new ReadableStream({start(controller){source=controller;}}),{headers:{'content-type':'text/event-stream'}});
  const f=fixture(transport),key=(s:string)=>f.terminal.input(s);
  try {
    key('Read');key('\r');await until(()=>!!source);
    for(let i=0;i<40;i++)source!.enqueue(encode(`line ${i} 中文👩‍💻\n`));
    await until(()=>f.screen().includes('line 39'));
    key('稳定草稿');key('\x1b[5~');key('\x1b[5~');
    const before=f.screen().split('\n').slice(2,-7).join('\n');
    for(let i=40;i<80;i++)source!.enqueue(encode(`line ${i} 中文👩‍💻\n`));
    await new Promise(r=>setTimeout(r,150));
    assert.equal(f.screen().split('\n').slice(2,-7).join('\n'),before);assert.match(f.screen(),/稳定草稿/);
    (f.app as unknown as {bottom():void}).bottom();
    assert.match(f.screen(),/line 79/);assert.match(f.screen(),/稳定草稿/);
    f.terminal.columns=40;f.terminal.rows=12;f.terminal.resize();assert.equal(f.app.screen().length,12);
    f.terminal.columns=30;f.terminal.rows=8;f.terminal.resize();assert.match(f.screen(),/窗口过小/);
    f.terminal.columns=80;f.terminal.rows=24;f.terminal.resize();assert.match(f.screen(),/稳定草稿/);
    source!.enqueue(new TextEncoder().encode('data: {"id":"stream","model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));source!.close();
    await until(()=>f.screen().includes('✓ 完成'));
  } finally {await f.app.exit();}
});

test('real read tools show source truncation and failure while folded without exposing raw record plumbing', async () => {
  for(const kind of ['truncated','failed']) {
    const demo=demoTransport();let calls=0,release:()=>void=()=>{};
    const transport:typeof fetch=async(url,init)=>{
      calls++;
      if(calls===2)await new Promise<void>((resolve,reject)=>{release=resolve;init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
      return demo.fetch(url,init);
    };
    const f=fixture(transport),key=(s:string)=>f.terminal.input(s);
    writeFileSync(join(f.workspace,'README.md'),kind==='truncated'?'long readable text 中文\n'.repeat(3000):Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]));
    try {
      key('Read README');key('\r');await until(()=>calls===2);
      // A partial read names its range; a failed read keeps its error lines visible while folded.
      await until(()=>(kind==='truncated'?/✓ read README\.md 第 1–\d+ 行 \/ 共 3000 行/:/✗ read README\.md\s*\n {4}\S/).test(f.screen()));
      assert.doesNotMatch(f.screen(),/tool\.summary|tool\.result|attemptId/);
      release();await until(()=>f.screen().includes('✓ 完成'));
    } finally {release();await f.app.exit();}
  }
});

// Assert at the real pi-tui ANSI boundary, not against stripped display text.
// The recorded r3 Terminal frames draw a reverse-video software caret while
// also showing the hardware caret. These are independently owned cursors.
test('focused editor uses one hardware caret without a competing painted caret', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    // Same input prefix as the second recorded real-Terminal run (events 40–48).
    for(const input of ['读','取',' ','R','E','A','D','M','E']) key(input);
    f.app.screen();
    const ansi=f.terminal.writes.join('');
    const visible=ansi.lastIndexOf('\x1b[?25h')>ansi.lastIndexOf('\x1b[?25l');
    assert.equal(visible,true,'focused editor must show its hardware caret for IME');
    assert.doesNotMatch(ansi,/\x1b\[7m/, 'software caret competes with the visible hardware caret');
    f.terminal.writes=[];
    key('\x12');f.app.screen();
    const overlay=f.terminal.writes.join('');
    assert.ok(overlay.lastIndexOf('\x1b[?25l')>overlay.lastIndexOf('\x1b[?25h'),'a view owns focus and hides the editor caret');
    assert.doesNotMatch(overlay,/\x1b\[7m/,'blurred editor must not leave a painted caret behind');
    key('\x1b');f.app.screen();
    assert.match(f.terminal.writes.at(-1)!,/\x1b\[21;12H\x1b\[\?25h/,'return to the unchanged editor insertion point');
  } finally { await f.app.exit(); }
});

test('caret adaptation preserves independent reverse-video component styles', () => {
  const terminal=new TestTerminal(),tui=new TuiAltScreen(terminal,true);
  const identity=(text:string)=>text;
  const editor=new HardwareCursorEditor(tui,{borderColor:text=>`\x1b[7m${text}\x1b[0m`,selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}});
  editor.setText('é');
  for(const focused of [true,false]) {
    editor.focused=focused;
    const lines=editor.render(20);
    assert.match(lines[0],/^\x1b\[7m─+/,'the border theme keeps its independent reverse-video style');
    assert.doesNotMatch(lines[1],/\x1b\[7m/,'only the editor caret loses reverse-video styling');
    assert.equal(lines[1].includes(CURSOR_MARKER),focused,'only focused input provides the IME insertion marker');
    assert.equal(editor.focused,focused,'rendering does not change input focus');
  }
});

test('real bracketed paste preserves combining text and keeps caret visible through multiline resize', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    key('\x1b[200~A👩‍💻é中B\x1b[201~');f.app.screen();
    assert.equal(f.transport.calls.length,0,'paste must not submit');
    assert.match(f.screen(),/A👩‍💻é中B/);
    assert.match(f.terminal.writes.at(-1)!,/\x1b\[21;8H\x1b\[\?25h/,'wide and combining text position the hardware caret in terminal cells');
    key('\x01');key('\x1b[C');key('\x1b[C');key('\x04');
    assert.match(f.screen(),/A👩‍💻中B/,'Ctrl+D removes the complete combining grapheme');
    key('\x03');
    // The constrained footer must retain Pi's cursor-aware layout clipping.
    key('\x1b[200~一\n二\n三\n四\n五\n六\n七\n八\x1b[201~');
    for(const [columns,rows] of [[80,24],[40,12],[120,30]]) {
      f.terminal.columns=columns;f.terminal.rows=rows;f.terminal.resize();f.app.screen();
      const ansi=f.terminal.writes.join('');
      assert.ok(ansi.lastIndexOf('\x1b[?25h')>ansi.lastIndexOf('\x1b[?25l'),`caret stays visible at ${columns}×${rows}`);
      assert.match(f.screen(),/八/,'current insertion line remains visible');
    }
  } finally {await f.app.exit();}
});

test('repainting hides the hardware caret before moving it through display rows', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    f.app.screen(); // A visible hardware caret exists before this update.
    f.terminal.writes=[];
    key('A');f.app.screen();
    const paint=f.terminal.writes.find(value=>value.includes('\x1b[2K'));
    assert.ok(paint,'typing must repaint the real ANSI frame');
    assert.match(paint,/^\x1b\[\?2026h\x1b\[\?25l/,'hide before drawing on terminals without synchronized-output support');
    assert.match(paint,/\x1b\[21;2H\x1b\[\?25h\x1b\[\?2026l$/,'restore the hardware caret at the actual insertion point');
  } finally {await f.app.exit();}
});

test('history overlay is reachable and consumes command-like text without changing the active execution target', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    key('/history {broken');key('\r');assert.match(f.screen(),/参数有误/);assert.doesNotMatch(f.screen(),/历史 · 只读/);key('\x15');assert.equal(f.terminal.stopped,false);assert.equal(f.transport.calls.length,0);
    key('/history');key('\r');assert.match(f.screen(),/历史 · 只读/);assert.equal(f.transport.calls.length,0);key('\x1b');
    key('Read README');key('\r');await until(()=>f.screen().includes('✓ 完成'));
    const calls=f.transport.calls.length;
    key('/history');key('\r');assert.match(f.screen(),/历史 · 只读/);
    // A session display number in the /history filter selects the same session; the filter keeps the full identity.
    const sessionId=(f.app as any).historyView.history.items[0].sessionId as string;key('\x1b');
    key('/history '+readDisplayIndex(join(f.root,'data')).label('session',sessionId));key('\r');
    assert.equal((f.app as any).historyView.history.filter.session,sessionId);assert.equal((f.app as any).historyView.history.items.length,1);
    key('\r');assert.match(f.screen(),/task.accepted/);key('\r');
    key('/compact');key('\r');key('/exit');key('\r');assert.equal(f.terminal.stopped,false);assert.equal(f.transport.calls.length,calls);
    key('\x03');key('\x04');assert.equal(f.terminal.stopped,false);key('\x1b');
    assert.match(f.screen(),/✓ 完成/);assert.equal(f.transport.calls.length,calls);
  } finally {await f.app.exit();}
});

test('compact is listed in help, idle summary reaches next input, and readonly history cannot compress',async()=>{
 const calls:any[]=[];const transport:typeof fetch=async(url,init)=>{calls.push(JSON.parse(String(init?.body)));const response=await scriptedTransport([]).fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',calls.length===1?'INITIAL FINAL '+'z'.repeat(90000):calls.length===2?'VISIBLE COMPACT SUMMARY':'NEXT FINAL'),{headers:{'content-type':'text/event-stream'}});};
 const f=fixture(transport),key=(s:string)=>f.terminal.input(s),dataRoot=join(f.root,'data');
 try{
  key('\x14');assert.match(f.screen(),/尚无 run/);assert.doesNotMatch(f.screen(),/◆ trace/);
  key('?');for(let i=0;i<3&&!/\/compact /.test(f.screen());i++)key('n');assert.match(f.screen(),/\/compact /);key('\x1b');
  key('ORIGINAL UI REQUEST');key('\r');await until(()=>f.screen().includes('✓ 完成'));
  key('/compact');key('\r');await until(()=>f.screen().includes('上下文压缩 applied'));assert.equal(calls.length,2);assert.equal(readAcceptedTasks(dataRoot).tasks.length,1);
  key('\x14');assert.match(f.screen(),/trace/);assert.match(f.screen(),/compaction 手动/);assert.match(f.screen(),/另有维护 1 项/);key('\x1b');assert.doesNotMatch(f.screen(),/另有维护/);
  key('NEXT UI REQUEST');key('\r');await until(()=>calls.length===3&&f.screen().includes('✓ 完成'));
  assert.match(JSON.stringify(calls[2]),/VISIBLE COMPACT SUMMARY/);assert.doesNotMatch(JSON.stringify(calls[2]),/ORIGINAL UI REQUEST/);assert.equal(readAcceptedTasks(dataRoot).tasks.length,2);
  key('/older');key('\r');key('/compact');key('\r');assert.match(f.screen(),/只读历史\/恢复视图不能压缩/);assert.equal(calls.length,3);
 }finally{await f.app.exit();}
});

test('a failed TUI task never implicitly supplies context to the next independent request',async()=>{
 const calls:any[]=[];const transport:typeof fetch=async(url,init)=>{calls.push(JSON.parse(String(init?.body)));return calls.length===1?new Response('controlled denied',{status:401}):scriptedTransport([]).fetch(url,init);};
 const f=fixture(transport),key=(s:string)=>f.terminal.input(s);
 try{key('FAILED ORIGINAL INPUT');key('\r');await until(()=>f.screen().includes('失败'));key('EXPLICIT NEW INPUT');key('\r');await until(()=>f.screen().includes('✓ 完成'));assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(calls[1]),/FAILED ORIGINAL INPUT/);}finally{await f.app.exit();}
});

test('improve is reachable with explicit limits; report navigation and ordinary text never select a candidate',async()=>{
 const {offlineImproveTransport}=await import('../src/improve.js'),{listImproveReports,readImproveReport}=await import('../src/improve.js'),{readImproveDecision}=await import('../src/improve-decisions.js');
 const analysis=offlineImproveTransport(),coding=scriptedTransport([]);
 const transport:typeof fetch=async(url,init)=>JSON.parse(String(init?.body)).tools.some((t:any)=>t.function.name==='evidence_summary')?analysis.fetch(url,init):coding.fetch(url,init);
 const f=fixture(transport),key=(text:string)=>f.terminal.input(text);
 try{key('Original task');key('\r');await until(()=>f.screen().includes('✓ 完成'));key('/improve');key('\r');assert.match(f.screen(),/尚未启动/);assert.equal(analysis.calls.length,0);
 key('/improve '+JSON.stringify({id:'tui-report',purpose:'Inspect current task',limits:{maxRequests:4,maxTokens:1024,maxRequestTokens:256,maxDurationMs:30000,maxOutputTokens:128}}));key('\r');
 // The status line shows the analysis by its report display number; completion is a main-area event line.
 const target=readAcceptedTasks(join(f.root,'data')).tasks[0].runId!;assert.match(f.screen(),/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);assert.match(f.screen(),/ improve 分析 ir-[0-9a-f]{4,}/);assert.ok(!f.screen().includes(target));
 await until(()=>/✓ improve ir-[0-9a-f]{4,} 分析完成/.test(f.screen()));assert.equal(analysis.calls.length,2);
 key('/improves tui-report');key('\r');assert.match(f.screen(),/只读报告/);key('please execute all');key('\r');assert.equal(analysis.calls.length,2);key('\x1b');
 const report=readImproveReport(join(f.root,'data'),'tui-report').report!;
 key('/improve-select '+JSON.stringify({id:'tui-empty-choice',reportId:readDisplayIndex(join(f.root,'data')).label('improve-report',report.id),reportRevision:report.revision,selections:[],groups:[],limits:{deadline:new Date(Date.now()+30000).toISOString(),maxChecks:0,maxRequests:0,maxTokens:0}}));key('\r');assert.match(f.screen(),/结构化选择/);key('s');f.screen();key('\r');await until(()=>{try{return readImproveDecision(join(f.root,'data'),'tui-empty-choice').state==='completed';}catch{return false;}});await until(()=>f.screen().includes('✓ 完成')&&!f.screen().includes('improve 执行'));assert.equal(analysis.calls.length,2);key('\x1b');assert.match(f.screen(),/决定 tui-empty-choice · completed；具体写回\/启用见结果/);assert.ok(JSON.stringify(readImproveDecision(join(f.root,'data'),'tui-empty-choice')).includes(`"reportId":"${report.id}"`));assert.doesNotMatch(f.screen(),/正式目标未写回、未启用/);
 key('/older');key('\r');key('/improve {}');key('\r');assert.match(f.screen(),/只读历史\/恢复视图不能发起分析/);assert.equal(listImproveReports(join(f.root,'data')).items.length,1);
 }finally{await f.app.exit();}
});

test('several unknowns are resolved one by one and submitted once; paged facts are all collected', async () => {
  const { recoveryFixture, uncertainTools } = await import('./fixtures/recovery-projection.js');
  const f = await recoveryFixture(true); const ids = await uncertainTools(f, 34);
  const terminal = new TestTerminal(), transport = scriptedTransport([]);
  terminal.columns = 132; terminal.rows = 38;
  const app = new ReadOnlyTui({ workspace: f.workspace, dataRoot: f.dataRoot, runId: f.result.runId, draftRoot: join(f.root, 'drafts'), mode: 'offline', transport: transport.fetch, terminal, widthCalibration: false });
  app.start(); const key = (value: string) => terminal.input(value), screen = () => app.screen().map(stripTerminalSequences).join('\n');
  try {
    await until(() => screen().includes('未知 1/34'));
    assert.match(screen(), /结果未提交 · 可能已产生影响/); assert.match(screen(), /只读操作，重复读取不改变文件/);
    // 2 视为已完成：附一句说明，选完跳到下一项。
    key('2'); key('\r'); assert.match(screen(), /说明（可选）/); key('checked by hand'); key('\r');
    assert.match(screen(), /未知 2\/34/);
    for (let i = 1; i < 34; i++) { key('3'); key('\r'); }
    await until(() => screen().includes('确认 34 项处置'));
    assert.match(screen(), /1\/34 read README\.md · 视为已完成 · “checked by hand”/); assert.match(screen(), /续跑可能新增模型请求费用/);
    key('\x1b'); assert.match(screen(), /未知 34\/34/, 'Esc returns to the last item to adjust');
    assert.equal(transport.calls.length, 0);
    key('3'); key('\r'); await until(() => screen().includes('确认 34 项处置')); key('\r');
    await until(() => !screen().includes('确认 34 项处置'));
  } finally { await app.exit(); }
  const decision = (await readRun(f.dataRoot, f.result.runId)).records.filter(r => r.kind === 'recovery.decision');
  assert.equal(decision.length, 1, 'one submission covers every unknown');
  const resolutions = (decision[0].data as any).decision.resolutions;
  assert.deepEqual(resolutions.map((r: any) => r.taskId), ids);
  assert.deepEqual(resolutions[0], { taskId: ids[0], choice: 'completed', reason: 'checked by hand' });
  assert.ok(resolutions.slice(1).every((r: any) => r.choice === 'retry'));
});

test('full-screen views stack: Esc returns layer by layer; in-view Ctrl+C and global keys neither stop the session task nor leak', async () => {
  const script=scriptedTransport([{name:'bash',args:{command:`'${process.execPath}' hold.cjs`}}]);
  const f=fixture(script.fetch,true),key=(data:string)=>f.terminal.input(data);
  writeFileSync(join(f.workspace,'hold.cjs'),"require('node:fs').writeFileSync('started.txt','started');setTimeout(()=>console.log('released'),1500);");
  const views=f.app as unknown as {pushView(kind:string):void;openConfirm(config:object,confirm:(selected:number[])=>void):void};
  try {
    key('Run held tool');key('\r');await until(()=>existsSync(join(f.workspace,'started.txt')));
    key('/help');key('\r');assert.match(f.screen(),/帮助/);
    views.pushView('queue');assert.match(f.screen(),/队列/);
    for(const k of ['\x03','\x03','\x04','\x0f','\x14','\x12','?'])key(k);
    assert.match(f.screen(),/队列/,'global keys are inert inside a view');assert.doesNotMatch(f.screen(),/中止中|请求中止/);
    key('\x1b');assert.match(f.screen(),/帮助/);assert.doesNotMatch(f.screen(),/队列：/,'Esc returns to the previous layer');
    key('\x1b');assert.doesNotMatch(f.screen(),/Ctrl\+X → Enter 后续请求\nCtrl\+J/,'Esc on the top layer returns to the session');
    // A confirm dialog consumes keys: Esc closes only the dialog, Enter confirms once.
    key('/help');key('\r');let confirmed:number[]|undefined;
    views.openConfirm({title:'测试确认',action:'确认',fixed:['不调用模型 · ≈¥0']},selected=>{confirmed=selected;});
    assert.match(f.screen(),/测试确认/);assert.match(f.screen(),/Enter 确认 · Esc 取消/);
    key('\x1b');assert.doesNotMatch(f.screen(),/测试确认/);assert.match(f.screen(),/帮助/,'dialog Esc does not pop the view');
    views.openConfirm({title:'测试确认',action:'确认'},selected=>{confirmed=selected;});key('\r');assert.deepEqual(confirmed,[]);
    key('\x1b');
    await until(()=>f.screen().includes('✓ 完成'));
    assert.equal(script.calls.length,2,'session task finished normally');
    // Instant feedback replaces the key-hint line until the next key.
    key('\x18');assert.match(f.screen(),/按 Enter 明确排到下一任务/);
    key('x');assert.doesNotMatch(f.screen(),/按 Enter 明确排到下一任务/);assert.match(f.screen(),/Enter 提交 · \/ 命令 · Ctrl\+R 历史 · \? 帮助/);
    key('\x03');key('\x03');const exit=await f.app.closed;assert.equal(exit.result?.status,'completed');
  }finally{await f.app.exit();}
});

test('queue panel names requests by q- number and /withdraw accepts it (v1 fixture copy)', async () => {
  const root=mkdtempSync(join(tmpdir(),'durio-tui-q-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);
  cpSync(new URL('../../test/fixtures/v1-records/data',import.meta.url),dataRoot,{recursive:true});
  const q=readDisplayIndex(dataRoot).label('queue-request','frozen-follow'),terminal=new TestTerminal();terminal.columns=120;
  const app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',transport:demoTransport().fetch,terminal,widthCalibration:false});app.start();
  const key=(data:string)=>terminal.input(data),screen=()=>app.screen().map(stripTerminalSequences).join('\n');
  try {
    key('/queue');key('\r');await until(()=>/q-[0-9a-f]{4,} · 原 id /.test(screen()));assert.doesNotMatch(screen(),/原 run [0-9a-f]{8}-/);
    key('\x1b');key(`/withdraw ${q}`);key('\r');
    await until(()=>readQueue(dataRoot).items.find(item=>item.requestId==='frozen-follow')!.status==='withdrawn');
  } finally { await app.exit(); }
});

test('? opens help only on empty input; F2 does nothing; help fits 80x24 and 40x12', async () => {
  const f=fixture(),key=(data:string)=>f.terminal.input(data);
  try {
    assert.match(f.screen(),/描述要查看或分析的内容… {3}\/ 命令  @ 文件  Shift\+Enter 换行/,'read-only placeholder on empty input');
    assert.match(f.screen(),/Enter 提交 · \/ 命令 · Ctrl\+R 历史 · \? 帮助/);
    key('a?');assert.doesNotMatch(f.screen(),/会话屏键位/);assert.match(f.screen(),/a\?/);
    key('\x7f');key('\x7f');key('\x1bOQ');assert.doesNotMatch(f.screen(),/操作菜单|会话屏键位/,'F2 is inert');
    for(const [columns,rows] of [[80,24],[40,12]] as const) {
      f.terminal.columns=columns;f.terminal.rows=rows;f.terminal.resize();
      key('?');const lines=f.app.screen().map(stripTerminalSequences);
      assert.equal(lines.length,rows);for(const line of lines)assert.ok(line.trimEnd().length<=columns,`${columns}x${rows}: ${line}`);
      const text=lines.join('\n');assert.match(text,/帮助/);assert.match(text,/会话屏键位/);assert.match(text,/Esc 返回会话/);
      for(let i=0;i<40;i++)key('n');assert.match(f.screen(),/\/improve-rollback/,'the command list scrolls to its end');assert.match(f.screen(),/Esc 返回会话/);
      key('\x1b');assert.doesNotMatch(f.screen(),/会话屏键位/);
    }
    f.terminal.columns=30;f.terminal.rows=10;f.terminal.resize();assert.match(f.screen(),/窗口过小/);
    f.terminal.columns=80;f.terminal.rows=24;f.terminal.resize();
    key('/help');key('\r');assert.match(f.screen(),/会话屏键位/);key('\x1b');
    // Narrow footers drop hints from the right; `? 帮助` goes last.
    const hints=(f.app as unknown as {sessionHints():string[]}).sessionHints();assert.deepEqual(hints,['Enter 提交','/ 命令','Ctrl+R 历史','? 帮助']);
  } finally { await f.app.exit(); }
});

test('bad command arguments open no view and list the valid values in the status line', async () => {
  const f=fixture(),key=(data:string)=>f.terminal.input(data);
  try {
    key('/history --sort x');key('\r');assert.match(f.screen(),/参数有误：未知选项 --sort · 可用 --from --to --project --status/);assert.doesNotMatch(f.screen(),/历史 · 只读/);
    assert.match(f.screen(),/\/history --sort x/,'the command stays in the input box to fix');
    key('\x15');key('/history --from 10/01');key('\r');assert.match(f.screen(),/日期写 MM-DD 或 YYYY-MM-DD/);
    key('\x15');key('/stats --source live');key('\r');assert.match(f.screen(),/可用 ordinary synthetic diagnostic/);
    key('\x15');key('/metrics');key('\r');assert.match(f.screen(),/未知命令 \/metrics/);
    key('\x15');key('/stats');key('\r');assert.doesNotMatch(f.screen(),/参数有误/);key('\x1b');
    key('\x12');assert.match(f.screen(),/历史 · 只读/,'Ctrl+R opens history');key('\x1b');
    key('\x15');key('/eval');key('\r');assert.match(f.screen(),/还没有 eval 计划 · 新建用 pi-durio eval plan/,'2b list layer, empty');key('\x1b');assert.doesNotMatch(f.screen(),/还没有 eval 计划/);
    assert.equal(f.transport.calls.length,0);
  } finally { await f.app.exit(); }
});

test('/ and @ completion in the editor: subcommand, option value, and a file path only', async () => {
  const f=fixture(),key=(data:string)=>f.terminal.input(data),text=()=>(f.app as unknown as {editor:{getText():string;isShowingAutocomplete():boolean}}).editor;
  try {
    for(const c of '/history --status a')key(c);
    await until(()=>text().isShowingAutocomplete());key('\t');assert.equal(text().getText(),'/history --status aborted ');
    key('\x15');for(const c of '/improve h')key(c);await until(()=>text().isShowingAutocomplete());key('\t');assert.equal(text().getText(),'/improve history ');
    key('\x15');for(const c of 'read @READ')key(c);await until(()=>text().isShowingAutocomplete());
    assert.match(f.screen(),/README\.md/);key('\t');assert.equal(text().getText(),'read @README.md ');
    assert.equal(f.transport.calls.length,0);
  } finally { await f.app.exit(); }
});
