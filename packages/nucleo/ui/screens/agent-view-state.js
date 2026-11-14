// The state of the agent view, with no DOM (issue 539, layer 3 of issue 521): which route the read takes, what a
// failed read means, and the read state machine (loading, then ready, error or missing). `agent-view.js` draws
// from it; the test imports it directly. The data is the shape of docs/contracts/agent-view.md.

/** `GET /api/sessions/:id/agents/:agentId`: the agent id has a ":" in it, so it travels encoded. (issue 539) */
export const agentReadRoute = (sessionId, agentId) => `/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}`;

/** A 404 is an agent (or a session) the core does not know; every other failure is one to try again. (issue 539) */
export const failureKind = (e) => (e?.status === 404 ? 'missing' : 'error');

/** The agent still works or waits for something, so its view follows it. (issue 539) */
export const isRunning = (data) => data?.state === 'working' || data?.state === 'waiting';

/**
 * The read of one agent as a state machine. `snapshot()` is `{ phase, data, message }`, the phase being
 * `loading`, `ready`, `error` or `missing`. `load()` goes through `loading` (the first read, and the retry
 * after an error); `refresh()` reads again with no `loading` in between and keeps the data when it fails, so
 * a view that is up is never thrown away by a read that did not come back. Reads that overlap collapse: one
 * in flight, and one more for everything that asked meanwhile. An older answer never replaces a newer one.
 * An `AbortError` (the person left the screen) changes nothing. (issue 539)
 */
export function createAgentReader({ read }) {
  let current = { phase: 'loading', data: null, message: null };
  let turn = 0;
  let flying = null;
  let again = false;
  const listeners = new Set();
  const set = (next) => {
    current = next;
    for (const f of listeners) f(current);
  };

  async function run(quiet) {
    const mine = ++turn;
    if (!quiet) set({ phase: 'loading', data: null, message: null });
    try {
      const data = await read();
      if (mine === turn) set({ phase: 'ready', data, message: null });
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== turn) return;
      if (failureKind(e) === 'missing') set({ phase: 'missing', data: null, message: null });
      else if (!quiet || current.phase !== 'ready') set({ phase: 'error', data: null, message: e?.message ?? String(e) });
    }
  }

  return {
    snapshot: () => current,
    subscribe(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    load: () => run(false),
    async refresh() {
      if (flying) {
        again = true;
        return flying;
      }
      flying = (async () => {
        do {
          again = false;
          await run(true);
        } while (again);
      })().finally(() => (flying = null));
      return flying;
    },
  };
}
