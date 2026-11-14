/*
 * issue 506 the issue detail use case: one read of the issue (`WorkIssueSource`, one GraphQL query) behind
 * the ADR-0001 cache, and the issue's Status in the chosen Project. Inside the TTL it never calls GitHub;
 * GitHub down after a read serves the last value (`stale`, a stable code, #495); with nothing stored the
 * `NoDataError` goes up, and the route turns it into a reason. The Project is read through its own cache
 * or snapshot and never fails the detail: without it the Status is `null`.
 */

import { GITHUB_TTL, type GithubCache } from './cache.ts';
import type { WorkProjectBoard } from './work-board.ts';
import { buildWorkIssue, type WorkIssueRead, type WorkIssueSource, type WorkIssueView } from './work-issue.ts';

export interface WorkIssueServiceOptions {
  source: WorkIssueSource;
  cache: GithubCache;
  /** The chosen Project, for the Project Status; without it the Status is `null`. */
  project?: WorkProjectBoard;
  /** The raw text of a stale read or a failed Project read goes here; the answer only carries a code. */
  log?: (message: string) => void;
}

export interface WorkIssueReadOptions {
  /** The refresh button: re-reads GitHub (the cache keeps its 30 s floor). */
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

/** The same issue in any letter case is the same cache entry. */
export const workIssueCacheKey = (key: string): string => `github:work-issue:${key.toLowerCase()}`;

export class WorkIssueService {
  private readonly source: WorkIssueSource;
  private readonly cache: GithubCache;
  private readonly project: WorkProjectBoard | undefined;
  private readonly log: (message: string) => void;

  constructor({ source, cache, project, log = () => {} }: WorkIssueServiceOptions) {
    this.source = source;
    this.cache = cache;
    this.project = project;
    this.log = log;
  }

  async issue(key: string, { force = false }: WorkIssueReadOptions = {}): Promise<WorkIssueResult> {
    const cacheKey = workIssueCacheKey(key);
    // A missing issue is the fetcher's `null`, not a failure: it is never served as a stale value.
    const r = await this.cache.get<WorkIssueRead | null>(cacheKey, GITHUB_TTL.detail, async () => ({ value: await this.source.issue(key) }), { force });
    if (r.value === null) {
      await this.cache.invalidate(cacheKey);
      throw new WorkIssueNotFoundError(key);
    }
    if (r.stale && r.staleReason) this.log(`work issue ${key}: stale read: ${r.staleReason}`);
    const view = buildWorkIssue(r.value, await this.projectStatus(r.value.key));
    return { ...view, fetchedAt: r.fetchedAt, stale: r.stale, staleReason: r.stale ? (r.staleCode ?? 'github-error') : null };
  }

  /** The lane the issue's card is in; `null` when it is in no card, in the no-Status lane, or the Project cannot be read. */
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
