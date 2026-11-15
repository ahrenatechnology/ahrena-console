// The routes of docs/contracts/permission-requests.md, one test per operation (#618/AC-8). The contract is authored; these
// tests validate the server against it, status by status and key by key. (#618)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { remoteRouteFor } from '../../src/api/owner-auth.ts';
import { settle } from '../permissions/fakes.ts';
import { call as rawCall, remoteFixture } from './remote-credential-fixture.ts';
import { permissionFixture, reqPath, SID, WINDOW_CREDENTIAL } from './permission-fixture.ts';

const LIST_KEYS = ['answeredAt', 'decision', 'expiresAt', 'folder', 'id', 'reason', 'requestedAt', 'state', 'summary', 'terminalOnly', 'tool'];

async function withFixture(run: (f: Awaited<ReturnType<typeof permissionFixture>>) => Promise<void>, over: Parameters<typeof permissionFixture>[0] = {}): Promise<void> {
  const f = await permissionFixture(over);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}

describe('operation 1: POST /api/sessions/:sid/permission-requests (#618/AC-8)', () => {
  test('#618/AC-8: registers and answers 201 { requestId, expiresAt }, and keeps no raw tool input', () =>
    withFixture(async (f) => {
      const r = await f.register({ toolInput: { command: 'echo hello-sentinel-4411' } });
      assert.equal(r.status, 201);
      assert.deepEqual(Object.keys(r.json ?? {}).sort(), ['expiresAt', 'requestId']);
      assert.equal(typeof r.json?.requestId, 'string');
      assert.ok(Number.isFinite(Date.parse(String(r.json?.expiresAt))));
      const stored = JSON.stringify([...f.deps.repository.requests.values()]);
      assert.ok(stored.includes('hello-sentinel-4411'), 'the redacted summary is kept');
      assert.ok(!stored.includes('toolInput'), 'the raw tool input is not a field of what is stored');
    }));

  test('#618/AC-8: a digest that is not the core\'s is 400 digest_mismatch and stores nothing', () =>
    withFixture(async (f) => {
      const r = await f.call('POST', reqPath(SID), { body: { toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/w', permissionMode: 'default', digest: 'a'.repeat(64) } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'digest_mismatch' });
      assert.equal(f.deps.repository.requests.size, 0);
    }));

  test('#618/AC-8: a body over 64 KiB is 413, a body that is not JSON of the shape is 400, other content types 415', () =>
    withFixture(async (f) => {
      const big = await f.call('POST', reqPath(SID), { raw: JSON.stringify({ toolName: 'Bash', toolInput: { command: 'x'.repeat(70_000) }, cwd: '/w', digest: 'a'.repeat(64) }) });
      assert.equal(big.status, 413);
      assert.deepEqual(big.json, { error: 'too_large' });
      for (const body of [{ toolName: 5, toolInput: {}, cwd: '/w', digest: 'a'.repeat(64) }, { toolName: 'Bash', cwd: '/w', digest: 'a'.repeat(64) }, { toolName: 'Bash', toolInput: {}, cwd: '/w', digest: 'short' }]) {
        const r = await f.call('POST', reqPath(SID), { body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.deepEqual(r.json, { error: 'invalid_request' });
      }
      assert.equal((await f.call('POST', reqPath(SID), { raw: '{nope' })).status, 400);
      assert.equal((await f.call('POST', reqPath(SID), { raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await f.call('POST', reqPath('bad id'), { body: {} })).status, 400);
    }));

  test('#618/AC-8: off is 503 { error: "off" }, before any body is read; a request with Origin or Sec-Fetch-Site is 403 hook_only', () =>
    withFixture(async (f) => {
      f.set({ enabled: false });
      const off = await f.call('POST', reqPath(SID), { body: { toolName: 'Bash' } });
      assert.equal(off.status, 503);
      assert.deepEqual(off.json, { error: 'off' });
      f.set({ enabled: true });
      for (const headers of [{ origin: f.api.url }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' }, { origin: 'http://evil.example' }]) {
        const r = await f.call('POST', reqPath(SID), { body: {}, headers });
        assert.equal(r.status, 403, JSON.stringify(headers));
      }
      const withOrigin = await f.call('POST', reqPath(SID), { body: {}, headers: { origin: f.api.url } });
      assert.deepEqual(withOrigin.json, { error: 'hook_only' });
      assert.equal(f.deps.repository.requests.size, 0);
    }));

  test('#618/AC-8: without the owner bearer the route is 403 and nothing is stored', () =>
    withFixture(async (f) => {
      const r = await f.call('POST', reqPath(SID), { bearer: false, body: {} });
      assert.equal(r.status, 403);
      assert.equal(f.deps.repository.requests.size, 0);
    }));
});

describe('operation 2: GET …/:rid/decision?wait=25 (#618/AC-8)', () => {
  test('#618/AC-8: 200 { requestId, digest, decision, reason, answeredBy, channel } once, then 409', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      assert.equal((await f.answer(SID, rid, { decision: 'deny', reason: 'later' })).status, 200);
      const first = await f.call('GET', reqPath(SID, rid, '/decision?wait=25'));
      assert.equal(first.status, 200);
      assert.deepEqual(Object.keys(first.json ?? {}).sort(), ['answeredBy', 'channel', 'decision', 'digest', 'reason', 'requestId']);
      assert.equal(first.json?.decision, 'deny');
      assert.equal(first.json?.reason, 'later');
      assert.equal(first.json?.channel, 'ui');
      const second = await f.call('GET', reqPath(SID, rid, '/decision?wait=25'));
      assert.equal(second.status, 409);
      assert.deepEqual(second.json, { error: 'already_delivered' });
    }));

  test('#618/AC-8: 204 when the slice ends with no answer, and the wait is the one asked for, at most 25 s', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      const waiting = f.call('GET', reqPath(SID, rid, '/decision?wait=25'));
      await settle();
      await settle();
      await f.deps.clock.advance(25_000);
      const r = await waiting;
      assert.equal(r.status, 204);
      assert.equal(r.text, '');
      const capped = f.call('GET', reqPath(SID, rid, '/decision?wait=900'));
      await settle();
      await settle();
      await f.deps.clock.advance(25_000);
      assert.equal((await capped).status, 204);
      assert.equal((await f.call('GET', reqPath(SID, rid, '/decision'))).status, 204);
    }));

  test('#618/AC-8: the long poll wakes when the owner answers, and it is delivered then', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      const waiting = f.call('GET', reqPath(SID, rid, '/decision?wait=25'));
      await settle();
      await settle();
      assert.equal((await f.answer(SID, rid, { decision: 'allow' })).status, 200);
      const r = await waiting;
      assert.equal(r.status, 200);
      assert.equal(r.json?.decision, 'allow');
    }));

  test('#618/AC-8: 410 for a request that expired, 404 for an unknown id, 503 off, 403 with Origin or Sec-Fetch-Site', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      await f.deps.clock.advance(9 * 60_000 + 30_000);
      const gone = await f.call('GET', reqPath(SID, rid, '/decision?wait=0'));
      assert.equal(gone.status, 410);
      assert.deepEqual(gone.json, { error: 'gone' });
      const unknown = await f.call('GET', reqPath(SID, 'no-such-id', '/decision'));
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, { error: 'not_found' });
      for (const headers of [{ origin: f.api.url }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await f.call('GET', reqPath(SID, rid, '/decision'), { headers })).status, 403, JSON.stringify(headers));
      }
      f.set({ enabled: false });
      const off = await f.call('GET', reqPath(SID, rid, '/decision'));
      assert.equal(off.status, 503);
      assert.deepEqual(off.json, { error: 'off' });
    }));

  test('#618/AC-8: a bad wait is 400 invalid_request', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      for (const wait of ['abc', '-1', '1e3', '']) assert.equal((await f.call('GET', reqPath(SID, rid, `/decision?wait=${wait}`))).status, 400, wait);
    }));
});

describe('operation 3: POST …/:rid/withdraw (#618/AC-8)', () => {
  test('#618/AC-8: 200 { ok: true }, then the decision is 410 and a second withdraw is 410', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      const r = await f.call('POST', reqPath(SID, rid, '/withdraw'));
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
      assert.equal((await f.call('GET', reqPath(SID, rid, '/decision'))).status, 410);
      const again = await f.call('POST', reqPath(SID, rid, '/withdraw'));
      assert.equal(again.status, 410);
      assert.deepEqual(again.json, { error: 'gone' });
    }));

  test('#618/AC-8: 404 unknown, 409 after the delivery, 403 with Origin, 503 off', () =>
    withFixture(async (f) => {
      assert.equal((await f.call('POST', reqPath(SID, 'no-such-id', '/withdraw'))).status, 404);
      const { rid } = await f.register();
      await f.answer(SID, rid, { decision: 'deny' });
      await f.call('GET', reqPath(SID, rid, '/decision'));
      assert.equal((await f.call('POST', reqPath(SID, rid, '/withdraw'))).status, 409);
      assert.equal((await f.call('POST', reqPath(SID, rid, '/withdraw'), { headers: { origin: f.api.url } })).status, 403);
      f.set({ enabled: false });
      assert.equal((await f.call('POST', reqPath(SID, rid, '/withdraw'))).status, 503);
    }));
});

describe('operation 4: GET /api/sessions/:sid/permission-requests (#618/AC-8)', () => {
  test('#618/AC-8: the list is { available, reason, requests } with exactly the screen\'s fields, redacted', () =>
    withFixture(async (f) => {
      const { rid } = await f.register({ toolInput: { command: 'curl -H "Authorization: Bearer sk-live-sentinel-9931" https://x.example' } });
      const r = await f.call('GET', reqPath(SID), { headers: { origin: f.api.url } });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json ?? {}).sort(), ['available', 'reason', 'requests']);
      assert.equal(r.json?.available, true);
      assert.equal(r.json?.reason, null);
      const [item] = r.json?.requests as Array<Record<string, unknown>>;
      assert.deepEqual(Object.keys(item!).sort(), LIST_KEYS);
      assert.equal(item?.id, rid);
      assert.equal(item?.state, 'pending');
      assert.equal(item?.tool, 'Bash');
      assert.ok(!r.text.includes('sk-live-sentinel-9931'), 'the summary is masked');
      assert.ok(!r.text.includes(WINDOW_CREDENTIAL));
    }));

  test('#618/AC-8: off is 200 { available: false, reason: "off", requests: [] }; a cross-site page and a missing bearer are 403', () =>
    withFixture(async (f) => {
      await f.register();
      f.set({ credential: null });
      const off = await f.call('GET', reqPath(SID));
      assert.equal(off.status, 200);
      assert.deepEqual(off.json, { available: false, reason: 'off', requests: [] });
      assert.equal((await f.call('GET', reqPath(SID), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await f.call('GET', reqPath(SID), { bearer: false })).status, 403);
      assert.equal((await f.call('GET', reqPath('bad id'))).status, 400);
    }));
});

describe('operation 5: POST …/:rid/answer (#618/AC-8)', () => {
  test('#618/AC-8: the window answers 200 { ok: true }; the answer carries neither the credential nor the reason back', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      const r = await f.answer(SID, rid, { decision: 'deny', reason: 'not now' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
      assert.ok(!r.text.includes('not now'));
      assert.equal(f.deps.repository.find(SID, rid)?.state, 'answered');
    }));

  test('#618/AC-8: 409 already_answered, 410 gone, 404 not_found, 422 terminal_only (a deny is accepted), 400 for a bad decision or reason', () =>
    withFixture(async (f) => {
      const a = await f.register();
      await f.answer(SID, a.rid, { decision: 'allow' });
      const twice = await f.answer(SID, a.rid, { decision: 'deny' });
      assert.equal(twice.status, 409);
      assert.deepEqual(twice.json, { error: 'already_answered' });
      const b = await f.register();
      await f.call('POST', reqPath(SID, b.rid, '/withdraw'));
      const gone = await f.answer(SID, b.rid, { decision: 'allow' });
      assert.equal(gone.status, 410);
      assert.deepEqual(gone.json, { error: 'gone' });
      const none = await f.answer(SID, 'no-such-id', { decision: 'allow' });
      assert.equal(none.status, 404);
      assert.deepEqual(none.json, { error: 'not_found' });
      const c = await f.register({ toolInput: { command: 'git push --force origin main' } });
      const refused = await f.answer(SID, c.rid, { decision: 'allow' });
      assert.equal(refused.status, 422);
      assert.deepEqual(refused.json, { error: 'terminal_only' });
      assert.equal((await f.answer(SID, c.rid, { decision: 'deny' })).status, 200);
      const d = await f.register();
      for (const [body, code] of [[{ decision: 'maybe' }, 'invalid_decision'], [{ decision: 'deny', reason: 'two\nlines' }, 'invalid_reason'], [{ decision: 'deny', reason: 'x'.repeat(501) }, 'invalid_reason'], [{ decision: 'allow', reason: 'why' }, 'invalid_reason']] as const) {
        const r = await f.answer(SID, d.rid, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.deepEqual(r.json, { error: code });
      }
      for (const body of ['[]', '"allow"', '{nope', '{}']) {
        const r = await f.answer(SID, d.rid, null, { raw: body });
        assert.equal(r.status, 400, body);
      }
    }));

  test('#618/AC-8: the three proofs: no or wrong window credential is 403 window_only, a failed same-origin proof is 403 forbidden_origin', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      for (const headers of [{ 'ahrena-window': null }, { 'ahrena-window': 'wrong-credential' }, { 'ahrena-window': WINDOW_CREDENTIAL.slice(0, -1) }, { 'ahrena-window': `${WINDOW_CREDENTIAL}x` }, { 'ahrena-window': '' }]) {
        const r = await f.answer(SID, rid, { decision: 'deny' }, { headers });
        assert.equal(r.status, 403, JSON.stringify(headers));
        assert.deepEqual(r.json, { error: 'window_only' });
      }
      // Refused by the answer route's own proof, with its code.
      for (const headers of [{ origin: null }, { 'content-type': 'text/plain' }]) {
        const r = await f.answer(SID, rid, { decision: 'deny' }, { headers });
        assert.equal(r.status, 403, JSON.stringify(headers));
        assert.deepEqual(r.json, { error: 'forbidden_origin' }, JSON.stringify(headers));
      }
      // Refused earlier, by the owner gate or the chain (a foreign Origin, another Host, a page of another site).
      for (const headers of [{ origin: 'http://evil.example' }, { origin: 'http://localhost:1' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { host: 'evil.example' }]) {
        const r = await f.answer(SID, rid, { decision: 'deny' }, { headers });
        assert.equal(r.status, 403, JSON.stringify(headers));
      }
      const noBearer = await f.call('POST', reqPath(SID, rid, '/answer'), { bearer: false, body: { decision: 'deny' }, headers: { origin: f.api.url, 'ahrena-window': WINDOW_CREDENTIAL } });
      assert.equal(noBearer.status, 403);
      assert.equal(f.deps.repository.find(SID, rid)?.state, 'pending', 'no refused answer changed the request');
    }));

  test('#618/AC-8: a query or an altered path is not the answer route; a body over 2048 bytes is refused before it is read', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      const headers = { origin: f.api.url, 'ahrena-window': WINDOW_CREDENTIAL };
      const withQuery = await f.call('POST', `${reqPath(SID, rid, '/answer')}?x=1`, { body: { decision: 'deny' }, headers });
      assert.equal(withQuery.status, 403);
      const big = await f.answer(SID, rid, null, { raw: JSON.stringify({ decision: 'deny', reason: 'x'.repeat(2100) }) });
      assert.equal(big.status, 403);
      assert.equal(f.deps.repository.find(SID, rid)?.state, 'pending');
    }));

  test('#618/AC-8: with the capability off, even a correct answer is 403 window_only', () =>
    withFixture(async (f) => {
      const { rid } = await f.register();
      f.set({ enabled: false });
      const r = await f.answer(SID, rid, { decision: 'deny' });
      assert.equal(r.status, 403);
      assert.deepEqual(r.json, { error: 'window_only' });
    }));

  test('#618/AC-8: no window credential in the core: the answer is 403 window_only whatever header it carries', () =>
    withFixture(
      async (f) => {
        const { rid } = await f.register();
        f.set({ credential: null });
        for (const credential of [WINDOW_CREDENTIAL, '', 'null', 'undefined']) {
          const r = await f.answer(SID, rid, { decision: 'deny' }, { headers: { 'ahrena-window': credential } });
          assert.equal(r.status, 403, credential);
          assert.deepEqual(r.json, { error: 'window_only' });
        }
      },
      { credential: WINDOW_CREDENTIAL },
    ));
});

describe('the AhrenaRemote signature opens none of the five routes (#618/AC-5, #618/AC-8)', () => {
  test('#618/AC-5: no operation is on the closed list of remote routes, and a valid signed request gets credential-route', async () => {
    const targets: Array<[string, string]> = [
      ['POST', reqPath(SID)],
      ['GET', reqPath(SID, 'rq-1', '/decision?wait=25')],
      ['POST', reqPath(SID, 'rq-1', '/withdraw')],
      ['GET', reqPath(SID)],
      ['POST', reqPath(SID, 'rq-1', '/answer')],
    ];
    for (const [method, target] of targets) assert.equal(remoteRouteFor(method, target), null, `${method} ${target}`);
    const { harness } = await import('../permissions/fakes.ts');
    const deps = harness();
    const f = await remoteFixture({ api: { permissions: { deps, enabled: () => true, windowCredential: () => WINDOW_CREDENTIAL } } });
    try {
      const credential = await f.mint();
      for (const [method, target] of targets) {
        const r = await f.signed(credential, method, target, { body: method === 'POST' ? '{}' : undefined });
        assert.equal(r.status, 403, `${method} ${target}`);
        assert.equal(r.json?.reason, 'credential-route', `${method} ${target}`);
      }
      assert.equal(deps.repository.requests.size, 0);
      assert.equal(deps.audit.records.length, 0);
    } finally {
      await f.close();
    }
    void rawCall;
  });
});
