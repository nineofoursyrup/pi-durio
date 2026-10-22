import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdinBuffer } from '@earendil-works/pi-tui';
import { TerminalWidthProbe } from '../src/tui/width-probe.js';

const scripts=join(process.cwd(),'scripts/redesign-terminal');
const {createNativeInputObserver}=await import(pathToFileURL(join(scripts,'native.mjs')).href);
const {assessNative}=await import(pathToFileURL(join(scripts,'assess.mjs')).href);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('native observer forwards wheel pressure and new-width replies without per-event rendering, then preserves follow input',async()=>{
  const events:any[]=[],ordinary:string[]=[],buffer=new StdinBuffer();let snapshots=0;
  const observer=createNativeInputObserver({append:(event:any)=>events.push(event),snapshot:()=>{snapshots++;return {screen:['synthetic frame'],queue:[],errors:[]};}});
  const terminal={columns:132,rows:38,write:(data:string)=>{
    if(!data.includes('\x1b[6n'))return;
    // Independent protocol oracle, through the public stdin parser; the product
    // keeps its default 1200 ms deadline and does both bare/context queries.
    const column=data.includes('A口B')?5:3;
    setImmediate(()=>buffer.process(`\x1b[2;${column}R\x1b[?1;2c`));
  }};
  const probe=new TerminalWidthProbe(terminal),controller=new AbortController();
  const forward=(data:string)=>{if(!probe.consume(data))ordinary.push(data);};
  buffer.on('data',data=>observer.input(data,forward));
  const wheel='\x1b[<64;18;20M',count=766;
  try {
    const measuring=probe.measure('口',controller.signal);
    buffer.process(wheel.repeat(count));
    assert.equal(await measuring,2,'new glyph calibrates under the unchanged deadline');
    assert.equal(snapshots,0,'wheel/CPR/DA traffic cannot synchronously render a frame for every event');
    await sleep(150);
    assert.equal(snapshots,1,'the entire burst has one deferred observation, not one timer per event');
    observer.input('follow one',forward);await sleep(150);
    assert.equal(ordinary.at(-1),'follow one','later text remains deliverable');
    assert.equal(ordinary.filter(data=>data===wheel).length,count,'all wheel events reach the product');
    const received=events.filter(event=>event.kind==='received');
    assert.deepEqual(received.map(event=>event.data),[...Array(count).fill(wheel),'\x1b[2;3R','\x1b[?1;2c','\x1b[2;5R','\x1b[?1;2c','follow one']);
    assert.deepEqual(received.map(event=>event.ordinal),Array.from({length:count+5},(_,i)=>i+1));
    const follow=events.find(event=>event.kind==='input'&&event.data==='follow one');
    assert.equal(follow?.settled,true);assert.deepEqual(follow.before.screen,['synthetic frame']);assert.deepEqual(follow.after.screen,['synthetic frame']);
  } finally {controller.abort();probe.close();observer.close();}
});

test('native observer retains eligible help, withdrawal and physical-key facts while interrupted observations stay unrun',async()=>{
  const {screens}=JSON.parse(readFileSync(join(process.cwd(),'test/fixtures/redesign-terminal/native-input-screens.json'),'utf8'));
  const events:any[]=[];let screen=screens.idle,queue=['q-first','q-last'];
  const observer=createNativeInputObserver({append:(event:any)=>events.push(event),snapshot:()=>({screen:[...screen],queue:[...queue],errors:[]})});
  const statuses=(rows:any[])=>Object.fromEntries(assessNative({events:rows}).items.map((item:any)=>[item.id,item.status]));
  try {
    observer.input('?',()=>screen=screens.help);await sleep(150);
    screen=screens.probe;observer.input('?',()=>screen=screens.probeQuestion);await sleep(150);
    screen=screens.running;observer.input('\x7f',()=>queue.pop());await sleep(200);
    observer.input('\x7f',()=>{});await sleep(150);
    observer.input('\x07',()=>{});observer.input('\x07',()=>{}); // Physical PgUp tried, not delivered.
    observer.input('\x07',()=>{});observer.input('\x1b[5~',()=>{});observer.input('\x07',()=>{});
    observer.input('\x0e',()=>{});observer.input('\x1b[6~',()=>{});observer.input('\x0e',()=>{});
    const result=statuses(events);
    assert.equal(result['help-empty'],'PASS');assert.equal(result['help-nonempty'],'PASS');assert.equal(result.backspace,'PASS');
    assert.equal(result['page-up'],'FAIL','a later delivered key cannot erase the first failed physical attempt');assert.equal(result['page-down'],'PASS');
    const start=events.length;
    screen=screens.idle;observer.input('?',()=>screen=screens.help);
    for(let i=0;i<766;i++)observer.input('\x1b[<64;18;20M',()=>{});
    await sleep(150);
    const interrupted=events.slice(start);
    assert.equal(statuses(interrupted)['help-empty'],'NOT_RUN','a coalesced before/after pair cannot become settled evidence');
    assert.equal(interrupted.find(event=>event.kind==='input'&&event.data==='?')?.settled,false);
    const resizeStart=events.length;
    screen=screens.idle;observer.input('?',()=>screen=screens.help);observer.resize({columns:80,rows:24},()=>{});await sleep(150);
    assert.equal(statuses(events.slice(resizeStart))['help-empty'],'NOT_RUN','resize invalidates an in-flight settled observation');
    const closeStart=events.length;
    screen=screens.idle;observer.input('?',()=>screen=screens.help);observer.close();await sleep(150);
    assert.equal(statuses(events.slice(closeStart))['help-empty'],'NOT_RUN','closing cannot manufacture the missing after frame');
  } finally {observer.close();}
});
