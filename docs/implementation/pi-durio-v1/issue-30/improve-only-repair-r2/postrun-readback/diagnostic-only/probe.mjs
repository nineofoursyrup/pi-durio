// Read-only diagnostic: execute only exact installed pure validators in a VM.
// Extracted JSON is never submitted or saved as a product report/candidate.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('./',import.meta.url), inputs=JSON.parse(readFileSync(new URL('inputs.json',root),'utf8'));
const source=JSON.parse(readFileSync(inputs.sourceResult,'utf8')), answer=source.answer;
const installed='/Users/nineofour/pi-durio-v1-run/evidence/final-candidate-f26ae8f/install/node_modules/pi-durio/dist/src/';
const digest=v=>createHash('sha256').update(v).digest('hex');
const exact=readFileSync(installed+'improve.js','utf8'),history=readFileSync(installed+'improve-history.js','utf8');
const pure=exact.slice(exact.indexOf('const strings ='),exact.indexOf('export function prepareImprove('));
const condition=history.slice(history.indexOf('export function conditionIdentity('),history.indexOf('export function listImproveSuppressions(')).replaceAll('export function','function');
assert.ok(pure.includes('function candidates(')&&condition.includes('function conditionFiles('));
const context=vm.createContext({digest});
vm.runInContext(condition+'\n'+pure+'\nglobalThis.validateCandidates=candidates;',context);
let directError=null;try{JSON.parse(answer);}catch(error){directError=String(error);}
assert.match(directError,/SyntaxError/);
const blocks=[...answer.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
assert.equal(blocks.length,1);
const extracted=JSON.parse(blocks[0][1]);
let shapeError=null;try{context.validateCandidates(extracted.candidates,inputs.request,inputs.targets,new Set(inputs.usedEvidence));}catch(error){shapeError=String(error);}
assert.match(shapeError,/IMPROVE_CANDIDATE_CONTRACT_INCOMPLETE/);
const missing=extracted.candidates.map((candidate,index)=>({draft:index+1,stepsCount:candidate.steps.length,validationChecksCount:candidate.validation.checks.length,unacquiredClaimEvidence:candidate.facts.flatMap(f=>f.evidence).filter(id=>!inputs.usedEvidence.includes(id)),futureWriteback:candidate.activation.writeback,futureEnable:candidate.activation.enable}));
const factualChecks=[{input:[-9,-5,-1],modelClaim: 'current result is -5 / already satisfied',actualCurrentExpression:Math.min(-1,Math.min(-5,-9)),expectedFromProtectedSource:-5},{input:[6,0,10],modelClaim:'current result is 6 / already satisfied',actualCurrentExpression:Math.min(10,Math.min(0,6)),expectedFromProtectedSource:6}];
const result={status:'DIAGNOSIS_CONFIRMED_NO_CANONICAL_REPAIR',directParseError:directError,isolatedFenceExtraction:{scope:'Diagnostic only; no adoption or mutation',jsonSyntax:'valid',rawDrafts:extracted.candidates.length,exactInstalledValidatorError:shapeError},draftRequirements:missing,factualChecks,canonicalReport:{state:source.improve.state,candidates:source.improve.candidates.length,revision:source.improve.revision,unchanged:true},sourceIdentities:[{path:inputs.sourceResult,sha256:digest(readFileSync(inputs.sourceResult))},{path:installed+'improve.js',sha256:digest(exact)},{path:installed+'improve-history.js',sha256:digest(history)}],limitations:['Schema validation cannot prove natural-language factual accuracy.','Evaluated only two disputed claims against the unchanged baseline expression, not a candidate or protected check execution.','No product code, report, journal, fixture, grant or original raw output changed; no provider, VM, candidate selection or candidate validation executed.']};
writeFileSync(new URL('probe-result.json',root),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
