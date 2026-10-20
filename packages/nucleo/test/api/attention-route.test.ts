// `GET /api/attention` (#87): the tray's list, with the synthetic data of the simulator and of the MCP
// tests. No real data.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, montarAtencao, MontadorDoPainel, type LocalApi, type RespostaDaAtencao } from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { seedPanelScenario } from '../../src/simulator/panel.ts';
import { NOW, seed } from '../mcp/helpers.ts';

let storage: SqliteStorage;
let contas: Accounts;
let frota: FleetReader;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  contas = new Accounts({ storage, file: null });
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
    await seedPanelScenario(storage, 'p3', NOW);
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
    await seedPanelScenario(storage, 'p7', NOW);
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
  let api: LocalApi;
  let mudancas: ChangeCursor;
  beforeEach(async () => {
    await seedPanelScenario(storage, 'p3', NOW);
    mudancas = new ChangeCursor();
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => NOW });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, fleet: frota, changes: mudancas });
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

  test('responde as chaves em inglês que outro núcleo lê (src/telemetry/remote.ts); a rota antiga não existe mais (#173 fase 6)', async () => {
    const r = (await (await fetch(`${api.url}/api/attention`)).json()) as RespostaDaAtencao;
    assert.deepEqual(Object.keys(r), ['generatedAt', 'cursor', 'total', 'needs', 'yourTurn', 'blocked', 'idle', 'active', 'withError', 'items']);
    assert.ok(r.items.length > 0);
    assert.deepEqual(Object.keys(r.items[0]!), ['session', 'title', 'project', 'account', 'level', 'reason', 'attention', 'shortReason', 'longReason', 'since', 'minutes', 'local', 'machine']);
    const antiga = await fetch(`${api.url}/api/atencao`);
    assert.equal(antiga.status, 404);
    assert.deepEqual(await antiga.json(), { error: 'não encontrado' });
  });

  test('pedido com Origin dá 403, como as outras rotas', async () => {
    const res = await fetch(`${api.url}/api/attention`, { headers: { origin: 'https://exemplo.com' } });
    assert.equal(res.status, 403);
  });

  test('sem a frota, a rota não existe', async () => {
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    const outra = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {} });
    assert.equal((await fetch(`${outra.url}/api/attention`)).status, 404);
    await outra.close();
  });
});

describe('#245 GET /api/attention: blocked and idle', () => {
  test('#245/AC-3 #245/AC-4 each item carries `attention`, and the counts split blocked from idle; `needs` and `yourTurn` stay', async () => {
    await seed(storage);
    const r = await montarAtencao(frota, null);
    assert.deepEqual(
      r.items.map((i) => [i.session, i.attention]),
      [
        ['plano', { level: 'blocked', reason: 'plan' }],
        ['permissao', { level: 'blocked', reason: 'permission' }],
        ['pergunta', { level: 'blocked', reason: 'question' }],
        ['erro', { level: 'blocked', reason: 'error' }],
        ['sua-vez', { level: 'idle', reason: 'turn_ended' }],
        ['interrompida', { level: 'idle', reason: 'interrupted' }],
        ['abriu', { level: 'idle', reason: 'first_prompt' }],
      ],
    );
    assert.deepEqual({ total: r.total, needs: r.needs, yourTurn: r.yourTurn, blocked: r.blocked, idle: r.idle }, { total: 7, needs: 4, yourTurn: 3, blocked: 4, idle: 3 });
    for (const i of r.items) assert.equal(i.level === 'needs', i.attention.level === 'blocked', i.session);
  });

  test('a remote item gets its attention from its level and reason, whatever the remote sent', async () => {
    const remote = {
      id: 'workstation',
      label: 'Workstation',
      attention: () => ({
        items: [
          { session: 'r1', title: 't', project: null, account: null, level: 'needs', reason: 'question', since: '2026-11-02T11:00:00.000Z', minutes: 60, attention: { level: 'idle', reason: 'turn_ended' } },
          { session: 'r2', title: 't', project: null, account: null, level: 'your-turn', reason: 'no-prompt', since: '2026-11-02T11:00:00.000Z', minutes: 60 },
          // A level its reason does not imply is left out: the counts and `attention` never disagree.
          { session: 'r3', title: 't', project: null, account: null, level: 'needs', reason: 'your-turn', since: '2026-11-02T11:00:00.000Z', minutes: 60 },
        ],
      }),
    };
    const r = await montarAtencao(frota, null, [remote]);
    assert.deepEqual(
      r.items.map((i) => [i.session, i.attention]),
      [
        ['r1', { level: 'blocked', reason: 'question' }],
        ['r2', { level: 'idle', reason: 'first_prompt' }],
      ],
    );
    assert.deepEqual([r.blocked, r.idle], [1, 1]);
  });

  test('GET /api/attention answers the new counts and `attention` on each item', async () => {
    await seed(storage);
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: () => NOW });
    const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, fleet: frota });
    try {
      const fresh = (await (await fetch(`${api.url}/api/attention`)).json()) as RespostaDaAtencao;
      assert.deepEqual([fresh.blocked, fresh.idle], [4, 3]);
      for (const i of fresh.items) assert.ok('attention' in i, i.session);
    } finally {
      await api.close();
    }
  });
});
