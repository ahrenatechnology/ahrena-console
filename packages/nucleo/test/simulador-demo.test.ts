// A --demo da API (#103): o apelido do painel e as pastas temporárias onde o Promover grava.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { apelidoDaDemo, pastasDosRegistrosDaDemo, SESSAO_DO_PAINEL } from '../src/simulador/painel.ts';

describe('apelidoDaDemo', () => {
  test('o id real do painel lateral vira a sessão do cenário; as do simulador ficam como vieram', () => {
    assert.equal(apelidoDaDemo('0b6f6a1e-1111-4222-8333-944445555666'), SESSAO_DO_PAINEL);
    assert.equal(apelidoDaDemo('sim-painel-vitrine-demo'), 'sim-painel-vitrine-demo');
    assert.equal(apelidoDaDemo(SESSAO_DO_PAINEL), SESSAO_DO_PAINEL);
    assert.equal(apelidoDaDemo('simulado'), SESSAO_DO_PAINEL, 'só o prefixo "sim-"');
  });
});

describe('pastasDosRegistrosDaDemo', () => {
  const pastas: string[] = [];
  after(async () => {
    for (const p of pastas) await rm(p, { recursive: true, force: true });
  });

  test('cria uma pasta por repo sintético, com os registros semeados, e troca só /simulacao/<repo do seed>', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ahrena-demo-teste-'));
    pastas.push(base);
    const raiz = pastasDosRegistrosDaDemo(base);

    const vitrine = raiz('/simulacao/vitrine-demo');
    assert.equal(vitrine, join(base, 'vitrine-demo'));
    assert.ok(vitrine!.startsWith(base + sep), 'dentro da pasta temporária');
    assert.deepEqual(await readdir(join(vitrine!, 'docs', 'decisoes')), ['0003-kanban-por-long-polling.md']);
    assert.match(await readFile(join(vitrine!, 'docs', 'decisoes', '0003-kanban-por-long-polling.md'), 'utf8'), /^# 0003 · /);
    assert.deepEqual((await readdir(join(base, 'motor-de-regras', 'docs', 'decisoes'))).sort(), ['0004-cobranca-em-servico-a-parte.md', '0005-contrato-da-cobranca-primeiro.md']);
    assert.deepEqual(await readdir(join(base, 'painel-de-metricas', 'docs', 'decisoes')), ['0006-cache-do-total-do-mes.md']);
    assert.deepEqual(await readdir(join(base, 'ahrena-demo', 'docs', 'decisoes')), []);

    for (const fora of ['/outro', '/simulacao/constructor', '/simulacao/__proto__', '/simulacao/toString', '/simulacao', '/simulacao/', '/simulacaox/vitrine-demo', 'simulacao/vitrine-demo']) {
      assert.equal(raiz(fora), null, fora);
    }
  });
});
