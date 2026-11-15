// Test doubles for the ports of the permission use cases (#618, layer 2): in memory, no disk, no real timer.
import { digestOf } from '../../src/permissions/digest.ts';
import type { PermissionRequest } from '../../src/permissions/model.ts';
import type { RegisterInput } from '../../src/permissions/register-request.ts';
import type { Clock, PermissionAudit, PermissionAuditRecord, PermissionChange, PermissionChangeNotifier, PermissionDeps, PermissionRequestRepository, Timer } from '../../src/permissions/ports.ts';

export const T0 = 1_700_000_000_000;

/** A clock that moves only when the test says so; a timer fires when `advance` passes it. (#618) */
export class FakeClock implements Clock {
  private current = T0;
  private timers: { due: number; fire: () => void; live: boolean }[] = [];
  activeTimers = 0;
  now(): number {
    return this.current;
  }
  timer(ms: number): Timer {
    let fire!: () => void;
    const elapsed = new Promise<void>((resolve) => (fire = resolve));
    const entry = { due: this.current + ms, fire, live: true };
    this.timers.push(entry);
    this.activeTimers += 1;
    return {
      elapsed,
      cancel: () => {
        if (entry.live) this.activeTimers -= 1;
        entry.live = false;
      },
    };
  }
  /** Moves time and fires the timers it passes, then lets the waiters run. (#618) */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (const t of this.timers) {
      if (t.live && t.due <= this.current) {
        t.live = false;
        this.activeTimers -= 1;
        t.fire();
      }
    }
    await settle();
  }
}

/** Lets every promise already resolved run its continuation. (#618) */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A copy of an aggregate that shares nothing with it, as a row read back by the SQLite adapter is (#618, layer 2). */
const copyOf = (request: PermissionRequest): PermissionRequest => Object.assign(Object.create(Object.getPrototypeOf(request)) as PermissionRequest, request);

/** In memory. With `copies`, `save` stores a copy and every read returns a new one, so a use case that holds a request across an `await` saves a stale one over a newer one, as it would against the adapter (#618). */
export class InMemoryRepository implements PermissionRequestRepository {
  readonly requests = new Map<string, PermissionRequest>();
  private readonly links = new Map<string, string>();
  private readonly copies: boolean;
  constructor(options: { copies?: boolean } = {}) {
    this.copies = options.copies === true;
  }
  private out(request: PermissionRequest): PermissionRequest {
    return this.copies ? copyOf(request) : request;
  }
  save(request: PermissionRequest): void {
    this.requests.set(request.id, this.out(request));
  }
  find(sessionId: string, requestId: string): PermissionRequest | null {
    const r = this.requests.get(requestId);
    return r !== undefined && r.sessionId === sessionId ? this.out(r) : null;
  }
  listBySession(sessionId: string): PermissionRequest[] {
    return [...this.requests.values()].filter((r) => r.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt).map((r) => this.out(r));
  }
  listOpen(): PermissionRequest[] {
    return [...this.requests.values()].filter((r) => r.isOpen).sort((a, b) => a.createdAt - b.createdAt).map((r) => this.out(r));
  }
  clearReasonsSettledBefore(at: number): void {
    for (const r of this.requests.values()) {
      if (r.settledAt !== null && r.settledAt < at) Object.assign(r, { _reason: null });
    }
  }
  linkToolUse(requestId: string, toolUseId: string): void {
    this.links.set(requestId, toolUseId);
  }
  toolUseOf(requestId: string): string | null {
    return this.links.get(requestId) ?? null;
  }
}

export class RecordingAudit implements PermissionAudit {
  readonly records: PermissionAuditRecord[] = [];
  append(record: PermissionAuditRecord): void {
    this.records.push(structuredClone(record));
  }
}

export class FakeNotifier implements PermissionChangeNotifier {
  readonly published: PermissionChange[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  publish(change: PermissionChange): void {
    this.published.push({ ...change });
    for (const l of [...(this.listeners.get(change.requestId) ?? [])]) l();
  }
  subscribe(requestId: string, listener: () => void): () => void {
    const set = this.listeners.get(requestId) ?? new Set();
    set.add(listener);
    this.listeners.set(requestId, set);
    return () => set.delete(listener);
  }
  get listening(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

export interface Harness extends PermissionDeps {
  repository: InMemoryRepository;
  audit: RecordingAudit;
  clock: FakeClock;
  notifier: FakeNotifier;
}

export function harness(options: { copies?: boolean } = {}): Harness {
  let n = 0;
  return { repository: new InMemoryRepository(options), audit: new RecordingAudit(), clock: new FakeClock(), notifier: new FakeNotifier(), newId: () => `rq-${++n}` };
}

export const PLAIN = { command: 'npm run migrate' };

/** The input a hook sends to register: the digest is the one the hook computes. (#618) */
export async function registerInput(over: { sessionId?: string; toolName?: string; toolInput?: unknown; cwd?: string } = {}): Promise<RegisterInput> {
  const sessionId = over.sessionId ?? 'S1';
  const toolName = over.toolName ?? 'Bash';
  const toolInput = 'toolInput' in over ? over.toolInput : PLAIN;
  const cwd = over.cwd ?? '/w';
  return { sessionId, toolName, toolInput, cwd, permissionMode: 'default', digest: await digestOf({ sessionId, toolName, toolInput, cwd }) };
}
