// #280 layer 2: the Tools writes on 127.0.0.1 with the fake Mac (machines.ts) and a fake spawn:
// nothing real ever runs. The strict same-origin gate (no Origin, a foreign Origin, `Origin: null`
// and a query string all get 403 with nothing spawned; 415 without JSON), the planDigest (409 with
// the new plan, 202 with the job), the admin refusal (403), Cancel, Verificar agora, the jobs in
// GET /api/tools and the `tools` change on /api/changes.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { publishToolsChanges, ToolsExecutor, type ToolJob } from '../../src/tools/executor.ts';
import type { ToolActionView, ToolsOverview } from '../../src/tools/service.ts';
import { fakeSpawn, type SpawnCall } from './doubles.ts';
import { macService } from './machines.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-tools-routes-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

async function boot(o: { script?: (call: SpawnCall) => void; acceptNoOrigin?: boolean } = {}) {
  const { service } = macService();
  await service.check();
  const sp = fakeSpawn(o.script ?? ((call) => call.child.exit(0)));
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const executor = new ToolsExecutor({
    service,
    logFile: join(dir, `tools-${++n}.log`),
    spawn: sp.spawn,
    killGroup: sp.killGroup,
    onChange: publishToolsChanges(cursor),
    acceptNoOriginActions: () => o.acceptNoOrigin ?? false,
    log: () => {},
  });
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, tools: executor });
  const port = Number(new URL(api.url).port);
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  /** A raw request: the path exactly as given, the headers exactly as given (no Origin unless passed). */
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? (JSON.parse(data) as Record<string, unknown>) : {} }));
      });
      req.on('error', reject);
      req.end(text);
    });
  const overview = async () => (await (await fetch(`${api.url}/api/tools`)).json()) as ToolsOverview;
  const ghUpdate = async () => (await overview()).items.find((i) => i.id === 'gh')!.actions[0]!;
  return {
    sp,
    cursor,
    executor,
    origin,
    send,
    overview,
    ghUpdate,
    close: async () => {
      await executor.idle('local');
      await api.close();
      await storage.close();
    },
  };
}

describe('#280 the Tools writes', () => {
  test('the gate: no Origin, a foreign Origin, Origin null, a query string: 403 and nothing spawned; no JSON: 415', async () => {
    const t = await boot();
    try {
      const plan = await t.ghUpdate();
      const body = { planDigest: plan.planDigest, machine: 'local' };
      const path = '/api/tools/gh/actions/update';
      assert.equal((await t.send('POST', path, body)).status, 403, 'no Origin');
      assert.equal((await t.send('POST', path, body, { origin: 'https://exemplo.dev' })).status, 403);
      assert.equal((await t.send('POST', path, body, { origin: 'null' })).status, 403);
      assert.equal((await t.send('POST', path, body, { origin: t.origin.replace('127.0.0.1', 'localhost') })).status, 403, 'Origin must match the Host');
      assert.equal((await t.send('POST', `${path}?x=1`, body, { origin: t.origin })).status, 403, 'query string');
      assert.equal((await t.send('POST', '/api/tools/gh/actions/%75pdate', body, { origin: t.origin })).status, 403, 'encoded path');
      assert.equal((await t.send('GET', path, undefined, { origin: t.origin })).status, 404, 'GET is not a write');
      assert.equal((await t.send('DELETE', path, body, { origin: t.origin })).status, 403, 'wrong method');
      assert.equal((await t.send('POST', '/api/tools/checks', {})).status, 403, 'checks without Origin');
      assert.equal((await t.send('DELETE', '/api/tools/jobs/aaaaaaaaaaaa', undefined)).status, 403, 'cancel without Origin');
      assert.equal((await t.send('POST', '/api/tools/mcp/checks', {})).status, 403, "layer 3's route is gated already");
      const wrongType = await t.send('POST', path, body, { origin: t.origin, 'content-type': 'text/plain' });
      assert.equal(wrongType.status, 415);
      assert.equal(t.sp.calls.length, 0, 'nothing spawned');
      assert.deepEqual((await t.overview()).jobs, { current: null, queue: [], recent: [], batch: null });
    } finally {
      await t.close();
    }
  });

  test('planDigest: another one gets 409 with the new plan; the right one 202 with the job; the job in GET /api/tools', async () => {
    const t = await boot();
    try {
      const plan = await t.ghUpdate();
      assert.deepEqual(plan.steps, [['brew', 'upgrade', 'gh']]);
      const stale = await t.send('POST', '/api/tools/gh/actions/update', { planDigest: 'ffffffffffffffff', machine: 'local' }, { origin: t.origin });
      assert.equal(stale.status, 409);
      assert.deepEqual(stale.body.plan, plan);
      assert.equal(typeof stale.body.error, 'string');
      assert.equal(t.sp.calls.length, 0);

      const ok = await t.send('POST', '/api/tools/gh/actions/update', { planDigest: plan.planDigest, machine: 'local' }, { origin: t.origin });
      assert.equal(ok.status, 202);
      const job = ok.body.job as ToolJob;
      assert.deepEqual([job.toolId, job.actionId, job.label, job.machine, job.steps], ['gh', 'update', 'Atualizar GitHub CLI', 'local', [['brew', 'upgrade', 'gh']]]);
      await t.executor.idle('local');
      assert.equal(t.sp.calls.length, 1);
      assert.equal(t.sp.calls[0]!.command, '/opt/homebrew/bin/brew');
      const jobs = (await t.overview()).jobs as { recent: ToolJob[] };
      assert.equal(jobs.recent[0]!.id, job.id);
      assert.equal(jobs.recent[0]!.state, 'succeeded');
    } finally {
      await t.close();
    }
  });

  test('an admin plan: 403 with the plan, nothing spawned; unknown tool 404; an action not offered 409; bad digest 400', async () => {
    const t = await boot();
    try {
      const aws = (await t.overview()).items.find((i) => i.id === 'aws')!.actions[0] as ToolActionView;
      assert.equal(aws.admin, true);
      const r = await t.send('POST', '/api/tools/aws/actions/update', { planDigest: aws.planDigest, machine: 'local' }, { origin: t.origin });
      assert.equal(r.status, 403);
      assert.match(r.body.error as string, /administrador/);
      assert.deepEqual(r.body.plan, aws);
      const digest = '0123456789abcdef';
      assert.equal((await t.send('POST', '/api/tools/nope/actions/update', { planDigest: digest }, { origin: t.origin })).status, 404);
      assert.equal((await t.send('POST', '/api/tools/gh/actions/update', { planDigest: digest, machine: 'ws-exemplo' }, { origin: t.origin })).status, 404);
      const jq = await t.send('POST', '/api/tools/jq/actions/update', { planDigest: digest }, { origin: t.origin });
      assert.deepEqual([jq.status, jq.body.plan], [409, null], 'jq is up to date');
      assert.equal((await t.send('POST', '/api/tools/gh/actions/update', { planDigest: 'x' }, { origin: t.origin })).status, 400);
      assert.equal(t.sp.calls.length, 0);
    } finally {
      await t.close();
    }
  });

  test('Cancel: 200 canceled; 404 unknown; 409 already ended', async () => {
    const t = await boot({ script: () => {} });
    try {
      const plan = await t.ghUpdate();
      const job = (await t.send('POST', '/api/tools/gh/actions/update', { planDigest: plan.planDigest }, { origin: t.origin })).body.job as ToolJob;
      await new Promise((r) => setTimeout(r, 20));
      const c = await t.send('DELETE', `/api/tools/jobs/${job.id}`, undefined, { origin: t.origin });
      assert.equal(c.status, 200);
      assert.equal((c.body.job as ToolJob).state, 'canceled');
      assert.deepEqual(t.sp.kills.map((k) => k.signal), ['SIGTERM']);
      t.sp.calls[0]!.child.exit(null, 'SIGTERM');
      await t.executor.idle('local');
      assert.equal((await t.send('DELETE', `/api/tools/jobs/${job.id}`, undefined, { origin: t.origin })).status, 409);
      assert.equal((await t.send('DELETE', '/api/tools/jobs/aaaaaaaaaaaa', undefined, { origin: t.origin })).status, 404);
    } finally {
      await t.close();
    }
  });

  test('Verificar agora: 200 with the body; a `tools` change follows', async () => {
    const t = await boot();
    try {
      const start = t.cursor.current;
      const r = await t.send('POST', '/api/tools/checks', { machine: 'local' }, { origin: t.origin });
      assert.equal(r.status, 200);
      assert.equal(r.body.network, 'online');
      assert.deepEqual(r.body.jobs, { current: null, queue: [], recent: [], batch: null });
      assert.equal((await t.send('POST', '/api/tools/checks', { machine: 'ws-exemplo' }, { origin: t.origin })).status, 404);
      await new Promise((r) => setImmediate(r));
      const w = await t.cursor.wait(start, { timeoutMs: 0 });
      assert.deepEqual(w.changes.map((c) => [c.type, c.key]), [['tools', 'local']]);
    } finally {
      await t.close();
    }
  });

  test('each job transition is a `tools` change keyed `local` on GET /api/changes', async () => {
    const t = await boot();
    try {
      const start = t.cursor.current;
      const plan = await t.ghUpdate();
      await t.send('POST', '/api/tools/gh/actions/update', { planDigest: plan.planDigest }, { origin: t.origin });
      await t.executor.idle('local');
      const r = (await (await fetch(`${t.origin}/api/changes?since=${encodeURIComponent(start)}&wait=0`)).json()) as { changes: { type: string; key: string }[] };
      assert.deepEqual(r.changes.map((c) => [c.type, c.key]), [['tools', 'local']]);
    } finally {
      await t.close();
    }
  });

  test("layer 4's hook: with acceptNoOriginActions, a loopback request without Origin is accepted; a foreign Origin still is not", async () => {
    const t = await boot({ acceptNoOrigin: true });
    try {
      const plan = await t.ghUpdate();
      assert.equal((await t.send('POST', '/api/tools/gh/actions/update', { planDigest: plan.planDigest }, { origin: 'https://exemplo.dev' })).status, 403);
      assert.equal((await t.send('POST', '/api/tools/gh/actions/update', { planDigest: plan.planDigest })).status, 202);
    } finally {
      await t.close();
    }
  });
});
