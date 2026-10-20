// The Analytics Delivery tab's data (#266): `GET /api/analytics/delivery`. Synthetic fixtures, a
// fixed clock and an in-memory GitHub read; the last block reads the simulator's fake GitHub through
// the real adapter. Each test names the criterion it covers (#266/AC-n).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, normalizeLegacyUrl } from '../../src/api/index.ts';
import { DAYS_ERROR, RotaAnalytics, type DeliveryOptions } from '../../src/api/analytics-route.ts';
import { activeHoursPerDay, GROUP_BY_ERROR, KEY_ERROR, openItemState, OPEN_ITEM_STATES, type DeliveryGithubRead } from '../../src/api/delivery.ts';
import { createCoreDelivery, DeliveryGithub, latestProjects, projectGroupOf } from '../../src/api/delivery-github.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubCache, MemoryCacheStore, RateLimitedError } from '../../src/github/cache.ts';
import { DELIVERY_QUERIES, GithubDeliverySource, type DeliveryOpenRaw, type DeliveryRaw, type DeliverySource } from '../../src/github/delivery-source.ts';
import { GithubReposSource, SemGithubError } from '../../src/github/repos-source.ts';
import { createFakeGithub, DEMO_DELIVERY_PROJECTS, DEMO_DELIVERY_GITHUB_DATA } from '../../src/simulator/fake-github.ts';
import type { TokenCounts } from '../../src/model.ts';
import { event, session } from '../fixtures.ts';

// Tuesday, noon in São Paulo.
const NOW = Date.parse('2026-10-20T15:00:00.000Z');
const TZ = 'America/Sao_Paulo';
const H = 3_600_000;
const daysAgo = (n: number, time = '14:00:00') => `${new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)}T${time}.000Z`;
const tk = (input: number, output: number): TokenCounts => ({ input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const usage = (id: string, sessionId: string, createdAt: string, model: string, tokens: TokenCounts) =>
  event({ id, sessionId, agentId: null, type: 'AssistantMessage', toolName: null, summary: null, createdAt, data: { usage: { messageId: id, model, tokens } } });
const tool = (id: string, sessionId: string, createdAt: string) => event({ id, sessionId, agentId: null, type: 'PreToolUse', toolName: 'Bash', summary: null, createdAt, data: null });
// Default prices (src/cost/default-prices.ts), US$ per million.
const OPUS = (1000 * 4 + 1000 * 20) / 1e6;

type Json = any;

const pr = (createdAt: string, mergedAt: string | null, reviews: (string | null)[] = []) => ({ createdAt, mergedAt, reviews: { nodes: reviews.map((submittedAt) => ({ submittedAt })) } });
const openPr = (number: number, createdAt: string, over: Partial<Extract<DeliveryOpenRaw, { __typename: 'PullRequest' }>> = {}): DeliveryOpenRaw => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/x/pull/${number}`, createdAt, isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
});
const openIssue = (number: number, createdAt: string, linked: number | null = null): DeliveryOpenRaw => ({
  __typename: 'Issue', number, title: `Issue ${number}`, url: `https://github.com/x/issues/${number}`, createdAt,
  closedByPullRequestsReferences: { nodes: linked ? [{ number: linked, state: 'OPEN' }] : [] },
});

/** Three repositories: `alpha` with sessions and merges, `beta` with merges and no session, `gamma` with no merge. */
const RAW: Record<string, DeliveryRaw> = {
  'exemplo-labs/alpha': {
    repo: 'exemplo-labs/alpha', since: '2026-07-21', openPrs: 2, openIssues: 3,
    prs: [
      pr(daysAgo(1, '10:00:00'), daysAgo(1, '12:00:00'), [daysAgo(1, '11:00:00')]), // 2 h, yesterday
      pr(daysAgo(3, '08:00:00'), daysAgo(2, '08:00:00'), [daysAgo(2, '07:00:00'), daysAgo(40), null]), // 24 h
      pr('2026-10-19T20:00:00.000Z', '2026-10-20T01:30:00.000Z'), // merged 01:30 UTC: the 19th in São Paulo
      pr(daysAgo(20), daysAgo(15)), // inside 30 days, outside 7
      pr(daysAgo(0, '09:00:00'), null), // opened today, still open
    ],
    issues: [
      { createdAt: daysAgo(4), closedAt: daysAgo(1) },
      { createdAt: daysAgo(50), closedAt: daysAgo(2) },
      { createdAt: daysAgo(5), closedAt: null },
    ],
    open: [openIssue(10, daysAgo(41)), openPr(20, daysAgo(23), { isDraft: true }), openIssue(11, daysAgo(19), 30), openPr(21, daysAgo(6), { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }), openPr(22, daysAgo(2), { reviewDecision: 'APPROVED' })],
    truncated: [],
  },
  'exemplo-labs/beta': {
    repo: 'exemplo-labs/beta', since: '2026-07-21', openPrs: 1, openIssues: 0,
    prs: [pr(daysAgo(2, '10:00:00'), daysAgo(2, '16:00:00'))], // 6 h
    issues: [], open: [openPr(5, daysAgo(4))], truncated: [],
  },
  'estudio-ficticio/gamma': { repo: 'estudio-ficticio/gamma', since: '2026-07-21', openPrs: 0, openIssues: 1, prs: [pr(daysAgo(3), null)], issues: [], open: [openIssue(7, daysAgo(9))], truncated: [] },
};

function githubWith(status: DeliveryGithubRead['status'] = 'connected', readAt: number | null = NOW - 60_000): DeliveryOptions['github'] {
  return {
    read: async (repos) => ({
      status, readAt, error: status === 'stale' ? 'GitHub limitou as chamadas' : null, pending: 0, truncated: [],
      repos: status === 'disconnected' ? new Map() : new Map(repos.filter((r) => RAW[r]).map((r) => [r, RAW[r]])),
    }),
  };
}

const CWD: Record<string, string> = { '/simulacao/alpha': 'exemplo-labs/alpha', '/simulacao/gamma': 'estudio-ficticio/gamma' };

async function fixtures(): Promise<SqliteStorage> {
  const storage = openSqliteStorage({ path: ':memory:' });
  // s1 on alpha: yesterday 13:00–13:30 (events 5 min apart) and an idle gap of an hour, which does not count.
  await storage.putSession(session({ id: 's1', cwd: '/simulacao/alpha', status: 'completed', startedAt: daysAgo(1, '13:00:00'), updatedAt: daysAgo(1, '14:30:00'), accountId: null, accountSource: null }));
  for (let m = 0; m <= 30; m += 5) await storage.appendEvent(tool(`s1-t${m}`, 's1', daysAgo(1, `13:${String(m).padStart(2, '0')}:00`)));
  await storage.appendEvent(tool('s1-late', 's1', daysAgo(1, '14:30:00')));
  await storage.appendEvent(usage('s1-u', 's1', daysAgo(1, '13:30:00'), 'claude-opus-5-5', tk(1000, 1000)));
  // s2 on gamma, 3 days ago, an unpriced model: partial cost.
  await storage.putSession(session({ id: 's2', cwd: '/simulacao/gamma', status: 'completed', startedAt: daysAgo(3, '10:00:00'), updatedAt: daysAgo(3, '10:06:00'), accountId: null, accountSource: null }));
  await storage.appendEvent(tool('s2-t0', 's2', daysAgo(3, '10:00:00')));
  await storage.appendEvent(usage('s2-u', 's2', daysAgo(3, '10:06:00'), 'modelo-sem-preco', tk(500, 100)));
  // s3 outside any GitHub repository.
  await storage.putSession(session({ id: 's3', cwd: '/simulacao/sem-remote', status: 'completed', startedAt: daysAgo(1), updatedAt: daysAgo(1), accountId: null, accountSource: null }));
  await storage.appendEvent(tool('s3-t0', 's3', daysAgo(1)));
  return storage;
}

const PROJECTS = [
  { key: 'exemplo-labs/1', label: 'Loja de exemplo', repos: ['exemplo-labs/alpha', 'exemplo-labs/beta'] },
  { key: 'exemplo-labs/2', label: 'Plataforma', repos: ['exemplo-labs/beta', 'estudio-ficticio/gamma'] },
];

function route(storage: SqliteStorage, over: Partial<DeliveryOptions> = {}, withDelivery = true) {
  const delivery: DeliveryOptions = {
    github: githubWith(),
    repoOfCwd: (cwd) => CWD[cwd] ?? null,
    projects: async () => ({ projects: PROJECTS, error: null }),
    accountRepos: async () => [{ fullName: 'exemplo-labs/beta', lastPush: daysAgo(2) }, { fullName: 'exemplo-labs/old', lastPush: daysAgo(200) }],
    ...over,
  };
  return new RotaAnalytics({ storage, contas: new Accounts({ storage, file: null }), agora: () => NOW, ...(withDelivery ? { delivery } : {}) });
}
const ask = async (r: RotaAnalytics, path: string) => r.responder(normalizeLegacyUrl(new URL(path, 'http://127.0.0.1')));
const body = async (r: RotaAnalytics, path: string) => {
  const res = await ask(r, path);
  assert.equal(res.status, 200, JSON.stringify(res.corpo));
  return res.corpo as Json;
};
const rowOf = (v: Json, key: string) => v.rows.find((r: Json) => r.key === key);

describe('GET /api/analytics/delivery', () => {
  let storage: SqliteStorage;
  before(async () => (storage = await fixtures()));
  after(() => storage.close());

  test('#266/AC-1: the period numbers: merged PRs, median time to merge, open, Claude hours, cost and cost per merged PR', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    assert.equal(v.days, 30);
    assert.equal(v.groupBy, 'repo');
    assert.equal(v.key, null);
    assert.equal(v.timeZone, TZ);
    assert.equal(v.today, '2026-10-20');
    assert.equal(v.calendar.length, 30);
    assert.equal(v.calendar.at(-1), '2026-10-20');
    const t = v.totals;
    assert.equal(t.mergedPrs, 5); // alpha 4, beta 1
    assert.equal(t.medianLeadTimeMs, 6 * H); // 2 h, 5.5 h, 6 h, 24 h, 5 d
    assert.equal(t.openPrs, 3);
    assert.equal(t.openIssues, 4);
    assert.equal(t.claudeHours, 0.6); // s1 30 min + s2 6 min
    assert.ok(Math.abs(t.costUsd - OPUS) < 1e-6);
    assert.equal(t.costPartial, true);
    assert.ok(Math.abs(t.costPerMergedPr - OPUS / 5) < 1e-6);
    assert.equal(t.repos, 3);
    assert.equal(t.reposWithClaude, 2);
  });

  test('#266/AC-11: contributions by type per repository: opened and merged PRs, opened and closed issues, reviews', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    assert.deepEqual(rowOf(v, 'exemplo-labs/alpha').contributions, { openedPrs: 5, mergedPrs: 4, openedIssues: 2, closedIssues: 2, reviews: 2 });
    assert.deepEqual(rowOf(v, 'exemplo-labs/beta').contributions, { openedPrs: 1, mergedPrs: 1, openedIssues: 0, closedIssues: 0, reviews: 0 });
  });

  test('#266/AC-2: merged PRs per day in the person\'s time zone, with peak and total; Claude hours per day beside them', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    const a = rowOf(v, 'exemplo-labs/alpha');
    assert.equal(a.mergedPerDay.length, 30);
    const at = (day: string) => a.mergedPerDay[v.calendar.indexOf(day)];
    assert.equal(at('2026-10-19'), 2, 'yesterday, plus the 01:30 UTC merge of today');
    assert.equal(at('2026-10-20'), 0);
    assert.equal(at('2026-10-18'), 1);
    assert.equal(a.peak, 2);
    assert.equal(a.total, 4);
    assert.equal(a.claudeHoursPerDay.length, 30);
    assert.equal(a.claudeHoursPerDay[v.calendar.indexOf('2026-10-19')], 0.5);
    assert.equal(a.claudeHoursPerDay[v.calendar.indexOf('2026-10-18')], 0);
  });

  test('#266/AC-3: the effort and delivery table per repository', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    const a = rowOf(v, 'exemplo-labs/alpha');
    assert.equal(a.label, 'exemplo-labs/alpha');
    assert.deepEqual(a.repos, ['exemplo-labs/alpha']);
    assert.equal(a.mergedPrs, 4);
    assert.equal(a.medianLeadTimeMs, (5.5 + 24) / 2 * H);
    assert.equal(a.openPrs, 2);
    assert.equal(a.openIssues, 3);
    assert.equal(a.claudeHours, 0.5);
    assert.ok(Math.abs(a.costUsd - OPUS) < 1e-6);
    assert.equal(a.costPartial, false);
    assert.ok(Math.abs(a.costPerMergedPr - OPUS / 4) < 1e-6);
    assert.deepEqual(v.rows.map((r: Json) => r.key), ['exemplo-labs/alpha', 'exemplo-labs/beta', 'estudio-ficticio/gamma'], 'most merged first');
  });

  test('#266/AC-7: no session in the period gives null hours, cost and cost per PR; no merge gives null cost per PR; an unpriced model marks the cost partial', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    const b = rowOf(v, 'exemplo-labs/beta');
    assert.equal(b.claudeHours, null);
    assert.equal(b.costUsd, null);
    assert.equal(b.costPerMergedPr, null);
    assert.ok(b.claudeHoursPerDay.every((h: unknown) => h === null), 'unknown, never zero');
    const g = rowOf(v, 'estudio-ficticio/gamma');
    assert.equal(g.mergedPrs, 0);
    assert.equal(g.total, 0);
    assert.equal(g.peak, 0);
    assert.equal(g.medianLeadTimeMs, null);
    assert.equal(g.claudeHours, 0.1);
    assert.equal(g.costUsd, null, 'only an unpriced model: null, never zero');
    assert.equal(g.costPartial, true);
    assert.equal(g.costPerMergedPr, null);
  });

  test('#266/AC-4: open PRs and issues, the oldest first, with kind, number, title, repository, age and state', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}`);
    assert.deepEqual(v.openItems.map((i: Json) => [i.kind, i.number, i.state]), [
      ['issue', 10, 'issueWithoutPr'],
      ['pr', 20, 'draft'],
      ['issue', 11, 'issueWithPr'],
      ['issue', 7, 'issueWithoutPr'],
      ['pr', 21, 'ciFailed'],
      ['pr', 5, 'review'],
      ['pr', 22, 'approved'],
    ]);
    const first = v.openItems[0];
    assert.equal(first.repo, 'exemplo-labs/alpha');
    assert.equal(first.title, 'Issue 10');
    assert.equal(first.ageMs, NOW - Date.parse(daysAgo(41)));
    assert.deepEqual(first.rowKeys, ['exemplo-labs/alpha']);
    assert.equal(v.openItems.find((i: Json) => i.number === 11).linkedPr, 30);
    assert.equal(v.openItemsTotal, 7);
    assert.equal(v.openItemsTruncated, false);
  });

  test('#266/AC-5: groupBy=project switches every axis to projects; a repository in two projects counts in both, the totals count it once', async () => {
    const v = await body(route(storage), `/api/analytics/delivery?days=30&tz=${TZ}&groupBy=project`);
    assert.equal(v.groupBy, 'project');
    assert.deepEqual(v.rows.map((r: Json) => [r.key, r.label, r.repos]), [
      ['exemplo-labs/1', 'Loja de exemplo', ['exemplo-labs/alpha', 'exemplo-labs/beta']],
      ['exemplo-labs/2', 'Plataforma', ['exemplo-labs/beta', 'estudio-ficticio/gamma']],
    ]);
    const [p1, p2] = v.rows;
    assert.equal(p1.mergedPrs, 5);
    assert.equal(p2.mergedPrs, 1, 'beta counts in both projects');
    assert.equal(p1.claudeHours, 0.5);
    assert.equal(p2.claudeHours, 0.1, 'the effort is the sum of the sessions of its repositories');
    assert.deepEqual(p2.contributions, { openedPrs: 2, mergedPrs: 1, openedIssues: 0, closedIssues: 0, reviews: 0 });
    assert.equal(v.totals.mergedPrs, 5, 'beta once in the totals');
    assert.deepEqual(v.openItems.find((i: Json) => i.number === 5).rowKeys, ['exemplo-labs/1', 'exemplo-labs/2']);
    assert.deepEqual(v.options.projects.map((p: Json) => p.key), ['exemplo-labs/1', 'exemplo-labs/2']);
  });

  test('#266/AC-6: the period and the repository or project filter apply to the whole tab', async () => {
    const r = route(storage);
    const week = await body(r, `/api/analytics/delivery?days=7&tz=${TZ}`);
    assert.equal(week.calendar.length, 7);
    assert.equal(rowOf(week, 'exemplo-labs/alpha').mergedPrs, 3, 'the merge 15 days ago is outside 7 days');
    assert.equal(rowOf(week, 'exemplo-labs/alpha').contributions.reviews, 2);
    const one = await body(r, `/api/analytics/delivery?days=30&tz=${TZ}&key=exemplo-labs/beta`);
    assert.equal(one.key, 'exemplo-labs/beta');
    assert.deepEqual(one.rows.map((x: Json) => x.key), ['exemplo-labs/beta']);
    assert.equal(one.totals.mergedPrs, 1);
    assert.deepEqual(one.openItems.map((i: Json) => i.number), [5]);
    assert.equal(one.options.repos.length, 3, 'the options keep every repository');
    const project = await body(r, `/api/analytics/delivery?days=30&tz=${TZ}&groupBy=project&key=exemplo-labs/2`);
    assert.deepEqual(project.rows.map((x: Json) => x.key), ['exemplo-labs/2']);
    assert.equal(project.totals.claudeHours, 0.1);
    // The old name of the time zone parameter goes through the global alias (src/api/legacy-routes.ts).
    assert.equal((await body(r, `/api/analytics/delivery?days=30&fuso=${TZ}`)).timeZone, TZ);
  });

  test('#266/AC-6: an invalid period, grouping or key is a 400, like the cost route', async () => {
    const r = route(storage);
    assert.deepEqual(await ask(r, '/api/analytics/delivery?days=14'), { status: 400, corpo: { error: DAYS_ERROR } });
    assert.deepEqual(await ask(r, '/api/analytics/delivery?groupBy=person'), { status: 400, corpo: { error: GROUP_BY_ERROR } });
    assert.deepEqual(await ask(r, '/api/analytics/delivery?key=../x'), { status: 400, corpo: { error: KEY_ERROR } });
    assert.deepEqual(await ask(r, '/api/analytics/delivery?groupBy=project&key=exemplo-labs/alpha'), { status: 400, corpo: { error: KEY_ERROR } });
  });

  test('#266/AC-8: without GitHub the tab gets no repository by default, so the screen explains how to connect', async () => {
    for (const r of [route(storage, {}, false), route(storage, { github: githubWith('disconnected', null) })]) {
      const v = await body(r, `/api/analytics/delivery?days=30&tz=${TZ}`);
      assert.equal(v.github.status, 'disconnected');
      assert.equal(v.github.readAt, null);
      assert.deepEqual(v.rows, []);
      assert.deepEqual(v.openItems, []);
      assert.deepEqual(v.options.repos, []);
      assert.equal(v.totals.mergedPrs, null);
      assert.equal(v.totals.claudeHours, null);
    }
  });

  test('#266/AC-8: GitHub down or rate limited: the cached data with the read time and the flag, the Claude side still live', async () => {
    const readAt = NOW - 3 * H;
    const v = await body(route(storage, { github: githubWith('stale', readAt) }), `/api/analytics/delivery?days=30&tz=${TZ}`);
    assert.equal(v.github.status, 'stale');
    assert.equal(v.github.readAt, new Date(readAt).toISOString());
    assert.equal(v.github.error, 'GitHub limitou as chamadas');
    assert.equal(v.totals.mergedPrs, 5);
    assert.equal(v.totals.claudeHours, 0.6);
  });

  test('#266/AC-9: no axis per person: no author, assignee, reviewer or login anywhere in the payload, and none asked from GitHub', async () => {
    const forbidden = /^(author|authors|assignee|assignees|reviewer|reviewers|login|user|person|people|owner)$/i;
    const keys = (x: unknown, out: string[] = []): string[] => {
      if (Array.isArray(x)) x.forEach((y) => keys(y, out));
      else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) out.push(k), keys(y, out);
      return out;
    };
    for (const groupBy of ['repo', 'project']) {
      const v = await body(route(storage), `/api/analytics/delivery?days=90&tz=${TZ}&groupBy=${groupBy}`);
      assert.deepEqual(keys(v).filter((k) => forbidden.test(k)), []);
    }
    for (const q of Object.values(DELIVERY_QUERIES)) assert.doesNotMatch(q, /\b(author|assignees?|login|reviewRequests|editor)\b/);
  });
});

describe('#266 delivery building blocks', () => {
  test('#266/AC-3: Claude hours are the gaps between a session\'s events up to 10 min, on the day of each gap in the time zone', () => {
    const calendar = ['2026-10-18', '2026-10-19', '2026-10-20'];
    const times = ['2026-10-19T13:00:00Z', '2026-10-19T13:09:00Z', '2026-10-19T13:30:00Z', '2026-10-20T02:50:00Z', '2026-10-20T02:59:00Z'];
    // 9 min on the 19th; the 21-min gap is idle; 02:50 UTC is the 19th in São Paulo: 9 min more.
    assert.deepEqual(activeHoursPerDay(times, calendar, TZ).map((h) => Math.round(h * 60)), [0, 18, 0]);
  });

  test('#266/AC-4: the open item state, in English (the screen writes it in pt-BR)', () => {
    assert.deepEqual([...OPEN_ITEM_STATES], ['draft', 'review', 'ciFailed', 'approved', 'issueWithPr', 'issueWithoutPr']);
    assert.deepEqual(openItemState(openPr(1, daysAgo(1), { isDraft: true, reviewDecision: 'APPROVED' })), { state: 'draft', linkedPr: null });
    assert.deepEqual(openItemState(openPr(1, daysAgo(1), { reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] } })), { state: 'ciFailed', linkedPr: null });
    assert.deepEqual(openItemState(openPr(1, daysAgo(1), { reviewDecision: 'APPROVED' })), { state: 'approved', linkedPr: null });
    assert.deepEqual(openItemState(openPr(1, daysAgo(1), { reviewDecision: 'CHANGES_REQUESTED', commits: null })), { state: 'review', linkedPr: null });
    assert.deepEqual(openItemState(openIssue(2, daysAgo(1), 9)), { state: 'issueWithPr', linkedPr: 9 });
    assert.deepEqual(openItemState(openIssue(2, daysAgo(1))), { state: 'issueWithoutPr', linkedPr: null });
  });
});

describe('#266 DeliveryGithub: never waits for GitHub', () => {
  const raw = (repo: string): DeliveryRaw => ({ repo, since: '2026-07-21', openPrs: 0, openIssues: 0, prs: [], issues: [], open: [], truncated: [] });

  test('#266/AC-8: first read is loading, then connected with the read time; a change is recorded so the screen re-reads', async () => {
    let now = NOW;
    const recorded: string[] = [];
    const source: DeliverySource = { delivery: async (o, n) => (n === 'missing' ? null : raw(`${o}/${n}`)) };
    const g = new DeliveryGithub({ source, cache: new GithubCache({ store: new MemoryCacheStore(), now: () => now }), now: () => now, changes: { record: (c) => void recorded.push(`${c.type}:${c.key}`) } });
    const first = await g.read(['exemplo-labs/alpha', 'exemplo-labs/missing']);
    assert.equal(first.status, 'loading');
    assert.equal(first.pending, 2);
    await g.settle();
    now += 1000;
    const second = await g.read(['exemplo-labs/alpha', 'exemplo-labs/missing']);
    assert.equal(second.status, 'connected');
    assert.equal(second.readAt, NOW);
    assert.deepEqual([...second.repos.keys()], ['exemplo-labs/alpha']);
    assert.ok(recorded.includes('repos:delivery'));
  });

  test('#266/AC-8: GitHub failing after a read keeps the cached data and says stale; no token says disconnected', async () => {
    let now = NOW;
    let fail: Error | null = null;
    const source: DeliverySource = { delivery: async (o, n) => { if (fail) throw fail; return raw(`${o}/${n}`); } };
    const cache = new GithubCache({ store: new MemoryCacheStore(), now: () => now });
    const g = new DeliveryGithub({ source, cache, now: () => now });
    await g.read(['exemplo-labs/alpha']);
    await g.settle();
    now += 10 * 60_000;
    fail = new RateLimitedError('GitHub limitou as chamadas: API rate limit exceeded', 60_000);
    await g.read(['exemplo-labs/alpha']);
    await g.settle();
    const stale = await g.read(['exemplo-labs/alpha']);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.readAt, NOW);
    assert.match(stale.error ?? '', /limitou/);
    assert.equal(stale.repos.size, 1);

    const none = new DeliveryGithub({ source: { delivery: async () => { throw new SemGithubError('gh sem login'); } }, cache: new GithubCache({ store: new MemoryCacheStore(), now: () => now }), now: () => now });
    await none.read(['exemplo-labs/alpha']);
    await none.settle();
    assert.equal((await none.read(['exemplo-labs/alpha'])).status, 'disconnected');
    assert.equal((await new DeliveryGithub({ source: null, cache, now: () => now }).read(['exemplo-labs/alpha'])).status, 'disconnected');
  });
});

describe('#266 DeliveryGithub: the screen learns of every outcome', () => {
  test('#266/AC-8: a failed read and a missing token record a change too, and GitHub down with nothing cached is an error, not stale', async () => {
    const recorded: string[] = [];
    const changes = { record: (c: { key: string }) => void recorded.push(c.key) };
    const down = new DeliveryGithub({ source: { delivery: async () => { throw new Error('o GitHub respondeu 502'); } }, cache: new GithubCache({ store: new MemoryCacheStore(), now: () => NOW }), now: () => NOW, changes });
    await down.read(['exemplo-labs/alpha']);
    await down.settle();
    const r = await down.read(['exemplo-labs/alpha']);
    assert.equal(r.status, 'error');
    assert.equal(r.readAt, null);
    assert.match(r.error ?? '', /^exemplo-labs\/alpha: .*502/);
    assert.equal(recorded.length, 1);
    assert.equal(r.pending, 0, 'a failed read is not retried on every request');

    const none = new DeliveryGithub({ source: { delivery: async () => { throw new SemGithubError('gh sem login'); } }, cache: new GithubCache({ store: new MemoryCacheStore(), now: () => NOW }), now: () => NOW, changes });
    assert.equal((await none.read(['exemplo-labs/alpha'])).status, 'loading');
    await none.settle();
    assert.equal(recorded.length, 2);
    assert.equal((await none.read(['exemplo-labs/alpha'])).status, 'disconnected');
  });

  test('#266/AC-5: the Projects never wait for GitHub: the last read answers while the next one runs', async () => {
    let release: () => void = () => {};
    const recorded: string[] = [];
    const projects = latestProjects(
      () => new Promise((resolve) => (release = () => resolve([{ owner: 'exemplo-labs', number: 1, title: 'Quadro', lanes: [{ id: null, name: 'x', color: null, items: [{ repo: 'exemplo-labs/a' } as never] }] }]))),
      { record: (c) => void recorded.push(c.key) },
    );
    assert.deepEqual(await projects(), { projects: [], error: null });
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual((await projects()).projects, [{ key: 'exemplo-labs/1', label: 'Quadro', repos: ['exemplo-labs/a'] }]);
    assert.deepEqual(recorded, ['delivery']);
  });
});

describe('#266 the fake GitHub answers the delivery read', () => {
  test('#266/AC-2/AC-4: RepoDelivery through the real adapter: merges, reviews and open items, and two demo projects sharing a repository', async () => {
    const fake = createFakeGithub(DEMO_DELIVERY_GITHUB_DATA, { now: () => NOW });
    const source = new GithubDeliverySource(new GithubReposSource({ token: 'demo', fetch: fake.fetch, url: 'https://github-falso.invalid/graphql', api: 'https://github-falso.invalid' }));
    const d = await source.delivery('exemplo-labs', 'motor-de-regras', '2026-07-21');
    assert.ok(d);
    assert.equal(d.repo, 'exemplo-labs/motor-de-regras');
    assert.ok(d.prs.some((p) => p.mergedAt), 'merged PRs in the period');
    assert.ok(d.prs.some((p) => (p.reviews?.nodes.length ?? 0) > 0), 'reviews with their time');
    assert.equal(d.openPrs, 5);
    assert.equal(d.openIssues, 9);
    assert.equal(d.open.length, 14);
    const ages = d.open.map((i) => Date.parse(i.createdAt));
    assert.deepEqual(ages, [...ages].sort((a, b) => a - b), 'oldest first');
    assert.ok(d.open.every((i) => i.title && i.number > 0));
    assert.equal(await source.delivery('exemplo-labs', 'nao-existe', '2026-07-21'), null);

    const repos = new Set(DEMO_DELIVERY_GITHUB_DATA.repos.map((r) => `${r.owner}/${r.name}`));
    assert.ok(DEMO_DELIVERY_PROJECTS.length >= 2);
    for (const p of DEMO_DELIVERY_PROJECTS) for (const r of p.repos) assert.ok(repos.has(r), `${r} is a demo repository`);
    const all = DEMO_DELIVERY_PROJECTS.flatMap((p) => p.repos);
    assert.ok(all.length > new Set(all).size, 'one repository in two projects');
  });
});

describe('#266 the demo wiring', () => {
  test('#266/AC-5/AC-7: createCoreDelivery({ demo }) reads the fake GitHub only: a repository with no session, three projects, one repository in two', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    try {
      const delivery = createCoreDelivery({
        demo: true, noGithub: false, cache: new GithubCache({ store: new MemoryCacheStore() }), queue: new GithubCallQueue(), changes: { record: () => null },
        sessions: { repoDe: () => null }, boards: async () => { throw new Error('the demo does not read the kanban'); }, accountRepos: async () => [],
      });
      const r = new RotaAnalytics({ storage, delivery, deliveryCacheMs: 0 });
      await ask(r, '/api/analytics/delivery?groupBy=project');
      await (delivery.github as DeliveryGithub).settle();
      const v = await body(r, '/api/analytics/delivery?groupBy=project');
      assert.equal(v.github.status, 'connected');
      assert.deepEqual(v.rows.map((x: Json) => x.label).sort(), ['Loja de exemplo', 'Métricas', 'Plataforma de regras']);
      assert.ok(v.rows.every((x: Json) => x.claudeHours === null && x.mergedPrs > 0));
      const byRepo = await body(r, '/api/analytics/delivery');
      assert.ok(byRepo.rows.some((x: Json) => x.key === 'estudio-ficticio/portal-de-ajuda'));
    } finally {
      storage.close();
    }
  });

  test('#266/AC-5: a Project row has the repositories with items in it, drafts left out', () => {
    const item = (repo: string | null) => ({ repo }) as never;
    const g = projectGroupOf({ owner: 'exemplo-labs', number: 3, title: 'Quadro', lanes: [{ id: null, name: 'x', color: null, items: [item('exemplo-labs/b'), item(null), item('exemplo-labs/a'), item('exemplo-labs/b')] }] });
    assert.deepEqual(g, { key: 'exemplo-labs/3', label: 'Quadro', repos: ['exemplo-labs/a', 'exemplo-labs/b'] });
  });
});
