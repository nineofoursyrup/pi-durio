import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,digest} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {currentImproveVersion,decisionDigest,previewImproveDecision,previewImproveResume,readImproveDecision,resumeImproveDecision,submitImproveDecision,type ImproveDecision,type ImproveMode} from '../src/improve-decisions.js';
import {appendFact} from '../src/eval/store.js';

/** Historical facts are synthesized as recorded, never migrated to the new contract. */
function legacyFixture() {
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-improve-host-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');
 mkdirSync(workspace);writeFileSync(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 const evidence=new Evidence(dataRoot,'legacy-analysis'),target=captureImproveSources(evidence,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'historical-version').targets[0];
 const candidate={id:'candidate:legacy',revision:'c1',display:'R1',title:'Addition',problem:'Wrong operator',objective:'bug',target,scope:['math.mjs'],steps:['Fix addition'],dependencies:[],conflicts:[],suggestionOnly:false,
  activation:{writeback:true,enable:false,conditions:['regression passes'],timing:'new task'}};
 const report={id:'legacy-report',revision:'r1',runId:evidence.runId,target:{workspace,runId:'source-run'},candidates:[candidate],targets:[target],state:'complete',evidence:[]};
 evidence.append('improve.started',{request:{id:report.id},target:report.target});evidence.append('improve.report',report);evidence.close();
 const decision=(mode:ImproveMode,id='new-choice'):ImproveDecision=>({id,reportId:report.id,reportRevision:report.revision,
  selections:[{candidateId:candidate.id,candidateRevision:candidate.revision,target,steps:candidate.steps,mode,...(mode==='execute-declared-scope'?{formal:{writeback:true as const,activate:null,failureCompensation:'none' as const}}:{})}],
  groups:['validate-only','execute-declared-scope'].includes(mode)?[{id:'g1',candidateIds:[candidate.id],changes:[{targetId:target.id,path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],checks:[{kind:'regression',program:'console.log("saved old check")',timeoutMs:1000}]}]:[],
  directory:join(directory,id),limits:{deadline:new Date(Date.now()+60000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}});
 return {directory,workspace,dataRoot,report,decision};
}

test('legacy reports reject every new headless decision without writing history or targets',async()=>{
 const f=legacyFixture(),before=readFileSync(join(f.dataRoot,'host.sqlite'));
 for(const mode of ['defer','do-not-suggest','validate-only','execute-declared-scope'] as const){
  const d=f.decision(mode);
  assert.throws(()=>previewImproveDecision(f.dataRoot,d),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
  await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:d}),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
 }
 assert.deepEqual(readFileSync(join(f.dataRoot,'host.sqlite')),before);
 assert.equal(readFileSync(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
});

test('legacy frozen groups cannot resume even with the current execution version; saved IDs still read idempotently',async()=>{
 const f=legacyFixture(),d=f.decision('validate-only','historical-choice'),e=new Evidence(f.dataRoot,f.report.runId);
 appendFact(e,'improve.decision',{id:d.id,workspace:f.workspace,executionVersion:currentImproveVersion(),requestDigest:decisionDigest(d),decision:d,decisions:[]});
 e.append('improve.batch',{id:d.id,state:'frozen',reason:'historical cancellation before first group'});e.close();
 const state=readImproveDecision(f.dataRoot,d.id),resume={id:d.id,resumeId:'new-resume',decisionSource:state.sourceId,groupIds:['g1']},before=digest(readFileSync(join(f.dataRoot,'host.sqlite')));
 assert.throws(()=>previewImproveResume(f.dataRoot,resume),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
 await assert.rejects(resumeImproveDecision({...resume,dataRoot:f.dataRoot}),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:d}),state);
 assert.equal(digest(readFileSync(join(f.dataRoot,'host.sqlite'))),before);
 // A recorded resume ID is also a read, even when it belongs to a legacy batch.
 const saved=new Evidence(f.dataRoot,f.report.runId);
 saved.append('improve.resume',{...resume,requestDigest:decisionDigest({resumeId:resume.resumeId,decisionSource:resume.decisionSource,groupIds:resume.groupIds})});saved.close();
 const savedState=readImproveDecision(f.dataRoot,d.id),savedBytes=digest(readFileSync(join(f.dataRoot,'host.sqlite')));
 assert.deepEqual(await resumeImproveDecision({...resume,dataRoot:f.dataRoot}),savedState);
 assert.equal(digest(readFileSync(join(f.dataRoot,'host.sqlite'))),savedBytes);
});


test('passed first-version validation remains read-only and cannot authorize a fresh execute decision',async()=>{
 const f=legacyFixture(),d=f.decision('validate-only','historical-pass'),e=new Evidence(f.dataRoot,f.report.runId);
 e.append('improve.decision',{id:d.id,workspace:f.workspace,executionVersion:'first-version',requestDigest:decisionDigest(d),decision:d,decisions:d.selections});
 e.append('improve.validation',{id:d.id,groupId:'g1',state:'completed',result:{conclusion:{allChecksPassed:true,allRequiredBenefitsMet:true}}});
 e.append('improve.batch',{id:d.id,state:'completed'});e.close();
 const saved=readImproveDecision(f.dataRoot,d.id),before=readFileSync(join(f.dataRoot,'host.sqlite'));
 assert.equal(saved.groups[0].state,'completed');
 assert.throws(()=>previewImproveDecision(f.dataRoot,f.decision('execute-declared-scope','after-pass')),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision('execute-declared-scope','after-pass')}),/IMPROVE_LEGACY_REPORT_READ_ONLY/);
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:d}),saved);assert.deepEqual(readFileSync(join(f.dataRoot,'host.sqlite')),before);
});
