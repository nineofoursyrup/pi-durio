#!/usr/bin/env python3
"""Fixed credential source; preflight first, then replace this process with Node."""
import os
import pathlib
import re
import stat
import subprocess
import sys

NODE = '/opt/homebrew/Cellar/node/26.8.2/bin/node'
CREDENTIAL_PATH = '/Users/nineofour/Durio/api.env'
ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'frozen-manifest.json'
GRANT = ROOT / 'explicit-human-grant.json'


def load_key():
    # O_NOFOLLOW plus fstat checks the opened object without a path-check race.
    fd = os.open(CREDENTIAL_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('invalid credential file')
        raw = os.read(fd, 4097)
        if len(raw) > 4096:
            raise ValueError('invalid credential file')
    finally:
        os.close(fd)
    lines = [line.strip() for line in raw.decode('utf-8').splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if len(lines) != 1:
        raise ValueError('invalid credential file')
    match = re.fullmatch(r'DEEPSEEK_API_KEY\s*=\s*([\'\"]?)([A-Za-z0-9._-]+)\1', lines[0])
    if not match:
        raise ValueError('invalid credential file')
    return match.group(2)


def main():
    if len(sys.argv) != 1:
        print('LAUNCH_DENIED: fixed manifest, grant and credential source; no arguments', file=sys.stderr)
        return 1
    env = dict(os.environ)
    for name in ['DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']:
        env.pop(name, None)
    try:
        result = subprocess.run([NODE, str(ROOT / 'harness/preflight.mjs'), str(MANIFEST), str(GRANT)], env=env, check=False)
    except Exception:
        print('LAUNCH_DENIED: preflight unavailable', file=sys.stderr)
        return 1
    if result.returncode != 0:
        return result.returncode if result.returncode > 0 else 128 - result.returncode
    try:
        env['DEEPSEEK_API_KEY'] = load_key()
    except Exception:
        # Never expose the value, length, hash, contents, or parser exception.
        print('LAUNCH_DENIED: credential file missing or invalid', file=sys.stderr)
        return 1
    try:
        os.execve(NODE, [NODE, str(ROOT / 'harness/run.mjs'), str(MANIFEST), str(GRANT)], env)
    except Exception:
        print('LAUNCH_DENIED: runner execution unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
