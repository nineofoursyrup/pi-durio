import {Evidence} from '../../src/evidence.js';
import {improveFacts} from '../../src/improve-history.js';
import type {ImproveDecision} from '../../src/improve-decisions.js';

/** Publish a current-format synthetic report before exercising a declared plan.
 * Each fixture group owns one candidate, so its exact changes/checks/basis are
 * explicit candidate declarations. Never use this to alter historical fixtures
 * or after a decision has been submitted. Invalid candidate proposals are
 * declared explicitly too; authority-tampering requests are mutated only after
 * this fixture has fixed the candidate being tested. */
export function saveDeclaredFixture(dataRoot:string,report:any,decision:ImproveDecision) {
 if(improveFacts(dataRoot).some(f=>f.kind==='improve.decision'&&f.data.decision.reportId===report.id))throw Error('DECLARED_FIXTURE_ALREADY_DECIDED');
 report.selectionContract='declared-v1';
 for(const candidate of report.candidates){
  candidate.replacements??=[];candidate.structuredChecks??=[];
 }
 for(const group of decision.groups){
  if(group.candidateIds.length!==1||group.checks.some(check=>check.kind==='fresh'))throw Error('DECLARED_FIXTURE_REQUIRES_ONE_CANDIDATE_AND_DIRECT_CHECKS');
  const candidate=report.candidates.find((c:any)=>c.id===group.candidateIds[0]);
  if(!candidate||group.changes.some(change=>change.targetId!==candidate.target.id))throw Error('DECLARED_FIXTURE_TARGET_MISMATCH');
  candidate.replacements=group.changes.map(({path,content})=>({path,content}));
  candidate.structuredChecks=structuredClone(group.checks);
  if(group.basis)candidate.validationBasis=structuredClone(group.basis);else delete candidate.validationBasis;
  if(group.build)candidate.buildTimeoutMs=group.build.timeoutMs;else delete candidate.buildTimeoutMs;
  const activation=decision.selections.find(s=>s.candidateId===candidate.id)?.formal?.activate;
  if(activation)candidate.activation={...candidate.activation,taskTypes:activation.taskTypes};
 }
 const e=new Evidence(dataRoot,report.runId);e.append('improve.report',report);e.close();
}
