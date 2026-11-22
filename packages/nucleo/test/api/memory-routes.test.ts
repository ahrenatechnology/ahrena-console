// The memory read routes through the real server and against the authored contract (#735) and (#719): the gate, the contract, the local and remote split.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMemoryRoute } from '../../src/api/memory-route.ts';
import { remoteRouteFor } from '../../src/api/owner-auth.ts';
import { fakeReads, statusReading, type FakeReads } from '../../src/memory/mocks/fake-reads.ts';
import { FAKE_DATA_DIR, FAKE_SESSION_ID, FAKE_TOKEN } from '../../src/memory/mocks/fixtures.ts';
import { OWNER_TOKEN } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';
import { assertAnswersTheSpec, declaredOperations, readSpec, routeKey } from './openapi-spec.ts';
import { call, remoteFixture, type Fixture } from './remote-credential-fixture.ts';

let current: FakeReads = fakeReads().memory;
const memory: FakeReads = {
  status: () => current.status(),
  statusWithLocal: () => current.statusWithLocal(),
  recent: (project) => current.recent(project),
  bridgeHandoffsWithLocal: (project) => current.bridgeHandoffsWithLocal(project),
  sessionHandoffsWithLocal: (project, id) => current.sessionHandoffsWithLocal(project, id),
  sessionCaptured: (project, id) => current.sessionCaptured(project, id),
};
const route = createMemoryRoute({ memory });

let demo: DemoApi;
before(async () => {
  demo = await startDemoApi({ extra: { memory: route } });
});
after(async () => {
  await demo.close();
});

async function get(path: string, headers: Record<string, string> = { authorization: `Bearer ${OWNER_TOKEN}` }, reads = fakeReads()) {
  current = reads.memory;
  const r = await call(demo.api.url, path, 'GET', headers);
  return { ...r, calls: reads.calls };
}

const PATHS = {
  state: '/api/memory',
  handoffs: '/api/memory/handoffs?project=app',
  pages: '/api/memory/pages?project=app',
  session: `/api/memory/sessions/${FAKE_SESSION_ID}?project=app`,
} as const;
const TEMPLATES = { state: '/api/memory', handoffs: '/api/memory/handoffs', pages: '/api/memory/pages', session: '/api/memory/sessions/{sessionId}' } as const;

describe('#735 the contract declares the memory read routes', () => {
  test('#735/AC-1 #735/AC-2 Given the spec, Then it declares the four read operations and, besides them, only the actions of #740 under /api/memory', () => {
    const operations = declaredOperations(readSpec()).filter((o) => o.path.startsWith('/api/memory'));
    const actions = ['GET /api/memory/plan', 'POST /api/memory/actions/{memoryAction}'];
    assert.deepEqual(operations.map((o) => routeKey(o.method, o.path)).sort(), [...Object.values(TEMPLATES).map((t) => `GET ${t}`), ...actions].sort());
  });

  for (const [name, path] of Object.entries(PATHS) as [keyof typeof PATHS, string][]) {
    test(`#735/AC-1 #735/AC-2 Given a running server, When GET ${TEMPLATES[name]} is called, Then the answer conforms to the contract`, async () => {
      const r = await get(path);
      assert.equal(r.status, 200);
      assertAnswersTheSpec('GET', TEMPLATES[name], r.status, r.json);
    });
  }

  test('#735/AC-1 the answers of a server with every alert, and of one that is stopped, absent or failing, conform', async () => {
    const loud = statusReading({ bind: '0.0.0.0:7421', auth_posture: { posture: 'none_loopback' }, providers: { llm: { status: 'ok', provider: 'ollama', model: 'm' }, embedding: { status: 'ok' } } });
    const alerts = await get(PATHS.state, undefined, fakeReads({ statusWithLocal: async () => ({ state: 'running', status: loud.status, local: loud.local }) }));
    assertAnswersTheSpec('GET', '/api/memory', alerts.status, alerts.json);
    assert.equal((alerts.json!.alerts as unknown[]).length, 4);
    for (const state of ['stopped', 'unavailable', 'unknown'] as const) {
      const r = await get(PATHS.state, undefined, fakeReads({ statusWithLocal: async () => ({ state }) }));
      assertAnswersTheSpec('GET', '/api/memory', r.status, r.json);
    }
  });

  test('#735/AC-2 the refusals conform: a project that is not valid, a bind that is not 127.0.0.1, a server not running, a read that fails', async () => {
    const bad = await get('/api/memory/handoffs?project=-x');
    assert.equal(bad.status, 400);
    assertAnswersTheSpec('GET', '/api/memory/handoffs', bad.status, bad.json);
    const reading = statusReading({ bind: '0.0.0.0:7421' });
    const wide = await get(PATHS.handoffs, undefined, fakeReads({ status: async () => ({ state: 'running', status: reading.status }) }));
    assert.equal(wide.status, 409);
    assertAnswersTheSpec('GET', '/api/memory/handoffs', wide.status, wide.json);
    const stopped = await get(PATHS.session, undefined, fakeReads({ status: async () => ({ state: 'stopped' }) }));
    assert.equal(stopped.status, 503);
    assertAnswersTheSpec('GET', '/api/memory/sessions/{sessionId}', stopped.status, stopped.json);
    const failed = await get(PATHS.pages, undefined, fakeReads({ recent: async () => ({ ok: false, reason: 'timeout' }) }));
    assert.equal(failed.status, 502);
    assertAnswersTheSpec('GET', '/api/memory/pages', failed.status, failed.json);
    const badSession = await get('/api/memory/sessions/-x?project=app');
    assertAnswersTheSpec('GET', '/api/memory/sessions/{sessionId}', badSession.status, badSession.json);
  });
});

describe('#735/AC-3 the routes are local: the gate, the remote credential and the machine parameter', () => {
  test('#735/AC-3 Given no owner proof, When a memory route is asked, Then it is refused and the module is not called', async () => {
    for (const path of Object.values(PATHS)) {
      const r = await get(path, {});
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.calls, [], path);
    }
  });

  test('#735/AC-3 Given a page of another site, When a memory route is asked, Then it is refused', async () => {
    const r = await get(PATHS.state, { authorization: `Bearer ${OWNER_TOKEN}`, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    assert.equal(r.text.includes(FAKE_DATA_DIR), false);
  });

  test('#735/AC-3 Given the Mac asking a remote machine with ?machine=, Then 400 local-only: no remote request gets the local fields', async () => {
    for (const path of ['/api/memory?machine=workstation', '/api/memory/handoffs?project=app&machine=workstation', '/api/memory/pages?machine=local&project=app', `/api/memory/sessions/${FAKE_SESSION_ID}?project=app&machine=workstation`]) {
      const r = await get(path);
      assert.equal(r.status, 400, path);
      assert.equal(r.json!.reason, 'local-only', path);
      assert.equal(r.text.includes(FAKE_DATA_DIR), false, path);
    }
  });

  test('#735/AC-3 the closed list of the remote credential holds none of the memory routes', () => {
    for (const target of ['/api/memory', '/api/memory/handoffs?project=app', '/api/memory/pages?project=app', `/api/memory/sessions/${FAKE_SESSION_ID}?project=app`, '/api/memory/sessions/x']) {
      assert.equal(remoteRouteFor('GET', target), null, target);
    }
  });

  describe('Given a remote credential (decision 0020)', () => {
    let f: Fixture;
    before(async () => {
      current = fakeReads().memory;
      f = await remoteFixture({ api: { memory: route } });
    });
    after(async () => f.close());

    test('#735/AC-3 When a signed request asks a memory route, Then 403 credential-route, nothing local comes out and the module is not called', async () => {
      const reads = fakeReads();
      current = reads.memory;
      const issued = await f.mint();
      for (const target of ['/api/memory', '/api/memory/handoffs?project=app', '/api/memory/pages?project=app', `/api/memory/sessions/${FAKE_SESSION_ID}?project=app`]) {
        const r = await f.signed(issued, 'GET', target);
        assert.equal(r.status, 403, target);
        assert.equal(r.json?.error, 'Rota fora da lista liberada à credencial remota.', target);
        assert.equal(r.text.includes(FAKE_DATA_DIR) || r.text.includes('/Users/'), false, target);
      }
      assert.deepEqual(reads.calls, []);
    });
  });
});

describe('#735/AC-5 #719/AC-10 no answer carries a token', () => {
  test('#719/AC-10 Given a token planted in every value the module could hold, Then no route answers it', async () => {
    const reading = statusReading();
    const planted = fakeReads({
      statusWithLocal: async () => ({ state: 'running', status: { ...reading.status, token: FAKE_TOKEN } as typeof reading.status, local: { ...reading.local, auth_token: FAKE_TOKEN } as typeof reading.local }),
    });
    const r = await get(PATHS.state, undefined, planted);
    assert.equal(r.text.includes(FAKE_TOKEN), false);
    assert.equal(/token/i.test(r.text), false);
    for (const path of [PATHS.handoffs, PATHS.pages, PATHS.session]) {
      const answer = await get(path);
      assert.equal(/token/i.test(answer.text), false, path);
    }
  });
});
