#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, copyFileSync, constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const [installedRoot,output,evidenceRoot]=process.argv.slice(2);
if(!installedRoot||!output||!evidenceRoot)throw Error('Usage: node scripts/terminal-candidate-manifest.mjs INSTALLED_PACKAGE_ROOT OUTPUT_JSON EVIDENCE_ROOT');
const sha=value=>createHash('sha256').update(value).digest('hex');
const files=[];
function walk(relative=''){for(const name of readdirSync(join(installedRoot,relative)).sort()){const path=join(relative,name),full=join(installedRoot,path),stat=lstatSync(full);if(stat.isSymbolicLink())files.push({path,sha256:`link:${readlinkSync(full)}`});else if(stat.isDirectory())walk(path);else if(stat.isFile())files.push({path,sha256:sha(readFileSync(full))});}}
walk();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('CANDIDATE_WORKTREE_DIRTY');
const runner=join(dirname(resolve(output)),'terminal-validation.mjs');
copyFileSync(resolve('scripts/terminal-validation.mjs'),runner,constants.COPYFILE_EXCL);
writeFileSync(output,JSON.stringify({createdAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),packageRoot:resolve(installedRoot),evidenceRoot:resolve(evidenceRoot),runner,runnerSha256:sha(readFileSync(runner)),files},null,2),{flag:'wx'});
console.log(`node '${runner}' --manifest '${resolve(output)}'`);
