// O Dev Console montado (decisão 0008, seção 4): junta os contextos, as leituras do GitHub pelo
// cache e as sessões, e entrega o que a tela C27 desenha. Só leitura; nada é anotado à mão.

import type { GetOptions } from '../github/cache.ts';
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
import type { DependsOnYouItem, DevConsoleSessions } from './sessions.ts';

export interface ContextSummary {
  id: string;
  name: string;
  repos: string[];
  source: DevConsoleContext['source'];
}

export interface GithubFreshness {
  /** A leitura mais velha do GitHub entre os repositórios (ISO); `null` quando nada veio. */
  readAt: string | null;
  /** `true` quando parte do que se vê é o cache, porque o GitHub falhou. */
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
}

export interface DevConsoleOverview extends GithubFreshness {
  generatedAt: string;
  contexts: (ContextSummary & { ready: number; notReady: number })[];
  /** A fila de todos os contextos juntos, cada PR uma vez. */
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

  listContexts(): Promise<DevConsoleContext[]> {
    return this.contexts.list();
  }

  /** O Dev Console de um contexto; `null` se o contexto não existe. */
  async view(contextId: string, options: GetOptions = {}): Promise<DevConsoleView | null> {
    const context = await this.contexts.get(contextId);
    if (!context) return null;
    const [snapshots, sessions] = await Promise.all([this.snapshots(context.repos, options), this.sessions.read(new Set(context.repos))]);
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
      ...freshness(snapshots),
    };
  }

  /** Os contextos e a fila de merge de todos eles; um repositório em dois contextos é lido uma vez. */
  async overview(options: GetOptions = {}): Promise<DevConsoleOverview> {
    const contexts = await this.contexts.list();
    const repos = [...new Set(contexts.flatMap((c) => c.repos))];
    const snapshots = await this.snapshots(repos, options);
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

  private snapshots(repos: readonly string[], options: GetOptions): Promise<RepoSnapshot[]> {
    return Promise.all(repos.map((r) => this.github.read(r, options)));
  }
}
