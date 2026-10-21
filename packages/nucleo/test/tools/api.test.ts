// #280 layer 1: GET /api/tools on 127.0.0.1 with a fake machine: the contract's shape, ?machine=,
// the núcleo without the service, and the Origin defenses every read has (decision 0003).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import type { ToolsService } from '../../src/tools/service.ts';
import { macService } from './machines.ts';

async function boot(tools: ToolsService | null) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, tools });
  return {
    get: (path: string, headers: Record<string, string> = {}) => fetch(`${api.url}${path}`, { headers }),
    origin: new URL(api.url).origin,
    close: async () => {
      await api.close();
      await storage.close();
    },
  };
}

describe('#280 GET /api/tools', () => {
  test('the contract shape, with a fake runner', async () => {
    const { service } = macService();
    const { get, close } = await boot(service);
    try {
      const r = await get('/api/tools');
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), ['version', 'machine', 'checkedAt', 'nextCheckAt', 'network', 'managers', 'actionsAllowed', 'items', 'containers', 'mcp', 'jobs']);
      const items = body.items as Record<string, unknown>[];
      assert.deepEqual(Object.keys(items[0]!), ['id', 'label', 'group', 'inCatalog', 'binary', 'manager', 'installed', 'latest', 'latestCheckedAt', 'latestError', 'source', 'state', 'note', 'actions']);
      const gcloud = items.find((i) => i.id === 'gcloud')!;
      const action = (gcloud.actions as Record<string, unknown>[])[0]!;
      assert.deepEqual(Object.keys(action), ['id', 'runnable', 'admin', 'blockedReason', 'steps', 'timeoutSeconds', 'targetVersion', 'planDigest']);
      assert.deepEqual(Object.keys(body.containers as object), ['runtime', 'toolId', 'state', 'readOnly', 'version', 'vm', 'dockerContext', 'containers', 'actions']);
      assert.deepEqual(body.mcp, { statusCheckedAt: null, servers: [] });
      assert.equal((await get('/api/tools?machine=local')).status, 200);
    } finally {
      await close();
    }
  });

  test('?machine= : 400 for an invalid id, 404 for a machine this layer does not serve', async () => {
    const { service } = macService();
    const { get, close } = await boot(service);
    try {
      assert.equal((await get('/api/tools?machine=Ws_1')).status, 400);
      const r = await get('/api/tools?machine=ws-exemplo');
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'máquina desconhecida: ws-exemplo' });
    } finally {
      await close();
    }
  });

  test('without the service: 404', async () => {
    const { get, close } = await boot(null);
    try {
      assert.equal((await get('/api/tools')).status, 404);
    } finally {
      await close();
    }
  });

  test('the /ui reads it with its own Origin; another Origin gets 403; writes are not here yet', async () => {
    const { service, run } = macService();
    const { get, origin, close } = await boot(service);
    try {
      assert.equal((await get('/api/tools', { origin })).status, 200);
      const before = run.calls.length;
      assert.equal((await get('/api/tools', { origin: 'https://exemplo.dev' })).status, 403);
      assert.equal(run.calls.length, before, 'nothing ran');
      const post = await fetch(`${origin}/api/tools`, { method: 'POST' });
      assert.equal(post.status, 405);
    } finally {
      await close();
    }
  });
});
