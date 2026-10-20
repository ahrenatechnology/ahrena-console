// As rotas da telemetria (#175, decisão 0008), só `GET`, com as defesas de Origin e Host do servidor
// (decisão 0003) como as outras:
//
// - `GET /api/machines`: `[{ id, label, state, lastReadAt, alerts }]`, esta máquina primeiro. `state`
//   é `connected`, `unreachable`, `not-configured` ou `incompatible-version` (as remotas são a #176).
// - `GET /api/telemetry?machine=<id>&hours=1|12`: `{ version, machine, hours, current, series, alerts }`
//   (src/telemetry/service.ts). `machine` padrão `local`, `hours` padrão 1. Parâmetro inválido dá 400;
//   máquina que não existe, 404.
// - Sem a telemetria ligada na API (plataforma sem coletor): 404 nas duas.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { isWindowHours, LOCAL_MACHINE_ID, MACHINE_ID, type WindowHours } from '../telemetry/model.ts';
import type { TelemetryService } from '../telemetry/service.ts';

export const MACHINES_ROUTE = '/api/machines';
export const TELEMETRY_ROUTE = '/api/telemetry';

const SEM_TELEMETRIA = { error: 'o núcleo subiu sem a telemetria' };

export function isTelemetryRoute(pathname: string): boolean {
  return pathname === MACHINES_ROUTE || pathname === TELEMETRY_ROUTE;
}

/** Lê `machine` e `hours`; devolve a mensagem de erro quando algum é inválido. */
export function readTelemetryRequest(params: URLSearchParams): { machine: string; hours: WindowHours } | string {
  const machine = params.get('machine') ?? LOCAL_MACHINE_ID;
  if (!MACHINE_ID.test(machine)) return 'machine inválida: letras minúsculas, números e hífen';
  const bruto = params.get('hours');
  const hours = bruto === null || bruto === '' ? 1 : Number(bruto);
  if (!/^\d+$/.test(bruto ?? '1') || !isWindowHours(hours)) return 'hours: 1 ou 12';
  return { machine, hours };
}

export async function respondTelemetry(res: ServerResponse, url: URL, telemetry: TelemetryService | null | undefined): Promise<void> {
  if (!telemetry) return send(res, 404, SEM_TELEMETRIA);
  if (url.pathname === MACHINES_ROUTE) return send(res, 200, await telemetry.machines());
  const pedido = readTelemetryRequest(url.searchParams);
  if (typeof pedido === 'string') return send(res, 400, { error: pedido });
  const corpo = await telemetry.telemetry(pedido.machine, pedido.hours);
  if (!corpo) return send(res, 404, { error: `máquina desconhecida: ${pedido.machine}` });
  send(res, 200, corpo);
}
