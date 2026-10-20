// O Dev Console montado e a rota (#177): o contexto sintético do simulador, um GitHub falso, sessões
// e decisões num banco em memória, e o `git` falso das pastas. Sem rede, sem dado real.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { registerDecision } from '../../src/decisoes/registro.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { createDevConsole, DEV_CONSOLE_TTL, type DevConsole, type DevConsoleOverview, type DevConsoleView } from '../../src/dev-console/index.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { LeituraDaFrota } from '../../src/mcp/index.ts';
import type { Session } from '../../src/model.ts';
import {
  DEV_CONSOLE_SIMULATOR_CATALOG,
  DEV_CONSOLE_SIMULATOR_CONTEXTS,
  DEV_CONSOLE_SIMULATOR_RULES,
  devConsoleSimulatorGit,
  SimulatedDevConsoleSource,
} from '../../src/simulador/dev-console.ts';
import { agent, at, event, session, T0 } from '../fixtures.ts';
import { clock, type Clock } from '../github/helpers.ts';

let storage: SqliteStorage;
let decisions: SqliteDecisionStore;
let now: Clock;
let source: SimulatedDevConsoleSource;
let devConsole: DevConsole;

async function live(over: Partial<Session>, events: Parameters<typeof event>[0][] = []) {
  const s = session({ startedAt: at(-60), updatedAt: at(-1), ...over });
  await storage.putSession(s);
  await storage.putAgent(agent({ id: `${s.id}:main`, sessionId: s.id, status: s.awaitingInputSince ? 'waiting' : 'working' }));
  let i = 0;
  for (const e of events) await storage.appendEvent(event({ sessionId: s.id, id: `${s.id}-e${++i}`, agentId: `${s.id}:main`, createdAt: at(-30 + i), ...e }));
}

beforeEach(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  decisions = new SqliteDecisionStore(storage.db);
  now = clock(Date.parse(T0));
  source = new SimulatedDevConsoleSource({ now });
  const contas = new Contas({ storage, arquivo: null });
  const frota = new LeituraDaFrota({ storage, contas, agora: now, fusoHorario: 'UTC', cacheMs: 0 });
  devConsole = createDevConsole({
    storage,
    frota,
    decisions,
    source,
    cache: new GithubCache({ store: new MemoryCacheStore(), now }),
    file: null,
    contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS,
    git: devConsoleSimulatorGit,
    now,
  });
  // Trabalhando no #61 (branch no remoto), no #68 (sem push) e uma pedindo permissão (não entra no "depende de você").
  await live({ id: 'trabalhando', name: 'Separar pagamentos', cwd: '/sim/vitrine-demo' });
  await live({ id: 'delegada', name: 'Cupom por categoria', cwd: '/sim/ahrena-demo' });
  await live(
    { id: 'plano', name: 'Migração do esquema', cwd: '/sim/motor-de-regras', awaitingInputSince: at(-9), awaitingReason: 'notification' },
    [{ type: 'PreToolUse', toolName: 'ExitPlanMode', summary: null, data: { tool_use_id: 'p1', tool_input: { plan: 'passos' } } }],
  );
  await live(
    { id: 'permissao', name: 'Rodar a migração', cwd: '/outra/ahrena-demo', awaitingInputSince: at(-2), awaitingReason: 'notification' },
    [{ type: 'Notification', toolName: null, summary: 'Claude needs your permission', data: { notification_type: 'permission_prompt' } }],
  );
  await live({ id: 'fora', name: 'Fora do contexto', cwd: '/sim/cli-de-notas' });
  await registerDecision(
    decisions,
    { sourceKey: 'sugerida:1', sessionId: 'trabalhando', topic: 'cards', context: null, choice: '10 cards por coluna', alternatives: ['20 por coluna'], decidedBy: 'agente', origin: 'sugerida', inferred: true, decidedAt: at(-6) },
    at(-6),
  );
});
afterEach(() => storage.close());

const numbers = (xs: readonly { number: number }[]) => xs.map((x) => x.number);

describe('Dev Console de um contexto', () => {
  test('#177/AC-6 o simulador gera um contexto sintético, e #177/AC-2 a fila sai na ordem: o empilhado depois da base', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(v.context, { id: 'loja', name: 'Loja', repos: [DEV_CONSOLE_SIMULATOR_CATALOG, DEV_CONSOLE_SIMULATOR_RULES], source: 'file' });
    assert.deepEqual(v.mergeQueue.map((q) => [q.repo.split('/')[1], q.number, q.stackedOn]), [
      ['catalogo-exemplo', 81, null],
      ['motor-de-regras', 79, null],
      ['motor-de-regras', 84, 79],
    ]);
    assert.deepEqual(v.notReady.map((n) => [n.number, n.reason]), [
      [82, 'conflict'],
      [77, 'ci-failing'],
      [83, 'ci-running'],
    ]);
  });

  test('#177/AC-2 o placar: prontos, CI rodando, CI vermelho ou conflito, sessões trabalhando e esperando você', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(v.scoreboard, { ready: 3, ciRunning: 1, ciFailingOrConflict: 2, sessionsWorking: 2, waitingOnYou: 2 });
  });

  test('#177/AC-2 depende de você: a sessão do contexto que espera o plano e a decisão sugerida sem resposta; a permissão não entra', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(
      v.dependsOnYou.map((d) => [d.kind, d.sessionId, d.kind === 'session' ? d.reason : d.choice, d.issue]),
      [
        ['session', 'plano', 'plan', 58],
        ['suggested-decision', 'trabalhando', '10 cards por coluna', 61],
      ],
    );
    const s = v.dependsOnYou[0];
    assert.equal(s.kind === 'session' && s.reasonText, 'espera você aprovar o plano');
    assert.equal(s.minutes, 9);
    const d = v.dependsOnYou[1];
    assert.deepEqual(d.kind === 'suggested-decision' && [d.label, d.alternatives, d.minutes], ['D1', ['20 por coluna'], 6]);
  });

  test('#177/AC-3 o quadro em seis colunas, cada card com número, título, sessão, PR e CI', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(Object.keys(v.board), ['todo', 'delegated', 'in-progress', 'in-review', 'blocked', 'done']);
    assert.deepEqual(numbers(v.board.todo), [64, 66, 70]);
    assert.deepEqual(numbers(v.board.delegated), [68]);
    assert.deepEqual(numbers(v.board['in-progress']), [61, 72]);
    assert.deepEqual(numbers(v.board['in-review']), [31, 47, 58]);
    assert.deepEqual(numbers(v.board.blocked), [55]);
    assert.deepEqual(numbers(v.board.done), [52, 50, 49]);
    assert.deepEqual(v.board.delegated[0].session, { id: 'delegada', title: 'Cupom por categoria', waitingOnYou: false });
    const review = v.board['in-review'];
    assert.deepEqual(review.map((c) => [c.number, c.pullRequest?.number, c.ci]), [
      [31, 81, 'ok'],
      [47, 77, 'failing'],
      [58, 79, 'ok'],
    ]);
    assert.deepEqual(review[2].session, { id: 'plano', title: 'Migração do esquema', waitingOnYou: true });
    assert.deepEqual(Object.keys(v.board.todo[0]).sort(), ['ci', 'number', 'pullRequest', 'repo', 'session', 'title', 'url']);
  });

  test('#177/AC-2 mesclados nas últimas 24 h e readAt do GitHub', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(numbers(v.mergedLast24h), [80, 78, 76]);
    assert.equal(v.readAt, T0);
    assert.equal(v.stale, false);
  });

  test('#177/AC-5 #177/AC-6 sem GitHub, devolve o cache com readAt e stale: true', async () => {
    await devConsole.view('loja');
    const calls = source.calls.length;
    now.add(DEV_CONSOLE_TTL.issues + 1);
    source.offline = true;
    const v = (await devConsole.view('loja'))!;
    assert.ok(source.calls.length > calls, 'tentou o GitHub depois do TTL');
    assert.equal(v.stale, true);
    assert.match(v.staleReason ?? '', /fora do ar/);
    assert.equal(v.readAt, T0);
    assert.deepEqual(numbers(v.mergeQueue), [81, 79, 84]);
    assert.deepEqual(numbers(v.board.todo), [64, 66, 70]);
  });

  test('contexto desconhecido: null', async () => {
    assert.equal(await devConsole.view('nenhum'), null);
  });
});

describe('Dev Console sem contexto', () => {
  test('#177/AC-4 a lista dos contextos e a fila de merge de todos eles', async () => {
    const o = await devConsole.overview();
    assert.deepEqual(o.contexts, [{ id: 'loja', name: 'Loja', repos: [DEV_CONSOLE_SIMULATOR_CATALOG, DEV_CONSOLE_SIMULATOR_RULES], source: 'file', ready: 3, notReady: 3 }]);
    assert.deepEqual(numbers(o.mergeQueue), [81, 79, 84]);
    assert.equal(o.readAt, T0);
  });
});

describe('GET /api/dev-console', () => {
  let api: ApiLocal;
  beforeEach(async () => {
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora: now });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, devConsole });
  });
  afterEach(() => api.close());

  test('#177/AC-4 sem context: os contextos e a fila de todos', async () => {
    const res = await fetch(`${api.url}/api/dev-console`);
    assert.equal(res.status, 200);
    const o = (await res.json()) as DevConsoleOverview;
    assert.deepEqual(o.contexts.map((c) => c.id), ['loja']);
    assert.deepEqual(numbers(o.mergeQueue), [81, 79, 84]);
  });

  test('#177/AC-2 com context: o Dev Console do contexto', async () => {
    const res = await fetch(`${api.url}/api/dev-console?context=loja`);
    assert.equal(res.status, 200);
    const v = (await res.json()) as DevConsoleView;
    assert.deepEqual(Object.keys(v).sort(), ['board', 'context', 'dependsOnYou', 'generatedAt', 'mergeQueue', 'mergedLast24h', 'notReady', 'readAt', 'scoreboard', 'stale', 'staleReason']);
    assert.equal(v.scoreboard.ready, 3);
  });

  test('contexto desconhecido dá 404; id inválido dá 400', async () => {
    assert.equal((await fetch(`${api.url}/api/dev-console?context=nenhum`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/dev-console?context=${encodeURIComponent('a b')}`)).status, 400);
  });

  test('só GET, e pedido com Origin de fora dá 403', async () => {
    assert.equal((await fetch(`${api.url}/api/dev-console`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${api.url}/api/dev-console`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
  });

  test('sem o Dev Console, a rota não existe', async () => {
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    const outra = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    assert.equal((await fetch(`${outra.url}/api/dev-console`)).status, 404);
    await outra.close();
  });
});
