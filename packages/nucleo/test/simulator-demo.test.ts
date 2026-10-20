// The API's --demo (#103): the panel alias, the old session ids (#173) and the temporary folders
// where Promote writes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { DETAIL_LOCAL, DETAIL_SESSION, demoLocal, seedDetail } from '../src/simulator/detail.ts';
import { seedPanelHistory } from '../src/simulator/history-ended.ts';
import { currentDemoId, LEGACY_DEMO_IDS, upgradeDemoUrl } from '../src/simulator/legacy-ids.ts';
import { demoAlias, demoRecordFolders, P9_PARENT, PANEL_SCENARIOS, PANEL_SESSION, seedPanelScenario, VITRINE_PARENT } from '../src/simulator/panel.ts';
import { seedDemoWorkflows } from '../src/simulator/workflows.ts';
import { DEMO_SESSION, startLegacyDemo } from './api/legacy-demo.ts';

describe('demoAlias', () => {
  test("the side panel's real id becomes the scenario's session; the simulator's stay as they came", () => {
    assert.equal(demoAlias('0b6f6a1e-1111-4222-8333-944445555666'), PANEL_SESSION);
    assert.equal(demoAlias('sim-panel-vitrine-demo'), 'sim-panel-vitrine-demo');
    assert.equal(demoAlias('sim-painel-vitrine-demo'), 'sim-panel-vitrine-demo', 'an old id is read as its new one');
    assert.equal(demoAlias('sim-painel-esta'), PANEL_SESSION);
    assert.equal(demoAlias(PANEL_SESSION), PANEL_SESSION);
    assert.equal(demoAlias('simulado'), PANEL_SESSION, 'only the "sim-" prefix');
  });
});

describe('the demo\'s old session ids (#173)', () => {
  test('every old id maps to a session the demo writes, and the other ids stay', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const seen = new Set<string>([PANEL_SESSION, P9_PARENT, VITRINE_PARENT, DETAIL_SESSION]);
    for (const scenario of PANEL_SCENARIOS) await seedPanelScenario(storage, scenario);
    await seedDemoWorkflows(storage);
    await seedDetail(storage);
    await seedPanelHistory(storage, null);
    for (const s of (await storage.listSessions({ limit: 500 })).items) seen.add(s.id);
    await storage.close();
    for (const [old, current] of Object.entries(LEGACY_DEMO_IDS)) {
      assert.ok(seen.has(current), `${old} → ${current}`);
      assert.ok(!seen.has(old), `${old} is no longer written`);
    }
    assert.equal(currentDemoId('sim-wf-csv'), 'sim-wf-csv');
    assert.equal(currentDemoId('toString'), 'toString');
    assert.equal(demoLocal('sim-detalhe-pedidos'), DETAIL_LOCAL);
  });

  test('upgradeDemoUrl swaps an old id in a path segment or a query value, and nothing else', () => {
    const up = (u: string) => upgradeDemoUrl(new URL(u, 'http://127.0.0.1:4720')).href.slice('http://127.0.0.1:4720'.length);
    assert.equal(up('/api/sessions/sim-detalhe-pedidos/agents'), '/api/sessions/sim-detail-orders/agents');
    assert.equal(up('/api/panel/sim-painel-esta?decisions=family'), '/api/panel/sim-panel-current?decisions=family');
    assert.equal(up('/api/events?session=sim-wf-pagamentos&limit=5'), '/api/events?session=sim-wf-payments&limit=5');
    assert.equal(up('/api/sessions/sim-detalhe-pedidos-x'), '/api/sessions/sim-detalhe-pedidos-x');
    assert.equal(up('/api/sessions/%E0%A4%A'), '/api/sessions/%E0%A4%A');
    const same = new URL('http://127.0.0.1:4720/api/sessions/sim-panel-current?x=1');
    assert.equal(upgradeDemoUrl(same), same);
  });

  test('the demo server answers an old id with the session under its new id', async () => {
    const demo = await startLegacyDemo();
    try {
      const body = async (path: string) => {
        const r = await fetch(`${demo.api.url}${path}`);
        return [r.status, await r.json()];
      };
      assert.equal(DEMO_SESSION, 'sim-panel-current');
      assert.deepEqual(await body('/api/sessions/sim-detalhe-pedidos'), await body('/api/sessions/sim-detail-orders'));
      assert.deepEqual(await body('/api/panel/sim-painel-esta'), await body('/api/panel/sim-panel-current'));
      assert.deepEqual(await body('/api/sessions/sim-wf-pagamentos/workflow'), await body('/api/sessions/sim-wf-payments/workflow'));
      const [status] = await body('/api/sessions/sim-detail-orders');
      assert.equal(status, 200);
    } finally {
      await demo.close();
    }
  });
});

describe('demoRecordFolders', () => {
  const folders: string[] = [];
  after(async () => {
    for (const p of folders) await rm(p, { recursive: true, force: true });
  });

  test('creates one folder per synthetic repo, with the seeded records, and swaps only /simulacao/<seeded repo>', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ahrena-demo-teste-'));
    folders.push(base);
    const rootOf = demoRecordFolders(base);

    const vitrine = rootOf('/simulacao/vitrine-demo');
    assert.equal(vitrine, join(base, 'vitrine-demo'));
    assert.ok(vitrine!.startsWith(base + sep), 'inside the temporary folder');
    assert.deepEqual(await readdir(join(vitrine!, 'docs', 'decisoes')), ['0003-kanban-por-long-polling.md']);
    assert.match(await readFile(join(vitrine!, 'docs', 'decisoes', '0003-kanban-por-long-polling.md'), 'utf8'), /^# 0003 · /);
    assert.deepEqual((await readdir(join(base, 'motor-de-regras', 'docs', 'decisoes'))).sort(), ['0004-cobranca-em-servico-a-parte.md', '0005-contrato-da-cobranca-primeiro.md']);
    assert.deepEqual(await readdir(join(base, 'painel-de-metricas', 'docs', 'decisoes')), ['0006-cache-do-total-do-mes.md']);
    assert.deepEqual(await readdir(join(base, 'ahrena-demo', 'docs', 'decisoes')), []);

    for (const outside of ['/outro', '/simulacao/constructor', '/simulacao/__proto__', '/simulacao/toString', '/simulacao', '/simulacao/', '/simulacaox/vitrine-demo', 'simulacao/vitrine-demo']) {
      assert.equal(rootOf(outside), null, outside);
    }
  });
});
