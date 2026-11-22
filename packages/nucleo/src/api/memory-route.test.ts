// The read routes of the embedded ai-memory (#735) and (#719): GET /api/memory, /api/memory/handoffs, /api/memory/pages and /api/memory/sessions/<id>.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fakeReads, statusReading, type FakeReads } from '../memory/mocks/fake-reads.ts';
import { FAKE_DATA_DIR, FAKE_DB_PATH, FAKE_SESSION_ID, FAKE_TOKEN, OTHER_SESSION_ID } from '../memory/mocks/fixtures.ts';
import { createMemoryRoute } from './memory-route.ts';

interface Answer {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

let server: Server;
let origin: string;
let current: FakeReads;

before(async () => {
  const memory: FakeReads = {
    status: () => current.status(),
    statusWithLocal: () => current.statusWithLocal(),
    recent: (project) => current.recent(project),
    bridgeHandoffsWithLocal: (project) => current.bridgeHandoffsWithLocal(project),
    sessionHandoffsWithLocal: (project, id) => current.sessionHandoffsWithLocal(project, id),
    sessionCaptured: (project, id) => current.sessionCaptured(project, id),
  };
  const route = createMemoryRoute({ memory });
  // The core's request handler answers a throw with a bare 500 (api/server.ts) (#735).
  server = createServer((req, res) => {
    route(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"erro interno"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function parsed(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function ask(path: string, fake = fakeReads(), method = 'GET'): Promise<Answer & { calls: string[] }> {
  current = fake.memory;
  const r = await fetch(`${origin}${path}`, { method });
  const text = await r.text();
  return { status: r.status, body: parsed(text), text, calls: fake.calls };
}

const ALERT_IDS = (body: Record<string, unknown>): string[] => (body.alerts as { id: string }[]).map((a) => a.id);

describe('#735/AC-1 GET /api/memory', () => {
  test('#735/AC-1 #719/AC-5 Given a running server on 127.0.0.1, When asked, Then the state, the bind, the auth posture, the LLM and embeddings status, the counts and no alert come back', async () => {
    const r = await ask('/api/memory');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
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
    assert.deepEqual(r.calls, ['statusWithLocal']);
  });

  test('#735/AC-1 #719/AC-6 Given a bind other than 127.0.0.1, When asked, Then the bind alert is in the answer', async () => {
    const reading = statusReading({ bind: '0.0.0.0:7421' });
    const r = await ask('/api/memory', fakeReads({ statusWithLocal: async () => ({ state: 'running', status: reading.status, local: reading.local }) }));
    assert.deepEqual(ALERT_IDS(r.body), ['bind-not-loopback']);
    assert.equal(r.body.bind, '0.0.0.0:7421');
  });

  test('#735/AC-1 #719/AC-5 Given an auth posture of none_loopback, When asked, Then the auth alert is in the answer', async () => {
    const reading = statusReading({ auth_posture: { posture: 'none_loopback' } });
    const r = await ask('/api/memory', fakeReads({ statusWithLocal: async () => ({ state: 'running', status: reading.status, local: reading.local }) }));
    assert.deepEqual(ALERT_IDS(r.body), ['auth-none-loopback']);
    assert.equal(r.body.auth_posture, 'none_loopback');
  });

  test('#735/AC-1 #719/AC-12 Given an LLM provider and embeddings on, When asked, Then the LLM and the embeddings alerts are in the answer, in pt-BR', async () => {
    const base = statusReading();
    const raw = { providers: { llm: { status: 'ok', provider: 'ollama', model: 'm' }, embedding: { status: 'ok' } } };
    const reading = statusReading(raw);
    const r = await ask('/api/memory', fakeReads({ statusWithLocal: async () => ({ state: 'running', status: reading.status, local: base.local }) }));
    assert.deepEqual(ALERT_IDS(r.body), ['llm-provider-configured', 'embeddings-enabled']);
    assert.deepEqual(r.body.llm, { status: 'ok', provider: 'ollama' });
    for (const alert of r.body.alerts as { text: string }[]) assert.match(alert.text, /[áâãéêíóôõúç]/);
  });

  test('#735/AC-1 #719/AC-5 Given the server stopped, absent or failing, When asked, Then it says so with no detail of the process', async () => {
    for (const [state, expected] of [['stopped', 'stopped'], ['unavailable', 'unavailable'], ['unknown', 'failed']] as const) {
      const r = await ask('/api/memory', fakeReads({ statusWithLocal: async () => ({ state }) }));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { state: expected, alerts: [] });
    }
  });

  test('#735/AC-1 the answer is built from named fields: a field the module value carries beyond them does not come out', async () => {
    const reading = statusReading();
    const planted = { ...reading.status, token: FAKE_TOKEN, extra: { path: FAKE_DATA_DIR } };
    const r = await ask('/api/memory', fakeReads({ statusWithLocal: async () => ({ state: 'running', status: planted as typeof reading.status, local: reading.local }) }));
    assert.equal(r.text.includes(FAKE_TOKEN), false);
    assert.equal('token' in r.body || 'extra' in r.body, false);
  });
});

describe('#735/AC-2 GET /api/memory/handoffs and /api/memory/pages', () => {
  test('#735/AC-2 #719/AC-7 Given a valid project, When the handoffs are asked, Then the open handoffs come back with agent, owner under local and age, and no body field', async () => {
    const r = await ask('/api/memory/handoffs?project=app');
    assert.equal(r.status, 200);
    assert.equal(r.body.project, 'app');
    const handoffs = r.body.handoffs as Record<string, unknown>[];
    assert.equal(handoffs.length, 2);
    assert.equal(handoffs[0]!.from_agent, 'claude-code');
    assert.equal(handoffs[0]!.created_at, '2026-11-20T10:00:00Z');
    assert.deepEqual(handoffs[0]!.local, { cwd: '/Users/someone/work/app', owner_user: 'local:someone', accepted_by_user: null });
    for (const planted of ['summary', 'open_questions', 'next_steps', 'files_touched', FAKE_TOKEN, 'secret-plan']) assert.equal(r.text.includes(planted), false, planted);
    assert.deepEqual(r.calls, ['status', 'bridgeHandoffsWithLocal:app']);
  });

  test('#735/AC-2 the handoff items are built from named fields: a body field on the module value does not come out', async () => {
    const fake = fakeReads();
    const read = fake.memory.bridgeHandoffsWithLocal;
    fake.memory.bridgeHandoffsWithLocal = async (project) => {
      const result = await read(project);
      if (!result.ok) return result;
      return { ok: true, value: { handoffs: result.value.handoffs.map((h) => ({ ...h, summary: `plan ${FAKE_TOKEN}`, next_steps: ['x'] })), local: result.value.local.map((l) => ({ ...l, secret: FAKE_TOKEN })) } };
    };
    const r = await ask('/api/memory/handoffs?project=app', fake);
    for (const planted of ['summary', 'next_steps', 'secret', FAKE_TOKEN]) assert.equal(r.text.includes(planted), false, planted);
  });

  test('#735/AC-2 #719/AC-7 Given a valid project, When the pages are asked, Then the recent pages come back with title, type, date and path, and no snippet', async () => {
    const fake = fakeReads({ recent: async () => ({ ok: true, value: [{ path: 'notes/a.md', title: 'A', updated_at: '2026-11-20T09:00:00Z', snippet: `key ${FAKE_TOKEN}` } as never] }) });
    const r = await ask('/api/memory/pages?project=app', fake);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { project: 'app', pages: [{ path: 'notes/a.md', title: 'A', updated_at: '2026-11-20T09:00:00Z' }] });
    assert.equal(r.text.includes(FAKE_TOKEN), false);
  });

  test('#735/AC-2 the pages are read with the CLI: neither the status nor the bridge is called', async () => {
    const r = await ask('/api/memory/pages?project=app');
    assert.deepEqual(r.calls, ['recent:app']);
  });
});

describe('#735 the project and the session id are validated before the module is called', () => {
  const BAD_PROJECTS = ['', '-rf', 'a/b', 'a b', '..%2Fx', 'a%00b', 'x'.repeat(129), '%E2%82%AC'];
  for (const path of ['/api/memory/handoffs', '/api/memory/pages']) {
    for (const project of BAD_PROJECTS) {
      test(`#735 #719/AC-7 Given ${path}?project=${project.slice(0, 12)}…, Then 400 and the module is never called`, async () => {
        const r = await ask(`${path}?project=${project}`);
        assert.equal(r.status, 400);
        assert.equal(r.body.reason, 'invalid-project');
        assert.deepEqual(r.calls, []);
      });
    }
    test(`#735 Given ${path} with no project or the project twice, Then 400 and the module is never called`, async () => {
      for (const query of ['', '?project=a&project=b', '?other=a']) {
        const r = await ask(`${path}${query}`);
        assert.equal(r.status, 400, query);
        assert.deepEqual(r.calls, [], query);
      }
    });
  }

  for (const id of ['-x', 'a b', '.x', '_x', 'a%2Fb', 'x'.repeat(129), '%E2%82%AC']) {
    test(`#735 Given /api/memory/sessions/${id.slice(0, 12)}…, Then 400 and the module is never called`, async () => {
      const r = await ask(`/api/memory/sessions/${id}?project=app`);
      assert.equal(r.status, 400);
      assert.equal(r.body.reason, 'invalid-session-id');
      assert.deepEqual(r.calls, []);
    });
  }

  test('#735 Given a valid session id and an invalid project, Then 400 and the module is never called', async () => {
    const r = await ask(`/api/memory/sessions/${FAKE_SESSION_ID}?project=-x`);
    assert.equal(r.status, 400);
    assert.deepEqual(r.calls, []);
  });

  test('#735 an unknown query parameter is a 400, and so is any parameter on GET /api/memory', async () => {
    for (const path of ['/api/memory?x=1', '/api/memory/pages?project=app&limit=5', '/api/memory/handoffs?project=app&state=accepted']) {
      const r = await ask(path);
      assert.equal(r.status, 400, path);
      assert.equal(r.body.reason, 'invalid-query', path);
      assert.deepEqual(r.calls, [], path);
    }
  });

  test('#735 a method other than GET is a 405 and the module is never called', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await ask('/api/memory', fakeReads(), method);
      assert.equal(r.status, 405, method);
      assert.deepEqual(r.calls, [], method);
    }
  });
});

describe('#735 decision 1: the bridge is called only after status confirms the bind 127.0.0.1', () => {
  const BRIDGE_PATHS = ['/api/memory/handoffs?project=app', `/api/memory/sessions/${FAKE_SESSION_ID}?project=app`];
  const BRIDGE_CALLS = /^(?:bridgeHandoffsWithLocal|sessionHandoffsWithLocal|sessionCaptured)/;

  for (const path of BRIDGE_PATHS) {
    test(`#735 #719/AC-6 Given a bind other than 127.0.0.1, When ${path.split('?')[0]!.replace(FAKE_SESSION_ID, '<id>')} is asked, Then it refuses with the bind alert and the bridge is NOT called`, async () => {
      const reading = statusReading({ bind: '0.0.0.0:7421' });
      const fake = fakeReads({ status: async () => ({ state: 'running', status: reading.status }) });
      const r = await ask(path, fake);
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, 'bind-not-loopback');
      assert.equal((r.body.alert as { id: string }).id, 'bind-not-loopback');
      assert.match(String((r.body.alert as { text: string }).text), /127\.0\.0\.1/);
      assert.equal(fake.calls.filter((c) => BRIDGE_CALLS.test(c)).length, 0);
    });

    test(`#735 Given a server that is not running or whose status cannot be read, When ${path.split('?')[0]!.replace(FAKE_SESSION_ID, '<id>')} is asked, Then it refuses and the bridge is NOT called`, async () => {
      for (const state of [{ state: 'stopped' }, { state: 'unavailable' }, { state: 'unknown' }, { state: 'running' }] as const) {
        const fake = fakeReads({ status: async () => state });
        const r = await ask(path, fake);
        assert.equal(r.status, 503, state.state);
        assert.equal(r.body.reason, 'not-running');
        assert.equal(fake.calls.filter((c) => BRIDGE_CALLS.test(c)).length, 0, state.state);
      }
    });

    test(`#735 Given the bind 127.0.0.1, When ${path.split('?')[0]!.replace(FAKE_SESSION_ID, '<id>')} is asked, Then the bridge is called`, async () => {
      const r = await ask(path);
      assert.equal(r.status, 200);
      assert.equal(r.calls.filter((c) => BRIDGE_CALLS.test(c)).length >= 1, true);
      assert.equal(r.calls[0], 'status', 'the status is read first');
    });
  }
});

describe('#735 GET /api/memory/sessions/<id>', () => {
  test('#719/AC-8 Given a captured session that opened a handoff, When asked, Then captured is true and the handoff comes without a body', async () => {
    const r = await ask(`/api/memory/sessions/${FAKE_SESSION_ID}?project=app`);
    assert.equal(r.status, 200);
    assert.equal(r.body.session_id, FAKE_SESSION_ID);
    assert.equal(r.body.project, 'app');
    assert.equal(r.body.captured, true);
    assert.deepEqual((r.body.opened as { from_session_id: string }[]).map((h) => h.from_session_id), [FAKE_SESSION_ID]);
    for (const planted of ['summary', 'next_steps', FAKE_TOKEN]) assert.equal(r.text.includes(planted), false, planted);
  });

  test('#719/AC-8 Given a session the server never captured, When asked, Then captured is false and no handoff is listed', async () => {
    const fake = fakeReads({ sessionCaptured: async () => ({ ok: true, value: false }) });
    const r = await ask(`/api/memory/sessions/${OTHER_SESSION_ID}?project=app`, fake);
    assert.equal(r.body.captured, false);
    assert.equal(r.status, 200);
  });
});

describe('#735 a read that fails answers a generic error and a closed reason', () => {
  test('#735 Given the bridge failing with a reason, Then 502 carries our text and the reason, never the detail', async () => {
    for (const reason of ['failed', 'exit', 'timeout', 'rejected'] as const) {
      const r = await ask('/api/memory/handoffs?project=app', fakeReads({ bridgeHandoffsWithLocal: async () => ({ ok: false, reason }) }));
      assert.equal(r.status, 502, reason);
      assert.deepEqual(Object.keys(r.body).sort(), ['error', 'reason']);
      assert.equal(r.body.reason, reason);
    }
  });

  test('#735 Given the module unavailable, Then 503 with reason unavailable', async () => {
    const r = await ask('/api/memory/pages?project=app', fakeReads({ recent: async () => ({ ok: false, reason: 'unavailable' }) }));
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, 'unavailable');
  });

  test('#735 Given a module that throws with a path and a token in its message, Then the route answers nothing of it', async () => {
    const boom = fakeReads({ recent: async () => { throw new Error(`boom ${FAKE_DATA_DIR} ${FAKE_TOKEN}`); } });
    current = boom.memory;
    const r = await fetch(`${origin}/api/memory/pages?project=app`).catch(() => null);
    const text = r ? await r.text() : '';
    assert.equal(text.includes(FAKE_TOKEN) || text.includes(FAKE_DATA_DIR), false);
  });
});

describe('#735/AC-3 the local fields are in the answers of the local routes and nowhere else in them', () => {
  test('#735/AC-3 #719/AC-11 each local path and personal field is under a local key', async () => {
    const answers = [await ask('/api/memory'), await ask('/api/memory/handoffs?project=app'), await ask(`/api/memory/sessions/${FAKE_SESSION_ID}?project=app`)];
    const walk = (node: unknown, underLocal: boolean, found: string[]): string[] => {
      if (Array.isArray(node)) node.forEach((n) => walk(n, underLocal, found));
      else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (['data_dir', 'db_path', 'cwd', 'owner_user', 'accepted_by_user', 'config_path', 'service_path'].includes(key) && !underLocal) found.push(key);
          walk(value, underLocal || key === 'local', found);
        }
      }
      return found;
    };
    for (const answer of answers) assert.deepEqual(walk(answer.body, false, []), []);
    assert.equal(answers.some((a) => a.text.includes(FAKE_DATA_DIR)), true, 'the local answer does carry the path, under local');
  });
});
