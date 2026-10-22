import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TuiAltScreen, setGraphemeWidthOverrides, stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { HardwareCursorEditor } from '../src/tui/cursor.js';
import { disabledInputLines } from '../src/tui/recovery.js';
import { ConfirmDialog, frameBox, inputBox, rule } from '../src/tui/view-stack.js';
import { styledLine } from '../src/tui/theme.js';

class TestTerminal implements Terminal {
  columns=132;rows=38;kittyProtocolActive=false;
  input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}
  clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function until(predicate:()=>boolean){for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('running frame timed out');}

test('a running session keeps measured two-column rules and both input rules inside every supported size',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-ambiguous-borders-')),workspace=join(root,'project');mkdirSync(workspace);
  let stream:ReadableStreamDefaultController<Uint8Array>|undefined;
  const transport:typeof fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){
    stream=controller;init?.signal?.addEventListener('abort',()=>controller.error(Error('fixture stopped')),{once:true});
  }}),{headers:{'content-type':'text/event-stream'}});
  const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot:join(root,'data'),draftRoot:join(root,'drafts'),mode:'offline',terminal,transport,widthCalibration:false});
  app.start();
  try {
    terminal.input('probe');terminal.input('\r');await until(()=>!!stream);
    stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'ambiguous',model:'deepseek-flash',choices:[{index:0,delta:{content:'synthetic output\n'},finish_reason:null}]})}\n\n`));
    await until(()=>app.screen().some(line=>line.includes('synthetic output')));
    // These observations come from the retained Terminal.app width-on profile.
    setGraphemeWidthOverrides(new Map(Array.from('─│╭╮╰╯…·◇◆↓≈',glyph=>[glyph,2])));
    for(const [width,height] of [[132,38],[80,24],[40,12]]) {
      terminal.columns=width;terminal.rows=height;terminal.resize();
      const lines=app.screen().map(stripTerminalSequences);
      assert.equal(lines.length,height);
      assert.ok(lines.every(line=>visibleWidth(line)<=width),'no line wraps outside the terminal');
      const content=lines.findIndex(line=>line.includes('补充当前任务')),top=content-1,bottom=content+1;
      assert.ok(top>=0&&bottom>top,'input frame is present');
      assert.match(lines[top].trim(),/^─+ ?$/,'top rule stays complete without an ellipsis');
      assert.match(lines[bottom].trim(),/^─+ ?$/,'bottom rule stays complete without an ellipsis');
      assert.ok(lines.slice(top+1,bottom).every(line=>!/[│╭╮╰╯]/.test(line)),'input has no visible side borders');
      for(const line of lines.filter(line=>line.includes('─')))assert.doesNotMatch(line,/\.\.\.|…/,'rules and borders cannot be ellipsized');
      assert.equal(visibleWidth(lines.find(line=>line.includes('pi-durio'))!),width,'truncated header still fills exactly one row');
    }
  } finally {setGraphemeWidthOverrides();await app.exit();}
});

test('the nine existing display fixtures preserve wide rules and aligned rounded edges without growing the harness screen set',async()=>{
  const fixtureModule=await import(pathToFileURL(join(process.cwd(),'scripts/redesign-terminal/fixtures.mjs')).href);
  const root=join(mkdtempSync(join(tmpdir(),'durio-ambiguous-views-')),'fixture');
  const fixture=await fixtureModule.createFixtures(process.cwd(),root),renderer=await fixtureModule.renderers(process.cwd(),fixture);
  setGraphemeWidthOverrides(new Map(Array.from('─│╭╮╰╯…·◇◆↓≈',glyph=>[glyph,2])));
  try {
    for(const id of ['1a','1b','1c','1d','1e','1f','2a','2b','2c'])for(const [width,height]of[[132,38],[80,24],[40,12]]) {
      const lines:string[]=await renderer.render(id,width,height,'truecolor');
      assert.ok(lines.every(line=>visibleWidth(line)<=width),`${id} ${width}×${height} stays inside its viewport`);
      const plain=lines.map(stripTerminalSequences);
      for(const line of plain) {
        assert.doesNotMatch(line,/─{3}(?:\.\.\.|…)/,`${id} decorative rules do not truncate`);
        if(line.includes('╭'))assert.ok(line.includes('╮'),`${id} top edge retains its right corner`);
        if(line.includes('╰'))assert.ok(line.includes('╯'),`${id} bottom edge retains its right corner`);
      }
      const top=plain.findIndex(line=>line.includes('╭')),bottom=plain.findIndex((line,i)=>i>top&&line.includes('╰'));
      if(top>=0&&bottom>top) {
        const rightColumn=(line:string,glyph:string)=>visibleWidth(line.slice(0,line.indexOf(glyph)));
        const right=rightColumn(plain[top],'╮');
        assert.equal(rightColumn(plain[bottom],'╯'),right,`${id} corners share their right column`);
        for(const line of plain.slice(top+1,bottom))if(line.includes('│'))
          assert.equal(visibleWidth(line.slice(0,line.lastIndexOf('│'))),right,`${id} right side aligns with its corners`);
      }
    }
  }finally{setGraphemeWidthOverrides();renderer.close();}
});

test('wide borders reserve both sides, pad odd columns, retain scroll counts and map mouse input to content',()=>{
  const terminal=new TestTerminal(),tui=new TuiAltScreen(terminal,true),identity=(text:string)=>text;
  setGraphemeWidthOverrides(new Map(Array.from('─│╭╮╰╯↑↓…',glyph=>[glyph,2])));
  try {
    assert.equal(stripTerminalSequences(rule(9)),'──── ','a spare column is a space, never an ellipsis');
    const boxed=[frameBox([styledLine([{text:'content'}],35)],41)];
    for(const lines of [inputBox([styledLine([{text:'command'}],37)],41),disabledInputLines('saved draft',41)]) {
      assert.equal(stripTerminalSequences(lines[0]),'─'.repeat(20)+' ');
      assert.equal(stripTerminalSequences(lines.at(-1)!),'─'.repeat(20)+' ');
      assert.ok(lines.every(line=>visibleWidth(line)===41));
    }
    for(const lines of boxed) {
      const plain=lines.map(stripTerminalSequences);
      assert.equal(plain[0],'╭'+'─'.repeat(18)+' ╮');
      assert.equal(plain.at(-1),'╰'+'─'.repeat(18)+' ╯');
      assert.ok(lines.every(line=>visibleWidth(line)===41));
    }
    const dialog=new ConfirmDialog({title:'确认',action:'执行',body:['授权内容保持完整'],fixed:['不得丢失的影响说明']});
    const lines=dialog.render(41,24).map(stripTerminalSequences);
    assert.ok(lines.every(line=>visibleWidth(line)===37));
    assert.match(lines.join('\n'),/授权内容保持完整/);assert.match(lines.join('\n'),/不得丢失的影响说明/);
    assert.match(lines[0],/^╭─+ ╮$/);assert.match(lines.at(-1)!,/^╰─+ ╯$/);
    const editor=new HardwareCursorEditor(tui,{borderColor:identity,selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}});
    editor.focused=true;editor.setText(Array.from({length:20},(_,i)=>`line ${i+1}`).join('\n'));
    const scrolled=editor.render(41).map(stripTerminalSequences);
    assert.ok(scrolled.every(line=>visibleWidth(line)===41));
    assert.match(scrolled[0],/^─.*↑ \d+ more .*─ *$/,'scroll count stays inside the complete border');
    assert.doesNotMatch(scrolled[0],/\.\.\.|…/);
    editor.setText('中éX');editor.render(41);
    editor.handleMouse({type:'click',button:'left',x:5,y:1,screenX:5,screenY:1,width:41,height:3,shift:false,alt:false,ctrl:false});
    editor.handleInput('!');assert.equal(editor.getText(),'中!éX','removing a measured side keeps click insertion aligned with the visible content');
  } finally {setGraphemeWidthOverrides();}
});
