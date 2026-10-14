#!/usr/bin/env node
// Narrow offline regression: actual installed reader + delayed fixture persistence.
// Does not launch the TUI, VM, build, provider or follow-up native batch.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const [installArg,outArg]=process.argv.slice(2),install=resolve(installArg),out=resolve(outArg);
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');mkdirSync(out);
const base=dirname(fileURLToPath(import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const ref=path=>{const b=readFileSync(path);return{path,bytes:b.length,sha256:sha(b)};};
const save=(name,v)=>writeFileSync(join(out,name+'.json'),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const require=createRequire(join(install,'package.json')),product=require.resolve('pi-durio/improve'),evidencePath=join(dirname(product),'evidence.js');
const source=readFileSync(join(base,'native-composition.mjs'),'utf8'),original=readFileSync(join(base,'..','native-composition.mjs'),'utf8');
const callbackText=s=>{const match=s.match(/analysis=await until\((\(\)=>\{.+?\})\);/);assert.ok(match,'Exact analysis poll callback must be found');return match[1];};
const untilText=source.match(/^async function until\(.*$/m)?.[0];assert.ok(untilText);
const until=new Function('delay','closed',`return (${untilText});`)(delay,false);
const callback=(text,reader,root,id)=>new Function('readImproveReport','dataRoot','analysisRequest',`return (${text});`)(reader,root,{id});
save('plan',{at:new Date().toISOString(),node:process.execPath,nodeVersion:process.version,harness:ref(fileURLToPath(import.meta.url)),fixedComposition:ref(join(base,'native-composition.mjs')),originalComposition:ref(join(base,'..','native-composition.mjs')),product:ref(product),fixtureWriter:ref(evidencePath),scope:'Actual installed readImproveReport with delayed improve.started and improve.report fixture records; exact original/fixed callbacks and original async until function extracted from pinned harness files. Other errors must retain object identity. No native/VM/provider execution.'});
let evidence,publisher;
try{
 const {readImproveReport}=await import(pathToFileURL(product).href),{Evidence}=await import(pathToFileURL(evidencePath).href);
 const dataRoot=join(out,'fixture-data'),id='delayed-report',target={workspace:join(out,'fixture-workspace'),runId:'source',taskId:'task',sessionId:'session'};
 evidence=new Evidence(dataRoot,'analysis');
 let firstFailure;try{callback(callbackText(original),readImproveReport,dataRoot,id)();assert.fail('Original callback must fail before any report exists');}catch(error){assert.equal(error.message,'IMPROVE_REPORT_NOT_FOUND');firstFailure={name:error.name,message:error.message};}
 const observed=[];const instrumented=(root,requestId)=>{try{const value=readImproveReport(root,requestId);observed.push({atPerformanceMs:performance.now(),state:value.report?.state??value.state});return value;}catch(error){observed.push({atPerformanceMs:performance.now(),error:String(error)});throw error;}};
 const report={id,revision:'r1',runId:'analysis',target,candidates:[],targets:[],selected:[],state:'complete',evidence:[]};
 publisher=(async()=>{await delay(50);evidence.append('improve.started',{request:{id},target});await delay(170);evidence.append('improve.report',report);})();
 const began=performance.now(),result=await until(callback(callbackText(source),instrumented,dataRoot,id),2000);await publisher;
 assert.equal(result.id,id);assert.equal(result.state,'complete');assert.ok(observed.some(x=>x.error==='Error: IMPROVE_REPORT_NOT_FOUND'));assert.ok(observed.some(x=>x.state==='interrupted-or-running'));assert.equal(observed.at(-1).state,'complete');
 const otherErrors=[];for(const message of ['EVIDENCE_CORRUPT','IMPROVE_REPORT_NOT_FOUND: unrelated suffix']){const sentinel=new Error(message);await assert.rejects(()=>until(callback(callbackText(source),()=>{throw sentinel;},dataRoot,id),1000),error=>error===sentinel);otherErrors.push({message,rethrownSameObject:true});}
 evidence.close();evidence=null;
 save('result',{at:new Date().toISOString(),status:'PASS',firstFailure,delayedReportReadback:{elapsedMs:performance.now()-began,observed,report:result},otherErrors,realProviderRequests:0,nativeExecuted:false,vmExecuted:false,productSourceChanged:false,limits:['Fixture records are intentionally minimal; this proves the missing-to-started-to-complete polling behavior only.','This offline regression does not establish native follow-up, isolation regression, fixture writeback or human acceptance.'],plan:ref(join(out,'plan.json'))});
}catch(error){if(publisher)await publisher.catch(()=>{});save('failure',{at:new Date().toISOString(),status:'FAIL',error:String(error),stack:error.stack});process.exitCode=1;}finally{evidence?.close();}
console.log(JSON.stringify({out,status:process.exitCode?'FAIL':'PASS'}));
