/*
 * #506 the issue detail use case: one read of the issue through the ADR-0001 cache, with the issue's
 * Project Status from the chosen Project. The source and the Project are test doubles.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GITHUB_TTL, GithubCache, MemoryCacheStore, NoDataError, RateLimitedError } from '../../src/github/cache.ts';
import type { ProjectBoard, ProjectCard } from '../../src/github/project.ts';
import type { WorkProjectBoard } from '../../src/github/work-board.ts';
import { WorkIssueWrittenUnreadError, type WorkIssueCurrent, type WorkIssueEdit, type WorkIssueRead, type WorkIssueSource, type WorkIssueWriter } from '../../src/github/work-issue.ts';
import { workIssueCacheKey, WorkIssueConflictError, WorkIssueNotFoundError, WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, k, REPO } from './helpers.ts';

const issueRead = (n: number, over: Partial<WorkIssueRead> = {}): WorkIssueRead => ({
  key: k(n),
  repo: REPO,
  number: n,
  title: `read of ${n}`,
  updatedAt: '2026-11-10T10:00:00Z',
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

  test('#506/AC-3 Given GitHub down and nothing stored, Then it throws NoDataError and the raw message goes to the log', async () => {
    const { source, service, logs } = setup();
    source.fail = new TypeError('fetch failed');
    await assert.rejects(service.issue(k(506)), (e) => e instanceof NoDataError);
    assert.ok(logs.some((l) => l.includes('no data') && l.includes('fetch failed')), 'the raw message is logged');
  });

  test('#506/AC-3 Given GitHub has no such issue, Then it throws WorkIssueNotFoundError and stores nothing', async () => {
    const { source, service, cache } = setup();
    source.missing.add(k(999));
    await assert.rejects(service.issue(k(999)), (e) => e instanceof WorkIssueNotFoundError);
    assert.equal(await cache.peek(`github:work-issue:${k(999).toLowerCase()}`), null);
    // #506 an issue created meanwhile is read on the next call
    source.missing.clear();
    assert.equal((await service.issue(k(999))).number, 999);
  });
});

/** #533 GitHub as the write port sees it: one issue with a title, a body and an `updatedAt` that moves on every write. */
class FakeWriter implements WorkIssueWriter {
  calls: string[] = [];
  fail: Error | null = null;
  missing = false;
  /** #533 the write is applied, then the read-back fails. */
  unread: Error | null = null;
  github = { title: 'on github', body: 'body on github', updatedAt: '2026-11-10T10:00:00Z' };
  async current(key: string): Promise<WorkIssueCurrent | null> {
    this.calls.push(`current ${key}`);
    if (this.fail) throw this.fail;
    return this.missing ? null : { ...this.github };
  }
  async update(key: string, edit: WorkIssueEdit): Promise<WorkIssueRead | null> {
    this.calls.push(`update ${key} ${JSON.stringify(edit)}`);
    if (this.fail) throw this.fail;
    if (this.missing) return null;
    if (this.unread) throw new WorkIssueWrittenUnreadError(key, this.unread);
    this.github = { title: edit.title ?? this.github.title, body: edit.body ?? this.github.body, updatedAt: '2026-11-12T12:00:00Z' };
    return issueRead(Number(key.split('#')[1]), { ...this.github, labels: edit.labels ?? [] });
  }
  async comment(key: string, body: string): Promise<WorkIssueRead | null> {
    this.calls.push(`comment ${key} ${body}`);
    if (this.fail) throw this.fail;
    if (this.missing) return null;
    if (this.unread) throw new WorkIssueWrittenUnreadError(key, this.unread);
    return issueRead(Number(key.split('#')[1]), { ...this.github, updatedAt: '2026-11-12T13:00:00Z', comments: [{ author: 'me', createdAt: '2026-11-12T13:00:00Z', body }], commentsTotal: 1 });
  }
  // #534 the Plan steps have their own tests (work-plan-steps-service.test.ts).
  async stepCurrent(): Promise<WorkIssueCurrent | null> { return null; }
  async editStep(): Promise<WorkIssueRead | null> { return null; }
  async addStep(): Promise<WorkIssueRead | null> { return null; }
  async removeStep(): Promise<WorkIssueRead | null> { return null; }
  async restoreStep(): Promise<WorkIssueRead | null> { return null; }
  async moveStep(): Promise<WorkIssueRead | null> { return null; }
}

function setupWrite() {
  const base = setup();
  const writer = new FakeWriter();
  const logs: string[] = [];
  const service = new WorkIssueService({ source: base.source, writer, cache: base.cache, log: (m) => logs.push(m) });
  return { ...base, writer, service, logs };
}

describe('#533/AC-1 the write goes to GitHub and the cache holds what GitHub returned', () => {
  test('#533/AC-1 Given a title save opened at the current updatedAt, Then GitHub is written, the answer is the issue as returned (new updatedAt) and the next read is served by the cache', async () => {
    const { writer, source, service } = setupWrite();
    const r = await service.update(k(533), { title: 'new title' }, '2026-11-10T10:00:00Z');
    assert.deepEqual([r.title, r.updatedAt, r.stale, r.staleReason], ['new title', '2026-11-12T12:00:00Z', false, null]);
    assert.equal(writer.calls.length, 2, 'one check, one write');
    const again = await service.issue(k(533));
    assert.equal(again.title, 'new title');
    assert.equal(source.calls.length, 0, 'the read never called GitHub');
  });

  test('#533/AC-1 Given labels, type, milestone or parent, Then they are written with no conflict check', async () => {
    const { writer, service } = setupWrite();
    await service.update(k(533), { labels: ['backend'], type: 'Plan', milestone: 'Work board', parent: `${REPO}#478` });
    assert.equal(writer.calls.length, 1);
    assert.ok(writer.calls[0].startsWith(`update ${k(533)}`) && writer.calls[0].includes('"labels":["backend"]'));
  });

  test('#533/AC-1 Given a comment, Then it is written and the answer and the cache carry the issue with it', async () => {
    const { writer, service } = setupWrite();
    const r = await service.comment(k(533), 'hello');
    assert.deepEqual([r.commentsTotal, r.comments[0].body], [1, 'hello']);
    assert.deepEqual(writer.calls, [`comment ${k(533)} hello`]);
    assert.equal((await service.issue(k(533))).comments[0].body, 'hello');
  });

  test('#533/AC-1 a missing issue is WorkIssueNotFoundError for every write', async () => {
    const { writer, service } = setupWrite();
    writer.missing = true;
    await assert.rejects(service.update(k(533), { labels: [] }), (e) => e instanceof WorkIssueNotFoundError);
    await assert.rejects(service.update(k(533), { title: 't' }, '2026-11-10T10:00:00Z'), (e) => e instanceof WorkIssueNotFoundError);
    await assert.rejects(service.comment(k(533), 'x'), (e) => e instanceof WorkIssueNotFoundError);
  });
});

describe('#533/AC-2 a title or body save older than GitHub is not written', () => {
  test("#533/AC-2 Given GitHub was edited after the panel opened, When it saves a title, Then nothing is written and the conflict carries GitHub's title, body and updatedAt", async () => {
    const { writer, service, cache } = setupWrite();
    writer.github.updatedAt = '2026-11-11T09:00:00Z';
    await assert.rejects(service.update(k(533), { title: 'mine' }, '2026-11-10T10:00:00Z'), (e) => {
      assert.ok(e instanceof WorkIssueConflictError);
      assert.deepEqual(e.current, { title: 'on github', body: 'body on github', updatedAt: '2026-11-11T09:00:00Z' });
      return true;
    });
    assert.deepEqual(writer.calls, [`current ${k(533)}`], 'no write');
    assert.equal(await cache.peek(workIssueCacheKey(k(533))), null);
  });

  test('#533/AC-2 the same for a body, and a save at exactly GitHub updatedAt is written', async () => {
    const { writer, service } = setupWrite();
    writer.github.updatedAt = '2026-11-11T09:00:00Z';
    await assert.rejects(service.update(k(533), { body: 'mine' }, '2026-11-10T10:00:00Z'), (e) => e instanceof WorkIssueConflictError);
    const r = await service.update(k(533), { body: 'mine' }, '2026-11-11T09:00:00Z');
    assert.equal(r.body, 'mine');
  });

  test('#533/AC-2 a labels save carries no check even when GitHub is newer', async () => {
    const { writer, service } = setupWrite();
    writer.github.updatedAt = '2026-11-11T09:00:00Z';
    await service.update(k(533), { labels: ['x'] }, '2026-11-01T00:00:00Z');
    assert.ok(!writer.calls.some((c) => c.startsWith('current')));
  });
});

describe('#533/AC-3 a GitHub refusal leaves the cache as it was', () => {
  test('#533/AC-3 Given a stored issue and GitHub refusing the write, Then the error goes up, the raw text goes to the log and the cache entry is unchanged', async () => {
    const { writer, service, cache, logs, now } = setupWrite();
    await service.issue(k(533));
    const before = await cache.peek(workIssueCacheKey(k(533)));
    writer.fail = new Error('secret raw refusal');
    await assert.rejects(service.update(k(533), { labels: ['x'] }), /secret raw refusal/);
    await assert.rejects(service.comment(k(533), 'x'), /secret raw refusal/);
    assert.deepEqual(await cache.peek(workIssueCacheKey(k(533))), before);
    assert.ok(logs.some((l) => l.includes('secret raw refusal')));
    now.add(1);
  });

  test('#533/AC-3 Given GitHub limited the calls, Then the pause is kept and the next write throws without calling GitHub', async () => {
    const { writer, service } = setupWrite();
    writer.fail = new RateLimitedError('limited', 60_000);
    await assert.rejects(service.comment(k(533), 'x'), (e) => e instanceof RateLimitedError);
    writer.calls.length = 0;
    await assert.rejects(service.comment(k(533), 'x'), (e) => e instanceof RateLimitedError);
    assert.deepEqual(writer.calls, []);
  });

  test('#533/AC-3 Given a service without a writer (--demo), Then a write throws WorkIssueWriteOffError', async () => {
    const base = setup();
    await assert.rejects(base.service.comment(k(533), 'x'), (e) => e instanceof Error && e.name === 'WorkIssueWriteOffError');
  });
});

describe('#533/AC-3 a write applied whose read-back fails drops the cached version', () => {
  test('#533/AC-3 Given a stored issue and a write whose read-back fails, Then the error goes up, the raw text goes to the log and the cache entry is gone, so the next read asks GitHub', async () => {
    const { writer, service, cache, logs, source } = setupWrite();
    await service.issue(k(533));
    writer.unread = new Error('secret raw timeout');
    await assert.rejects(service.update(k(533), { labels: ['x'] }), (e) => e instanceof WorkIssueWrittenUnreadError);
    assert.equal(await cache.peek(workIssueCacheKey(k(533))), null);
    assert.ok(logs.some((l) => l.includes('secret raw timeout')));
    await assert.rejects(service.comment(k(533), 'x'), (e) => e instanceof WorkIssueWrittenUnreadError);
    const before = source.calls.length;
    await service.issue(k(533));
    assert.equal(source.calls.length, before + 1);
  });
});
