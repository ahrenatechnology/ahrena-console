/*
 * #590 the issue options of a repository: what the work board's edit mode offers in its selectors, the
 * labels, issue types, open milestones and parent candidates of the whole repository, not only of the
 * board's current level. One read of the repository (`WorkIssueOptionsSource`, one GraphQL query) behind
 * the ADR-0001 cache, as the issue detail is (work-issue-service.ts): inside the TTL it never calls
 * GitHub; GitHub down after a read serves the last value (`stale`, a stable code, #495); with nothing
 * stored the `NoDataError` goes up and the route turns it into a reason.
 *
 * The values are what the write path accepts (#533): labels and issue types by name, milestones by title
 * (only the open ones), a parent as an issue key `owner/name#N`.
 *
 * Every list is bounded (see `OPTIONS_LIMITS`): a repository with more than the bound answers its first
 * ones; the selectors are not a search.
 */

import { GITHUB_TTL, NoDataError, type GithubCache } from './cache.ts';

/** #590 the bound of each list of the GraphQL read; GitHub's page maximum is 100. */
export const OPTIONS_LIMITS = {
  labels: 100,
  types: 100,
  milestones: 100,
  /** #590 the parent candidates: the most recently updated open issues. */
  parents: 100,
} as const;

/** #590 A parent candidate: an open issue, by the key the write's `parent` takes. */
export interface WorkIssueParentOption {
  /** #590 `owner/name#N`. */
  key: string;
  title: string;
}

/** #590 What GitHub holds of one repository's options. */
export interface WorkIssueOptions {
  labels: string[];
  types: string[];
  /** #590 titles of the open milestones. */
  milestones: string[];
  parents: WorkIssueParentOption[];
}

/** #590 The port the options are read through. `null`: GitHub has no such repository (or it is not visible). */
export interface WorkIssueOptionsSource {
  options(repo: string): Promise<WorkIssueOptions | null>;
}

/** #590 The options with the cache's freshness: what the route answers. */
export interface WorkIssueOptionsResult extends WorkIssueOptions {
  fetchedAt: number;
  stale: boolean;
  /** The stable code of why the read is stale (#495); `null` when fresh. */
  staleReason: string | null;
}

/** #590 GitHub answered, and has no such repository. */
export class WorkRepositoryNotFoundError extends Error {
  constructor(repo: string) {
    super(`repository not found: ${repo}`);
    this.name = 'WorkRepositoryNotFoundError';
  }
}

/** #590 The same repository in any letter case is the same cache entry. */
export const workIssueOptionsCacheKey = (repo: string): string => `github:work-issue-options:${repo.toLowerCase()}`;

export interface WorkIssueOptionsServiceOptions {
  source: WorkIssueOptionsSource;
  cache: GithubCache;
  /** #590 the raw text of a stale read or a failed read goes here; the answer only carries a code. */
  log?: (message: string) => void;
}

export class WorkIssueOptionsService {
  private readonly source: WorkIssueOptionsSource;
  private readonly cache: GithubCache;
  private readonly log: (message: string) => void;

  constructor({ source, cache, log = () => {} }: WorkIssueOptionsServiceOptions) {
    this.source = source;
    this.cache = cache;
    this.log = log;
  }

  /**
   * #590 `force` is the refresh button: it re-reads GitHub (the cache keeps its 30 s floor). The TTL is the issues'
   * (5 min): the parent candidates are a list of issues, the rest changes more slowly.
   */
  async options(repo: string, { force = false }: { force?: boolean } = {}): Promise<WorkIssueOptionsResult> {
    const cacheKey = workIssueOptionsCacheKey(repo);
    // #590 a missing repository is the fetcher's `null`, not a failure: it is never served as a stale value.
    let r;
    try {
      r = await this.cache.get<WorkIssueOptions | null>(cacheKey, GITHUB_TTL.issues, async () => ({ value: await this.source.options(repo) }), { force });
    } catch (err) {
      // #495 the route answers the code; the raw message stays here.
      if (err instanceof NoDataError) this.log(`work issue options ${repo}: no data: ${err.message}`);
      throw err;
    }
    if (r.value === null) {
      await this.cache.invalidate(cacheKey);
      throw new WorkRepositoryNotFoundError(repo);
    }
    if (r.stale && r.staleReason) this.log(`work issue options ${repo}: stale read: ${r.staleReason}`);
    const { labels, types, milestones, parents } = r.value;
    return { labels, types, milestones, parents, fetchedAt: r.fetchedAt, stale: r.stale, staleReason: r.stale ? (r.staleCode ?? 'github-error') : null };
  }
}
