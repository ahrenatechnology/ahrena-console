/*
 * issue 506 the issue detail use case: one read of the issue through the ADR-0001 cache, with the issue's
 * Project Status from the chosen Project. The source and the Project are test doubles.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GITHUB_TTL, GithubCache, MemoryCacheStore, NoDataError, RateLimitedError } from '../../src/github/cache.ts';
import type { ProjectBoard, ProjectCard } from '../../src/github/project.ts';
import type { WorkProjectBoard } from '../../src/github/work-board.ts';
import type { WorkIssueRead, WorkIssueSource } from '../../src/github/work-issue.ts';
import { WorkIssueNotFoundError, WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, k, REPO } from './helpers.ts';

const issueRead = (n: number, over: Partial<WorkIssueRead> = {}): WorkIssueRead => ({
  key: k(n),
  repo: REPO,
  number: n,
  title: `read of ${n}`,
  url: `https://github.com/${REPO}/issues/${n}`,
  state: 'OPEN',
  type: 'Plan',
  labels: [],
  milestone: null,
  body: '',
  comments: [],
  commentsTotal: 0,
  parentChain: [],
  subIssues: [],
  pullRequests: [],
  ...over,
});

class FakeSource implements WorkIssueSource {
  calls: string[] = [];
  fail: Error | null = null;
  missing = new Set<string>();
  title = 'first';
  async issue(key: string): Promise<WorkIssueRead | null> {
    this.calls.push(key);
    if (this.fail) throw this.fail;
    if (this.missing.has(key)) return null;
    return issueRead(Number(key.split('#')[1]), { title: this.title });
  }
}

const card = (n: number, statusId: string | null): ProjectCard => ({
  itemId: `PVTI_${n}`, kind: 'Issue', key: k(n), repo: REPO, number: n, title: `issue ${n}`, url: null, state: 'OPEN', updatedAt: '', type: 'Plan', parent: null, statusId,
});

const projectBoard = (lanes: { id: string | null; name: string; cards: ProjectCard[] }[]): ProjectBoard => ({
  owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'u', field: 'Status',
  lanes: lanes.map((l) => ({ id: l.id, name: l.name, color: 'GRAY', items: l.cards })) as ProjectBoard['lanes'],
  count: 0, fetchedAt: 0, stale: false, staleReason: null, staleCode: null,
});

function setup(project?: WorkProjectBoard) {
  const now = clock();
  const source = new FakeSource();
  const logs: string[] = [];
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const service = new WorkIssueService({ source, cache, log: (m) => logs.push(m), ...(project ? { project } : {}) });
  return { now, source, logs, cache, service };
}

describe('#506/AC-1 the issue detail through the cache', () => {
  test('#506/AC-1 Given an issue read, When it is read again inside the TTL, Then GitHub is called once and the answer is not stale', async () => {
    const { source, service, now } = setup();
    const a = await service.issue(k(506));
    now.add(GITHUB_TTL.detail - 1);
    const b = await service.issue(k(506));
    assert.equal(source.calls.length, 1);
    assert.equal(b.title, 'first');
    assert.deepEqual([b.stale, b.staleReason, b.fetchedAt], [false, null, a.fetchedAt]);
  });

  test('#506/AC-1 Given a refresh after the TTL, Then it re-reads GitHub', async () => {
    const { source, service, now } = setup();
    await service.issue(k(506));
    source.title = 'second';
    now.add(GITHUB_TTL.detail);
    assert.equal((await service.issue(k(506))).title, 'second');
    assert.equal(source.calls.length, 2);
  });

  test('#506/AC-1 Given the issue is a card in the chosen Project, Then projectStatus is its lane name; a no-Status lane or no card is null', async () => {
    const board = projectBoard([
      { id: null, name: 'No Status', cards: [card(508, null)] },
      { id: 'opt-1', name: 'In Progress', cards: [card(506, 'opt-1')] },
    ]);
    const project: WorkProjectBoard = { board: async () => board };
    const { service } = setup(project);
    assert.equal((await service.issue(k(506))).projectStatus, 'In Progress');
    assert.equal((await service.issue(k(508))).projectStatus, null);
    assert.equal((await service.issue(k(509))).projectStatus, null);
  });

  test('#506/AC-1 Given the stored Project snapshot, Then it is used before reading GitHub', async () => {
    let reads = 0;
    const board = projectBoard([{ id: 'opt-1', name: 'Todo', cards: [card(506, 'opt-1')] }]);
    const { service } = setup({ board: async () => (reads++, board), snapshot: async () => board });
    assert.equal((await service.issue(k(506))).projectStatus, 'Todo');
    assert.equal(reads, 0);
  });

  test('#506/AC-1 Given the Project read fails or none is chosen, Then the issue still answers with a null projectStatus', async () => {
    const project: WorkProjectBoard = { board: async () => { throw new Error('no project'); } };
    const { service, logs } = setup(project);
    assert.equal((await service.issue(k(506))).projectStatus, null);
    assert.ok(logs.some((l) => l.includes('project status')));
  });
});

describe('#506/AC-3 GitHub down and an unknown issue', () => {
  test('#506/AC-3 Given a good read and GitHub then down, Then the last value answers stale with the stable code and fetchedAt', async () => {
    const { source, service, now, logs } = setup();
    const first = await service.issue(k(506));
    source.fail = new RateLimitedError('secret raw text', 60_000);
    now.add(GITHUB_TTL.detail);
    const r = await service.issue(k(506));
    assert.deepEqual([r.stale, r.staleReason, r.fetchedAt, r.title], [true, 'rate-limited', first.fetchedAt, 'first']);
    assert.ok(logs.some((l) => l.includes('secret raw text')), 'the raw text goes to the log');
    assert.ok(!JSON.stringify(r).includes('secret raw text'));
  });

  test('#506/AC-3 Given GitHub down and nothing stored, Then it throws NoDataError', async () => {
    const { source, service } = setup();
    source.fail = new TypeError('fetch failed');
    await assert.rejects(service.issue(k(506)), (e) => e instanceof NoDataError);
  });

  test('#506/AC-3 Given GitHub has no such issue, Then it throws WorkIssueNotFoundError and stores nothing', async () => {
    const { source, service, cache } = setup();
    source.missing.add(k(999));
    await assert.rejects(service.issue(k(999)), (e) => e instanceof WorkIssueNotFoundError);
    assert.equal(await cache.peek(`github:work-issue:${k(999).toLowerCase()}`), null);
    // an issue created meanwhile is read on the next call
    source.missing.clear();
    assert.equal((await service.issue(k(999))).number, 999);
  });
});
