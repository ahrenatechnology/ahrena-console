// The assembled Dev Console and its route (#177): the simulator's synthetic context, a fake GitHub,
// sessions and decisions in an in-memory database, and a fake `git` for the folders. No network, no real data.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { createDevConsole, DEV_CONSOLE_TTL, parseContexts, type DevConsole, type DevConsoleOverview, type DevConsoleView } from '../../src/dev-console/index.ts';
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
  // Working on #61 (branch on the remote) and on #68 (not pushed), and one asking permission on #68, which depends on you.
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

describe('Dev Console of one context', () => {
  test('#177/AC-6 the simulator generates a synthetic context, and #177/AC-2 the queue is in order: the stacked PR after its base', async () => {
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

  test('#177/AC-2 the scoreboard: ready, CI running, CI failing or conflict, sessions working and waiting on you', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(v.scoreboard, { ready: 3, ciRunning: 1, ciFailingOrConflict: 2, sessionsWorking: 2, waitingOnYou: 3 });
  });

  test('#177/AC-2 depends on you: the context sessions that need you (the plan and the permission), with the readable reason, and the unanswered suggested decision', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(
      v.dependsOnYou.map((d) => [d.kind, d.sessionId, d.kind === 'session' ? d.reason : d.choice, d.issue]),
      [
        ['session', 'plano', 'plan', 58],
        ['suggested-decision', 'trabalhando', '10 cards por coluna', 61],
        ['session', 'permissao', 'permission', 68],
      ],
    );
    const s = v.dependsOnYou[0];
    assert.equal(s.kind === 'session' && s.reasonText, 'espera você aprovar o plano');
    assert.equal(s.minutes, 9);
    const p = v.dependsOnYou[2];
    assert.match(p.kind === 'session' ? p.reasonText : '', /^pede permissão/);
    const d = v.dependsOnYou[1];
    assert.deepEqual(d.kind === 'suggested-decision' && [d.label, d.alternatives, d.minutes], ['D1', ['20 por coluna'], 6]);
  });

  test('#177/AC-3 the board in six columns, each card with number, title, session, PR and CI', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(Object.keys(v.board), ['todo', 'delegated', 'in-progress', 'in-review', 'blocked', 'done']);
    assert.deepEqual(numbers(v.board.todo), [64, 66, 70]);
    assert.deepEqual(numbers(v.board.delegated), [68]);
    assert.deepEqual(numbers(v.board['in-progress']), [61, 72]);
    assert.deepEqual(numbers(v.board['in-review']), [31, 47, 58]);
    assert.deepEqual(numbers(v.board.blocked), [55]);
    assert.deepEqual(numbers(v.board.done), [52, 50, 49]);
    // Two sessions on #68's branch: the card shows the one waiting on you.
    assert.deepEqual(v.board.delegated[0].session, { id: 'permissao', title: 'Rodar a migração', waitingOnYou: true });
    const review = v.board['in-review'];
    assert.deepEqual(review.map((c) => [c.number, c.pullRequest?.number, c.ci]), [
      [31, 81, 'ok'],
      [47, 77, 'failing'],
      [58, 79, 'ok'],
    ]);
    assert.deepEqual(review[2].session, { id: 'plano', title: 'Migração do esquema', waitingOnYou: true });
    assert.deepEqual(Object.keys(v.board.todo[0]).sort(), ['ci', 'number', 'pullRequest', 'repo', 'session', 'title', 'url']);
  });

  test('#177/AC-2 merged in the last 24 h and GitHub readAt', async () => {
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(numbers(v.mergedLast24h), [80, 78, 76]);
    assert.equal(v.readAt, T0);
    assert.equal(v.stale, false);
  });

  test('#177/AC-5 #177/AC-6 with no GitHub, returns the cache with readAt and stale: true', async () => {
    await devConsole.view('loja');
    const calls = source.calls.length;
    now.add(DEV_CONSOLE_TTL.issues + 1);
    source.offline = true;
    const v = (await devConsole.view('loja'))!;
    assert.ok(source.calls.length > calls, 'it tried GitHub after the TTL');
    assert.equal(v.stale, true);
    assert.match(v.staleReason ?? '', /fora do ar/);
    assert.equal(v.readAt, T0);
    assert.deepEqual(numbers(v.mergeQueue), [81, 79, 84]);
    assert.deepEqual(numbers(v.board.todo), [64, 66, 70]);
  });

  test('#177/AC-5 partial GitHub list: truncated per repository', async () => {
    let v = (await devConsole.view('loja'))!;
    assert.deepEqual(v.truncated, { [DEV_CONSOLE_SIMULATOR_CATALOG]: false, [DEV_CONSOLE_SIMULATOR_RULES]: false });
    class Partial extends SimulatedDevConsoleSource {
      override async issues(repo: string) {
        const r = await super.issues(repo);
        return repo === DEV_CONSOLE_SIMULATOR_RULES ? { ...r, truncated: true } : r;
      }
    }
    const contas = new Contas({ storage, arquivo: null });
    const frota = new LeituraDaFrota({ storage, contas, agora: now, fusoHorario: 'UTC', cacheMs: 0 });
    const partial = createDevConsole({ storage, frota, source: new Partial({ now }), cache: new GithubCache({ store: new MemoryCacheStore(), now }), file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit, now });
    v = (await partial.view('loja'))!;
    assert.deepEqual(v.truncated, { [DEV_CONSOLE_SIMULATOR_CATALOG]: false, [DEV_CONSOLE_SIMULATOR_RULES]: true });
  });

  test('#177/AC-1 #177/AC-3 mixed-case owner/repo in the file and in the session remote match', async () => {
    const contas = new Contas({ storage, arquivo: null });
    const frota = new LeituraDaFrota({ storage, contas, agora: now, fusoHorario: 'UTC', cacheMs: 0 });
    const git: typeof devConsoleSimulatorGit = async (cwd, args) =>
      cwd !== '/sim/ahrena-demo' ? null : args[0] === 'remote' ? 'git@github.com:Dev-Sintetico/Catalogo-Exemplo.git' : args[0] === 'branch' ? 'feat/68-cupom' : null;
    const mixed = createDevConsole({
      storage, frota, source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), file: null, git, now,
      contexts: parseContexts({ contexts: [{ id: 'mix', repos: ['DEV-SINTETICO/catalogo-exemplo'] }] }),
    });
    const v = (await mixed.view('mix'))!;
    assert.deepEqual(v.context.repos, [DEV_CONSOLE_SIMULATOR_CATALOG]);
    assert.deepEqual(numbers(v.board.delegated), [68]);
    assert.equal(v.board.delegated[0].session?.id, 'delegada');
    assert.equal(v.scoreboard.sessionsWorking, 1);
  });

  test('#179/AC-2 decisions taken today: the ones in force from the context sessions, most recent first; yesterday and outside the context stay out', async () => {
    const decide = (sessionId: string, key: string, choice: string, minutesAgo: number) =>
      registerDecision(
        decisions,
        { sourceKey: key, sessionId, topic: key, context: null, choice, alternatives: [], decidedBy: 'usuario', origin: 'pergunta', inferred: false, decidedAt: at(-minutesAgo) },
        at(-minutesAgo),
      );
    await decide('trabalhando', 'q1', 'SQLite em memória nos testes', 14);
    await decide('plano', 'q2', 'Cobrança vira um serviço à parte', 25);
    await decide('fora', 'q3', 'Fora do contexto', 5);
    // T0 is 12:00 UTC: 13 h ago is yesterday.
    await decide('trabalhando', 'q4', 'De ontem', 13 * 60);
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(
      v.decisionsToday.map((d) => [d.sessionId, d.choice, d.minutes]),
      [
        ['trabalhando', 'SQLite em memória nos testes', 14],
        ['plano', 'Cobrança vira um serviço à parte', 25],
      ],
    );
    assert.match(v.decisionsToday[0].label, /^D\d+$/);
    assert.equal(v.decisionsToday[1].repo, DEV_CONSOLE_SIMULATOR_RULES);
  });

  test('#179/AC-2 decisions taken today include a context session that already ended today', async () => {
    await storage.putSession(session({ id: 'ended', name: 'Encerrada', cwd: '/sim/motor-de-regras', status: 'completed', startedAt: at(-120), updatedAt: at(-5), endedAt: at(-5) }));
    await registerDecision(
      decisions,
      { sourceKey: 'e1', sessionId: 'ended', topic: 'e1', context: null, choice: 'Decidida numa sessão encerrada', alternatives: [], decidedBy: 'usuario', origin: 'pergunta', inferred: false, decidedAt: at(-20) },
      at(-20),
    );
    const v = (await devConsole.view('loja'))!;
    assert.deepEqual(v.decisionsToday.map((d) => [d.sessionId, d.choice, d.repo]), [['ended', 'Decidida numa sessão encerrada', DEV_CONSOLE_SIMULATOR_RULES]]);
  });

  test('#179/AC-2 a session that completes while the live list is cached is counted once', async () => {
    const contas = new Contas({ storage, arquivo: null });
    const frota = new LeituraDaFrota({ storage, contas, agora: now, fusoHorario: 'UTC', cacheMs: 60_000 });
    const cached = createDevConsole({ storage, frota, decisions, source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit, now });
    await registerDecision(
      decisions,
      { sourceKey: 'c1', sessionId: 'plano', topic: 'c1', context: null, choice: 'Uma vez só', alternatives: [], decidedBy: 'usuario', origin: 'pergunta', inferred: false, decidedAt: at(-3) },
      at(-3),
    );
    await cached.view('loja');
    const s = (await storage.getSession('plano'))!;
    await storage.putSession({ ...s, status: 'completed', endedAt: at(-1), updatedAt: at(-1) });
    const v = (await cached.view('loja'))!;
    assert.deepEqual(v.decisionsToday.filter((d) => d.choice === 'Uma vez só').length, 1);
  });

  test('#179/AC-2 "today" is the machine day: in America/Sao_Paulo a decision at 01:00 UTC is yesterday', async () => {
    const decide = (key: string, choice: string, minutesAgo: number) =>
      registerDecision(
        decisions,
        { sourceKey: key, sessionId: 'trabalhando', topic: key, context: null, choice, alternatives: [], decidedBy: 'usuario', origin: 'pergunta', inferred: false, decidedAt: at(-minutesAgo) },
        at(-minutesAgo),
      );
    // T0 is 12:00 UTC, 09:00 in São Paulo: 04:00 UTC is 01:00 there (today), 01:00 UTC is 22:00 there (yesterday).
    await decide('sp1', 'Hoje em São Paulo', 8 * 60);
    await decide('sp2', 'Ontem em São Paulo', 11 * 60);
    const contas = new Contas({ storage, arquivo: null });
    const frota = new LeituraDaFrota({ storage, contas, agora: now, fusoHorario: 'America/Sao_Paulo', cacheMs: 0 });
    const sp = createDevConsole({ storage, frota, decisions, source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit, now });
    assert.deepEqual((await sp.view('loja'))!.decisionsToday.map((d) => d.choice), ['Hoje em São Paulo']);
    assert.deepEqual((await devConsole.view('loja'))!.decisionsToday.map((d) => d.choice), ['Hoje em São Paulo', 'Ontem em São Paulo'], 'both are today in UTC');
  });

  test('unknown context: null', async () => {
    assert.equal(await devConsole.view('nenhum'), null);
  });
});

describe('Dev Console without a context', () => {
  test('#177/AC-4 the list of contexts and the merge queue of all of them', async () => {
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

  test('#177/AC-4 without context: the contexts and the queue of all', async () => {
    const res = await fetch(`${api.url}/api/dev-console`);
    assert.equal(res.status, 200);
    const o = (await res.json()) as DevConsoleOverview;
    assert.deepEqual(o.contexts.map((c) => c.id), ['loja']);
    assert.deepEqual(numbers(o.mergeQueue), [81, 79, 84]);
  });

  test('#177/AC-2 with context: the Dev Console of the context', async () => {
    const res = await fetch(`${api.url}/api/dev-console?context=loja`);
    assert.equal(res.status, 200);
    const v = (await res.json()) as DevConsoleView;
    assert.deepEqual(Object.keys(v).sort(), ['board', 'context', 'decisionsToday', 'dependsOnYou', 'generatedAt', 'mergeQueue', 'mergedLast24h', 'notReady', 'readAt', 'scoreboard', 'stale', 'staleReason', 'truncated']);
    assert.equal(v.scoreboard.ready, 3);
  });

  test('unknown context gives 404; invalid id gives 400', async () => {
    assert.equal((await fetch(`${api.url}/api/dev-console?context=nenhum`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/dev-console?context=${encodeURIComponent('a b')}`)).status, 400);
  });

  test('GET only, and a request with a foreign Origin gives 403', async () => {
    assert.equal((await fetch(`${api.url}/api/dev-console`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${api.url}/api/dev-console`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
  });

  test('without the Dev Console, the route does not exist', async () => {
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    const outra = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    assert.equal((await fetch(`${outra.url}/api/dev-console`)).status, 404);
    await outra.close();
  });
});
