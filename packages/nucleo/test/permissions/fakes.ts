// Test doubles for the ports of the permission use cases (#618, layer 2): in memory, no disk, no real timer.
import { digestOf } from '../../src/permissions/digest.ts';
import type { PermissionRequest } from '../../src/permissions/model.ts';
import type { Clock, PermissionAudit, PermissionAuditRecord, PermissionChange, PermissionChangeNotifier, PermissionDeps, PermissionRequestRepository, Timer } from '../../src/permissions/ports.ts';

export const T0 = 1_700_000_000_000;

/** A clock that moves only when the test says so; a timer fires when `advance` passes it. */
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
  /** Moves time and fires the timers it passes, then lets the waiters run. */
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

/** Lets every promise already resolved run its continuation. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class InMemoryRepository implements PermissionRequestRepository {
  readonly requests = new Map<string, PermissionRequest>();
  private readonly links = new Map<string, string>();
  save(request: PermissionRequest): void {
    this.requests.set(request.id, request);
  }
  find(sessionId: string, requestId: string): PermissionRequest | null {
    const r = this.requests.get(requestId);
    return r !== undefined && r.sessionId === sessionId ? r : null;
  }
  listBySession(sessionId: string): PermissionRequest[] {
    return [...this.requests.values()].filter((r) => r.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }
  listOpen(): PermissionRequest[] {
    return [...this.requests.values()].filter((r) => r.isOpen).sort((a, b) => a.createdAt - b.createdAt);
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

export function harness(): Harness {
  let n = 0;
  return { repository: new InMemoryRepository(), audit: new RecordingAudit(), clock: new FakeClock(), notifier: new FakeNotifier(), newId: () => `rq-${++n}` };
}

export const PLAIN = { command: 'npm run migrate' };

/** The input a hook sends to register: the digest is the one the hook computes. */
export async function registerInput(over: { sessionId?: string; toolName?: string; toolInput?: unknown; cwd?: string } = {}) {
  const sessionId = over.sessionId ?? 'S1';
  const toolName = over.toolName ?? 'Bash';
  const toolInput = 'toolInput' in over ? over.toolInput : PLAIN;
  const cwd = over.cwd ?? '/w';
  return { sessionId, toolName, toolInput, cwd, permissionMode: 'default', digest: await digestOf({ sessionId, toolName, toolInput, cwd }) };
}
