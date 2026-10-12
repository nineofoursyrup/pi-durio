/** Host price table and query-time request cost estimates (#51 费用估算).
 * The single source for every displayed amount: estimates are computed from
 * reported usage when read and never appended as records. */

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
export const USAGE_CATEGORY_UNREPORTED='用量类别未上报：';
const consultedFrom=Date.parse(`${HOST_PRICE_TABLE.consultedAt}T00:00:00+08:00`);

/** Beijing-time period of an instant. Statutory holidays are not modelled. */
export function pricePeriod(at:string|number|Date):PricePeriod{
 const ms=new Date(at).getTime();if(!Number.isFinite(ms))throw Error('PRICE_PERIOD_TIME_REQUIRED');
 const beijing=new Date(ms+8*3600_000),day=beijing.getUTCDay(),minute=beijing.getUTCHours()*60+beijing.getUTCMinutes();
 return day>=1&&day<=5&&(minute>=540&&minute<720||minute>=840&&minute<1080)?'peak':'off-peak';
}

export interface CostPrice {source:string;version:string;consultedAt:string;note:string;currency:'CNY';period:PricePeriod;provider:string;model:string;perMillion:UnitPrices}
export interface RequestCostEstimate {state:'complete'|'partial'|'unknown';currency:'CNY'|null;amount:number|null;gaps:string[];at:string;period:PricePeriod;price:CostPrice|null}

/** Estimate one model request. `at` is transport entry time, or the request intent time without a transport record.
 * `usage` is the reported pi-ai usage object; null/absent means usage is unknown, never zero. */
export function estimateRequestCost(request:{provider?:string|null;model?:string|null;usage:unknown;at:string}):RequestCostEstimate{
 const period=pricePeriod(request.at),key=`${request.provider}/${request.model}`,unit=HOST_PRICE_TABLE.models[key]?.[period];
 const result:RequestCostEstimate={state:'unknown',currency:null,amount:null,gaps:[],at:request.at,period,price:null};
 if(!unit){result.gaps.push(PRICE_UNCOVERED);return result;}
 result.price={source:HOST_PRICE_TABLE.source,version:HOST_PRICE_TABLE.version,consultedAt:HOST_PRICE_TABLE.consultedAt,note:HOST_PRICE_TABLE.note,currency:'CNY',period,provider:request.provider!,model:request.model!,perMillion:{...unit}};
 const usage=request.usage as Record<string,unknown>|null|undefined;
 if(!usage||typeof usage!=='object'){result.gaps.push(USAGE_MISSING);return result;}
 let amount=0,known=0;
 for(const category of ['input','cacheRead','cacheWrite','output'] as const){
  const tokens=usage[category];
  if(typeof tokens==='number'&&Number.isFinite(tokens)&&tokens>=0){amount+=tokens*unit[category]/1e6;known++;}
  else result.gaps.push(USAGE_CATEGORY_UNREPORTED+category);
 }
 if(!known){result.gaps=[USAGE_MISSING];return result;}
 if(Date.parse(request.at)<consultedFrom)result.gaps.push(PRICE_EFFECTIVE_UNPROVEN);
 result.amount=amount;result.currency='CNY';result.state=result.gaps.length?'partial':'complete';return result;
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
