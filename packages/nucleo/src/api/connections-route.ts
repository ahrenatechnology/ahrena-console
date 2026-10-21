// The console's own GitHub connection in the API (#241, decision 0011 §6).
//
// | Route                                      | What                                                   |
// | ------------------------------------------ | ------------------------------------------------------ |
// | `GET /api/connections`                     | `{ github: <status> }` (src/github/connection/connection.ts) |
// | `POST /api/connections/github/start`       | Starts the device flow (one at a time); `{ github }`   |
// | `POST /api/connections/github/cancel`      | Drops the pending flow; `{ github }`                   |
// | `POST /api/connections/github/disconnect`  | Deletes the vault entry and forgets it; `{ github }`   |
// | `POST /api/connections/github/source`      | `{ source: "console" | "gh" }`; `{ github }`           |
// | `POST /api/project/selection`              | `{ owner, number, field? }`; `{ selection, envOverride }` |
//
// The five writes are accepted ONLY from the /ui itself (`strictWriteRefusal`): POST, the raw URL exactly
// the route (no query), our Host, `Origin` exactly `http://<Host>`, `Content-Type: application/json`, a
// body of at most 4 KiB, and not a browser saying `Sec-Fetch-Site: cross-site` or `same-site`. Unlike the
// other writes, a request without `Origin` is refused: connecting is a decision of the person in front of
// the screen; no agent, MCP client, mod or CLI starts a device flow for them.
// Answers carry machine codes; the /ui phrases them in pt-BR. Never the credential nor the device code.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { GithubConnectionError, type GithubConnection } from '../github/connection/connection.ts';
import { ProjectSelectionError, type ProjectEnvOverride, type ResolvedProjectSelection } from '../github/project-selection.ts';

export const CONNECTIONS_ROUTE = '/api/connections';
export const GITHUB_START_ROUTE = '/api/connections/github/start';
export const GITHUB_CANCEL_ROUTE = '/api/connections/github/cancel';
export const GITHUB_DISCONNECT_ROUTE = '/api/connections/github/disconnect';
export const GITHUB_SOURCE_ROUTE = '/api/connections/github/source';
export const PROJECT_SELECTION_ROUTE = '/api/project/selection';

/** The writes that only the /ui itself may make. */
export const STRICT_WRITE_ROUTES: ReadonlySet<string> = new Set([GITHUB_START_ROUTE, GITHUB_CANCEL_ROUTE, GITHUB_DISCONNECT_ROUTE, GITHUB_SOURCE_ROUTE, PROJECT_SELECTION_ROUTE]);

const MAX_BODY = 4096;

export interface Refusal {
  status: number;
  body: { error: string };
}

/** A browser on another page: `cross-site` or `same-site` (a `<form>`, an `<img>`, a no-cors `fetch`). */
export const fromAnotherSite = (req: IncomingMessage) => /^(cross-site|same-site)$/i.test(String(req.headers['sec-fetch-site'] ?? ''));

/** Why a strict write is refused, or `null` when it comes from the /ui itself (the body size is checked while reading). */
export function strictWriteRefusal(req: IncomingMessage, port: number, pathname: string): Refusal | null {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method-not-allowed' } };
  const forbidden: Refusal = { status: 403, body: { error: 'forbidden' } };
  if (req.url !== pathname) return forbidden;
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return forbidden;
  if (req.headers.origin !== `http://${host}`) return forbidden;
  if (fromAnotherSite(req)) return forbidden;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return { status: 415, body: { error: 'unsupported-media-type' } };
  if (Number(req.headers['content-length']) > MAX_BODY) return { status: 413, body: { error: 'too-large' } };
  return null;
}

/** The JSON body; `too-large` past 4 KiB (the rest is not read: the answer closes the connection), `invalid` when not JSON. */
export function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: 'too-large' | 'invalid' }> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    const chunk = (part: string) => {
      text += part;
      if (Buffer.byteLength(text) <= MAX_BODY) return;
      req.off('data', chunk);
      req.pause();
      resolve({ ok: false, error: 'too-large' });
    };
    req.on('data', chunk);
    req.on('end', () => {
      try {
        resolve({ ok: true, value: text === '' ? {} : JSON.parse(text) });
      } catch {
        resolve({ ok: false, error: 'invalid' });
      }
    });
    req.on('error', reject);
  });
}

function sendTooLarge(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('connection', 'close');
  res.on('finish', () => req.destroy());
  send(res, 413, { error: 'too-large' });
}

/** What the selection write needs from the Project resolver. */
export interface ProjectSelectionTarget {
  select(input: { owner: unknown; number: unknown; field?: unknown }): { selection: ResolvedProjectSelection; envOverride: ProjectEnvOverride | null };
}

function connectionError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof GithubConnectionError)) throw err;
  if (err.code === 'github-unavailable') return send(res, 409, { error: 'github-unavailable', reason: err.reason });
  if (err.code === 'github-error') return send(res, 502, { error: 'github-error' });
  if (err.code === 'invalid') return send(res, 400, { error: 'invalid' });
  send(res, 409, { error: err.code });
}

/** GET /api/connections and the four github writes. The caller already ran `strictWriteRefusal` on the writes. */
export async function respondConnections(req: IncomingMessage, res: ServerResponse, pathname: string, connection: GithubConnection): Promise<void> {
  if (pathname === CONNECTIONS_ROUTE) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    return send(res, 200, { github: await connection.status() });
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.error === 'too-large' ? sendTooLarge(req, res) : send(res, 400, { error: 'invalid' });
  try {
    if (pathname === GITHUB_START_ROUTE) return send(res, 200, { github: await connection.start() });
    if (pathname === GITHUB_CANCEL_ROUTE) return send(res, 200, { github: await connection.cancel() });
    if (pathname === GITHUB_DISCONNECT_ROUTE) return send(res, 200, { github: await connection.disconnect() });
    if (pathname === GITHUB_SOURCE_ROUTE) {
      const source = (body.value as { source?: unknown } | null)?.source;
      if (source !== 'console' && source !== 'gh') return send(res, 400, { error: 'invalid' });
      return send(res, 200, { github: await connection.setSource(source) });
    }
  } catch (err) {
    return connectionError(res, err);
  }
  send(res, 404, { error: 'not-found' });
}

/** POST /api/project/selection. The caller already ran `strictWriteRefusal`. */
export async function respondProjectSelection(req: IncomingMessage, res: ServerResponse, target: ProjectSelectionTarget | null): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return body.error === 'too-large' ? sendTooLarge(req, res) : send(res, 400, { error: 'invalid' });
  if (!target) return send(res, 503, { error: 'off' });
  try {
    send(res, 200, target.select((body.value ?? {}) as { owner: unknown; number: unknown; field?: unknown }));
  } catch (err) {
    if (err instanceof ProjectSelectionError) return send(res, 400, { error: 'invalid' });
    throw err;
  }
}
