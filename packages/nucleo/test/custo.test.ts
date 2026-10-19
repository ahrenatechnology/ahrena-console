// Custo e tokens (item 1.6): tabela de preços editável, piso da compactação e agregações.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import {
  PRECOS_PADRAO,
  agregarCusto,
  aplicarPiso,
  custoDaSessao,
  definirPreco,
  diaDe,
  precosVigentes,
  restaurarPadrao,
  tabelaDePrecos,
} from '../src/custo/index.ts';
import { importHistory, mainAgentId, subagentId } from '../src/ingest/historico/importer.ts';
import { emptyTokenCounts, type TokenCounts } from '../src/model.ts';
import { estimateCost, resolvePricing } from '../src/pricing.ts';
import { agent, at, event, pricing, session, T0, usage } from './fixtures.ts';

const zero = emptyTokenCounts();
const perto = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe('tabela de preços padrão', () => {
  const precoDe = (modelo: string) => resolvePricing(modelo, PRECOS_PADRAO);

  test('casa o id e o id com data, com os preços públicos', () => {
    assert.equal(precoDe('claude-opus-5-5')?.inputPerMTok, 4);
    assert.equal(precoDe('claude-opus-5-5')?.cacheReadPerMTok, 0.2);
    assert.equal(precoDe('claude-sonnet-4-5-20250929')?.outputPerMTok, 15);
    assert.equal(precoDe('claude-haiku-4-5-20251001')?.cacheWrite1hPerMTok, 2);
    assert.equal(precoDe('claude-3-5-haiku-20241022')?.inputPerMTok, 0.8);
    assert.equal(precoDe('claude-opus-4-20250514')?.inputPerMTok, 15);
  });

  test('modelo vizinho não herda o preço de outro', () => {
    assert.equal(precoDe('claude-opus-5')?.inputPerMTok, 5);
    assert.equal(precoDe('claude-opus-5-9'), null);
    assert.equal(precoDe('claude-opus-4-9'), null);
    assert.equal(precoDe('claude-3-7-sonnet-20250219'), null);
  });

  test('toda linha tem os cinco preços e a data da consulta', () => {
    for (const p of PRECOS_PADRAO) {
      for (const k of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok'] as const) {
        assert.equal(typeof p[k], 'number', `${p.pattern}.${k}`);
      }
      assert.equal(p.updatedAt, '2026-10-18T00:00:00.000Z');
    }
    assert.equal(new Set(PRECOS_PADRAO.map((p) => p.pattern)).size, PRECOS_PADRAO.length);
  });
});

describe('tabela de preços editável', () => {
  test('sobrescrita do usuário vence o padrão, e restaurar volta ao padrão', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    await definirPreco(store, pricing({ pattern: 'claude-opus-5-5', inputPerMTok: 3 }));
    await definirPreco(store, pricing({ pattern: 'modelo-interno%', inputPerMTok: 1 }));

    const tabela = new Map((await tabelaDePrecos(store)).map((l) => [l.pattern, l]));
    const opus = tabela.get('claude-opus-5-5')!;
    assert.equal(opus.origem, 'usuario');
    assert.equal(opus.inputPerMTok, 3);
    assert.equal(opus.nome, 'Claude Opus 5.5');
    assert.equal(opus.padrao?.inputPerMTok, 4);
    assert.equal(tabela.get('modelo-interno%')?.origem, 'usuario');
    assert.equal(tabela.get('claude-opus-5-5-20%')?.origem, 'padrao');
    assert.equal(resolvePricing('claude-opus-5-5', await precosVigentes(store))?.inputPerMTok, 3);

    assert.equal(await restaurarPadrao(store, 'claude-opus-5-5'), 1);
    assert.equal(resolvePricing('claude-opus-5-5', await precosVigentes(store))?.inputPerMTok, 4);
    assert.equal(await restaurarPadrao(store), 1);
    assert.equal(resolvePricing('modelo-interno-1', await precosVigentes(store)), null);
    await store.close();
  });

  test('preço inválido não é gravado', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    await assert.rejects(definirPreco(store, pricing({ inputPerMTok: -1 })));
    assert.deepEqual(await store.listModelPricing(), []);
    await store.close();
  });
});

describe('piso depois da compactação', () => {
  const t = (output: number): TokenCounts => ({ ...zero, output });

  test('sem registro anterior, o piso é zero', () => {
    assert.deepEqual(aplicarPiso(null, t(10)), zero);
  });

  test('quando a contagem viva cai, o que sumiu vira piso e o total não diminui', () => {
    const piso = aplicarPiso({ tokens: t(100), baseline: zero }, t(10));
    assert.deepEqual(piso, t(90));
    // Depois o vivo volta a crescer e o piso fica.
    assert.deepEqual(aplicarPiso({ tokens: t(10), baseline: piso }, t(50)), t(90));
    // Segunda compactação acumula.
    assert.deepEqual(aplicarPiso({ tokens: t(50), baseline: t(90) }, t(5)), t(135));
  });

  test('o custo conta o piso', () => {
    const u = usage({ tokens: zero, baseline: t(1_000_000) });
    assert.equal(estimateCost(u, [pricing()]).costUsd, 50);
  });
});

describe('agregações de custo', () => {
  // input 10 / output 50 por MTok para claude-opus-5%.
  const precos = [pricing()];
  const uso = (output: number, extra: Record<string, unknown> = {}) => ({
    usage: {
      messageId: null,
      requestId: null,
      model: 'claude-opus-5-5',
      speed: 'standard',
      inferenceGeo: '',
      serviceTier: 'standard',
      contextSize: '',
      tokens: { ...zero, output },
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      ...extra,
    },
  });

  async function cenario() {
    const store = openSqliteStorage({ path: ':memory:' });
    await store.putSession(session({ id: 's1', updatedAt: at(60 * 24) }));
    await store.putAgent(agent({ id: 'a1' }));
    await store.putAgent(agent({ id: 'a2', type: 'subagent', parentAgentId: 'a1' }));
    // Duas linhas da mesma mensagem (streaming): conta a final.
    await store.appendEvent(event({ id: 'e1', agentId: 'a1', createdAt: T0, data: uso(100_000, { messageId: 'm1' }) }));
    await store.appendEvent(event({ id: 'e2', agentId: 'a1', createdAt: T0, data: uso(200_000, { messageId: 'm1' }) }));
    await store.appendEvent(event({ id: 'e3', agentId: 'a2', createdAt: at(60 * 24), data: uso(300_000, { messageId: 'm2' }) }));
    // Mensagem de um modelo sem preço.
    await store.appendEvent(event({ id: 'e4', agentId: 'a2', createdAt: at(60 * 24), data: uso(1000, { messageId: 'm3', model: 'modelo-novo' }) }));
    // O bucket tem 500k de saída vivos mais 100k de piso: 600k no total, 500k explicados pelos eventos.
    await store.putTokenUsage(usage({ tokens: { ...zero, output: 500_000 }, baseline: { ...zero, output: 100_000 }, updatedAt: at(60 * 24) }));
    await store.putTokenUsage(usage({ model: 'modelo-novo', tokens: { ...zero, output: 1000 }, updatedAt: at(60 * 24) }));
    // Outra sessão, só com bucket (como o simulador grava).
    await store.putSession(session({ id: 's2', updatedAt: at(10) }));
    await store.putTokenUsage(usage({ sessionId: 's2', tokens: { ...zero, output: 1_000_000 }, updatedAt: at(10) }));
    return store;
  }

  test('cada agrupamento soma o mesmo total, marcado como estimativa', async () => {
    const store = await cenario();
    const r = await agregarCusto(store, { precos });
    assert.equal(r.estimativa, true);
    assert.equal(r.moeda, 'USD');
    perto(r.total.custoUsd, (600_000 + 1_000_000) * 50 / 1e6);
    for (const linhas of [r.porSessao, r.porAgente, r.porModelo, r.porDia]) {
      perto(linhas.reduce((s, l) => s + (l.custoUsd ?? 0), 0), r.total.custoUsd!);
      assert.equal(linhas.reduce((s, l) => s + l.totalDeTokens, 0), r.total.totalDeTokens);
      assert.ok(linhas.every((l) => l.estimativa === true));
    }
    await store.close();
  });

  test('por agente: o que os eventos explicam vai para o agente; o piso fica sem agente', async () => {
    const store = await cenario();
    const r = await custoDaSessao(store, 's1', { precos });
    const porAgente = new Map(r.porAgente.map((l) => [l.agentId, l]));
    perto(porAgente.get('a1')!.custoUsd, 10);
    perto(porAgente.get('a2')!.custoUsd, 15);
    assert.deepEqual(porAgente.get('a2')!.semPreco, { modelos: ['modelo-novo'], totalDeTokens: 1000 });
    const semAgente = porAgente.get(null)!;
    assert.equal(semAgente.chave, 's1:sem-agente');
    assert.equal(semAgente.tokens.output, 100_000);
    perto(semAgente.custoUsd, 5);
    await store.close();
  });

  test('por modelo: modelo sem preço é "sem preço", não zero', async () => {
    const store = await cenario();
    const r = await agregarCusto(store, { precos });
    const novo = r.porModelo.find((l) => l.chave === 'modelo-novo')!;
    assert.equal(novo.custoUsd, null);
    assert.deepEqual(novo.semPreco, { modelos: ['modelo-novo'], totalDeTokens: 1000 });
    assert.equal(r.porModelo.at(-1)!.chave, 'modelo-novo');
    assert.deepEqual(r.total.semPreco.modelos, ['modelo-novo']);
    await store.close();
  });

  test('por dia, com filtro de período e fuso', async () => {
    const store = await cenario();
    const r = await agregarCusto(store, { precos });
    assert.deepEqual(r.porDia.map((l) => l.chave), ['2026-11-02', '2026-11-03']);
    perto(r.porDia[0].custoUsd, 10 + 50);

    const so3 = await agregarCusto(store, { precos, desde: '2026-11-03', ate: '2026-11-03' });
    assert.deepEqual(so3.porSessao.map((l) => l.chave), ['s1']);
    perto(so3.total.custoUsd, 15 + 5);

    // 12:00 UTC é 21:00 em Tóquio, no mesmo dia; 23:30 UTC já é o dia seguinte lá.
    assert.equal(diaDe('2026-11-02T23:30:00.000Z', 'Asia/Tokyo'), '2026-11-03');
    assert.equal(diaDe('2026-11-02T23:30:00.000Z'), '2026-11-02');
    await store.close();
  });

  test('sem uso, custo zero e nenhuma linha', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const r = await agregarCusto(store);
    assert.equal(r.total.custoUsd, 0);
    assert.deepEqual(r.porSessao, []);
    await store.close();
  });
});

describe('custo de ponta a ponta com o histórico importado', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-custo-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S1 = '00000000-0000-4000-8000-000000000001';
  const S2 = '00000000-0000-4000-8000-000000000002';

  test('importa, preça pela tabela vigente e reparte entre agentes', async () => {
    const root = join(tmp, 'projects');
    cpSync(join(import.meta.dirname, 'fixtures', 'historico', 'projects'), root, { recursive: true });
    const store = openSqliteStorage({ path: ':memory:' });
    await importHistory({ storage: store, root });

    const r = await agregarCusto(store);
    const buckets = [...(await store.listTokenUsage(S1)), ...(await store.listTokenUsage(S2))];
    const precos = await precosVigentes(store);
    const esperado = buckets.reduce((s, b) => s + (estimateCost(b, precos).costUsd ?? 0), 0);
    perto(r.total.custoUsd, esperado);

    // Os eventos explicam todo o uso da S1: nada fica sem agente.
    const s1 = await custoDaSessao(store, S1);
    const agentes = s1.porAgente.map((l) => l.agentId);
    assert.ok(!agentes.includes(null));
    assert.ok(agentes.includes(mainAgentId(S1)) && agentes.includes(subagentId(S1, 'a1111111111111111')));
    assert.ok(s1.porAgente.every((l) => l.custoUsd !== null && l.custoUsd > 0));

    // A S2 usa modo fast num modelo sem preço de fast: "sem preço".
    const s2 = await custoDaSessao(store, S2);
    assert.equal(s2.total.custoUsd, null);
    assert.ok(s2.total.semPreco.totalDeTokens > 0);
    await store.close();
  });
});
