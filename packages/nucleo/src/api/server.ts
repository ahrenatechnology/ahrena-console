// The core's minimal local API (start of #21), on 127.0.0.1: the hooks and the panel on the same port.
//
// | Route                         | What                                                      |
// | ----------------------------- | --------------------------------------------------------- |
// | `GET /api/overview`           | Health: the panel and the load script wait on it          |
// | `GET /api/panel/<session>`    | Everything the panel draws, in one request (api/types.ts) |
// | `GET /api/wall`               | One card per open session, for the "Mural ao vivo" (api/wall.ts, #34) |
// | `GET /api/load`               | Counters for the load measurement                         |
// | `POST /api/hooks`             | The hooks receiver (src/ingest/hooks)                     |
// | `GET /api/decisions/<session>` | The decisions of a scope (`?scope=session|family|branch`) |
// | `POST /api/decisions/<id>/confirm` and `/dismiss` | Confirm and Dismiss of a suggested one |
// | `POST /api/decisions/<id>/adjust` and `/undo` | The adjustment written by the person (`{ text }`) and Undo of the last action |
// | `POST /open/<local_…>`        | Opens the conversation in the Claude Desktop (`open claude://…`, on macOS); JSON, like the other writes |
// | `GET /open/<local_…>`         | Redirects to `claude://claude.ai/epitaxy/<local_…>`, which opens the conversation in the Claude Desktop (the mod's `Link` only takes `http://localhost`) |
// | `POST /mcp`                   | The MCP server (src/mcp), when `mcp` is passed            |
// | `GET /api/changes`            | Long polling of the changes (`?since=`, `?wait=`; src/changes, item 2.4) |
// | `GET /api/events`             | The activity feed, all sessions (api/events.ts, #94)      |
// | `GET /api/attention`          | Who needs you, across all accounts (the tray, #87)        |
// | `GET /api/dashboard`          | The Dashboard's numbers, active agents and activity (C1, #27) |
// | `GET /api/analytics` and `/api/analytics/cost` | The Analytics screen (`?tz=`, `?days=`; api/analytics-route.ts, #95 and #32) |
// | `GET /api/sessions`           | The Sessions screen's list, paginated and filtered (api/sessions.ts, #28) |
// | `GET /api/history`            | The ended sessions by day (`?before=`, `?days=`, `?search=`; api/history.ts, #33) |
// | `GET /ui` and `/ui/*`         | The console's interface (api/ui.ts, folder `ui/`, #26)    |
// | `GET /api/kanban`             | The read-only Kanban, sessions or agents by column (`?view=`; api/kanban.ts, #31) |
// | `GET /api/workflows` and `/api/sessions/<id>/workflow` | Workflows and the Workflow tab (api/workflows.ts, #96 and #97) |
// | `GET /api/project`            | The GitHub Project kanban (api/project.ts, #80); `?refresh=1` re-reads |
// | `POST /api/project/move`      | Changes a card's Status: `{ itemId, optionId }` (api/project.ts) |
// | `GET /api/sessions/<id>` and `/agents`, `/conversation`, `/events` | The session Detail in the /ui (api/session-detail.ts, #29 and #30) |
// | `GET /api/decisions`, `GET /api/sessions/<id>/decisions` and `POST /api/decisions/<id>/promote` | The /ui's Decisions page and tab and the "Promover a registro" (api/decisions-ui.ts, #103) |
// | `GET /api/repos` and `/api/repos/<owner>/<repo>` | GitHub repositories and metrics (`?period=`, `?refresh=1`; api/repos.ts, #104, #105) |
// | `GET /api/agent-instructions/<owner>/<repo>` and `/file?path=` | A repository's Instructions tab: instruction files, `@imports`, `.claude/` and `.mcp.json` (`?refresh=1`; api/agent-instructions.ts, #183) |
// | `GET /api/agent-config`, `GET` and `POST /api/agent-config/skill` | The Agent Config screen (api/agent-config.ts, src/agent-config, #63): what is in the configuration folders and editing a skill, with backup |
// | `GET /api/machines`           | The machines: this one and the remote ones, with state and alerts (api/telemetry.ts, #175) |
// | `GET /api/telemetry`          | One machine's telemetry: current reading, series and alerts (`?machine=`, `?hours=1|12`; #175) |
//
// The old Portuguese routes and query parameters (`/api/painel/<id>`, `/api/sessao/<id>`, `/abrir/<id>`,
// `/api/atencao`, `/api/mudancas?desde=&espera=`…) answer as aliases of these, with the same response:
// `normalizeLegacyUrl` (api/legacy-routes.ts, the only place that knows them) runs before the routing
// (issue #173, phase 1). They leave in phase 6, after the published mod and the installed app migrate.
// Since phase 2b the JSON is English, and an old route still answers its old body and takes its old
// request body: `handle` sets the route's back-translator (`legacyResponseFor`) on the response, and
// `send` applies it to every JSON it writes, errors included; the writes read the body through
// `legacyRequestBody`.
//
// `?local=`, `?account=`, `?org=`, `?model=` and `?cwd=` on the panel are what it reads from its own session;
// `?decisions=<scope>` brings the open decision list in the same request.
// A request with an `Origin`, or with a `Host` that is not ours, gets 403 (decision 0003). The exception is
// the /ui itself reading: a `GET` whose `Origin` is exactly `http://<Host>` (a browser may send `Origin`
// even on a same-origin `fetch`). A write with `Origin` is still refused, except three, only with `Origin`
// exactly `http://<Host>` and the exact path (no query): the Detail's "Abrir no Claude Desktop",
// `POST /open/<local_…>`, the project Kanban's `POST /api/project/move` (api/project.ts) and the
// decisions through the /ui (#103), `POST /api/decisions/<id>/(confirm|dismiss|adjust|undo|promote)`, and
// the Agent Config screen's `POST /api/agent-config/skill` (api/agent-config.ts). The old aliases
// (`/abrir/…`, `/api/projeto/mover`, `/api/decisoes/<id>/<action>`) go through the same rules.
// An outside site cannot get that `Origin`, nor send JSON without the CORS preflight, and the core does
// not answer CORS. Writing to the decisions also requires `Content-Type: application/json` and the body
// `{ "session": "<id>" }` (the old `{ "sessao" }` is still read, on every path), and it only reaches a
// decision that session sees, from its account.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { allowedLocalRequest, createHookRoute, HOOKS_PATH, rewriteJsonBodies, send, type HookRouteOptions } from '../ingest/hooks/receiver.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import { CHANGES_ROUTE, serveChanges } from '../changes/http.ts';
import { ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao } from './decisions.ts';
import { responderDecisoesDaUi, type DecisoesDaUi } from './decisions-ui.ts';
import type { MontadorDoPainel, PedidoDoPainel } from './panel.ts';
import type { EscopoDasDecisoes } from './types.ts';
import { VERSAO_DA_API } from './version.ts';
import { MCP_PATH, createMcpRoute } from '../mcp/http.ts';
import { ehDaUi, responderUi } from './ui.ts';
import { responderWorkflows } from './workflows.ts';
import { muralDoPainel, WALL_ROUTE, responderMural } from './wall.ts';
import { SESSIONS_ROUTE, responderSessoes, type ListaDeSessoes } from './sessions.ts';
import { HISTORY_ROUTE, responderHistorico } from './history.ts';
import type { SessionHistory } from '../history/reading.ts';
import { responderKanban, ROTA_DO_KANBAN, type QuadroKanban } from './kanban.ts';
import { EVENTS_ROUTE, responderEventos, type FeedDeEventos } from './events.ts';
import { agentConfigWriteFromSameOrigin, AGENT_CONFIG_ROUTE, type AgentConfigRoute } from './agent-config.ts';
import type { McpServer } from '../mcp/protocol.ts';
import { criarRotaDoProjeto, ehDoProjeto, mesmaOrigemMovendo, type OpcoesDoProjeto } from './project.ts';
import { DETAIL_ROUTE, type LeiturasDoDetalhe } from './session-detail.ts';
import type { FleetReader } from '../mcp/fleet.ts';
import { montarAtencao, ATTENTION_ROUTE, type RemoteAttentionSource } from './attention-route.ts';
import { montarDashboard, ROTA_DO_DASHBOARD } from './dashboard-route.ts';
import { RotaAnalytics } from './analytics-route.ts';
import { legacyRequestBody, legacyResponseFor, normalizeLegacyPath, normalizeLegacyUrl, rawPathnameOf } from './legacy-routes.ts';
import { ROTA_DOS_REPOS, type RotaDosRepos } from './repos.ts';
import { AGENT_INSTRUCTIONS_ROUTE, type AgentInstructionsRoute } from './agent-instructions.ts';
import { DEV_CONSOLE_ROUTE, respondDevConsole, type DevConsole } from './dev-console.ts';
import { isTelemetryRoute, respondTelemetry } from './telemetry.ts';
import type { TelemetryService } from '../telemetry/service.ts';

export { VERSAO_DA_API };

export interface OpcoesDaApi {
  montador: MontadorDoPainel;
  hooks: HookRouteOptions;
  host?: string;
  /** 0 escolhe uma porta livre (testes). Padrão 4720. */
  port?: number;
  /**
   * A socket already listening (the port the owner reserved before opening the database, issue
   * #221): the API takes it over instead of binding `port`, so no other process can grab the port
   * in between. With port 0, that is the only way to keep the port the system assigned.
   */
  listenOn?: NetServer;
  log?: (mensagem: string) => void;
  /** Contadores extras para `/api/load` (seguidor, índice do Desktop). */
  carga?: () => Record<string, unknown>;
  /**
   * Abre um endereço `claude://` no Claude Desktop (no macOS, `open <url>`). Sem ela, o
   * `POST /open/<local_…>` responde 501 e o painel fica com o link de reserva.
   */
  abrirNoDesktop?: ((url: string) => Promise<void>) | null;
  /** O servidor MCP em `/mcp` (src/mcp). Sem ele, `/mcp` dá 404. */
  mcp?: McpServer;
  /** The commit of the running code, in `/api/overview`: whoever starts another core compares (src/owner). */
  commit?: string | null;
  /** O cursor de mudanças; liga `GET /api/changes`. */
  mudancas?: ChangeCursor;
  /** O kanban do GitHub Project (#80). Sem ele, `/api/project` responde 503. */
  projeto?: OpcoesDoProjeto;
  /** As leituras do Detalhe da sessão (`/api/sessions/<id>…`); sem elas, 404. */
  detalhe?: LeiturasDoDetalhe;
  /** O feed de atividade; liga `GET /api/events` (#94). */
  eventos?: FeedDeEventos;
  /** A leitura da frota do MCP; liga `GET /api/attention`. */
  frota?: FleetReader;
  /** The remote machines whose sessions also enter `GET /api/attention` (#176). */
  remoteAttention?: readonly RemoteAttentionSource[];
  /** A tela Analytics (#95, #32); liga `GET /api/analytics` e `/api/analytics/cost`. */
  analytics?: RotaAnalytics;
  /** A lista da tela Sessões; liga `GET /api/sessions`. */
  sessoes?: ListaDeSessoes;
  /** As sessões encerradas por dia; liga `GET /api/history` (#33). */
  historico?: SessionHistory;
  /** O Kanban (#31); liga `GET /api/kanban`. */
  kanban?: QuadroKanban;
  /** A página e a aba Decisões da /ui e o Promover (api/decisions-ui.ts, #103). Sem ela, essas rotas dão 404. */
  decisoesUi?: DecisoesDaUi;
  /** Repositórios do GitHub e métricas (api/repos.ts); sem ela, `/api/repos` dá 404. */
  repos?: RotaDosRepos;
  /** The Instructions tab of a repository (api/agent-instructions.ts, #183); without it, `/api/agent-instructions` gives 404. */
  agentInstructions?: AgentInstructionsRoute;
  /**
   * Demo only (#173): rewrites the old simulator session ids of a URL to the current ones
   * (src/simulator/legacy-ids.ts), after the old routes became the new ones.
   */
  demoUrl?: (url: URL) => URL;
  /** The Dev Console (#177); turns on `GET /api/dev-console`. */
  devConsole?: DevConsole;
  /** The Agent Config screen (`createAgentConfigRoute`); without it, `/api/agent-config` gives 404. */
  agentConfig?: AgentConfigRoute;
  /** Machine telemetry (#175); without it, `/api/machines` and `/api/telemetry` give 404. */
  telemetry?: TelemetryService | null;
}

/** O id `local_<uuid>` do índice do Claude Desktop, e nada mais. */
export const LOCAL_DO_DESKTOP = /^local_[0-9a-f-]{36}$/;

export const PANEL_ROUTE = '/api/panel';
export const OPEN_ROUTE = '/open';
export const LOAD_ROUTE = '/api/load';
export const DECISIONS_ROUTE = '/api/decisions';

const PANEL = /^\/api\/panel\/([^/]+)$/;
const OPEN = /^\/open\/([^/]+)$/;
const OPEN_IN_DESKTOP = /^\/open\/(local_[0-9a-f-]{8,64})$/i;
const DECISION_LIST = /^\/api\/decisions\/([^/]+)$/;
const DECISION_ACTION = /^\/api\/decisions\/([^/]+)\/(confirm|dismiss|adjust|undo)$/;
const DECISION_WRITE_FROM_UI = /^\/api\/decisions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/(confirm|dismiss|adjust|undo|promote)$/;
/** The action in the URL → the action the panel builder still names in Portuguese (phase 3). */
const DECISION_ACTIONS: Readonly<Record<string, AcaoNaDecisao>> = { confirm: 'confirm', dismiss: 'dismiss', adjust: 'adjust', undo: 'undo' };

export interface ApiLocal {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARAM = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
const CAMINHO = /^\/[^\0\n]{0,1023}$/;
const MAX_CORPO = 4096;

/** O pedido vem da própria `/ui`: `Origin` igual a `http://<Host>`, e o Host já é o nosso. */
function daPropriaUi(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origem = req.headers.origin;
  if (typeof origem !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origem === `http://${host}`;
}

/** A própria `/ui` lendo: `GET` da mesma origem. */
const mesmaOrigemLendo = (req: IncomingMessage, port: number): boolean => req.method === 'GET' && daPropriaUi(req, port);

/**
 * O "Abrir no Claude Desktop" do Detalhe: só `POST /open/<local_…>` (ou o alias `/abrir/<local_…>`)
 * da mesma origem, com a URL crua exatamente assim (sem query, sem `..`). O resto da decisão 0003
 * vale como nas outras escritas: JSON (o `abrirDireto` confere) e o id estrito.
 */
const mesmaOrigemAbrindo = (req: IncomingMessage, port: number): boolean =>
  req.method === 'POST' && /^\/open\/local_[0-9a-f-]{36}$/.test(normalizeLegacyPath(req.url ?? '')) && daPropriaUi(req, port);

/**
 * A própria `/ui` decidindo (#103): só `POST /api/decisions/<id>/<action>` (ou o alias
 * `/api/decisoes/<id>/<ação>`), com o caminho cru exato (query dá 403) e da mesma origem. O id começa por alfanumérico: `/api/decisions/../confirm` não passa. O JSON obrigatório continua com quem responde (415).
 */
const mesmaOrigemDecidindo = (req: IncomingMessage, port: number): boolean =>
  req.method === 'POST' && DECISION_WRITE_FROM_UI.test(normalizeLegacyPath(req.url ?? '')) && daPropriaUi(req, port);

const escopoDe = (v: string | null): EscopoDasDecisoes | null => (ESCOPOS_DAS_DECISOES.includes(v as EscopoDasDecisoes) ? (v as EscopoDasDecisoes) : null);

/** O que o painel manda de si: os mesmos parâmetros do `GET /api/panel`. */
function pedidoDe(sessionId: string, url: URL): PedidoDoPainel {
  const p = (k: string) => {
    const v = url.searchParams.get(k);
    return v && PARAM.test(v) ? v : null;
  };
  const cwd = url.searchParams.get('cwd');
  return {
    sessionId,
    local: p('local'),
    conta: p('account'),
    org: p('org'),
    modelo: p('model'),
    cwd: cwd && CAMINHO.test(cwd) ? cwd : null,
    decisoes: escopoDe(url.searchParams.get('decisions')),
  };
}

function lerCorpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let corpo = '';
    let grande = false;
    req.setEncoding('utf8');
    req.on('data', (parte: string) => {
      if (grande) return;
      corpo += parte;
      if (corpo.length > MAX_CORPO) grande = true;
    });
    req.on('end', () => resolve(grande ? null : corpo));
    req.on('error', reject);
  });
}

export function iniciarApiLocal(opts: OpcoesDaApi): Promise<ApiLocal> {
  const log = opts.log ?? ((m: string) => console.error(`[ahrena-console api] ${m}`));
  const hooks = createHookRoute(opts.hooks);
  const mcp = opts.mcp ? createMcpRoute(opts.mcp) : null;
  const projeto = criarRotaDoProjeto(opts.projeto ?? { kanban: null, fonte: 'github', log });
  const mural = muralDoPainel(opts.montador);
  const contadores = { requests: 0, panel: 0, panelMs: 0 };
  let port = 0;

  async function painel(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const t0 = performance.now();
    const corpo = await opts.montador.montar(pedidoDe(sessionId, url));
    contadores.panel++;
    contadores.panelMs += performance.now() - t0;
    send(res, 200, corpo);
  }

  async function listaDeDecisoes(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const escopo = escopoDe(url.searchParams.get('scope') ?? 'family');
    if (!escopo) return send(res, 400, { error: 'scope: session, family ou branch' });
    const lista = await opts.montador.listaDeDecisoes(pedidoDe(sessionId, url), escopo);
    if (!lista) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
    send(res, 200, lista);
  }

  // Escrita: só JSON, com a sessão no corpo; a montagem confere se a sessão enxerga a decisão. The body
  // is `{ session, text }`; the old `{ sessao, texto }` is read too, on the new path as well (the old
  // path translates it through `legacyRequestBody`), so a client can move to the new route first.
  async function decidir(req: IncomingMessage, res: ServerResponse, id: string, acao: AcaoNaDecisao, url: URL) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!ID.test(id)) return send(res, 400, { error: 'id de decisão inválido' });
    const texto = await lerCorpo(req);
    if (texto === null) return send(res, 413, { error: 'corpo grande demais' });
    let sessao: unknown;
    let ajuste: unknown;
    try {
      const corpo = legacyRequestBody(rawPathnameOf(req.url), JSON.parse(texto)) as { session?: unknown; text?: unknown; sessao?: unknown; texto?: unknown } | null;
      sessao = corpo?.session ?? corpo?.sessao;
      ajuste = corpo?.text ?? corpo?.texto;
    } catch {
      return send(res, 400, { error: 'JSON inválido' });
    }
    if (typeof sessao !== 'string' || !ID.test(sessao)) return send(res, 400, { error: 'informe a sessão: { "session": "<id>" }' });
    try {
      const decisao = await opts.montador.decidir(pedidoDe(sessao, url), id, acao, typeof ajuste === 'string' ? ajuste : null);
      if (!decisao) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
      log(`decisão ${id}: ${acao} pela sessão ${sessao}`);
      send(res, 200, { decision: decisao });
    } catch (err) {
      if (err instanceof ErroDaDecisao) return send(res, err.status, { error: err.message });
      throw err;
    }
  }

  // O id passou pelo padrão `local_<hex e hífen>`: nada do pedido vai além dele para o endereço.
  function abrirNoDesktop(res: ServerResponse, local: string) {
    const destino = `claude://claude.ai/epitaxy/${local}`;
    const corpo = `<!doctype html><meta charset="utf-8"><title>Abrindo a sessão</title><p>Abrindo a sessão no Claude Desktop… <a href="${destino}">abrir</a></p>`;
    res.writeHead(302, { location: destino, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(corpo) });
    res.end(corpo);
  }

  // Escrita como as das decisões: só JSON e só de 127.0.0.1 (o `allowedLocalRequest` do `handle`).
  async function abrirDireto(req: IncomingMessage, res: ServerResponse, local: string) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!LOCAL_DO_DESKTOP.test(local)) return send(res, 400, { error: 'id de sessão do Desktop inválido' });
    if (!opts.abrirNoDesktop) return send(res, 501, { error: 'abrir a sessão só no macOS, com o Claude Desktop' });
    try {
      await opts.abrirNoDesktop(`claude://claude.ai/epitaxy/${local}`);
      log(`sessão ${local} aberta no Claude Desktop`);
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 502, { error: `não deu para abrir: ${(err as Error).message}` });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    contadores.requests++;
    // The old routes and parameters become the new ones here, before any check (api/legacy-routes.ts).
    const raw = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const normalized = normalizeLegacyUrl(raw);
    const url = opts.demoUrl ? opts.demoUrl(normalized) : normalized;
    // An old route answers its old body: every JSON written from here on, errors included, goes
    // through its back-translator (new → old keys and values).
    const toLegacy = legacyResponseFor(raw.pathname);
    if (toLegacy) rewriteJsonBodies(res, toLegacy);
    if (!allowedLocalRequest(req, port) && !mesmaOrigemLendo(req, port) && !mesmaOrigemAbrindo(req, port) && !mesmaOrigemMovendo(req, port) && !mesmaOrigemDecidindo(req, port) && !agentConfigWriteFromSameOrigin(req, port)) return send(res, 403, { error: 'origem não permitida' });
    // Demo: a /ui page asked by an old session id goes to its new URL (query kept), so the page and
    // its live refresh work with the current id.
    if (url !== normalized && url.pathname !== normalized.pathname && req.method === 'GET' && url.pathname.startsWith('/ui/')) {
      res.writeHead(302, { location: `${url.pathname}${url.search}`, 'cache-control': 'no-store', 'content-length': 0 });
      return void res.end();
    }
    if (url.pathname.startsWith(HOOKS_PATH)) return hooks(req, res);
    const direto = OPEN.exec(url.pathname);
    if (direto && req.method === 'POST') return abrirDireto(req, res, decodeURIComponent(direto[1]!));
    if (opts.decisoesUi && (await responderDecisoesDaUi(req, res, url, opts.decisoesUi, log))) return;
    const escrita = DECISION_ACTION.exec(url.pathname);
    if (escrita) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      return decidir(req, res, decodeURIComponent(escrita[1]!), DECISION_ACTIONS[escrita[2]!]!, url);
    }
    if (mcp && url.pathname === MCP_PATH) return mcp(req, res);
    if (ehDoProjeto(url.pathname)) return projeto(req, res, url);
    if (opts.agentConfig && (url.pathname === AGENT_CONFIG_ROUTE || url.pathname.startsWith(`${AGENT_CONFIG_ROUTE}/`))) return opts.agentConfig(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    if (ehDaUi(url.pathname)) return responderUi(res, url.pathname);
    const abrir = OPEN_IN_DESKTOP.exec(url.pathname);
    if (abrir) return abrirNoDesktop(res, abrir[1]!);
    // `pid` proves who holds the port: whoever reads the lock only stops the core if its pid is this one (src/owner).
    // `nome` and `versao` stay beside `name` and `version` until phase 6 of #173: the installed app
    // (v.get("nome") == "ahrena-console") and the `dono` of an older checkout read them.
    if (url.pathname === '/api/overview') return send(res, 200, { ok: true, name: 'ahrena-console', version: VERSAO_DA_API, pid: process.pid, commit: opts.commit ?? null, nome: 'ahrena-console', versao: VERSAO_DA_API });
    if (url.pathname === CHANGES_ROUTE && opts.mudancas) return serveChanges(res, url, opts.mudancas);
    if (url.pathname === WALL_ROUTE) return responderMural(res, mural);
    if (url.pathname === EVENTS_ROUTE && opts.eventos) return responderEventos(res, url, opts.eventos);
    if (url.pathname === ATTENTION_ROUTE && opts.frota) return send(res, 200, await montarAtencao(opts.frota, opts.mudancas?.current ?? null, opts.remoteAttention));
    if (url.pathname === ROTA_DO_DASHBOARD && opts.frota) return send(res, 200, await montarDashboard(opts.frota));
    if (opts.analytics && RotaAnalytics.atende(url.pathname)) {
      const r = await opts.analytics.responder(url);
      return send(res, r.status, r.corpo);
    }
    if (url.pathname === SESSIONS_ROUTE && opts.sessoes) return responderSessoes(res, url, opts.sessoes);
    if (url.pathname === HISTORY_ROUTE) return responderHistorico(res, url, opts.historico);
    if (url.pathname === ROTA_DO_KANBAN && opts.kanban) return responderKanban(res, url, opts.kanban);
    if (opts.repos && (url.pathname === ROTA_DOS_REPOS || url.pathname.startsWith(`${ROTA_DOS_REPOS}/`))) return opts.repos(res, url);
    if (opts.agentInstructions && url.pathname.startsWith(`${AGENT_INSTRUCTIONS_ROUTE}/`)) return opts.agentInstructions(res, url);
    if (url.pathname === DEV_CONSOLE_ROUTE && opts.devConsole) return respondDevConsole(res, url, opts.devConsole);
    if (isTelemetryRoute(url.pathname)) return respondTelemetry(res, url, opts.telemetry);
    if (url.pathname === LOAD_ROUTE) {
      return send(res, 200, {
        ...contadores,
        eventsRead: opts.montador.resumos.eventosLidos,
        ...(opts.mudancas ? { openWaits: opts.mudancas.openWaits } : {}),
        ...(opts.carga?.() ?? {}),
      });
    }
    if (await responderWorkflows(res, url, opts.montador)) return;
    const m = PANEL.exec(url.pathname);
    if (m) return painel(res, decodeURIComponent(m[1]!), url);
    const d = DECISION_LIST.exec(url.pathname);
    if (d) return listaDeDecisoes(res, decodeURIComponent(d[1]!), url);
    const det = opts.detalhe && DETAIL_ROUTE.exec(url.pathname);
    if (det) return opts.detalhe!.responder(res, decodeURIComponent(det[1]), det[2] ?? null, url);
    send(res, 404, { error: 'não encontrado' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`erro em ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'erro interno' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const listening = () => {
      server.off('error', reject);
      const { address, port: bound } = server.address() as AddressInfo;
      port = bound;
      resolve({
        server,
        url: `http://${address}:${bound}`,
        close: () =>
          new Promise<void>((done, fail) => {
            opts.mudancas?.close();
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    };
    if (opts.listenOn) server.listen(opts.listenOn, listening);
    else server.listen(opts.port ?? 4720, opts.host ?? '127.0.0.1', listening);
  });
}
