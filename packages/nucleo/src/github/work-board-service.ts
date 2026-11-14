/*
 * #465 #466 the work board use case: loads the Project, the parents outside it, the linked sessions and
 * the queue, records each node's column in the history, and hands everything to the pure `buildWorkBoard`.
 * ADR-0001 GitHub down keeps the last data: `stale`, `staleReason` (a code, #495) and `fetchedAt` come from the Project
 * read. Sessions and the queue are local and read live on every call, so a card still moves while GitHub
 * is out.
 */

import { githubFailureOf, NoDataError, type GithubFailure } from './cache.ts';
import type { ProjectBoard, ProjectCard } from './project.ts';
import {
  analyzeWorkNodes,
  type AnalyzedWorkNode,
  type WorkCardExecution,
  type WorkCardPlanning,
  type WorkSessionLink,
  buildWorkBoard,
  DEFAULT_WORK_BOARD_FILTERS,
  columnObservations,
  type ParentLookup,
  type WorkBoardFilters,
  type WorkBoardNode,
  type WorkBoardStatusOption,
  type WorkBoardView,
  type WorkColumnHistory,
  type WorkProjectBoard,
  type WorkQueue,
  type WorkSessions,
} from './work-board.ts';
import { executionOfRun, settleExecutionRun, type RunningCards, type WorkExecutionRuns } from './work-execution.ts';
import { planningOfRun, settlePlanRun, type WorkPlanRuns } from './work-plan.ts';
import type { RepositoryTrust } from './trusted-owners.ts';
import type { WorkNode } from './work.ts';

export interface WorkBoardServiceOptions {
  project: WorkProjectBoard;
  sessions: WorkSessions;
  queue: WorkQueue;
  history: WorkColumnHistory;
  /** #594 whose repositories are trusted: each card carries `trusted`. Required: no board trusts by default. */
  trust: RepositoryTrust;
  /** #507 the planning runs; without it no card has a planning state. */
  planRuns?: WorkPlanRuns;
  /** #531 the execution runs; without it no card has a boot state. */
  executionRuns?: WorkExecutionRuns;
  /** #465 without it, parents outside the Project stay chain links with no title. */
  parents?: ParentLookup;
  now?: () => number;
  /** #496 the end of the GitHub rate-limit pause (epoch ms; in the past or `0` when there is none). Lazy: read when the board is built. */
  pausedUntil?: () => number;
  /** #496 when the background sync next reads the Project (epoch ms), `null` when nothing is scheduled. Lazy: the sync is built after this service. */
  nextScheduledRead?: () => number | null;
  /** #465 the raw error of a failed parent lookup goes here; the board only says it could not read them. */
  log?: (message: string) => void;
}

export interface WorkBoardReadOptions {
  /** #465 the refresh button: re-reads GitHub (ADR-0001, the cache keeps its 30 s floor). */
  force?: boolean;
  /** ADR-0015 answer the stored board and wait for GitHub only when nothing is stored. */
  fromStore?: boolean;
}

export class WorkBoardService implements RunningCards {
  private readonly project: WorkProjectBoard;
  private readonly sessions: WorkSessions;
  private readonly queue: WorkQueue;
  private readonly history: WorkColumnHistory;
  private readonly trust: RepositoryTrust;
  private readonly planRuns: WorkPlanRuns | undefined;
  private readonly executionRuns: WorkExecutionRuns | undefined;
  private readonly parents: ParentLookup | undefined;
  private readonly now: () => number;
  private readonly pausedUntil: () => number;
  private readonly nextScheduledRead: () => number | null;
  private readonly log: (message: string) => void;

  constructor({ project, sessions, queue, history, trust, planRuns, executionRuns, parents, now = Date.now, pausedUntil = () => 0, nextScheduledRead = () => null, log = () => {} }: WorkBoardServiceOptions) {
    this.project = project;
    this.sessions = sessions;
    this.queue = queue;
    this.history = history;
    this.trust = trust;
    this.planRuns = planRuns;
    this.executionRuns = executionRuns;
    this.parents = parents;
    this.now = now;
    this.pausedUntil = pausedUntil;
    this.nextScheduledRead = nextScheduledRead;
    this.log = log;
  }

  async board(filters: WorkBoardFilters, { force = false, fromStore = false }: WorkBoardReadOptions = {}): Promise<WorkBoardView> {
    const read = await this.readProject(force, fromStore);
    const fromProject = issueCards(read).map(nodeOfCard);
    const { nodes: outside, reason } = await this.resolveParents(fromProject);
    const nodes = [...fromProject, ...outside];
    const [links, queue] = await Promise.all([this.sessions.links(), this.queue.positions()]);
    // #507 a planning session is not an execution: it never moves the card, it gives it its planning state.
    const sessions = links.filter((l) => !l.planning);
    const now = this.now();
    const execution = await this.settleExecution(links.filter((l) => l.execution), now);
    const analyzed = analyzeWorkNodes(nodes, sessions, queue, new Set(execution.keys()));
    const planning = await this.settlePlanning(analyzed, links.filter((l) => l.planning), now);
    const since = await this.history.observe(columnObservations(analyzed, now));
    // #495 the screen gets a code; the raw text of the stale read goes to the log.
    if (read.stale && read.staleReason) this.log(`work board: stale read: ${read.staleReason}`);
    const staleReason = read.stale ? (read.staleCode ?? 'github-error') : reason;
    return buildWorkBoard({
      project: { owner: read.owner, number: read.number, title: read.title, url: read.url },
      statuses: statusOptions(read),
      nodes,
      sessions,
      queue,
      queueAvailable: this.queue.available,
      since,
      filters,
      analyzed,
      planning,
      execution,
      trust: this.trust,
      now,
      fetchedAt: read.fetchedAt,
      stale: staleReason !== null,
      staleReason,
      retryAt: staleReason === null ? null : this.retryAt(now),
    });
  }

  /**
   * #531 how many cards are in Em execução now, booting runs included: what the run route counts against
   * the limit. It reads the board the way the screen does (the store first, level item).
   */
  async runningCount(): Promise<number> {
    const view = await this.board({ ...DEFAULT_WORK_BOARD_FILTERS }, { fromStore: true });
    return view.columns.find((c) => c.id === 'running')?.count ?? 0;
  }

  /**
   * #531 settles every execution run against the live execution sessions of its issue (work-execution.ts),
   * records the change, and returns the boot state of the runs still booting. The record failing never
   * fails the board: the cards just carry no boot state.
   */
  private async settleExecution(executionLinks: readonly WorkSessionLink[], now: number): Promise<Map<string, WorkCardExecution>> {
    const out = new Map<string, WorkCardExecution>();
    if (!this.executionRuns) return out;
    try {
      for (const run of await this.executionRuns.all()) {
        const live = executionLinks.filter((l) => l.key.toLowerCase() === run.key.toLowerCase()).map((l) => ({ sessionId: l.sessionId, since: l.since }));
        const settled = settleExecutionRun(run, { live, now });
        if (settled !== run) await this.executionRuns.save(settled);
        const state = executionOfRun(settled);
        if (state) out.set(run.key.toLowerCase(), state);
      }
    } catch (err) {
      this.log(`work board: execution runs unavailable: ${err instanceof Error ? err.message : String(err)}`);
      out.clear();
    }
    return out;
  }

  /**
   * #507 settles every planning run whose issue is on the board against its live planning sessions and its
   * sub-issue total (work-plan.ts), records the change, and returns the card states. The record failing
   * never fails the board: the cards just carry no planning state.
   */
  private async settlePlanning(analyzed: ReadonlyMap<string, AnalyzedWorkNode>, planningLinks: readonly WorkSessionLink[], now: number): Promise<Map<string, WorkCardPlanning>> {
    const out = new Map<string, WorkCardPlanning>();
    if (!this.planRuns) return out;
    try {
      const onBoard = new Map([...analyzed.values()].filter((a) => a.node.inProject).map((a) => [a.node.key.toLowerCase(), a.node]));
      for (const run of await this.planRuns.all()) {
        const node = onBoard.get(run.key.toLowerCase());
        if (!node) continue;
        const live = planningLinks.filter((l) => l.key.toLowerCase() === run.key.toLowerCase()).map((l) => ({ sessionId: l.sessionId, since: l.since }));
        const settled = settlePlanRun(run, { live, steps: node.subIssues?.total ?? 0, now });
        if (settled !== run) await this.planRuns.save(settled);
        const state = planningOfRun(settled);
        if (state) out.set(run.key.toLowerCase(), state);
      }
    } catch (err) {
      this.log(`work board: planning runs unavailable: ${err instanceof Error ? err.message : String(err)}`);
      out.clear();
    }
    return out;
  }

  /** #496 the pause the rate limit set wins; else the sync's next read, an overdue one counting as now (it runs on the next tick); else nothing is scheduled. */
  private retryAt(now: number): number | null {
    const paused = this.pausedUntil();
    if (paused > now) return paused;
    const next = this.nextScheduledRead();
    return next === null ? null : Math.max(next, now);
  }

  private async readProject(force: boolean, fromStore: boolean): Promise<ProjectBoard> {
    const stored = fromStore && !force ? await this.project.snapshot?.() : null;
    try {
      return stored ?? (await this.project.board({ force }));
    } catch (err) {
      // #495 the route answers the code; the raw message stays here.
      if (err instanceof NoDataError) this.log(`work board: no data: ${err.message}`);
      throw err;
    }
  }

  /**
   * #465 one batched lookup for the parents the Project cites but does not hold, ancestors included. Its
   * failure never fails the board: the chain keeps those links without a title and the board says why.
   */
  private async resolveParents(nodes: readonly WorkBoardNode[]): Promise<{ nodes: WorkBoardNode[]; reason: GithubFailure | null }> {
    const known = new Set(nodes.map((n) => n.key));
    const missing = [...new Set(nodes.flatMap((n) => (n.parent && !known.has(n.parent) ? [n.parent] : [])))];
    if (!missing.length || !this.parents) return { nodes: [], reason: null };
    try {
      const found = await this.parents.nodes(missing);
      return { nodes: found.filter((n) => !known.has(n.key)).map(nodeOutsideProject), reason: null };
    } catch (err) {
      this.log(`work board: parent lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { nodes: [], reason: githubFailureOf(err) };
    }
  }
}

/** #465 pull requests and draft issues are not work items on this board. */
const issueCards = (board: ProjectBoard): ProjectCard[] =>
  board.lanes.flatMap((l) => l.items).filter((c) => c.kind === 'Issue' && c.key !== null && c.repo !== null && c.number !== null);

/** #466 the Status options in Project order; the no-Status lane is not an option. */
const statusOptions = (board: ProjectBoard): WorkBoardStatusOption[] =>
  board.lanes.flatMap((l) => (l.id === null ? [] : [{ id: l.id, name: l.name }]));

function nodeOfCard(c: ProjectCard): WorkBoardNode {
  return {
    key: c.key!,
    repo: c.repo!,
    number: c.number!,
    title: c.title,
    url: c.url ?? '',
    state: c.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    type: c.type,
    parent: c.parent,
    labels: c.labels ?? [],
    milestone: c.milestone ?? null,
    closedAt: c.closedAt ?? null,
    statusId: c.statusId,
    subIssues: c.subIssues ?? null,
    pullRequest: c.pullRequest ?? null,
    inProject: true,
  };
}

function nodeOutsideProject(n: WorkNode): WorkBoardNode {
  return {
    key: n.key,
    repo: n.repo,
    number: n.number,
    title: n.title,
    url: n.url,
    state: n.state,
    type: n.type,
    parent: n.parent,
    labels: [],
    milestone: null,
    closedAt: null,
    statusId: null,
    subIssues: n.progress ? { total: n.progress.total, completed: n.progress.completed } : null,
    pullRequest: null,
    inProject: false,
  };
}
