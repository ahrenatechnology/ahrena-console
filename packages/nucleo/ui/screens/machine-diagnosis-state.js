// The state of the diagnosis next to a saturation alert (issue 566, wireframe 566-1 to 566-9) without the DOM: which
// alert opens by itself, which panels are open, what each one holds, and the reads behind them. The screen
// (`machine.js`) asks `view(alertId)` for what to draw and repaints when `onChange` says something moved; the components
// (`machine-diagnosis.js`) draw one state from it. Reads go through `read(alert, { signal })`, a function the screen
// gives (`machine-diagnosis-read.js` binds it to `GET /api/diagnosis`); it ends in an outcome
// `{ state: 'ready', diagnosis } | { state: 'failed', failure } | { state: 'closed' } | { state: 'unsupported' }`, or
// throws, which is a failure carrying the error's `status`.
//
// The rules (wireframe 566-4, Q3, Q5, Q11):
//  - the first time saturation alerts are on screen, the most severe opens by itself (an error before a warning, then
//    the oldest); the others stay closed and read nothing until someone opens them;
//  - open and closed survive the 30 s re-reads: `sync` only adds the alerts it did not know and drops those that went;
//  - one read per open, no automatic refresh; "Tentar de novo" and "Ler de novo" each read once more;
//  - a read that passes `READ_CEILING_MS` is aborted and becomes a failure with no status;
//  - closing, an alert that goes, and leaving the screen abort the read in flight, and a late answer is dropped.

import { READ_CEILING_MS, isSaturationKind, mountOf } from './machine-diagnosis-format.js';

/** `GET /api/diagnosis` for one alert of one machine, both URL-encoded. */
export const diagnosisRoute = (machineId, alertId) => `/api/diagnosis?machine=${encodeURIComponent(machineId)}&alert=${encodeURIComponent(alertId)}`;

/** The alerts that have a diagnosis, in the order they came. */
export const saturationAlerts = (alerts) => (Array.isArray(alerts) ? alerts.filter((a) => isSaturationKind(a?.kind)) : []);

const sinceMs = (a) => {
  const t = Date.parse(a?.since ?? '');
  return Number.isFinite(t) ? t : Infinity;
};

/** The alert that opens by itself: an error before a warning, then the oldest (no date counts as the newest); `null` for none. */
export function mostSevere(alerts) {
  const rank = (a) => (a?.level === 'error' ? 0 : 1);
  const list = Array.isArray(alerts) ? [...alerts] : [];
  return list.sort((a, b) => rank(a) - rank(b) || sinceMs(a) - sinceMs(b))[0] ?? null;
}

const isMac = (os) => /mac|darwin/i.test(String(os ?? ''));

/**
 * What the probable cause compares the diagnosis against, from the reading the screen already has: `memoryUsedBytes`,
 * `load`, the `volume` the alert is about, and, on this machine, how the sentence names it ("o Mac" or "esta máquina").
 * A remote is named by the panel from its label. A field that is not there is left out.
 */
export function readingContext(reading, alert, { local = true } = {}) {
  const out = {};
  if (!reading) return out;
  if (Number.isFinite(reading.memory?.usedBytes)) out.memoryUsedBytes = reading.memory.usedBytes;
  if (Number.isFinite(reading.cpu?.load?.one)) out.load = reading.cpu.load.one;
  if (alert?.kind === 'volume-full') {
    const mount = mountOf(alert.id);
    const v = reading.volumes?.find((x) => x.mount === mount);
    if (v) out.volume = { mount: v.mount, usedBytes: v.usedBytes, totalBytes: v.totalBytes };
  }
  if (local) out.machine = isMac(reading.host?.os) ? 'o Mac' : 'esta máquina';
  return out;
}

const asOutcome = (o) => (o && typeof o === 'object' && typeof o.state === 'string' ? o : { state: 'failed', failure: { status: null } });
const statusOf = (e) => (Number.isInteger(e?.status) && e.status > 0 ? e.status : null);

/**
 * `read(alert, { signal })`, `onChange()` for the screen to repaint, `signal` of the screen (leaving aborts everything).
 * `ceilingMs` is for the test only.
 */
export function createDiagnosisState({ read, onChange = () => {}, signal = null, ceilingMs = READ_CEILING_MS }) {
  const entries = new Map();
  let stopped = false;

  const clear = (e) => {
    clearTimeout(e.timer);
    e.timer = null;
    e.controller?.abort();
    e.controller = null;
    e.token += 1;
  };

  function settle(e, token, outcome) {
    if (stopped || !e.open || e.token !== token) return;
    clearTimeout(e.timer);
    e.timer = null;
    e.controller = null;
    e.token += 1; // one answer per read: whatever comes after (the abort, a late body) is dropped
    e.state = outcome.state;
    e.diagnosis = outcome.state === 'ready' ? (outcome.diagnosis ?? null) : null;
    e.failure = outcome.state === 'failed' ? (outcome.failure ?? { status: null }) : null;
    onChange();
  }

  function startRead(e) {
    clear(e);
    const token = e.token;
    const controller = new AbortController();
    e.controller = controller;
    e.state = 'loading';
    e.diagnosis = null;
    e.failure = null;
    e.timer = setTimeout(() => {
      if (e.token !== token) return;
      controller.abort();
      settle(e, token, { state: 'failed', failure: { status: null } });
    }, ceilingMs);
    (async () => read(e.alert, { signal: controller.signal }))().then(
      (outcome) => settle(e, token, asOutcome(outcome)),
      (error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        settle(e, token, { state: 'failed', failure: { status: statusOf(error) } });
      },
    );
  }

  function open(e) {
    e.open = true;
    startRead(e);
  }

  function close(e) {
    clear(e);
    e.open = false;
    e.state = 'idle';
    e.diagnosis = null;
    e.failure = null;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const e of entries.values()) clear(e);
  }
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stopped = true;

  function retry(alertId) {
    const e = entries.get(alertId);
    if (stopped || !e?.open || e.state === 'loading') return;
    startRead(e);
    onChange();
  }

  return {
    /** The alerts on screen now: new ones are added closed, the first of them opening if nothing was on screen; gone ones go. No repaint: the screen is painting. */
    sync(alerts) {
      if (stopped) return;
      const now = saturationAlerts(alerts);
      const ids = new Set(now.map((a) => a.id));
      for (const [id, e] of entries) {
        if (ids.has(id)) continue;
        close(e);
        entries.delete(id);
      }
      const fresh = [];
      for (const a of now) {
        const known = entries.get(a.id);
        if (known) known.alert = a;
        else fresh.push(a);
      }
      const first = entries.size === 0;
      for (const a of fresh) entries.set(a.id, { alert: a, open: false, state: 'idle', diagnosis: null, failure: null, expanded: new Set(), controller: null, timer: null, token: 0 });
      const chosen = first ? mostSevere(fresh) : null;
      if (chosen) open(entries.get(chosen.id));
    },

    /** What to draw for one alert: `{ open, state, diagnosis, failure, expanded }`; `null` for an alert with no panel. */
    view(alertId) {
      const e = entries.get(alertId);
      return e ? { open: e.open, state: e.state, diagnosis: e.diagnosis, failure: e.failure, expanded: e.expanded } : null;
    },

    /** "Ver diagnóstico" and "Diagnóstico": opens (one read) or closes (aborts, forgets). */
    toggle(alertId) {
      const e = entries.get(alertId);
      if (stopped || !e) return;
      if (e.open) close(e);
      else open(e);
      onChange();
    },

    /** "Tentar de novo" on a failure: one read more; nothing while one is in flight. */
    retry,

    /** "Ler de novo" on a diagnosis: the same, one read more. */
    reread(alertId) {
      retry(alertId);
    },

    /** "Mostrar os 10" / "Mostrar menos" of one section of one alert. */
    more(alertId, sectionId) {
      const e = entries.get(alertId);
      if (stopped || !e) return;
      if (e.expanded.has(sectionId)) e.expanded.delete(sectionId);
      else e.expanded.add(sectionId);
      onChange();
    },

    stop,
  };
}
