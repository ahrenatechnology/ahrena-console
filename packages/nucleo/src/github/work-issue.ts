/*
 * issue 506 the issue detail the work board's panel reads (wireframe 467-1): the header, the body, the
 * comments, the parent chain, the sub-issues, the Plan steps and the linked pull request. `WorkIssueRead` is
 * what the source port returns for one issue; `buildWorkIssue` turns it into the route's body, with no IO.
 */

import type { CiState, IssueState, LinkedPullRequest, ReviewDecision, PullRequestState } from './work.ts';
import { LEVEL_BY_TYPE } from './work.ts';

/** An issue the detail cites: a parent or a sub-issue. */
export interface WorkIssueRef {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  type: string | null;
}

export interface WorkIssueComment {
  /** `null` for a deleted account. */
  author: string | null;
  createdAt: string;
  body: string;
}

export interface WorkIssuePullRequest extends LinkedPullRequest {
  title: string;
}

/** One issue as the source reads it from GitHub, in one query. */
export interface WorkIssueRead extends WorkIssueRef {
  labels: string[];
  milestone: string | null;
  body: string;
  comments: WorkIssueComment[];
  /** How many comments the issue has; `comments` may hold only the first ones. */
  commentsTotal: number;
  /** The parents, nearest first (the issue's parent, then its parent's parent...). */
  parentChain: WorkIssueRef[];
  /** In GitHub's order. */
  subIssues: WorkIssueRef[];
  pullRequests: WorkIssuePullRequest[];
}

/** The port the issue detail reads through. `null`: GitHub has no such issue. */
export interface WorkIssueSource {
  issue(key: string): Promise<WorkIssueRead | null>;
}

export interface WorkIssueChecks {
  total: number;
  passed: number;
  failed: number;
  running: number;
}

export interface WorkIssuePullRequestView {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  ci: CiState | null;
  checks: WorkIssueChecks | null;
  review: ReviewDecision | null;
}

export interface WorkPlanStep {
  number: number;
  title: string;
  url: string;
  state: IssueState;
}

/** The body of `GET /api/work/issue` (without the cache's `fetchedAt`, `stale` and `staleReason`). */
export interface WorkIssueView {
  key: string;
  repo: string;
  type: string | null;
  number: number;
  title: string;
  state: IssueState;
  url: string;
  labels: string[];
  milestone: string | null;
  /** The issue's Status in the chosen Project; `null` when it is not in it. */
  projectStatus: string | null;
  body: string;
  comments: WorkIssueComment[];
  commentsTotal: number;
  /** Root first. */
  parents: WorkIssueRef[];
  subIssues: WorkIssueRef[];
  plan: { count: number; steps: WorkPlanStep[] };
  pullRequest: WorkIssuePullRequestView | null;
}

const isPlan = (type: string | null): boolean => type !== null && LEVEL_BY_TYPE[type] === 'plan';

/** The pull request the panel shows: the open one, else a merged one, else the first closed one. */
function linkedPullRequest(prs: readonly WorkIssuePullRequest[]): WorkIssuePullRequestView | null {
  const pr = prs.find((p) => p.state === 'OPEN') ?? prs.find((p) => p.state === 'MERGED') ?? prs[0];
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    ci: pr.ci,
    checks: pr.checks ? { total: pr.checks.total, passed: pr.checks.ok, failed: pr.checks.falhas, running: pr.checks.rodando } : null,
    review: pr.review,
  };
}

export function buildWorkIssue(read: WorkIssueRead, projectStatus: string | null): WorkIssueView {
  const steps = read.subIssues.filter((s) => isPlan(s.type)).map((s) => ({ number: s.number, title: s.title, url: s.url, state: s.state }));
  return {
    key: read.key,
    repo: read.repo,
    type: read.type,
    number: read.number,
    title: read.title,
    state: read.state,
    url: read.url,
    labels: read.labels,
    milestone: read.milestone,
    projectStatus,
    body: read.body,
    comments: read.comments,
    commentsTotal: read.commentsTotal,
    parents: [...read.parentChain].reverse(),
    subIssues: read.subIssues,
    plan: { count: steps.length, steps },
    pullRequest: linkedPullRequest(read.pullRequests),
  };
}
