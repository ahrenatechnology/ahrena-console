import { OWNER_TOKEN, ownerRequest as request } from '../owner-http.ts';
// The Update button's routes (issue 462, decision 0022 section 6) on 127.0.0.1, with a FAKE command in place of
// ssh: the three routes and their shapes, 202/200/404/405/409, the Origin rules (the /ui only: no Origin and
// another Origin both get 403 and nothing runs), the closed route list (an exact raw path), one job per machine,
// and the `update` object of each remote item of GET /api/machines. Placeholders only.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createCoreUpdateRoute } from '../../src/api/core-update.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { CoreUpdater, type MachineUpdate } from '../../src/telemetry/core-update.ts';
import type { ConnectionConfig } from '../../src/telemetry/machines-config.ts';
import { localMachine, TelemetryService, type MachineEntry, type MachineStatus } from '../../src/telemetry/service.ts';
import { phase, result, Scenario, SCRIPT_TEXT } from '../telemetry/core-update-fixture.ts';

const scenarios: Scenario[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of scenarios.splice(0)) s.close();
});

async function boot() {
  const s = new Scenario();
  scenarios.push(s);
  const configs: Record<string, ConnectionConfig | null> = { 'ws-exemplo': s.connection(), 'ws-dois': null };
  let fileInvalid = false;
  const updater = new CoreUpdater({
    lookup: async (id) => (id in configs ? (fileInvalid ? { kind: 'invalid-file' } : { kind: 'ok', connection: configs[id]! }) : { kind: 'unknown' }),
    context: (id) => ({ connection: id in configs ? configs[id]! : undefined, fileInvalid }),
    appVersion: '0.0.17',
    telemetryVersion: 1,
    script: async () => SCRIPT_TEXT,
    msPerSecond: 20,
    killGraceMs: 100,
  });
  const status: MachineStatus = { state: 'connected', reason: null, version: 1 };
  const remote = (id: string, port: number): MachineEntry => ({ id, label: id, port, state: () => status.state, status: () => status, update: () => updater.status(id) });
  const storage = openSqliteStorage({ path: ':memory:' });
  const telemetry = new TelemetryService({ store: new SqliteTelemetryStore(storage.db), tracker: new AlertTracker(), machines: [localMachine(), remote('ws-exemplo', 14720), remote('ws-dois', 14721)] });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, telemetry, coreUpdate: createCoreUpdateRoute(updater) });
  const port = Number(new URL(api.url).port);
  closers.push(async () => {
    await updater.cancel('ws-exemplo').catch(() => null);
    await updater.settled('ws-exemplo').catch(() => null);
    await api.close();
    await storage.close();
  });
  return { s, updater, api, host: `127.0.0.1:${port}`, own: { origin: `http://127.0.0.1:${port}` }, setInvalid: (v: boolean) => (fileInvalid = v), configs };
}

function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const CHECK = '/api/machines/ws-exemplo/update/check';
const UPDATE = '/api/machines/ws-exemplo/update';
const CHECK_OK = { steps: [{ out: phase('check') }, { out: result(0) }], exit: 0 };

describe('issue 462 the Update routes', () => {
  test('GET /api/machines: every remote item has `update` with the documented keys; this machine has none', async () => {
    const b = await boot();
    const r = await call(b.api.url, 'GET', '/api/machines');
    assert.equal(r.status, 200);
    const list = r.body as unknown as { id: string; update?: MachineUpdate }[];
    assert.equal('update' in list[0]!, false);
    const u = list[1]!.update!;
    assert.deepEqual(
      Object.keys(u).sort(),
      ['backupPath', 'canCancel', 'command', 'configured', 'confirmation', 'endedAt', 'exitCode', 'invalidReason', 'kind', 'message', 'newCommit', 'observedVersion', 'oldCommit', 'phase', 'problem', 'readyUntil', 'reason', 'setup', 'startedAt', 'state', 'targetVersion', 'timeoutSeconds'],
    );
    assert.equal(u.configured, true);
    assert.equal(u.state, 'idle');
    assert.equal(u.problem, null);
    assert.equal(u.targetVersion, '0.0.17');
    assert.equal(u.timeoutSeconds, 60);
    assert.deepEqual(u.command, b.configs['ws-exemplo']!.update!.command);
    const two = list[2]!.update!;
    assert.equal(two.configured, false);
    assert.equal(two.problem, 'credential-missing');
    assert.equal(two.message?.key, 'problem-credential-missing');
  });

  test('POST check from the /ui: 202 { update } checking; the fake ssh ran once with the check tail', async () => {
    const b = await boot();
    b.s.set(CHECK_OK);
    const r = await call(b.api.url, 'POST', CHECK, b.own, '{"command":["/bin/sh","-c","id"]}');
    assert.equal(r.status, 202);
    assert.equal(r.body.update.state, 'checking');
    assert.equal(r.body.update.canCancel, true);
    await b.updater.settled('ws-exemplo');
    const runs = b.s.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.argv.at(-1), '--check');
    assert.equal(JSON.stringify(runs[0]!.argv).includes('/bin/sh'), false, 'nothing from the body reaches the argv');
    const after = await call(b.api.url, 'GET', '/api/machines');
    assert.equal(after.body[1].update.state, 'ready');
  });

  test('POST update without a good check: 409 check-required; with one: 202; a second POST gets the same job (one ssh)', async () => {
    const b = await boot();
    const no = await call(b.api.url, 'POST', UPDATE, b.own);
    assert.equal(no.status, 409);
    assert.equal(no.body.reason, 'check-required');
    assert.equal(b.s.runs().length, 0);
    b.s.set(CHECK_OK);
    await call(b.api.url, 'POST', CHECK, b.own);
    await b.updater.settled('ws-exemplo');
    b.s.set({ steps: [{ out: phase('check') }, { out: phase('backup') }, { sleep: 300 }, { out: result(0) }], exit: 0 });
    const [one, two] = await Promise.all([call(b.api.url, 'POST', UPDATE, b.own), call(b.api.url, 'POST', UPDATE, b.own)]);
    assert.deepEqual([one.status, two.status], [202, 202]);
    assert.equal(one.body.update.state, 'running');
    await b.updater.settled('ws-exemplo');
    assert.equal(b.s.runs().length, 2, 'the check and ONE update');
    assert.equal(b.s.runs()[1]!.argv.includes('--check'), false);
  });

  test('DELETE: in the check phase 200 canceled; from the backup on 409 not-cancelable; with nothing running 409 not-running', async () => {
    const b = await boot();
    assert.deepEqual((await call(b.api.url, 'DELETE', UPDATE, b.own)).body.reason, 'not-running');
    b.s.set({ steps: [{ out: phase('check') }, { sleep: 30_000 }], exit: 0 });
    await call(b.api.url, 'POST', CHECK, b.own);
    const del = await call(b.api.url, 'DELETE', UPDATE, b.own);
    assert.equal(del.status, 200);
    assert.equal(del.body.update.state, 'canceled');
    await b.updater.settled('ws-exemplo');

    b.s.set(CHECK_OK);
    await call(b.api.url, 'POST', CHECK, b.own);
    await b.updater.settled('ws-exemplo');
    b.s.set({ steps: [{ out: phase('check') }, { out: phase('backup') }, { sleep: 500 }, { out: result(0) }], exit: 0 });
    await call(b.api.url, 'POST', UPDATE, b.own);
    const { until } = await import('../telemetry/core-update-fixture.ts');
    await until(() => b.updater.status('ws-exemplo')!.phase === 'backup');
    const no = await call(b.api.url, 'DELETE', UPDATE, b.own);
    assert.equal(no.status, 409);
    assert.equal(no.body.reason, 'not-cancelable');
    await b.updater.settled('ws-exemplo');
  });

  test('a request with no Origin (the tray, a local process) or another Origin gets 403 on all three routes, and nothing runs', async () => {
    const b = await boot();
    b.s.set(CHECK_OK);
    for (const headers of [{}, { origin: 'http://example.test' }, { origin: 'null' }, { origin: `https://${b.host}` }, { ...b.own, host: 'example.test' }] as Record<string, string>[]) {
      assert.equal((await call(b.api.url, 'POST', CHECK, headers)).status, 403, JSON.stringify(headers));
      assert.equal((await call(b.api.url, 'POST', UPDATE, headers)).status, 403, JSON.stringify(headers));
      assert.equal((await call(b.api.url, 'DELETE', UPDATE, headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(b.s.runs().length, 0);
  });

  test('the route list is closed: a query, an encoded path or another verb is not the route', async () => {
    const b = await boot();
    b.s.set(CHECK_OK);
    assert.equal((await call(b.api.url, 'POST', `${CHECK}?x=1`, b.own)).status, 403);
    assert.equal((await call(b.api.url, 'POST', '/api/machines/ws%2Dexemplo/update/check', b.own)).status, 403);
    assert.equal((await call(b.api.url, 'DELETE', CHECK, b.own)).status, 403);
    assert.equal((await call(b.api.url, 'GET', CHECK, b.own)).status, 405);
    assert.equal((await call(b.api.url, 'PUT', UPDATE, b.own)).status, 403);
    assert.equal(b.s.runs().length, 0);
  });

  test('404 for an unknown id and for this machine; 409 with the reason for a machine that cannot update', async () => {
    const b = await boot();
    for (const id of ['nope', 'local']) {
      for (const [m, p] of [['POST', 'update/check'], ['POST', 'update'], ['DELETE', 'update']] as const) {
        const r = await call(b.api.url, m, `/api/machines/${id}/${p}`, b.own);
        assert.equal(r.status, 404, `${id} ${m} ${p}`);
        assert.equal(r.body.reason, 'unknown');
      }
    }
    // An id outside the id shape is not even the route of the same-origin exception.
    assert.equal((await call(b.api.url, 'POST', '/api/machines/Bad_Id/update', b.own)).status, 403);
    const none = await call(b.api.url, 'POST', '/api/machines/ws-dois/update/check', b.own);
    assert.equal(none.status, 409);
    assert.equal(none.body.reason, 'not-configured');
    b.configs['ws-exemplo'] = b.s.connection({ update: undefined as never, updateProblem: 'forbidden-flag' });
    const bad = await call(b.api.url, 'POST', CHECK, b.own);
    assert.deepEqual([bad.status, bad.body.reason], [409, 'invalid']);
    const item = (await call(b.api.url, 'GET', '/api/machines')).body[1].update;
    assert.deepEqual([item.problem, item.invalidReason, item.configured], ['invalid', 'forbidden-flag', false]);
    assert.match(item.message.text, /está inválido/);
    b.configs['ws-exemplo'] = b.s.connection();
    b.setInvalid(true);
    const file = await call(b.api.url, 'POST', CHECK, b.own);
    assert.deepEqual([file.status, file.body.reason], [409, 'invalid-file']);
    assert.equal(b.s.runs().length, 0);
  });
});
