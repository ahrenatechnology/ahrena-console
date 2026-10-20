// The history of ended sessions (#33, C15): pure rules, with no port and no clock.
//
// - A session with `endedAt` goes in; its day is the day it ended, in the requested time zone (the
//   core machine's, injectable for tests).
// - A page counts days with a session (empty days do not show), from newest to oldest; within a day,
//   the sessions from the latest end to the earliest.
// - The cursor is a day: `before` returns the days strictly before it, and `next` is the page's last
//   day while there are more.
// - The shapes that reach the API (`EndedSession`, `HistoryDay`, `HistoryPage`) have
//   English keys since phase 2b of #173.
// - The search is a case-insensitive substring on the title, the id and the project, before paging.

import { basename } from 'node:path';
import { dayOf } from '../cost/aggregation.ts';
import { DEFAULT_PRICES, type DefaultPrice } from '../cost/default-prices.ts';
import type { Session, SessionStatus } from '../model.ts';
import { resolvePricing } from '../pricing.ts';

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 31;
export const MAX_SEARCH_LENGTH = 100;

/** What the history needs from an ended session, before the cost and the links. */
export interface EndedSession {
  id: string;
  title: string | null;
  /** The session's folder (`basename` of `cwd`). */
  project: string | null;
  /** The model's readable name (`modelDisplayName`). */
  model: string | null;
  status: SessionStatus;
  start: string;
  end: string;
}

export interface HistoryRequest {
  /** `YYYY-MM-DD`: only days strictly before it. `null` starts from the newest. */
  before: string | null;
  /** How many days with a session per page. */
  days: number;
  /** Already trimmed; `null` with no filter. */
  search: string | null;
}

export interface HistoryDay<T> {
  day: string;
  sessions: T[];
}

export interface HistoryPage<T> {
  days: HistoryDay<T>[];
  /** Pass as `before` for the next page; `null` when it is over. */
  next: string | null;
}

/**
 * `claude-opus-5-5` → "Opus 5.5", by the name in the default price table; `[1m]` becomes " 1M". A
 * model that is not in the table keeps its id.
 */
export function modelDisplayName(model: string | null): string | null {
  if (!model) return null;
  const long = /\[1m\]$/i.test(model);
  const id = model.replace(/\[1m\]$/i, '');
  const name = (resolvePricing(id, DEFAULT_PRICES) as DefaultPrice | null)?.name.replace(/^Claude /, '');
  return name ? `${name}${long ? ' 1M' : ''}` : model;
}

/** The history session, or `null` if it has not ended. `title` replaces the session name (e.g. the Desktop's). */
export function endedSessionOf(s: Session, title?: string | null): EndedSession | null {
  if (!s.endedAt) return null;
  return {
    id: s.id,
    title: title ?? s.name ?? null,
    project: s.cwd ? basename(s.cwd) || null : null,
    model: modelDisplayName(s.model),
    status: s.status,
    start: s.startedAt,
    end: s.endedAt,
  };
}

function matchesSearch(s: EndedSession, search: string): boolean {
  const needle = search.toLowerCase();
  return [s.title, s.id, s.project].some((v) => v !== null && v.toLowerCase().includes(needle));
}

// Latest end first; on a tie, the larger id, so the order does not depend on the read.
const newestFirst = (a: EndedSession, b: EndedSession) => (a.end === b.end ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.end < b.end ? 1 : -1);

export function historyPage<T extends EndedSession>(sessions: readonly T[], request: HistoryRequest, timeZone: string): HistoryPage<T> {
  const byDay = new Map<string, T[]>();
  for (const s of sessions) {
    if (request.search && !matchesSearch(s, request.search)) continue;
    const day = dayOf(s.end, timeZone);
    if (request.before && day >= request.before) continue;
    const list = byDay.get(day);
    if (list) list.push(s);
    else byDay.set(day, [s]);
  }
  const all = [...byDay.keys()].sort().reverse();
  const page = all.slice(0, request.days);
  return {
    days: page.map((day) => ({ day, sessions: byDay.get(day)!.sort(newestFirst) })),
    next: all.length > page.length ? page.at(-1)! : null,
  };
}

function isValidDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export type ParsedHistoryRequest = { ok: true; request: HistoryRequest } | { ok: false; error: string };

/** Reads `before`, `days` and `search` from the query; the error says which parameter (by the new name) and why. */
export function parseHistoryRequest(q: URLSearchParams): ParsedHistoryRequest {
  const before = q.get('before');
  if (before !== null && !isValidDay(before)) return { ok: false, error: 'before: um dia AAAA-MM-DD' };
  const days = q.get('days');
  let n = DEFAULT_DAYS;
  if (days !== null) {
    n = /^\d{1,2}$/.test(days) ? Number(days) : NaN;
    if (!(n >= 1 && n <= MAX_DAYS)) return { ok: false, error: `days: um inteiro de 1 a ${MAX_DAYS}` };
  }
  const search = q.get('search');
  if (search !== null && search.length > MAX_SEARCH_LENGTH) return { ok: false, error: `search: até ${MAX_SEARCH_LENGTH} caracteres` };
  return { ok: true, request: { before, days: n, search: search?.trim() || null } };
}
