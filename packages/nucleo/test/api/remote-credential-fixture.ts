// Shared by the remote credential tests (decision 0020, #388): a real núcleo on a test port with an injected
// clock, generation and identity, raw HTTP (no fetch: the tests set Host, Origin and the proof themselves),
// and the Mac's side of the signature, written here independently of the verifier's own helpers.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { send } from '../../src/ingest/hooks/receiver.ts';
import { RemoteCredentialStore, type RemoteCredentialStoreOptions } from '../../src/api/remote-credentials.ts';
import type { ApiOptions } from '../../src/api/server.ts';

export const OWNER = 'a'.repeat(64);
export const ISSUE = '/api/owner/remote-credentials';

export interface Answer {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
}

export function call(url: string, path: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) {
      h['content-length'] = String(Buffer.byteLength(body));
      h['content-type'] ??= 'application/json';
    }
    const req = request(url + path, { method, headers: h, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, text, json, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export interface Issued {
  version: number;
  nonce: string;
  credentialId: string;
  key: string;
  machineIdentity: string;
  uid: number;
  corePid: number;
  corePort: number;
  generation: string;
  issuedAt: number;
  expiresAt: number;
}

export const hex = (n: number) => randomBytes(n).toString('hex');

export function signHeader(c: Pick<Issued, 'credentialId' | 'key' | 'generation'>, p: { method: string; target: string; host: string; ts: number; nonce?: string; body?: string; key?: string }): string {
  const nonce = p.nonce ?? hex(16);
  const bodyHash = createHash('sha256').update(p.body ?? '').digest('hex');
  const text = ['ahrena-remote-v1', p.method, p.target, p.host, c.generation, String(p.ts), nonce, bodyHash].join('\n');
  const sig = createHmac('sha256', p.key ?? c.key).update(text).digest('hex');
  return `AhrenaRemote id=${c.credentialId}, ts=${p.ts}, nonce=${nonce}, sig=${sig}`;
}

export interface Fixture {
  url: string;
  port: number;
  host: string;
  store: RemoteCredentialStore;
  clock: { now: number };
  /** Issues through the route, with the owner's bearer. */
  mint(body?: Record<string, unknown>): Promise<Issued>;
  /** A signed request as the Mac sends it: no Origin, the core's own Host. */
  signed(c: Issued, method: string, target: string, o?: { body?: string; ts?: number; nonce?: string; headers?: Record<string, string> }): Promise<Answer>;
  close(): Promise<void>;
}

export async function remoteFixture(o: { api?: Partial<ApiOptions>; store?: RemoteCredentialStoreOptions; token?: string | null } = {}): Promise<Fixture> {
  const storage = await openSqliteStorage({ path: ':memory:' });
  const clock = { now: 1_800_000_000_000 };
  const store = new RemoteCredentialStore({ now: () => clock.now, machineIdentity: 'b'.repeat(64), corePid: process.pid, ...o.store });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, port: 0, ownerToken: () => (o.token === undefined ? OWNER : o.token), remoteCredentials: store, log: () => {}, ...o.api });
  const port = Number(new URL(api.url).port);
  const host = `127.0.0.1:${port}`;
  const f: Fixture = {
    url: api.url,
    port,
    host,
    store,
    clock,
    async mint(body = {}) {
      const r = await call(api.url, ISSUE, 'POST', { authorization: `Bearer ${OWNER}` }, JSON.stringify({ version: 1, nonce: hex(16), ...body }));
      if (r.status !== 200) throw new Error(`issue failed: ${r.status}`);
      return r.json as unknown as Issued;
    },
    signed(c, method, target, x = {}) {
      const header = signHeader(c, { method, target, host, ts: x.ts ?? clock.now, nonce: x.nonce, body: x.body });
      return call(api.url, target, method, { authorization: header, ...x.headers }, x.body);
    },
    close: async () => {
      await api.close();
      await storage.close();
    },
  };
  return f;
}

/** A route stub that echoes what it read of the body (so the hand-off is observable), with `read` choosing how. */
export function echoBody(read: 'events' | 'iterator') {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    let text = '';
    if (read === 'iterator') for await (const chunk of req) text += chunk.toString('utf8');
    else {
      req.setEncoding('utf8');
      await new Promise<void>((done) => {
        req.on('data', (c: string) => (text += c));
        req.on('end', done);
      });
    }
    send(res, 200, { echoed: text });
  };
}
