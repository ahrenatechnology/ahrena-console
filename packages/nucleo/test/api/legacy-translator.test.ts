// Issue #173, phase 2b: the back-translator of the old routes (src/api/legacy-routes.ts). The engine
// alone, on made-up specs; the route specs themselves are proved by the goldens (legacy-golden.test.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_BODIES, legacyRequestBody, legacyResponseFor, legacyRouteOf, normalizeLegacyQuery, rawPathnameOf, translateBody, type LegacyBodySpec } from '../../src/api/legacy-routes.ts';
import { TIPOS_DE_MUDANCA } from '../../src/mudancas/cursor.ts';
import { MOTIVO_CURTO } from '../../src/api/rota-atencao.ts';

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
    for (const path of ['/api/eventos', '/api/projeto/mover']) {
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

  // Every member of the unions of the panel and decision shapes (src/api/tipos.ts), new → the old value
  // of the plugin's types (plugins/ahrena-console/types). The goldens only see what the demo emits.
  describe('every union member of the panel and the decisions answers the old value on the old route', () => {
    const panel = legacyResponseFor('/api/painel/x')!;
    const account = { id: 'a', label: 'L', color: '#fff', source: 'config' };
    const oldAccount = { id: 'a', rotulo: 'L', cor: '#fff', fonte: 'config' };
    const ACTIVITY = { tool: 'ferramenta', delegating: 'delegando', question: 'pergunta', permission: 'permissao', error: 'erro', prompt: 'prompt', 'your-turn': 'sua-vez', interrupted: 'interrompida', completed: 'concluida', abandoned: 'abandonada', idle: 'ociosa' };
    const BANNER = { question: 'pergunta', permission: 'permissao', error: 'erro' };
    const OUTCOME = { current: 'atual', completed: 'concluido', abandoned: 'abandonado' };
    const OWNER = { main: 'principal', subagent: 'subagente', session: 'sessao' };
    const CHILD_STATE = { active: 'active', completed: 'completed', error: 'error', abandoned: 'abandoned', waiting: 'waiting', delegating: 'delegating', background: 'background', unknown: 'desconhecido' };
    const PR_STATE = { draft: 'rascunho', open: 'aberto', merged: 'mergeado', closed: 'fechado' };
    const PR_CI = { ok: 'ok', failed: 'falhou', running: 'rodando' };
    const PR_REVIEW = { approved: 'aprovado', 'changes-requested': 'ajustes', pending: 'pendente' };
    const LEVEL = { needs: 'precisa', 'your-turn': 'sua-vez' };
    const WHY = { permission: 'permissao', question: 'pergunta', plan: 'plano', decision: 'decisao', error: 'erro', 'your-turn': 'sua-vez', interrupted: 'interrompida', 'no-prompt': 'no-prompt' };
    const RELATION = { parent: 'mae', child: 'filha', sibling: 'irma' };
    const ORIGIN = { question: 'pergunta', plan: 'plano', permission: 'permissao', correction: 'correcao', suggested: 'sugerida' };
    const STATE = { current: 'vigente', superseded: 'substituida', to_confirm: 'a_confirmar', dismissed: 'descartada' };
    const UNDO = { confirm: 'confirmar', dismiss: 'descartar', adjust: 'ajustar' };
    const DECIDED_BY = { user: 'usuario', agent: 'agente' };
    const SESSION = { this: 'esta', parent: 'mae', family: 'familia', branch: 'branch' };
    const SCOPE = { session: 'sessao', family: 'familia', branch: 'branch' };

    test('activity and banner types', () => {
      for (const [type, old] of Object.entries(ACTIVITY)) {
        const b = panel({ session: { activity: { type, text: 'x' }, account } }) as { sessao: unknown };
        assert.deepEqual(b.sessao, { atividade: { tipo: old, texto: 'x' }, conta: oldAccount }, type);
      }
      for (const [type, old] of Object.entries(BANNER)) {
        const b = panel({ session: { banner: { type, text: 'x', footer: 'f', since: 's' } } }) as { sessao: unknown };
        assert.equal(JSON.stringify(b.sessao), JSON.stringify({ faixa: { tipo: old, texto: 'x', rodape: 'f', desde: 's' } }), type);
      }
    });

    test('plan outcome and owner type', () => {
      for (const [outcome, old] of Object.entries(OUTCOME)) {
        const b = panel({ plans: [{ number: 1, outcome, summary: 's', done: 1, total: 2, current: null, start: 's', end: null }] }) as { planos: unknown[] };
        assert.equal(JSON.stringify(b.planos[0]), JSON.stringify({ numero: 1, resultado: old, resumo: 's', feitos: 1, total: 2, atual: null, inicio: 's', fim: null }), outcome);
      }
      for (const [type, old] of Object.entries(OWNER)) {
        const owner = { type, name: null, agentId: null };
        const oldOwner = { tipo: old, nome: null, agenteId: null };
        const b = panel({ plan: { currentOwner: owner, steps: [{ id: '1', text: 't', activeText: null, state: 'pending', owner }] } });
        assert.deepEqual(b, { plano: { atualDono: oldOwner, passos: [{ id: '1', texto: 't', textoAtivo: null, estado: 'pending', dono: oldOwner }] } }, type);
      }
    });

    test('children state', () => {
      for (const [state, old] of Object.entries(CHILD_STATE)) {
        const b = panel({ children: [{ id: 'c', local: null, title: 't', state, reason: null, since: null, doing: null, archived: false }] }) as { filhas: unknown[] };
        assert.equal(JSON.stringify(b.filhas[0]), JSON.stringify({ id: 'c', local: null, titulo: 't', estado: old, motivo: null, desde: null, fazendo: null, arquivada: false }), state);
      }
    });

    test('pr state, ci and review', () => {
      for (const [state, old] of Object.entries(PR_STATE)) {
        const b = panel({ work: { branch: 'b', repo: null, issue: { number: 1, title: 't', url: 'u', subIssues: { done: 1, total: 2 } }, pr: { number: 2, url: 'u', state, ci: null, checks: { total: 1, ok: 1, failed: 0, running: 0 }, review: null }, notPushed: false, error: null } }) as { trabalho: unknown };
        assert.equal(
          JSON.stringify(b.trabalho),
          JSON.stringify({ branch: 'b', repo: null, issue: { numero: 1, titulo: 't', url: 'u', subIssues: { feitas: 1, total: 2 } }, pr: { numero: 2, url: 'u', estado: old, ci: null, checks: { total: 1, ok: 1, falhas: 0, rodando: 0 }, review: null }, semPush: false, erro: null }),
          state,
        );
      }
      for (const [ci, old] of Object.entries(PR_CI)) assert.deepEqual(panel({ work: { pr: { ci } } }), { trabalho: { pr: { ci: old } } }, ci);
      for (const [review, old] of Object.entries(PR_REVIEW)) assert.deepEqual(panel({ work: { pr: { review } } }), { trabalho: { pr: { review: old } } }, review);
    });

    test('who needs you: level, why and relation', () => {
      for (const [level, oldLevel] of Object.entries(LEVEL))
        for (const [why, oldWhy] of Object.entries(WHY))
          for (const [relation, oldRelation] of Object.entries(RELATION)) {
            const item = { id: 'i', level, why, local: null, title: 't', state: 'waiting', reason: null, urgent: false, since: 's', text: 'x', model: null, relation, sameProject: true, account };
            const old = { id: 'i', nivel: oldLevel, porque: oldWhy, local: null, titulo: 't', estado: 'waiting', motivo: null, urgente: false, desde: 's', texto: 'x', modelo: null, relacao: oldRelation, mesmoProjeto: true, conta: oldAccount };
            const b = panel({ needYou: { total: 1, yourTurn: 0, byAccount: [{ account, n: 1 }], family: [item], machine: [item] } });
            assert.equal(JSON.stringify(b), JSON.stringify({ precisam: { total: 1, suaVez: 0, porConta: [{ conta: oldAccount, n: 1 }], familia: [old], maquina: [old] } }), `${level}/${why}/${relation}`);
          }
    });

    // Every decision field's union, in the panel's list and in the old decisions/scope route; `resume.from`
    // and the keys of `byScope` with them.
    const decision = (o: Record<string, unknown>) => ({ id: 'd', label: 'D1', origin: 'question', state: 'current', title: 't', text: 'x', context: 'c', undo: null, rejected: ['n'], decidedBy: 'user', decidedAt: 'z', confirmedAt: null, supersededBy: null, session: 'this', toolUseId: null, ...o });
    const oldDecision = (o: Record<string, unknown>) => ({ id: 'd', rotulo: 'D1', origem: 'pergunta', estado: 'vigente', titulo: 't', texto: 'x', contexto: 'c', desfazer: null, nao: ['n'], decididaPor: 'usuario', decididaEm: 'z', confirmadaEm: null, substituidaPor: null, sessao: 'esta', toolUseId: null, ...o });
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ...Object.entries(ORIGIN).map(([v, o]): [string, Record<string, unknown>, Record<string, unknown>] => [`origin ${v}`, { origin: v }, { origem: o }]),
      ...Object.entries(STATE).map(([v, o]): [string, Record<string, unknown>, Record<string, unknown>] => [`state ${v}`, { state: v }, { estado: o }]),
      ...Object.entries(UNDO).map(([v, o]): [string, Record<string, unknown>, Record<string, unknown>] => [`undo ${v}`, { undo: v }, { desfazer: o }]),
      ...Object.entries(DECIDED_BY).map(([v, o]): [string, Record<string, unknown>, Record<string, unknown>] => [`decidedBy ${v}`, { decidedBy: v }, { decididaPor: o }]),
      ...Object.entries(SESSION).map(([v, o]): [string, Record<string, unknown>, Record<string, unknown>] => [`session ${v}`, { session: v }, { sessao: o }]),
    ];
    const list = (scope: string, d: unknown) => ({ scope, current: 1, toConfirm: 0, items: [d], byScope: { session: 1, family: 2, branch: 3 } });
    const oldList = (escopo: string, d: unknown) => ({ escopo, vigentes: 1, aConfirmar: 0, itens: [d], porEscopo: { sessao: 1, familia: 2, branch: 3 } });

    test('decisions in the panel: origin, state, undo, decidedBy, session, the list scope and resume.from', () => {
      for (const [scope, oldScope] of Object.entries(SCOPE))
        for (const [name, field, oldField] of cases) {
          const b = panel({ decisions: { current: 1, toConfirm: 0, resume: { n: 1, tokens: null, from: 'f' }, list: list(scope, decision(field)) } });
          const want = { decisoes: { vigentes: 1, aConfirmar: 0, retomada: { n: 1, tokens: null, de: 'f' }, lista: oldList(oldScope, oldDecision(oldField)) } };
          assert.equal(JSON.stringify(b), JSON.stringify(want), `${scope} ${name}`);
        }
    });

    test('decisions on the old decisions/scope route', () => {
      const route = legacyResponseFor('/api/decisoes/x')!;
      for (const [scope, oldScope] of Object.entries(SCOPE))
        for (const [name, field, oldField] of cases)
          assert.equal(JSON.stringify(route(list(scope, decision(field)))), JSON.stringify(oldList(oldScope, oldDecision(oldField))), `${scope} ${name}`);
    });
  });
});

// Phase 2b layer 3: every member of the unions of the attention, the changes, the wall and the load,
// new → the old value on the old route (the goldens only see what the demo emits).
describe('every union member of the installed app and the live group answers the old value on the old route', () => {
  const LEVEL = { needs: 'precisa', 'your-turn': 'sua-vez' };
  const REASON = { permission: 'permissao', question: 'pergunta', plan: 'plano', decision: 'decisao', error: 'erro', 'your-turn': 'sua-vez', interrupted: 'interrompida', 'no-prompt': 'no-prompt' };
  const CHANGE = { session: 'sessao', state: 'estado', 'needs-you': 'precisa-de-voce', plan: 'plano', decision: 'decisao', account: 'conta', repos: 'repos', alert: 'alert' };
  const ACTIVITY = { tool: 'ferramenta', delegating: 'delegando', question: 'pergunta', permission: 'permissao', error: 'erro', prompt: 'prompt', 'your-turn': 'sua-vez', interrupted: 'interrompida', completed: 'concluida', abandoned: 'abandonada', idle: 'ociosa' };
  const HISTORY = { ready: 'pronto', importing: 'importando', off: 'desligado' };

  test('attention: level and reason, with the whole item and top in the old keys and order', () => {
    assert.deepEqual(Object.keys(REASON).sort(), Object.keys(MOTIVO_CURTO).sort(), 'every reason the route answers');
    const route = legacyResponseFor('/api/atencao')!;
    for (const [level, oldLevel] of Object.entries(LEVEL))
      for (const [reason, oldReason] of Object.entries(REASON)) {
        const item = { session: 's', title: 't', project: null, account: { label: 'L', color: '#fff' }, level, reason, shortReason: 'x', longReason: 'y', since: 'd', minutes: 1, local: null };
        const body = { generatedAt: 'g', cursor: 'c', total: 1, needs: 1, yourTurn: 0, active: 2, withError: 0, items: [item] };
        assert.equal(
          JSON.stringify(route(body)),
          JSON.stringify({
            geradoEm: 'g', cursor: 'c', total: 1, precisam: 1, suaVez: 0, ativas: 2, comErro: 0,
            itens: [{ sessao: 's', titulo: 't', projeto: null, conta: { rotulo: 'L', cor: '#fff' }, nivel: oldLevel, motivo: oldReason, motivoCurto: 'x', motivoLongo: 'y', desde: 'd', minutos: 1, local: null }],
          }),
          `${level} ${reason}`,
        );
      }
  });

  test('changes: every type, the keys of a change and of the answer, and the errors that cite a parameter', () => {
    assert.deepEqual(Object.keys(CHANGE), [...TIPOS_DE_MUDANCA], 'every change type');
    const route = legacyResponseFor('/api/mudancas')!;
    for (const [type, old] of Object.entries(CHANGE)) {
      const body = { cursor: 'g.2', changes: [{ type, key: 'k', sessionId: null, accountId: null, seq: 2 }], reset: false, timedOut: false };
      assert.equal(JSON.stringify(route(body)), JSON.stringify({ cursor: 'g.2', mudancas: [{ tipo: old, chave: 'k', sessionId: null, accountId: null, seq: 2 }], reiniciar: false, expirou: false }), type);
    }
    const errors = {
      'session inválida': 'sessao inválida',
      'account inválida': 'conta inválida',
      'wait inválida': 'espera inválida',
      [`type: um de ${TIPOS_DE_MUDANCA.join(', ')}`]: 'tipo: um de sessao, estado, precisa-de-voce, plano, decisao, conta, repos, alert',
      'esperas abertas demais (máximo 2)': 'esperas abertas demais (máximo 2)',
    };
    for (const [error, old] of Object.entries(errors)) assert.deepEqual(route({ error }), { error: old }, error);
  });

  test('changes: the old `?type=` values (alone or in a list) become the new ones; the new ones pass', () => {
    for (const [type, old] of Object.entries(CHANGE)) {
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`tipo=${old}`)).get('type'), type, old);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`type=${type}`)).get('type'), type, type);
    }
    assert.equal(normalizeLegacyQuery(new URLSearchParams('tipo=sessao,decisao,alert')).get('type'), 'session,decision,alert');
    // An event type is not a change type: it passes as it came.
    assert.equal(normalizeLegacyQuery(new URLSearchParams('tipo=PreToolUse')).get('type'), 'PreToolUse');
  });

  test('wall: the activity types of a card, its keys and the counts', () => {
    const route = legacyResponseFor('/api/mural')!;
    for (const [type, old] of Object.entries(ACTIVITY)) {
      const card = {
        id: 'i', title: 't', project: 'p', branch: null, status: 'waiting', state: 'waiting', reason: 'notification', urgent: true, since: 'd',
        activity: { type, text: 'x' }, model: 'm', effort: null, agents: { active: 1, total: 2 }, cost: { usd: null, estimate: true },
        plan: { done: 1, total: 2, current: 'c' }, context: { pct: 1, used: 2, limit: 3, label: 'l' },
      };
      assert.equal(
        JSON.stringify(route({ version: 1, generatedAt: 'g', count: { all: 1, waiting: 1, active: 0 }, cards: [card] })),
        JSON.stringify({
          versao: 1, geradoEm: 'g', contagem: { todas: 1, esperando: 1, ativas: 0 },
          cards: [{
            id: 'i', titulo: 't', projeto: 'p', branch: null, status: 'waiting', estado: 'waiting', motivo: 'notification', urgente: true, desde: 'd',
            atividade: { tipo: old, texto: 'x' }, modelo: 'm', esforco: null, agentes: { ativos: 1, total: 2 }, custo: { usd: null, estimativa: true },
            plano: { feitos: 1, total: 2, atual: 'c' }, contexto: { pct: 1, usados: 2, limite: 3, rotulo: 'l' },
          }],
        }),
        type,
      );
    }
  });

  test('load: every counter and the history state; the follower and the work counters stay', () => {
    const route = legacyResponseFor('/api/carga')!;
    for (const [history, old] of Object.entries(HISTORY)) {
      const follower = { rounds: 1, scans: 1, filesImported: 2, filesKnown: 3, watching: true };
      assert.equal(
        JSON.stringify(route({ requests: 1, panel: 2, panelMs: 3, eventsRead: 4, openWaits: 0, history, follower, desktopRead: 5, work: { github: 0, git: 1 } })),
        JSON.stringify({ pedidos: 1, painel: 2, msPainel: 3, eventosLidos: 4, esperasAbertas: 0, historico: old, seguidor: follower, desktopLidos: 5, trabalho: { github: 0, git: 1 } }),
        history,
      );
    }
  });
});
