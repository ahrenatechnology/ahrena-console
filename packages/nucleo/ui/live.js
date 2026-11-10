// "Ao vivo": the SSE stream `GET /api/stream` as the main path, with a fall back to the long polling of
// `GET /api/changes?since=<cursor>&wait=25` through the read layer. (issue 414, L6)
//
// - SSE first: `/api/stream`, resumed with `?since=<cursor>` on the first connection. Each event carries
//   the new cursor in its `id:`.
//   - `event: reset` (and the first connection with no cursor) calls `onRestart`: the screens re-read all.
//   - `event: changes` calls `onChange(changes)`.
//   - `event: error`, or the connection dropping or `/api/stream` not being there: this client closes the
//     stream (it does not lean on the browser's own `Last-Event-ID` reconnect) and hands over to the long
//     polling below, which resumes from that same cursor.
// - Long polling (the fall back, and the only path where SSE is not available): the first request goes
//   without a cursor and comes back at once with `reset: true`; news calls `onChange`; a timeout keeps
//   looping. It resumes from the last cursor the stream reached (`?since=<cursor>`), so nothing is lost in
//   the hand-off. A failure switches the state to `offline` and retries with a growing wait (or the
//   `Retry-After` of a 503); when it comes back, the state goes back to `live` and `onRestart` fires, even
//   if the cursor still works: what was on screen may have gone stale during the drop.

export const LIVE_STATES = ['connecting', 'live', 'offline'];

const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const parse = (e) => {
  try {
    return JSON.parse(e.data);
  } catch {
    return null;
  }
};

export function startLive({
  read,
  wait = 25,
  delays = [1000, 2000, 5000, 10000],
  onChange = () => {},
  onRestart = () => {},
  onState = () => {},
  sleep = realSleep,
  eventSource = typeof globalThis !== 'undefined' ? globalThis.EventSource : undefined,
}) {
  const stop = new AbortController();
  let state = 'connecting';
  let error = null;
  let nextAttempt = null;
  const change = (next, e = null, when = null) => {
    error = e;
    nextAttempt = when;
    if (next === state && !e) return;
    state = next;
    onState({ state, error, nextAttempt });
  };

  // The SSE phase: run the stream until it ends (an error, a drop, or `stop`), and return the last cursor
  // it reached so the long polling can resume from it without a gap. Resolves at once when SSE is off.
  function streamPhase(startCursor) {
    const ES = eventSource;
    if (!ES) return Promise.resolve(startCursor);
    return new Promise((resolve) => {
      let cursor = startCursor;
      let es = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try {
          es?.close();
        } catch {
          /* already closed */
        }
        resolve(cursor);
      };
      if (stop.signal.aborted) return done();
      stop.signal.addEventListener('abort', done, { once: true });
      try {
        es = new ES(`/api/stream${startCursor ? `?since=${encodeURIComponent(startCursor)}` : ''}`);
      } catch {
        return done();
      }
      es.onopen = () => change('live');
      es.addEventListener('changes', (e) => {
        change('live');
        const d = parse(e);
        cursor = d?.cursor ?? e.lastEventId ?? cursor;
        if (d?.changes?.length) onChange(d.changes);
      });
      es.addEventListener('reset', (e) => {
        change('live');
        const d = parse(e);
        cursor = d?.cursor ?? e.lastEventId ?? cursor;
        onRestart(d ?? { cursor, reset: true });
      });
      // Both the server's `event: error` (too many waits, the 503-equivalent) and a dropped or missing
      // stream arrive here: close it and hand over to the long polling, from the last cursor.
      es.addEventListener('error', done);
    });
  }

  // The long-polling phase: the loop the console has always had, resuming from the given cursor.
  async function pollPhase(startCursor) {
    let cursor = startCursor;
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const r = await read(`/api/changes?since=${encodeURIComponent(cursor)}&wait=${wait}`, { signal: stop.signal });
        const recovered = failures > 0;
        failures = 0;
        change('live');
        cursor = r.cursor;
        if (r.reset || recovered) onRestart(r);
        else if (r.changes?.length) onChange(r.changes);
      } catch (e) {
        if (stop.signal.aborted) break;
        failures++;
        const ms = e?.retryIn ?? delays[Math.min(failures, delays.length) - 1];
        change('offline', e, Date.now() + ms);
        await sleep(ms, stop.signal);
      }
    }
  }

  async function run() {
    // SSE leads; when it is off or drops, the long polling takes over from the cursor it reached.
    const cursor = await streamPhase('');
    if (!stop.signal.aborted) await pollPhase(cursor);
  }

  const done = run();
  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get nextAttempt() {
      return nextAttempt;
    },
    /** Stops the loop; the promise resolves when the open request ends. */
    stop() {
      stop.abort();
      return done;
    },
  };
}
