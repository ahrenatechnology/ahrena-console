// #465 the parents outside the Project: one batched read per set of keys, behind the ADR-0001 cache.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GITHUB_TTL, GithubCache, MemoryCacheStore, NoDataError, type WorkNode } from '../../src/index.ts';
import { CachedParentLookup, parentsCacheKey } from '../../src/github/work-board-parents.ts';
import { clock, k, node } from './helpers.ts';

function setup() {
  const now = clock();
  const calls: string[][] = [];
  let down = false;
  const source = {
    async nodes(keys: readonly string[]): Promise<WorkNode[]> {
      calls.push([...keys]);
      if (down) throw new Error('GitHub fora');
      return keys.map((key) => node(Number(key.split('#')[1]), { title: `read ${calls.length}` }));
    },
  };
  const parents = new CachedParentLookup({ source, cache: new GithubCache({ store: new MemoryCacheStore(), now }) });
  return { now, calls, parents, goDown: () => (down = true) };
}

describe('#465 parents outside the Project', () => {
  test('one batched call for the whole set, with sorted unique keys', async () => {
    const { calls, parents } = setup();
    const found = await parents.nodes([k(7), k(3), k(7)]);
    assert.deepEqual(calls, [[k(3), k(7)]]);
    assert.deepEqual(found.map((n) => n.key), [k(3), k(7)]);
  });

  test('#465 the cache key sorts and dedupes the keys itself', () => {
    assert.equal(parentsCacheKey([k(7), k(3), k(7)]), parentsCacheKey([k(3), k(7)]));
  });

  test('the same set in any order is served from the cache inside the TTL', async () => {
    const { calls, parents } = setup();
    await parents.nodes([k(3), k(7)]);
    await parents.nodes([k(7), k(3)]);
    assert.equal(calls.length, 1);
  });

  test('re-reads after the TTL', async () => {
    const { now, calls, parents } = setup();
    await parents.nodes([k(3)]);
    now.add(GITHUB_TTL.issues);
    const again = await parents.nodes([k(3)]);
    assert.equal(calls.length, 2);
    assert.equal(again[0].title, 'read 2');
  });

  test('GitHub down after one read returns the last value', async () => {
    const { now, calls, parents, goDown } = setup();
    await parents.nodes([k(3)]);
    goDown();
    now.add(GITHUB_TTL.issues);
    const stale = await parents.nodes([k(3)]);
    assert.equal(calls.length, 2);
    assert.equal(stale[0].title, 'read 1');
  });

  test('GitHub down with nothing stored rejects', async () => {
    const { parents, goDown } = setup();
    goDown();
    await assert.rejects(parents.nodes([k(3)]), NoDataError);
  });
});
