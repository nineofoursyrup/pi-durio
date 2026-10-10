/** Rebuild the explicitly authorized dependency derivative without editing node_modules. */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root=resolve('vendor/pi-tui');
const original=join(root,'upstream/earendil-works-pi-tui-1.1.0.tgz');
const originalIntegrity='sha512-v7wkS0y2ErZvZkSfemqd9RrBZJ5x6p8Ujsv7NdJj01IXJyFM0kNL6rMdcKcvTe7EVTd6ugvDB9VPZSoaBF9QxQ==';
const hash=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest(algorithm==='sha512'?'base64':'hex');
if(`sha512-${hash(readFileSync(original),'sha512')}`!==originalIntegrity)throw Error('UPSTREAM_INTEGRITY_MISMATCH');
if(ts.version!=='5.9.3')throw Error('WIDTH_BUILD_TYPESCRIPT_CHANGED');
const temporary=mkdtempSync(join(tmpdir(),'durio-width-build-'));
try {
  execFileSync('tar',['-xzf',original,'-C',temporary]);
  const packageRoot=join(temporary,'package'),sources=join(temporary,'packages/tui/src');
  mkdirSync(sources,{recursive:true});
  for(const name of ['utils','index']) {
    const map=JSON.parse(readFileSync(join(packageRoot,`dist/${name}.js.map`),'utf8'));
    writeFileSync(join(sources,`${name}.ts`),map.sourcesContent[0]);
  }
  execFileSync('patch',['-p1','--batch','--forward','-i',join(root,'width-overrides.patch')],{cwd:temporary});
  for(const name of ['utils','index']) {
    const source=readFileSync(join(sources,`${name}.ts`),'utf8');
    const output=ts.transpileModule(source,{fileName:`src/${name}.ts`,compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,sourceMap:true,inlineSources:true}});
    writeFileSync(join(packageRoot,`dist/${name}.js`),output.outputText.replace(/(from\s+["'][^"']+)\.ts(["'])/g,'$1.js$2'));
    writeFileSync(join(packageRoot,`dist/${name}.js.map`),output.sourceMapText);
    const declarationPath=join(packageRoot,`dist/${name}.d.ts`);
    let declaration=readFileSync(declarationPath,'utf8').replace(/\/\/# sourceMappingURL=.*$/m,'');
    declaration+=name==='utils'?'\nexport declare function setGraphemeWidthOverrides(widths?: ReadonlyMap<string, number>): void;\n':'\nexport { setGraphemeWidthOverrides } from "./utils.js";\n';
    writeFileSync(declarationPath,declaration);
    rmSync(`${declarationPath}.map`);
  }
  const metadataPath=join(packageRoot,'package.json'),metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
  metadata.version='1.1.0-durio-width.1';
  metadata.piDurioDerivative={upstreamVersion:'1.1.0',upstreamIntegrity:originalIntegrity,patchSha256:hash(readFileSync(join(root,'width-overrides.patch'))),typescript:ts.version};
  writeFileSync(metadataPath,JSON.stringify(metadata,null,2)+'\n');
  const [packed]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temporary],{cwd:packageRoot,encoding:'utf8',maxBuffer:2*1024*1024}));
  const filename='pi-tui-1.1.0-durio-width.1.tgz';
  copyFileSync(join(temporary,packed.filename),join(root,filename));
  writeFileSync(join(root,'manifest.json'),JSON.stringify({name:metadata.name,version:metadata.version,upstream:{filename:'upstream/earendil-works-pi-tui-1.1.0.tgz',integrity:originalIntegrity,sha256:hash(readFileSync(original))},patch:{filename:'width-overrides.patch',sha256:metadata.piDurioDerivative.patchSha256},build:{typescript:ts.version,scriptSha256:hash(readFileSync(new URL(import.meta.url)))},artifact:{filename,integrity:packed.integrity,sha256:hash(readFileSync(join(root,filename)))},modifiedUpstreamSources:['packages/tui/src/utils.ts','packages/tui/src/index.ts']},null,2)+'\n');
  console.log(`Built ${metadata.name}@${metadata.version}: ${packed.integrity}`);
} finally {rmSync(temporary,{recursive:true,force:true});}
