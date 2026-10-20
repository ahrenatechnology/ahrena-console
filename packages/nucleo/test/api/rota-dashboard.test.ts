// `GET /api/dashboard` (#27): os números, os agentes ativos e a atividade do Dashboard (C1), com
// os dados sintéticos do simulador e dos testes do MCP. Nenhum dado real.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoDashboard, MontadorDoPainel, montarDashboard, type ApiLocal } from '../../src/api/index.ts';
import { LeituraDaFrota } from '../../src/mcp/index.ts';
import { semearCenariosDoPainel, SESSAO_DO_PAINEL } from '../../src/simulador/painel.ts';
import { at, event } from '../fixtures.ts';
import { AGORA, semear } from '../mcp/helpers.ts';

let storage: SqliteStorage;
let contas: Contas;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  contas = new Contas({ storage, arquivo: null });
});
afterEach(() => storage.close());

const frotaEm = (agora: () => number, fusoHorario = 'UTC') => new LeituraDaFrota({ storage, contas, agora, fusoHorario, cacheMs: 0, custoMs: 0 });

describe('montarDashboard com o cenário p1 do simulador', () => {
  test('os seis números', async () => {
    const agora = Date.now();
    await semearCenariosDoPainel(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(d.numeros.sessoes, { total: 3, ativas: 1, esperando: 2, comErro: 0 });
    // Só o principal da sessão que trabalha; os das que esperam você não contam.
    assert.deepEqual(d.numeros.agentes, { ativos: 1, sessoes: 1 });
    assert.deepEqual(d.numeros.subagentes, { ativos: 1, sessoes: 1 });
    let eventos = 0;
    for (const id of [SESSAO_DO_PAINEL, 'sim-painel-motor-de-regras', 'sim-painel-app-receitas']) eventos += (await storage.listEvents(id, { limit: 500 })).items.length;
    assert.deepEqual(d.numeros.eventos, { hoje: eventos, ultimaHora: eventos, total: eventos });
    assert.equal(d.numeros.custo.usd, 1.84);
    assert.equal(d.numeros.custo.dias, 30);
  });

  test('os agentes: quem trabalha primeiro, com subagentes, turnos, plano e custo', async () => {
    const agora = Date.now();
    await semearCenariosDoPainel(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(
      d.agentes.map((a) => [a.sessao, a.status]),
      [
        [SESSAO_DO_PAINEL, 'active'],
        ['sim-painel-motor-de-regras', 'waiting'],
        ['sim-painel-app-receitas', 'waiting'],
      ],
    );
    const esta = d.agentes[0]!;
    assert.equal(esta.titulo, 'Kanban de sessões no artefato');
    assert.equal(esta.projeto, 'ahrena-demo');
    assert.equal(esta.modelo, 'claude-opus-5-5');
    assert.equal(esta.turnos, 18);
    assert.equal(esta.custoUsd, 1.84);
    assert.equal(esta.tarefa, 'Rodar a bateria');
    assert.deepEqual(
      esta.subagentes.map((s) => [s.tipo, s.status]),
      [
        ['Explore', 'working'],
        ['Plan', 'completed'],
      ],
    );
    // Quem pede permissão mostra o pedido; sem uso, o custo é zero.
    assert.equal(d.agentes[1]!.tarefa, 'Bash: npm run migrate');
    assert.equal(d.agentes[1]!.custoUsd, 0);
  });

  test('a atividade recente: o pedido de permissão e a interrupção, mais novo primeiro', async () => {
    const agora = Date.now();
    await semearCenariosDoPainel(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(
      d.atividade.map((l) => [l.texto, l.projeto, l.status]),
      [
        ['Pede permissão: Bash npm run migrate', 'motor-de-regras', 'waiting'],
        ['Interrompida (Esc)', 'app-receitas', 'waiting'],
      ],
    );
  });
});

describe('MontadorDoDashboard', () => {
  test('com as sessões dos testes do MCP: estados, erro e nada da mensagem do erro', async () => {
    await semear(storage);
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => AGORA) }).montar();
    assert.equal(d.numeros.sessoes.comErro, 1);
    assert.equal(d.numeros.subagentes.ativos, 1);
    const erro = d.atividade.find((l) => l.sessao === 'erro');
    assert.deepEqual(erro && [erro.texto, erro.status], ['Erro de API 529 · overloaded_error', 'error']);
    assert.doesNotMatch(JSON.stringify(d), /hunter2/);
    assert.equal(d.agentes.at(-1)!.status, 'error');
  });

  test('lê só o que é novo: um turno concluído entra, com a duração, e conta nos eventos', async () => {
    let agora = AGORA;
    await semear(storage);
    const m = new MontadorDoDashboard({ frota: frotaEm(() => agora), cacheMs: 0 });
    const antes = await m.montar();
    const s = (await storage.getSession('trabalhando'))!;
    await storage.appendEvent(event({ id: 't-p', sessionId: s.id, agentId: null, type: 'UserPromptSubmit', toolName: null, summary: 'agora roda os testes', createdAt: at(1) }));
    await storage.appendEvent(event({ id: 't-s', sessionId: s.id, agentId: null, type: 'Stop', toolName: null, summary: null, createdAt: new Date(Date.parse(at(1)) + 38_200).toISOString() }));
    await storage.putSession({ ...s, updatedAt: at(2) });
    agora = Date.parse(at(2));
    const depois = await m.montar();
    assert.equal(depois.numeros.eventos.total, antes.numeros.eventos.total + 2);
    assert.equal(depois.atividade[0]!.texto, 'Turno concluído em 38,2 s');
    assert.equal(depois.atividade[0]!.status, 'active');
    const card = depois.agentes.find((a) => a.sessao === 'trabalhando')!;
    assert.deepEqual(card.mensagens, ['agora roda os testes']);
    assert.equal(card.turnos, 1);
  });

  test('"hoje" começa à meia-noite do fuso; a última hora é a última hora', async () => {
    // T0 é 12:00 UTC, 09:00 em São Paulo: 10:00 UTC é hoje nos dois; 02:00 UTC é ontem em São Paulo.
    const sessao = { id: 's-dia', name: 'dia', status: 'active' as const, cwd: '/repo/dia', model: null, source: 'startup', startedAt: at(-700), endedAt: null, awaitingInputSince: null, awaitingReason: null, updatedAt: at(-1), accountId: null, accountSource: null, metadata: {} };
    await storage.putSession(sessao);
    for (const [id, min] of [['a', -600], ['b', -120], ['c', -30], ['d', -5]] as const) {
      await storage.appendEvent(event({ id, sessionId: 's-dia', agentId: null, type: 'PreToolUse', createdAt: at(min) }));
    }
    const utc = await new MontadorDoDashboard({ frota: frotaEm(() => AGORA, 'UTC') }).montar();
    assert.deepEqual(utc.numeros.eventos, { hoje: 4, ultimaHora: 2, total: 4 });
    const sp = await new MontadorDoDashboard({ frota: frotaEm(() => AGORA, 'America/Sao_Paulo') }).montar();
    assert.deepEqual(sp.numeros.eventos, { hoje: 3, ultimaHora: 2, total: 4 });
  });

  test('banco vazio: tudo zero, listas vazias', async () => {
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => AGORA) }).montar();
    assert.deepEqual(d.numeros.sessoes, { total: 0, ativas: 0, esperando: 0, comErro: 0 });
    assert.deepEqual(d.numeros.eventos, { hoje: 0, ultimaHora: 0, total: 0 });
    assert.equal(d.numeros.custo.usd, 0);
    assert.deepEqual([d.agentes, d.atividade], [[], []]);
  });
});

describe('GET /api/dashboard', () => {
  let api: ApiLocal | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });

  const subir = (frota?: LeituraDaFrota) =>
    iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null as never }), hooks: { storage }, port: 0, log: () => {}, ...(frota ? { frota } : {}) });

  test('responde o dashboard quando o núcleo tem a frota', async () => {
    const agora = Date.now();
    await semearCenariosDoPainel(storage, 'p1', agora);
    api = await subir(frotaEm(() => agora));
    const r = await fetch(`${api.url}/api/dashboard`);
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.numeros.sessoes.total, 3);
    assert.equal(corpo.agentes.length, 3);
  });

  test('sem a frota, 404', async () => {
    api = await subir();
    assert.equal((await fetch(`${api.url}/api/dashboard`)).status, 404);
  });
});
