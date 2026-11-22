/*
 * The diagnosis route (#565, epic #563), `GET` only, behind the server's Origin and Host defenses
 * like the other reads:
 *
 * - `GET /api/diagnosis?machine=<id>&alert=<alertId>`: 200 `{ machine, alertId, kind, takenAt, sections }`
 *   (src/diagnosis/model.ts). The contract is docs/contracts/core-api.openapi.json, the diagnosis operation.
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
 * The local-or-remote reading is `createDiagnosisReader`, which the delegation (api/delegations.ts, #567) reuses.
 *
 * A remote machine is asked the same route through its tunnel port, as `machine=local` and the id of the
 * open alert encoded again for the wire; its answer is re-projected before it is returned, as the machine
 * asked for.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { diagnose, shape, type DiagnoseDeps } from '../diagnosis/diagnose.ts';
import {
  CACHE_ACTION_IDS,
  SECTION_IDS,
  SECTION_STATUSES,
  capReason,
  isDiagnosable,
  sectionsFor,
  type CacheActionId,
  type CacheItem,
  type Diagnosis,
  type DiagnosisSection,
  type DockerDfItem,
  type FolderItem,
  type JournalItem,
  type OutsideSessionLoad,
  type ProcessItem,
  type SectionId,
  type SectionItems,
  type SectionOf,
  type SectionStatus,
  type SessionLoadItem,
  type SwapItem,
  type WorktreeItem,
  type WorktreesInfo,
} from '../diagnosis/model.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID, type AlertKind } from '../telemetry/model.ts';
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

export type DiagnosisQuery = { machine: string; alertId: string } | string;

/** `machine` and `alert` exactly once each; the error message when one is missing or invalid. Shared with the delegation preview (#567). */
export function readDiagnosisQuery(params: URLSearchParams): DiagnosisQuery {
  const machines = params.getAll('machine');
  const machine = machines[0];
  if (machines.length !== 1 || machine === undefined || !MACHINE_ID.test(machine)) return 'machine inválida: informe uma vez, com letras minúsculas, números e hífen';
  const alert = params.getAll('alert');
  const alertId = alert[0] ?? '';
  if (alert.length !== 1 || !isAlertIdParam(alertId)) return `alert inválido: informe uma vez o id de um alerta aberto, com até ${ALERT_ID_MAX} caracteres`;
  return { machine, alertId };
}

/** Whether `alertId` is an id the diagnosis query accepts; the delegation body follows the same rule (#567). */
export function isAlertIdParam(alertId: unknown): alertId is string {
  return typeof alertId === 'string' && alertId !== '' && alertId.length <= ALERT_ID_MAX && !/[\u0000-\u001f\u007f]/.test(alertId);
}

/** What reading one machine's diagnosis ends in; the route maps each to its status, the delegation port to its answer (#567). */
export type DiagnosisReading =
  | { kind: 'ok'; diagnosis: Diagnosis }
  | { kind: 'unknown-machine' }
  | { kind: 'alert-not-open' }
  | { kind: 'not-diagnosable' }
  | { kind: 'unsupported' }
  | { kind: 'unreachable' }
  | { kind: 'bad-response' };

export type DiagnosisReader = (machine: string, alertId: string) => Promise<DiagnosisReading>;

/** The local diagnosis, or the remote machine's through its tunnel: one reader for the route and for the delegation (#567). */
export function createDiagnosisReader(o: DiagnosisRouteOptions): DiagnosisReader {
  const log = o.log ?? (() => {});
  const local = o.local;

  async function readHere(machine: string, alertId: string): Promise<DiagnosisReading> {
    if (!local) return { kind: 'unsupported' };
    return diagnose({ machine, alertId }, { ...local, alerts: o.alerts, isKnownMachine: (id) => id === LOCAL_MACHINE_ID });
  }

  async function readThere(machine: string, port: number, remote: NonNullable<DiagnosisRouteOptions['remote']>, alertId: string): Promise<DiagnosisReading> {
    // The Mac validates against what it tracks for the machine, and sends the id of that open alert, never the query's text.
    const open = o.alerts.active(machine).find((a) => a.id === alertId);
    if (!open) return { kind: 'alert-not-open' };
    if (!isDiagnosable(open.kind)) return { kind: 'not-diagnosable' };
    const r = await remote.get(port, `${DIAGNOSIS_ROUTE}?machine=${LOCAL_MACHINE_ID}&alert=${encodeURIComponent(open.id)}`);
    if (r.kind === 'unreachable') {
      log(`diagnosis: ${machine} did not answer: ${r.reason}`);
      return { kind: 'unreachable' };
    }
    const body = r.body;
    if (r.status === 200) {
      const remoteDiagnosis = readDiagnosis(body, open.id, open.kind);
      if (remoteDiagnosis) return { kind: 'ok', diagnosis: { machine, alertId: open.id, kind: open.kind, ...remoteDiagnosis } satisfies Diagnosis };
    } else if (r.status === 501 && isRecord(body) && body.error === UNSUPPORTED.error) {
      return { kind: 'unsupported' };
    } else if (r.status === 404 || r.status === 405) {
      // A núcleo that has the route says why in `reason`; one that has not answers its own 404 (or 405): an old núcleo.
      if (r.status === 404 && isRecord(body) && body.reason === 'alert-not-open') return { kind: 'alert-not-open' };
      return { kind: 'unsupported' };
    }
    log(`diagnosis: ${machine} answered ${r.status}, not a diagnosis`);
    return { kind: 'bad-response' };
  }

  return async (machine, alertId) => {
    if (machine === LOCAL_MACHINE_ID) return readHere(machine, alertId);
    const port = o.remote?.port(machine);
    if (!o.remote || port === undefined) return { kind: 'unknown-machine' };
    return readThere(machine, port, o.remote, alertId);
  };
}

export function createDiagnosisRoute(o: DiagnosisRouteOptions): DiagnosisRoute {
  const read = createDiagnosisReader(o);
  return async (req, res, url) => {
    req.resume();
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    const query = readDiagnosisQuery(url.searchParams);
    if (typeof query === 'string') return send(res, 400, { error: query });
    const r = await read(query.machine, query.alertId);
    switch (r.kind) {
      case 'ok':
        return send(res, 200, r.diagnosis);
      case 'unknown-machine':
        return unknownMachine(res, query.machine);
      case 'alert-not-open':
        return alertNotOpen(res);
      case 'not-diagnosable':
        return notDiagnosable(res);
      case 'unsupported':
        return respondDiagnosisUnsupported(res);
      case 'unreachable':
        return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
      case 'bad-response':
        return send(res, 502, { error: 'resposta inesperada da máquina', reason: 'bad-response' });
    }
  };
}

const unknownMachine = (res: ServerResponse, machine: string) => send(res, 404, { error: `máquina desconhecida: ${machine}`, reason: 'unknown-machine' });
const alertNotOpen = (res: ServerResponse) => send(res, 404, { error: 'o alerta não está aberto nesta máquina', reason: 'alert-not-open' });
const notDiagnosable = (res: ServerResponse) => send(res, 422, { error: 'este alerta não tem diagnóstico', reason: 'not-diagnosable' });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const ACTION_IDS: readonly unknown[] = Object.values(CACHE_ACTION_IDS);
const isCacheActionId = (v: unknown): v is CacheActionId => ACTION_IDS.includes(v);

/*
 * One reader per item shape of the contract (docs/contracts/core-api.openapi.json, the diagnosis operation): every documented field is
 * checked, and the item is rebuilt from those fields only, so a key the contract does not name never
 * passes. `null` when the item is not that shape.
 */
function readProcess(v: unknown): ProcessItem | null {
  if (!isRecord(v) || !isNumber(v.pid) || !isString(v.name) || !isNumber(v.rssBytes) || !isNumber(v.cpuPct) || !isString(v.startedAt)) return null;
  return { pid: v.pid, name: v.name, rssBytes: v.rssBytes, cpuPct: v.cpuPct, startedAt: v.startedAt };
}
function readSessionLoad(v: unknown): SessionLoadItem | null {
  if (!isRecord(v) || !isString(v.sessionId) || !(v.title === null || isString(v.title)) || !isString(v.rootCommand) || !(v.cwd === null || isString(v.cwd))) return null;
  if (!isNumber(v.processCount) || !Number.isInteger(v.processCount) || v.processCount < 0 || !isNumber(v.cpuPct) || v.cpuPct < 0) return null;
  return { sessionId: v.sessionId, title: v.title, rootCommand: v.rootCommand, cwd: v.cwd, processCount: v.processCount, cpuPct: v.cpuPct };
}
/** The outside-session line of a `processes-by-session` section, rebuilt from its two documented fields; `null` when absent or malformed, because the sessions are still a diagnosis without it (issue 722). */
function readOutsideSession(v: unknown): OutsideSessionLoad | null {
  if (!isRecord(v) || !isNumber(v.processCount) || !Number.isInteger(v.processCount) || v.processCount < 0 || !isNumber(v.cpuPct) || v.cpuPct < 0) return null;
  return { processCount: v.processCount, cpuPct: v.cpuPct };
}
function readSwap(v: unknown): SwapItem | null {
  if (!isRecord(v) || !isNumber(v.usedBytes) || !isNumber(v.totalBytes)) return null;
  return { usedBytes: v.usedBytes, totalBytes: v.totalBytes };
}
function readFolder(v: unknown): FolderItem | null {
  if (!isRecord(v) || !isString(v.path) || !isNumber(v.bytes)) return null;
  return { path: v.path, bytes: v.bytes };
}
function readDockerDf(v: unknown): DockerDfItem | null {
  if (!isRecord(v) || !isString(v.type) || !isNumber(v.usedBytes) || !isNumber(v.reclaimableBytes)) return null;
  return { type: v.type, usedBytes: v.usedBytes, reclaimableBytes: v.reclaimableBytes };
}
/** A cache points to a cleanup action of #569; a worktree (`id: 'worktree'`) points to none. */
function readCache(v: unknown): CacheItem | WorktreeItem | null {
  if (!isRecord(v) || !isString(v.id) || !isString(v.path) || !isNumber(v.bytes)) return null;
  if (v.id === 'worktree') {
    if (v.actionId !== null || !isString(v.lastUsedAt) || !isBoolean(v.hasUncommitted) || !isBoolean(v.hasUnpushed)) return null;
    return { id: 'worktree', path: v.path, bytes: v.bytes, lastUsedAt: v.lastUsedAt, hasUncommitted: v.hasUncommitted, hasUnpushed: v.hasUnpushed, actionId: null };
  }
  if (!isCacheActionId(v.actionId)) return null;
  return { id: v.id, path: v.path, bytes: v.bytes, actionId: v.actionId };
}
/** The worktrees facts of an `ok` `known-caches` section, rebuilt from the two documented fields; `null` when absent or malformed, because the screen does not need them to draw the section (#566). */
function readWorktrees(v: unknown): WorktreesInfo | null {
  if (!isRecord(v) || !isNumber(v.oldAfterDays) || !Number.isInteger(v.oldAfterDays) || v.oldAfterDays < 1) return null;
  if (v.root !== null && !isString(v.root)) return null;
  return { oldAfterDays: v.oldAfterDays, root: v.root };
}
function readJournal(v: unknown): JournalItem | null {
  if (!isRecord(v) || !isNumber(v.bytes)) return null;
  return { bytes: v.bytes };
}

type ItemReaders = { [K in SectionId]: (v: unknown) => SectionItems[K][number] | null };
const ITEM_READERS: ItemReaders = {
  'processes-by-rss': readProcess,
  'processes-by-cpu': readProcess,
  'processes-by-session': readSessionLoad,
  swap: readSwap,
  'largest-folders': readFolder,
  'docker-df': readDockerDf,
  'known-caches': readCache,
  journal: readJournal,
};

/** The items of one section, each read by its shape, then sorted and capped as a local answer is; `null` when one is not that shape. */
function readItems<K extends SectionId>(id: K, raw: unknown[]): SectionItems[K] | null {
  const read: ItemReaders[K] = ITEM_READERS[id];
  const items: SectionItems[K][number][] = [];
  for (const v of raw) {
    const item = read(v);
    if (item === null) return null;
    items.push(item);
  }
  return shape(id, items as SectionItems[K]);
}

function readSection<K extends SectionId>(id: K, status: SectionStatus, s: Record<string, unknown>, raw: unknown[]): SectionOf<K> | null {
  // A section that did not come has no items (the contract); one that says otherwise is not a diagnosis.
  if (status !== 'ok' && raw.length > 0) return null;
  const items = readItems(id, raw);
  if (!items) return null;
  const section: SectionOf<K> = { id, status, items } as SectionOf<K>;
  if (status !== 'ok' && typeof s.reason === 'string') section.reason = capReason(s.reason);
  if (status === 'ok' && isRecord(s.partial) && typeof s.partial.reason === 'string') section.partial = { reason: capReason(s.partial.reason) };
  if (status === 'ok' && id === 'known-caches') {
    const worktrees = readWorktrees(s.worktrees);
    if (worktrees) section.worktrees = worktrees;
  }
  if (status === 'ok' && id === 'processes-by-session') {
    const outsideSession = readOutsideSession(s.outsideSession);
    if (outsideSession) section.outsideSession = outsideSession;
  }
  return section;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
/** A núcleo older than issue 722 answers a `load-high` without `processes-by-session`: that is still a diagnosis, with one section fewer. */
const withoutSessions = (ids: readonly string[]) => ids.filter((id) => id !== 'processes-by-session');

/**
 * A remote diagnosis, re-projected: only known ids and statuses, the sections of the alert's kind on
 * Darwin or Linux in order and once each, the keys of a section and of each item and no others, a short
 * `reason`, lists sorted and capped. `null` when the body is not a diagnosis of this alert.
 */
function readDiagnosis(body: unknown, alertId: string, kind: AlertKind): Pick<Diagnosis, 'takenAt' | 'sections'> | null {
  if (!isRecord(body) || body.alertId !== alertId || typeof body.takenAt !== 'string' || Number.isNaN(Date.parse(body.takenAt)) || !Array.isArray(body.sections)) return null;
  const sections: DiagnosisSection[] = [];
  for (const s of body.sections as unknown[]) {
    if (!isRecord(s) || !(SECTION_IDS as readonly unknown[]).includes(s.id) || !(SECTION_STATUSES as readonly unknown[]).includes(s.status) || !Array.isArray(s.items)) return null;
    const section = readSection(s.id as SectionId, s.status as SectionStatus, s, s.items as unknown[]);
    if (!section) return null;
    sections.push(section);
  }
  const ids = sections.map((s) => s.id);
  const expected = [sectionsFor(kind, 'darwin'), sectionsFor(kind, 'linux')].flatMap((list) => [list, withoutSessions(list)]);
  if (!expected.some((list) => sameIds(ids, list))) return null;
  return { takenAt: body.takenAt, sections };
}
