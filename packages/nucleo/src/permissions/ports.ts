// What the permission use cases need from the outside, as interfaces the OLTP layer implements (#618, layer 2).
// Everything here is synchronous except the clock's timer: a use case loads, calls one aggregate and saves with no
// `await` in between, so one delivery or one answer is atomic in the single-threaded core; the adapter's `save` is one
// transaction. Pure types: no import of a mechanism. (#618)
import type { Channel, Decision, PermissionRequest, RequestState, Settler } from './model.ts';

/** Where requests live. The tool input is never stored: the aggregate does not hold it. */
export interface PermissionRequestRepository {
  /** Inserts the request, or updates the one with the same id. */
  save(request: PermissionRequest): void;
  /** The request with this id *of this session*; another session's id is `null`, as an unknown one is (#618/AC-1). */
  find(sessionId: string, requestId: string): PermissionRequest | null;
  /** Every request of the session, oldest first. */
  listBySession(sessionId: string): PermissionRequest[];
  /** Every request that is still pending or answered, of every session, oldest first. */
  listOpen(): PermissionRequest[];
  /** Remembers the `tool_use_id` a PreToolUse of the same call carried (decision 0025, "Respondido em outro lugar"). */
  linkToolUse(requestId: string, toolUseId: string): void;
  /** The `tool_use_id` linked to the request, or `null`. */
  toolUseOf(requestId: string): string | null;
}

export type AuditEvent = 'registered' | 'answered' | 'delivered' | 'closed' | 'refused';

/**
 * One line of `permission-audit.jsonl`. By its shape it cannot carry the tool input or the summary, and a reason travels
 * only as its SHA-256 (#618/AC-7).
 */
export interface PermissionAuditRecord {
  at: number;
  event: AuditEvent;
  requestId: string;
  sessionId: string;
  toolName?: string;
  digest?: string;
  terminalOnly?: boolean;
  state?: RequestState;
  decision?: Decision;
  answeredBy?: string;
  channel?: Channel;
  /** SHA-256 hex of the reason, `null` when there was none. */
  reasonSha256?: string | null;
  settledBy?: Settler;
  /** For a refusal: the operation that was refused and the code it was refused with. */
  operation?: string;
  code?: string;
}

export interface PermissionAudit {
  append(record: PermissionAuditRecord): void;
}

/** A timer the use case can cancel, so a long poll never leaves one running. */
export interface Timer {
  elapsed: Promise<void>;
  cancel(): void;
}

/** Time in milliseconds, and the timer a long poll waits on: tests drive both without waiting. */
export interface Clock {
  now(): number;
  timer(ms: number): Timer;
}

/** What changed, for the `/ui` change feed and for the long poll waiting on it. */
export interface PermissionChange {
  sessionId: string;
  requestId: string;
  state: RequestState;
}

export interface PermissionChangeNotifier {
  publish(change: PermissionChange): void;
  /** Calls `listener` on the next change of this request; returns what stops listening. */
  subscribe(requestId: string, listener: () => void): () => void;
}

/** What a use case needs, handed in at construction. `newId` gives a random, never reused request id. */
export interface PermissionDeps {
  repository: PermissionRequestRepository;
  audit: PermissionAudit;
  clock: Clock;
  notifier: PermissionChangeNotifier;
  newId: () => string;
}
