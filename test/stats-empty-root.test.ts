import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { ReadOnlyTui } from '../src/tui/app.js';
import { Evidence } from '../src/evidence.js';
import { readStats, statsRequest } from '../src/tui/stats.js';
import { statsChoices } from '../src/tui/stats-filter.js';

class TestTerminal implements Terminal {
  columns=132;rows=38;kittyProtocolActive=false;
  input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}
  stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}
  clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}

test('fresh data roots open the existing stats and self empty states without creating storage or invoking a provider',async()=>{
  for(const exists of [false,true])for(const command of ['/stats','/stats --self']) {
    const root=mkdtempSync(join(tmpdir(),'durio-empty-stats-')),workspace=join(root,'project'),dataRoot=join(root,'data');mkdirSync(workspace);
    if(exists)mkdirSync(dataRoot);
    let calls=0;
    const terminal=new TestTerminal(),app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false,
      transport:async()=>{calls++;throw Error('stats cannot call a provider');}});
    const screen=()=>app.screen().map(stripTerminalSequences).join('\n');
    try {
      app.start();terminal.input(command);terminal.input('\r');
      assert.doesNotMatch(screen(),/Error:|ENOENT|任务指标不可读取/);
      if(command==='/stats') {
        assert.match(screen(),/◆ stats/);assert.match(screen(),/样本 0/);
        assert.match(screen(),/窗口内没有日常受理样本 · \/ 调整范围/);
        assert.match(screen(),/任务验收 +N\/A/);
        terminal.input('/');assert.match(screen(),/时间/);terminal.input('\t');
        assert.doesNotMatch(screen(),/◆ self/,'a filter does not switch tabs');terminal.input('\x1b');
        terminal.input('\t');assert.match(screen(),/◆ self/);
        terminal.input('\t');assert.match(screen(),/窗口内没有日常受理样本/);
      }else {
        assert.match(screen(),/◆ self/);
        for(let i=0;i<100&&!screen().includes('尚无任务');i++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.match(screen(),/尚无任务/);
        terminal.input('\t');assert.match(screen(),/窗口内没有日常受理样本/);
      }
      assert.equal(calls,0);assert.equal(existsSync(dataRoot),exists);
      if(exists)assert.deepEqual(readdirSync(dataRoot),[]);
    }finally{await app.exit();}
    assert.equal(existsSync(dataRoot),exists);if(exists)assert.deepEqual(readdirSync(dataRoot),[]);
  }
});

async function assertReadError(dataRoot:string,pattern:RegExp) {
  const root=mkdtempSync(join(tmpdir(),'durio-stats-error-ui-')),terminal=new TestTerminal();
  assert.throws(()=>readStats(dataRoot,statsRequest({},root).scope),pattern);
  const app=new ReadOnlyTui({workspace:root,dataRoot,draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false});
  try {
    app.start();terminal.input('/stats');terminal.input('\r');
    const screen=app.screen().map(stripTerminalSequences).join('\n');
    assert.match(screen,/任务指标不可读取/);assert.match(screen,pattern);
    assert.doesNotMatch(screen,/窗口内没有日常受理样本/);
  }finally{await app.exit();}
}

test('corrupt host databases and dangling database links remain read errors instead of empty samples',async()=>{
  const corrupt=mkdtempSync(join(tmpdir(),'durio-stats-corrupt-')),path=join(corrupt,'host.sqlite');
  writeFileSync(path,'not a supported database');const before=readFileSync(path);
  await assertReadError(corrupt,/RECOVERY_REQUIRED/);assert.throws(()=>statsChoices(corrupt,corrupt),/RECOVERY_REQUIRED/);
  assert.deepEqual(readFileSync(path),before,'reading cannot migrate or replace corrupt bytes');
  const dangling=mkdtempSync(join(tmpdir(),'durio-stats-dangling-'));symlinkSync('missing.sqlite',join(dangling,'host.sqlite'));
  await assertReadError(dangling,/ENOENT/);assert.throws(()=>statsChoices(dangling,dangling),/ENOENT/);
});

test('a permission-denied host database is still reported', {skip:process.getuid?.()===0?'root bypasses filesystem read permissions':false},async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-stats-denied-'));new Evidence(root,'empty-store').close();
  const path=join(root,'host.sqlite'),before=readFileSync(path);chmodSync(path,0);
  try {await assertReadError(root,/EACCES/);assert.throws(()=>statsChoices(root,root),/EACCES/);}
  finally{chmodSync(path,0o600);}
  assert.deepEqual(readFileSync(path),before);
});

test('missing acquired objects and invalid snapshot requests cannot become an empty-root result',async()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-stats-object-gap-')),evidence=new Evidence(root,'original-run');
  evidence.append('task.accepted',{taskId:'original-task',sessionId:'original-session',workspace:root,input:'retained input',mode:'live',authorization:{execution:'trusted-local-read-only',tools:['read']}});evidence.close();
  const objects=readdirSync(join(root,'objects'));assert.equal(objects.length,1);unlinkSync(join(root,'objects',objects[0]));
  await assertReadError(root,/ENOENT/);
  const absent=join(root,'new-data');
  assert.throws(()=>readStats(absent,{...statsRequest({},root).scope,through:1}),/INVALID_METRICS_SNAPSHOT/);
  assert.equal(existsSync(absent),false);
});
