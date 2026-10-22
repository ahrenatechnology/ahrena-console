// The cloud connectors' routes (#277, decision 0013 section 6), behind the server's Origin and Host
// defenses (decision 0003):
//
// - `GET /api/connectors`: `{ connectors: [aws, { kind: 'gcp', state: 'soon' }, { kind: 'azure', state: 'soon' }] }`,
//   the AWS item from src/clouds/aws-connector.ts (`AwsConnectorView`). Never a token, a secret or
//   command output.
// - `POST /api/connectors/aws/sessions/<name>/login`: Entrar on this machine. The body may be
//   `{ "mode": "browser" | "device-code" }` (JSON, at most 1 KiB, no other key); none is `browser`.
//   202 `{ login }` (started, or the one running); 404 for a session the file does not have; 409
//   `{ error, reason }` when it cannot run (`invalid-file`, `cli-missing`, `cli-unsupported`,
//   `name-not-supported`, `device-code-unsupported`). `DELETE` on the same path: Cancelar, 200
//   `{ login }`, 409 when nothing runs, 404 for an unknown session.
// - `GET /api/machines/<id>/connectors`: the remote núcleo's `/api/connectors` through the machine's
//   tunnel port, re-projected (src/clouds/remote-connectors.ts): `{ machine, status: 'ok' |
//   'unreachable' | 'unsupported', reason?, connectors }`. 404 for an id that is not a remote machine.
// - `POST` and `DELETE /api/machines/<id>/connectors/aws/sessions/<name>/login`: forwarded to the
//   remote núcleo as a local request, with `mode: device-code`; only the session name travels. The
//   remote's answer is re-projected; 502 when the machine does not answer.
// - The session name in the path is taken raw (no decoding) and must match `SAFE_CLI_NAME`; any
//   other is 404. The núcleo then looks it up in the freshest reading of ~/.aws/config: nothing from
//   the request becomes an argument.
// - The writes are a same-origin exception of the /ui (`cloudsWriteFromSameOrigin`, in server.ts's
//   gate), besides the no-Origin loopback request every write accepts (the tray, and this Mac's
//   núcleo forwarding to a remote one). Any other Origin gets 403 there, before this code runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';
import { SAFE_CLI_NAME } from '../clouds/aws-config.ts';
import type { AwsConnector, LoginRefusal } from '../clouds/aws-connector.ts';
import { LOGIN_MODES, type LoginMode } from '../clouds/aws-login.ts';
import { REMOTE_CONNECTORS_PATH, sanitizeConnectors, sanitizeLoginAnswer, type RemoteWrite } from '../clouds/remote-connectors.ts';
import { fromOwnUi } from './same-origin.ts';

export const CONNECTORS_ROUTE = '/api/connectors';
const SESSION_LOGIN = /^\/api\/connectors\/aws\/sessions\/([^/]+)\/login$/;
const REMOTE_CONNECTORS = /^\/api\/machines\/([^/]+)\/connectors$/;
const REMOTE_SESSION_LOGIN = /^\/api\/machines\/([^/]+)\/connectors\/aws\/sessions\/([^/]+)\/login$/;
/** The exact raw paths the same-origin exception accepts: valid names, no query, no encoding. */
const LOCAL_WRITE_RAW_PATH = /^\/api\/connectors\/aws\/sessions\/[A-Za-z0-9._-]{1,64}\/login$/;
const REMOTE_WRITE_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/connectors\/aws\/sessions\/[A-Za-z0-9._-]{1,64}\/login$/;
const MAX_LOGIN_BODY = 1024;

const SOON = [
  { kind: 'gcp', state: 'soon' },
  { kind: 'azure', state: 'soon' },
] as const;

export interface CloudsRouteOptions {
  aws: AwsConnector | null;
  /** The remote machines: the tunnel port of a remote id, `undefined` for any other. */
  remote?: {
    port: (machineId: string) => number | undefined;
    get: RemoteGet;
    write: RemoteWrite;
  } | null;
}

export type CloudsRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function isCloudsRoute(pathname: string): boolean {
  return pathname === CONNECTORS_ROUTE || pathname.startsWith(`${CONNECTORS_ROUTE}/`) || REMOTE_CONNECTORS.test(pathname) || REMOTE_SESSION_LOGIN.test(pathname);
}

/** The /ui's Entrar and Cancelar: only `POST` or `DELETE` on the exact raw path, `Origin` equal to `http://<Host>`, our Host. */
export function cloudsWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST' && req.method !== 'DELETE') return false;
  const raw = req.url ?? '';
  if (!LOCAL_WRITE_RAW_PATH.test(raw) && !REMOTE_WRITE_RAW_PATH.test(raw)) return false;
  return fromOwnUi(req, port);
}

const REFUSALS: Record<LoginRefusal, { status: number; error: string }> = {
  unknown: { status: 404, error: 'sessão SSO desconhecida no ~/.aws/config' },
  'invalid-file': { status: 409, error: 'O ~/.aws/config está com erro; corrija o arquivo para entrar.' },
  'cli-missing': { status: 409, error: 'a aws CLI não foi encontrada nesta máquina' },
  'cli-unsupported': { status: 409, error: 'a aws CLI desta máquina é a v1; o login por SSO precisa da v2' },
  'name-not-supported': { status: 409, error: 'o nome desta sessão não é suportado na linha de comando' },
  'device-code-unsupported': { status: 409, error: 'a aws CLI desta máquina não tem o login por código (precisa da 2.22 ou mais nova)' },
};

function readLimited(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > max) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', reject);
  });
}

/** The login body: none is `browser`; otherwise exactly `{ "mode": <enum> }`. */
async function readMode(req: IncomingMessage): Promise<LoginMode | { status: number; error: string }> {
  const text = await readLimited(req, MAX_LOGIN_BODY);
  if (text === null) return { status: 413, error: 'corpo grande demais' };
  if (text.trim() === '') return 'browser';
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return { status: 415, error: 'use application/json' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: 'JSON inválido' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'mode')) return { status: 400, error: 'o corpo só aceita { "mode": "browser" | "device-code" }' };
  const mode = (body as { mode?: unknown }).mode;
  if (mode === undefined) return 'browser';
  if (typeof mode !== 'string' || !(LOGIN_MODES as readonly string[]).includes(mode)) return { status: 400, error: 'mode: browser ou device-code' };
  return mode as LoginMode;
}

export function createCloudsRoute(o: CloudsRouteOptions): CloudsRoute {
  return async (req, res, url) => {
    const path = url.pathname;
    if (path === CONNECTORS_ROUTE) {
      req.resume();
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      const connectors: unknown[] = [];
      if (o.aws) connectors.push(await o.aws.view());
      connectors.push(...SOON.map((s) => ({ ...s })));
      return send(res, 200, { connectors });
    }

    const login = SESSION_LOGIN.exec(path);
    if (login) {
      const name = login[1]!;
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        req.resume();
        return send(res, 405, { error: 'use POST ou DELETE' });
      }
      if (!o.aws || !SAFE_CLI_NAME.test(name)) {
        req.resume();
        return send(res, 404, { error: REFUSALS.unknown.error, reason: 'unknown' });
      }
      if (req.method === 'DELETE') {
        req.resume();
        const r = await o.aws.cancel(name);
        if (r.kind === 'unknown') return send(res, 404, { error: REFUSALS.unknown.error, reason: 'unknown' });
        if (r.kind === 'not-running') return send(res, 409, { error: 'nenhum login em andamento nesta sessão', reason: 'not-running' });
        return send(res, 200, { login: r.status });
      }
      const mode = await readMode(req);
      if (typeof mode !== 'string') return send(res, mode.status, { error: mode.error });
      const r = await o.aws.login(name, mode, typeof req.headers.origin === 'string' ? 'ui' : 'local');
      if (r.kind === 'refused') {
        const refusal = REFUSALS[r.reason as LoginRefusal] ?? REFUSALS.unknown;
        return send(res, refusal.status, { error: refusal.error, reason: r.reason });
      }
      return send(res, 202, { login: r.status });
    }

    const remoteRead = REMOTE_CONNECTORS.exec(path);
    const remoteLogin = REMOTE_SESSION_LOGIN.exec(path);
    const machineId = remoteRead?.[1] ?? remoteLogin?.[1];
    if (machineId !== undefined) {
      req.resume();
      const unknown = { error: `máquina desconhecida: ${MACHINE_ID.test(machineId) ? machineId : '(id inválido)'}` };
      const port = MACHINE_ID.test(machineId) && machineId !== LOCAL_MACHINE_ID ? o.remote?.port(machineId) : undefined;
      if (!o.remote || port === undefined) return send(res, 404, unknown);
      if (remoteRead) {
        if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
        const r = await o.remote.get(port, REMOTE_CONNECTORS_PATH);
        if (r.kind === 'unreachable') return send(res, 200, { machine: machineId, status: 'unreachable', reason: r.reason, connectors: [] });
        const connectors = r.status === 200 ? sanitizeConnectors(r.body) : null;
        if (!connectors) return send(res, 200, { machine: machineId, status: 'unsupported', connectors: [] });
        return send(res, 200, { machine: machineId, status: 'ok', connectors });
      }
      const name = remoteLogin![2]!;
      if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'use POST ou DELETE' });
      if (!SAFE_CLI_NAME.test(name)) return send(res, 404, { error: REFUSALS.unknown.error, reason: 'unknown' });
      const remotePath = `${CONNECTORS_ROUTE}/aws/sessions/${name}/login`;
      const r = await o.remote.write(port, req.method, remotePath, req.method === 'POST' ? JSON.stringify({ mode: 'device-code' }) : null);
      if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
      const body = sanitizeLoginAnswer(r.body);
      // A remote núcleo without the route answers 404 with its generic error and no `reason`: the
      // screen then shows the command to run over there (decision 0013 section 2a, C67 state 4).
      if (!body || ![200, 202, 404, 409].includes(r.status)) return send(res, 502, { error: 'resposta inesperada da máquina', reason: 'bad-response' });
      const reason = typeof (r.body as { reason?: unknown }).reason === 'string' && /^[a-z-]{1,40}$/.test((r.body as { reason: string }).reason) ? (r.body as { reason: string }).reason : undefined;
      return send(res, r.status, reason && 'error' in body ? { ...body, reason } : body);
    }

    req.resume();
    return send(res, 404, { error: 'não encontrado' });
  };
}
