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
// | `GET /api/analytics`, `/api/analytics/cost` and `/api/analytics/delivery` | The Analytics screen (`?tz=`, `?days=`, `?groupBy=`, `?key=`; api/analytics-route.ts, #95, #32 and #266) |
// | `GET /api/sessions`           | The Sessions screen's list, paginated and filtered (api/sessions.ts, #28) |
// | `GET /api/history`            | The ended sessions by day (`?before=`, `?days=`, `?search=`; api/history.ts, #33) |
// | `GET /ui` and `/ui/*`         | The console's interface (api/ui.ts, folder `ui/`, #26)    |
// | `GET /api/kanban`             | The read-only Kanban, sessions or agents by column (`?view=`; api/kanban.ts, #31) |
// | `GET /api/workflows` and `/api/sessions/<id>/workflow` | Workflows and the Workflow tab (api/workflows.ts, #96 and #97) |
// | `GET /api/project`            | The GitHub Project kanban (api/project.ts, #80); `?refresh=1` re-reads |
// | `POST /api/project/move`      | Changes a card's Status: `{ itemId, optionId }` (api/project.ts) |
// | `GET /api/sessions/<id>` and `/agents`, `/conversation`, `/events` | The session Detail in the /ui (api/session-detail.ts, #29 and #30) |
// | `GET /api/new-session/folders` and `POST /api/new-session` | "Nova sessão": the folders it can start in, and a new session in one of them, in the Claude Desktop or a terminal (api/new-session.ts) |
// | `POST /api/sessions/<id>/open` | Opens the session where it runs: Claude Desktop, a terminal resuming it, or its live terminal brought forward; the núcleo picks the target (api/session-open-route.ts, #285) |
// | `GET /api/decisions`, `GET /api/sessions/<id>/decisions` and `POST /api/decisions/<id>/promote` | The /ui's Decisions page and tab and the "Promover a registro" (api/decisions-ui.ts, #103) |
// | `GET /api/repos` and `/api/repos/<owner>/<repo>` | GitHub repositories and metrics (`?period=`, `?refresh=1`; api/repos.ts, #104, #105) |
// | `GET /api/agent-instructions/<owner>/<repo>` and `/file?path=` | A repository's Instructions tab: instruction files, `@imports`, `.claude/` and `.mcp.json` (`?refresh=1`; api/agent-instructions.ts, #183) |
// | `GET /api/framework-install/<owner>/<repo>/plan`, `/pull-request` and `POST /api/framework-install/<owner>/<repo>` | Install the Ahrena Framework in a repository through a PR: the preview with the diff, the PR state and opening the PR (api/framework-install.ts, #184) |
// | `GET /api/agent-config`, `GET` and `POST /api/agent-config/skill` | The Agent Config screen (api/agent-config.ts, src/agent-config, #63): what is in the configuration folders and editing a skill, with backup |
// | `?machine=` on the lists above and on the Detail | The sessions of every machine, merged, or of one (api/machine-sessions.ts, #243) |
// | `GET /api/machines`           | The machines: this one and the remote ones, with state and alerts (api/telemetry.ts, #175) |
// | `GET /api/telemetry`          | One machine's telemetry: current reading, series and alerts (`?machine=`, `?hours=1|12`; #175) |
// | `POST /api/machines/<id>/reconnect` and `DELETE` | Reconnect a remote machine with the command of machines.json, and Cancel (api/telemetry.ts, #244) |
// | `GET /api/sessions/<id>/messaging`, `POST /api/sessions/<id>/messages` and `GET /api/sessions/<id>/messages/<messageId>` | Send a message a person typed in the /ui to the session's live process, through Claude Code's cross-session inbox, and read its state (api/messaging.ts, src/messaging, #61) |
// | `POST /api/terminals/<id>/actions/<action>` | Interrupt a terminal's foreground command or end its session, by ids (api/terminals.ts, #350) |
// | `GET /api/tools`              | The Tools screen: CLIs, runtimes and containers, installed and latest versions, the catalog's actions, the jobs (`?machine=`; api/tools.ts, #280) |
// | `POST /api/tools/<toolId>/actions/<actionId>`, `DELETE /api/tools/jobs/<jobId>`, `POST /api/tools/checks` and `POST /api/tools/mcp/checks` | Run a catalog action as a job, cancel it, Verificar agora, Verificar conexões (api/tools.ts, src/tools/executor.ts, #280) |
// | `POST /api/machines/<id>/connection/start|stop|reconnect|login-and-start`, `DELETE /api/machines/<id>/connection` | The connection of a remote machine (api/connection.ts, #278) |
// | `GET`/`POST /api/ports/release`, and the same under `/api/machines/<id>/` | Release a listening port: SIGTERM, then SIGKILL (api/ports.ts, #286, decision 0016) |
// | `GET /api/docker`, `GET /api/docker/plan`, `POST /api/docker/actions/<actionId>`, `DELETE /api/docker/jobs/<jobId>` | The Docker actions of a machine (api/docker.ts, src/docker, #288, decision 0017) |
// | `GET /api/connectors`, `POST`/`DELETE /api/connectors/aws/sessions/<name>/login`, and the same under `/api/machines/<id>/` | The cloud connectors and their logins (api/clouds.ts, #277) |
// | `GET /api/app-update`, `PUT /api/app-update/state` and `POST /api/app-update/actions/check|install|dismiss|ack` | The desktop app's update notice: the app reports, the /ui reads and clicks (api/app-update.ts, #330) |
// | `GET /api/connections`        | The console's own GitHub connection: `{ github: <status> }` (api/connections-route.ts, #241) |
// | `POST /api/connections/github/start`, `/cancel`, `/disconnect`, `/source` | Device flow, Cancel, Disconnect and the credential source (#241, decision 0011) |
// | `GET /api/project/options`    | The Projects the account sees, to choose the kanban's (`?refresh=1`; api/project.ts, #241) |
// | `POST /api/project/selection` | Stores the chosen Project: `{ owner, number, field? }` (#241) |
//
// #241 (decision 0011 §6): the six writes `POST /api/connections/github/(start|cancel|disconnect|source|orgs)`
// and `POST /api/project/selection` are accepted ONLY from the /ui itself: exact path, our Host, `Origin`
// exactly `http://<Host>`, JSON, at most 4 KiB, no cross-site or same-site `Sec-Fetch-Site`. A request
// without `Origin` is 403 there, unlike the other writes. While GitHub is not connected, every
// GitHub-backed screen route answers 409 `{ "error": "github-not-connected" }` without calling GitHub.
// `GET /api/project/options` spends GitHub quota: a browser saying `Sec-Fetch-Site: cross-site` or
// `same-site` gets 403 before that gate. The connection and the screens are wired in api/core-github.ts.
//
// The old Portuguese routes and query parameters (the panel, open, attention and changes ones…) were
// aliases of these until phase 6 of #173 (decision 0009): now they are 404 like any unknown path.
//
// `?local=`, `?account=`, `?org=`, `?model=` and `?cwd=` on the panel are what it reads from its own session;
// `?decisions=<scope>` brings the open decision list in the same request.
// A request with an `Origin`, or with a `Host` that is not ours, gets 403 (decision 0003). The exception is
// the /ui itself reading: a `GET` whose `Origin` is exactly `http://<Host>` (a browser may send `Origin`
// even on a same-origin `fetch`). A write with `Origin` is still refused, except three, only with `Origin`
// exactly `http://<Host>` and the exact path (no query): the Detail's "Abrir no Claude Desktop",
// `POST /open/<local_…>`, the project Kanban's `POST /api/project/move` (api/project.ts) and the
// decisions through the /ui (#103), `POST /api/decisions/<id>/(confirm|dismiss|adjust|undo|promote)`,
// the "Abrir no Claude Desktop / no terminal / Ir para o terminal" of #285, `POST /api/sessions/<uuid>/open`
// (api/session-open-route.ts), the Agent Config screen's `POST /api/agent-config/skill` (api/agent-config.ts), the framework
// install's `POST /api/framework-install/<owner>/<repo>` (api/framework-install.ts, #184), and the machine
// screen's Reconnect and Cancel, `POST` and `DELETE /api/machines/<id>/reconnect` (api/telemetry.ts, #244,
// decision 0012), and the Detail's Send, `POST /api/sessions/<id>/messages` (api/messaging.ts, #61), which
// is stricter: without `Origin` it is refused too, since only text a person typed in the /ui may go.
// The orders to a session, `POST /api/sessions/<id>/commands` (api/orders.ts), are the same: only the /ui creates them.
// The Tools writes (#280, decision 0014) are stricter: every non-GET request under `/api/tools` skips
// the gate above and passes only `toolsWriteAllowed` (api/tools.ts): `Origin` exactly `http://<Host>`,
// the exact raw path, and a request with NO Origin gets 403 too (unless layer 4's hook accepts it).
// An outside site cannot get that `Origin`, nor send JSON without the CORS preflight, and the core does
// not answer CORS. Writing to the decisions also requires `Content-Type: application/json` and the body
// `{ "session": "<id>" }`, and it only reaches a
// decision that session sees, from its account.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { allowedLocalRequest, createHookRoute, HOOKS_PATH, send, type HookRouteOptions } from '../ingest/hooks/receiver.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import { CHANGES_ROUTE, serveChanges } from '../changes/http.ts';
import { ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao } from './decisions.ts';
import { responderDecisoesDaUi, type DecisoesDaUi } from './decisions-ui.ts';
import type { MontadorDoPainel, PedidoDoPainel } from './panel.ts';
import type { PanelDecisionScope } from './types.ts';
import { API_VERSION } from './version.ts';
import { MCP_PATH, createMcpRoute } from '../mcp/http.ts';
import { isUiPath, respondUi } from './ui.ts';
import { responderWorkflows } from './workflows.ts';
import { muralDoPainel, WALL_ROUTE, responderMural } from './wall.ts';
import { SESSIONS_ROUTE, responderSessoes, type ListaDeSessoes } from './sessions.ts';
import { HISTORY_ROUTE, responderHistorico } from './history.ts';
import type { SessionHistory } from '../history/reading.ts';
import { responderKanban, KANBAN_ROUTE, type QuadroKanban } from './kanban.ts';
import { EVENTS_ROUTE, responderEventos, type FeedDeEventos } from './events.ts';
import { agentConfigWriteFromSameOrigin, AGENT_CONFIG_ROUTE, type AgentConfigRoute } from './agent-config.ts';
import type { McpServer } from '../mcp/protocol.ts';
import { criarRotaDoProjeto, ehDoProjeto, mesmaOrigemMovendo, PROJECT_OPTIONS_ROUTE, type OpcoesDoProjeto } from './project.ts';
import { DETAIL_ROUTE, type LeiturasDoDetalhe } from './session-detail.ts';
import type { FleetReader } from '../mcp/fleet.ts';
import { montarAtencao, remoteAttentionItems, ATTENTION_ROUTE, type RemoteAttentionSource } from './attention-route.ts';
import { SessionOpenDescriber } from './session-open.ts';
import { createSessionOpenRoute, SESSION_OPEN_FROM_UI, SESSION_OPEN_ROUTE } from './session-open-route.ts';
import { createNewSessionRoute, NEW_SESSION_FOLDERS_ROUTE, NEW_SESSION_ROUTE } from './new-session.ts';
import type { TerminalFocuser, TerminalOpener } from './terminal-launch.ts';
import { montarDashboard, DASHBOARD_ROUTE } from './dashboard-route.ts';
import { createMachineSessionsRoute } from './machine-sessions.ts';
import type { MachineReader } from './machine-reader.ts';
import { RotaAnalytics } from './analytics-route.ts';
import { REPOS_ROUTE, type RotaDosRepos } from './repos.ts';
import { AGENT_INSTRUCTIONS_ROUTE, type AgentInstructionsRoute } from './agent-instructions.ts';
import { FRAMEWORK_INSTALL_ROUTE, frameworkInstallWriteFromSameOrigin, type FrameworkInstallRoute } from './framework-install.ts';
import { ADRS_ROUTE, PDRS_ROUTE, type DecisionsRoute } from './adrs.ts';
import { DEV_CONSOLE_ROUTE, respondDevConsole, type DevConsole } from './dev-console.ts';
import { isTelemetryRoute, reconnectFromSameOrigin, RECONNECT_ROUTE, respondReconnect, respondTelemetry } from './telemetry.ts';
import type { ReconnectControl } from '../telemetry/reconnect.ts';
import type { TelemetryService } from '../telemetry/service.ts';
import { MESSAGING_ROUTE, messagesWriteFromSameOrigin, type MessagingRoute } from './messaging.ts';
import { ORDERS_ROUTE, ordersWriteFromSameOrigin, type OrdersRoute } from './orders.ts';
import { isTerminalsRoute, respondTerminalsWrite, terminalsWriteAllowed } from './terminals.ts';
import type { TerminalControl } from '../telemetry/terminal-actions.ts';
import { isToolsRoute, isToolsWrite, respondTools, respondToolsWrite, toolsWriteAllowed } from './tools.ts';
import { dockerWriteAllowed, isDockerRoute, isDockerWrite, type DockerRoute } from './docker.ts';
import type { ToolsControl } from '../tools/executor.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';
import { appUpdateWriteFromSameOrigin, isAppUpdateRoute, type AppUpdateRoute } from './app-update.ts';
import { cloudsWriteFromSameOrigin, isCloudsRoute, type CloudsRoute } from './clouds.ts';
import { isPortsRoute, isPortsWrite, portsWriteAllowed, type PortsRoute } from './ports.ts';
import { connectionWriteFromSameOrigin, isConnectionRoute, type ConnectionRoute } from './connection.ts';
import { CONNECTIONS_ROUTE, PROJECT_SELECTION_ROUTE, respondConnections, respondProjectSelection, STRICT_WRITE_ROUTES, strictWriteRefusal, type ProjectSelectionTarget } from './connections-route.ts';
import type { GithubConnection } from '../github/connection/connection.ts';

export { API_VERSION };

export interface ApiOptions {
  panelBuilder: MontadorDoPainel;
  hooks: HookRouteOptions;
  host?: string;
  /** 0 picks a free port (tests). Default 4720. */
  port?: number;
  /**
   * A socket already listening (the port the owner reserved before opening the database, issue
   * #221): the API takes it over instead of binding `port`, so no other process can grab the port
   * in between. With port 0, that is the only way to keep the port the system assigned.
   */
  listenOn?: NetServer;
  log?: (message: string) => void;
  /** Extra counters for `/api/load` (follower, Desktop index). */
  load?: () => Record<string, unknown>;
  /**
   * Opens a `claude://` address in the Claude Desktop (on macOS, `open <url>`). Without it,
   * `POST /open/<local_…>` answers 501 and the panel keeps the fallback link.
   */
  openInDesktop?: ((url: string) => Promise<void>) | null;
  /**
   * #285: the `open` of the wall, the attention items and `POST /api/sessions/<id>/open`, with this
   * machine's live `claude` processes. Without it, no session is `terminal-live`.
   */
  openDescriber?: SessionOpenDescriber;
  /** #285: opens a terminal resuming a session; without it, a terminal session gets 501 with the command. */
  openTerminal?: TerminalOpener | null;
  /** "Nova sessão": a folder its list leaves out; default the scratch and temporary folders (api/new-session.ts). */
  isThrowawayFolder?: (path: string) => boolean;
  /** #285: brings forward the terminal of a live session; without it, 409 with the command. */
  focusTerminal?: TerminalFocuser | null;
  /** #285: the Claude Desktop's `local_…` of a session for the open route; default the panel builder's index. */
  localOf?: (sessionId: string) => Promise<string | null> | string | null;
  /** O servidor MCP em `/mcp` (src/mcp). Sem ele, `/mcp` dá 404. */
  mcp?: McpServer;
  /** The commit of the running code, in `/api/overview`: whoever starts another core compares (src/owner). */
  commit?: string | null;
  /** The change cursor; turns on `GET /api/changes`. */
  changes?: ChangeCursor;
  /** The GitHub Project kanban (#80). Without it, `/api/project` answers 503. */
  project?: OpcoesDoProjeto;
  /** The session Detail reads (`/api/sessions/<id>…`); without them, 404. */
  detail?: LeiturasDoDetalhe;
  /** The activity feed; turns on `GET /api/events` (#94). */
  events?: FeedDeEventos;
  /** The MCP fleet reader; turns on `GET /api/attention`. */
  fleet?: FleetReader;
  /** The remote machines whose sessions also enter `GET /api/attention` (#176); a function follows machines.json live (#244). */
  remoteAttention?: readonly RemoteAttentionSource[] | (() => readonly RemoteAttentionSource[]);
  /** A tela Analytics (#95, #32); liga `GET /api/analytics` e `/api/analytics/cost`. */
  analytics?: RotaAnalytics;
  /** The Sessions screen's list; turns on `GET /api/sessions`. */
  sessions?: ListaDeSessoes;
  /** The ended sessions by day; turns on `GET /api/history` (#33). */
  history?: SessionHistory;
  /** O Kanban (#31); liga `GET /api/kanban`. */
  kanban?: QuadroKanban;
  /** The /ui's Decisions page and tab and the Promote (api/decisions-ui.ts, #103). Without it, those routes give 404. */
  decisionsUi?: DecisoesDaUi;
  /** Repositórios do GitHub e métricas (api/repos.ts); sem ela, `/api/repos` dá 404. */
  repos?: RotaDosRepos;
  /** The Instructions tab of a repository (api/agent-instructions.ts, #183); without it, `/api/agent-instructions` gives 404. */
  agentInstructions?: AgentInstructionsRoute;
  /** Instalar o Ahrena Framework num repositório por PR (api/framework-install.ts, #184); sem ela, `/api/framework-install` dá 404. */
  frameworkInstall?: FrameworkInstallRoute;
  /** As ADRs e as PDRs dos repositórios (api/adrs.ts, #174); sem ela, `/api/adrs` e `/api/pdrs` dão 404. */
  decisions?: DecisionsRoute;
  /** The Dev Console (#177); turns on `GET /api/dev-console`. */
  devConsole?: Pick<DevConsole, 'overview' | 'view'>;
  /** The Agent Config screen (`createAgentConfigRoute`); without it, `/api/agent-config` gives 404. */
  agentConfig?: AgentConfigRoute;
  /** Machine telemetry (#175); without it, `/api/machines` and `/api/telemetry` give 404. */
  telemetry?: TelemetryService | null;
  /** #243: reads the remote machines' lists for `?machine=` (api/machine-sessions.ts); without it, only this machine. */
  machineReader?: MachineReader | null;
  /** The reconnect of the remote machines (#244); without it, `POST /api/machines/<id>/reconnect` gives 404 or 409. */
  reconnect?: ReconnectControl | null;
  /** Sending a message to a live session (api/messaging.ts, #61); without it, those routes give 404. */
  messaging?: MessagingRoute;
  /** The /ui's orders to a session, carried by the panel mod (api/orders.ts, #61); without it, those routes give 404. */
  orders?: OrdersRoute;
  /** The Tools screen (#280, decision 0014): the executor (or only the service, read-only); without it, `/api/tools` gives 404. */
  tools?: ToolsControl | null;
  /** The terminal sessions' actions (#350): `POST /api/terminals/<id>/actions/<action>`; without it, 404. */
  terminals?: TerminalControl | null;
  /** The Docker screen's actions (#288, decision 0017; api/docker.ts): `/api/docker` on the Tools executor's queue; without it, 404. */
  docker?: { route: DockerRoute; acceptNoOrigin: () => boolean } | null;
  /** The cloud connectors (#277, decision 0013; api/clouds.ts): `/api/connectors` and the logins; without it, 404. */
  clouds?: CloudsRoute | null;
  /** The port release (#286, decision 0016; api/ports.ts): `/api/ports/release` and the same under `/api/machines/<id>/`; without it, 404. */
  ports?: PortsRoute | null;
  /** The desktop app's update notice (#330, api/app-update.ts): `/api/app-update`; without it, 404. */
  appUpdate?: AppUpdateRoute | null;
  /** The connection of the remote machines (#278, api/connection.ts): start, stop, reconnect, login-and-start, cancel; without it, 404. */
  machineConnection?: ConnectionRoute | null;
  /** The console's own GitHub connection (#241); turns on `/api/connections` and its writes. */
  connection?: GithubConnection | null;
  /** Where `POST /api/project/selection` stores the chosen Project (#241); without it, 503 `off`. */
  projectSelection?: ProjectSelectionTarget | null;
  /**
   * #241: whether GitHub is connected (the connection's `connected()`, no network). When given and false,
   * every GitHub-backed screen route answers 409 `github-not-connected` before any GitHub call. Not
   * given under --no-github, so those routes keep their `off` / `no-github` answers.
   */
  githubConnected?: (() => Promise<boolean>) | null;
}

/** The GitHub-backed screen routes the 409 `github-not-connected` gate covers (#241). */
export function isGithubScreenRoute(pathname: string): boolean {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  return (
    under(REPOS_ROUTE) ||
    pathname.startsWith(`${AGENT_INSTRUCTIONS_ROUTE}/`) ||
    under(ADRS_ROUTE) ||
    under(PDRS_ROUTE) ||
    pathname === DEV_CONSOLE_ROUTE ||
    (ehDoProjeto(pathname)) ||
    pathname.startsWith(`${FRAMEWORK_INSTALL_ROUTE}/`) ||
    pathname === '/api/analytics/delivery'
  );
}

/** The `local_<uuid>` id of the Claude Desktop index, and nothing else. */
export const DESKTOP_LOCAL_ID = /^local_[0-9a-f-]{36}$/;

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

export interface LocalApi {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARAM = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
const CWD = /^\/[^\0\n]{0,1023}$/;
const MAX_BODY = 4096;

/** Our own `/ui` reading: a same-origin `GET`. */
const sameOriginRead = (req: IncomingMessage, port: number): boolean => req.method === 'GET' && fromOwnUi(req, port);

/**
 * The Detail's "Abrir no Claude Desktop": only `POST /open/<local_…>` from the same origin, with the raw URL exactly like that (no query, no `..`). The rest of decision 0003
 * holds as in the other writes: JSON (`openDirect` checks it) and the strict id.
 */
const sameOriginOpen = (req: IncomingMessage, port: number): boolean =>
  req.method === 'POST' && /^\/open\/local_[0-9a-f-]{36}$/.test(req.url ?? '') && fromOwnUi(req, port);

/** #285's open button: only `POST /api/sessions/<uuid>/open`, the exact raw path (a query gives 403), from the same origin. */
const sameOriginSessionOpen = (req: IncomingMessage, port: number): boolean =>
  req.method === 'POST' && SESSION_OPEN_FROM_UI.test(req.url ?? '') && fromOwnUi(req, port);

/** "Nova sessão": only `POST /api/new-session`, the exact raw path, from the same origin. */
const sameOriginNewSession = (req: IncomingMessage, port: number): boolean => req.method === 'POST' && req.url === NEW_SESSION_ROUTE && fromOwnUi(req, port);

/** `decodeURIComponent`, or the raw text when it is malformed (the id check then refuses it). */
function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Our own `/ui` deciding (#103): only `POST /api/decisions/<id>/<action>`, with the exact raw path (a query gives 403) and from the same origin. The id
 * starts with an alphanumeric: `/api/decisions/../confirm` does not pass. The mandatory JSON stays with the handler (415).
 */
const sameOriginDecision = (req: IncomingMessage, port: number): boolean =>
  req.method === 'POST' && DECISION_WRITE_FROM_UI.test(req.url ?? '') && fromOwnUi(req, port);

/** The decision list scope of a parameter, or `null`. */
const scopeOf = (v: string | null): PanelDecisionScope | null => (ESCOPOS_DAS_DECISOES.includes(v as PanelDecisionScope) ? (v as PanelDecisionScope) : null);

/** What the panel sends about itself: the same parameters as `GET /api/panel`. */
function panelRequestOf(sessionId: string, url: URL): PedidoDoPainel {
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
    cwd: cwd && CWD.test(cwd) ? cwd : null,
    decisoes: scopeOf(url.searchParams.get('decisions')),
  };
}

/** The request body, or `null` past `MAX_BODY`. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', reject);
  });
}

export function startLocalApi(opts: ApiOptions): Promise<LocalApi> {
  const log = opts.log ?? ((m: string) => console.error(`[ahrena-console api] ${m}`));
  const hooks = createHookRoute(opts.hooks);
  const mcp = opts.mcp ? createMcpRoute(opts.mcp) : null;
  const projectRoute = criarRotaDoProjeto(opts.project ?? { kanban: null, fonte: 'github', log });
  const openDescriber = opts.openDescriber ?? new SessionOpenDescriber();
  const wall = muralDoPainel(opts.panelBuilder, { open: openDescriber });
  const machineSessions = createMachineSessionsRoute({ reader: opts.machineReader, telemetry: opts.telemetry, local: { sessions: opts.sessions, wall, kanban: opts.kanban, history: opts.history, events: opts.events, dashboard: opts.fleet ? () => montarDashboard(opts.fleet!) : null, panel: opts.panelBuilder } });
  const remotes = (): readonly RemoteAttentionSource[] => (typeof opts.remoteAttention === 'function' ? opts.remoteAttention() : (opts.remoteAttention ?? []));
  const sessionOpen = createSessionOpenRoute({
    storage: opts.panelBuilder.storage,
    localOf:
      opts.localOf ??
      (async (id) => {
        await opts.panelBuilder.atualizarFontes();
        return opts.panelBuilder.localDe(id);
      }),
    describer: openDescriber,
    openInDesktop: opts.openInDesktop,
    openTerminal: opts.openTerminal,
    focusTerminal: opts.focusTerminal,
    isRemote: (id) => remotes().some((r) => remoteAttentionItems(r.attention(), r).some((i) => i.session === id)),
    log,
  });
  const newSession = createNewSessionRoute({ storage: opts.panelBuilder.storage, openInDesktop: opts.openInDesktop, openTerminal: opts.openTerminal, isThrowaway: opts.isThrowawayFolder, log });
  const counters = { requests: 0, panel: 0, panelMs: 0 };
  let port = 0;

  async function panel(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const t0 = performance.now();
    const body = await opts.panelBuilder.montar(panelRequestOf(sessionId, url));
    counters.panel++;
    counters.panelMs += performance.now() - t0;
    send(res, 200, body);
  }

  async function decisionList(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const scope = scopeOf(url.searchParams.get('scope') ?? 'family');
    if (!scope) return send(res, 400, { error: 'scope: session, family ou branch' });
    const list = await opts.panelBuilder.listaDeDecisoes(panelRequestOf(sessionId, url), scope);
    if (!list) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
    send(res, 200, list);
  }

  // A write: JSON only, with the session in the body; the panel builder checks the session sees the decision. The body
  // is `{ session, text }`.
  async function decide(req: IncomingMessage, res: ServerResponse, id: string, action: AcaoNaDecisao, url: URL) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!ID.test(id)) return send(res, 400, { error: 'id de decisão inválido' });
    const text = await readBody(req);
    if (text === null) return send(res, 413, { error: 'corpo grande demais' });
    let session: unknown;
    let adjustment: unknown;
    try {
      const body = JSON.parse(text) as { session?: unknown; text?: unknown } | null;
      session = body?.session;
      adjustment = body?.text;
    } catch {
      return send(res, 400, { error: 'JSON inválido' });
    }
    if (typeof session !== 'string' || !ID.test(session)) return send(res, 400, { error: 'informe a sessão: { "session": "<id>" }' });
    try {
      const decision = await opts.panelBuilder.decidir(panelRequestOf(session, url), id, action, typeof adjustment === 'string' ? adjustment : null);
      if (!decision) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
      log(`decision ${id}: ${action} by session ${session}`);
      send(res, 200, { decision });
    } catch (err) {
      if (err instanceof ErroDaDecisao) return send(res, err.status, { error: err.message });
      throw err;
    }
  }

  // The id passed the `local_<hex and hyphen>` pattern: nothing else from the request goes into the address.
  function redirectToDesktop(res: ServerResponse, local: string) {
    const target = `claude://claude.ai/epitaxy/${local}`;
    const body = `<!doctype html><meta charset="utf-8"><title>Abrindo a sessão</title><p>Abrindo a sessão no Claude Desktop… <a href="${target}">abrir</a></p>`;
    res.writeHead(302, { location: target, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  // A write like the decisions': JSON only and only from 127.0.0.1 (`handle`'s `allowedLocalRequest`).
  async function openDirect(req: IncomingMessage, res: ServerResponse, local: string) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!DESKTOP_LOCAL_ID.test(local)) return send(res, 400, { error: 'id de sessão do Desktop inválido' });
    if (!opts.openInDesktop) return send(res, 501, { error: 'abrir a sessão só no macOS, com o Claude Desktop' });
    try {
      await opts.openInDesktop(`claude://claude.ai/epitaxy/${local}`);
      log(`session ${local} opened in the Claude Desktop`);
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 502, { error: `não deu para abrir: ${(err as Error).message}` });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    counters.requests++;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    // The Tools writes have their own, stricter gate (no Origin is 403 too), never the one below.
    if (isToolsWrite(req, url.pathname)) {
      if (!toolsWriteAllowed(req, port, opts.tools?.acceptNoOriginActions?.() ?? false)) {
        req.resume();
        return send(res, 403, { error: 'origem não permitida' });
      }
      return respondToolsWrite(req, res, url, opts.tools);
    }
    // The terminal actions have a gate of their own, as strict as the Tools': no Origin is 403 too.
    if (isTerminalsRoute(url.pathname) && req.method !== 'GET') {
      if (!terminalsWriteAllowed(req, port, opts.terminals?.acceptNoOriginActions() ?? false)) {
        req.resume();
        return send(res, 403, { error: 'origem não permitida' });
      }
      return respondTerminalsWrite(req, res, url, opts.terminals);
    }
    // The port release writes have their own gate too (decision 0016): the Origin, or none only when asked for.
    if (isPortsWrite(req, url.pathname)) {
      if (!opts.ports || !portsWriteAllowed(req, port, opts.ports.acceptNoOrigin())) {
        req.resume();
        return send(res, opts.ports ? 403 : 404, { error: opts.ports ? 'origem não permitida' : 'não encontrado' });
      }
      return opts.ports.handle(req, res, url);
    }
    // The Docker writes share the Tools writes' strict gate (no Origin is 403 unless this núcleo accepts remote actions).
    if (isDockerWrite(req, url.pathname)) {
      if (!dockerWriteAllowed(req, port, opts.docker?.acceptNoOrigin() ?? false)) {
        req.resume();
        return send(res, 403, { error: 'origem não permitida' });
      }
      if (!opts.docker) {
        req.resume();
        return send(res, 404, { error: 'o núcleo subiu sem a tela Docker' });
      }
      return opts.docker.route(req, res, url);
    }
    // #241: the six writes only the /ui itself makes, checked before anything else.
    if (STRICT_WRITE_ROUTES.has(url.pathname)) {
      const refusal = strictWriteRefusal(req, port, url.pathname);
      if (refusal) return send(res, refusal.status, refusal.body);
      if (url.pathname === PROJECT_SELECTION_ROUTE) return respondProjectSelection(req, res, opts.projectSelection ?? null);
      if (!opts.connection) return send(res, 404, { error: 'not-found' });
      return respondConnections(req, res, url.pathname, opts.connection);
    }
    if (!allowedLocalRequest(req, port) && !sameOriginRead(req, port) && !sameOriginOpen(req, port) && !sameOriginSessionOpen(req, port) && !sameOriginNewSession(req, port) && !mesmaOrigemMovendo(req, port) && !sameOriginDecision(req, port) && !agentConfigWriteFromSameOrigin(req, port) && !frameworkInstallWriteFromSameOrigin(req, port) && !reconnectFromSameOrigin(req, port) && !messagesWriteFromSameOrigin(req, port) && !cloudsWriteFromSameOrigin(req, port) && !connectionWriteFromSameOrigin(req, port) && !ordersWriteFromSameOrigin(req, port) && !appUpdateWriteFromSameOrigin(req, port)) return send(res, 403, { error: 'origem não permitida' });
    // The Project list spends GitHub quota and the connection status is the /ui's: another site's page
    // never gets either, connected or not (#241 review 2).
    if ((url.pathname === PROJECT_OPTIONS_ROUTE || url.pathname === CONNECTIONS_ROUTE) && fromAnotherSite(req)) return send(res, 403, { error: 'forbidden' });
    if (opts.githubConnected && isGithubScreenRoute(url.pathname) && !(await opts.githubConnected())) return send(res, 409, { error: 'github-not-connected' });
    if (url.pathname.startsWith(HOOKS_PATH)) return hooks(req, res);
    if (req.method === 'GET' && (await machineSessions(res, url))) return;
    const openMatch = OPEN.exec(url.pathname);
    if (openMatch && req.method === 'POST') return openDirect(req, res, decodeURIComponent(openMatch[1]!));
    const sessionOpenMatch = SESSION_OPEN_ROUTE.exec(url.pathname);
    if (sessionOpenMatch) return sessionOpen(req, res, decodeSegment(sessionOpenMatch[1]!));
    if (url.pathname === NEW_SESSION_ROUTE || url.pathname === NEW_SESSION_FOLDERS_ROUTE) return newSession(req, res, url.pathname);
    if (opts.decisionsUi && (await responderDecisoesDaUi(req, res, url, opts.decisionsUi, log))) return;
    const actionMatch = DECISION_ACTION.exec(url.pathname);
    if (actionMatch) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      return decide(req, res, decodeURIComponent(actionMatch[1]!), DECISION_ACTIONS[actionMatch[2]!]!, url);
    }
    if (mcp && url.pathname === MCP_PATH) return mcp(req, res);
    if (url.pathname === CONNECTIONS_ROUTE && opts.connection) return respondConnections(req, res, url.pathname, opts.connection);
    if (ehDoProjeto(url.pathname)) return projectRoute(req, res, url);
    if (opts.agentConfig && (url.pathname === AGENT_CONFIG_ROUTE || url.pathname.startsWith(`${AGENT_CONFIG_ROUTE}/`))) return opts.agentConfig(req, res, url);
    if (opts.frameworkInstall && url.pathname.startsWith(`${FRAMEWORK_INSTALL_ROUTE}/`)) return opts.frameworkInstall(req, res, url);
    if (opts.machineConnection && isConnectionRoute(url.pathname)) return opts.machineConnection(req, res, url);
    const reconnectMatch = RECONNECT_ROUTE.exec(url.pathname);
    if (reconnectMatch) return respondReconnect(req, res, reconnectMatch[1]!, opts.reconnect, opts.telemetry);
    if (opts.messaging && MESSAGING_ROUTE.test(url.pathname)) return opts.messaging(req, res, url);
    if (opts.orders && ORDERS_ROUTE.test(url.pathname)) return opts.orders(req, res, url);
    if (opts.clouds && isCloudsRoute(url.pathname)) return opts.clouds(req, res, url);
    if (opts.ports && isPortsRoute(url.pathname)) return opts.ports.handle(req, res, url);
    if (opts.docker && isDockerRoute(url.pathname)) return opts.docker.route(req, res, url);
    if (opts.appUpdate && isAppUpdateRoute(url.pathname)) return opts.appUpdate(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    if (isUiPath(url.pathname)) return respondUi(res, url.pathname);
    const desktopMatch = OPEN_IN_DESKTOP.exec(url.pathname);
    if (desktopMatch) return redirectToDesktop(res, desktopMatch[1]!);
    // `pid` proves who holds the port: whoever reads the lock only stops the core if its pid is this one (src/owner).
    if (url.pathname === '/api/overview') return send(res, 200, { ok: true, name: 'ahrena-console', version: API_VERSION, pid: process.pid, commit: opts.commit ?? null });
    if (url.pathname === CHANGES_ROUTE && opts.changes) return serveChanges(res, url, opts.changes);
    if (url.pathname === WALL_ROUTE) return responderMural(res, wall, url.searchParams.has('parkedLimit') ? Number(url.searchParams.get('parkedLimit')) : undefined);
    if (url.pathname === EVENTS_ROUTE && opts.events) return responderEventos(res, url, opts.events);
    if (url.pathname === ATTENTION_ROUTE && opts.fleet) return send(res, 200, await montarAtencao(opts.fleet, opts.changes?.current ?? null, remotes(), openDescriber));
    if (url.pathname === DASHBOARD_ROUTE && opts.fleet) return send(res, 200, await montarDashboard(opts.fleet));
    if (opts.analytics && RotaAnalytics.atende(url.pathname)) {
      const r = await opts.analytics.responder(url);
      return send(res, r.status, r.corpo);
    }
    if (url.pathname === SESSIONS_ROUTE && opts.sessions) return responderSessoes(res, url, opts.sessions);
    if (url.pathname === HISTORY_ROUTE) return responderHistorico(res, url, opts.history);
    if (url.pathname === KANBAN_ROUTE && opts.kanban) return responderKanban(res, url, opts.kanban);
    if (opts.repos && (url.pathname === REPOS_ROUTE || url.pathname.startsWith(`${REPOS_ROUTE}/`))) return opts.repos(res, url);
    if (opts.agentInstructions && url.pathname.startsWith(`${AGENT_INSTRUCTIONS_ROUTE}/`)) return opts.agentInstructions(res, url);
    if (opts.decisions && [ADRS_ROUTE, PDRS_ROUTE].some((r) => url.pathname === r || url.pathname.startsWith(`${r}/`))) return opts.decisions(res, url);
    if (url.pathname === DEV_CONSOLE_ROUTE && opts.devConsole) return respondDevConsole(res, url, opts.devConsole);
    if (isTelemetryRoute(url.pathname)) return respondTelemetry(res, url, opts.telemetry);
    if (isToolsRoute(url.pathname)) return respondTools(res, url, opts.tools);
    if (url.pathname === LOAD_ROUTE) {
      return send(res, 200, {
        ...counters,
        eventsRead: opts.panelBuilder.resumos.eventosLidos,
        ...(opts.changes ? { openWaits: opts.changes.openWaits } : {}),
        ...(opts.load?.() ?? {}),
      });
    }
    if (await responderWorkflows(res, url, opts.panelBuilder)) return;
    const m = PANEL.exec(url.pathname);
    if (m) return panel(res, decodeURIComponent(m[1]!), url);
    const d = DECISION_LIST.exec(url.pathname);
    if (d) return decisionList(res, decodeURIComponent(d[1]!), url);
    const det = opts.detail && DETAIL_ROUTE.exec(url.pathname);
    if (det) return opts.detail!.responder(res, decodeURIComponent(det[1]), det[2] ?? null, url);
    send(res, 404, { error: 'não encontrado' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error on ${req.url}: ${(err as Error).message}`);
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
            opts.changes?.close();
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    };
    if (opts.listenOn) server.listen(opts.listenOn, listening);
    else server.listen(opts.port ?? 4720, opts.host ?? '127.0.0.1', listening);
  });
}
