/*
 * #534 the Plan steps use cases: each runs through the write seam of layer 1 (#533), so the cache holds what
 * GitHub returned, a failure leaves it as it was, and the step's own cache entry is dropped when its fields change.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { WorkIssueWrittenUnreadError, type WorkIssueRead, type WorkIssueSource, type WorkIssueWriter } from '../../src/github/work-issue.ts';
import { WorkIssueConflictError, WorkIssueNotFoundError, WorkIssueService, workIssueCacheKey } from '../../src/github/work-issue-service.ts';
import { clock, k, REPO } from './helpers.ts';
import { trustOf } from '../fixtures.ts';

const issueRead = (n: number, over: Partial<WorkIssueRead> = {}): WorkIssueRead => ({
  key: k(n), repo: REPO, number: n, title: `read of ${n}`, updatedAt: '2026-11-10T10:00:00Z', url: `https://github.com/${REPO}/issues/${n}`, state: 'OPEN', type: 'Plan',
  labels: [], milestone: null, body: '', comments: [], commentsTotal: 0, parentChain: [], subIssues: [], pullRequests: [], ...over,
});

class FakeWriter implements WorkIssueWriter {
  calls: string[] = [];
  missing = false;
  unread: Error | null = null;
  step = { title: 'step on github', body: 'step body', updatedAt: '2026-11-10T10:00:00Z' };
  private after(parent: string): WorkIssueRead {
    return issueRead(Number(parent.split('#')[1]), { title: 'after the write' });
  }
  private done(parent: string) {
    if (this.unread) throw new WorkIssueWrittenUnreadError(parent, this.unread);
    return this.missing ? null : this.after(parent);
  }
  async current() { return null; }
  async update() { return null; }
  async comment() { return null; }
  async stepCurrent(parent: string, step: string) {
    this.calls.push(`stepCurrent ${parent} ${step}`);
    return this.missing ? null : { ...this.step };
  }
  async editStep(parent: string, step: string, edit: { title?: string; body?: string }) {
    this.calls.push(`editStep ${parent} ${step} ${JSON.stringify(edit)}`);
    return this.done(parent);
  }
  async addStep(parent: string, step: { title: string; body: string }) {
    this.calls.push(`addStep ${parent} ${JSON.stringify(step)}`);
    return this.done(parent);
  }
  async removeStep(parent: string, step: string) {
    this.calls.push(`removeStep ${parent} ${step}`);
    return this.done(parent);
  }
  async restoreStep(parent: string, step: string) {
    this.calls.push(`restoreStep ${parent} ${step}`);
    return this.done(parent);
  }
  async moveStep(parent: string, step: string, after: string | null) {
    this.calls.push(`moveStep ${parent} ${step} ${after}`);
    return this.done(parent);
  }
}

function setup() {
  const writer = new FakeWriter();
  const cache = new GithubCache({ store: new MemoryCacheStore(), now: clock() });
  const source: WorkIssueSource = { issue: async (key) => issueRead(Number(key.split('#')[1])) };
  const service = new WorkIssueService({ trust: trustOf('ahrenatechnology'), source, writer, cache });
  return { writer, cache, service };
}

describe('#534/AC-1 editing a step', () => {
  test("#534/AC-1 Given the step's updatedAt the /ui read, Then the step is written and the answer and the cache of the issue carry the write; the step's own entry is dropped", async () => {
    const { writer, cache, service } = setup();
    await service.issue(k(601));
    assert.ok(await cache.peek(workIssueCacheKey(k(601))));
    const r = await service.editStep(k(534), k(601), { title: 'T' }, '2026-11-10T10:00:00Z');
    assert.deepEqual([r.title, r.stale], ['after the write', false]);
    assert.deepEqual(writer.calls, [`stepCurrent ${k(534)} ${k(601)}`, `editStep ${k(534)} ${k(601)} {"title":"T"}`]);
    assert.equal((await cache.peek<WorkIssueRead>(workIssueCacheKey(k(534))))!.value!.title, 'after the write');
    assert.equal(await cache.peek(workIssueCacheKey(k(601))), null);
  });

  test("#534/AC-1 Given GitHub's step is newer, Then WorkIssueConflictError carries it and nothing is written", async () => {
    const { writer, service } = setup();
    writer.step.updatedAt = '2026-11-11T09:00:00Z';
    await assert.rejects(service.editStep(k(534), k(601), { title: 'T' }, '2026-11-10T10:00:00Z'), (e: any) => e instanceof WorkIssueConflictError && e.current.title === 'step on github');
    assert.deepEqual(writer.calls, [`stepCurrent ${k(534)} ${k(601)}`]);
  });
});

describe('#534/AC-2 to AC-4 the other operations go through the same seam', () => {
  test('#534/AC-2 add, #534/AC-3 move and #534/AC-4 remove each answer the issue as GitHub returned it and store it', async () => {
    const { writer, cache, service } = setup();
    assert.equal((await service.addStep(k(534), { title: 'new', body: '' })).title, 'after the write');
    assert.equal((await service.moveStep(k(534), k(601), null)).title, 'after the write');
    assert.equal((await service.removeStep(k(534), k(601))).title, 'after the write');
    assert.deepEqual(writer.calls, [`addStep ${k(534)} {"title":"new","body":""}`, `moveStep ${k(534)} ${k(601)} null`, `removeStep ${k(534)} ${k(601)}`]);
    assert.ok(await cache.peek(workIssueCacheKey(k(534))));
  });

  test("#534/AC-4 removing a step drops the step's own cache entry", async () => {
    const { cache, service } = setup();
    await service.issue(k(601));
    await service.removeStep(k(534), k(601));
    assert.equal(await cache.peek(workIssueCacheKey(k(601))), null);
  });
});

describe('#534/AC-4 restoring a removed step', () => {
  test("#534/AC-4 restore answers the issue as GitHub returned it, stores it, and drops the step's own cache entry", async () => {
    const { writer, cache, service } = setup();
    await service.issue(k(601));
    assert.equal((await service.restoreStep(k(534), k(601))).title, 'after the write');
    assert.deepEqual(writer.calls, [`restoreStep ${k(534)} ${k(601)}`]);
    assert.ok(await cache.peek(workIssueCacheKey(k(534))));
    assert.equal(await cache.peek(workIssueCacheKey(k(601))), null);
  });

  test('#534/AC-5 restore of an unknown issue is WorkIssueNotFoundError; written but unread drops both entries', async () => {
    const { writer, cache, service } = setup();
    writer.missing = true;
    await assert.rejects(service.restoreStep(k(534), k(601)), WorkIssueNotFoundError);
    writer.missing = false;
    await service.issue(k(534));
    await service.issue(k(601));
    writer.unread = new Error('raw read-back text');
    await assert.rejects(service.restoreStep(k(534), k(601)), WorkIssueWrittenUnreadError);
    assert.equal(await cache.peek(workIssueCacheKey(k(534))), null);
    assert.equal(await cache.peek(workIssueCacheKey(k(601))), null);
  });
});

describe('#534/AC-5 failures leave the cache as it was', () => {
  test('#534/AC-5 an unknown issue is WorkIssueNotFoundError from each operation', async () => {
    const { writer, service } = setup();
    writer.missing = true;
    for (const run of [() => service.editStep(k(534), k(601), { title: 'T' }, '2026-11-10T10:00:00Z'), () => service.addStep(k(534), { title: 'x', body: '' }), () => service.removeStep(k(534), k(601)), () => service.moveStep(k(534), k(601), null)]) {
      await assert.rejects(run(), WorkIssueNotFoundError);
    }
  });

  test('#534/AC-5 written but unread drops the issue and the step entries; the raw text goes to the log', async () => {
    const logs: string[] = [];
    const writer = new FakeWriter();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now: clock() });
    const service = new WorkIssueService({ trust: trustOf('ahrenatechnology'), source: { issue: async (key) => issueRead(Number(key.split('#')[1])) }, writer, cache, log: (m) => logs.push(m) });
    await service.issue(k(534));
    await service.issue(k(601));
    writer.unread = new Error('raw read-back text');
    await assert.rejects(service.removeStep(k(534), k(601)), WorkIssueWrittenUnreadError);
    assert.equal(await cache.peek(workIssueCacheKey(k(534))), null);
    assert.equal(await cache.peek(workIssueCacheKey(k(601))), null);
    assert.ok(logs.some((l) => l.includes('raw read-back text')));
  });
});
