// The telemetry routes (#175, decision 0008), `GET` only, behind the server's Origin and Host
// defenses (decision 0003) like the others:
//
// - `GET /api/machines`: `[{ id, label, state, lastReadAt, alerts }]`, this machine first. `state`
//   is `connected`, `unreachable`, `not-configured` or `incompatible-version` (remote machines are
//   #176).
// - `GET /api/telemetry?machine=<id>&hours=1|12`: `{ version, machine, hours, current, series, alerts }`
//   (src/telemetry/service.ts). `machine` defaults to `local`, `hours` to 1. An invalid parameter
//   gives 400; a machine that does not exist, 404.
// - Without telemetry wired into the API (a platform with no collector): 404 on both.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID, type WindowHours } from '../telemetry/model.ts';
import type { TelemetryService } from '../telemetry/service.ts';

export const MACHINES_ROUTE = '/api/machines';
export const TELEMETRY_ROUTE = '/api/telemetry';

const NO_TELEMETRY = { error: 'o núcleo subiu sem a telemetria' };

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
