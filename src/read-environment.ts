import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { getOrThrow, type ExecutionEnv, type BinaryReader } from '@earendil-works/pi-durable/env';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';

const MUTATIONS = new Set(['exec', 'writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile', 'createDir', 'remove', 'createTempDir', 'createTempFile']);
export function readEnvironment(workspace: string, guard: () => void, record: (kind: string, data: unknown) => void): ExecutionEnv {
  const env = new NodeExecutionEnv({ cwd: workspace, shellEnv: {} });
  return new Proxy(env, {
    get(target, property) {
      if (MUTATIONS.has(String(property))) return async () => { throw new Error('CAPABILITY_DENIED: read-only task'); };
      if (property === 'openBinaryReader') return async (...args: Parameters<ExecutionEnv['openBinaryReader']>) => {
        guard();
        const canonical = await realpath(args[0]);
        const rel = relative(workspace, canonical);
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('CAPABILITY_DENIED: outside declared project');
        const opened = await target.openBinaryReader(...args);
        if (!opened.ok) return opened;
        const reader = opened.value;
        try {
          const info = getOrThrow(await reader.info(args[2]));
          if (info.size > 256 * 1024) throw new Error('READ_LIMIT: this small-project path supports files up to 256 KiB');
          record('read.open', { path: canonical, info, boundary: 'ExecutionEnv BinaryReader; subsequent byte ranges are exact acquired originals' });
        } catch (error) { await reader.close(args[2]); throw error; }
        const captured: BinaryReader = {
          info: reader.info.bind(reader),
          scanLines: async (options, context) => { guard(); return reader.scanLines(options, context); },
          close: reader.close.bind(reader),
          read: async (offset, length, context) => {
            guard();
            const result = await reader.read(offset, length, context);
            if (result.ok) record('read.bytes', { path: canonical, offset, encoding: 'base64', bytes: Buffer.from(result.value).toString('base64') });
            return result;
          }
        };
        return { ok: true, value: captured };
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
