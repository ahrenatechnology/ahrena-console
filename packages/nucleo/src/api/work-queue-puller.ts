/*
 * #477 the queue's puller: the core opens the Athena session of the first item of the execution queue
 * when there is room, the way "Executar plano" would (api/work-execution-open.ts is the use case both call).
 * The core opens Claude sessions here with no one in front of the screen, so nothing about the item is
 * taken from when it was queued: every pull checks again.
 *
 * It acts only when the queue is not stopped and the cards in Em execução (booting runs included) are under
 * the installation's limit. It takes position 1 and, in this order:
 * 1. the key and the stored target must still be plain (`owner/name#N`, desktop or terminal), else the item is dropped;
 * 2. `RepositoryTrust.isTrusted` must still hold: an owner that stopped being trusted drops the item, and no issue is read;
 * 3. an issue that already runs (a booting run, or a card in a fact column) is dropped, never launched twice;
 * 4. the issue is read again: closed, gone, an epic or an initiative, or without a plan, drops the item. GitHub
 *    down leaves the item and the queue as they are (nothing failed, the next pull tries again);
 * 5. the prompt is the execution prompt: the key and the Plan step numbers, never a title, body or comment.
 * A dropped item lets the next one be considered in the same pull.
 *
 * Failure: when the session does not open (no folder, no launcher, the launcher threw; a run that could not
 * be recorded twice is the exception: the session is open, so the item just leaves the line), the item returns to the top with the reason and the queue stops (`markFailed`); it resumes
 * when the person removes the item or retries (`POST /api/work/queue/retry`, `clearStop`). A run the queue
 * started that expires (no session showed up in time) does the same (`runExpired`): the item that left
 * the line at pull time comes back to the top, failed.
 *
 * One pull at a time per process: a trigger while one runs gets that same pull, and the opening itself is
 * guarded per issue in the use case, so two triggers (or a trigger and the route) never launch an issue twice.
 * Lowering the limit under the running count stops nothing: pulling resumes only under it.
 * The reasons stored are fixed pt-BR texts (the screen shows them); logs carry the issue key and a code, never
 * the prompt, a path or issue text.
 */

import { NoDataError } from '../github/cache.ts';
import type { RepositoryTrust } from '../github/trusted-owners.ts';
import { DEFAULT_EXECUTION_LIMIT, isExecutionRunActive, isOverExecutionLimit, type ExecutionRun, type RunningCards, type WorkExecutionRuns } from '../github/work-execution.ts';
import { WorkIssueNotFoundError, type WorkIssueResult, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo, type PlanTarget } from '../github/work-plan.ts';
import { isQueueColumn, type CardColumns, type QueueEntry, type WorkQueueStore } from '../github/work-queue.ts';
import { NEW_SESSION_TARGETS } from './new-session.ts';
import { openExecution, RunNotRecordedError, unrunnableReason } from './work-execution-open.ts';
import type { WorkSessionOpeners } from './work-session-open.ts';

export interface WorkQueuePullerDeps extends WorkSessionOpeners {
  queue: WorkQueueStore;
  /** The issue detail use case; `null` under --no-github: nothing is pulled. */
  issues: Pick<WorkIssueService, 'issue'> | null;
  runs: WorkExecutionRuns;
  /** Whose repositories the core opens sessions for; asked at every pull. */
  trust: RepositoryTrust;
  /** The cards in Em execução now, booting runs included: the board service. */
  running: RunningCards;
  /** The column of a card: a card in a fact column is not launched. */
  columns: CardColumns;
  /** The installation's limit, read at every pull; default `DEFAULT_EXECUTION_LIMIT`. */
  limit?: () => number;
  now?: () => number;
}

type Step = 'pulled' | 'dropped' | 'idle' | 'failed';

/** A pull never loops longer than this many items (each step takes one item out of the line or opens one). */
const MAX_STEPS = 200;

export const OPEN_FAILED_REASON = 'Não deu para abrir a sessão desta issue; confira o console antes de tentar de novo';
export const EXPIRED_REASON = 'A sessão de execução não apareceu a tempo: o Claude Desktop ou o terminal não respondeu';

/** A key from the database in a log line: quoted and cut, so a row that was not written through the route cannot forge a line. */
const safe = (key: string): string => JSON.stringify(key.slice(0, 80));

const KEY = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#([1-9]\d{0,9})$/;

export class WorkQueuePuller {
  private readonly o: WorkQueuePullerDeps;
  private inFlight: Promise<void> | null = null;

  constructor(o: WorkQueuePullerDeps) {
    this.o = o;
  }

  private log(message: string): void {
    (this.o.log ?? (() => {}))(`work queue: ${message}`);
  }

  private nowMs(): number {
    return (this.o.now ?? Date.now)();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** Pulls while there is room. Never throws. A trigger while a pull runs is that same pull. */
  trigger(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    let before: number | null = null;
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const { step, running } = await this.step(before);
        if (step === 'idle' || step === 'failed') return;
        before = step === 'pulled' ? running : before;
      }
    } catch (err) {
      this.log(`pull failed: ${err instanceof Error ? err.name : typeof err}`);
    }
  }

  /** `pulledFrom`: the running count before the last opening of this pull, if it opened one. */
  private async step(pulledFrom: number | null): Promise<{ step: Step; running: number }> {
    const { queue } = this.o;
    if ((await queue.stopped()) !== null) return { step: 'idle', running: 0 };
    let running: number;
    try {
      running = await this.o.running.runningCount();
    } catch (err) {
      if (err instanceof NoDataError) return { step: 'idle', running: 0 };
      throw err;
    }
    // reading the board can settle a run to expired, which stops the queue (`runExpired`): look again
    if ((await queue.stopped()) !== null) return { step: 'idle', running };
    if (isOverExecutionLimit(running, false, this.o.limit?.() ?? DEFAULT_EXECUTION_LIMIT)) return { step: 'idle', running };
    // the board must see the run just opened: a count that did not rise would let this step launch past the limit
    if (pulledFrom !== null && running <= pulledFrom) {
      this.log('the running count did not rise after an opening; pulling stops until the next trigger');
      return { step: 'idle', running };
    }
    const head = (await queue.list())[0];
    if (!head) return { step: 'idle', running };
    return { step: await this.pullHead(head), running };
  }

  private async drop(head: QueueEntry, code: string): Promise<Step> {
    this.log(`${safe(head.key)} left the line (${code})`);
    await this.o.queue.remove(head.key);
    return 'dropped';
  }

  private async fail(head: QueueEntry, reason: string, code: string): Promise<Step> {
    this.log(`${safe(head.key)} failed to open (${code}); the queue stops`);
    await this.o.queue.markFailed(head.key, reason, this.nowIso());
    return 'failed';
  }

  private async pullHead(head: QueueEntry): Promise<Step> {
    const m = KEY.exec(head.key);
    const repo = m?.[1];
    const number = m ? Number(m[2]) : NaN;
    if (!repo || !isPlanRepo(repo) || !isPlanNumber(number)) return this.drop(head, 'bad-key');
    if (!(NEW_SESSION_TARGETS as readonly string[]).includes(head.target)) return this.drop(head, 'bad-target');
    if (!this.o.trust.isTrusted(repo)) return this.drop(head, 'untrusted');
    if (!this.o.issues) return 'idle';

    const column = await this.o.columns.columnOf(head.key);
    if (column !== null && !isQueueColumn(column)) return this.drop(head, 'already-running');
    const previous = await this.o.runs.get(head.key);
    if (previous && isExecutionRunActive(previous, this.nowMs())) return this.drop(head, 'already-running');

    let issue: WorkIssueResult;
    try {
      issue = await this.o.issues.issue(head.key);
    } catch (err) {
      if (err instanceof WorkIssueNotFoundError) return this.drop(head, 'issue-gone');
      if (err instanceof NoDataError) return 'idle';
      throw err;
    }
    if (issue.state === 'CLOSED') return this.drop(head, 'closed');
    if (unrunnableReason(issue) !== null) return this.drop(head, 'no-plan');
    // the issue read waited on GitHub: the owner may have been untrusted meanwhile
    if (!this.o.trust.isTrusted(repo)) return this.drop(head, 'untrusted');

    try {
      const opened = await openExecution({ ...this.o }, { repo, number, target: head.target as PlanTarget, issue, origin: 'queue' });
      if (!opened.opened) {
        // another opener holds this issue: it is running, not failing
        if (opened.status === 409) return this.drop(head, 'already-running');
        const error = opened.body.error;
        return this.fail(head, typeof error === 'string' ? error : OPEN_FAILED_REASON, `status-${opened.status}`);
      }
    } catch (err) {
      // the session is open: failing the item would let a retry open a second one, so it leaves the line
      if (err instanceof RunNotRecordedError) return this.drop(head, 'opened-but-not-recorded');
      return this.fail(head, OPEN_FAILED_REASON, err instanceof Error ? err.name : typeof err);
    }
    try {
      await this.o.queue.remove(head.key);
    } catch {
      this.log(`${safe(head.key)} opened but could not leave the line; the next pull drops it`);
    }
    return 'pulled';
  }

  /**
   * A run the queue started expired: its item left the line when it was pulled, so it comes back to the top
   * with the reason, and the queue stops. A run the person started is not the queue's: nothing happens.
   */
  async runExpired(run: ExecutionRun): Promise<void> {
    if (run.origin !== 'queue') return;
    try {
      await this.o.queue.enqueue(run.key, run.target, this.nowIso());
      await this.o.queue.markFailed(run.key, EXPIRED_REASON, this.nowIso());
      this.log(`${run.key} came back to the top: its session did not show up`);
    } catch (err) {
      this.log(`${run.key} could not return to the line: ${err instanceof Error ? err.name : typeof err}`);
    }
  }
}
