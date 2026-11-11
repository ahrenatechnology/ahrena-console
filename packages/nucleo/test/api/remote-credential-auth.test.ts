// Decision 0020 (#388), layer 1: the core of a remote machine issues a short credential to its owner and verifies
// the signed requests that carry it. AC1: no proof, no data, no action; AC2: a restarted core refuses the old
// proof; AC4: replay, clock, wrong core, eviction. The CLI half is in test/owner/remote-credential-cli.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DOCKER_ACTIONS } from '../../src/docker/catalog.ts';
import { CLOCK_WINDOW_MS, CREDENTIAL_TTL_MS } from '../../src/api/remote-credentials.ts';
import { ISSUE, OWNER, call, echoBody, hex, remoteFixture, signHeader } from './remote-credential-fixture.ts';

const passed = (status: number) => status !== 401 && status !== 403;

describe('AC1 · no proof, no data, no action', () => {
  test('AC1 a list route without Authorization is 403 owner-auth-required', async () => {
    const f = await remoteFixture();
    try {
      for (const path of ['/api/telemetry', '/api/attention', '/api/connectors', '/api/wall']) {
        assert.equal((await call(f.url, path)).status, 403, path);
      }
    } finally { await f.close(); }
  });

  test('AC1 a valid signature with a forged Origin is 403, and the Origin never replaces the proof', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const header = signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now });
      for (const origin of [`http://${f.host}`, 'http://127.0.0.1:4720', 'null', 'http://evil.example']) {
        const r = await call(f.url, '/api/wall', 'GET', { authorization: header, origin });
        assert.equal(r.status, 403, origin);
        assert.equal(r.json?.reason, undefined, 'the Origin refusal is the generic owner text');
      }
      // The refusals changed nothing: the same signature, without the Origin, still passes once.
      assert.equal((await call(f.url, '/api/wall', 'GET', { authorization: header })).status, 200);
      assert.equal((await call(f.url, '/api/wall', 'GET', { origin: `http://${f.host}` })).status, 403);
    } finally { await f.close(); }
  });

  test('AC1 a signature for GET /api/telemetry cannot be reused on POST login or any other target', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const header = signHeader(c, { method: 'GET', target: '/api/telemetry', host: f.host, ts: f.clock.now });
      const login = '/api/connectors/aws/sessions/dev/login';
      const asPost = await call(f.url, login, 'POST', { authorization: header }, '{"mode":"device-code"}');
      assert.equal(asPost.status, 401);
      assert.equal(asPost.json?.reason, 'credential-signature');
      assert.equal((await call(f.url, '/api/attention', 'GET', { authorization: header })).status, 401);
      assert.equal((await call(f.url, '/api/telemetry', 'POST', { authorization: header })).status, 401);
    } finally { await f.close(); }
  });

  test('AC1 the body is signed: the same signature with another body is refused', async () => {
    const f = await remoteFixture({ api: { ports: { handle: echoBody('events'), acceptNoOrigin: () => true } } });
    try {
      const c = await f.mint();
      const target = '/api/ports/release';
      const header = signHeader(c, { method: 'POST', target, host: f.host, ts: f.clock.now, body: '{"port":3000,"pid":42,"signal":"TERM"}' });
      const r = await call(f.url, target, 'POST', { authorization: header }, '{"port":3000,"pid":43,"signal":"TERM"}');
      assert.equal(r.status, 401);
      assert.equal(r.json?.reason, 'credential-signature');
    } finally { await f.close(); }
  });

  test('AC1 a route outside the list is 403 credential-route even with a valid signature, the issue route included', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      for (const [method, target] of [['GET', '/api/changes'], ['GET', '/api/runtime/stream'], ['POST', '/api/new-session'], ['GET', '/mcp'], ['POST', ISSUE], ['GET', '/api/telemetry/'], ['GET', '/api/machines']] as const) {
        const body = method === 'POST' ? JSON.stringify({ version: 1, nonce: hex(16) }) : undefined;
        const r = await f.signed(c, method, target, { body });
        assert.equal(r.status, 403, `${method} ${target}`);
        assert.equal(r.json?.reason, 'credential-route', `${method} ${target}`);
      }
      assert.equal(f.store.liveCount(), 1, 'a credential cannot issue another');
    } finally { await f.close(); }
  });

  test('AC1 an action route with a valid signature is 403 without accept-remote-actions, and runs with it', async () => {
    const action = DOCKER_ACTIONS[0];
    const body = JSON.stringify({ target: null, planDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
    const routes = [
      ['POST', '/api/ports/release', '{"port":3000,"pid":42,"signal":"TERM"}'],
      ['POST', `/api/docker/actions/${action}`, body],
      ['POST', '/api/terminals/pts-3/actions/interrupt', '{"pid":42}'],
      ['DELETE', '/api/tools/jobs/0123456789ab', ''],
    ] as const;
    const off = await remoteFixture();
    try {
      const c = await off.mint();
      for (const [method, target, b] of routes) {
        const r = await off.signed(c, method, target, { body: b || undefined });
        assert.equal(r.status, 403, `${method} ${target}`);
      }
    } finally { await off.close(); }

    const stub = (read: 'events' | 'iterator') => echoBody(read);
    const on = await remoteFixture({
      api: {
        ports: { handle: stub('events'), acceptNoOrigin: () => true },
        docker: { route: stub('iterator'), acceptNoOrigin: () => true },
      },
    });
    try {
      const c = await on.mint();
      const ports = await on.signed(c, 'POST', '/api/ports/release', { body: routes[0][2] });
      assert.equal(ports.status, 200);
      assert.equal(ports.json?.echoed, routes[0][2], 'the body reaches the route intact (events)');
      const docker = await on.signed(c, 'POST', `/api/docker/actions/${action}`, { body });
      assert.equal(docker.status, 200);
      assert.equal(docker.json?.echoed, body, 'the body reaches the route intact (async iterator)');
      // The terminals and tools options are still off on this núcleo: those stay closed.
      assert.equal((await on.signed(c, 'POST', '/api/terminals/pts-3/actions/interrupt', { body: '{"pid":42}' })).status, 403);
    } finally { await on.close(); }
  });

  test('AC1 issue without the owner bearer, or with an Origin, or by a signed proof, is 403', async () => {
    const f = await remoteFixture();
    try {
      const body = JSON.stringify({ version: 1, nonce: hex(16) });
      assert.equal((await call(f.url, ISSUE, 'POST', {}, body)).status, 403);
      assert.equal((await call(f.url, ISSUE, 'POST', { authorization: `Bearer ${'b'.repeat(64)}` }, body)).status, 403);
      assert.equal((await call(f.url, ISSUE, 'POST', { authorization: `Bearer ${OWNER}`, origin: `http://${f.host}` }, body)).status, 403);
      assert.equal((await call(f.url, ISSUE, 'POST', { authorization: `Bearer ${OWNER}`, host: 'evil.example' }, body)).status, 403);
      assert.equal(f.store.liveCount(), 0);
      const nobody = await remoteFixture({ token: null });
      try { assert.equal((await call(nobody.url, ISSUE, 'POST', { authorization: `Bearer ${OWNER}` }, body)).status, 403); } finally { await nobody.close(); }
    } finally { await f.close(); }
  });

  test('AC1 issue answers the documented fields, only JSON under 1 KiB, only POST', async () => {
    const f = await remoteFixture();
    try {
      const bearer = { authorization: `Bearer ${OWNER}` };
      const nonce = hex(16);
      const ok = await call(f.url, ISSUE, 'POST', bearer, JSON.stringify({ version: 1, nonce }));
      assert.equal(ok.status, 200);
      assert.deepEqual(Object.keys(ok.json!).sort(), ['corePid', 'corePort', 'credentialId', 'expiresAt', 'generation', 'issuedAt', 'key', 'machineIdentity', 'nonce', 'uid', 'version']);
      assert.equal(ok.json?.nonce, nonce);
      assert.equal(ok.json?.corePort, f.port);
      assert.equal(ok.json?.generation, f.store.generation);
      assert.equal(ok.json?.expiresAt, f.clock.now + CREDENTIAL_TTL_MS);
      assert.match(String(ok.json?.key), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(ok.headers['cache-control'], 'no-store');
      assert.equal((await call(f.url, ISSUE, 'GET', bearer)).status, 405);
      assert.equal((await call(f.url, ISSUE, 'POST', { ...bearer, 'content-type': 'text/plain' }, '{}')).status, 415);
      assert.equal((await call(f.url, ISSUE, 'POST', bearer, JSON.stringify({ version: 1, nonce, pad: 'x'.repeat(1100) }))).status, 413);
      for (const bad of [{ version: 2, nonce }, { version: 1, nonce: 'short' }, { version: 1, nonce, revoke: ['x'] }, { version: 1, nonce, extra: 1 }, { version: 1, nonce, revoke: [hex(16), hex(16), hex(16), hex(16)] }]) {
        assert.equal((await call(f.url, ISSUE, 'POST', bearer, JSON.stringify(bad))).status, 400, JSON.stringify(bad));
      }
      assert.equal((await call(f.url, `${ISSUE}?x=1`, 'POST', bearer, JSON.stringify({ version: 1, nonce }))).status, 404);
    } finally { await f.close(); }
  });

  test('AC1 a changed query is a rejected signature; a parameter outside the accepted set is 403 credential-route', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const header = signHeader(c, { method: 'GET', target: '/api/wall?parkedLimit=5', host: f.host, ts: f.clock.now });
      for (const target of ['/api/wall', '/api/wall?parkedLimit=6', '/api/wall?parkedLimit=5&x=1', '/api/wall?parkedLimit=5&']) {
        const r = await call(f.url, target, 'GET', { authorization: header });
        assert.equal(r.status, 401, target);
        assert.equal(r.json?.reason, 'credential-signature', target);
      }
      const unknown = await f.signed(c, 'GET', '/api/wall?parkedLimit=5&refresh=1');
      assert.equal(unknown.status, 403);
      assert.equal(unknown.json?.reason, 'credential-route');
      assert.equal((await f.signed(c, 'GET', '/api/wall?parkedLimit=5&parkedLimit=6')).status, 403, 'a repeated parameter');
      assert.equal((await f.signed(c, 'GET', '/api/telemetry?hours=12')).status, 403, 'no parameters on telemetry');
      assert.equal((await f.signed(c, 'GET', '/api/wall?parkedLimit=5')).status, 200, 'the signed one still passes');
      assert.equal(passed((await f.signed(c, 'GET', '/api/sessions/abc/conversation?before=7')).status), true);
      assert.equal((await f.signed(c, 'GET', '/api/sessions/abc?a%20b=1')).status, 403);
    } finally { await f.close(); }
  });

  test('AC1 a different Host cannot borrow a proof signed for this one', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const header = signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now });
      assert.equal((await call(f.url, '/api/wall', 'GET', { authorization: header, host: `localhost:${f.port}` })).status, 401);
      assert.equal((await call(f.url, '/api/wall', 'GET', { authorization: header, host: 'evil.example' })).status, 403);
    } finally { await f.close(); }
  });

  test('AC1 a malformed AhrenaRemote header is credential-unknown, never an echo', async () => {
    const f = await remoteFixture();
    try {
      for (const authorization of ['AhrenaRemote x', 'AhrenaRemote id=zz, ts=1, nonce=a, sig=b', `AhrenaRemote id=${hex(16)},ts=1,nonce=${hex(16)},sig=${hex(32)}`]) {
        const r = await call(f.url, '/api/wall', 'GET', { authorization });
        assert.equal(r.status, 401);
        assert.equal(r.json?.reason, 'credential-unknown');
        assert.ok(!r.text.includes('AhrenaRemote'));
      }
    } finally { await f.close(); }
  });
});

describe('AC2 · the old proof is refused after a restart or a revoke (remote side)', () => {
  test('AC2 a restart (new generation) makes every old credential credential-unknown; a new one works', async () => {
    const f = await remoteFixture();
    try {
      const old = await f.mint();
      assert.equal((await f.signed(old, 'GET', '/api/wall')).status, 200);
      f.store.restart();
      const r = await f.signed(old, 'GET', '/api/wall');
      assert.equal(r.status, 401);
      assert.equal(r.json?.reason, 'credential-unknown');
      const fresh = await f.mint();
      assert.notEqual(fresh.generation, old.generation);
      assert.equal((await f.signed(fresh, 'GET', '/api/wall')).status, 200);
    } finally { await f.close(); }
  });

  test('AC2 a new process (a new table) knows none of the old ids', async () => {
    const before = await remoteFixture();
    const old = await before.mint();
    await before.close();
    const after = await remoteFixture();
    try {
      const r = await after.signed(old, 'GET', '/api/wall');
      assert.equal(r.status, 401);
      assert.equal(r.json?.reason, 'credential-unknown');
    } finally { await after.close(); }
  });

  test('AC2 revoke at issue drops the listed ids before the new one exists', async () => {
    const f = await remoteFixture();
    try {
      const a = await f.mint();
      const b = await f.mint();
      const c = await f.mint({ revoke: [a.credentialId] });
      assert.equal((await f.signed(a, 'GET', '/api/wall')).json?.reason, 'credential-unknown');
      assert.equal((await f.signed(b, 'GET', '/api/wall')).status, 200);
      assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
      assert.equal(f.store.liveCount(), 2);
    } finally { await f.close(); }
  });

  test('AC2 past expiresAt the credential is credential-expired, and later credential-unknown', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      f.clock.now += CREDENTIAL_TTL_MS + 1;
      const r = await f.signed(c, 'GET', '/api/wall');
      assert.equal(r.status, 401);
      assert.equal(r.json?.reason, 'credential-expired');
      await f.mint(); // a later issue forgets what expired more than one TTL ago
      f.clock.now += CREDENTIAL_TTL_MS + 1;
      await f.mint();
      assert.equal((await f.signed(c, 'GET', '/api/wall')).json?.reason, 'credential-unknown');
    } finally { await f.close(); }
  });

  test('AC2 a restart comes back served: the same machine identity and uid, another generation', async () => {
    const f = await remoteFixture();
    try {
      const a = await f.mint();
      f.store.restart();
      const b = await f.mint();
      assert.equal(a.machineIdentity, b.machineIdentity);
      assert.equal(a.uid, b.uid);
      assert.notEqual(a.generation, b.generation);
    } finally { await f.close(); }
  });
});

describe('AC4 · replay, clock, wrong core, eviction', () => {
  test('AC4 the same nonce twice is 403 credential-replayed; a bad signature does not burn a nonce', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const nonce = hex(16);
      assert.equal((await f.signed(c, 'GET', '/api/wall', { nonce })).status, 200);
      const again = await f.signed(c, 'GET', '/api/wall', { nonce });
      assert.equal(again.status, 403);
      assert.equal(again.json?.reason, 'credential-replayed');
      // A forged request that reuses a fresh nonce with a wrong key leaves the nonce free for the real one.
      const fresh = hex(16);
      const forged = signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now, nonce: fresh, key: 'wrong' });
      assert.equal((await call(f.url, '/api/wall', 'GET', { authorization: forged })).status, 401);
      assert.equal((await f.signed(c, 'GET', '/api/wall', { nonce: fresh })).status, 200);
    } finally { await f.close(); }
  });

  test('AC4 a nonce is forgotten after its window, so the memory does not grow with time', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const nonce = hex(16);
      assert.equal((await f.signed(c, 'GET', '/api/wall', { nonce })).status, 200);
      f.clock.now += 3 * CLOCK_WINDOW_MS;
      // Same nonce, but the request is now older than the window: the clock check says so first.
      const stale = await f.signed(c, 'GET', '/api/wall', { nonce, ts: f.clock.now - 3 * CLOCK_WINDOW_MS });
      assert.equal(stale.json?.reason, 'credential-clock');
      assert.equal((await f.signed(c, 'GET', '/api/wall', { nonce })).status, 200, 'a fresh request may use the number again');
    } finally { await f.close(); }
  });

  test('AC4 ts outside 10 s is 401 credential-clock, either way', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      for (const delta of [-CLOCK_WINDOW_MS - 1, CLOCK_WINDOW_MS + 1, -3_600_000, 3_600_000]) {
        const r = await f.signed(c, 'GET', '/api/wall', { ts: f.clock.now + delta });
        assert.equal(r.status, 401, String(delta));
        assert.equal(r.json?.reason, 'credential-clock', String(delta));
      }
      assert.equal((await f.signed(c, 'GET', '/api/wall', { ts: f.clock.now - CLOCK_WINDOW_MS })).status, 200);
      assert.equal((await f.signed(c, 'GET', '/api/wall', { ts: f.clock.now + CLOCK_WINDOW_MS })).status, 200);
    } finally { await f.close(); }
  });

  test('AC4 10 001 bad-signature requests with a valid id are 401 each, and then a correct request passes', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      let wrong = 0;
      const batch = 50;
      for (let sent = 0; sent < 10_001; sent += batch) {
        const n = Math.min(batch, 10_001 - sent);
        const rs = await Promise.all(Array.from({ length: n }, () => call(f.url, '/api/wall', 'GET', { authorization: signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now, key: 'not-the-key' }) })));
        for (const r of rs) if (r.status === 401) wrong++;
      }
      assert.equal(wrong, 10_001);
      const ok = await f.signed(c, 'GET', '/api/wall');
      assert.equal(ok.status, 200);
    } finally { await f.close(); }
  });

  test('AC4 the nonce memory is capped per credential: past the cap the answer is 429, never a replay of an old nonce', async () => {
    const f = await remoteFixture({ store: { maxNonces: 3 } });
    try {
      const c = await f.mint();
      for (let i = 0; i < 3; i++) assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
      const over = await f.signed(c, 'GET', '/api/wall');
      assert.equal(over.status, 429);
      assert.equal(over.json?.reason, 'credential-busy');
      f.clock.now += 2 * CLOCK_WINDOW_MS + 1;
      assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
    } finally { await f.close(); }
  });

  test('AC4 a credential minted by core A is rejected by core B', async () => {
    const a = await remoteFixture();
    const b = await remoteFixture();
    try {
      const fromA = await a.mint();
      assert.equal((await a.signed(fromA, 'GET', '/api/wall')).status, 200);
      const header = signHeader(fromA, { method: 'GET', target: '/api/wall', host: b.host, ts: b.clock.now });
      const r = await call(b.url, '/api/wall', 'GET', { authorization: header });
      assert.equal(r.status, 401);
      assert.equal(r.json?.reason, 'credential-unknown');
      assert.notEqual(a.store.generation, b.store.generation);
    } finally { await a.close(); await b.close(); }
  });

  test('AC4 a credential of another uid or generation is refused even if its id is in the table', async () => {
    const f = await remoteFixture({ store: { uid: 1234 } });
    try {
      const c = await f.mint();
      assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
      const other = await remoteFixture({ store: { uid: 4321, generation: f.store.generation } });
      try {
        assert.equal((await call(other.url, '/api/wall', 'GET', { authorization: signHeader(c, { method: 'GET', target: '/api/wall', host: other.host, ts: other.clock.now }) })).json?.reason, 'credential-unknown');
      } finally { await other.close(); }
    } finally { await f.close(); }
  });

  test('AC4 a 4th issue evicts the oldest; the three newest stay live', async () => {
    const f = await remoteFixture();
    try {
      const [one, two, three, four] = [await f.mint(), await f.mint(), await f.mint(), await f.mint()];
      assert.equal(f.store.liveCount(), 3);
      assert.equal((await f.signed(one, 'GET', '/api/wall')).json?.reason, 'credential-unknown');
      for (const c of [two, three, four]) assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
    } finally { await f.close(); }
  });

  test('AC4 the id is checked first: an unknown id with a bad Origin-free signature is credential-unknown and changes no state', async () => {
    const f = await remoteFixture();
    try {
      const c = await f.mint();
      const ghost = { ...c, credentialId: hex(16) };
      assert.equal((await f.signed(ghost, 'GET', '/api/wall')).json?.reason, 'credential-unknown');
      assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
    } finally { await f.close(); }
  });
});
