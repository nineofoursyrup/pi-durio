import type {EvalPlan,EvalTrial} from './plan.js';
import {PersistentBudget,dispatchProvider,type RequestPurpose} from '../provider-boundary.js';
import {readObject} from '../evidence.js';
/** Guest JSON cannot choose a provider, URL, key, purpose, attempt identity or settle usage. */
export function evalMediator(plan:EvalPlan,trial:EvalTrial,budget:PersistentBudget,transport?:typeof fetch,assertHeld:()=>void=()=>{}){
 if(plan.mode==='live'&&transport)throw Error('LIVE_TRANSPORT_OVERRIDE_DENIED');
 if(plan.mode==='offline'&&!transport)throw Error('OFFLINE_TRANSPORT_REQUIRED');
 let dispatch=0,lastError:string|null=null;
 return {get lastError(){return lastError;},maxRequests:100,maxOutputTokens:plan.maxOutputTokens,
  async request({input,maxOutputTokens,signal}:{input:string;maxOutputTokens:number;signal:AbortSignal}){
   try{
    assertHeld();
    if(plan.comparison){
      // Reuse the one host ledger. This limit is per independent trial, so a noisy
      // first side cannot spend the second side's pre-authorized allowance.
      const facts=budget.evidence.db.prepare("SELECT kind,body FROM records WHERE run_id=? AND kind IN ('budget.reserve','budget.settle') ORDER BY seq").all(budget.evidence.runId).map(row=>({kind:String(row.kind),...JSON.parse(readObject(budget.evidence.root,JSON.parse(String(row.body))).toString())}));
      const reservations=facts.filter(f=>f.kind==='budget.reserve'&&f.budgetId===budget.id&&f.operationId===trial.id);
      if(reservations.length>=plan.comparison.trialBudget.maxRequests)throw Error('BUDGET_TRIAL_REQUEST_LIMIT');
      const spent=reservations.reduce((sum,reservation)=>sum+(facts.find(f=>f.kind==='budget.settle'&&f.id===reservation.id)?.tokens??plan.budget.unknownUpperBound?.tokens??reservation.tokens),0);
      if(spent+(plan.budget.unknownUpperBound?.tokens??plan.budget.maxRequestTokens)>plan.comparison.trialBudget.maxTokens)throw Error('BUDGET_TRIAL_TOKEN_LIMIT');
    }
    if(plan.mode==='live'){
      const upper=1_048_576+plan.maxOutputTokens;
      if(!plan.budget.unknownUpperBound||plan.budget.unknownUpperBound.tokens<upper||plan.budget.maxRequestTokens<upper||!plan.budget.unknownUpperBound.source.startsWith('https://api-docs.deepseek.com/'))throw Error('EVAL_UNPROVEN_PROVIDER_TOKEN_BOUND');
    }
    if(Buffer.byteLength(input)>262144||maxOutputTokens!==plan.maxOutputTokens)throw Error('EVAL_MEDIATOR_LIMIT');
    const payload=JSON.parse(input);validatePayload(payload,plan);
    // Purpose is a trusted phase. Guest metadata never grants extra scope/budget.
    // Any upstream compaction uses exactly the same authorization and reserve gate.
    const purpose:RequestPurpose='eval-runtime';
    const response=await dispatchProvider({budget,purpose,operationId:trial.id,transport,maxResponseBytes:786432,onDispatch:id=>{dispatch++;budget.evidence.append('eval.provider-link',{trialId:trial.id,guestDispatchOrdinal:dispatch,hostDispatchId:id,claimedPurpose:'untrusted; see fixed guest runtime intent for diagnostics'});}},plan.model.endpoint,{method:'POST',body:JSON.stringify(payload),signal,headers:{'content-type':'application/json',...(plan.mode==='live'?{authorization:`Bearer ${process.env.DEEPSEEK_API_KEY??''}`}:{})}});
    const body=await response.text();if(!response.ok)lastError=`PROVIDER_HTTP_${response.status}`;return JSON.stringify({status:response.status,contentType:response.headers.get('content-type')??'text/event-stream',body});
   }catch(error){lastError=String(error);throw error;}
  }
 };
}
function validatePayload(value:any,plan:EvalPlan){
 const allowed=new Set(['model','messages','tools','tool_choice','stream','stream_options','max_tokens','temperature','top_p','frequency_penalty','presence_penalty','reasoning_effort','thinking']);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.has(key))||value.model!=='deepseek-flash'||value.stream!==true||value.max_tokens!==plan.maxOutputTokens||!Array.isArray(value.messages)||value.messages.length<1||value.messages.length>500)throw Error('EVAL_MEDIATOR_PAYLOAD_DENIED');
 let nodes=0;const check=(object:any,depth:number)=>{if(depth>20||++nodes>20000)throw Error('EVAL_MEDIATOR_STRUCTURE_LIMIT');if(object&&typeof object==='object')for(const child of Object.values(object))check(child,depth+1);};check(value,0);
 for(const message of value.messages){if(!message||!['system','developer','user','assistant','tool'].includes(message.role)||Object.keys(message).some(key=>!['role','content','tool_calls','tool_call_id','name','reasoning_content'].includes(key)))throw Error('EVAL_MEDIATOR_MESSAGE_DENIED');}
 for(const message of value.messages){if(message.content!==null&&message.content!==undefined&&typeof message.content!=='string'&&(!Array.isArray(message.content)||message.content.some((part:any)=>!part||part.type!=='text'||typeof part.text!=='string'||Object.keys(part).some(key=>!['type','text'].includes(key)))))throw Error('EVAL_MEDIATOR_CONTENT_DENIED');}
 if(value.tools&&(!Array.isArray(value.tools)||value.tools.length>4||value.tools.some((tool:any)=>tool.type!=='function'||!['read','write','edit','bash'].includes(tool.function?.name))))throw Error('EVAL_MEDIATOR_TOOLS_DENIED');
}
