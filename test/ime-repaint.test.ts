import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { COLOR_TIER, overrideColorTierForTest } from '../src/tui/theme.js';
import { captureSnapshot } from '../src/tui/snapshot.js';

// Track only the actual row-replacement writes emitted by pi-tui. A terminal's
// external preedit drawing can damage this display without changing app.screen().
class PaintedTerminal implements Terminal {
  columns=132;rows=38;kittyProtocolActive=false;painted=new Map<number,string>();
  private runningFrameReady!:()=>void;
  readonly runningFrame=new Promise<void>(resolve=>{this.runningFrameReady=resolve;});
  input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  write(data:string){
    for(const match of data.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|\x1b\[\?2026l|$)/g))this.painted.set(Number(match[1]),match[2]);
    // Provider entry precedes the UI's periodic refresh of execution facts.
    if([...this.painted.values()].some(line=>/deepseek-flash · offline.*本任务 0 tok \+1 unknown/.test(stripTerminalSequences(line))))this.runningFrameReady();
  }
  stop(){}async drainInput(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
const turn=()=>new Promise(resolve=>setTimeout(resolve,30));

test('a delivered empty Backspace repaints terminal-damaged input without changing the draft or submitting work',async()=>{
  const savedTier=COLOR_TIER,root=mkdtempSync(join(tmpdir(),'durio-ime-repaint-')),workspace=join(root,'project');mkdirSync(workspace);
  const terminal=new PaintedTerminal();let started!:()=>void,calls=0;
  const dispatched=new Promise<void>(resolve=>{started=resolve;});
  const transport:typeof fetch=async(_url,init)=>{calls++;started();return await new Promise<Response>((_resolve,reject)=>{const abort=()=>reject(Error('fixture stream cancelled'));init!.signal!.addEventListener('abort',abort,{once:true});if(init!.signal!.aborted)abort();});};
  const app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot:join(root,'drafts'),mode:'offline',transport,terminal,widthCalibration:false});
  try {
    app.start();terminal.input('probe');terminal.input('\r');await dispatched;await terminal.runningFrame;
    for(const tier of ['truecolor','256color','none'] as const){
      overrideColorTierForTest(tier);await turn();
      const screen=app.screen(),row=screen.findIndex(line=>stripTerminalSequences(line).includes('补充当前任务'))+1;
      assert.ok(row>0);
      const expected=stripTerminalSequences(screen[row-1]);assert.match(expected,/^\s*❯ .*\s*$/);
      assert.equal(stripTerminalSequences(terminal.painted.get(row)!),expected,'erase the actual current input row, with no asynchronous gap after locating it');
      terminal.painted.set(row,' '.repeat(terminal.columns)); // Model external erase; no invented composition input event.
      terminal.input('\x7f');await turn();
      const repainted=terminal.painted.get(row)!;
      assert.equal(stripTerminalSequences(repainted),expected,'the physical input row must be restored even when editor text is unchanged');
      const grid=captureSnapshot([repainted],terminal.columns,1,tier);
      assert.ok(grid.rows[0].every(cell=>cell.bg===(undefined)));
      assert.equal(calls,1,'repairing the display cannot submit a task');
      assert.ok(app.screen().some(line=>stripTerminalSequences(line).includes('补充当前任务')),'the input remains empty with the original placeholder');
    }
  }finally{await app.exit();overrideColorTierForTest(savedTier);}
});
