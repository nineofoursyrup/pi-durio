import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiAltScreen, setGraphemeWidthOverrides, stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { HardwareCursorEditor } from '../src/tui/cursor.js';

class TestTerminal implements Terminal {
  columns=132;rows=38;kittyProtocolActive=false;
  input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}
  clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}

for(const ambiguity of [1,2])test(`overflow input keeps its rules and a single press/release inserts at the visible character (${ambiguity}-column ambiguous profile)`,async()=>{
  const failures:unknown[]=[];
  for(const [columns,rows]of[[132,38],[80,24],[40,12]]){
    const root=mkdtempSync(join(tmpdir(),'durio-input-overflow-')),workspace=join(root,'project');mkdirSync(workspace);
    const terminal=new TestTerminal();terminal.columns=columns;terminal.rows=rows;
    const app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false});
    const text=()=>app.screen().map(stripTerminalSequences);
    try{
      app.start();setGraphemeWidthOverrides(new Map(Array.from('─│╭╮╰╯↑↓…·◇◆≈',glyph=>[glyph,ambiguity])));
      for(let line=1;line<=12;line++){terminal.input(`LINE${String(line).padStart(2,'0')} abcdef`);if(line<12)terminal.input('\x1b[13;2u');}
      const before=text(),content=before.map((line,row)=>({line,row})).filter(item=>/LINE\d+/.test(item.line));
      assert.ok(content.length>0&&content.length<12,'the complete app frame has overflowing input');
      assert.ok(app.screen().every(line=>visibleWidth(line)<=columns),'every rendered row fits its terminal');
      const top=before[content[0].row-1]?.trim()??'',bottom=before[content.at(-1)!.row+1]?.trim()??'';
      if(!/^─.*↑ \d+ more .*─ *$/.test(top)||!/^─+ *$/.test(bottom))failures.push({columns,rows,kind:'missing-rules',top,bottom,visible:content.map(item=>item.line.trim())});
      const target=before.findIndex(line=>line.includes('LINE10 abcdef'));assert.ok(target>=0,'LINE10 is visible before the click');
      // This target prefix is entirely ASCII: its index is an independent terminal-column oracle.
      const x=before[target].indexOf('abcdef');
      terminal.input(`\x1b[<0;${x+1};${target+1}M`);
      terminal.input(`\x1b[<0;${x+1};${target+1}m`);
      terminal.input('X');
      const after=text();
      if(!after.some(line=>line.includes('LINE10 Xabcdef')))failures.push({columns,rows,kind:'click-position',target:{x:x+1,y:target+1},visible:after.filter(line=>/LINE\d+/.test(line)).map(line=>line.trim())});
      // Moving to the first logical line exposes hidden content below the same bounded window.
      for(let line=0;line<12;line++)terminal.input('\x1b[A');
      const atTop=text(),first=atTop.findIndex(line=>line.includes('LINE01 abcdef')),last=atTop.findIndex(line=>line.includes('LINE04 abcdef'));
      assert.ok(first>0&&last===first+3,'a six-row input area keeps four content rows');
      assert.match(atTop[first-1].trim(),/^─+$/);
      assert.match(atTop[last+1].trim(),/^─.*↓ 8 more .*─ *$/,'the bottom rule counts every hidden line below');
    }finally{setGraphemeWidthOverrides();await app.exit();}
  }
  assert.deepEqual(failures,[],'both overflow rules and the clicked insertion position are observable in the complete frame');
});


test('a three-row input window keeps both rules and maps a single content row while moving upward',()=>{
  const terminal=new TestTerminal();terminal.columns=40;terminal.rows=12;
  const tui=new TuiAltScreen(terminal,true),identity=(text:string)=>text;
  const editor=new HardwareCursorEditor(tui,{borderColor:identity,selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}});
  editor.setInputHeightLimit(()=>3);editor.setText(Array.from({length:12},(_,i)=>`LINE${String(i+1).padStart(2,'0')} abcdef`).join('\n'));
  tui.setLayoutRoot(editor);tui.setFocus(editor);
  const screen=()=>{tui.renderNow(true);return tui.getScreenLines().map(stripTerminalSequences);};
  try{
    setGraphemeWidthOverrides(new Map(Array.from('─↑↓',glyph=>[glyph,2])));tui.start();
    const before=screen();assert.match(before[0],/↑ 11 more/);assert.match(before[1],/LINE12 abcdef/);assert.match(before[2].trim(),/^─+$/);
    const x=visibleWidth(before[1].slice(0,before[1].indexOf('abcdef')))+1;
    terminal.input(`\x1b[<0;${x};2M`);terminal.input(`\x1b[<0;${x};2m`);terminal.input('X');
    assert.match(screen()[1],/LINE12 Xabcdef/);
    terminal.input('\x1b[A');const above=screen();
    assert.match(above[0],/↑ 10 more/);assert.match(above[1],/LINE11 abcdef/);assert.match(above[2],/↓ 1 more/);
  }finally{tui.stop();setGraphemeWidthOverrides();}
});
