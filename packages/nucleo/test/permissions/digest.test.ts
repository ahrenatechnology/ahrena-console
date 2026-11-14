// The digest that binds an answer to its session and call (#618/AC-1). Pure: no disk, no socket, no clock.
// The vectors in digest-vectors.json are shared with the plugin hook (#620), so both sides never diverge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { canonicalJson, digestOf } from '../../src/permissions/digest.ts';

interface Vector {
  name: string;
  input: { sessionId: string; toolName: string; toolInput: unknown; cwd: string };
  canonical: string;
  sha256: string;
}
const vectors = JSON.parse(readFileSync(new URL('./digest-vectors.json', import.meta.url), 'utf8')) as Vector[];

describe('digestOf (#618/AC-1)', () => {
  for (const v of vectors) {
    test(`#618/AC-1: shared vector, ${v.name}`, async () => {
      assert.equal(canonicalJson(v.input), v.canonical);
      assert.equal(await digestOf(v.input), v.sha256);
    });
  }

  test('#618/AC-1: the digest is a lowercase SHA-256 hex', async () => {
    assert.match(await digestOf({ sessionId: 'S', toolName: 'Bash', toolInput: {}, cwd: '/w' }), /^[0-9a-f]{64}$/);
  });

  test('#618/AC-1: an answer meant for another session, tool, input or cwd does not share the digest', async () => {
    const base = { sessionId: 'S', toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/w' };
    const d = await digestOf(base);
    for (const other of [{ sessionId: 'T' }, { toolName: 'Read' }, { toolInput: { command: 'ls -a' } }, { cwd: '/x' }]) {
      assert.notEqual(await digestOf({ ...base, ...other }), d, JSON.stringify(other));
    }
  });

  test('#618/AC-1: key order in the input does not change the digest', async () => {
    const a = await digestOf({ sessionId: 'S', toolName: 'Edit', toolInput: { a: 1, b: { c: 2, d: 3 } }, cwd: '/w' });
    const b = await digestOf({ cwd: '/w', toolInput: { b: { d: 3, c: 2 }, a: 1 }, toolName: 'Edit', sessionId: 'S' });
    assert.equal(a, b);
  });

  test('#618/AC-1: undefined keys are dropped, an undefined input reads as null', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson(undefined), 'null');
    assert.equal(canonicalJson([undefined, 1]), '[null,1]');
  });

  test('#618/AC-1: only the four bound fields count: an extra field is not hashed', async () => {
    const base = { sessionId: 'S', toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/w' };
    assert.equal(await digestOf({ ...base, permissionMode: 'default' } as typeof base), await digestOf(base));
  });
});
