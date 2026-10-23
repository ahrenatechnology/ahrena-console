// The connection routes of a remote machine (#278, decision 0013 section 6), behind the server's
// Origin and Host defenses (decision 0003):
//
// - `POST /api/machines/<id>/connection/start`: Subir. `/stop`: Parar. `/reconnect`: Parar (if there
//   is a stop command) then Subir. `/login-and-start`: the AWS connector's browser login for the
//   session of the linked profile, then, only if it exits 0, Subir. Each answers 202 `{ connection }`
//   (the job started, or the same kind already running); 404 `{ error, reason: 'unknown' }` for an id
//   that is not a remote machine; 409 `{ error, reason }` when it cannot run (`ConnectionRefusal`).
// - `DELETE /api/machines/<id>/connection`: Cancelar what runs. 200 `{ connection }`; 409 reason
//   `not-running`; 404.
// - The body is never read and nothing from the request reaches a process: only the id of the path,
//   looked up in the freshest reading of machines.json (src/telemetry/connection.ts).
// - Origin: these method+path pairs are a same-origin exception of the /ui (`connectionWriteFromSameOrigin`,
//   in server.ts's gate), besides the no-Origin loopback request every write accepts (the tray). Any
//   other Origin gets 403 there, before this code runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID, type ReconnectStarter } from '../telemetry/model.ts';
import type { ConnectionRefusal, ConnectionResult, MachineConnection } from '../telemetry/connection.ts';
import { fromOwnUi } from './same-origin.ts';

const ACTION_ROUTE = /^\/api\/machines\/([^/]+)\/connection\/([^/]+)$/;
const CANCEL_ROUTE = /^\/api\/machines\/([^/]+)\/connection$/;
/** The exact raw paths the same-origin exception accepts: a valid id, a known action, no query, no encoding. */
const ACTION_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/connection\/(start|stop|reconnect|login-and-start)$/;
const CANCEL_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/connection$/;

const ACTIONS = ['start', 'stop', 'reconnect', 'login-and-start'] as const;
type Action = (typeof ACTIONS)[number];

export type ConnectionRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function isConnectionRoute(pathname: string): boolean {
  return ACTION_ROUTE.test(pathname) || CANCEL_ROUTE.test(pathname);
}

/** The /ui's Subir, Parar, Reconectar, Entrar e subir (`POST`) and Cancelar (`DELETE`): the exact raw path, `Origin` equal to `http://<Host>`, our Host. */
export function connectionWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  const raw = req.url ?? '';
  if (req.method === 'POST' && ACTION_RAW_PATH.test(raw)) return fromOwnUi(req, port);
  if (req.method === 'DELETE' && CANCEL_RAW_PATH.test(raw)) return fromOwnUi(req, port);
  return false;
}

/** The screen text of each refusal (pt-BR); the `reason` is what the screen and the tray branch on. */
export const CONNECTION_REFUSALS: Record<ConnectionRefusal, { status: number; error: string }> = {
  unknown: { status: 404, error: 'máquina desconhecida' },
  'not-configured': { status: 409, error: 'esta máquina não tem conexão: adicione "connection" (ou "reconnect") a ela no machines.json' },
  'invalid-file': { status: 409, error: 'O machines.json está inválido; corrija o arquivo para mexer na conexão.' },
  busy: { status: 409, error: 'outra ação da conexão está em andamento nesta máquina' },
  'no-stop-command': { status: 409, error: 'esta máquina não tem comando de parar: adicione "connection.stop" no machines.json' },
  'no-cloud-profile': { status: 409, error: 'esta máquina não tem perfil de nuvem: adicione "connection.cloudProfile" no machines.json' },
  'cloud-unavailable': { status: 409, error: 'o conector AWS não está ligado neste núcleo' },
  'profile-not-found': { status: 409, error: 'o perfil da conexão não está no ~/.aws/config deste Mac' },
  'login-not-possible': { status: 409, error: 'o login da sessão deste perfil não pode rodar daqui' },
  'invalid-aws-config': { status: 409, error: 'O ~/.aws/config está com erro; corrija o arquivo para entrar.' },
  'cli-missing': { status: 409, error: 'a aws CLI não foi encontrada neste Mac' },
  'cli-unsupported': { status: 409, error: 'a aws CLI deste Mac é a v1; o login por SSO precisa da v2' },
  'name-not-supported': { status: 409, error: 'o nome da sessão não é suportado na linha de comando' },
  'not-running': { status: 409, error: 'nada da conexão está em andamento nesta máquina' },
};

function answer(res: ServerResponse, r: ConnectionResult, ok: number): void {
  if (r.kind === 'refused') {
    const refusal = CONNECTION_REFUSALS[r.reason];
    return send(res, refusal.status, { error: refusal.error, reason: r.reason });
  }
  send(res, ok, { connection: r.status });
}

export function createConnectionRoute(connection: MachineConnection | null): ConnectionRoute {
  return async (req, res, url) => {
    // The body is never read; drained so the connection stays usable.
    req.resume();
    const action = ACTION_ROUTE.exec(url.pathname);
    const cancel = action ? null : CANCEL_ROUTE.exec(url.pathname);
    const rawId = action?.[1] ?? cancel?.[1] ?? '';
    if (action && req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    if (cancel && req.method !== 'DELETE') return send(res, 405, { error: 'use DELETE' });
    const unknown = { error: `máquina desconhecida: ${MACHINE_ID.test(rawId) ? rawId : '(id inválido)'}`, reason: 'unknown' };
    if (!MACHINE_ID.test(rawId) || rawId === LOCAL_MACHINE_ID || !connection) return send(res, 404, unknown);
    if (action && !(ACTIONS as readonly string[]).includes(action[2]!)) return send(res, 404, { error: 'ação desconhecida' });
    if (cancel) {
      const r = await connection.cancel(rawId);
      if (r.kind === 'refused' && r.reason === 'unknown') return send(res, 404, unknown);
      return answer(res, r, 200);
    }
    const by: ReconnectStarter = typeof req.headers.origin === 'string' ? 'ui' : 'local';
    const verb = action![2] as Action;
    const r =
      verb === 'start'
        ? await connection.start(rawId, by)
        : verb === 'stop'
          ? await connection.stop(rawId, by)
          : verb === 'reconnect'
            ? await connection.reconnect(rawId, by)
            : await connection.loginAndStart(rawId, by);
    if (r.kind === 'refused' && r.reason === 'unknown') return send(res, 404, unknown);
    answer(res, r, 202);
  };
}
