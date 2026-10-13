import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {records} from '../src/history.js';
import {recordCostEstimate} from '../src/metrics/index.js';
import {HOST_PRICE_TABLE,pricePeriod,estimateRequestCost,sumCostEstimates,formatAmount,formatCostTotals,hostPlanPrice,upperBoundAmount,consultedDateGap,estimateRunRequests} from '../src/cost-estimate.js';

const flash={provider:'deepseek',model:'deepseek-flash'};
const usage=(u:Partial<Record<'input'|'cacheRead'|'cacheWrite'|'output',number>>)=>({input:0,cacheRead:0,cacheWrite:0,output:0,totalTokens:0,cost:{total:99},...u});

test('price table version 1 is the fixed DeepSeek CNY table with consulted date and holiday note',()=>{
 assert.equal(HOST_PRICE_TABLE.currency,'CNY');assert.equal(HOST_PRICE_TABLE.consultedAt,'2026-10-12');assert.match(HOST_PRICE_TABLE.source,/api-docs\.deepseek\.com\/zh-cn\/quick_start\/pricing/);assert.match(HOST_PRICE_TABLE.note,/节假日/);
 assert.deepEqual(Object.keys(HOST_PRICE_TABLE.models),['deepseek/deepseek-flash']);
 assert.deepEqual(HOST_PRICE_TABLE.models['deepseek/deepseek-flash'].peak,{input:2,cacheRead:0.04,cacheWrite:0,output:8});
 assert.deepEqual(HOST_PRICE_TABLE.models['deepseek/deepseek-flash']['off-peak'],{input:1,cacheRead:0.02,cacheWrite:0,output:4});
});

test('period boundaries use Beijing time on weekdays and weekends',()=>{
 // 2026-10-14 is a Wednesday, 2026-10-17 a Saturday.
 const at=(day:number,time:string)=>`2026-10-${day}T${time}:00+08:00`;
 const expected:[string,'peak'|'off-peak'][]=[['08:59','off-peak'],['09:00','peak'],['11:59','peak'],['12:00','off-peak'],['13:59','off-peak'],['14:00','peak'],['17:59','peak'],['18:00','off-peak']];
 for(const [time,period]of expected)assert.equal(pricePeriod(at(14,time)),period,time);
 for(const time of ['09:00','10:30','14:00','17:59'])assert.equal(pricePeriod(at(17,time)),'off-peak',`weekend ${time}`);
 // The same instant written in UTC is judged by its Beijing clock: 01:00Z is 09:00 Beijing.
 assert.equal(pricePeriod('2026-10-14T01:00:00Z'),'peak');assert.equal(pricePeriod('2026-10-14T00:59:00Z'),'off-peak');
 // Friday 23:00 UTC is Saturday 07:00 Beijing.
 assert.equal(pricePeriod('2026-10-16T02:00:00Z'),'peak');assert.equal(pricePeriod('2026-10-16T23:00:00Z'),'off-peak');
});

test('each usage category maps to its unit price; cache writes cost 0; the pi-ai USD cost is ignored',()=>{
 const peak='2026-10-14T10:00:00+08:00',idle='2026-10-14T20:00:00+08:00';
 const cases:[Parameters<typeof usage>[0],number,number][]=[[{input:1e6},2,1],[{cacheRead:1e6},0.04,0.02],[{cacheWrite:1e6},0,0],[{output:1e6},8,4],[{input:1e6,cacheRead:1e6,cacheWrite:1e6,output:1e6},10.04,5.02]];
 for(const [u,peakAmount,idleAmount]of cases){
  const p=estimateRequestCost({...flash,usage:usage(u),at:peak}),i=estimateRequestCost({...flash,usage:usage(u),at:idle});
  assert.ok(Math.abs(p.amount!-peakAmount)<1e-12,JSON.stringify(u));assert.ok(Math.abs(i.amount!-idleAmount)<1e-12,JSON.stringify(u));
  assert.equal(p.state,'complete');assert.equal(p.currency,'CNY');assert.equal(p.period,'peak');assert.equal(i.period,'off-peak');
 }
 const e=estimateRequestCost({...flash,usage:usage({input:1000}),at:peak});
 assert.deepEqual({version:e.price!.version,consultedAt:e.price!.consultedAt,period:e.price!.period,provider:e.price!.provider,model:e.price!.model,currency:e.price!.currency},{version:'deepseek-cny-v1',consultedAt:'2026-10-12',period:'peak',provider:'deepseek',model:'deepseek-flash',currency:'CNY'});
});

test('usage without all four reported categories is unknown and never zero',()=>{
 for(const u of [null,undefined,{},{totalTokens:3},{input:1e6,output:1e6}]){const e=estimateRequestCost({...flash,usage:u,at:'2026-10-14T10:00:00+08:00'});assert.equal(e.state,'unknown');assert.equal(e.amount,null);assert.equal(e.currency,null);assert.deepEqual(e.gaps,['用量未知']);}
});

test('requests before the consulted date are estimated but partial with the effective-date gap',()=>{
 const before=estimateRequestCost({...flash,usage:usage({output:1e6}),at:'2026-10-11T23:59:00+08:00'});
 assert.equal(before.state,'partial');assert.equal(before.amount,4);assert.deepEqual(before.gaps,['价目在请求时的生效情况无法证明']);
 const on=estimateRequestCost({...flash,usage:usage({output:1e6}),at:'2026-10-12T00:00:00+08:00'});assert.equal(on.state,'complete');assert.deepEqual(on.gaps,[]);
 assert.equal(consultedDateGap('2026-10-11T15:59:59Z'),'价目在请求时的生效情况无法证明');assert.equal(consultedDateGap('2026-10-11T15:59:59Z','2026-10-12'),'价目在请求时的生效情况无法证明');assert.equal(consultedDateGap('2026-10-12T00:00:00+08:00'),null);assert.equal(consultedDateGap('2026-10-11T16:00:00Z'),null);
});

test('models outside the price table are unknown with "价目未覆盖" and no conversion',()=>{
 for(const model of [{provider:'deepseek',model:'deepseek-v4-pro'},{provider:'fixture',model:'fixed'},{provider:null,model:null}]){
  const e=estimateRequestCost({...model,usage:usage({input:1e6}),at:'2026-10-14T10:00:00+08:00'});
  assert.equal(e.state,'unknown');assert.equal(e.amount,null);assert.equal(e.price,null);assert.deepEqual(e.gaps,['价目未覆盖']);
 }
 assert.equal(hostPlanPrice('deepseek','deepseek-v4-pro'),null);assert.equal(upperBoundAmount(1e6,'fixture','fixed'),null);
});

test('plan price and token upper bounds use the peak output price',()=>{
 assert.deepEqual(hostPlanPrice('deepseek','deepseek-flash'),{version:'deepseek-cny-v1',source:HOST_PRICE_TABLE.source,consultedAt:'2026-10-12',currency:'CNY',perMillionTokens:8});
 assert.deepEqual(upperBoundAmount(250000,'deepseek','deepseek-flash'),{amount:2,currency:'CNY',version:'deepseek-cny-v1'});
});

test('amount display: ≈ and symbol, two decimals, < ¥0.01, +N unknown, partial, per currency',()=>{
 assert.equal(formatAmount(0.06,'CNY'),'≈ ¥0.06');assert.equal(formatAmount(12.345,'CNY'),'≈ ¥12.35');assert.equal(formatAmount(0,'CNY'),'≈ ¥0.00');
 assert.equal(formatAmount(0.004,'CNY'),'< ¥0.01');assert.equal(formatAmount(0.0099,'CNY'),'< ¥0.01');assert.equal(formatAmount(0.01,'CNY'),'≈ ¥0.01');
 assert.equal(formatAmount(1.5,'USD'),'≈ $1.50');assert.equal(formatAmount(7,'EUR'),'≈ EUR 7.00');
 const totals=sumCostEstimates([{currency:'CNY',amount:0.05,state:'complete'},{currency:'CNY',amount:0.01,state:'partial'},{currency:null,amount:null,state:'unknown'},{currency:null,amount:null,state:'unknown'},{currency:null,amount:null,state:'not-applicable'},{currency:'USD',amount:0.1,state:'complete'}]);
 assert.ok(Math.abs(totals.amounts.CNY-0.06)<1e-12);assert.equal(totals.amounts.USD,0.1);assert.equal(totals.unknownRequests,2);assert.equal(totals.partial,true);
 assert.equal(formatCostTotals(totals),'≈ ¥0.06 · ≈ $0.10 +2 unknown partial');
 assert.equal(formatCostTotals(sumCostEstimates([{currency:'CNY',amount:0.003,state:'complete'}])),'< ¥0.01');
 assert.equal(formatCostTotals(sumCostEstimates([{currency:null,amount:null,state:'unknown'}])),'+1 unknown');
 assert.equal(formatCostTotals(sumCostEstimates([])),'≈ ¥0.00');
 assert.equal(formatCostTotals(sumCostEstimates([],{partial:true})),'unknown');
 assert.equal(formatCostTotals(sumCostEstimates([{currency:'CNY',amount:2,state:'complete'}],{partial:true})),'≈ ¥2.00 partial');
});

test('shared run entry: transport time, reported-usage gate, one incomplete-usage definition, revisions first, not-applicable',()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-run-cost-')),e=new Evidence(root,'run'),model={provider:'deepseek',id:'deepseek-flash'};
 const usage={input:1e6,output:1e6,cacheRead:0,cacheWrite:0,totalTokens:2e6,cost:{total:0.5}},zeros={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}};
 const call=(id:string,o:{dispatches?:number;usage?:'reported'|'unknown';completeness?:string;raw?:object|null;failed?:boolean}={})=>{
  e.append('model.intent',{attemptId:id,model,purpose:'generation',allocation:'task'});
  if(o.failed){e.append('model.dispatch-failed',{attemptId:id,dispatched:false,attemptDispatched:false,reason:'not admitted'});return;}
  for(let n=0;n<(o.dispatches??1);n++)e.append('model.dispatch',{attemptId:id,transportEntered:true});
  if(o.raw!==null)e.append('model.provider-event',{attemptId:id,event:{usage:o.raw??{prompt_tokens:1e6,completion_tokens:1e6,prompt_cache_hit_tokens:0}}});
  e.append('model.response',{attemptId:id,usage:o.usage??'reported',completeness:o.completeness??'complete',message:{usage:o.usage==='unknown'?zeros:usage}});
 };
 call('ok');call('unreported',{usage:'unknown'});call('aborted',{completeness:'partial'});call('shared',{dispatches:2});call('no-cache-hit',{raw:{prompt_tokens:1e6,completion_tokens:1e6}});call('no-raw',{raw:null});call('skipped',{failed:true});call('revised');e.close();
 const {requests,totals}=estimateRunRequests(root,'run'),by=Object.fromEntries(requests.map(r=>[r.attemptId,r]));
 const dispatch=[...records(root,{runId:'run',kinds:['model.dispatch']})][0];assert.equal(by.ok.at,dispatch.at);assert.equal(by.ok.state,'complete');assert.equal(by.ok.currency,'CNY');assert.equal(by.ok.price.version,'deepseek-cny-v1');assert.deepEqual(by.ok.history.map((h:any)=>[h.currency,h.amount]),[['USD',0.5]]);
 const amount=by.ok.period==='peak'?10:5;assert.equal(by.ok.amount,amount);
 assert.equal(by.unreported.state,'unknown');assert.equal(by.unreported.amount,null);assert.equal(by.unreported.usage,null);assert.deepEqual(by.unreported.history,[]);assert.ok(by.unreported.gaps.includes('usage missing or request in flight'));
 // Missing usage with a known host price is not a missing price.
 assert.equal(by.unreported.price.version,'deepseek-cny-v1');assert.ok(!by.unreported.gaps.includes('price unavailable'));
 assert.equal(by.aborted.state,'partial');assert.ok(by.aborted.gaps.includes('usage incomplete: response ended with error or abort'));
 assert.equal(by.shared.state,'partial');assert.ok(by.shared.gaps.includes('multiple observable requests share one model response; per-request usage incomplete'));
 assert.equal(by['no-cache-hit'].state,'partial');assert.deepEqual(by['no-cache-hit'].gaps,['usage incomplete: provider did not report cache-hit tokens']);
 assert.equal(by['no-raw'].state,'complete');assert.equal(by.skipped.state,'not-applicable');
 assert.deepEqual({unknownRequests:totals.unknownRequests,partial:totals.partial},{unknownRequests:1,partial:true});
 const intent=[...records(root,{runId:'run',kinds:['model.intent']})].at(-1)!,response=[...records(root,{runId:'run',kinds:['model.response']})].at(-1)!;
 recordCostEstimate(root,{id:'explicit',requestSource:intent.id,amount:3,currency:'CNY',price:{source:'explicit tariff',version:'explicit-v1',effectiveAt:'2000-01-01T00:00:00Z',provider:'deepseek',model:'deepseek-flash'},usageSources:[response.id],reason:'Explicit sourced re-estimate'});
 const revised=estimateRunRequests(root,'run').requests.find(r=>r.attemptId==='revised')!;assert.equal(revised.amount,3);assert.equal(revised.price.version,'explicit-v1');assert.equal(revised.state,'complete');
});
