import {mkdtemp,writeFile,readFile,mkdir,cp,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {digest,Evidence} from '../evidence.js';
/** Synthetic assets only. The probe itself runs as an actual product bash tool. */
export async function prepareProbe(inputDir:string,descendants=true){
 const root=await mkdtemp(join(tmpdir(),'durio21-'));const targets:{name:string;path:string;sha256:string}[]=[];
 for(const name of ['host-home-key','other-trial-answer','grader-expected','report','shared-git']){const path=join(root,name);await writeFile(path,`immutable ${name}`);targets.push({name,path,sha256:digest(`immutable ${name}`)});}
 const sentinel=spawn(process.execPath,['-e',"process.on('SIGUSR1',()=>process.exit(9));setInterval(()=>{},1000)"],{stdio:'ignore'});
 const socket=join(root,'control.sock'),server=createServer(connection=>connection.end('unreachable'));await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 const policy=fileURLToPath(new URL('../../execution/isolation/',import.meta.url));
 await cp(join(policy,'native-probe.py'),join(inputDir,'native-probe.py'));
 await cp(join(policy,'runtime-probe.mjs'),join(inputDir,'runtime-probe.mjs'));
 await writeFile(join(inputDir,'probe.json'),JSON.stringify({targets:targets.map(({name,path})=>({name,path})),pid:sentinel.pid,socket,descendant:descendants}));
 return{root,targets,async verify(work:string,evidence:Evidence){
  const bytes=await readFile(join(work,'probes.json')),probe=JSON.parse(bytes.toString()),descendant=descendants?JSON.parse(await readFile(join(work,'descendant.json'),'utf8')):null;
  let stopped=true;if(descendants){const heartbeat=await readFile(join(work,'heartbeat.txt'));await new Promise(resolve=>setTimeout(resolve,200));stopped=heartbeat.equals(await readFile(join(work,'heartbeat.txt')));}
  const unchanged=(await Promise.all(targets.map(async target=>digest(await readFile(target.path))===target.sha256))).every(Boolean);
  const valid=probe.results.every((r:any)=>r.blocked)&&(descendant?.results??[]).every((r:any)=>r.blocked)&&stopped&&unchanged&&sentinel.exitCode===null;
  return{valid,probe:evidence.blob(bytes),descendant:descendant?evidence.blob(JSON.stringify(descendant)):null,heartbeatStopped:stopped,assetsUnchanged:unchanged,hostSentinelAlive:sentinel.exitCode===null,syntheticAssets:targets};
 },async close(){sentinel.kill('SIGTERM');await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
