#!/usr/bin/env node
// Launch this in actual macOS Terminal. It uses the installed public TUI and
// its normal ProcessTerminal/width calibration; no injected terminal is used.
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [installArg,outArg]=process.argv.slice(2);
if(!installArg||!outArg)throw Error('Usage: node native-idle.mjs INSTALL_ROOT NEW_OUTPUT');
if(process.platform!=='darwin'||!process.stdin.isTTY||!process.stdout.isTTY||process.env.TERM_PROGRAM!=='Apple_Terminal')throw Error('ACTUAL_MACOS_TERMINAL_REQUIRED');
const install=resolve(installArg),out=resolve(outArg);
if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
mkdirSync(out);mkdirSync(join(out,'workspace'));
writeFileSync(join(out,'workspace','README.md'),'Controlled idle startup fixture. No task is requested.\n',{flag:'wx'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ref=path=>{const data=readFileSync(path);return{path,bytes:data.length,sha256:sha(data)};};
const save=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
const require=createRequire(join(install,'package.json'));
const product=require.resolve('pi-durio/tui');
save('plan.json',{at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),product:ref(product),
 sourceBuild:ref(join(install,'node_modules/pi-durio/dist/execution/source-build.json')),
 node:process.execPath,nodeVersion:process.version,terminal:{program:process.env.TERM_PROGRAM,version:process.env.TERM_PROGRAM_VERSION??null,term:process.env.TERM??null,columns:process.stdout.columns,rows:process.stdout.rows},
 workload:'One normal native TUI start, no tasks or typed input, 30 seconds idle after the first normal emitted frame, 1 second RSS sampling, graceful public exit.',
 readiness:'First stdout paint containing the normal pi-durio header; normal width gate suppresses paints until calibration is available. This measures frame emission, not screen presentation or human response.',
 timeOrigin:'Node performance.timeOrigin; measured readiness includes module import within this process but excludes Terminal window launch and shell scheduling before Node.',
 limits:['RSS is this host Node process only, excluding Terminal.app and other processes.','The disclosed stdout observer and 1 Hz sampler add small unseparated overhead.','No numeric pass threshold; first-frame absence, width failure or runtime errors remain failures.','No provider is allowed; an explicit rejecting offline transport prevents dispatch.']});
let app,firstFrame=null,stdoutBytes=0,providerAttempts=0,inputBytesAfterFrame=0,closing=false;
const samples=[];
const originalWrite=process.stdout.write;
process.stdout.write=function(chunk,...args){
 const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));stdoutBytes+=bytes.length;
 if(firstFrame===null&&bytes.toString().includes('pi-durio ·'))firstFrame={performanceMs:performance.now(),uptimeSeconds:process.uptime(),wallTime:new Date().toISOString()};
 return originalWrite.call(this,chunk,...args);
};
const observeInput=data=>{if(firstFrame)inputBytesAfterFrame+=Buffer.byteLength(data);};
process.stdin.on('data',observeInput);
let sampleTimer,deadlineTimer;
try{
 const {ReadOnlyTui}=await import(pathToFileURL(product).href);
 app=new ReadOnlyTui({workspace:join(out,'workspace'),dataRoot:join(out,'data'),draftRoot:join(out,'drafts'),mode:'offline',coding:false,
  transport:async()=>{providerAttempts++;throw Error('IDLE_MEASUREMENT_FORBIDS_PROVIDER');}});
 const begun=performance.now();
 sampleTimer=setInterval(()=>{
  samples.push({performanceMs:performance.now(),rssBytes:process.memoryUsage().rss});
  if(!closing&&firstFrame&&performance.now()-firstFrame.performanceMs>=30000){closing=true;void app.exit();}
 },1000);
 deadlineTimer=setTimeout(()=>{if(!closing){closing=true;void app.exit();}},60000);
 app.start();
 const exit=await app.closed;
 const observedIdleMs=firstFrame?performance.now()-firstFrame.performanceMs:0;
 save('result.json',{at:new Date().toISOString(),plan:ref(join(out,'plan.json')),firstFrame,samples,
  peakObservedRssBytes:samples.length?Math.max(...samples.map(s=>s.rssBytes)):null,stdoutBytes,inputBytesAfterFrame,providerAttempts,
  appStartCallAtPerformanceMs:begun,observedIdleMs,exit,
  status:firstFrame&&observedIdleMs>=30000&&providerAttempts===0&&!exit.result&&!exit.error&&exit.widthCalibration?.status==='measured'?'MEASURED':'MEASURED_WITH_FAILURES',
  inputInterpretation:'Bytes can include terminal/focus responses; count alone is not proof of human typing. Any actual interaction must be noted in the native observation.'});
}catch(error){save('failure.json',{at:new Date().toISOString(),error:String(error),firstFrame,samples,providerAttempts});throw error;}
finally{clearInterval(sampleTimer);clearTimeout(deadlineTimer);if(app)await app.exit();process.stdin.off('data',observeInput);process.stdout.write=originalWrite;}
console.log('Native idle measurement retained: '+out);
