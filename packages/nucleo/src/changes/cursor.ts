// The core's change cursor (item 2.4): a sequence that moves on every relevant change, kept in a
// short in-memory queue, and the wait on top of it (long polling).
//
// - `record()` costs O(open waits): it does not read the database and does not scan anything.
// - `wait()` answers as soon as there is news that passes the filters, or on timeout. No internal
//   polling: when idle, the core only has one timer per open wait, woken up by `record()`.
// - Each wait answers at least `minIntervalMs` after it starts (default 1 s). With hooks arriving
//   non-stop, a client long polling in a loop wakes up at most once per interval, and the burst
//   comes out in a single answer.
// - The cursor returned is the current one, even with filters: the changes that did not pass are
//   left behind and do not come back in a later request with other filters.
// - At most `maxWaiters` open (default 256); above that, `TooManyWaitersError`.
// - The cursor is opaque (`<generation>.<seq>`). The generation changes every time the core starts;
//   a cursor from another generation, or older than the queue, comes back at once with `reset: true`
//   (read everything again).
// - Injectable clock, so the tests are deterministic.

// `repos` (#104, #105): the list or the metrics of a repository changed; the key is `lista` or
// `<owner>/<repo>` in lower case. Only the HTTP route exposes it; MCP's `wait_for_changes` filters it out (mcp.ts).
// `agent-instructions` (#183): a repository's Instructions tab changed; the key is `<owner>/<repo>` in
// lower case. Like `repos`, only the HTTP route exposes it.
// `framework-install` (#184): a repository's framework install plan or its pull request changed; the key
// is `<owner>/<repo>` in lower case. Only the HTTP route exposes it.
// `alert` (#175, src/telemetry): a machine alert that enters or exits; the key is `<machine>:<alert>`,
// with no session and no account.
// The values are English since #173 phase 2b; the old ones (`sessao`, `estado`, `precisa-de-voce`, `plano`,
// `decisao`, `conta`) are still accepted in `?type=` and answered on the old route (src/api/legacy-routes.ts).
export const CHANGE_TYPES = ['session', 'state', 'needs-you', 'plan', 'decision', 'account', 'repos', 'alert', 'agent-instructions', 'framework-install'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface RecordedChange {
  seq: number;
  type: ChangeType;
  /** What changed: the id of the session, decision or account; for `repos`, `lista` or `<owner>/<repo>`. For `alert`: `<machine>:<alert>`; for `agent-instructions` and `framework-install`, `<owner>/<repo>`. */
  key: string;
  /** The session the change belongs to; `null` for account and repository changes (and for `alert`). */
  sessionId: string | null;
  /** The session's account; `null` is "Sem conta" (no account). */
  accountId: string | null;
}

export type NewChange = Omit<RecordedChange, 'seq'>;

export interface ChangeFilters {
  sessionIds?: readonly string[];
  /** `null` in the list asks for the "Sem conta" (no account) changes. */
  accountIds?: readonly (string | null)[];
  types?: readonly ChangeType[];
  /** Account filter by rule (the account label in MCP), on top of `accountIds`. */
  matchesAccount?: (accountId: string | null) => boolean;
}

export interface WaitOptions {
  filters?: ChangeFilters;
  /** Default `DEFAULT_WAIT_MS`, capped at `MAX_WAIT_MS`. 0 answers at once. */
  timeoutMs?: number;
  /** Aborting answers at once with whatever there is (the HTTP client gave up, the server closed). */
  signal?: AbortSignal;
}

export interface WaitResult {
  /** Cursor for the next request: the current one, which also skips the changes the filters left out. */
  cursor: string;
  /** What changed and passes the filters, once per (type, key), in the order of the last change. */
  changes: RecordedChange[];
  /** The cursor is no good (empty, from another generation or too old): read everything again and go on with `cursor`. */
  reset: boolean;
  /** Came back on timeout, with no news. */
  timedOut: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const DEFAULT_WAIT_MS = 25_000;
/** Below the ~130 s the app waits for a tool answer (validation V2) and the 120 s of HTTP. */
export const MAX_WAIT_MS = 110_000;
export const DEFAULT_CAPACITY = 1024;
/** How long the wait holds after the first news, so a burst comes out in a single answer. */
export const DEFAULT_BATCH_MS = 50;
/** Minimum interval between the start of a wait and the answer, so the long polling loop does not spin on every hook. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_MAX_WAITERS = 256;
/** Cap of changes per answer; above it the answer asks for `reset`. */
export const MAX_CHANGES_PER_ANSWER = 200;

export interface ChangeCursorOptions {
  capacity?: number;
  batchMs?: number;
  minIntervalMs?: number;
  maxWaiters?: number;
  clock?: Clock;
  /** Default: random. Fixed in the tests. */
  generation?: string;
}

/** Too many open waits: the API answers 503. */
export class TooManyWaitersError extends Error {
  constructor(max: number) {
    super(`esperas abertas demais (máximo ${max})`);
    this.name = 'TooManyWaitersError';
  }
}

interface Waiter {
  since: number;
  /** Time (on the clock) before which the wait does not answer. */
  answerAt: number;
  filters: ChangeFilters;
  timer: unknown;
  batching: boolean;
  answer(timedOut: boolean): void;
}

export class ChangeCursor {
  readonly generation: string;
  private readonly capacity: number;
  private readonly batchMs: number;
  private readonly minIntervalMs: number;
  private readonly maxWaiters: number;
  private readonly clock: Clock;
  /** Circular queue of the last `capacity` changes, in `seq` order. */
  private readonly queue: RecordedChange[] = [];
  private seq = 0;
  private readonly waiters = new Set<Waiter>();

  constructor(options: ChangeCursorOptions = {}) {
    this.generation = options.generation ?? Math.floor(Math.random() * 36 ** 6).toString(36);
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.batchMs = Math.max(0, options.batchMs ?? DEFAULT_BATCH_MS);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.maxWaiters = Math.max(1, options.maxWaiters ?? DEFAULT_MAX_WAITERS);
    this.clock = options.clock ?? systemClock;
  }

  /** The current cursor. */
  get current(): string {
    return `${this.generation}.${this.seq}`;
  }

  /** How many waits are open. */
  get openWaits(): number {
    return this.waiters.size;
  }

  record(change: NewChange): RecordedChange {
    const recorded = { ...change, seq: ++this.seq };
    this.queue.push(recorded);
    if (this.queue.length > this.capacity) this.queue.shift();
    for (const waiter of [...this.waiters]) {
      if (!waiter.batching && matches(recorded, waiter.filters)) this.schedule(waiter);
    }
    return recorded;
  }

  /** The wait has news: it answers after the batching and the minimum interval. */
  private schedule(waiter: Waiter): void {
    waiter.batching = true;
    this.clock.clearTimeout(waiter.timer);
    const ms = Math.max(this.batchMs, waiter.answerAt - this.clock.now());
    if (ms <= 0) waiter.answer(false);
    else waiter.timer = this.clock.setTimeout(() => waiter.answer(false), ms);
  }

  /** Rejects with `TooManyWaitersError` when `maxWaiters` are already open. */
  wait(cursor: string | null | undefined, options: WaitOptions = {}): Promise<WaitResult> {
    const filters = options.filters ?? {};
    const since = this.seqOf(cursor);
    if (since === null) return Promise.resolve({ cursor: this.current, changes: [], reset: true, timedOut: false });
    const already = this.read(since, filters);
    const timeoutMs = clampWait(options.timeoutMs);
    if (already.reset || timeoutMs === 0 || options.signal?.aborted) return Promise.resolve(already);
    if (this.waiters.size >= this.maxWaiters) return Promise.reject(new TooManyWaitersError(this.maxWaiters));

    return new Promise((resolve) => {
      const onAbort = () => waiter.answer(false);
      const waiter: Waiter = {
        since,
        answerAt: this.clock.now() + this.minIntervalMs,
        filters,
        timer: null,
        batching: false,
        answer: (timedOut) => {
          if (!this.waiters.delete(waiter)) return;
          this.clock.clearTimeout(waiter.timer);
          options.signal?.removeEventListener('abort', onAbort);
          const r = this.read(since, filters);
          resolve({ ...r, timedOut: timedOut && r.changes.length === 0 && !r.reset });
        },
      };
      this.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (already.changes.length > 0) this.schedule(waiter);
      else waiter.timer = this.clock.setTimeout(() => waiter.answer(true), timeoutMs);
    });
  }

  /** Answers every open wait with whatever there is (when the core shuts down). */
  close(): void {
    for (const waiter of [...this.waiters]) waiter.answer(false);
  }

  private seqOf(cursor: string | null | undefined): number | null {
    const m = /^([0-9a-z]+)\.(\d{1,15})$/.exec(cursor ?? '');
    if (!m || m[1] !== this.generation) return null;
    const seq = Number(m[2]);
    return seq <= this.seq ? seq : null;
  }

  private read(since: number, filters: ChangeFilters): WaitResult {
    const cursor = this.current;
    const first = this.queue[0]?.seq ?? this.seq + 1;
    // The queue already dropped changes this cursor has not seen.
    if (since < first - 1) return { cursor, changes: [], reset: true, timedOut: false };
    const byKey = new Map<string, RecordedChange>();
    for (let i = this.queue.length - 1; i >= 0 && this.queue[i].seq > since; i--) {
      const m = this.queue[i];
      if (!matches(m, filters)) continue;
      const k = `${m.type}\0${m.key}`;
      if (!byKey.has(k)) byKey.set(k, m);
    }
    if (byKey.size > MAX_CHANGES_PER_ANSWER) return { cursor, changes: [], reset: true, timedOut: false };
    const changes = [...byKey.values()].sort((a, b) => a.seq - b.seq);
    return { cursor, changes, reset: false, timedOut: false };
  }
}

export function clampWait(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(timeoutMs)));
}

function matches(m: RecordedChange, f: ChangeFilters): boolean {
  if (f.types && !f.types.includes(m.type)) return false;
  if (f.sessionIds && (m.sessionId === null || !f.sessionIds.includes(m.sessionId))) return false;
  if (f.accountIds && !f.accountIds.includes(m.accountId)) return false;
  if (f.matchesAccount && !f.matchesAccount(m.accountId)) return false;
  return true;
}

/** Item 2.4 shortcut: waits on the given cursor. */
export function awaitChanges(
  changes: ChangeCursor,
  cursor: string | null | undefined,
  options: WaitOptions = {},
): Promise<WaitResult> {
  return changes.wait(cursor, options);
}
