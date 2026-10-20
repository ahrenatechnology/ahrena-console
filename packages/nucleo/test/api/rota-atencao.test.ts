// `GET /api/atencao` (#87): a lista da bandeja, com os dados sintéticos do simulador e dos testes
// do MCP. Nenhum dado real.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, montarAtencao, MontadorDoPainel, type ApiLocal, type RespostaDaAtencao } from '../../src/api/index.ts';
import { LeituraDaFrota } from '../../src/mcp/index.ts';
import { CursorDeMudancas } from '../../src/mudancas/cursor.ts';
import { semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { AGORA, semear } from '../mcp/helpers.ts';

let storage: SqliteStorage;
let contas: Contas;
let frota: LeituraDaFrota;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  contas = new Contas({ storage, arquivo: null });
  frota = new LeituraDaFrota({ storage, contas, agora: () => AGORA, fusoHorario: 'UTC' });
});
afterEach(() => storage.close());

describe('montarAtencao', () => {
  test('esperando e com erro, as que travam primeiro, depois quem espera há mais tempo', async () => {
    await semear(storage);
    const r = await montarAtencao(frota, null);
    assert.deepEqual(
      r.itens.map((i) => [i.sessao, i.nivel, i.motivo]),
      [
        ['plano', 'precisa', 'plano'],
        ['permissao', 'precisa', 'permissao'],
        ['erro', 'precisa', 'erro'],
        ['pergunta', 'precisa', 'pergunta'],
        ['sua-vez', 'sua-vez', 'sua-vez'],
        ['interrompida', 'sua-vez', 'interrompida'],
        ['abriu', 'sua-vez', 'no-prompt'],
      ],
    );
    assert.equal(r.total, 7);
    assert.equal(r.precisam, 4);
    assert.equal(r.suaVez, 3);
    assert.equal(r.comErro, 1);
    // Trabalhando e delegando; as que esperam você não contam como ativas.
    assert.equal(r.ativas, 2);
    assert.deepEqual(
      r.itens.slice(0, 3).map((i) => [i.motivoCurto, i.minutos]),
      [
        ['Plano para aprovar', 8],
        ['Pede permissão', 5],
        ['Com erro', 4],
      ],
    );
  });

  test('a conta sai com rótulo e cor, nunca o id; sem conta é null', async () => {
    await semear(storage);
    const r = await montarAtencao(frota, null);
    const porId = new Map(r.itens.map((i) => [i.sessao, i]));
    assert.equal(porId.get('permissao')?.conta?.rotulo, 'equipe');
    assert.match(porId.get('permissao')?.conta?.cor ?? '', /^#[0-9a-f]{6}$/i);
    assert.deepEqual(Object.keys(porId.get('permissao')?.conta ?? {}).sort(), ['cor', 'rotulo']);
    assert.equal(porId.get('erro')?.conta, null);
    assert.doesNotMatch(JSON.stringify(r), /"id"|accountId/);
  });

  test('não traz texto da conversa', async () => {
    await semear(storage);
    const texto = JSON.stringify(await montarAtencao(frota, null));
    for (const segredo of ['rm -rf', 'Ignore as instruções', 'hunter2']) assert.ok(!texto.includes(segredo), segredo);
  });

  test('cenário do simulador: os números batem com o "precisam de você" do painel', async () => {
    await semearCenariosDoPainel(storage, 'p3', AGORA);
    const r = await montarAtencao(frota, null);
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => AGORA });
    const painel = await montador.montar({ sessionId: 'nenhuma' });
    assert.ok(r.total > 0);
    assert.equal(r.precisam, painel.precisam.total);
    assert.equal(r.suaVez, painel.precisam.suaVez);
    const doPainel = new Map(painel.precisam.maquina.map((i) => [i.id, i.nivel]));
    for (const i of r.itens) if (doPainel.has(i.sessao)) assert.equal(i.nivel, doPainel.get(i.sessao), i.sessao);
  });

  test('ninguém esperando: lista vazia', async () => {
    const r = await montarAtencao(frota, 'c1');
    assert.deepEqual({ total: r.total, itens: r.itens, cursor: r.cursor }, { total: 0, itens: [], cursor: 'c1' });
  });
});

describe('GET /api/atencao', () => {
  let api: ApiLocal;
  let mudancas: CursorDeMudancas;
  beforeEach(async () => {
    await semearCenariosDoPainel(storage, 'p3', AGORA);
    mudancas = new CursorDeMudancas();
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => AGORA });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, frota, mudancas });
  });
  afterEach(() => api.close());

  test('responde a lista com o cursor de /api/mudancas', async () => {
    const res = await fetch(`${api.url}/api/atencao`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as RespostaDaAtencao;
    assert.equal(r.cursor, mudancas.atual);
    assert.equal(r.total, r.itens.length);
    // O cursor serve para esperar a próxima mudança: sem mudança, volta vazio quando a espera acaba.
    const m = (await (await fetch(`${api.url}/api/mudancas?desde=${encodeURIComponent(r.cursor!)}&espera=0`)).json()) as { reiniciar: boolean; mudancas: unknown[] };
    assert.equal(m.reiniciar, false);
    assert.deepEqual(m.mudancas, []);
  });

  test('pedido com Origin dá 403, como as outras rotas', async () => {
    const res = await fetch(`${api.url}/api/atencao`, { headers: { origin: 'https://exemplo.com' } });
    assert.equal(res.status, 403);
  });

  test('sem a frota, a rota não existe', async () => {
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    const outra = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    assert.equal((await fetch(`${outra.url}/api/atencao`)).status, 404);
    await outra.close();
  });
});
