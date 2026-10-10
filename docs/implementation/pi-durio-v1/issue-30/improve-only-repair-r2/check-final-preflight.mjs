#!/usr/bin/env node
// Full exact-candidate preflight with an in-memory authorization fixture only.
// No executable grant is written; product imports/environment/credential access are prohibited.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {verifyInstallation} from './harness/common.mjs';
const root=path.dirname(url.fileURLToPath(import.meta.url)),manifestPath=path.join(root,'checked-manifest.json'),output=path.join(root,'final-preflight-check-r1.json');
assert.equal(fs.existsSync(output),false);
const hash=b=>createHash('sha256').update(b).digest('hex'),actualManifest=fs.readFileSync(manifestPath),manifest=JSON.parse(actualManifest),overrides=new Map(),readIdentities=new Map();
const grantPath='/OFFLINE_MEMORY_ONLY/improve-repair-grant.json',authPath='/OFFLINE_MEMORY_ONLY/improve-repair-authorization.json';
const read=p=>{p=String(p);assert.notEqual(p,'/Users/nineofour/Durio/api.env','CREDENTIAL_READ_FORBIDDEN');if(overrides.has(p))return overrides.get(p);const bytes=fs.readFileSync(p);readIdentities.set(p,{path:p,bytes:bytes.length,sha256:hash(bytes)});return bytes;};
const file=p=>{const bytes=read(p);return {path:p,bytes:bytes.length,sha256:hash(bytes)};};
const at=new Date().toISOString(),authorization={kind:'improve-repair-one-start',author:'human-user',source:{kind:'codex-user-reply',requestToolCallId:'OFFLINE_MEMORY_ONLY_NOT_A_REAL_CALL'},manifestSha256:hash(actualManifest),batchId:manifest.batchId,priorManifestSha256:manifest.prior.manifest.sha256,priorBudgetSha256:manifest.prior.cumulativeBudget.sha256,receivedAt:at,exactHumanReply:'OFFLINE IN-MEMORY FIXTURE ONLY; no actual user grant',limits:manifest.limits};
overrides.set(authPath,Buffer.from(JSON.stringify(authorization)));
const grant={paidApproved:true,manifestSha256:hash(actualManifest),batchId:manifest.batchId,humanAuthorization:authorization.exactHumanReply,authorizationSource:file(authPath),credentialSource:'/Users/nineofour/Durio/api.env',grantedAt:at,limits:manifest.limits};
overrides.set(grantPath,Buffer.from(JSON.stringify(grant)));
const context=vm.createContext({Date,process:{argv:[],get env(){throw Error('ENVIRONMENT_ACCESS_FORBIDDEN');}},fetch(){throw Error('NETWORK_FORBIDDEN');},console:{log(){},error(){}}}),parse=vm.runInContext('JSON.parse',context),clone=v=>parse(JSON.stringify(v));context.structuredClone=clone;
const modules=new Map();function synthetic(id,exports){modules.set(id,new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:id}));}
synthetic('node:assert/strict',{default:assert});synthetic('node:fs',{readFileSync:read,existsSync:p=>overrides.has(String(p))||fs.existsSync(p)});synthetic('node:path',{dirname:path.dirname,join:path.join,resolve:path.resolve});synthetic('node:url',{fileURLToPath:url.fileURLToPath});
synthetic('./common.mjs',{file:p=>clone(file(p)),json:p=>parse(read(p).toString()),sha:hash,verifyInstallation:(p,expected)=>verifyInstallation(p,JSON.parse(JSON.stringify(expected)))});
const module=new vm.SourceTextModule(read(path.join(root,'harness/preflight.mjs')).toString(),{context,identifier:'preflight',initializeImportMeta(meta){meta.url=url.pathToFileURL(path.join(root,'harness/preflight.mjs')).href;}});
let result;
try{await module.link(id=>modules.get(id));await module.evaluate();const checked=module.namespace.preflight(manifestPath,grantPath);assert.equal(checked.artifact.integratedSource,'f26ae8f4b8039608a1fa796e1c69da4d8173d112');
 for(const name of ['explicit-human-grant.json','paid-start.json','authorized-plan.json'])assert.equal(fs.existsSync(path.join(root,name)),false,`NO_ACTUAL_AUTH_OR_START:${name}`);
 result={status:'PASS_OFFLINE_IN_MEMORY_AUTHORIZATION_ONLY',manifest:file(manifestPath),candidate:checked.artifact.integratedSource,producer:checked.artifact.producer,candidateGate:checked.freeze.candidateGate,priorUnknownReservation:1056768,newMaxRequests:8,cumulativeMaxChargedTokens:2318328,scope:'Exact frozen-input content and complete preflight evaluated using only an artificial in-memory authorization. Real seed tree and referenced evidence hashes checked. No product import/API/environment access.',actualReads:readIdentities.size,actualAuthorization:false,realCredentialReads:0,newProviderRequests:0,vmStarts:0,productExecutions:0,newGrantFiles:0,newPaidStartFiles:0,script:file(url.fileURLToPath(import.meta.url))};
}catch(error){result={status:'FAIL',manifest:file(manifestPath),error:{message:error.message,stack:error.stack},actualAuthorization:false,realCredentialReads:0,newProviderRequests:0,productExecutions:0};}
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,manifestSha256:result.manifest.sha256,actualAuthorization:false,actualReads:result.actualReads}));if(result.status==='FAIL')throw Error(result.error.message);
