// The GitHub call queue (decision 0001, item 6; #341): one call at a time by default, at most
// `limit` with one, in arrival order, a failure never holding the next.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCallQueue } from '../../src/github/call-queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 2));

async function run(queue: GithubCallQueue, n: number, fail = (_: number) => false) {
  let inFlight = 0;
  let maxInFlight = 0;
  const started: number[] = [];
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) =>
      queue.run(async () => {
        started.push(i);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight--;
        if (fail(i)) throw new Error(`call ${i}`);
        return i;
      }),
    ),
  );
  return { maxInFlight, started, results };
}

describe('#341: GithubCallQueue', () => {
  test('without a limit, one call at a time, in order', async () => {
    const r = await run(new GithubCallQueue(), 5);
    assert.equal(r.maxInFlight, 1);
    assert.deepEqual(r.started, [0, 1, 2, 3, 4]);
  });

  test('with a limit of 3, never more than 3 at once, started in arrival order', async () => {
    const r = await run(new GithubCallQueue(3), 10);
    assert.equal(r.maxInFlight, 3);
    assert.deepEqual(r.started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(
      r.results.map((x) => (x.status === 'fulfilled' ? x.value : null)),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
  });

  test('a failing call frees its slot: the ones after it still run', async () => {
    const queue = new GithubCallQueue(2);
    const r = await run(queue, 6, (i) => i % 2 === 0);
    assert.deepEqual(r.results.map((x) => x.status), ['rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
    assert.equal((await run(queue, 3)).maxInFlight, 2);
  });

  test('a limit that is not a positive integer is refused', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new GithubCallQueue(bad), RangeError);
  });
});
