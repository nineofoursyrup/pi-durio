import {existsSync,readdirSync,readFileSync,writeFileSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {workspaceOwnerRegistry} from './workspace-ownership.js';
import {digest} from './evidence.js';

const contains=(a:string,b:string)=>{const p=relative(a,b);return !p||!isAbsolute(p)&&p!=='..'&&!p.startsWith('../');};
export interface WorkspaceFence {dataRoot:string;decisionId:string;decisionSource:string;groupId:string;workspace:string}
/** A durable admission marker pointing at the existing host journal. It is not
 * a second outcome store. It survives process/owner release after partial work. */
export function workspaceFences(workspace:string):WorkspaceFence[]{
 if(!existsSync(workspaceOwnerRegistry))return [];
 const found:WorkspaceFence[]=[];
 for(const name of readdirSync(workspaceOwnerRegistry)){
  if(!/^[a-f0-9]{64}$/.test(name))continue;
  const path=join(workspaceOwnerRegistry,name,'improve-fence.json');if(!existsSync(path))continue;
  const fence=JSON.parse(readFileSync(path,'utf8')) as WorkspaceFence;
  if(!fence.workspace||name!==digest(fence.workspace))throw Error('IMPROVE_FENCE_IDENTITY_UNKNOWN');
  if(contains(workspace,fence.workspace)||contains(fence.workspace,workspace))found.push(fence);
 }
 return found;
}
export function assertWorkspaceUnfenced(workspace:string){const fences=workspaceFences(workspace);if(fences.length)throw Error(`IMPROVE_RECOVERY_REQUIRED: ${JSON.stringify(fences)}; inspect the original decision and explicitly roll back or reconcile; no ordinary task clears this fence`);}
export function setWorkspaceFence(fence:WorkspaceFence){
 const path=join(workspaceOwnerRegistry,digest(fence.workspace),'improve-fence.json');
 writeFileSync(path,JSON.stringify(fence),{flag:'wx',mode:0o600});for(const p of [path,join(workspaceOwnerRegistry,digest(fence.workspace))]){const fd=openSync(p,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
}
export function clearWorkspaceFence(fence:WorkspaceFence){
 const path=join(workspaceOwnerRegistry,digest(fence.workspace),'improve-fence.json');
 if(!existsSync(path))return;
 if(JSON.stringify(JSON.parse(readFileSync(path,'utf8')))!==JSON.stringify(fence))throw Error('IMPROVE_FENCE_CHANGED');unlinkSync(path);const fd=openSync(join(workspaceOwnerRegistry,digest(fence.workspace)),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
