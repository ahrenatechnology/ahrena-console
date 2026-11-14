/*
 * #465 #466 the work board use case: loads the Project, the parents outside it, the linked sessions and
 * the queue, records each node's column in the history, and hands everything to the pure `buildWorkBoard`.
 * ADR-0001 GitHub down keeps the last data: `stale`, `staleReason` (a code, #495) and `fetchedAt` come from the Project
 * read. Sessions and the queue are local and read live on every call, so a card still moves while GitHub
 * is out.
 */

import { githubFailureOf, NoDataError, type GithubFailure } from './cache.ts';
import type { ProjectBoard, ProjectCard } from './project.ts';
import type { WorkBoardProjects } from './work-board-projects.ts';
import {
  analyzeWorkNodes,
  type AnalyzedWorkNode,
  type WorkCardExecution,
  type WorkCardPlanning,
  type WorkSessionLink,
  buildWorkBoard,
  DEFAULT_WORK_BOARD_FILTERS,
  statusSlug,
  type WorkBoardColumn,
  columnObservations,
  type ParentLookup,
  type WorkBoardFilters,
  type WorkBoardInput,
  type WorkBoardNode,
  type WorkBoardOrganization,
  type WorkBoardOrigin,
  type WorkBoardStatusOption,
  type WorkBoardView,
  type WorkColumnHistory,
  type WorkProjectBoard,
  type WorkQueue,
  type WorkSessions,
} from './work-board.ts';
import { DEFAULT_EXECUTION_LIMIT, executionOfRun, settleExecutionRun, type ExecutionRun, type RunningCards, type WorkExecutionRuns } from './work-execution.ts';
import { planningOfRun, settlePlanRun, type WorkPlanRuns } from './work-plan.ts';
import { isWritableQueue, type CardColumns } from './work-queue.ts';
import type { RepositoryTrust } from './trusted-owners.ts';
import type { QueueStop } from './work-queue.ts';
import type { WorkNode } from './work.ts';

export interface WorkBoardServiceOptions {
  project: WorkProjectBoard;
  /**
   * #609 the Projects of every granted organization and of the person's account. Without it the board reads the one chosen
   * Project (`project`), as before; with it the chosen Project is not read here (the kanban of one Project keeps using it).
   */
  projects?: Pick<WorkBoardProjects, 'read'>;
  sessions: WorkSessions;
  /** #477 the execution queue; when it can also be written (`WorkQueueStore`) the board drops the entries whose issue closed or lost its plan. */
  queue: WorkQueue;
  /** #477 the concurrent-execution limit the board shows on Na fila (the installation's `work.executionLimit`). Lazy: a change applies at the next read. Default `DEFAULT_EXECUTION_LIMIT`. */
  limit?: () => number;
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
  /** #477 a booting run just settled to `expired` (once per run, awaited): the queue's puller puts the item it pulled back at the top. A throw is logged and never fails the board. */
  onRunExpired?: (run: ExecutionRun) => Promise<void>;
  /** #477 each board read hands its view here when it is done (the puller looks at the queue and the limit). A throw is logged and never fails the board. */
  onRead?: (view: WorkBoardView) => void;
  /** #465 the raw error of a failed parent lookup goes here; the board only says it could not read them. */
  log?: (message: string) => void;
}

export interface WorkBoardReadOptions {
  /** #465 the refresh button: re-reads GitHub (ADR-0001, the cache keeps its 30 s floor). */
  force?: boolean;
  /** ADR-0015 answer the stored board and wait for GitHub only when nothing is stored. */
  fromStore?: boolean;
}

export class WorkBoardService implements RunningCards, CardColumns {
  private readonly project: WorkProjectBoard;
  private readonly projects: Pick<WorkBoardProjects, 'read'> | undefined;
  private readonly sessions: WorkSessions;
  private readonly queue: WorkQueue;
  private readonly limit: () => number;
  private readonly history: WorkColumnHistory;
  private readonly trust: RepositoryTrust;
  private readonly planRuns: WorkPlanRuns | undefined;
  private readonly executionRuns: WorkExecutionRuns | undefined;
  private readonly parents: ParentLookup | undefined;
  private readonly now: () => number;
  private readonly pausedUntil: () => number;
  private readonly nextScheduledRead: () => number | null;
  private readonly onRunExpired: ((run: ExecutionRun) => Promise<void>) | undefined;
  private readonly onRead: ((view: WorkBoardView) => void) | undefined;
  private readonly log: (message: string) => void;

  constructor({ project, projects, sessions, queue, limit = () => DEFAULT_EXECUTION_LIMIT, history, trust, planRuns, executionRuns, parents, now = Date.now, pausedUntil = () => 0, nextScheduledRead = () => null, onRunExpired, onRead, log = () => {} }: WorkBoardServiceOptions) {
    this.project = project;
    this.projects = projects;
    this.sessions = sessions;
    this.queue = queue;
    this.limit = limit;
    this.history = history;
    this.trust = trust;
    this.planRuns = planRuns;
    this.executionRuns = executionRuns;
    this.parents = parents;
    this.now = now;
    this.pausedUntil = pausedUntil;
    this.nextScheduledRead = nextScheduledRead;
    this.onRunExpired = onRunExpired;
    this.onRead = onRead;
    this.log = log;
  }

  async board(filters: WorkBoardFilters, { force = false, fromStore = false }: WorkBoardReadOptions = {}): Promise<WorkBoardView> {
    const read = await this.readBoards(force, fromStore);
    const fromProject = read.cards;
    const { nodes: outside, reason } = await this.resolveParents(fromProject);
    const nodes = [...fromProject, ...outside];
    const links = await this.sessions.links();
    const { positions: queue, stopped: queueStopped } = await this.readQueue(nodes);
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
    const view = buildWorkBoard({
      project: projectOf(read.projects, filters),
      organizations: read.organizations,
      statuses: read.statuses,
      nodes,
      sessions,
      queue,
      queueAvailable: this.queue.available,
      queueLimit: this.limit(),
      queueStopped,
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
    try {
      this.onRead?.(view);
    } catch (err) {
      this.log(`work board: onRead failed: ${err instanceof Error ? err.name : typeof err}`);
    }
    return view;
  }

  /**
   * #531 how many cards are in Em execução now, booting runs included: what the run route counts against
   * the limit. It reads the board the way the screen does (the store first, level item).
   */
  async runningCount(): Promise<number> {
    return (await this.board({ ...DEFAULT_WORK_BOARD_FILTERS }, { fromStore: true })).queue.running;
  }

  /**
   * #477 the column of an issue's card, for the queue route to refuse the fact columns; `null` when the
   * board does not hold the card at the default level (a card of an older done window included).
   */
  async columnOf(key: string): Promise<WorkBoardColumn | null> {
    const view = await this.board({ ...DEFAULT_WORK_BOARD_FILTERS }, { fromStore: true });
    const wanted = key.toLowerCase();
    return view.columns.find((c) => c.cards.some((card) => card.key.toLowerCase() === wanted))?.id ?? null;
  }

  /**
   * #477 the queue's positions and its stop, after dropping the entries whose issue is closed or has no
   * plan any more (a card that lost its plan goes back to Planejamento). An entry whose issue the board
   * does not hold stays. Dropping failing never fails the board: the entry just stays until the next read.
   */
  private async readQueue(nodes: readonly WorkBoardNode[]): Promise<{ positions: ReadonlyMap<string, number>; stopped: QueueStop | null }> {
    let positions = await this.queue.positions();
    if (isWritableQueue(this.queue) && positions.size) {
      try {
        const onBoard = new Map(nodes.filter((n) => n.inProject).map((n) => [n.key.toLowerCase(), n]));
        const gone = [...positions.keys()].filter((key) => {
          const n = onBoard.get(key.toLowerCase());
          return n !== undefined && (n.state === 'CLOSED' || !n.subIssues || n.subIssues.total === 0);
        });
        for (const key of gone) await this.queue.remove(key);
        if (gone.length) positions = await this.queue.positions();
      } catch (err) {
        this.log(`work board: queue not updated: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { positions, stopped: await this.queue.stopped() };
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
        if (settled !== run) {
          await this.executionRuns.save(settled);
          if (settled.state === 'expired') await this.runExpired(settled);
        }
        const state = executionOfRun(settled);
        if (state) out.set(run.key.toLowerCase(), state);
      }
    } catch (err) {
      this.log(`work board: execution runs unavailable: ${err instanceof Error ? err.message : String(err)}`);
      out.clear();
    }
    return out;
  }

  /** #477 tells the queue a run expired; its failure is the queue's, never the board's. */
  private async runExpired(run: ExecutionRun): Promise<void> {
    try {
      await this.onRunExpired?.(run);
    } catch (err) {
      this.log(`work board: onRunExpired failed: ${err instanceof Error ? err.name : typeof err}`);
    }
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

  /**
   * #609 the cards, the Status options and the owners of what the board is about: the Projects of every granted organization
   * and of the account, or, without that source, the one chosen Project as an owner of its own. A card that two Projects hold
   * is shown once, under the first (its card, the origin and the Status of that Project).
   */
  private async readBoards(force: boolean, fromStore: boolean): Promise<BoardsRead> {
    if (!this.projects) {
      const read = await this.readProject(force, fromStore);
      const origin = { organization: read.owner, project: { owner: read.owner, number: read.number, title: read.title } };
      return {
        cards: issueCards(read).map((c) => nodeOfCard(c, origin)),
        statuses: statusOptions(read),
        organizations: [{ login: read.owner, own: false, state: 'read', readAt: read.fetchedAt, projects: [origin.project] }],
        projects: [{ owner: read.owner, number: read.number, title: read.title, url: read.url }],
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        staleReason: read.staleReason,
        staleCode: read.staleCode,
      };
    }
    let read;
    try {
      read = await this.projects.read({ force, fromStore });
    } catch (err) {
      if (err instanceof NoDataError) this.log(`work board: no data: ${err.message}`);
      throw err;
    }
    const cards: WorkBoardNode[] = [];
    const seen = new Set<string>();
    const statuses = new Map<string, string>();
    const canonical = new Map<string, string>();
    const projects: BoardsRead['projects'] = [];
    for (const { organization, board } of read.boards) {
      const origin = { organization, project: { owner: board.owner, number: board.number, title: board.title } };
      projects.push({ ...origin.project, url: board.url });
      for (const o of statusOptions(board)) {
        // #609 The same Status name in two Projects is one option: GitHub gives each Project its own option ids.
        const slug = statusSlug(o.name);
        const first = statuses.get(slug) ?? (statuses.set(slug, o.id), o.id);
        canonical.set(o.id, first);
      }
      for (const card of issueCards(board)) {
        const key = (card.key ?? '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push({ ...nodeOfCard(card, origin), statusId: card.statusId === null ? null : (canonical.get(card.statusId) ?? card.statusId) });
      }
    }
    const names = new Map(read.boards.flatMap(({ board }) => statusOptions(board)).map((o) => [o.id, o.name]));
    return {
      cards,
      statuses: [...statuses.values()].map((id) => ({ id, name: names.get(id) ?? id })),
      organizations: read.organizations,
      projects,
      fetchedAt: read.fetchedAt,
      stale: read.stale,
      staleReason: read.stale ? 'the stored boards were not refreshed' : null,
      staleCode: read.staleCode,
    };
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

/** #609 what a board read hands to the view: the cards, the Status options (by Project order), the owners and the Projects. */
interface BoardsRead {
  cards: WorkBoardNode[];
  statuses: WorkBoardStatusOption[];
  organizations: WorkBoardOrganization[];
  projects: { owner: string; number: number; title: string; url: string }[];
  fetchedAt: number;
  stale: boolean;
  staleReason: string | null;
  staleCode: GithubFailure | 'sync-pending' | null;
}

/** #609 the Project the board is about: the one `?project=` names, else the only one read, else none. */
function projectOf(projects: BoardsRead['projects'], filters: WorkBoardFilters): WorkBoardInput['project'] {
  const asked = filters.project?.toLowerCase();
  const hit = projects.find((p) => `${p.owner}/${p.number}`.toLowerCase() === asked) ?? (projects.length === 1 ? projects[0] : undefined);
  return hit ?? null;
}

/** #465 pull requests and draft issues are not work items on this board. */
const issueCards = (board: ProjectBoard): ProjectCard[] =>
  board.lanes.flatMap((l) => l.items).filter((c) => c.kind === 'Issue' && c.key !== null && c.repo !== null && c.number !== null);

/** #466 the Status options in Project order; the no-Status lane is not an option. */
const statusOptions = (board: ProjectBoard): WorkBoardStatusOption[] =>
  board.lanes.flatMap((l) => (l.id === null ? [] : [{ id: l.id, name: l.name }]));

function nodeOfCard(c: ProjectCard, origin: WorkBoardOrigin): WorkBoardNode {
  return {
    origin,
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
