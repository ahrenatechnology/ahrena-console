// POST /api/terminals/<id>/actions/<action> (#350) behind its own, strict gate (decision 0014 section 4):
// the same Origin as the Host, loopback Host, the exact path; no Origin is 403 unless
// `terminal.acceptRemoteActions`; JSON only; a body with only pid, machine and confirm.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import type { TerminalActResult, TerminalControl } from '../../src/telemetry/terminal-actions.ts';

const calls: unknown[][] = [];
let accept = false;
let next: TerminalActResult = { kind: 'sent', action: 'interrupt', signal: 'SIGINT', pid: 41233, target: 'command' };
const control: TerminalControl = {
  act: async (...args) => (calls.push(args), next),
  acceptNoOriginActions: () => accept,
};

const storage = openSqliteStorage({ path: ':memory:' });
const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, terminals: control });
const host = `127.0.0.1:${new URL(api.url).port}`;
after(async () => {
  await api.close();
  await storage.close();
});

function post(path: string, headers: Record<string, string>, body?: string, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request(`${api.url}${path}`, { method, agent: false, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const ui = { origin: `http://${host}`, 'content-type': 'application/json' };
const PATH = '/api/terminals/pts-0/actions/interrupt';

describe('#350 the gate', () => {
  test('same Origin and JSON: 200 with the result, and the control gets the ids', async () => {
    calls.length = 0;
    const r = await post(PATH, ui, '{"pid":41233}');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { result: 'sent', action: 'interrupt', signal: 'SIGINT', pid: 41233, target: 'command' });
    assert.deepEqual(calls, [['local', 'pts-0', 'interrupt', 41233, false]]);
  });

  test('another Origin, the null Origin and a wrong Host are 403 and nothing runs', async () => {
    calls.length = 0;
    assert.equal((await post(PATH, { ...ui, origin: 'https://exemplo.dev' }, '{"pid":1}')).status, 403);
    assert.equal((await post(PATH, { ...ui, origin: 'null' }, '{"pid":1}')).status, 403);
    assert.equal((await post(PATH, { ...ui, host: 'exemplo.dev' }, '{"pid":1}')).status, 403);
    assert.deepEqual(calls, []);
  });

  test('no Origin is 403 by default, and passes only when the config accepts remote actions', async () => {
    calls.length = 0;
    const headers = { 'content-type': 'application/json' };
    accept = false;
    assert.equal((await post(PATH, headers, '{"pid":1}')).status, 403);
    accept = true;
    assert.equal((await post(PATH, headers, '{"pid":1}')).status, 200);
    accept = false;
    assert.equal(calls.length, 1);
  });

  test('only POST on the exact path: other actions, ids and encodings are 403', async () => {
    for (const [i, [path, method]] of ([[PATH, 'DELETE'], ['/api/terminals/pts-0/actions/reboot', 'POST'], ['/api/terminals/..%2fx/actions/end', 'POST'], [`${PATH}?x=1`, 'POST']] as const).entries()) {
      const r = await post(path, ui, '{"pid":1}', method).catch((e: Error) => ({ status: e.message, body: {} }));
      assert.equal(r.status, 403, `case ${i}`);
    }
  });
});

describe('#350 the body', () => {
  test('JSON only, an object with pid, and nothing else', async () => {
    assert.equal((await post(PATH, { origin: ui.origin }, '{"pid":1}')).status, 415);
    assert.equal((await post(PATH, ui, 'nope')).status, 400);
    assert.equal((await post(PATH, ui, '[]')).status, 400);
    assert.equal((await post(PATH, ui, '{}')).status, 400);
    assert.equal((await post(PATH, ui, '{"pid":"1"}')).status, 400);
    assert.equal((await post(PATH, ui, '{"pid":-1}')).status, 400);
    assert.equal((await post(PATH, ui, '{"pid":1,"command":"rm -rf /"}')).status, 400);
    assert.equal((await post(PATH, ui, '{"pid":1,"machine":"../x"}')).status, 400);
    assert.equal((await post(PATH, ui, '{"pid":1,"confirm":"yes"}')).status, 400);
    assert.equal((await post(PATH, ui, JSON.stringify({ pid: 1, pad: 'x'.repeat(2000) }))).status, 413);
  });

  test('machine and confirm reach the control', async () => {
    calls.length = 0;
    await post('/api/terminals/pts-0/actions/kill', ui, '{"pid":41233,"machine":"ws-exemplo","confirm":true}');
    assert.deepEqual(calls, [['ws-exemplo', 'pts-0', 'kill', 41233, true]]);
  });
});

describe('#350 what the control answers', () => {
  const cases: [TerminalActResult, number, string | undefined][] = [
    [{ kind: 'unknown-machine' }, 404, undefined],
    [{ kind: 'unknown-session' }, 404, 'unknown-session'],
    [{ kind: 'unreadable' }, 409, 'unreadable'],
    [{ kind: 'changed' }, 409, 'changed'],
    [{ kind: 'confirm-required' }, 409, 'confirm-required'],
    [{ kind: 'refused', reason: 'tunnel' }, 403, 'tunnel'],
    [{ kind: 'refused', reason: 'core' }, 403, 'core'],
    [{ kind: 'refused', reason: 'other-user' }, 403, 'other-user'],
    [{ kind: 'unreachable' }, 502, 'unreachable'],
    [{ kind: 'relayed', status: 409, body: { reason: 'changed' } }, 409, 'changed'],
  ];
  for (const [result, status, reason] of cases) {
    test(`${result.kind} → ${status}`, async () => {
      next = result;
      const r = await post(PATH, ui, '{"pid":41233}');
      assert.equal(r.status, status);
      assert.equal(r.body.reason, reason);
    });
  }
});
