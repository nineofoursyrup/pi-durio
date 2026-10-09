import {readdirSync,readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {Evidence,readObject,openHostReadonly,type BlobRef,digest} from '../evidence.js';
export interface ContentFile {path:string;ref:BlobRef;mode?:number}
export interface EvalFact {seq:number;at:string;kind:string;data:any;source:string}
export function evalFacts(root:string,id?:string):EvalFact[]{const db=openHostReadonly(root);try{return db.prepare(`SELECT * FROM records WHERE kind LIKE 'eval.%' AND kind!='eval.content' ${id?'AND run_id=?':''} ORDER BY seq`).all(...id?[id]:[]).map(row=>{const ref=JSON.parse(String(row.body));return{seq:Number(row.seq),at:String(row.at),kind:String(row.kind),data:JSON.parse(readObject(root,ref).toString()),source:`e1:${row.seq}:${ref.sha256}`};});}finally{db.close();}}
export function appendFact(e:Evidence,kind:string,data:unknown){const seq=e.append(kind,data);return `e1:${seq}:${digest(JSON.stringify(data))}`;}
export function regularFiles(root:string,prefix='',singleLink=true):string[]{
 const result:string[]=[];
 for(const entry of readdirSync(join(root,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(prefix,entry.name),stat=lstatSync(join(root,path));if(stat.isDirectory()&&!stat.isSymbolicLink())result.push(...regularFiles(root,path,singleLink));else if(stat.isFile()&&!stat.isSymbolicLink()&&(stat.nlink===1||!singleLink))result.push(path);else throw Error(`EVAL_UNSAFE_FILE: ${path}`);if(result.length>20000)throw Error('EVAL_FILE_LIMIT');}
 return result;
}
export function captureFiles(e:Evidence,root:string,names:readonly string[]){
 const files:ContentFile[]=[];let bytes=0;
 for(const path of names){const content=readFileSync(join(root,path));bytes+=content.length;if(bytes>134217728)throw Error('EVAL_CONTENT_LIMIT');files.push({path,ref:e.blob(content),mode:lstatSync(join(root,path)).mode&0o777});}
 for(let i=0;i<files.length;i+=100)e.append('eval.content',{files:files.slice(i,i+100)});
 return {files,bytes,id:digest(JSON.stringify(files))};
}
export function materialize(root:string,files:readonly ContentFile[],destination:string){
 mkdirSync(destination,{recursive:false,mode:0o755});
 for(const {path,ref,mode}of files){if(!/^[a-zA-Z0-9_@+.,=-]+(?:\/[a-zA-Z0-9_@+.,=-]+)*$/.test(path)||path.split('/').some(p=>p==='.'||p==='..'))throw Error('EVAL_CONTENT_PATH');const to=join(destination,path);mkdirSync(dirname(to),{recursive:true,mode:0o755});writeFileSync(to,readObject(root,ref),{flag:'wx',mode:0o444|((mode??0)&0o111)});}
}
/** Only execution modules go to the VM. Host runner, fixtures, graders and reports are excluded. */
export function installedRuntimeFiles(installation:string){
 const files=['package.json','dist/execution/package-lock.json','eval-environment.json'];
 files.push(...regularFiles(join(installation,'dist/src')).filter(p=>!p.startsWith('eval/')||['eval/guest.js','eval/guest.js.map','eval/guest.d.ts'].includes(p)).map(p=>'dist/src/'+p));
 const lock=JSON.parse(readFileSync(join(installation,'dist/execution/package-lock.json'),'utf8'));
 for(const [path,metadata]of Object.entries(lock.packages)as[string,{dev?:boolean;optional?:boolean}][]){if(!path||metadata.dev)continue;try{files.push(...regularFiles(join(installation,path),'',false).filter(p=>!p.startsWith('node_modules/')).map(p=>path+'/'+p));}catch(error){if(!metadata.optional)throw error;}}
 return [...new Set(files)];
}
