import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import {Evidence} from './evidence.js';
import {sourceBytes,sourceFileSize} from './improve-source.js';
import type {ContentFile} from './eval/store.js';

// Fixed expanded bytes per complete artifact, including every dependency/input
// path. Identical contents still count separately even when the CAS shares them.
const contentBytesLimit=160*1024*1024,fileBytesLimit=16*1024*1024,fileCountLimit=20000;
function checkFileCount(count:number){if(count>fileCountLimit)throw Error('IMPROVE_BUILD_FILE_LIMIT');}
function contentBudget(){
 let total=0;
 return (path:string,bytes:number)=>{if(bytes>fileBytesLimit)throw Error('IMPROVE_SOURCE_SIZE_OR_TYPE_DENIED');total+=bytes;if(total>contentBytesLimit)throw Error(`IMPROVE_BUILD_CONTENT_LIMIT: ${path}: ${total} > ${contentBytesLimit}`);};
}
/** Apply the same bound after changed inputs and compiled outputs are combined. */
export function assertBuildContentBudget(files:readonly ContentFile[]){
 checkFileCount(files.length);const account=contentBudget();
 for(const file of files)account(file.path,file.ref.bytes);
}

export function captureBuildContents(e:Evidence,root:string,paths:string[],record:(kind:string,data:any)=>string,groupId:string){
 checkFileCount(paths.length);const preflight=contentBudget();
 for(const path of paths)preflight(path,sourceFileSize(root,path,fileBytesLimit,true));
 const files:ContentFile[]=[],actual=contentBudget();
 for(const path of paths){const bytes=sourceBytes(root,path,fileBytesLimit,true);actual(path,bytes.length);files.push({path,ref:e.blob(bytes),mode:lstatSync(join(root,path)).mode&0o777});}
 for(let i=0;i<files.length;i+=100)record('improve.build-content',{groupId,files:files.slice(i,i+100)});
 return files;
}
