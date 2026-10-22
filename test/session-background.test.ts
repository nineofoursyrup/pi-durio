import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { captureSnapshot } from '../src/tui/snapshot.js';
import { COLOR_TIER, overrideColorTierForTest } from '../src/tui/theme.js';

class TestTerminal implements Terminal {
  columns=132;rows=38;kittyProtocolActive=false;input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function until(predicate:()=>boolean) {
  for(let i=0;i<600;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,30));}
  throw Error('session background fixture timed out');
}

test('short and overflowing running transcripts leave unused viewport rows on the terminal background while keeping local blocks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-session-background-')),workspace=join(root,'project');mkdirSync(workspace);
  let stream:ReadableStreamDefaultController<Uint8Array>|undefined;
  const transport:typeof fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
    stream=controller;
    init?.signal?.addEventListener('abort',()=>controller.error(Error('fixture stopped')),{once:true});
  }}),{headers:{'content-type':'text/event-stream'}});
  const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot:join(root,'drafts'),mode:'offline',transport,terminal,widthCalibration:false});
  const saved=COLOR_TIER,failures:string[]=[];
  const emit=(text:string)=>stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'background',model:'deepseek-flash',choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`));
  let emitted=0;
  try {
    app.start();terminal.input('probe');terminal.input('\r');await until(()=>!!stream);
    for(const count of [0,1,9,60]) {
      for(;emitted<count;emitted++)emit(`output ${emitted+1}\n`);
      if(count)await until(()=>app.screen().some(line=>stripTerminalSequences(line).includes(`output ${count}`)));
      for(const tier of ['truecolor','256color','none'] as const)for(const [width,height] of [[132,38],[80,24],[40,12]]) {
        overrideColorTierForTest(tier);terminal.columns=width;terminal.rows=height;terminal.resize();
        const lines=app.screen(),text=lines.map(stripTerminalSequences),grid=captureSnapshot(lines,width,height,tier);
        assert.equal(lines.length,height);assert.ok(lines.every(line=>visibleWidth(line)<=width),'every physical row stays inside the viewport');
        assert.match(text.join('\n'),/运行/,'fixture remains running');
        const input=text.findIndex(line=>line.includes('补充当前任务'));assert.ok(input>0);assert.match(text[input-1].trim(),/^─+$/);assert.match(text[input+1].trim(),/^─+$/);
        if(count)assert.ok(text.some(line=>line.includes(`output ${count}`)),'following keeps the latest output visible');
        let holes=0;
        for(const [y,row]of grid.rows.entries())for(const [x,cell]of row.entries()) {
          // U2 deliberately keeps the user message block; all other cells use the terminal background.
          const expected=tier==='none'?undefined:text[y].trimStart().startsWith('┃ ')&&cell.bg==='bg.block'?'bg.block':undefined;
          if(cell.bg!==expected)holes++;
        }
        if(holes)failures.push(`${tier} ${width}×${height}, ${count} output lines: ${holes} unexpectedly painted cells`);
        if(tier==='none')assert.doesNotMatch(lines.join(''),/\x1b\[(?:38|48);/,'no-color mode emits no color SGR');
      }
      terminal.columns=132;terminal.rows=38;terminal.resize();
    }
    assert.deepEqual(failures,[]);
  } finally {await app.exit();overrideColorTierForTest(saved);}
});
