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
}
