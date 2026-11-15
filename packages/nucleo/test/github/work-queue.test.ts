/*
 * #477 the execution queue: the order arithmetic (pure) and the SQLite store, against a real database with
 * the migrations. Scenario tokens are `#477/AC-n`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { isQueueColumn, moveAfter, stopOf, type QueueEntry } from '../../src/github/work-queue.ts';
import { SqliteWorkQueue } from '../../src/github/work-queue-store.ts';
import { WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';

const A = 'acme/app#500';
const B = 'acme/app#501';
const C = 'acme/app#502';
const T1 = '2026-11-14T10:00:00.000Z';
const T2 = '2026-11-14T10:05:00.000Z';

const fresh = () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  return { storage, queue: new SqliteWorkQueue(storage.db) };
};
const order = async (queue: SqliteWorkQueue) => (await queue.list()).map((e) => e.key);

describe('#477 queue order arithmetic', () => {
  test('#477/AC-2 moveAfter puts a key right after another, or on top with null', () => {
    assert.deepEqual(moveAfter([A, B, C], C, null), [C, A, B]);
    assert.deepEqual(moveAfter([A, B, C], A, B), [B, A, C]);
    assert.deepEqual(moveAfter([A, B, C], A, C), [B, C, A]);
    assert.deepEqual(moveAfter([A, B, C], B, A), [A, B, C]);
  });

  test('#477/AC-2 moveAfter refuses a key that is not in line, itself as the anchor, and an unknown anchor', () => {
    assert.equal(moveAfter([A, B], C, null), null);
    assert.equal(moveAfter([A, B], A, A), null);
    assert.equal(moveAfter([A, B], A, C), null);
  });

  test('#477/AC-5 only Planejamento and Na fila accept a card; the four fact columns do not', () => {
    const accepting = WORK_BOARD_COLUMNS.filter((c) => isQueueColumn(c.id)).map((c) => c.id);
    assert.deepEqual(accepting, ['planning', 'queued']);
  });

  test('#477/AC-2 the stop is the first entry with a failure, in queue order', () => {
    const e = (key: string, failedReason: string | null): QueueEntry => ({ key, position: 1, target: 'terminal', enqueuedAt: T1, failedReason, failedAt: failedReason ? T2 : null });
    assert.equal(stopOf([e(A, null), e(B, null)]), null);
    assert.deepEqual(stopOf([e(A, null), e(B, 'boom'), e(C, 'later')]), { key: B, reason: 'boom' });
  });
});

describe('#477 SqliteWorkQueue', () => {
  test('#477/AC-2 enqueue appends with contiguous positions and keeps the chosen target', async () => {
    const { queue } = fresh();
    await queue.enqueue(A, 'terminal', T1);
    const second = await queue.enqueue(B, 'desktop', T2);
    assert.deepEqual([second.key, second.position, second.target, second.enqueuedAt, second.failedReason], [B, 2, 'desktop', T2, null]);
    assert.deepEqual([...(await queue.positions())], [[A, 1], [B, 2]]);
  });

  test('#477/AC-2 keys are stored and compared in lower case', async () => {
    const { queue } = fresh();
    await queue.enqueue('Acme/App#500', 'terminal', T1);
    assert.deepEqual([...(await queue.positions()).keys()], [A]);
    assert.equal(await queue.remove('ACME/app#500'), true);
  });

  test('#477/AC-2 queueing a queued item again keeps its place and takes the last target', async () => {
    const { queue } = fresh();
    await queue.enqueue(A, 'terminal', T1);
    await queue.enqueue(B, 'terminal', T1);
    const again = await queue.enqueue(A, 'desktop', T2);
    assert.deepEqual([again.position, again.target, again.enqueuedAt], [1, 'desktop', T1]);
    assert.deepEqual(await order(queue), [A, B]);
  });

  test('#477/AC-2 remove closes the gap; removing a key that is not in line answers false', async () => {
    const { queue } = fresh();
    for (const k of [A, B, C]) await queue.enqueue(k, 'terminal', T1);
    assert.equal(await queue.remove(B), true);
    assert.deepEqual([...(await queue.positions())], [[A, 1], [C, 2]]);
    assert.equal(await queue.remove(B), false);
  });

  test('#477/AC-2 reorder moves an item above another and renumbers; an unknown key or anchor changes nothing', async () => {
    const { queue } = fresh();
    for (const k of [A, B]) await queue.enqueue(k, 'terminal', T1);
    assert.equal(await queue.reorder(B, null), true);
    assert.deepEqual([...(await queue.positions())], [[B, 1], [A, 2]]);
    assert.equal(await queue.reorder(C, null), false);
    assert.equal(await queue.reorder(B, C), false);
    assert.deepEqual(await order(queue), [B, A]);
  });

  test('#477/AC-3 the queue and its order survive reopening the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahrena-work-queue-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'core.db');
    const first = openSqliteStorage({ path });
    const queue = new SqliteWorkQueue(first.db);
    for (const k of [A, B, C]) await queue.enqueue(k, 'desktop', T1);
    await queue.reorder(C, null);
    await first.close();

    const second = openSqliteStorage({ path });
    const reopened = new SqliteWorkQueue(second.db);
    const entries = await reopened.list();
    assert.deepEqual(entries.map((e) => [e.key, e.position, e.target]), [[C, 1, 'desktop'], [A, 2, 'desktop'], [B, 3, 'desktop']]);
    await second.close();
  });

  test('#477/AC-3 the table is `work_queue` and belongs to the migrations', () => {
    const { storage } = fresh();
    const columns = (storage.db.prepare('PRAGMA table_info(work_queue)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(columns, ['item_key', 'position', 'target', 'enqueued_at', 'failed_reason', 'failed_at']);
  });

  test('#477/AC-2 a database without the table is refused with a pointer to the migrations', () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    storage.db.exec('DROP TABLE work_queue');
    assert.throws(() => new SqliteWorkQueue(storage.db), /work_queue/);
  });

  test('#477/AC-2 a failed pull returns the entry to the top with the reason and stops the queue', async () => {
    const { queue } = fresh();
    for (const k of [A, B, C]) await queue.enqueue(k, 'terminal', T1);
    assert.equal(await queue.stopped(), null);
    assert.equal(await queue.markFailed(C, 'sessão não subiu', T2), true);
    assert.deepEqual(await order(queue), [C, A, B]);
    const [top] = await queue.list();
    assert.deepEqual([top!.failedReason, top!.failedAt], ['sessão não subiu', T2]);
    assert.deepEqual(await queue.stopped(), { key: C, reason: 'sessão não subiu' });
    assert.equal(await queue.markFailed('acme/app#999', 'x', T2), false);
  });

  test('#477/AC-2 removing the failed entry resumes the queue', async () => {
    const { queue } = fresh();
    for (const k of [A, B]) await queue.enqueue(k, 'terminal', T1);
    await queue.markFailed(B, 'boom', T2);
    await queue.remove(B);
    assert.equal(await queue.stopped(), null);
  });

  test('#477/AC-2 the store is available and every write is one transaction: a failing write leaves the queue as it was', async () => {
    const { storage, queue } = fresh();
    assert.equal(queue.available, true);
    await queue.enqueue(A, 'terminal', T1);
    storage.db.exec('CREATE TRIGGER no_more BEFORE INSERT ON work_queue BEGIN SELECT RAISE(ABORT, \'no more\'); END');
    await assert.rejects(queue.enqueue(B, 'terminal', T1), /no more/);
    assert.deepEqual(await order(queue), [A]);
    storage.db.exec('DROP TRIGGER no_more');
    await queue.enqueue(B, 'terminal', T1);
    assert.deepEqual(await order(queue), [A, B]);
  });
});
