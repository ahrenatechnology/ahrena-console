// Cache das leituras do GitHub (decisão 0001, item 4): TTL por chave, uma chamada só por
// chave mesmo com várias telas pedindo, leitura velha (`stale`) quando o GitHub falha,
// pausa quando o GitHub limita e atualização na hora (`patch`) para escritas do console.
// O armazenamento é uma porta (`CachePort`): em memória, SQLite local, DynamoDB no hub.

export interface CacheEntry<T = unknown> {
  value: T;
  /** Quando veio do GitHub (ms desde a época). */
  fetchedAt: number;
  etag: string | null;
}

/** Porta do armazenamento do cache: chave → entrada. */
export interface CachePort {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCacheStore implements CachePort {
  readonly entries = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | null> {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** TTLs da tabela da decisão 0001. */
export const GITHUB_TTL = {
  /** Status dos cards no Project (5.3). */
  project: 2 * 60_000,
  /** Lista rasa das issues; o delta cobre o intervalo. */
  issues: 5 * 60_000,
  /** Filhas de um card expandido. */
  children: 10 * 60_000,
  /** PR, CI e review de um card aberto. */
  detail: 60_000,
  /** Lista de projetos e campos. */
  projects: 60 * 60_000,
} as const;

/** Intervalo do delta (`updated:>=`) com a tela aberta. */
export const DELTA_INTERVAL_MS = 60_000;
/** Até quando o dado velho ainda é servido; depois, "sem dados". */
export const MAX_STALE_MS = 24 * 60 * 60_000;
/** Intervalo mínimo entre duas releituras forçadas (botão de atualizar). */
export const MIN_FORCED_REFRESH_MS = 30_000;
/** Pausa quando o GitHub limita e não diz por quanto tempo. */
export const DEFAULT_BACKOFF_MS = 2 * 60_000;

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class NoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDataError';
  }
}

type HeaderBag = Headers | Record<string, string | undefined>;
const header = (h: HeaderBag, name: string): string | null =>
  h instanceof Headers ? h.get(name) : (h[name] ?? h[name.toLowerCase()] ?? null);

/** Quanto esperar depois de um 403/429: `retry-after`, senão `x-ratelimit-reset`, senão 2 min. */
export function backoffMs(headers: HeaderBag, now = Date.now()): number {
  const retryAfter = Number(header(headers, 'retry-after'));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(header(headers, 'x-ratelimit-reset'));
  if (header(headers, 'x-ratelimit-remaining') === '0' && reset > 0) return Math.max(0, reset * 1000 - now);
  return DEFAULT_BACKOFF_MS;
}

export interface FetchResult<T> {
  value?: T;
  etag?: string | null;
  /** O GitHub respondeu 304: vale o valor que já estava no cache. */
  notModified?: boolean;
}

export type Fetcher<T> = (ctx: { etag: string | null }) => Promise<FetchResult<T>>;

export interface CacheResult<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
  staleReason: string | null;
}

export interface GetOptions {
  /** Releitura pedida pela pessoa: ignora o TTL, respeitando o intervalo mínimo. */
  force?: boolean;
}

export interface GithubCacheOptions {
  store: CachePort;
  now?: () => number;
  maxStaleMs?: number;
  minForcedRefreshMs?: number;
}

export class GithubCache {
  readonly store: CachePort;
  private readonly now: () => number;
  private readonly maxStaleMs: number;
  private readonly minForcedRefreshMs: number;
  private readonly inflight = new Map<string, Promise<CacheResult<unknown>>>();
  private blockedUntil = 0;

  constructor({ store, now = Date.now, maxStaleMs = MAX_STALE_MS, minForcedRefreshMs = MIN_FORCED_REFRESH_MS }: GithubCacheOptions) {
    this.store = store;
    this.now = now;
    this.maxStaleMs = maxStaleMs;
    this.minForcedRefreshMs = minForcedRefreshMs;
  }

  /** Até quando as chamadas estão suspensas por limite do GitHub (ms desde a época). */
  get pausedUntil(): number {
    return this.blockedUntil;
  }

  /** Quanto falta da pausa por limite do GitHub (0 se não há). */
  pauseLeftMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Suspende as chamadas por limite do GitHub vindo de fora das leituras (ex.: uma mutação). */
  pause(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /**
   * Dentro do TTL não chama o GitHub; fora dele chama uma vez por chave; se falhar e
   * houver dado de até 24 h, serve o velho com `stale: true` e o motivo.
   */
  async get<T>(key: string, ttlMs: number, fetcher: Fetcher<T>, { force = false }: GetOptions = {}): Promise<CacheResult<T>> {
    const hit = (await this.store.get(key)) as CacheEntry<T> | null;
    const age = hit ? this.now() - hit.fetchedAt : Infinity;
    if (hit && age < (force ? Math.min(ttlMs, this.minForcedRefreshMs) : ttlMs)) return fresh(hit);
    if (this.now() < this.blockedUntil) return this.fallback(hit, 'GitHub limitou as chamadas');

    let p = this.inflight.get(key) as Promise<CacheResult<T>> | undefined;
    if (!p) {
      p = this.refresh(key, hit, fetcher).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      return await p;
    } catch (err) {
      return this.fallback(hit, err instanceof Error ? err.message : String(err));
    }
  }

  /** Lê o que está guardado, sem chamar o GitHub. `null` se não há ou passou de 24 h. */
  async peek<T>(key: string): Promise<CacheEntry<T> | null> {
    const hit = (await this.store.get(key)) as CacheEntry<T> | null;
    return hit && this.now() - hit.fetchedAt <= this.maxStaleMs ? hit : null;
  }

  /** Grava um valor que veio de outra leitura (ex.: o detalhe das filhas). */
  async put<T>(key: string, value: T, etag: string | null = null): Promise<void> {
    await this.store.set(key, { value, fetchedAt: this.now(), etag });
  }

  /** Escrita do próprio console: atualiza o valor guardado na hora, sem reler e sem mudar `fetchedAt`. */
  async patch<T>(key: string, update: (value: T) => T): Promise<boolean> {
    const hit = (await this.store.get(key)) as CacheEntry<T> | null;
    if (!hit) return false;
    await this.store.set(key, { ...hit, value: update(hit.value) });
    return true;
  }

  async invalidate(key: string): Promise<void> {
    await this.store.delete(key);
  }

  private async refresh<T>(key: string, hit: CacheEntry<T> | null, fetcher: Fetcher<T>): Promise<CacheResult<T>> {
    try {
      const r = await fetcher({ etag: hit?.etag ?? null });
      if (r.notModified && !hit) throw new Error('GitHub respondeu 304 sem dado no cache');
      const value = r.notModified ? hit!.value : (r.value as T);
      const entry: CacheEntry<T> = { value, fetchedAt: this.now(), etag: r.etag ?? hit?.etag ?? null };
      await this.store.set(key, entry);
      return fresh(entry);
    } catch (err) {
      if (err instanceof RateLimitedError) this.blockedUntil = this.now() + err.retryAfterMs;
      throw err;
    }
  }

  private fallback<T>(hit: CacheEntry<T> | null, reason: string): CacheResult<T> {
    if (!hit || this.now() - hit.fetchedAt > this.maxStaleMs) throw new NoDataError(`sem dados: ${reason}`);
    return { value: hit.value, fetchedAt: hit.fetchedAt, stale: true, staleReason: reason };
  }
}

const fresh = <T>(e: CacheEntry<T>): CacheResult<T> => ({ value: e.value, fetchedAt: e.fetchedAt, stale: false, staleReason: null });
