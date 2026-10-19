// Receptor HTTP dos hooks: `POST /api/hooks` em 127.0.0.1. O encaminhador do plugin
// (plugin/hooks/forward.mjs) manda o stdin do hook para cá; o receptor normaliza e grava pela porta.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StoragePort } from '../../storage-port.ts';
import { Perfis } from '../../perfis/perfis.ts';
import type { PerfisDoHook } from './conta.ts';
import { ingestHook, type IngestResult } from './ingest.ts';
import { InvalidHookError } from './normalize.ts';

export const DEFAULT_HOOK_HOST = '127.0.0.1';
/** Mesma porta do núcleo (`AHRENA_CONSOLE_PORT`). */
export const DEFAULT_HOOK_PORT = 4720;
export const HOOKS_PATH = '/api/hooks';
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

export interface HookReceiverOptions {
  storage: StoragePort;
  host?: string;
  /** 0 escolhe uma porta livre (testes). */
  port?: number;
  /** Chamado depois de cada evento gravado; é onde a máquina de estados (1.5) entra. Erros aqui não derrubam a gravação. */
  onEvent?: (result: IngestResult) => void | Promise<void>;
  /** Para onde vão os erros; o padrão é `console.error`. */
  log?: (message: string) => void;
  now?: () => Date;
  /** Perfis (#109) para a conta das sessões; o padrão é um novo sobre a porta. */
  perfis?: PerfisDoHook;
}

export interface HookReceiver {
  server: Server;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_HOOK_BODY_BYTES) return reject(new HttpError(413, 'payload grande demais'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, 'payload grande demais'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/** Rota dos hooks sem servidor próprio: o servidor da API local (src/api) a monta na mesma porta. */
export type HookRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * `POST /api/hooks` e `GET /api/hooks/health`. Quem monta a rota confere `Origin` e `Host` antes
 * (decisão 0003); `startHookReceiver` faz isso para o receptor sozinho.
 */
export type HookRouteOptions = Omit<HookReceiverOptions, 'host' | 'port'>;

export function createHookRoute(opts: HookRouteOptions): HookRoute {
  const log = opts.log ?? ((m: string) => console.error(`[ahrena-console hooks] ${m}`));
  const now = opts.now ?? (() => new Date());
  const perfis = opts.perfis ?? new Perfis({ storage: opts.storage });
  // Uma gravação por vez: os hooks de uma sessão chegam em rajada e a leitura-e-gravação da sessão
  // não pode intercalar.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === `${HOOKS_PATH}/health` && req.method === 'GET') return send(res, 200, { ok: true });
    if (path !== HOOKS_PATH) return send(res, 404, { error: 'não encontrado' });
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    // Exigir JSON obriga um navegador a fazer preflight (que não respondemos), mais uma barreira.
    if (!/^application\/json\b/i.test(header(req, 'content-type') ?? '')) {
      return send(res, 415, { error: 'content-type precisa ser application/json' });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      return send(res, 400, { error: 'JSON inválido' });
    }

    try {
      const result = await serial(() =>
        ingestHook(opts.storage, raw, {
          receivedAt: now().toISOString(),
          firedAt: header(req, 'x-ahrena-hook-at'),
          deliveryId: header(req, 'x-ahrena-delivery-id'),
          perfis,
        }),
      );
      send(res, 202, { id: result.event.id, duplicate: !result.appended });
      if (result.appended && opts.onEvent) {
        try {
          await opts.onEvent(result);
        } catch (err) {
          log(`onEvent falhou para ${result.event.type}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (err instanceof InvalidHookError) return send(res, 400, { error: err.message });
      log(`falha ao gravar hook: ${(err as Error).message}`);
      send(res, 500, { error: 'falha ao gravar' });
    }
  };
}

/** Contra CSRF e DNS rebinding (decisão 0003): nada de navegador, e o Host tem de ser o nosso. */
export function allowedLocalRequest(req: IncomingMessage, port: number): boolean {
  const host = header(req, 'host');
  return !header(req, 'origin') && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

export function startHookReceiver(opts: HookReceiverOptions): Promise<HookReceiver> {
  const log = opts.log ?? ((m: string) => console.error(`[ahrena-console hooks] ${m}`));
  const route = createHookRoute(opts);
  let port = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedLocalRequest(req, port)) return send(res, 403, { error: 'origem não permitida' });
    return route(req, res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`erro inesperado: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'erro interno' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_HOOK_PORT, opts.host ?? DEFAULT_HOOK_HOST, () => {
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
