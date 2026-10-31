import { ownerFetch as fetch } from './owner-http.ts';
// The API's --demo (#103): the panel alias, the old session ids that left in phase 6 of #173 and
// the temporary folders where Promote writes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { DETAIL_LOCAL, DETAIL_SESSION, demoLocal } from '../src/simulator/detail.ts';
import { demoAlias, demoRecordFolders, PANEL_SESSION } from '../src/simulator/panel.ts';
import { DEMO_SESSION, startDemoApi } from './api/demo-api.ts';

describe('demoAlias', () => {
  test("the side panel's real id becomes the scenario's session; the simulator's stay as they came", () => {
    assert.equal(demoAlias('0b6f6a1e-1111-4222-8333-944445555666'), PANEL_SESSION);
    assert.equal(demoAlias('sim-panel-vitrine-demo'), 'sim-panel-vitrine-demo');
    assert.equal(demoAlias(PANEL_SESSION), PANEL_SESSION);
    assert.equal(demoAlias('simulado'), PANEL_SESSION, 'only the "sim-" prefix');
  });
});

describe('the demo\'s old session ids are gone (#173, phase 6)', () => {
  test('an old id is not a session of the demo: the API answers 404 and the panel alias keeps it as it came', async () => {
    const demo = await startDemoApi();
    try {
      const get = (path: string) => fetch(`${demo.api.url}${path}`, { redirect: 'manual' });
      assert.equal(DEMO_SESSION, 'sim-panel-current');
      assert.equal((await get('/api/sessions/sim-detail-orders')).status, 200);
      assert.equal((await get('/api/sessions/sim-detalhe-pedidos')).status, 404);
      assert.equal((await get('/api/sessions/sim-wf-pagamentos/workflow')).status, 404);
      assert.equal(demoAlias('sim-painel-esta'), 'sim-painel-esta');
      assert.equal(demoLocal('sim-detalhe-pedidos'), null);
      assert.equal(demoLocal(DETAIL_SESSION), DETAIL_LOCAL);
      // A /ui page asked by an old id is served as it came (the screen says the session was not found), no 302.
      assert.equal((await get('/ui/sessions/sim-detalhe-pedidos')).status, 200);
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
