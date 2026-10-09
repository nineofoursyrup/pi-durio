import { spawn } from 'node:child_process';
import { mkdir, copyFile, realpath, writeFile, chmod, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportRegularFiles } from './export.mjs';

const stopped = new WeakMap();
const policy = fileURLToPath(new URL('./restrict.py', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
const cleanHostEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: process.env.HOME });

async function cli(executable, args, timeout = 30_000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env: cleanHostEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    const halt = reason => {
      error = reason; child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL');
    };
    const timer = setTimeout(() => halt('control_timeout'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) halt('control_output_limit'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) halt('control_output_limit'); });
    child.on('error', err => { error = err.code; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ...(error ? { error } : {}) }); });
  });
}

// Trusted callers supply image identity and staged input, never candidate data.
// Each call creates a new VM, new HOME/cache/tmp, and a private writable mount.
export async function runRestricted({ image, inputDir, runDir, command,
  timeoutMs, model, signal, protocolLimits, dependenciesDir, containerExecutable = '/opt/homebrew/bin/container' }) {
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('immutable_image_required');
  if (!Array.isArray(command) || !command.length || command.some(s => typeof s !== 'string' || s.includes('\0'))) throw new Error('invalid_command');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error('invalid_timeout');
  if (model && (!Number.isSafeInteger(model.maxRequests) || model.maxRequests < 1 || model.maxRequests > 100 ||
      !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 16384 ||
      typeof model.request !== 'function')) throw new Error('invalid_model_budget');
  const limits = protocolLimits ?? { inputBytes:4096, responseBytes:16384, lineBytes:16384, totalBytes:1048576 };
  if (Object.keys(limits).sort().join(',') !== 'inputBytes,lineBytes,responseBytes,totalBytes' ||
    Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1) || limits.inputBytes > 262144 || limits.responseBytes > 1048576 || limits.lineBytes > 1048576 || limits.totalBytes > 8388608) throw new Error('invalid_protocol_limits');
  if (signal?.aborted) throw new Error('cancelled_before_start');
  await mkdir(runDir, { mode: 0o700 }); // Exclusive: old/uncertain spaces are never reused.
  runDir = await realpath(runDir);
  const id = `durio-i12-${randomUUID()}`;
  const workDir = join(runDir, 'work');
  const stagedInput = join(runDir, 'input');
  const boundaryDir = join(runDir, 'boundary');
  const result = { id, image, status: 'invalid', started: false, terminated: false,
    reason: null, modelRequests: [], control: [], stdout: '', stderr: '' };
  const record = async (name, args) => {
    const response = await cli(containerExecutable, args);
    result.control.push({ name, args, ...response });
    await writeFile(join(runDir, `${name}.json`), json(response), { flag: 'wx' });
    return response;
  };
  try {
    const version = await record('version', ['--version']);
    if (version.code !== 0 || !version.stdout.includes('version 1.4.1 ')) {
      result.reason = 'isolation_unavailable';
      return result;
    }
    // Inspect only; all dependency downloads belong to the explicit preparation step.
    const imageState = await record('image', ['image', 'inspect', image]);
    if (imageState.code !== 0) { result.reason = 'image_unavailable'; return result; }
    if (JSON.parse(imageState.stdout)[0]?.configuration?.descriptor?.digest !== image.split('@')[1]) {
      result.reason = 'image_identity_mismatch'; return result;
    }
    await cp(inputDir, stagedInput, { recursive: true, dereference: false, errorOnExist: true, force: false });
    await mkdir(workDir, { mode: 0o777 });
    await chmod(workDir, 0o777);
    for (const name of ['home', 'tmp', 'cache']) {
      await mkdir(join(workDir, name), { mode: 0o777 });
      await chmod(join(workDir, name), 0o777);
    }
    await mkdir(boundaryDir);
    await copyFile(policy, join(boundaryDir, 'restrict.py'));
    const mounts = [[stagedInput, '/input', true], [workDir, '/work', false], [boundaryDir, '/boundary', true]];
    if(dependenciesDir) mounts.push([await realpath(dependenciesDir), '/deps', true]);
    if (mounts.some(([path]) => /[,\n\r]/.test(path))) throw new Error('unsupported_mount_path');
    const args = ['create', '--name', id, '--platform', 'linux/arm64', '--cpus', '1', '--memory', '512M',
      '--read-only', '--no-dns', '--cap-drop', 'ALL', '--cap-add', 'SYS_ADMIN', '--cap-add', 'SETUID',
      '--cap-add', 'SETGID', '--cap-add', 'SETPCAP', '--ulimit', 'nofile=128:128', '--ulimit', 'nproc=64:64',
      '--ulimit', 'fsize=8388608:8388608', '--workdir', '/work', '--interactive',
      '--entrypoint', '/usr/bin/unshare'];
    for (const [source, target, readonly] of mounts) {
      args.push('--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`);
    }
    args.push(image, '--net', '--', '/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups',
      '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
      '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work/home', 'TMPDIR=/work/tmp',
      'XDG_CACHE_HOME=/work/cache', '/usr/bin/python3', '-I', '/boundary/restrict.py', ...command);
    await writeFile(join(runDir, 'plan.json'), json({ id, image, command, timeoutMs, mounts,
      model: model ? { maxRequests: model.maxRequests, maxOutputTokens: model.maxOutputTokens } : null, args }), { flag: 'wx' });
    const created = await record('create', args);
    if (created.code !== 0) { result.reason = 'container_create_failed'; return result; }
    const configuration = await record('configuration', ['inspect', id]);
    if (configuration.code !== 0) throw new Error('configuration_unknown');
    const config = JSON.parse(configuration.stdout)[0]?.configuration;
    if (!config?.readOnly || config.ssh || config.virtualization || config.publishedSockets?.length || config.publishedPorts?.length ||
        config.image?.descriptor?.digest !== image.split('@')[1] ||
        mounts.some(([source,destination,readonly])=>!config.mounts?.some(m=>m.source===source&&m.destination===destination&&Boolean(m.options?.includes('ro'))===readonly))) {
      throw new Error('configuration_mismatch');
    }
    result.started = true;
    const execution = await new Promise(resolve => {
      const child = spawn(containerExecutable, ['start', '--attach', '--interactive', id], {
        env: cleanHostEnv(), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let reason = null, stdout = '', stderr = '', pending = '', chain = Promise.resolve();
      let accepted = 0, closed = false;
      const abort = new AbortController();
      const halt = value => {
        if (reason) return;
        reason = value;
        abort.abort(value);
        child.stdin.destroy();
        // A failed controller may leave a helper holding inherited pipe FDs.
        // Do not let pipe EOF delay the independent VM stop/delete path.
        child.stdout.destroy();
        child.stderr.destroy();
        // Killing the client is not termination confirmation; stop/delete below is mandatory.
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => halt('timeout'), timeoutMs);
      const onAbort = () => halt('cancelled');
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      child.stdin.on('error', () => {});
      child.on('error', () => halt('execution_start_failed'));
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 1_048_576) halt('output_limit');
      });
      child.stdout.on('data', chunk => {
        stdout += chunk; pending += chunk;
        if (Buffer.byteLength(stdout) > limits.totalBytes || Buffer.byteLength(pending) > limits.lineBytes) return halt('output_limit');
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.startsWith('{')) continue;
          let request;
          try { request = JSON.parse(line); } catch { continue; }
          if (request.kind !== 'model.request') continue;
          chain = chain.then(async () => {
            if (closed || reason) return;
            if (!model || Object.keys(request).sort().join(',') !== 'id,input,kind,maxOutputTokens' ||
                !Number.isSafeInteger(request.id) || request.id !== accepted + 1 ||
                typeof request.input !== 'string' || Buffer.byteLength(request.input) > limits.inputBytes ||
                !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
                request.maxOutputTokens > model.maxOutputTokens || accepted >= model.maxRequests) return halt('model_request_denied');
            accepted += 1;
            const attempt = { id: request.id, maxOutputTokens: request.maxOutputTokens, status: 'started' };
            result.modelRequests.push(attempt);
            try {
              // Trusted callback maps to the existing provider seam in #21. No guest URL,
              // credential, path, model selection, shell command or method is accepted.
              const response = await model.request({ input: request.input, maxOutputTokens: request.maxOutputTokens, signal: abort.signal });
              if (closed || reason) return;
              if (typeof response !== 'string' || Buffer.byteLength(response) > limits.responseBytes) throw new Error('invalid_provider_response');
              attempt.status = 'completed';
              if (!closed && !reason) child.stdin.write(JSON.stringify({ kind: 'model.response', id: request.id, output: response }) + '\n');
            } catch { if (!closed) { attempt.status = 'unknown'; halt('model_provider_error'); } }
          });
        }
      });
      child.on('close', code => {
        closed = true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort);
        abort.abort('execution_ended');
        for (const attempt of result.modelRequests) if (attempt.status === 'started') attempt.status = 'unknown';
        // A stuck provider must not prevent the boundary from terminating the VM.
        resolve({ code, reason, stdout: stdout.slice(0, limits.totalBytes), stderr: stderr.slice(0, 1_048_576) });
      });
    });
    Object.assign(result, execution);
    result.status = execution.reason ? 'failed' : execution.code === 0 ? 'completed' : 'failed';
    result.reason = execution.reason ?? (execution.code === 0 ? null : 'execution_error');
  } catch (error) {
    result.status = 'invalid'; result.reason = error.message;
  } finally {
    if (result.control.some(entry => entry.name === 'create')) {
      try {
        const stop = await record('stop', ['stop', '--time', '1', id]);
        const inspected = await record('stopped', ['inspect', id]);
        const state = inspected.code === 0 ? JSON.parse(inspected.stdout)[0]?.status?.state : null;
        const deleted = await record('delete', ['delete', id]);
        const listed = await record('absence', ['list', '--all', '--format', 'json']);
        const absent = listed.code === 0 && !JSON.parse(listed.stdout).some(item => item.id === id);
        result.terminated = stop.code === 0 && state === 'stopped' && deleted.code === 0 && absent;
      } catch { result.terminated = false; }
      if (!result.terminated) { result.status = 'invalid'; result.reason = 'termination_unconfirmed'; }
    }
    await writeFile(join(runDir, 'outcome.json'), json(result), { flag: 'wx' });
    if (result.terminated) stopped.set(result, workDir);
  }
  return result;
}

export async function exportStopped(execution, names, destination, limits) {
  if (!stopped.has(execution) || execution.status === 'invalid') throw new Error('termination_not_verified');
  return exportRegularFiles(stopped.get(execution), names, destination, limits?.maxBytes, limits?.maxFiles);
}
