import { OWNER_TOKEN, ownerRequest as request } from '../owner-http.ts';
// The app update notice's state and routes (#330, wireframes C77 to C80): what the app reports, what the
// /ui reads and clicks, Depois for 24 h or until a newer version, the Origin defense and the changes feed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createAppUpdateRoute } from '../../src/api/app-update.ts';
import { AppUpdateState, DISMISS_MS, type AppUpdateReport } from '../../src/app-update/state.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';

const report = (extra: Partial<AppUpdateReport> = {}): AppUpdateReport => ({
  appVersion: '0.0.9',
  mode: 'dev',
  available: { version: '0.0.10', notes: 'Aviso de versão nova no topo da /ui', publishedAt: '2026-10-24T10:00:00Z' },
  phase: 'idle',
  progress: null,
  error: null,
  lastCheckAt: 1_000,
  nextCheckAt: 601_000,
  updatedFrom: null,
  updatedNotes: null,
  ...extra,
});

describe('AppUpdateState', () => {
  test('without a report there is no app, no card and the actions are refused', () => {
    const s = new AppUpdateState(null);
    assert.equal(s.view().app, false);
    assert.equal(s.act('check'), false);
    assert.equal(s.act('install'), false);
    assert.equal(s.act('dismiss'), false);
  });

  test('check and install become counters the app carries out, and each is a change', () => {
    const cursor = new ChangeCursor();
    const s = new AppUpdateState(cursor);
    s.report(report());
    assert.equal(s.act('check'), true);
    assert.equal(s.act('check'), true);
    assert.equal(s.act('install'), true);
    assert.deepEqual(s.view().requests, { check: 2, install: 1 });
    assert.equal(cursor.current !== undefined, true);
  });

  test('Depois hides the card for 24 h, not for a newer version', () => {
    let now = 1_000_000;
    const s = new AppUpdateState(null, () => now);
    s.report(report());
    assert.equal(s.view().dismissed, false);
    assert.equal(s.act('dismiss', '0.0.10'), true);
    assert.equal(s.view().dismissed, true);
    now += DISMISS_MS - 1;
    assert.equal(s.view().dismissed, true);
    now += 1;
    assert.equal(s.view().dismissed, false);
    s.act('dismiss');
    s.report(report({ available: { version: '0.0.11', notes: null, publishedAt: null } }));
    assert.equal(s.view().dismissed, false);
  });

  test('Depois of another version than the one on offer is refused', () => {
    const s = new AppUpdateState(null);
    s.report(report());
    assert.equal(s.act('dismiss', '0.0.9'), false);
    assert.equal(s.view().dismissed, false);
  });

  test('the "updated" card comes from the first report only, and the ack clears it', () => {
    const s = new AppUpdateState(null);
    s.report(report({ appVersion: '0.0.10', available: null, updatedFrom: '0.0.9', updatedNotes: 'O que mudou' }));
    assert.deepEqual(s.view().updated, { from: '0.0.9', to: '0.0.10', notes: 'O que mudou' });
    s.act('ack');
    assert.equal(s.view().updated, null);
    s.report(report({ appVersion: '0.0.10', available: null, updatedFrom: '0.0.9' }));
    assert.equal(s.view().updated, null);
  });
});

async function boot() {
  const cursor = new ChangeCursor();
  const state = new AppUpdateState(cursor);
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, appUpdate: createAppUpdateRoute(state) });
  const port = Number(new URL(api.url).port);
  const host = `127.0.0.1:${port}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host, ...(text === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(text);
    });
  return { call, host, cursor, close: async () => { await api.close(); await storage.close(); } };
}

describe('GET/PUT/POST /api/app-update', () => {
  test('without an app: app false; the /ui cannot click', async () => {
    const t = await boot();
    try {
      const r = await t.call('GET', '/api/app-update');
      assert.equal(r.status, 200);
      assert.equal(r.body.app, false);
      const click = await t.call('POST', '/api/app-update/actions/check', undefined, { origin: `http://${t.host}` });
      assert.equal(click.status, 404);
      assert.equal(click.body.error, 'no-app');
    } finally {
      await t.close();
    }
  });

  test('the app reports, the /ui reads and clicks, and every step is a change', async () => {
    const t = await boot();
    try {
      const before = t.cursor.current;
      const put = await t.call('PUT', '/api/app-update/state', report());
      assert.equal(put.status, 200);
      assert.equal(put.body.app, true);
      assert.equal(put.body.available.version, '0.0.10');
      const own = { origin: `http://${t.host}` };
      assert.equal((await t.call('GET', '/api/app-update', undefined, own)).status, 200);
      const dismiss = await t.call('POST', '/api/app-update/actions/dismiss', { version: '0.0.10' }, own);
      assert.equal(dismiss.body.dismissed, true);
      const check = await t.call('POST', '/api/app-update/actions/check', undefined, own);
      assert.equal(check.body.requests.check, 1);
      const waited = await t.cursor.wait(before, { filters: { types: ['app-update'] }, timeoutMs: 0 });
      assert.equal(waited.changes.some((c) => c.type === 'app-update'), true);
    } finally {
      await t.close();
    }
  });

  test('a page from another Origin cannot report nor click', async () => {
    const t = await boot();
    try {
      await t.call('PUT', '/api/app-update/state', report());
      const other = { origin: 'http://evil.example' };
      assert.equal((await t.call('PUT', '/api/app-update/state', report({ appVersion: '9.9.9' }), other)).status, 403);
      assert.equal((await t.call('POST', '/api/app-update/actions/install', undefined, other)).status, 403);
      const own = { origin: `http://${t.host}` };
      assert.equal((await t.call('PUT', '/api/app-update/state', report({ appVersion: '9.9.9' }), own)).status, 403);
      assert.equal((await t.call('GET', '/api/app-update')).body.appVersion, '0.0.9');
    } finally {
      await t.close();
    }
  });

  test('a malformed report is a 400 and keeps the state', async () => {
    const t = await boot();
    try {
      assert.equal((await t.call('PUT', '/api/app-update/state', { ...report(), mode: 'beta' })).status, 400);
      assert.equal((await t.call('PUT', '/api/app-update/state', { ...report(), available: { version: '' } })).status, 400);
      assert.equal((await t.call('PUT', '/api/app-update/state', 'x')).status, 400);
      assert.equal((await t.call('GET', '/api/app-update')).body.app, false);
    } finally {
      await t.close();
    }
  });
});
