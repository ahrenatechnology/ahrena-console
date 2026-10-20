// The golden cases of the old Portuguese routes (issue #173, phase 2b): every old path, with the old
// parameters and the old request bodies, in a fixed order (the writes change the state the later
// reads see). `record-legacy-goldens.ts` ran them once, on the code before any JSON key changed, and
// `legacy-golden.test.ts` replays them on every layer. Do not reorder, remove or edit a case: the
// stored goldens follow this list one to one.
//
// A path or body may carry `{session}`, `{local}`, `{decision}` (the suggested decision of p9, to be
// confirmed), `{current}` (a decision in force), `{cursor}` (the change cursor of an earlier answer),
// `{item}` and `{option}` (a project card and a lane it is not in), `{recordPath}` and `{recordHash}`
// (a promote draft): they are filled in at run time, from earlier answers, and stored unfilled. New
// cases are only ever appended (with their golden recorded on the code of phase 2b layer 1).
import { DEMO_ALIAS, DEMO_SESSION, LOCAL, type LegacyDemo } from './legacy-demo.ts';

export interface GoldenCase {
  name: string;
  method?: 'GET' | 'POST';
  path: string;
  /** JSON request body (POST). A string is sent as it is. */
  body?: unknown;
  /** `content-type` of the POST; default `application/json`. */
  contentType?: string;
  /** Answers that move on their own (load counters): only the status and the key set are stored. */
  keysOnly?: boolean;
  /** Runs on the server before the request (state that no route can set). */
  prepare?: (demo: LegacyDemo) => void;
  /** Placeholders this answer fills for the cases after it. */
  capture?: (body: unknown) => Record<string, string>;
}

export interface GoldenRecord {
  name: string;
  request: { method: string; path: string; body?: unknown };
  status: number;
  contentType: string | null;
  location?: string | null;
  /** The body: parsed JSON, or the text when it is not JSON; with `keysOnly`, the sorted keys. */
  body: unknown;
}

type Decision = { id: string; estado: string };
const decisionsOf = (body: unknown): Decision[] => ((body as { itens?: Decision[] }).itens ?? []);

const s = DEMO_SESSION;
const post = (name: string, path: string, body?: unknown, extra: Partial<GoldenCase> = {}): GoldenCase => ({ name, method: 'POST', path, body, ...extra });

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // Panel (the published mod), both old paths.
  { name: 'panel', path: `/api/painel/${s}` },
  { name: 'panel-with-params', path: `/api/painel/${s}?conta=c1&modelo=claude-opus-5-5&decisoes=familia` },
  { name: 'panel-decisions-session', path: `/api/painel/${s}?decisoes=sessao` },
  { name: 'panel-via-session-alias', path: `/api/sessao/${s}` },
  { name: 'panel-invalid-id', path: '/api/painel/a%20b' },
  // Decisions of a scope.
  {
    name: 'scope-decisions-family',
    path: `/api/decisoes/${s}?escopo=familia`,
    capture: (b) => ({ decision: decisionsOf(b).find((d) => d.estado === 'a_confirmar')!.id, current: decisionsOf(b).find((d) => d.estado === 'vigente')!.id }),
  },
  { name: 'scope-decisions-default', path: `/api/decisoes/${s}` },
  { name: 'scope-decisions-session', path: `/api/decisoes/${s}?escopo=sessao` },
  { name: 'scope-decisions-branch', path: `/api/decisoes/${s}?escopo=branch` },
  { name: 'scope-decisions-invalid-scope', path: `/api/decisoes/${s}?escopo=nada` },
  { name: 'scope-decisions-invalid-id', path: '/api/decisoes/a%20b' },
  // The installed app.
  { name: 'attention', path: '/api/atencao' },
  { name: 'changes-no-cursor', path: '/api/mudancas?espera=0', capture: (b) => ({ cursor: (b as { cursor: string }).cursor }) },
  { name: 'changes-empty-since', path: '/api/mudancas?desde=&espera=0' },
  { name: 'changes-since-cursor', path: '/api/mudancas?desde={cursor}&espera=0' },
  { name: 'changes-unknown-cursor', path: '/api/mudancas?desde=nada&espera=0&tipo=sessao' },
  { name: 'changes-invalid-type', path: '/api/mudancas?espera=0&tipo=nada' },
  { name: 'changes-invalid-wait', path: '/api/mudancas?espera=x' },
  // Wall, events, load.
  { name: 'wall', path: '/api/mural' },
  { name: 'events', path: '/api/eventos' },
  { name: 'events-filtered', path: '/api/eventos?limite=5&tipo=PreToolUse' },
  { name: 'events-by-session', path: `/api/eventos?sessao=${s}&busca=a&de=2026-01-01&ate=2026-12-31` },
  { name: 'events-invalid-limit', path: '/api/eventos?limite=0' },
  { name: 'load', path: '/api/carga', keysOnly: true },
  // Sessions and the Detail.
  { name: 'sessions', path: '/api/sessoes' },
  { name: 'sessions-filtered', path: '/api/sessoes?status=esperando&ordem=custo&sentido=asc&pagina=1&busca=a' },
  { name: 'sessions-search-order', path: '/api/sessoes?busca=&ordem=duracao&sentido=desc&pagina=2' },
  { name: 'sessions-invalid-order', path: '/api/sessoes?ordem=nada' },
  { name: 'session-detail', path: `/api/sessoes/${s}` },
  { name: 'session-unknown', path: '/api/sessoes/nao-existe' },
  { name: 'session-agents', path: `/api/sessoes/${s}/agentes` },
  { name: 'session-conversation', path: `/api/sessoes/${s}/conversa` },
  { name: 'session-conversation-limit', path: `/api/sessoes/${s}/conversa?limite=2` },
  { name: 'session-conversation-agent', path: `/api/sessoes/${s}/conversa?agente=qualquer` },
  { name: 'session-events', path: `/api/sessoes/${s}/eventos` },
  { name: 'session-events-filtered', path: `/api/sessoes/${s}/eventos?limite=3&tipo=PreToolUse` },
  { name: 'session-workflow', path: `/api/sessoes/${s}/workflow` },
  { name: 'session-decisions', path: `/api/sessoes/${s}/decisoes` },
  { name: 'session-decisions-branch-current', path: `/api/sessoes/${s}/decisoes?escopo=branch&estado=vigentes` },
  { name: 'session-decisions-invalid-scope', path: `/api/sessoes/${s}/decisoes?escopo=nada` },
  // History.
  { name: 'history', path: '/api/historico' },
  { name: 'history-search', path: '/api/historico?dias=3&busca=a' },
  { name: 'history-before', path: '/api/historico?antes=2026-10-19&dias=2' },
  { name: 'history-invalid-days', path: '/api/historico?dias=99' },
  // The Decisions page.
  { name: 'decisions-page', path: '/api/decisoes' },
  { name: 'decisions-page-family', path: '/api/decisoes?agrupar=familia&estado=a_confirmar&q=kanban' },
  { name: 'decisions-page-session', path: '/api/decisoes?agrupar=sessao' },
  { name: 'decisions-page-invalid-group', path: '/api/decisoes?agrupar=nada' },
  // The GitHub Project.
  {
    name: 'project',
    path: '/api/projeto',
    capture: (b) => {
      const lanes = (b as { raias: { id: string | null; cards: { itemId: string }[] }[] }).raias;
      const from = lanes.find((l) => l.cards.length > 0)!;
      const to = lanes.find((l) => l.id !== null && l.id !== from.id)!;
      return { item: from.cards[0]!.itemId, option: to.id! };
    },
  },
  { name: 'project-refresh', path: '/api/projeto?forcar=1' },
  // Analytics.
  { name: 'analytics-cost', path: '/api/analytics/custo' },
  { name: 'analytics-cost-days-tz', path: '/api/analytics/custo?dias=7&fuso=America/Sao_Paulo' },
  { name: 'analytics-cost-invalid-days', path: '/api/analytics/custo?dias=8' },
  { name: 'analytics-cost-invalid-tz', path: '/api/analytics/custo?fuso=nada' },
  // Open in the Desktop.
  { name: 'open-get', path: `/abrir/${LOCAL}` },
  { name: 'open-get-short-id', path: '/abrir/local_x' },
  post('open-post', `/abrir/${LOCAL}`, {}),
  post('open-post-invalid-id', '/abrir/local_curto', {}),
  post('open-post-not-json', `/abrir/${LOCAL}`, '{}', { contentType: 'text/plain' }),
  // Writes on the decisions, with the old body `{ sessao, texto }`.
  post('confirm', '/api/decisoes/{decision}/confirmar', { sessao: s }),
  { name: 'scope-decisions-after-confirm', path: `/api/decisoes/${s}?escopo=familia` },
  post('undo-confirm', '/api/decisoes/{decision}/desfazer', { sessao: s }),
  post('adjust', '/api/decisoes/{decision}/ajustar', { sessao: s, texto: 'Oito cards por coluna, com "mostrar mais"' }),
  { name: 'panel-after-adjust', path: `/api/painel/${s}?decisoes=familia` },
  post('undo-adjust', '/api/decisoes/{decision}/desfazer', { sessao: s }),
  post('dismiss', '/api/decisoes/{decision}/descartar', { sessao: s }),
  post('undo-dismiss', '/api/decisoes/{decision}/desfazer', { sessao: s }),
  post('undo-nothing-to-undo', '/api/decisoes/{decision}/desfazer', { sessao: s }),
  post('promote-draft', '/api/decisoes/{current}/promover', { sessao: s }),
  post('promote-suggested', '/api/decisoes/{decision}/promover', { sessao: s }),
  post('confirm-no-session', '/api/decisoes/{decision}/confirmar', {}),
  post('promote-no-session', '/api/decisoes/{current}/promover', {}),
  post('confirm-invalid-json', '/api/decisoes/{decision}/confirmar', '{x'),
  post('confirm-not-json', '/api/decisoes/{decision}/confirmar', JSON.stringify({ sessao: s }), { contentType: 'text/plain' }),
  post('confirm-unknown', '/api/decisoes/nao-existe/confirmar', { sessao: s }),
  post('dismiss-unknown', '/api/decisoes/nao-existe/descartar', { sessao: s }),
  post('adjust-unknown', '/api/decisoes/nao-existe/ajustar', { sessao: s, texto: 'x' }),
  post('promote-unknown', '/api/decisoes/nao-existe/promover', { sessao: s }),
  { name: 'confirm-with-get', path: '/api/decisoes/{decision}/confirmar' },
  { name: 'decisions-page-after-writes', path: '/api/decisoes' },
  // Moving a project card, with the old body `{ itemId, optionId }`.
  post('project-move-unknown-item', '/api/projeto/mover', { itemId: 'nada', optionId: 'x' }),
  post('project-move-no-fields', '/api/projeto/mover', {}),
  post('project-move', '/api/projeto/mover', { itemId: '{item}', optionId: '{option}' }),
  { name: 'project-after-move', path: '/api/projeto' },
  // The panel of a session the core has not seen yet (the mod asks it at the start of every session).
  { name: 'panel-new-session', path: `/api/painel/sessao-nova?local=${LOCAL}&conta=c1&org=o1&modelo=claude-opus-5-5&cwd=/simulacao/ahrena-demo` },
  { name: 'panel-via-demo-alias', path: `/api/painel/${DEMO_ALIAS}` },
  // Promote for real, with the old body `{ sessao, confirmar, caminho, hash }`, into a temp folder.
  {
    name: 'promote-draft-with-folder',
    method: 'POST',
    path: '/api/decisoes/{current}/promover',
    body: { sessao: s },
    prepare: (demo) => demo.createRecordsFolder(),
    capture: (b) => {
      const draft = (b as { rascunho: { caminho: string; hash: string } }).rascunho;
      return { recordPath: draft.caminho, recordHash: draft.hash };
    },
  },
  post('promote-confirm', '/api/decisoes/{current}/promover', { sessao: s, confirmar: true, caminho: '{recordPath}', hash: '{recordHash}' }),
  post('promote-confirm-again', '/api/decisoes/{current}/promover', { sessao: s, confirmar: true, caminho: '{recordPath}', hash: '{recordHash}' }),
  { name: 'scope-decisions-after-promote', path: `/api/decisoes/${s}?escopo=familia` },
  // Every change the writes above registered, since the cursor of `changes-no-cursor`.
  { name: 'changes-after-writes', path: '/api/mudancas?desde={cursor}&espera=0' },
];

const fill = (text: string, vars: Readonly<Record<string, string>>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
const fillPath = (path: string, vars: Readonly<Record<string, string>>): string => path.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : encodeURIComponent(vars[k])));

/** Runs one case, filling its placeholders from `vars` and adding the ones it captures. */
export async function runGoldenCase(demo: LegacyDemo, c: GoldenCase, vars: Record<string, string>): Promise<{ record: GoldenRecord; text: string }> {
  const method = c.method ?? 'GET';
  const init: RequestInit = { method, redirect: 'manual' };
  if (method === 'POST') {
    const raw = typeof c.body === 'string' ? c.body : JSON.stringify(c.body ?? {});
    init.headers = { 'content-type': c.contentType ?? 'application/json' };
    init.body = fill(raw, vars);
  }
  c.prepare?.(demo);
  const r = await fetch(`${demo.api.url}${fillPath(c.path, vars)}`, init);
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (c.capture && r.status === 200) Object.assign(vars, c.capture(body));
  const record: GoldenRecord = {
    name: c.name,
    request: { method, path: c.path, ...(c.body !== undefined ? { body: c.body } : {}) },
    status: r.status,
    contentType: r.headers.get('content-type'),
    ...(r.headers.has('location') ? { location: r.headers.get('location') } : {}),
    body: c.keysOnly && body && typeof body === 'object' ? Object.keys(body).sort() : body,
  };
  return { record, text };
}

/** Runs every case, in order, against a fresh demo server; the records come back unfilled. */
export async function runGoldenCases(demo: LegacyDemo): Promise<GoldenRecord[]> {
  const vars: Record<string, string> = {};
  const out: GoldenRecord[] = [];
  for (const c of GOLDEN_CASES) out.push((await runGoldenCase(demo, c, vars)).record);
  return out;
}

/** The file of a record, under `test/fixtures/legacy-golden/`. */
export const goldenFile = (index: number, name: string): string => `${String(index + 1).padStart(3, '0')}-${name}.json`;
