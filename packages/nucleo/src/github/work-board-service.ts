/*
 * #465 #466 the work board use case: loads the Project, the parents outside it, the linked sessions and
 * the queue, records each node's column in the history, and hands everything to the pure `buildWorkBoard`.
 * ADR-0001 GitHub down keeps the last data: `stale`, `staleReason` and `fetchedAt` come from the Project
 * read. Sessions and the queue are local and read live on every call, so a card still moves while GitHub
 * is out.
 */

import type { ProjectBoard, ProjectCard } from './project.ts';
import {
  analyzeWorkNodes,
  buildWorkBoard,
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
import type { WorkNode } from './work.ts';

export interface WorkBoardServiceOptions {
  project: WorkProjectBoard;
  sessions: WorkSessions;
  queue: WorkQueue;
  history: WorkColumnHistory;
  /** #465 without it, parents outside the Project stay chain links with no title. */
  parents?: ParentLookup;
  now?: () => number;
  /** #465 the raw error of a failed parent lookup goes here; the board only says it could not read them. */
  log?: (message: string) => void;
}

/** On-screen reason (pt-BR) when the parents outside the Project could not be read. */
export const PARENTS_UNAVAILABLE_REASON = 'não deu para ler os pais fora do Project';

export interface WorkBoardReadOptions {
  /** #465 the refresh button: re-reads GitHub (ADR-0001, the cache keeps its 30 s floor). */
  force?: boolean;
  /** ADR-0015 answer the stored board and wait for GitHub only when nothing is stored. */
  fromStore?: boolean;
}

export class WorkBoardService {
  private readonly project: WorkProjectBoard;
  private readonly sessions: WorkSessions;
  private readonly queue: WorkQueue;
  private readonly history: WorkColumnHistory;
  private readonly parents: ParentLookup | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor({ project, sessions, queue, history, parents, now = Date.now, log = () => {} }: WorkBoardServiceOptions) {
    this.project = project;
    this.sessions = sessions;
    this.queue = queue;
    this.history = history;
    this.parents = parents;
    this.now = now;
    this.log = log;
  }

  async board(filters: WorkBoardFilters, { force = false, fromStore = false }: WorkBoardReadOptions = {}): Promise<WorkBoardView> {
    const read = await this.readProject(force, fromStore);
    const fromProject = issueCards(read).map(nodeOfCard);
    const { nodes: outside, reason } = await this.resolveParents(fromProject);
    const nodes = [...fromProject, ...outside];
    const [sessions, queue] = await Promise.all([this.sessions.links(), this.queue.positions()]);
    const now = this.now();
    const analyzed = analyzeWorkNodes(nodes, sessions, queue);
    const since = await this.history.observe(columnObservations(analyzed, now));
    const reasons = [read.stale ? (read.staleReason ?? 'dado velho') : null, reason].filter((r): r is string => r !== null);
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
      now,
      fetchedAt: read.fetchedAt,
      stale: reasons.length > 0,
      staleReason: reasons.length ? reasons.join('; ') : null,
    });
  }

  private async readProject(force: boolean, fromStore: boolean): Promise<ProjectBoard> {
    const stored = fromStore && !force ? await this.project.snapshot?.() : null;
    return stored ?? this.project.board({ force });
  }

  /**
   * #465 one batched lookup for the parents the Project cites but does not hold, ancestors included. Its
   * failure never fails the board: the chain keeps those links without a title and the board says why.
   */
  private async resolveParents(nodes: readonly WorkBoardNode[]): Promise<{ nodes: WorkBoardNode[]; reason: string | null }> {
    const known = new Set(nodes.map((n) => n.key));
    const missing = [...new Set(nodes.flatMap((n) => (n.parent && !known.has(n.parent) ? [n.parent] : [])))];
    if (!missing.length || !this.parents) return { nodes: [], reason: null };
    try {
      const found = await this.parents.nodes(missing);
      return { nodes: found.filter((n) => !known.has(n.key)).map(nodeOutsideProject), reason: null };
    } catch (err) {
      this.log(`work board: parent lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { nodes: [], reason: PARENTS_UNAVAILABLE_REASON };
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
