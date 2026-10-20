import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiAltScreen,stripTerminalSequences,visibleWidth,type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { Evidence } from '../src/evidence.js';
import { showFullScreen } from '../src/tui/fullscreen.js';
import { styledLine,overrideColorTierForTest } from '../src/tui/theme.js';
import { captureSnapshot } from '../src/tui/snapshot.js';

class TestTerminal implements Terminal {
  columns=80;rows=24;kittyProtocolActive=false;
  input:(value:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(value:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}

test('actual full-view entries fill 80×24 and 40×12 and Esc returns to the session',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-fullscreen-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);new Evidence(dataRoot,'fullscreen-fixture').close();
  const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false});
  const lines=()=>app.screen().map(stripTerminalSequences),screen=()=>lines().join('\n');
  try {
    app.start();
    for(const [width,height] of [[132,38],[80,24],[40,12]]) {
      terminal.columns=width;terminal.rows=height;terminal.resize();
      for(const [command,title] of [['/help',/帮助/],['/stats',/指标/],['/storage',/storage/],['/history',/history/],['/queue',/queue/],['/improve',/improve/],['/eval',/eval/]] as const){
        terminal.input(command);terminal.input('\r');
        const frame=lines();assert.equal(frame.length,height,command);assert.ok(frame.every(line=>visibleWidth(line)<=width),command);
        const header = height >= 30 ? 1 : 0;
        assert.match(frame[header],title,`${command} follows the collapsible top margin`);
        if (header) assert.equal(frame[0].trim(), '');
        assert.doesNotMatch(frame.join('\n'),/描述要查看或分析的内容|最近会话|Enter 提交/,`${command} covers the session`);
        assert.match(frame.join('\n'),/Esc/);
        terminal.input('\x1b');assert.match(screen(),/描述要查看或分析的内容/,'Esc restores the welcome input');
      }
    }
  } finally {await app.exit();}
});


test('the shared full-screen compositor paints short lines and empty rows with the base background',()=>{
  overrideColorTierForTest('truecolor');
  const terminal=new TestTerminal(),tui=new TuiAltScreen(terminal,true);
  tui.setLayoutRoot({invalidate(){},render:width=>Array.from({length:terminal.rows},()=>styledLine([{text:'underlying'}],width,'bg.selected'))});
  showFullScreen(tui,terminal,{invalidate(){},render:()=>[styledLine([{text:'short'}],5),'']});
  try {
    tui.start();tui.renderNow(true);
    const grid=captureSnapshot(tui.getScreenLines().map(line=>line.replace(/\x1b\]8;;[^\x07]*\x07/g,'')),terminal.columns,terminal.rows,'truecolor');
    assert.ok(grid.rows.every(row=>row.every(cell=>cell.bg==='bg.base')),'padding must be base cells, including after a line reset');
    assert.match(grid.rows[0].map(cell=>cell.char).join(''),/^short +$/);
  } finally {tui.stop();}
});


test('an open full-screen view yields to the root warning below the supported terminal size', () => {
  const terminal = new TestTerminal(), tui = new TuiAltScreen(terminal, true);
  tui.setLayoutRoot({ invalidate() {}, render: width => [styledLine([{ text: '窗口过小' }], width)] });
  showFullScreen(tui, terminal, { invalidate() {}, render: width => [styledLine([{ text: 'active view' }], width)] });
  try {
    tui.start(); tui.renderNow(true); assert.match(tui.getScreenLines().join(''), /active view/);
    terminal.columns = 30; terminal.rows = 10; terminal.resize(); tui.renderNow(true);
    assert.match(tui.getScreenLines().map(stripTerminalSequences).join(''), /窗口过小/);
    assert.doesNotMatch(tui.getScreenLines().join(''), /active view/);
    terminal.columns = 80; terminal.rows = 24; terminal.resize(); tui.renderNow(true);
    assert.match(tui.getScreenLines().join(''), /active view/);
  } finally { tui.stop(); }
});
