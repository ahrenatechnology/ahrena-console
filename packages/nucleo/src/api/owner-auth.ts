// Owner authentication is independent of the browser's Origin/Host checks (#302).
// Only the owner context (0600 lock, desktop bootstrap) receives the bearer. Never accept
// it in a URL, cookie, or request body. Unknown credentials fail closed before dispatch.
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allowedLocalRequest, send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';
import { isUiPath } from './ui.ts';

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

/** Check before any handler, including future runtime routes. Revocation also closes pending streams. */
export function authorizeOwner(req: IncomingMessage, res: ServerResponse, port: number, current: OwnerToken): boolean {
  const token = current();
  if ((!allowedLocalRequest(req, port) && !fromOwnUi(req, port)) || fromAnotherSite(req) || !ownerAuthenticated(req, token)) {
    req.resume();
    send(res, 403, { error: 'Acesso restrito ao dono do console. Abra pelo app.' });
    return false;
  }
  res.setHeader('cache-control', 'no-store');
  // A revoked/expired owner context must not keep a long poll or future SSE connection alive.
  const timer = setInterval(() => {
    if (current() !== token) res.destroy();
  }, 100);
  timer.unref();
  res.once('close', () => clearInterval(timer));
  // Revalidate synchronously at every output boundary. Once SSE headers were sent, Node's
  // write/end no longer call writeHead, so a header-only guard would leak between timer ticks.
  const stillOwned = (): boolean => {
    if (current() === token && !res.destroyed) return true;
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
  return true;
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
