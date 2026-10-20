// `GET /api/attention` (#87): a lista da bandeja, com os dados sintéticos do simulador e dos testes
// do MCP. Nenhum dado real.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, montarAtencao, MontadorDoPainel, type ApiLocal, type RespostaDaAtencao } from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { semearCenariosDoPainel } from '../../src/simulator/panel.ts';
import { NOW, seed } from '../mcp/helpers.ts';

let storage: SqliteStorage;
let contas: Contas;
let frota: FleetReader;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  contas = new Contas({ storage, arquivo: null });
  frota = new FleetReader({ storage, accounts: contas, now: () => NOW, timeZone: 'UTC' });
});
afterEach(() => storage.close());

describe('montarAtencao', () => {
  test('urgentes primeiro (permissão, pergunta, plano, decisão), depois erro, depois a sua vez; no grupo, quem espera há mais tempo', async () => {
    await seed(storage);
    const r = await montarAtencao(frota, null);
    assert.deepEqual(
      r.items.map((i) => [i.session, i.level, i.reason]),
      [
        ['plano', 'needs', 'plan'],
        ['permissao', 'needs', 'permission'],
        ['pergunta', 'needs', 'question'],
        ['erro', 'needs', 'error'],
        ['sua-vez', 'your-turn', 'your-turn'],
        ['interrompida', 'your-turn', 'interrupted'],
        ['abriu', 'your-turn', 'no-prompt'],
      ],
    );
    assert.equal(r.total, 7);
    assert.equal(r.needs, 4);
    assert.equal(r.yourTurn, 3);
    assert.equal(r.withError, 1);
    // Trabalhando e delegando; as que esperam você não contam como ativas.
    assert.equal(r.active, 2);
    assert.deepEqual(
      r.items.slice(0, 4).map((i) => [i.shortReason, i.minutes]),
      [
        ['Plano para aprovar', 8],
        ['Pede permissão', 5],
        ['Fez uma pergunta', 3],
        ['Com erro', 4],
      ],
    );
  });

  test('a conta sai com rótulo e cor, nunca o id; sem conta é null', async () => {
    await seed(storage);
    const r = await montarAtencao(frota, null);
    const porId = new Map(r.items.map((i) => [i.session, i]));
    assert.equal(porId.get('permissao')?.account?.label, 'equipe');
    assert.match(porId.get('permissao')?.account?.color ?? '', /^#[0-9a-f]{6}$/i);
    assert.deepEqual(Object.keys(porId.get('permissao')?.account ?? {}).sort(), ['color', 'label']);
    assert.equal(porId.get('erro')?.account, null);
    assert.doesNotMatch(JSON.stringify(r), /"id"|accountId/);
  });

  test('não traz texto da conversa', async () => {
    await seed(storage);
    const texto = JSON.stringify(await montarAtencao(frota, null));
    for (const segredo of ['rm -rf', 'Ignore as instruções', 'hunter2']) assert.ok(!texto.includes(segredo), segredo);
  });

  test('cenário do simulador: os números batem com o "precisam de você" do painel', async () => {
    await semearCenariosDoPainel(storage, 'p3', NOW);
    const r = await montarAtencao(frota, null);
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => NOW });
    const painel = await montador.montar({ sessionId: 'nenhuma' });
    assert.ok(r.total > 0);
    assert.equal(r.needs, painel.needYou.total);
    assert.equal(r.yourTurn, painel.needYou.yourTurn);
    // The same level and reason values as the panel's (#173 phase 2b).
    const doPainel = new Map(painel.needYou.machine.map((i) => [i.id, [i.level, i.why]]));
    for (const i of r.items) if (doPainel.has(i.session)) assert.deepEqual([i.level, i.reason], doPainel.get(i.session), i.session);
  });

  test('A2 do wireframe: a permissão vem antes do erro mais antigo, e a sua vez por último', async () => {
    await semearCenariosDoPainel(storage, 'p7', NOW);
    const r = await montarAtencao(frota, null);
    assert.deepEqual(
      r.items.map((i) => i.reason),
      ['permission', 'error', 'your-turn'],
    );
    // O erro espera há mais tempo que a permissão, e mesmo assim vem depois.
    assert.ok(r.items[1].minutes > r.items[0].minutes);
  });

  test('ninguém esperando: lista vazia', async () => {
    const r = await montarAtencao(frota, 'c1');
    assert.deepEqual({ total: r.total, items: r.items, cursor: r.cursor }, { total: 0, items: [], cursor: 'c1' });
  });
});

describe('GET /api/attention', () => {
  let api: ApiLocal;
  let mudancas: ChangeCursor;
  beforeEach(async () => {
    await semearCenariosDoPainel(storage, 'p3', NOW);
    mudancas = new ChangeCursor();
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => NOW });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, frota, mudancas });
  });
  afterEach(() => api.close());

  test('responde a lista com o cursor de /api/changes', async () => {
    const res = await fetch(`${api.url}/api/attention`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as RespostaDaAtencao;
    assert.equal(r.cursor, mudancas.current);
    assert.equal(r.total, r.items.length);
    // O cursor serve para esperar a próxima mudança: sem mudança, volta vazio quando a espera acaba.
    const m = (await (await fetch(`${api.url}/api/changes?since=${encodeURIComponent(r.cursor!)}&wait=0`)).json()) as { reset: boolean; changes: unknown[] };
    assert.equal(m.reset, false);
    assert.deepEqual(m.changes, []);
  });

  test('a rota antiga responde as chaves e os valores antigos (#173 fase 2b)', async () => {
    const novo = (await (await fetch(`${api.url}/api/attention`)).json()) as RespostaDaAtencao;
    const antigo = (await (await fetch(`${api.url}/api/atencao`)).json()) as Record<string, unknown> & { itens: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(antigo), ['geradoEm', 'cursor', 'total', 'precisam', 'suaVez', 'ativas', 'comErro', 'itens']);
    assert.equal(antigo.precisam, novo.needs);
    assert.ok(antigo.itens.length > 0);
    assert.deepEqual(Object.keys(antigo.itens[0]!), ['sessao', 'titulo', 'projeto', 'conta', 'nivel', 'motivo', 'motivoCurto', 'motivoLongo', 'desde', 'minutos', 'local', 'machine']);
  });

  test('pedido com Origin dá 403, como as outras rotas', async () => {
    const res = await fetch(`${api.url}/api/attention`, { headers: { origin: 'https://exemplo.com' } });
    assert.equal(res.status, 403);
  });

  test('sem a frota, a rota não existe', async () => {
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    const outra = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    assert.equal((await fetch(`${outra.url}/api/attention`)).status, 404);
    await outra.close();
  });
});
