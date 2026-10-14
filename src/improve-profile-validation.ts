import {isDeepStrictEqual} from 'node:util';
import {executionConfig} from './execution-config.js';
import {applyTaskProfile,type TaskProfile} from './task-profile.js';
import {readImproveDefaults,type DefaultChange,type TaskType} from './improve-defaults.js';
import type {ValidationGroup} from './improve-validation.js';

export interface EffectiveConfig {instructions:string;settings:ReturnType<typeof executionConfig>['settings']}
export interface EffectiveProfileChange {workspace:string;taskType:TaskType;before:EffectiveConfig;after:EffectiveConfig}
function effective(taskType:TaskType,profile:TaskProfile):EffectiveConfig {
 if(!['read','coding'].includes(taskType))throw Error('IMPROVE_PROFILE_TASK_TYPE_INVALID');
 const actual=applyTaskProfile(executionConfig(taskType==='coding','offline'),profile);
 return {instructions:actual.instructions,settings:actual.settings};
}
/** Read-only authoring input. This is the currently selected actual loader
 * configuration, never inferred from a candidate file that has not been used. */
export function readImproveEffectiveConfig(root:string,workspace:string,taskType:TaskType):EffectiveConfig{return effective(taskType,readImproveDefaults(root,workspace,taskType).profile);}
export function effectiveProfileChanges(changes:DefaultChange[]):EffectiveProfileChange[]{return changes.map(change=>({workspace:change.current.workspace,taskType:change.current.taskType,before:effective(change.previous.taskType,change.previous.profile),after:effective(change.current.taskType,change.current.profile)}));}
function sameShape(value:any,actual:any):boolean {
 if(actual===null||typeof actual!=='object')return typeof value===typeof actual&&(typeof value!=='number'||Number.isFinite(value));
 if(!value||typeof value!=='object'||Array.isArray(value)!==Array.isArray(actual))return false;
 if(Array.isArray(actual))return value.length===actual.length&&actual.every((part,index)=>sameShape(value[index],part));
 return isDeepStrictEqual(Object.keys(value).sort(),Object.keys(actual).sort())&&Object.keys(actual).every(key=>sameShape(value[key],actual[key]));
}
/** A file-only check cannot stand in for changed loading behavior. Exact full
 * expectations are user plan data and execute before each selected regression. */
export function validateProfileBasis(group:ValidationGroup,profiles:EffectiveProfileChange[]){
 const basis=group.basis;if(!profiles.length){if(basis?.expectedProfiles||basis?.equivalence)throw Error('IMPROVE_PROFILE_SCOPE_REQUIRED');return;}
 if(basis?.impact==='no-behavior'){
  if(!['exact','trim-instructions-end'].includes(basis.equivalence??''))throw Error('IMPROVE_PROFILE_EQUIVALENCE_REQUIRED');
  for(const p of profiles){const before=basis.equivalence==='exact'?p.before.instructions:p.before.instructions.trimEnd(),after=basis.equivalence==='exact'?p.after.instructions:p.after.instructions.trimEnd();if(before!==after||!isDeepStrictEqual(p.before.settings,p.after.settings))throw Error('IMPROVE_PROFILE_BEHAVIOR_CHANGE: file equivalence does not prove actual activation equivalence');}
 }
 if(basis?.impact==='deterministic-fix'){
  if(!basis.expectedProfiles)throw Error('IMPROVE_PROFILE_EXPECTATIONS_REQUIRED: bind complete actual before/after instructions and settings');
  if(Buffer.byteLength(JSON.stringify(basis.expectedProfiles))>1048576||!sameShape(basis.expectedProfiles,profiles))throw Error('IMPROVE_PROFILE_EXPECTATIONS_INVALID');
 }
}
