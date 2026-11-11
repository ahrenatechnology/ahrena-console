// "Tentar agora" on the owner-proof bands (#388, decision 0020, wireframes 388-2 and 388-4): the local route
// `POST /api/machines/<id>/owner-proof/retry` asks the core to request the remote owner's proof now and read the
// machine again. It sits behind the owner gate (#302) and the Origin checks like the other local writes, it is
// never on the remote credential's closed list, and it answers only the machine's state and reason.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { remoteRouteFor } from '../../src/api/owner-auth.ts';
import { OWNER_PROOF_RETRY_ROUTE, ownerProofRetryPath } from '../../src/api/owner-proof-retry.ts';
import type { MachineStatus } from '../../src/telemetry/service.ts';
import { call, OWNER, remoteFixture } from './remote-credential-fixture.ts';

const SENTINEL = 'sentinel-key-9a8b7c6d5e4f';
const PATH = '/api/machines/ws-exemplo/owner-proof/retry';

async function boot() {
  const calls: string[] = [];
  const f = await remoteFixture({
    api: {
      ownerProofRetry: async (id: string) => {
        calls.push(id);
        if (id !== 'ws-exemplo') return null;
        // Anything beyond state and reason must never reach the answer.
        return { state: 'unreachable', reason: 'owner-auth-failed', version: null, credential: SENTINEL, key: SENTINEL } as unknown as MachineStatus;
      },
    },
  });
  return { f, calls };
}

describe('AC1 · Tentar agora, the local route', () => {
  test('AC1 the owner (bearer, no Origin) and the /ui (bearer, its own Origin) start one retry and get only state and reason', async () => {
    const { f, calls } = await boot();
    try {
      assert.equal(ownerProofRetryPath('ws-exemplo'), PATH);
      assert.ok(OWNER_PROOF_RETRY_ROUTE.test(PATH));
      for (const headers of [{ authorization: `Bearer ${OWNER}` }, { authorization: `Bearer ${OWNER}`, origin: `http://${f.host}` }]) {
        const r = await call(f.url, PATH, 'POST', headers, '{}');
        assert.equal(r.status, 200, JSON.stringify(headers));
        assert.deepEqual(r.json, { machine: { id: 'ws-exemplo', state: 'unreachable', reason: 'owner-auth-failed' } });
        assert.ok(!r.text.includes(SENTINEL), 'AC3: no credential material in the answer');
      }
      assert.deepEqual(calls, ['ws-exemplo', 'ws-exemplo']);
    } finally {
      await f.close();
    }
  });

  test('AC1 without the owner bearer, or with a forged Origin, the route is refused and nothing runs', async () => {
    const { f, calls } = await boot();
    try {
      assert.equal((await call(f.url, PATH, 'POST', {}, '{}')).status, 403);
      assert.equal((await call(f.url, PATH, 'POST', { authorization: `Bearer ${'b'.repeat(64)}` }, '{}')).status, 403);
      for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:4720']) {
        assert.equal((await call(f.url, PATH, 'POST', { authorization: `Bearer ${OWNER}`, origin }, '{}')).status, 403, origin);
      }
      assert.deepEqual(calls, []);
    } finally {
      await f.close();
    }
  });

  test('AC1 the route is never on the remote credential closed list: a valid AhrenaRemote proof gets credential-route', async () => {
    assert.equal(remoteRouteFor('POST', PATH), null);
    const { f, calls } = await boot();
    try {
      const c = await f.mint();
      const r = await f.signed(c, 'POST', PATH, { body: '{}' });
      assert.equal(r.status, 403);
      assert.equal(r.json?.reason, 'credential-route');
      assert.deepEqual(calls, []);
    } finally {
      await f.close();
    }
  });

  test('AC1 only POST, only a remote machine id', async () => {
    const { f, calls } = await boot();
    try {
      const auth = { authorization: `Bearer ${OWNER}` };
      assert.equal((await call(f.url, PATH, 'GET', auth)).status, 405);
      assert.equal((await call(f.url, '/api/machines/local/owner-proof/retry', 'POST', auth, '{}')).status, 404);
      assert.equal((await call(f.url, '/api/machines/NOT_AN_ID/owner-proof/retry', 'POST', auth, '{}')).status, 404);
      assert.equal((await call(f.url, '/api/machines/outra/owner-proof/retry', 'POST', auth, '{}')).status, 404);
      assert.deepEqual(calls, ['outra']);
    } finally {
      await f.close();
    }
  });
});
