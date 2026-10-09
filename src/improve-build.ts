import {readFileSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {Evidence,digest,readObject,type BlobRef} from './evidence.js';
import {sourceBytes,sourceInputPaths,verifySelfSource,type SourceTarget} from './improve-source.js';
import {regularFiles,materialize,type ContentFile} from './eval/store.js';
import {verifiedImage} from './eval/plan.js';
import type {ContentChange} from './improve-validation.js';

const installation=fileURLToPath(new URL('../../',import.meta.url));
const entry='dist/src/cli.js';
export interface ImproveBuildArtifact {id:string;directory:string;entry:string;manifest:BlobRef;files:number;bytes:number;compatibility:{node:string;platform:string;arch:string};sourceBuild:string}
export interface ImproveBuildPair {state:'completed';targetId:string;sourceRoot:string;baseline:ImproveBuildArtifact;candidate:ImproveBuildArtifact;execution:BlobRef;startup:BlobRef;environment:{image:string;compiler:string};scope:string}
function dependencyPaths(root:string,development:boolean){
 const lock=JSON.parse(readFileSync(join(root,'dist/execution/package-lock.json'),'utf8')),files:string[]=[];
 for(const [path,metadata]of Object.entries(lock.packages)as[string,{dev?:boolean;optional?:boolean}][]){if(!path||!development&&metadata.dev)continue;if(!existsSync(join(root,path))){if(metadata.optional)continue;throw Error(`IMPROVE_BUILD_DEPENDENCY_MISSING:${path}`);}files.push(...regularFiles(join(root,path),'',false).filter(p=>!p.startsWith('node_modules/')).map(p=>`${path}/${p}`));}
 return [...new Set(files)].sort();
}
function saveContents(e:Evidence,root:string,paths:string[],record:(kind:string,data:any)=>string,groupId:string){
 const files:ContentFile[]=[];let total=0;
 for(const path of paths){const bytes=sourceBytes(root,path,16*1024*1024,true);total+=bytes.length;if(total>134217728)throw Error('IMPROVE_BUILD_CONTENT_LIMIT');files.push({path,ref:e.blob(bytes),mode:lstatSync(join(root,path)).mode&0o777});}
 for(let i=0;i<files.length;i+=100)record('improve.build-content',{groupId,files:files.slice(i,i+100)});
 return files;
}
function retained(e:Evidence,files:ContentFile[],directory:string):ImproveBuildArtifact{
 const manifest=e.blob(JSON.stringify(files)),source=files.find(f=>f.path==='dist/execution/source-build.json');if(!source||!files.some(f=>f.path===entry))throw Error('IMPROVE_BUILD_ENTRY_MISSING');
 return {id:manifest.sha256,directory,entry,manifest,files:files.length,bytes:files.reduce((n,f)=>n+f.ref.bytes,0),compatibility:{node:process.version,platform:process.platform,arch:process.arch},sourceBuild:source.ref.sha256};
}
export function buildFiles(root:string,build:ImproveBuildArtifact):ContentFile[]{
 const files=JSON.parse(readObject(root,build.manifest).toString())as ContentFile[];
 if(build.id!==build.manifest.sha256||!Array.isArray(files)||files.length!==build.files||files.length>20000||new Set(files.map(f=>f.path)).size!==files.length)throw Error('IMPROVE_BUILD_MANIFEST_INVALID');return files;
}
/** Verify actual retained executable/dependency/configuration bytes, not package names. */
export function verifyImproveBuild(root:string,build:ImproveBuildArtifact,compatibility=true){
 if(compatibility&&(build.compatibility.node!==process.version||build.compatibility.platform!==process.platform||build.compatibility.arch!==process.arch))throw Error('IMPROVE_BUILD_COMPATIBILITY_CHANGED');
 if(realpathSync(build.directory)!==build.directory||build.entry!==entry)throw Error('IMPROVE_BUILD_ENTRY_CHANGED');
 const files=buildFiles(root,build),actual=regularFiles(build.directory);
 if(!isDeepStrictEqual(actual.sort(),files.map(f=>f.path).sort()))throw Error('IMPROVE_BUILD_FILE_SET_CHANGED');
 for(const file of files){const bytes=sourceBytes(build.directory,file.path,16*1024*1024,true);if((lstatSync(join(build.directory,file.path)).mode&0o777)!==(0o444|((file.mode??0)&0o111)))throw Error(`IMPROVE_BUILD_MODE_CHANGED:${file.path}`);if(!bytes.equals(readObject(root,file.ref)))throw Error(`IMPROVE_BUILD_CONTENT_CHANGED:${file.path}`);}
 return files;
}
/** Current registered source may be before or after this exact selected write,
 * depending on rollback; unrelated user/build-input edits always remain visible. */
export function verifyBuildSource(root:string,pair:ImproveBuildPair,side:'baseline'|'candidate'|'either'){
 const files=buildFiles(root,pair[side==='either'?'baseline':side]),source=JSON.parse(readObject(root,files.find(f=>f.path==='dist/execution/source-build.json')!.ref).toString());
 if(!isDeepStrictEqual(sourceInputPaths(pair.sourceRoot),source.inputs.map((f:any)=>f.path).sort()))throw Error('IMPROVE_BUILD_SOURCE_INPUT_SET_CHANGED');
 for(const file of source.inputs){const bytes=sourceBytes(pair.sourceRoot,file.path,8*1024*1024);if(bytes.length!==file.bytes||digest(bytes)!==file.sha256){const candidateFiles=side==='either'?buildFiles(root,pair.candidate):[],other=side==='either'?JSON.parse(readObject(root,candidateFiles.find(f=>f.path==='dist/execution/source-build.json')!.ref).toString()).inputs.find((f:any)=>f.path===file.path):null;if(!other||bytes.length!==other.bytes||digest(bytes)!==other.sha256)throw Error(`IMPROVE_BUILD_SOURCE_CHANGED:${file.path}`);}}
}
export class ImproveBuildFailure extends Error{constructor(readonly state:'failed'|'unknown',message:string){super(message);}}
export async function prepareImproveBuild(o:{evidence:Evidence;target:SourceTarget;changes:ContentChange[];directory:string;timeoutMs:number;deadline:string;signal:AbortSignal;groupId:string;record:(kind:string,data:any)=>string;guard:()=>void}):Promise<ImproveBuildPair>{
 const {evidence:e,target,record,guard}=o,source=target.workspace!;
 guard();if(verifySelfSource(source)!==target.applicableVersion)throw Error('IMPROVE_SELF_SOURCE_VERSION_DRIFT');
 const original=JSON.parse(readFileSync(join(installation,'dist/execution/source-build.json'),'utf8'));
 // This path changes product TypeScript only. Lock/compiler/build recipe changes
 // need separately prepared dependencies; never install or run hooks implicitly.
 if(o.changes.some(c=>c.targetId!==target.id||!c.path.startsWith('src/')||!c.path.endsWith('.ts')||!original.inputs.some((f:any)=>f.path===c.path)))throw Error('IMPROVE_SELF_BUILD_DEPENDENCY_PREPARATION_REQUIRED');
 const dependencies=dependencyPaths(source,true),production=dependencyPaths(installation,false);
 for(const path of production)if(!sourceBytes(source,path,16*1024*1024,true).equals(sourceBytes(installation,path,16*1024*1024,true)))throw Error(`IMPROVE_BUILD_DEPENDENCY_MISMATCH:${path}`);
 const paths=[...new Set([...original.inputs.map((f:any)=>f.path),...original.outputs.map((f:any)=>f.path),'dist/execution/source-build.json',...dependencies])].sort();
 const baselineFiles=saveContents(e,source,paths,record,o.groupId),changes=new Map(o.changes.map(c=>[c.path,Buffer.from(c.content)]));
 const candidateInputs=baselineFiles.filter(f=>!f.path.startsWith('dist/')).map(f=>changes.has(f.path)?{...f,ref:e.blob(changes.get(f.path)!)}:f);
 await mkdir(o.directory,{mode:0o700});materialize(e.root,baselineFiles,join(o.directory,'baseline'));
 const baseline=retained(e,baselineFiles,join(o.directory,'baseline')),input=join(o.directory,'input');await mkdir(input,{mode:0o755});materialize(e.root,candidateInputs,join(input,'source'));
 await writeFile(join(input,'bootstrap.mjs'),"import{cp,chmod,symlink}from'node:fs/promises';import{execFileSync}from'node:child_process';await cp('/input/source','/work/source',{recursive:true,filter:p=>p!=='/input/source/node_modules'});await symlink('/input/source/node_modules','/work/source/node_modules','dir');await chmod('/work/source',0o755);process.chdir('/work/source');console.log(JSON.stringify({buildEnvironment:{node:process.version,nodeOptions:process.env.NODE_OPTIONS,heapLimit:(await import('node:v8')).getHeapStatistics().heap_size_limit}}));execFileSync(process.execPath,['scripts/build-artifact.mjs'],{stdio:'inherit'});",{flag:'wx',mode:0o444});
 record('improve.build-started',{groupId:o.groupId,targetId:target.id,sourceRoot:source,baseline,recipe:'Unmodified registered scripts/build-artifact.mjs; exact TypeScript compiler; no npm install or lifecycle hooks',resources:{profile:'typescript-build',memoryBytes:1073741824,nodeHeapMiB:768},image:verifiedImage});
 const engine=await import(new URL('../execution/isolation/boundary.mjs',import.meta.url).href);
 const execution=await engine.runRestricted({image:verifiedImage,inputDir:input,runDir:join(o.directory,'execution'),command:['node','/input/bootstrap.mjs'],resourceProfile:'typescript-build',timeoutMs:Math.max(100,Math.min(o.timeoutMs,Date.parse(o.deadline)-Date.now())),signal:o.signal});guard();
 const executionRef=e.blob(JSON.stringify(execution));record('improve.build-execution',{groupId:o.groupId,execution:executionRef,state:!execution.terminated||execution.status==='invalid'?'unknown':execution.code===0?'completed':'failed'});
 if(!execution.terminated||execution.status==='invalid'||execution.code!==0)throw new ImproveBuildFailure(!execution.terminated||execution.status==='invalid'?'unknown':'failed',`IMPROVE_BUILD_FAILED:${execution.reason??execution.stderr??execution.code}`);
 const outputRoot=join(o.directory,'execution/work/source'),names=regularFiles(join(outputRoot,'dist')).filter(p=>p.startsWith('src/')||p.startsWith('execution/')).map(p=>`source/dist/${p}`),destination=join(o.directory,'export');
 await engine.exportStopped(execution,names,destination,{maxFiles:2000,maxBytes:16777216});
 const compiledRoot=join(destination,'source'),manifestBytes=sourceBytes(compiledRoot,'dist/execution/source-build.json',8*1024*1024),compiled=JSON.parse(manifestBytes.toString());
 const expectedInputs=original.inputs.map((f:any)=>changes.has(f.path)?{...f,sha256:digest(changes.get(f.path)!),bytes:changes.get(f.path)!.length}:f);
 if(compiled.version!==1||!isDeepStrictEqual(compiled.inputs,expectedInputs)||!isDeepStrictEqual(compiled.compiler,original.compiler))throw Error('IMPROVE_BUILD_SOURCE_CORRESPONDENCE_CHANGED');
 const outputFiles=saveContents(e,compiledRoot,names.map((p:string)=>p.slice('source/'.length)),record,o.groupId);
 if(!isDeepStrictEqual(compiled.outputs.map((f:any)=>f.path).sort(),outputFiles.filter(f=>f.path!=='dist/execution/source-build.json').map(f=>f.path).sort()))throw Error('IMPROVE_BUILD_OUTPUT_SET_CHANGED');
 for(const file of compiled.outputs){const actual=outputFiles.find(f=>f.path===file.path)!;if(actual.ref.sha256!==file.sha256||actual.ref.bytes!==file.bytes)throw Error('IMPROVE_BUILD_OUTPUT_CONTENT_CHANGED');}
 // Candidate outputs are inert until a separately recorded explicit launch.
 const candidateFiles=[...candidateInputs,...outputFiles].sort((a,b)=>a.path.localeCompare(b.path));materialize(e.root,candidateFiles,join(o.directory,'candidate'));
 const candidate=retained(e,candidateFiles,join(o.directory,'candidate'));
 const smokeInput=join(o.directory,'startup-input');await mkdir(smokeInput,{mode:0o755});materialize(e.root,candidateFiles,join(smokeInput,'build'));
 const startup=await engine.runRestricted({image:verifiedImage,inputDir:smokeInput,runDir:join(o.directory,'startup'),command:['node','/input/build/dist/src/cli.js','--help'],timeoutMs:Math.max(100,Math.min(o.timeoutMs,Date.parse(o.deadline)-Date.now())),signal:o.signal});guard();
 const startupRef=e.blob(JSON.stringify(startup));record('improve.build-startup',{groupId:o.groupId,buildId:candidate.id,execution:startupRef,state:!startup.terminated||startup.status==='invalid'?'unknown':startup.code===0?'completed':'failed'});
 if(!startup.terminated||startup.status==='invalid'||startup.code!==0)throw new ImproveBuildFailure(!startup.terminated||startup.status==='invalid'?'unknown':'failed',`IMPROVE_BUILD_STARTUP_FAILED:${startup.reason??startup.stderr??startup.code}`);
 const pair:ImproveBuildPair={state:'completed',targetId:target.id,sourceRoot:source,baseline,candidate,execution:executionRef,startup:startupRef,environment:{image:verifiedImage,compiler:digest(JSON.stringify(original.compiler))},scope:'TypeScript source change built in the existing restricted VM. Native dependency bytes are retained from the registered host installation; subsequent launch rechecks host Node/platform/arch. No running process replaced.'};
 verifyImproveBuild(e.root,baseline);verifyImproveBuild(e.root,candidate);record('improve.build',{groupId:o.groupId,...pair});return pair;
}
