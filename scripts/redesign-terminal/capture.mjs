#!/usr/bin/env node
/** Attach a user-taken screenshot; never launches or screenshots Terminal itself. */
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyManifest } from './verify.mjs';
import { save, sha256, templates, newOutputPath } from './common.mjs';
const { values } = parseArgs({ options: { manifest: { type: 'string' }, run: { type: 'string' }, image: { type: 'string' }, output: { type: 'string' } } });
if (!values.manifest || !values.run || !values.image || !values.output) throw Error('Usage: node capture.mjs --manifest MANIFEST --run NATIVE_GALLERY_DIR --image USER_SCREENSHOT.png --output NEW_ATTACHMENT_DIR');
const manifest = verifyManifest(values.manifest); if (manifest.synthetic) throw Error('SYNTHETIC_MANIFEST_NOT_NATIVE');
const environment = JSON.parse(readFileSync(join(values.run, 'environment.json'), 'utf8')), gallery = JSON.parse(readFileSync(join(values.run, 'gallery.json'), 'utf8'));
if (environment.manifestSha256 !== sha256(readFileSync(values.manifest)) || JSON.stringify(environment.candidate) !== JSON.stringify(manifest.candidate) || environment.scope !== 'native-synthetic-gallery' || environment.platform !== 'darwin' || environment.arch !== 'arm64' || environment.TERM_PROGRAM !== 'Apple_Terminal' || !environment.stdinTTY || !environment.stdoutTTY || environment.columns !== 132 || environment.rows !== 38 || gallery.columns !== 132 || gallery.rows !== 38 || gallery.screen !== environment.screen || gallery.tier !== environment.tier || !gallery.displayed) throw Error('SCREENSHOT_NATIVE_BINDING_MISMATCH');
if (!templates()['screenshots.json'].slots.some(s => s.screen === environment.screen && s.tier === environment.tier)) throw Error('SCREENSHOT_SLOT_NOT_PLANNED');
const bytes = readFileSync(values.image); if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('SCREENSHOT_PNG_REQUIRED');
const output = newOutputPath(values.output, [manifest.source.root, manifest.installation.root, manifest.harness.root]); mkdirSync(output, { mode: 0o700 });
copyFileSync(values.image, join(output, 'screenshot.png'), constants.COPYFILE_EXCL);
save(join(output, 'screenshot.json'), { screen: environment.screen, tier: environment.tier, columns: 132, rows: 38, status: 'ATTACHED_NOT_VISUALLY_CONFIRMED', path: 'screenshot.png', sha256: sha256(bytes), executionVersion: environment.executionVersion, candidate: manifest.candidate, manifestSha256: environment.manifestSha256, nativeRun: resolve(values.run), gallery, at: new Date().toISOString(), userConfirmation: 'NOT_RUN' });
console.log(output);
