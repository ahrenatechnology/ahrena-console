/*
 * #465 #466 the work board ("Quadro do trabalho", epic #464): the issues of the chosen GitHub Project laid
 * out by the agent lifecycle (planning, queued, running, review, blocked, done), with the column computed
 * from the issue state, the PR that closes it (CI and review), the Console sessions linked to it and the
 * execution queue. The column sits beside `stageOf`/`WORK_STAGES` (work.ts) and does not replace them:
 * `stageOf` answers "where is the PR" from GitHub alone; the column also needs sessions and the queue.
 * Pure domain: the ports at the end are what the use case (work-board-service.ts) reads.
 */

import type { StaleCode } from './cache.ts';
import type { ProjectBoard } from './project.ts';
import type { RepositoryTrust } from './trusted-owners.ts';
import {
  levelOf,
  parseWorkKey,
  WORK_LEVELS,
  type CiState,
  type IssueState,
  type LinkedPullRequest,
  type WorkLevel,
  type WorkNode,
} from './work.ts';

// ----------

/** The six columns, in lifecycle order; label and criterion are on-screen text (pt-BR), carried as data. */
export const WORK_BOARD_COLUMNS = [
  { id: 'planning', label: 'Planejamento', criterion: 'Aberta, sem sessão de execução e fora da fila' },
  { id: 'queued', label: 'Na fila', criterion: 'Planejada e posta na fila; espera vaga' },
  { id: 'running', label: 'Em execução', criterion: 'Sessão da Athena trabalhando' },
  { id: 'review', label: 'Em review', criterion: 'PR aberto esperando o Argos' },
  { id: 'blocked', label: 'Bloqueado', criterion: 'Precisa de você, 3 rodadas ou CI falhou' },
  { id: 'done', label: 'Concluído', criterion: 'PR mergeado ou issue fechada' },
] as const;
export type WorkBoardColumn = (typeof WORK_BOARD_COLUMNS)[number]['id'];

/** Why a card is blocked; this order is also the sort order inside Bloqueado. */
export const WORK_BLOCKED_REASONS = [
  { id: 'needs-you', label: 'Precisa de você' },
  { id: 'review-rounds', label: 'Mudança pedida depois de 3 rodadas' },
  { id: 'ci-failed', label: 'CI falhou' },
] as const;
export type WorkBlockedReason = (typeof WORK_BLOCKED_REASONS)[number]['id'];

/** Review rounds the agency loop runs before it needs the person (develop → Argos, at most three). */
export const REVIEW_ROUNDS_LIMIT = 3;
/** Done cards older than this leave the board, so Concluído does not grow forever. */
export const DONE_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

/** GitHub issue type → the filter slug. Types not listed have no slug and never match a type filter. */
export const WORK_TYPE_SLUGS = {
  'User Story': 'story',
  Story: 'story',
  Feature: 'story',
  Task: 'task',
  'Tech Task': 'task',
  Spike: 'spike',
  Bug: 'bug',
  Epic: 'epic',
  'Epic / Milestone': 'epic',
  Milestone: 'epic',
  Initiative: 'initiative',
  Plan: 'plan',
} as const;
export type WorkTypeSlug = (typeof WORK_TYPE_SLUGS)[keyof typeof WORK_TYPE_SLUGS];
/** The slugs in the order the type dropdown lists them. */
export const WORK_TYPE_SLUG_ORDER: readonly WorkTypeSlug[] = ['initiative', 'epic', 'story', 'task', 'spike', 'bug', 'plan'];

export function typeSlugOf(type: string | null): WorkTypeSlug | null {
  return type && Object.hasOwn(WORK_TYPE_SLUGS, type) ? WORK_TYPE_SLUGS[type as keyof typeof WORK_TYPE_SLUGS] : null;
}

/** The status filter value for the items without Project Status. */
export const NO_STATUS_SLUG = 'no-status';
/** On-screen name of that option, the same as the Project kanban lane. */
export const NO_STATUS_NAME = 'Sem status';

/** #466 Status option name → URL slug: diacritics stripped, lower case, each run of other characters one dash, trimmed. */
export function statusSlug(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** #466 Status option id → its slug and name. */
export type WorkStatusIndex = ReadonlyMap<string, { id: string; name: string }>;

/**
 * #466 the slug of every Status option, unique and never empty, so each option can be kept in the URL. A name
 * with no ASCII left falls back to `status-<id>`; a slug already taken, `no-status` included, gets the
 * option id appended, then a number, in Project order.
 */
export function statusIndex(options: readonly WorkBoardStatusOption[]): WorkStatusIndex {
  const taken = new Set<string>([NO_STATUS_SLUG]);
  const out = new Map<string, { id: string; name: string }>();
  for (const { id, name } of options) {
    const idSlug = statusSlug(id);
    const base = statusSlug(name) || `status-${idSlug || codePoints(name) || 'option'}`;
    let slug = taken.has(base) && idSlug ? `${base}-${idSlug}` : base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.set(id, { id: slug, name });
  }
  return out;
}

const codePoints = (text: string): string => [...text].map((c) => c.codePointAt(0)!.toString(16)).join('-');

// ----------

/** What a linked session is doing: needs the person, an agent acting, or nothing. */
export type WorkSessionState = 'working' | 'needs-you' | 'idle';

/** A live Console session linked to an issue (by branch, or by the first reference in its first prompt). */
export interface WorkSessionLink {
  sessionId: string;
  key: string;
  state: WorkSessionState;
  since: string;
  /**
   * #507 a planning-only session ("Planejar", work-plan.ts): it is no execution, so it never moves the card
   * out of Planejamento; the board turns it into the card's `planning` state instead. Absent otherwise.
   */
  planning?: true;
  /**
   * #531 the session of an execution run ("Executar plano", work-execution.ts): the board settles the run
   * against it, which clears the card's boot state. It is a normal session for the column. Absent otherwise.
   */
  execution?: true;
}

/** #507 the planning state of a card: its planning session runs, or the last one ended without a plan (`reason` is pt-BR on-screen text). */
export type WorkCardPlanning = { state: 'running' } | { state: 'failed'; reason: string };

/** #531 the execution state of a card: its run opened a session that has not started yet (the screen says "subindo…"). */
export type WorkCardExecution = { state: 'booting' };

export interface IssueSignals {
  state: IssueState;
  /** #465 the PR that closes the issue, with `mergedAt` and `changesRequested` when known. */
  pullRequest: LinkedPullRequest | null;
  sessions: readonly WorkSessionState[];
  /** #531 a run of "Executar plano" whose session is still booting: it counts as an agent working. */
  executing?: boolean;
  /** #477 1-based position in the execution queue; `null` out of it. */
  queuePosition: number | null;
}

export interface ColumnResult {
  column: WorkBoardColumn;
  /** #465 set exactly when `column` is `blocked`. */
  blocked: WorkBlockedReason | null;
}

const at = (column: WorkBoardColumn, blocked: WorkBlockedReason | null = null): ColumnResult => ({ column, blocked });
const failedCi = (ci: CiState | null): boolean => ci === 'FAILURE' || ci === 'ERROR';

/**
 * Column of a leaf (an item or a plan, or an epic/initiative with no children on the board), by the
 * precedence of the epic #464 table, first match wins:
 * 1. done — issue closed or PR merged: nothing else matters once the work landed;
 * 2. blocked/needs-you — a session waits for the person, the most urgent thing on the board;
 * 3. running — an agent is working, or its session is still booting (#531); it may be fixing the CI or the review, so that is not blocked yet;
 * 4. blocked/review-rounds — changes requested after `REVIEW_ROUNDS_LIMIT` rounds: the loop is exhausted;
 * 5. blocked/ci-failed — the open PR's last commit failed;
 * 6. review — an open PR, draft or not;
 * 7. queued — in the execution queue;
 * 8. planning.
 * Two sessions resolve to the most advanced one through 2 and 3; an idle session never moves the card.
 */
export function columnOfIssue({ state, pullRequest: pr, sessions, executing = false, queuePosition }: IssueSignals): ColumnResult {
  if (state === 'CLOSED' || pr?.state === 'MERGED') return at('done');
  if (sessions.includes('needs-you')) return at('blocked', 'needs-you');
  if (sessions.includes('working') || executing) return at('running');
  const open = pr?.state === 'OPEN' ? pr : null;
  if (open?.review === 'CHANGES_REQUESTED' && (open.changesRequested ?? 0) >= REVIEW_ROUNDS_LIMIT) return at('blocked', 'review-rounds');
  if (open && failedCi(open.ci)) return at('blocked', 'ci-failed');
  if (open) return at('review');
  if (queuePosition !== null) return at('queued');
  return at('planning');
}

const reasonRank = (r: WorkBlockedReason): number => WORK_BLOCKED_REASONS.findIndex((x) => x.id === r);

/**
 * Column of an epic or initiative from its direct children (epic #464 table, wireframe `WB_EPICS`):
 * closed itself → done; any child blocked → blocked, with the first reason in reason order, because one
 * stuck child holds the whole epic; all done → done; then the most advanced activity: running, review,
 * queued; else planning.
 */
export function columnOfParent(state: IssueState, children: readonly ColumnResult[]): ColumnResult {
  if (state === 'CLOSED') return at('done');
  const reasons = children.flatMap((c) => (c.blocked ? [c.blocked] : []));
  if (reasons.length) return at('blocked', reasons.sort((a, b) => reasonRank(a) - reasonRank(b))[0]);
  const has = (column: WorkBoardColumn) => children.some((c) => c.column === column);
  if (children.every((c) => c.column === 'done')) return at('done');
  for (const column of ['running', 'review', 'queued'] as const) if (has(column)) return at(column);
  return at('planning');
}

// ----------

export type WorkCardCi = 'ok' | 'failed' | 'running';
export type WorkCardReview = 'approved' | 'changes-requested' | 'pending';

// #465 a copy of the panel's `ciDoPr`/`reviewDoPr` value sets (src/api/work.ts): the domain must not import src/api.
const cardCi = (ci: CiState | null): WorkCardCi | null => (!ci ? null : ci === 'SUCCESS' ? 'ok' : failedCi(ci) ? 'failed' : 'running');
const cardReview = (p: LinkedPullRequest): WorkCardReview | null =>
  p.review === 'APPROVED' ? 'approved' : p.review === 'CHANGES_REQUESTED' ? 'changes-requested' : p.state === 'OPEN' ? 'pending' : null;

// ----------

/**
 * An initiative or epic filter value: a bare number (the wireframe's URL form, matching that number in any
 * repo) or an issue key `owner/name#n` (matching that issue only, when two repos share the number).
 */
export type WorkAncestorFilter = number | string;

export interface WorkBoardFilters {
  level: WorkLevel;
  initiative: WorkAncestorFilter | null;
  epic: WorkAncestorFilter | null;
  type: WorkTypeSlug | null;
  label: string | null;
  repo: string | null;
  status: string | null;
}
export type WorkBoardFilterParam = keyof WorkBoardFilters;
export interface WorkBoardFilterError {
  error: 'bad-filter';
  param: WorkBoardFilterParam;
}

export const DEFAULT_WORK_BOARD_FILTERS: Readonly<WorkBoardFilters> = {
  level: 'item',
  initiative: null,
  epic: null,
  type: null,
  label: null,
  repo: null,
  status: null,
};

/** The URL query (English params, one value each) → filters; an empty value is unset. */
export function parseWorkBoardFilters(query: URLSearchParams): WorkBoardFilters | WorkBoardFilterError {
  const text = (p: WorkBoardFilterParam) => query.get(p)?.trim() || null;
  const bad = (param: WorkBoardFilterParam): WorkBoardFilterError => ({ error: 'bad-filter', param });
  const level = text('level') ?? DEFAULT_WORK_BOARD_FILTERS.level;
  if (!(WORK_LEVELS as readonly string[]).includes(level)) return bad('level');
  const ancestors: Record<'initiative' | 'epic', WorkAncestorFilter | null> = { initiative: null, epic: null };
  for (const p of ['initiative', 'epic'] as const) {
    const v = text(p);
    if (v === null) continue;
    const parsed = parseAncestorFilter(v);
    if (parsed === null) return bad(p);
    ancestors[p] = parsed;
  }
  const type = text('type');
  if (type !== null && !WORK_TYPE_SLUG_ORDER.includes(type as WorkTypeSlug)) return bad('type');
  return { level: level as WorkLevel, ...ancestors, type: type as WorkTypeSlug | null, label: text('label'), repo: text('repo'), status: text('status') };
}

/** #466 `<n>` → n; `owner/name#<n>` → the key, normalised; anything else → `null`. */
function parseAncestorFilter(v: string): WorkAncestorFilter | null {
  if (/^[1-9]\d*$/.test(v)) return Number(v);
  const m = /^([^/#\s]+\/[^/#\s]+)#([1-9]\d*)$/.exec(v);
  return m ? `${m[1]}#${Number(m[2])}` : null;
}

export const isWorkBoardFilterError = (f: WorkBoardFilters | WorkBoardFilterError): f is WorkBoardFilterError => 'error' in f;

// ----------

/** One issue as the board reads it: a Project card, or a parent resolved outside the Project. */
export interface WorkBoardNode {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  type: string | null;
  parent: string | null;
  labels: readonly string[];
  milestone: string | null;
  closedAt: string | null;
  statusId: string | null;
  subIssues: { total: number; completed: number } | null;
  pullRequest: LinkedPullRequest | null;
  /** #465 `false` for a parent resolved outside the Project: it gives the chain, the level and the filters, never a card. */
  inProject: boolean;
}

export interface WorkBoardStatusOption {
  id: string;
  name: string;
}

export interface WorkBoardInput {
  project: { owner: string; number: number; title: string; url: string };
  statuses: readonly WorkBoardStatusOption[];
  nodes: readonly WorkBoardNode[];
  sessions: readonly WorkSessionLink[];
  queue: ReadonlyMap<string, number>;
  queueAvailable: boolean;
  since: ReadonlyMap<string, string>;
  filters: WorkBoardFilters;
  analyzed?: ReadonlyMap<string, AnalyzedWorkNode>;
  /** #507 the planning state per issue key, lower case; a key without one is `null` on its card. */
  planning?: ReadonlyMap<string, WorkCardPlanning>;
  /** #531 the execution state per issue key, lower case: the keys with a booting run; a key without one is `null` on its card. */
  execution?: ReadonlyMap<string, WorkCardExecution>;
  /** #594 whose repositories are trusted: each card says whether its own is. Required, so no caller trusts by default. */
  trust: RepositoryTrust;
  now: number;
  fetchedAt: number;
  stale: boolean;
  /** #495 a stable English code (`StaleCode`), never GitHub's raw message; the screen translates it. */
  staleReason: StaleCode | null;
  /**
   * #496 epoch ms of the core's next GitHub read while the board is stale: the end of the rate-limit pause,
   * else the next scheduled read of the Project. `null` when the board is not stale or no read is scheduled.
   */
  retryAt: number | null;
}

export interface WorkChainLink {
  key: string;
  number: number;
  /** #465 `null` when the parent never arrived from GitHub. */
  title: string | null;
  level: WorkLevel;
}

export interface WorkChildrenSummary {
  total: number;
  done: number;
  byColumn: Partial<Record<WorkBoardColumn, number>>;
  blocked: Partial<Record<WorkBlockedReason, number>>;
}

export interface WorkBoardCard {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  level: WorkLevel;
  type: WorkTypeSlug | null;
  typeName: string | null;
  state: 'open' | 'closed';
  /** #594 the owner of the repository is trusted: the core opens Planejar and Executar plano sessions for it. */
  trusted: boolean;
  column: WorkBoardColumn;
  columnSince: string | null;
  parent: { key: string; number: number } | null;
  chain: WorkChainLink[];
  projectStatus: { id: string; name: string } | null;
  labels: string[];
  milestone: string | null;
  /** #465 an item with sub-issues: its children are plan steps. */
  plan: { steps: number } | null;
  /** #507 `running` while the planning session runs (the screen says "planejando…"), `failed` with its reason once it ended without a plan; `null` otherwise. */
  planning: WorkCardPlanning | null;
  /** #531 `booting` while the run's session has not started (the screen says "subindo…"), in Em execução; `null` otherwise. */
  execution: WorkCardExecution | null;
  sessions: { count: number; state: WorkSessionState | null; ids: string[] };
  pullRequest: {
    number: number;
    url: string;
    state: 'open' | 'draft' | 'merged' | 'closed';
    ci: WorkCardCi | null;
    review: WorkCardReview | null;
    changesRequested: number;
  } | null;
  blocked: { reason: WorkBlockedReason; label: string } | null;
  queuePosition: number | null;
  doneAt: string | null;
  doneBy: 'merged' | 'closed' | null;
  children: WorkChildrenSummary | null;
}

export interface WorkBoardColumnView {
  id: WorkBoardColumn;
  label: string;
  criterion: string;
  count: number;
  cards: WorkBoardCard[];
}

/** An initiative or epic in a dropdown, by key: two repos may hold the same number. */
export interface WorkAncestorOption {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  count: number;
}

export interface WorkBoardOptions {
  initiatives: WorkAncestorOption[];
  epics: WorkAncestorOption[];
  types: { id: WorkTypeSlug; count: number }[];
  labels: { name: string; count: number }[];
  repos: { name: string; count: number }[];
  statuses: { id: string; name: string; count: number }[];
}

export interface WorkBoardView {
  project: WorkBoardInput['project'] & { primaryRepo: string | null };
  filters: WorkBoardFilters;
  levels: WorkLevel[];
  columns: WorkBoardColumnView[];
  blockedReasons: { id: WorkBlockedReason; label: string }[];
  doneWindowDays: number;
  queue: { available: boolean };
  options: WorkBoardOptions;
  /** #466 nodes of the level before the filters. */
  total: number;
  /** #466 nodes of the level after the filters (the done window only trims the columns). */
  matched: number;
  /** #501 for each active filter, the cards the board would show without that filter (the done window still applies). */
  countsWithoutFilter: Partial<Record<FilterKey, number>>;
  fetchedAt: number;
  stale: boolean;
  /** #495 a stable English code (`StaleCode`), never GitHub's raw message; the screen translates it. */
  staleReason: StaleCode | null;
  /**
   * #496 epoch ms of the core's next GitHub read while the board is stale: the end of the rate-limit pause,
   * else the next scheduled read of the Project. `null` when the board is not stale or no read is scheduled.
   */
  retryAt: number | null;
}

/** A node with everything derived from the graph: level, ancestors, column, sessions and children. */
export interface AnalyzedWorkNode {
  node: WorkBoardNode;
  level: WorkLevel;
  chain: WorkChainLink[];
  column: ColumnResult;
  sessions: WorkSessionLink[];
  queuePosition: number | null;
  doneAt: string | null;
  doneBy: 'merged' | 'closed' | null;
  children: WorkChildrenSummary | null;
}

const sessionRank: Record<WorkSessionState, number> = { 'needs-you': 0, working: 1, idle: 2 };

/**
 * Levels top-down (as `buildTree`), columns bottom-up. A parent that did not arrive makes its child a root
 * for the level, as in the tree; a cycle (should not exist on GitHub) is cut where it closes.
 */
export function analyzeWorkNodes(
  nodes: readonly WorkBoardNode[],
  sessions: readonly WorkSessionLink[],
  queue: ReadonlyMap<string, number>,
  /** #531 the issue keys, lower case, whose execution run is still booting. */
  executing: ReadonlySet<string> = new Set(),
): Map<string, AnalyzedWorkNode> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const childrenOf = new Map<string, WorkBoardNode[]>();
  for (const n of nodes) if (n.parent && byKey.has(n.parent) && !closesCycle(byKey, n)) childrenOf.set(n.parent, [...(childrenOf.get(n.parent) ?? []), n]);
  // #465 #477 session and queue keys may differ in case from GitHub's `nameWithOwner`: compare lower case.
  const sessionsOf = new Map<string, WorkSessionLink[]>();
  for (const s of sessions) sessionsOf.set(s.key.toLowerCase(), [...(sessionsOf.get(s.key.toLowerCase()) ?? []), s]);
  const queueOf = new Map([...queue].map(([key, position]) => [key.toLowerCase(), position]));

  const levels = new Map<string, WorkLevel>();
  const levelFor = (n: WorkBoardNode): WorkLevel => {
    let level = levels.get(n.key);
    if (!level) {
      const parent = n.parent && byKey.has(n.parent) && !closesCycle(byKey, n) ? byKey.get(n.parent)! : null;
      level = levelOf(n.type, parent ? levelFor(parent) : null);
      levels.set(n.key, level);
    }
    return level;
  };

  const out = new Map<string, AnalyzedWorkNode>();
  const analyze = (n: WorkBoardNode): AnalyzedWorkNode => {
    const hit = out.get(n.key);
    if (hit) return hit;
    const level = levelFor(n);
    const linked = sessionsOf.get(n.key.toLowerCase()) ?? [];
    const queuePosition = queueOf.get(n.key.toLowerCase()) ?? null;
    const kids = (childrenOf.get(n.key) ?? []).map(analyze);
    const rollsUp = kids.length > 0 && (level === 'initiative' || level === 'epic');
    const column = rollsUp
      ? columnOfParent(n.state, kids.map((c) => c.column))
      : columnOfIssue({ state: n.state, pullRequest: n.pullRequest, sessions: linked.map((s) => s.state), executing: executing.has(n.key.toLowerCase()), queuePosition });
    const done = column.column === 'done' ? doneOf(n) : { doneAt: null, doneBy: null };
    const a: AnalyzedWorkNode = { node: n, level, chain: chainOf(byKey, n, level, levelFor), column, sessions: linked, queuePosition, ...done, children: kids.length ? summarize(kids) : null };
    out.set(n.key, a);
    return a;
  };
  for (const n of nodes) analyze(n);
  return out;
}

function closesCycle(byKey: ReadonlyMap<string, WorkBoardNode>, start: WorkBoardNode): boolean {
  const seen = new Set([start.key]);
  for (let p = start.parent; p; p = byKey.get(p)?.parent ?? null) {
    if (seen.has(p)) return p === start.key;
    seen.add(p);
  }
  return false;
}

function doneOf(n: WorkBoardNode): Pick<AnalyzedWorkNode, 'doneAt' | 'doneBy'> {
  if (n.pullRequest?.state === 'MERGED') return { doneAt: n.pullRequest.mergedAt ?? n.closedAt, doneBy: 'merged' };
  if (n.state === 'CLOSED') return { doneAt: n.closedAt, doneBy: 'closed' };
  // #465 done by the rollup of its children while the epic itself is still open.
  return { doneAt: null, doneBy: null };
}

/**
 * #465 ancestors, root first. A parent that never arrived stays as a link with no title; its level is
 * taken as one above the child's, the only thing known about it.
 */
function chainOf(byKey: ReadonlyMap<string, WorkBoardNode>, n: WorkBoardNode, level: WorkLevel, levelFor: (n: WorkBoardNode) => WorkLevel): WorkChainLink[] {
  const chain: WorkChainLink[] = [];
  const seen = new Set([n.key]);
  let childLevel = level;
  for (let key = n.parent; key && !seen.has(key); ) {
    seen.add(key);
    const p = byKey.get(key);
    const pLevel = p ? levelFor(p) : WORK_LEVELS[Math.max(WORK_LEVELS.indexOf(childLevel) - 1, 0)];
    chain.unshift({ key, number: p?.number ?? parseWorkKey(key).number, title: p?.title ?? null, level: pLevel });
    childLevel = pLevel;
    key = p?.parent ?? null;
  }
  return chain;
}

function summarize(kids: readonly AnalyzedWorkNode[]): WorkChildrenSummary {
  const s: WorkChildrenSummary = { total: kids.length, done: 0, byColumn: {}, blocked: {} };
  for (const { column } of kids) {
    s.byColumn[column.column] = (s.byColumn[column.column] ?? 0) + 1;
    if (column.column === 'done') s.done++;
    if (column.blocked) s.blocked[column.blocked] = (s.blocked[column.blocked] ?? 0) + 1;
  }
  return s;
}

/** What the column history observes for each node: its column, since when the work landed for done, else now. */
export interface WorkColumnObservation {
  key: string;
  column: WorkBoardColumn;
  at: string;
}

/** Only the Project's issues have a time in column: a parent outside the Project is never a card. */
export function columnObservations(analyzed: ReadonlyMap<string, AnalyzedWorkNode>, now: number): WorkColumnObservation[] {
  const nowIso = new Date(now).toISOString();
  return [...analyzed.values()].filter((a) => a.node.inProject).map((a) => ({ key: a.node.key, column: a.column.column, at: a.doneAt ?? nowIso }));
}

// ----------

type FilterKey = Exclude<WorkBoardFilterParam, 'level'>;
const FILTER_KEYS: readonly FilterKey[] = ['initiative', 'epic', 'type', 'label', 'repo', 'status'];

/** #466 an option that left the Project counts as no Status, as in the kanban lanes. */
function statusOf(n: WorkBoardNode, statuses: WorkStatusIndex): { id: string; name: string } | null {
  return (n.statusId && statuses.get(n.statusId)) || null;
}

/** #466 the node itself and its ancestors at `level`: the initiative and epic filters match either. */
const lineageAt = (a: AnalyzedWorkNode, level: WorkLevel): WorkChainLink[] => [
  ...a.chain.filter((c) => c.level === level),
  ...(a.level === level ? [{ key: a.node.key, number: a.node.number, title: a.node.title, level }] : []),
];

function matchesAncestor(a: AnalyzedWorkNode, level: 'initiative' | 'epic', want: WorkAncestorFilter | null): boolean {
  if (want === null) return true;
  const lineage = lineageAt(a, level);
  if (typeof want === 'number') return lineage.some((c) => c.number === want);
  return lineage.some((c) => c.key.toLowerCase() === want.toLowerCase());
}

function matchesFilter(a: AnalyzedWorkNode, key: FilterKey, f: WorkBoardFilters, statuses: WorkStatusIndex): boolean {
  const n = a.node;
  switch (key) {
    case 'initiative':
      return matchesAncestor(a, 'initiative', f.initiative);
    case 'epic':
      return matchesAncestor(a, 'epic', f.epic);
    case 'type':
      return f.type === null || typeSlugOf(n.type) === f.type;
    case 'label':
      return f.label === null || n.labels.some((l) => l.toLowerCase() === f.label!.toLowerCase());
    case 'repo': {
      if (f.repo === null) return true;
      const want = f.repo.toLowerCase();
      return n.repo.toLowerCase() === want || n.repo.split('/')[1]?.toLowerCase() === want;
    }
    case 'status':
      return f.status === null || (statusOf(n, statuses)?.id ?? NO_STATUS_SLUG) === f.status;
  }
}

/** Whether the node passes every filter, or every filter but `except` (for the dropdown counts). */
export function matchesWorkBoardFilters(a: AnalyzedWorkNode, f: WorkBoardFilters, statuses: WorkStatusIndex, except?: FilterKey): boolean {
  return FILTER_KEYS.every((key) => key === except || matchesFilter(a, key, f, statuses));
}

// ----------

/** The whole board from plain inputs: the use case only loads them. */
export function buildWorkBoard(input: WorkBoardInput): WorkBoardView {
  const { nodes, filters, now } = input;
  const statuses = statusIndex(input.statuses);
  const analyzed = input.analyzed ?? analyzeWorkNodes(nodes, input.sessions, input.queue, new Set(input.execution?.keys() ?? []));
  const ofLevel = [...analyzed.values()].filter((a) => a.node.inProject && a.level === filters.level);
  const matched = ofLevel.filter((a) => matchesWorkBoardFilters(a, filters, statuses));
  const windowStart = now - DONE_WINDOW_DAYS * DAY_MS;
  const sinceOf = (a: AnalyzedWorkNode) => input.since.get(a.node.key) ?? null;
  // #465 a done card with no `doneAt` (an epic done by rollup, an old cache row) ages out by its column time.
  const doneTime = (a: AnalyzedWorkNode) => a.doneAt ?? sinceOf(a);
  const inDoneWindow = (a: AnalyzedWorkNode) => a.column.column !== 'done' || !doneTime(a) || Date.parse(doneTime(a)!) >= windowStart;
  const shown = matched.filter(inDoneWindow);
  const countsWithoutFilter: Partial<Record<FilterKey, number>> = {};
  for (const key of FILTER_KEYS) {
    if (filters[key] === null) continue;
    countsWithoutFilter[key] = ofLevel.filter((a) => matchesWorkBoardFilters(a, filters, statuses, key) && inDoneWindow(a)).length;
  }
  const cards = shown.map((a) => toCard(a, sinceOf(a), statuses, input.planning?.get(a.node.key.toLowerCase()) ?? null, input.execution?.get(a.node.key.toLowerCase()) ?? null, input.trust.isTrusted(a.node.repo)));

  return {
    project: { ...input.project, primaryRepo: mostFrequent(nodes.filter((n) => n.inProject).map((n) => n.repo)) },
    filters: { ...filters },
    levels: [...WORK_LEVELS],
    columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
      const inColumn = cards.filter((c) => c.column === id).sort(ORDER[id]);
      return { id, label, criterion, count: inColumn.length, cards: inColumn };
    }),
    blockedReasons: WORK_BLOCKED_REASONS.map(({ id, label }) => ({ id, label })),
    doneWindowDays: DONE_WINDOW_DAYS,
    queue: { available: input.queueAvailable },
    options: optionsOf(ofLevel, filters, statuses),
    total: ofLevel.length,
    matched: matched.length,
    countsWithoutFilter,
    fetchedAt: input.fetchedAt,
    stale: input.stale,
    staleReason: input.staleReason,
    retryAt: input.retryAt,
  };
}

function toCard(a: AnalyzedWorkNode, columnSince: string | null, statuses: WorkStatusIndex, planning: WorkCardPlanning | null, execution: WorkCardExecution | null, trusted: boolean): WorkBoardCard {
  const n = a.node;
  const parent = a.chain.at(-1);
  const best = [...a.sessions].sort((x, y) => sessionRank[x.state] - sessionRank[y.state])[0];
  const reason = a.column.blocked ? WORK_BLOCKED_REASONS.find((r) => r.id === a.column.blocked)! : null;
  return {
    key: n.key,
    repo: n.repo,
    number: n.number,
    title: n.title,
    url: n.url,
    level: a.level,
    type: typeSlugOf(n.type),
    typeName: n.type,
    state: n.state === 'CLOSED' ? 'closed' : 'open',
    trusted,
    column: a.column.column,
    columnSince,
    parent: parent ? { key: parent.key, number: parent.number } : null,
    chain: a.chain,
    projectStatus: statusOf(n, statuses),
    labels: [...n.labels],
    milestone: n.milestone,
    plan: a.level === 'item' && n.subIssues ? { steps: n.subIssues.total } : null,
    planning,
    execution,
    sessions: { count: a.sessions.length, state: best?.state ?? null, ids: a.sessions.map((s) => s.sessionId) },
    pullRequest: n.pullRequest ? cardPullRequest(n.pullRequest) : null,
    blocked: reason ? { reason: reason.id, label: reason.label } : null,
    queuePosition: a.queuePosition,
    doneAt: a.doneAt,
    doneBy: a.doneBy,
    children: a.children,
  };
}

function cardPullRequest(p: LinkedPullRequest): NonNullable<WorkBoardCard['pullRequest']> {
  const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open';
  return { number: p.number, url: p.url, state, ci: cardCi(p.ci), review: cardReview(p), changesRequested: p.changesRequested ?? 0 };
}

// #465 order inside each column, as the wireframe: unknown times go last; ties by number.
type CardOrder = (a: WorkBoardCard, b: WorkBoardCard) => number;
const time = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const nullsLast = (x: number | null, y: number | null, cmp: (x: number, y: number) => number): number =>
  x === null ? (y === null ? 0 : 1) : y === null ? -1 : cmp(x, y);
const byNumber: CardOrder = (a, b) => a.number - b.number;
const newestSince: CardOrder = (a, b) => nullsLast(time(a.columnSince), time(b.columnSince), (x, y) => y - x) || byNumber(a, b);
const oldestSince: CardOrder = (a, b) => nullsLast(time(a.columnSince), time(b.columnSince), (x, y) => x - y) || byNumber(a, b);
const ORDER: Record<WorkBoardColumn, CardOrder> = {
  planning: newestSince,
  queued: (a, b) => nullsLast(a.queuePosition, b.queuePosition, (x, y) => x - y) || byNumber(a, b),
  running: oldestSince,
  review: oldestSince,
  blocked: (a, b) => reasonRank(a.blocked!.reason) - reasonRank(b.blocked!.reason) || oldestSince(a, b),
  done: (a, b) => nullsLast(time(a.doneAt), time(b.doneAt), (x, y) => y - x) || byNumber(a, b),
};

function mostFrequent(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * #466 each dropdown value is counted over the nodes of the level that match all the OTHER filters, so a
 * dropdown says how many would remain if it changed (and "no result" can say how to clear it).
 */
function optionsOf(ofLevel: readonly AnalyzedWorkNode[], filters: WorkBoardFilters, statuses: WorkStatusIndex): WorkBoardOptions {
  const pool = (except: FilterKey) => ofLevel.filter((a) => matchesWorkBoardFilters(a, filters, statuses, except));
  const lineage = (level: 'initiative' | 'epic'): WorkAncestorOption[] => {
    const found = tally(pool(level).flatMap((a) => lineageAt(a, level).map((c) => [c.key, c.title] as const)));
    return found
      .map(([key, title, count]) => {
        const { repo, number } = parseWorkKey(key);
        return { key, repo, number, title, count };
      })
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  };
  const types = tally(pool('type').flatMap((a) => {
    const slug = typeSlugOf(a.node.type);
    return slug ? [[slug, null] as const] : [];
  }));
  // #466 labels match case-insensitively, so their spellings count together under the first one seen.
  const labels = tally(pool('label').flatMap((a) => uniqueBy(a.node.labels, (l) => l.toLowerCase()).map((l) => [l.toLowerCase(), l] as const)));
  const statusPool = pool('status');
  const statusCount = (slug: string) => statusPool.filter((a) => (statusOf(a.node, statuses)?.id ?? NO_STATUS_SLUG) === slug).length;
  const noStatus = statusCount(NO_STATUS_SLUG);
  return {
    initiatives: lineage('initiative'),
    epics: lineage('epic'),
    types: types.map(([id, , count]) => ({ id: id as WorkTypeSlug, count })).sort((a, b) => WORK_TYPE_SLUG_ORDER.indexOf(a.id) - WORK_TYPE_SLUG_ORDER.indexOf(b.id)),
    labels: labels.map(([, name, count]) => ({ name: name!, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    repos: tally(pool('repo').map((a) => [a.node.repo, null] as const)).map(([name, , count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    statuses: [
      ...[...statuses.values()].map(({ id, name }) => ({ id, name, count: statusCount(id) })),
      ...(noStatus ? [{ id: NO_STATUS_SLUG, name: NO_STATUS_NAME, count: noStatus }] : []),
    ],
  };
}

function tally(pairs: readonly (readonly [string, string | null])[]): [string, string | null, number][] {
  const out = new Map<string, [string, string | null, number]>();
  for (const [id, display] of pairs) {
    const hit = out.get(id);
    if (hit) hit[2]++;
    else out.set(id, [id, display, 1]);
  }
  return [...out.values()];
}

function uniqueBy<T>(list: readonly T[], keyOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(keyOf(t)) && seen.add(keyOf(t)));
}

// ----------

/*
 * #465 leftmost match wins, so the first reference in the prompt is the one that counts: a github.com issue
 * or pull URL, `owner/name#n`, or a bare `#n` (not inside a word, a path or an HTML entity like `&#123;`).
 */
const ISSUE_REFERENCE =
  /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)(?!\w)|(?<![\w&#/])#(\d+)(?!\w)/;

/** The issue key a session's first prompt points to: its first reference only; a bare `#n` needs the session's repo. */
export function issueOfPrompt(text: string, sessionRepo: string | null): string | null {
  const m = ISSUE_REFERENCE.exec(text);
  if (!m) return null;
  if (m[1]) return `${m[1]}/${m[2]}#${Number(m[3])}`;
  if (m[4]) return `${m[4]}/${m[5]}#${Number(m[6])}`;
  return sessionRepo ? `${sessionRepo}#${Number(m[7])}` : null;
}

// ----------

/** The chosen Project's board: what `GithubProject` already is (ADR-0001 cache, ADR-0015 snapshot). */
export interface WorkProjectBoard {
  board(options?: { force?: boolean }): Promise<ProjectBoard>;
  snapshot?(): Promise<ProjectBoard | null>;
}

/** The live sessions linked to issues. */
export interface WorkSessions {
  links(): Promise<WorkSessionLink[]>;
}

/** The execution queue (#477); until it exists, `EMPTY_WORK_QUEUE`. Its keys are compared in lower case. */
export interface WorkQueue {
  readonly available: boolean;
  positions(): Promise<ReadonlyMap<string, number>>;
}

export const EMPTY_WORK_QUEUE: WorkQueue = Object.freeze({ available: false, positions: async () => new Map<string, number>() });

/**
 * Keeps, per issue key, the current column and since when: the same column keeps its time, a different
 * one restarts it at the observation's `at`. Returns key → since (ISO).
 */
export interface WorkColumnHistory {
  observe(observations: readonly WorkColumnObservation[]): Promise<Map<string, string>>;
}

/** Parents cited by Project issues but not in the Project: one batched read, ancestors included. */
export interface ParentLookup {
  nodes(keys: readonly string[]): Promise<WorkNode[]>;
}
