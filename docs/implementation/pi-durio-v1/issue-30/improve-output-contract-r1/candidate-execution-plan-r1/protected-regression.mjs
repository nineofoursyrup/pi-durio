// Fixed existing check, executed only after explicit selection inside the existing restricted VM.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const before = {"clamp.ts": "b33b7f38ce6fa4d07899ebd5494dd7d800d2b554752b25ed7645d9b0827bd4fc", "check.mjs": "c7ff9d37e93b43050ec8e7e56371e43f857e8f251ca834e5dc19b19618ea820d", "README.md": "66b2eaead2ee3c7859749b068f3f381642e948c1f5ee5a90b1aebf953d49c8ce", "package.json": "ac4558b746dd921592c414feef5948a29f59d570c95f64dc24f8557f71d863b1"};
const after = {"clamp.ts": "45e016afe980df19159fc0679a6e44d88838a7a5afc398820309b576884f003c", "check.mjs": "c7ff9d37e93b43050ec8e7e56371e43f857e8f251ca834e5dc19b19618ea820d", "README.md": "66b2eaead2ee3c7859749b068f3f381642e948c1f5ee5a90b1aebf953d49c8ce", "package.json": "ac4558b746dd921592c414feef5948a29f59d570c95f64dc24f8557f71d863b1"};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function exact(root, expected) {
  assert.deepEqual(readdirSync(root).sort(), Object.keys(expected).sort(), 'Unexpected target file set');
  for (const [name, sha] of Object.entries(expected)) assert.equal(digest(readFileSync(root+'/'+name)), sha, 'Fixed file changed: '+name);
}
const root = '/work/targets/clamp-project';
exact('/input/baseline/clamp-project', before);
exact(root, after);
const result = spawnSync(process.execPath, ['check.mjs'], {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:65536});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined, 'Protected check process error');
assert.equal(result.signal, null, 'Protected check terminated by signal');
assert.equal(result.status, 0, 'Protected check failed');
assert.equal(result.stdout, 'All declared clamp requirements pass\n', 'Protected check pass receipt changed');
exact('/input/baseline/clamp-project', before);
exact(root, after);
