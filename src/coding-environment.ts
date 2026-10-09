import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { type ExecutionEnv } from '@earendil-works/pi-durable/env';
import { realpath, stat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readEnvironment } from './read-environment.js';
import { digest } from './evidence.js';

export interface ToolEnvironmentConfig { version: string; variables: Readonly<Record<string, string>> }
export interface ObservedFile { size: number; mtimeMs: number; sha256?: string }
export function toolEnvironment(config?: ToolEnvironmentConfig): Readonly<Record<string, string>> {
  if (config && (typeof config.version !== 'string' || !config.version.trim() || !config.variables || typeof config.variables !== 'object' || Object.entries(config.variables).some(([name, value]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || typeof value !== 'string' || value.includes('\0')))) throw new Error('INVALID_TOOL_ENVIRONMENT');
  return Object.freeze({ PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir(), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', ...config?.variables });
}

/** Public environment adapter; trusted shell has current-user access, not an OS sandbox. */
export function codingEnvironment(workspace: string, env: Readonly<Record<string, string>>, guard: () => void, record: (kind: string, data: unknown) => void, shellState: (state: 'started' | 'settled') => void, observed: Map<string, ObservedFile>): ExecutionEnv {
  const target = new NodeExecutionEnv({ cwd: workspace, shellPath: '/bin/bash', shellEnv: {} });
  const readonly = readEnvironment(workspace, guard, (kind, data) => {
    record(kind, data);
    if (kind === 'read.open') {
      const opened = data as { path: string; info: ObservedFile };
      observed.set(opened.path, { size: opened.info.size, mtimeMs: opened.info.mtimeMs });
    } else if (kind === 'read.bytes') {
      const read = data as { path: string; offset: number; bytes: string };
      const previous = observed.get(read.path);
      const bytes = Buffer.from(read.bytes, 'base64');
      if (previous && read.offset === 0 && bytes.length === previous.size) previous.sha256 = digest(bytes);
    }
  });
  async function pathWithin(path: string) {
    let parent = resolve(workspace, path);
    const suffix: string[] = [];
    for (;;) {
      try { parent = join(await realpath(parent), ...suffix); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
        suffix.unshift(basename(parent)); parent = dirname(parent);
      }
    }
    const rel = relative(workspace, parent);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('CAPABILITY_DENIED: file outside declared project');
    return parent;
  }
  const deny = new Set(['appendFile', 'truncateFile', 'flushFile', 'renameFile', 'createDir', 'remove', 'createTempDir', 'createTempFile', 'watch', 'openTextLineReader', 'readTextLines', 'readBinaryFile', 'listDir', 'openDirReader']);
  return new Proxy(target, { get(base, property) {
    if (property === 'openBinaryReader') return readonly.openBinaryReader;
    if (deny.has(String(property))) return async () => { throw new Error('CAPABILITY_DENIED: unavailable operation'); };
    if (property === 'readTextFile') return async (...args: Parameters<ExecutionEnv['readTextFile']>) => {
      guard();
      const path = await pathWithin(args[0]);
      const before = await stat(path);
      if (before.size > 256 * 1024) throw new Error('READ_LIMIT: files up to 256 KiB');
      const result = await base.readTextFile(path, args[1]);
      if (result.ok) {
        const after = await stat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('FILE_CHANGED: file changed while reading');
        record('read.text', { path, text: result.value, boundary: 'ExecutionEnv decoded text for edit' });
        observed.set(path, { size: after.size, mtimeMs: after.mtimeMs, sha256: digest(result.value) });
      }
      return result;
    };
    if (property === 'writeFile') return async (...args: Parameters<ExecutionEnv['writeFile']>) => {
      guard();
      const path = await pathWithin(args[0]);
      if (Buffer.byteLength(args[1]) > 256 * 1024) throw new Error('WRITE_LIMIT: files up to 256 KiB');
      let previous: Buffer | undefined;
      try {
        const info = await stat(path);
        if (info.size > 256 * 1024) throw new Error('WRITE_LIMIT: existing file exceeds 256 KiB');
        const seen = observed.get(path);
        if (!seen) throw new Error('WRITE_REQUIRES_READ: read the existing file before replacing it');
        if (seen.size !== info.size || seen.mtimeMs !== info.mtimeMs) throw new Error('FILE_CHANGED: preserve intervening edits; read and reconsider');
        previous = await readFile(path);
        if (seen.sha256 && digest(previous) !== seen.sha256) throw new Error('FILE_CHANGED: acquired content no longer matches');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (observed.has(path)) throw new Error('FILE_CHANGED: observed file was removed'); }
      record('file.write-intent', { path, previous: previous?.toString('base64') ?? null, content: Buffer.from(args[1]).toString('base64'), encoding: 'base64' });
      guard();
      // Recheck after intent persistence/observer notification; the advisory owner cannot lock out external editors.
      let current: Buffer | undefined;
      try { current = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (previous ? !current || !previous.equals(current) : current !== undefined) throw new Error('FILE_CHANGED: changed before write; preserve external edits');
      const result = await base.writeFile(path, args[1], args[2]);
      if (result.ok) { const info = await stat(path); observed.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256: digest(args[1]) }); }
      record('file.write-result', { path, ok: result.ok, ...(result.ok ? { sha256: digest(args[1]) } : { error: result.error.message }) });
      return result;
    };
    if (property === 'exec') return async (...args: Parameters<ExecutionEnv['exec']>) => {
      guard();
      const [command, options, context] = args;
      let bytes = 0, chunks = 0;
      record('shell.started', { command, cwd: workspace, environmentNames: Object.keys(env).sort(), inheritEnv: false, boundary: 'trusted local shell; output is complete acquired decoded UTF-8, with separate stdout/stderr' });
      shellState('started');
      const result = await base.exec(command, { ...options, cwd: workspace, env: { ...env }, inheritEnv: false, window: undefined,
        onOutput(text, outputContext, info) {
          // Synchronous fsync/SQLite append is backpressure. No growing output/telemetry queue.
          const data = Buffer.from(text);
          for (let offset = 0; offset < data.length; offset += 16 * 1024) {
            const chunk = data.subarray(offset, offset + 16 * 1024);
            record('tool.output', { index: chunks, offset: bytes, stream: info.stream, encoding: 'base64', bytes: chunk.toString('base64') });
            chunks++; bytes += chunk.length;
          }
          options?.onOutput?.(text, outputContext, info);
        }
      }, context);
      shellState('settled');
      record('shell.completed', { bytes, chunks, managedCommand: 'settled', externalProcesses: 'unknown', completeness: result.ok ? 'complete' : 'partial', ...(result.ok ? result.value : { error: result.error.message, code: result.error.code, spillPath: result.error.spillPath }) });
      return result;
    };
    const value = Reflect.get(base, property);
    return typeof value === 'function' ? (...args: unknown[]) => { if (property !== 'cleanup') guard(); return value.apply(base, args); } : value;
  } });
}
