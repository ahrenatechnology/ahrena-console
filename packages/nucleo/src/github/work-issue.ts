/*
 * #506 the issue detail the work board's panel reads (wireframe 467-1): the header, the body, the
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
  /** #506 `null` for a deleted account. */
  author: string | null;
  createdAt: string;
  body: string;
}

export interface WorkIssuePullRequest extends LinkedPullRequest {
  title: string;
}

/** One issue as the source reads it from GitHub, in one query. */
export interface WorkIssueRead extends WorkIssueRef {
  /** #533 GitHub's `updatedAt`: the version a title or body save is checked against. */
  updatedAt: string;
  labels: string[];
  milestone: string | null;
  body: string;
  comments: WorkIssueComment[];
  /** #506 how many comments the issue has; `comments` may hold only the first ones. */
  commentsTotal: number;
  /** #506 the parents, nearest first (the issue's parent, then its parent's parent...). */
  parentChain: WorkIssueRef[];
  /** #506 in GitHub's order. */
  subIssues: WorkIssueRef[];
  pullRequests: WorkIssuePullRequest[];
}

/** The port the issue detail reads through. `null`: GitHub has no such issue. */
export interface WorkIssueSource {
  issue(key: string): Promise<WorkIssueRead | null>;
}

/** #533 what GitHub holds of the fields a conflict is decided on. */
export interface WorkIssueCurrent {
  title: string;
  body: string;
  updatedAt: string;
}

/**
 * #533 the fields a save may change; an absent one is left alone. `type`, `milestone` and `parent` clear with
 * `null`; `labels` replaces the whole set. `parent` is an issue key (`owner/repo#N`).
 */
export interface WorkIssueEdit {
  title?: string;
  body?: string;
  labels?: string[];
  type?: string | null;
  milestone?: string | null;
  parent?: string | null;
}

/**
 * #533 the port the issue is written through. Each write answers the issue as GitHub holds it afterwards, or
 * `null` when GitHub has no such issue (nothing is written then).
 */
export interface WorkIssueWriter {
  /** The title, body and `updatedAt` GitHub holds now; `null`: no such issue. */
  current(key: string): Promise<WorkIssueCurrent | null>;
  update(key: string, edit: WorkIssueEdit): Promise<WorkIssueRead | null>;
  comment(key: string, body: string): Promise<WorkIssueRead | null>;
}

/** #533 the credential cannot write this issue. */
export class WorkIssueForbiddenError extends Error {
  constructor(key: string) {
    super(`no permission to write ${key}`);
    this.name = 'WorkIssueForbiddenError';
  }
}

/** #533 the edit names a label, type, milestone or parent GitHub does not know; raised before anything is written. */
export class WorkIssueRefusedError extends Error {
  readonly param: 'labels' | 'type' | 'milestone' | 'parent';
  constructor(param: WorkIssueRefusedError['param'], detail: string) {
    super(`unknown ${param}: ${detail}`);
    this.name = 'WorkIssueRefusedError';
    this.param = param;
  }
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
  /** #533 GitHub's `updatedAt`; a title or body save carries the one it was opened at. Empty for a value cached before #533. */
  updatedAt: string;
  labels: string[];
  milestone: string | null;
  /** #506 the issue's Status in the chosen Project; `null` when it is not in it. */
  projectStatus: string | null;
  body: string;
  comments: WorkIssueComment[];
  commentsTotal: number;
  /** #506 root first. */
  parents: WorkIssueRef[];
  subIssues: WorkIssueRef[];
  plan: { count: number; steps: WorkPlanStep[] };
  pullRequest: WorkIssuePullRequestView | null;
}

const isPlan = (type: string | null): boolean => type !== null && LEVEL_BY_TYPE[type] === 'plan';

/** #506 the pull request the panel shows: the open one, else a merged one, else the first closed one. */
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
    updatedAt: read.updatedAt ?? '',
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
