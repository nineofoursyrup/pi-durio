#!/usr/bin/env node
/** Independent installation: only package exports and the shipped CLI; real public durable runtime, explicit offline transport. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [installArg,evidenceArg]=process.argv.slice(2);if(!installArg||!evidenceArg)throw Error('Usage: node scripts/demo-compaction.mjs INSTALL_ROOT NEW_EVIDENCE_ROOT');
const installRoot=resolve(installArg),evidenceRoot=resolve(evidenceArg),workspace=join(evidenceRoot,'project'),dataRoot=join(evidenceRoot,'data');
mkdirSync(evidenceRoot,{recursive:false});mkdirSync(workspace);writeFileSync(join(workspace,'README.md'),'Original file remains unchanged after context compaction.\n');
const require=createRequire(join(installRoot,'package.json'));
const {runCodingTask,readAcceptedTasks,readRun}=await import(pathToFileURL(require.resolve('pi-durio')).href);
const {compactContext,readCompactions}=await import(pathToFileURL(require.resolve('pi-durio/compaction')).href);
const {scriptedTransport}=await import(pathToFileURL(require.resolve('pi-durio/offline')).href);
const fixture=scriptedTransport([]);const transport=async(url,init)=>{const response=await fixture.fetch(url,init);return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.','ORIGINAL LONG RESPONSE '+ 'z'.repeat(90000)),{headers:{'content-type':'text/event-stream'}});};
const initial=await runCodingTask({workspace,dataRoot,input:'ORIGINAL USER OBJECTIVE',mode:'offline',transport});assert.equal(initial.status,'completed');
const summary=scriptedTransport([]),authorization={workspace,mode:'offline',tools:['read','write','edit','bash']};
const compact=await compactContext({dataRoot,runId:initial.runId,requestId:'installed-api-compact',authorization,transport:summary.fetch});assert.equal(compact.compaction?.state,'applied');assert.equal(summary.calls.length,1);
assert.equal((await compactContext({dataRoot,runId:initial.runId,requestId:'installed-api-compact',authorization,transport:summary.fetch})).compaction?.state,'applied');assert.equal(summary.calls.length,1);
const cli=join(installRoot,'node_modules','pi-durio','dist','src','cli.js'),authFile=join(evidenceRoot,'authorization.json');writeFileSync(authFile,JSON.stringify(authorization));
function command(id,args){const result=spawnSync(process.execPath,[cli,...args,'--data-root',dataRoot],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'},maxBuffer:4*1024*1024});writeFileSync(join(evidenceRoot,`${id}.stdout`),result.stdout);writeFileSync(join(evidenceRoot,`${id}.stderr`),result.stderr);assert.equal(result.status,0,`${id}: ${result.stdout}\n${result.stderr}`);return JSON.parse(result.stdout);}
const noop=command('cli-cold-noop',['compact','--run',initial.runId,'--id','installed-cli-noop','--authorization',authFile,'--offline-demo']);assert.equal(noop.compaction.state,'noop');
const db=join(dataRoot,'sessions',initial.sessionId,'durable.sqlite'),sha=()=>createHash('sha256').update(readFileSync(db)).digest('hex'),before=sha();
const inspected=command('cli-readonly-inspect',['compact','--inspect','--run',initial.runId]);assert.equal(sha(),before);assert.ok(inspected.items.some(i=>i.kind==='compaction.generated'));assert.ok(inspected.items.some(i=>i.kind==='compaction.finished'&&i.data.state==='applied'));
const later=scriptedTransport([]),next=await runCodingTask({workspace,dataRoot,input:'NEXT ORDINARY REQUEST',contextRunId:initial.runId,mode:'offline',transport:later.fetch});assert.equal(next.status,'completed');assert.notEqual(next.taskId,initial.taskId);assert.match(JSON.stringify(later.calls),/conversation history before this point was compacted/);assert.match(JSON.stringify(later.calls),/NEXT ORDINARY REQUEST/);assert.doesNotMatch(JSON.stringify(later.calls),/ORIGINAL USER OBJECTIVE/);
let after,original=false;do{const page=await readRun(dataRoot,initial.runId,{after,limit:100});for(const record of page.records)if(record.kind==='model.response'&&JSON.stringify(record).includes('z'.repeat(90000)))original=true;after=page.next??undefined;}while(after);assert.equal(original,true);assert.equal(readAcceptedTasks(dataRoot).tasks.length,2);
writeFileSync(join(evidenceRoot,'actual-summary-payload.json'),JSON.stringify(summary.calls,null,2));writeFileSync(join(evidenceRoot,'actual-next-payload.json'),JSON.stringify(later.calls,null,2));
const report={status:'PASS',method:'independently installed package exports plus cold CLI process; public durable runtime, deterministic offline provider',installRoot,dataRoot,workspace,initial,compact,next,noop,readOnlySha256:before,facts:readCompactions(dataRoot,initial.runId),originalResponseRetained:original,codingSamples:2,summaryDispatches:summary.calls.length,paidProvider:'NOT RUN',nativeTerminal:'NOT RUN; aggregate acceptance in issue 31'};writeFileSync(join(evidenceRoot,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,evidenceRoot,source:initial.runId,next:next.runId}));
