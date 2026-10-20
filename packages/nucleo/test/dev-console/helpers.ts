// Synthetic Dev Console facts: made-up repositories, PRs, issues and sessions.
// No real organization, repository, host or person names.

import type { ContextSession, IssueFact, MergedPullRequestFact, PullRequestFact } from '../../src/dev-console/model.ts';

export const REPO = 'dev-sintetico/catalogo-exemplo';
export const OTHER_REPO = 'dev-sintetico/motor-de-regras';
export const NOW = Date.parse('2026-11-02T12:00:00.000Z');
export const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

export function pr(number: number, over: Partial<PullRequestFact> = {}): PullRequestFact {
  return {
    repo: REPO,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${over.repo ?? REPO}/pull/${number}`,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    baseRefName: 'main',
    headRefName: `feat/${number}-pr`,
    isCrossRepository: false,
    createdAt: hoursAgo(10),
    ci: 'SUCCESS',
    review: 'APPROVED',
    closes: [],
    ...over,
  };
}

export function issue(number: number, over: Partial<IssueFact> = {}): IssueFact {
  return {
    repo: REPO,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${over.repo ?? REPO}/issues/${number}`,
    state: 'OPEN',
    labels: [],
    closedAt: null,
    ...over,
  };
}

export function merged(number: number, mergedAt: string, over: Partial<MergedPullRequestFact> = {}): MergedPullRequestFact {
  return { repo: REPO, number, title: `PR ${number}`, url: `https://github.com/${REPO}/pull/${number}`, mergedAt, ...over };
}

export function contextSession(id: string, over: Partial<ContextSession> = {}): ContextSession {
  return { id, title: `sessão ${id}`, repo: REPO, branch: null, working: true, waitingOnYou: false, ...over };
}
