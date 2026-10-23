// `GET /api/dashboard` (#27): the Dashboard's numbers, active agents and activity (C1), with
// the synthetic data of the simulator and of the MCP tests. No real data.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoDashboard, MontadorDoPainel, montarDashboard, type LocalApi } from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { seedPanelScenario, PANEL_SESSION } from '../../src/simulator/panel.ts';
import { aggregateCost } from '../../src/cost/aggregation.ts';
import { at, event, session, usage } from '../fixtures.ts';
import { NOW, seed } from '../mcp/helpers.ts';

let storage: SqliteStorage;
let contas: Accounts;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  contas = new Accounts({ storage, file: null });
});
afterEach(() => storage.close());

const frotaEm = (agora: () => number, fusoHorario = 'UTC') => new FleetReader({ storage, accounts: contas, now: agora, timeZone: fusoHorario, cacheMs: 0, costMs: 0 });

describe('montarDashboard com o cenário p1 do simulador', () => {
  test('os seis números', async () => {
    const agora = Date.now();
    await seedPanelScenario(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(d.numbers.sessions, { total: 3, active: 1, waiting: 2, withError: 0, blocked: 1, idle: 1 });
    // Só o principal da sessão que trabalha; os das que esperam você não contam.
    assert.deepEqual(d.numbers.agents, { active: 1, sessions: 1 });
    assert.deepEqual(d.numbers.subagents, { active: 1, sessions: 1 });
    let eventos = 0;
    for (const id of [PANEL_SESSION, 'sim-panel-motor-de-regras', 'sim-panel-app-receitas']) eventos += (await storage.listEvents(id, { limit: 500 })).items.length;
    assert.deepEqual(d.numbers.events, { today: eventos, lastHour: eventos, total: eventos });
    assert.equal(d.numbers.cost.usd, 1.84);
    assert.equal(d.numbers.cost.days, 30);
  });

  test('os agentes: quem trabalha primeiro, com subagentes, turnos, plano e custo', async () => {
    const agora = Date.now();
    await seedPanelScenario(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(
      d.agents.map((a) => [a.session, a.status]),
      [
        [PANEL_SESSION, 'active'],
        ['sim-panel-motor-de-regras', 'waiting'],
        ['sim-panel-app-receitas', 'waiting'],
      ],
    );
    const esta = d.agents[0]!;
    assert.equal(esta.title, 'Kanban de sessões no artefato');
    assert.equal(esta.project, 'ahrena-demo');
    assert.equal(esta.model, 'claude-opus-5-5');
    assert.equal(esta.turns, 18);
    assert.equal(esta.costUsd, 1.84);
    assert.equal(esta.task, 'Rodar a bateria');
    assert.deepEqual(
      esta.subagents.map((s) => [s.type, s.status]),
      [
        ['Explore', 'working'],
        ['Plan', 'completed'],
      ],
    );
    // Quem pede permissão mostra o pedido; sem uso, o custo é zero.
    assert.equal(d.agents[1]!.task, 'Bash: npm run migrate');
    assert.equal(d.agents[1]!.costUsd, 0);
  });

  test('a atividade recente: o pedido de permissão e a interrupção, mais novo primeiro', async () => {
    const agora = Date.now();
    await seedPanelScenario(storage, 'p1', agora);
    const d = await montarDashboard(frotaEm(() => agora));
    assert.deepEqual(
      d.activity.map((l) => [l.text, l.project, l.status]),
      [
        ['Pede permissão: Bash npm run migrate', 'motor-de-regras', 'waiting'],
        ['Interrompida (Esc)', 'app-receitas', 'waiting'],
      ],
    );
  });
});

describe('MontadorDoDashboard', () => {
  test('com as sessões dos testes do MCP: estados, erro e nada da mensagem do erro', async () => {
    await seed(storage);
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => NOW) }).montar();
    assert.equal(d.numbers.sessions.withError, 1);
    assert.equal(d.numbers.subagents.active, 1);
    const erro = d.activity.find((l) => l.session === 'erro');
    assert.deepEqual(erro && [erro.text, erro.status], ['Erro de API 529 · overloaded_error', 'error']);
    assert.doesNotMatch(JSON.stringify(d), /hunter2/);
    assert.equal(d.agents.at(-1)!.status, 'error');
  });

  test('lê só o que é novo: um turno concluído entra, com a duração, e conta nos eventos', async () => {
    let agora = NOW;
    await seed(storage);
    const m = new MontadorDoDashboard({ frota: frotaEm(() => agora), cacheMs: 0 });
    const antes = await m.montar();
    const s = (await storage.getSession('trabalhando'))!;
    await storage.appendEvent(event({ id: 't-p', sessionId: s.id, agentId: null, type: 'UserPromptSubmit', toolName: null, summary: 'agora roda os testes', createdAt: at(1) }));
    await storage.appendEvent(event({ id: 't-s', sessionId: s.id, agentId: null, type: 'Stop', toolName: null, summary: null, createdAt: new Date(Date.parse(at(1)) + 38_200).toISOString() }));
    await storage.putSession({ ...s, updatedAt: at(2) });
    agora = Date.parse(at(2));
    const depois = await m.montar();
    assert.equal(depois.numbers.events.total, antes.numbers.events.total + 2);
    assert.equal(depois.activity[0]!.text, 'Turno concluído em 38,2 s');
    assert.equal(depois.activity[0]!.status, 'active');
    const card = depois.agents.find((a) => a.session === 'trabalhando')!;
    assert.deepEqual(card.messages, ['agora roda os testes']);
    assert.equal(card.turns, 1);
  });

  test('"hoje" começa à meia-noite do fuso; a última hora é a última hora', async () => {
    // T0 é 12:00 UTC, 09:00 em São Paulo: 10:00 UTC é hoje nos dois; 02:00 UTC é ontem em São Paulo.
    const sessao = { id: 's-dia', name: 'dia', status: 'active' as const, cwd: '/repo/dia', model: null, source: 'startup', startedAt: at(-700), endedAt: null, awaitingInputSince: null, awaitingReason: null, updatedAt: at(-1), accountId: null, accountSource: null, metadata: {} };
    await storage.putSession(sessao);
    for (const [id, min] of [['a', -600], ['b', -120], ['c', -30], ['d', -5]] as const) {
      await storage.appendEvent(event({ id, sessionId: 's-dia', agentId: null, type: 'PreToolUse', createdAt: at(min) }));
    }
    const utc = await new MontadorDoDashboard({ frota: frotaEm(() => NOW, 'UTC') }).montar();
    assert.deepEqual(utc.numbers.events, { today: 4, lastHour: 2, total: 4 });
    const sp = await new MontadorDoDashboard({ frota: frotaEm(() => NOW, 'America/Sao_Paulo') }).montar();
    assert.deepEqual(sp.numbers.events, { today: 3, lastHour: 2, total: 4 });
  });

  test('banco vazio: tudo zero, listas vazias', async () => {
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => NOW) }).montar();
    assert.deepEqual(d.numbers.sessions, { total: 0, active: 0, waiting: 0, withError: 0, blocked: 0, idle: 0 });
    assert.deepEqual(d.numbers.events, { today: 0, lastHour: 0, total: 0 });
    assert.equal(d.numbers.cost.usd, 0);
    assert.deepEqual([d.agents, d.activity], [[], []]);
  });
});

// #311: the build is incremental (events and cost slices per session) and yields to the event loop.
describe('MontadorDoDashboard at scale (#311)', () => {
  const withUsage = (id: string, sessionId: string, messageId: string, min: number) =>
    event({ id, sessionId, agentId: `${sessionId}:main`, type: 'ToolUse', toolName: 'Bash', summary: null, createdAt: at(min), data: { usage: { messageId, model: 'claude-opus-5-5', tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });

  test('the response after incremental changes is the one a cold build gives, cost included', async () => {
    let agora = NOW;
    await seed(storage);
    const frota = frotaEm(() => agora);
    const m = new MontadorDoDashboard({ frota, cacheMs: 0, custoMs: 0 });
    const before = await m.montar();
    const s = (await storage.getSession('trabalhando'))!;
    await storage.appendEvent(withUsage('u1', s.id, 'msg-1', 1));
    await storage.appendEvent(withUsage('u2', s.id, 'msg-2', 2));
    await storage.putSession({ ...s, updatedAt: at(2) });
    agora = Date.parse(at(2));
    const incremental = await m.montar();
    const cold = await new MontadorDoDashboard({ frota: frotaEm(() => agora), cacheMs: 0, custoMs: 0 }).montar();
    assert.deepEqual(incremental, cold);
    assert.notEqual(incremental.numbers.cost.usd, before.numbers.cost.usd);
    assert.deepEqual(Object.keys(incremental), ['generatedAt', 'day', 'timeZone', 'numbers', 'agents', 'activity']);
    assert.deepEqual(Object.keys(incremental.numbers), ['sessions', 'agents', 'subagents', 'events', 'cost']);
  });

  test('a token-usage bucket written without touching the session shows in the next cost refresh', async () => {
    const id = 'bucket-only';
    await storage.putSession(session({ id, status: 'completed', startedAt: at(-60), updatedAt: at(-30) }));
    await storage.appendEvent(withUsage('b-u', id, 'b-m', -20));
    const m = new MontadorDoDashboard({ frota: frotaEm(() => NOW), cacheMs: 0, custoMs: 0 });
    const before = await m.montar();
    await storage.putTokenUsage(usage({ sessionId: id, tokens: { input: 5_000_000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, updatedAt: at(-10) }));
    const after = await m.montar();
    assert.ok((after.numbers.cost.usd ?? 0) > (before.numbers.cost.usd ?? 0));
    assert.deepEqual(after, await new MontadorDoDashboard({ frota: frotaEm(() => NOW), cacheMs: 0, custoMs: 0 }).montar());
  });

  test('the cost of sessions with several pages of events is the one aggregateCost gives', async () => {
    for (const [id, n] of [['big-a', 620], ['big-b', 40]] as const) {
      await storage.putSession(session({ id, status: 'completed', startedAt: at(-90), updatedAt: at(-5) }));
      for (let i = 0; i < n; i++) await storage.appendEvent(withUsage(`${id}-u${i}`, id, `${id}-m${i % 300}`, -80 + (i % 70)));
    }
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => NOW) }).montar();
    const direct = await aggregateCost(storage, { since: '2026-10-04', until: '2026-11-02', timeZone: 'UTC' });
    assert.equal(d.numbers.cost.usd, Math.round((direct.total.costUsd ?? 0) * 100) / 100);
  });

  test('a build over many sessions gives the event loop back', async () => {
    for (let i = 0; i < 60; i++) {
      const id = `bulk-${i}`;
      await storage.putSession(session({ id, status: 'completed', startedAt: at(-60), updatedAt: at(-30 + (i % 20)) }));
      await storage.appendEvent(withUsage(`${id}-u`, id, `${id}-m`, -20));
    }
    let turns = 0;
    let running = true;
    const tick = (): void => {
      turns++;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const d = await new MontadorDoDashboard({ frota: frotaEm(() => NOW), sliceMs: 0 }).montar();
    running = false;
    assert.equal(d.numbers.sessions.total, 60);
    assert.ok(turns >= 60, `the event loop turned only ${turns} times during the build`);
  });
});

describe('GET /api/dashboard', () => {
  let api: LocalApi | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });

  const subir = (frota?: FleetReader) =>
    startLocalApi({ panelBuilder: new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null as never }), hooks: { storage }, port: 0, log: () => {}, ...(frota ? { fleet: frota } : {}) });

  test('responde o dashboard quando o núcleo tem a frota', async () => {
    const agora = Date.now();
    await seedPanelScenario(storage, 'p1', agora);
    api = await subir(frotaEm(() => agora));
    const r = await fetch(`${api.url}/api/dashboard`);
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.numbers.sessions.total, 3);
    assert.equal(corpo.agents.length, 3);
  });

  test('sem a frota, 404', async () => {
    api = await subir();
    assert.equal((await fetch(`${api.url}/api/dashboard`)).status, 404);
  });
});
