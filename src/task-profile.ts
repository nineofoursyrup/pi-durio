import {digest} from './evidence.js';

/** Deliberately excludes model/provider/auth/tools/retry/budget/maxTokens.
 * Output limits belong to the common host grant, never candidate config. */
export interface TaskProfile {version:1;instructions:string;compaction?:{enabled?:boolean;reserveTokens?:number;keepRecentTokens?:number};stream?:{timeoutMs:number}}
export interface EffectiveTask {type:'read'|'coding';profile:TaskProfile}
export interface ProfileContent {targetId:string;path:string;kind:'agent-config'|'prompt-skill';text:string}
export function validateTaskProfile(value:TaskProfile){
 if(!value||value.version!==1||typeof value.instructions!=='string'||Buffer.byteLength(value.instructions)>262144||!Object.keys(value).every(k=>['version','instructions','compaction','stream'].includes(k)))throw Error('IMPROVE_PROFILE_INVALID');
 if(value.compaction){const c=value.compaction;if(!Object.keys(c).every(k=>['enabled','reserveTokens','keepRecentTokens'].includes(k))||c.enabled!==undefined&&typeof c.enabled!=='boolean'||[c.reserveTokens,c.keepRecentTokens].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>1048576))||c.keepRecentTokens!==undefined&&c.reserveTokens!==undefined&&c.keepRecentTokens>c.reserveTokens)throw Error('IMPROVE_PROFILE_COMPACTION_INVALID');}
 if(value.stream&&(!Object.keys(value.stream).every(k=>k==='timeoutMs')||!Number.isSafeInteger(value.stream.timeoutMs)||value.stream.timeoutMs<100||value.stream.timeoutMs>300000))throw Error('IMPROVE_PROFILE_STREAM_INVALID');
 return structuredClone(value);
}
export function profileFromContent(files:ProfileContent[]):TaskProfile {
 const profile:TaskProfile={version:1,instructions:''},instructions:string[]=[];
 for(const file of files){
  if(file.kind==='prompt-skill')instructions.push(`[${file.targetId}/${file.path}]\n${file.text}`);
  else{
   const config=JSON.parse(file.text);if(!config||typeof config!=='object'||Array.isArray(config)||!Object.keys(config).every(k=>['instructions','compaction','stream'].includes(k))||config.instructions!==undefined&&typeof config.instructions!=='string')throw Error('IMPROVE_CONFIG_SCHEMA_UNSUPPORTED');
   const checked=validateTaskProfile({version:1,instructions:config.instructions??'',...(config.compaction?{compaction:config.compaction}:{}),...(config.stream?{stream:config.stream}:{})});
   if(checked.instructions)instructions.push(`[${file.targetId}/${file.path}]\n${checked.instructions}`);
   for(const key of ['compaction','stream']as const){if(!checked[key])continue;for(const [field,value]of Object.entries(checked[key]!)){const previous=(profile as any)[key]?.[field];if(previous!==undefined&&previous!==value)throw Error('IMPROVE_CONFIG_COMBINATION_CONFLICT');((profile as any)[key]??={})[field]=value;}}
  }
 }
 profile.instructions=instructions.join('\n\n');return validateTaskProfile(profile);
}
export function profileIdentity(profile:TaskProfile){return digest(JSON.stringify(validateTaskProfile(profile)));}
export function applyTaskProfile<T extends {instructions:string;settings:{compaction:object;stream:object}}>(base:T,profile?:TaskProfile):T {
 if(!profile)return base;const p=validateTaskProfile(profile);
 return {...base,instructions:[base.instructions,p.instructions].filter(Boolean).join('\n\n'),settings:{...base.settings,compaction:{...base.settings.compaction,...p.compaction},stream:{...base.settings.stream,...p.stream}}};
}
