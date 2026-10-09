import { mkdir, copyFile } from 'node:fs/promises';
// npm deliberately omits a root package-lock.json from packs. Ship its exact bytes inside dist instead.
await mkdir('dist/execution', { recursive: true });
await copyFile('package-lock.json', 'dist/execution/package-lock.json');
await mkdir('dist/execution/isolation', { recursive: true });
for (const name of ['boundary.mjs','export.mjs','restrict.py']) await copyFile(`scripts/isolation/${name}`, `dist/execution/isolation/${name}`);
await copyFile('scripts/isolation/fixtures/native-probe.py', 'dist/execution/isolation/native-probe.py');
await copyFile('scripts/eval/fixtures/runtime-probe.mjs', 'dist/execution/isolation/runtime-probe.mjs');
