import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DEFAULT_EVENTS_RETENTION_DAYS, parseEventsRetentionDays, pruneEventsBatch, runEventsRetention, startEventsRetention } from './events-retention.ts';
import { openSqliteStorage } from './sqlite-storage.ts';
import { session } from '../../../test/fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-retention-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const noSleep = async () => {};
let n = 0;

function open() {
  return openSqliteStorage({ path: join(dir, `r${n++}.sqlite`) });
}

/** One event per row, `ageMs` before NOW. */
function insert(db: ReturnType<typeof open>['db'], id: string, ageMs: number) {
  db.prepare(`INSERT INTO events (id, session_id, type, created_at, data) VALUES (?, 's1', 'PreToolUse', ?, ?)`)
    .run(id, new Date(NOW - ageMs).toISOString(), 'x'.repeat(200));
}

function ids(db: ReturnType<typeof open>['db']): string[] {
  return (db.prepare('SELECT id FROM events ORDER BY created_at, id').all() as { id: string }[]).map((r) => r.id);
}

describe('events retention', () => {
  test('AC-3: events older than the window are removed, those at the boundary and newer stay', async () => {
    const store = open();
    insert(store.db, 'old-1', 40 * DAY);
    insert(store.db, 'old-2', 30 * DAY + 1);
    insert(store.db, 'at-boundary', 30 * DAY);
    insert(store.db, 'inside', 29 * DAY);
    insert(store.db, 'now', 0);
    const r = await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep });
    assert.equal(r.deleted, 2);
    assert.deepEqual(ids(store.db), ['at-boundary', 'inside', 'now']);
    await store.close();
  });

  test('AC-3: a window of N days removes nothing newer than N days', async () => {
    const store = open();
    for (let d = 19; d >= 0; d--) insert(store.db, `e${d}`, d * DAY);
    const r = await runEventsRetention(store.db, { days: 7, now: () => NOW, sleep: noSleep });
    assert.equal(r.deleted, 12);
    assert.deepEqual(ids(store.db).sort(), Array.from({ length: 8 }, (_, d) => `e${d}`).sort());
    await store.close();
  });

  test('AC-3: the newest event is kept even when every event is older than the window, so seq never restarts', async () => {
    const store = open();
    insert(store.db, 'a', 90 * DAY);
    insert(store.db, 'b', 80 * DAY);
    const before = (store.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number }).m;
    await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep });
    assert.deepEqual(ids(store.db), ['b']);
    insert(store.db, 'c', 0);
    const seq = (store.db.prepare(`SELECT seq FROM events WHERE id = 'c'`).get() as { seq: number }).seq;
    assert.equal(seq, before + 1);
    await store.close();
  });

  test('AC-3: deletes in batches of at most batchSize rows, pausing between them', async () => {
    const store = open();
    for (let i = 0; i < 25; i++) insert(store.db, `old-${i}`, 60 * DAY + i);
    insert(store.db, 'new', DAY);
    const pauses: number[] = [];
    const r = await runEventsRetention(store.db, {
      days: 30, now: () => NOW, batchSize: 10, pauseMs: 7, sleep: async (ms) => void pauses.push(ms),
    });
    assert.equal(r.deleted, 25);
    assert.equal(r.batches, 3);
    assert.equal(pauses.length, 2);
    assert.ok(pauses.every((ms) => ms >= 7), `pauses ${pauses}`);
    assert.deepEqual(ids(store.db), ['new']);
    await store.close();
  });

  test('a batch never deletes more than its limit', async () => {
    const store = open();
    for (let i = 0; i < 12; i++) insert(store.db, `old-${i}`, 60 * DAY + i);
    insert(store.db, 'new', 0);
    assert.equal(pruneEventsBatch(store.db, new Date(NOW - 30 * DAY).toISOString(), 5), 5);
    assert.equal(ids(store.db).length, 8);
    await store.close();
  });

  test('AC-3: compaction runs after a large delete and gives pages back to the file', async () => {
    const store = open();
    assert.equal((store.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum, 2);
    for (let i = 0; i < 3000; i++) insert(store.db, `old-${i}`, 60 * DAY + i);
    insert(store.db, 'new', 0);
    const pages = () => (store.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const before = pages();
    const r = await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep, compactThreshold: 1000, vacuumPages: 20 });
    assert.equal(r.compaction, 'incremental');
    assert.ok(r.vacuumSteps > 1, `the vacuum ran in steps (${r.vacuumSteps})`);
    assert.equal((store.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count, 0);
    assert.ok(pages() < before / 2, `${before} pages became ${pages()}`);
    await store.close();
  });

  test('AC-3: a small delete does not compact', async () => {
    const store = open();
    for (let i = 0; i < 5; i++) insert(store.db, `old-${i}`, 60 * DAY + i);
    insert(store.db, 'new', 0);
    const r = await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep, compactThreshold: 1000 });
    assert.equal(r.deleted, 5);
    assert.equal(r.compaction, 'none');
    await store.close();
  });

  test('a database created before auto_vacuum was incremental is not compacted, unless the one full VACUUM is asked for', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA auto_vacuum = NONE; CREATE TABLE legacy_marker (x TEXT)');
    legacy.close();
    const store = openSqliteStorage({ path });
    assert.equal((store.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum, 0);
    for (let i = 0; i < 2000; i++) insert(store.db, `old-${i}`, 60 * DAY + i);
    insert(store.db, 'new', 0);
    const plain = await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep, compactThreshold: 1000 });
    assert.equal(plain.compaction, 'unavailable');
    for (let i = 0; i < 2000; i++) insert(store.db, `older-${i}`, 70 * DAY + i);
    const full = await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep, fullVacuum: true });
    assert.equal(full.compaction, 'full');
    assert.equal((store.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum, 2);
    await store.close();
  });

  test('other tables are untouched', async () => {
    const store = open();
    await store.putSession(session());
    insert(store.db, 'old', 90 * DAY);
    insert(store.db, 'new', 0);
    await runEventsRetention(store.db, { days: 30, now: () => NOW, sleep: noSleep });
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1);
    await store.close();
  });
});

describe('events retention window and schedule', () => {
  test('the window defaults to 30 days and accepts a whole number of days', () => {
    assert.equal(DEFAULT_EVENTS_RETENTION_DAYS, 30);
    assert.deepEqual(parseEventsRetentionDays(undefined), { days: 30 });
    assert.deepEqual(parseEventsRetentionDays(''), { days: 30 });
    assert.deepEqual(parseEventsRetentionDays('7'), { days: 7 });
  });

  test('an invalid window falls back to 30 days with a warning that names the variable', () => {
    for (const bad of ['0', '-3', '1.5', 'abc', '99999', '7d']) {
      const r = parseEventsRetentionDays(bad);
      assert.equal(r.days, 30, bad);
      assert.match(r.warning ?? '', /AHRENA_CONSOLE_EVENTS_RETENTION_DAYS/, bad);
    }
  });

  test('the schedule runs after its first delay and not before, and stop cancels it', async () => {
    const store = open();
    insert(store.db, 'old', 90 * DAY);
    insert(store.db, 'new', 0);
    const lines: string[] = [];
    const stop = startEventsRetention({
      db: store.db, env: { AHRENA_CONSOLE_EVENTS_RETENTION_DAYS: '1' }, log: (l) => lines.push(l), firstDelayMs: 30, intervalMs: 60_000,
    });
    assert.equal(ids(store.db).length, 2, 'nothing runs when it is scheduled');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(ids(store.db), ['new']);
    assert.ok(lines.some((l) => l.includes('events retention: 1 events')), lines.join('\n'));
    stop();
    await store.close();
  });
});
