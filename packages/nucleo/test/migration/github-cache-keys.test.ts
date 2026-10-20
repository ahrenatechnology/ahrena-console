// #173 phase 5: the GitHub cache rows written under Portuguese keys move to the English keys the code
// reads now, whole, so no entry that was still fresh has to be fetched again.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteCacheStore, englishGithubCacheKey, renameLegacyGithubCacheKeys } from '../../src/github/sqlite-cache.ts';

test('each Portuguese segment of a cache key has its English key', () => {
  assert.equal(englishGithubCacheKey('repos:lista'), 'repos:list');
  assert.equal(englishGithubCacheKey('repos:resumo'), 'repos:summary');
  assert.equal(englishGithubCacheKey('repos:detalhe:o/r:1a'), 'repos:detail:o/r:1y');
  assert.equal(englishGithubCacheKey('painel:issue:o/r#1'), 'panel:issue:o/r#1');
  assert.equal(englishGithubCacheKey('repos:rest:o/r:runs:1a'), 'repos:rest:o/r:runs:1y');
  for (const key of ['repos:list', 'github:issues:is:open', 'repos:rest:o/r:languages', 'repos:detail:o/r:90d']) {
    assert.equal(englishGithubCacheKey(key), null, key);
  }
});

test('when both keys exist, the row fetched last stays, and the count drops only by the duplicate', async () => {
  const db = new DatabaseSync(':memory:');
  const cache = new SqliteCacheStore(db);
  await cache.set('repos:lista', { value: 'old-newer', fetchedAt: 20, etag: 'a' });
  await cache.set('repos:list', { value: 'new-older', fetchedAt: 10, etag: 'b' });
  await cache.set('repos:resumo', { value: 'old-older', fetchedAt: 5, etag: 'c' });
  await cache.set('repos:summary', { value: 'new-newer', fetchedAt: 30, etag: 'd' });
  await cache.set('painel:issue:o/r#1', { value: 'only-old', fetchedAt: 7, etag: null });
  renameLegacyGithubCacheKeys(db);
  assert.deepEqual(await cache.get('repos:list'), { value: 'old-newer', fetchedAt: 20, etag: 'a' });
  assert.deepEqual(await cache.get('repos:summary'), { value: 'new-newer', fetchedAt: 30, etag: 'd' });
  assert.deepEqual(await cache.get('panel:issue:o/r#1'), { value: 'only-old', fetchedAt: 7, etag: null });
  for (const key of ['repos:lista', 'repos:resumo', 'painel:issue:o/r#1']) assert.equal(await cache.get(key), null, key);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM github_cache').get() as { n: number }).n, 3);
  renameLegacyGithubCacheKeys(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM github_cache').get() as { n: number }).n, 3, 'running twice changes nothing');
});

test('a database without the cache table is left alone', () => {
  const db = new DatabaseSync(':memory:');
  renameLegacyGithubCacheKeys(db);
  assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'github_cache'`).get(), undefined);
});
