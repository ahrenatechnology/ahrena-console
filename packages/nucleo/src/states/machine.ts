// The session state machine: reads session and agents through the port, applies the rules (rules.ts,
// watcher.ts) and saves. It is entered from three sides:
// - `onHook`, hooked on the hook receiver's `onEvent`;
// - `sync(id)`, for events that reached the port another way (history, real time);
// - `sweep()`, the watcher, every 15 s with `start()`.
// Clock and probe are injectable, so the tests are deterministic.

import type { IngestResult } from '../ingest/hooks/ingest.ts';
import type { Agent, Session, SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { readInbox, type InboxState } from './inbox.ts';
import { MEMORY_KEY, readMemory, transition, type SessionState } from './rules.ts';
import { systemProcessProbe, type ProcessProbe } from './probe.ts';
import { DEFAULT_LIMITS, checkWatcherRules, type WatcherLimits, type WatcherRule } from './watcher.ts';

/** How often the watcher sweeps. */
export const WATCHER_INTERVAL_MS = 15_000;

/** Options of the `SessionStateMachine`. */
export interface StateMachineOptions {
  storage: StoragePort;
  /** Clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** Defaults to `systemProcessProbe()`; `null` turns it off (cloud, remote sources). */
  probe?: ProcessProbe | null;
  limits?: Partial<WatcherLimits>;
  /** Called on every saved change (so real time can tell whoever is watching). */
  onChange?: (change: StateChange) => void;
  log?: (message: string) => void;
}

/** A state change the machine saved. */
export interface StateChange {
  sessionId: string;
  before: InboxState;
  after: InboxState;
  /** Type of the event that caused it (for a watcher rule, the type of its synthetic event). */
  cause: string;
  rule: WatcherRule | null;
}

/** Applies the rules to each session and saves the result, one task at a time. */
export class SessionStateMachine {
  private readonly storage: StoragePort;
  private readonly now: () => Date;
  private readonly probe: ProcessProbe | null;
  private readonly limits: WatcherLimits;
  private readonly onChange?: (change: StateChange) => void;
  private readonly log: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: StateMachineOptions) {
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
    this.probe = options.probe === undefined ? systemProcessProbe() : options.probe;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.onChange = options.onChange;
    this.log = options.log ?? ((m) => console.error(`[ahrena-console states] ${m}`));
  }

  /** For the hook receiver's `onEvent`. */
  readonly onHook = async (result: IngestResult): Promise<void> => {
    await this.apply(result.event);
  };

  /** Applies an event already saved in the port. */
  apply(event: SessionEvent): Promise<StateChange | null> {
    return this.serially(async () => {
      const state = await this.load(event.sessionId);
      if (!state) return null;
      return this.save(state, transition(state, event), event.type, null);
    });
  }

  /** Applies, in order, the session events the machine has not seen yet (those from history, for example). */
  sync(sessionId: string): Promise<StateChange | null> {
    return this.serially(() => this.syncNow(sessionId));
  }

  /** One watcher pass over every active or errored session. */
  sweep(): Promise<StateChange[]> {
    return this.serially(async () => {
      const liveDirs = this.probe ? await this.probe.liveDirs().catch(() => null) : null;
      const changes: StateChange[] = [];
      let cursor: string | null = null;
      do {
        const page = await this.storage.listSessions({ status: ['active', 'error'], limit: 200, cursor });
        for (const s of page.items) {
          try {
            const change = await this.watchSession(s, liveDirs);
            if (change) changes.push(change);
          } catch (err) {
            this.log(`watcher failed on session ${s.id}: ${(err as Error).message}`);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      return changes;
    });
  }

  /** Turns the watcher on. Returns the function that turns it off. */
  start(intervalMs = WATCHER_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      this.sweep().catch((err) => this.log(`watcher failed: ${(err as Error).message}`));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // --- internal ---

  private async watchSession(s: Session, liveDirs: ReadonlySet<string> | null): Promise<StateChange | null> {
    // Activity the machine did not see (imported history, a hook that failed in onEvent): apply it before judging.
    const memory = readMemory(s);
    let synced: StateChange | null = null;
    if (!memory.lastEvent || s.updatedAt > memory.lastEvent) synced = await this.syncNow(s.id);

    const state = await this.load(s.id);
    if (!state) return synced;
    const finding = checkWatcherRules(state, this.now(), liveDirs, this.limits);
    if (!finding) return synced;
    await this.storage.appendEvent(finding.event);
    return (await this.save(state, transition(state, finding.event), finding.event.type, finding.rule)) ?? synced;
  }

  private async syncNow(sessionId: string): Promise<StateChange | null> {
    const initial = await this.load(sessionId);
    if (!initial) return null;
    let state = initial;
    let last: string | null = null;
    let cursor: string | null = null;
    do {
      const page = await this.storage.listEvents(sessionId, { limit: 500, cursor });
      for (const e of page.items) {
        const next = transition(state, e);
        if (next !== state) last = e.type;
        state = next;
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!last) return null;
    return this.save(initial, state, last, null);
  }

  private async load(sessionId: string): Promise<SessionState | null> {
    const session = await this.storage.getSession(sessionId);
    if (!session) return null;
    return { session, agents: await this.storage.listAgents(sessionId) };
  }

  private async save(before: SessionState, after: SessionState, cause: string, rule: WatcherRule | null): Promise<StateChange | null> {
    if (before === after) return null;
    const previous = new Map(before.agents.map((a) => [a.id, a]));
    for (const a of after.agents) {
      if (!sameRecord(previous.get(a.id), a)) await this.storage.putAgent(a);
    }
    if (!sameRecord(before.session, after.session)) {
      // Re-read at save time: the receiver may have updated cwd, model or metadata meanwhile.
      const current = (await this.storage.getSession(after.session.id)) ?? before.session;
      await this.storage.putSession(merge(current, after.session));
    }
    const from = readInbox(before.session, before.agents).state;
    const to = readInbox(after.session, after.agents).state;
    const change: StateChange = { sessionId: after.session.id, before: from, after: to, cause, rule };
    if (from !== to) {
      try {
        this.onChange?.(change);
      } catch (err) {
        this.log(`onChange failed: ${(err as Error).message}`);
      }
    }
    return change;
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** The state fields come from the machine; the rest from the current record (which others also save). */
function merge(current: Session, fromMachine: Session): Session {
  return {
    ...current,
    status: fromMachine.status,
    endedAt: fromMachine.endedAt,
    awaitingInputSince: fromMachine.awaitingInputSince,
    awaitingReason: fromMachine.awaitingReason,
    updatedAt: current.updatedAt > fromMachine.updatedAt ? current.updatedAt : fromMachine.updatedAt,
    metadata: { ...current.metadata, [MEMORY_KEY]: fromMachine.metadata[MEMORY_KEY] },
  };
}

function sameRecord(a: Agent | Session | undefined, b: Agent | Session): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
