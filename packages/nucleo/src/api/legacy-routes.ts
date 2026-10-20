// The old Portuguese routes and query parameters of the API, as aliases of the English ones
// (issue #173, phase 1; decision 0009). This is the only place that knows them: the server runs
// `normalizeLegacyUrl` before routing, and every handler reads only the new names.
//
// They stay until the published mod (v0.0.30 calls `/api/painel/<id>` and `/abrir/<id>`) and the
// installed app (`/api/atencao`, `/api/mudancas`) migrate; phase 6 deletes this file.
//
// Phase 2b turns the JSON keys and fixed values of the API English, but an old route keeps answering
// exactly the body it answered before (the goldens of `test/api/legacy-golden.test.ts`) and keeps
// accepting the old request body. That is the back-translator at the end of this file: per old
// route, a spec of keys and values new → old for the response and old → new for the request body.

/**
 * The old routes, by the name their body spec has in `LEGACY_BODIES`. A sub-route of the sessions
 * and an action on a decision are named after their new segment (`session/agents`, `decision/confirm`).
 */
export type LegacyRoute =
  | 'attention'
  | 'changes'
  | 'panel'
  | 'open'
  | 'wall'
  | 'events'
  | 'load'
  | 'sessions'
  | 'session'
  | 'session/agents'
  | 'session/conversation'
  | 'session/events'
  | 'session/workflow'
  | 'session/decisions'
  | 'history'
  | 'decisions/scope'
  | 'decisions'
  | 'decision/confirm'
  | 'decision/dismiss'
  | 'decision/adjust'
  | 'decision/undo'
  | 'decision/promote'
  | 'project'
  | 'project/move'
  | 'analytics/cost';

/** Old path → its route and its new path. The id segments are kept as they came (still encoded). */
const LEGACY_PATHS: readonly (readonly [RegExp, (m: RegExpExecArray) => LegacyRoute, (m: RegExpExecArray) => string])[] = [
  [/^\/api\/atencao$/, () => 'attention', () => '/api/attention'],
  [/^\/api\/mudancas$/, () => 'changes', () => '/api/changes'],
  [/^\/api\/(?:painel|sessao)\/([^/]+)$/, () => 'panel', (m) => `/api/panel/${m[1]}`],
  [/^\/abrir\/([^/]+)$/, () => 'open', (m) => `/open/${m[1]}`],
  [/^\/api\/mural$/, () => 'wall', () => '/api/wall'],
  [/^\/api\/eventos$/, () => 'events', () => '/api/events'],
  [/^\/api\/carga$/, () => 'load', () => '/api/load'],
  [/^\/api\/sessoes$/, () => 'sessions', () => '/api/sessions'],
  [/^\/api\/sessoes\/([^/]+)$/, () => 'session', (m) => `/api/sessions/${m[1]}`],
  [/^\/api\/sessoes\/([^/]+)\/(agentes|conversa|eventos|workflow|decisoes)$/, (m) => `session/${LEGACY_SEGMENTS[m[2]!]}` as LegacyRoute, (m) => `/api/sessions/${m[1]}/${LEGACY_SEGMENTS[m[2]!]}`],
  [/^\/api\/historico$/, () => 'history', () => '/api/history'],
  [/^\/api\/decisoes\/([^/]+)$/, () => 'decisions/scope', (m) => `/api/decisions/${m[1]}`],
  [/^\/api\/decisoes$/, () => 'decisions', () => '/api/decisions'],
  [/^\/api\/decisoes\/([^/]+)\/(confirmar|descartar|ajustar|desfazer|promover)$/, (m) => `decision/${LEGACY_SEGMENTS[m[2]!]}` as LegacyRoute, (m) => `/api/decisions/${m[1]}/${LEGACY_SEGMENTS[m[2]!]}`],
  [/^\/api\/projeto$/, () => 'project', () => '/api/project'],
  [/^\/api\/projeto\/mover$/, () => 'project/move', () => '/api/project/move'],
  [/^\/api\/analytics\/custo$/, () => 'analytics/cost', () => '/api/analytics/cost'],
];

const LEGACY_SEGMENTS: Readonly<Record<string, string>> = {
  agentes: 'agents',
  conversa: 'conversation',
  eventos: 'events',
  workflow: 'workflow',
  decisoes: 'decisions',
  confirmar: 'confirm',
  descartar: 'dismiss',
  ajustar: 'adjust',
  desfazer: 'undo',
  promover: 'promote',
};

/** Old query parameter → new, on every API route. When both come, the new one wins. */
export const LEGACY_PARAMS: Readonly<Record<string, string>> = {
  desde: 'since',
  espera: 'wait',
  sessao: 'session',
  conta: 'account',
  tipo: 'type',
  modelo: 'model',
  decisoes: 'decisions',
  escopo: 'scope',
  antes: 'before',
  depois: 'after',
  dias: 'days',
  busca: 'search',
  limite: 'limit',
  pagina: 'page',
  ordem: 'order',
  sentido: 'direction',
  coluna: 'column',
  visao: 'view',
  forcar: 'refresh',
  fuso: 'tz',
  agente: 'agent',
  ferramenta: 'tool',
  de: 'from',
  ate: 'to',
  filtro: 'filter',
  no: 'node',
  estado: 'state',
  agrupar: 'groupBy',
  grupo: 'group',
  periodo: 'period',
  atualizar: 'refresh',
};

/**
 * Fixed values that travel in the query, translated to the values the handlers read. Phase 1 mapped
 * the English values to the Portuguese ones the handlers still used; when a handler switches to
 * English (phase 2b), its entry flips and maps the old values to the new ones. Both are accepted on
 * every route either way.
 */
const ENGLISH_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Phase 2b layer 2: the decision scope is English in the handlers (`/api/decisions/<s>?scope=`,
  // `/api/panel/<s>?decisions=`, `/api/sessions/<id>/decisions?scope=`).
  scope: { sessao: 'session', familia: 'family' },
  decisions: { sessao: 'session', familia: 'family' },
  view: { sessions: 'sessoes', agents: 'agentes' },
  groupBy: { family: 'familia', session: 'sessao' },
  period: { '1y': '1a' },
};

/** The new path of an old one; any other path comes back as it is. */
export function normalizeLegacyPath(pathname: string): string {
  for (const [old, , next] of LEGACY_PATHS) {
    const m = old.exec(pathname);
    if (m) return next(m);
  }
  return pathname;
}

/** The query with the new parameter names and the values the handlers read. */
export function normalizeLegacyQuery(query: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [name, value] of query) {
    const next = LEGACY_PARAMS[name];
    if (next !== undefined && query.has(next)) continue;
    const key = next ?? name;
    out.append(key, ENGLISH_VALUES[key]?.[value] ?? value);
  }
  return out;
}

/** The URL the router sees: new path and new query; `/ui`, `/mcp` and the hooks are left alone. */
export function normalizeLegacyUrl(url: URL): URL {
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/abrir/') && !url.pathname.startsWith('/open/')) return url;
  if (url.pathname.startsWith('/api/hooks')) return url;
  const out = new URL(url);
  out.pathname = normalizeLegacyPath(url.pathname);
  const query = normalizeLegacyQuery(url.searchParams);
  out.search = query.size > 0 ? `?${query}` : '';
  return out;
}

// ---------------------------------------------------------------------------------------------
// The back-translator (issue #173, phase 2b).
//
// The server asks `legacyResponseFor(rawPathname)` once per request, with the path as it came (before
// `normalizeLegacyUrl`); for an old route it gets the new → old translator of that route and applies
// it where every JSON body is written (`send`, through `rewriteJsonBodies`), the `{ error }` bodies
// included. The handlers that read a JSON body pass it through `legacyRequestBody` (old → new).
//
// A spec (`LegacyBodySpec`) is written in the direction it translates: `response` maps NEW names to
// OLD ones, `request` maps OLD names to NEW ones. Its entries are matched on the names of the body as
// it arrives (the "from" side):
//
// - `keys`: `{ from: to }` renames an object key. An entry is global (`'key'`, any object) or scoped
//   to the enclosing object's key (`'parent.key'`); the scoped one wins. For array items the parent is
//   the array's key; the top-level object's parent is `''`, so `'.key'` scopes to the top level.
// - `values`: `{ selector: { from: to } }` translates a string value (or each string of an array) held
//   by that key, with the same selectors as `keys`: `{ status: { waiting: 'esperando' } }`.
// - `opaque`: selectors whose value is copied untouched (tool inputs, payloads, data maps); the key
//   itself is still renamed by `keys`.
// - `dictKeys`: selectors whose value is an object keyed by DATA (a `Record<Scope, number>`): its
//   keys are translated by `values[selector]`, never by `keys`, and its children are walked with the
//   dict's key as their parent (a string child is translated by `values['dict.*']`).
//
// The names in a selector are always "from" names (new ones in `response`, old ones in `request`), and
// a key that is renamed is looked up by its "from" name for every rule. Only plain objects and arrays
// are walked; anything else (a `Date`, a number) is left for `JSON.stringify`. An empty spec is the
// identity and returns the same object.
// ---------------------------------------------------------------------------------------------

/** How one body is translated; see the notes above. */
export interface LegacyBodySpec {
  keys?: Readonly<Record<string, string>>;
  values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  dictKeys?: readonly string[];
  opaque?: readonly string[];
}

/** An old route's translation: its response (new → old) and, on the writes, its request body (old → new). */
export interface LegacyRouteSpec {
  response?: LegacyBodySpec;
  request?: LegacyBodySpec;
}

/** `{ k: v }` with every key scoped to `parent` (`'parent.k'`). */
const scoped = <T>(parent: string, map: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [`${parent}.${k}`, v]));

/** Several specs as one (a later entry wins on the same selector). */
function merge(...specs: LegacyBodySpec[]): LegacyBodySpec {
  return {
    keys: Object.assign({}, ...specs.map((s) => s.keys ?? {})),
    values: Object.assign({}, ...specs.map((s) => s.values ?? {})),
    dictKeys: specs.flatMap((s) => s.dictKeys ?? []),
    opaque: specs.flatMap((s) => s.opaque ?? []),
  };
}

// ---------------------------------------------------------------------------------------------
// The panel group (phase 2b layer 2): `GET /api/panel/<session>` (old `/api/painel/<id>` and
// `/api/sessao/<id>`, what the published mod v0.0.30 reads), the decision list of a scope and the
// writes on a decision, plus the old routes that embed one of their shapes (the wall's activity, the
// Detail's session card, cost and plan, the decision cards of the Decisions page, tab and promote).
//
// Naming conventions, for the later layers to reuse:
// - keys are camelCase English; a date `xxxEm` becomes `xxxAt` (`geradoEm` → `generatedAt`,
//   `iniciadaEm` → `startedAt`, `decididaEm` → `decidedAt`, `mudouEm` → `changedAt`);
// - a count of things in a state is named after the state: `vigentes` → `current`, `aConfirmar` →
//   `toConfirm`, `suaVez` → `yourTurn`; `porX` → `byX` (`porConta` → `byAccount`, `porEscopo` → `byScope`);
// - the recurring words: titulo → title, texto → text, rotulo → label, cor → color, fonte → source,
//   desde → since, ate → until, motivo → reason, estado → state, tipo → type, nome → name, modelo →
//   model, conta → account, sessao → session, itens → items, versao → version, pasta → folder,
//   numero → number, feitos/feitas → done, atual → current, proximo → next, dono → owner, pai →
//   parent, filhas → children, familia → family, erro → error (scoped: `error` at the top level is
//   the error response);
// - fixed values are lowercase English and keep the separator the old value had (`sua-vez` →
//   `your-turn`, `a_confirmar` → `to_confirm`); values that were already English stay as they are;
// - the decision scope is `session | family | branch`; a relation between sessions is `parent |
//   child | sibling`, and a decision's own session `this | parent | family | branch`.
//
// `GET /api/panel` (Painel, src/api/tipos.ts), keys old → new:
// - top: versao → version, geradoEm → generatedAt, sessao → session, contexto → context, custo →
//   cost, plano → plan, planos → plans, subagentes → subagents, filhas → children, trabalho → work,
//   precisam → needYou, decisoes → decisions (api, tokens, background, prs stay);
// - api: versao → version, pasta → folder, abreSessao → opensSession (commit stays);
//   tokens: entrada → input, saida → output; background: primeiro → first;
// - session: titulo → title, modelo → model, iniciadaEm → startedAt, estado → state, motivo →
//   reason, urgente → urgent, desde → since, turno → turn, atividade → activity, faixa → banner,
//   conta → account; activity: tipo → type, texto → text; banner: also rodape → footer, desde → since;
//   account: rotulo → label, cor → color, fonte → source;
// - context: usados → used, limite → limit, estouros → overflows, alerta → alert,
//   compactacoesManuais → manualCompactions, rotulo → label, agentes → agents (agenteId → agentId);
//   cost: serie → series, estimativa → estimate;
// - plan: feitos → done, atual → current, proximo → next, restantes → remaining, atualDono →
//   currentOwner, mudouEm → changedAt, passos → steps; steps: texto → text, textoAtivo → activeText,
//   estado → state, dono → owner; owner: tipo → type, nome → name, agenteId → agentId;
// - plans: numero → number, resultado → outcome, resumo → summary, feitos → done, atual →
//   current, inicio → start, fim → end;
// - subagents: ativos → active, itens → items; items: nome → name, tarefa → task, desde → since,
//   ate → until, pai → parent, onda → wave;
// - children: titulo → title, estado → state, motivo → reason, desde → since, fazendo → doing,
//   arquivada → archived;
// - work: semPush → notPushed, erro → error; issue: numero → number, titulo → title,
//   subIssues.feitas → done; pr: numero → number, estado → state, checks.falhas → failed,
//   checks.rodando → running;
// - needYou: suaVez → yourTurn, porConta → byAccount (conta → account), familia → family, maquina
//   → machine; each one: nivel → level, porque → why, titulo → title, estado → state, motivo →
//   reason, urgente → urgent, desde → since, texto → text, modelo → model, relacao → relation,
//   mesmoProjeto → sameProject, conta → account;
// - prs.itens → items: numero → number, titulo → title, sessao → session (titulo → title);
// - decisions: vigentes → current, aConfirmar → toConfirm, retomada → resume (de → from), lista → list;
// - the decision list (ListaDeDecisoes): escopo → scope, vigentes → current, aConfirmar →
//   toConfirm, itens → items, porEscopo → byScope;
// - a decision: rotulo → label, origem → origin, estado → state, titulo → title, texto → text,
//   contexto → context, desfazer → undo, nao → rejected, decididaPor → decidedBy, decididaEm →
//   decidedAt, confirmadaEm → confirmedAt, substituidaPor → supersededBy, sessao → session
//   (toolUseId stays); the /ui's card adds escopo → scope, substitui → supersedes, promovidaPara →
//   promotedTo, conversa → conversation (sessionId, branch, repo stay).
//
// Values, old → new:
// - atividade.tipo: ferramenta → tool, delegando → delegating, pergunta → question, permissao →
//   permission, erro → error, sua-vez → your-turn, interrompida → interrupted, concluida → completed,
//   abandonada → abandoned, ociosa → idle (prompt stays); faixa.tipo: the same three;
// - dono.tipo: principal → main, subagente → subagent, sessao → session;
// - planos.resultado: atual → current, concluido → completed, abandonado → abandoned;
// - filhas.estado: desconhecido → unknown (the inbox states were English already);
// - trabalho.pr.estado: rascunho → draft, aberto → open, mergeado → merged, fechado → closed;
//   ci: falhou → failed, rodando → running (ok stays); review: aprovado → approved, ajustes →
//   changes-requested, pendente → pending;
// - precisam.nivel: precisa → needs, sua-vez → your-turn; porque: permissao → permission, pergunta →
//   question, plano → plan, decisao → decision, erro → error, sua-vez → your-turn, interrompida →
//   interrupted (no-prompt stays); relacao: mae → parent, filha → child, irma → sibling;
// - escopo (and the keys of porEscopo, the `?scope=` / `?decisions=` values): sessao → session,
//   familia → family (branch stays);
// - decisão: origem pergunta → question, plano → plan, permissao → permission, correcao →
//   correction, sugerida → suggested; estado vigente → current, substituida → superseded,
//   a_confirmar → to_confirm, descartada → dismissed; desfazer confirmar → confirm, descartar →
//   dismiss, ajustar → adjust; decididaPor usuario → user, agente → agent; sessao esta → this,
//   mae → parent, familia → family (branch stays).
//
// Decision writes, `POST /api/decisions/<id>/(confirm|dismiss|adjust|undo)`: request `{ sessao, texto }`
// → `{ session, text }` (the new route reads the old keys too); response `{ decisao }` → `{ decision }`.
// `/open/<local>` answers `{ ok }` / `{ error }` as before: nothing to translate.
// ---------------------------------------------------------------------------------------------

const ACTIVITY_TYPES = {
  tool: 'ferramenta',
  delegating: 'delegando',
  question: 'pergunta',
  permission: 'permissao',
  error: 'erro',
  'your-turn': 'sua-vez',
  interrupted: 'interrompida',
  completed: 'concluida',
  abandoned: 'abandonada',
  idle: 'ociosa',
};
const OWNER_TYPES = { main: 'principal', subagent: 'subagente', session: 'sessao' };
const SCOPES = { session: 'sessao', family: 'familia' };
const SCOPE_ERRORS = { 'scope: session, family ou branch': 'escopo: sessao, familia ou branch' };

const SESSION_CARD_KEYS = { title: 'titulo', model: 'modelo', startedAt: 'iniciadaEm', state: 'estado', reason: 'motivo', urgent: 'urgente', since: 'desde', turn: 'turno', activity: 'atividade', banner: 'faixa', account: 'conta' };
const ACCOUNT_KEYS = { label: 'rotulo', color: 'cor', source: 'fonte' };

/** The session card (`SessaoDoPainel`) held by `parent`, with its activity, banner and account. */
const sessionCard = (parent: string): LegacyBodySpec => ({
  keys: {
    ...scoped(parent, SESSION_CARD_KEYS),
    ...scoped('activity', { type: 'tipo', text: 'texto' }),
    ...scoped('banner', { type: 'tipo', text: 'texto', footer: 'rodape', since: 'desde' }),
    ...scoped('account', ACCOUNT_KEYS),
  },
  values: { 'activity.type': ACTIVITY_TYPES, 'banner.type': ACTIVITY_TYPES },
});

/** The plan (`PlanoDoPainel`) held by `parent`, with its steps and owners. */
const plan = (parent: string): LegacyBodySpec => {
  const owner = { type: 'tipo', name: 'nome', agentId: 'agenteId' };
  return {
    keys: {
      ...scoped(parent, { done: 'feitos', current: 'atual', next: 'proximo', remaining: 'restantes', currentOwner: 'atualDono', changedAt: 'mudouEm', steps: 'passos' }),
      ...scoped('steps', { text: 'texto', activeText: 'textoAtivo', state: 'estado', owner: 'dono' }),
      ...scoped('owner', owner),
      ...scoped('currentOwner', owner),
    },
    values: { 'owner.type': OWNER_TYPES, 'currentOwner.type': OWNER_TYPES },
  };
};

const DECISION_KEYS = {
  label: 'rotulo',
  origin: 'origem',
  state: 'estado',
  title: 'titulo',
  text: 'texto',
  context: 'contexto',
  undo: 'desfazer',
  rejected: 'nao',
  decidedBy: 'decididaPor',
  decidedAt: 'decididaEm',
  confirmedAt: 'confirmadaEm',
  supersededBy: 'substituidaPor',
  session: 'sessao',
};
/** What the /ui's decision card (`DecisaoDaUi`) adds to the panel's. */
const DECISION_UI_KEYS = { scope: 'escopo', supersedes: 'substitui', promotedTo: 'promovidaPara', conversation: 'conversa' };

/** A decision (`DecisaoDoPainel`, or with `ui` the /ui's `DecisaoDaUi`) held by `parent` (an object, or an array of them). */
const decision = (parent: string, ui = false): LegacyBodySpec => ({
  keys: scoped(parent, ui ? { ...DECISION_KEYS, ...DECISION_UI_KEYS } : DECISION_KEYS),
  values: scoped<Readonly<Record<string, string>>>(parent, {
    origin: { question: 'pergunta', plan: 'plano', permission: 'permissao', correction: 'correcao', suggested: 'sugerida' },
    state: { current: 'vigente', superseded: 'substituida', to_confirm: 'a_confirmar', dismissed: 'descartada' },
    undo: { confirm: 'confirmar', dismiss: 'descartar', adjust: 'ajustar' },
    decidedBy: { user: 'usuario', agent: 'agente' },
    session: { this: 'esta', parent: 'mae', family: 'familia' },
    ...(ui ? { scope: SCOPES } : {}),
  }),
});

/** The decision list of a scope (`ListaDeDecisoes`), held by `parent` (`''` at the top level). */
const decisionList = (parent: string): LegacyBodySpec =>
  merge(
    {
      keys: scoped(parent, { scope: 'escopo', current: 'vigentes', toConfirm: 'aConfirmar', items: 'itens', byScope: 'porEscopo' }),
      values: { [`${parent}.scope`]: SCOPES, byScope: SCOPES },
      dictKeys: ['byScope'],
    },
    decision('items'),
  );

/** The panel (`Painel`), new → old: the whole body. */
const PANEL: LegacyBodySpec = merge(
  {
    keys: {
      version: 'versao',
      folder: 'pasta',
      opensSession: 'abreSessao',
      generatedAt: 'geradoEm',
      session: 'sessao',
      context: 'contexto',
      cost: 'custo',
      input: 'entrada',
      output: 'saida',
      first: 'primeiro',
      plan: 'plano',
      plans: 'planos',
      subagents: 'subagentes',
      children: 'filhas',
      work: 'trabalho',
      needYou: 'precisam',
      decisions: 'decisoes',
      // The context meter and the cost.
      used: 'usados',
      limit: 'limite',
      overflows: 'estouros',
      alert: 'alerta',
      manualCompactions: 'compactacoesManuais',
      agents: 'agentes',
      agentId: 'agenteId',
      series: 'serie',
      estimate: 'estimativa',
      // The plan history, the subagents and the children.
      number: 'numero',
      outcome: 'resultado',
      summary: 'resumo',
      done: 'feitos',
      current: 'atual',
      start: 'inicio',
      end: 'fim',
      active: 'ativos',
      items: 'itens',
      name: 'nome',
      task: 'tarefa',
      until: 'ate',
      parent: 'pai',
      wave: 'onda',
      doing: 'fazendo',
      archived: 'arquivada',
      // Work by branch: only `work.error` is the old `erro` (the top-level `error` is an error response).
      notPushed: 'semPush',
      'work.error': 'erro',
      'subIssues.done': 'feitas',
      'checks.failed': 'falhas',
      'checks.running': 'rodando',
      // Who needs you and the PRs.
      yourTurn: 'suaVez',
      byAccount: 'porConta',
      family: 'familia',
      machine: 'maquina',
      level: 'nivel',
      why: 'porque',
      relation: 'relacao',
      sameProject: 'mesmoProjeto',
      // The keys shared by the session card, the children, who needs you and the decisions.
      title: 'titulo',
      text: 'texto',
      label: 'rotulo',
      model: 'modelo',
      state: 'estado',
      reason: 'motivo',
      urgent: 'urgente',
      since: 'desde',
      account: 'conta',
      // The decisions line.
      'decisions.current': 'vigentes',
      toConfirm: 'aConfirmar',
      resume: 'retomada',
      from: 'de',
      list: 'lista',
    },
    values: {
      'children.state': { unknown: 'desconhecido' },
      outcome: { current: 'atual', completed: 'concluido', abandoned: 'abandonado' },
      'pr.state': { draft: 'rascunho', open: 'aberto', merged: 'mergeado', closed: 'fechado' },
      'pr.ci': { failed: 'falhou', running: 'rodando' },
      'pr.review': { approved: 'aprovado', 'changes-requested': 'ajustes', pending: 'pendente' },
      level: { needs: 'precisa', 'your-turn': 'sua-vez' },
      why: { permission: 'permissao', question: 'pergunta', plan: 'plano', decision: 'decisao', error: 'erro', 'your-turn': 'sua-vez', interrupted: 'interrompida' },
      relation: { parent: 'mae', child: 'filha', sibling: 'irma' },
    },
  },
  sessionCard('session'),
  plan('plan'),
  decisionList('list'),
);

/** A write on a decision: the response `{ decision }` and the old request body `{ sessao, texto }`. */
const DECISION_WRITE: LegacyRouteSpec = {
  response: merge(
    {
      keys: { '.decision': 'decisao' },
      values: {
        '.error': {
          'informe a sessão: { "session": "<id>" }': 'informe a sessão: { "sessao": "<id>" }',
          'escreva o ajuste: { "text": "…" }': 'escreva o ajuste: { "texto": "…" }',
        },
      },
    },
    decision('decision'),
  ),
  request: { keys: { '.sessao': 'session', '.texto': 'text' } },
};

/**
 * The spec of every old route. Empty is the identity: the layers that turn a route's keys English
 * fill its entry, and the goldens prove the old body did not move.
 */
export const LEGACY_BODIES: Readonly<Record<LegacyRoute, LegacyRouteSpec>> = {
  attention: {},
  changes: {},
  panel: { response: PANEL },
  open: {},
  // The wall's card keeps its keys until its layer; only the activity line is the panel's.
  wall: { response: { keys: scoped('atividade', { type: 'tipo', text: 'texto' }), values: { 'atividade.type': ACTIVITY_TYPES } } },
  events: {},
  load: {},
  sessions: {},
  // The Detail's top: the session card and the cost are the panel's.
  session: { response: merge(sessionCard('sessao'), { keys: scoped('custo', { series: 'serie', estimate: 'estimativa' }) }) },
  // The Detail's agents tab: the task progress is the panel's plan.
  'session/agents': { response: plan('tarefas') },
  'session/conversation': {},
  'session/events': {},
  'session/workflow': {},
  // The Detail's decisions tab: its scope, the counts by scope and the /ui's decision cards.
  'session/decisions': {
    response: merge(
      { values: { '.escopo': SCOPES, 'injecao.escopo': SCOPES, porEscopo: SCOPES, '.error': SCOPE_ERRORS }, dictKeys: ['porEscopo'] },
      decision('itens', true),
    ),
  },
  history: {},
  'decisions/scope': { response: merge(decisionList(''), { values: { '.error': SCOPE_ERRORS } }) },
  // The Decisions page: only the cards (`grupos[].itens[]`) are the panel's.
  decisions: { response: decision('itens', true) },
  'decision/confirm': DECISION_WRITE,
  'decision/dismiss': DECISION_WRITE,
  'decision/adjust': DECISION_WRITE,
  'decision/undo': DECISION_WRITE,
  // The promote keeps its own keys (`{ decisao, caminho }`, `{ rascunho }`, the body `{ sessao, … }`)
  // until its layer; the card inside is the /ui's decision.
  'decision/promote': { response: decision('decisao', true) },
  project: {},
  'project/move': {},
  'analytics/cost': {},
};

/** The old route a raw path (as it came, without the query) belongs to; null for any other path. */
export function legacyRouteOf(rawPathname: string): LegacyRoute | null {
  for (const [old, route] of LEGACY_PATHS) {
    const m = old.exec(rawPathname);
    if (m) return route(m);
  }
  return null;
}

const own = <T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

/** The entry of `map` for `key` inside `parent`: the scoped one first, then the global one. */
const pick = <T>(map: Readonly<Record<string, T>> | undefined, parent: string, key: string): T | undefined => own(map, `${parent}.${key}`) ?? own(map, key);

const listed = (list: readonly string[] | undefined, parent: string, key: string): boolean => !!list && (list.includes(`${parent}.${key}`) || list.includes(key));

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const isEmpty = (spec: LegacyBodySpec | undefined): boolean =>
  !spec || ((!spec.keys || Object.keys(spec.keys).length === 0) && (!spec.values || Object.keys(spec.values).length === 0) && !spec.dictKeys?.length && !spec.opaque?.length);

/** `node`, held by `key` inside an object whose own key is `parent`, translated by `spec`. */
function walk(spec: LegacyBodySpec, node: unknown, key: string, parent: string): unknown {
  if (typeof node === 'string') return own(pick(spec.values, parent, key), node) ?? node;
  // An array's items keep the array's key: an object inside it has the array's key as its parent.
  if (Array.isArray(node)) return node.map((item) => walk(spec, item, key, parent));
  if (!isPlainObject(node)) return node;
  if (!listed(spec.dictKeys, parent, key)) return walkObject(spec, node, key);
  const names = pick(spec.values, parent, key);
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [own(names, k) ?? k, walkDictChild(spec, v, key)]));
}

/** The children of a plain object whose own key is `key`. */
function walkObject(spec: LegacyBodySpec, node: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [pick(spec.keys, key, k) ?? k, listed(spec.opaque, key, k) ? v : walk(spec, v, k, key)]));
}

/** A value of a data-keyed dict: strings by `values['dict.*']`, objects with the dict's key as their parent. */
function walkDictChild(spec: LegacyBodySpec, node: unknown, dictKey: string): unknown {
  if (typeof node === 'string') return own(pick(spec.values, dictKey, '*'), node) ?? node;
  if (Array.isArray(node)) return node.map((item) => walkDictChild(spec, item, dictKey));
  return isPlainObject(node) ? walkObject(spec, node, dictKey) : node;
}

/** A whole body translated by `spec`; an empty spec gives back the same body. */
export function translateBody(spec: LegacyBodySpec | undefined, body: unknown): unknown {
  if (isEmpty(spec)) return body;
  return walk(spec!, body, '', '');
}

/**
 * The new → old translator of the response, when the request came through an old path (the raw
 * path, before `normalizeLegacyUrl`); null for the new routes and everything else.
 */
export function legacyResponseFor(rawPathname: string): ((body: unknown) => unknown) | null {
  const route = legacyRouteOf(rawPathname);
  if (!route) return null;
  const spec = LEGACY_BODIES[route].response;
  return (body) => translateBody(spec, body);
}

/** An old request body in the new names (old → new); any other route's body comes back as it is. */
export function legacyRequestBody(rawPathname: string, body: unknown): unknown {
  const route = legacyRouteOf(rawPathname);
  return route ? translateBody(LEGACY_BODIES[route].request, body) : body;
}

/** The raw path of a request (`req.url` without the query), as `legacyResponseFor` and `legacyRequestBody` take it. */
export function rawPathnameOf(rawUrl: string | undefined): string {
  return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
}
