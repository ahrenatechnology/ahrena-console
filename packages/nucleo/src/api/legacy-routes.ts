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
 * Fixed values that travel in the query, in English, translated to the values the handlers still
 * use (they also show up in the JSON, which changes in phase 2). The old values keep working as
 * they are.
 */
const ENGLISH_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  scope: { session: 'sessao', family: 'familia' },
  decisions: { session: 'sessao', family: 'familia' },
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

/**
 * The spec of every old route. All empty in phase 2b layer 1 (identity): the layers that turn a
 * route's keys English fill its entry, and the goldens prove the old body did not move.
 */
export const LEGACY_BODIES: Readonly<Record<LegacyRoute, LegacyRouteSpec>> = {
  attention: {},
  changes: {},
  panel: {},
  open: {},
  wall: {},
  events: {},
  load: {},
  sessions: {},
  session: {},
  'session/agents': {},
  'session/conversation': {},
  'session/events': {},
  'session/workflow': {},
  'session/decisions': {},
  history: {},
  'decisions/scope': {},
  decisions: {},
  'decision/confirm': {},
  'decision/dismiss': {},
  'decision/adjust': {},
  'decision/undo': {},
  'decision/promote': {},
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
