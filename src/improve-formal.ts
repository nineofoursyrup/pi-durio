import {planEvalAssets} from './improve-eval-assets.js';
import {openSync,closeSync,fstatSync,lstatSync,realpathSync,readFileSync,writeSync,ftruncateSync,fsyncSync,constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {Evidence,digest,readObject,type BlobRef} from './evidence.js';
import type {ImproveCandidate} from './improve.js';
import type {ImproveSelection} from './improve-decisions.js';
import type {ValidationGroup} from './improve-validation.js';
import {sourceBytes} from './improve-source.js';
import {setWorkspaceFence,clearWorkspaceFence,assertWorkspaceUnfenced,type WorkspaceFence} from './workspace-fence.js';
import {assertDefaultBaseline,validateDefaultScope,type DefaultChange,type DefaultScope} from './improve-defaults.js';
import {planBuildDefault,assertBuildDefault} from './improve-process.js';
import {verifyImproveBuild,verifyBuildSource} from './improve-build.js';

export interface FormalSelection {writeback:true;activate:null|DefaultScope;failureCompensation:'none';newProcess?:{workspace:string;baseline:string}}
export interface PathIdentity {path:string;dev:number;ino:number;mode:number}
export function fileIdentity(root:string,path:string):PathIdentity[]{
 const parts=[root];let part=root;for(const segment of path.split('/')){part=join(part,segment);parts.push(part);}
 return parts.map((path,i)=>{const s=lstatSync(path);if(s.isSymbolicLink()||realpathSync(path)!==path||(i===parts.length-1?!s.isFile()||s.nlink!==1:!s.isDirectory()))throw Error('IMPROVE_TARGET_IDENTITY_DENIED');return {path,dev:s.dev,ino:s.ino,mode:s.mode};});
}
export function assertFileIdentity(expected:PathIdentity[]){for(const p of expected){const s=lstatSync(p.path);if(s.dev!==p.dev||s.ino!==p.ino||s.mode!==p.mode||s.isSymbolicLink()||realpathSync(p.path)!==p.path||s.isFile()&&s.nlink!==1)throw Error(`IMPROVE_TARGET_IDENTITY_DRIFT: ${p.path}`);}}
export function replaceExact(root:string,path:string,before:Buffer,after:Buffer,identity:PathIdentity[]){
 assertFileIdentity(identity);if(!sourceBytes(root,path).equals(before))throw Error(`IMPROVE_BASELINE_DRIFT: ${path}; current user content preserved`);
 const absolute=join(root,path),fd=openSync(absolute,constants.O_RDWR|constants.O_NOFOLLOW);
 try{
  const s=fstatSync(fd),last=identity.at(-1)!;
  if(s.dev!==last.dev||s.ino!==last.ino||s.nlink!==1||!readFileSync(fd).equals(before))throw Error('IMPROVE_BASELINE_DRIFT');
  assertFileIdentity(identity);
  // Descriptor-bound write never follows a replaced symlink or overwrites a
  // replacement inode. External same-inode races cannot be made transactional;
  // a failed readback stays unknown and retains the fence.
  let offset=0;while(offset<after.length)offset+=writeSync(fd,after,offset,after.length-offset,offset);ftruncateSync(fd,after.length);fsyncSync(fd);
  assertFileIdentity(identity);if(!sourceBytes(root,path).equals(after))throw Error('IMPROVE_WRITEBACK_READBACK_UNKNOWN');
 }finally{closeSync(fd);}
}
export function validateFormalSelection(selection:ImproveSelection,candidate:ImproveCandidate,workspace:string){
 const f=selection.formal;
 if(selection.mode!=='execute-declared-scope'){if(f!==undefined)throw Error('IMPROVE_FORMAL_AUTHORITY_REQUIRES_EXECUTE');return;}
 if(!f||f.writeback!==true||f.failureCompensation!=='none'||!Object.keys(f).every(k=>['writeback','activate','failureCompensation','newProcess'].includes(k))||f.activate===undefined||!candidate.activation.writeback)throw Error('IMPROVE_FORMAL_AUTHORITY_REQUIRED');
 if(f.newProcess&&(!candidate.activation.enable||candidate.target.kind!=='self-source'||f.newProcess.workspace!==workspace||typeof f.newProcess.baseline!=='string'||!Object.keys(f.newProcess).every(k=>['workspace','baseline'].includes(k))))throw Error('IMPROVE_NEW_PROCESS_SCOPE_DENIED');
 if(f.activate!==null){if(!candidate.activation.enable||!['agent-config','prompt-skill'].includes(candidate.target.kind))throw Error('IMPROVE_ACTIVATION_SCOPE_DENIED');validateDefaultScope(f.activate,workspace);}
}
export function captureGroupIdentities(candidates:ImproveCandidate[]){return candidates.flatMap(c=>c.target.files.map(f=>({targetId:c.target.id,path:f.path,identity:fileIdentity(c.target.workspace!,f.path)})));}
export interface FormalFile {targetId:string;root:string;path:string;before:BlobRef;after:BlobRef;identity:PathIdentity[]}
export async function applyImproveGroup(o:{evidence:Evidence;decisionId:string;decisionSource:string;group:ValidationGroup;candidates:ImproveCandidate[];selections:ImproveSelection[];result:any;identities:ReturnType<typeof captureGroupIdentities>;defaults:DefaultChange[];ownerRoots:string[];record:(kind:string,data:any)=>string;guard:()=>void;baseline:()=>void;signal?:AbortSignal}){
 const {evidence:e,group,record,guard,result}=o;
 if(!o.selections.some(s=>s.mode==='execute-declared-scope'))return {state:'not-selected'};
 const performance=o.candidates.some(c=>c.objective==='performance');
 if(!result.conclusion?.allChecksPassed||!result.conclusion?.allRequiredBenefitsMet||performance&&!(result.conclusion?.requiredBenefitCount>0)){record('improve.formal',{groupId:group.id,state:'blocked',reason:'Required benefits or necessary checks/protections are not all satisfied',writeback:'not-written',activation:'not-enabled'});return {state:'blocked',reason:'IMPROVE_ACTIVATION_CONDITIONS_NOT_MET'};}
 const files:FormalFile[]=group.changes.map(change=>{const c=o.candidates.find(c=>c.target.id===change.targetId)!,retained=result.construction.files.find((f:any)=>f.path===`${change.targetId}/${change.path}`);if(!retained||!readObject(e.root,retained.after).equals(Buffer.from(change.content)))throw Error('IMPROVE_VALIDATED_CONTENT_MISMATCH');return {targetId:change.targetId,root:c.target.workspace!,path:change.path,before:retained.before,after:retained.after,identity:o.identities.find(i=>i.targetId===change.targetId&&i.path===change.path)!.identity};});
 const assetRevisions=planEvalAssets(e.root,group,o.candidates);
 const buildChange=planBuildDefault(e.root,o.decisionId,group.id,o.selections,result.build);
 if(result.build){verifyImproveBuild(e.root,result.build.baseline);verifyImproveBuild(e.root,result.build.candidate);}
 guard();o.baseline();assertDefaultBaseline(e.root,o.defaults);for(const entry of o.identities)assertFileIdentity(entry.identity);for(const root of o.ownerRoots)assertWorkspaceUnfenced(root);
 if(buildChange)assertBuildDefault(e.root,buildChange);
 const fences=o.ownerRoots.map(workspace=>({dataRoot:e.root,decisionId:o.decisionId,decisionSource:o.decisionSource,groupId:group.id,workspace}));
 record('improve.formal-started',{groupId:group.id,files,fences,defaults:o.defaults,buildChange,scope:'Exact validated bytes only; no Git, external commands or install/release effects'});
 for(const fence of fences)setWorkspaceFence(fence);
 let written=0;
 try{
  for(const [index,file]of files.entries()){
   guard();if(o.signal?.aborted)throw Error('IMPROVE_CANCELLED_BEFORE_WRITE');
   record('improve.write-intent',{groupId:group.id,index,file});
   guard();const before=readObject(e.root,file.before),after=readObject(e.root,file.after);replaceExact(file.root,file.path,before,after,file.identity);written++;
   record('improve.write-result',{groupId:group.id,index,state:'written',file,unchanged:before.equals(after)});
  }
  // Recheck every actual formal byte before activating the whole combination.
  guard();for(const file of files){assertFileIdentity(file.identity);if(!sourceBytes(file.root,file.path).equals(readObject(e.root,file.after)))throw Error('IMPROVE_POST_WRITE_DRIFT');}
  const activations=o.selections.filter(s=>s.formal?.activate).map(s=>({candidateId:s.candidateId,target:s.target,scope:s.formal!.activate!,files:files.filter(f=>f.targetId===s.target.id)}));
  if(activations.length){assertDefaultBaseline(e.root,o.defaults);record('improve.activation',{groupId:group.id,state:'new-default',activations,defaults:o.defaults,timing:'subsequent new tasks only; old pending keeps original configuration'});}
  if(result.build){verifyBuildSource(e.root,result.build,'candidate');verifyImproveBuild(e.root,result.build.candidate);}
  if(buildChange){assertBuildDefault(e.root,buildChange);record('improve.build-activation',{groupId:group.id,state:'new-process-entry',change:buildChange,timing:'Future explicit new process only; current process and pending execution unchanged'});}
  if(assetRevisions.length)record('improve.eval-asset',{groupId:group.id,revisions:assetRevisions,scope:'Independent asset revision; prior conclusions retained. Cases apply only to future explicit plans; grader regrade requires a separate saved-outcome request.'});
  record('improve.formal',{groupId:group.id,state:'completed',writeback:'written',activation:buildChange?'new-process-entry':activations.length?'new-default':'not-enabled',files});
  for(const fence of fences)clearWorkspaceFence(fence);return {state:'completed'};
 }catch(error){
  // The intent/result distinction survives even if this terminal record fails.
  try{record('improve.formal',{groupId:group.id,state:'frozen',reason:String(error),writeback:written?'partial-or-unknown':'not-written-or-unknown',activation:'not-enabled',written,files});}catch{}
  throw error;
 }
}
