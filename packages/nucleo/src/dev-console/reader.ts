// The Dev Console's GitHub reads through the decision 0001 cache: one key per query and per
// repository, with the PR TTL (60 s) for PRs and branches and the issue TTL (5 min) for issues.
// With no GitHub it serves what is cached with `stale: true`; with nothing cached, the
// repository comes back empty, also `stale`, so the screen can say why.

import { GITHUB_TTL, GithubCache, type CacheResult } from '../github/cache.ts';
import { DONE_WINDOW_MS, type IssueFact, type MergedPullRequestFact, type PullRequestFact } from './model.ts';
import type { DevConsoleSource, RepoBranches, RepoIssues, RepoPullRequests } from './source.ts';

export const DEV_CONSOLE_TTL = {
  pullRequests: GITHUB_TTL.detail,
  branches: GITHUB_TTL.detail,
  issues: GITHUB_TTL.issues,
} as const;

export const devConsoleCacheKey = (kind: keyof typeof DEV_CONSOLE_TTL, repo: string) => `dev-console:${kind}:${repo}`;

export interface RepoSnapshot {
  repo: string;
  openPullRequests: PullRequestFact[];
  merged: MergedPullRequestFact[];
  openIssues: IssueFact[];
  closedIssues: IssueFact[];
  branches: string[];
  /** One of the lists came back partial (more than GitHub's page). */
  truncated: boolean;
  /** The oldest of the three reads (ms since the epoch); `null` when none came back. */
  readAt: number | null;
  stale: boolean;
  staleReason: string | null;
}

export interface DevConsoleGithubOptions {
  source: DevConsoleSource;
  cache: GithubCache;
  now?: () => number;
}

interface Read<T> {
  value: T;
  readAt: number | null;
  stale: boolean;
  staleReason: string | null;
}

export class DevConsoleGithub {
  private readonly source: DevConsoleSource;
  private readonly cache: GithubCache;
  private readonly now: () => number;

  constructor({ source, cache, now = Date.now }: DevConsoleGithubOptions) {
    this.source = source;
    this.cache = cache;
    this.now = now;
  }

  async read(repo: string): Promise<RepoSnapshot> {
    const since = new Date(this.now() - DONE_WINDOW_MS).toISOString();
    const [prs, issues, branches] = await Promise.all([
      this.get<RepoPullRequests>(devConsoleCacheKey('pullRequests', repo), DEV_CONSOLE_TTL.pullRequests, () => this.source.pullRequests(repo, since), { open: [], merged: [] }),
      this.get<RepoIssues>(devConsoleCacheKey('issues', repo), DEV_CONSOLE_TTL.issues, () => this.source.issues(repo, since), { open: [], closed: [] }),
      this.get<RepoBranches>(devConsoleCacheKey('branches', repo), DEV_CONSOLE_TTL.branches, () => this.source.branches(repo), { names: [] }),
    ]);
    const reads = [prs, issues, branches];
    const times = reads.map((r) => r.readAt).filter((t): t is number => t !== null);
    return {
      repo,
      openPullRequests: prs.value.open,
      merged: prs.value.merged,
      openIssues: issues.value.open,
      closedIssues: issues.value.closed,
      branches: branches.value.names,
      truncated: Boolean(prs.value.truncated || issues.value.truncated || branches.value.truncated),
      readAt: times.length > 0 ? Math.min(...times) : null,
      stale: reads.some((r) => r.stale),
      staleReason: reads.find((r) => r.staleReason)?.staleReason ?? null,
    };
  }

  private async get<T>(key: string, ttl: number, fetch: () => Promise<T>, empty: T): Promise<Read<T>> {
    try {
      const r: CacheResult<T> = await this.cache.get(key, ttl, async () => ({ value: await fetch() }));
      return { value: r.value, readAt: r.fetchedAt, stale: r.stale, staleReason: r.staleReason };
    } catch (err) {
      // `NoDataError`: nothing cached and GitHub failed.
      return { value: empty, readAt: null, stale: true, staleReason: err instanceof Error ? err.message : String(err) };
    }
  }
}
