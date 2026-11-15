// `GET /api/history?before=<YYYY-MM-DD>&days=<N>&search=<text>` (#33, C15): the ended sessions
// by day, with each one's detail and the link across /clear. The rules are in
// src/history/model.ts and the reading in src/history/reading.ts; here only the request and the response.
//
// - `before` (optional): only the days strictly before; without it, from the most recent day with a session.
// - `days` (optional, default 7, maximum 31): how many days with an ended session per page.
// - `search` (optional, up to 100 characters): case-insensitive substring of the title, the id and the project.
// - Invalid parameter: 400 `{ error }`. With no history wired into the API: 404.
// Response 200: `{ days: [{ day, sessions: HistoryItem[] }], next }` (src/history/reading.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { SessionHistory } from '../history/reading.ts';
import { parseHistoryRequest } from '../history/model.ts';
import { noopObserver, type Observer } from '../observability/port.ts';

export const HISTORY_ROUTE = '/api/history';

export async function responderHistorico(res: ServerResponse, url: URL, historico: SessionHistory | null | undefined, observer: Observer = noopObserver): Promise<void> {
  if (!historico) return send(res, 404, { error: 'o núcleo subiu sem o histórico' });
  const parsed = parseHistoryRequest(url.searchParams);
  if (!parsed.ok) return send(res, 400, { error: parsed.error });
  send(res, 200, await observer.adapter({ name: 'history.read', system: 'sqlite' }, () => historico.page(parsed.request)));
}

/**
 * #661 the route observed end to end: a root span for the request, a child span for the adapter read and a log record
 * on the same trace. An unexpected failure answers the generic error and the correlation id, never the error's text.
 */
export function respondHistoryObserved(observer: Observer, req: IncomingMessage, res: ServerResponse, url: URL, historico: SessionHistory | null | undefined): Promise<void> {
  return observer.entry({ name: `GET ${HISTORY_ROUTE}`, method: req.method ?? 'GET', route: HISTORY_ROUTE }, async (scope) => {
    try {
      await responderHistorico(res, url, historico, observer);
    } catch (error) {
      scope.fail(error);
      if (!res.headersSent) send(res, 500, { error: 'erro interno', correlationId: scope.correlationId });
    }
    scope.respond(res.statusCode);
  });
}
