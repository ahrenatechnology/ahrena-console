// The Analytics Delivery tab (#266): the pure part. It takes each repository's GitHub read
// (src/github/delivery-source.ts) and each session's Claude effort, cuts them to the period's days
// in the person's time zone, and adds them up per row. A row is always a repository or a project,
// never a person (AC-9): nothing here reads or returns an author, an assignee or a reviewer.
//
// Definitions:
// - merged PR of the period: `mergedAt` on one of the period's days; the time to merge is
//   `mergedAt − createdAt`, and its median reuses `mediana` (src/github/repos-calculo.ts). A row's
//   or the totals' median is taken over all the merges of its repositories, not a median of medians;
// - opened PR or issue: `createdAt` in the period; closed issue: `closedAt` in the period; review: a
//   review submitted in the period, among each PR's last 20 (the sample of the GitHub read);
// - open now: the repository's own counts (`openPrs`, `openIssues`), whatever the period;
// - Claude hours: the gaps between consecutive events of a session up to `IDLE_GAP_MS`, on the day
//   (in the time zone) of the gap's first event; a longer gap is the session waiting, and does not
//   count. A session belongs to the repository its cwd's git remote points to (src/api/repos-sessions.ts);
// - cost: the slices of the same sessions in the period (src/cost/aggregation.ts), with the table in
//   force; usage with no price makes the cost `null` when nothing else has a price, and `costPartial`
//   says some usage was left out (as in the Cost tab);
// - a row with no session in the period has `null` hours, cost and cost per PR; with no merged PR,
//   `null` cost per PR. Zero never stands in for unknown (AC-7);
// - a project's repositories are the ones with items in it; a repository in two projects counts in
//   both rows, and once in the totals (the totals add up the distinct repositories of the rows shown).

import { costReport, dayOf, type CostSlice } from '../cost/aggregation.ts';
import { mediana } from '../github/repos-calculo.ts';
import type { DeliveryOpenRaw, DeliveryRaw } from '../github/delivery-source.ts';
import { NOME_DO_DONO, NOME_DO_REPO } from '../github/repos-source.ts';
import { chaveDoRepo } from './repos-sessions.ts';

export const DELIVERY_ROUTE = '/api/analytics/delivery';
export const GROUP_BYS = ['repo', 'project'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const GROUP_BY_ERROR = 'groupBy: repo ou project';
export const KEY_ERROR = 'key: owner/repo em groupBy=repo, owner/número em groupBy=project';

/** The state of an open PR or issue; the screen writes it in pt-BR. */
export const OPEN_ITEM_STATES = ['draft', 'review', 'ciFailed', 'approved', 'issueWithPr', 'issueWithoutPr'] as const;
export type OpenItemState = (typeof OPEN_ITEM_STATES)[number];
/** Open items in the answer, at most (the oldest); `openItemsTotal` counts all of them. */
export const OPEN_ITEMS_LIMIT = 200;
/** A longer gap between two events of a session is the session waiting. */
export const IDLE_GAP_MS = 10 * 60_000;
/** Repositories read, at most: the ones with sessions first, then the projects', then the latest pushed. */
export const DELIVERY_MAX_REPOS = 30;

const PROJECT_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/\d{1,9}$/;

/** `null` (no filter), or the key in the shape of the grouping; anything else is invalid (`undefined`). */
export function validKey(groupBy: GroupBy, key: string | null): string | null | undefined {
  if (key === null || key === '') return null;
  if (groupBy === 'project') return PROJECT_KEY.test(key) ? key : undefined;
  const [owner, name, ...rest] = key.split('/');
  return rest.length === 0 && name !== undefined && NOME_DO_DONO.test(owner) && NOME_DO_REPO.test(name) ? chaveDoRepo(key) : undefined;
}

export interface OpenItem {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  url: string;
  /** `owner/name`. */
  repo: string;
  createdAt: string;
  ageMs: number;
  state: OpenItemState;
  /** The open PR that closes the issue (`issueWithPr`); otherwise `null`. */
  linkedPr: number | null;
  /** The rows (repositories or projects) the item belongs to. */
  rowKeys: string[];
}

/** The GitHub side of one repository, cut to the period. */
export interface RepoActivity {
  key: string;
  repo: string;
  mergedPerDay: number[];
  leadTimesMs: number[];
  openedPrs: number;
  openedIssues: number;
  closedIssues: number;
  reviews: number;
  openPrs: number;
  openIssues: number;
  open: Omit<OpenItem, 'rowKeys'>[];
}

/** One session's Claude effort in the period. */
export interface SessionEffort {
  /** `chaveDoRepo` of its repository. */
  repo: string;
  hoursPerDay: number[];
  slices: CostSlice[];
}

/** A row's definition: a repository (`repos` is itself) or a project (its repositories). */
export interface DeliveryGroup {
  key: string;
  label: string;
  repos: string[];
}

/** The GitHub read the route gets (src/api/delivery-github.ts). */
export interface DeliveryGithubRead {
  /**
   * `loading`: nothing read yet; `stale`: GitHub did not answer the last read, the cache is served;
   * `error`: GitHub did not answer and nothing is cached.
   */
  status: 'connected' | 'disconnected' | 'loading' | 'stale' | 'error';
  /** The oldest read among the repositories used (ms), `null` without any. */
  readAt: number | null;
  error: string | null;
  /** Repositories still being read. */
  pending: number;
  /** Samples cut (screen text). */
  truncated: string[];
  /** By `chaveDoRepo`. A repository GitHub does not show is absent. */
  repos: Map<string, DeliveryRaw>;
}

export function openItemState(item: DeliveryOpenRaw): { state: OpenItemState; linkedPr: number | null } {
  if (item.__typename === 'Issue') {
    const pr = item.closedByPullRequestsReferences?.nodes.find((p) => p.state === 'OPEN');
    return pr ? { state: 'issueWithPr', linkedPr: pr.number } : { state: 'issueWithoutPr', linkedPr: null };
  }
  if (item.isDraft) return { state: 'draft', linkedPr: null };
  const ci = item.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (ci === 'FAILURE' || ci === 'ERROR') return { state: 'ciFailed', linkedPr: null };
  if (item.reviewDecision === 'APPROVED') return { state: 'approved', linkedPr: null };
  return { state: 'review', linkedPr: null };
}

const indexer = (calendar: readonly string[]) => {
  const at = new Map(calendar.map((d, i) => [d, i]));
  return (iso: string | null | undefined, timeZone: string): number | undefined => (iso && Number.isFinite(Date.parse(iso)) ? at.get(dayOf(iso, timeZone)) : undefined);
};

export function repoActivity(raw: DeliveryRaw, calendar: readonly string[], timeZone: string, now: number): RepoActivity {
  const dayIndex = indexer(calendar);
  const inPeriod = (iso: string | null | undefined) => dayIndex(iso, timeZone) !== undefined;
  const mergedPerDay = calendar.map(() => 0);
  const leadTimesMs: number[] = [];
  let reviews = 0;
  for (const p of raw.prs) {
    const i = dayIndex(p.mergedAt, timeZone);
    if (i !== undefined) {
      mergedPerDay[i]++;
      const lead = Date.parse(p.mergedAt!) - Date.parse(p.createdAt);
      if (lead >= 0) leadTimesMs.push(lead);
    }
    reviews += (p.reviews?.nodes ?? []).filter((r) => inPeriod(r.submittedAt)).length;
  }
  return {
    key: chaveDoRepo(raw.repo),
    repo: raw.repo,
    mergedPerDay,
    leadTimesMs,
    openedPrs: raw.prs.filter((p) => inPeriod(p.createdAt)).length,
    openedIssues: raw.issues.filter((i) => inPeriod(i.createdAt)).length,
    closedIssues: raw.issues.filter((i) => inPeriod(i.closedAt)).length,
    reviews,
    openPrs: raw.openPrs,
    openIssues: raw.openIssues,
    open: raw.open.map((o) => ({
      kind: o.__typename === 'PullRequest' ? 'pr' : 'issue',
      number: o.number,
      title: o.title,
      url: o.url,
      repo: raw.repo,
      createdAt: o.createdAt,
      ageMs: Math.max(0, now - Date.parse(o.createdAt)),
      ...openItemState(o),
    })),
  };
}

/** Hours per day of the calendar from a session's event times (any order). */
export function activeHoursPerDay(times: readonly string[], calendar: readonly string[], timeZone: string, idleGapMs = IDLE_GAP_MS): number[] {
  const dayIndex = indexer(calendar);
  const out = calendar.map(() => 0);
  const sorted = times.filter((t) => Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b));
  for (let k = 1; k < sorted.length; k++) {
    const gap = Date.parse(sorted[k]) - Date.parse(sorted[k - 1]);
    const i = dayIndex(sorted[k - 1], timeZone);
    if (gap > 0 && gap <= idleGapMs && i !== undefined) out[i] += gap / 3_600_000;
  }
  return out;
}

const round = (v: number | null, places: number): number | null => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);

/** The numbers of a set of repositories: a row's, or the totals'. */
export function deliveryNumbers(repos: readonly string[], activities: ReadonlyMap<string, RepoActivity>, efforts: readonly SessionEffort[], days: number, timeZone: string) {
  const set = new Set(repos);
  const acts = [...set].map((r) => activities.get(r)).filter((a): a is RepoActivity => a !== undefined);
  // Only the sessions of repositories with a GitHub read: hours never come without the merges beside them.
  const read = new Set(acts.map((a) => a.key));
  const sessions = efforts.filter((e) => read.has(e.repo));
  const sum = (f: (a: RepoActivity) => number) => acts.reduce((s, a) => s + f(a), 0);
  const mergedPerDay = Array.from({ length: days }, (_, i) => sum((a) => a.mergedPerDay[i]));
  const mergedPrs = mergedPerDay.reduce((s, n) => s + n, 0);
  const hoursPerDay = sessions.length ? Array.from({ length: days }, (_, i) => round(sessions.reduce((s, e) => s + e.hoursPerDay[i], 0), 2)) : mergedPerDay.map(() => null);
  const claudeHours = sessions.length ? round(sessions.reduce((s, e) => s + e.hoursPerDay.reduce((x, h) => x + h, 0), 0), 2) : null;
  const cost = sessions.length ? costReport(sessions.flatMap((e) => e.slices), timeZone).total : null;
  const costUsd = cost ? round(cost.costUsd, 4) : null;
  return {
    mergedPrs,
    mergedPerDay,
    claudeHoursPerDay: hoursPerDay,
    peak: Math.max(0, ...mergedPerDay),
    total: mergedPrs,
    medianLeadTimeMs: mediana(acts.flatMap((a) => a.leadTimesMs)),
    openPrs: sum((a) => a.openPrs),
    openIssues: sum((a) => a.openIssues),
    contributions: { openedPrs: sum((a) => a.openedPrs), mergedPrs, openedIssues: sum((a) => a.openedIssues), closedIssues: sum((a) => a.closedIssues), reviews: sum((a) => a.reviews) },
    claudeHours,
    costUsd,
    costPartial: (cost?.unpriced.models.length ?? 0) > 0,
    costPerMergedPr: costUsd !== null && mergedPrs > 0 ? round(costUsd / mergedPrs, 4) : null,
    reposWithClaude: new Set(sessions.map((e) => e.repo)).size,
    repoCount: acts.length,
  };
}

export type DeliveryRow = { key: string; label: string; repos: string[] } & Omit<ReturnType<typeof deliveryNumbers>, 'reposWithClaude' | 'repoCount'>;

export function deliveryRow(group: DeliveryGroup, activities: ReadonlyMap<string, RepoActivity>, efforts: readonly SessionEffort[], days: number, timeZone: string): DeliveryRow {
  const { reposWithClaude: _w, repoCount: _c, ...numbers } = deliveryNumbers(group.repos, activities, efforts, days, timeZone);
  return { key: group.key, label: group.label, repos: [...group.repos], ...numbers };
}

/** Rows: most merged first, then most Claude hours, then the label. */
export const byDelivery = (a: DeliveryRow, b: DeliveryRow) => b.mergedPrs - a.mergedPrs || (b.claudeHours ?? -1) - (a.claudeHours ?? -1) || a.label.localeCompare(b.label);

/** The open items of the rows, the oldest first, each with the rows it belongs to; cut at `limit`. */
export function openItemsOf(rows: readonly DeliveryGroup[], activities: ReadonlyMap<string, RepoActivity>, limit = OPEN_ITEMS_LIMIT): { items: OpenItem[]; total: number } {
  const rowsOf = new Map<string, string[]>();
  for (const r of rows) for (const repo of r.repos) rowsOf.set(repo, [...(rowsOf.get(repo) ?? []), r.key]);
  const acts = [...rowsOf.keys()].map((k) => activities.get(k)).filter((a): a is RepoActivity => a !== undefined);
  const items = acts
    .flatMap((a) => a.open.map((o) => ({ ...o, rowKeys: rowsOf.get(a.key)! })))
    .sort((a, b) => b.ageMs - a.ageMs || a.repo.localeCompare(b.repo) || a.number - b.number);
  return { items: items.slice(0, limit), total: acts.reduce((s, a) => s + a.openPrs + a.openIssues, 0) };
}
