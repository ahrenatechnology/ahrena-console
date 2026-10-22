// Cache do GitHub no mesmo banco SQLite do núcleo, tabela `github_cache` (decisão 0001).
// A tabela é criada aqui, com IF NOT EXISTS, para o cache não depender da ordem das
// migrações da porta de armazenamento: o cache pode ser apagado a qualquer momento.

import type { DatabaseSync } from 'node:sqlite';
import type { CacheEntry, CachePort } from './cache.ts';

export class SqliteCacheStore implements CachePort {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS github_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      etag TEXT
    ) STRICT`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const r = this.db.prepare('SELECT value_json, fetched_at, etag FROM github_cache WHERE key = ?').get(key) as
      | { value_json: string; fetched_at: number; etag: string | null }
      | undefined;
    return r ? { value: JSON.parse(r.value_json), fetchedAt: Number(r.fetched_at), etag: r.etag } : null;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO github_cache (key, value_json, fetched_at, etag) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at, etag = excluded.etag`,
      )
      .run(key, JSON.stringify(entry.value), Math.trunc(entry.fetchedAt), entry.etag);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM github_cache WHERE key = ?').run(key);
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM github_cache');
  }
}

/** The English key of a cache key written before #173 phase 5, or `null` if it has no Portuguese segment. */
export function englishGithubCacheKey(key: string): string | null {
  let next = key
    .replace(/^repos:detalhe:/, 'repos:detail:')
    .replace(/^repos:lista$/, 'repos:list')
    .replace(/^repos:resumo$/, 'repos:summary')
    .replace(/^painel:issue:/, 'panel:issue:');
  if (next.endsWith(':1a')) next = `${next.slice(0, -3)}:1y`;
  return next === key ? null : next;
}

/**
 * #173 phase 5: the cache keys that had Portuguese segments (`repos:detalhe:…`, `repos:lista`,
 * `repos:resumo`, `painel:issue:…`, the `1a` period) are read under English keys now. The value is the
 * raw GitHub answer, whose shape did not change, so each row moves to its English key with its
 * `fetched_at` and `etag`: nothing still fresh is lost. If the English key already exists, the most
 * recently fetched row stays. The table may not exist yet.
 */
export function renameLegacyGithubCacheKeys(db: DatabaseSync): void {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_cache'`).get();
  if (!exists) return;
  const rows = db.prepare('SELECT key FROM github_cache').all() as { key: string }[];
  const move = db.prepare(
    `INSERT INTO github_cache (key, value_json, fetched_at, etag)
       SELECT ?, value_json, fetched_at, etag FROM github_cache WHERE key = ?
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at, etag = excluded.etag
       WHERE excluded.fetched_at > github_cache.fetched_at`,
  );
  const drop = db.prepare('DELETE FROM github_cache WHERE key = ?');
  for (const { key } of rows) {
    const english = englishGithubCacheKey(key);
    if (!english) continue;
    move.run(english, key);
    drop.run(key);
  }
}
