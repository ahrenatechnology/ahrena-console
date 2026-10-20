// `GET /api/history?before=<YYYY-MM-DD>&days=<N>&search=<text>` (#33, C15): the ended sessions
// by day, with each one's detail and the link across /clear. The rules are in
// src/history/model.ts and the reading in src/history/reading.ts; here only the request and the response.
//
// - `before` (optional): only the days strictly before; without it, from the most recent day with a session.
// - `days` (optional, default 7, maximum 31): how many days with an ended session per page.
// - `search` (optional, up to 100 characters): case-insensitive substring of the title, the id and the project.
// - Invalid parameter: 400 `{ error }`. With no history wired into the API: 404.
// Response 200: `{ days: [{ day, sessions: HistoryItem[] }], next }` (src/history/reading.ts).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { SessionHistory } from '../history/reading.ts';
import { parseHistoryRequest } from '../history/model.ts';

export const HISTORY_ROUTE = '/api/history';

export async function responderHistorico(res: ServerResponse, url: URL, historico: SessionHistory | null | undefined): Promise<void> {
  if (!historico) return send(res, 404, { error: 'o núcleo subiu sem o histórico' });
  const parsed = parseHistoryRequest(url.searchParams);
  if (!parsed.ok) return send(res, 400, { error: parsed.error });
  send(res, 200, await historico.page(parsed.request));
}
