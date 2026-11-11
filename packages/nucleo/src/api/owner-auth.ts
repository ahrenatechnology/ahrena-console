// Owner authentication is independent of the browser's Origin/Host checks (#302).
// Only the owner context (0600 lock, desktop bootstrap) receives the bearer. Never accept
// it in a URL, cookie, or request body. Unknown credentials fail closed before dispatch.
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allowedLocalRequest, send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';
import { isUiPath } from './ui.ts';
import type { RemoteVerifier } from './remote-auth.ts';

export type OwnerToken = () => string | null;
const TOKEN = /^[a-f0-9]{64}$/;

export function ownerAuthenticated(req: IncomingMessage, token: string | null): boolean {
  if (!token || !TOKEN.test(token)) return false;
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return false;
  return timingSafeEqual(Buffer.from(authorization.slice(7)), Buffer.from(token));
}

/** The only anonymous surfaces contain no session content and cannot perform actions. */
export function ownerProofRequired(method: string | undefined, path: string): boolean {
  return !(method === 'GET' && (isUiPath(path) || path === '/api/overview' || path === '/api/hooks/health'));
}

/** The remote actions a signed request may reach, by the núcleo option that must also allow them (decision 0020 section 5). */
export type RemoteActionGroup = 'ports' | 'docker' | 'terminals' | 'tools';

/** One entry of the closed list a remote credential (`AhrenaRemote`) is valid for. */
export interface RemoteRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Matched against the raw request path, without the query. */
  path: RegExp;
  /** The query parameter names the route accepts: a fixed set, or a pattern for the session Detail tabs. */
  query: readonly string[] | RegExp;
  /** Set on the actions: `--accept-remote-actions` (or its variable) is still required, in addition to the credential. */
  action?: RemoteActionGroup;
}

const NO_QUERY: readonly string[] = [];
const sessionsQuery = ['status', 'search', 'dir', 'order', 'direction', 'page', 'perPage'] as const;
const eventsQuery = ['limit', 'after', 'before', 'type', 'session', 'tool', 'status', 'search', 'from', 'to'] as const;

/**
 * THE closed list of routes a remote credential is valid for, by method and raw path (decision 0020, section 5).
 * Every other route, the issue route included, gets 403 `credential-route` with an `AhrenaRemote` proof, even
 * if the owner's bearer would open it. A route the Mac starts calling on a remote enters here in a reviewed PR.
 * The session Detail tabs and the panel are the ones api/machine-sessions.ts and api/machine-panel.ts read.
 */
export const REMOTE_ROUTES: readonly RemoteRoute[] = [
  { method: 'GET', path: /^\/api\/telemetry$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/attention$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/connectors$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/sessions$/, query: sessionsQuery },
  { method: 'GET', path: /^\/api\/wall$/, query: ['parkedLimit'] },
  { method: 'GET', path: /^\/api\/kanban$/, query: ['view', 'column', 'page'] },
  { method: 'GET', path: /^\/api\/history$/, query: ['days', 'before', 'search'] },
  { method: 'GET', path: /^\/api\/events$/, query: eventsQuery },
  { method: 'GET', path: /^\/api\/dashboard$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/sessions\/(?!\.{1,2}(?:\/|$))(?:[A-Za-z0-9_.-]|%3A){1,128}(?:\/(?:agents|conversation|events|workflow|decisions))?$/, query: /^[A-Za-z][A-Za-z0-9_]{0,31}$/ },
  { method: 'GET', path: /^\/api\/panel\/(?!\.{1,2}$)(?:[A-Za-z0-9_.-]|%3A){1,128}$/, query: ['local', 'account', 'org', 'model', 'cwd'] },
  { method: 'POST', path: /^\/api\/connectors\/aws\/sessions\/(?!\.{1,2}\/)[A-Za-z0-9._-]{1,64}\/login$/, query: NO_QUERY },
  { method: 'DELETE', path: /^\/api\/connectors\/aws\/sessions\/(?!\.{1,2}\/)[A-Za-z0-9._-]{1,64}\/login$/, query: NO_QUERY },
  // The remote actions (0016, 0017, 0018 section 4): the credential alone does not open them.
  { method: 'GET', path: /^\/api\/ports\/release$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/ports\/release\/preview$/, query: ['port', 'pid'] },
  { method: 'POST', path: /^\/api\/ports\/release$/, query: NO_QUERY, action: 'ports' },
  { method: 'GET', path: /^\/api\/docker$/, query: NO_QUERY },
  { method: 'GET', path: /^\/api\/docker\/plan$/, query: ['action', 'target'] },
  { method: 'POST', path: /^\/api\/docker\/actions\/[a-z-]{1,32}$/, query: NO_QUERY, action: 'docker' },
  { method: 'DELETE', path: /^\/api\/tools\/jobs\/[a-f0-9]{12}$/, query: NO_QUERY, action: 'tools' },
  { method: 'POST', path: /^\/api\/terminals\/(?:pts-\d{1,6}|ttys\d{1,4})\/actions\/(?:interrupt|terminate|kill|hangup|end)$/, query: NO_QUERY, action: 'terminals' },
];

/** The list entry a request matches by method, raw path and query parameter names (each at most once), or `null`. */
export function remoteRouteFor(method: string | undefined, rawTarget: string): RemoteRoute | null {
  const cut = rawTarget.indexOf('?');
  const path = cut < 0 ? rawTarget : rawTarget.slice(0, cut);
  const search = cut < 0 ? '' : rawTarget.slice(cut + 1);
  // The router dispatches on the canonical path: a target that changes when normalised is not what was listed.
  try {
    if (new URL(rawTarget, 'http://x').pathname !== path) return null;
  } catch {
    return null;
  }
  const route = REMOTE_ROUTES.find((r) => r.method === method && r.path.test(path));
  if (!route) return null;
  if (search === '' && cut < 0) return route;
  const names = [...new URLSearchParams(search).keys()];
  if (new Set(names).size !== names.length) return null;
  const known = (n: string) => (Array.isArray(route.query) ? (route.query as readonly string[]).includes(n) : (route.query as RegExp).test(n));
  return names.every(known) ? route : null;
}

/** The requests whose gate was tried with an `AhrenaRemote` proof (not the bearer): the issue route refuses them. */
const remoteProofs = new WeakSet<IncomingMessage>();
export const openedByRemote = (req: IncomingMessage): boolean => remoteProofs.has(req);

/** Check before any handler, including future runtime routes. Revocation also closes pending streams. */
export function authorizeOwner(req: IncomingMessage, res: ServerResponse, port: number, current: OwnerToken): boolean {
  const token = current();
  if ((!allowedLocalRequest(req, port) && !fromOwnUi(req, port)) || fromAnotherSite(req) || !ownerAuthenticated(req, token)) {
    req.resume();
    send(res, 403, { error: 'Acesso restrito ao dono do console. Abra pelo app.' });
    return false;
  }
  guardResponse(res, () => current() === token);
  return true;
}

/**
 * Closes a response whose proof stops being good: a timer every 100 ms and a check at every output
 * boundary. A revoked/expired owner context, or a remote credential that expired, was evicted or lost
 * its generation, must not keep a long poll or an SSE connection alive: the response is destroyed with
 * no last payload. Once SSE headers were sent, Node's write/end no longer call writeHead, so a
 * header-only guard would leak between timer ticks.
 */
export function guardResponse(res: ServerResponse, valid: () => boolean): void {
  res.setHeader('cache-control', 'no-store');
  const timer = setInterval(() => {
    if (!valid()) res.destroy();
  }, 100);
  timer.unref();
  res.once('close', () => clearInterval(timer));
  const stillOwned = (): boolean => {
    if (valid() && !res.destroyed) return true;
    res.destroy();
    return false;
  };
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    if (!stillOwned()) return res;
    return writeHead(...args);
  }) as typeof res.writeHead;
  const write = res.write.bind(res);
  res.write = ((...args: Parameters<typeof res.write>) => {
    if (!stillOwned()) return false;
    return write(...args);
  }) as typeof res.write;
  const end = res.end.bind(res);
  res.end = ((...args: Parameters<typeof res.end>) => {
    if (!stillOwned()) return res;
    return end(...args);
  }) as typeof res.end;
  const flushHeaders = res.flushHeaders.bind(res);
  res.flushHeaders = () => { if (stillOwned()) flushHeaders(); };
  const addTrailers = res.addTrailers.bind(res);
  res.addTrailers = (...args: Parameters<typeof res.addTrailers>) => { if (stillOwned()) addTrailers(...args); };
}

/**
 * The owner gate of the server: the owner's bearer (`authorizeOwner`), or an `AhrenaRemote` signature
 * (decision 0020) when this núcleo verifies them. The signature path reads the body first (the
 * signature covers it) and hands it on to the route untouched, so only that path is asynchronous: the
 * bearer path answers in the same tick as before (a refusal must not wait for a body the client may send).
 */
export function authorizeRequest(req: IncomingMessage, res: ServerResponse, port: number, current: OwnerToken, remote?: RemoteVerifier | null): boolean | Promise<boolean> {
  const authorization = req.headers.authorization;
  if (remote && typeof authorization === 'string' && authorization.startsWith('AhrenaRemote ')) {
    remoteProofs.add(req);
    return remote.authorize(req, res, port);
  }
  return authorizeOwner(req, res, port, current);
}

/** Explicit owner bootstrap for a no-lock/demo process. Never read a token from argv or an HTTP request. */
export function readOwnerTokenFile(path: string | undefined): string | null {
  if (!path || !process.getuid) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size !== 64) return null;
    const token = readFileSync(fd, 'utf8');
    return TOKEN.test(token) ? token : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
