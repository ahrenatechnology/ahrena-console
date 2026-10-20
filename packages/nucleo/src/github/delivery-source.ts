// What the Analytics Delivery tab (#266) reads from GitHub for one repository, in one query plus
// the following pages of its searches, in the style of src/github/repos-source.ts (decision 0001):
//
// | Query              | What it brings                                                        | Cost |
// | ------------------ | --------------------------------------------------------------------- | ---: |
// | RepoDelivery       | the open counts, the first page of PRs updated since `since` (with the submitted time of their last 20 reviews), of issues updated since `since`, and the 50 oldest open PRs and issues | ≈ 2 |
// | RepoDeliveryPage   | the next pages of the PR or the issue search, up to the cap            | ≈ 1  |
//
// One read covers the longest period (90 days, `DELIVERY_FETCH_DAYS`), and 7 and 30 days are cut
// from it in memory: a PR merged, opened or reviewed in the period, or an issue opened or closed in
// it, was necessarily updated in it. Nothing about people is asked: no author, no assignee, no
// reviewer (#266 AC-9). Reviews come from `reviews(last: 20)`: a PR with more than 20 reviews counts
// only its last 20.

import { RateLimitedError } from './cache.ts';
import { SemGithubError, type GithubReposSource } from './repos-source.ts';

/** Days one read covers: the longest period plus one, so any time zone's first day is inside. */
export const DELIVERY_FETCH_DAYS = 91;
/** PRs per page (each brings its last reviews) and pages read at most. */
export const DELIVERY_PR_PAGE = 25;
export const DELIVERY_PR_PAGES = 20;
/** Issues per page and pages read at most. */
export const DELIVERY_ISSUE_PAGE = 100;
export const DELIVERY_ISSUE_PAGES = 5;
/** Open PRs and issues read per repository, the oldest first. */
export const DELIVERY_OPEN_ITEMS = 50;
/** Reviews read per PR, the newest. */
export const DELIVERY_REVIEWS_PER_PR = 20;

export interface DeliveryPrRaw {
  createdAt: string;
  mergedAt: string | null;
  /** The submitted time of each of its last reviews (`null` while pending). */
  reviews: { nodes: { submittedAt: string | null }[] } | null;
}

export interface DeliveryIssueRaw {
  createdAt: string;
  closedAt: string | null;
}

export type CiRollupState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';

export interface DeliveryOpenPrRaw {
  __typename: 'PullRequest';
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: CiRollupState } | null } }[] } | null;
}

export interface DeliveryOpenIssueRaw {
  __typename: 'Issue';
  number: number;
  title: string;
  url: string;
  createdAt: string;
  /** The open PR that closes it, if any. */
  closedByPullRequestsReferences: { nodes: { number: number; state: string }[] } | null;
}

export type DeliveryOpenRaw = DeliveryOpenPrRaw | DeliveryOpenIssueRaw;

/** One repository's read: what the tab cuts by period in memory. */
export interface DeliveryRaw {
  /** `owner/name`, as GitHub writes it. */
  repo: string;
  /** First day (YYYY-MM-DD, UTC) of the searches. */
  since: string;
  /** Open now: the repository's own counts, not the sample. */
  openPrs: number;
  openIssues: number;
  /** PRs updated since `since`. */
  prs: DeliveryPrRaw[];
  /** Issues updated since `since`. */
  issues: DeliveryIssueRaw[];
  /** The oldest open PRs and issues, oldest first. */
  open: DeliveryOpenRaw[];
  /** Samples cut by the page cap or by a page that failed (screen text). */
  truncated: string[];
  /** Set when a following page failed: the reason (screen text); the sample is shorter than GitHub's. */
  incomplete?: string;
}

/** Port of the Delivery tab's GitHub read. `null`: the repository does not exist or is not visible. */
export interface DeliverySource {
  delivery(owner: string, name: string, since: string): Promise<DeliveryRaw | null>;
}

/** GitHub's answer to a `repo:` search over a repository that does not exist or is not visible. */
const UNSEARCHABLE = /cannot be searched|do not exist or you do not have permission/i;

const RATE = 'rateLimit { cost remaining resetAt }';
const PAGE = 'issueCount pageInfo { hasNextPage endCursor }';
const PR = `createdAt mergedAt reviews(last: ${DELIVERY_REVIEWS_PER_PR}) { nodes { submittedAt } }`;
const ISSUE = 'createdAt closedAt';
const OPEN = `__typename
  ... on PullRequest { number title url createdAt isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  ... on Issue { number title url createdAt closedByPullRequestsReferences(first: 1) { nodes { number state } } }`;

export const DELIVERY_QUERIES = {
  delivery: `query RepoDelivery($o: String!, $r: String!, $first: Int!, $prs: String!, $issues: String!, $open: String!) { ${RATE}
  repository(owner: $o, name: $r) { nameWithOwner issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } }
  prs: search(query: $prs, type: ISSUE, first: $first) { ${PAGE} nodes { ... on PullRequest { ${PR} } } }
  issues: search(query: $issues, type: ISSUE, first: ${DELIVERY_ISSUE_PAGE}) { ${PAGE} nodes { ... on Issue { ${ISSUE} } } }
  open: search(query: $open, type: ISSUE, first: ${DELIVERY_OPEN_ITEMS}) { issueCount nodes { ${OPEN} } } }`,
  page: `query RepoDeliveryPage($q: String!, $first: Int!, $after: String) { ${RATE}
  search(query: $q, type: ISSUE, first: $first, after: $after) { ${PAGE} nodes { ... on PullRequest { ${PR} } ... on Issue { ${ISSUE} } } } }`,
} as const;

/** The searches of one read, from `since` (YYYY-MM-DD). */
export function deliverySearches(fullName: string, since: string) {
  return {
    prs: `repo:${fullName} is:pr updated:>=${since} sort:updated-desc`,
    issues: `repo:${fullName} is:issue updated:>=${since} sort:updated-desc`,
    open: `repo:${fullName} is:open sort:created-asc`,
  };
}

const isDeliveryPr = (n: Partial<DeliveryPrRaw>): n is DeliveryPrRaw => typeof n.createdAt === 'string';
const isDeliveryIssue = (n: Partial<DeliveryIssueRaw>): n is DeliveryIssueRaw => typeof n.createdAt === 'string';

interface SearchPage<T> {
  issueCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Partial<T>[];
}

/** The GitHub adapter: the token, the time cap and the 502 retry of `GithubReposSource.query`. */
export class GithubDeliverySource implements DeliverySource {
  private readonly github: Pick<GithubReposSource, 'query'>;

  constructor(github: Pick<GithubReposSource, 'query'>) {
    this.github = github;
  }

  async delivery(owner: string, name: string, since: string): Promise<DeliveryRaw | null> {
    const searches = deliverySearches(`${owner}/${name}`, since);
    type Data = {
      repository: { nameWithOwner: string; issues: { totalCount: number }; pullRequests: { totalCount: number } } | null;
      prs: SearchPage<DeliveryPrRaw>;
      issues: SearchPage<DeliveryIssueRaw>;
      open: { issueCount: number; nodes: Partial<DeliveryOpenRaw>[] };
    };
    let data: Data;
    try {
      data = await this.github.query<Data>('RepoDelivery', DELIVERY_QUERIES.delivery, { o: owner, r: name, first: DELIVERY_PR_PAGE, ...searches });
    } catch (err) {
      // A search over a repository the token cannot see fails instead of coming back empty: not found.
      if (err instanceof Error && UNSEARCHABLE.test(err.message)) return null;
      throw err;
    }
    if (!data.repository) return null;
    const truncated: string[] = [];
    const failed: string[] = [];
    const prs = await this.remainingPages(searches.prs, data.prs, DELIVERY_PR_PAGES, DELIVERY_PR_PAGE, 'PRs', truncated, failed);
    const issues = await this.remainingPages(searches.issues, data.issues, DELIVERY_ISSUE_PAGES, DELIVERY_ISSUE_PAGE, 'issues', truncated, failed);
    return {
      repo: data.repository.nameWithOwner,
      since,
      openPrs: data.repository.pullRequests.totalCount,
      openIssues: data.repository.issues.totalCount,
      prs: prs.filter(isDeliveryPr),
      issues: issues.filter(isDeliveryIssue),
      open: data.open.nodes.filter((n): n is DeliveryOpenRaw => n?.__typename === 'PullRequest' || n?.__typename === 'Issue'),
      truncated,
      ...(failed.length > 0 ? { incomplete: failed.join('; ') } : {}),
    };
  }

  /** The following pages, serially, up to `max` pages; a page that fails ends the sample and says so. */
  private async remainingPages<T>(q: string, first: SearchPage<T>, max: number, size: number, what: string, truncated: string[], failed: string[]): Promise<Partial<T>[]> {
    const nodes = first.nodes.filter((n) => n && Object.keys(n).length > 0);
    let page = first;
    let i = 1;
    for (; i < max && page.pageInfo.hasNextPage; i++) {
      try {
        page = (await this.github.query<{ search: SearchPage<T> }>('RepoDeliveryPage', DELIVERY_QUERIES.page, { q, first: size, after: page.pageInfo.endCursor })).search;
      } catch (err) {
        if (err instanceof SemGithubError || err instanceof RateLimitedError) throw err;
        const note = `amostra de ${what} incompleta: ${nodes.length} lidos, o resto falhou (${err instanceof Error ? err.message : String(err)})`;
        truncated.push(note);
        failed.push(note);
        return nodes;
      }
      nodes.push(...page.nodes.filter((n) => n && Object.keys(n).length > 0));
    }
    if (page.pageInfo.hasNextPage) truncated.push(`amostra de ${what} cortada em ${nodes.length} de ${first.issueCount}`);
    return nodes;
  }
}
