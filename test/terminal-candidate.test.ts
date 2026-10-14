import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

for(const runnerName of ['terminal-validation.mjs','recovery-start-terminal-validation.mjs'])test(`${runnerName} candidate verification rejects added and missing files as well as changed bytes`,()=>{
  const root=mkdtempSync(join(tmpdir(),'durio-candidate-')),packageRoot=join(root,'package'),manifest=join(root,'manifest.json'),runner=resolve('scripts',runnerName);
  const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  mkdirSync(packageRoot);writeFileSync(join(packageRoot,'module.js'),'export const candidate = 1;');
  writeFileSync(manifest,JSON.stringify({commit:'fixture',packageRoot,runnerSha256:sha(readFileSync(runner)),files:[{path:'module.js',sha256:sha(readFileSync(join(packageRoot,'module.js')))}]}));
  const verify=()=>spawnSync(process.execPath,[runner,'--manifest',manifest,'--verify-only'],{encoding:'utf8'});
  assert.equal(verify().status,0);
  writeFileSync(join(packageRoot,'index.js'),'extra resolution candidate');
  const extra=verify();assert.notEqual(extra.status,0);assert.match(extra.stderr,/CANDIDATE_FILE_SET_CHANGED.*extra.*index\.js/s);
  unlinkSync(join(packageRoot,'index.js'));
  renameSync(join(packageRoot,'module.js'),join(root,'saved-module.js'));
  const missing=verify();assert.notEqual(missing.status,0);assert.match(missing.stderr,/CANDIDATE_FILE_SET_CHANGED.*missing.*module\.js/s);
  renameSync(join(root,'saved-module.js'),join(packageRoot,'module.js'));
  writeFileSync(join(packageRoot,'module.js'),'changed bytes');
  assert.match(verify().stderr,/CANDIDATE_CHANGED: module\.js/);
});
