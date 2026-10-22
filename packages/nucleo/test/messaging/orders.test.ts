// The per-session orders (#61, mod part): the queue with a fake clock, and the routes on 127.0.0.1.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createOrdersRoute } from '../../src/api/orders.ts';
import { QUEUED_TTL_MS, RUNNING_TTL_MS, SessionOrders } from '../../src/messaging/orders.ts';

describe('SessionOrders', () => {
  test('an order is created, handed over once, and confirmed', () => {
    const o = new SessionOrders();
    const r = o.create('s1', 'compact');
    assert.equal(r.kind, 'accepted');
    const id = (r as { order: { orderId: string } }).order.orderId;
    assert.deepEqual(o.claim('s2'), [], 'another session gets nothing');
    assert.deepEqual(o.claim('s1'), [{ orderId: id, kind: 'compact' }]);
    assert.deepEqual(o.claim('s1'), [], 'delivered once');
    assert.equal(o.get('s1', id)?.state, 'running');
    assert.equal(o.done('s2', id, { ok: true }), false, 'only its own session confirms');
    assert.equal(o.done('s1', id, { ok: true }), true);
    assert.equal(o.done('s1', id, { ok: true }), false, 'confirmed once');
    assert.equal(o.get('s1', id)?.state, 'done');
  });

  test('one open order per session; an unknown kind is refused', () => {
    const o = new SessionOrders();
    assert.deepEqual(o.create('s1', 'rm -rf'), { kind: 'refused', refusal: 'invalid_kind' });
    const first = o.create('s1', 'clear');
    const second = o.create('s1', 'compact');
    assert.equal(second.kind, 'refused');
    assert.equal((second as { refusal: string }).refusal, 'in_flight');
    assert.equal(o.create('s2', 'remote-control').kind, 'accepted', 'another session is free');
    const id = (first as { order: { orderId: string } }).order.orderId;
    o.claim('s1');
    o.done('s1', id, { ok: false, reason: 'o plano não permite' });
    assert.equal(o.get('s1', id)?.state, 'failed');
    assert.equal(o.get('s1', id)?.reason, 'o plano não permite');
    assert.equal(o.create('s1', 'compact').kind, 'accepted', 'a settled order frees the session');
  });

  test('an order nobody fetched, or nobody answered, expires', () => {
    let t = 1_000_000;
    const o = new SessionOrders(() => t);
    const a = (o.create('s1', 'compact') as { order: { orderId: string } }).order.orderId;
    t += QUEUED_TTL_MS;
    assert.deepEqual(o.claim('s1'), []);
    assert.deepEqual([o.get('s1', a)?.state, o.get('s1', a)?.reason], ['expired', 'no_mod']);
    const b = (o.create('s1', 'clear') as { order: { orderId: string } }).order.orderId;
    o.claim('s1');
    t += RUNNING_TTL_MS;
    assert.deepEqual([o.get('s1', b)?.state, o.get('s1', b)?.reason], ['expired', 'no_answer']);
    assert.equal(o.done('s1', b, { ok: true }), false, 'too late');
  });
});

const root = mkdtempSync(join(tmpdir(), 'acm-orders-'));
after(() => rmSync(root, { recursive: true, force: true }));

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

async function boot(available = true) {
  const storage = openSqliteStorage({ path: join(root, `db-${Math.random().toString(36).slice(2)}.sqlite`) });
  const now = new Date().toISOString();
  const sessionId = '00000000-0000-4000-8000-000000000001';
  await storage.putSession({ id: sessionId, name: null, status: 'active', cwd: '/tmp/p', model: null, source: 'startup', startedAt: now, endedAt: null, awaitingInputSince: null, awaitingReason: null, updatedAt: now, accountId: null, accountSource: null, metadata: {} });
  const accounts = new Accounts({ storage, file: null });
  const montador = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null });
  const messaging = { availability: async () => ({ available, reason: available ? null : 'no_live_process', entrypoint: null, remoteControl: false, configDir: null, accountId: null, processes: available ? 1 : 0, inFlight: null }) };
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, orders: createOrdersRoute({ orders: new SessionOrders(), messaging: messaging as never, sessions: storage }) });
  const host = `127.0.0.1:${new URL(api.url).port}`;
  return { url: api.url, host, sessionId, close: async () => (await api.close(), await storage.close()) };
}

describe('the orders routes', () => {
  test('the /ui creates, the mod fetches once and confirms, the /ui reads how it ended', async () => {
    const b = await boot();
    try {
      const ui = { origin: `http://${b.host}`, 'content-type': 'application/json' };
      const base = `/api/sessions/${b.sessionId}/commands`;
      const made = await call(b.url, 'POST', base, ui, JSON.stringify({ kind: 'compact' }));
      assert.equal(made.status, 202);
      assert.equal(made.json.state, 'queued');
      const id = made.json.orderId as string;

      assert.equal((await call(b.url, 'POST', base, ui, JSON.stringify({ kind: 'clear' }))).status, 409, 'one at a time');
      assert.equal((await call(b.url, 'GET', base, { origin: `http://${b.host}` })).status, 403, 'the page does not fetch');

      const got = await call(b.url, 'GET', base);
      assert.deepEqual(got.json, { orders: [{ orderId: id, kind: 'compact' }] });
      assert.deepEqual((await call(b.url, 'GET', base)).json, { orders: [] }, 'once');
      assert.equal((await call(b.url, 'GET', `${base}/${id}`, { origin: `http://${b.host}` })).json.state, 'running');

      const json = { 'content-type': 'application/json' };
      assert.equal((await call(b.url, 'POST', `${base}/${id}/done`, ui, JSON.stringify({ ok: true }))).status, 403, 'the page does not confirm');
      assert.equal((await call(b.url, 'POST', `${base}/${id}/done`, json, JSON.stringify({ ok: 'yes' }))).status, 400);
      assert.equal((await call(b.url, 'POST', `${base}/${id}/done`, json, JSON.stringify({ ok: false, reason: 'o plano não permite' }))).status, 200);
      const end = await call(b.url, 'GET', `${base}/${id}`, { origin: `http://${b.host}` });
      assert.deepEqual([end.json.state, end.json.reason], ['failed', 'o plano não permite']);
    } finally {
      await b.close();
    }
  });

  test('refuses what is not the /ui, an unknown kind, an unknown session and a session with no live process', async () => {
    const b = await boot();
    try {
      const base = `/api/sessions/${b.sessionId}/commands`;
      const json = { 'content-type': 'application/json' };
      const ui = { origin: `http://${b.host}`, ...json };
      assert.equal((await call(b.url, 'POST', base, json, JSON.stringify({ kind: 'compact' }))).status, 403, 'no Origin: not the page');
      assert.equal((await call(b.url, 'POST', base, { origin: 'http://evil.example', ...json }, JSON.stringify({ kind: 'compact' }))).status, 403);
      assert.equal((await call(b.url, 'POST', base, ui, JSON.stringify({ kind: 'rm' }))).status, 400);
      assert.equal((await call(b.url, 'POST', '/api/sessions/nope/commands', ui, JSON.stringify({ kind: 'compact' }))).status, 404);
    } finally {
      await b.close();
    }
    const off = await boot(false);
    try {
      const r = await call(off.url, 'POST', `/api/sessions/${off.sessionId}/commands`, { origin: `http://${off.host}`, 'content-type': 'application/json' }, JSON.stringify({ kind: 'compact' }));
      assert.equal(r.status, 409);
      assert.equal(r.json.reason, 'no_live_process');
    } finally {
      await off.close();
    }
  });
});
