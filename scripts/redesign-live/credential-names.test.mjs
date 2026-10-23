import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import * as prep from './core.mjs';

// Tiny synthetic files only; no product imports, real credentials or model runs.
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'durio-redesign-live-credentials-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifest={schema:'pi-durio-redesign-terminal-v1',candidate:{commit:'a'.repeat(40),tree:'b'.repeat(40)},source:{root},
  installation:{root:join(root,'installation'),files:[]},harness:{root:join(root,'terminal-harness'),files:[]},synthetic:true};
 const add=(tree,path,content)=>{
  const full=join(tree.root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,content);
  tree.files.push({path,sha256:prep.sha(content)});
 };
 const build=JSON.stringify({redesignLive:{schema:'pi-durio-redesign-live-interface-v1',price:{},improveLimits:{standard:{},large:{}}}});
 add(manifest.installation,'dist/execution/source-build.json',build);manifest.source.sourceBuildSha256=prep.sha(build);
 add(manifest.harness,'verify.mjs',"throw Error('PRODUCT_IMPORT_FORBIDDEN_IN_PREP');\n");
 const manifestPath=join(root,'manifest.json');
 const persist=()=>{write(manifestPath,manifest);return prep.fileRef(manifestPath);};
 return{root,manifest,add,persist};
}

test('installation and harness inventories hash credential-named SDK sources and detect byte drift',t=>{
 const f=fixture(t),source="throw Error('SDK_IMPORT_FORBIDDEN_IN_PREP');\n";
 const path='node_modules/@anthropic-ai/sdk/core/credentials.js';
 f.add(f.manifest.installation,path,source);
 f.add(f.manifest.installation,'node_modules/@smithy/core/CredentialsProviderError.js',source);
 f.add(f.manifest.harness,'nested/credentials.js',source);
 const ref=f.persist();
 assert.deepEqual(prep.candidate(ref,true).candidate,f.manifest.candidate);
 writeFileSync(join(f.manifest.installation.root,path),'changed SDK bytes\n');
 assert.throws(()=>prep.candidate(ref,true),/MANIFEST_FILES_CHANGED/,'SDK files remain part of the hashed inventory');
});

test('direct file references and plan or grant paths keep the original credential-name refusal',t=>{
 const f=fixture(t),bytes='{"synthetic":true}\n',ref=name=>({path:join(f.root,name),sha256:prep.sha(bytes)});
 for(const name of ['api.env','.env','.env.local','auth.json','credentials.json','credentials.js','CredentialsProviderError.js']){
  const file=ref(name);writeFileSync(file.path,bytes);
  assert.throws(()=>prep.json(file.path),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/,name);
  assert.throws(()=>prep.fileRef(file.path),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/,name);
  assert.throws(()=>prep.readRef(file),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/,name);
 }
 const plan=prep.planTemplate('coding'),planPath=join(f.root,'plan.json');
 Object.assign(plan,{synthetic:true,candidateManifest:f.persist(),cases:ref('api.env')});write(planPath,plan);
 const checked=prep.validate(planPath,ref('api.env').path);
 for(const code of ['CASES_REQUIRED','AUTHORIZATION_REQUIRED'])assert.ok(checked.issues.some(i=>i.code===code&&i.detail==='ORDINARY_NON_CREDENTIAL_FILE_REQUIRED'),code);
 assert.throws(()=>prep.validate(ref('api.env').path),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/);
});

test('installation and harness inventories still refuse environment and auth files',t=>{
 for(const tree of ['installation','harness'])for(const name of ['.env','.env.local','api.env','auth.json']){
  const f=fixture(t);f.add(f.manifest[tree],`nested/${name}`,'SYNTHETIC placeholder only\n');
  assert.throws(()=>prep.candidate(f.persist(),true),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/,`${tree}/${name}`);
 }
});

test('workspace inventory keeps the original credential-name refusal',t=>{
 const f=fixture(t),workspace=join(f.root,'workspace'),cases=prep.caseTemplate();mkdirSync(workspace);
 cases.cases=[{id:'synthetic-counter',category:'no-change',visibility:'public-development',input:'Synthetic fixture only.',
  files:{'credentials.js':'export const count = 3;\n'},dirty:{},writable:[],dependencyLock:'{"lockfileVersion":3,"packages":{}}',
  grader:{version:'synthetic-g1',program:'console.log(3)',expectedStdout:'3\n',required:['counter stays 3']}}];
 for(const [path,content]of Object.entries({...cases.cases[0].files,'package-lock.json':cases.cases[0].dependencyLock}))writeFileSync(join(workspace,path),content);
 const casesPath=join(f.root,'cases.json'),planPath=join(f.root,'plan.json');write(casesPath,cases);
 const plan=prep.planTemplate('coding');plan.cases=prep.fileRef(casesPath);plan.execution.workspace=workspace;write(planPath,plan);
 assert.throws(()=>prep.checkWorkspace(planPath),/ORDINARY_NON_CREDENTIAL_FILE_REQUIRED/);
});
