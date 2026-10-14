#!/usr/bin/env node
/** No credential reads, product imports or provider calls. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {verifyInstallation,json,save,sha,file} from './common.mjs';
const [installArg,identityArg,outArg]=process.argv.slice(2);
if(!outArg)throw Error('Usage: check-installation.mjs INSTALL IDENTITY NEW_OUTPUT');
const root=resolve(outArg);mkdirSync(root);
const identity=json(identityArg);
verifyInstallation(join(resolve(installArg),'node_modules/pi-durio'),identity.installed);
const fixture=join(root,'fixture');mkdirSync(fixture);writeFileSync(join(fixture,'module.js'),'baseline\n');
const expected=[{path:'module.js',bytes:9,sha256:sha('baseline\n')}];verifyInstallation(fixture,expected);
writeFileSync(join(fixture,'unlisted.js'),'new executable module\n');
assert.throws(()=>verifyInstallation(fixture,expected),/INSTALLED_CONTENT_OR_SET_CHANGED/);
unlinkSync(join(fixture,'unlisted.js'));
const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'nested.js'),'outside must not be followed\n');
symlinkSync('../outside',join(fixture,'unlisted-directory'));
assert.throws(()=>verifyInstallation(fixture,expected),/INSTALLED_CONTENT_OR_SET_CHANGED/);
verifyInstallation(fixture,[...expected,{path:'unlisted-directory',symlink:'../outside'}]);
save(join(root,'summary.json'),{status:'PASS',actualInstallationFiles:identity.installed.length,identity:file(identityArg),checks:['Actual independent install exact file/link set and byte/link-target identity','Extra regular module rejected','Extra directory symlink rejected without following it','Explicit directory symlink represented by its own path and literal target'],credentialReads:0,productImports:0,providerCalls:0});
console.log('PASS: exact installation set; unlisted file and directory symlink refused');
