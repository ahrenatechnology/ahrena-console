// Issue #173, phase 6: the old Portuguese routes, query parameters, values and request bodies were
// aliases of the English ones until the published mod (v0.0.34) and app (0.0.5) moved to English.
// Now an old route is an unknown path (404, or 405 for a write), an old parameter or value is not
// read, and an old body is refused; the Origin rules of decision 0003 hold on the English routes.
// The server is the --demo one (scenario p4), assembled in `demo-api.ts`.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { LocalApi } from '../../src/api/index.ts';
import { DEMO_SESSION, LOCAL, startDemoApi, type DemoApi } from './demo-api.ts';

describe('#173 phase 6: the Portuguese aliases are gone', () => {
  let demo: DemoApi;
  let api: LocalApi;
  let host: string;
  let decisionId: string;
  let opened: string[];

  before(async () => {
    demo = await startDemoApi();
    ({ api, host, opened } = demo);
    const list = (await (await fetch(`${api.url}/api/decisions/${DEMO_SESSION}?scope=family`)).json()) as { items: { id: string; state: string }[] };
    decisionId = list.items.find((d) => d.state === 'to_confirm')!.id;
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

  const NOT_FOUND = { status: 404, location: null, body: { error: 'não encontrado' } };

  test('GET on an old route is 404, like any unknown path; the English route answers', async () => {
    const s = DEMO_SESSION;
    const pairs: [string, string][] = [
      ['/api/atencao', '/api/attention'],
      ['/api/mudancas?espera=0', '/api/changes?wait=0'],
      [`/api/painel/${s}`, `/api/panel/${s}`],
      [`/api/sessao/${s}`, `/api/panel/${s}`],
      ['/api/mural', '/api/wall'],
      ['/api/eventos', '/api/events'],
      ['/api/carga', '/api/load'],
      ['/api/sessoes', '/api/sessions'],
      [`/api/sessoes/${s}`, `/api/sessions/${s}`],
      [`/api/sessoes/${s}/agentes`, `/api/sessions/${s}/agents`],
      [`/api/sessoes/${s}/conversa`, `/api/sessions/${s}/conversation`],
      [`/api/sessoes/${s}/eventos`, `/api/sessions/${s}/events`],
      [`/api/sessoes/${s}/workflow`, `/api/sessions/${s}/workflow`],
      [`/api/sessoes/${s}/decisoes`, `/api/sessions/${s}/decisions`],
      ['/api/historico', '/api/history'],
      [`/api/decisoes/${s}`, `/api/decisions/${s}`],
      ['/api/decisoes', '/api/decisions'],
      ['/api/projeto', '/api/project'],
      ['/api/analytics/custo', '/api/analytics/cost'],
    ];
    for (const [old, next] of pairs) {
      assert.deepEqual(await call(old), NOT_FOUND, old);
      const r = await call(next);
      assert.equal(r.status, 200, `${next}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await call(`/abrir/${LOCAL}`), NOT_FOUND, 'GET /abrir/<local_…> no longer redirects');
    const open = await call(`/open/${LOCAL}`);
    assert.equal(open.status, 302);
    assert.equal(open.location, `claude://claude.ai/epitaxy/${LOCAL}`);
  });

  test('a write on an old route reaches nothing: no session opened, no decision changed', async () => {
    const json = { 'content-type': 'application/json' };
    const self = { ...json, origin: `http://${host}` };
    const post = (path: string, body: unknown, headers: Record<string, string> = json) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const before = opened.length;
    for (const headers of [json, self]) {
      const writes: [string, unknown][] = [
        [`/abrir/${LOCAL}`, {}],
        [`/api/decisoes/${encodeURIComponent(decisionId)}/confirmar`, { sessao: DEMO_SESSION }],
        [`/api/decisoes/${encodeURIComponent(decisionId)}/descartar`, { sessao: DEMO_SESSION }],
        [`/api/decisoes/${encodeURIComponent(decisionId)}/ajustar`, { sessao: DEMO_SESSION, texto: 'x' }],
        [`/api/decisoes/${encodeURIComponent(decisionId)}/desfazer`, { sessao: DEMO_SESSION }],
        [`/api/decisoes/${encodeURIComponent(decisionId)}/promover`, { sessao: DEMO_SESSION }],
        ['/api/projeto/mover', { itemId: 'nada', optionId: 'x' }],
      ];
      for (const [path, body] of writes) {
        const r = await post(path, body, headers);
        // The page's own Origin on an unknown path is not one of the allowed writes: 403. Without Origin, 405.
        assert.ok([403, 404, 405].includes(r.status), `${path} ${headers === self ? 'page Origin' : ''}: ${r.status}`);
      }
    }
    assert.equal(opened.length, before, 'nothing was opened in the Desktop');
    const list = (await (await fetch(`${api.url}/api/decisions/${DEMO_SESSION}?scope=family`)).json()) as { items: { id: string; state: string }[] };
    assert.equal(list.items.find((d) => d.id === decisionId)?.state, 'to_confirm', 'the decision is as it was');
  });

  test('the old query parameters are not read: the English one decides', async () => {
    const s = DEMO_SESSION;
    // An invalid value under the old name is ignored (the default applies); under the new name it is a 400.
    for (const [old, next] of [
      [`/api/decisions/${s}?escopo=nada`, `/api/decisions/${s}?scope=nada`],
      ['/api/history?dias=99', '/api/history?days=99'],
      ['/api/analytics/cost?dias=8', '/api/analytics/cost?days=8'],
      ['/api/decisions?estado=nada', '/api/decisions?state=nada'],
    ]) {
      assert.equal((await call(old)).status, 200, old);
      assert.equal((await call(next)).status, 400, next);
    }
    // And the panel ignores `?decisoes=` (it brings no decision list) while `?decisions=` brings one.
    const oldPanel = (await call(`/api/panel/${s}?decisoes=family`)).body as Record<string, unknown>;
    const newPanel = (await call(`/api/panel/${s}?decisions=family`)).body as Record<string, unknown>;
    assert.notDeepEqual(oldPanel, newPanel);
  });

  test('the old fixed values are refused where the route checks them', async () => {
    const s = DEMO_SESSION;
    for (const path of [`/api/decisions/${s}?scope=familia`, '/api/decisions?state=a_confirmar', '/api/sessions?status=esperando', '/api/sessions?order=custo']) {
      assert.equal((await call(path)).status, 400, path);
    }
  });

  test('the old request bodies are refused: `{ sessao }` is not the session', async () => {
    const json = { 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: json, body: JSON.stringify(body) });
    const id = encodeURIComponent(decisionId);
    for (const action of ['confirm', 'dismiss', 'adjust', 'undo']) {
      assert.deepEqual(await post(`/api/decisions/${id}/${action}`, { sessao: DEMO_SESSION }), { status: 400, location: null, body: { error: 'informe a sessão: { "session": "<id>" }' } }, action);
    }
    assert.equal((await post(`/api/decisions/${id}/promote`, { sessao: DEMO_SESSION })).status, 400, 'promote');
    const confirmed = await post(`/api/decisions/${id}/confirm`, { session: DEMO_SESSION });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const undone = await post(`/api/decisions/${id}/undo`, { session: DEMO_SESSION });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
  });

  test('GET /api/overview: only `name` and `version`, no `nome`/`versao`', async () => {
    const r = await call('/api/overview');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.name, 'ahrena-console');
    assert.equal(typeof body.version, 'string');
    assert.ok(!('nome' in body) && !('versao' in body), JSON.stringify(body));
  });

  test('POST /open/<local_…>: the Origin rules of decision 0003 still hold', async () => {
    const json = { 'content-type': 'application/json' };
    const self = { ...json, origin: `http://${host}` };
    const post = (path: string, headers: Record<string, string>) => call(path, { method: 'POST', headers, body: '{}' });
    const before = opened.length;
    const path = `/open/${LOCAL}`;
    assert.deepEqual(await post(path, json), { status: 200, location: null, body: { ok: true } });
    assert.equal((await post(path, self)).status, 200, "the page's own Origin");
    for (const origin of ['https://exemplo.com', 'http://localhost:1', 'null']) assert.equal((await post(path, { ...json, origin })).status, 403, origin);
    assert.equal((await post(path, { 'content-type': 'text/plain', origin: `http://${host}` })).status, 415);
    assert.equal((await post(`${path}?x=1`, self)).status, 403, `${path}?x=1`);
    assert.equal((await post('/open/local_curto', self)).status, 403);
    assert.equal(opened.length, before + 2);
    assert.ok(opened.every((u) => u === `claude://claude.ai/epitaxy/${LOCAL}`));
  });

  test('POST on the decisions and the project move: the page Origin passes, another site or a query does not', async () => {
    const json = { 'content-type': 'application/json' };
    const self = { ...json, origin: `http://${host}` };
    const foreign = { ...json, origin: 'https://exemplo.com' };
    const post = (path: string, body: unknown, headers: Record<string, string>) => call(path, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const action of ['confirm', 'dismiss', 'adjust', 'undo', 'promote']) {
      const path = `/api/decisions/nao-existe/${action}`;
      assert.notEqual((await post(path, { session: DEMO_SESSION }, self)).status, 403, path);
      assert.equal((await post(path, { session: DEMO_SESSION }, foreign)).status, 403, `${path} foreign`);
      assert.equal((await post(`${path}?x=1`, { session: DEMO_SESSION }, self)).status, 403, `${path}?x=1`);
      assert.equal((await call(path)).status, 405, `${path}: GET`);
    }
    const move = { itemId: 'nada', optionId: 'x' };
    assert.equal((await post('/api/project/move', move, json)).status, 400);
    assert.equal((await post('/api/project/move', move, self)).status, 400);
    assert.equal((await post('/api/project/move', move, foreign)).status, 403);
  });
});
