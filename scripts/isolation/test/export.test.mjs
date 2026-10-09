import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportRegularFiles } from '../export.mjs';

test('export accepts declared ordinary files and refuses links or traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durio-export-test-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'answer.js'), 'export default 42;');
  await writeFile(join(root, 'hidden.txt'), 'synthetic hidden value');
  await symlink(join(root, 'hidden.txt'), join(source, 'outside'));
  await symlink(root, join(source, 'parent'));
  await link(join(root, 'hidden.txt'), join(source, 'hardlink'));
  const destination = join(root, 'export');
  const files = await exportRegularFiles(source, ['answer.js'], destination);
  assert.equal(await readFile(join(destination, 'answer.js'), 'utf8'), 'export default 42;');
  assert.equal(files[0].bytes, 18);
  for (const file of ['outside', 'parent/hidden.txt', 'hardlink', '../hidden.txt', '/etc/passwd']) {
    await assert.rejects(exportRegularFiles(source, [file], join(root, `reject-${Math.random()}`)));
  }
});
