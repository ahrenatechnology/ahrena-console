/*
 * #477 the execution queue of the work board: the items the person planned and put in line, in priority
 * order. One queue per installation (the screen filters it). Pure domain: the entry, the write port, the
 * order arithmetic and which columns accept a card; the SQLite store is work-queue-store.ts, the routes
 * are api/work-queue.ts. The read side the board needs (`WorkQueue`) is in work-board.ts.
 *
 * - Only an item with a plan, in Planejamento or Na fila, enters the queue. Em execução, Em review,
 *   Bloqueado and Concluído are facts of the session and of GitHub: they never receive a card.
 * - The position is 1-based and contiguous; the order of the queue is the order of the column.
 * - Putting an item that is already queued again keeps its place and takes the new target (the last
 *   choice, wireframe 477-1).
 * - A failure to pull (`markFailed`, used by the puller of #477 L2) returns the entry to the top with the
 *   reason; the queue is then stopped until that entry is removed or the person retries (`clearStop`).
 * - Keys are issue keys (`owner/name#N`), stored and compared in lower case.
 */

import type { WorkBoardColumn, WorkQueue } from './work-board.ts';
import type { ExecutionTarget } from './work-execution.ts';

export interface QueueEntry {
  /** The issue key, lower case. */
  key: string;
  /** 1-based, contiguous. */
  position: number;
  /** Where the session opens when the entry is pulled: the last choice of the person. */
  target: ExecutionTarget;
  enqueuedAt: string;
  /** Why pulling this entry failed; `null` while it has not. */
  failedReason: string | null;
  failedAt: string | null;
}

/** What reads and writes the queue: the board's read side plus the changes the routes and the puller make. */
export interface WorkQueueStore extends WorkQueue {
  /** The entries in queue order. */
  list(): Promise<QueueEntry[]>;
  /** Appends the key, or, when it is queued, only replaces its target (the place is kept, a recorded failure stays). */
  enqueue(key: string, target: ExecutionTarget, at: string): Promise<QueueEntry>;
  /** Takes the key out and closes the gap; `false` when it was not queued. */
  remove(key: string): Promise<boolean>;
  /** Moves `key` right after `after`, or to the top when `after` is `null`; `false` when either is not queued. */
  reorder(key: string, after: string | null): Promise<boolean>;
  /** Returns the entry to the top with the reason; `false` when it is not queued. */
  markFailed(key: string, reason: string, at: string): Promise<boolean>;
  /** Clears the recorded failure, which ends the queue's stop (the retry of #477 L2); `false` when no entry had one. */
  clearStop(): Promise<boolean>;
}

/** The queue is stopped by the first entry that carries a failure: its key and reason. */
export interface QueueStop {
  key: string;
  reason: string;
}

/** The column of a card, as the routes need it to decide whether the card may enter the queue. */
export interface CardColumns {
  /** `null` when the card is not on the board. */
  columnOf(key: string): Promise<WorkBoardColumn | null>;
}

/** The columns a card can be queued from or sit in; the others are facts. */
export const QUEUE_COLUMNS: readonly WorkBoardColumn[] = ['planning', 'queued'];

export const isQueueColumn = (column: WorkBoardColumn): boolean => QUEUE_COLUMNS.includes(column);

/**
 * `keys` with `key` moved right after `after` (to the top when `after` is `null`); `null` when `key` or
 * `after` is not in `keys`, or when they are the same key.
 */
export function moveAfter(keys: readonly string[], key: string, after: string | null): string[] | null {
  if (!keys.includes(key) || key === after || (after !== null && !keys.includes(after))) return null;
  const rest = keys.filter((k) => k !== key);
  const at = after === null ? 0 : rest.indexOf(after) + 1;
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** The stop the entries carry: the first with a failure, in queue order; `null` when none has. */
export function stopOf(entries: readonly QueueEntry[]): QueueStop | null {
  const failed = entries.find((e) => e.failedReason !== null);
  return failed ? { key: failed.key, reason: failed.failedReason! } : null;
}

/** Whether the queue can also be written: the board only drops entries from a queue that can. */
export const isWritableQueue = (queue: WorkQueue): queue is WorkQueueStore => typeof (queue as Partial<WorkQueueStore>).remove === 'function';
