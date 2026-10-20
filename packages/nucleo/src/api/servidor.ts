// API local mínima do núcleo (começo da #21), em 127.0.0.1: os hooks e o painel na mesma porta.
//
// | Rota                          | O quê                                                     |
// | ----------------------------- | --------------------------------------------------------- |
// | `GET /api/overview`           | Saúde: o painel e o script de carga esperam por ela        |
// | `GET /api/painel/<sessão>`    | Tudo o que o painel desenha, num pedido (api/tipos.ts)     |
// | `GET /api/sessao/<sessão>`    | O mesmo, no caminho que o script de carga já usa           |
// | `GET /api/carga`              | Contadores para a medição de carga                         |
// | `POST /api/hooks`             | O receptor de hooks (src/ingest/hooks)                     |
// | `GET /api/decisoes/<sessão>`  | As decisões de um escopo (`?escopo=sessao|familia|branch`)  |
// | `POST /api/decisoes/<id>/confirmar` e `/descartar` | O Confirmar e o Descartar de uma sugerida |
// | `POST /abrir/<local_…>`       | Abre a conversa no Claude Desktop (`open claude://…`, no macOS); JSON, como as outras escritas |
// | `GET /abrir/<local_…>`        | Redireciona para `claude://claude.ai/epitaxy/<local_…>`, que abre a conversa no Claude Desktop (o `Link` do mod só leva `http://localhost`) |
// | `POST /api/decisoes/<id>/ajustar` e `/desfazer` | O ajuste escrito pela pessoa (`{ texto }`) e o Desfazer da última ação |
// | `POST /mcp`                   | O servidor MCP (src/mcp), quando `mcp` é passado           |
// | `GET /api/mudancas`           | Long polling das mudanças (src/mudancas, item 2.4)         |
// | `GET /ui` e `/ui/*`           | A interface do console (api/ui.ts, pasta `ui/`, #26)       |
// | `GET /api/projeto`            | O kanban do GitHub Project (api/projeto.ts, #80); `?forcar=1` relê |
// | `POST /api/projeto/mover`     | Muda o Status de um card: `{ itemId, optionId }` (api/projeto.ts) |
//
// `?local=`, `?conta=`, `?org=`, `?modelo=` e `?cwd=` no painel são o que ele lê da própria sessão;
// `?decisoes=<escopo>` traz a lista de decisões aberta no mesmo pedido.
// Pedido com `Origin` ou com `Host` que não seja o nosso dá 403 (decisão 0003). A exceção é a própria
// `/ui` lendo: um `GET` cujo `Origin` é exatamente `http://<Host>` (um navegador pode mandar `Origin`
// até num `fetch` da mesma origem). Escrita com `Origin` continua recusada, salvo o
// `POST /api/projeto/mover` da própria `/ui`, com o mesmo `Origin` (api/projeto.ts). A escrita nas
// decisões pede ainda `Content-Type: application/json` e o corpo `{ "sessao": "<id>" }`, e só
// alcança uma decisão que essa sessão enxerga, da conta dela.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowedLocalRequest, createHookRoute, HOOKS_PATH, send, type HookRouteOptions } from '../ingest/hooks/receiver.ts';
import type { CursorDeMudancas } from '../mudancas/cursor.ts';
import { ROTA_DAS_MUDANCAS, responderMudancas } from '../mudancas/http.ts';
import { ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao } from './decisoes.ts';
import type { MontadorDoPainel, PedidoDoPainel } from './painel.ts';
import type { EscopoDasDecisoes } from './tipos.ts';
import { VERSAO_DA_API } from './versao.ts';
import { CAMINHO_DO_MCP, criarRotaMcp } from '../mcp/http.ts';
import { ehDaUi, responderUi } from './ui.ts';
import type { ServidorMcp } from '../mcp/protocolo.ts';
import { criarRotaDoProjeto, ehDoProjeto, mesmaOrigemMovendo, type OpcoesDoProjeto } from './projeto.ts';

export { VERSAO_DA_API };

export interface OpcoesDaApi {
  montador: MontadorDoPainel;
  hooks: HookRouteOptions;
  host?: string;
  /** 0 escolhe uma porta livre (testes). Padrão 4720. */
  port?: number;
  log?: (mensagem: string) => void;
  /** Contadores extras para `/api/carga` (seguidor, índice do Desktop). */
  carga?: () => Record<string, unknown>;
  /**
   * Abre um endereço `claude://` no Claude Desktop (no macOS, `open <url>`). Sem ela, o
   * `POST /abrir/<local_…>` responde 501 e o painel fica com o link de reserva.
   */
  abrirNoDesktop?: ((url: string) => Promise<void>) | null;
  /** O servidor MCP em `/mcp` (src/mcp). Sem ele, `/mcp` dá 404. */
  mcp?: ServidorMcp;
  /** O commit do código no ar, em `/api/overview`: quem sobe outro núcleo compara (src/dono). */
  commit?: string | null;
  /** O cursor de mudanças; liga `GET /api/mudancas`. */
  mudancas?: CursorDeMudancas;
  /** O kanban do GitHub Project (#80). Sem ele, `/api/projeto` responde 503. */
  projeto?: OpcoesDoProjeto;
}

/** O id `local_<uuid>` do índice do Claude Desktop, e nada mais. */
export const LOCAL_DO_DESKTOP = /^local_[0-9a-f-]{36}$/;

export interface ApiLocal {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARAM = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
const CAMINHO = /^\/[^\0\n]{0,1023}$/;
const MAX_CORPO = 4096;

/** A própria `/ui` lendo: `GET` com `Origin` igual a `http://<Host>`, e o Host já é o nosso. */
function mesmaOrigemLendo(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origem = req.headers.origin;
  if (req.method !== 'GET' || typeof origem !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origem === `http://${host}`;
}

const escopoDe = (v: string | null): EscopoDasDecisoes | null => (ESCOPOS_DAS_DECISOES.includes(v as EscopoDasDecisoes) ? (v as EscopoDasDecisoes) : null);

/** O que o painel manda de si: os mesmos parâmetros do `GET /api/painel`. */
function pedidoDe(sessionId: string, url: URL): PedidoDoPainel {
  const p = (k: string) => {
    const v = url.searchParams.get(k);
    return v && PARAM.test(v) ? v : null;
  };
  const cwd = url.searchParams.get('cwd');
  return {
    sessionId,
    local: p('local'),
    conta: p('conta'),
    org: p('org'),
    modelo: p('modelo'),
    cwd: cwd && CAMINHO.test(cwd) ? cwd : null,
    decisoes: escopoDe(url.searchParams.get('decisoes')),
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
    const escopo = escopoDe(url.searchParams.get('escopo') ?? 'familia');
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
    if (!allowedLocalRequest(req, port) && !mesmaOrigemLendo(req, port) && !mesmaOrigemMovendo(req, port)) return send(res, 403, { error: 'origem não permitida' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith(HOOKS_PATH)) return hooks(req, res);
    const direto = /^\/abrir\/([^/]+)$/.exec(url.pathname);
    if (direto && req.method === 'POST') return abrirDireto(req, res, decodeURIComponent(direto[1]));
    const escrita = /^\/api\/decisoes\/([^/]+)\/(confirmar|descartar|ajustar|desfazer)$/.exec(url.pathname);
    if (escrita) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      return decidir(req, res, decodeURIComponent(escrita[1]), escrita[2] as AcaoNaDecisao, url);
    }
    if (mcp && url.pathname === CAMINHO_DO_MCP) return mcp(req, res);
    if (ehDoProjeto(url.pathname)) return projeto(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    if (ehDaUi(url.pathname)) return responderUi(res, url.pathname);
    const abrir = /^\/abrir\/(local_[0-9a-f-]{8,64})$/i.exec(url.pathname);
    if (abrir) return abrirNoDesktop(res, abrir[1]);
    // `pid` prova a posse da porta: quem lê a trava só para o núcleo se o pid dela é este (src/dono).
    if (url.pathname === '/api/overview') return send(res, 200, { ok: true, nome: 'ahrena-console', versao: VERSAO_DA_API, pid: process.pid, commit: opts.commit ?? null });
    if (url.pathname === ROTA_DAS_MUDANCAS && opts.mudancas) return responderMudancas(res, url, opts.mudancas);
    if (url.pathname === '/api/carga') {
      return send(res, 200, {
        ...contadores,
        eventosLidos: opts.montador.resumos.eventosLidos,
        ...(opts.mudancas ? { esperasAbertas: opts.mudancas.abertas } : {}),
        ...(opts.carga?.() ?? {}),
      });
    }
    const m = /^\/api\/(?:painel|sessao)\/([^/]+)$/.exec(url.pathname);
    if (m) return painel(res, decodeURIComponent(m[1]), url);
    const d = /^\/api\/decisoes\/([^/]+)$/.exec(url.pathname);
    if (d) return listaDeDecisoes(res, decodeURIComponent(d[1]), url);
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
