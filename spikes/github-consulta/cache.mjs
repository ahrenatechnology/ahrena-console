// Prova mínima do spike #40: cache com TTL, leitura velha quando o GitHub falha,
// uma chamada só por chave (single-flight) e pausa que respeita o que o GitHub manda.
// O armazenamento é uma porta: { get(key), set(key, entry) }. Local é SQLite (#11);
// no hub, DynamoDB. Aqui há um adaptador em memória e um em disco (JSON).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async set(key, entry) { this.map.set(key, entry); }
}

export class DiskStore {
  constructor(dir) { this.dir = dir; }
  file(key) { return join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`); }
  async get(key) { try { return JSON.parse(await readFile(this.file(key), 'utf8')); } catch { return null; } }
  async set(key, entry) { await mkdir(this.dir, { recursive: true }); await writeFile(this.file(key), JSON.stringify(entry)); }
}

export class RateLimited extends Error {
  constructor(message, retryAfterMs) { super(message); this.retryAfterMs = retryAfterMs; }
}

// Quanto esperar depois de um 403/429: retry-after, senão x-ratelimit-reset, senão 2 min.
export function backoffMs(headers, now = Date.now()) {
  const retryAfter = Number(headers['retry-after']);
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && reset > 0) return Math.max(0, reset * 1000 - now);
  return 2 * 60_000;
}

export class GithubCache {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
    this.inflight = new Map();
    this.blockedUntil = 0;
  }

  // Devolve { value, fetchedAt, stale, staleReason }. Dentro do TTL não chama o GitHub;
  // fora dele chama uma vez; se falhar e houver dado velho, serve o velho com stale:true.
  async get(key, ttlMs, fetcher) {
    const hit = await this.store.get(key);
    if (hit && this.now() - hit.fetchedAt < ttlMs) return { ...hit, stale: false };
    if (this.now() < this.blockedUntil) return this.fallback(hit, 'GitHub limitou as chamadas');
    if (!this.inflight.has(key)) {
      const p = this.refresh(key, hit, fetcher).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      return await this.inflight.get(key);
    } catch (err) {
      return this.fallback(hit, err.message);
    }
  }

  async refresh(key, hit, fetcher) {
    try {
      const { value, etag = null, notModified = false } = await fetcher({ etag: hit?.etag ?? null });
      const entry = { value: notModified ? hit.value : value, etag: etag ?? hit?.etag ?? null, fetchedAt: this.now() };
      await this.store.set(key, entry);
      return { ...entry, stale: false };
    } catch (err) {
      if (err instanceof RateLimited) this.blockedUntil = this.now() + err.retryAfterMs;
      throw err;
    }
  }

  fallback(hit, reason) {
    if (!hit) throw new Error(reason);
    return { ...hit, stale: true, staleReason: reason };
  }

  // Escrita do próprio console (mover card): atualiza o cache na hora, sem reler.
  async patch(key, update) {
    const hit = await this.store.get(key);
    if (hit) await this.store.set(key, { ...hit, value: update(hit.value) });
  }
}
