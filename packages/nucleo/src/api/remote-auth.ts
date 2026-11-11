// The remote owner credential, core side (decision 0020, #388): the verifier of `AhrenaRemote` proofs and
// the route that issues the credential.
//
//   Authorization: AhrenaRemote id=<credentialId>, ts=<ms>, nonce=<32 hex>, sig=<64 hex>
//   sig = HMAC-SHA256(key, "ahrena-remote-v1\n" + method + "\n" + target + "\n" + host + "\n" + generation
//                          + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(body)))
//
// `target` is the raw request target, query included. The checks run in this order and stop at the first:
//   1. no `Origin` and a loopback Host of this core's port (403 `owner` text otherwise)
//   2. the id is known, not expired, not evicted ............................ 401 credential-unknown / credential-expired
//   3. its generation and uid are this process's ............................ 401 credential-unknown
//   4. |ts - now| <= 10 s ................................................... 401 credential-clock
//   5. the signature, in constant time ...................................... 401 credential-signature
//   6. the nonce was not seen on this credential (recorded only now) ........ 403 credential-replayed
//   7. the method and raw target are in the closed list (owner-auth.ts) ..... 403 credential-route
//   8. an action route also needs the núcleo to accept remote actions ....... 403 credential-route
// A request that fails before step 6 changes no state, so whoever knows an id (it travels in clear on the
// tunnel) cannot fill the nonce memory. Error texts are fixed: never the header, the id, the key or the body.
// `credential-signature` is a reason of its own (the record allowed it or `credential-unknown`): the Mac
// renews on unknown, expired and clock, and a wrong signature is none of those.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allowedLocalRequest, send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite } from './same-origin.ts';
import { guardResponse, remoteRouteFor, type RemoteActionGroup, type RemoteRoute } from './owner-auth.ts';
import { CLOCK_WINDOW_MS, CREDENTIAL_ID, REQUEST_NONCE, RemoteCredentialStore } from './remote-credentials.ts';

export const REMOTE_CREDENTIALS_ROUTE = '/api/owner/remote-credentials';
/** The body of a signed request the verifier reads before the route does. */
export const MAX_SIGNED_BODY_BYTES = 16 * 1024;
export const MAX_ISSUE_BODY_BYTES = 1024;
const BODY_DEADLINE_MS = 10_000;

export const REMOTE_FAILURES = {
  'credential-unknown': { status: 401, error: 'Credencial remota desconhecida. Peça uma nova.' },
  'credential-expired': { status: 401, error: 'Credencial remota expirada. Peça uma nova.' },
  'credential-clock': { status: 401, error: 'Hora do pedido fora da janela de 10 segundos. Peça uma nova credencial.' },
  'credential-signature': { status: 401, error: 'Assinatura recusada.' },
  'credential-replayed': { status: 403, error: 'Pedido já usado.' },
  'credential-route': { status: 403, error: 'Rota fora da lista liberada à credencial remota.' },
  'credential-busy': { status: 429, error: 'Pedidos demais com esta credencial.' },
} as const;
export type RemoteFailure = keyof typeof REMOTE_FAILURES;

const HEADER = /^AhrenaRemote id=([0-9a-f]{32}), ts=(\d{1,16}), nonce=([0-9a-f]{32}), sig=([0-9a-f]{64})$/;
const OWNER_ONLY = { error: 'Acesso restrito ao dono do console. Abra pelo app.' };

/** The string the Mac and the core both sign. */
export function signingString(p: { method: string; target: string; host: string; generation: string; ts: number | string; nonce: string; body: Buffer | string }): string {
  return `ahrena-remote-v1\n${p.method}\n${p.target}\n${p.host}\n${p.generation}\n${p.ts}\n${p.nonce}\n${createHash('sha256').update(p.body).digest('hex')}`;
}

export function sign(key: string, p: Parameters<typeof signingString>[0]): string {
  return createHmac('sha256', key).update(signingString(p)).digest('hex');
}

export interface RemoteVerifier {
  /** Resolves `true` once the response is guarded and the request may go on; otherwise the answer was sent. */
  authorize(req: IncomingMessage, res: ServerResponse, port: number): Promise<boolean>;
  readonly store: RemoteCredentialStore;
}

export interface RemoteVerifierOptions {
  store: RemoteCredentialStore;
  /** Whether this núcleo takes the remote actions of a group (`--accept-remote-actions`). Default: none. */
  actionsAccepted?: (group: RemoteActionGroup) => boolean;
  /** The closed list; the real one (owner-auth.ts) unless a test swaps it. */
  routeFor?: (method: string | undefined, rawTarget: string) => RemoteRoute | null;
}

export function createRemoteVerifier(o: RemoteVerifierOptions): RemoteVerifier {
  const { store } = o;
  const routeFor = o.routeFor ?? remoteRouteFor;
  const actionsAccepted = o.actionsAccepted ?? (() => false);

  async function authorize(req: IncomingMessage, res: ServerResponse, port: number): Promise<boolean> {
    const refuse = (status: number, body: object): false => {
      req.resume();
      send(res, status, body);
      return false;
    };
    const fail = (reason: RemoteFailure): false => {
      const f = REMOTE_FAILURES[reason];
      return refuse(f.status, { error: f.error, reason });
    };
    // The Mac never sends an Origin: any Origin with this proof is a browser, or a forgery of one.
    if (req.headers.origin !== undefined || !allowedLocalRequest(req, port) || fromAnotherSite(req)) return refuse(403, OWNER_ONLY);

    const m = HEADER.exec(String(req.headers.authorization));
    if (!m) return fail('credential-unknown');
    const [, id, tsText, nonce, sig] = m as unknown as [string, string, string, string, string];
    const found = store.lookup(id);
    if (found.kind === 'expired') return fail('credential-expired');
    if (found.kind !== 'live') return fail('credential-unknown');
    const credential = found.credential;
    if (credential.generation !== store.generation || credential.uid !== store.uid) return fail('credential-unknown');
    const ts = Number(tsText);
    if (!Number.isSafeInteger(ts) || Math.abs(ts - store.now()) > CLOCK_WINDOW_MS) return fail('credential-clock');

    const body = await signedBody(req);
    if (body === 'too-large') {
      res.once('finish', () => req.destroy());
      res.setHeader('connection', 'close');
      send(res, 413, { error: 'corpo grande demais' });
      return false;
    }
    if (body === null) {
      req.destroy();
      return false;
    }
    const expected = sign(credential.key, { method: req.method ?? '', target: req.url ?? '', host: String(req.headers.host), generation: store.generation, ts: tsText, nonce, body });
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return fail('credential-signature');
    // Re-check after the (possibly slow) body: the credential may have gone meanwhile.
    if (!store.isLive(id)) return fail('credential-expired');

    const seen = store.recordNonce(id, nonce);
    if (seen === 'replayed') return fail('credential-replayed');
    if (seen === 'full') return fail('credential-busy');

    const route = routeFor(req.method, req.url ?? '');
    if (!route) return fail('credential-route');
    if (route.action && !actionsAccepted(route.action)) return fail('credential-route');

    guardResponse(res, () => store.isLive(id));
    return true;
  }

  return { authorize, store };
}

/**
 * The request body, buffered so its hash can be signed, then put back on the stream for the route.
 * `Buffer.alloc(0)` without touching the stream when the request declares no body; `'too-large'` past the cap;
 * `null` when the client stalls or goes away.
 */
async function signedBody(req: IncomingMessage): Promise<Buffer | 'too-large' | null> {
  const length = req.headers['content-length'];
  const chunked = req.headers['transfer-encoding'] !== undefined;
  if (!chunked && (length === undefined || length === '0')) return Buffer.alloc(0);
  if (!chunked && Number(length) > MAX_SIGNED_BODY_BYTES) return 'too-large';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (value: Buffer | 'too-large' | null, restore: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.off('readable', onReadable);
      req.off('error', onError);
      req.off('close', onClose);
      // Back on the stream, synchronously: 'end' is only scheduled, and it does not fire while data is buffered.
      if (restore && Buffer.isBuffer(value) && value.length > 0) req.unshift(value);
      resolve(value);
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = req.read() as Buffer | null) !== null) {
        size += chunk.length;
        chunks.push(chunk);
        if (size > MAX_SIGNED_BODY_BYTES) return done('too-large', false);
      }
      if (req.complete) done(Buffer.concat(chunks), true);
    };
    const onError = () => done(null, false);
    const onClose = () => done(null, false);
    const deadline = setTimeout(() => done(null, false), BODY_DEADLINE_MS);
    deadline.unref();
    req.on('readable', onReadable);
    req.on('error', onError);
    req.on('close', onClose);
    onReadable();
  });
}

// ---------- The issue route ----------

interface IssueRequest {
  nonce: string;
  revoke: string[];
}

function parseIssue(text: string): IssueRequest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'version' && k !== 'nonce' && k !== 'revoke')) return null;
  if (o.version !== 1 || typeof o.nonce !== 'string' || !REQUEST_NONCE.test(o.nonce)) return null;
  const revoke = o.revoke === undefined ? [] : o.revoke;
  if (!Array.isArray(revoke) || revoke.length > 3 || !revoke.every((id) => typeof id === 'string' && CREDENTIAL_ID.test(id))) return null;
  return { nonce: o.nonce, revoke: revoke as string[] };
}

function readLimited(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      if (tooLarge) return;
      body += c;
      if (Buffer.byteLength(body) > max) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', () => resolve(null));
  });
}

/**
 * `POST /api/owner/remote-credentials`, reached only after the server's owner gate accepted the LOCAL
 * bearer (a signed proof never gets here: the route is not in the closed list). No `Origin` at all.
 */
export async function respondIssue(req: IncomingMessage, res: ServerResponse, port: number, store: RemoteCredentialStore | null): Promise<void> {
  if (req.headers.origin !== undefined) {
    req.resume();
    return send(res, 403, OWNER_ONLY);
  }
  if (req.url !== REMOTE_CREDENTIALS_ROUTE) {
    req.resume();
    return send(res, 404, { error: 'não encontrado' });
  }
  if (req.method !== 'POST') {
    req.resume();
    return send(res, 405, { error: 'use POST' });
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    return send(res, 415, { error: 'use application/json' });
  }
  const text = await readLimited(req, MAX_ISSUE_BODY_BYTES);
  if (text === null) return send(res, 413, { error: 'corpo grande demais' });
  if (!store) return send(res, 404, { error: 'não encontrado' });
  const request = parseIssue(text);
  if (!request) return send(res, 400, { error: 'JSON inválido: { "version": 1, "nonce": "<32 hex>", "revoke": [...] }' });
  const c = store.issue({ port, revoke: request.revoke });
  send(res, 200, {
    version: 1,
    nonce: request.nonce,
    credentialId: c.credentialId,
    key: c.key,
    machineIdentity: c.machineIdentity,
    uid: c.uid,
    corePid: c.corePid,
    corePort: c.corePort,
    generation: c.generation,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  });
}
