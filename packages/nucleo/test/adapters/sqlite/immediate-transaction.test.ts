import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../../../src/adapters/sqlite/immediate-transaction.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  return db;
}

const names = (db: DatabaseSync) => (db.prepare('SELECT name FROM item ORDER BY id').all() as { name: string }[]).map(r => r.name);

test('#498/AC-1 commits the row and returns the value when fn succeeds', () => {
  const db = database();
  const result = immediateTransaction(db, () => {
    db.prepare('INSERT INTO item (name) VALUES (?)').run('kept');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(names(db), ['kept']);
  assert.equal(db.isTransaction, false);
});

test('#498/AC-1 rolls back the row and rethrows the same error when fn throws', () => {
  const db = database();
  const failure = new Error('boom');
  assert.throws(
    () => immediateTransaction(db, () => {
      db.prepare('INSERT INTO item (name) VALUES (?)').run('discarded');
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(names(db), []);
  assert.equal(db.isTransaction, false);
});

test('a nested call throws, because the boundary does not nest', () => {
  const db = database();
  assert.throws(() => immediateTransaction(db, () => immediateTransaction(db, () => 1)));
  assert.equal(db.isTransaction, false);
});
