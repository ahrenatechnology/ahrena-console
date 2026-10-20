// The telemetry routes (#175, decision 0008), `GET` only, behind the server's Origin and Host
// defenses (decision 0003) like the others:
//
// - `GET /api/machines`: `[{ id, label, state, reason, version, port, lastReadAt, alerts, reconnect }]`,
//   this machine first, then the remote ones of `machines.json` (#176); `reconnect` (#244) is `null`
//   for this machine and the demo's simulated one. `state` is `connected`,
//   `unreachable` (with `reason`), `not-configured` or `incompatible-version`.
// - `GET /api/telemetry?machine=<id>&hours=1|12`: `{ version, machine, hours, current, series, alerts }`
//   (src/telemetry/service.ts). `machine` defaults to `local`, `hours` to 1. An invalid parameter
//   gives 400; a machine that does not exist, 404.
// - Without telemetry wired into the API (a platform with no collector): 404 on both.
//
// And the reconnect of a remote machine (#244, decision 0012 section 4), the two writes:
//
// - `POST /api/machines/<id>/reconnect`: starts the command of machines.json, or returns the one
//   running. 202 `{ reconnect }`; 404 for an unknown id; 409 `{ error }` without a command. The body
//   is never read: only the id of the path reaches the runner (src/telemetry/reconnect.ts). 409 too
//   while machines.json is invalid, even if its last good reading had a command.
// - `DELETE /api/machines/<id>/reconnect`: Cancel. 200 `{ reconnect }` (`canceled`); 409 when nothing
//   runs; 404 for an unknown id.
// - Origin: these two method+path pairs are a same-origin exception of the /ui (`reconnectFromSameOrigin`,
//   called in server.ts `handle`), besides the no-Origin loopback request every write accepts. Any
//   other Origin gets 403 there, before this code runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID, type WindowHours } from '../telemetry/model.ts';
import type { ReconnectStarter } from '../telemetry/model.ts';
import type { ReconnectControl } from '../telemetry/reconnect.ts';
import type { TelemetryService } from '../telemetry/service.ts';

export const MACHINES_ROUTE = '/api/machines';
export const TELEMETRY_ROUTE = '/api/telemetry';

const NO_TELEMETRY = { error: 'o núcleo subiu sem a telemetria' };

/** `/api/machines/<id>/reconnect`; the id is checked against `MACHINE_ID` before anything else. */
export const RECONNECT_ROUTE = /^\/api\/machines\/([^/]+)\/reconnect$/;
/** The exact raw path the same-origin exception accepts: a valid id, no query, no encoding. */
const RECONNECT_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/reconnect$/;

/** The /ui's Reconnect and Cancel (#244): only `POST` or `DELETE` on the exact path, `Origin` equal to `http://<Host>`, our Host. */
export function reconnectFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST' && req.method !== 'DELETE') return false;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (!RECONNECT_RAW_PATH.test(req.url ?? '')) return false;
  return origin === `http://${host}`;
}

export function isTelemetryRoute(pathname: string): boolean {
  return pathname === MACHINES_ROUTE || pathname === TELEMETRY_ROUTE;
}

/** Reads `machine` and `hours`; returns the error message when one is invalid. */
export function readTelemetryRequest(params: URLSearchParams): { machine: string; hours: WindowHours } | string {
  const machine = params.get('machine') ?? LOCAL_MACHINE_ID;
  if (!MACHINE_ID.test(machine)) return 'machine inválida: letras minúsculas, números e hífen';
  // Absent or empty means the default; otherwise only `1` or `12` written exactly so (not `012` or `1.0`).
  const raw = params.get('hours') || '1';
  if (!/^(1|12)$/.test(raw)) return 'hours: 1 ou 12';
  const hours = Number(raw) as WindowHours;
  return { machine, hours };
}

export async function respondTelemetry(res: ServerResponse, url: URL, telemetry: TelemetryService | null | undefined): Promise<void> {
  if (!telemetry) return send(res, 404, NO_TELEMETRY);
  if (url.pathname === MACHINES_ROUTE) return send(res, 200, await telemetry.machines());
  const query = readTelemetryRequest(url.searchParams);
  if (typeof query === 'string') return send(res, 400, { error: query });
  const body = await telemetry.telemetry(query.machine, query.hours);
  if (!body) return send(res, 404, { error: `máquina desconhecida: ${query.machine}` });
  send(res, 200, body);
}

/**
 * `POST` and `DELETE /api/machines/<id>/reconnect`. Reached only after the server's Origin check: a
 * request with an `Origin` here is the same-origin /ui (`ui`), one without it the loopback client (`local`).
 */
export async function respondReconnect(
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
  control: ReconnectControl | null | undefined,
  telemetry: TelemetryService | null | undefined,
): Promise<void> {
  // The body is never read; drained so the connection stays usable.
  req.resume();
  if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'use POST ou DELETE' });
  const unknown = { error: `máquina desconhecida: ${MACHINE_ID.test(rawId) ? rawId : '(id inválido)'}` };
  if (!MACHINE_ID.test(rawId) || rawId === LOCAL_MACHINE_ID) return send(res, 404, unknown);
  if (!control) return telemetry?.has(rawId) ? send(res, 409, { error: NOT_CONFIGURED }) : send(res, 404, unknown);
  if (req.method === 'POST') {
    const startedBy: ReconnectStarter = typeof req.headers.origin === 'string' ? 'ui' : 'local';
    const r = await control.start(rawId, startedBy);
    if (r.kind === 'unknown') return send(res, 404, unknown);
    if (r.kind === 'not-configured') return send(res, 409, { error: NOT_CONFIGURED });
    if (r.kind === 'invalid-file') return send(res, 409, { error: INVALID_FILE });
    return send(res, 202, { reconnect: r.status });
  }
  const r = await control.cancel(rawId);
  if (r.kind === 'unknown') return send(res, 404, unknown);
  if (r.kind === 'not-running') return send(res, 409, { error: 'nenhuma reconexão em andamento nesta máquina' });
  send(res, 200, { reconnect: r.status });
}

const INVALID_FILE = 'O machines.json está inválido; corrija o arquivo para reconectar.';
const NOT_CONFIGURED = 'esta máquina não tem comando de reconexão: adicione "reconnect" a ela no machines.json';
