import {readFileSync,realpathSync,lstatSync,openSync,closeSync,fstatSync,constants} from 'node:fs';
import {join,relative,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
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
export function verifySelfSource(root:string) {
 const raw=readFileSync(join(installation,'dist/execution/source-build.json'));
 const manifest=JSON.parse(raw.toString());
 if(manifest.version!==1||!Array.isArray(manifest.inputs)||!manifest.inputs.length||!Array.isArray(manifest.outputs)||!manifest.outputs.length||!Array.isArray(manifest.compiler)||!manifest.compiler.length||manifest.inputs.length>10000||manifest.outputs.length>10000||manifest.compiler.length>10000)throw Error('SELF_SOURCE_BUILD_MANIFEST_INVALID');
 // This is an explicit registered checkout only, never directory-name or remote discovery.
 for(const entry of manifest.compiler??[]){const bytes=sourceBytes(root,entry.path,16*1024*1024,true);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_COMPILER_MISMATCH:${entry.path}`);}
 for(const entry of manifest.inputs){const bytes=sourceBytes(root,entry.path,8*1024*1024);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_CONTENT_MISMATCH:${entry.path}`);}
 for(const entry of manifest.outputs){for(const base of [root,installation]){const bytes=sourceBytes(base,entry.path,8*1024*1024);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error(`SELF_SOURCE_BUILD_MISMATCH:${entry.path}`);}}
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
   for(const path of source.paths){try{const bytes=sourceBytes(root,path,Math.max(0,Math.min(262144,1048576-total)));total+=bytes.length;if(total>1048576)throw Error('IMPROVE_SOURCE_TOTAL_LIMIT');const redaction=redactAnalysisText(bytes.toString('utf8')),content=evidence.blob(bytes),data={targetId:source.id,kind:source.kind,root,path,content,redaction:{reasons:redaction.reasons,coverage:redaction.coverage},applicableVersion};const seq=evidence.append('improve.source',data),sourceId=`e1:${seq}:${digest(JSON.stringify(data))}`;
    target.files.push({path,...content,content,sourceId,state:redaction.reasons.length?'withheld':'available',reason:redaction.reasons});texts.set(`${source.id}\0${path}`,{text:redaction.text,sourceId,redaction});
   }catch(error){gaps.push(`${path}: ${String(error)}`);}}
  }catch(error){gaps.push(String(error));}
  if(gaps.length)target.state='incomplete';target.baseline=digest(JSON.stringify({workspace:target.workspace,files:target.files.map(f=>({path:f.path,sha256:f.sha256})),applicableVersion,gaps}));targets.push(target);
 }
 return {targets,texts};
}
