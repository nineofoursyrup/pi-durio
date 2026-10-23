import {TASK_REQUEST_LIMIT} from './provider-boundary.js';
import {providerResponseBytes,RESPONSE_BASE_BYTES,RESPONSE_BYTES_PER_OUTPUT_TOKEN,MAX_OUTPUT_TOKENS} from './provider-response-budget.js';

// These are the existing isolation limits. This module does not enlarge them.
export const EVAL_PROTOCOL_LIMITS=Object.freeze({inputBytes:262_144,responseBytes:1_048_576,lineBytes:1_048_576,totalBytes:8_388_608});
const MEDIATOR_OVERHEAD=4096,RESPONSE_LINE_OVERHEAD=8192,DIAGNOSTIC_RESERVE=65_536;
// #124's content stream expands 1.125x / 1.367x through the two JSON layers.
// Quote/backslash/newline/tab and tool_calls fixtures measure up to 1.147x /
// 1.434x. Round up to 1.2x / 1.5x, with fixed wrapper/header headroom. Like the
// provider allowance, these cover the measured SSE profile, not arbitrary data.
// responseBytes counts the mediator string. lineBytes/totalBytes count guest
// stdout (request lines); stderr has its own independent cap. Host response lines
// go to guest stdin and are measured for memory, not charged to an unrelated cap.
// A valid JSON request can at most double under the outer JSON escaping.
const REQUEST_LINE_BYTES=2*EVAL_PROTOCOL_LIMITS.inputBytes+128;
function requests(value:number){if(!Number.isSafeInteger(value)||value<1||value>100)throw Error('INVALID_EVAL_REQUEST_LIMIT');return value;}
export function evalTrialRequests(plan:{budget:{maxRequests:number};comparison?:{trialBudget:{maxRequests:number}}}){
 return Math.min(requests(plan.budget.maxRequests),requests(plan.comparison?.trialBudget.maxRequests??TASK_REQUEST_LIMIT),TASK_REQUEST_LIMIT);
}
export function evalResponseBudget(maxOutputTokens:number,maxRequests:number){
 const responseBytes=providerResponseBytes(maxOutputTokens);
 const mediatorBytes=Math.ceil(responseBytes*6/5)+MEDIATOR_OVERHEAD;
 const responseLineBytes=Math.ceil(responseBytes*3/2)+RESPONSE_LINE_OVERHEAD;
 return {responseBytes,mediatorBytes,responseLineBytes,requestLineBytes:REQUEST_LINE_BYTES,totalBytes:DIAGNOSTIC_RESERVE+requests(maxRequests)*REQUEST_LINE_BYTES};
}
export function maxEvalOutputTokens(maxRequests:number){
 if(DIAGNOSTIC_RESERVE+requests(maxRequests)*REQUEST_LINE_BYTES>EVAL_PROTOCOL_LIMITS.totalBytes)return 0;
 const responseBytes=(EVAL_PROTOCOL_LIMITS.responseBytes-MEDIATOR_OVERHEAD)*5/6;
 return Math.max(0,Math.min(MAX_OUTPUT_TOKENS,Math.floor((responseBytes-RESPONSE_BASE_BYTES)/RESPONSE_BYTES_PER_OUTPUT_TOKEN)));
}
export function validateEvalResponseBudget(maxOutputTokens:number,maxRequests:number){
 const budget=evalResponseBudget(maxOutputTokens,maxRequests);
 if(budget.mediatorBytes>EVAL_PROTOCOL_LIMITS.responseBytes||budget.requestLineBytes>EVAL_PROTOCOL_LIMITS.lineBytes||budget.totalBytes>EVAL_PROTOCOL_LIMITS.totalBytes)throw Error(`EVAL_PROTOCOL_CAPACITY: ${maxRequests} requests allow at most ${maxEvalOutputTokens(maxRequests)} output tokens per request`);
 return budget;
}
