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
  // Phase 2b layer 6: the Kanban view (`/api/kanban?view=`) and the Decisions page grouping
  // (`/api/decisions?groupBy=`) are English in the handlers; each parameter has only that one reader.
  view: { sessoes: 'sessions', agentes: 'agents' },
  groupBy: { familia: 'family', sessao: 'session' },
  // Phase 2b layer 7: the repository period is English in `/api/repos/<owner>/<repo>?period=` (no old
  // path; the old name `periodo` is global), and the year is `1y`.
  period: { '1a': '1y' },
  // Phase 2b layer 3: the change types are English in `/api/changes?type=` (src/changes/cursor.ts).
  type: { sessao: 'session', estado: 'state', 'precisa-de-voce': 'needs-you', plano: 'plan', decisao: 'decision', conta: 'account' },
};

const DECISION_STATE_FILTER_VALUES = { todas: 'all', vigentes: 'current', a_confirmar: 'to_confirm' };

/**
 * Query values that only one route knows, by the route's NEW path (a session id as `:id`, `routeKeyOf`):
 * a name as common as `status` or `order` means something else elsewhere (`/api/events?status=` takes `active|waiting|error|completed`
 * and must keep answering `?status=erro` with its 400), so these do not go global.
 */
const ENGLISH_VALUES_BY_PATH: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  // Phase 2b layer 4: the Sessions list filter and order are English in `/api/sessions?status=&order=`
  // (old alias `/api/sessoes`, which reaches here already as the new path); both value sets accepted.
  '/api/sessions': {
    status: { todas: 'all', ativas: 'active', esperando: 'waiting', concluidas: 'completed', erro: 'error', abandonadas: 'abandoned' },
    order: { atividade: 'activity', duracao: 'duration', custo: 'cost' },
  },
  // Phase 2b layer 5: the Workflows filter and graph node ids are English in `/api/workflows?filter=&node=`
  // (no old path; the old parameter names `filtro`/`no` are global); both value sets accepted.
  '/api/workflows': {
    filter: { todas: 'all', ativas: 'active', concluidas: 'completed' },
    node: {
      principal: 'main',
      'origem:prompt': 'origin:prompt',
      'origem:retomada': 'origin:resume',
      'compactacao:sem': 'compaction:none',
      'compactacao:compactou': 'compaction:compacted',
      'resultado:concluida': 'outcome:completed',
      'resultado:erro': 'outcome:error',
      'resultado:andamento': 'outcome:active',
      'resultado:abandonada': 'outcome:abandoned',
      // A subagent with no type: its old node was `subagente:subagente`.
      'subagente:subagente': 'subagent:subagent',
    },
  },
  // Phase 2b layer 6: the Kanban columns are English in `/api/kanban?column=` (no old path; the old
  // name `coluna` is global). The two views share `waiting` and `error`.
  '/api/kanban': {
    column: {
      ativa: 'active',
      esperando: 'waiting',
      concluida: 'completed',
      erro: 'error',
      abandonada: 'abandoned',
      trabalhando: 'working',
      concluidos: 'done',
    },
  },
  // Phase 2b layer 7: the "no account" filter of `/api/changes?account=` (old alias `/api/mudancas`)
  // is `no-account`; the other values are account ids (`<uuid>/<uuid>`), never these words.
  '/api/changes': { account: { 'sem-conta': 'no-account' } },
  // Phase 2b layer 6: the decision state filter is English on the Decisions page and the Detail's
  // decisions tab (`?state=`; old aliases `/api/decisoes` and `/api/sessoes/<id>/decisoes`).
  '/api/decisions': { state: DECISION_STATE_FILTER_VALUES },
  '/api/sessions/:id/decisions': { state: DECISION_STATE_FILTER_VALUES },
};

/** The key of a route in the maps by path: a session's id is `:id` (`/api/sessions/:id/decisions`). */
const routeKeyOf = (pathname: string): string => pathname.replace(/^\/api\/sessions\/[^/]+\/decisions$/, '/api/sessions/:id/decisions');

/**
 * Query values whose old prefix carries data after it, by the route's NEW path: an old graph node
 * `subagente:<type>` is `subagent:<type>` (the type is the subagent's own, kept as it came).
 */
const ENGLISH_PREFIXES_BY_PATH: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  '/api/workflows': { node: { 'subagente:': 'subagent:' } },
};

/** One query value in the names the handler reads: the exact map first, then an old prefix. */
function englishValue(value: string, values: Readonly<Record<string, string>> | undefined, prefixes: Readonly<Record<string, string>> | undefined): string {
  if (values && Object.hasOwn(values, value)) return values[value]!;
  for (const [old, next] of Object.entries(prefixes ?? {})) if (value.startsWith(old)) return next + value.slice(old.length);
  return value;
}

/** The new path of an old one; any other path comes back as it is. */
export function normalizeLegacyPath(pathname: string): string {
  for (const [old, , next] of LEGACY_PATHS) {
    const m = old.exec(pathname);
    if (m) return next(m);
  }
  return pathname;
}

/**
 * The query with the new parameter names and the values the handlers read. `pathname` is the route's
 * NEW path (after `normalizeLegacyPath`); it picks the values only that route knows.
 */
export function normalizeLegacyQuery(query: URLSearchParams, pathname = ''): URLSearchParams {
  const out = new URLSearchParams();
  const routeKey = routeKeyOf(pathname);
  const routeValues = Object.hasOwn(ENGLISH_VALUES_BY_PATH, routeKey) ? ENGLISH_VALUES_BY_PATH[routeKey] : undefined;
  const routePrefixes = Object.hasOwn(ENGLISH_PREFIXES_BY_PATH, pathname) ? ENGLISH_PREFIXES_BY_PATH[pathname] : undefined;
  for (const [name, value] of query) {
    const next = LEGACY_PARAMS[name];
    if (next !== undefined && query.has(next)) continue;
    const key = next ?? name;
    const values = routeValues?.[key] ?? ENGLISH_VALUES[key];
    const prefixes = routePrefixes?.[key];
    // A list parameter (`?type=sessao,estado`) has each of its values translated.
    out.append(key, values || prefixes ? value.split(',').map((v) => englishValue(v, values, prefixes)).join(',') : value);
  }
  return out;
}

/** The URL the router sees: new path and new query; `/ui`, `/mcp` and the hooks are left alone. */
export function normalizeLegacyUrl(url: URL): URL {
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/abrir/') && !url.pathname.startsWith('/open/')) return url;
  if (url.pathname.startsWith('/api/hooks')) return url;
  const out = new URL(url);
  out.pathname = normalizeLegacyPath(url.pathname);
  const query = normalizeLegacyQuery(url.searchParams, out.pathname);
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

// ---------------------------------------------------------------------------------------------
// The installed app and the live group (phase 2b layer 3): `GET /api/attention` (old `/api/atencao`)
// and `GET /api/changes` (old `/api/mudancas`), what the installed app reads; `GET /api/wall` (old
// `/api/mural`) and `GET /api/load` (old `/api/carga`). `/api/dashboard` and `/api/overview` have no
// old alias (the overview keeps `nome`/`versao` beside `name`/`version` until phase 6: servidor.ts).
//
// `GET /api/attention` (RespostaDaAtencao, src/api/rota-atencao.ts), keys old → new:
// - top: geradoEm → generatedAt, precisam → needs, suaVez → yourTurn, ativas → active, comErro →
//   withError, itens → items (cursor, total stay);
// - items: sessao → session, titulo → title, projeto → project, conta → account (rotulo → label,
//   cor → color), nivel → level, motivo → reason, motivoCurto → shortReason, motivoLongo →
//   longReason, desde → since, minutos → minutes (local stays);
// - values: nivel and motivo as the panel's `level` and `why` (precisa → needs, sua-vez → your-turn;
//   permissao → permission, pergunta → question, plano → plan, decisao → decision, erro → error,
//   interrompida → interrupted; no-prompt stays).
//
// `GET /api/changes` (WaitResult, src/changes/cursor.ts), keys old → new: mudancas → changes,
// reiniciar → reset, expirou → timedOut (cursor stays); each change: tipo → type, chave → key
// (sessionId, accountId, seq stay). The type values: sessao → session, estado → state,
// precisa-de-voce → needs-you, plano → plan, decisao → decision, conta → account (repos, alert and
// agent-instructions stay);
// `?type=` takes both (ENGLISH_VALUES). The errors cite the new parameter: `wait inválida`, `type: um
// de …`, `session inválida`, `account inválida`.
//
// `GET /api/wall` (Mural, src/api/tipos.ts), keys old → new: versao → version, geradoEm →
// generatedAt, contagem → count (todas → all, esperando → waiting, ativas → active); each card:
// titulo → title, projeto → project, estado → state, motivo → reason, urgente → urgent, desde →
// since, atividade → activity, modelo → model, esforco → effort, agentes → agents (ativos → active),
// custo → cost (estimativa → estimate), plano → plan (feitos → done, atual → current), contexto →
// context (usados → used, limite → limit, rotulo → label). The values were English already, but the
// activity types (the panel's).
//
// `GET /api/load` (servidor.ts and the extras of cli.ts), keys old → new: pedidos → requests, painel →
// panel, msPainel → panelMs, eventosLidos → eventsRead, esperasAbertas → openWaits, historico →
// history (pronto → ready, importando → importing, desligado → off), seguidor → follower, desktopLidos
// → desktopRead, trabalho → work.
// ---------------------------------------------------------------------------------------------

const ATTENTION_LEVELS = { needs: 'precisa', 'your-turn': 'sua-vez' };
const ATTENTION_REASONS = { permission: 'permissao', question: 'pergunta', plan: 'plano', decision: 'decisao', error: 'erro', 'your-turn': 'sua-vez', interrupted: 'interrompida' };

/** `GET /api/attention`, new → old. */
const ATTENTION: LegacyBodySpec = {
  keys: {
    ...scoped('', { generatedAt: 'geradoEm', needs: 'precisam', yourTurn: 'suaVez', active: 'ativas', withError: 'comErro', items: 'itens' }),
    ...scoped('items', {
      session: 'sessao',
      title: 'titulo',
      project: 'projeto',
      account: 'conta',
      level: 'nivel',
      reason: 'motivo',
      shortReason: 'motivoCurto',
      longReason: 'motivoLongo',
      since: 'desde',
      minutes: 'minutos',
    }),
    ...scoped('account', { label: 'rotulo', color: 'cor' }),
  },
  values: { 'items.level': ATTENTION_LEVELS, 'items.reason': ATTENTION_REASONS },
};

const CHANGE_TYPES = { session: 'sessao', state: 'estado', 'needs-you': 'precisa-de-voce', plan: 'plano', decision: 'decisao', account: 'conta' };

/** `GET /api/changes`, new → old, the errors that cite a parameter included. */
const CHANGES: LegacyBodySpec = {
  keys: {
    ...scoped('', { changes: 'mudancas', reset: 'reiniciar', timedOut: 'expirou' }),
    ...scoped('changes', { type: 'tipo', key: 'chave' }),
  },
  values: {
    'changes.type': CHANGE_TYPES,
    // Phase 2b layer 7: the `repos` change of the repository list. `key` mixes this fixed value with
    // data (session, decision and account ids, `<machine>:<alert>`, a repo's `owner/repo`), and the
    // value map rewrites any key that is exactly `list`. The accepted edge: a session whose id is
    // exactly `list` would read `lista` on the old route. Real session ids are UUIDs, alerts carry a
    // `:` and repos a `/`, so only a hand-made id can hit it.
    'changes.key': { list: 'lista' },
    '.error': {
      'session inválida': 'sessao inválida',
      'account inválida': 'conta inválida',
      'wait inválida': 'espera inválida',
      'type: um de session, state, needs-you, plan, decision, account, repos, alert, agent-instructions': 'tipo: um de sessao, estado, precisa-de-voce, plano, decisao, conta, repos, alert, agent-instructions',
    },
  },
};

/** `GET /api/wall`, new → old: the counts and the card, with the panel's activity line. */
const WALL: LegacyBodySpec = {
  keys: {
    ...scoped('', { version: 'versao', generatedAt: 'geradoEm', count: 'contagem' }),
    ...scoped('count', { all: 'todas', waiting: 'esperando', active: 'ativas' }),
    ...scoped('cards', {
      title: 'titulo',
      project: 'projeto',
      state: 'estado',
      reason: 'motivo',
      urgent: 'urgente',
      since: 'desde',
      activity: 'atividade',
      model: 'modelo',
      effort: 'esforco',
      agents: 'agentes',
      cost: 'custo',
      plan: 'plano',
      context: 'contexto',
    }),
    ...scoped('activity', { type: 'tipo', text: 'texto' }),
    ...scoped('agents', { active: 'ativos' }),
    ...scoped('cost', { estimate: 'estimativa' }),
    ...scoped('plan', { done: 'feitos', current: 'atual' }),
    ...scoped('context', { used: 'usados', limit: 'limite', label: 'rotulo' }),
  },
  values: { 'activity.type': ACTIVITY_TYPES },
};

/** `GET /api/load`, new → old (its golden holds only the key set: the counters move on their own). */
const LOAD: LegacyBodySpec = {
  keys: scoped('', {
    requests: 'pedidos',
    panel: 'painel',
    panelMs: 'msPainel',
    eventsRead: 'eventosLidos',
    openWaits: 'esperasAbertas',
    history: 'historico',
    follower: 'seguidor',
    desktopRead: 'desktopLidos',
    work: 'trabalho',
  }),
  values: { '.history': { ready: 'pronto', importing: 'importando', off: 'desligado' } },
  // The follower's stats and the work counters were English already.
  opaque: ['.follower', '.work'],
};

// ---------------------------------------------------------------------------------------------
// The activity feed, the Sessions list and the History (phase 2b layer 4): `GET /api/events` (old
// `/api/eventos`), `GET /api/sessions` (old `/api/sessoes`) and `GET /api/history` (old `/api/historico`).
//
// `GET /api/events` (RespostaDoFeed, src/api/eventos.ts), keys old → new:
// - top: eventos → events, anteriores → older, opcoes → options (cursor stays); options: tipos →
//   types, ferramentas → tools, sessoes → sessions;
// - each event: criadoEm → createdAt, tipo → type, ferramenta → tool, resumo → summary, sessao →
//   session, agente → agent, detalhe → detail (id, status stay); session (and options.sessions):
//   titulo → title, projeto → project; agent: nome → name; detail: entrada → input (callId stays);
// - values: agent.name principal → main, subagente → subagent (a subagent's type is data and stays);
//   the event status was English already;
// - errors cite the new parameter: `limit:`, `after:`, `before:`, `type:`, `session:`, `tool:`,
//   `search:`, `from:`, `to:` (`after e before não se combinam`, `from: depois do to`).
//
// `GET /api/sessions` (ListaDeSessoesHttp, src/api/sessoes.ts), keys old → new:
// - top: registradas → registered, pagina → page, porPagina → perPage, paginas → pages, diretorios →
//   directories, itens → items (total stays);
// - items: titulo → title, motivo → reason, ultimaAtividade → lastActivity, inicio → start, rodando
//   → running, duracaoMs → durationMs, agentes → agents, custoUsd → costUsd, conta → account (rotulo
//   → label, cor → color) (id, status, cwd stay; the status and reason values were English already);
// - query values (ENGLISH_VALUES_BY_PATH, this route only, both accepted): status todas → all,
//   ativas → active, esperando → waiting, concluidas → completed, erro → error, abandonadas →
//   abandoned; order atividade → activity, duracao → duration, custo → cost (direction stays);
// - errors cite the new parameter and values: `status: um de all, …`, `order: um de activity, …`,
//   `direction:`, `page:`, `search grande demais`.
//
// `GET /api/history` (HistoryResponse, src/history/reading.ts), keys old → new: dias → days,
// proximo → next; each day: dia → day, sessoes → sessions; each session: titulo → title, projeto →
// project, modelo → model, inicio → start, fim → end, duracaoMs → durationMs, custoUsd → costUsd,
// anterior → previous, seguinte → next (id, status stay); previous/next: titulo → title. Errors:
// `before:`, `days:`, `search:`.
// ---------------------------------------------------------------------------------------------

const FEED_SESSION_KEYS = { title: 'titulo', project: 'projeto' };

/** `GET /api/events`, new → old. */
const EVENTS: LegacyBodySpec = {
  keys: {
    ...scoped('', { events: 'eventos', older: 'anteriores', options: 'opcoes' }),
    ...scoped('options', { types: 'tipos', tools: 'ferramentas', sessions: 'sessoes' }),
    ...scoped('events', { createdAt: 'criadoEm', type: 'tipo', tool: 'ferramenta', summary: 'resumo', session: 'sessao', agent: 'agente', detail: 'detalhe' }),
    ...scoped('session', FEED_SESSION_KEYS),
    ...scoped('sessions', FEED_SESSION_KEYS),
    ...scoped('agent', { name: 'nome' }),
    ...scoped('detail', { input: 'entrada' }),
  },
  values: {
    // An accepted edge: `agent.name` mixes the fixed values main|subagent with data (a subagent's
    // type), so a subagent whose type is literally `main` or `subagent` reads as principal|subagente
    // on the old route.
    'agent.name': { main: 'principal', subagent: 'subagente' },
    '.error': {
      'limit: um inteiro de 1 a 200': 'limite: um inteiro de 1 a 200',
      'after e before não se combinam': 'depois e antes não se combinam',
      'after: cursor inválido': 'depois: cursor inválido',
      'before: cursor inválido': 'antes: cursor inválido',
      'type: só letras, números e _, até 64': 'tipo: só letras, números e _, até 64',
      'session: id de sessão inválido': 'sessao: id de sessão inválido',
      'tool: nome de ferramenta inválido': 'ferramenta: nome de ferramenta inválido',
      'search: sem quebras de linha nem caracteres de controle': 'busca: sem quebras de linha nem caracteres de controle',
      'search: até 100 caracteres': 'busca: até 100 caracteres',
      'from: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)': 'de: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)',
      'to: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)': 'ate: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)',
      'from: depois do to': 'de: depois do ate',
    },
  },
};

/** `GET /api/sessions`, new → old: the page, its rows and the errors that cite a parameter. */
const SESSIONS: LegacyBodySpec = {
  keys: {
    ...scoped('', { registered: 'registradas', page: 'pagina', perPage: 'porPagina', pages: 'paginas', directories: 'diretorios', items: 'itens' }),
    ...scoped('items', {
      title: 'titulo',
      reason: 'motivo',
      lastActivity: 'ultimaAtividade',
      start: 'inicio',
      running: 'rodando',
      durationMs: 'duracaoMs',
      agents: 'agentes',
      costUsd: 'custoUsd',
      account: 'conta',
    }),
    ...scoped('account', { label: 'rotulo', color: 'cor' }),
  },
  values: {
    '.error': {
      'status: um de all, active, waiting, completed, error, abandoned': 'status: um de todas, ativas, esperando, concluidas, erro, abandonadas',
      'order: um de activity, duration, cost': 'ordem: um de atividade, duracao, custo',
      'direction: um de desc, asc': 'sentido: um de desc, asc',
      'page: um inteiro a partir de 1': 'pagina: um inteiro a partir de 1',
      'search grande demais': 'busca grande demais',
    },
  },
};

/** `GET /api/history`, new → old. */
const HISTORY: LegacyBodySpec = {
  keys: {
    ...scoped('', { days: 'dias', next: 'proximo' }),
    ...scoped('days', { day: 'dia', sessions: 'sessoes' }),
    ...scoped('sessions', {
      title: 'titulo',
      project: 'projeto',
      model: 'modelo',
      start: 'inicio',
      end: 'fim',
      durationMs: 'duracaoMs',
      costUsd: 'custoUsd',
      previous: 'anterior',
      next: 'seguinte',
    }),
    ...scoped('previous', { title: 'titulo' }),
    ...scoped('next', { title: 'titulo' }),
  },
  values: {
    '.error': {
      'before: um dia AAAA-MM-DD': 'antes: um dia AAAA-MM-DD',
      'days: um inteiro de 1 a 31': 'dias: um inteiro de 1 a 31',
      'search: até 100 caracteres': 'busca: até 100 caracteres',
    },
  },
};

// ---------------------------------------------------------------------------------------------
// The session Detail and the workflows (phase 2b layer 5): `GET /api/sessions/<id>` (old
// `/api/sessoes/<id>`), its tabs `/agents`, `/conversation`, `/events` (old `/agentes`, `/conversa`,
// `/eventos`; src/api/detalhe.ts) and `/workflow`, and `GET /api/workflows` (no old path;
// src/api/workflows.ts). The decisions tab is layer 6's.
//
// `GET /api/sessions/<id>` (CabecaDoDetalhe), keys old → new: versao → version, geradoEm →
// generatedAt, sessao → session (the panel's session card), custo → cost (the panel's), abreSessao →
// opensSession, comando → command, encerradaEm → endedAt, contagens → counts (agentes → agents,
// eventos → events) (branch, local stay). Errors unchanged (`id de sessão inválido`, `o núcleo não
// conhece esta sessão`).
//
// `/agents` (AgentesDoDetalhe), keys old → new: numeros → numbers (eventos → events, porMinuto →
// perMinute, ferramentas → tools, ferramentasUnicas → uniqueTools, subagentes → subagents, compactacoes
// → compactions, erros → errors, duracaoMin → durationMin, rodando → running); ferramentas → tools
// (nome → name, n stays); tarefas → tasks (the panel's plan); tokens: cacheLido → cacheRead,
// cacheGravado → cacheWrite, entrada → input, saida → output (total stays); agentes → agents: tipo →
// type, nome → name, tarefa → task, modelo → model, turnos → turns, inicio → start, fim → end, custoUsd
// → costUsd, pai → parent (id, status stay). Values: agents.type principal → main, subagente → subagent.
//
// `/conversation` (ConversaDoDetalhe), keys old → new: agentes → agents (nome → name), agente → agent,
// mensagens → messages (total stays); each message: papel → role, em → at, texto → text, modelo →
// model, tokens (entrada → input, saida → output), ferramentas → tools; each tool: nome → name, resumo →
// summary, estado → state, entrada → input, resultado → result. Values: role voce → you, assistente →
// assistant; tool state erro → error, permissao → permission, rodando → running (ok stays). The message
// text and the tool summary, input and result are the session's DATA: opaque, never translated.
//
// `/events` (EventosDoDetalhe), keys old → new: filtrados → filtered, itens → items, proximo → next,
// opcoes → options (total stays); each item: em → at, tipo → type, ferramenta → tool, resumo → summary,
// agente → agent (nome → name), dados → data (id, status stay); options: tipos → types, ferramentas →
// tools, agentes → agents (nome → name) (status stays). The event types, tools and statuses were English
// already. The tab has no error that names a parameter: an invalid filter is ignored.
//
// `/workflow` (WorkflowDaSessao), keys old → new: sessaoId → sessionId, inicio → start, fim → end,
// duracaoMs → durationMs, resumo → summary, nos → nodes, arestas → edges, rodadasDeReview →
// reviewRounds, ajustes → changesRequested, linhaDoTempo → timeline; nodes: nome → name, tipo → type,
// rodada → round, tarefa → task, modelo → model, duracaoMs → durationMs, estado → state, ajustes →
// changesRequested, inicio → start, fim → end; edges: de → from, para → to, tipo → type, rotulo → label;
// timeline: inicio → start, fim → end, faixas → lanes (noId → nodeId, rotulo → label, trechos → spans:
// noId → nodeId, inicio → start, fim → end, estado → state). Values: node and span state ativo → active,
// concluido → completed, erro → error; edge type abriu → opened, entregou → delivered, ajustes →
// changes-requested (the PR review's word). The edge labels (`plano`, `diff`, `ajustes`) are screen text.
//
// `GET /api/workflows` (RespostaDosWorkflows), no old path, keys old → new: filtro → filter, no → node,
// geradoEm → generatedAt, sessoes → sessions, truncado → truncated, maximo → max, grafo → graph (kpis,
// runs stay); kpis: profundidadeMedia → averageDepth, subagentesPorSessao → subagentsPerSession,
// sucessoSubagentes → subagentSuccess, fluxoComum → commonFlow (rotulo → label, fracao → fraction),
// rodadasPorPr → roundsPerPr, duracaoMediaMs → averageDurationMs; runs: nome → name, estado → state,
// modelo → model, projeto → project, sessaoId → sessionId, ferramentas → tools, duracaoMs → durationMs,
// inicio → start, fim → end, fases → phases (nome → name), volta → loop, agentes → agents (rotulo →
// label, tipo → type, fase → phase, estado → state, ajustes → changesRequested, ferramentas → tools,
// duracaoMs → durationMs); graph: colunas → columns (rotulo → label), nos → nodes (coluna → column,
// rotulo → label), arestas → edges (de → from, para → to). Values: filter todas → all, ativas →
// active, concluidas → completed; run state ativa → active, concluida → completed, erro → error; run
// agent state concluido → completed, rodando → running, ajustes → changes-requested, erro → error;
// column ids origem → origin, principal → main, subagente → subagent, compactacao → compaction,
// resultado → outcome; node ids origem:prompt → origin:prompt, origem:retomada → origin:resume,
// principal → main, compactacao:sem → compaction:none, compactacao:compactou → compaction:compacted,
// resultado:concluida|erro|andamento|abandonada → outcome:completed|error|active|abandoned,
// subagente:<type> → subagent:<type>. `?filter=` and `?node=` take both (ENGLISH_VALUES_BY_PATH and
// ENGLISH_PREFIXES_BY_PATH); the errors cite the new names: `filter: all, active ou completed`, `node: um
// id de nó do grafo (ex.: subagent:Explore)`.
// ---------------------------------------------------------------------------------------------

const AGENT_NAME = { name: 'nome' };

/** `GET /api/sessions/<id>`, new → old: the top, with the panel's session card and cost. */
const SESSION_TOP: LegacyBodySpec = merge(
  {
    keys: {
      ...scoped('', {
        version: 'versao',
        generatedAt: 'geradoEm',
        session: 'sessao',
        cost: 'custo',
        opensSession: 'abreSessao',
        command: 'comando',
        endedAt: 'encerradaEm',
        counts: 'contagens',
      }),
      ...scoped('counts', { agents: 'agentes', events: 'eventos' }),
      ...scoped('cost', { series: 'serie', estimate: 'estimativa' }),
    },
  },
  sessionCard('session'),
);

/** `/api/sessions/<id>/agents`, new → old: the numbers, the tools, the panel's plan, the tokens and the agent tree. */
const SESSION_AGENTS: LegacyBodySpec = merge(
  {
    keys: {
      ...scoped('', { numbers: 'numeros', tools: 'ferramentas', tasks: 'tarefas', agents: 'agentes' }),
      ...scoped('numbers', {
        events: 'eventos',
        perMinute: 'porMinuto',
        tools: 'ferramentas',
        uniqueTools: 'ferramentasUnicas',
        subagents: 'subagentes',
        compactions: 'compactacoes',
        errors: 'erros',
        durationMin: 'duracaoMin',
        running: 'rodando',
      }),
      ...scoped('tools', AGENT_NAME),
      ...scoped('tokens', { cacheRead: 'cacheLido', cacheWrite: 'cacheGravado', input: 'entrada', output: 'saida' }),
      ...scoped('agents', { type: 'tipo', name: 'nome', task: 'tarefa', model: 'modelo', turns: 'turnos', start: 'inicio', end: 'fim', costUsd: 'custoUsd', parent: 'pai' }),
    },
    values: { 'agents.type': { main: 'principal', subagent: 'subagente' } },
  },
  plan('tasks'),
);

/** `/api/sessions/<id>/conversation`, new → old; what the session said and ran is data. */
const SESSION_CONVERSATION: LegacyBodySpec = {
  keys: {
    ...scoped('', { agents: 'agentes', agent: 'agente', messages: 'mensagens' }),
    ...scoped('agents', AGENT_NAME),
    ...scoped('messages', { role: 'papel', at: 'em', text: 'texto', model: 'modelo', tools: 'ferramentas' }),
    ...scoped('tokens', { input: 'entrada', output: 'saida' }),
    ...scoped('tools', { name: 'nome', summary: 'resumo', state: 'estado', input: 'entrada', result: 'resultado' }),
  },
  values: {
    'messages.role': { you: 'voce', assistant: 'assistente' },
    'tools.state': { error: 'erro', permission: 'permissao', running: 'rodando' },
  },
  opaque: ['messages.text', 'tools.summary', 'tools.input', 'tools.result'],
};

/** `/api/sessions/<id>/events`, new → old: the page of the timeline and its filter options. */
const SESSION_EVENTS: LegacyBodySpec = {
  keys: {
    ...scoped('', { filtered: 'filtrados', items: 'itens', next: 'proximo', options: 'opcoes' }),
    ...scoped('items', { at: 'em', type: 'tipo', tool: 'ferramenta', summary: 'resumo', agent: 'agente', data: 'dados' }),
    ...scoped('agent', AGENT_NAME),
    ...scoped('options', { types: 'tipos', tools: 'ferramentas', agents: 'agentes' }),
    ...scoped('agents', AGENT_NAME),
  },
  opaque: ['items.summary', 'items.data'],
};

const WORKFLOW_NODE_STATES = { active: 'ativo', completed: 'concluido', error: 'erro' };

/** `/api/sessions/<id>/workflow`, new → old: the agents' graph, the review loop and the timeline. */
const SESSION_WORKFLOW: LegacyBodySpec = {
  keys: {
    ...scoped('', {
      sessionId: 'sessaoId',
      start: 'inicio',
      end: 'fim',
      durationMs: 'duracaoMs',
      summary: 'resumo',
      nodes: 'nos',
      edges: 'arestas',
      reviewRounds: 'rodadasDeReview',
      changesRequested: 'ajustes',
      timeline: 'linhaDoTempo',
    }),
    ...scoped('nodes', {
      name: 'nome',
      type: 'tipo',
      round: 'rodada',
      task: 'tarefa',
      model: 'modelo',
      durationMs: 'duracaoMs',
      state: 'estado',
      changesRequested: 'ajustes',
      start: 'inicio',
      end: 'fim',
    }),
    ...scoped('edges', { from: 'de', to: 'para', type: 'tipo', label: 'rotulo' }),
    ...scoped('timeline', { start: 'inicio', end: 'fim', lanes: 'faixas' }),
    ...scoped('lanes', { nodeId: 'noId', label: 'rotulo', spans: 'trechos' }),
    ...scoped('spans', { nodeId: 'noId', start: 'inicio', end: 'fim', state: 'estado' }),
  },
  values: {
    'nodes.state': WORKFLOW_NODE_STATES,
    'spans.state': WORKFLOW_NODE_STATES,
    'edges.type': { opened: 'abriu', delivered: 'entregou', 'changes-requested': 'ajustes' },
  },
};

// ---------------------------------------------------------------------------------------------
// The Decisions of the /ui and the GitHub Project kanban (phase 2b layer 6): `GET /api/decisions` (old
// `/api/decisoes`), `GET /api/sessions/<id>/decisions` (old `/api/sessoes/<id>/decisoes`), `POST
// /api/decisions/<id>/promote` (old `/promover`; src/api/decisoes-ui.ts), `GET /api/project` and `POST
// /api/project/move` (old `/api/projeto` and `/api/projeto/mover`; src/api/projeto.ts). `GET /api/kanban`
// (src/api/kanban.ts) has no old path: its body simply turned English (only its old query values map).
//
// `GET /api/decisions` (DecisoesDaPagina), keys old → new: agrupar → groupBy, estado → state, contagens
// → counts (vigentes → current, aConfirmar → toConfirm, substituidas30d → superseded30d, promovidas →
// promoted; branches stays), grupos → groups (chave → key, tipo → type, titulo → title, pasta → folder,
// vigentes → current, aConfirmar → toConfirm, itens → items, mais → more; repo, total stay); the items
// are the /ui's decision cards (layer 2) (q stays). Values: groupBy and groups.type familia → family,
// sessao → session (branch stays); state todas → all, vigentes → current, a_confirmar → to_confirm.
// `?groupBy=` and `?state=` take both (ENGLISH_VALUES, ENGLISH_VALUES_BY_PATH). Errors cite the new
// parameter: `groupBy: branch, family ou session`, `state: all, current ou to_confirm`, `group inválido`
// (`busca de até 200 caracteres` is about `q` and stays).
//
// `GET /api/sessions/<id>/decisions` (DecisoesDaAba), keys old → new: sessao → session, escopo → scope,
// estado → state, porEscopo → byScope, itens → items (the /ui's decision cards), injecao → injection
// (ligada → enabled, escopo → scope, decisoes → decisions, texto → text; tokens stays), mcp (ferramenta →
// tool, existe → exists, chamada → call, resposta → response) (q, total stay). Values: the scopes as the
// panel's, state as the page's. `mcp.call` is screen text (the call the tool will answer) and stays.
//
// `POST /api/decisions/<id>/promote`: request `{ sessao, confirmar, caminho, hash }` → `{ session,
// confirm, path, hash }` (the new route reads the old keys too); response 200 `{ rascunho: { caminho,
// markdown, hash, repo, podeGravar, motivo } }` → `{ draft: { path, markdown, hash, repo, canWrite,
// reason } }`, 201 `{ decisao, caminho }` → `{ decision, path }` (the /ui's decision card). Errors that
// name a body key: `informe a sessão: { "session": "<id>" }`, `informe o path: "docs/decisoes/…"`.
//
// `GET /api/project` (QuadroDoProjeto), keys old → new: projeto → project (dono → owner, numero →
// number, titulo → title, campo → field; url stays), raias → lanes (nome → name, cor → color; id, cards
// stay), marcos → milestones, lidoEm → fetchedAt, desatualizado → stale, motivo → reason, fonte →
// source (total stays); each card: tipo → type, tipoDaIssue → issueType, numero → number, titulo →
// title, estado → state, marco → milestone, subIssues.feitas → done, pr.numero → number, raiaId →
// laneId (itemId, url, repo stay). Values: pr.ci falhou → failed, rodando → running (ok stays);
// pr.review aprovado → approved, ajustes → changes-requested, pendente → pending (the panel's). The
// card type, the issue type and the state are GitHub's and stay.
// Errors (both routes): codigo → code, comando → command, variavel → variable; code invalido → invalid,
// sem-escopo → no-scope, limitado → rate-limited, raia-desconhecida → unknown-lane, item-desconhecido →
// unknown-item, github-fora → github-down, github-recusou → github-refused, desligado → off, sem-projeto
// → no-project. The `error` texts name no Portuguese parameter and stay.
// `POST /api/project/move` (body `{ itemId, optionId }`, English already): response quadro → board (the
// project's), movido → moved (de → from, para → to; itemId stays).
//
// `GET /api/kanban` (KanbanHttp), no old path, keys old → new: visao → view, porPagina → perPage,
// colunas → columns (rotulo → label, pagina → page, temMais → hasMore, itens → items; id, total stay);
// the session card as the Sessions list row (titulo → title, motivo → reason, ultimaAtividade →
// lastActivity, inicio → start, rodando → running, duracaoMs → durationMs, agentes → agents, custoUsd →
// costUsd, conta → account { label, color }) plus ultimoPrompt → lastPrompt, modelo → model; the agent
// card: sessaoId → sessionId, principal → main, nome → name, descricao → description, motivo → reason,
// modelo → model, inicio → start, ultimaAtividade → lastActivity, rodando → running, duracaoMs →
// durationMs. Values: view sessoes → sessions, agentes → agents; column ativa → active, esperando →
// waiting, concluida → completed, erro → error, abandonada → abandoned, trabalhando → working,
// concluidos → done. Errors: `view:`, `column:`, `page:`.
// ---------------------------------------------------------------------------------------------

const GROUPINGS = { family: 'familia', session: 'sessao' };
const STATE_FILTERS = { all: 'todas', current: 'vigentes', to_confirm: 'a_confirmar' };
const STATE_FILTER_ERRORS = { 'state: all, current ou to_confirm': 'estado: todas, vigentes ou a_confirmar' };
const PR_CI = { failed: 'falhou', running: 'rodando' };
const PR_REVIEW = { approved: 'aprovado', 'changes-requested': 'ajustes', pending: 'pendente' };

/** `GET /api/decisions`, new → old: the page, its groups and the /ui's decision cards. */
const DECISIONS_PAGE: LegacyBodySpec = merge(
  {
    keys: {
      ...scoped('', { groupBy: 'agrupar', state: 'estado', counts: 'contagens', groups: 'grupos' }),
      ...scoped('counts', { current: 'vigentes', toConfirm: 'aConfirmar', superseded30d: 'substituidas30d', promoted: 'promovidas' }),
      ...scoped('groups', { key: 'chave', type: 'tipo', title: 'titulo', folder: 'pasta', current: 'vigentes', toConfirm: 'aConfirmar', items: 'itens', more: 'mais' }),
    },
    values: {
      '.groupBy': GROUPINGS,
      'groups.type': GROUPINGS,
      '.state': STATE_FILTERS,
      '.error': { ...STATE_FILTER_ERRORS, 'groupBy: branch, family ou session': 'agrupar: branch, familia ou sessao', 'group inválido': 'grupo inválido' },
    },
  },
  decision('items', true),
);

/** `GET /api/sessions/<id>/decisions`, new → old: the tab, its scope counts, the injection and MCP cards and the decision cards. */
const SESSION_DECISIONS: LegacyBodySpec = merge(
  {
    keys: {
      ...scoped('', { session: 'sessao', scope: 'escopo', state: 'estado', byScope: 'porEscopo', items: 'itens', injection: 'injecao' }),
      ...scoped('injection', { enabled: 'ligada', scope: 'escopo', decisions: 'decisoes', text: 'texto' }),
      ...scoped('mcp', { tool: 'ferramenta', exists: 'existe', call: 'chamada', response: 'resposta' }),
    },
    values: { '.scope': SCOPES, 'injection.scope': SCOPES, byScope: SCOPES, '.state': STATE_FILTERS, '.error': { ...SCOPE_ERRORS, ...STATE_FILTER_ERRORS } },
    dictKeys: ['byScope'],
  },
  decision('items', true),
);

/** `POST /api/decisions/<id>/promote`: the draft or the promoted card, and the old body `{ sessao, confirmar, caminho }`. */
const DECISION_PROMOTE: LegacyRouteSpec = {
  response: merge(
    {
      keys: {
        ...scoped('', { draft: 'rascunho', decision: 'decisao', path: 'caminho' }),
        ...scoped('draft', { path: 'caminho', canWrite: 'podeGravar', reason: 'motivo' }),
      },
      values: {
        '.error': {
          'informe a sessão: { "session": "<id>" }': 'informe a sessão: { "sessao": "<id>" }',
          'informe o path: "docs/decisoes/NNNN-slug.md"': 'informe o caminho: "docs/decisoes/NNNN-slug.md"',
        },
      },
    },
    decision('decision', true),
  ),
  request: { keys: { '.sessao': 'session', '.confirmar': 'confirm', '.caminho': 'path' } },
};

/** The project board (`QuadroDoProjeto`) held by `parent` (`''` at the top level), with its lanes and cards. */
const projectBoard = (parent: string): LegacyBodySpec => ({
  keys: {
    ...scoped(parent, { project: 'projeto', lanes: 'raias', milestones: 'marcos', fetchedAt: 'lidoEm', stale: 'desatualizado', reason: 'motivo', source: 'fonte' }),
    ...scoped('project', { owner: 'dono', number: 'numero', title: 'titulo', field: 'campo' }),
    ...scoped('lanes', { name: 'nome', color: 'cor' }),
    ...scoped('cards', { type: 'tipo', issueType: 'tipoDaIssue', number: 'numero', title: 'titulo', state: 'estado', milestone: 'marco', laneId: 'raiaId' }),
    ...scoped('subIssues', { done: 'feitas' }),
    ...scoped('pr', { number: 'numero' }),
  },
  values: { 'pr.ci': PR_CI, 'pr.review': PR_REVIEW },
});

/** The errors of the two project routes: `{ error, code, command?, variable? }`. */
const PROJECT_ERRORS: LegacyBodySpec = {
  keys: scoped('', { code: 'codigo', command: 'comando', variable: 'variavel' }),
  values: {
    '.code': {
      invalid: 'invalido',
      'no-scope': 'sem-escopo',
      'rate-limited': 'limitado',
      'unknown-lane': 'raia-desconhecida',
      'unknown-item': 'item-desconhecido',
      'github-down': 'github-fora',
      'github-refused': 'github-recusou',
      off: 'desligado',
      'no-project': 'sem-projeto',
    },
  },
};

/** `GET /api/project`, new → old. */
const PROJECT: LegacyBodySpec = merge(projectBoard(''), PROJECT_ERRORS);

/** `POST /api/project/move`, new → old: `{ board, moved }` (the body `{ itemId, optionId }` was English already). */
const PROJECT_MOVE: LegacyBodySpec = merge(
  { keys: { ...scoped('', { board: 'quadro', moved: 'movido' }), ...scoped('moved', { from: 'de', to: 'para' }) } },
  projectBoard('board'),
  PROJECT_ERRORS,
);

// ---------------------------------------------------------------------------------------------
// The Analytics cost (phase 2b layer 7): `GET /api/analytics/cost` (old `/api/analytics/custo`).
// `/api/analytics` (the Overview) has no old path, so its body is simply English.
//
// Keys old → new: geradoEm → generatedAt, fusoHorario → timeZone, dias → days, hoje → today, desde →
// since, ate → until, estimativa → estimate, moeda → currency, contas → accounts (rotulo → label, cor →
// color), resumoDeHoje → todaySummary (sessoes → sessions, porConta → byAccount), periodo → period
// (mediaPorDia → dailyAverage), semPreco → unpriced ({ modelos → models, totalDeTokens → totalTokens }
// at the top, the list of models in an account row), porDia → byDay, pico → peak (dia → day), porModelo
// → byModel (modelo → model, totalDeTokens → totalTokens), porProjeto → byProject (projeto → project),
// porConta → byAccount (conta → account, rotulo → label, cor → color, semPreco → unpriced, porDia →
// byDay). Dates, model names and projects are data and never translated. The errors cite `days:`/`tz:`.
// ---------------------------------------------------------------------------------------------

/** The account split row of the cost, in `todaySummary.byAccount` and the top `byAccount`. */
const COST_ACCOUNT_ROW = { account: 'conta', label: 'rotulo', color: 'cor', unpriced: 'semPreco', byDay: 'porDia' };

/** `GET /api/analytics/cost`, new → old. */
const ANALYTICS_COST: LegacyBodySpec = {
  keys: {
    ...scoped('', {
      generatedAt: 'geradoEm',
      timeZone: 'fusoHorario',
      days: 'dias',
      today: 'hoje',
      since: 'desde',
      until: 'ate',
      estimate: 'estimativa',
      currency: 'moeda',
      accounts: 'contas',
      todaySummary: 'resumoDeHoje',
      period: 'periodo',
      unpriced: 'semPreco',
      byDay: 'porDia',
      peak: 'pico',
      byModel: 'porModelo',
      byProject: 'porProjeto',
      byAccount: 'porConta',
    }),
    ...scoped('accounts', { label: 'rotulo', color: 'cor' }),
    ...scoped('todaySummary', { sessions: 'sessoes', byAccount: 'porConta' }),
    ...scoped('byAccount', COST_ACCOUNT_ROW),
    ...scoped('period', { dailyAverage: 'mediaPorDia' }),
    ...scoped('unpriced', { models: 'modelos', totalTokens: 'totalDeTokens' }),
    ...scoped('byDay', { day: 'dia' }),
    ...scoped('peak', { day: 'dia' }),
    ...scoped('byModel', { model: 'modelo', totalTokens: 'totalDeTokens' }),
    ...scoped('byProject', { project: 'projeto' }),
  },
  values: {
    '.error': {
      // `DAYS_ERROR` and `TZ_ERROR` of src/api/rota-analytics.ts (a test derives them from `DIAS_DO_CUSTO`).
      'days: 7, 30 ou 90': 'dias: 7, 30 ou 90',
      'tz: um fuso IANA, como America/Sao_Paulo': 'fuso: um fuso IANA, como America/Sao_Paulo',
    },
  },
};

/**
 * The spec of every old route. Empty is the identity: the layers that turn a route's keys English
 * fill its entry, and the goldens prove the old body did not move.
 */
export const LEGACY_BODIES: Readonly<Record<LegacyRoute, LegacyRouteSpec>> = {
  attention: { response: ATTENTION },
  changes: { response: CHANGES },
  panel: { response: PANEL },
  open: {},
  wall: { response: WALL },
  events: { response: EVENTS },
  load: { response: LOAD },
  sessions: { response: SESSIONS },
  session: { response: SESSION_TOP },
  'session/agents': { response: SESSION_AGENTS },
  'session/conversation': { response: SESSION_CONVERSATION },
  'session/events': { response: SESSION_EVENTS },
  'session/workflow': { response: SESSION_WORKFLOW },
  'session/decisions': { response: SESSION_DECISIONS },
  history: { response: HISTORY },
  'decisions/scope': { response: merge(decisionList(''), { values: { '.error': SCOPE_ERRORS } }) },
  decisions: { response: DECISIONS_PAGE },
  'decision/confirm': DECISION_WRITE,
  'decision/dismiss': DECISION_WRITE,
  'decision/adjust': DECISION_WRITE,
  'decision/undo': DECISION_WRITE,
  'decision/promote': DECISION_PROMOTE,
  project: { response: PROJECT },
  'project/move': { response: PROJECT_MOVE },
  'analytics/cost': { response: ANALYTICS_COST },
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
