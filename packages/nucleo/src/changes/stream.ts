// The Server-Sent Events route on the local API, for the panel's live Feed and the Conversa tab:
//
//   GET /api/stream?session=<id>&account=<id>&type=<type>
//
// - Streams the change events over SSE, on the SAME change cursor as `/api/changes` (reuses `wait`/`record`,
//   not a second machine). The same filters, via `parseChangesRequest`.
// - The resume cursor is `Last-Event-ID` (the browser resends it on reconnect) or `?since=<cursor>`.
// - Each SSE message's `id:` is the new cursor, so a reconnect resumes exactly where it stopped, and the
//   client can fall back to the `/api/changes` long poll with that cursor without missing anything.
// - No 1 s floor (`minIntervalMs: 0`): the connection is held, so there is no long polling loop to throttle.
//   Burst batching (`batchMs`) stays, so a burst of hooks still comes out in a single `changes` event.
// - A bad, old or other-generation cursor emits a `reset` event (the client rereads everything) and goes on.
// - Too many open waits closes the stream with an `error` event (like the 503 on `/api/changes`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { TooManyWaitersError, type ChangeCursor } from './cursor.ts';
import { parseChangesRequest } from './http.ts';

export const STREAM_ROUTE = '/api/stream';

function firstHeader(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** One SSE message: the id (the cursor, for reconnect and fallback), the event name and a JSON data line. */
function writeEvent(res: ServerResponse, id: string, event: string, data: unknown): void {
  res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function serveStream(req: IncomingMessage, res: ServerResponse, url: URL, changes: ChangeCursor): Promise<void> {
  const request = parseChangesRequest(url);
  if (typeof request === 'string') return send(res, 400, { error: request });
  // On reconnect the browser resends the last delivered id; it wins over `?since=`.
  let cursor = firstHeader(req.headers['last-event-id']) ?? request.cursor;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n'); // a comment flushes the headers and opens the stream at once

  const gaveUp = new AbortController();
  const onClose = () => gaveUp.abort();
  res.once('close', onClose);
  try {
    while (!gaveUp.signal.aborted) {
      let result;
      try {
        result = await changes.wait(cursor, { filters: request.filters, minIntervalMs: 0, signal: gaveUp.signal });
      } catch (err) {
        if (!(err instanceof TooManyWaitersError)) throw err;
        writeEvent(res, cursor ?? '', 'error', { error: err.message });
        break;
      }
      if (gaveUp.signal.aborted) break;
      cursor = result.cursor;
      if (result.reset) writeEvent(res, cursor, 'reset', { cursor, reset: true });
      else if (result.changes.length > 0) writeEvent(res, cursor, 'changes', { cursor, changes: result.changes, reset: false });
      else res.write(': keep-alive\n\n'); // timed out with no news: a heartbeat keeps the connection open
    }
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
