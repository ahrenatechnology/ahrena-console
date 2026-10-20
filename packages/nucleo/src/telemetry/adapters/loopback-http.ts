// The `RemoteGet` adapter (#176): `GET http://127.0.0.1:<port><path>` with `node:http`, to the local
// port the user's tunnel forwards to a remote núcleo.
//
// - `Host: 127.0.0.1:4720`: the remote núcleo listens on its own 4720 and its Host defense
//   (decision 0003, src/api/server.ts) refuses any other Host, the forwarded port included.
// - No `Origin`, `GET` only, no body: nothing on this Mac writes to the remote machine.
// - One deadline for the whole exchange (3 s by default, injectable for tests): a núcleo that
//   accepts and never answers, or answers slowly, is `no-response` at the deadline.
// - `ECONNREFUSED` is `port-closed` (the tunnel is down); any other failure (reset, closed at once,
//   the deadline, a body too large) is `no-response`.
// - Always 127.0.0.1: the address is not configurable, so the núcleo never reaches another host.

import { request } from 'node:http';
import type { RemoteGet, RemoteGetResult } from '../ports.ts';

/** The Host the remote núcleo expects: its own address and port. */
export const REMOTE_HOST_HEADER = '127.0.0.1:4720';
export const REMOTE_TIMEOUT_MS = 3_000;
/** A telemetry answer with 12 h of series is well under this. */
export const MAX_REMOTE_BODY_BYTES = 8 * 1024 * 1024;

export interface LoopbackGetOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export function loopbackGet({ timeoutMs = REMOTE_TIMEOUT_MS, maxBodyBytes = MAX_REMOTE_BODY_BYTES }: LoopbackGetOptions = {}): RemoteGet {
  return (port, path) =>
    new Promise<RemoteGetResult>((resolve) => {
      let settled = false;
      const finish = (result: RemoteGetResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        req.destroy();
        resolve(result);
      };
      const noResponse = () => finish({ kind: 'unreachable', reason: 'no-response' });

      const req = request(
        { host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { host: REMOTE_HOST_HEADER, accept: 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBodyBytes) return noResponse();
            chunks.push(chunk);
          });
          res.on('end', () => {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              body = undefined;
            }
            finish({ kind: 'response', status: res.statusCode ?? 0, body });
          });
          res.on('error', noResponse);
          res.on('aborted', noResponse);
        },
      );
      const deadline = setTimeout(noResponse, timeoutMs);
      deadline.unref?.();
      req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNREFUSED' ? finish({ kind: 'unreachable', reason: 'port-closed' }) : noResponse()));
      req.end();
    });
}
