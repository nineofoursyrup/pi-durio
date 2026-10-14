#!/usr/bin/env node
// Parse/link existing exported artifacts only; never evaluate model code or run its commands.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=dirname(fileURLToPath(import.meta.url));
const inputs=JSON.parse(readFileSync(join(root,'artifact-link-input.json'),'utf8'));
const rows=[];
for(const input of inputs){
 const context=vm.createContext({}),modules=new Map();
 for(const file of input.files){
  assert.notEqual(file.source,'/Users/nineofour/Durio/api.env');
  const bytes=readFileSync(file.source);assert.equal(bytes.length,file.ref.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.ref.sha256);
  const code=stripTypeScriptTypes(bytes.toString(),{mode:'strip'});
  modules.set(file.path,new vm.SourceTextModule(code,{context,identifier:file.path}));
 }
 const target=modules.get(input.caseId==='local-fix'?'project/math.ts':'project/main.ts');
 let error=null;
 try{await target.link(specifier=>{assert.equal(specifier,'./greeting.ts','No arbitrary imports allowed');return modules.get('project/greeting.ts');});}
 catch(caught){error={name:caught.name,message:caught.message};}
 if(input.caseId==='local-fix')assert.equal(error,null);
 else {assert.equal(error?.name,'SyntaxError');assert.match(error.message,/does not provide an export named 'namedGreeting'/);}
 rows.push({caseId:input.caseId,status:error?'LINK_ERROR':'LINKED',error,sourceRefs:input.files.map(f=>({path:f.path,ref:f.ref})),evaluationPerformed:false,originalGradeUnchanged:true});
}
const result={status:'DIAGNOSTIC_ASSERTIONS_PASS',scope:'Independent read-only ESM parse/link check over saved artifacts; no module evaluation, product grader, provider, shell, restricted VM or original-result writes',rows};
writeFileSync(join(root,'artifact-link-check.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,outcomes:rows.map(r=>({caseId:r.caseId,status:r.status}))}));
