#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dimensions, screens, save, sha256, newOutputPath } from './common.mjs';
import { verifyManifest } from './verify.mjs';
import { createFixtures, renderers } from './fixtures.mjs';
import { characterGrid, colorModes } from './grid.mjs';

export function serialize(grid, layoutOnly = false) {
  return `${grid.width}x${grid.height} ${grid.tier}\n` + grid.rows.map((row, index) => {
    const style = c => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}${c.dim ? '/d' : ''}${c.reverse ? '/r' : ''}`;
    let start = 0; const styles = [];
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { styles.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    const text = row.map(c => c.char).join('');
    return `${String(index).padStart(2, '0')}|${layoutOnly ? text.replace(/[0-9]/g, '#') : text}|\n   ${styles.join(' ; ')}`;
  }).join('\n') + '\n';
}
export async function generateGoldens(packageRoot, output, binding, baseline) {
  mkdirSync(output, { mode: 0o700 });
  const fixture = await createFixtures(packageRoot, join(output, 'synthetic-fixture'));
  const rendered = await renderers(packageRoot, fixture);
  const results = [];
  try {
    for (const id of screens) for (const size of dimensions) {
      const tiers = size.columns === 132 && ['1b', '1e'].includes(id) ? ['truecolor', '256color', 'none'] : ['truecolor'];
      for (const tier of tiers) for (const state of id === '1e' && size.columns === 132 ? ['six-oracles', 'zero', 'unknown'] : ['default']) {
        const lines = await rendered.render(id, size.columns, size.rows, tier, state === 'default' ? 'six-oracles' : state);
        if (lines.length !== size.rows || lines.some(line => rendered.pi.visibleWidth(line) > size.columns)) throw Error(`RENDER_OVERFLOW:${id}:${size.columns}x${size.rows}:${tier}`);
        const colors = colorModes(lines.join(''));
        if (tier === 'none' && colors.length) throw Error(`NO_COLOR_SGR:${id}`);
        if (tier === '256color' && colors.some(c => c !== '256color')) throw Error(`WRONG_COLOR_SGR:${id}`);
        const name = `${id}-${size.columns}x${size.rows}-${tier}-${state}.txt`;
        // Newly created fixtures can contain their private workspace path; normalize only that identity.
        const grid = characterGrid(lines.map(line => line.replaceAll(fixture.workspace, '/synthetic/project')), size.columns, size.rows, tier, rendered.theme, rendered.pi.visibleWidth);
        const text = serialize(grid, id === '2c');
        writeFileSync(join(output, name), text, { flag: 'wx' });
        let regression = 'NOT_RUN';
        if (baseline) { try { regression = readFileSync(join(baseline, name), 'utf8') === text ? 'MATCH' : 'DIFFERENT'; } catch { regression = 'MISSING'; } }
        results.push({ screen: id, ...size, tier, state, path: name, sha256: sha256(text), generated: 'GENERATED', regression, layoutOnly: id === '2c', userConfirmation: { status: 'NOT_RUN', at: null, statement: null, acceptedDeviation: null } });
      }
    }
  } finally { rendered.close(); }
  const report = { schema: 'pi-durio-redesign-goldens-v1', ...binding, input: 'explicit synthetic facts; no tool/provider/VM execution; no controlled measurement', nativeAcceptance: 'NOT_RUN', userConfirmation: 'NOT_RUN', artifacts: results };
  save(join(output, 'golden-index.json'), report);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' }, baseline: { type: 'string' }, development: { type: 'boolean' }, package: { type: 'string' }, 'verify-only': { type: 'boolean' } } });
  let root, binding, protectedRoots;
  if (values.development) { if (values.manifest || !values.package || values['verify-only']) throw Error('DEVELOPMENT_ARGUMENTS'); root = resolve(values.package); binding = { candidate: null, manifestSha256: null, developmentOnly: true }; }
  else { if (!values.manifest) throw Error('MANIFEST_REQUIRED'); const manifest = verifyManifest(values.manifest); if (values['verify-only']) { console.log('verified; no render or native activity'); process.exit(0); } if (manifest.synthetic) throw Error('SYNTHETIC_MANIFEST_NOT_FROZEN_CANDIDATE'); root = manifest.installation.root; protectedRoots = [manifest.source.root, root, manifest.harness.root]; binding = { candidate: manifest.candidate, manifestSha256: sha256(readFileSync(values.manifest)), developmentOnly: false }; }
  if (!values.output) throw Error('NEW_OUTPUT_REQUIRED');
  const result = await generateGoldens(root, newOutputPath(values.output, protectedRoots ?? [root]), binding, values.baseline && resolve(values.baseline));
  console.log(JSON.stringify({ artifacts: result.artifacts.length, nativeAcceptance: 'NOT_RUN', userConfirmation: 'NOT_RUN' }));
}
