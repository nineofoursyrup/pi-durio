import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {replacementContent} from '../src/improve-replacements.js';
import {improveChoiceError} from '../src/tui/improve-selection.js';
import type {ImproveCandidate} from '../src/improve.js';

function fixture(bytes:Buffer) {
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'durio-replacement-bytes-'))),workspace=join(directory,'project'),root=join(directory,'data');mkdirSync(workspace);
 writeFileSync(join(workspace,'sample.js'),bytes);
 const evidence=new Evidence(root,'analysis'),sources=captureImproveSources(evidence,workspace,[{id:'project',kind:'project',paths:['sample.js']}],'test');evidence.close();
 const candidate:ImproveCandidate={id:'candidate',revision:'revision',display:'R1',title:'Update value',problem:'Old value',objective:'bug',target:sources.targets[0],facts:[],hypotheses:[],successCounterexamples:[],gaps:[],mechanismsReviewed:[],steps:[],scope:['sample.js'],validation:{method:'regression',checks:[],budget:'0',protections:[]},risks:[],rollback:'Retained original',activation:{writeback:true,enable:false,conditions:[],timing:'next task'},dependencies:[],conflicts:[],execution:'not-started',effect:'unverified',selection:'unselected',suggestionOnly:false};
 return {root,workspace,candidate};
}
test('fragment replacements reject non-UTF-8 baselines before they can rewrite unrelated bytes',()=>{
 const original=Buffer.concat([Buffer.from('// GBK: '),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('\nconst x = 1;\n')]),f=fixture(original);
 assert.equal(f.candidate.target.files[0].state,'withheld','new analysis already withholds undecodable sources; saved-report application must also reject them');
 assert.throws(()=>replacementContent(f.root,f.candidate,{path:'sample.js',before:'x = 1',content:'x = 2'}),/IMPROVE_REPLACEMENT_ENCODING_UNSUPPORTED/);
 const message=improveChoiceError(new Error('IMPROVE_REPLACEMENT_ENCODING_UNSUPPORTED: replacement baseline must be UTF-8 text'));
 assert.match(message,/取证基线不是 UTF-8 文本，不能安全替换/);assert.match(message,/IMPROVE_REPLACEMENT_ENCODING_UNSUPPORTED: replacement baseline must be UTF-8 text/);
 assert.deepEqual(readFileSync(join(f.workspace,'sample.js')),original);
});
test('UTF-8 fragment replacements preserve every byte outside the unique match and retain the saved-report execution guard',()=>{
 const prefix='\uFEFF// 中文 😀\r\n',suffix='\r\n// tail\r\n',f=fixture(Buffer.from(prefix+'const x = 1;'+suffix));
 assert.deepEqual(Buffer.from(replacementContent(f.root,f.candidate,{path:'sample.js',before:'x = 1',content:'x = 2'})),Buffer.from(prefix+'const x = 2;'+suffix));
 assert.throws(()=>replacementContent(f.root,f.candidate,{path:'sample.js',before:'absent',content:'x'}),/IMPROVE_REPLACEMENT_BASELINE_MISMATCH/);
 assert.throws(()=>replacementContent(f.root,f.candidate,{path:'sample.js',before:'//',content:'x'}),/IMPROVE_REPLACEMENT_BASELINE_MISMATCH/);
});
