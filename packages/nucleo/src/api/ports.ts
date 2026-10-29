// The port release routes (#286, decision 0016). Same model as the Tools writes (decision 0014):
// the request carries ids, never a command; the núcleo checks again and does it.
//
// - `GET /api/ports/release`: `{ release: true, remoteActions }`. What a Mac's núcleo asks a remote
//   one to know whether the action is there and whether it will take a request from the tunnel.
// - `GET /api/ports/release/preview?port=<n>&pid=<n>`: what the confirmation shows, 200 `{ process, pid,
//   command, ports, interface }` (the command is one short line with credentials cut out) or the same
//   409 `{ error, reason, now? }` a release would answer. It sends nothing.
// - `POST /api/ports/release` `{ port, pid, signal: 'TERM' | 'KILL' }`: 200 `{ result: 'released' |
//   'still-listening' }` (it waited up to 5 s for TERM, 3 s for KILL); 409 `{ error, reason, now? }`
//   when nothing was sent (`already-free`, `owner-changed` with who holds the port now, `self`, `app`,
//   `container`, `other-user`); 503 `{ reason: 'unavailable' }` when the listeners cannot be read.
//   The body is exactly those three keys.
// - `GET` and `POST /api/machines/<id>/ports/release`: the same on a remote machine, relayed to its
//   núcleo through the tunnel port as a request without Origin. Only the port, the pid and the signal
//   travel. The remote's answer is re-projected; 403 there becomes `remote-actions-off`, 404 `unsupported`.
//
// Every non-GET request goes through `portsWriteAllowed` INSTEAD of the server's usual gate: our Host,
// the exact raw path, and `Origin` exactly `http://<Host>`. A request with NO Origin is refused unless
// this núcleo was started accepting remote actions (`--accept-remote-actions`): that is what the
// tunnel looks like from the Workstation, so the default is to refuse. The machine route takes only
// the /ui's own Origin: nothing local needs it without one. Then `application/json` (415) and a
// capped body (413).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';
import type { RemoteWrite } from '../clouds/remote-connectors.ts';
import { PortReleaser, REFUSAL_REASONS, RELEASE_SIGNALS, type ReleaseSignal } from '../ports/release.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';

export const PORTS_RELEASE_ROUTE = '/api/ports/release';
export const PORTS_PREVIEW_ROUTE = '/api/ports/release/preview';
const MACHINE_RELEASE = /^\/api\/machines\/([^/]+)\/ports\/release(\/preview)?$/;
const MACHINE_RELEASE_RAW = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/ports\/release$/;
const PREVIEW_QUERY = /^\?port=(\d{1,5})&pid=(\d{1,7})$/;
const MAX_BODY = 256;

export interface PortsRouteOptions {
  /** Without it (`--demo`) the local route is 404. */
  releaser: PortReleaser | null;
  /** Whether a request with no Origin is taken (a remote núcleo started with `--accept-remote-actions`). */
  acceptNoOrigin: () => boolean;
  remote?: { port: (machineId: string) => number | undefined; get: RemoteGet; write: RemoteWrite } | null;
}

export interface PortsRoute {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  acceptNoOrigin(): boolean;
}

export function isPortsRoute(pathname: string): boolean {
  return pathname === PORTS_RELEASE_ROUTE || pathname === PORTS_PREVIEW_ROUTE || MACHINE_RELEASE.test(pathname);
}

/** Every non-GET request on a release route is a write and goes through `portsWriteAllowed` only. */
export function isPortsWrite(req: IncomingMessage, pathname: string): boolean {
  return req.method !== 'GET' && isPortsRoute(pathname);
}

export function portsWriteAllowed(req: IncomingMessage, port: number, acceptNoOrigin: boolean): boolean {
  if (req.method !== 'POST') return false;
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const raw = req.url ?? '';
  if (MACHINE_RELEASE_RAW.test(raw)) return fromOwnUi(req, port);
  if (raw !== PORTS_RELEASE_ROUTE) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return acceptNoOrigin && !fromAnotherSite(req);
  return origin === `http://${host}`;
}

interface ReleaseBody {
  port: number;
  pid: number;
  signal: ReleaseSignal;
}

function readLimited(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      if (tooLarge) return;
      body += c;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', reject);
  });
}

async function readBody(req: IncomingMessage): Promise<ReleaseBody | { status: number; error: string }> {
  const text = await readLimited(req);
  if (text === null) return { status: 413, error: 'corpo grande demais' };
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return { status: 415, error: 'use application/json' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: 'JSON inválido' };
  }
  const bad = { status: 400, error: 'o corpo é { "port": 1..65535, "pid": número, "signal": "TERM" | "KILL" }' };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).length !== 3 || !Number.isInteger(b.port) || !Number.isInteger(b.pid)) return bad;
  const port = b.port as number;
  const pid = b.pid as number;
  if (port < 1 || port > 65535 || pid < 1 || pid > 4_194_304 || !(RELEASE_SIGNALS as readonly unknown[]).includes(b.signal)) return bad;
  return { port, pid, signal: b.signal as ReleaseSignal };
}

const REFUSAL_TEXT: Record<string, string> = {
  unavailable: 'não deu para ler as portas desta máquina',
  'already-free': 'a porta já está livre',
  'owner-changed': 'a porta agora é de outro processo; nada foi enviado',
  self: 'é o núcleo do console',
  app: 'é o app do console',
  container: 'a porta é publicada por um container; a stack é a dona',
  'other-user': 'o processo é de outro usuário e o console não pede senha de administrador',
};

/** `{ process, pid }` from a remote answer: a short text and an integer, nothing else. */
function sanitizeNow(v: unknown): { process: string | null; pid: number | null } | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object' || v === undefined) return undefined;
  const { process, pid } = v as { process?: unknown; pid?: unknown };
  return {
    process: typeof process === 'string' && process.length <= 80 && !/[\u0000-\u001f\u007f]/.test(process) ? process : null,
    pid: Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : null,
  };
}

export function createPortsRoute(o: PortsRouteOptions): PortsRoute {
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const path = url.pathname;
    const machine = MACHINE_RELEASE.exec(path);
    if (path === PORTS_PREVIEW_ROUTE) {
      req.resume();
      if (!o.releaser) return send(res, 404, { error: 'não encontrado' });
      if (req.method !== 'GET' || fromAnotherSite(req)) return send(res, 403, { error: 'origem não permitida' });
      const q = PREVIEW_QUERY.exec(url.search);
      if (!q) return send(res, 400, { error: 'use ?port=<n>&pid=<n>' });
      const r = await o.releaser.preview(Number(q[1]), Number(q[2]));
      if (r.kind === 'ok') return send(res, 200, { process: r.process, pid: r.pid, command: r.command, ports: r.ports, interface: r.interface });
      return send(res, r.reason === 'unavailable' ? 503 : 409, { error: REFUSAL_TEXT[r.reason], reason: r.reason, ...(r.now !== undefined ? { now: r.now } : {}) });
    }
    if (path === PORTS_RELEASE_ROUTE) {
      if (!o.releaser) {
        req.resume();
        return send(res, 404, { error: 'não encontrado' });
      }
      if (req.method === 'GET') {
        req.resume();
        return send(res, 200, { release: true, remoteActions: o.acceptNoOrigin() });
      }
      const body = await readBody(req);
      if ('status' in body) return send(res, body.status, { error: body.error });
      const r = await o.releaser.release(body.port, body.pid, body.signal);
      if (r.kind === 'released' || r.kind === 'still-listening') return send(res, 200, { result: r.kind });
      const status = r.reason === 'unavailable' ? 503 : 409;
      return send(res, status, { error: REFUSAL_TEXT[r.reason], reason: r.reason, ...(r.now !== undefined ? { now: r.now } : {}) });
    }

    // /api/machines/<id>/ports/release
    const id = machine![1]!;
    const remotePort = MACHINE_ID.test(id) && id !== LOCAL_MACHINE_ID ? o.remote?.port(id) : undefined;
    if (!o.remote || remotePort === undefined) {
      req.resume();
      return send(res, 404, { error: `máquina desconhecida: ${MACHINE_ID.test(id) ? id : '(id inválido)'}` });
    }
    if (machine![2]) {
      req.resume();
      if (req.method !== 'GET' || fromAnotherSite(req)) return send(res, 403, { error: 'origem não permitida' });
      const q = PREVIEW_QUERY.exec(url.search);
      if (!q) return send(res, 400, { error: 'use ?port=<n>&pid=<n>' });
      const r = await o.remote.get(remotePort, `${PORTS_PREVIEW_ROUTE}${url.search}`);
      if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
      const a = (r.body ?? {}) as Record<string, unknown>;
      if (r.status === 200 && Array.isArray(a.ports) && Number.isInteger(a.pid)) {
        const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v.replace(/[\u0000-\u001f\u007f]/g, ' ') : null);
        return send(res, 200, { process: text(a.process, 80), pid: a.pid, command: text(a.command, 200) ?? '', ports: a.ports.filter((n) => Number.isInteger(n)).slice(0, 64), interface: a.interface === 'all' || a.interface === 'address' ? a.interface : 'loopback' });
      }
      if (r.status === 404 || r.status === 405) return send(res, 409, { error: 'o núcleo de lá não sabe liberar portas', reason: 'unsupported' });
      const reason = typeof a.reason === 'string' && (REFUSAL_REASONS as readonly string[]).includes(a.reason) ? a.reason : null;
      if ((r.status === 409 || r.status === 503) && reason) {
        const now = sanitizeNow(a.now);
        return send(res, r.status, { error: REFUSAL_TEXT[reason], reason, ...(now !== undefined ? { now } : {}) });
      }
      return send(res, 502, { error: 'resposta inesperada da máquina', reason: 'bad-response' });
    }
    if (req.method === 'GET') {
      req.resume();
      const r = await o.remote.get(remotePort, PORTS_RELEASE_ROUTE);
      if (r.kind === 'unreachable') return send(res, 200, { machine: id, status: 'unreachable', reason: r.reason, remoteActions: false });
      const b = r.body as { release?: unknown; remoteActions?: unknown } | undefined;
      if (r.status !== 200 || b?.release !== true) return send(res, 200, { machine: id, status: 'unsupported', remoteActions: false });
      return send(res, 200, { machine: id, status: 'ok', remoteActions: b.remoteActions === true });
    }
    const body = await readBody(req);
    if ('status' in body) return send(res, body.status, { error: body.error });
    const r = await o.remote.write(remotePort, 'POST', PORTS_RELEASE_ROUTE, JSON.stringify({ port: body.port, pid: body.pid, signal: body.signal }));
    if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
    const answer = (r.body ?? {}) as { result?: unknown; reason?: unknown; now?: unknown };
    if (r.status === 200 && (answer.result === 'released' || answer.result === 'still-listening')) return send(res, 200, { result: answer.result });
    if (r.status === 403) return send(res, 409, { error: 'a Workstation não aceita ações pelo túnel', reason: 'remote-actions-off' });
    if (r.status === 404 || r.status === 405) return send(res, 409, { error: 'o núcleo de lá não sabe liberar portas', reason: 'unsupported' });
    const reason = typeof answer.reason === 'string' && (REFUSAL_REASONS as readonly string[]).includes(answer.reason) ? answer.reason : null;
    if ((r.status === 409 || r.status === 503) && reason) {
      const now = sanitizeNow(answer.now);
      return send(res, r.status, { error: REFUSAL_TEXT[reason], reason, ...(now !== undefined ? { now } : {}) });
    }
    return send(res, 502, { error: 'resposta inesperada da máquina', reason: 'bad-response' });
  };
  return { handle, acceptNoOrigin: o.acceptNoOrigin };
}
