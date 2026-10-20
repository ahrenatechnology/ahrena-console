// What says a core is alive: the pid exists and the port answers `/api/overview` with the name
// (`name`, or `nome` on a core from before #173 phase 2b) `ahrena-console`. One without the other
// is an orphan lock (the pid was reused, or the port changed).

import { get } from 'node:http';
import { createServer, type Server } from 'node:net';

export const CORE_NAME = 'ahrena-console';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a core says about itself in `/api/overview`. */
export interface CoreView {
  name: string;
  version: string;
  /** The pid of whoever answers. `null` on a core from before #86. */
  pid: number | null;
  /** The commit of the running code, if it knows. */
  commit: string | null;
}

/** `GET /api/overview` on 127.0.0.1. `null` if nobody answers, or if it is not JSON. */
export function probe(port: number, timeoutMs = 1000): Promise<CoreView | null> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/overview', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          // `name`/`version` since #173 phase 2b; an older core answers only `nome`/`versao`.
          const v = JSON.parse(body) as { name?: unknown; version?: unknown; nome?: unknown; versao?: unknown; pid?: unknown; commit?: unknown };
          const name = typeof v.name === 'string' ? v.name : v.nome;
          const version = typeof v.version === 'string' ? v.version : v.versao;
          resolve(
            typeof name === 'string'
              ? {
                  name,
                  version: typeof version === 'string' ? version : '?',
                  pid: Number.isInteger(v.pid) ? (v.pid as number) : null,
                  commit: typeof v.commit === 'string' ? v.commit : null,
                }
              : null,
          );
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** `probe`, but only if whoever answers is a core. */
export async function probeCore(port: number, timeoutMs = 1000): Promise<CoreView | null> {
  const v = await probe(port, timeoutMs);
  return v?.name === CORE_NAME ? v : null;
}

/** -1, 0 or 1, comparing `a.b.c` by number; whatever comes after `-` or `+` does not count. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split('.').map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Holds the port on 127.0.0.1 before opening the database. It is what guarantees a single core when
 * two start at the same time: the system gives the port to one, and the other adopts. `'in-use'` if
 * it already has an owner.
 */
export function reservePort(port: number): Promise<Server | 'in-use'> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => c.destroy());
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve('in-use') : reject(e)));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(s));
  });
}

export function releasePort(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits for the port to answer as a core. `null` if time runs out. */
export async function waitForCore(port: number, timeoutMs: number): Promise<CoreView | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await probeCore(port, 500);
    if (v) return v;
    await sleep(100);
  }
  return null;
}
