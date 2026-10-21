import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { readQueue } from '../src/runtime.js';
import { COLOR_TIER, overrideColorTierForTest } from '../src/tui/theme.js';

class TestTerminal implements Terminal {
  columns=132; rows=38; kittyProtocolActive=false;
  input:(data:string)=>void=()=>{}; resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){} async drainInput(){} write(){} moveBy(){} hideCursor(){} showCursor(){}
  clearLine(){} clearFromCursor(){} clearScreen(){} setTitle(){} setProgress(){} setProgramStatus(){}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>boolean,detail?:()=>string){for(let i=0;i<200;i++){if(check())return;await wait();}throw Error(`completion fixture timed out${detail?'\n'+detail():''}`);}

test('session completion borrows only main rows and preserves fixed regions, scrolling and keyboard/mouse input',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-completion-layout-')),workspace=join(root,'project'),dataRoot=join(root,'data');
  mkdirSync(workspace);
  for(const name of ['alpha.txt','bravo.txt','delta.txt','omega.txt'])writeFileSync(join(workspace,name),'fixture');
  let stream:ReadableStreamDefaultController<Uint8Array>|undefined;
  const transport:typeof fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
    stream=controller;
    init?.signal?.addEventListener('abort',()=>controller.error(Error('fixture stopped')),{once:true});
  }}),{headers:{'content-type':'text/event-stream'}});
  const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',transport,terminal,widthCalibration:false});
  const key=(data:string)=>terminal.input(data),lines=()=>app.screen().map(stripTerminalSequences);
  const anchors=(shown:string[])=>({header:shown.findIndex(line=>line.includes('pi-durio')),top:shown.findIndex(line=>line.includes('╭')),bottom:shown.findIndex(line=>line.includes('╰')),status:shown.findIndex(line=>/运行 · 第/.test(line)),queue:shown.findIndex(line=>/^\s*(?:↳ steer|队列 \d+ 项)/.test(line)),footer:shown.findIndex(line=>line.includes('ctx '))});
  const emit=(number:number)=>stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'completion',model:'deepseek-flash',choices:[{index:0,delta:{content:`output ${number}\n`},finish_reason:null}]})}\n\n`));
  const saved=COLOR_TIER;
  app.start();
  try {
    // 1a shares the input/footer anchors even though it has no separate run status region.
    const welcome=anchors(lines());key('/');await until(()=>lines().some(line=>line.includes('→ /')));
    assert.deepEqual(anchors(lines()),welcome);key('\x1b');key('\x15');
    key('Read');key('\r');await until(()=>!!stream);
    for(let i=0;i<60;i++)emit(i);
    await until(()=>lines().some(line=>line.includes('output 59')));
    key('queued direction');key('\r');await until(()=>readQueue(dataRoot).items.length===1);
    for(const [width,height,tier] of [[132,38,'truecolor'],[132,38,'256color'],[132,38,'none'],[80,24,'truecolor'],[40,12,'truecolor']] as const){
      overrideColorTierForTest(tier);terminal.columns=width;terminal.rows=height;terminal.resize();
      for(const trigger of ['/','@']){
        key('\x15');const closed=lines(),fixed=anchors(closed);
        key(trigger);await until(()=>lines().some(line=>/→ /.test(line)));
        const opened=lines(),menu=opened.findIndex(line=>/→ /.test(line));
        assert.deepEqual(anchors(opened),fixed,`${width}x${height} ${tier} ${trigger}: fixed regions`);
        assert.ok(menu>=0&&menu<fixed.status,'menu occupies the main area above status and queue');
        assert.ok(opened.some(line=>/\(1\/\d+\)/.test(line)),'the menu scroll counter stays visible');
        assert.equal(opened.length,height);assert.ok(app.screen().every(line=>visibleWidth(line)<=width));
        key('\x1b');key('\x15');
        assert.deepEqual(anchors(lines()),fixed,'closing completion restores the same fixed regions');
        assert.deepEqual(lines().filter(line=>line.includes('output ')),closed.filter(line=>line.includes('output ')),'following resumes at the same latest output');
      }
    }
    // User-confirmed compact rule: preserve the selected item and count, or a resize hint below two rows.
    for(const count of [2,3,4]){
      const draft=Array.from({length:count-1},(_,i)=>`line ${i+1}`).join('\n')+'\n';
      key('\x1b[200~'+draft+'\x1b[201~');const fixed=anchors(lines());
      key('@');await until(()=>lines().some(line=>/→ |补全空间不足/.test(line)));
      assert.deepEqual(anchors(lines()),fixed,`${count} input lines keep every fixed region`);
      if(count<4){assert.match(lines().join('\n'),/→ alpha\.txt/);assert.match(lines().join('\n'),/\(1\/4\)/);}
      else {assert.match(lines().join('\n'),/补全空间不足 · 请扩大窗口/);assert.doesNotMatch(lines().join('\n'),/→ /);}
      key('\x1b[B');key('\x1b[B');
      if(count<4){assert.match(lines().join('\n'),/→ delta\.txt/);assert.match(lines().join('\n'),/\(3\/4\)/);}
      terminal.columns=132;terminal.rows=38;terminal.resize();
      assert.match(lines().join('\n'),/→ delta\.txt/,'expanding the window keeps the selected item');
      assert.match(lines().join('\n'),/\(3\/4\)/);assert.doesNotMatch(lines().join('\n'),/补全空间不足/);
      terminal.columns=40;terminal.rows=12;terminal.resize();
      assert.deepEqual(anchors(lines()),fixed,'returning to the compact window preserves the input and fixed regions');
      if(count<4){
        const selected=lines().findIndex(line=>line.includes('→ delta.txt'));
        key(`\x1b[<0;7;${selected+1}M`);key(`\x1b[<0;7;${selected+1}m`);key('!');
        assert.match(lines().join('\n'),/@delta\.txt !/,'a compact menu click applies its displayed item and keeps editor focus');
      }else{
        const hint=lines().findIndex(line=>line.includes('补全空间不足'));
        key(`\x1b[<0;7;${hint+1}M`);key(`\x1b[<0;7;${hint+1}m`);key('a');
        assert.match(lines().join('\n'),/│  @a /,'the resize hint is not a clickable completion and input remains editable');
        key('\x1b');
      }
      assert.equal(lines().length,12);assert.ok(app.screen().every(line=>visibleWidth(line)<=40));
      for(let i=0;i<count;i++){key('\x15');if(i<count-1)key('\x7f');}
    }
    terminal.columns=132;terminal.rows=38;terminal.resize();lines();key('\x1b[5~');
    const paused=lines().filter(line=>line.includes('output '));
    key('/');await until(()=>lines().some(line=>line.includes('→ /')));
    const shortened=lines().filter(line=>line.includes('output '));
    assert.ok(shortened.length<paused.length);assert.deepEqual(shortened.map(line=>line.match(/output \d+/)?.[0]),paused.slice(0,shortened.length).map(line=>line.match(/output \d+/)?.[0]),'opening keeps the paused top row');
    emit(60);await wait();key('\x1b');key('\x15');
    assert.deepEqual(lines().filter(line=>line.includes('output ')),paused,'closing does not move a paused viewport or enable following');
    key('/bottom');key('\r');key(' ');key('\x15');lines();
    assert.ok(lines().some(line=>line.includes('output 60')),'the explicit bottom action reaches the latest output before pausing');
    const outputRow=lines().findIndex(line=>line.includes('output '));
    key(`\x1b[<0;9;${outputRow+1}M`);key(`\x1b[<0;9;${outputRow+1}m`);
    assert.match(lines().join('\n'),/↓ 回到底部/,'selecting transcript text pauses following even at the latest output');
    key('/');await until(()=>lines().some(line=>line.includes('→ /')));key('\x1b');key('\x15');
    assert.match(lines().join('\n'),/↓ 回到底部/,'closing completion does not re-enable a deliberately paused end position');
    // Real terminal mouse coordinates include side margins and the menu region's screen offset.
    key('@');await until(()=>lines().some(line=>/→ .*alpha\.txt/.test(line)),()=>lines().join('\n'));
    const menu=lines().findIndex(line=>/→ .*alpha\.txt/.test(line));
    key(`\x1b[<0;7;${menu+2}M`);key(`\x1b[<0;7;${menu+2}m`);
    key('!');assert.match(lines().join('\n'),/❯ @bravo\.txt !/,'clicking the second item retains editor focus');
    key('\x15');key('@');await until(()=>lines().some(line=>/→ .*alpha\.txt/.test(line)));key('\x1b[B');key('\t');
    assert.match(lines().join('\n'),/❯ @bravo\.txt /,'Down and Tab apply the selected item');
    key('\x15');key('@');await until(()=>lines().some(line=>/→ .*alpha\.txt/.test(line)));key('\x1b[B');key('\r');
    assert.match(lines().join('\n'),/❯ @bravo\.txt /,'Enter completes a file without submitting');
    assert.equal(readQueue(dataRoot).items.length,1);
  } finally {overrideColorTierForTest(saved);await app.exit();}
});
