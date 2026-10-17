import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {improveHome} from '../src/improve-entry.js';
import {improveCandidateDecisions} from '../src/improve-history.js';

test('pending reports use the latest decision: only passed validation can be selected again',()=>{
 for(const outcome of ['passed','failed','cancelled','not-run','unknown'] as const){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-home-decisions-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');mkdirSync(workspace);
  const e=new Evidence(dataRoot,'analysis'),reportId='report',candidateId='candidate';
  const candidate={id:candidateId,replacements:[{path:'a.ts',content:'new'}],structuredChecks:[{kind:'direct',program:'console.log("checked")',timeoutMs:1000}]};
  const target={workspace,runId:'coding'},report={id:reportId,runId:e.runId,selectionContract:'declared-v1',startedAt:'2026-10-17T00:00:00Z',target,candidates:[candidate],suppressed:[]};
  e.append('improve.started',{request:{id:reportId},target});e.append('improve.report',report);e.close();
  assert.equal(improveHome(dataRoot,workspace).pending[0].undecided,1);
  const saved=new Evidence(dataRoot,'analysis');
  const decision={id:'validation',reportId,selections:[{candidateId,mode:'validate-only'}],groups:[{id:'group',candidateIds:[candidateId]}],limits:{maxTokens:0}};
  saved.append('improve.decision',{id:decision.id,decision,decisions:decision.selections});
  if(outcome!=='not-run')saved.append('improve.group-started',{id:decision.id,groupId:'group',reserved:{checks:1,requests:0,tokens:0}});
  if(outcome!=='not-run'&&outcome!=='unknown')saved.append('improve.validation',{id:decision.id,groupId:'group',state:outcome==='passed'?'completed':outcome,result:{conclusion:{allChecksPassed:outcome==='passed',allRequiredBenefitsMet:outcome==='passed'}}});
  saved.append('improve.batch',{id:decision.id,state:outcome==='passed'?'completed':'frozen'});saved.close();
  assert.equal(improveCandidateDecisions(dataRoot,reportId).get(candidateId)?.canExecute,outcome==='passed');
  assert.deepEqual(improveHome(dataRoot,workspace).pending.map(p=>p.undecided),outcome==='passed'?[1]:[],outcome);
  assert.equal(improveHome(dataRoot,workspace).reports,1,'history remains available regardless of eligibility');
  if(outcome==='passed'){
   const last=new Evidence(dataRoot,'analysis');last.append('improve.decision',{id:'execute',decision:{...decision,id:'execute',selections:[{candidateId,mode:'execute-declared-scope'}]},decisions:[{candidateId,mode:'execute-declared-scope'}]});last.close();
   assert.deepEqual(improveHome(dataRoot,workspace).pending,[],'the later execute decision replaces the passed-validation eligibility');
  }
 }
});
