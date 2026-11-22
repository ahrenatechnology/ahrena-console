// The memory action routes (#740): GET /api/memory/plan and POST /api/memory/actions/<id>, over a fake of the actions. The gate
// (Origin, Host) is the server's and is tested through it in test/api/memory-actions.test.ts. (#740)
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { MemoryActionPlan, MemoryActions, MemoryActResult, MemoryPlanResult } from '../memory/actions.ts';
import type { ToolJob } from '../tools/executor.ts';
import type { IncomingMessage } from 'node:http';
import { createMemoryActionsRoute, isMemoryWrite, memoryWriteAllowed } from './memory-actions-route.ts';

const DIGEST = '0123456789abcdef';
const plan = (over: Partial<MemoryActionPlan> = {}): MemoryActionPlan => ({
  actionId: 'activate',
  label: 'Ativar a memória',
  steps: [{ display: ['ai-memory', 'setup', '--yes', '--no-service', '--agent', 'claude-code'], account: 0 }],
  timeoutSeconds: 180,
  planDigest: DIGEST,
  accounts: [{ dir: '/Users/someone/.claude', setup: { fresh: true, service: { action: 'install', manager: 'launchd' }, agents: [{ agent: 'claude-code', found: true, wiring: 'hooks' }], other_agents: [] } }],
  service: { action: 'install', manager: 'launchd' },
  dataDir: '/Users/someone/.local/share/ai-memory',
  deletes: [],
  keeps: [],
  needsAcknowledgment: false,
  startNeedsActivation: false,
  ...over,
});
const job = (): ToolJob => ({
  id: 'a1b2c3d4e5f6',
  toolId: 'ai-memory',
  actionId: 'activate',
  label: 'Ativar a memória',
  machine: 'local',
  state: 'queued',
  steps: [['ai-memory', 'setup']],
  step: 0,
  phase: 'running',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  timeoutSeconds: 180,
  targetVersion: null,
  output: ['wrote /Users/someone/secret'],
  logFile: '/Users/someone/.ahrena-console/tools.log',
});

let server: Server;
let origin: string;
const calls: string[] = [];
let planAnswer: MemoryPlanResult = { kind: 'plan', plan: plan() };
let actAnswer: MemoryActResult = { kind: 'queued', job: job() };
const actions: MemoryActions = {
  plan: async (id) => (calls.push(`plan ${id}`), planAnswer),
  act: async (id, digest, ack) => (calls.push(`act ${id} ${digest} ${ack}`), actAnswer),
};

before(async () => {
  const route = createMemoryActionsRoute({ actions });
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

interface Answer {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function ask(path: string, init: { method?: string; body?: string; type?: string | null } = {}): Promise<Answer> {
  calls.length = 0;
  const headers: Record<string, string> = init.type === null ? {} : { 'content-type': init.type ?? 'application/json' };
  const r = await fetch(`${origin}${path}`, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: init.body }) });
  const text = await r.text();
  const body: unknown = JSON.parse(text);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  return { status: r.status, body: Object.fromEntries(Object.entries(body)), text };
}
// The path of an action, built so that a path that is not in the catalog is no route string of the code (#740).
const actionPath = (id: string): string => `/api/memory/actions/${id}`;
const post = (id: string, body: unknown, type?: string | null) => ask(`/api/memory/actions/${id}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...(type === undefined ? {} : { type }) });

describe('#740/AC-1 GET /api/memory/plan', () => {
  test('#740/AC-1 Given an activate plan, When asked, Then the steps, the accounts, the service, the digest and the consent come back and nothing is queued', async () => {
    planAnswer = { kind: 'plan', plan: plan() };
    const r = await ask('/api/memory/plan?action=activate');
    assert.equal(r.status, 200);
    const view = r.body.plan as Record<string, unknown>;
    assert.deepEqual(Object.keys(view).sort(), ['accounts', 'actionId', 'consent', 'dataDir', 'label', 'notices', 'planDigest', 'service', 'steps', 'timeoutSeconds']);
    assert.equal(view.planDigest, DIGEST);
    assert.equal((view.accounts as unknown[]).length, 1);
    const consent = (view.consent as string[]).join(' ');
    assert.match(consent, /\.ai-memory\.toml/);
    assert.match(consent, /ignore_paths/);
    assert.match(consent, /--apply --capture-mode allowlist/);
    assert.match(consent, /embeddings/);
    assert.deepEqual(calls, ['plan activate']);
  });

  test('#740/AC-4 Given a delete-data plan, Then it lists what is deleted, what stays and the field of the acknowledgment', async () => {
    planAnswer = { kind: 'plan', plan: plan({ actionId: 'delete-data', accounts: [], service: null, dataDir: null, deletes: ['wiki/', 'db/', 'raw/'], keeps: ['config.toml', 'access-credentials', 'logs'], needsAcknowledgment: true }) };
    const r = await ask('/api/memory/plan?action=delete-data');
    const view = r.body.plan as Record<string, unknown>;
    assert.deepEqual(view.deletes, ['wiki/', 'db/', 'raw/']);
    assert.deepEqual(view.keeps, ['config.toml', 'auth-tokens/', 'logs']);
    assert.deepEqual(Object.keys(view.acknowledgment as object), ['field', 'text']);
    assert.equal((view.acknowledgment as { field: string }).field, 'acknowledgeDataLoss');
    assert.equal('consent' in view, false);
  });

  test('#740/AC-4 Given a deactivate plan, Then it says that starting needs a new activation', async () => {
    planAnswer = { kind: 'plan', plan: plan({ actionId: 'deactivate', accounts: [], service: null, dataDir: null, startNeedsActivation: true }) };
    const view = (await ask('/api/memory/plan?action=deactivate')).body.plan as { notices: string[] };
    assert.match(view.notices.join(' '), /ativar de novo/);
  });

  test('#740/AC-4 Given an action that is not offered, Then 409 with a closed reason and our pt-BR text', async () => {
    planAnswer = { kind: 'not-offered', reason: 'not-stopped' };
    const r = await ask('/api/memory/plan?action=delete-data');
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'not-stopped');
    assert.match(r.body.error as string, /parada/);
  });

  test('#740 Given an unreadable setup plan, Then 502 (503 with no binary) with a closed reason and no detail', async () => {
    planAnswer = { kind: 'unreadable', reason: 'timeout' };
    const r = await ask('/api/memory/plan?action=activate');
    assert.equal(r.status, 502);
    assert.equal(r.body.reason, 'timeout');
    planAnswer = { kind: 'unreadable', reason: 'unavailable' };
    assert.equal((await ask('/api/memory/plan?action=activate')).status, 503);
  });

  test('#740 Given an unknown action, a missing, repeated or extra parameter or a machine, Then it is refused and the actions are not asked', async () => {
    assert.equal((await ask('/api/memory/plan?action=format-disk')).status, 404);
    assert.equal((await ask('/api/memory/plan')).status, 404);
    assert.equal((await ask('/api/memory/plan?action=stop&action=start')).body.reason, 'invalid-query');
    assert.equal((await ask('/api/memory/plan?action=stop&x=1')).body.reason, 'invalid-query');
    const machine = await ask('/api/memory/plan?action=stop&machine=ws');
    assert.equal(machine.status, 400);
    assert.equal(machine.body.reason, 'local-only');
    assert.deepEqual(calls, []);
  });

  test('#740 Given a method other than GET on the plan, Then 405', async () => {
    assert.equal((await ask('/api/memory/plan?action=stop', { method: 'POST', body: '{}' })).status, 405);
  });
});

describe('#740/AC-1 POST /api/memory/actions/<id>', () => {
  test('#740/AC-1 Given the digest of the plan, When confirmed, Then 202 with the job and only its named fields', async () => {
    actAnswer = { kind: 'queued', job: job() };
    const r = await post('activate', { planDigest: DIGEST });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.body.job as object), ['id', 'toolId', 'actionId', 'label', 'state', 'steps', 'step', 'phase', 'startedAt', 'endedAt', 'exitCode', 'timeoutSeconds']);
    assert.equal(r.text.includes('/Users/someone'), false, 'neither the output nor the log path');
    assert.deepEqual(calls, [`act activate ${DIGEST} false`]);
  });

  test('#740/AC-4 Given the acknowledgment, Then it reaches the actions', async () => {
    await post('delete-data', { planDigest: DIGEST, acknowledgeDataLoss: true });
    assert.deepEqual(calls, [`act delete-data ${DIGEST} true`]);
  });

  test('#740/AC-1 Given a stale plan, Then 409 with the new plan', async () => {
    actAnswer = { kind: 'stale', plan: plan({ planDigest: 'fedcba9876543210' }) };
    const r = await post('activate', { planDigest: DIGEST });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'stale-plan');
    assert.equal((r.body.plan as { planDigest: string }).planDigest, 'fedcba9876543210');
  });

  test('#740/AC-4 Given delete-data without the acknowledgment, Then 400 and nothing is queued', async () => {
    actAnswer = { kind: 'acknowledgment-required', plan: plan({ actionId: 'delete-data' }) };
    const r = await post('delete-data', { planDigest: DIGEST });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'acknowledgment-required');
  });

  test('#740/AC-4 Given an action that is not offered or unreadable, Then 409 or 502 with the closed reason', async () => {
    actAnswer = { kind: 'not-offered', reason: 'not-stopped' };
    const refused = await post('delete-data', { planDigest: DIGEST, acknowledgeDataLoss: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, 'not-stopped');
    actAnswer = { kind: 'unreadable', reason: 'exit' };
    assert.equal((await post('activate', { planDigest: DIGEST })).status, 502);
  });

  test('#740 Given a request that is not valid, Then it is refused before the actions are asked', async () => {
    assert.equal((await post('activate', { planDigest: DIGEST }, 'text/plain')).status, 415);
    assert.equal((await post('activate', { planDigest: DIGEST }, null)).status, 415);
    assert.equal((await post('activate', 'x'.repeat(5000))).status, 413);
    assert.equal((await post('activate', '{not json')).status, 400);
    assert.equal((await post('activate', '[]')).status, 400);
    assert.equal((await post('activate', {})).status, 400);
    assert.equal((await post('activate', { planDigest: 'short' })).status, 400);
    assert.equal((await post('activate', { planDigest: DIGEST, extra: 1 })).status, 400);
    assert.equal((await post('delete-data', { planDigest: DIGEST, acknowledgeDataLoss: 'yes' })).status, 400);
    const machine = await post('activate', { planDigest: DIGEST, machine: 'ws' });
    assert.equal(machine.status, 400);
    assert.equal(machine.body.reason, 'local-only');
    assert.equal((await post('format-disk', { planDigest: DIGEST })).status, 404);
    assert.deepEqual(calls, []);
  });
});

describe('#740/AC-6 memoryWriteAllowed: our Host, the exact path and exactly our Origin', () => {
  const PORT = 4801;
  const req = (o: { host?: string; method?: string; url?: string; origin?: string }): Pick<IncomingMessage, 'method' | 'url' | 'headers'> =>
    ({ method: o.method ?? 'POST', url: o.url ?? actionPath('activate'), headers: { host: o.host ?? `127.0.0.1:${PORT}`, ...(o.origin === undefined ? {} : { origin: o.origin }) } });
  const ours = `http://127.0.0.1:${PORT}`;

  test('#740/AC-6 Given our Host and our Origin on an action path, Then it is allowed (127.0.0.1 and localhost)', () => {
    assert.equal(memoryWriteAllowed(req({ origin: ours }), PORT), true);
    assert.equal(memoryWriteAllowed(req({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), PORT), true);
    for (const id of ['stop', 'start', 'deactivate', 'delete-data']) assert.equal(memoryWriteAllowed(req({ url: actionPath(id), origin: ours }), PORT), true, id);
  });

  test('#740/AC-6 Given no Origin, another Origin, Origin null, another port or scheme, Then it is refused: there is no switch that lets a write through without one', () => {
    for (const origin of [undefined, 'null', 'http://evil.example', `http://127.0.0.1:${PORT + 1}`, `https://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `${ours}/`, '']) assert.equal(memoryWriteAllowed(req(origin === undefined ? {} : { origin }), PORT), false, String(origin));
  });

  test('#740/AC-6 Given a Host that is not ours, Then it is refused even with the matching Origin', () => {
    for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, '0.0.0.0:4801', '']) assert.equal(memoryWriteAllowed(req({ host, origin: `http://${host}` }), PORT), false, host);
  });

  test('#740/AC-6 Given another method or another path, Then it is refused', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal(memoryWriteAllowed(req({ method, origin: ours }), PORT), false, method);
    for (const url of [actionPath('format-disk'), `${actionPath('activate')}/`, `${actionPath('activate')}?x=1`, actionPath('%61ctivate'), '/api/memory/plan', '/api/memory/actions/']) assert.equal(memoryWriteAllowed(req({ url, origin: ours }), PORT), false, url);
  });

  test('#740/AC-6 Every non-GET request under /api/memory/actions/ is a memory write, and nothing else is', () => {
    assert.equal(isMemoryWrite(req({ method: 'POST' }), actionPath('activate')), true);
    assert.equal(isMemoryWrite(req({ method: 'DELETE' }), actionPath('whatever')), true);
    assert.equal(isMemoryWrite(req({ method: 'GET' }), actionPath('activate')), false);
    assert.equal(isMemoryWrite(req({ method: 'POST' }), '/api/memory/handoffs'), false);
  });
});
