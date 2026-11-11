// AC2 (remote side): a response opened with a remote credential closes, with no last payload, the moment the
// credential expires, is evicted or loses its generation (decision 0020 section 4, #388).
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { authorizeRequest, REMOTE_ROUTES, type RemoteRoute } from '../../src/api/owner-auth.ts';
import { createRemoteVerifier } from '../../src/api/remote-auth.ts';
import { CREDENTIAL_TTL_MS, RemoteCredentialStore } from '../../src/api/remote-credentials.ts';
import { hex, signHeader } from './remote-credential-fixture.ts';

const STREAM: RemoteRoute = { method: 'GET', path: /^\/sse$/, query: [] };
const clock = { now: 1_800_000_000_000 };

async function streaming() {
  const store = new RemoteCredentialStore({ now: () => clock.now, generation: hex(16), machineIdentity: 'c'.repeat(64) });
  const verifier = createRemoteVerifier({ store, routeFor: (method, target) => (method === 'GET' && target === '/sse' ? STREAM : null) });
  let port = 0;
  const server: Server = createServer(async (req, res) => {
    if (!(await authorizeRequest(req, res, port, () => null, verifier))) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    const tick = setInterval(() => res.write('data: tick\n\n'), 10);
    res.once('close', () => clearInterval(tick));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  return {
    store,
    host,
    port,
    close: () => { server.closeAllConnections(); server.close(); },
    /** Opens the stream; `received()` is what arrived, `closedAt` when the connection ended. */
    open(c: { credentialId: string; key: string; generation: string }) {
      const log = { bytes: [] as { at: number; text: string }[], closedAt: 0, status: 0 };
      const req = request({ host: '127.0.0.1', port, path: '/sse', headers: { host, authorization: signHeader(c, { method: 'GET', target: '/sse', host, ts: clock.now }) }, agent: false }, (res) => {
        log.status = res.statusCode ?? 0;
        res.on('data', (d: Buffer) => log.bytes.push({ at: Date.now(), text: d.toString() }));
        res.on('close', () => { log.closedAt = Date.now(); });
        res.on('error', () => { log.closedAt ||= Date.now(); });
      });
      req.on('error', () => { log.closedAt ||= Date.now(); });
      req.end();
      return log;
    },
  };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe('AC2 · streams opened with a remote credential close without the last chunk', () => {
  test('AC2 the real list has no stream route yet: the guard is for the first one that opens (documented)', () => {
    assert.equal(REMOTE_ROUTES.some((r) => /stream|changes/.test(String(r.path))), false);
  });

  for (const [name, revoke] of [
    ['expiry', () => { clock.now += CREDENTIAL_TTL_MS + 1; }],
    ['eviction by the 4th issue', (s: RemoteCredentialStore) => { for (let i = 0; i < 3; i++) s.issue({ port: 1 }); }],
    ['a generation change', (s: RemoteCredentialStore) => s.restart()],
    ['a revoke at issue', null],
  ] as const) {
    test(`AC2 ${name} destroys the stream and nothing is written after it`, async () => {
      clock.now = 1_800_000_000_000;
      const t = await streaming();
      try {
        const c = t.store.issue({ port: t.port });
        const log = t.open(c);
        assert.equal(await until(() => log.bytes.length >= 2), true, 'the stream is flowing');
        assert.equal(log.status, 200);
        const cutAt = Date.now();
        if (revoke) revoke(t.store);
        else t.store.issue({ port: t.port, revoke: [c.credentialId] });
        assert.equal(await until(() => log.closedAt > 0), true, 'the connection was destroyed');
        assert.ok(log.closedAt - cutAt < 1000, 'within the guard timer');
        const after = log.bytes.filter((b) => b.at > log.closedAt);
        assert.deepEqual(after, [], 'no byte after the close');
        // Everything received arrived before the cut plus one timer tick; nothing like a final event.
        assert.ok(!log.bytes.some((b) => /bye|final|end/.test(b.text)));
      } finally { t.close(); }
    });
  }

  test('AC2 a response write after the credential died is refused synchronously, between timer ticks', async () => {
    clock.now = 1_800_000_000_000;
    const store = new RemoteCredentialStore({ now: () => clock.now, generation: hex(16), machineIdentity: 'c'.repeat(64) });
    const { guardResponse } = await import('../../src/api/owner-auth.ts');
    const written: string[] = [];
    let destroyed = false;
    const c = store.issue({ port: 1 });
    const res = {
      destroyed: false,
      setHeader() {},
      once() {},
      writeHead() { return this; },
      write(chunk: string) { written.push(chunk); return true; },
      end() { return this; },
      flushHeaders() {},
      addTrailers() {},
      destroy() { destroyed = true; this.destroyed = true; },
    };
    guardResponse(res as never, () => store.isLive(c.credentialId));
    assert.equal(res.write('first'), true);
    clock.now += CREDENTIAL_TTL_MS + 1;
    assert.equal(res.write('second'), false);
    assert.deepEqual(written, ['first']);
    assert.equal(destroyed, true);
  });
});
