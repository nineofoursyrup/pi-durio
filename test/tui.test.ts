import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { demoTransport } from '../src/offline.js';
import { readRun } from '../src/runtime.js';

class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; writes: string[] = []; stopped = false;
  input: (s:string)=>void = ()=>{}; resize: ()=>void = ()=>{};
  start(input: (s:string)=>void, resize: ()=>void) { this.input=input; this.resize=resize; }
  stop() { this.stopped=true; }
  async drainInput() {}
  write(value:string) { this.writes.push(value); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise(r => setTimeout(r,30));
async function until(predicate:()=>boolean) { for(let i=0;i<200;i++) { if(predicate()) return; await tick(); } throw Error('condition timed out'); }
function fixture(override?: typeof fetch) {
  const root=mkdtempSync(join(tmpdir(),'durio-tui-')); const workspace=join(root,'project'); mkdirSync(workspace); writeFileSync(join(workspace,'README.md'),'Fixture 中文 👩‍💻 é\n');
  const terminal=new TestTerminal(); const transport=demoTransport();
  const app=new ReadOnlyTui({ workspace, dataRoot:join(root,'data'), draftRoot:join(root,'drafts'), mode:'offline', transport:override??transport.fetch, terminal, copy:async()=>true });
  const screen=()=>app.screen().map(stripTerminalSequences).join('\n'); app.start();
  return {root,workspace,terminal,transport,app,screen};
}

test('non-terminal CLI rejection does not emit terminal modes into a pipeline', () => {
  const child=spawnSync(process.execPath,['dist/src/cli.js','tui','--workspace','test/fixtures/project','--offline-demo'],{encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/TUI_REQUIRES_TERMINAL/);assert.equal(child.stdout,'');
  const coding=spawnSync(process.execPath,['dist/src/cli.js','tui','--workspace','test/fixtures/project','--offline-demo','--coding'],{encoding:'utf8'});
  assert.equal(coding.status,1);assert.match(coding.stderr,/currently grants read only/);assert.equal(coding.stdout,'');
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

test('viewport/focus changes invalidate confirmations, and explicit menu exit preserves the live draft', async () => {
  const f=fixture(),key=(s:string)=>f.terminal.input(s);
  try {
    for(const change of ['\x1b[O','\x1b[5~','\x1b[<64;5;5M']) {
      key('\x04'); key(change); key('\x04'); assert.equal(f.terminal.stopped,false);
      key('x');key('\x7f');
    }
    key('需要保留的草稿');key('\x1bOQ');key('\x1b[B');key('\r');
    assert.match(f.screen(),/退出并保留草稿/);
    key('\x1b');assert.match(f.screen(),/需要保留的草稿/);
    key('\x1bOQ');key('\x1b[B');key('\r');key('\r');
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
    key('保留');key('\x1bOQ');key('\x1b');assert.equal(terminated,false);
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
    key('\x1b[200~中文\n第二行\x1b[201~'); assert.equal(f.transport.calls.length,0);
    key('\n'); key('第三行\\'); key('\r'); assert.equal(f.transport.calls.length,0);
    key('\r'); key('保留草稿'); key('\r');
    await until(()=>f.screen().includes('已完成'));
    assert.match(f.screen(),/保留草稿/); assert.equal(f.transport.calls.length,2);
    assert.doesNotMatch(f.screen(),/model\.provider-event|tool\.summary|attemptId|"runId"/);
    assert.equal(f.screen().match(/Offline fixture readback/g)?.length,1);
    const runId=f.screen().match(/run ([a-f0-9-]{36})/)?.[1]; assert.ok(runId);
    const before=await readRun(join(f.root,'data'),runId);
    key('\x0f'); key('n'); key('p'); key('\x0c'); key('\x1b'); assert.equal(f.transport.calls.length,2);
    assert.deepEqual(await readRun(join(f.root,'data'),runId),before);
    assert.match(f.screen(),/known/);
    key('\x03'); key('\x03'); const closed=await f.app.closed;
    assert.equal(closed.result?.status,'completed'); assert.equal(closed.result?.cleanup,'confirmed');
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
    key('\x1bOQ');key('\x1b[B');key('\x1b[B');key('\x1b[B');key('\r');
    assert.match(f.screen(),/line 79/);assert.match(f.screen(),/稳定草稿/);
    f.terminal.columns=40;f.terminal.rows=12;f.terminal.resize();assert.equal(f.app.screen().length,12);
    f.terminal.columns=30;f.terminal.rows=8;f.terminal.resize();assert.match(f.screen(),/窗口过小/);
    f.terminal.columns=80;f.terminal.rows=24;f.terminal.resize();assert.match(f.screen(),/稳定草稿/);
    source!.enqueue(new TextEncoder().encode('data: {"id":"stream","model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));source!.close();
    await until(()=>f.screen().includes('已完成'));
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
      await until(()=>f.screen().includes(kind==='truncated'?'源输出截断':'读取 · 失败'));
      assert.doesNotMatch(f.screen(),/tool\.summary|tool\.result|attemptId/);
      release();await until(()=>f.screen().includes('已完成'));
    } finally {release();await f.app.exit();}
  }
});
