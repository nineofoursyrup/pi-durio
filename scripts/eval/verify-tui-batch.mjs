// Development verification only. Build and explicitly prepare the fixed runtime
// before invoking; neither this gate nor its tests install dependencies.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
const [runtime,evidence]=process.argv.slice(2);
if(!runtime||!evidence)throw Error('Usage: node scripts/eval/verify-tui-batch.mjs PREPARED_RUNTIME NEW_EVIDENCE_DIR');
const installation=resolve(runtime),output=resolve(evidence);
if(!existsSync(join(installation,'eval-environment.json')))throw Error('EVAL_RUNTIME_REQUIRED: explicitly prepare the fixed Linux runtime first');
if(!readFileSync(join(installation,'dist/execution/source-build.json')).equals(readFileSync('dist/execution/source-build.json')))throw Error('EVAL_RUNTIME_STALE: prepared runtime must match this candidate build');
mkdirSync(output,{recursive:false,mode:0o700});
execFileSync(process.execPath,['--test','dist/test/integration/eval-batch.js'],{stdio:'inherit',env:{...process.env,DURIO_EVAL82_RUNTIME:installation,DURIO_EVAL82_EVIDENCE:output}});
