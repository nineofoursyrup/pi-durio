import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StdinBuffer } from '@earendil-works/pi-tui';
import { TerminalWidthProbe } from '../src/tui/width-probe.js';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Terminal, visibleWidth } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { demoTransport } from '../src/offline.js';
import { processMeasurements } from '../src/self-measurement.js';
import { records } from '../src/history.js';

test('native width query survives split/batched replies and preserves ordinary input and pasted CPR text', async()=>{
  const ordinary:string[]=[],writes:string[]=[];
  const buffer=new StdinBuffer();
  const terminal={columns:80,rows:24,write:(data:string)=>{
    writes.push(data);
    if(!data.includes('\x1b[6n'))return;
    const col=data.includes('A👩‍💻B')?8:6; // Independent Apple Terminal CPR, not Pi's width function.
    queueMicrotask(()=>{buffer.process('x\x1b[2;');buffer.process(`${col}R\x1b[?1;2c\x1b[1;2R`);});
  }};
  const probe=new TerminalWidthProbe(terminal);
  buffer.on('data',data=>{if(!probe.consume(data))ordinary.push(data);});
  buffer.on('paste',data=>{const paste=`\x1b[200~${data}\x1b[201~`;if(!probe.consume(paste))ordinary.push(paste);});
  const measuring=probe.measure('👩‍💻',new AbortController().signal);
  buffer.process('\x1b[200~pasted \x1b[2;99R\x1b[?1;2c\x1b[201~');
  assert.equal(await measuring,5);
  assert.deepEqual(ordinary,['\x1b[200~pasted \x1b[2;99R\x1b[?1;2c\x1b[201~','x','\x1b[1;2R','x','\x1b[1;2R']);
  assert.equal(writes.filter(data=>data.includes('\x1b[6n')).length,2);
});

test('timed-out CPR cannot be reassigned before its trailing DA1, and contextual mismatch stays unknown',async()=>{
  const writes:string[]=[];
  const probe=new TerminalWidthProbe({columns:80,rows:24,write:data=>writes.push(data)},10);
  await assert.rejects(probe.measure('中',new AbortController().signal),/TIMEOUT/);
  await assert.rejects(probe.measure('👩‍💻',new AbortController().signal),/PRIOR_QUERY_BOUNDARY_UNKNOWN/);
  assert.equal(writes.length,1,'no newer query can reuse a late CPR');
  probe.consume('\x1b[2;3R');probe.consume('\x1b[?1;2c');
  const retry=probe.measure('👩‍💻',new AbortController().signal);
  probe.consume('\x1b[2;6R');probe.consume('\x1b[?1;2c');await Promise.resolve();
  probe.consume('\x1b[2;9R');probe.consume('\x1b[?1;2c');
  await assert.rejects(retry,/CONTEXT_MISMATCH/);
});

class MeasuringTerminal implements Terminal {
  columns=80;rows=24;kittyProtocolActive=false;writes:string[]=[];stopped=false;
  input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  hold?:string;held:Array<()=>void>=[];samples:string[]=[];
  private buffer=new StdinBuffer();
  constructor(){this.buffer.on('data',data=>this.input(data));this.buffer.on('paste',data=>this.input(`\x1b[200~${data}\x1b[201~`));}
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  key(data:string){this.buffer.process(data);}
  write(data:string){
    this.writes.push(data);
    const probe=/\x1b\[2;1H\x1b\[2K([^\x1b]*)\x1b\[6n/.exec(data);
    if(!probe)return;
    const sample=probe[1];this.samples.push(sample);
    // Controlled terminal oracle. Emoji width 5 is copied from the immutable human CPR;
    // other widths only describe this test terminal, never native acceptance.
    let width=0;for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(sample))
      width+=segment==='👩‍💻'?5:segment==='é'?1:/^[\x20-\x7e]$/.test(segment)?1:/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/.test(segment)?2:1;
    const respond=()=>{this.buffer.process('\x1b[2;');this.buffer.process(`${width+1}R\x1b[?1;2c`);};
    if(this.hold&&sample.includes(this.hold))this.held.push(respond);else queueMicrotask(respond);
  }
  release(){this.hold=undefined;for(const respond of this.held.splice(0))respond();}
  stop(){this.stopped=true;}async drainInput(){}
  moveBy(){}hideCursor(){this.write('\x1b[?25l');}showCursor(){this.write('\x1b[?25h');}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function until(predicate:()=>boolean){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timed out');}
function calibratedFixture(transportOverride?:typeof fetch,onProviderEntered?:()=>void){
  const root=mkdtempSync(join(tmpdir(),'durio-calibrated-')),workspace=join(root,'project');mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Fixture');
  const terminal=new MeasuringTerminal(),transport=demoTransport(),draftRoot=join(root,'drafts');
  const dispatch=transportOverride??transport.fetch;
  const observed:typeof fetch=onProviderEntered?(...args)=>{const response=dispatch(...args);onProviderEntered();return response;}:dispatch;
  const app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot,mode:'offline',transport:observed,terminal,copy:async()=>true});app.start();
  const painted=()=>/\x1b\[\d+;\d+H\x1b\[\?25h\x1b\[\?2026l$/.test(terminal.writes.at(-1)??'');
  return {root,terminal,transport,app,draftRoot,painted};
}

test('resize during an outstanding width query automatically remeasures and paints the new size',async()=>{
  const f=calibratedFixture();
  try {
    await until(f.painted);
    f.terminal.columns=40;f.terminal.rows=12;f.terminal.resize();await until(f.painted);
    f.terminal.hold='Ω';f.terminal.key('Ω');await until(()=>f.terminal.held.length===1);
    const before=f.terminal.writes.length;
    f.terminal.columns=244;f.terminal.rows=68;f.terminal.resize();
    f.terminal.release();
    await until(()=>f.painted()||f.terminal.writes.slice(before).some(data=>data.includes('Display unverified')));
    assert.doesNotMatch(f.terminal.writes.slice(before).join(''),/Display unverified/,'the late window-change result must not wait for another resize or Ctrl+L');
    assert.ok(f.painted(),'measurement completion repaints at the new dimensions');
    assert.equal(f.terminal.samples.filter(sample=>sample==='Ω').length,2,'the interrupted grapheme is measured again after the reply boundary');
    assert.match(f.terminal.writes.at(-1)!,/\x1b\[65;\d+H\x1b\[\?25h/);
  } finally {
    f.terminal.release();await f.app.exit();
  }
});

test('repeated in-flight resizes exhaust a bounded retry budget and Ctrl+L can start a fresh measurement',async()=>{
  const f=calibratedFixture();
  try {
    await until(f.painted);f.terminal.hold='Ω';f.terminal.key('Ω');
    for(let attempt=0;attempt<3;attempt++) {
      await until(()=>f.terminal.held.length===1);
      f.terminal.columns++;f.terminal.resize();f.terminal.held.shift()!();
    }
    await until(()=>f.terminal.writes.some(data=>data.includes('Display unverified: Error: WIDTH_WINDOW_CHANGED')));
    const queries=f.terminal.samples.length;
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.terminal.samples.length,queries,'no unbounded automatic exchange follows the third interrupted attempt');
    assert.equal(f.terminal.samples.filter(sample=>sample==='Ω').length,3);
    assert.equal(f.terminal.held.length,0,'every failed attempt consumed its DA1 boundary');
    f.terminal.release();const before=f.terminal.writes.length;f.terminal.key('\x0c');await until(f.painted);
    assert.doesNotMatch(f.terminal.writes.slice(before).join(''),/Display unverified/,'explicit Ctrl+L gets a fresh bounded calibration');
    assert.ok(f.app.screen().join('\n').includes('Ω'),'retry preserves the entered draft');
  } finally {
    f.terminal.release();await f.app.exit();
  }
});

test('self timing includes input waiting for calibration and ignores blocked frames and width-query replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-width-'));
  const terminal = new MeasuringTerminal(); terminal.hold = 'A';
  const app = new ReadOnlyTui({ workspace: root, dataRoot: join(root, 'data'), draftRoot: join(root, 'drafts'), mode: 'offline', terminal });
  const before = processMeasurements.snapshot().keys.samples;
  try {
    app.start(); terminal.key('x');
    await until(() => terminal.held.length === 1);
    app.screen();
    assert.equal(processMeasurements.snapshot().keys.samples, before, 'neither a blocked frame nor calibration traffic completes a key sample');
    terminal.release();
    await until(() => processMeasurements.snapshot().keys.samples === before + 1);
    assert.equal(processMeasurements.snapshot().keys.samples, before + 1, 'protocol replies are not additional key samples');
  } finally { terminal.release(); await app.exit(); }
});

for(const resizeDuringQuery of [false,true])test(`starting a task leaves no timed width query across synchronous execution capture${resizeDuringQuery?' after an in-flight resize':''}`, async () => {
  let entered!:()=>void;const providerEntered=new Promise<void>(resolve=>{entered=resolve;});
  const f=calibratedFixture(undefined,entered);
  const artifacts=()=>existsSync(join(f.root,'data/host.sqlite'))?[...records(join(f.root,'data'),{kinds:['execution.artifact']})]:[];
  try {
    await until(f.painted);
    f.terminal.hold='◆';f.terminal.key('probe');f.terminal.key('\r');f.app.screen();
    await until(()=>f.terminal.held.length===1);
    if(resizeDuringQuery){f.terminal.columns++;f.terminal.resize();}
    // Give ordinary asynchronous startup a turn while the controlled terminal has
    // an outstanding reply. Artifact capture must wait for that reply boundary.
    await new Promise(resolve=>setTimeout(resolve,300));
    // A terminal reply can be dispatched after overdue timers when host work has
    // blocked the loop. Preserve that ordering instead of replying in a microtask.
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(artifacts().length,0,'execution capture waits for the terminal reply, even on a fast filesystem');
    assert.equal(f.transport.calls.length,0,'runtime must not pass execution capture while a CPR is still in flight');
    assert.equal(f.terminal.writes.some(data=>data.includes('Display unverified')),false,'host preparation must not expire the terminal query');
    f.terminal.release();
    // The query is released; wait for the real transport boundary, not a wall-clock budget for artifact I/O.
    await providerEntered;
    assert.ok(f.transport.calls.length>0);
    assert.equal(artifacts().length,1,'execution capture still precedes the provider request');
  } finally {
    f.terminal.release();
    const result=await f.app.exit();
    assert.equal(result.widthCalibration?.error,null);
  }
});

test('stop while execution capture waits for calibration prevents capture and provider dispatch', async () => {
  const f=calibratedFixture();
  try {
    await until(f.painted);
    f.terminal.hold='◆';f.terminal.key('probe');f.terminal.key('\r');f.app.screen();
    await until(()=>f.terminal.held.length===1);
    await new Promise(resolve=>setTimeout(resolve,300));
    f.terminal.key('\x1b');f.terminal.release();
    const result=await f.app.exit();
    assert.equal(f.transport.calls.length,0);
    assert.equal(result.result?.status,'aborted');assert.equal(result.result?.cleanup,'confirmed');
    assert.equal([...records(join(f.root,'data'),{kinds:['execution.artifact']})].length,0,'the post-wait guard preserves cancellation');
  } finally {f.terminal.release();await f.app.exit();}
});

test('an empty Backspace held by width calibration is retained instead of bypassing the gate or replaying',async()=>{
  const f=calibratedFixture();
  try {
    await until(f.painted);f.terminal.hold='A';f.terminal.key('\x0c');
    await until(()=>f.terminal.held.length===1);
    const writes=f.terminal.writes.length;f.terminal.key('\x7f');await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.terminal.writes.length,writes,'an input-row repair must not paint while a width reply is pending');
    f.terminal.release();await until(f.painted);
    const retained=readdirSync(join(f.draftRoot,'pending-input')).map(name=>JSON.parse(readFileSync(join(f.draftRoot,'pending-input',name),'utf8')));
    assert.ok(retained.some(record=>record.reason==='action-needs-current-frame'&&record.automaticReplay===false&&record.inputs.some((event:{data:string})=>event.data==='\x7f')));
    assert.equal(f.transport.calls.length,0);
  } finally {f.terminal.release();await f.app.exit();}
});

for(const [label,key,draft] of [['Ctrl+D','\x04',''],['Ctrl+C','\x03','keep this draft']] as const) {
  test(`calibration replies between the first two ${label} presses do not cancel exit confirmation`,async()=>{
    const f=calibratedFixture();
    try {
      await until(f.painted);
      if(draft){f.terminal.key(draft);await until(f.painted);}
      const before=f.terminal.samples.length,firstAt=Date.now();f.terminal.key(key);
      await until(()=>f.painted()&&f.terminal.samples.length>before);
      assert.ok(Date.now()-firstAt<800,'responses and the second key are inside the unchanged confirmation window');
      f.terminal.key(key);await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(f.terminal.stopped,true,'CPR/DA1 are protocol responses, not user actions that revoke confirmation');
      const result=await f.app.closed;assert.equal(result.draftSaved,!!draft);assert.equal(f.transport.calls.length,0);
    }finally{await f.app.exit();}
  });
}

test('real input, focus and resize revoke confirmation on arrival even while width replies are held',async()=>{
  for(const change of ['text','focus','page','modified-f3','pasted-reply','resize']) {
    const f=calibratedFixture();
    try {
      await until(f.painted);f.terminal.hold='A';f.terminal.key('\x04');
      await until(()=>f.terminal.held.length===1);
      if(change==='resize'){f.terminal.columns=81;f.terminal.resize();}
      else f.terminal.key({text:'x',focus:'\x1b[O',page:'\x1b[5~','modified-f3':'\x1b[1;2R','pasted-reply':'\x1b[200~\x1b[2;99R\x1b[?1;2c\x1b[201~'}[change]!);
      f.terminal.key('\x04');await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(f.terminal.stopped,false,`${change} invalidates the first press before any held event is replayed`);
    }finally{f.terminal.release();await f.app.exit();}
  }
});

test('late inactive CPR and fragmented DA1 stay protocol events, while the 800ms expiry remains intact',async()=>{
  const f=calibratedFixture();
  try {
    await until(f.painted);const count=f.terminal.samples.length;
    f.terminal.key('\x04');await until(()=>f.painted()&&f.terminal.samples.length>count);
    await new Promise(resolve=>setTimeout(resolve,820));
    f.terminal.key('\x04');assert.equal(f.terminal.stopped,false,'the expired first press cannot authorize exit');
    f.terminal.key('\x1b[2;');await new Promise(resolve=>setTimeout(resolve,2));
    f.terminal.key('99R\x1b[?1;');await new Promise(resolve=>setTimeout(resolve,2));f.terminal.key('2c');
    f.terminal.key('\x04');await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.terminal.stopped,true,'a late complete reply does not revoke a fresh confirmation');
  }finally{await f.app.exit();}
});

test('product first paste is measured before paint, keeps later keys ordered and discovers combined graphemes',async()=>{
  let entered!:()=>void;const providerEntered=new Promise<void>(resolve=>{entered=resolve;});
  const f=calibratedFixture(undefined,entered),key=(data:string)=>f.terminal.key(data);
  try {
    // Arrival during the first frame's asynchronous calibration is retained, including the first key.
    key('\x1b[200~A👩‍💻é中B\x1b[201~');
    await until(()=>f.painted()&&f.terminal.samples.includes('👩‍💻'));
    assert.equal(visibleWidth('A👩‍💻é中B'),10);
    // 输入内容左侧 2 列内边距加 1 列闭合框线（U10）：插入点在第 14 列。
    assert.match(f.terminal.writes.at(-1)!,/\x1b\[21;14H\x1b\[\?25h/);
    assert.equal(f.transport.calls.length,0);
    key('\x03');await until(f.painted);
    key('e');key('\u0301');await until(()=>f.painted()&&f.terminal.samples.includes('é'));
    assert.ok(f.app.screen().join('\n').includes('é'));
    key('\x03');await until(f.painted);
    f.terminal.hold='Ω';key('Ω');key('Z');key('\r');
    await until(()=>f.terminal.held.length===1);
    assert.equal(f.transport.calls.length,0,'Enter stays pending while native width is unknown');
    assert.equal(f.terminal.writes.some(data=>data.includes('ΩZ')&&!data.includes('\x1b[6n')),false);
    f.terminal.release();await until(f.painted);
    assert.equal(f.transport.calls.length,0,'queued actions require a fresh action against the current frame');
    key('\r');await providerEntered;assert.ok(f.transport.calls.length>0);
  }finally{await f.app.exit();}
});

test('pending calibration preserves modal priority and Ctrl+C exit saves unapplied input without replay',async()=>{
  const f=calibratedFixture(),key=(data:string)=>f.terminal.key(data);
  try {
    await until(f.painted);
    key('?');await new Promise(r=>setTimeout(r,10));
    // The help view consumes cancellation first, whether its new characters are still being measured or ready.
    key('\x03');key('\x03');assert.equal(f.terminal.stopped,false);key('\x1b');await until(f.painted);
    f.terminal.hold='Ω';key('Ω');key('unapplied');key('\r');await until(()=>f.terminal.held.length===1);
    key('\x03');key('\x03');f.terminal.release();
    const result=await f.app.closed;
    assert.equal(result.draftSaved,true);assert.equal(f.transport.calls.length,0);assert.equal(f.terminal.stopped,true);
    const retained=readdirSync(join(f.draftRoot,'pending-input')).map(name=>JSON.parse(readFileSync(join(f.draftRoot,'pending-input',name),'utf8')));
    assert.deepEqual(retained.flatMap(record=>record.inputs).map(event=>event.data),[...'unapplied','\r']);
    assert.ok(retained.every(record=>record.state==='not_applied'&&record.automaticReplay===false));
    const drafts=readdirSync(f.draftRoot).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(f.draftRoot,name),'utf8')));
    assert.ok(drafts.some(draft=>draft.text==='Ω'));
    assert.match(f.terminal.writes.join(''),/\x1b\[\?1049l/);
    const output=f.terminal.writes.join('');
    assert.ok(output.lastIndexOf('\x1b[?2026l')>output.lastIndexOf('\x1b[?2026h'),'exit closes synchronized output even when a query was cancelled');
  }finally{await f.app.exit();}
});

test('SIGTERM during a pending measurement saves the draft and receipts, then restores display modes',async()=>{
  const f=calibratedFixture();
  try {
    await until(f.painted);f.terminal.hold='Ω';f.terminal.key('Ω');f.terminal.key('\r');await until(()=>f.terminal.held.length===1);
    process.emit('SIGTERM');f.terminal.release();
    const result=await f.app.closed;
    assert.equal(result.draftSaved,true);assert.equal(f.transport.calls.length,0);assert.equal(result.widthCalibration?.retainedInputs,1);
    const output=f.terminal.writes.join('');
    assert.ok(output.lastIndexOf('\x1b[?2026l')>output.lastIndexOf('\x1b[?2026h'));
    assert.match(output,/\x1b\[\?1049l/);assert.ok(f.terminal.stopped);
  }finally{await f.app.exit();}
});

test('Enter arriving while a run is busy cannot become a new task after that run finishes during calibration',async()=>{
  const fixture=demoTransport();let calls=0,releaseRun!:()=>void;
  let held!:()=>void;const providerHeld=new Promise<void>(resolve=>{held=resolve;});
  const transport:typeof fetch=async(url,init)=>{
    calls++;const response=await fixture.fetch(url,init);
    if(calls===1)await new Promise<void>(resolve=>{releaseRun=resolve;held();});
    return response;
  };
  const f=calibratedFixture(transport),key=(data:string)=>f.terminal.key(data);
  try {
    await until(f.painted);key('Read README');key('\r');await providerHeld;
    f.terminal.hold='Ω';key('Ω');key('next');key('\r');await until(()=>f.terminal.held.length===1);
    releaseRun();await until(()=>f.app.screen().join('\n').replace(/\x1b\[[0-9;]*m/g,'').includes('✓ 完成'));
    f.terminal.release();key('\x0c');await until(f.painted);await new Promise(r=>setTimeout(r,50));
    assert.equal(calls,2,'only the original tool-and-answer task ran; queued Enter never started another');
    const retained=readdirSync(join(f.draftRoot,'pending-input')).map(name=>JSON.parse(readFileSync(join(f.draftRoot,'pending-input',name),'utf8')));
    assert.ok(retained.some(record=>record.reason==='interaction-context-changed'&&record.inputs.some((event:{data:string})=>event.data==='\r')));
    assert.ok(retained.flatMap(record=>record.inputs).every((event:{context:string})=>JSON.parse(event.context).phase==='running'));
  }finally{await f.app.exit();}
});

test('stop remains responsive while new output widths are waiting, without leaking Esc through a modal',async()=>{
  let entered!:()=>void;const providerEntered=new Promise<void>(resolve=>{entered=resolve;});
  let aborted=false;
  const transport:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true});
  });
  const f=calibratedFixture(transport,entered),key=(data:string)=>f.terminal.key(data);
  try {
    await until(f.painted);key('Read');key('\r');await providerEntered;
    key('?');key('\x1b');assert.equal(aborted,false,'first Esc closes the help view');await until(f.painted);
    f.terminal.hold='Ω';key('Ω');key('\r');await until(()=>f.terminal.held.length===1);
    key('\x1b');await until(()=>aborted);assert.equal(f.terminal.stopped,false);
    f.terminal.release();await until(f.painted);
  }finally{const exit=await f.app.exit();assert.equal(exit.result?.status,'aborted');}
});
