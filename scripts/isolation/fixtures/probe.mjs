import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline';

const plan = JSON.parse(fs.readFileSync('/input/probe-input.json', 'utf8'));
const results = [];
function attempt(name, action) {
  try { action(); results.push({ name, blocked: false }); }
  catch (error) { results.push({ name, blocked: ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ESRCH'].includes(error.code), code: error.code }); }
}
for (const target of plan.targets) {
  attempt(`${target.name}_read`, () => fs.readFileSync(target.path));
  attempt(`${target.name}_write`, () => fs.appendFileSync(target.path, 'tampered'));
}
for (const path of ['/usr/local/bin/node', '/input/public-test.mjs', '/boundary/restrict.py']) {
  attempt(`readonly:${path}`, () => fs.appendFileSync(path, 'tampered'));
}
attempt('host_process_signal', () => process.kill(plan.hostPid, 'SIGUSR1'));
const socketResult = await new Promise(resolve => {
  const client = net.connect(plan.socket);
  client.on('connect', () => { client.destroy(); resolve({ name: 'host_control_socket', blocked: false }); });
  client.on('error', error => resolve({ name: 'host_control_socket', blocked: ['ENOENT', 'EACCES', 'EPERM'].includes(error.code), code: error.code }));
  client.setTimeout(1000, () => { client.destroy(); resolve({ name: 'host_control_socket', blocked: false, code: 'unconfirmed_timeout' }); });
});
results.push(socketResult);
results.push({ name: 'host_credential_environment', blocked: !process.env.DURIO_PROBE_SECRET && !process.env.DEEPSEEK_API_KEY });
const native = spawnSync('/usr/bin/python3', ['-I', '/input/native-probe.py'], { encoding: 'utf8' });
if (native.status !== 0) throw new Error(`native probe failed: ${native.stderr}`);
const nativeEvidence = JSON.parse(native.stdout);
results.push(...nativeEvidence.results);
// A detached descendant inherits the policy and keeps writing until VM teardown.
const child = spawn('node', ['-e', `
  const fs=require('node:fs');
  const cp=require('node:child_process');
  const r=cp.spawnSync('/usr/bin/python3',['-I','/input/native-probe.py'],{encoding:'utf8'});
  fs.writeFileSync('/work/descendant.json',r.stdout);
  process.on('SIGTERM',()=>{});
  setInterval(()=>fs.appendFileSync('/work/heartbeat.txt','x'),50);
`], { detached: true, stdio: 'ignore' });
child.unref();
await new Promise(resolve => setTimeout(resolve, 300));
fs.writeFileSync('/work/public-test.mjs', 'console.log("PASS");');
if (plan.mode === 'good') {
  const lines = createInterface({ input: process.stdin });
  process.stdout.write(JSON.stringify({ kind: 'model.request', id: 1, input: 'Return the literal integer 42.', maxOutputTokens: 8 }) + '\n');
  const response = await new Promise(resolve => lines.once('line', line => { lines.close(); resolve(JSON.parse(line)); }));
  process.stdin.destroy();
  fs.writeFileSync('/work/program.mjs', `
    import fs from 'node:fs';
    import {spawnSync} from 'node:child_process';
    const probes=[];
    for(const target of ${JSON.stringify(plan.targets)}) {
      for(const op of ['read','write']) {
        try { if(op==='read') fs.readFileSync(target.path); else fs.appendFileSync(target.path,'tampered'); probes.push({name:target.name+'_'+op,blocked:false}); }
        catch(e){ probes.push({name:target.name+'_'+op,blocked:['ENOENT','EACCES','EPERM','EROFS'].includes(e.code),code:e.code}); }
      }
    }
    const native=spawnSync('/usr/bin/python3',['-I','/input/native-probe.py'],{encoding:'utf8'});
    probes.push(...JSON.parse(native.stdout).results);
    fs.writeFileSync('/work/grading-probes.json',JSON.stringify(probes));
    console.log(${JSON.stringify(response.output)});
  `);
} else if (plan.mode === 'bad-score') {
  fs.writeFileSync('/work/program.mjs', `
    import fs from 'node:fs';
    fs.writeFileSync('/work/measurement.json',JSON.stringify({code:0,stdout:'42\\n'}));
    console.log('PASS');
  `);
} else if (plan.mode === 'symlink') {
  fs.symlinkSync(plan.targets[0].path, '/work/program.mjs');
} else if (plan.mode === 'timeout') {
  fs.writeFileSync('/work/program.mjs', 'console.log(42);');
  setInterval(() => {}, 1000);
} else if (plan.mode === 'bad-model') {
  process.stdout.write(JSON.stringify({ kind: 'model.request', id: 1, input: 'x', maxOutputTokens: 8, url: 'http://host-control' }) + '\n');
  setInterval(() => {}, 1000);
}
fs.writeFileSync('/work/probes.json', JSON.stringify({ results, nativeEvidence }, null, 2));
console.log(JSON.stringify({ kind: 'candidate.report', claimedGrade: 'PASS' }));
