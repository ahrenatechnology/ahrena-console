/* The real runner passes an entry's environment to the command (issue 722, epic 720): `ps` prints the start in UTC. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { systemRunner } from './system.ts';

describe('systemRunner', () => {
  test('#720/AC-2 Given an entry that sets TZ, Then the command sees it, over LC_ALL=C', async () => {
    const r = await systemRunner('sh', ['-c', 'printf "%s %s" "$TZ" "$LC_ALL"'], { timeoutMs: 5_000, maxBytes: 1024, signal: new AbortController().signal, env: { TZ: 'UTC' } });
    assert.deepEqual(r, { ok: true, stdout: 'UTC C' });
  });
});
