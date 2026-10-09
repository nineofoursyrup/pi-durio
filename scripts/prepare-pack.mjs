import { stat, copyFile, rename, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
// esbuild's installer optimizes its executable with a hard link. npm's tar extractor rejects
// Link entries. Give npm pack identical executable bytes in an independent regular file.
const binary = require.resolve('esbuild/bin/esbuild');
if ((await stat(binary)).nlink > 1) {
  const bytes = await readFile(binary);
  const temporary = `${binary}.pi-durio-pack`;
  await copyFile(binary, temporary);
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (hash(await readFile(temporary)) !== hash(bytes)) throw new Error('Pack binary copy mismatch');
  await rename(temporary, binary);
}
