import {digest,readObject,type BlobRef} from './evidence.js';
import {improveFacts} from './improve-history.js';
import {profileFromContent,profileIdentity,type TaskProfile} from './task-profile.js';
import type {ImproveSelection} from './improve-decisions.js';
import type {ValidationGroup} from './improve-validation.js';

export type TaskType='read'|'coding';
export interface DefaultFile {targetId:string;root:string;path:string;kind:'agent-config'|'prompt-skill';content:BlobRef}
export interface DefaultSnapshot {workspace:string;taskType:TaskType;revision:string;files:DefaultFile[];profile:TaskProfile;profileId:string}
const key=(f:DefaultFile)=>JSON.stringify([f.root,f.kind,f.path]);
export function defaultSnapshot(root:string,workspace:string,taskType:TaskType,files:DefaultFile[],lookup=(ref:BlobRef)=>readObject(root,ref)):DefaultSnapshot{
 files=[...files].sort((a,b)=>key(a).localeCompare(key(b)));
 const profile=profileFromContent(files.map(f=>({...f,text:lookup(f.content).toString('utf8')})));
 return {workspace,taskType,revision:digest(JSON.stringify({workspace,taskType,files})),files,profile,profileId:profileIdentity(profile)};
}
export function readImproveDefaults(root:string,workspace:string,taskType:TaskType):DefaultSnapshot {
 let files:DefaultFile[]=[];try{for(const fact of improveFacts(root))if(fact.kind==='improve.activation')for(const value of fact.data.defaults??[])if(value.current.workspace===workspace&&value.current.taskType===taskType)files=value.current.files;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return defaultSnapshot(root,workspace,taskType,files);
}
export interface DefaultChange {previous:DefaultSnapshot;current:DefaultSnapshot}
export function plannedDefaults(root:string,selections:ImproveSelection[],group:ValidationGroup,retain?:(bytes:string)=>BlobRef):DefaultChange[]{
 const activated=selections.filter(s=>s.formal?.activate);if(!activated.length)return [];
 const workspace=activated[0].formal!.activate!.workspace,types=[...new Set(activated.flatMap(s=>s.formal!.activate!.taskTypes))];
 const added=new Map<string,Buffer>();return types.map(taskType=>{
  const previous=readImproveDefaults(root,workspace,taskType),files=new Map(previous.files.map(f=>[key(f),f]));
  for(const s of activated.filter(s=>s.formal!.activate!.taskTypes.includes(taskType))){
   if(s.formal!.activate!.baseline[taskType]!==previous.revision)throw Error('IMPROVE_DEFAULT_BASELINE_DRIFT');
   for(const c of group.changes.filter(c=>c.targetId===s.target.id)){const bytes=Buffer.from(c.content),content=retain?retain(c.content):{sha256:digest(bytes),bytes:bytes.length};added.set(content.sha256,bytes);const f:DefaultFile={targetId:c.targetId,root:s.target.workspace!,path:c.path,kind:s.target.kind as DefaultFile['kind'],content};files.set(key(f),f);}
  }
  return {previous,current:defaultSnapshot(root,workspace,taskType,[...files.values()],ref=>added.get(ref.sha256)??readObject(root,ref))};
 });
}
export function assertDefaultBaseline(root:string,changes:DefaultChange[]){for(const {previous}of changes)if(readImproveDefaults(root,previous.workspace,previous.taskType).revision!==previous.revision)throw Error('IMPROVE_DEFAULT_BASELINE_DRIFT');}
