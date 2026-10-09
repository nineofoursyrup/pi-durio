import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { StdinBuffer, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { runReadTask } from '../src/runtime.js';

// A separate process answers on a real pipe so a synchronous recovery check can
// leave a valid CPR/DA reply queued in the OS while the probe's timer expires.
class ReplyTerminal implements Terminal {
  columns=80;rows=24;kittyProtocolActive=false;writes:string[]=[];pending=0;
  hold=false;held:string[]=[];
  input:(data:string)=>void=()=>{};
  private buffer=new StdinBuffer();
  readonly child=spawn(process.execPath,['--input-type=module','-e',`
    import {createInterface} from 'node:readline';
    process.stdout.write('READY\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const sample=JSON.parse(line);let width=0;
      for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(sample))
        width+=/^[\\x20-\\x7e]$/.test(segment)?1:/[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]/.test(segment)?2:1;
      setTimeout(()=>process.stdout.write('\\x1b[2;'+(width+1)+'R\\x1b[?1;2c'),2);
    });
  `],{stdio:['pipe','pipe','inherit']});
  readonly ready:Promise<void>;
  constructor(){
    this.buffer.on('data',data=>{if(data==='\x1b[?1;2c')this.pending--;this.input(data);});
    this.ready=new Promise(resolve=>this.child.stdout.once('data',chunk=>{assert.equal(chunk.toString(),'READY\n');this.child.stdout.on('data',chunk=>this.buffer.process(chunk.toString()));resolve();}));
  }
  start(input:(data:string)=>void){this.input=input;}
  key(data:string){this.buffer.process(data);}
  write(data:string){this.writes.push(data);const probe=/\x1b\[2;1H\x1b\[2K([^\x1b]*)\x1b\[6n/.exec(data);if(probe){this.pending++;if(this.hold)this.held.push(probe[1]);else this.child.stdin.write(JSON.stringify(probe[1])+'\n');}}
  release(){this.hold=false;for(const sample of this.held.splice(0))this.child.stdin.write(JSON.stringify(sample)+'\n');}
  stop(){}async drainInput(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
  close(){this.buffer.destroy();this.child.stdin.end();this.child.kill();}
}

async function until(predicate:()=>boolean){for(let i=0;i<600;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('condition timed out');}

for(const entry of ['startup','command'])test(`recovery ${entry} waits for slow execution-material checks before starting timed width queries`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'durio-recovery-width-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Recovery width fixture');
  const controller=new AbortController();
  const original=await runReadTask({workspace,dataRoot,input:'Interrupted task',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('interrupted')));controller.abort();})});
  const terminal=new ReplyTerminal();await terminal.ready;
  const app=new ReadOnlyTui({workspace,dataRoot,runId:entry==='startup'?original.runId:undefined,draftRoot:join(root,'drafts'),mode:'offline',terminal});
  const realRead=fs.readFileSync;let checks=0,delayMs=0,queriesDuringCheck=0;
  const slowRead=t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{
    if(!checks&&String(args[0]).includes('/node_modules/')){
      checks++;queriesDuringCheck=terminal.pending;
      const start=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1400);delayMs=performance.now()-start;
    }
    return Reflect.apply(realRead,fs,args);
  });syncBuiltinESMExports();
  try {
    app.start();
    if(entry==='command'){
      await until(()=>/\x1b\[\d+;\d+H\x1b\[\?25h\x1b\[\?2026l$/.test(terminal.writes.at(-1)??''));
      terminal.key(`/recover ${original.runId}`);terminal.key('\r');
    }
    await until(()=>terminal.writes.some(value=>value.includes('Display unverified:'))||terminal.writes.some(value=>value.includes('恢复核对 ·')));
    t.diagnostic(JSON.stringify({checks,delayMs,queriesDuringCheck,unverified:terminal.writes.filter(value=>value.includes('Display unverified:'))}));
    assert.equal(checks,1,'the real recovery path verified original execution bytes');
    assert.ok(delayMs>=1400,'the real check exceeded the unchanged 1200ms probe deadline');
    assert.equal(queriesDuringCheck,0,'execution verification and timed CPR exchanges never overlap');
    assert.doesNotMatch(terminal.writes.join(''),/WIDTH_CPR_TIMEOUT/,'valid pipe replies must not time out behind startup recovery work');
    assert.ok(terminal.writes.some(value=>value.includes('恢复核对 ·')),'the measured recovery panel is painted without Ctrl+L');
    if(entry==='command'){
      // A truly missing reply must still fail, and retry must await its late DA1.
      terminal.hold=true;terminal.key('\x0c');
      await until(()=>terminal.writes.some(value=>value.includes('WIDTH_CPR_TIMEOUT')));
      terminal.key('\x0c');assert.match(terminal.writes.at(-1)!,/Prior terminal reply incomplete/);
      terminal.release();await until(()=>terminal.pending===0);
      const before=terminal.writes.length;terminal.key('\x0c');
      await until(()=>terminal.writes.slice(before).some(value=>value.includes('恢复核对 ·')));
      assert.doesNotMatch(terminal.writes.slice(before).join(''),/Display unverified:/,'a fresh retry succeeds after the late response boundary');
    }
    const exit=await app.exit();assert.equal(exit.widthCalibration?.status,'measured');
  }finally{slowRead.mock.restore();syncBuiltinESMExports();await app.exit();terminal.close();}
});
