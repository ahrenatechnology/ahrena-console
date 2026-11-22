// The memory readers: field-by-field reprojection of what the real v3.5.1 binary confirmed (#727/AC-3).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FAKE_DATA_DIR, FAKE_DB_PATH, FAKE_TOKEN, handoffsFixture, recentFixture, statusFixture } from './mocks/fixtures.ts';
import { MemoryReadError, readHandoffs, readRecent, readSetupPlan, readStatus, readVersion } from './readers.ts';

const PLAN = {
  format: 1,
  data_dir: '/Users/someone/.ahrena-console/ai-memory',
  config_path: '/Users/someone/.ahrena-console/ai-memory/config.toml',
  fresh: true,
  service: { action: 'install', manager: 'launchd', path: '/Users/someone/Library/LaunchAgents/ai-memory.plist' },
  agents: [{ agent: 'claude-code', found: true, wiring: 'mcp' }],
  other_agents: ['codex'],
};

describe('readVersion (#727/AC-3)', () => {
  test('#727/AC-3 "ai-memory 3.5.1" is { version: "3.5.1" }', () => {
    assert.deepEqual(readVersion('ai-memory 3.5.1\n'), { version: '3.5.1' });
  });

  for (const bad of ['', 'ai-memory', '3.5.1', 'other-tool 3.5.1', 'ai-memory 3.5.1 extra', 'ai-memory 3.5\n', 'ai-memory 3.5.1\nsecond line']) {
    test(`#727/AC-3 ${JSON.stringify(bad)} is rejected`, () => {
      assert.throws(() => readVersion(bad), MemoryReadError);
    });
  }
});

describe('readSetupPlan (#727/AC-3)', () => {
  test('#727/AC-3 #734/D2 a format 1 plan comes back field by field, with its local paths held apart', () => {
    assert.deepEqual(readSetupPlan(JSON.stringify(PLAN)), {
      plan: {
        fresh: true,
        service: { action: 'install', manager: 'launchd' },
        agents: [{ agent: 'claude-code', found: true, wiring: 'mcp' }],
        other_agents: ['codex'],
      },
      local: { data_dir: PLAN.data_dir, config_path: PLAN.config_path, service_path: PLAN.service.path },
    });
  });

  test('#727/AC-3 #734/D2 the shareable plan names no path: data_dir, config_path and the service path are only in the local part', () => {
    const { plan, local } = readSetupPlan(JSON.stringify(PLAN));
    const text = JSON.stringify(plan);
    for (const path of [PLAN.data_dir, PLAN.config_path, PLAN.service.path]) assert.equal(text.includes(path), false);
    assert.deepEqual(Object.keys(local).sort(), ['config_path', 'data_dir', 'service_path']);
  });

  test('#727/AC-3 any field outside the list is dropped, at the top and inside each object', () => {
    const noisy = {
      ...PLAN,
      auth_token: 'fake-token-0000-not-real',
      service: { ...PLAN.service, secret: 'fake-token-0000-not-real' },
      agents: [{ agent: 'claude-code', found: false, wiring: 'none', env: { AI_MEMORY_AUTH_TOKEN: 'fake-token-0000-not-real' } }],
    };
    const out = readSetupPlan(JSON.stringify(noisy));
    assert.equal(JSON.stringify(out).includes('fake-token-0000-not-real'), false);
    assert.deepEqual(Object.keys(out.plan).sort(), ['agents', 'fresh', 'other_agents', 'service']);
    assert.deepEqual(Object.keys(out.plan.service).sort(), ['action', 'manager']);
    assert.deepEqual(Object.keys(out.plan.agents[0]!).sort(), ['agent', 'found', 'wiring']);
  });

  test('#727/AC-3 a service with no path or a null wiring is kept as null', () => {
    const out = readSetupPlan(JSON.stringify({ ...PLAN, service: { action: 'none', manager: 'none', path: null }, agents: [{ agent: 'claude-code', found: false, wiring: null }] }));
    assert.equal(out.local.service_path, null);
    assert.equal(out.plan.agents[0]!.wiring, null);
  });

  for (const format of [0, 2, '1', null, undefined]) {
    test(`#727/AC-3 format ${String(format)} is rejected, never passed through`, () => {
      const plan: Record<string, unknown> = { ...PLAN, format };
      if (format === undefined) delete plan.format;
      assert.throws(() => readSetupPlan(JSON.stringify(plan)), (error) => error instanceof MemoryReadError && error.code === 'unsupported-format');
    });
  }

  for (const [name, text] of [
    ['malformed JSON', '{not json'],
    ['an empty output', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['a plan without data_dir', JSON.stringify({ ...PLAN, data_dir: undefined })],
    ['a fresh that is not a boolean', JSON.stringify({ ...PLAN, fresh: 'yes' })],
    ['a service that is not an object', JSON.stringify({ ...PLAN, service: 'launchd' })],
    ['agents that is not an array', JSON.stringify({ ...PLAN, agents: {} })],
    ['an agent without found', JSON.stringify({ ...PLAN, agents: [{ agent: 'claude-code', wiring: 'mcp' }] })],
    ['other_agents with a non-string', JSON.stringify({ ...PLAN, other_agents: [1] })],
  ] as const) {
    test(`#727/AC-3 ${name} is rejected`, () => {
      assert.throws(() => readSetupPlan(text), MemoryReadError);
    });
  }

  test('#727/AC-3 the error carries a code and no part of the input', () => {
    try {
      readSetupPlan('{"format": 1, "data_dir": "fake-token-0000-not-real"');
      assert.fail('should throw');
    } catch (error) {
      assert.ok(error instanceof MemoryReadError);
      assert.equal(String(error.message).includes('fake-token-0000-not-real'), false);
      assert.equal(error.code, 'malformed-plan');
    }
  });
});

describe('readStatus (#733/AC-1, #733/AC-4)', () => {
  test('#733/AC-1 status --json is read into the listed fields only, with the paths held apart', () => {
    const { status, local } = readStatus(JSON.stringify(statusFixture()));
    assert.deepEqual(status, {
      version: '3.5.1',
      bind: '127.0.0.1:7421',
      counts: { pages_latest: 12, pages_all: 40, sessions: 3, observations: 250 },
      storage: { database_bytes: 3276800, data_dir_free_bytes: 52428800000 },
      providers: { llm: { status: 'ok', provider: 'ollama', model: 'llama3.2' }, embedding: { status: 'disabled' } },
      capture_mode: 'denylist',
      auth_posture: 'none_loopback',
      client_auth: 'off',
    });
    assert.deepEqual(local, { data_dir: FAKE_DATA_DIR, db_path: FAKE_DB_PATH });
  });

  test('#733/AC-1 the shareable part holds no path and none of the dropped fields', () => {
    const { status } = readStatus(JSON.stringify(statusFixture()));
    const text = JSON.stringify(status);
    for (const dropped of [FAKE_DATA_DIR, FAKE_DB_PATH, 'server_url', 'spool', 'recovery', 'derived', 'ingest', 'fix', 'last_call_at', 'wiki_format']) {
      assert.equal(text.includes(dropped), false, `${dropped} must not be in the status`);
    }
  });

  test('#733/AC-1 a null data_dir_free_bytes and null provider and model are kept as null', () => {
    const raw = statusFixture() as { storage: Record<string, unknown>; providers: { llm: Record<string, unknown> } };
    raw.storage.data_dir_free_bytes = null;
    raw.providers.llm = { status: 'unknown', provider: null, model: null };
    const { status } = readStatus(JSON.stringify(raw));
    assert.equal(status.storage.data_dir_free_bytes, null);
    assert.deepEqual(status.providers.llm, { status: 'unknown', provider: null, model: null });
  });

  test('#733/AC-1 an allowlist capture mode and the other provider states are accepted', () => {
    const raw = statusFixture() as { capture_mode: string; providers: { embedding: Record<string, unknown> } };
    raw.capture_mode = 'allowlist';
    raw.providers.embedding = { status: 'error', provider: 'x', model: 'y', dim: 3 };
    const { status } = readStatus(JSON.stringify(raw));
    assert.equal(status.capture_mode, 'allowlist');
    assert.equal(status.providers.embedding.status, 'error');
  });

  test('#733/AC-4 client.auth true is "on" and false is "off", as a word and never as the value', () => {
    for (const [value, word] of [[true, 'on'], [false, 'off']] as const) {
      const raw = statusFixture() as { client: Record<string, unknown> };
      raw.client = { ...raw.client, auth: value };
      assert.equal(readStatus(JSON.stringify(raw)).status.client_auth, word);
    }
  });

  test('#733/AC-4 a client.auth that is a string (a token) is a misfit, and the error holds the code only', () => {
    const raw = statusFixture() as { client: Record<string, unknown> };
    raw.client = { ...raw.client, auth: FAKE_TOKEN };
    try {
      readStatus(JSON.stringify(raw));
      assert.fail('should throw');
    } catch (error) {
      assert.ok(error instanceof MemoryReadError);
      assert.equal(error.code, 'malformed-status');
      assert.equal(String(error.message).includes(FAKE_TOKEN), false);
    }
  });

  test('#733/AC-4 a token planted at the top level, in client and in auth_posture comes out nowhere', () => {
    const raw = statusFixture() as { client: Record<string, unknown>; auth_posture: Record<string, unknown> };
    raw.client = { ...raw.client, token: FAKE_TOKEN, auth_token: FAKE_TOKEN };
    raw.auth_posture = { ...raw.auth_posture, token: FAKE_TOKEN };
    const out = readStatus(JSON.stringify({ ...raw, token: FAKE_TOKEN, auth_token: FAKE_TOKEN }));
    assert.equal(JSON.stringify(out).includes(FAKE_TOKEN), false);
    assert.equal(/token/i.test(JSON.stringify(out)), false);
  });

  const DROP = Symbol('drop');
  for (const [name, path, value] of [
    ['a version that is not a string', ['version'], 3],
    ['a missing bind', ['bind'], DROP],
    ['a count that is not a number', ['counts', 'sessions'], '3'],
    ['a missing counts', ['counts'], DROP],
    ['a data_dir_free_bytes that is a string', ['storage', 'data_dir_free_bytes'], '1'],
    ['a provider status outside the closed list', ['providers', 'llm', 'status'], 'fine'],
    ['a provider that is a number', ['providers', 'llm', 'provider'], 1],
    ['a capture mode outside the closed list', ['capture_mode'], 'both'],
    ['a missing auth_posture', ['auth_posture'], DROP],
    ['a client.auth that is missing', ['client', 'auth'], DROP],
    ['a client.auth that is a number', ['client', 'auth'], 1],
    ['a missing data_dir', ['data_dir'], DROP],
    ['a db_path that is not a string', ['db_path'], null],
  ] as const) {
    test(`#733/AC-1 ${name} is rejected with malformed-status`, () => {
      const root = statusFixture();
      const parent = path.slice(0, -1).reduce((node, key) => node[key] as Record<string, unknown>, root);
      const last = path.at(-1)!;
      if (value === DROP) delete parent[last];
      else parent[last] = value;
      assert.throws(() => readStatus(JSON.stringify(root)), (e) => e instanceof MemoryReadError && e.code === 'malformed-status');
    });
  }

  for (const text of ['', '{not json', '[]', '"x"', 'null']) {
    test(`#733/AC-1 ${JSON.stringify(text)} is rejected with malformed-status`, () => {
      assert.throws(() => readStatus(text), (e) => e instanceof MemoryReadError && e.code === 'malformed-status');
    });
  }
});

describe('readHandoffs (#733/AC-2)', () => {
  test('#733/AC-2 #734/D1 each handoff comes back with the four listed fields and no body, and cwd in a local part', () => {
    const out = readHandoffs(JSON.stringify(handoffsFixture()));
    assert.deepEqual(out.handoffs, [
      { id: 'h-0001', from_agent: 'claude-code', to_agent: 'codex', created_at_ms: 1763632800000 },
      { id: 'h-0002', from_agent: 'codex', to_agent: null, created_at_ms: 1763632900000 },
    ]);
    assert.deepEqual(out.local, [
      { id: 'h-0001', cwd: '/Users/someone/work/app' },
      { id: 'h-0002', cwd: null },
    ]);
    assert.equal(JSON.stringify(out.handoffs).includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(out).includes('body'), false);
    assert.equal(JSON.stringify(out.handoffs).includes('/Users/'), false);
  });

  test('#733/AC-2 an empty array is an empty list', () => {
    assert.deepEqual(readHandoffs('[]'), { handoffs: [], local: [] });
  });

  for (const [name, text] of [
    ['malformed JSON', '{no'],
    ['an object instead of an array', '{}'],
    ['an item that is not an object', '["x"]'],
    ['an id that is a number', JSON.stringify([{ id: 1, from_agent: 'a', to_agent: null, cwd: null, created_at_ms: 1 }])],
    ['a missing from_agent', JSON.stringify([{ id: 'x', to_agent: null, cwd: null, created_at_ms: 1 }])],
    ['a to_agent that is a number', JSON.stringify([{ id: 'x', from_agent: 'a', to_agent: 2, cwd: null, created_at_ms: 1 }])],
    ['a created_at_ms that is a string', JSON.stringify([{ id: 'x', from_agent: 'a', to_agent: null, cwd: null, created_at_ms: '1' }])],
  ] as const) {
    test(`#733/AC-2 ${name} is rejected with malformed-handoffs`, () => {
      assert.throws(() => readHandoffs(text), (e) => e instanceof MemoryReadError && e.code === 'malformed-handoffs');
    });
  }
});

describe('readRecent (#733/AC-3)', () => {
  test('#733/AC-3 a planted snippet, workspace, project and unknown field do not appear in the result', () => {
    const planted = recentFixture().map((page) => ({ ...page, workspace: 'default', project: 'app', surprise: FAKE_TOKEN }));
    const out = readRecent(JSON.stringify(planted));
    assert.deepEqual(out, [
      { path: 'notes/design.md', title: 'Design notes', updated_at: '2026-11-20T09:00:00Z' },
      { path: 'notes/todo.md', title: 'Todo', updated_at: '2026-11-19T09:00:00Z' },
    ]);
    const text = JSON.stringify(out);
    for (const absent of ['snippet', FAKE_TOKEN, 'buy milk', 'workspace', 'project', 'surprise']) assert.equal(text.includes(absent), false, `${absent} must not appear`);
  });

  test('#733/AC-3 an empty array is an empty list', () => {
    assert.deepEqual(readRecent('[]'), []);
  });

  for (const [name, text] of [
    ['malformed JSON', 'nope'],
    ['an object instead of an array', '{}'],
    ['a page without a path', JSON.stringify([{ title: 't', updated_at: 'u' }])],
    ['a title that is null', JSON.stringify([{ path: 'p', title: null, updated_at: 'u' }])],
    ['an updated_at that is a number', JSON.stringify([{ path: 'p', title: 't', updated_at: 5 }])],
  ] as const) {
    test(`#733/AC-3 ${name} is rejected with malformed-recent`, () => {
      assert.throws(() => readRecent(text), (e) => e instanceof MemoryReadError && e.code === 'malformed-recent');
    });
  }
});
