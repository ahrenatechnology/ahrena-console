// Dev Console (decision 0008, section 4): the domain, with no GitHub, no session reads and no HTTP.
// Everything here is derived from facts already read (PRs, issues, remote branches and the
// context's sessions); nothing is annotated by hand. Pure functions: reading and serving live outside.

import { issueDoBranch } from '../api/trabalho.ts';
import type { CiState, ReviewDecision } from '../github/work.ts';

// ---------- facts read from GitHub ----------

/** GitHub's `mergeable`: `UNKNOWN` while GitHub is still computing it. */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface PullRequestFact {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: Mergeable;
  /** `mergeStateStatus`: `BEHIND` when the base moved on and branch protection requires an up-to-date branch. */
  mergeStateStatus: string | null;
  baseRefName: string;
  headRefName: string;
  /** The branch comes from a fork: `headRefName` belongs to the fork, so nothing stacks on it. */
  isCrossRepository: boolean;
  createdAt: string;
  /** `statusCheckRollup.state` of the last commit; `null` when there are no checks. */
  ci: CiState | null;
  review: ReviewDecision | null;
  /** Issues the PR closes (`closingIssuesReferences`), same repository only. */
  closes: number[];
}

export interface MergedPullRequestFact {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export interface IssueFact {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  /** Closed issues only. */
  closedAt: string | null;
}

// ---------- facts read from the sessions ----------

/** A live session in one of the context's repositories. */
export interface ContextSession {
  id: string;
  title: string;
  repo: string;
  branch: string | null;
  /** Working now (not waiting on you and not stopped on an error). */
  working: boolean;
  /** Needs you: one of the depends-on-you reasons (permission, question, plan, decision, error, interrupted). */
  waitingOnYou: boolean;
}

// ---------- what the Dev Console shows ----------

export const NOT_READY_REASONS = ['draft', 'conflict', 'checking', 'ci-failing', 'changes-requested', 'behind', 'ci-running', 'no-ci', 'stacked'] as const;
/**
 * Why an open PR is not in the queue, in priority order: the first reason is the one the screen
 * shows. `checking` (mergeable still `UNKNOWN`) sits right after `conflict`: both are about
 * mergeability, and a draft or a conflict says more than "GitHub is still computing".
 */
export type NotReadyReason = (typeof NOT_READY_REASONS)[number];

export type CiSummary = 'ok' | 'failing' | 'running' | null;

export interface QueueItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  ci: CiSummary;
  review: ReviewDecision | null;
  closes: number[];
  /** The open PR whose branch this one is based on (stacked), or `null`. */
  stackedOn: number | null;
}

export interface NotReadyItem extends QueueItem {
  reason: NotReadyReason;
  /** Every reason, in priority order. */
  reasons: NotReadyReason[];
}

export interface MergeQueue {
  ready: QueueItem[];
  notReady: NotReadyItem[];
}

export const BOARD_COLUMNS = ['todo', 'delegated', 'in-progress', 'in-review', 'blocked', 'done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export interface BoardCard {
  repo: string;
  number: number;
  title: string;
  url: string;
  session: { id: string; title: string; waitingOnYou: boolean } | null;
  pullRequest: { number: number; url: string; isDraft: boolean } | null;
  ci: CiSummary;
}

export type Board = Record<BoardColumn, BoardCard[]>;

export interface Scoreboard {
  ready: number;
  ciRunning: number;
  ciFailingOrConflict: number;
  sessionsWorking: number;
  waitingOnYou: number;
}

/** The labels of the `blocked` column (decision 0008, section 4), configurable in `dev-console.json`. */
export const DEFAULT_BLOCKED_LABELS: readonly string[] = ['blocked', 'bloqueada'];

/** A repository key: `owner/repo` in lower case, the way GitHub compares them. */
export const repoKey = (repo: string): string => repo.toLowerCase();
export const DONE_WINDOW_MS = 24 * 60 * 60_000;

export function ciSummary(ci: CiState | null): CiSummary {
  if (!ci) return null;
  if (ci === 'SUCCESS') return 'ok';
  if (ci === 'FAILURE' || ci === 'ERROR') return 'failing';
  return 'running';
}

const prKey = (repo: string, number: number) => `${repo}#${number}`;

/**
 * The open PR in the same repository whose branch is this PR's base: this one is stacked on it.
 * Only PRs from branches of the repository itself are indexed: a fork's `headRefName` (sometimes
 * `main`) is not a branch here.
 */
function stackBases(prs: readonly PullRequestFact[]): Map<string, PullRequestFact> {
  const byHead = new Map(prs.filter((p) => !p.isCrossRepository).map((p) => [`${p.repo}\0${p.headRefName}`, p]));
  const out = new Map<string, PullRequestFact>();
  for (const p of prs) {
    const base = byHead.get(`${p.repo}\0${p.baseRefName}`);
    if (base && base.number !== p.number) out.set(prKey(p.repo, p.number), base);
  }
  return out;
}

/** The PR's own reasons, ignoring the stack. Empty: ready on its own. */
export function ownReasons(p: PullRequestFact): NotReadyReason[] {
  const r: NotReadyReason[] = [];
  const ci = ciSummary(p.ci);
  if (p.isDraft) r.push('draft');
  if (p.mergeable === 'CONFLICTING') r.push('conflict');
  if (p.mergeable === 'UNKNOWN') r.push('checking');
  if (ci === 'failing') r.push('ci-failing');
  if (p.review === 'CHANGES_REQUESTED') r.push('changes-requested');
  if (p.mergeStateStatus === 'BEHIND') r.push('behind');
  if (ci === 'running') r.push('ci-running');
  if (ci === null) r.push('no-ci');
  return r;
}

const byAge = (a: { createdAt: string; repo: string; number: number }, b: { createdAt: string; repo: string; number: number }) =>
  a.createdAt.localeCompare(b.createdAt) || a.repo.localeCompare(b.repo) || a.number - b.number;

/**
 * The merge queue: ready PRs (CI green, no conflict, not draft, no changes requested, up to date
 * with the base), oldest first, with a stacked PR right after its base. A stacked PR only joins
 * if its base did; otherwise it stays out with `stacked`.
 *
 * `mergeable: 'UNKNOWN'` (GitHub still computing) is not ready: it stays out with `checking`.
 * GitHub computes it lazily, so the next read (the PR TTL, 60 s) brings the value.
 */
export function buildMergeQueue(prs: readonly PullRequestFact[]): MergeQueue {
  const bases = stackBases(prs);
  const own = new Map(prs.map((p) => [prKey(p.repo, p.number), ownReasons(p)]));
  // Ready: no reason of its own and, when stacked, a ready base (walking up the whole stack).
  const readyMemo = new Map<string, boolean>();
  const isReady = (p: PullRequestFact, seen = new Set<string>()): boolean => {
    const k = prKey(p.repo, p.number);
    const memo = readyMemo.get(k);
    if (memo !== undefined) return memo;
    if (seen.has(k)) return false; // branch cycle: nobody joins
    seen.add(k);
    const base = bases.get(k);
    const ok = own.get(k)!.length === 0 && (!base || isReady(base, seen));
    readyMemo.set(k, ok);
    return ok;
  };

  const item = (p: PullRequestFact): QueueItem => ({
    repo: p.repo,
    number: p.number,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    ci: ciSummary(p.ci),
    review: p.review,
    closes: [...p.closes],
    stackedOn: bases.get(prKey(p.repo, p.number))?.number ?? null,
  });

  // Order: ready roots oldest first; each followed by the PRs stacked on it, also oldest first.
  const ready = prs.filter((p) => isReady(p));
  const children = new Map<string, PullRequestFact[]>();
  const roots: PullRequestFact[] = [];
  for (const p of ready) {
    const base = bases.get(prKey(p.repo, p.number));
    if (base) {
      const k = prKey(base.repo, base.number);
      children.set(k, [...(children.get(k) ?? []), p]);
    } else roots.push(p);
  }
  const ordered: QueueItem[] = [];
  const visit = (p: PullRequestFact) => {
    ordered.push(item(p));
    for (const c of (children.get(prKey(p.repo, p.number)) ?? []).sort(byAge)) visit(c);
  };
  for (const r of roots.sort(byAge)) visit(r);

  const notReady: NotReadyItem[] = prs
    .filter((p) => !isReady(p))
    .map((p) => {
      const reasons = [...own.get(prKey(p.repo, p.number))!];
      if (bases.has(prKey(p.repo, p.number))) reasons.push('stacked');
      return { ...item(p), reason: reasons[0], reasons };
    })
    .sort(byAge);
  return { ready: ordered, notReady };
}

export interface BoardInput {
  openIssues: readonly IssueFact[];
  closedIssues: readonly IssueFact[];
  openPullRequests: readonly PullRequestFact[];
  /** Remote branches, per repository. */
  remoteBranches: ReadonlyMap<string, readonly string[]>;
  sessions: readonly ContextSession[];
  blockedLabels?: readonly string[];
  now: number;
}

/**
 * The column of an open issue, in the order that wins: `blocked` (the label), `in-review` (an
 * open PR that closes it), `in-progress` (a remote branch with its number), `delegated` (an open
 * session on a branch with its number, not pushed yet), otherwise `todo`.
 */
export function columnOf(
  issue: IssueFact,
  facts: { pullRequest: PullRequestFact | null; remoteBranch: boolean; session: ContextSession | null },
  blockedLabels: readonly string[] = DEFAULT_BLOCKED_LABELS,
): Exclude<BoardColumn, 'done'> {
  const blocked = new Set(blockedLabels.map((l) => l.toLowerCase()));
  if (issue.labels.some((l) => blocked.has(l.toLowerCase()))) return 'blocked';
  if (facts.pullRequest) return 'in-review';
  if (facts.remoteBranch) return 'in-progress';
  if (facts.session) return 'delegated';
  return 'todo';
}

const branchHasIssue = (branch: string | null, number: number) => branch !== null && issueDoBranch(branch) === number;

export function buildBoard(input: BoardInput): Board {
  const board: Board = { todo: [], delegated: [], 'in-progress': [], 'in-review': [], blocked: [], done: [] };
  // Several sessions on the issue's branch: the one waiting on you, else the working one, else the lowest id.
  const sessionFor = (i: IssueFact) =>
    input.sessions
      .filter((s) => s.repo === i.repo && branchHasIssue(s.branch, i.number))
      .sort((a, b) => Number(b.waitingOnYou) - Number(a.waitingOnYou) || Number(b.working) - Number(a.working) || a.id.localeCompare(b.id))[0] ?? null;
  const prFor = (i: IssueFact) =>
    input.openPullRequests.filter((p) => p.repo === i.repo && p.closes.includes(i.number)).sort((a, b) => Number(a.isDraft) - Number(b.isDraft) || a.number - b.number)[0] ??
    null;
  const card = (i: IssueFact, pr: PullRequestFact | null, s: ContextSession | null): BoardCard => ({
    repo: i.repo,
    number: i.number,
    title: i.title,
    url: i.url,
    session: s ? { id: s.id, title: s.title, waitingOnYou: s.waitingOnYou } : null,
    pullRequest: pr ? { number: pr.number, url: pr.url, isDraft: pr.isDraft } : null,
    ci: pr ? ciSummary(pr.ci) : null,
  });

  for (const i of input.openIssues) {
    const branches = input.remoteBranches.get(i.repo) ?? [];
    const pr = prFor(i);
    const remoteBranch = branches.some((b) => branchHasIssue(b, i.number));
    // Delegated is a session on the issue's branch that has not been pushed: once the branch is on the remote, the column is another one.
    const s = sessionFor(i);
    const delegatedSession = s && s.branch && !branches.includes(s.branch) ? s : null;
    const column = columnOf(i, { pullRequest: pr, remoteBranch, session: delegatedSession }, input.blockedLabels);
    board[column].push(card(i, pr, s));
  }
  const since = input.now - DONE_WINDOW_MS;
  for (const i of input.closedIssues) {
    if (i.closedAt && Date.parse(i.closedAt) >= since) board.done.push(card(i, null, null));
  }
  for (const c of BOARD_COLUMNS) board[c].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  board.done.sort((a, b) => {
    const at = (c: BoardCard) => input.closedIssues.find((i) => i.repo === c.repo && i.number === c.number)?.closedAt ?? '';
    return at(b).localeCompare(at(a));
  });
  return board;
}

/** PRs merged in the last 24 h, most recent first. */
export function mergedSince(merged: readonly MergedPullRequestFact[], now: number): MergedPullRequestFact[] {
  const since = now - DONE_WINDOW_MS;
  return merged.filter((m) => Date.parse(m.mergedAt) >= since).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || a.repo.localeCompare(b.repo));
}

export function buildScoreboard(input: { queue: MergeQueue; openPullRequests: readonly PullRequestFact[]; sessions: readonly ContextSession[]; dependsOnYou: number }): Scoreboard {
  const open = input.openPullRequests.filter((p) => !p.isDraft);
  return {
    ready: input.queue.ready.length,
    ciRunning: open.filter((p) => ciSummary(p.ci) === 'running').length,
    ciFailingOrConflict: open.filter((p) => ciSummary(p.ci) === 'failing' || p.mergeable === 'CONFLICTING').length,
    sessionsWorking: input.sessions.filter((s) => s.working).length,
    waitingOnYou: input.dependsOnYou,
  };
}
