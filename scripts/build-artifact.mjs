import { mkdir, copyFile } from 'node:fs/promises';
// npm deliberately omits a root package-lock.json from packs. Ship its exact bytes inside dist instead.
await mkdir('dist/execution', { recursive: true });
await copyFile('package-lock.json', 'dist/execution/package-lock.json');
