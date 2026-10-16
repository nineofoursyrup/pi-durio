import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,mkdirSync,writeFileSync,truncateSync,readdirSync,rmSync,realpathSync,symlinkSync,existsSync,lstatSync,fstatSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,readObject,digest} from '../src/evidence.js';
import {captureBuildContents,assertBuildContentBudget} from '../src/improve-build-content.js';

test('build content retains every duplicate path at the expanded limit and rejects excess before writing evidence',t=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-build-content-limit-'))),source=join(directory,'source');mkdirSync(source);
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const paths=Array.from({length:10},(_,i)=>`${i}.bin`);
 for(const path of paths){writeFileSync(join(source,path),'');truncateSync(join(source,path),16*1024*1024);}
 const e=new Evidence(join(directory,'accepted'),'build'),records:any[]=[];t.after(()=>e.close());
 const files=captureBuildContents(e,source,paths,(kind,data)=>{records.push({kind,data});return 'captured';},'build');
 assert.equal(files.length,10);assert.equal(files.reduce((n,f)=>n+f.ref.bytes,0),167772160);
 assert.deepEqual(files.map(f=>f.path),paths);assert.equal(new Set(files.map(f=>f.ref.sha256)).size,1);
 assert.equal(readObject(e.root,files[0].ref).length,16*1024*1024);assert.equal(records[0].kind,'improve.build-content');
 writeFileSync(join(source,'extra.bin'),'x');
 const denied=new Evidence(join(directory,'denied'),'build');t.after(()=>denied.close());
 assert.throws(()=>captureBuildContents(denied,source,[...paths,'extra.bin'],()=>{assert.fail('over-budget content must not be recorded');},'build'),/IMPROVE_BUILD_CONTENT_LIMIT/);
 assert.deepEqual(readdirSync(join(denied.root,'objects')),[]);
});

test('build capture keeps per-file, ordinary-path and file-count limits before writing evidence',t=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-build-content-paths-'))),source=join(directory,'source');mkdirSync(source);
 const e=new Evidence(join(directory,'data'),'build');t.after(()=>{e.close();rmSync(directory,{recursive:true,force:true});});
 const record=()=>assert.fail('rejected paths must not be recorded');
 writeFileSync(join(source,'large.bin'),'');truncateSync(join(source,'large.bin'),16*1024*1024+1);
 assert.throws(()=>captureBuildContents(e,source,['large.bin'],record,'build'),/IMPROVE_SOURCE_SIZE_OR_TYPE_DENIED/);
 writeFileSync(join(source,'plain.txt'),'retained');symlinkSync(join(source,'plain.txt'),join(source,'alias.txt'));
 assert.throws(()=>captureBuildContents(e,source,['alias.txt'],record,'build'),/IMPROVE_SOURCE_ALIAS_DENIED/);
 assert.throws(()=>captureBuildContents(e,source,['../outside'],record,'build'),/IMPROVE_SOURCE_PATH_DENIED/);
 mkdirSync(join(source,'directory'));
 assert.throws(()=>captureBuildContents(e,source,['directory'],record,'build'),/IMPROVE_SOURCE_SIZE_OR_TYPE_DENIED/);
 assert.throws(()=>captureBuildContents(e,source,Array.from({length:20001},(_,i)=>`missing-${i}`),record,'build'),/IMPROVE_BUILD_FILE_LIMIT/);
 assert.deepEqual(readdirSync(join(e.root,'objects')),[]);
});

test('candidate content is bounded after separately admissible inputs and outputs are combined',()=>{
 const ref={sha256:digest('content'),bytes:16*1024*1024};
 const inputs=Array.from({length:10},(_,i)=>({path:`input-${i}`,ref})),outputs=[{path:'dist/new.js',ref:{sha256:digest('x'),bytes:1}}];
 assert.doesNotThrow(()=>assertBuildContentBudget(inputs));assert.doesNotThrow(()=>assertBuildContentBudget(outputs));
 assert.throws(()=>assertBuildContentBudget([...inputs,...outputs]),/IMPROVE_BUILD_CONTENT_LIMIT/);
 const empty=Array.from({length:20000},(_,i)=>({path:`empty-${i}`,ref:{sha256:digest(''),bytes:0}}));
 assert.doesNotThrow(()=>assertBuildContentBudget(empty));
 assert.throws(()=>assertBuildContentBudget([...empty,...outputs]),/IMPROVE_BUILD_FILE_LIMIT/);
});

test('a file growing after the metadata scan cannot bypass the actual-read content budget',t=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-build-content-growth-'))),source=join(directory,'source');mkdirSync(source);
 const e=new Evidence(join(directory,'data'),'build');t.after(()=>{e.close();rmSync(directory,{recursive:true,force:true});});
 const paths=Array.from({length:10},(_,i)=>`${i}.bin`);
 for(const [i,path]of paths.entries()){writeFileSync(join(source,path),'');truncateSync(join(source,path),16*1024*1024-(i===9?1:0));}
 writeFileSync(join(source,'extra.bin'),'x');paths.push('extra.bin');
 const firstInode=lstatSync(join(source,paths[0])).ino,read=fs.readFileSync;let changed=false;
 // Schedule a real file edit at the filesystem read boundary, after the complete
 // metadata scan. Persistence and every subsequent read still use the real disk.
 const hooked=t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{
  const bytes=read(...args),fd=args[0];
  if(!changed&&typeof fd==='number'&&fstatSync(fd).ino===firstInode){truncateSync(join(source,'9.bin'),16*1024*1024);changed=true;}
  return bytes;
 });
 syncBuiltinESMExports();
 try{
  assert.throws(()=>captureBuildContents(e,source,paths,()=>assert.fail('incomplete capture must not be recorded'),'build'),/IMPROVE_BUILD_CONTENT_LIMIT/);
  assert.equal(changed,true);assert.equal(existsSync(join(e.root,'objects',digest('x'))),false);
 }finally{hooked.mock.restore();syncBuiltinESMExports();}
});
