// The memory actions through the real server, against the authored contract (#740, #719): the scenario of the build, the strict
// same-origin gate, the closed remote list, and what no answer may carry. A real executor over a fake spawn and temporary folders: (#740)
// nothing real runs, and no ai-memory, launchctl or brew is ever started. (#740)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createMemoryActionsRoute } from '../../src/api/memory-actions-route.ts';
import { serverView } from '../../src/api/memory-view.ts';
import { remoteRouteFor } from '../../src/api/owner-auth.ts';
import { statusReading } from '../../src/memory/mocks/fake-reads.ts';
import { harness, type Harness, type Setup } from '../../src/memory/mocks/actions-harness.ts';
import { OWNER_TOKEN } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';
import { assertAnswersTheSpec } from './openapi-spec.ts';
import { call, remoteFixture, type Fixture } from './remote-credential-fixture.ts';

let current: Harness = harness();
const route = createMemoryActionsRoute({ actions: { plan: (id) => current.actions.plan(id), act: (id, digest, ack) => current.actions.act(id, digest, ack) } });

let demo: DemoApi;
before(async () => {
  demo = await startDemoApi({ extra: { memoryActions: route } });
});
after(async () => {
  await demo.close();
});

const OWNER = { authorization: `Bearer ${OWNER_TOKEN}` };
const own = () => ({ ...OWNER, origin: `http://${demo.host}` });
const asPage = (extra: Record<string, string> = {}) => ({ ...OWNER, origin: `http://${demo.host}`, ...extra });

function use(setup: Setup = {}): Harness {
  current = harness(setup);
  return current;
}
const get = (path: string, headers: Record<string, string> = OWNER) => call(demo.api.url, path, 'GET', headers);
const confirm = (id: string, body: unknown, headers: Record<string, string> = own()) => call(demo.api.url, `/api/memory/actions/${id}`, 'POST', headers, JSON.stringify(body));
const nothingRan = (h: Harness) => {
  assert.equal(h.sp.calls.length, 0, 'no process was started');
  const jobs = h.executor.jobs('local');
  assert.equal(jobs.current === null && jobs.queue.length === 0 && jobs.recent.length === 0, true, 'nothing was queued');
};

describe('#740/AC-1 the build scenario: activate, with a core of two accounts', () => {
  test('#740/AC-1 Given two accounts and ai-memory not active, When the person asks for the activate plan, Then it lists one setup --plan per account, the service, the four steps in order, the consent and a planDigest, and nothing is written', async () => {
    const h = use();
    const r = await get('/api/memory/plan?action=activate');
    assert.equal(r.status, 200);
    assertAnswersTheSpec('GET', '/api/memory/plan', r.status, r.json);
    const plan = r.json!.plan as { accounts: unknown[]; service: unknown; steps: { display: string[] }[]; consent: string[]; planDigest: string };
    assert.equal(plan.accounts.length, 2);
    assert.deepEqual(plan.service, { action: 'install', manager: 'launchd' });
    assert.deepEqual(plan.steps.map((s) => s.display.slice(0, 3).join(' ')), ['ai-memory setup --yes', 'ai-memory setup --yes', 'core write-config embedding_provider=none', 'ai-memory auth enable', 'ai-memory setup --yes']);
    assert.match(plan.consent.join(' '), /\.ai-memory\.toml/);
    assert.match(plan.consent.join(' '), /ignore_paths/);
    assert.match(plan.consent.join(' '), /--capture-mode allowlist/);
    assert.match(plan.planDigest, /^[0-9a-f]{16}$/);
    nothingRan(h);
    assert.throws(() => readFileSync(join(h.data, 'config.toml')), 'nothing was written');
  });

  test('#740/AC-1 #740/AC-2 #740/AC-3 When the person confirms with that planDigest from the core\'s own Origin, Then the four steps run in order, one at a time, and config.toml keeps its other keys', async () => {
    const h = use({ config: '# mine\nllm_provider = "ollama"\n[decay]\nhalf_life_days = 30\n' });
    const planned = await get('/api/memory/plan?action=activate');
    const digest = (planned.json!.plan as { planDigest: string }).planDigest;
    const r = await confirm('activate', { planDigest: digest });
    assert.equal(r.status, 202);
    assertAnswersTheSpec('POST', '/api/memory/actions/{memoryAction}', r.status, r.json);
    await h.executor.idle('local');
    assert.deepEqual(
      h.sp.calls.map((c) => c.args.filter((a) => a !== '--data-dir' && a !== h.data).join(' ')),
      ['setup --yes --no-service --agent claude-code', 'setup --yes --no-service --agent claude-code', 'auth enable --no-mcp', 'setup --yes --agent claude-code'],
    );
    assert.equal(h.sp.maxActive(), 1);
    const config = readFileSync(join(h.data, 'config.toml'), 'utf8');
    assert.ok(config.includes('embedding_provider = "none"'));
    for (const kept of ['# mine', 'llm_provider = "ollama"', '[decay]', 'half_life_days = 30']) assert.ok(config.includes(kept), kept);
    assert.ok(config.indexOf('embedding_provider') < config.indexOf('[decay]'), 'a top-level key');
    assert.equal(h.executor.jobs('local').recent[0]!.state, 'succeeded');
  });

  test('#740/AC-1 Given a stale planDigest, When the person confirms, Then 409 and nothing runs', async () => {
    const h = use();
    const r = await confirm('activate', { planDigest: '0123456789abcdef' });
    assert.equal(r.status, 409);
    assert.equal(r.json!.reason, 'stale-plan');
    assertAnswersTheSpec('POST', '/api/memory/actions/{memoryAction}', r.status, r.json);
    nothingRan(h);
  });
});

describe('#740/AC-6 a write needs the core\'s own Origin and a loopback Host', () => {
  async function digestOf(): Promise<string> {
    return ((await get('/api/memory/plan?action=activate')).json!.plan as { planDigest: string }).planDigest;
  }

  test('#740/AC-6 Given a missing, foreign or null Origin, When a confirm arrives with the right planDigest, Then 403 and nothing runs', async () => {
    const h = use();
    const planDigest = await digestOf();
    for (const origin of [undefined, 'http://evil.example', 'null', `http://127.0.0.1:${Number(demo.host.split(':')[1]) + 1}`, `https://${demo.host}`, `${'http://'}localhost:${demo.host.split(':')[1]}`]) {
      const r = await confirm('activate', { planDigest }, { ...OWNER, ...(origin === undefined ? {} : { origin }) });
      assert.equal(r.status, 403, String(origin));
      assert.equal(typeof r.json!.error, 'string', 'refused with a message, by the owner proof or by the memory gate');
    }
    nothingRan(h);
  });

  test('#740/AC-6 Given a Host that is not loopback with the right Origin, Then 403 and nothing runs', async () => {
    const h = use();
    const planDigest = await digestOf();
    const r = await confirm('activate', { planDigest }, asPage({ host: 'evil.example:80' }));
    assert.equal(r.status, 403);
    nothingRan(h);
  });

  test('#740/AC-6 Given the right Origin but no owner proof, Then it is refused and nothing runs', async () => {
    const h = use();
    const planDigest = await digestOf();
    const r = await confirm('activate', { planDigest }, { origin: `http://${demo.host}` });
    assert.equal(r.status, 403);
    nothingRan(h);
  });

  test('#740/AC-6 Given another path, method or an action that is not in the catalog, Then the gate refuses it', async () => {
    const h = use();
    for (const [method, path] of [['DELETE', '/api/memory/actions/activate'], ['PUT', '/api/memory/actions/stop'], ['POST', '/api/memory/actions/format-disk'], ['POST', '/api/memory/actions/activate/'], ['POST', '/api/memory/actions/activate?x=1']] as const) {
      const r = await call(demo.api.url, path, method, own(), '{}');
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    nothingRan(h);
  });

  test('#740/AC-6 Given the right Origin and a valid confirm, Then the gate lets it through (so the refusals above mean something)', async () => {
    const h = use({ state: { state: 'running' } });
    const r = await confirm('stop', { planDigest: ((await get('/api/memory/plan?action=stop')).json!.plan as { planDigest: string }).planDigest });
    assert.equal(r.status, 202);
    await h.executor.idle('local');
  });
});

describe('#740/AC-4 stop, deactivate and delete-data through the routes', () => {
  test('#740/AC-4 Given a running server, When delete-data is asked or confirmed, Then 409 not-stopped and nothing runs', async () => {
    const h = use({ state: { state: 'running' } });
    const plan = await get('/api/memory/plan?action=delete-data');
    assert.equal(plan.status, 409);
    assert.equal(plan.json!.reason, 'not-stopped');
    assertAnswersTheSpec('GET', '/api/memory/plan', plan.status, plan.json);
    const r = await confirm('delete-data', { planDigest: '0123456789abcdef', acknowledgeDataLoss: true });
    assert.equal(r.status, 409);
    assertAnswersTheSpec('POST', '/api/memory/actions/{memoryAction}', r.status, r.json);
    nothingRan(h);
  });

  test('#740/AC-4 Given a stopped server, When delete-data is confirmed without the acknowledgment, Then 400 and nothing runs; with it, reset --confirm runs', async () => {
    const h = use({ state: { state: 'stopped' } });
    const planned = await get('/api/memory/plan?action=delete-data');
    assert.equal(planned.status, 200);
    assertAnswersTheSpec('GET', '/api/memory/plan', planned.status, planned.json);
    const view = planned.json!.plan as { planDigest: string; deletes: string[]; keeps: string[] };
    assert.deepEqual(view.deletes, ['wiki/', 'db/', 'raw/']);
    const refused = await confirm('delete-data', { planDigest: view.planDigest });
    assert.equal(refused.status, 400);
    assert.equal(refused.json!.reason, 'acknowledgment-required');
    assertAnswersTheSpec('POST', '/api/memory/actions/{memoryAction}', refused.status, refused.json);
    nothingRan(h);
    const done = await confirm('delete-data', { planDigest: view.planDigest, acknowledgeDataLoss: true });
    assert.equal(done.status, 202);
    await h.executor.idle('local');
    assert.deepEqual(h.sp.calls[0]!.args.filter((a) => a !== '--data-dir' && a !== h.data), ['reset', '--confirm']);
  });

  test('#740/AC-4 Given a running server, the plans of stop and deactivate conform to the contract and say what happens', async () => {
    use({ state: { state: 'running' } });
    for (const action of ['stop', 'deactivate']) {
      const r = await get(`/api/memory/plan?action=${action}`);
      assert.equal(r.status, 200, action);
      assertAnswersTheSpec('GET', '/api/memory/plan', r.status, r.json);
    }
    const deactivate = (await get('/api/memory/plan?action=deactivate')).json!.plan as { notices: string[]; deletes?: string[] };
    assert.match(deactivate.notices.join(' '), /ativar de novo/);
    assert.equal(deactivate.deletes, undefined);
  });
});

describe('#740/AC-5 #719/AC-10 no answer carries a token, and a request carries no path', () => {
  test('#719/AC-10 Given every action asked and confirmed, Then no answer names a token value or the credential files, and no process was given one', async () => {
    const h = use({ state: { state: 'stopped' } });
    const texts: string[] = [];
    for (const action of ['activate', 'start', 'stop', 'deactivate', 'delete-data']) texts.push((await get(`/api/memory/plan?action=${action}`)).text);
    const planned = await get('/api/memory/plan?action=activate');
    texts.push((await confirm('activate', { planDigest: (planned.json!.plan as { planDigest: string }).planDigest })).text);
    await h.executor.idle('local');
    for (const text of texts) {
      assert.equal(/fake-token|fake-secret|auth-header|bearer/i.test(text), false);
    }
    const everything = JSON.stringify(h.sp.calls.map((c) => [c.command, c.args, c.options.env]));
    assert.equal(/auth-token|auth-header|fake-secret/i.test(everything), false);
  });

  test('#740/AC-5 Given a body that names a path, a folder or an argv, Then it is refused and nothing runs', async () => {
    const h = use();
    for (const body of [{ planDigest: '0123456789abcdef', dir: '/etc' }, { planDigest: '0123456789abcdef', CLAUDE_CONFIG_DIR: '/Users/evil/.claude' }, { planDigest: '0123456789abcdef', argv: ['rm', '-rf', '/'] }]) {
      assert.equal((await confirm('activate', body)).status, 400);
    }
    nothingRan(h);
  });
});

describe('#740/AC-6 the routes are local: the remote credential and the machine parameter', () => {
  test('#740/AC-6 the closed list of the remote credential holds none of the memory action routes', () => {
    for (const [method, target] of [['GET', '/api/memory/plan?action=activate'], ['POST', '/api/memory/actions/activate'], ['POST', '/api/memory/actions/delete-data']] as const) {
      assert.equal(remoteRouteFor(method, target), null, `${method} ${target}`);
    }
  });

  test('#740/AC-6 Given ?machine=, Then 400 local-only', async () => {
    use();
    const r = await get('/api/memory/plan?action=activate&machine=workstation');
    assert.equal(r.status, 400);
    assert.equal(r.json!.reason, 'local-only');
    assertAnswersTheSpec('GET', '/api/memory/plan', r.status, r.json);
  });

  describe('Given a remote credential (decision 0020)', () => {
    let f: Fixture;
    before(async () => {
      f = await remoteFixture({ api: { memoryActions: route } });
    });
    after(async () => f.close());

    test('#740/AC-6 When a signed request asks for a plan or confirms an action, Then 403 credential-route and nothing runs', async () => {
      const h = use();
      const issued = await f.mint();
      const asked = await f.signed(issued, 'GET', '/api/memory/plan?action=activate');
      assert.equal(asked.status, 403);
      assert.equal(asked.json?.error, 'Rota fora da lista liberada à credencial remota.');
      const body = JSON.stringify({ planDigest: '0123456789abcdef' });
      const confirmed = await f.signed(issued, 'POST', '/api/memory/actions/activate', { body });
      assert.equal(confirmed.status, 403);
      nothingRan(h);
    });
  });
});

describe('#740 a core without the memory module', () => {
  test('#740 Given no memoryActions route, When the plan or a confirm arrives, Then 404 and nothing is served', async () => {
    const bare = await startDemoApi();
    try {
      const planned = await call(bare.api.url, '/api/memory/plan?action=activate', 'GET', OWNER);
      assert.equal(planned.status, 404);
      const confirmed = await call(bare.api.url, '/api/memory/actions/activate', 'POST', { ...OWNER, origin: `http://${bare.host}` }, '{}');
      assert.equal(confirmed.status, 404);
    } finally {
      await bare.close();
    }
  });
});

describe('#740/AC-3 a later status with no authentication raises the alert (already served by #739)', () => {
  test('#740/AC-3 Given a status that reads auth_posture none_loopback, When the state is built, Then the auth-none-loopback alert is raised; with auth on, it is not', () => {
    const open = statusReading({ auth_posture: { posture: 'none_loopback' } });
    const view = serverView({ state: 'running', status: open.status, local: open.local });
    assert.deepEqual(view.alerts.map((a) => a.id), ['auth-none-loopback']);
    const closed = statusReading();
    assert.deepEqual(serverView({ state: 'running', status: closed.status, local: closed.local }).alerts, []);
  });
});
