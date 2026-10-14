import {readFileSync,readdirSync,realpathSync,lstatSync,openSync,closeSync,fstatSync,constants,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,relative,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {regularFiles} from './file-inventory.js';
import {Evidence,digest,type BlobRef} from './evidence.js';

export interface ImproveSource {id:string;kind:'project'|'agent-config'|'prompt-skill'|'self-source'|'eval-asset';paths:string[];root?:string}
export interface SourceFile {path:string;sha256:string;bytes:number;sourceId:string;content:BlobRef;state:'available'|'withheld';reason:string[]}
export interface SourceTarget {id:string;kind:ImproveSource['kind'];workspace:string|null;files:SourceFile[];baseline:string;applicableVersion:string|null;state:'verified'|'incomplete';gaps:string[]}
const installation=fileURLToPath(new URL('../../',import.meta.url));
export function redactAnalysisText(text:string) {
 const reasons:string[]=[];
 if(/(?:api[_-]?key|authorization|bearer\s|password|secret|private[ _-]?key|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|BEGIN.*KEY|token["'\s]*[:=])/i.test(text))reasons.push('credential-like material withheld');
 if(/(?:ignore (?:all |previous |prior )*instructions|system prompt|<\/?(?:system|developer)>|执行.{0,12}(?:命令|指令)|忽略.{0,12}指令)/i.test(text))reasons.push('instruction-like material withheld; never authority');
 if(/\u0000|�/.test(text))reasons.push('binary or undecodable material withheld');
 return {text:reasons.length?'[WITHHELD]':text,reasons,coverage:'conservative known patterns; not universal secret detection'};
}
function inside(root:string,path:string){const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);}
/** Open only declared ordinary files, with bounded reads and alias checks before/after acquisition.
 * The model has no filesystem capability: all acquired views are frozen before scheduling. */
export function sourceBytes(root:string,path:string,max=262144,compiler=false) {
 if(isAbsolute(path)||!path||path.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p)||/(^|\/)\.git(?:\/|$)/.test(path)||!compiler&&/(^|\/)node_modules(?:\/|$)/.test(path))throw Error('IMPROVE_SOURCE_PATH_DENIED');
 const absolute=join(root,path);if(!inside(root,absolute))throw Error('IMPROVE_SOURCE_PATH_DENIED');
 let part=root;for(const segment of path.split('/')){part=join(part,segment);if(lstatSync(part).isSymbolicLink())throw Error('IMPROVE_SOURCE_ALIAS_DENIED');}
 if(realpathSync(absolute)!==absolute)throw Error('IMPROVE_SOURCE_ALIAS_DENIED');
 const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const before=fstatSync(fd);if(!before.isFile()||before.size>max)throw Error('IMPROVE_SOURCE_SIZE_OR_TYPE_DENIED');const bytes=readFileSync(fd),after=fstatSync(fd),named=lstatSync(absolute);if(bytes.length>max||before.size!==after.size||before.mtimeMs!==after.mtimeMs||named.dev!==after.dev||named.ino!==after.ino||realpathSync(absolute)!==absolute)throw Error('IMPROVE_SOURCE_CHANGED');return bytes;}finally{closeSync(fd);}
}
export function sourceInputPaths(root:string):string[]{
 const paths:string[]=[];const visit=(path:string)=>{const stat=lstatSync(join(root,path));if(stat.isSymbolicLink())throw Error('SELF_SOURCE_INPUT_ALIAS');if(stat.isDirectory())for(const name of readdirSync(join(root,path)).sort())visit(`${path}/${name}`);else if(stat.isFile())paths.push(path);else throw Error('SELF_SOURCE_INPUT_TYPE');if(paths.length>10000)throw Error('SELF_SOURCE_INPUT_LIMIT');};
 for(const path of ['src','test','scripts','vendor','package.json','package-lock.json','tsconfig.json'])visit(path);return paths.sort();
}
function productionInputs(root:string){const lock=JSON.parse(readFileSync(join(root,'dist/execution/package-lock.json'),'utf8')),files:string[]=[];for(const [path,metadata]of Object.entries(lock.packages)as[string,{dev?:boolean;optional?:boolean}][]){if(!path||metadata.dev)continue;try{files.push(...regularFiles(join(root,path),'',false).filter(p=>!p.startsWith('node_modules/')).map(p=>`${path}/${p}`));}catch(error){if(!metadata.optional)throw error;}}return [...new Set(files)].sort();}
export function verifySelfSource(root:string) {
 const raw=sourceBytes(installation,'dist/execution/source-build.json',8*1024*1024);
 const manifest=JSON.parse(raw.toString());
 if(manifest.version!==1||!Array.isArray(manifest.inputs)||!manifest.inputs.length||!Array.isArray(manifest.outputs)||!manifest.outputs.length||!Array.isArray(manifest.compiler)||!manifest.compiler.length||manifest.inputs.length>10000||manifest.outputs.length>10000||manifest.compiler.length>10000)throw Error('SELF_SOURCE_BUILD_MANIFEST_INVALID');
 if(JSON.stringify(sourceInputPaths(root))!==JSON.stringify(manifest.inputs.map((f:{path:string})=>f.path).sort()))throw Error('SELF_SOURCE_INPUT_SET_MISMATCH');
 if(!sourceBytes(root,'dist/execution/source-build.json',8*1024*1024).equals(raw))throw Error('SELF_SOURCE_MANIFEST_MISMATCH');
 for(const base of [root,installation]){const outputs=[...regularFiles(join(base,'dist/src')).map(p=>`dist/src/${p}`),...regularFiles(join(base,'dist/execution')).filter(p=>p!=='source-build.json').map(p=>`dist/execution/${p}`)].sort();if(JSON.stringify(outputs)!==JSON.stringify(manifest.outputs.map((f:{path:string})=>f.path).sort()))throw Error('SELF_SOURCE_OUTPUT_SET_MISMATCH');}
 // This is an explicit registered checkout only, never directory-name or remote discovery.
 for(const entry of manifest.compiler??[]){const bytes=sourceBytes(root,entry.path,16*1024*1024,true);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_COMPILER_MISMATCH:${entry.path}`);}
 for(const entry of manifest.inputs){const bytes=sourceBytes(root,entry.path,8*1024*1024);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_CONTENT_MISMATCH:${entry.path}`);}
 for(const entry of manifest.outputs){for(const base of [root,installation]){const bytes=sourceBytes(base,entry.path,8*1024*1024);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_BUILD_MISMATCH:${entry.path}`);}}
 const deps=productionInputs(installation);if(JSON.stringify(deps)!==JSON.stringify(productionInputs(root)))throw Error('SELF_SOURCE_DEPENDENCY_SET_MISMATCH');
 for(const path of deps)if(!sourceBytes(root,path,16*1024*1024,true).equals(sourceBytes(installation,path,16*1024*1024,true)))throw Error(`SELF_SOURCE_DEPENDENCY_MISMATCH:${path}`);
 return digest(raw);
}
export function captureImproveSources(evidence:Evidence,workspace:string,sources:ImproveSource[],version:string|null) {
 const targets:SourceTarget[]=[],texts=new Map<string,{text:string;sourceId:string;redaction:ReturnType<typeof redactAnalysisText>}>();let total=0;
 for(const source of sources){const gaps:string[]=[];let root:string|null=null,applicableVersion=version;
  const target:SourceTarget={id:source.id,kind:source.kind,workspace:null,files:[],baseline:'',applicableVersion,state:'verified',gaps};
  try{root=realpathSync(source.root??workspace);target.workspace=root;
   if(source.kind!=='self-source'&&(root===realpathSync(installation)||inside(realpathSync(installation),root)))throw Error('SELF_SOURCE_EXPLICIT_REGISTRATION_REQUIRED');
   if(source.kind==='project'&&root!==workspace)throw Error('IMPROVE_CROSS_PROJECT_SOURCE_DENIED');
   if(source.kind==='self-source'){if(!source.root)throw Error('SELF_SOURCE_EXPLICIT_REGISTRATION_REQUIRED');applicableVersion=verifySelfSource(root);target.applicableVersion=applicableVersion;}
   if(source.kind==='eval-asset'){verifyRegisteredSourceFingerprints(evidence.root,workspace);}
   for(const path of source.paths){try{const bytes=sourceBytes(root,path,Math.max(0,Math.min(262144,1048576-total)));total+=bytes.length;if(total>1048576)throw Error('IMPROVE_SOURCE_TOTAL_LIMIT');const redaction=redactAnalysisText(bytes.toString('utf8')),content=evidence.blob(bytes),data={targetId:source.id,kind:source.kind,root,path,content,redaction:{reasons:redaction.reasons,coverage:redaction.coverage},applicableVersion};const seq=evidence.append('improve.source',data),sourceId=`e1:${seq}:${digest(JSON.stringify(data))}`;
    target.files.push({path,...content,content,sourceId,state:redaction.reasons.length?'withheld':'available',reason:redaction.reasons});texts.set(`${source.id}\0${path}`,{text:redaction.text,sourceId,redaction});
   }catch(error){gaps.push(`${path}: ${String(error)}`);}}
  }catch(error){gaps.push(String(error));}
  if(gaps.length)target.state='incomplete';target.baseline=digest(JSON.stringify({workspace:target.workspace,files:target.files.map(f=>({path:f.path,sha256:f.sha256})),applicableVersion,gaps}));targets.push(target);
 }
 return {targets,texts};
}

// Source registration: persisted per dataRoot; re-verified at each analysis start.
// Only eval-asset and self-source require explicit registration per I3.
export interface SourceRegistration {id:string;workspace:string;kind:'self-source'|'eval-asset';root:string;paths:string[];fingerprints:{path:string;sha256:string;bytes:number}[];registeredAt:string}

function registrationPath(dataRoot:string){return join(dataRoot,'source-registrations.json');}

function readRegistrationStore(dataRoot:string):{registrations:SourceRegistration[],unregistered:string[]}{
 try{return JSON.parse(readFileSync(registrationPath(dataRoot),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {registrations:[],unregistered:[]};throw error;}
}

function writeRegistrationStore(dataRoot:string,store:{registrations:SourceRegistration[],unregistered:string[]}){
 mkdirSync(dataRoot,{recursive:true,mode:0o700});
 writeFileSync(registrationPath(dataRoot),JSON.stringify(store,null,2)+'\n',{mode:0o600});
}

/** Register a self-source or eval-asset path in the data root with content fingerprints.
 * On subsequent analyses the host re-verifies the current content matches the stored fingerprints. */
export function registerImproveSource(dataRoot:string,workspace:string,source:{kind:'self-source'|'eval-asset';root:string;paths:string[]}):SourceRegistration{
 const root=realpathSync(source.root);
 const fingerprints=source.paths.map(path=>{const bytes=sourceBytes(root,path);return {path,sha256:digest(bytes),bytes:bytes.length};});
 const id=randomUUID();
 const reg:SourceRegistration={id,workspace:realpathSync(workspace),kind:source.kind,root,paths:source.paths,fingerprints,registeredAt:new Date().toISOString()};
 const store=readRegistrationStore(dataRoot);store.registrations.push(reg);writeRegistrationStore(dataRoot,store);
 return reg;
}

export function listRegisteredSources(dataRoot:string,workspace?:string):SourceRegistration[]{
 const store=readRegistrationStore(dataRoot);
 const unregistered=new Set(store.unregistered??[]);
 return store.registrations.filter(r=>!unregistered.has(r.id)&&(!workspace||r.workspace===workspace));
}

export function unregisterImproveSource(dataRoot:string,registrationId:string):void{
 const store=readRegistrationStore(dataRoot);
 if(!store.registrations.some(r=>r.id===registrationId))throw Error('IMPROVE_SOURCE_REGISTRATION_NOT_FOUND');
 if(!(store.unregistered??[]).includes(registrationId)){store.unregistered=[...(store.unregistered??[]),registrationId];writeRegistrationStore(dataRoot,store);}
}

/** Verify that registered eval-asset sources have not changed since registration.
 * Called at analysis start; throws with a descriptive error if content has drifted. */
export function verifyRegisteredSourceFingerprints(dataRoot:string,workspace:string):void{
 for(const reg of listRegisteredSources(dataRoot,workspace)){
  if(reg.kind!=='eval-asset')continue;
  for(const fp of reg.fingerprints){
   let current:Buffer;try{current=sourceBytes(reg.root,fp.path);}catch(error){throw Error(`IMPROVE_REGISTERED_SOURCE_UNAVAILABLE: ${reg.root}/${fp.path}: ${String(error)}`);}
   if(current.length!==fp.bytes||digest(current)!==fp.sha256)throw Error(`IMPROVE_REGISTERED_SOURCE_CHANGED: ${reg.root}/${fp.path} changed since registration ${reg.id}`);
  }
 }
}
