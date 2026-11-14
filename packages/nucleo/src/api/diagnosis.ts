/*
 * The diagnosis route (#565, epic #563), `GET` only, behind the server's Origin and Host defenses
 * like the other reads:
 *
 * - `GET /api/diagnosis?machine=<id>&alert=<alertId>`: 200 `{ machine, alertId, kind, takenAt, sections }`
 *   (src/diagnosis/model.ts). The contract is docs/contracts/diagnosis.md.
 * - 400 for a missing, repeated or invalid parameter; 404 `{ error, reason }` for a machine that does not
 *   exist (`unknown-machine`) or an alert that is not open on it (`alert-not-open`); 422 `not-diagnosable`
 *   for an open alert of a kind that has no diagnosis; 405 for another method.
 * - 501 `{ error: "diagnosis-unsupported" }` when this núcleo cannot diagnose (no collector for its
 *   platform, or the route not wired), and when the remote núcleo asked for a machine says it cannot or
 *   does not have the route (an old núcleo): stable, so the screen tells it from a failure.
 * - 502 `{ error, reason }` when a remote machine does not answer or answers something that is not a diagnosis.
 *
 * Nothing in the query reaches a command: `machine` is checked against the known machines and `alert`
 * against the alerts the tracker holds open (the use case, src/diagnosis/diagnose.ts, takes the mount from
 * the open alert). The query is decoded once, by `URLSearchParams`.
 *
 * A remote machine is asked the same route through its tunnel port, as `machine=local` and the id of the
 * open alert encoded again for the wire; its answer is re-projected before it is returned, as the machine
 * asked for.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { diagnose, type DiagnoseDeps } from '../diagnosis/diagnose.ts';
import { SECTION_IDS, SECTION_STATUSES, capReason, isDiagnosable, type Diagnosis, type DiagnosisSection } from '../diagnosis/model.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';

export const DIAGNOSIS_ROUTE = '/api/diagnosis';

const UNSUPPORTED = { error: 'diagnosis-unsupported' };
const ALERT_ID_MAX = 200;

export interface DiagnosisRouteOptions {
  /** The machines' open alerts; `AlertTracker` satisfies it. This route reads it and never decides an alert. */
  alerts: DiagnoseDeps['alerts'];
  /** This machine's collector and clock; `null` where there is no collector (a platform without one, `--demo`): 501. */
  local: Omit<DiagnoseDeps, 'alerts' | 'isKnownMachine'> | null;
  /** The remote machines and the tunnel `GET` that reaches their núcleo; without it, only this machine exists. */
  remote?: { port: (machineId: string) => number | undefined; get: RemoteGet } | null;
  log?: (message: string) => void;
}

export type DiagnosisRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** A núcleo with no diagnosis wired answers the route with the same 501 a núcleo that cannot diagnose does. */
export function respondDiagnosisUnsupported(res: ServerResponse): void {
  send(res, 501, UNSUPPORTED);
}

type Query = { machine: string; alertId: string } | string;

/** `machine` and `alert` exactly once each; the error message when one is missing or invalid. */
function readQuery(params: URLSearchParams): Query {
  const machines = params.getAll('machine');
  const machine = machines[0];
  if (machines.length !== 1 || machine === undefined || !MACHINE_ID.test(machine)) return 'machine inválida: informe uma vez, com letras minúsculas, números e hífen';
  const alert = params.getAll('alert');
  const alertId = alert[0] ?? '';
  if (alert.length !== 1 || alertId === '' || alertId.length > ALERT_ID_MAX || /[\u0000-\u001f\u007f]/.test(alertId)) return `alert inválido: informe uma vez o id de um alerta aberto, com até ${ALERT_ID_MAX} caracteres`;
  return { machine, alertId };
}

export function createDiagnosisRoute(o: DiagnosisRouteOptions): DiagnosisRoute {
  const log = o.log ?? (() => {});
  const local = o.local;

  async function diagnoseHere(res: ServerResponse, machine: string, alertId: string): Promise<void> {
    if (!local) return respondDiagnosisUnsupported(res);
    const r = await diagnose({ machine, alertId }, { ...local, alerts: o.alerts, isKnownMachine: (id) => id === LOCAL_MACHINE_ID });
    if (r.kind === 'ok') return send(res, 200, r.diagnosis);
    if (r.kind === 'unknown-machine') return unknownMachine(res, machine);
    if (r.kind === 'alert-not-open') return alertNotOpen(res);
    return notDiagnosable(res);
  }

  async function diagnoseThere(res: ServerResponse, machine: string, port: number, remote: NonNullable<DiagnosisRouteOptions['remote']>, alertId: string): Promise<void> {
    // The Mac validates against what it tracks for the machine, and sends the id of that open alert, never the query's text.
    const open = o.alerts.active(machine).find((a) => a.id === alertId);
    if (!open) return alertNotOpen(res);
    if (!isDiagnosable(open.kind)) return notDiagnosable(res);
    const r = await remote.get(port, `${DIAGNOSIS_ROUTE}?machine=${LOCAL_MACHINE_ID}&alert=${encodeURIComponent(open.id)}`);
    if (r.kind === 'unreachable') {
      log(`diagnosis: ${machine} did not answer: ${r.reason}`);
      return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
    }
    const body = r.body;
    if (r.status === 200) {
      const sections = readSections(body, open.id);
      if (sections) return send(res, 200, { machine, alertId: open.id, kind: open.kind, takenAt: takenAtOf(body), sections } satisfies Diagnosis);
    } else if (r.status === 501 && isRecord(body) && body.error === UNSUPPORTED.error) {
      return respondDiagnosisUnsupported(res);
    } else if (r.status === 404 || r.status === 405) {
      // A núcleo that has the route says why in `reason`; one that has not answers its own 404 (or 405): an old núcleo.
      if (r.status === 404 && isRecord(body) && body.reason === 'alert-not-open') return alertNotOpen(res);
      return respondDiagnosisUnsupported(res);
    }
    log(`diagnosis: ${machine} answered ${r.status}, not a diagnosis`);
    return send(res, 502, { error: 'resposta inesperada da máquina', reason: 'bad-response' });
  }

  return async (req, res, url) => {
    req.resume();
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    const query = readQuery(url.searchParams);
    if (typeof query === 'string') return send(res, 400, { error: query });
    if (query.machine === LOCAL_MACHINE_ID) return diagnoseHere(res, query.machine, query.alertId);
    const port = o.remote?.port(query.machine);
    if (!o.remote || port === undefined) return unknownMachine(res, query.machine);
    return diagnoseThere(res, query.machine, port, o.remote, query.alertId);
  };
}

const unknownMachine = (res: ServerResponse, machine: string) => send(res, 404, { error: `máquina desconhecida: ${machine}`, reason: 'unknown-machine' });
const alertNotOpen = (res: ServerResponse) => send(res, 404, { error: 'o alerta não está aberto nesta máquina', reason: 'alert-not-open' });
const notDiagnosable = (res: ServerResponse) => send(res, 422, { error: 'este alerta não tem diagnóstico', reason: 'not-diagnosable' });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function takenAtOf(body: unknown): string {
  return isRecord(body) && typeof body.takenAt === 'string' ? body.takenAt : '';
}

/**
 * The sections of a remote diagnosis, re-projected: only known ids and statuses, the keys of a section and
 * no others, a short `reason`. `null` when the body is not a diagnosis of this alert.
 */
function readSections(body: unknown, alertId: string): DiagnosisSection[] | null {
  if (!isRecord(body) || body.alertId !== alertId || typeof body.takenAt !== 'string' || !Array.isArray(body.sections)) return null;
  const sections: DiagnosisSection[] = [];
  for (const s of body.sections as unknown[]) {
    if (!isRecord(s) || !(SECTION_IDS as readonly unknown[]).includes(s.id) || !(SECTION_STATUSES as readonly unknown[]).includes(s.status) || !Array.isArray(s.items)) return null;
    const section: Record<string, unknown> = { id: s.id, status: s.status, items: s.items };
    if (typeof s.reason === 'string') section.reason = capReason(s.reason);
    if (isRecord(s.partial) && typeof s.partial.reason === 'string') section.partial = { reason: capReason(s.partial.reason) };
    // The ids, statuses and the array were checked above; the items are the remote collector's, as `DiagnosisSection` says.
    sections.push(section as unknown as DiagnosisSection);
  }
  return sections;
}
