// Read-only host ledger; historical UNKNOWN remains reserved.
import assert from 'node:assert/strict';
import {PRIOR,LIMITS,STAGES} from './preflight.mjs';

export function stageLedger(api,dataRoot,runId,stage,entered){
 const limits=STAGES[stage],base={stage,limits,runId,entered};
 if(!entered)return {...base,requests:0,dispatches:0,knownTokens:0,reservedTokens:0,unknown:0,completeness:'not-started',violation:false};
 try{
  assert.ok(runId,'STAGE_RUN_ID_UNAVAILABLE');let after=0;const records=[];
  for(;;){const page=api.query.readRunRecords(dataRoot,runId,{after,limit:50,kinds:['budget.reserve','budget.settle','provider.dispatch']});for(const row of page.records){after=row.seq;records.push({kind:row.kind,data:JSON.parse(api.runtime.readObject(dataRoot,row.ref)),source:`e1:${row.seq}:${row.ref.sha256}`});}if(!page.more)break;}
  const reserves=records.filter(r=>r.kind==='budget.reserve'),settles=records.filter(r=>r.kind==='budget.settle'),dispatches=records.filter(r=>r.kind==='provider.dispatch');
  let knownTokens=0,reservedTokens=0,unknown=0,violation=false;
  const requests=reserves.map(r=>{const matches=settles.filter(s=>s.data.id===r.data.id);assert.ok(matches.length<=1,'DUPLICATE_SETTLEMENT');const s=matches[0];if(Number.isSafeInteger(s?.data.tokens)&&s.data.tokens>=0){knownTokens+=s.data.tokens;if(s.data.tokens>r.data.tokens)violation=true;}else{unknown++;reservedTokens+=r.data.tokens;}return{id:r.data.id,reservation:r.source,settlement:s?.source??null,dispatch:dispatches.find(d=>d.data.id===r.data.id)?.source??null};});
  assert.ok(dispatches.every(d=>reserves.some(r=>r.data.id===d.data.id)),'UNRESERVED_DISPATCH');
  violation ||= requests.length>limits.maxRequests||knownTokens+reservedTokens>limits.maxTokens;
  return {...base,requests:requests.length,dispatches:dispatches.length,knownTokens,reservedTokens,unknown,completeness:unknown?'unknown':'known',violation,evidence:requests};
 }catch(error){return {...base,requests:null,dispatches:null,knownTokens:0,reservedTokens:limits.maxTokens,unknown:null,completeness:'unavailable-full-stage-held',violation:null,error:String(error),warning:'Hold the full authorized stage allowance; unavailable evidence is never treated as zero usage or permission to resume'};}
}

export function cumulativeLedger(improveStage){
 const stages=[improveStage],knownTokens=PRIOR.knownTokens+stages.reduce((n,s)=>n+s.knownTokens,0),reservedTokens=PRIOR.reservedTokens+stages.reduce((n,s)=>n+s.reservedTokens,0);
 return {prior:PRIOR,stages,knownRequests:PRIOR.requests+stages.reduce((n,s)=>n+(s.requests??0),0),requestCompleteness:stages.some(s=>s.requests===null)?'unknown':'known',knownTokens,reservedTokens,chargedUpperTokens:knownTokens+reservedTokens,conservativeKnownUsd:knownTokens*12/10000000,conservativeChargedUpperUsd:(knownTokens+reservedTokens)*12/10000000,limits:LIMITS,boundExceeded:stages.some(s=>s.violation===true)||knownTokens+reservedTokens>LIMITS.cumulativeMaxTokens,accountBill:'Not observed',rule:'Only host stage reservations and settlements are counted; failed/unknown reservations remain charged. SDK/guest mirrors are not added. Original STOPPED and failed trial remain unchanged.'};
}
