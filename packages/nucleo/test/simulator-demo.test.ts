// The API's --demo (#103): the panel alias and the temporary folders where Promote writes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { demoAlias, demoRecordFolders, PANEL_SESSION } from '../src/simulator/panel.ts';

describe('demoAlias', () => {
  test("the side panel's real id becomes the scenario's session; the simulator's stay as they came", () => {
    assert.equal(demoAlias('0b6f6a1e-1111-4222-8333-944445555666'), PANEL_SESSION);
    assert.equal(demoAlias('sim-painel-vitrine-demo'), 'sim-painel-vitrine-demo');
    assert.equal(demoAlias(PANEL_SESSION), PANEL_SESSION);
    assert.equal(demoAlias('simulado'), PANEL_SESSION, 'only the "sim-" prefix');
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
