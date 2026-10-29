import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Accounts,
  MontadorDoMural,
  MontadorDoPainel,
  TrabalhoPorBranch,
  ehAberta,
  startLocalApi,
  muralDoPainel,
  type DesktopIndex,
  type Wall,
  type DesktopSession,
} from '../../src/api/index.ts';
import { SimulatorWorkSource, PANEL_SESSION, seedPanelScenario } from '../../src/simulator/panel.ts';
import type { StoragePort } from '../../src/storage-port.ts';
import { T0, session } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const MIN = 60_000;
const iso = (minAtras: number) => new Date(AGORA - minAtras * MIN).toISOString();

/**
 * As sessões do simulador: o P4 (esta sessão delegando, uma na sua vez, uma ativa e uma concluída há
 * 20 min) e as outras do P6 (permissão, Esc e erro). Mais três que não estão abertas: abandonada,
 * concluída há 200 min e erro encerrado há 200 min (o abandono do vigia é 180 min). O P4 por último:
 * o git falso responde o branch dele. O simulador grava `metadata.branch` e `metadata.esforco`.
 */
async function semear() {
  const storage = openSqliteStorage({ path: ':memory:' });
  await seedPanelScenario(storage, 'p6', AGORA);
  await seedPanelScenario(storage, 'p4', AGORA);
  await storage.putSession(session({ id: 'sim-mural-abandonada', cwd: '/simulacao/abandonada', status: 'abandoned', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  await storage.putSession(session({ id: 'sim-mural-antiga', cwd: '/simulacao/antiga', status: 'completed', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  await storage.putSession(session({ id: 'sim-mural-erro-velho', cwd: '/simulacao/erro-velho', status: 'error', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  return storage;
}

function painelDe(storage: StoragePort, desktop: DesktopIndex | null = null, trabalho: TrabalhoPorBranch | null = null) {
  return new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop, trabalho, agora: () => AGORA });
}

const muralDe = (storage: StoragePort, desktop: DesktopIndex | null = null) => muralDoPainel(painelDe(storage, desktop));

/** Conta as leituras de custo e tokens que passam pela porta. */
function contando(storage: StoragePort) {
  const n = { usos: 0 };
  const porta = new Proxy(storage, {
    get(alvo, chave, rec) {
      const v = Reflect.get(alvo, chave, rec);
      if (chave === 'listTokenUsage') return (...a: unknown[]) => (n.usos++, (v as (...x: unknown[]) => unknown).apply(alvo, a));
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
  return { porta, n };
}

const sim = (slug: string) => `sim-panel-${slug}`;

describe('mural ao vivo (#34)', () => {
  test('critério de aberta: viva, ou encerrada com atividade recente; nunca abandonada nem arquivada', () => {
    const base = { endedAt: null, updatedAt: iso(500) };
    assert.equal(ehAberta({ ...base, status: 'active' }, null, AGORA), true, 'ativa (e esperando) entra, por mais parada que esteja: o vigia a abandona');
    assert.equal(ehAberta({ ...base, status: 'error' }, null, AGORA), true, 'erro sem fim entra');
    assert.equal(ehAberta({ status: 'error', endedAt: iso(120), updatedAt: iso(120) }, null, AGORA), true, 'erro encerrado há 2 h ainda entra');
    assert.equal(ehAberta({ status: 'error', endedAt: iso(181), updatedAt: iso(181) }, null, AGORA), false, 'erro encerrado há mais que o abandono sai');
    assert.equal(ehAberta({ status: 'completed', endedAt: iso(179), updatedAt: iso(179) }, null, AGORA), true, 'concluída dentro do abandono do vigia (180 min) entra');
    assert.equal(ehAberta({ status: 'completed', endedAt: iso(181), updatedAt: iso(181) }, null, AGORA), false, 'concluída há mais de 180 min sai');
    assert.equal(ehAberta({ status: 'abandoned', endedAt: iso(1), updatedAt: iso(1) }, null, AGORA), false, 'abandonada nunca entra');
    assert.equal(ehAberta({ ...base, status: 'active' }, { archived: true }, AGORA), false, 'arquivada no Desktop sai');
  });

  test('formato, ordem e contagem', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    assert.equal(mural.version, 1);
    assert.equal(mural.generatedAt, T0);
    assert.deepEqual(
      mural.cards.map((c) => c.id),
      [
        // Precisam de você: urgentes e erro, o pedido mais recente primeiro; depois as ociosas (#245), a mais recente primeiro.
        sim('motor-de-regras'), sim('painel-de-metricas'), sim('fila-de-tarefas'), sim('app-receitas'),
        // As outras, pela atividade mais recente; a concluída há 20 min ainda está aberta.
        PANEL_SESSION, sim('catalogo-exemplo'), sim('blog-estatico'),
      ],
    );
    assert.deepEqual(mural.count, { all: 7, waiting: 4, active: 2, blocked: 2, idle: 2 });
    const [permissao, erro, suaVez] = mural.cards;
    assert.deepEqual([permissao.status, permissao.state, permissao.reason, permissao.urgent, permissao.activity.type], ['waiting', 'waiting', 'notification', true, 'permission']);
    assert.deepEqual([erro.status, erro.state, erro.urgent, erro.activity.type], ['error', 'error', true, 'error']);
    assert.equal(erro.since, iso(3));
    assert.deepEqual([suaVez.urgent, suaVez.activity], [false, { type: 'your-turn', text: '"Terminei a migração. Rodo os testes?"' }]);
    const concluida = mural.cards.at(-1)!;
    assert.deepEqual([concluida.status, concluida.activity.type], ['completed', 'completed']);
    await storage.close();
  });

  test('o card de uma sessão com plano, subagentes, contexto e custo', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    const esta = mural.cards.find((c) => c.id === PANEL_SESSION)!;
    assert.equal(esta.title, 'Separar pagamentos em serviços');
    assert.equal(esta.project, 'vitrine-demo');
    assert.equal(esta.branch, 'feat/63-separar-pagamentos', 'sem o Desktop, o branch da metadata');
    assert.equal(esta.state, 'delegating');
    assert.equal(esta.model, 'claude-opus-5-5');
    assert.equal(esta.effort, 'high', 'sem o índice do Desktop, o esforço da metadata');
    assert.deepEqual(esta.agents, { active: 4, total: 5 }, 'o principal conta');
    assert.deepEqual(esta.plan, { done: 2, total: 6, current: 'Extrair a cobrança' });
    assert.equal(esta.context?.limit, 200_000);
    assert.equal(esta.context?.used, 114_000);
    assert.equal(esta.context?.pct, 57);
    assert.equal(typeof esta.context?.label, 'string');
    assert.equal(esta.cost.estimate, true);
    assert.ok(esta.cost.usd !== null && Math.abs(esta.cost.usd - 3.47) < 0.05, `custo ${esta.cost.usd}`);
    await storage.close();
  });

  test('sessão sem plano, sem contexto e sem uso', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    const catalogo = mural.cards.find((c) => c.id === sim('catalogo-exemplo'))!;
    assert.equal(catalogo.plan, null);
    assert.equal(catalogo.context, null);
    assert.deepEqual(catalogo.cost, { usd: 0, estimate: true });
    assert.deepEqual(catalogo.agents, { active: catalogo.state === 'active' ? 1 : 0, total: 1 });
    assert.equal(catalogo.effort, 'medium');
    assert.equal(catalogo.branch, 'feat/31-csv');
    await storage.close();
  });

  test('o custo vem do cache: um segundo pedido não recalcula', async () => {
    const storage = await semear();
    const { porta, n } = contando(storage);
    const painel = painelDe(porta);
    const mural = new MontadorDoMural({ painel, storage: porta, agora: () => AGORA, cacheMs: 0 });
    const primeiro = await mural.montar();
    const lidos = n.usos;
    assert.ok(lidos >= primeiro.count.all, 'o primeiro pedido calcula o custo de cada sessão aberta');
    const segundo = await mural.montar();
    assert.notEqual(segundo, primeiro, 'sem o cache da resposta, montou de novo');
    assert.equal(n.usos, lidos, 'mas o custo saiu do cache: nada novo lido');
    assert.deepEqual(segundo.cards.map((c) => c.cost), primeiro.cards.map((c) => c.cost));
    await storage.close();
  });

  test('a resposta inteira fica guardada por cacheMs, e pedidos juntos esperam a mesma montagem', async () => {
    const storage = await semear();
    const mural = muralDe(storage);
    const [a, b] = await Promise.all([mural.montar(), mural.montar()]);
    assert.equal(a, b);
    assert.equal(await mural.montar(), a);
    await storage.close();
  });

  test('o esforço e a arquivada vêm do índice do Desktop', async () => {
    const storage = await semear();
    const sessao = (cli: string, extra: Partial<DesktopSession>): DesktopSession => ({
      localId: `local_${cli}`, cliSessionId: cli, title: null, branch: null, cwd: null, parentLocalId: null, archived: false, accounts: [], ...extra,
    });
    const doDesktop: Record<string, DesktopSession> = {
      [PANEL_SESSION]: sessao(PANEL_SESSION, { effort: 'max', branch: 'feat/63-do-desktop' }),
      [sim('catalogo-exemplo')]: sessao(sim('catalogo-exemplo'), { archived: true }),
    };
    const desktop = { refresh: async () => {}, sessionByCli: (id: string) => doDesktop[id] ?? null, sessionByLocal: () => null, childrenOf: () => [] } as unknown as DesktopIndex;
    const mural = await muralDe(storage, desktop).montar();
    const esta = mural.cards.find((c) => c.id === PANEL_SESSION)!;
    assert.equal(esta.effort, 'max', 'o Desktop vale mais que a metadata');
    assert.equal(esta.branch, 'feat/63-do-desktop');
    assert.equal(mural.cards.some((c) => c.id === sim('catalogo-exemplo')), false, 'a arquivada no Desktop sai do mural');
    assert.deepEqual(mural.count, { all: 6, waiting: 4, active: 1, blocked: 2, idle: 2 });
    await storage.close();
  });

  test('sessão de terminal sem branch: o do git da pasta, em cache, sem GitHub', async () => {
    const storage = await semear();
    await storage.putSession(session({ id: 'sim-mural-terminal', cwd: '/simulacao/terminal', status: 'active', updatedAt: iso(1), metadata: { simulado: true } }));
    const pastas: string[] = [];
    const git = async (cwd: string, args: string[]) => (args[0] === 'branch' ? (pastas.push(cwd), cwd === '/simulacao/terminal' ? 'feat/7-terminal' : null) : null);
    const trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git, agora: () => AGORA });
    const mural = muralDoPainel(painelDe(storage, null, trabalho), { cacheMs: 0 });
    const doTerminal = async () => (await mural.montar()).cards.find((c) => c.id === 'sim-mural-terminal')?.branch;
    assert.equal(await doTerminal(), null, 'o primeiro pedido não espera o git');
    await trabalho.esperar();
    assert.equal(await doTerminal(), 'feat/7-terminal');
    // #333: the parked sessions (no branch known either) read it too, each folder once.
    assert.equal(pastas.filter((p) => p === '/simulacao/terminal').length, 1, 'a sessão sem branch roda git uma vez (cache de 60 s)');
    assert.equal(new Set(pastas).size, pastas.length, 'cada pasta, uma vez');
    assert.equal(trabalho.chamadas.github, 0, 'nunca o GitHub');
    await storage.close();
  });

  test('GET /api/wall pela API local', async () => {
    const storage = await semear();
    const api = await startLocalApi({ panelBuilder: painelDe(storage), hooks: { storage }, port: 0, log: () => {} });
    try {
      const r = await fetch(`${api.url}/api/wall`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      const mural = (await r.json()) as Wall;
      assert.equal(mural.version, 1);
      assert.equal(mural.cards.length, 7);
      assert.equal((await fetch(`${api.url}/api/wall`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
      assert.equal((await fetch(`${api.url}/api/wall`, { method: 'POST' })).status, 405);
      // The old Portuguese route is gone (#173 phase 6).
      const antiga = await fetch(`${api.url}/api/mural`);
      assert.equal(antiga.status, 404);
      assert.deepEqual(await antiga.json(), { error: 'não encontrado' });
    } finally {
      await api.close();
      await storage.close();
    }
  });
});

/** The Desktop index as a map of `local_…` rows, for the tree and the archive. */
function desktopOf(rows: DesktopSession[]): DesktopIndex {
  const row = (cli: string, extra: Partial<DesktopSession> = {}): DesktopSession => ({ localId: `local_${cli}`, cliSessionId: cli, title: cli, branch: null, cwd: null, parentLocalId: null, archived: false, accounts: [], ...extra });
  const all = rows.map((r) => row(r.cliSessionId!, r));
  return {
    refresh: async () => {},
    sessionByCli: (id: string) => all.find((r) => r.cliSessionId === id) ?? null,
    sessionByLocal: (local: string) => all.find((r) => r.localId === local) ?? null,
    childrenOf: (local: string) => all.filter((r) => r.parentLocalId === local),
  } as unknown as DesktopIndex;
}
const asked = (reason: string) => ({ states: { waitingWhenAbandoned: { since: iso(400), reason } } });

describe('mural ao vivo: a que espera por mim fica e as Paradas (#333)', () => {
  test('abandoned while waiting on a blocking request stays on the wall, with the age of the request', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'asks', cwd: '/x/asks', status: 'abandoned', endedAt: iso(300), updatedAt: iso(400), metadata: asked('notification') }));
    const mural = await muralDe(storage).montar();
    assert.deepEqual(mural.cards.map((c) => c.id), ['asks']);
    assert.equal(mural.cards[0]!.attention?.level, 'blocked');
    assert.equal(mural.cards[0]!.since, iso(400), 'há 400 min, not the 180');
    assert.equal(mural.parked.total, 0);
    await storage.close();
  });

  test('Esc, a new session at the prompt and a plain end asked nothing: they go to Paradas, not to the cards', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'esc', status: 'abandoned', updatedAt: iso(400), metadata: asked('interrupted') }));
    await storage.putSession(session({ id: 'prompt', status: 'abandoned', updatedAt: iso(500), metadata: asked('session_start') }));
    await storage.putSession(session({ id: 'plain', status: 'abandoned', updatedAt: iso(600), metadata: {} }));
    await storage.putSession(session({ id: 'done', status: 'completed', endedAt: iso(700), updatedAt: iso(700) }));
    const mural = await muralDe(storage).montar();
    assert.deepEqual(mural.cards, []);
    assert.equal(mural.parked.total, 4);
    assert.deepEqual(mural.parked.items.map((c) => c.id), ['esc', 'prompt', 'plain', 'done'], 'the most recent first');
    await storage.close();
  });

  test('the archived are in neither the cards nor Paradas, and what is older than the window is history', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'archived-asks', status: 'abandoned', updatedAt: iso(400), metadata: asked('notification') }));
    await storage.putSession(session({ id: 'archived-idle', status: 'completed', endedAt: iso(400), updatedAt: iso(400) }));
    await storage.putSession(session({ id: 'ancient', status: 'completed', endedAt: iso(60 * 24 * 40), updatedAt: iso(60 * 24 * 40) }));
    const desktop = desktopOf([{ cliSessionId: 'archived-asks', archived: true } as DesktopSession, { cliSessionId: 'archived-idle', archived: true } as DesktopSession]);
    const mural = await muralDe(storage, desktop).montar();
    assert.deepEqual(mural.cards, []);
    assert.equal(mural.parked.total, 0);
    await storage.close();
  });

  test('Paradas: the total counts them all, `parkedLimit` picks the rows (7 by default, at most 100)', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    for (let i = 0; i < 12; i++) await storage.putSession(session({ id: `p${i}`, status: 'completed', endedAt: iso(300 + i), updatedAt: iso(300 + i) }));
    const mural = muralDe(storage);
    const padrao = await mural.montar();
    assert.equal(padrao.parked.total, 12);
    assert.equal(padrao.parked.items.length, 7);
    assert.equal((await mural.montar({ parkedLimit: 12 })).parked.items.length, 12);
    assert.equal((await mural.montar({ parkedLimit: 0 })).parked.items.length, 7, 'a bad limit falls back to the default');
    assert.equal(padrao.count.all, 0, 'the band is not in the count of the cards');
    await storage.close();
  });

  test('a leader carries its children, every level, and the child that needs you is a card too', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'pm', status: 'active', updatedAt: iso(1) }));
    await storage.putSession(session({ id: 'tl', status: 'active', updatedAt: iso(2), awaitingInputSince: iso(2), awaitingReason: 'stop' }));
    await storage.putSession(session({ id: 'pending', status: 'abandoned', updatedAt: iso(400), metadata: asked('notification') }));
    await storage.putSession(session({ id: 'working', status: 'active', updatedAt: iso(1) }));
    await storage.putSession(session({ id: 'stale', status: 'completed', endedAt: iso(500), updatedAt: iso(500) }));
    await storage.putSession(session({ id: 'grand', status: 'active', updatedAt: iso(1) }));
    const desktop = desktopOf([
      { cliSessionId: 'pm' } as DesktopSession,
      { cliSessionId: 'tl', parentLocalId: 'local_pm' } as DesktopSession,
      { cliSessionId: 'pending', parentLocalId: 'local_tl' } as DesktopSession,
      { cliSessionId: 'working', parentLocalId: 'local_tl' } as DesktopSession,
      { cliSessionId: 'stale', parentLocalId: 'local_tl' } as DesktopSession,
      { cliSessionId: 'grand', parentLocalId: 'local_working' } as DesktopSession,
    ]);
    const mural = await muralDe(storage, desktop).montar();
    assert.deepEqual(mural.cards.map((c) => c.id), ['pending', 'pm'], 'the child that needs you first; the idle and the active ones nest');
    const pm = mural.cards.find((c) => c.id === 'pm')!;
    assert.equal(pm.parentId, null);
    assert.deepEqual(pm.children.map((c) => c.id), ['tl']);
    assert.deepEqual(pm.children[0]!.children.map((c) => c.id), ['pending', 'working', 'stale']);
    assert.deepEqual(pm.children[0]!.children[1]!.children.map((c) => c.id), ['grand']);
    assert.deepEqual(pm.tree, { total: 5, blocked: 1, active: 2, parked: 1 }, 'all levels: tl is idle, pending needs you, working and grand are active, stale is parked');
    const pending = mural.cards.find((c) => c.id === 'pending')!;
    assert.equal(pending.parentId, 'pm', 'its leader is the nearest card above it');
    assert.equal(pending.tree, null);
    assert.equal(mural.parked.total, 0, 'a parked child counts in its leader, not in Paradas');
    await storage.close();
  });

  test('mother archived: the live child is a card of its own; nobody shows up twice', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'mother', status: 'active', updatedAt: iso(1) }));
    await storage.putSession(session({ id: 'daughter', status: 'active', updatedAt: iso(1) }));
    await storage.putSession(session({ id: 'orphan-stale', status: 'completed', endedAt: iso(500), updatedAt: iso(500) }));
    const desktop = desktopOf([
      { cliSessionId: 'mother', archived: true } as DesktopSession,
      { cliSessionId: 'daughter', parentLocalId: 'local_mother' } as DesktopSession,
      { cliSessionId: 'orphan-stale', parentLocalId: 'local_mother' } as DesktopSession,
    ]);
    const mural = await muralDe(storage, desktop).montar();
    assert.deepEqual(mural.cards.map((c) => [c.id, c.parentId, c.children]), [['daughter', null, []]]);
    assert.deepEqual(mural.parked.items.map((c) => c.id), ['orphan-stale'], 'a parked child of an archived mother is plain Paradas');
    await storage.close();
  });

  test('a cycle in the Desktop index does not loop', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'a', status: 'active', updatedAt: iso(1) }));
    await storage.putSession(session({ id: 'b', status: 'active', updatedAt: iso(1) }));
    const desktop = desktopOf([{ cliSessionId: 'a', parentLocalId: 'local_b' } as DesktopSession, { cliSessionId: 'b', parentLocalId: 'local_a' } as DesktopSession]);
    const mural = await muralDe(storage, desktop).montar();
    assert.equal(mural.cards.length, 1, 'one of them leads and the other nests: nobody vanishes');
    assert.equal(mural.cards[0]!.tree?.total, 1);
    await storage.close();
  });

  test('GET /api/wall?parkedLimit=… pela API local', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    for (let i = 0; i < 9; i++) await storage.putSession(session({ id: `p${i}`, status: 'completed', endedAt: iso(300 + i), updatedAt: iso(300 + i) }));
    const api = await startLocalApi({ panelBuilder: painelDe(storage), hooks: { storage }, port: 0, log: () => {} });
    try {
      const mural = (await (await fetch(`${api.url}/api/wall`)).json()) as Wall;
      assert.deepEqual([mural.parked.total, mural.parked.items.length], [9, 7]);
      const todas = (await (await fetch(`${api.url}/api/wall?parkedLimit=50`)).json()) as Wall;
      assert.equal(todas.parked.items.length, 9);
    } finally {
      await api.close();
      await storage.close();
    }
  });
});
