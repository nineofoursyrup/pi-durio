import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {HistoryView} from '../src/tui/history.js';

test('history selection remains visible at 40x12 and pending acceptance can be inspected without a run',()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-history-view-')),e=new Evidence(root,'source');
  e.append('task.accepted',{taskId:'source-task',sessionId:'source-session',workspace:'/project',input:'first'});e.append('run.started',{sessionId:'source-session'});
  for(let n=0;n<7;n++)e.append('control.accepted',{requestId:`next-${n}`,taskId:`task-${n}`,kind:'follow-up',input:`pending ${n}`,target:{workspace:'/project',sessionId:'source-session',taskId:'source-task',runId:'source'},executionVersion:{artifactId:'v',configSeq:0,artifactSeq:0},authorization:{tools:['read']}});e.close();
  const view=new HistoryView(root);view.render(38,8);
  for(let n=0;n<7;n++){view.handleInput('\x1b[B');assert.match(view.render(38,8).join('\n'),/› pending/);}
  view.handleInput('\r');assert.match(view.render(38,8).join('\n'),/历史/);
  for(let n=0;n<5;n++)view.handleInput('\x1b[6~');
  view.handleInput('b');view.render(38,8);view.handleInput('n');assert.doesNotThrow(()=>view.render(38,8));
});
