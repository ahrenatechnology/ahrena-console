/*
 * #506 the issue detail use case: one read of the issue (`WorkIssueSource`, one GraphQL query) behind
 * the ADR-0001 cache, and the issue's Status in the chosen Project. Inside the TTL it never calls GitHub;
 * GitHub down after a read serves the last value (`stale`, a stable code, #495); with nothing stored the
 * `NoDataError` goes up, and the route turns it into a reason. The Project is read through its own cache
 * or snapshot and never fails the detail: without it the Status is `null`.
 */

import { GITHUB_TTL, NoDataError, RateLimitedError, type GithubCache } from './cache.ts';
import type { WorkProjectBoard } from './work-board.ts';
import { buildWorkIssue, type WorkIssueCurrent, type WorkIssueEdit, type WorkIssueRead, type WorkIssueSource, type WorkIssueView, type WorkIssueWriter, WorkIssueWrittenUnreadError } from './work-issue.ts';

export interface WorkIssueServiceOptions {
  source: WorkIssueSource;
  /** #533 where the writes go; without it (`--demo`) a write throws `WorkIssueWriteOffError`. */
  writer?: WorkIssueWriter;
  cache: GithubCache;
  /** #506 the chosen Project, for the Project Status; without it the Status is `null`. */
  project?: WorkProjectBoard;
  /** #506 the raw text of a stale read or a failed Project read goes here; the answer only carries a code. */
  log?: (message: string) => void;
}

export interface WorkIssueReadOptions {
  /** #506 the refresh button: re-reads GitHub (the cache keeps its 30 s floor). */
  force?: boolean;
}

/** The detail with the cache's freshness: what the route answers. */
export interface WorkIssueResult extends WorkIssueView {
  fetchedAt: number;
  stale: boolean;
  /** The stable code of why the read is stale (#495); `null` when fresh. */
  staleReason: string | null;
}

/** GitHub answered, and has no such issue. */
export class WorkIssueNotFoundError extends Error {
  constructor(key: string) {
    super(`issue not found: ${key}`);
    this.name = 'WorkIssueNotFoundError';
  }
}

/** #533 a title or body save is older than GitHub's: nothing was written; `current` is what GitHub holds now. */
export class WorkIssueConflictError extends Error {
  readonly current: WorkIssueCurrent;
  constructor(key: string, current: WorkIssueCurrent) {
    super(`issue changed on GitHub since it was opened: ${key}`);
    this.name = 'WorkIssueConflictError';
    this.current = current;
  }
}

/** #533 the service has no writer (`--demo`). */
export class WorkIssueWriteOffError extends Error {
  constructor() {
    super('issue writes are off');
    this.name = 'WorkIssueWriteOffError';
  }
}

/** The same issue in any letter case is the same cache entry. */
export const workIssueCacheKey = (key: string): string => `github:work-issue:${key.toLowerCase()}`;

/** #533 the raw text for the log: for a written-but-unread write, the read-back's own. */
const rawTextOf = (err: unknown): string => {
  const raw = err instanceof WorkIssueWrittenUnreadError ? err.cause : err;
  return `${err instanceof WorkIssueWrittenUnreadError ? 'written, read-back failed: ' : ''}${raw instanceof Error ? raw.message : String(raw)}`;
};

export class WorkIssueService {
  private readonly source: WorkIssueSource;
  private readonly writer: WorkIssueWriter | undefined;
  private readonly cache: GithubCache;
  private readonly project: WorkProjectBoard | undefined;
  private readonly log: (message: string) => void;

  constructor({ source, writer, cache, project, log = () => {} }: WorkIssueServiceOptions) {
    this.source = source;
    this.writer = writer;
    this.cache = cache;
    this.project = project;
    this.log = log;
  }

  async issue(key: string, { force = false }: WorkIssueReadOptions = {}): Promise<WorkIssueResult> {
    const cacheKey = workIssueCacheKey(key);
    // #506 a missing issue is the fetcher's `null`, not a failure: it is never served as a stale value.
    let r;
    try {
      r = await this.cache.get<WorkIssueRead | null>(cacheKey, GITHUB_TTL.detail, async () => ({ value: await this.source.issue(key) }), { force });
    } catch (err) {
      // #495 the route answers the code; the raw message stays here.
      if (err instanceof NoDataError) this.log(`work issue ${key}: no data: ${err.message}`);
      throw err;
    }
    if (r.value === null) {
      await this.cache.invalidate(cacheKey);
      throw new WorkIssueNotFoundError(key);
    }
    if (r.stale && r.staleReason) this.log(`work issue ${key}: stale read: ${r.staleReason}`);
    const view = buildWorkIssue(r.value, await this.projectStatus(r.value.key));
    return { ...view, fetchedAt: r.fetchedAt, stale: r.stale, staleReason: r.stale ? (r.staleCode ?? 'github-error') : null };
  }

  /**
   * #533 saves fields of the issue. A title or body save carries `seenAt`, the `updatedAt` it was opened at:
   * when GitHub's is newer nothing is written and `WorkIssueConflictError` carries GitHub's version. The
   * other fields save with no check.
   */
  async update(key: string, edit: WorkIssueEdit, seenAt?: string): Promise<WorkIssueResult> {
    const checked = edit.title !== undefined || edit.body !== undefined;
    return this.write(key, async (writer) => {
      if (checked) {
        const current = await writer.current(key);
        if (!current) return null;
        if (seenAt === undefined || Date.parse(current.updatedAt) > Date.parse(seenAt)) throw new WorkIssueConflictError(key, current);
      }
      return writer.update(key, edit);
    });
  }

  /** #533 adds a comment; the answer and the cache carry the issue with it. */
  async comment(key: string, body: string): Promise<WorkIssueResult> {
    return this.write(key, (writer) => writer.comment(key, body));
  }

  /**
   * #534 edits a Plan step's title and body. `seenAt` is the step's `updatedAt` the /ui read, checked as a title or
   * body save of an issue is: GitHub's newer is `WorkIssueConflictError` and nothing is written. The step's own cached
   * detail is dropped, the parent's holds the answer.
   */
  async editStep(key: string, step: string, edit: { title?: string; body?: string }, seenAt: string): Promise<WorkIssueResult> {
    return this.write(
      key,
      async (writer) => {
        const current = await writer.stepCurrent(key, step);
        if (!current) return null;
        if (Date.parse(current.updatedAt) > Date.parse(seenAt)) throw new WorkIssueConflictError(step, current);
        return writer.editStep(key, step, edit);
      },
      [step],
    );
  }

  /** #534 adds a Plan sub-issue at the end of the plan. */
  async addStep(key: string, step: { title: string; body: string }): Promise<WorkIssueResult> {
    return this.write(key, (writer) => writer.addStep(key, step));
  }

  /** #534 removes a step: its sub-issue is closed as not planned. */
  async removeStep(key: string, step: string): Promise<WorkIssueResult> {
    return this.write(key, (writer) => writer.removeStep(key, step), [step]);
  }

  /** #534 moves a step behind `after`, or to the top with `null`. */
  async moveStep(key: string, step: string, after: string | null): Promise<WorkIssueResult> {
    return this.write(key, (writer) => writer.moveStep(key, step, after));
  }

  /**
   * #533 the write seam: run one GitHub write, then store what GitHub returned (the cache keeps no earlier
   * version of its own: ADR-0001) and answer it. A failure stores nothing, so the cache stays as it was (except a
   * write applied whose read-back failed, which drops the entry: the stored version is older than GitHub's); the
   * raw text goes to the log and the error goes up for the route to turn into a code. A rate limit also
   * pauses the cache's GitHub calls, as the Kanban mover does. `drop` (#534) are other issues whose own cached detail
   * the write makes stale (a step's), dropped when the write was applied.
   */
  private async write(key: string, run: (writer: WorkIssueWriter) => Promise<WorkIssueRead | null>, drop: readonly string[] = []): Promise<WorkIssueResult> {
    if (!this.writer) throw new WorkIssueWriteOffError();
    const wait = this.cache.pauseLeftMs();
    if (wait > 0) throw new RateLimitedError('GitHub limitou as chamadas; tente de novo em instantes', wait);
    let read: WorkIssueRead | null;
    try {
      read = await run(this.writer);
    } catch (err) {
      if (err instanceof RateLimitedError) this.cache.pause(err.retryAfterMs);
      // #533 GitHub holds the write: the cached version is stale, so the next read asks GitHub.
      if (err instanceof WorkIssueWrittenUnreadError) for (const k of [key, ...drop]) await this.cache.invalidate(workIssueCacheKey(k));
      if (!(err instanceof WorkIssueConflictError)) this.log(`work issue ${key}: write failed: ${rawTextOf(err)}`);
      throw err;
    }
    if (read === null) throw new WorkIssueNotFoundError(key);
    const cacheKey = workIssueCacheKey(key);
    await this.cache.put<WorkIssueRead | null>(cacheKey, read);
    for (const k of drop) await this.cache.invalidate(workIssueCacheKey(k));
    const stored = (await this.cache.peek(cacheKey))!;
    const view = buildWorkIssue(read, await this.projectStatus(read.key));
    return { ...view, fetchedAt: stored.fetchedAt, stale: false, staleReason: null };
  }

  /** #506 the lane the issue's card is in; `null` when it is in no card, in the no-Status lane, or the Project cannot be read. */
  private async projectStatus(key: string): Promise<string | null> {
    if (!this.project) return null;
    try {
      const board = (await this.project.snapshot?.()) ?? (await this.project.board());
      const lane = board.lanes.find((l) => l.items.some((c) => c.key?.toLowerCase() === key.toLowerCase()));
      return lane && lane.id !== null ? lane.name : null;
    } catch (err) {
      this.log(`work issue ${key}: project status unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
