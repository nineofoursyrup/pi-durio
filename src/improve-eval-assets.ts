import {readObject,digest,type BlobRef} from './evidence.js';
import {validateGrader,loadEvalPlan} from './eval/plan.js';
import {regradeEval} from './eval/runner.js';
import type {EvalCase} from './eval/fixtures.js';
import {improveFacts,readImproveDecision} from './improve-history.js';
import type {ImproveCandidate} from './improve.js';
import type {ValidationGroup} from './improve-validation.js';

export type EvalAsset={schema:1;id:string;version:string;kind:'grader';value:EvalCase['grader']}|{schema:1;id:string;version:string;kind:'cases';value:EvalCase[]};
export function parseEvalAsset(bytes:Buffer|string):EvalAsset{
 const asset=JSON.parse(bytes.toString()) as EvalAsset;
 if(!asset||asset.schema!==1||!/^[-\w.]{1,80}$/.test(asset.id)||!/^[-\w.]{1,80}$/.test(asset.version)||!['grader','cases'].includes(asset.kind)||!Object.keys(asset).every(k=>['schema','id','version','kind','value'].includes(k)))throw Error('IMPROVE_EVAL_ASSET_INVALID');
 if(asset.kind==='grader'){validateGrader(asset.value);if(asset.value.version!==asset.version)throw Error('IMPROVE_GRADER_ASSET_VERSION_MISMATCH');}
 else{
  if(!Array.isArray(asset.value)||!asset.value.length||asset.value.length>16||new Set(asset.value.map(c=>c.id)).size!==asset.value.length)throw Error('IMPROVE_CASE_ASSET_INVALID');
  for(const c of asset.value){if(!/^[-\w]{1,80}$/.test(c.id)||!['local-fix','multi-file','regression','no-change'].includes(c.category)||c.visibility!=='public-development'||!c.input?.trim()||!c.dependencyLock||!c.files||Object.keys(c.files).length>24||!Array.isArray(c.writable)||!c.dirty)throw Error('IMPROVE_CASE_ASSET_INVALID');validateGrader(c.grader);for(const [path,value]of Object.entries({...c.files,...c.dirty}))if(typeof value!=='string'||!/^[-\w.]+(?:\/[-\w.]+)*$/.test(path)||path.split('/').some(p=>p==='.'||p==='..'))throw Error('IMPROVE_CASE_ASSET_INVALID');for(const path of c.writable)if(!Object.hasOwn(c.files,path))throw Error('IMPROVE_CASE_ASSET_INVALID');}
 }
 return asset;
}
export interface EvalAssetRevision {targetId:string;path:string;before:EvalAsset;after:EvalAsset;beforeContent:BlobRef;afterContent:BlobRef}
/** Revisions are independent decisions, with checks fixed before the write.
 * Cases configure future eval plans; they never relabel saved outcomes. */
export function planEvalAssets(root:string,group:ValidationGroup,candidates:ImproveCandidate[]):EvalAssetRevision[]{
 const revisions:EvalAssetRevision[]=[];
 for(const change of group.changes){const c=candidates.find(c=>c.target.id===change.targetId);if(c?.target.kind!=='eval-asset')continue;const file=c.target.files.find(f=>f.path===change.path)!;
  const oldBytes=readObject(root,file.content),newBytes=Buffer.from(change.content),before=parseEvalAsset(oldBytes),after=parseEvalAsset(newBytes);
  if(after.id!==before.id||after.kind!==before.kind||after.version===before.version)throw Error('IMPROVE_EVAL_ASSET_NEW_VERSION_REQUIRED');
  for(const fact of improveFacts(root).filter(f=>f.kind==='improve.eval-asset'))for(const old of fact.data.revisions as EvalAssetRevision[])for(const seen of [{asset:old.before,content:old.beforeContent},{asset:old.after,content:old.afterContent}])if(seen.asset.id===after.id&&seen.asset.version===after.version&&seen.content.sha256!==digest(newBytes))throw Error('IMPROVE_EVAL_ASSET_VERSION_CONTENT_CHANGED');
  revisions.push({targetId:change.targetId,path:change.path,before,after,beforeContent:file.content,afterContent:{sha256:digest(newBytes),bytes:newBytes.length}});
 }
 return revisions;
}
export function readImproveEvalAssets(root:string,id:string){return improveFacts(root).filter(f=>f.kind==='improve.eval-asset'&&f.data.id===id).map(f=>({sourceId:f.sourceId,...f.data}));}
export interface ImproveRegrade {dataRoot:string;decisionId:string;decisionSource:string;groupId:string;targetId:string;path:string;assetVersion:string;assetDigest:string;evalDataRoot:string;planId:string;revisionId:string;caseIds:string[];directory:string;signal?:AbortSignal}
/** Reuse the existing append-only grader engine for every affected saved side. */
export async function regradeImproveAsset(o:ImproveRegrade){
 const state=readImproveDecision(o.dataRoot,o.decisionId),group=state.groups.find((g:any)=>g.id===o.groupId);
 if(state.sourceId!==o.decisionSource||group?.formal?.state!=='completed')throw Error('IMPROVE_EVAL_ASSET_NOT_FORMALLY_AVAILABLE');
 const revisions=readImproveEvalAssets(o.dataRoot,o.decisionId).filter(f=>f.groupId===o.groupId).flatMap(f=>f.revisions as EvalAssetRevision[]),revision=revisions.find(r=>r.targetId===o.targetId&&r.path===o.path);
 if(!revision||revision.after.kind!=='grader'||revision.after.version!==o.assetVersion||revision.afterContent.sha256!==o.assetDigest)throw Error('IMPROVE_GRADER_REVISION_CHANGED');
 const after=parseEvalAsset(readObject(o.dataRoot,revision.afterContent));if(after.kind!=='grader')throw Error('IMPROVE_GRADER_ASSET_REQUIRED');
 const plan=loadEvalPlan(o.evalDataRoot,o.planId);if(!Array.isArray(o.caseIds)||!o.caseIds.length||new Set(o.caseIds).size!==o.caseIds.length||o.caseIds.some(id=>!plan.cases.some(c=>c.id===id)))throw Error('IMPROVE_GRADER_CASE_SCOPE_INVALID');
 // The plan must already exist: this never executes candidate inference or
 // changes cases, runtime, budgets, original outcomes, or old grade facts.
 return regradeEval({dataRoot:o.evalDataRoot,id:o.planId,directory:o.directory,revisionId:o.revisionId,signal:o.signal,graders:Object.fromEntries(o.caseIds.map(id=>[id,after.value]))});
}
