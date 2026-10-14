/** Host price table and query-time request cost estimates (#51 费用估算).
 * The single source for every displayed amount: estimates are computed from
 * reported usage when read and never appended as records. */
import {decode,records,resolveEvidence,type EvidenceReference} from './history.js';

export type PricePeriod='peak'|'off-peak';
export type UsageCategory='input'|'cacheRead'|'cacheWrite'|'output';
export type UnitPrices=Record<UsageCategory,number>;

/** Version 1: DeepSeek official CNY prices, consulted 2026-10-12. Units are CNY per million tokens. */
export const HOST_PRICE_TABLE={
 version:'deepseek-cny-v1',
 currency:'CNY',
 source:'DeepSeek 官方中文价格页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
 consultedAt:'2026-10-12',
 timezone:'Asia/Shanghai (UTC+8)',
 periods:'高峰：北京时间周一至周五 9:00–12:00、14:00–18:00；其余时间为空闲。',
 note:'未对中国法定节假日建模：节假日按普通工作日或周末规则判定时段。缓存写入不单独计费，按 0 计价。',
 models:{
  'deepseek/deepseek-flash':{
   name:'DeepSeek-V4.1-Flash',
   peak:{input:2,cacheRead:0.04,cacheWrite:0,output:8},
   'off-peak':{input:1,cacheRead:0.02,cacheWrite:0,output:4},
  },
 } as Record<string,{name:string}&Record<PricePeriod,UnitPrices>>,
} as const;

export const PERIOD_LABEL:Record<PricePeriod,string>={peak:'高峰','off-peak':'空闲'};
export const COST_ESTIMATE_NOTICE='估算 · 非账单';
export const PRICE_UNCOVERED='价目未覆盖';
export const PRICE_EFFECTIVE_UNPROVEN='价目在请求时的生效情况无法证明';
export const USAGE_MISSING='用量未知';

/** Beijing-time period of an instant. Statutory holidays are not modelled. */
export function pricePeriod(at:string|number|Date):PricePeriod{
 const ms=new Date(at).getTime();if(!Number.isFinite(ms))throw Error('PRICE_PERIOD_TIME_REQUIRED');
 const beijing=new Date(ms+8*3600_000),day=beijing.getUTCDay(),minute=beijing.getUTCHours()*60+beijing.getUTCMinutes();
 return day>=1&&day<=5&&(minute>=540&&minute<720||minute>=840&&minute<1080)?'peak':'off-peak';
}

export interface CostPrice {source:string;version:string;consultedAt:string;note:string;currency:'CNY';period:PricePeriod;provider:string;model:string;perMillion:UnitPrices}
export interface RequestCostEstimate {state:'complete'|'partial'|'unknown';currency:'CNY'|null;amount:number|null;gaps:string[];at:string;period:PricePeriod;price:CostPrice|null}

/** Gap for a host-derived price at `at`: the table cannot prove it was effective before its consulted date. */
export function consultedDateGap(at:string,consultedAt:string=HOST_PRICE_TABLE.consultedAt){
 return Date.parse(at)<Date.parse(`${consultedAt}T00:00:00+08:00`)?PRICE_EFFECTIVE_UNPROVEN:null;
}

/** Price one model request from the host table. `usage` must be reported pi-ai usage (all four categories);
 * anything else is unknown, never zero. Callers reading records use `estimateModelRequests`, which applies the usage gate. */
export function estimateRequestCost(request:{provider?:string|null;model?:string|null;usage:unknown;at:string}):RequestCostEstimate{
 const period=pricePeriod(request.at),key=`${request.provider}/${request.model}`,unit=HOST_PRICE_TABLE.models[key]?.[period];
 const result:RequestCostEstimate={state:'unknown',currency:null,amount:null,gaps:[],at:request.at,period,price:null};
 if(!unit){result.gaps.push(PRICE_UNCOVERED);return result;}
 result.price={source:HOST_PRICE_TABLE.source,version:HOST_PRICE_TABLE.version,consultedAt:HOST_PRICE_TABLE.consultedAt,note:HOST_PRICE_TABLE.note,currency:'CNY',period,provider:request.provider!,model:request.model!,perMillion:{...unit}};
 const usage=request.usage as Record<string,unknown>|null|undefined,categories=['input','cacheRead','cacheWrite','output'] as const;
 if(!usage||typeof usage!=='object'||!categories.every(c=>typeof usage[c]==='number'&&Number.isFinite(usage[c])&&(usage[c] as number)>=0)){result.gaps.push(USAGE_MISSING);return result;}
 const gap=consultedDateGap(request.at);if(gap)result.gaps.push(gap);
 result.amount=categories.reduce((sum,c)=>sum+(usage[c] as number)*unit[c]/1e6,0);result.currency='CNY';result.state=result.gaps.length?'partial':'complete';return result;
}

export interface RequestFact {ref:EvidenceReference;data:any}
/** One model request (one `model.intent`) with its displayed estimate. Full identities only; display numbers belong to callers. */
export interface ModelRequestCost {source:string;attemptId:string;runId:string;provider:string|null;model:string|null;at:string;period:PricePeriod;dispatchSources:string[];usageSources:string[];usage:Record<string,unknown>|null;state:'complete'|'partial'|'unknown'|'not-applicable';currency:string|null;amount:number|null;gaps:string[];price:any;history:any[]}
export const USAGE_MISSING_GAP='usage missing or request in flight';
export const USAGE_INCOMPLETE={
 response:'usage incomplete: response ended with error or abort',
 shared:'multiple observable requests share one model response; per-request usage incomplete',
 conflicting:'conflicting usage for one model request identity',
 cacheHit:'usage incomplete: provider did not report cache-hit tokens',
} as const;
const cacheHitReported=(raw:any)=>typeof raw.prompt_cache_hit_tokens==='number'||typeof raw.prompt_tokens_details?.cached_tokens==='number'||typeof raw.cached_tokens==='number'||typeof raw.cache_read_input_tokens==='number';

/** The single selection used by every cost display (cost report, TUI, exit summary, trace, usage/show):
 * - time: first transport entry, else the intent time;
 * - usage: only from the last `model.response` with `usage:'reported'` (unreported usage is normalized zeros, never used);
 * - incomplete usage (partial): response completeness partial (error/abort), several transport entries for one response,
 *   conflicting usage, or a raw provider usage report without cache-hit tokens;
 * - amount: active explicit `cost.estimate` revision, else the host price table, else none;
 * - host-proven non-dispatch is not-applicable.
 * `facts` are one run's decoded records through some sequence; raw provider events are read here when absent from `facts`. */
export function estimateModelRequests(root:string,facts:readonly RequestFact[]):ModelRequestCost[]{
 const intents=facts.filter(f=>f.ref.kind==='model.intent');if(!intents.length)return[];
 const through=Math.max(...facts.map(f=>f.ref.seq)),runId=intents[0].ref.runId,cacheHit=new Map<string,boolean>();
 const events=facts.some(f=>f.ref.kind==='model.provider-event')?facts.filter(f=>f.ref.kind==='model.provider-event'):[...records(root,{runId,through,kinds:['model.provider-event']})].flatMap(ref=>{try{return[{ref,data:decode(root,ref)}];}catch{return[];}});
 for(const e of events){const raw=e.data.event?.usage;if(raw&&typeof raw==='object')cacheHit.set(e.data.attemptId,cacheHitReported(raw));}
 return intents.map(intent=>{
  const d=intent.data,same=(f:RequestFact)=>f.data.attemptId===d.attemptId;
  const dispatches=facts.filter(f=>f.ref.kind==='model.dispatch'&&same(f)&&f.data.transportEntered===true),responses=facts.filter(f=>f.ref.kind==='model.response'&&same(f)),response=responses.at(-1);
  const reported=response?.data.usage==='reported',at=dispatches[0]?.ref.at??intent.ref.at;
  const request:ModelRequestCost={source:intent.ref.id,attemptId:d.attemptId,runId:intent.ref.runId,provider:d.model?.provider??null,model:d.model?.id??null,at,period:pricePeriod(at),dispatchSources:dispatches.map(f=>f.ref.id),usageSources:response?[response.ref.id]:[],usage:reported?response.data.message?.usage??null:null,state:'unknown',currency:null,amount:null,gaps:[],price:null,history:[]};
  if(!dispatches.length&&facts.some(f=>f.ref.kind==='model.dispatch-failed'&&same(f)&&f.data.dispatched===false&&f.data.attemptDispatched===false)){request.state='not-applicable';return request;}
  if(!dispatches.length)request.gaps.push('transport entry not proven');
  if(dispatches.length>1)request.gaps.push(USAGE_INCOMPLETE.shared);
  if(responses.length>1&&new Set(responses.map(r=>JSON.stringify(r.data.message?.usage))).size>1)request.gaps.push(USAGE_INCOMPLETE.conflicting);
  if(!reported)request.gaps.push(USAGE_MISSING_GAP);
  else{if(response.data.completeness==='partial')request.gaps.push(USAGE_INCOMPLETE.response);if(cacheHit.get(d.attemptId)===false)request.gaps.push(USAGE_INCOMPLETE.cacheHit);}
  // The first version's pi-ai USD estimate stays in history only; it is never the displayed amount.
  const original=response?.data.message?.usage?.cost?.total;
  if(reported&&typeof original==='number'&&Number.isFinite(original)&&original>=0)request.history.push({source:response.ref.id,amount:original,currency:'USD',price:{source:'@earendil-works/pi-ai@1.1.0 model price catalog',version:'1.1.0',effectiveAt:null,observedAt:response.ref.at,provider:request.provider,model:request.model,currency:'USD'},role:'original estimate; not the displayed amount'});
  const host=estimateRequestCost({provider:request.provider,model:request.model,usage:request.usage,at});
  request.price=host.price;request.amount=host.amount;request.currency=host.currency;request.gaps.push(...host.gaps.filter(g=>g!==USAGE_MISSING||reported));
  applyRevisions(root,request,facts);return request;
 });
}

/** Estimate every model request of one run through `through` (default: all committed records). */
export function estimateRunRequests(root:string,runId:string,options:{through?:number}={}){
 const facts=[...records(root,{runId,through:options.through,kinds:['model.intent','model.dispatch','model.dispatch-failed','model.response','model.provider-event','cost.estimate']})].map(ref=>({ref,data:decode(root,ref)}));
 const requests=estimateModelRequests(root,facts);return{requests,totals:sumCostEstimates(requests)};
}

/** Explicit sourced `cost.estimate` revisions win over the host price; superseded revisions stay in history and
 * several active revisions are a conflict (unknown). Shared by every cost path. */
export function applyRevisions(root:string,request:{source:string;at:string;amount:number|null;currency:string|null;price:any;gaps:string[];history:any[];state:string},facts:readonly RequestFact[]){
 const revisions=facts.filter(f=>f.ref.kind==='cost.estimate'&&f.data.requestSource===request.source);
 request.history.push(...revisions.map(f=>({source:f.ref.id,...f.data})));const superseded=new Set(revisions.map(f=>f.data.revisionOf));const active=revisions.filter(f=>!superseded.has(f.data.id));
 if(active.length>1){request.gaps.push('conflicting estimate revisions');request.amount=null;request.currency=null;}
 if(active.length===1){const f=active[0],amountValid=typeof f.data.amount==='number'&&Number.isFinite(f.data.amount)&&f.data.amount>=0;let valid=f.data.method==='explicit-sourced-estimate-v1'&&amountValid&&typeof f.data.currency==='string'&&!!f.data.price?.source&&!!f.data.price?.version&&!!f.data.price?.provider&&!!f.data.price?.model&&Number.isFinite(Date.parse(f.data.price?.effectiveAt))&&Date.parse(f.data.price.effectiveAt)<=Date.parse(request.at)&&Array.isArray(f.data.usageSources)&&f.data.usageSources.length>0;for(const id of f.data.usageSources??[])try{decode(root,resolveEvidence(root,id));}catch{valid=false;}
  if(valid){request.amount=f.data.amount;request.currency=f.data.currency;request.price={...f.data.price,currency:f.data.currency,observedAt:f.ref.at};request.gaps=request.gaps.filter(g=>!['original catalog effective time is unavailable','price unavailable',PRICE_UNCOVERED,PRICE_EFFECTIVE_UNPROVEN].includes(g));}else request.gaps.push('estimate metadata or usage source unavailable');
 }
 // Missing usage with a known price is not a missing price.
 if(request.amount===null&&!request.price&&!request.gaps.includes('price unavailable')&&!request.gaps.includes(PRICE_UNCOVERED))request.gaps.push('price unavailable');request.state=request.gaps.length?(request.amount===null?'unknown':'partial'):'complete';
}

/** Fixed plan price from the host table: the peak output price as a uniform upper-bound unit price. */
export function hostPlanPrice(provider:string,model:string){
 const prices=HOST_PRICE_TABLE.models[`${provider}/${model}`];
 return prices?{version:HOST_PRICE_TABLE.version,source:HOST_PRICE_TABLE.source,consultedAt:HOST_PRICE_TABLE.consultedAt,currency:'CNY' as const,perMillionTokens:prices.peak.output}:null;
}

/** Amount for a token upper bound, always at the peak output price; null when the table does not cover the model. */
export function upperBoundAmount(tokens:number,provider:string,model:string){
 const price=hostPlanPrice(provider,model);return price?{amount:tokens*price.perMillionTokens/1e6,currency:price.currency,version:price.version}:null;
}

export interface CostTotals {amounts:Record<string,number>;unknownRequests:number;partial:boolean}
/** Sum per currency without conversion; unknown amounts are counted, never added as zero. */
export function sumCostEstimates(items:readonly {currency:string|null;amount:number|null;state:string}[],options:{partial?:boolean}={}):CostTotals{
 const totals:CostTotals={amounts:{},unknownRequests:0,partial:!!options.partial};
 for(const item of items){
  if(item.state==='not-applicable')continue;
  if(item.amount===null||!item.currency){totals.unknownRequests++;continue;}
  totals.amounts[item.currency]=(totals.amounts[item.currency]??0)+item.amount;
  if(item.state==='partial')totals.partial=true;
 }
 return totals;
}

const symbols:Record<string,string>={CNY:'¥',USD:'$'};
/** "≈ ¥0.06"; non-zero below 0.01 is "< ¥0.01", never 0. */
export function formatAmount(amount:number,currency:string){
 const symbol=symbols[currency]??`${currency} `;
 return amount>0&&amount<0.01?`< ${symbol}0.01`:`≈ ${symbol}${amount.toFixed(2)}`;
}

/** "≈ ¥0.06 · ≈ $0.10 +2 unknown partial". CNY first, other currencies after, never converted.
 * Nothing known: "+N unknown"; no requests at all: "≈ ¥0.00"; only scope gaps: "unknown". */
export function formatCostTotals(totals:CostTotals){
 const currencies=Object.keys(totals.amounts).sort((a,b)=>Number(b==='CNY')-Number(a==='CNY')||a.localeCompare(b));
 const known=currencies.map(c=>formatAmount(totals.amounts[c],c)).join(' · ');
 if(!known&&!totals.unknownRequests)return totals.partial?'unknown':formatAmount(0,HOST_PRICE_TABLE.currency);
 return [known,totals.unknownRequests?`+${totals.unknownRequests} unknown`:'',totals.partial?'partial':''].filter(Boolean).join(' ');
}

/** Runs accepted into any of `sessionIds`. Recovery and maintenance reuse the accepted run, so these are all runs of the sessions. */
export function sessionRunIds(root:string,sessionIds:readonly string[],options:{through?:number}={}){
 const sessions=new Set(sessionIds),runIds=new Set<string>();
 for(const ref of records(root,{through:options.through,kinds:['task.accepted']}))if(sessions.has(decode(root,ref).sessionId))runIds.add(ref.runId);
 return [...runIds];
}

/** Every model request of every run in the sessions: the exit summary's "本次会话". */
export function estimateSessionRequests(root:string,sessionIds:readonly string[],options:{through?:number}={}){
 const runIds=sessionRunIds(root,sessionIds,options),requests=runIds.flatMap(runId=>estimateRunRequests(root,runId,options).requests);
 return {runIds,requests,totals:sumCostEstimates(requests)};
}

/** Human-facing request estimate for trace/usage: display amount plus price version, period and consulted date. */
export function requestCostView(request:ModelRequestCost|undefined){
 if(!request)return null;
 const display=request.state==='not-applicable'?'not applicable':request.amount===null||!request.currency?'unknown':`${formatAmount(request.amount,request.currency)}${request.state==='partial'?' partial':''}`;
 return {display,state:request.state,currency:request.currency,amount:request.amount,gaps:request.gaps,price:{version:request.price?.version??null,period:PERIOD_LABEL[request.period],consultedAt:request.price?.consultedAt??null,...(request.price?.effectiveAt?{effectiveAt:request.price.effectiveAt}:{})}};
}

/** Human-facing totals: display string and the "估算 · 非账单" notice beside the per-currency sums. */
export function costTotalsView(totals:CostTotals){return {display:formatCostTotals(totals),notice:COST_ESTIMATE_NOTICE,...totals};}

/** Trace page plus each model item's estimate and the whole run's totals at the page snapshot. */
export function withTraceCosts<T extends {runId:string;snapshot:number;items:{kind:string;source:{id:string}}[]}>(root:string,page:T){
 const scope=`run:${page.runId}`;let cost;
 // Trace keeps reading around unreadable records; an unreadable cost source leaves the amount unknown instead.
 try{cost=estimateRunRequests(root,page.runId,{through:page.snapshot});}catch(error){return {...page,costEstimate:{scope,display:'unknown',notice:COST_ESTIMATE_NOTICE,error:String(error)}};}
 return {...page,items:page.items.map(item=>item.kind==='model'?{...item,cost:requestCostView(cost.requests.find(r=>r.source===item.source.id))}:item),costEstimate:{scope,...costTotalsView(cost.totals)}};
}

/** Usage projection plus each request allocation's estimate; the totals cover exactly the projection's `runIds`.
 * Allocations of other runs in the same sessions keep their own request estimate but are not added to the totals. */
export function withUsageCosts<T extends {runIds:string[];through:number;requestAllocations:{source:string;runId:string}[]}>(root:string,usage:T){
 const scope=`runs:${usage.runIds.join(',')}`;let requests:ModelRequestCost[],totals:CostTotals;
 // Usage keeps unreadable records as gaps; an unreadable cost source leaves the amount unknown instead.
 try{
  const byRun=new Map([...new Set([...usage.runIds,...usage.requestAllocations.map(item=>item.runId)])].map(runId=>[runId,estimateRunRequests(root,runId,{through:usage.through}).requests]));
  requests=[...byRun.values()].flat();totals=sumCostEstimates(usage.runIds.flatMap(runId=>byRun.get(runId)!));
 }catch(error){return {...usage,costEstimate:{scope,display:'unknown',notice:COST_ESTIMATE_NOTICE,error:String(error)}};}
 const bySource=new Map(requests.map(r=>[r.source,r]));
 return {...usage,requestAllocations:usage.requestAllocations.map(item=>({...item,cost:requestCostView(bySource.get(item.source))})),costEstimate:{scope,runIds:usage.runIds,...costTotalsView(totals)}};
}
