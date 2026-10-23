// Shared by the isolated guest entry and offline integration checks. No host
// plans, credentials, answers or graders belong in the mounted product runtime.
import {runCodingTask,runReadTask} from './runtime.js';
import type {EffectiveTask} from './task-profile.js';

export interface EvalGuestInput {
 trialId:string;mode:'live'|'offline';prompt:string;maxOutputTokens:number;
 effectiveTask?:EffectiveTask;verificationCompaction?:{reserveTokens:number;keepRecentTokens:number};originalFailure?:boolean;
}
// Preserve the SDK's effective output limit through the JSON bridge. Guest
// metadata can only reduce the trusted plan cap, never increase it.
export function evalGuestRequest(body:RequestInit['body'],planMaxOutputTokens:number){
 if(typeof body!=='string')throw Error('EVAL_EXPECTED_JSON_PAYLOAD');
 const maxOutputTokens:unknown=JSON.parse(body)?.max_tokens;
 if(typeof maxOutputTokens!=='number'||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>planMaxOutputTokens)throw Error('EVAL_GUEST_OUTPUT_LIMIT');
 return {input:body,maxOutputTokens};
}
export function runEvalGuest(input:EvalGuestInput,transport:typeof fetch,paths:{dataRoot:string;workspace:string}){
 return (input.effectiveTask?.type==='read'?runReadTask:runCodingTask)({
  ...paths,input:input.prompt,mode:input.mode,taskOrigin:{kind:'eval',source:'eval',trialId:input.trialId},
  ...(input.effectiveTask?{verificationProfile:input.effectiveTask.profile}:{}),
  ...(input.mode==='offline'?{transport}:{}),
  providerBoundary:{purpose:'generation',operationId:input.trialId,transport,maxOutputTokens:input.maxOutputTokens},
  ...(input.verificationCompaction?{verificationCompaction:input.verificationCompaction}:{}),
  ...(input.originalFailure?{fault:(kind:string)=>{if(kind==='model.provider-event')throw Error('CONTROLLED_ORIGINAL_WRITE_FAILURE');}}:{})
 });
}
