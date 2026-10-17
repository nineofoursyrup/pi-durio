import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Evidence} from '../src/evidence.js';
import {captureImproveSources,listRegisteredSources,registerImproveSource,unregisterImproveSource} from '../src/improve-source.js';

function fixture(){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-source-registration-'))),workspace=join(directory,'project'),otherWorkspace=join(directory,'other-project'),dataRoot=join(directory,'data'),assets=join(directory,'assets'),other=join(directory,'other-assets');
 for(const path of [workspace,otherWorkspace,assets,other])mkdirSync(path);
 for(const root of [assets,other])for(const path of ['case.json','extra.json'])writeFileSync(join(root,path),`{"path":"${path}"}\n`);
 return {directory,workspace,otherWorkspace,dataRoot,assets,other};
}
test('raw eval sources require an active registration matching workspace, kind, root and every selected path',()=>{
 for(const invalid of ['none','workspace','kind','root','paths','revoked'] as const){
  const f=fixture();
  if(invalid!=='none'){
   const reg=registerImproveSource(f.dataRoot,invalid==='workspace'?f.otherWorkspace:f.workspace,{kind:invalid==='kind'?'self-source':'eval-asset',root:invalid==='root'?f.other:f.assets,paths:['case.json']});
   if(invalid==='revoked')unregisterImproveSource(f.dataRoot,reg.id);
  }
  const before=listRegisteredSources(f.dataRoot),evidence=new Evidence(f.dataRoot,'analysis');
  const captured=captureImproveSources(evidence,f.workspace,[{id:'raw',kind:'eval-asset',root:f.assets,paths:invalid==='paths'?['case.json','extra.json']:['case.json']}],'v1');evidence.close();
  assert.equal(captured.targets[0].state,'incomplete',invalid);
  assert.match(captured.targets[0].gaps.join('\n'),/IMPROVE_SOURCE_REGISTRATION_REQUIRED/,invalid);
  assert.deepEqual(captured.targets[0].files,[],invalid);assert.equal(captured.texts.size,0,invalid);
  assert.deepEqual(listRegisteredSources(f.dataRoot),before,'capture must never register or expand a source');
 }
});
test('selected registered content is fingerprint-bound; unrelated registrations do not authorize or block it',()=>{
 const f=fixture();registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:f.assets,paths:['case.json','extra.json']});
 registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:f.other,paths:['case.json']});writeFileSync(join(f.other,'case.json'),'unselected drift');
 const evidence=new Evidence(f.dataRoot,'analysis'),source={id:'selected',kind:'eval-asset' as const,root:f.assets,paths:['case.json']};
 const good=captureImproveSources(evidence,f.workspace,[source],'v1');assert.equal(good.targets[0].state,'verified');assert.deepEqual(good.targets[0].files.map(f=>f.path),['case.json']);assert.equal(good.texts.size,1);
 writeFileSync(join(f.assets,'case.json'),'changed selected bytes');
 const drift=captureImproveSources(evidence,f.workspace,[source],'v1');evidence.close();
 assert.equal(drift.targets[0].state,'incomplete');assert.match(drift.targets[0].gaps.join('\n'),/IMPROVE_REGISTERED_SOURCE_CHANGED/);assert.deepEqual(drift.targets[0].files,[]);assert.equal(drift.texts.size,0);
});
test('self source needs registration in addition to the existing complete build correspondence',()=>{
 const f=fixture(),root=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),source={id:'self',kind:'self-source' as const,root,paths:['src/cli.ts']},evidence=new Evidence(f.dataRoot,'analysis');
 const absent=captureImproveSources(evidence,f.workspace,[source],'v1');assert.equal(absent.targets[0].state,'incomplete');assert.match(absent.targets[0].gaps.join('\n'),/IMPROVE_SOURCE_REGISTRATION_REQUIRED/);assert.equal(absent.texts.size,0);
 registerImproveSource(f.dataRoot,f.workspace,{kind:source.kind,root,paths:source.paths});
 const good=captureImproveSources(evidence,f.workspace,[source],'v1');evidence.close();assert.equal(good.targets[0].state,'verified',good.targets[0].gaps.join('\n'));assert.equal(good.targets[0].files.length,1);assert.notEqual(good.targets[0].applicableVersion,'v1');
});
