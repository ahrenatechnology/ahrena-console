/*
 * PUT /api/cpu-governor (#723, #720): turns the governor on or off, accepted only from the /ui itself.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { CpuGovernor, type MachineControl } from '../cpu-governor/governor.ts';
import { CPU_GOVERNOR_ROUTE, respondCpuGovernor } from './cpu-governor-route.ts';
import { STRICT_WRITE_ROUTES, strictWriteRefusal } from './connections-route.ts';

const calls: string[] = [];
const machine: MachineControl = {
  sample: async () => null,
  inspect: async () => null,
  renice: async (pid) => (calls.push(`renice ${pid}`), 'done'),
  background: async (pid) => (calls.push(`background ${pid}`), 'done'),
  foreground: async (pid) => (calls.push(`foreground ${pid}`), 'done'),
};
const governor = new CpuGovernor({ machine, load: () => ({ load1: 0, cores: 8 }), nowMs: () => 1_000, log: () => undefined, platform: 'darwin', selfPid: 1 });

let server: Server;
let origin: string;
let port: number;

before(async () => {
  server = createServer((req, res) => {
    const refusal = STRICT_WRITE_ROUTES.has(req.url ?? '') ? strictWriteRefusal(req, port, req.url ?? '') : { status: 404, body: { error: 'not-found' } };
    if (refusal) {
      res.statusCode = refusal.status;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(refusal.body));
    }
    return void respondCpuGovernor(req, res, governor);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
after(() => server.close());

const put = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${origin}${CPU_GOVERNOR_ROUTE}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin, ...headers }, body });

describe('#720/AC-6 PUT /api/cpu-governor', () => {
  test('#720/AC-6 Given the route, Then it is a strict write route', () => {
    assert.ok(STRICT_WRITE_ROUTES.has('/api/cpu-governor'));
  });

  test('#720/AC-6 Given {enabled:false} from the /ui, Then the governor is off and the answer is its state', async () => {
    const r = await put('{"enabled":false}');
    assert.equal(r.status, 200);
    const body: unknown = await r.json();
    assert.deepEqual(body, { cpuGovernor: { enabled: false, mode: 'normal', containedSessions: [], since: new Date(1_000).toISOString() } });
    assert.equal(governor.state().enabled, false);
  });

  test('#720/AC-6 Given {enabled:true}, Then the governor is on again', async () => {
    const r = await put('{"enabled":true}');
    assert.equal(r.status, 200);
    assert.equal(governor.state().enabled, true);
  });

  test('#720/AC-6 Given a body without a boolean enabled, Then 400 invalid and the state is unchanged', async () => {
    for (const body of ['{}', '{"enabled":"no"}', '{"enabled":1}', '[]', 'not json']) {
      const r = await put(body);
      assert.equal(r.status, 400, body);
      assert.deepEqual(await r.json(), { error: 'invalid' });
    }
    assert.equal(governor.state().enabled, true);
  });

  test('#720/AC-6 Given no Origin, another Origin or a cross-site request, Then 403 and the state is unchanged', async () => {
    const noOrigin = await fetch(`${origin}${CPU_GOVERNOR_ROUTE}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
    assert.equal(noOrigin.status, 403);
    assert.equal((await put('{"enabled":false}', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await put('{"enabled":false}', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(governor.state().enabled, true);
  });

  test('#720/AC-6 Given POST or GET, Then 405', async () => {
    assert.equal((await fetch(`${origin}${CPU_GOVERNOR_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })).status, 405);
    assert.equal((await fetch(`${origin}${CPU_GOVERNOR_ROUTE}`, { headers: { origin } })).status, 405);
  });

  test('#720/AC-6 Given a body over 4 KiB, Then 413', async () => {
    const r = await put(JSON.stringify({ enabled: false, pad: 'x'.repeat(5000) }));
    assert.equal(r.status, 413);
    assert.equal(governor.state().enabled, true);
  });
});

describe('#720/AC-6 without a governor', () => {
  test('#720/AC-6 Given a core that runs no governor, When PUT, Then 503 off', async () => {
    const lone = createServer((req, res) => void respondCpuGovernor(req, res, null));
    await new Promise<void>((r) => lone.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${(lone.address() as AddressInfo).port}${CPU_GOVERNOR_ROUTE}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'off' });
    } finally {
      lone.close();
    }
  });
});
