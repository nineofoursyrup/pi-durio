#!/usr/bin/env python3
"""Credential parser/file policy fixtures only. Never accesses the real api.env."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest import mock

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('launch', here / 'launch.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = []
with tempfile.TemporaryDirectory(prefix='durio-usd3-credential-') as temporary:
    root = Path(temporary)
    credential = root / 'fixture.env'
    module.CREDENTIAL_PATH = str(credential)

    def check(name, text, accepted=False, mode=0o600):
        credential.write_text(text)
        credential.chmod(mode)
        try:
            value = module.load_key()
            ok = accepted and value == 'offline-fixture-only'
        except Exception:
            ok = not accepted
        assert ok, name
        rows.append({'name': name, 'status': 'PASS'})

    check('plain', 'DEEPSEEK_API_KEY=offline-fixture-only\n', True)
    check('quoted-comment', '# fixture\nDEEPSEEK_API_KEY="offline-fixture-only"\n', True)
    check('empty', 'DEEPSEEK_API_KEY=\n')
    check('other-variable', 'OTHER_SECRET=offline-fixture-only\n')
    check('duplicate', 'DEEPSEEK_API_KEY=offline-fixture-only\nDEEPSEEK_API_KEY=offline-fixture-only\n')
    check('command-substitution', 'DEEPSEEK_API_KEY=$(touch /tmp/never-execute-credential)\n')
    check('shell-source', 'export DEEPSEEK_API_KEY=offline-fixture-only\n')
    check('insecure-permissions', 'DEEPSEEK_API_KEY=offline-fixture-only\n', mode=0o644)
    check('oversized', '#' * 5000)
    credential.unlink()
    target = root / 'target.env'
    target.write_text('DEEPSEEK_API_KEY=offline-fixture-only\n')
    target.chmod(0o600)
    credential.symlink_to(target)
    try:
        module.load_key()
        raise AssertionError('symlink accepted')
    except OSError:
        rows.append({'name': 'symlink-denied', 'status': 'PASS'})
    credential.unlink()
    credential.mkdir()
    try:
        module.load_key()
        raise AssertionError('directory accepted')
    except (ValueError, OSError):
        rows.append({'name': 'non-regular-denied', 'status': 'PASS'})
    credential.rmdir()
    credential.write_text('DEEPSEEK_API_KEY=offline-fixture-only\n')
    credential.chmod(0o600)
    with mock.patch.object(module.os, 'getuid', return_value=os.getuid() + 1):
        try:
            module.load_key()
            raise AssertionError('wrong owner accepted')
        except ValueError:
            rows.append({'name': 'wrong-owner-denied', 'status': 'PASS'})
result = {'status': 'PASS', 'cases': len(rows), 'rows': rows, 'scope': 'Only temporary literal fixture credentials; real api.env never read; no key values, lengths or hashes retained'}
with Path(sys.argv[1]).open('x') as stream:
    json.dump(result, stream, indent=2)
    stream.write('\n')
print(json.dumps({'status': result['status'], 'cases': result['cases']}))
