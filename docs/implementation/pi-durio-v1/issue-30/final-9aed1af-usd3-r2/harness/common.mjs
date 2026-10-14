import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,lstatSync,readlinkSync} from 'node:fs';
import assert from 'node:assert/strict';

export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const json=path=>JSON.parse(readFileSync(path,'utf8'));
export const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export const file=path=>{const bytes=readFileSync(path);return{path,bytes:bytes.length,sha256:sha(bytes)};};
export function installationFiles(root,prefix=''){
 return readdirSync(join(root,prefix)).sort().flatMap(name=>{
  const path=prefix?`${prefix}/${name}`:name,absolute=join(root,path),info=lstatSync(absolute);
  if(info.isSymbolicLink())return [{path,symlink:readlinkSync(absolute)}];
  if(info.isDirectory())return installationFiles(root,path);
  if(!info.isFile())throw Error(`INSTALLED_UNSUPPORTED_ENTRY:${path}`);
  const bytes=readFileSync(absolute);return [{path,bytes:bytes.length,sha256:sha(bytes)}];
 });
}
export function verifyInstallation(root,expected){
 const ordered=entries=>[...entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 assert.deepEqual(ordered(installationFiles(root)),ordered(expected),'INSTALLED_CONTENT_OR_SET_CHANGED');
}
export async function installed(root){
 const require=createRequire(join(root,'package.json'));
 const load=id=>import(pathToFileURL(require.resolve(id)).href);
 return {root,package:join(root,'node_modules/pi-durio'),runtime:await load('pi-durio'),eval:await load('pi-durio/eval'),query:await load('pi-durio/query'),offline:await load('pi-durio/offline'),improve:await load('pi-durio/improve'),validation:await load('pi-durio/improve-validation')};
}

/** Read committed host facts through the installed public query API. No usage
 * accounting or transport replacement lives here. The original body is retained
 * before settlement; at admission, throw as well as abort to reject SDK retries. */
export function authenticationStop(api,dataRoot,runId,controller){
 let after=0,stopped=null;
 function inspect(){
  if(stopped)return stopped;
  for(;;){
   const page=api.query.readRunRecords(dataRoot,typeof runId==='function'?runId():runId,{after,limit:50,kinds:['provider.http']});
   for(const row of page.records){after=row.seq;const fact=JSON.parse(api.runtime.readObject(dataRoot,row.ref));if([401,403].includes(fact.status)){stopped={reason:`PROVIDER_HTTP_${fact.status}`,source:`e1:${row.seq}:${row.ref.sha256}`,dispatchId:fact.id};return stopped;}}
   if(!page.more)return null;
  }
 }
 return {get stopped(){return stopped;},fault(kind){
  if(!['budget.reserve','budget.settle','eval.outcome'].includes(kind))return;
  const reason=inspect();if(!reason)return;
  controller.abort(Error(reason.reason));
  if(kind==='budget.reserve')throw Error(`BATCH_AUTH_STOP:${reason.reason}`);
 }};
}
