import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence} from '../src/evidence.js';
import {previewCleanup} from '../src/storage.js';

test('cleanup retains unresolved and still-rollbackable formal bytes plus the current default; completed rollback releases only the former scope',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'durio-improve-retention-'))),e=new Evidence(root,'analysis');
 const before=e.blob('original formal file'),after=e.blob('validated formal file'),previous=e.blob('previous default instruction'),current=e.blob('new default instruction');
 const snapshot=(content:typeof current)=>({workspace:'/fixture/project',taskType:'coding',files:[{content}]}),defaults=[{previous:snapshot(previous),current:snapshot(current)}];
 e.append('improve.formal-started',{id:'decision',groupId:'group',files:[{before,after}],defaults});e.close();
 const units=[before,after,previous,current].map(ref=>`object:${ref.sha256}`),preview=(id:string)=>previewCleanup(root,{id,units,reason:'Explicitly inspect these four retained file payloads'});
 const unresolved=await preview('unresolved');assert.equal(unresolved.plan.units.length,0);assert.equal(unresolved.plan.blocked.length,4);assert.match(JSON.stringify(unresolved.plan.blocked),/improve-formal:decision:group/);
 const completed=new Evidence(root,'analysis');completed.append('improve.activation',{id:'decision',groupId:'group',state:'new-default',defaults});completed.append('improve.formal',{id:'decision',groupId:'group',state:'completed'});completed.close();
 const rollbackable=await preview('rollbackable');assert.equal(rollbackable.plan.units.length,0);assert.match(JSON.stringify(rollbackable.plan.blocked),/improve-active-default/);
 const rollback=new Evidence(root,'analysis');rollback.append('improve.activation',{id:'decision',groupId:'group',state:'rolled-back',defaults:defaults.map(d=>({previous:d.current,current:d.previous}))});rollback.append('improve.rollback',{id:'decision',groupId:'group',state:'completed'});rollback.close();
 const reverted=await preview('reverted');assert.deepEqual(reverted.plan.units.map(u=>u.id).sort(),[before,after,current].map(ref=>`object:${ref.sha256}`).sort());assert.deepEqual(reverted.plan.blocked.map(u=>u.id),[`object:${previous.sha256}`]);assert.match(reverted.plan.blocked[0].reasons.join(),/improve-active-default/);
});
