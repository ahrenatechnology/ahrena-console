// POST and DELETE /api/machines/<id>/reconnect (#244, decision 0012 section 4) on 127.0.0.1, with a
// FAKE command (a tiny node script in a temporary folder that writes a marker file or sleeps): 202,
// 404, 409, the cancel, `reconnect` in each GET /api/machines item, and the Origin defense of decision
// 0003 (another Origin gets 403 and the command never runs; the same-origin /ui and the no-Origin
// loopback request pass). A body is ignored: nothing from the request reaches the command.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import type { ReconnectConfig } from '../../src/telemetry/machines-config.ts';
import type { MachineSummary } from '../../src/telemetry/model.ts';
import { INVALID_MACHINES_FILE, publishReconnectChanges, ReconnectRunner } from '../../src/telemetry/reconnect.ts';
import { localMachine, TelemetryService, type MachineEntry } from '../../src/telemetry/service.ts';
import { touchesMachine } from '../../ui/screens/machine-format.js';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-reconnect-route-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = join(dir, 'fake-connect.mjs');
writeFileSync(
  SCRIPT,
  `const [mode, arg] = process.argv.slice(2);
const fs = await import('node:fs');
if (mode === 'marker') { fs.writeFileSync(arg, JSON.stringify(process.argv.slice(2))); console.log('PRINTED-BY-THE-FAKE-COMMAND'); }
if (mode === 'sleep') setTimeout(() => {}, 60_000);
`,
);

let n = 0;
async function boot(mode: 'marker' | 'sleep' = 'marker') {
  const marker = join(dir, `marker-${++n}`);
  const file = { invalid: false };
  const configs: Record<string, ReconnectConfig | null> = {
    'ws-exemplo': { command: [process.execPath, SCRIPT, mode, marker], timeoutSeconds: 900 },
    'ws-dois': null,
  };
  const storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const runner = new ReconnectRunner({
    logFile: join(dir, `reconnect-${n}.log`),
    // Like cli.ts: a known machine while machines.json is invalid gets INVALID_MACHINES_FILE.
    lookup: async (id) => (id in configs ? (file.invalid ? INVALID_MACHINES_FILE : configs[id]!) : undefined),
    onChange: publishReconnectChanges(cursor),
    msPerSecond: 20,
    killGraceMs: 100,
    log: () => {},
  });
  const remote = (id: string, port: number): MachineEntry => ({
    id,
    label: id === 'ws-exemplo' ? 'Workstation' : 'Outra',
    port,
    state: () => 'unreachable',
    reconnect: () => runner.status(id, configs[id] ?? null),
  });
  const telemetry = new TelemetryService({ store, tracker, machines: [localMachine(), remote('ws-exemplo', 14720), remote('ws-dois', 14721)] });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, telemetry, reconnect: runner });
  const port = Number(new URL(api.url).port);
  return {
    api,
    runner,
    marker,
    file,
    cursor,
    host: `127.0.0.1:${port}`,
    close: async () => {
      await runner.cancel('ws-exemplo').catch(() => null);
      await runner.exited('ws-exemplo');
      await api.close();
      await storage.close();
    },
  };
}

/** A request with full control of the method, Host, Origin and body (fetch hides some of them). */
function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const settle = () => new Promise((res) => setTimeout(res, 300));

describe('#244 POST /api/machines/<id>/reconnect', () => {
  test('#244 from the no-Origin loopback client (the tray): 202 with the running state, startedBy local, and the command runs', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect');
      assert.equal(r.status, 202);
      const body = JSON.parse(r.text) as { reconnect: MachineSummary['reconnect'] };
      assert.equal(body.reconnect?.state, 'running');
      assert.equal(body.reconnect?.startedBy, 'local');
      assert.equal(body.reconnect?.configured, true);
      await b.runner.exited('ws-exemplo');
      assert.equal(existsSync(b.marker), true);
    } finally {
      await b.close();
    }
  });

  test('#244 from the same-origin /ui: 202, startedBy ui', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { origin: `http://${b.host}`, 'content-type': 'application/json' }, '{}');
      assert.equal(r.status, 202);
      assert.equal((JSON.parse(r.text) as { reconnect: { startedBy: string } }).reconnect.startedBy, 'ui');
    } finally {
      await b.close();
    }
  });

  test('#244 another Origin gets 403 and the fake command never runs', async () => {
    const b = await boot();
    try {
      for (const origin of ['http://evil.example', 'null', `https://${b.host}`, 'http://localhost:1']) {
        const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { origin });
        assert.equal(r.status, 403, origin);
      }
      const d = await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/reconnect', { origin: 'http://evil.example' });
      assert.equal(d.status, 403);
      // A same-origin request with a query, or with a Host that is not ours, is not the exception either.
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect?x=1', { origin: `http://${b.host}` })).status, 403);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { host: 'example.test', origin: 'http://example.test' })).status, 403);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { host: 'example.test' })).status, 403);
      await settle();
      assert.equal(existsSync(b.marker), false);
      assert.equal(b.runner.status('ws-exemplo', null).state, 'idle');
    } finally {
      await b.close();
    }
  });

  test('#244 Origin null, a DNS-rebinding Host (with or without a matching Origin) and a query all get 403; the command never runs', async () => {
    const b = await boot();
    try {
      const port = b.host.split(':')[1];
      const cases: [string, Record<string, string>][] = [
        ['/api/machines/ws-exemplo/reconnect', { origin: 'null' }],
        ['/api/machines/ws-exemplo/reconnect', { host: `evil.example:${port}` }],
        ['/api/machines/ws-exemplo/reconnect', { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }],
        ['/api/machines/ws-exemplo/reconnect', { host: `evil.example:${port}`, origin: `http://${b.host}` }],
        ['/api/machines/ws-exemplo/reconnect?x=1', { origin: `http://${b.host}` }],
        ['/api/machines/ws-exemplo/reconnect?machine=other', { origin: `http://${b.host}` }],
      ];
      for (const method of ['POST', 'DELETE']) {
        for (const [path, headers] of cases) assert.equal((await call(b.api.url, method, path, headers)).status, 403, `${method} ${path} ${JSON.stringify(headers)}`);
      }
      await settle();
      assert.equal(existsSync(b.marker), false);
      assert.equal(b.runner.status('ws-exemplo', null).state, 'idle');
    } finally {
      await b.close();
    }
  });

  test('#244 while machines.json is invalid: 409 with the pt-BR message and nothing runs', async () => {
    const b = await boot();
    try {
      b.file.invalid = true;
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { origin: `http://${b.host}` });
      assert.equal(r.status, 409);
      assert.deepEqual(JSON.parse(r.text), { error: 'O machines.json está inválido; corrija o arquivo para reconectar.' });
      await settle();
      assert.equal(existsSync(b.marker), false);
    } finally {
      await b.close();
    }
  });

  test('#244 a body with a command is ignored: only the command of the file runs, with its own arguments', async () => {
    const b = await boot();
    try {
      const other = join(dir, 'from-the-body');
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { 'content-type': 'application/json' }, JSON.stringify({ command: [process.execPath, SCRIPT, 'marker', other], timeoutSeconds: 10 }));
      assert.equal(r.status, 202);
      assert.equal((JSON.parse(r.text) as { reconnect: { timeoutSeconds: number } }).reconnect.timeoutSeconds, 900);
      await b.runner.exited('ws-exemplo');
      assert.equal(existsSync(other), false);
      assert.equal(existsSync(b.marker), true);
    } finally {
      await b.close();
    }
  });

  test('#244 unknown machine 404; machine without command 409 with a pt-BR message; an invalid id 404', async () => {
    const b = await boot();
    try {
      assert.equal((await call(b.api.url, 'POST', '/api/machines/nao-existe/reconnect')).status, 404);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/local/reconnect')).status, 404);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/WS%20x/reconnect')).status, 404);
      const r = await call(b.api.url, 'POST', '/api/machines/ws-dois/reconnect');
      assert.equal(r.status, 409);
      assert.match((JSON.parse(r.text) as { error: string }).error, /machines\.json/);
      assert.equal((await call(b.api.url, 'GET', '/api/machines/ws-exemplo/reconnect')).status, 405);
    } finally {
      await b.close();
    }
  });

  test('#244 a second POST while one runs returns the running one: 202, same startedAt', async () => {
    const b = await boot('sleep');
    try {
      const a = JSON.parse((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect')).text) as { reconnect: { startedAt: string } };
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect', { origin: `http://${b.host}` });
      assert.equal(r.status, 202);
      const second = JSON.parse(r.text) as { reconnect: { startedAt: string; startedBy: string } };
      assert.equal(second.reconnect.startedAt, a.reconnect.startedAt);
      assert.equal(second.reconnect.startedBy, 'local');
    } finally {
      await b.close();
    }
  });
});

describe('#244 DELETE /api/machines/<id>/reconnect', () => {
  test('#244 cancels the running one: 200 canceled; then 409 when nothing runs; 404 unknown', async () => {
    const b = await boot('sleep');
    try {
      assert.equal((await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/reconnect')).status, 409);
      await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect');
      const r = await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/reconnect', { origin: `http://${b.host}` });
      assert.equal(r.status, 200);
      assert.equal((JSON.parse(r.text) as { reconnect: { state: string } }).reconnect.state, 'canceled');
      await b.runner.exited('ws-exemplo');
      assert.equal((await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/reconnect')).status, 409);
      assert.equal((await call(b.api.url, 'DELETE', '/api/machines/nao-existe/reconnect')).status, 404);
    } finally {
      await b.close();
    }
  });
});

describe('#244 reconnect in GET /api/machines and on /api/changes', () => {
  test('#244 each remote item carries reconnect, local carries null, and no command output ever appears', async () => {
    const b = await boot();
    try {
      await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect');
      await b.runner.exited('ws-exemplo');
      await settle();
      const r = await call(b.api.url, 'GET', '/api/machines');
      assert.doesNotMatch(r.text, /PRINTED-BY-THE-FAKE-COMMAND/);
      const list = JSON.parse(r.text) as MachineSummary[];
      assert.equal(list[0]!.reconnect, null);
      const ws = list.find((m) => m.id === 'ws-exemplo')!;
      assert.deepEqual(Object.keys(ws.reconnect!).sort(), ['command', 'configured', 'endedAt', 'exitCode', 'logFile', 'startedAt', 'startedBy', 'state', 'timeoutSeconds']);
      assert.equal(ws.reconnect!.state, 'succeeded');
      assert.equal(ws.reconnect!.exitCode, 0);
      assert.deepEqual(list.find((m) => m.id === 'ws-dois')!.reconnect, { ...ws.reconnect!, configured: false, command: null, timeoutSeconds: null, state: 'idle', startedAt: null, endedAt: null, exitCode: null, startedBy: null });
      const t = await call(b.api.url, 'GET', '/api/telemetry?machine=ws-exemplo');
      assert.doesNotMatch(t.text, /PRINTED-BY-THE-FAKE-COMMAND/);
    } finally {
      await b.close();
    }
  });

  test('#244 each state change is an alert change keyed <machine>:reconnect, the shape the machine screen re-reads on', async () => {
    const b = await boot();
    try {
      const before = b.cursor.current;
      await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect');
      await b.runner.exited('ws-exemplo');
      const w = await b.cursor.wait(before, { timeoutMs: 0 });
      assert.deepEqual(w.changes.map((c) => ({ type: c.type, key: c.key, sessionId: c.sessionId, accountId: c.accountId })), [
        { type: 'alert', key: 'ws-exemplo:reconnect', sessionId: null, accountId: null },
      ]);
      assert.equal(touchesMachine(w.changes, 'ws-exemplo'), true);
      assert.equal(touchesMachine(w.changes, 'ws-dois'), false);
    } finally {
      await b.close();
    }
  });
});
