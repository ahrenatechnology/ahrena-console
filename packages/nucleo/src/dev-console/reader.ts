// As leituras do GitHub do Dev Console pelo cache da decisão 0001: uma chave por consulta e por
// repositório, com o TTL dos PRs (60 s) para PRs e branches e o das issues (5 min) para as
// issues. Sem GitHub, serve o que está guardado com `stale: true`; sem nada guardado, o
// repositório vem vazio, também `stale`, para a tela dizer por quê.

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
  /** Alguma das listas veio parcial (mais do que a página do GitHub). */
  truncated: boolean;
  /** A leitura mais velha das três (ms desde a época); `null` quando nenhuma veio. */
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
      // `NoDataError`: nada guardado e o GitHub falhou.
      return { value: empty, readAt: null, stale: true, staleReason: err instanceof Error ? err.message : String(err) };
    }
  }
}
