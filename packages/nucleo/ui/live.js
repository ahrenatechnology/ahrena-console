// "Ao vivo": long polling on `GET /api/changes?since=<cursor>&wait=25`, through the read layer.
//
// - The first request goes without a cursor and comes back at once with `reiniciar: true`.
// - `reiniciar: true` (core restarted, stale cursor) calls `onRestart`: the screens re-read everything.
// - News calls `onChange(changes)`; a timeout without news just keeps looping.
// - A failure switches the state to `offline` and tries again, with a growing wait (or the
//   `Retry-After` of a 503). When it comes back, the state goes back to `live` and calls `onRestart`,
//   even if the cursor still works: what was on screen may have gone stale during the drop.

export const LIVE_STATES = ['connecting', 'live', 'offline'];

const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export function startLive({
  read,
  wait = 25,
  delays = [1000, 2000, 5000, 10000],
  onChange = () => {},
  onRestart = () => {},
  onState = () => {},
  sleep = realSleep,
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

  async function loop() {
    let cursor = '';
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const r = await read(`/api/changes?since=${encodeURIComponent(cursor)}&wait=${wait}`, { signal: stop.signal });
        const recovered = failures > 0;
        failures = 0;
        change('live');
        cursor = r.cursor;
        if (r.reiniciar || recovered) onRestart(r);
        else if (r.mudancas?.length) onChange(r.mudancas);
      } catch (e) {
        if (stop.signal.aborted) break;
        failures++;
        const ms = e?.retryIn ?? delays[Math.min(failures, delays.length) - 1];
        change('offline', e, Date.now() + ms);
        await sleep(ms, stop.signal);
      }
    }
  }

  const done = loop();
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
