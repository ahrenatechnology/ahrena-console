import { OWNER_TOKEN, ownerRequest as request } from '../owner-http.ts';
// The connection routes of a remote machine (#278, decision 0013 section 6) on 127.0.0.1, with a FAKE
// command (a tiny node script that writes a marker or sleeps) and a stub AWS login: the shapes, 202,
// 404 for an unknown id, 405, 409 with each reason, Cancel, `connection` in each GET /api/machines
// remote item, the old Reconnect route kept as an alias, the `<id>:connection` change, and the Origin
// defense of decision 0003: another Origin gets 403 and nothing is spawned. Placeholders only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createConnectionRoute } from '../../src/api/connection.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { MachineConnection, publishConnectionChanges, type CloudLogins, type CloudLoginStatus } from '../../src/telemetry/connection.ts';
import type { ConnectionConfig } from '../../src/telemetry/machines-config.ts';
import type { MachineSummary } from '../../src/telemetry/model.ts';
import { ReconnectRunner } from '../../src/telemetry/reconnect.ts';
import { localMachine, TelemetryService, type MachineEntry, type MachineStatus } from '../../src/telemetry/service.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-connection-route-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = join(dir, 'fake-connect.mjs');
writeFileSync(
  SCRIPT,
  `const [mode, arg] = process.argv.slice(2);
const fs = await import('node:fs');
if (mode === 'marker') fs.writeFileSync(arg, 'ran');
if (mode === 'sleep') setTimeout(() => {}, 60_000);
`,
);

class StubCloud implements CloudLogins {
  logins_: string[] = [];
  private state: CloudLoginStatus['state'] = 'idle';
  private release: () => void = () => {};
  private exit: Promise<void> = Promise.resolve();
  async view() {
    return {
      cli: { found: true, version: 2 },
      configFile: { status: 'ok' as const },
      sessions: [{ name: 'sessao-exemplo', loginSupported: true, state: 'expired' as const, expiresAt: '2026-11-02T03:10:00.000Z', profiles: [{ name: 'perfil-dev' }] }],
    };
  }
  async login(name: string) {
    this.logins_.push(name);
    this.state = 'running';
    this.exit = new Promise<void>((r) => (this.release = r));
    return { kind: 'started' as const };
  }
  async cancel() {
    if (this.state === 'running') this.finish('canceled');
    return { kind: 'canceled' };
  }
  finish(s: CloudLoginStatus['state']) {
    this.state = s;
    this.release();
  }
  logins = { exited: () => this.exit, status: (): CloudLoginStatus => ({ state: this.state, timeoutSeconds: 300 }) };
}

let n = 0;
async function boot(mode: 'marker' | 'sleep' = 'marker') {
  const marker = join(dir, `marker-${++n}`);
  const logFile = join(dir, `reconnect-${n}.log`);
  const start = { command: [process.execPath, SCRIPT, mode, marker], timeoutSeconds: 900 };
  const configs: Record<string, ConnectionConfig | null> = {
    'ws-exemplo': { start, stop: { command: [process.execPath, SCRIPT, 'marker', `${marker}.stop`], timeoutSeconds: 900 }, cloudProfile: { connector: 'aws', profile: 'perfil-dev' } },
    'ws-dois': null,
  };
  const status: MachineStatus = { state: 'unreachable', reason: 'port-closed', version: null };
  const machine = (port: number) => ({ port, status: () => status, readNow: async () => status });
  const machines: Record<string, ReturnType<typeof machine>> = { 'ws-exemplo': machine(14720), 'ws-dois': machine(14721) };
  const registry = {
    refresh: async () => {},
    fileInvalid: () => false,
    connectionOf: (id: string) => (id in configs ? configs[id]! : undefined),
    get: (id: string) => machines[id],
  };
  const spawns: string[] = [];
  const storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const runner = new ReconnectRunner({ logFile, lookup: async (id) => (id in configs ? (configs[id]?.start ?? null) : undefined), msPerSecond: 20, killGraceMs: 100, onSpawn: () => spawns.push('start') });
  const cloud = new StubCloud();
  const conn = new MachineConnection({ registry, startRunner: runner, logFile, cloud, onChange: publishConnectionChanges(cursor), runner: { msPerSecond: 20, killGraceMs: 100, onSpawn: () => spawns.push('stop') } });
  const remote = (id: string, port: number): MachineEntry => ({
    id,
    label: id === 'ws-exemplo' ? 'Workstation' : 'Outra',
    port,
    state: () => status.state,
    status: () => status,
    reconnect: () => runner.status(id, configs[id]?.start ?? null),
    connection: () => conn.status(id),
  });
  const telemetry = new TelemetryService({ store, tracker, machines: [localMachine(), remote('ws-exemplo', 14720), remote('ws-dois', 14721)] });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, telemetry, reconnect: conn.legacy, machineConnection: createConnectionRoute(conn) });
  const port = Number(new URL(api.url).port);
  return {
    api,
    conn,
    cloud,
    marker,
    spawns,
    cursor,
    host: `127.0.0.1:${port}`,
    close: async () => {
      await conn.stopAll();
      await api.close();
      await storage.close();
    },
  };
}

function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const ACTIONS = ['start', 'stop', 'reconnect', 'login-and-start'];

describe('#278 the connection routes', () => {
  test('#278 GET /api/machines: each remote has `connection`, this machine has none', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'GET', '/api/machines');
      assert.equal(r.status, 200);
      const list = r.body as unknown as MachineSummary[];
      assert.equal('connection' in list[0]!, false);
      const ws = list[1]!.connection!;
      assert.deepEqual(Object.keys(ws).sort(), ['actions', 'cloud', 'command', 'configured', 'job', 'lastError', 'logFile', 'ports', 'since', 'state'].sort());
      assert.equal(ws.configured, true);
      assert.equal(ws.state, 'down');
      assert.deepEqual(ws.cloud, { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'expired', expiresAt: '2026-11-02T03:10:00.000Z' });
      assert.deepEqual(ws.lastError?.reason, 'sso-expired');
      assert.deepEqual(ws.actions, { start: true, stop: false, reconnect: true, loginAndStart: true });
      assert.equal(list[2]!.connection?.configured, false);
    } finally {
      await b.close();
    }
  });

  test('#278 POST start from the tray (no Origin): 202 { connection }, the command runs', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start');
      assert.equal(r.status, 202);
      const c = r.body.connection as MachineSummary['connection'];
      assert.equal(c?.state, 'starting');
      assert.equal(c?.job?.startedBy, 'local');
      await b.conn.settled('ws-exemplo');
      assert.equal(existsSync(b.marker), true);
    } finally {
      await b.close();
    }
  });

  test('#278 POST from the same-origin /ui: 202, startedBy ui; a body is ignored', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/stop', { origin: `http://${b.host}`, 'content-type': 'application/json' }, '{"command":["/bin/sh"]}');
      assert.equal(r.status, 202);
      assert.equal((r.body.connection as MachineSummary['connection'])?.job?.startedBy, 'ui');
      await b.conn.settled('ws-exemplo');
      assert.equal(existsSync(`${b.marker}.stop`), true);
      assert.equal((await b.conn.status('ws-exemplo'))?.state, 'stopped');
    } finally {
      await b.close();
    }
  });

  test('#278 another Origin gets 403 on every write and nothing is spawned', async () => {
    const b = await boot();
    try {
      for (const origin of ['http://example.test', 'null', `https://${b.host}`]) {
        for (const a of ACTIONS) assert.equal((await call(b.api.url, 'POST', `/api/machines/ws-exemplo/connection/${a}`, { origin })).status, 403, `${origin} ${a}`);
        assert.equal((await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/connection', { origin })).status, 403, origin);
      }
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start?x=1', { origin: `http://${b.host}` })).status, 403);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start', { host: 'example.test', origin: 'http://example.test' })).status, 403);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(b.spawns, []);
      assert.deepEqual(b.cloud.logins_, []);
      assert.equal(existsSync(b.marker), false);
    } finally {
      await b.close();
    }
  });

  test('#278 404 for an unknown id, `local` and an invalid id; 405 for another method', async () => {
    const b = await boot();
    try {
      for (const id of ['ws-nenhuma', 'local', 'WS_X']) {
        const r = await call(b.api.url, 'POST', `/api/machines/${id}/connection/start`);
        assert.equal(r.status, 404, id);
        assert.equal(r.body.reason, 'unknown');
        assert.equal((await call(b.api.url, 'DELETE', `/api/machines/${id}/connection`)).status, 404, id);
      }
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/explode')).status, 404);
      assert.equal((await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connection/start')).status, 405);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection')).status, 405);
      assert.deepEqual(b.spawns, []);
    } finally {
      await b.close();
    }
  });

  test('#278 409 with the reason: not-configured, not-running, busy', async () => {
    const b = await boot('sleep');
    try {
      const nc = await call(b.api.url, 'POST', '/api/machines/ws-dois/connection/start');
      assert.deepEqual([nc.status, nc.body.reason], [409, 'not-configured']);
      assert.equal(typeof nc.body.error, 'string');
      const nr = await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/connection');
      assert.deepEqual([nr.status, nr.body.reason], [409, 'not-running']);
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start')).status, 202);
      const busy = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/reconnect');
      assert.deepEqual([busy.status, busy.body.reason], [409, 'busy']);
      const again = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start');
      assert.equal(again.status, 202, 'the same kind joins the one running');
      const cancel = await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/connection');
      assert.equal(cancel.status, 200);
      assert.equal((cancel.body.connection as MachineSummary['connection'])?.job?.state, 'canceled');
      await b.conn.settled('ws-exemplo');
      assert.deepEqual(b.spawns, ['start']);
    } finally {
      await b.close();
    }
  });

  test('#278 POST login-and-start: 202 at the login step, the session of the linked profile; Cancel ends it with no start', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/login-and-start');
      assert.equal(r.status, 202);
      const c = r.body.connection as MachineSummary['connection'];
      assert.deepEqual([c?.job?.kind, c?.job?.step], ['login-and-start', 'login']);
      assert.deepEqual(b.cloud.logins_, ['sessao-exemplo']);
      assert.equal((await call(b.api.url, 'DELETE', '/api/machines/ws-exemplo/connection')).status, 200);
      await b.conn.settled('ws-exemplo');
      assert.deepEqual(b.spawns, []);
    } finally {
      await b.close();
    }
  });

  test('#278 the old POST /api/machines/<id>/reconnect still answers 202 { reconnect } and runs the start command', async () => {
    const b = await boot();
    try {
      const r = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/reconnect');
      assert.equal(r.status, 202);
      assert.equal((r.body.reconnect as MachineSummary['reconnect'])?.state, 'running');
      await b.conn.settled('ws-exemplo');
      assert.equal(existsSync(b.marker), true);
    } finally {
      await b.close();
    }
  });

  test('#278 each change is an alert change keyed <machine>:connection', async () => {
    const b = await boot();
    try {
      const before = b.cursor.current;
      await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connection/start');
      await b.conn.settled('ws-exemplo');
      const w = await b.cursor.wait(before, { timeoutMs: 0 });
      const keys = new Set(w.changes.map((c) => `${c.type} ${c.key}`));
      assert.deepEqual([...keys], ['alert ws-exemplo:connection']);
    } finally {
      await b.close();
    }
  });
});
