import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expectedSourceInputs } from '../src/improve-build.js';

test('build input correspondence follows added and removed physical lines, preserving legacy fields', () => {
  const input = { path: 'src/example.ts', sha256: 'old', bytes: 12, physicalLines: 2 };
  for (const [text, lines] of [['// comment\n\nexport {};\n', 3], ['export {};', 1], ['', 0], ['\r\n', 1]] as const) {
    const bytes = Buffer.from(text);
    assert.deepEqual(expectedSourceInputs([input], new Map([[input.path, bytes]])), [{ ...input, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, physicalLines: lines }]);
  }
  const legacy = { path: input.path, sha256: 'old', bytes: 12 };
  assert.deepEqual(expectedSourceInputs([legacy], new Map([[input.path, Buffer.from('a\nb\nc')]])), [{ path: input.path, sha256: createHash('sha256').update('a\nb\nc').digest('hex'), bytes: 5 }]);
  assert.deepEqual(expectedSourceInputs([input], new Map()), [input]);
});

test('the emitted manifest records physical lines on every input and leaves compiler/output entries unchanged', () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('dist/execution/source-build.json', root), 'utf8'));
  for (const input of manifest.inputs) {
    const text = readFileSync(new URL(input.path, root), 'utf8');
    const expected = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    assert.equal(input.physicalLines, expected, input.path);
  }
  assert.ok(manifest.compiler.every((f: any) => f.physicalLines === undefined));
  assert.ok(manifest.outputs.every((f: any) => f.physicalLines === undefined));
});
