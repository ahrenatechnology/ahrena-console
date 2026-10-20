// Issue #173, phase 1: the API answers in English, and every old Portuguese route and query parameter
// answers as an alias of the new one, with the same status and the same body. The published mod
// (v0.0.30) calls `/api/painel/<id>` and `/abrir/<id>`; the installed app calls `/api/atencao` and
// `/api/mudancas`. The server is the --demo one (scenario p4), assembled here with synthetic data.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Contas,
  FeedDeEventos,
  LeiturasDoDetalhe,
  ListaDeSessoes,
  MontadorDoPainel,
  QuadroKanban,
  TrabalhoPorBranch,
  iniciarApiLocal,
  normalizeLegacyPath,
  normalizeLegacyQuery,
  normalizeLegacyUrl,
  type ApiLocal,
} from '../../src/api/index.ts';
import { RotaAnalytics } from '../../src/api/rota-analytics.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { GithubProject } from '../../src/github/project.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { HistoricoDeSessoes } from '../../src/historico/leitura.ts';
import { criarServidorMcp } from '../../src/mcp/index.ts';
import { CursorDeMudancas } from '../../src/mudancas/cursor.ts';
import { comMudancas, ContasDasSessoes, decisoesComMudancas } from '../../src/mudancas/fontes.ts';
import { localDaDemo, semearDetalhe } from '../../src/simulador/detalhe.ts';
import { semearHistoricoDoPainel } from '../../src/simulador/historico-encerradas.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, semearDecisoesDoPainel } from '../../src/simulador/painel.ts';
import { PROJECT_DO_SIMULADOR, ProjetoDoSimulador } from '../../src/simulador/projeto.ts';
import { semearWorkflowsDoDemo } from '../../src/simulador/workflows.ts';

const AGORA = Date.parse('2026-10-20T15:00:00Z');
const LOCAL = 'local_0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

describe('#173 phase 1: English routes, Portuguese aliases', () => {
  let sqlite: SqliteStorage;
  let api: ApiLocal;
  let host: string;
  let decisionId: string;
  const opened: string[] = [];

  before(async () => {
    const mudancas = new CursorDeMudancas();
    sqlite = openSqliteStorage({ path: ':memory:' });
    const contasDasSessoes = new ContasDasSessoes(sqlite);
    const storage = comMudancas(sqlite, mudancas, contasDasSessoes);
    const decisoes = decisoesComMudancas(new SqliteDecisionStore(sqlite.db), mudancas, contasDasSessoes);
    const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho, decisoes, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    // The decisions of the p9 scenario (p4 has none): a suggested one to confirm and undo.
    await semearDecisoesDoPainel(decisoes, 'p9', AGORA);
    await semearWorkflowsDoDemo(storage, AGORA);
    await semearDetalhe(storage, AGORA);
    await semearHistoricoDoPainel(storage, decisoes, 'p4', AGORA);
    const mcp = criarServidorMcp({ storage, contas, desktop: null, log: () => {} });
    const kanban = new GithubProject({ source: new ProjetoDoSimulador(), cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }), project: PROJECT_DO_SIMULADOR });
    api = await iniciarApiLocal({
      montador,
      hooks: { storage },
      port: 0,
      log: () => {},
      abrirNoDesktop: async (url) => void opened.push(url),
      mudancas,
      projeto: { kanban, fonte: 'demo', log: () => {} },
      detalhe: new LeiturasDoDetalhe({ storage, montador, agora: () => AGORA, local: localDaDemo }),
      eventos: new FeedDeEventos({ storage }),
      frota: mcp.frota,
      analytics: new RotaAnalytics({ storage, contas, agora: () => AGORA }),
      sessoes: new ListaDeSessoes({ storage, contas, agora: () => AGORA }),
      historico: new HistoricoDeSessoes({ storage, decisoes, fusoHorario: 'UTC' }),
      kanban: new QuadroKanban({ storage, contas, agora: () => AGORA }),
    });
    host = new URL(api.url).host;
    const lista = (await (await fetch(`${api.url}/api/decisions/${SESSAO_DO_PAINEL}?scope=family`)).json()) as { itens: { id: string; estado: string }[] };
    decisionId = lista.itens.find((d) => d.estado === 'a_confirmar')!.id;
  });
  after(async () => {
    await api.close();
    sqlite.close();
  });

  /** `geradoEm` is the clock of the request, not part of the answer being compared. */
  const withoutClock = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(withoutClock) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'geradoEm').map(([k, x]) => [k, withoutClock(x)])) : v;

  /** Status, redirect and body (JSON parsed) of a request. */
  async function call(path: string, init: RequestInit = {}) {
    const r = await fetch(`${api.url}${path}`, { redirect: 'manual', ...init });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, location: r.headers.get('location'), body: withoutClock(body) };
  }

  /** The new and the old path answer the same: status, redirect and body. */
  async function same(next: string, old: string, init: RequestInit = {}) {
    // A first read warms the caches (the GitHub of a branch answers from the second read on).
    if (!init.method || init.method === 'GET') await call(next, init);
    const a = await call(next, init);
    const b = await call(old, init);
    assert.deepEqual(b, a, `${old} ≠ ${next}`);
    return a;
  }

  test('the alias map: old path and parameters become the new ones; the rest is left alone', () => {
    const pairs: [string, string][] = [
      ['/api/atencao', '/api/attention'],
      ['/api/mudancas', '/api/changes'],
      ['/api/painel/abc', '/api/panel/abc'],
      ['/api/sessao/a%20b', '/api/panel/a%20b'],
      ['/abrir/local_x', '/open/local_x'],
      ['/api/mural', '/api/wall'],
      ['/api/eventos', '/api/events'],
      ['/api/carga', '/api/load'],
      ['/api/sessoes', '/api/sessions'],
      ['/api/sessoes/s1', '/api/sessions/s1'],
      ['/api/sessoes/s1/agentes', '/api/sessions/s1/agents'],
      ['/api/sessoes/s1/conversa', '/api/sessions/s1/conversation'],
      ['/api/sessoes/s1/eventos', '/api/sessions/s1/events'],
      ['/api/sessoes/s1/workflow', '/api/sessions/s1/workflow'],
      ['/api/historico', '/api/history'],
      ['/api/decisoes/s1', '/api/decisions/s1'],
      ['/api/decisoes/d1/confirmar', '/api/decisions/d1/confirm'],
      ['/api/decisoes/d1/descartar', '/api/decisions/d1/dismiss'],
      ['/api/decisoes/d1/ajustar', '/api/decisions/d1/adjust'],
      ['/api/decisoes/d1/desfazer', '/api/decisions/d1/undo'],
      ['/api/projeto', '/api/project'],
      ['/api/projeto/mover', '/api/project/move'],
      ['/api/analytics/custo', '/api/analytics/cost'],
    ];
    for (const [old, next] of pairs) {
      assert.equal(normalizeLegacyPath(old), next, old);
      assert.equal(normalizeLegacyPath(next), next, `${next} stays`);
    }
    for (const p of ['/api/overview', '/api/dashboard', '/api/analytics', '/api/workflows', '/api/kanban', '/api/hooks', '/mcp', '/ui/sessoes', '/api/sessoes/a/b/c', '/abrir'])
      assert.equal(normalizeLegacyPath(p), p, p);

    const q = normalizeLegacyQuery(new URLSearchParams('desde=c1&espera=0&conta=a&conta=b&escopo=familia&visao=agents&busca=x&since=c2'));
    assert.deepEqual([...q], [['wait', '0'], ['account', 'a'], ['account', 'b'], ['scope', 'familia'], ['view', 'agentes'], ['search', 'x'], ['since', 'c2']], 'the new one wins; English values map to the ones the handlers read');
    assert.equal(normalizeLegacyUrl(new URL('http://x/api/hooks?tipo=1')).search, '?tipo=1', 'the hooks are not touched');
    assert.equal(normalizeLegacyUrl(new URL('http://x/ui/kanban?visao=agentes')).search, '?visao=agentes', 'the /ui URLs are phase 2');
  });

  test('GET routes: the new path answers like the old one, with new and old parameters', async () => {
    const s = SESSAO_DO_PAINEL;
    const pairs: [string, string][] = [
      ['/api/attention', '/api/atencao'],
      ['/api/changes?wait=0', '/api/mudancas?espera=0'],
      ['/api/changes?since=&wait=0', '/api/mudancas?desde=&espera=0'],
      ['/api/changes?since=nada&wait=0&type=sessao', '/api/mudancas?desde=nada&espera=0&tipo=sessao'],
      ['/api/changes?wait=x', '/api/mudancas?espera=x'],
      [`/api/panel/${s}`, `/api/painel/${s}`],
      [`/api/panel/${s}`, `/api/sessao/${s}`],
      [`/api/panel/${s}?account=c1&model=claude-opus-5-5&decisions=family`, `/api/painel/${s}?conta=c1&modelo=claude-opus-5-5&decisoes=familia`],
      [`/api/panel/${s}?decisions=session`, `/api/sessao/${s}?decisoes=sessao`],
      ['/api/wall', '/api/mural'],
      ['/api/events', '/api/eventos'],
      ['/api/events?limit=5&type=PreToolUse', '/api/eventos?limite=5&tipo=PreToolUse'],
      [`/api/events?session=${s}&search=a&from=2026-01-01&to=2026-12-31`, `/api/eventos?sessao=${s}&busca=a&de=2026-01-01&ate=2026-12-31`],
      ['/api/events?limit=0', '/api/eventos?limite=0'],
      ['/api/sessions', '/api/sessoes'],
      ['/api/sessions?status=esperando&order=custo&direction=asc&page=1&search=a', '/api/sessoes?status=esperando&ordem=custo&sentido=asc&pagina=1&busca=a'],
      ['/api/sessions?order=nada', '/api/sessoes?ordem=nada'],
      [`/api/sessions/${s}`, `/api/sessoes/${s}`],
      [`/api/sessions/${s}/agents`, `/api/sessoes/${s}/agentes`],
      [`/api/sessions/${s}/conversation?limit=2`, `/api/sessoes/${s}/conversa?limite=2`],
      [`/api/sessions/${s}/conversation?agent=qualquer`, `/api/sessoes/${s}/conversa?agente=qualquer`],
      [`/api/sessions/${s}/events?limit=3&type=PreToolUse`, `/api/sessoes/${s}/eventos?limite=3&tipo=PreToolUse`],
      [`/api/sessions/${s}/workflow`, `/api/sessoes/${s}/workflow`],
      ['/api/sessions/nao-existe', '/api/sessoes/nao-existe'],
      ['/api/history', '/api/historico'],
      ['/api/history?days=3&search=a', '/api/historico?dias=3&busca=a'],
      ['/api/history?before=2026-10-19&days=2', '/api/historico?antes=2026-10-19&dias=2'],
      ['/api/history?days=99', '/api/historico?dias=99'],
      [`/api/decisions/${s}`, `/api/decisoes/${s}`],
      [`/api/decisions/${s}?scope=session`, `/api/decisoes/${s}?escopo=sessao`],
      [`/api/decisions/${s}?scope=family`, `/api/decisoes/${s}?escopo=familia`],
      [`/api/decisions/${s}?scope=branch`, `/api/decisoes/${s}?escopo=branch`],
      [`/api/decisions/${s}?scope=nada`, `/api/decisoes/${s}?escopo=nada`],
      ['/api/project', '/api/projeto'],
      ['/api/project?refresh=1', '/api/projeto?forcar=1'],
      ['/api/analytics?tz=America/Sao_Paulo', '/api/analytics?fuso=America/Sao_Paulo'],
      ['/api/analytics/cost', '/api/analytics/custo'],
      ['/api/analytics/cost?days=7&tz=UTC', '/api/analytics/custo?dias=7&fuso=UTC'],
      ['/api/analytics/cost?days=8', '/api/analytics/custo?dias=8'],
      ['/api/kanban?view=sessions', '/api/kanban?visao=sessoes'],
      ['/api/kanban?view=agents&column=trabalhando&page=1', '/api/kanban?visao=agentes&coluna=trabalhando&pagina=1'],
      ['/api/kanban?view=quadro', '/api/kanban?visao=quadro'],
      ['/api/workflows?filter=ativas', '/api/workflows?filtro=ativas'],
      ['/api/workflows?filter=todas&node=principal', '/api/workflows?filtro=todas&no=principal'],
    ];
    for (const [next, old] of pairs) {
      const r = await same(next, old);
      // The route exists: a 404 here is the handler's own ("sessão não encontrada"), never the router's.
      assert.notDeepEqual(r.body, { error: 'não encontrado' }, `${next} exists`);
    }
    // English values on the new parameters, and a mix of old and new names, read the same.
    await same(`/api/decisions/${s}?scope=family`, `/api/decisions/${s}?escopo=family`);
    await same('/api/kanban?view=agents', '/api/kanban?visao=agentes');
  });

  test('GET /api/load answers like /api/carga (the counters move with each request)', async () => {
    const a = await call('/api/load');
    const b = await call('/api/carga');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(Object.keys(b.body as object).sort(), Object.keys(a.body as object).sort());
  });

  test('GET /open/<local_…> redirects like /abrir/<local_…>', async () => {
    const r = await same(`/open/${LOCAL}`, `/abrir/${LOCAL}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, `claude://claude.ai/epitaxy/${LOCAL}`);
    await same('/open/local_x', '/abrir/local_x');
  });

  test('POST /open/<local_…>: the same Origin rules as /abrir (decision 0003)', async () => {
    const json = { 'content-type': 'application/json' };
    const self = { ...json, origin: `http://${host}` };
    const post = (path: string, headers: Record<string, string>) => call(path, { method: 'POST', headers, body: '{}' });
    for (const path of [`/open/${LOCAL}`, `/abrir/${LOCAL}`]) {
      assert.deepEqual(await post(path, json), { status: 200, location: null, body: { ok: true } }, path);
      assert.equal((await post(path, self)).status, 200, `${path}: the page's own Origin`);
      for (const origin of ['https://exemplo.com', 'http://localhost:1', 'null']) assert.equal((await post(path, { ...json, origin })).status, 403, `${path} ${origin}`);
      assert.equal((await post(path, { 'content-type': 'text/plain', origin: `http://${host}` })).status, 415, path);
      assert.equal((await post(`${path}?x=1`, self)).status, 403, `${path}?x=1`);
    }
    for (const path of ['/open/local_curto', '/abrir/local_curto']) assert.equal((await post(path, self)).status, 403, path);
    assert.deepEqual(await post('/open/local_curto', json), await post('/abrir/local_curto', json));
    assert.equal(opened.length, 4);
    assert.ok(opened.every((u) => u === `claude://claude.ai/epitaxy/${LOCAL}`));
  });

  test('POST on the decisions: new actions answer like the old ones; Origin is still refused', async () => {
    const json = { 'content-type': 'application/json' };
    const post = (path: string, body: unknown, headers: Record<string, string> = json) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const [next, old] of [['confirm', 'confirmar'], ['dismiss', 'descartar'], ['adjust', 'ajustar'], ['undo', 'desfazer']]) {
      for (const [n, o] of [[`/api/decisions/nao-existe/${next}`, `/api/decisoes/nao-existe/${old}`]]) {
        assert.deepEqual(await post(n, { sessao: SESSAO_DO_PAINEL }), await post(o, { sessao: SESSAO_DO_PAINEL }), n);
        assert.deepEqual(await post(n, {}), await post(o, {}), `${n} without the session`);
        assert.equal((await post(n, { sessao: SESSAO_DO_PAINEL }, { ...json, origin: `http://${host}` })).status, 403, n);
        assert.equal((await post(o, { sessao: SESSAO_DO_PAINEL }, { ...json, origin: `http://${host}` })).status, 403, o);
        assert.equal((await call(n)).status, 405, `${n}: GET`);
      }
    }
    // A real one: confirm on the new route, undo on the old one.
    const confirmed = await post(`/api/decisions/${encodeURIComponent(decisionId)}/confirm`, { sessao: SESSAO_DO_PAINEL });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const undone = await post(`/api/decisoes/${encodeURIComponent(decisionId)}/desfazer`, { sessao: SESSAO_DO_PAINEL });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
  });

  test('POST /api/project/move answers like /api/projeto/mover, with the page Origin too', async () => {
    const json = { 'content-type': 'application/json' };
    const body = JSON.stringify({ itemId: 'nada', optionId: 'x' });
    for (const headers of [json, { ...json, origin: `http://${host}` }]) {
      const r = await same('/api/project/move', '/api/projeto/mover', { method: 'POST', headers, body });
      assert.equal(r.status, 400);
    }
    const foreign = { ...json, origin: 'https://exemplo.com' };
    assert.equal((await call('/api/project/move', { method: 'POST', headers: foreign, body })).status, 403);
    assert.equal((await call('/api/projeto/mover', { method: 'POST', headers: foreign, body })).status, 403);
  });

  test('routes that did not change, and unknown ones, are not touched', async () => {
    for (const path of ['/api/overview', '/api/dashboard', '/api/analytics', '/api/workflows', '/api/kanban']) assert.equal((await call(path)).status, 200, path);
    await same('/api/nada', '/api/nada-mesmo');
    assert.equal((await call('/api/sessions/a/b/c')).status, 404);
    assert.equal((await call('/open')).status, 404);
  });
});
