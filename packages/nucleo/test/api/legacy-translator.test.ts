// Issue #173, phase 2b: the back-translator of the old routes (src/api/legacy-routes.ts). The engine
// alone, on made-up specs; the route specs themselves are proved by the goldens (legacy-golden.test.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_BODIES, legacyRequestBody, legacyResponseFor, legacyRouteOf, rawPathnameOf, translateBody, type LegacyBodySpec } from '../../src/api/legacy-routes.ts';

describe('#173 phase 2b: the back-translator', () => {
  test('global keys rename every object; scoped ones only inside their parent, and win', () => {
    const spec: LegacyBodySpec = { keys: { title: 'titulo', 'session.title': 'nome', '.count': 'total' } };
    const body = { count: 2, title: 'a', session: { title: 'b', count: 3 }, other: { title: 'c' } };
    assert.deepEqual(translateBody(spec, body), { total: 2, titulo: 'a', session: { nome: 'b', count: 3 }, other: { titulo: 'c' } });
  });

  test('the key order is kept, so the JSON is the same text but for the names', () => {
    const out = translateBody({ keys: { b: 'bb' } }, { a: 1, b: 2, c: 3 });
    assert.equal(JSON.stringify(out), '{"a":1,"bb":2,"c":3}');
  });

  test('array items have the array key as their parent', () => {
    const spec: LegacyBodySpec = { keys: { 'items.label': 'rotulo' }, values: { 'items.state': { pending: 'a_confirmar' } } };
    const body = { items: [{ label: 'D1', state: 'pending' }, { label: 'D2', state: 'other' }], label: 'x' };
    assert.deepEqual(translateBody(spec, body), { items: [{ rotulo: 'D1', state: 'a_confirmar' }, { rotulo: 'D2', state: 'other' }], label: 'x' });
  });

  test('values: by the key that holds them, scoped or global, strings and arrays of strings', () => {
    const spec: LegacyBodySpec = { values: { scope: { family: 'familia' }, 'filter.status': { waiting: 'esperando' }, kinds: { session: 'sessao' } } };
    const body = { scope: 'family', status: 'waiting', filter: { status: 'waiting' }, kinds: ['session', 'state'], n: 1, ok: true, none: null };
    assert.deepEqual(translateBody(spec, body), { scope: 'familia', status: 'waiting', filter: { status: 'esperando' }, kinds: ['sessao', 'state'], n: 1, ok: true, none: null });
  });

  test('a renamed key is matched by its "from" name for values and scopes', () => {
    const spec: LegacyBodySpec = { keys: { scope: 'escopo', label: 'rotulo' }, values: { scope: { session: 'sessao' } } };
    assert.deepEqual(translateBody(spec, { scope: 'session', scopeBox: { label: 'x' } }), { escopo: 'sessao', scopeBox: { rotulo: 'x' } });
  });

  test('opaque: the subtree is copied untouched, the key itself still renamed', () => {
    const spec: LegacyBodySpec = { keys: { input: 'entrada', title: 'titulo' }, opaque: ['input', 'event.payload'] };
    const body = { input: { title: 'kept', scope: 'family' }, event: { payload: { title: 'kept' }, title: 'renamed' }, payload: { title: 'renamed' } };
    assert.deepEqual(translateBody(spec, body), {
      entrada: { title: 'kept', scope: 'family' },
      event: { payload: { title: 'kept' }, titulo: 'renamed' },
      payload: { titulo: 'renamed' },
    });
  });

  test('dictKeys: the keys of the dict are data, translated as values; its children have the dict as parent', () => {
    const spec: LegacyBodySpec = {
      keys: { byScope: 'porEscopo', total: 'soma', 'byScope.label': 'rotulo' },
      values: { byScope: { session: 'sessao', family: 'familia' }, 'byScope.*': { open: 'aberta' } },
      dictKeys: ['byScope'],
    };
    const body = { byScope: { session: 4, family: { total: 5, label: 'f' }, branch: 'open', total: 1 } };
    // `total` inside the dict is a data key (no value entry): left as it is, never renamed by `keys`.
    assert.deepEqual(translateBody(spec, body), { porEscopo: { sessao: 4, familia: { soma: 5, rotulo: 'f' }, branch: 'aberta', total: 1 } });
  });

  test('the names of the prototype are data like any other', () => {
    const spec: LegacyBodySpec = { keys: { a: 'b' }, values: { a: { x: 'y' } } };
    assert.deepEqual(translateBody(spec, { constructor: 'toString', toString: { hasOwnProperty: 1 }, a: 'constructor' }), { constructor: 'toString', toString: { hasOwnProperty: 1 }, b: 'constructor' });
  });

  test('an empty spec is the identity: the very same body', () => {
    const body = { a: [1, { b: 'c' }] };
    assert.equal(translateBody({}, body), body);
    assert.equal(translateBody(undefined, body), body);
    assert.equal(translateBody({ keys: {}, values: {}, dictKeys: [], opaque: [] }, body), body);
    const date = new Date(0);
    assert.equal(translateBody({ keys: { a: 'b' } }, date), date, 'anything but plain objects and arrays is left for JSON.stringify');
  });

  test('the old route of a raw path; the new paths and the others have none', () => {
    const routes: [string, string][] = [
      ['/api/atencao', 'attention'],
      ['/api/mudancas', 'changes'],
      ['/api/painel/abc', 'panel'],
      ['/api/sessao/abc', 'panel'],
      ['/abrir/local_x', 'open'],
      ['/api/mural', 'wall'],
      ['/api/eventos', 'events'],
      ['/api/carga', 'load'],
      ['/api/sessoes', 'sessions'],
      ['/api/sessoes/s1', 'session'],
      ['/api/sessoes/s1/agentes', 'session/agents'],
      ['/api/sessoes/s1/conversa', 'session/conversation'],
      ['/api/sessoes/s1/eventos', 'session/events'],
      ['/api/sessoes/s1/workflow', 'session/workflow'],
      ['/api/sessoes/s1/decisoes', 'session/decisions'],
      ['/api/historico', 'history'],
      ['/api/decisoes/s1', 'decisions/scope'],
      ['/api/decisoes', 'decisions'],
      ['/api/decisoes/d1/confirmar', 'decision/confirm'],
      ['/api/decisoes/d1/descartar', 'decision/dismiss'],
      ['/api/decisoes/d1/ajustar', 'decision/adjust'],
      ['/api/decisoes/d1/desfazer', 'decision/undo'],
      ['/api/decisoes/d1/promover', 'decision/promote'],
      ['/api/projeto', 'project'],
      ['/api/projeto/mover', 'project/move'],
      ['/api/analytics/custo', 'analytics/cost'],
    ];
    for (const [path, route] of routes) {
      assert.equal(legacyRouteOf(path), route, path);
      assert.ok(Object.hasOwn(LEGACY_BODIES, route), `${route} has a spec`);
      assert.equal(typeof legacyResponseFor(path), 'function', path);
    }
    assert.equal(Object.keys(LEGACY_BODIES).length, new Set(routes.map(([, r]) => r)).size, 'one spec per old route');
    for (const p of ['/api/panel/abc', '/api/attention', '/api/changes', '/open/local_x', '/api/decisions/d1/confirm', '/api/overview', '/api/kanban', '/api/repos', '/api/hooks', '/ui/sessoes', '/api/sessoes/a/b/c'])
      assert.equal(legacyResponseFor(p), null, p);
    assert.equal(rawPathnameOf('/api/painel/abc?conta=x'), '/api/painel/abc');
    assert.equal(rawPathnameOf(undefined), '/');
  });

  test('a route whose spec is still empty gives its body back as it is', () => {
    const body = { sessao: 's', texto: 't', itens: [{ estado: 'a_confirmar' }] };
    for (const path of ['/api/atencao', '/api/projeto/mover']) {
      assert.equal(legacyResponseFor(path)!(body), body, path);
      assert.equal(legacyRequestBody(path, body), body, path);
    }
  });

  test('phase 2b layer 2: a decision write reads `{ sessao, texto }` and answers `{ decisao }` on the old route', () => {
    assert.deepEqual(legacyRequestBody('/api/decisoes/d/ajustar', { sessao: 's', texto: 't' }), { session: 's', text: 't' });
    const decision = { id: 'd', label: 'D1', origin: 'suggested', state: 'to_confirm', undo: 'adjust', decidedBy: 'agent', session: 'parent' };
    assert.deepEqual(legacyResponseFor('/api/decisoes/d/confirmar')!({ decision }), {
      decisao: { id: 'd', rotulo: 'D1', origem: 'sugerida', estado: 'a_confirmar', desfazer: 'ajustar', decididaPor: 'agente', sessao: 'mae' },
    });
    assert.deepEqual(legacyResponseFor('/api/decisoes/d/confirmar')!({ error: 'informe a sessão: { "session": "<id>" }' }), { error: 'informe a sessão: { "sessao": "<id>" }' });
    // The scope: as a value, as the keys of the counts, and in the error that names the parameter.
    assert.deepEqual(legacyResponseFor('/api/decisoes/s')!({ scope: 'family', current: 1, toConfirm: 0, items: [], byScope: { session: 1, family: 2, branch: 3 } }), {
      escopo: 'familia', vigentes: 1, aConfirmar: 0, itens: [], porEscopo: { sessao: 1, familia: 2, branch: 3 },
    });
    assert.deepEqual(legacyResponseFor('/api/decisoes/s')!({ error: 'scope: session, family ou branch' }), { error: 'escopo: sessao, familia ou branch' });
    // Inside the panel, `work.error` is the old `erro`; a top-level `error` stays the error response.
    assert.deepEqual(legacyResponseFor('/api/painel/s')!({ work: { error: null }, error: 'x' }), { trabalho: { erro: null }, error: 'x' });
  });

  test('request bodies: old → new on the old write routes only', () => {
    const spec = LEGACY_BODIES['decision/adjust'] as { request?: LegacyBodySpec };
    const saved = spec.request;
    spec.request = { keys: { sessao: 'session', texto: 'text' } };
    try {
      assert.deepEqual(legacyRequestBody('/api/decisoes/d1/ajustar', { sessao: 's', texto: 't' }), { session: 's', text: 't' });
      assert.deepEqual(legacyRequestBody('/api/decisions/d1/adjust', { sessao: 's', texto: 't' }), { sessao: 's', texto: 't' }, 'a new route takes its body as it comes');
      assert.equal(legacyRequestBody('/api/decisoes/d1/ajustar', null), null, 'a null body stays null');
    } finally {
      spec.request = saved;
    }
  });
});
