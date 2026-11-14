/*
 * #590 the issue options use case: one read of a repository's options through the ADR-0001 cache, the
 * source a test double (the seam the service reads GitHub through).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCache, MemoryCacheStore, NoDataError } from '../../src/github/cache.ts';
import { WorkIssueOptionsService, WorkRepositoryNotFoundError, type WorkIssueOptions, type WorkIssueOptionsSource } from '../../src/github/work-issue-options.ts';
import { clock, REPO } from './helpers.ts';

const OPTIONS: WorkIssueOptions = { labels: ['bug'], types: ['Plan'], milestones: ['Sprint 2'], parents: [{ key: `${REPO}#1`, title: 'Epic' }] };

class FakeSource implements WorkIssueOptionsSource {
  calls: string[] = [];
  fail: Error | null = null;
  missing = false;
  async options(repo: string): Promise<WorkIssueOptions | null> {
    this.calls.push(repo);
    if (this.fail) throw this.fail;
    return this.missing ? null : OPTIONS;
  }
}

function setup() {
  const now = clock();
  const source = new FakeSource();
  const logs: string[] = [];
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const service = new WorkIssueOptionsService({ source, cache, log: (m) => logs.push(m) });
  return { source, service, logs, now };
}

describe('WorkIssueOptionsService', () => {
  test('#590/AC-1 serves the options and does not call the source again inside the TTL', async () => {
    const { source, service } = setup();
    const a = await service.options(REPO);
    await service.options(REPO.toUpperCase());
    assert.deepEqual(a.labels, ['bug']);
    assert.equal(a.stale, false);
    assert.equal(source.calls.length, 1);
  });

  test('#590 a repository the source has not is not found, and nothing is cached for it', async () => {
    const { source, service } = setup();
    source.missing = true;
    await assert.rejects(() => service.options(REPO), WorkRepositoryNotFoundError);
    source.missing = false;
    const r = await service.options(REPO);
    assert.deepEqual(r.types, ['Plan']);
    assert.equal(source.calls.length, 2);
  });

  test('#590/AC-3 with nothing stored a failed read goes up as no data, its raw text only in the log', async () => {
    const { source, service, logs } = setup();
    source.fail = new Error('boom');
    await assert.rejects(() => service.options(REPO), NoDataError);
    assert.equal(logs.length, 1);
  });
});
