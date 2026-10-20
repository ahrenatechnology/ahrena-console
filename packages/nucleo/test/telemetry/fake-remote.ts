// A FAKE remote núcleo for the #176 tests, on loopback and a free port: no external network, no
// real machine. It answers `GET /api/telemetry` and `GET /api/attention` with what the test sets,
// refuses any Host other than the remote's own `127.0.0.1:4720` (the decision 0003 defense, as
// src/api/servidor.ts does) and records every request, so a test can prove nothing was written.
//
// http.Server is a net.Server, so the helpers below take either.
//
// Also: a port that refuses connections (a tunnel that is down), and servers that accept and never
// answer, or accept and close at once (a tunnel that is up with no núcleo behind it).

import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { TELEMETRY_VERSION, type Alert, type TelemetryReading } from '../../src/telemetry/model.ts';
import { emptySeries } from '../../src/telemetry/series.ts';

export interface RecordedRequest {
  method: string;
  url: string;
  host: string | undefined;
  origin: string | undefined;
}

export interface FakeRemoteState {
  version: number;
  current: TelemetryReading | null;
  alerts: Alert[];
  attention: unknown;
  /** Answers 404 on `/api/telemetry` (a núcleo older than #175). */
  noTelemetry?: boolean;
}

export interface FakeRemote {
  port: number;
  requests: RecordedRequest[];
  state: FakeRemoteState;
  close(): Promise<void>;
}

function listen(server: TcpServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

const closeServer = (server: TcpServer) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A remote's `GET /api/attention` answer, English (#173 phase 2b). */
export function attentionBody(items: unknown[], over: Record<string, unknown> = {}) {
  return { generatedAt: '2026-11-02T12:00:00.000Z', cursor: 'g.1', total: items.length, needs: items.length, yourTurn: 0, active: 1, withError: 0, items, ...over };
}

export function remoteItem(session: string, over: Record<string, unknown> = {}) {
  return {
    session,
    title: `Sessão ${session}`,
    project: 'projeto-exemplo',
    account: { label: 'equipe', color: '#3366ff' },
    level: 'needs',
    reason: 'permission',
    shortReason: 'Pede permissão',
    longReason: 'pede permissão para usar Bash',
    since: '2026-11-02T11:55:00.000Z',
    minutes: 5,
    local: 'local_00000000-0000-4000-8000-000000000009',
    machine: null,
    ...over,
  };
}

/** The same answer from a remote núcleo released before #173 phase 2b: Portuguese keys and values. */
export function oldAttentionBody(items: unknown[], over: Record<string, unknown> = {}) {
  return { geradoEm: '2026-11-02T12:00:00.000Z', cursor: 'g.1', total: items.length, precisam: items.length, suaVez: 0, ativas: 1, comErro: 0, itens: items, ...over };
}

export function oldRemoteItem(sessao: string, over: Record<string, unknown> = {}) {
  return {
    sessao,
    titulo: `Sessão ${sessao}`,
    projeto: 'projeto-exemplo',
    conta: { rotulo: 'equipe', cor: '#3366ff' },
    nivel: 'precisa',
    motivo: 'permissao',
    motivoCurto: 'Pede permissão',
    motivoLongo: 'pede permissão para usar Bash',
    desde: '2026-11-02T11:55:00.000Z',
    minutos: 5,
    local: 'local_00000000-0000-4000-8000-000000000009',
    machine: null,
    ...over,
  };
}

/** A fake remote núcleo. `port` reuses a port (to bring the "same" remote back up). */
export async function startFakeRemote(state: Partial<FakeRemoteState> = {}, port = 0): Promise<FakeRemote> {
  const requests: RecordedRequest[] = [];
  const s: FakeRemoteState = { version: TELEMETRY_VERSION, current: null, alerts: [], attention: attentionBody([]), ...state };
  const header = (req: IncomingMessage, name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined);
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', host: header(req, 'host'), origin: header(req, 'origin') });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (header(req, 'origin') || header(req, 'host') !== '127.0.0.1:4720') return json(403, { error: 'origem não permitida' });
    if (req.method !== 'GET') return json(405, { error: 'use GET' });
    const path = new URL(req.url ?? '/', 'http://127.0.0.1:4720').pathname;
    if (path === '/api/telemetry' && !s.noTelemetry) {
      const machine = { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, version: s.version, port: null, lastReadAt: s.current?.takenAt ?? null, alerts: s.alerts.length };
      return json(200, { version: s.version, machine, hours: 1, current: s.current, series: emptySeries(), alerts: s.alerts });
    }
    if (path === '/api/attention') return json(200, s.attention);
    json(404, { error: 'rota desconhecida' });
  });
  const bound = await listen(server, port);
  return { port: bound, requests, state: s, close: () => closeServer(server) };
}

/**
 * A port where nothing listens: bound for a moment and released. Another test file running at the
 * same time could take it in between; the window is a few microseconds and the risk is accepted.
 */
export async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/** Accepts and then `never` answers, or closes `at-once`. */
export async function startMuteServer(mode: 'never' | 'at-once'): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode === 'at-once') socket.destroy();
  });
  const port = await listen(server);
  return {
    port,
    close: async () => {
      for (const so of sockets) so.destroy();
      await closeServer(server);
    },
  };
}
