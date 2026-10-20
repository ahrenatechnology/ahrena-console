// Issue #173, phase 1: the API answers in English, and every old Portuguese route and query parameter
// answers as an alias of the new one, with the same status and the same body. The published mod
// (v0.0.30) calls `/api/painel/<id>` and `/abrir/<id>`; the installed app calls `/api/atencao` and
// `/api/mudancas`. The server is the --demo one (scenario p4), assembled in `legacy-demo.ts`.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LEGACY_BODIES, legacyResponseFor, normalizeLegacyPath, normalizeLegacyQuery, normalizeLegacyUrl, type ApiLocal, type LegacyRouteSpec } from '../../src/api/index.ts';
import { DEMO_SESSION, LOCAL, startLegacyDemo, type LegacyDemo } from './legacy-demo.ts';

describe('#173 phase 1: English routes, Portuguese aliases', () => {
  let demo: LegacyDemo;
  let api: ApiLocal;
  let host: string;
  let decisionId: string;
  let opened: string[];

  before(async () => {
    demo = await startLegacyDemo();
    ({ api, host, opened } = demo);
    const lista = (await (await fetch(`${api.url}/api/decisions/${DEMO_SESSION}?scope=family`)).json()) as { items: { id: string; state: string }[] };
    decisionId = lista.items.find((d) => d.state === 'to_confirm')!.id;
  });
  after(async () => {
    await demo.close();
  });

  /** Status, redirect and body (JSON parsed) of a request. */
  async function call(path: string, init: RequestInit = {}) {
    const r = await fetch(`${api.url}${path}`, { redirect: 'manual', ...init });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, location: r.headers.get('location'), body };
  }

  /**
   * The answer of a new path as the old path gives it: since phase 2b the old route back-translates
   * the body (src/api/legacy-routes.ts), so the new body goes through the same translator.
   */
  function asOld(old: string, r: Awaited<ReturnType<typeof call>>) {
    const toOld = legacyResponseFor(new URL(old, 'http://127.0.0.1').pathname);
    return toOld && typeof r.body !== 'string' ? { ...r, body: toOld(r.body) } : r;
  }

  /** The new and the old path answer the same: status, redirect and body (the old one in its old keys). */
  async function same(next: string, old: string, init: RequestInit = {}) {
    // A first read warms the caches (the GitHub of a branch answers from the second read on).
    if (!init.method || init.method === 'GET') await call(next, init);
    const a = await call(next, init);
    const b = await call(old, init);
    assert.deepEqual(b, asOld(old, a), `${old} ≠ ${next}`);
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
    assert.deepEqual([...q], [['wait', '0'], ['account', 'a'], ['account', 'b'], ['scope', 'family'], ['view', 'agents'], ['search', 'x'], ['since', 'c2']], 'the new one wins; values map to the ones the handlers read (English since phase 2b)');
    assert.equal(normalizeLegacyUrl(new URL('http://x/api/hooks?tipo=1')).search, '?tipo=1', 'the hooks are not touched');
    assert.equal(normalizeLegacyUrl(new URL('http://x/ui/kanban?visao=agentes')).search, '?visao=agentes', 'the /ui URLs are phase 2');
  });

  test('GET routes: the new path answers like the old one, with new and old parameters', async () => {
    const s = DEMO_SESSION;
    const pairs: [string, string][] = [
      ['/api/attention', '/api/atencao'],
      ['/api/changes?wait=0', '/api/mudancas?espera=0'],
      ['/api/changes?since=&wait=0', '/api/mudancas?desde=&espera=0'],
      ['/api/changes?since=nada&wait=0&type=sessao', '/api/mudancas?desde=nada&espera=0&tipo=sessao'],
      ['/api/changes?since=nada&wait=0&type=session,decision', '/api/mudancas?desde=nada&espera=0&tipo=sessao,decisao'],
      ['/api/changes?wait=0&type=nada', '/api/mudancas?espera=0&tipo=nada'],
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
      ['/api/decisions', '/api/decisoes'],
      ['/api/decisions?groupBy=family&state=a_confirmar&q=kanban', '/api/decisoes?agrupar=familia&estado=a_confirmar&q=kanban'],
      ['/api/decisions?groupBy=family&state=to_confirm&q=kanban', '/api/decisoes?agrupar=familia&estado=a_confirmar&q=kanban'],
      ['/api/decisions?state=nada', '/api/decisoes?estado=nada'],
      ['/api/decisions?group=%3Cx%3E', '/api/decisoes?grupo=%3Cx%3E'],
      ['/api/decisions?groupBy=session', '/api/decisoes?agrupar=sessao'],
      ['/api/decisions?groupBy=nada', '/api/decisoes?agrupar=nada'],
      [`/api/sessions/${s}/decisions`, `/api/sessoes/${s}/decisoes`],
      [`/api/sessions/${s}/decisions?scope=branch&state=vigentes`, `/api/sessoes/${s}/decisoes?escopo=branch&estado=vigentes`],
      [`/api/sessions/${s}/decisions?scope=session&state=current`, `/api/sessoes/${s}/decisoes?escopo=sessao&estado=vigentes`],
      [`/api/sessions/${s}/decisions?state=nada`, `/api/sessoes/${s}/decisoes?estado=nada`],
      ['/api/repos', '/api/repos'],
      ['/api/repos?refresh=1', '/api/repos?atualizar=1'],
      ['/api/repos/exemplo-labs/vitrine-demo?period=30d', '/api/repos/exemplo-labs/vitrine-demo?periodo=30d'],
      ['/api/repos/exemplo-labs/vitrine-demo?period=1y', '/api/repos/exemplo-labs/vitrine-demo?periodo=1a'],
      ['/api/repos/exemplo-labs/vitrine-demo?period=2y', '/api/repos/exemplo-labs/vitrine-demo?periodo=2y'],
    ];
    for (const [next, old] of pairs) {
      const r = await same(next, old);
      // The route exists: a 404 here is the handler's own ("sessão não encontrada"), never the router's.
      assert.notDeepEqual(r.body, { error: 'não encontrado' }, `${next} exists`);
    }
    // English values on the new parameters, and a mix of old and new names, read the same.
    await same(`/api/decisions/${s}?scope=family`, `/api/decisions/${s}?escopo=family`);
    await same('/api/kanban?view=agents', '/api/kanban?visao=agentes');
    await same('/api/kanban?view=agents&column=working', '/api/kanban?visao=agentes&coluna=trabalhando');
  });

  test('the sessions `status`/`order` values are that route\'s alone: `/api/eventos?status=erro` answers its old 400', async () => {
    const events = await call('/api/eventos?status=erro');
    assert.deepEqual(events, { status: 400, location: null, body: { error: 'status: um de active, waiting, error, completed' } });
    assert.equal(normalizeLegacyUrl(new URL(`http://x/api/sessoes/${DEMO_SESSION}/eventos?status=erro`)).search, '?status=erro', 'the session events too');
    assert.equal(normalizeLegacyUrl(new URL('http://x/api/eventos?status=erro&ordem=custo')).search, '?status=erro&order=custo');
    // The sessions list keeps both value sets, on the old path and on the new one.
    const old = await call('/api/sessoes?status=esperando&ordem=custo');
    assert.equal(old.status, 200);
    assert.deepEqual(old, await call('/api/sessoes?status=waiting&order=cost'));
    assert.deepEqual(asOld('/api/sessoes', await call('/api/sessions?status=esperando&order=custo')), old);
    assert.equal(normalizeLegacyUrl(new URL('http://x/api/sessoes?status=esperando&ordem=custo')).search, '?status=waiting&order=cost');
  });

  test('GET /api/load answers like /api/carga (the counters move with each request)', async () => {
    const a = await call('/api/load');
    const b = await call('/api/carga');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(Object.keys(b.body as object).sort(), Object.keys(asOld('/api/carga', a).body as object).sort());
    // The new route answers the English counters (#173 phase 2b), the old one the Portuguese ones.
    assert.deepEqual(Object.keys(a.body as object).sort(), ['eventsRead', 'openWaits', 'panel', 'panelMs', 'requests']);
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

  test('POST on the decisions: new actions answer like the old ones, with the same Origin rules', async () => {
    const json = { 'content-type': 'application/json' };
    const post = (path: string, body: unknown, headers: Record<string, string> = json) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const self = { ...json, origin: `http://${host}` };
    for (const [next, old] of [['confirm', 'confirmar'], ['dismiss', 'descartar'], ['adjust', 'ajustar'], ['undo', 'desfazer'], ['promote', 'promover']]) {
      const [n, o] = [`/api/decisions/nao-existe/${next}`, `/api/decisoes/nao-existe/${old}`];
      // The new route reads the old body `{ sessao }` too, so both get the same one; and the new body `{ session }`.
      assert.deepEqual(await post(o, { sessao: DEMO_SESSION }), asOld(o, await post(n, { sessao: DEMO_SESSION })), n);
      assert.deepEqual(await post(o, { sessao: DEMO_SESSION }), asOld(o, await post(n, { session: DEMO_SESSION })), `${n} { session }`);
      assert.deepEqual(await post(o, {}), asOld(o, await post(n, {})), `${n} without the session`);
      // The page's own Origin passes on both (#103); another site's, or a query, does not.
      assert.deepEqual(await post(o, { sessao: DEMO_SESSION }, self), asOld(o, await post(n, { sessao: DEMO_SESSION }, self)), `${n}: page Origin`);
      assert.notEqual((await post(n, { sessao: DEMO_SESSION }, self)).status, 403, n);
      for (const path of [n, o]) {
        assert.equal((await post(path, { sessao: DEMO_SESSION }, { ...json, origin: 'https://exemplo.com' })).status, 403, path);
        assert.equal((await post(`${path}?x=1`, { sessao: DEMO_SESSION }, self)).status, 403, `${path}?x=1`);
      }
      assert.equal((await call(n)).status, 405, `${n}: GET`);
    }
    // A real one: confirm on the new route, undo on the old one.
    const confirmed = await post(`/api/decisions/${encodeURIComponent(decisionId)}/confirm`, { session: DEMO_SESSION });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const undone = await post(`/api/decisoes/${encodeURIComponent(decisionId)}/desfazer`, { sessao: DEMO_SESSION });
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

  test('phase 2b wiring: an old route answers through its back-translator, errors included, and reads its body through it', async () => {
    const specs = LEGACY_BODIES as Record<string, LegacyRouteSpec>;
    const saved = { panel: specs.panel, confirm: specs['decision/confirm'], promote: specs['decision/promote'], move: specs['project/move'] };
    const json = { 'content-type': 'application/json' };
    try {
      specs.panel = { response: { keys: { error: 'erro' }, values: { error: { 'id de sessão inválido': 'id inválido' } } } };
      assert.deepEqual((await call('/api/painel/a%20b')).body, { erro: 'id inválido' });
      assert.deepEqual((await call('/api/sessao/a%20b?conta=x')).body, { erro: 'id inválido' });
      assert.deepEqual((await call('/api/panel/a%20b')).body, { error: 'id de sessão inválido' }, 'the new route is not translated');
      // The 403 of the Origin check is written after the translator is set: it goes through it too.
      assert.deepEqual((await call(`/api/painel/${DEMO_SESSION}`, { headers: { origin: 'https://exemplo.com' } })).body, { erro: 'origem não permitida' });

      // Request bodies, old → new, on the three readers: the decisions, the promote and the project move.
      specs['decision/confirm'] = { ...saved.confirm, request: { keys: { quem: 'sessao' } } };
      const confirm = (path: string) => call(path, { method: 'POST', headers: json, body: JSON.stringify({ quem: 'a b' }) });
      assert.deepEqual((await confirm('/api/decisoes/nao-existe/confirmar')).body, { error: 'informe a sessão: { "sessao": "<id>" }' }, 'the body was read as { sessao }');
      specs['decision/confirm'] = { request: { keys: { quem: 'sessao' } }, response: { keys: { error: 'erro' } } };
      assert.equal((await confirm('/api/decisoes/nao-existe/confirmar')).status, 400);
      const body = { quem: DEMO_SESSION };
      const r = await call('/api/decisoes/nao-existe/confirmar', { method: 'POST', headers: json, body: JSON.stringify(body) });
      assert.deepEqual(r, { status: 404, location: null, body: { erro: 'decisão não encontrada nesta sessão' } }, 'the old body reached the handler as { sessao }');
      specs['decision/promote'] = { request: { keys: { quem: 'sessao' } } };
      const promoted = await call('/api/decisoes/nao-existe/promover', { method: 'POST', headers: json, body: JSON.stringify(body) });
      assert.deepEqual(promoted.body, { error: 'decisão não encontrada nesta sessão' });
      specs['project/move'] = { request: { keys: { item: 'itemId', opcao: 'optionId' } } };
      const moved = await call('/api/projeto/mover', { method: 'POST', headers: json, body: JSON.stringify({ item: 'nada', opcao: 'x' }) });
      const plain = await call('/api/projeto/mover', { method: 'POST', headers: json, body: JSON.stringify({ itemId: 'nada', optionId: 'x' }) });
      assert.deepEqual(moved, plain);
    } finally {
      specs.panel = saved.panel;
      specs['decision/confirm'] = saved.confirm;
      specs['decision/promote'] = saved.promote;
      specs['project/move'] = saved.move;
    }
  });

  test('routes that did not change, and unknown ones, are not touched', async () => {
    for (const path of ['/api/overview', '/api/dashboard', '/api/analytics', '/api/workflows', '/api/kanban']) assert.equal((await call(path)).status, 200, path);
    await same('/api/nada', '/api/nada-mesmo');
    assert.equal((await call('/api/sessions/a/b/c')).status, 404);
    assert.equal((await call('/open')).status, 404);
  });
});
