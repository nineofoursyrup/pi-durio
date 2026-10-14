import fs from 'node:fs';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
const input=JSON.parse(fs.readFileSync('/input/probe.json','utf8')),results=[];
function attempt(name,operation){try{operation();results.push({name,blocked:false});}catch(error){results.push({name,blocked:['ENOENT','EACCES','EPERM','EROFS','ESRCH'].includes(error.code),code:error.code});}}
for(const target of input.targets){attempt(target.name+'_read',()=>fs.readFileSync(target.path));attempt(target.name+'_write',()=>fs.appendFileSync(target.path,'tampered'));}
for(const path of ['/deps/dist/src/runtime.js','/deps/node_modules/@earendil-works/pi-ai/package.json','/input/trial.json','/boundary/restrict.py'])attempt('readonly:'+path,()=>fs.appendFileSync(path,'tampered'));
attempt('host-process',()=>process.kill(input.pid,'SIGUSR1'));
results.push(await new Promise(resolve=>{const socket=net.connect(input.socket);socket.on('connect',()=>{socket.destroy();resolve({name:'host-control-socket',blocked:false});});socket.on('error',error=>resolve({name:'host-control-socket',blocked:['ENOENT','EACCES','EPERM'].includes(error.code),code:error.code}));socket.setTimeout(1000,()=>{socket.destroy();resolve({name:'host-control-socket',blocked:false,reason:'timeout unknown'});});}));
results.push({name:'host-credentials',blocked:!process.env.DEEPSEEK_API_KEY&&!process.env.DURIO_CANARY_KEY});
const native=spawnSync('python3',['-I','/input/native-probe.py'],{encoding:'utf8'});if(native.status!==0)throw Error(native.stderr);const evidence=JSON.parse(native.stdout);results.push(...evidence.results);
if(input.descendant){const child=spawn('node',['-e',`const fs=require('node:fs'),cp=require('node:child_process');const r=cp.spawnSync('python3',['-I','/input/native-probe.py'],{encoding:'utf8'});fs.writeFileSync('/work/descendant.json',r.stdout);process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('/work/heartbeat.txt','x'),50);`],{detached:true,stdio:'ignore'});child.unref();await new Promise(resolve=>setTimeout(resolve,250));}
fs.writeFileSync('/work/probes.json',JSON.stringify({results,evidence}));
console.log(JSON.stringify({checks:results.length,allBlocked:results.every(r=>r.blocked)}));
if(results.some(r=>!r.blocked))process.exitCode=2;
