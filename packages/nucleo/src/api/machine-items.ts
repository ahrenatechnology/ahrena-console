// What a remote núcleo sends to the lists of every machine (#243), checked item by item before it
// is merged with this machine's (api/machine-sessions.ts). The pattern of the attention route
// (api/attention-route.ts `remoteAttentionItems`):
//
// - Each item is rebuilt from its JSON with caps (`boundedJson`): depth, text length, array length,
//   number of keys, and only plain keys (never `__proto__`). What does not fit is left out.
// - Each kind of item has the fields the merge and the screen rely on checked (`ROW_CHECKS`): an
//   id, the status, the times as ISO dates. An item that fails is dropped, never repaired.
// - An item that already carries a `machine` is dropped: a remote's own remotes are never passed on.
// - The account goes out with its label and a `#rrggbb` color only (the screen puts it in a style).
// - `open` becomes `{ target: 'remote', command: null }`: nothing a remote sends becomes a command
//   or an "Abrir no Claude Desktop" here (#285).

import { SESSION_STATUSES } from '../model.ts';
import { SESSION_ATTENTION_REASONS } from './attention.ts';
import { STATUS_DO_EVENTO } from './events.ts';
import { paleta } from '../../../marca/gerado/marca.ts';

/** The machine an item comes from, as every list item carries it with `?machine=`. */
export interface MachineTag {
  id: string;
  label: string;
}

const MAX_DEPTH = 8;
const MAX_TEXT = 4_000;
const MAX_ARRAY = 1_000;
const MAX_KEYS = 100;
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** The ids the routes take (a session, an agent `<session>:<agent>`, an event). */
export const REMOTE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const NEUTRAL_ACCOUNT_COLOR = paleta.gray['200'];

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isId = (v: unknown): v is string => typeof v === 'string' && REMOTE_ID.test(v);
const oneOf = (list: readonly string[]) => (v: unknown) => typeof v === 'string' && list.includes(v);

/** A JSON value rebuilt with the caps of the module comment; `undefined` when it does not fit. */
export function boundedJson(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => boundedJson(x, depth + 1)).filter((x) => x !== undefined);
  if (!isObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, x] of Object.entries(v)) {
    if (keys >= MAX_KEYS) break;
    if (!KEY.test(k) || FORBIDDEN_KEYS.has(k)) continue;
    const y = boundedJson(x, depth + 1);
    if (y === undefined) continue;
    out[k] = y;
    keys++;
  }
  return out;
}

const DISPLAY_STATUSES = [...SESSION_STATUSES, 'waiting'];
const INBOX_STATES = [...DISPLAY_STATUSES, 'delegating', 'background'];
const isStatus = oneOf(DISPLAY_STATUSES);
const isAttention = (v: unknown) => v === null || v === undefined || (isObject(v) && (v.level === 'blocked' || v.level === 'idle') && oneOf(SESSION_ATTENTION_REASONS)(v.reason));

/** The kinds of item the lists merge, and what each must have. */
export type RowKind = 'session' | 'wall-card' | 'kanban-session' | 'kanban-agent' | 'event' | 'history' | 'dashboard-agent' | 'dashboard-activity';

const ROW_CHECKS: Record<RowKind, (r: Record<string, unknown>) => boolean> = {
  // `GET /api/sessions` (`LinhaDeSessao`).
  session: (r) =>
    isId(r.id) && typeof r.title === 'string' && isStatus(r.status) && isAttention(r.attention) && isIso(r.lastActivity) && isIso(r.start) && isNumber(r.durationMs) && (r.costUsd === null || isNumber(r.costUsd)),
  // `GET /api/wall` (`WallCard`).
  'wall-card': (r) => isId(r.id) && typeof r.title === 'string' && isStatus(r.status) && oneOf(INBOX_STATES)(r.state) && typeof r.urgent === 'boolean' && isAttention(r.attention) && isIso(r.since),
  // `GET /api/kanban` (`CardDeSessao`, `CardDeAgente`).
  'kanban-session': (r) => isId(r.id) && typeof r.title === 'string' && isStatus(r.status) && isAttention(r.attention) && isIso(r.lastActivity),
  'kanban-agent': (r) => isId(r.id) && isId(r.sessionId) && isStatus(r.status) && isAttention(r.attention) && isIso(r.lastActivity),
  // `GET /api/events` (`EventoDoFeed`).
  event: (r) => isId(r.id) && isIso(r.createdAt) && typeof r.type === 'string' && oneOf(STATUS_DO_EVENTO)(r.status) && isAttention(r.attention) && isObject(r.session) && isId(r.session.id),
  // `GET /api/history` (`HistoryItem`).
  history: (r) => isId(r.id) && oneOf(SESSION_STATUSES)(r.status) && isIso(r.start) && isIso(r.end),
  // `GET /api/dashboard` (`AgenteDoDashboard`, `AtividadeDoDashboard`).
  'dashboard-agent': (r) => isId(r.session) && typeof r.title === 'string' && isAttention(r.attention) && isIso(r.lastActivity),
  'dashboard-activity': (r) => isId(r.session) && typeof r.text === 'string' && isAttention(r.attention) && isIso(r.at),
};

/** A remote's account color when it is `#rrggbb`; the neutral one otherwise (the screens put it in a style). */
export function remoteAccountColor(v: unknown): string {
  return typeof v === 'string' && HEX.test(v) ? v : NEUTRAL_ACCOUNT_COLOR;
}

/** The account as the local ones go out: label and `#rrggbb` color only; `null` otherwise. */
function remoteAccount(v: unknown): { label: string; color: string } | null {
  if (!isObject(v) || typeof v.label !== 'string' || typeof v.color !== 'string') return null;
  return { label: v.label.slice(0, 40), color: remoteAccountColor(v.color) };
}

/** A remote's item of `kind`, rebuilt and marked with its machine; `null` when it lacks the shape. */
export function remoteRow(v: unknown, kind: RowKind, machine: MachineTag): Record<string, unknown> | null {
  if (!isObject(v) || (v.machine !== null && v.machine !== undefined)) return null;
  const r = boundedJson(v) as Record<string, unknown>;
  if (!ROW_CHECKS[kind](r)) return null;
  if ('account' in r) r.account = remoteAccount(r.account);
  if ('open' in r) r.open = { target: 'remote', command: null };
  r.machine = { id: machine.id, label: machine.label };
  return r;
}

/** The remote's items of `kind`, at most `max`, without repeated ids. */
export function remoteRows(v: unknown, kind: RowKind, machine: MachineTag, max = MAX_ARRAY): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const x of v.slice(0, max)) {
    const r = remoteRow(x, kind, machine);
    if (!r) continue;
    // Items with an id appear once; the dashboard's activity rows have none and may repeat a session.
    if (typeof r.id === 'string') {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    out.push(r);
  }
  return out;
}

/** A local item with its machine. */
export function withMachine<T extends object>(item: T, machine: MachineTag): T & { machine: MachineTag } {
  return { ...item, machine: { id: machine.id, label: machine.label } };
}

/** A count a remote sends, capped; 0 when it is not one. */
export function remoteCount(v: unknown, max = 10_000_000): number {
  return isCount(v) ? Math.min(v, max) : 0;
}

/**
 * Merges lists already in order into one, keeping each list's own order: at each step, the head that
 * `first` puts first; on a tie, the earlier list (this machine before the remotes).
 */
export function mergeOrdered<T>(lists: readonly (readonly T[])[], first: (a: T, b: T) => number): T[] {
  const at = lists.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (at[i]! >= lists[i]!.length) continue;
      if (best === -1 || first(lists[i]![at[i]!]!, lists[best]![at[best]!]!) < 0) best = i;
    }
    if (best === -1) return out;
    out.push(lists[best]![at[best]!]!);
    at[best]!++;
  }
}

/** Newer first by an ISO field; equal or unreadable keep the lists' order. */
export const newerFirst =
  <T>(key: (x: T) => unknown) =>
  (a: T, b: T): number => {
    const x = Date.parse(String(key(a)));
    const y = Date.parse(String(key(b)));
    return Number.isFinite(x) && Number.isFinite(y) ? y - x : 0;
  };
