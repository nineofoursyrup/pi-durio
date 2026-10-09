import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Evidence} from '../src/evidence.js';
import {records,decode} from '../src/history.js';
import {factClock} from '../src/fact-clock.js';
test('host admission and external termination clocks preserve monotonic process identity and cannot inherit supplied clocks',()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-clock-')),e=new Evidence(root,'r');
 e.append('control.accepted',{kind:'follow-up',clock:{processId:'spoof',monotonicMs:-1}});e.append('recovery.ended',{});e.append('untrusted.message',{clock:{wallTime:'1900-01-01',processId:'spoof'}});e.close();
 const refs=[...records(root)],first=decode(root,refs[0]).clock,last=decode(root,refs[1]).clock;
 assert.notEqual(first.processId,'spoof');assert.equal(first.processId,last.processId);assert.ok(last.monotonicMs>=first.monotonicMs);assert.equal(first.wallTime,refs[0].at);assert.notEqual(refs[2].at,'1900-01-01');assert.equal(decode(root,refs[2]).clock.wallTime,'1900-01-01');
 const child=spawnSync(process.execPath,['--input-type=module','-e',"import {factClock} from './dist/src/fact-clock.js';console.log(JSON.stringify(factClock()))"],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.notEqual(JSON.parse(child.stdout).processId,factClock().processId);
});
