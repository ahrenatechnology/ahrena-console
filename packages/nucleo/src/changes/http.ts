// The long polling route on the local API, for the tray app and the panel:
//
//   GET /api/changes?since=<cursor>&wait=<s>&session=<id>&account=<id>&type=<type>
//
// - An empty `since` comes back at once with the current cursor and `reset: true`.
// - The answer: `{ cursor, changes: [{ type, key, sessionId, accountId, seq }], reset, timedOut }`
//   (English since #173 phase 2b).
// - `wait` in seconds (default 25, max 110; 0 does not wait).
// - `session`, `account` and `type` take commas or repetition; `account=no-account` asks for "Sem conta"
//   (no account).
// - A client that closes the connection releases the wait at once.
// - Too many open waits: 503 with `Retry-After`.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { TooManyWaitersError, DEFAULT_WAIT_MS, CHANGE_TYPES, type ChangeCursor, type ChangeFilters, type ChangeType } from './cursor.ts';

export const CHANGES_ROUTE = '/api/changes';
/** `?account=` for the sessions without an account. */
export const NO_ACCOUNT = 'no-account';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function listParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

/** Reads the parameters; returns the error message when one is invalid. */
export function parseChangesRequest(url: URL): { cursor: string | null; timeoutMs: number; filters: ChangeFilters } | string {
  const filters: ChangeFilters = {};
  const sessions = listParam(url, 'session');
  if (sessions) {
    if (!sessions.every((s) => ID.test(s))) return 'session inválida';
    filters.sessionIds = sessions;
  }
  const accounts = listParam(url, 'account');
  if (accounts) {
    if (!accounts.every((c) => ID.test(c))) return 'account inválida';
    filters.accountIds = accounts.map((c) => (c === NO_ACCOUNT ? null : c));
  }
  const types = listParam(url, 'type');
  if (types) {
    if (!types.every((t): t is ChangeType => (CHANGE_TYPES as readonly string[]).includes(t))) {
      return `type: um de ${CHANGE_TYPES.join(', ')}`;
    }
    filters.types = types as ChangeType[];
  }
  const wait = url.searchParams.get('wait');
  const seconds = wait === null || wait === '' ? DEFAULT_WAIT_MS / 1000 : Number(wait);
  if (!Number.isFinite(seconds) || seconds < 0) return 'wait inválida';
  return { cursor: url.searchParams.get('since'), timeoutMs: seconds * 1000, filters };
}

export async function serveChanges(
  res: ServerResponse,
  url: URL,
  changes: ChangeCursor,
): Promise<void> {
  const request = parseChangesRequest(url);
  if (typeof request === 'string') return send(res, 400, { error: request });
  const gaveUp = new AbortController();
  const onClose = () => gaveUp.abort();
  res.once('close', onClose);
  try {
    const result = await changes.wait(request.cursor, { ...request, signal: gaveUp.signal });
    if (!res.destroyed && !res.writableEnded) send(res, 200, result);
  } catch (err) {
    if (!(err instanceof TooManyWaitersError)) throw err;
    res.setHeader('retry-after', '5');
    send(res, 503, { error: err.message });
  } finally {
    res.off('close', onClose);
  }
}
