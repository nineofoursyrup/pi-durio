import { constants } from 'node:fs';
import { mkdir, lstat, open, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// The caller must stop the VM before invoking this function. No candidate file
// is imported, evaluated, unpacked, or used as a destination path.
export async function exportRegularFiles(source, names, destination, maxBytes = 1_048_576) {
  if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length) {
    throw new Error('invalid_export_manifest');
  }
  const root = await lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('invalid_export_root');
  const selected = [];
  let total = 0;
  for (const name of names) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) ||
        name.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid_export_path');
    let path = source;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('export_parent_not_directory');
    }
    path = join(path, parts.at(-1));
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1) throw new Error('export_not_single_regular_file');
    total += before.size;
    if (total > maxBytes) throw new Error('export_size_limit');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || current.size !== before.size) {
        throw new Error('export_changed');
      }
      const bytes = Buffer.alloc(current.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) throw new Error('export_incomplete');
      selected.push({ name, bytes });
    } finally { await handle.close(); }
  }
  // Validate every declared item before creating any successful export.
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const file of selected) {
    await mkdir(dirname(join(destination, file.name)), { recursive: true, mode: 0o700 });
    await writeFile(join(destination, file.name), file.bytes, { flag: 'wx', mode: 0o400 });
  }
  return selected.map(({ name, bytes }) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
}
