// API local mínima do núcleo (começo da #21), em 127.0.0.1: os hooks e o painel na mesma porta.
//
// | Rota                          | O quê                                                     |
// | ----------------------------- | --------------------------------------------------------- |
// | `GET /api/overview`           | Saúde: o painel e o script de carga esperam por ela        |
// | `GET /api/panel/<session>`    | Tudo o que o painel desenha, num pedido (api/tipos.ts)     |
// | `GET /api/wall`               | Um card por sessão aberta, para o "Mural ao vivo" (api/mural.ts, #34) |
// | `GET /api/load`               | Contadores para a medição de carga                         |
// | `POST /api/hooks`             | O receptor de hooks (src/ingest/hooks)                     |
// | `GET /api/decisions/<session>` | As decisões de um escopo (`?scope=session|family|branch`)  |
// | `POST /api/decisions/<id>/confirm` e `/dismiss` | O Confirmar e o Descartar de uma sugerida |
// | `POST /api/decisions/<id>/adjust` e `/undo` | O ajuste escrito pela pessoa (`{ texto }`) e o Desfazer da última ação |
// | `POST /open/<local_…>`        | Abre a conversa no Claude Desktop (`open claude://…`, no macOS); JSON, como as outras escritas |
// | `GET /open/<local_…>`         | Redireciona para `claude://claude.ai/epitaxy/<local_…>`, que abre a conversa no Claude Desktop (o `Link` do mod só leva `http://localhost`) |
// | `POST /mcp`                   | O servidor MCP (src/mcp), quando `mcp` é passado           |
// | `GET /api/changes`            | Long polling das mudanças (`?since=`, `?wait=`; src/mudancas, item 2.4) |
// | `GET /api/events`             | O feed de atividade, todas as sessões (api/eventos.ts, #94) |
// | `GET /api/attention`          | Quem precisa de você, em todas as contas (a bandeja, #87)  |
// | `GET /api/dashboard`          | Números, agentes ativos e atividade do Dashboard (C1, #27) |
// | `GET /api/analytics` e `/api/analytics/cost` | A tela Analytics (`?tz=`, `?days=`; api/rota-analytics.ts, #95 e #32) |
// | `GET /api/sessions`           | A lista da tela Sessões, paginada e filtrada (api/sessoes.ts, #28) |
// | `GET /api/history`            | As sessões encerradas por dia (`?before=`, `?days=`, `?search=`; api/historico.ts, #33) |
// | `GET /ui` e `/ui/*`           | A interface do console (api/ui.ts, pasta `ui/`, #26)       |
// | `GET /api/kanban`             | O Kanban só leitura, sessões ou agentes por coluna (`?view=`; api/kanban.ts, #31) |
// | `GET /api/workflows` e `/api/sessions/<id>/workflow` | Workflows e a aba Workflow (api/workflows.ts, #96 e #97) |
// | `GET /api/project`            | O kanban do GitHub Project (api/projeto.ts, #80); `?refresh=1` relê |
// | `POST /api/project/move`      | Muda o Status de um card: `{ itemId, optionId }` (api/projeto.ts) |
// | `GET /api/sessions/<id>` e `/agents`, `/conversation`, `/events` | O Detalhe da sessão na /ui (api/detalhe.ts, #29 e #30) |
//
// The old Portuguese routes and query parameters (`/api/painel/<id>`, `/api/sessao/<id>`, `/abrir/<id>`,
// `/api/atencao`, `/api/mudancas?desde=&espera=`…) answer as aliases of these, with the same response:
// `normalizeLegacyUrl` (api/legacy-routes.ts, the only place that knows them) runs before the routing
// (issue #173, phase 1). They leave in phase 6, after the published mod and the installed app migrate.
//
// `?local=`, `?account=`, `?org=`, `?model=` e `?cwd=` no painel são o que ele lê da própria sessão;
// `?decisions=<scope>` traz a lista de decisões aberta no mesmo pedido.
// Pedido com `Origin` ou com `Host` que não seja o nosso dá 403 (decisão 0003). A exceção é a própria
// `/ui` lendo: um `GET` cujo `Origin` é exatamente `http://<Host>` (um navegador pode mandar `Origin`
// até num `fetch` da mesma origem). Escrita com `Origin` continua recusada, salvo duas, só com `Origin`
// exatamente `http://<Host>` (e JSON): o "Abrir no Claude Desktop" do Detalhe, `POST /open/<local_…>`
// (ou o alias `/abrir/<local_…>`), e o `POST /api/project/move` do Kanban do projeto (api/projeto.ts).
// A escrita nas decisões pede ainda `Content-Type: application/json` e o corpo `{ "sessao": "<id>" }`,
// e só alcança uma decisão que essa sessão enxerga, da conta dela.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowedLocalRequest, createHookRoute, HOOKS_PATH, send, type HookRouteOptions } from '../ingest/hooks/receiver.ts';
import type { CursorDeMudancas } from '../mudancas/cursor.ts';
import { CHANGES_ROUTE, responderMudancas } from '../mudancas/http.ts';
import { ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao } from './decisoes.ts';
import type { MontadorDoPainel, PedidoDoPainel } from './painel.ts';
import type { EscopoDasDecisoes } from './tipos.ts';
import { VERSAO_DA_API } from './versao.ts';
import { CAMINHO_DO_MCP, criarRotaMcp } from '../mcp/http.ts';
import { ehDaUi, responderUi } from './ui.ts';
import { responderWorkflows } from './workflows.ts';
import { muralDoPainel, WALL_ROUTE, responderMural } from './mural.ts';
import { SESSIONS_ROUTE, responderSessoes, type ListaDeSessoes } from './sessoes.ts';
import { HISTORY_ROUTE, responderHistorico } from './historico.ts';
import type { HistoricoDeSessoes } from '../historico/leitura.ts';
import { responderKanban, ROTA_DO_KANBAN, type QuadroKanban } from './kanban.ts';
import { EVENTS_ROUTE, responderEventos, type FeedDeEventos } from './eventos.ts';
import type { ServidorMcp } from '../mcp/protocolo.ts';
import { criarRotaDoProjeto, ehDoProjeto, mesmaOrigemMovendo, type OpcoesDoProjeto } from './projeto.ts';
import { DETAIL_ROUTE, type LeiturasDoDetalhe } from './detalhe.ts';
import type { LeituraDaFrota } from '../mcp/frota.ts';
import { montarAtencao, ATTENTION_ROUTE } from './rota-atencao.ts';
import { montarDashboard, ROTA_DO_DASHBOARD } from './rota-dashboard.ts';
import { RotaAnalytics } from './rota-analytics.ts';
import { normalizeLegacyPath, normalizeLegacyUrl } from './legacy-routes.ts';

export { VERSAO_DA_API };

export interface OpcoesDaApi {
  montador: MontadorDoPainel;
  hooks: HookRouteOptions;
  host?: string;
  /** 0 escolhe uma porta livre (testes). Padrão 4720. */
  port?: number;
  log?: (mensagem: string) => void;
  /** Contadores extras para `/api/load` (seguidor, índice do Desktop). */
  carga?: () => Record<string, unknown>;
  /**
   * Abre um endereço `claude://` no Claude Desktop (no macOS, `open <url>`). Sem ela, o
   * `POST /open/<local_…>` responde 501 e o painel fica com o link de reserva.
   */
  abrirNoDesktop?: ((url: string) => Promise<void>) | null;
  /** O servidor MCP em `/mcp` (src/mcp). Sem ele, `/mcp` dá 404. */
  mcp?: ServidorMcp;
  /** O commit do código no ar, em `/api/overview`: quem sobe outro núcleo compara (src/dono). */
  commit?: string | null;
  /** O cursor de mudanças; liga `GET /api/changes`. */
  mudancas?: CursorDeMudancas;
  /** O kanban do GitHub Project (#80). Sem ele, `/api/project` responde 503. */
  projeto?: OpcoesDoProjeto;
  /** As leituras do Detalhe da sessão (`/api/sessions/<id>…`); sem elas, 404. */
  detalhe?: LeiturasDoDetalhe;
  /** O feed de atividade; liga `GET /api/events` (#94). */
  eventos?: FeedDeEventos;
  /** A leitura da frota do MCP; liga `GET /api/attention`. */
  frota?: LeituraDaFrota;
  /** A tela Analytics (#95, #32); liga `GET /api/analytics` e `/api/analytics/cost`. */
  analytics?: RotaAnalytics;
  /** A lista da tela Sessões; liga `GET /api/sessions`. */
  sessoes?: ListaDeSessoes;
  /** As sessões encerradas por dia; liga `GET /api/history` (#33). */
  historico?: HistoricoDeSessoes;
  /** O Kanban (#31); liga `GET /api/kanban`. */
  kanban?: QuadroKanban;
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
/** The action in the URL → the action the panel builder still names in Portuguese (phase 3). */
const DECISION_ACTIONS: Readonly<Record<string, AcaoNaDecisao>> = { confirm: 'confirmar', dismiss: 'descartar', adjust: 'ajustar', undo: 'desfazer' };

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
  const mcp = opts.mcp ? criarRotaMcp(opts.mcp) : null;
  const projeto = criarRotaDoProjeto(opts.projeto ?? { kanban: null, fonte: 'github', log });
  const mural = muralDoPainel(opts.montador);
  const contadores = { pedidos: 0, painel: 0, msPainel: 0 };
  let port = 0;

  async function painel(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const t0 = performance.now();
    const corpo = await opts.montador.montar(pedidoDe(sessionId, url));
    contadores.painel++;
    contadores.msPainel += performance.now() - t0;
    send(res, 200, corpo);
  }

  async function listaDeDecisoes(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const escopo = escopoDe(url.searchParams.get('scope') ?? 'familia');
    if (!escopo) return send(res, 400, { error: 'escopo: sessao, familia ou branch' });
    const lista = await opts.montador.listaDeDecisoes(pedidoDe(sessionId, url), escopo);
    if (!lista) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
    send(res, 200, lista);
  }

  // Escrita: só JSON, com a sessão no corpo; a montagem confere se a sessão enxerga a decisão.
  async function decidir(req: IncomingMessage, res: ServerResponse, id: string, acao: AcaoNaDecisao, url: URL) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!ID.test(id)) return send(res, 400, { error: 'id de decisão inválido' });
    const texto = await lerCorpo(req);
    if (texto === null) return send(res, 413, { error: 'corpo grande demais' });
    let sessao: unknown;
    let ajuste: unknown;
    try {
      const corpo = JSON.parse(texto) as { sessao?: unknown; texto?: unknown } | null;
      sessao = corpo?.sessao;
      ajuste = corpo?.texto;
    } catch {
      return send(res, 400, { error: 'JSON inválido' });
    }
    if (typeof sessao !== 'string' || !ID.test(sessao)) return send(res, 400, { error: 'informe a sessão: { "sessao": "<id>" }' });
    try {
      const decisao = await opts.montador.decidir(pedidoDe(sessao, url), id, acao, typeof ajuste === 'string' ? ajuste : null);
      if (!decisao) return send(res, 404, { error: 'o núcleo subiu sem as decisões' });
      log(`decisão ${id}: ${acao} pela sessão ${sessao}`);
      send(res, 200, { decisao });
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
    contadores.pedidos++;
    // The old routes and parameters become the new ones here, before any check (api/legacy-routes.ts).
    const url = normalizeLegacyUrl(new URL(req.url ?? '/', `http://127.0.0.1:${port}`));
    if (!allowedLocalRequest(req, port) && !mesmaOrigemLendo(req, port) && !mesmaOrigemAbrindo(req, port) && !mesmaOrigemMovendo(req, port)) return send(res, 403, { error: 'origem não permitida' });
    if (url.pathname.startsWith(HOOKS_PATH)) return hooks(req, res);
    const direto = OPEN.exec(url.pathname);
    if (direto && req.method === 'POST') return abrirDireto(req, res, decodeURIComponent(direto[1]!));
    const escrita = DECISION_ACTION.exec(url.pathname);
    if (escrita) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      return decidir(req, res, decodeURIComponent(escrita[1]!), DECISION_ACTIONS[escrita[2]!]!, url);
    }
    if (mcp && url.pathname === CAMINHO_DO_MCP) return mcp(req, res);
    if (ehDoProjeto(url.pathname)) return projeto(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    if (ehDaUi(url.pathname)) return responderUi(res, url.pathname);
    const abrir = OPEN_IN_DESKTOP.exec(url.pathname);
    if (abrir) return abrirNoDesktop(res, abrir[1]!);
    // `pid` prova a posse da porta: quem lê a trava só para o núcleo se o pid dela é este (src/dono).
    if (url.pathname === '/api/overview') return send(res, 200, { ok: true, nome: 'ahrena-console', versao: VERSAO_DA_API, pid: process.pid, commit: opts.commit ?? null });
    if (url.pathname === CHANGES_ROUTE && opts.mudancas) return responderMudancas(res, url, opts.mudancas);
    if (url.pathname === WALL_ROUTE) return responderMural(res, mural);
    if (url.pathname === EVENTS_ROUTE && opts.eventos) return responderEventos(res, url, opts.eventos);
    if (url.pathname === ATTENTION_ROUTE && opts.frota) return send(res, 200, await montarAtencao(opts.frota, opts.mudancas?.atual ?? null));
    if (url.pathname === ROTA_DO_DASHBOARD && opts.frota) return send(res, 200, await montarDashboard(opts.frota));
    if (opts.analytics && RotaAnalytics.atende(url.pathname)) {
      const r = await opts.analytics.responder(url);
      return send(res, r.status, r.corpo);
    }
    if (url.pathname === SESSIONS_ROUTE && opts.sessoes) return responderSessoes(res, url, opts.sessoes);
    if (url.pathname === HISTORY_ROUTE) return responderHistorico(res, url, opts.historico);
    if (url.pathname === ROTA_DO_KANBAN && opts.kanban) return responderKanban(res, url, opts.kanban);
    if (url.pathname === LOAD_ROUTE) {
      return send(res, 200, {
        ...contadores,
        eventosLidos: opts.montador.resumos.eventosLidos,
        ...(opts.mudancas ? { esperasAbertas: opts.mudancas.abertas } : {}),
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
    server.listen(opts.port ?? 4720, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const { address, port: bound } = server.address() as AddressInfo;
      port = bound;
      resolve({
        server,
        url: `http://${address}:${bound}`,
        close: () =>
          new Promise<void>((done, fail) => {
            opts.mudancas?.encerrar();
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
