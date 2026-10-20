// The old Portuguese routes and query parameters of the API, as aliases of the English ones
// (issue #173, phase 1; decision 0009). This is the only place that knows them: the server runs
// `normalizeLegacyUrl` before routing, and every handler reads only the new names.
//
// They stay until the published mod (v0.0.30 calls `/api/painel/<id>` and `/abrir/<id>`) and the
// installed app (`/api/atencao`, `/api/mudancas`) migrate; phase 6 deletes this file. An old route
// answers exactly like the new one: same status, same body (JSON keys only change in phase 2).

/** Old path → new path. The id segments are kept as they came (still encoded). */
const LEGACY_PATHS: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/^\/api\/atencao$/, () => '/api/attention'],
  [/^\/api\/mudancas$/, () => '/api/changes'],
  [/^\/api\/(?:painel|sessao)\/([^/]+)$/, (m) => `/api/panel/${m[1]}`],
  [/^\/abrir\/([^/]+)$/, (m) => `/open/${m[1]}`],
  [/^\/api\/mural$/, () => '/api/wall'],
  [/^\/api\/eventos$/, () => '/api/events'],
  [/^\/api\/carga$/, () => '/api/load'],
  [/^\/api\/sessoes$/, () => '/api/sessions'],
  [/^\/api\/sessoes\/([^/]+)$/, (m) => `/api/sessions/${m[1]}`],
  [/^\/api\/sessoes\/([^/]+)\/(agentes|conversa|eventos|workflow)$/, (m) => `/api/sessions/${m[1]}/${LEGACY_SEGMENTS[m[2]!]}`],
  [/^\/api\/historico$/, () => '/api/history'],
  [/^\/api\/decisoes\/([^/]+)$/, (m) => `/api/decisions/${m[1]}`],
  [/^\/api\/decisoes\/([^/]+)\/(confirmar|descartar|ajustar|desfazer)$/, (m) => `/api/decisions/${m[1]}/${LEGACY_SEGMENTS[m[2]!]}`],
  [/^\/api\/projeto$/, () => '/api/project'],
  [/^\/api\/projeto\/mover$/, () => '/api/project/move'],
  [/^\/api\/analytics\/custo$/, () => '/api/analytics/cost'],
];

const LEGACY_SEGMENTS: Readonly<Record<string, string>> = {
  agentes: 'agents',
  conversa: 'conversation',
  eventos: 'events',
  workflow: 'workflow',
  confirmar: 'confirm',
  descartar: 'dismiss',
  ajustar: 'adjust',
  desfazer: 'undo',
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
};

/** The new path of an old one; any other path comes back as it is. */
export function normalizeLegacyPath(pathname: string): string {
  for (const [old, next] of LEGACY_PATHS) {
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
