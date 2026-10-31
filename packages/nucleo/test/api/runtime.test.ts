import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { ManagedRuntime, RuntimeBlockedError } from '../../src/runtime/service.ts';
import { fixture } from '../runtime/fixtures.ts';

const token = 'a'.repeat(64);
async function apiFixture() {
  const f = await fixture();
  let current: string | null = token;
  const runtime = new ManagedRuntime(f.storage, f.runs);
  const panelBuilder = new MontadorDoPainel({ storage: f.storage, contas: new Accounts({ storage: f.storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder, hooks: { storage: f.storage }, port: 0, ownerToken: () => current, runtime, log: () => {} });
  return { ...f, ...api, runtime, rotate: () => { current = null; }, cleanup: async () => { await api.close(); await f.storage.close(); } };
}
function call(base: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(base + path, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('every HTTP command requires owner proof and rejects caller-supplied identity', async () => {
  const f = await apiFixture();
  try {
    for (const operation of ['start', 'resume', 'send', 'interrupt', 'close', 'respond']) {
      const body = { operation, sessionId: f.scope.sessionId };
      assert.equal((await call(f.url, '/api/runtime/commands', 'POST', body, { authorization: '' })).status, 403);
      assert.equal((await call(f.url, '/api/runtime/commands', 'POST', body, { origin: 'https://evil.invalid' })).status, 403);
    }
    for (const extra of [{ provider: 'codex' }, { accountId: 'other' }, { profileId: 'other' }, { configDir: '/tmp' }, { allowed: true }]) {
      assert.equal((await call(f.url, '/api/runtime/commands', 'POST', { operation: 'start', sessionId: f.scope.sessionId, ...extra })).status, 400);
    }
    assert.equal(f.runs.listRuns(f.scope.sessionId).length, 0);
  } finally { await f.cleanup(); }
});

test('all managed commands hit production billing refusal; discovery remains available', async () => {
  const f = await apiFixture();
  try {
    const run = f.runs.createRun(f.scope);
    f.runs.transition(f.scope, run.id, 'running');
    const approval = f.runs.request(f.scope, run.id, 'approval', Date.now() + 60_000);
    const bodies = [
      { operation: 'start' }, { operation: 'send', message: 'private synthetic message' }, { operation: 'interrupt' }, { operation: 'close' },
      { operation: 'respond', requestId: approval.id, response: { kind: 'approval', decision: 'approve' } },
    ];
    for (const body of bodies) {
      const response = await call(f.url, '/api/runtime/commands', 'POST', { sessionId: f.scope.sessionId, ...(body.operation === 'start' ? {} : { runId: run.id }), ...body });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'billing_refused');
      assert.equal(response.body.admission.allowed, false);
      assert.ok(response.body.admission.reasons.includes('extras_unverified'));
      if (body.operation !== 'start') assert.equal(response.body.runId, run.id);
    }
    const refused = (await f.storage.listEvents(f.scope.sessionId)).items.filter(event => event.type === 'runtime.command.blocked');
    assert.equal(refused.length, 4);
    for (const event of refused) {
      const data = event.data as Record<string, unknown>;
      assert.equal(data.runId, run.id); assert.equal(data.turnId, run.turnId);
      assert.equal(data.requestId, data.operation === 'respond' ? approval.id : null);
    }
    assert.equal(f.runs.getRun(run.id)!.state, 'running');
    assert.equal(f.storage.db.prepare('SELECT state FROM runtime_requests WHERE id = ?').get(approval.id)!.state, 'pending');
    f.runs.transition(f.scope, run.id, 'interrupted');
    const resume = await call(f.url, '/api/runtime/commands', 'POST', { sessionId: f.scope.sessionId, runId: run.id, operation: 'resume' });
    assert.equal(resume.body.code, 'billing_refused');
    const discovery = await call(f.url, `/api/runtime?sessionId=${f.scope.sessionId}`);
    assert.equal(discovery.status, 200); assert.equal(discovery.body.allowed, false);
    assert.ok(Object.values(discovery.body.capabilities).every(value => value === 'unsupported'));
    assert.ok(!JSON.stringify((await f.storage.listEvents(f.scope.sessionId)).items).includes('private synthetic message'));
    const session = (await f.storage.getSession(f.scope.sessionId))!;
    await f.storage.putSession({ ...session, capabilities: { ...session.capabilities!, mode: 'external' } });
    const external = await call(f.url, '/api/runtime/commands', 'POST', { sessionId: f.scope.sessionId, operation: 'start' });
    assert.equal(external.body.code, 'unmanaged_session');
    assert.equal((await call(f.url, `/api/runtime?sessionId=${f.scope.sessionId}`)).status, 200);
  } finally { await f.cleanup(); }
});

test('owner revocation and invalid run reject without durable side effects', async () => {
  const f = await apiFixture();
  try {
    await assert.rejects(f.runtime.execute(f.scope.sessionId, { operation: 'start' }, null, () => false), { code: 'owner_required' });
    const invalid = await call(f.url, '/api/runtime/commands', 'POST', { sessionId: f.scope.sessionId, operation: 'close', runId: 'foreign' });
    assert.equal(invalid.body.code, 'stale_run');
    let checks = 0;
    await assert.rejects(f.runtime.execute(f.scope.sessionId, { operation: 'start' }, null, () => ++checks < 3), { code: 'owner_required' });
    assert.equal(f.runs.listRuns(f.scope.sessionId).length, 0);
  } finally { await f.cleanup(); }
});
