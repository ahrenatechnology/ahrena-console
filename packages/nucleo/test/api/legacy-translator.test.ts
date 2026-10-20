// Issue #173, phase 2b: the back-translator of the old routes (src/api/legacy-routes.ts). The engine
// alone, on made-up specs; the route specs themselves are proved by the goldens (legacy-golden.test.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_BODIES, legacyRequestBody, legacyResponseFor, legacyRouteOf, normalizeLegacyQuery, rawPathnameOf, translateBody, type LegacyBodySpec } from '../../src/api/legacy-routes.ts';
import { TIPOS_DE_MUDANCA } from '../../src/mudancas/cursor.ts';
import { MOTIVO_CURTO } from '../../src/api/rota-atencao.ts';
import { LIMITE_MAXIMO, MAIN_AGENT, SEARCH_MAX, STATUS_DO_EVENTO, SUBAGENT } from '../../src/api/eventos.ts';
import { BUSCA_MAXIMA as HISTORY_SEARCH_MAX, DIAS_MAXIMO } from '../../src/historico/modelo.ts';
import { FILTROS_DE_STATUS, ORDENS } from '../../src/api/sessoes.ts';
import { AGENT_STATUSES, AWAITING_REASONS, SESSION_STATUSES } from '../../src/model.ts';
import { DETAIL_AGENT_TYPES, MESSAGE_ROLES, TOOL_STATES } from '../../src/api/detalhe.ts';
import { EDGE_TYPES, FILTROS_DOS_WORKFLOWS, GRAPH_NODE_LABELS, NODE_STATES, NO_DO_GRAFO } from '../../src/api/workflows.ts';

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
    for (const path of ['/abrir/x', '/api/projeto/mover']) {
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

// Phase 2b layer 4: the activity feed, the Sessions list and the History, new → the old body on the
// old route, for every value of their unions and every error that cites a parameter.
describe('every union member of the feed, the Sessions list and the History answers the old value on the old route', () => {
  test('events: every status, the main agent and the subagent without a type; a subagent type stays', () => {
    const route = legacyResponseFor('/api/eventos')!;
    const AGENT = { [MAIN_AGENT]: 'principal', [SUBAGENT]: 'subagente', 'test-runner': 'test-runner' };
    for (const status of STATUS_DO_EVENTO)
      for (const [name, oldName] of Object.entries(AGENT)) {
        const session = { id: 's', title: 't', project: 'p' };
        const event = { id: 'e', createdAt: 'c', type: 'Stop', status, tool: null, summary: 'x', session, agent: { id: null, name }, detail: { callId: null, input: 'i' } };
        assert.equal(
          JSON.stringify(route({ events: [event], cursor: 'k', older: 'o', options: { types: ['Stop'], tools: ['Bash'], sessions: [session] } })),
          JSON.stringify({
            eventos: [{ id: 'e', criadoEm: 'c', tipo: 'Stop', status, ferramenta: null, resumo: 'x', sessao: { id: 's', titulo: 't', projeto: 'p' }, agente: { id: null, nome: oldName }, detalhe: { callId: null, entrada: 'i' } }],
            cursor: 'k',
            anteriores: 'o',
            opcoes: { tipos: ['Stop'], ferramentas: ['Bash'], sessoes: [{ id: 's', titulo: 't', projeto: 'p' }] },
          }),
          `${status} ${name}`,
        );
      }
  });

  test('events: every error that cites a parameter cites the old one on the old route', () => {
    const route = legacyResponseFor('/api/eventos')!;
    const errors = {
      [`limit: um inteiro de 1 a ${LIMITE_MAXIMO}`]: `limite: um inteiro de 1 a ${LIMITE_MAXIMO}`,
      'after e before não se combinam': 'depois e antes não se combinam',
      'after: cursor inválido': 'depois: cursor inválido',
      'before: cursor inválido': 'antes: cursor inválido',
      'type: só letras, números e _, até 64': 'tipo: só letras, números e _, até 64',
      'session: id de sessão inválido': 'sessao: id de sessão inválido',
      'tool: nome de ferramenta inválido': 'ferramenta: nome de ferramenta inválido',
      'status: um de active, waiting, error, completed': 'status: um de active, waiting, error, completed',
      'search: sem quebras de linha nem caracteres de controle': 'busca: sem quebras de linha nem caracteres de controle',
      [`search: até ${SEARCH_MAX} caracteres`]: `busca: até ${SEARCH_MAX} caracteres`,
      'from: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)': 'de: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)',
      'to: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)': 'ate: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)',
      'from: depois do to': 'de: depois do ate',
      'cursor inválido': 'cursor inválido',
    };
    for (const [error, old] of Object.entries(errors)) assert.deepEqual(route({ error }), { error: old }, error);
  });

  test('sessions: every status and reason pass, the row and the page in the old keys and order', () => {
    const route = legacyResponseFor('/api/sessoes')!;
    for (const status of [...SESSION_STATUSES, 'waiting'])
      for (const reason of [...AWAITING_REASONS, null]) {
        const row = { id: 'i', title: 't', status, reason, lastActivity: 'u', start: 's', running: true, durationMs: 1, agents: 2, costUsd: null, cwd: '/d', account: { label: 'L', color: '#fff' } };
        assert.equal(
          JSON.stringify(route({ total: 1, registered: 3, page: 1, perPage: 10, pages: 1, directories: ['/d'], items: [row] })),
          JSON.stringify({
            total: 1, registradas: 3, pagina: 1, porPagina: 10, paginas: 1, diretorios: ['/d'],
            itens: [{ id: 'i', titulo: 't', status, motivo: reason, ultimaAtividade: 'u', inicio: 's', rodando: true, duracaoMs: 1, agentes: 2, custoUsd: null, cwd: '/d', conta: { rotulo: 'L', cor: '#fff' } }],
          }),
          `${status} ${reason}`,
        );
      }
  });

  test('sessions: the old `?status=` and `?order=` values become the new ones; the new ones pass', () => {
    const STATUS = { todas: 'all', ativas: 'active', esperando: 'waiting', concluidas: 'completed', erro: 'error', abandonadas: 'abandoned' };
    const ORDER = { atividade: 'activity', duracao: 'duration', custo: 'cost' };
    assert.deepEqual(Object.values(STATUS), [...FILTROS_DE_STATUS], 'every status filter');
    assert.deepEqual(Object.values(ORDER), [...ORDENS], 'every order');
    for (const [old, status] of Object.entries(STATUS)) {
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`status=${old}`), '/api/sessions').get('status'), status, old);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`status=${status}`), '/api/sessions').get('status'), status, status);
      // Only on the sessions list: elsewhere (`/api/events?status=`) the old value reaches the handler as it came.
      for (const path of ['', '/api/events', '/api/sessions/s1/events'])
        assert.equal(normalizeLegacyQuery(new URLSearchParams(`status=${old}`), path).get('status'), old, `${path} ${old}`);
    }
    for (const [old, order] of Object.entries(ORDER)) {
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`ordem=${old}`), '/api/sessions').get('order'), order, old);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`order=${order}`), '/api/sessions').get('order'), order, order);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`ordem=${old}`), '/api/events').get('order'), old, old);
    }
  });

  test('sessions: every error that cites a parameter cites the old one, with the old values', () => {
    const route = legacyResponseFor('/api/sessoes')!;
    const errors = {
      [`status: um de ${FILTROS_DE_STATUS.join(', ')}`]: 'status: um de todas, ativas, esperando, concluidas, erro, abandonadas',
      [`order: um de ${ORDENS.join(', ')}`]: 'ordem: um de atividade, duracao, custo',
      'direction: um de desc, asc': 'sentido: um de desc, asc',
      'page: um inteiro a partir de 1': 'pagina: um inteiro a partir de 1',
      'search grande demais': 'busca grande demais',
      'dir: um caminho absoluto': 'dir: um caminho absoluto',
    };
    for (const [error, old] of Object.entries(errors)) assert.deepEqual(route({ error }), { error: old }, error);
  });

  test('history: every final status, the day and the session in the old keys and order, with the /clear neighbours', () => {
    const route = legacyResponseFor('/api/historico')!;
    for (const status of SESSION_STATUSES)
      for (const [previous, next] of [[null, null], [{ id: 'a', title: 'A' }, { id: 'b', title: null }]] as const) {
        const session = { id: 'i', title: 't', project: 'p', model: 'm', status, start: 's', end: 'e', durationMs: 1, costUsd: 0.5, previous, next };
        const old = (n: { id: string; title: string | null } | null) => (n ? { id: n.id, titulo: n.title } : null);
        assert.equal(
          JSON.stringify(route({ days: [{ day: '2026-10-20', sessions: [session] }], next: '2026-10-19' })),
          JSON.stringify({
            dias: [{ dia: '2026-10-20', sessoes: [{ id: 'i', titulo: 't', projeto: 'p', modelo: 'm', status, inicio: 's', fim: 'e', duracaoMs: 1, custoUsd: 0.5, anterior: old(previous), seguinte: old(next) }] }],
            proximo: '2026-10-19',
          }),
          `${status} ${previous?.id ?? 'no neighbours'}`,
        );
      }
  });

  test('history: every error that cites a parameter cites the old one', () => {
    const route = legacyResponseFor('/api/historico')!;
    const errors = {
      'before: um dia AAAA-MM-DD': 'antes: um dia AAAA-MM-DD',
      [`days: um inteiro de 1 a ${DIAS_MAXIMO}`]: `dias: um inteiro de 1 a ${DIAS_MAXIMO}`,
      [`search: até ${HISTORY_SEARCH_MAX} caracteres`]: `busca: até ${HISTORY_SEARCH_MAX} caracteres`,
      'o núcleo subiu sem o histórico': 'o núcleo subiu sem o histórico',
    };
    for (const [error, old] of Object.entries(errors)) assert.deepEqual(route({ error }), { error: old }, error);
  });

  test('the error texts with a limit in them follow the limit: the spec holds the exact current message', () => {
    // legacy-routes.ts imports nothing, so its keys spell the numbers out; a limit that moves fails here.
    const has = (route: 'events' | 'history', message: string) =>
      assert.ok(Object.hasOwn(LEGACY_BODIES[route].response?.values?.['.error'] ?? {}, message), `${route}: ${message}`);
    has('events', `limit: um inteiro de 1 a ${LIMITE_MAXIMO}`);
    has('events', `search: até ${SEARCH_MAX} caracteres`);
    has('history', `days: um inteiro de 1 a ${DIAS_MAXIMO}`);
    has('history', `search: até ${HISTORY_SEARCH_MAX} caracteres`);
  });
});

describe('every union member of the session Detail and the workflows answers the old value on the old route', () => {
  const card = { id: 's', title: 'T', model: 'm', startedAt: 'a', status: 'waiting', state: 'permission', reason: 'notification', urgent: true, since: 'b', turn: 2, activity: { type: 'permission', text: 'x' }, banner: { type: 'permission', text: 'y', footer: null, since: 'b' }, account: { id: 'c', label: 'L', color: '#fff', source: 'env' }, branch: 'br', cwd: '/d' };
  const oldCard = { id: 's', titulo: 'T', modelo: 'm', iniciadaEm: 'a', status: 'waiting', estado: 'permission', motivo: 'notification', urgente: true, desde: 'b', turno: 2, atividade: { tipo: 'permissao', texto: 'x' }, faixa: { tipo: 'permissao', texto: 'y', rodape: null, desde: 'b' }, conta: { id: 'c', rotulo: 'L', cor: '#fff', fonte: 'env' }, branch: 'br', cwd: '/d' };

  test('session top: the whole body in the old keys and order, with the panel card and cost', () => {
    const route = legacyResponseFor('/api/sessoes/s')!;
    const body = { version: 1, generatedAt: 'g', session: card, cost: { usd: 1, series: [0, 1], estimate: true }, branch: 'br', local: null, opensSession: false, command: 'npm test', endedAt: null, counts: { agents: 2, events: 9 } };
    assert.equal(
      JSON.stringify(route(body)),
      JSON.stringify({ versao: 1, geradoEm: 'g', sessao: oldCard, custo: { usd: 1, serie: [0, 1], estimativa: true }, branch: 'br', local: null, abreSessao: false, comando: 'npm test', encerradaEm: null, contagens: { agentes: 2, eventos: 9 } }),
    );
    for (const error of ['id de sessão inválido', 'o núcleo não conhece esta sessão']) assert.deepEqual(route({ error }), { error });
  });

  test('agents tab: every agent type and status, the numbers, tools, tokens and the plan in the old keys and order', () => {
    const route = legacyResponseFor('/api/sessoes/s/agentes')!;
    const OLD_TYPE = { main: 'principal', subagent: 'subagente' };
    assert.deepEqual(Object.keys(OLD_TYPE), [...DETAIL_AGENT_TYPES]);
    for (const type of DETAIL_AGENT_TYPES)
      for (const status of AGENT_STATUSES) {
        const agent = { id: 'a', type, name: 'Agente principal', task: null, model: 'm', turns: 3, status, start: 's', end: null, costUsd: 0.5, parent: null };
        const body = {
          numbers: { events: 9, perMinute: 1, tools: 4, uniqueTools: 2, subagents: 1, compactions: 0, errors: 0, durationMin: 9, running: true },
          tools: [{ name: 'Bash', n: 3 }],
          tasks: { done: 1, total: 2, current: 'c', next: null, remaining: 0, currentOwner: { type: 'main', name: null, agentId: 'a' }, changedAt: 'x', steps: [{ id: '1', text: 't', activeText: 'at', state: 'pending', owner: { type: 'subagent', name: 'Explore', agentId: 'b' } }] },
          tokens: { cacheRead: 1, cacheWrite: 2, input: 3, output: 4, total: 10 },
          agents: [agent],
        };
        assert.equal(
          JSON.stringify(route(body)),
          JSON.stringify({
            numeros: { eventos: 9, porMinuto: 1, ferramentas: 4, ferramentasUnicas: 2, subagentes: 1, compactacoes: 0, erros: 0, duracaoMin: 9, rodando: true },
            ferramentas: [{ nome: 'Bash', n: 3 }],
            tarefas: { feitos: 1, total: 2, atual: 'c', proximo: null, restantes: 0, atualDono: { tipo: 'principal', nome: null, agenteId: 'a' }, mudouEm: 'x', passos: [{ id: '1', texto: 't', textoAtivo: 'at', estado: 'pending', dono: { tipo: 'subagente', nome: 'Explore', agenteId: 'b' } }] },
            tokens: { cacheLido: 1, cacheGravado: 2, entrada: 3, saida: 4, total: 10 },
            agentes: [{ id: 'a', tipo: OLD_TYPE[type], nome: 'Agente principal', tarefa: null, modelo: 'm', turnos: 3, status, inicio: 's', fim: null, custoUsd: 0.5, pai: null }],
          }),
          `${type} ${status}`,
        );
      }
  });

  test('conversation: every role and tool state; the text and the tool summary, input and result are data', () => {
    const route = legacyResponseFor('/api/sessoes/s/conversa')!;
    const OLD_ROLE = { you: 'voce', assistant: 'assistente' };
    const OLD_STATE = { ok: 'ok', error: 'erro', permission: 'permissao', running: 'rodando' };
    assert.deepEqual(Object.keys(OLD_ROLE), [...MESSAGE_ROLES]);
    assert.deepEqual(Object.keys(OLD_STATE), [...TOOL_STATES]);
    for (const role of MESSAGE_ROLES)
      for (const state of [...TOOL_STATES, null]) {
        // Data that looks like the fixed values or the keys: never translated.
        const tool = { id: 't', name: 'Bash', summary: 'error', state, input: '{ "state": "error", "role": "you" }', result: 'running' };
        const body = { agents: [{ id: 'a', name: 'Agente principal' }], agent: 'a', total: 1, messages: [{ id: 'm', role, at: 'x', text: role, model: null, tokens: { input: 1, output: 2 }, tools: [tool] }] };
        assert.equal(
          JSON.stringify(route(body)),
          JSON.stringify({
            agentes: [{ id: 'a', nome: 'Agente principal' }],
            agente: 'a',
            total: 1,
            mensagens: [{ id: 'm', papel: OLD_ROLE[role], em: 'x', texto: role, modelo: null, tokens: { entrada: 1, saida: 2 }, ferramentas: [{ id: 't', nome: 'Bash', resumo: 'error', estado: state === null ? null : OLD_STATE[state], entrada: tool.input, resultado: 'running' }] }],
          }),
          `${role} ${state}`,
        );
      }
  });

  test('timeline (events tab): the page, every status and the options in the old keys and order; summary and data are data', () => {
    const route = legacyResponseFor('/api/sessoes/s/eventos')!;
    for (const status of ['active', 'waiting', 'error'] as const) {
      const body = {
        total: 2,
        filtered: 1,
        items: [{ id: 'e', at: 'x', type: 'PreToolUse', tool: 'Bash', summary: 'type', agent: { id: 'a', name: 'Explore' }, status, data: '{ "agent": { "name": "main" } }' }],
        next: null,
        options: { types: ['PreToolUse'], tools: ['Bash'], agents: [{ id: 'a', name: 'Agente principal' }], status: ['active', 'waiting', 'error'] },
      };
      assert.equal(
        JSON.stringify(route(body)),
        JSON.stringify({
          total: 2,
          filtrados: 1,
          itens: [{ id: 'e', em: 'x', tipo: 'PreToolUse', ferramenta: 'Bash', resumo: 'type', agente: { id: 'a', nome: 'Explore' }, status, dados: body.items[0]!.data }],
          proximo: null,
          opcoes: { tipos: ['PreToolUse'], ferramentas: ['Bash'], agentes: [{ id: 'a', nome: 'Agente principal' }], status: ['active', 'waiting', 'error'] },
        }),
        status,
      );
    }
  });

  test('session workflow: every node and span state and every edge type, in the old keys and order', () => {
    const route = legacyResponseFor('/api/sessoes/s/workflow')!;
    const OLD_STATE = { active: 'ativo', completed: 'concluido', error: 'erro' };
    const OLD_EDGE = { opened: 'abriu', delivered: 'entregou', 'changes-requested': 'ajustes' };
    assert.deepEqual(Object.keys(OLD_STATE), [...NODE_STATES]);
    assert.deepEqual(Object.keys(OLD_EDGE), [...EDGE_TYPES]);
    for (const state of NODE_STATES)
      for (const type of EDGE_TYPES) {
        const body = {
          sessionId: 's', start: 'a', end: null, durationMs: 1, summary: 'dev → review',
          nodes: [{ id: 'n', name: 'review', type: 'code-reviewer', round: 1, task: 'diff', model: null, durationMs: 1, state, changesRequested: 2, start: 'a', end: null }],
          edges: [{ from: 'm', to: 'n', type, label: 'ajustes' }],
          reviewRounds: 1, changesRequested: 2,
          timeline: { start: 'a', end: 'b', lanes: [{ nodeId: 'n', label: 'review · r1', spans: [{ nodeId: 'n', start: 'a', end: null, state }] }] },
        };
        assert.equal(
          JSON.stringify(route(body)),
          JSON.stringify({
            sessaoId: 's', inicio: 'a', fim: null, duracaoMs: 1, resumo: 'dev → review',
            nos: [{ id: 'n', nome: 'review', tipo: 'code-reviewer', rodada: 1, tarefa: 'diff', modelo: null, duracaoMs: 1, estado: OLD_STATE[state], ajustes: 2, inicio: 'a', fim: null }],
            arestas: [{ de: 'm', para: 'n', tipo: OLD_EDGE[type], rotulo: 'ajustes' }],
            rodadasDeReview: 1, ajustes: 2,
            linhaDoTempo: { inicio: 'a', fim: 'b', faixas: [{ noId: 'n', rotulo: 'review · r1', trechos: [{ noId: 'n', inicio: 'a', fim: null, estado: OLD_STATE[state] }] }] },
          }),
          `${state} ${type}`,
        );
      }
    for (const error of ['id de sessão inválido', 'sessão não encontrada']) assert.deepEqual(route({ error }), { error });
  });

  test('workflows: the old `?filter=`/`?filtro=` values and every old node id become the new ones, only on /api/workflows', () => {
    const FILTER = { todas: 'all', ativas: 'active', concluidas: 'completed' };
    assert.deepEqual(Object.values(FILTER), [...FILTROS_DOS_WORKFLOWS]);
    for (const [old, filter] of Object.entries(FILTER)) {
      for (const name of ['filtro', 'filter']) assert.equal(normalizeLegacyQuery(new URLSearchParams(`${name}=${old}`), '/api/workflows').get('filter'), filter, `${name}=${old}`);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`filter=${filter}`), '/api/workflows').get('filter'), filter);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`filter=${old}`), '/api/sessions').get('filter'), old, 'only on /api/workflows');
    }
    const NODE = {
      principal: 'main',
      'origem:prompt': 'origin:prompt',
      'origem:retomada': 'origin:resume',
      'compactacao:sem': 'compaction:none',
      'compactacao:compactou': 'compaction:compacted',
      'resultado:concluida': 'outcome:completed',
      'resultado:erro': 'outcome:error',
      'resultado:andamento': 'outcome:active',
      'resultado:abandonada': 'outcome:abandoned',
      'subagente:subagente': 'subagent:subagent',
      'subagente:Explore': 'subagent:Explore',
      'subagente:code-reviewer': 'subagent:code-reviewer',
    };
    // Every fixed node of the graph has its old id here.
    for (const id of Object.keys(GRAPH_NODE_LABELS)) assert.ok(Object.values(NODE).includes(id), id);
    for (const [old, node] of Object.entries(NODE)) {
      assert.ok(NO_DO_GRAFO.test(node), node);
      for (const name of ['no', 'node']) assert.equal(normalizeLegacyQuery(new URLSearchParams(`${name}=${old}`), '/api/workflows').get('node'), node, `${name}=${old}`);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`node=${node}`), '/api/workflows').get('node'), node, node);
      assert.equal(normalizeLegacyQuery(new URLSearchParams(`node=${old}`), '/api/events').get('node'), old, 'only on /api/workflows');
    }
  });
});
