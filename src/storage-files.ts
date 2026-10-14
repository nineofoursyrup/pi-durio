import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, realpath, readdir, mkdir, open, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

export interface StoredFile { path:string; sha256:string; bytes:number }
export const fileLimit=50000;
export async function exists(path:string) { try {await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;} }
export function safeRelative(path:string) {
  if(!path||isAbsolute(path)||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('UNSAFE_STORAGE_PATH');
  return path;
}
export async function regularFile(path:string) {
  const stat=await lstat(path);
  if(!stat.isFile()||await realpath(path)!==resolve(path))throw Error('STORAGE_ALIAS_OR_NON_FILE');
  return stat;
}
export async function hashFile(path:string):Promise<Omit<StoredFile,'path'>> {
  const before=await regularFile(path),hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(path)){hash.update(chunk);bytes+=chunk.length;}
  const after=await regularFile(path);
  if(bytes!==before.size||after.size!==before.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw Error('STORAGE_CHANGED_DURING_READ');
  return {sha256:hash.digest('hex'),bytes};
}
export async function treeFiles(root:string,options:{hash?:boolean;exclude?:(path:string)=>boolean}={}) {
  const output:StoredFile[]=[];
  async function walk(dir:string,prefix:string) {
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=prefix+entry.name;if(options.exclude?.(path))continue;
      const absolute=join(dir,entry.name);
      if(entry.isDirectory()){if(await realpath(absolute)!==resolve(absolute))throw Error('STORAGE_DIRECTORY_ALIAS');await walk(absolute,path+'/');}
      else {if(!entry.isFile())throw Error('STORAGE_ALIAS_OR_NON_FILE');if(output.length>=fileLimit)throw Error('STORAGE_FILE_LIMIT');const stat=await regularFile(absolute);output.push({path,bytes:stat.size,sha256:options.hash===false?'':(await hashFile(absolute)).sha256});}
    }
  }
  if(await exists(root))await walk(root,'');return output;
}
export async function syncDir(path:string) {const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}}
export async function saveJson(path:string,value:unknown) {const fd=await open(path,'wx',0o600);try{await fd.writeFile(JSON.stringify(value,null,2));await fd.sync();}finally{await fd.close();}await syncDir(dirname(path));}
export async function compressFile(source:string,target:string) {await pipeline(createReadStream(source),createGzip(),createWriteStream(target,{flags:'wx',mode:0o600}));const fd=await open(target,'r');try{await fd.sync();}finally{await fd.close();}}
export async function expandFile(source:string,target:string,file:StoredFile) {
  await regularFile(source);await mkdir(dirname(target),{recursive:true,mode:0o700});
  // A bounded stream refuses a compressed payload that exceeds its declared size.
  let bytes=0;
  await pipeline(createReadStream(source),createGunzip(),async function*(chunks){for await(const chunk of chunks){bytes+=chunk.length;if(bytes>file.bytes)throw Error('ARCHIVE_SIZE_MISMATCH');yield chunk;}},createWriteStream(target,{flags:'wx',mode:0o600}));
  const actual=await hashFile(target);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error('ARCHIVE_HASH_MISMATCH');
  const fd=await open(target,'r');try{await fd.sync();}finally{await fd.close();}
}
/** Destination must be a new sibling/outside tree. Never merge into or overwrite another root. */
export async function newDestination(source:string,destination:string) {
  const parent=await realpath(dirname(resolve(destination))),target=join(parent,resolve(destination).split('/').at(-1)!);
  const rel=relative(source,target),back=relative(target,source);
  if(!rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'))||(!isAbsolute(back)&&back!=='..'&&!back.startsWith('../')))throw Error('DESTINATION_OVERLAPS_SOURCE');
  if(await exists(target)||await exists(`${target}.lock`))throw Error('DESTINATION_EXISTS');return target;
}
export async function readJson(path:string,max=16*1024*1024) {const stat=await regularFile(path);if(stat.size>max)throw Error('MANIFEST_SIZE_LIMIT');return JSON.parse(await readFile(path,'utf8'));}
export async function publishDirectory(staging:string,destination:string) {
  if(await exists(destination))throw Error('DESTINATION_EXISTS');await rename(staging,destination);await syncDir(dirname(destination));
}
