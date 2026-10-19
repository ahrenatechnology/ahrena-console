// API local mínima do núcleo (começo da #21), em 127.0.0.1: os hooks e o painel na mesma porta.
//
// | Rota                          | O quê                                                     |
// | ----------------------------- | --------------------------------------------------------- |
// | `GET /api/overview`           | Saúde: o painel e o script de carga esperam por ela        |
// | `GET /api/painel/<sessão>`    | Tudo o que o painel desenha, num pedido (api/tipos.ts)     |
// | `GET /api/sessao/<sessão>`    | O mesmo, no caminho que o script de carga já usa           |
// | `GET /api/carga`              | Contadores para a medição de carga                         |
// | `POST /api/hooks`             | O receptor de hooks (src/ingest/hooks)                     |
//
// `?local=`, `?conta=`, `?org=`, `?modelo=` e `?cwd=` no painel são o que ele lê da própria sessão.
// Pedido com `Origin` ou com `Host` que não seja o nosso dá 403 (decisão 0003).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowedLocalRequest, createHookRoute, HOOKS_PATH, send, type HookRouteOptions } from '../ingest/hooks/receiver.ts';
import type { MontadorDoPainel } from './painel.ts';

export const VERSAO_DA_API = '0.0.1';

export interface OpcoesDaApi {
  montador: MontadorDoPainel;
  hooks: HookRouteOptions;
  host?: string;
  /** 0 escolhe uma porta livre (testes). Padrão 4720. */
  port?: number;
  log?: (mensagem: string) => void;
  /** Contadores extras para `/api/carga` (seguidor, índice do Desktop). */
  carga?: () => Record<string, unknown>;
}

export interface ApiLocal {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARAM = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
const CAMINHO = /^\/[^\0\n]{0,1023}$/;

export function iniciarApiLocal(opts: OpcoesDaApi): Promise<ApiLocal> {
  const log = opts.log ?? ((m: string) => console.error(`[ahrena-console api] ${m}`));
  const hooks = createHookRoute(opts.hooks);
  const contadores = { pedidos: 0, painel: 0, msPainel: 0 };
  let port = 0;

  async function painel(res: ServerResponse, sessionId: string, url: URL) {
    if (!ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });
    const p = (k: string) => {
      const v = url.searchParams.get(k);
      return v && PARAM.test(v) ? v : null;
    };
    const t0 = performance.now();
    const cwd = url.searchParams.get('cwd');
    const corpo = await opts.montador.montar({
      sessionId,
      local: p('local'),
      conta: p('conta'),
      org: p('org'),
      modelo: p('modelo'),
      cwd: cwd && CAMINHO.test(cwd) ? cwd : null,
    });
    contadores.painel++;
    contadores.msPainel += performance.now() - t0;
    send(res, 200, corpo);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    contadores.pedidos++;
    if (!allowedLocalRequest(req, port)) return send(res, 403, { error: 'origem não permitida' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith(HOOKS_PATH)) return hooks(req, res);
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    if (url.pathname === '/api/overview') return send(res, 200, { ok: true, nome: 'ahrena-console', versao: VERSAO_DA_API });
    if (url.pathname === '/api/carga') {
      return send(res, 200, {
        ...contadores,
        eventosLidos: opts.montador.resumos.eventosLidos,
        ...(opts.carga?.() ?? {}),
      });
    }
    const m = /^\/api\/(?:painel|sessao)\/([^/]+)$/.exec(url.pathname);
    if (m) return painel(res, decodeURIComponent(m[1]), url);
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
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
