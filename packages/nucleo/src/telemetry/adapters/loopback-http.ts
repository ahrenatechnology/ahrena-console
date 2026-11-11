// The `RemoteGet` adapter (#176): `GET http://127.0.0.1:<port><path>` with `node:http`, to the local
// port the user's tunnel forwards to a remote núcleo. `loopbackExchange` is the one wire for it and for
// the remote writes (src/clouds/remote-connectors.ts `loopbackWrite`).
//
// - `Host: 127.0.0.1:4720`: the remote núcleo listens on its own 4720 and its Host defense
//   (decision 0003, src/api/server.ts) refuses any other Host, the forwarded port included. A signed
//   request carries the Host of the core that issued its credential (`127.0.0.1:<corePort>`), because
//   the Host is part of what is signed.
// - No `Origin`, ever: the remote refuses a signed request that has one (decision 0020 section 6).
// - With a `proof` (decision 0020, #388, ../remote-proof.ts), each request carries
//   `Authorization: AhrenaRemote …` when the machine has a credential, and goes without any proof
//   otherwise. The header is never logged: nothing here logs.
// - One deadline for the whole exchange (3 s by default, injectable for tests): a núcleo that
//   accepts and never answers, or answers slowly, is `no-response` at the deadline.
// - `ECONNREFUSED` is `port-closed` (the tunnel is down); any other failure (reset, closed at once,
//   the deadline, a body too large) is `no-response`.
// - Always 127.0.0.1: the address is not configurable, so the núcleo never reaches another host.

import { request } from 'node:http';
import type { RemoteGet, RemoteGetResult } from '../ports.ts';
import { sendWithProof, type RemoteProof, type SignedRequest } from '../remote-proof.ts';

/** The Host the remote núcleo expects: its own address and port. */
export const REMOTE_HOST_HEADER = '127.0.0.1:4720';
export const REMOTE_TIMEOUT_MS = 3_000;
/** A telemetry answer with 12 h of series is well under this. */
export const MAX_REMOTE_BODY_BYTES = 8 * 1024 * 1024;

export interface LoopbackOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** The remote owner's proof (decision 0020); without it, no request is signed. */
  proof?: RemoteProof | null;
  /** The Host of an unsigned request; tests point it at a test core. */
  host?: string;
}
export type LoopbackGetOptions = LoopbackOptions;

interface Wire {
  timeoutMs: number;
  maxBodyBytes: number;
  host: string;
}

/** One request on the wire; never rejects. */
function exchange(port: number, method: string, path: string, body: string | null, signed: SignedRequest | null, o: Wire): Promise<RemoteGetResult> {
  return new Promise<RemoteGetResult>((resolve) => {
    let settled = false;
    const finish = (result: RemoteGetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(result);
    };
    const noResponse = () => finish({ kind: 'unreachable', reason: 'no-response' });
    const headers: Record<string, string | number> = { host: signed?.host ?? o.host, accept: 'application/json' };
    if (signed) headers.authorization = signed.authorization;
    if (body !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > o.maxBodyBytes) return noResponse();
        chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = undefined;
        }
        finish({ kind: 'response', status: res.statusCode ?? 0, body: parsed });
      });
      res.on('error', noResponse);
      res.on('aborted', noResponse);
    });
    const deadline = setTimeout(noResponse, o.timeoutMs);
    deadline.unref?.();
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNREFUSED' ? finish({ kind: 'unreachable', reason: 'port-closed' }) : noResponse()));
    req.end(body ?? undefined);
  });
}

/** A request to the remote núcleo through the tunnel port, signed when the proof has a credential for that machine. */
export function loopbackExchange({ timeoutMs = REMOTE_TIMEOUT_MS, maxBodyBytes = MAX_REMOTE_BODY_BYTES, proof = null, host = REMOTE_HOST_HEADER }: LoopbackOptions = {}) {
  const wire: Wire = { timeoutMs, maxBodyBytes, host };
  return (port: number, method: string, path: string, body: string | null): Promise<RemoteGetResult> =>
    sendWithProof(proof, port, method, path, body, (signed) => exchange(port, method, path, body, signed, wire));
}

export function loopbackGet(options: LoopbackGetOptions = {}): RemoteGet {
  const send = loopbackExchange(options);
  return (port, path) => send(port, 'GET', path, null);
}
