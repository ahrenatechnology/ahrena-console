// The assembled core for the permission request routes (#618, API layer): the real server, the real hook receiver and change
// feed, and the use cases over the in-memory doubles of test/permissions/fakes.ts, so a test moves the clock without waiting. (#618)
// The window credential is a constant of the test, held in memory and never written anywhere. (#618)
import { request } from 'node:http';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, LeiturasDoDetalhe, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { digestOf } from '../../src/permissions/digest.ts';
import { OWNER_TOKEN } from '../owner-http.ts';
import type { PermissionDeps } from '../../src/permissions/ports.ts';
import { harness, settle, type Harness } from '../permissions/fakes.ts';
import { answerFromConsoleSwitch, type InstallationSettings } from '../../src/settings/installation-settings.ts';
import type { WindowCredentialHolder } from '../../src/permissions/window-credential.ts';

export const WINDOW_CREDENTIAL = 'w1ndow-'.concat('c'.repeat(57));
export const SID = 'S1';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

export interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

export interface CallOptions {
  headers?: Record<string, string>;
  body?: unknown;
  /** Send this text as the body, as it is. (#618) */
  raw?: string;
  /** The owner bearer; `false` leaves it out. (#618) */
  bearer?: string | false;
  /** Fires as soon as the request is written, for a long poll the test then leaves open. (#618) */
  onSent?: () => void;
}

/** Polls until the condition holds, for work the server does after it answered (a hook event settles after its 202). (#618) */
export async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface PermissionFixture {
  api: LocalApi;
  deps: Harness;
  storage: SqliteStorage;
  changes: ChangeCursor;
  logs: string[];
  /** Turns the capability switch and the in-memory window credential. (#618) */
  set(over: { enabled?: boolean; credential?: string | null }): void;
  /** A plain call, as the hook makes it: no `Origin`. (#618) */
  call(method: string, path: string, options?: CallOptions): Promise<Reply>;
  /** The /ui window: `Origin` exactly the core's, JSON, a declared length and the window credential. (#618) */
  answer(sid: string, rid: string, body: unknown, over?: { headers?: Record<string, string | null>; raw?: string }): Promise<Reply>;
  /** Registers a request as the hook does, with the digest the hook computes; returns its reply. (#618) */
  register(over?: { sid?: string; toolName?: string; toolInput?: unknown; cwd?: string }): Promise<Reply & { rid: string }>;
  /** A hook event of the session through the real receiver. (#618) */
  hookEvent(payload: Record<string, unknown>): Promise<Reply>;
  close(): Promise<void>;
}

export const reqPath = (sid: string, rid = '', tail = ''): string => `/api/sessions/${sid}/permission-requests${rid === '' ? '' : `/${rid}`}${tail}`;

export interface FixtureOptions {
  enabled?: boolean;
  credential?: string | null;
  sweepEveryMs?: number;
  permissions?: boolean;
  deps?: (db: SqliteStorage['db']) => PermissionDeps;
  /** The switch is the installation setting, wired as the core's production wiring does; absent, it is a flag of the test. (#619) */
  settings?: InstallationSettings;
  /** The credential is this holder's (fed by the channel reader), not a constant of the test. (#619) */
  holder?: WindowCredentialHolder;
}

export async function permissionFixture(over: FixtureOptions = {}): Promise<PermissionFixture> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const accounts = new Accounts({ storage, file: null });
  const panelBuilder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null, agora: () => NOW });
  const deps = (over.deps ? over.deps(storage.db) : harness()) as Harness;
  const changes = new ChangeCursor({ minIntervalMs: 0 });
  const logs: string[] = [];
  const state = { enabled: over.enabled ?? true, credential: over.credential === undefined ? WINDOW_CREDENTIAL : over.credential };
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: (m) => logs.push(m),
    changes,
    fleet: new FleetReader({ storage, accounts, now: () => NOW, timeZone: 'UTC' }),
    detail: new LeiturasDoDetalhe({ storage, montador: panelBuilder, agora: () => NOW }),
    ...(over.permissions === false
      ? {}
      : {
          permissions: {
            deps,
            ...(over.settings ? answerFromConsoleSwitch(over.settings) : { enabled: () => state.enabled, setEnabled: (value: boolean) => void (state.enabled = value) }),
            windowCredential: () => (over.holder ? over.holder.current() : state.credential),
            sweepEveryMs: over.sweepEveryMs ?? 3_600_000,
          },
        }),
  });

  const call = (method: string, path: string, options: CallOptions = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const headers: Record<string, string> = { ...(options.bearer === false ? {} : { authorization: `Bearer ${options.bearer ?? OWNER_TOKEN}` }) };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      Object.assign(headers, options.headers);
      const req = request(`${api.url}${path}`, { method, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = text === '' ? null : JSON.parse(text);
            json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end(() => options.onSent?.());
    });

  return {
    api,
    deps,
    storage,
    changes,
    logs,
    set(next) {
      if (next.enabled !== undefined) state.enabled = next.enabled;
      if (next.credential !== undefined) state.credential = next.credential;
    },
    call,
    answer(sid, rid, body, extra = {}) {
      const text = extra.raw ?? JSON.stringify(body);
      const headers: Record<string, string> = { origin: api.url, 'ahrena-window': WINDOW_CREDENTIAL };
      for (const [name, value] of Object.entries(extra.headers ?? {})) {
        if (value === null) delete headers[name];
        else headers[name] = value;
      }
      return call('POST', reqPath(sid, rid, '/answer'), { raw: text, headers });
    },
    async register(input = {}) {
      const sid = input.sid ?? SID;
      const toolName = input.toolName ?? 'Bash';
      const toolInput = 'toolInput' in input ? input.toolInput : { command: 'npm run migrate' };
      const cwd = input.cwd ?? '/w';
      const digest = await digestOf({ sessionId: sid, toolName, toolInput, cwd });
      const reply = await call('POST', reqPath(sid), { body: { toolName, toolInput, cwd, permissionMode: 'default', digest } });
      return { ...reply, rid: String(reply.json?.requestId ?? '') };
    },
    hookEvent: (payload) => call('POST', '/api/hooks', { body: payload, headers: { 'x-ahrena-delivery-id': `d-${Math.random().toString(36).slice(2)}` } }),
    async close() {
      await settle();
      await api.close();
      storage.close();
    },
  };
}
