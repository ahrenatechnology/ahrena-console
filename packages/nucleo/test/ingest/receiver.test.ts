import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { ingestHook, startHookReceiver, type HookReceiver, type IngestResult } from '../../src/ingest/hooks/index.ts';
import { T0, at } from '../fixtures.ts';
import { HOOK_NAMES, HOOK_PAYLOADS } from './hook-payloads.ts';

describe('gravação pela porta', () => {
  let store: SqliteStorage;
  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => store.close());

  test('o primeiro hook cria o registro mínimo da sessão', async () => {
    const r = await ingestHook(store, HOOK_PAYLOADS.SessionStart, { receivedAt: T0 });
    assert.equal(r.sessionCreated, true);
    assert.equal(r.appended, true);
    const s = await store.getSession('sess-hooks-1');
    assert.equal(s?.status, 'active');
    assert.equal(s?.cwd, '/repo/app');
    assert.equal(s?.model, 'claude-opus-5-5');
    assert.equal(s?.source, 'startup');
    assert.equal(s?.startedAt, T0);
    assert.equal(s?.metadata.transcriptPath, HOOK_PAYLOADS.SessionStart.transcript_path);
  });

  test('não mexe em status nem espera; a última atividade não anda para trás', async () => {
    await ingestHook(store, HOOK_PAYLOADS.SessionStart, { receivedAt: at(5) });
    const s = await store.getSession('sess-hooks-1');
    await store.putSession({ ...s!, status: 'completed', awaitingInputSince: at(5), awaitingReason: 'stop' });

    await ingestHook(store, HOOK_PAYLOADS.Stop, { receivedAt: at(1) });
    let now = await store.getSession('sess-hooks-1');
    assert.equal(now?.updatedAt, at(5));
    assert.equal(now?.status, 'completed');
    assert.equal(now?.awaitingReason, 'stop');

    await ingestHook(store, HOOK_PAYLOADS.UserPromptSubmit, { receivedAt: at(9) });
    now = await store.getSession('sess-hooks-1');
    assert.equal(now?.updatedAt, at(9));
    assert.equal(now?.status, 'completed');
  });

  test('entrega repetida não duplica o evento', async () => {
    const o = { receivedAt: T0, deliveryId: 'd-1' };
    assert.equal((await ingestHook(store, HOOK_PAYLOADS.Notification, o)).appended, true);
    assert.equal((await ingestHook(store, HOOK_PAYLOADS.Notification, o)).appended, false);
    assert.equal((await store.listEvents('sess-hooks-1')).items.length, 1);
  });
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/api/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('receptor HTTP', () => {
  let store: SqliteStorage;
  let receiver: HookReceiver;
  let seen: IngestResult[];
  let logs: string[];

  beforeEach(async () => {
    store = openSqliteStorage({ path: ':memory:' });
    seen = [];
    logs = [];
    receiver = await startHookReceiver({
      storage: store,
      port: 0,
      onEvent: (r) => {
        seen.push(r);
      },
      log: (m) => logs.push(m),
    });
  });
  afterEach(async () => {
    await receiver.close();
    await store.close();
  });

  test('escuta só no 127.0.0.1', () => {
    assert.match(receiver.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('uma sessão inteira, evento por evento, fica gravada em ordem', async () => {
    for (const [i, name] of HOOK_NAMES.entries()) {
      const res = await post(receiver.url, HOOK_PAYLOADS[name], { 'x-ahrena-hook-at': at(i), 'x-ahrena-delivery-id': `d${i}` });
      assert.equal(res.status, 202, name);
      assert.equal((await res.json()).duplicate, false);
    }
    const events = (await store.listEvents('sess-hooks-1')).items;
    assert.deepEqual(events.map((e) => e.type), HOOK_NAMES);
    assert.deepEqual(seen.map((r) => r.event.type), HOOK_NAMES);
    assert.equal((await store.getSession('sess-hooks-1'))?.updatedAt, at(HOOK_NAMES.length - 1));
  });

  test('hooks simultâneos da mesma sessão não se atropelam', async () => {
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(receiver.url, { ...HOOK_PAYLOADS.PreToolUse, tool_use_id: `t${i}` })),
    );
    assert.ok(all.every((r) => r.status === 202));
    assert.equal((await store.listEvents('sess-hooks-1')).items.length, 20);
    assert.equal((await store.listSessions()).items.length, 1);
  });

  test('reenvio responde 202 marcado como duplicado e não chama onEvent de novo', async () => {
    const h = { 'x-ahrena-delivery-id': 'mesma' };
    await post(receiver.url, HOOK_PAYLOADS.Stop, h);
    const res = await post(receiver.url, HOOK_PAYLOADS.Stop, h);
    assert.equal(res.status, 202);
    assert.equal((await res.json()).duplicate, true);
    assert.equal(seen.length, 1);
  });

  test('erro no onEvent é registrado e não derruba a gravação', async () => {
    await receiver.close();
    receiver = await startHookReceiver({
      storage: store,
      port: 0,
      onEvent: () => {
        throw new Error('máquina de estados quebrou');
      },
      log: (m) => logs.push(m),
    });
    assert.equal((await post(receiver.url, HOOK_PAYLOADS.Stop)).status, 202);
    assert.equal((await store.listEvents('sess-hooks-1')).items.length, 1);
    assert.match(logs.join('\n'), /máquina de estados quebrou/);
  });

  test('recusa o que não é hook', async () => {
    assert.equal((await post(receiver.url, '{nada')).status, 400);
    assert.equal((await post(receiver.url, { hook_event_name: 'Stop' })).status, 400);
    assert.equal((await post(receiver.url, HOOK_PAYLOADS.Stop, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(receiver.url, 'x'.repeat(1024 * 1024 + 10))).status, 413);
    assert.equal((await fetch(`${receiver.url}/api/hooks`)).status, 405);
    assert.equal((await fetch(`${receiver.url}/outra`)).status, 404);
    assert.equal((await store.listSessions()).items.length, 0);
  });

  test('recusa requisição de navegador ou com Host de fora (decisão 0003)', async () => {
    const { request } = await import('node:http');
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${receiver.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(JSON.stringify(HOOK_PAYLOADS.Stop));
      });
    assert.equal(await status({ origin: 'https://exemplo.com' }), 403);
    assert.equal(await status({ host: 'atacante.exemplo:80' }), 403);
    assert.equal(await status({ host: receiver.url.replace('http://127.0.0.1', 'localhost') }), 202);
    assert.equal((await store.listEvents('sess-hooks-1')).items.length, 1);
  });

  test('health responde', async () => {
    const res = await fetch(`${receiver.url}/api/hooks/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
