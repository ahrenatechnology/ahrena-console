// The assembled Dev Console (decision 0008, section 4): joins the contexts, the cached GitHub reads
// and the sessions, and hands over what screen C27 draws. Read only; nothing is annotated by hand.

import type { DevConsoleContext, DevConsoleContexts } from './contexts.ts';
import {
  buildBoard,
  buildMergeQueue,
  buildScoreboard,
  mergedSince,
  type Board,
  type ContextSession,
  type MergedPullRequestFact,
  type NotReadyItem,
  type QueueItem,
  type Scoreboard,
} from './model.ts';
import type { DevConsoleGithub, RepoSnapshot } from './reader.ts';
import type { DecisionTodayItem, DependsOnYouItem, DevConsoleSessions } from './sessions.ts';

export interface ContextSummary {
  id: string;
  name: string;
  repos: string[];
  source: DevConsoleContext['source'];
}

export interface GithubFreshness {
  /** The oldest GitHub read across the repositories (ISO); `null` when nothing came back. */
  readAt: string | null;
  /** `true` when part of what is shown is the cache, because GitHub failed. */
  stale: boolean;
  staleReason: string | null;
}

export interface DevConsoleView extends GithubFreshness {
  generatedAt: string;
  context: ContextSummary;
  scoreboard: Scoreboard;
  dependsOnYou: DependsOnYouItem[];
  mergeQueue: QueueItem[];
  notReady: NotReadyItem[];
  board: Board;
  mergedLast24h: MergedPullRequestFact[];
  /** Decisions in force taken today in the context's live sessions, most recent first. */
  decisionsToday: DecisionTodayItem[];
  /** Per context repository: `true` when a GitHub list came back partial (more than one page). */
  truncated: Record<string, boolean>;
}

export interface DevConsoleOverview extends GithubFreshness {
  generatedAt: string;
  contexts: (ContextSummary & { ready: number; notReady: number })[];
  /** The queue of all contexts together, each PR once. */
  mergeQueue: QueueItem[];
}

export interface DevConsoleOptions {
  contexts: DevConsoleContexts;
  github: DevConsoleGithub;
  sessions: DevConsoleSessions;
  now?: () => number;
}

const summary = (c: DevConsoleContext): ContextSummary => ({ id: c.id, name: c.name, repos: [...c.repos], source: c.source });

function freshness(snapshots: readonly RepoSnapshot[]): GithubFreshness {
  const times = snapshots.map((s) => s.readAt).filter((t): t is number => t !== null);
  return {
    readAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
    stale: snapshots.some((s) => s.stale),
    staleReason: snapshots.find((s) => s.staleReason)?.staleReason ?? null,
  };
}

export class DevConsole {
  private readonly contexts: DevConsoleContexts;
  private readonly github: DevConsoleGithub;
  private readonly sessions: DevConsoleSessions;
  private readonly now: () => number;

  constructor({ contexts, github, sessions, now = Date.now }: DevConsoleOptions) {
    this.contexts = contexts;
    this.github = github;
    this.sessions = sessions;
    this.now = now;
  }

  /** The Dev Console of one context; `null` when the context does not exist. */
  async view(contextId: string): Promise<DevConsoleView | null> {
    const context = await this.contexts.get(contextId);
    if (!context) return null;
    const [snapshots, sessions] = await Promise.all([this.snapshots(context.repos), this.sessions.read(new Set(context.repos))]);
    const now = this.now();
    const openPullRequests = snapshots.flatMap((s) => s.openPullRequests);
    const contextSessions: ContextSession[] = context.repos.flatMap((r) => sessions.byRepo.get(r) ?? []);
    const dependsOnYou = context.repos.flatMap((r) => sessions.dependsOnYou.get(r) ?? []).sort((a, b) => a.since.localeCompare(b.since));
    const queue = buildMergeQueue(openPullRequests);
    return {
      generatedAt: new Date(now).toISOString(),
      context: summary(context),
      scoreboard: buildScoreboard({ queue, openPullRequests, sessions: contextSessions, dependsOnYou: dependsOnYou.length }),
      dependsOnYou,
      mergeQueue: queue.ready,
      notReady: queue.notReady,
      board: buildBoard({
        openIssues: snapshots.flatMap((s) => s.openIssues),
        closedIssues: snapshots.flatMap((s) => s.closedIssues),
        openPullRequests,
        remoteBranches: new Map(snapshots.map((s) => [s.repo, s.branches])),
        sessions: contextSessions,
        blockedLabels: context.blockedLabels,
        now,
      }),
      mergedLast24h: mergedSince(
        snapshots.flatMap((s) => s.merged),
        now,
      ),
      decisionsToday: context.repos.flatMap((r) => sessions.decisionsToday.get(r) ?? []).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
      truncated: Object.fromEntries(snapshots.map((s) => [s.repo, s.truncated])),
      ...freshness(snapshots),
    };
  }

  /** The contexts and the merge queue of all of them; a repository in two contexts is read once. */
  async overview(): Promise<DevConsoleOverview> {
    const contexts = await this.contexts.list();
    const repos = [...new Set(contexts.flatMap((c) => c.repos))];
    const snapshots = await this.snapshots(repos);
    const byRepo = new Map(snapshots.map((s) => [s.repo, s]));
    const queueOf = (rs: readonly string[]) => buildMergeQueue(rs.flatMap((r) => byRepo.get(r)?.openPullRequests ?? []));
    return {
      generatedAt: new Date(this.now()).toISOString(),
      contexts: contexts.map((c) => {
        const q = queueOf(c.repos);
        return { ...summary(c), ready: q.ready.length, notReady: q.notReady.length };
      }),
      mergeQueue: queueOf(repos).ready,
      ...freshness(snapshots),
    };
  }

  private snapshots(repos: readonly string[]): Promise<RepoSnapshot[]> {
    return Promise.all(repos.map((r) => this.github.read(r)));
  }
}
