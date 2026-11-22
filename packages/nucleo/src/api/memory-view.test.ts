// What the memory routes answer, built field by field from the module's values: the alerts, the server view and the handoff and page items (#735).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readBridgeHandoffs } from '../memory/bridge-readers.ts';
import { bridgeHandoffsFixture, FAKE_DATA_DIR, FAKE_DB_PATH, FAKE_TOKEN, statusFixture } from '../memory/mocks/fixtures.ts';
import { readStatus } from '../memory/readers.ts';
import { handoffView, isLoopbackBind, memoryAlerts, pageView, serverView } from './memory-view.ts';

/** A `status` value as the reader gives it, with the fixture's fields overridden. */
function reading(over: Record<string, unknown> = {}, providers: { llm?: Record<string, unknown>; embedding?: Record<string, unknown> } = {}) {
  const base = statusFixture() as { providers: { llm: Record<string, unknown>; embedding: Record<string, unknown> } };
  const raw = {
    ...base,
    auth_posture: { posture: 'auth_enabled' },
    providers: { ...base.providers, llm: { ...base.providers.llm, status: 'disabled', provider: null, model: null, ...providers.llm }, embedding: { ...base.providers.embedding, ...providers.embedding } },
    ...over,
  };
  return readStatus(JSON.stringify(raw));
}

describe('the loopback bind (#719/AC-6)', () => {
  test('#719/AC-6 only 127.0.0.1 with a port is the loopback bind; localhost, ::1, 0.0.0.0 and a lookalike are not confirmed', () => {
    assert.equal(isLoopbackBind('127.0.0.1:7421'), true);
    for (const bind of ['0.0.0.0:7421', 'localhost:7421', '[::1]:7421', '127.0.0.1', '127.0.0.1:7421.evil.example', '127.0.0.10:7421', '192.168.1.5:7421', '', '127.0.0.1:99999999']) {
      assert.equal(isLoopbackBind(bind), false, bind);
    }
  });
});

describe('the alerts of the status (#719/AC-5, AC-6, AC-12)', () => {
  test('#719/AC-6 a loopback bind with auth on, no LLM and no embeddings has no alert', () => {
    assert.deepEqual(memoryAlerts(reading().status), []);
  });

  test('#719/AC-6 a bind other than 127.0.0.1 carries the bind alert', () => {
    const alerts = memoryAlerts(reading({ bind: '0.0.0.0:7421' }).status);
    assert.deepEqual(alerts.map((a) => a.id), ['bind-not-loopback']);
    assert.match(alerts[0]!.text, /127\.0\.0\.1/);
  });

  test('#719/AC-5 an auth posture of none_loopback carries the auth alert', () => {
    const alerts = memoryAlerts(reading({ auth_posture: { posture: 'none_loopback', fix: 'x' } }).status);
    assert.deepEqual(alerts.map((a) => a.id), ['auth-none-loopback']);
  });

  test('#719/AC-12 an LLM provider configured carries the LLM alert, and the alert text does not carry the provider', () => {
    const alerts = memoryAlerts(reading({}, { llm: { status: 'ok', provider: 'ollama', model: 'llama3.2' } }).status);
    assert.deepEqual(alerts.map((a) => a.id), ['llm-provider-configured']);
    assert.equal(alerts[0]!.text.includes('ollama'), false);
  });

  test('#719/AC-12 embeddings that are not disabled carry the embeddings alert', () => {
    const alerts = memoryAlerts(reading({}, { embedding: { status: 'ok' } }).status);
    assert.deepEqual(alerts.map((a) => a.id), ['embeddings-enabled']);
  });

  test('#719/AC-12 every alert has an english id and a pt-BR text, and a text never carries a value of the status', () => {
    const status = reading({ bind: '10.9.8.7:7421', auth_posture: { posture: 'none_loopback' } }, { llm: { status: 'ok', provider: 'acme-llm' }, embedding: { status: 'ok' } }).status;
    const alerts = memoryAlerts(status);
    assert.deepEqual(alerts.map((a) => a.id), ['bind-not-loopback', 'auth-none-loopback', 'llm-provider-configured', 'embeddings-enabled']);
    for (const alert of alerts) {
      assert.match(alert.id, /^[a-z]+(?:-[a-z]+)+$/);
      assert.match(alert.text, /[áâãéêíóôõúç]/, 'the text is the person\'s language');
      for (const value of ['10.9.8.7', 'acme-llm']) assert.equal(alert.text.includes(value), false);
    }
  });
});

describe('the server view (#719/AC-5)', () => {
  test('#719/AC-5 a running server answers named fields only, and the local part is under local', () => {
    const { status, local } = reading();
    const view = serverView({ state: 'running', status, local });
    assert.deepEqual(view, {
      state: 'running',
      version: '3.5.1',
      bind: '127.0.0.1:7421',
      auth_posture: 'auth_enabled',
      client_auth: 'off',
      llm: { status: 'disabled', provider: null },
      embeddings: { status: 'disabled' },
      capture_mode: 'denylist',
      counts: { sessions: 3, pages_latest: 12, pages_all: 40, observations: 250 },
      storage: { database_bytes: 3276800, data_dir_free_bytes: 52428800000 },
      alerts: [],
      local: { data_dir: FAKE_DATA_DIR, db_path: FAKE_DB_PATH },
    });
  });

  test('#719/AC-5 a running server with no local part carries no local key', () => {
    const view = serverView({ state: 'running', status: reading().status });
    assert.equal('local' in view, false);
  });

  test('#719/AC-5 a stopped, absent or unreadable server says so and nothing else', () => {
    assert.deepEqual(serverView({ state: 'stopped' }), { state: 'stopped', alerts: [] });
    assert.deepEqual(serverView({ state: 'unavailable' }), { state: 'unavailable', alerts: [] });
    assert.deepEqual(serverView({ state: 'unknown' }), { state: 'failed', alerts: [] });
    assert.deepEqual(serverView({ state: 'running' }), { state: 'failed', alerts: [] });
  });
});

describe('the handoff and page items (#719/AC-7)', () => {
  test('#719/AC-7 a handoff item has the named fields and the personal ones only under local', () => {
    const { handoffs, local } = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
    const item = handoffView(handoffs[0]!, local[0]);
    assert.deepEqual(Object.keys(item).sort(), ['accepted_at', 'accepted_by', 'accepted_by_session', 'created_at', 'from_agent', 'from_session_id', 'id', 'local', 'state', 'to_agent']);
    assert.deepEqual(item.local, { cwd: '/Users/someone/work/app', owner_user: 'local:someone', accepted_by_user: null });
    const { local: _local, ...rest } = item;
    for (const name of ['owner_user', 'accepted_by_user', 'cwd', '/Users/', 'summary', 'next_steps', FAKE_TOKEN]) assert.equal(JSON.stringify(rest).includes(name), false, name);
  });

  test('#719/AC-7 a page item is path, title and updated_at, whatever else the object carries', () => {
    const planted = { path: 'notes/a.md', title: 'A', updated_at: '2026-11-20T09:00:00Z', snippet: `key ${FAKE_TOKEN}` };
    assert.deepEqual(pageView(planted), { path: 'notes/a.md', title: 'A', updated_at: '2026-11-20T09:00:00Z' });
  });
});
