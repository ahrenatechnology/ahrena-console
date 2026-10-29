// The port release routes (#286, decision 0015) on 127.0.0.1: the strict gate (Origin exactly ours;
// no Origin only when started with --accept-remote-actions), the body's three keys, the refusals, and
// the remote machine's relay to a FAKE remote núcleo on loopback (only port, pid and signal travel,
// as a request without Origin; the remote's refusals are re-projected).
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createPortsRoute } from '../../src/api/ports.ts';
import { loopbackWrite } from '../../src/clouds/remote-connectors.ts';
import { PortReleaser } from '../../src/ports/release.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import type { ListeningPort } from '../../src/telemetry/model.ts';

interface Recorded {
  method: string;
  url: string;
  host: string | undefined;
  origin: string | undefined;
  body: string;
}

async function fakeRemote(answers: { get: { status: number; body: unknown }; post: { status: number; body: unknown } }) {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host, origin: req.headers.origin, body });
      const a = req.method === 'GET' ? answers.get : answers.post;
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  return { port, requests, answers, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function boot(opts: { accept?: boolean; remotes?: Record<string, number> } = {}) {
  let ports: ListeningPort[] = [{ port: 5432, interface: 'all', address: null, process: 'postgres', pid: 2210 }];
  const signals: [number, string][] = [];
  const releaser = new PortReleaser({
    listPorts: async () => ports,
    run: async () => '501 postgres -D data',
    uid: () => 501,
    selfPid: 1,
    parentPid: 2,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      ports = ports.filter((p) => p.pid !== pid);
    },
    sleep: async () => {},
    waitMs: { TERM: 100, KILL: 100 },
  });
  const route = createPortsRoute({ releaser, acceptNoOrigin: () => opts.accept ?? false, remote: { port: (id) => opts.remotes?.[id], get: loopbackGet({ timeoutMs: 1000 }), write: loopbackWrite({ timeoutMs: 1000 }) } });
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, ports: route });
  const port = Number(new URL(api.url).port);
  return { api, signals, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, close: async () => { await api.close(); await storage.close(); } };
}

function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const RELEASE = '/api/ports/release';
const body = (o: object = {}) => JSON.stringify({ port: 5432, pid: 2210, signal: 'TERM', ...o });

describe('#286 POST /api/ports/release', () => {
  test('#286 the /ui (Origin equal to ours) releases the port', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', RELEASE, { ...JSON_HEADERS, origin: b.origin }, body());
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { result: 'released' });
      assert.deepEqual(b.signals, [[2210, 'SIGTERM']]);
    } finally {
      await b.close();
    }
  });

  test('#286 another Origin, a null Origin and no Origin get 403 and nothing is signalled', async () => {
    const b = await boot();
    try {
      for (const origin of ['http://evil.example', 'null', undefined]) {
        const r = await call(b.api.url, 'POST', RELEASE, { ...JSON_HEADERS, ...(origin ? { origin } : {}) }, body());
        assert.equal(r.status, 403, String(origin));
      }
      const wrongHost = await call(b.api.url, 'POST', RELEASE, { ...JSON_HEADERS, origin: b.origin, host: 'evil.example' }, body());
      assert.equal(wrongHost.status, 403);
      assert.deepEqual(b.signals, []);
    } finally {
      await b.close();
    }
  });

  test('#286 no Origin is taken only with --accept-remote-actions, and never from another site', async () => {
    const b = await boot({ accept: true });
    try {
      const cross = await call(b.api.url, 'POST', RELEASE, { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body());
      assert.equal(cross.status, 403);
      const ok = await call(b.api.url, 'POST', RELEASE, JSON_HEADERS, body());
      assert.equal(ok.status, 200);
      assert.deepEqual(b.signals, [[2210, 'SIGTERM']]);
      const capability = await call(b.api.url, 'GET', RELEASE);
      assert.deepEqual(capability.json, { release: true, remoteActions: true });
    } finally {
      await b.close();
    }
  });

  test('#286 the body is exactly port, pid and signal; anything else is 400, 413 or 415 and nothing is signalled', async () => {
    const b = await boot();
    const headers = { ...JSON_HEADERS, origin: b.origin };
    try {
      for (const bad of [body({ extra: 1 }), body({ signal: 'HUP' }), body({ port: 0 }), body({ port: '5432' }), body({ pid: 1.5 }), '[]', 'nope', JSON.stringify({ port: 5432, pid: 2210 })]) {
        assert.equal((await call(b.api.url, 'POST', RELEASE, headers, bad)).status, 400, bad);
      }
      assert.equal((await call(b.api.url, 'POST', RELEASE, headers, body({ pad: 'x'.repeat(400) }))).status, 413);
      assert.equal((await call(b.api.url, 'POST', RELEASE, { origin: b.origin, 'content-type': 'text/plain' }, body())).status, 415);
      assert.equal((await call(b.api.url, 'POST', `${RELEASE}?x=1`, headers, body())).status, 403);
      assert.deepEqual(b.signals, []);
    } finally {
      await b.close();
    }
  });

  test('#286 an owner that changed is 409 with who holds the port now; a free port is 409 already-free', async () => {
    const b = await boot();
    const headers = { ...JSON_HEADERS, origin: b.origin };
    try {
      const moved = await call(b.api.url, 'POST', RELEASE, headers, body({ pid: 9999 }));
      assert.equal(moved.status, 409);
      assert.deepEqual(moved.json.now, { process: 'postgres', pid: 2210 });
      assert.equal(moved.json.reason, 'owner-changed');
      const free = await call(b.api.url, 'POST', RELEASE, headers, body({ port: 6000 }));
      assert.equal(free.json.reason, 'already-free');
      assert.deepEqual(b.signals, []);
    } finally {
      await b.close();
    }
  });
});

describe('#286 /api/machines/<id>/ports/release', () => {
  const ws = (r: { port: number }) => ({ ws: r.port });

  test('#286 only the /ui reaches it, and only the port, pid and signal travel, as a request without Origin', async () => {
    const remote = await fakeRemote({ get: { status: 200, body: {} }, post: { status: 200, body: { result: 'released', secret: 'x' } } });
    const b = await boot({ remotes: ws(remote) });
    try {
      const noOrigin = await call(b.api.url, 'POST', '/api/machines/ws/ports/release', JSON_HEADERS, body());
      assert.equal(noOrigin.status, 403);
      assert.equal(remote.requests.length, 0);
      const r = await call(b.api.url, 'POST', '/api/machines/ws/ports/release', { ...JSON_HEADERS, origin: b.origin }, body());
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { result: 'released' });
      assert.equal(remote.requests.length, 1);
      const sent = remote.requests[0]!;
      assert.equal(sent.url, RELEASE);
      assert.equal(sent.origin, undefined);
      assert.deepEqual(JSON.parse(sent.body), { port: 5432, pid: 2210, signal: 'TERM' });
      assert.deepEqual(b.signals, [], 'nothing runs on this machine');
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#286 the remote refusing the tunnel is remote-actions-off; a núcleo without the route is unsupported', async () => {
    const remote = await fakeRemote({ get: { status: 200, body: {} }, post: { status: 403, body: { error: 'origem não permitida' } } });
    const b = await boot({ remotes: ws(remote) });
    const headers = { ...JSON_HEADERS, origin: b.origin };
    try {
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws/ports/release', headers, body())).json.reason, 'remote-actions-off');
      remote.answers.post = { status: 404, body: { error: 'não encontrado' } };
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws/ports/release', headers, body())).json.reason, 'unsupported');
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#286 the remote owner-changed answer is re-projected and nothing else of it passes', async () => {
    const remote = await fakeRemote({ get: { status: 200, body: {} }, post: { status: 409, body: { reason: 'owner-changed', now: { process: 'redis-server', pid: 5120, env: 'LEAK' }, token: 'LEAK' } } });
    const b = await boot({ remotes: ws(remote) });
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws/ports/release', { ...JSON_HEADERS, origin: b.origin }, body());
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'a porta agora é de outro processo; nada foi enviado', reason: 'owner-changed', now: { process: 'redis-server', pid: 5120 } });
      remote.answers.post = { status: 500, body: { reason: 'weird' } };
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws/ports/release', { ...JSON_HEADERS, origin: b.origin }, body())).status, 502);
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#286 GET tells whether the remote has the action and takes the tunnel; an unknown machine is 404', async () => {
    const remote = await fakeRemote({ get: { status: 200, body: { release: true, remoteActions: true } }, post: { status: 200, body: {} } });
    const b = await boot({ remotes: ws(remote) });
    try {
      assert.deepEqual((await call(b.api.url, 'GET', '/api/machines/ws/ports/release', { origin: b.origin })).json, { machine: 'ws', status: 'ok', remoteActions: true });
      remote.answers.get = { status: 404, body: { error: 'não encontrado' } };
      assert.equal((await call(b.api.url, 'GET', '/api/machines/ws/ports/release', { origin: b.origin })).json.status, 'unsupported');
      assert.equal((await call(b.api.url, 'GET', '/api/machines/nope/ports/release', { origin: b.origin })).status, 404);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/local/ports/release', { ...JSON_HEADERS, origin: b.origin }, body())).status, 404);
    } finally {
      await b.close();
      await remote.close();
    }
  });
});
