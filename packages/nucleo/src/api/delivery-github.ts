// The Delivery tab's GitHub read (#266), which never waits for GitHub, as src/api/repos.ts: the
// answer comes from what is in the cache of decision 0001 (`GithubCache`, the core's one), and a
// repository whose read expired (`DELIVERY_TTL_MS`) or does not exist yet is read again behind it,
// one call at a time in the core's GitHub queue. When a read lands, the change
// `{ type: 'repos', key: 'delivery' }` goes to the cursor and the screen re-reads.
//
// One read per repository covers 90 days (`DELIVERY_FETCH_DAYS`); 7 and 30 days are cut from it.
// GitHub down or rate limited: the cache's last read (up to 24 h) is served with `status: 'stale'`,
// the reason and the read time. No token (`gh` without login): `disconnected` while nothing is cached.

import type { NewChange } from '../changes/cursor.ts';
import { GithubCache, NoDataError } from '../github/cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import { DELIVERY_FETCH_DAYS, GithubDeliverySource, type DeliveryRaw, type DeliverySource } from '../github/delivery-source.ts';
import type { ProjectBoard } from '../github/project.ts';
import { DIA_MS, diaIso } from '../github/repos-calculo.ts';
import { GithubReposSource, SemGithubError } from '../github/repos-source.ts';
import { createFakeGithub, DEMO_DELIVERY_PROJECTS, DEMO_DELIVERY_GITHUB_DATA } from '../simulator/fake-github.ts';
import type { DeliveryOptions } from './analytics-route.ts';
import type { DeliveryGithubRead, DeliveryGroup } from './delivery.ts';
import type { SessoesPorRepo } from './repos-sessions.ts';

export const DELIVERY_TTL_MS = 5 * 60_000;
/** After a failed read, the next one waits this long (the cache's last read is served meanwhile). */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** The key of the change recorded when a read lands. */
export const DELIVERY_CHANGE_KEY = 'delivery';

/** Where a landed read is recorded (the core's `ChangeCursor`). */
export interface ChangeRecorder {
  record(change: NewChange): unknown;
}

export const deliveryCacheKey = (repo: string) => `delivery:${repo}`;

export interface DeliveryGithubOptions {
  /** `null`: the core runs without GitHub (`--no-github`). */
  source: DeliverySource | null;
  cache: GithubCache;
  queue?: GithubCallQueue;
  changes?: ChangeRecorder | null;
  now?: () => number;
  ttlMs?: number;
  log?: (message: string) => void;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class DeliveryGithub {
  private readonly source: DeliverySource | null;
  private readonly cache: GithubCache;
  private readonly queue: GithubCallQueue;
  private readonly changes: ChangeRecorder | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log: (message: string) => void;
  private readonly running = new Map<string, Promise<void>>();
  /** The reason the last read of each repository failed; cleared by the next one that works. */
  private readonly failures = new Map<string, { reason: string; at: number }>();
  /** When a read of each repository last found no token; it waits `RETRY_AFTER_FAILURE_MS` like a failure. */
  private readonly noTokenAt = new Map<string, number>();
  private noToken = false;

  constructor({ source, cache, queue = new GithubCallQueue(), changes = null, now = Date.now, ttlMs = DELIVERY_TTL_MS, log = () => {} }: DeliveryGithubOptions) {
    this.source = source;
    this.cache = cache;
    this.queue = queue;
    this.changes = changes;
    this.now = now;
    this.ttlMs = ttlMs;
    this.log = log;
  }

  /** What is cached for these repositories (`chaveDoRepo`), firing the expired reads behind. */
  async read(repos: readonly string[]): Promise<DeliveryGithubRead> {
    const out: DeliveryGithubRead = { status: 'disconnected', readAt: null, error: null, pending: 0, truncated: [], repos: new Map() };
    if (!this.source) return out;
    // Every peek first, then the reads fire with no await between them.
    const hits = await Promise.all(repos.map((repo) => this.cache.peek<DeliveryRaw | null>(deliveryCacheKey(repo))));
    for (const [i, repo] of repos.entries()) {
      const hit = hits[i];
      const failedAt = Math.max(this.failures.get(repo)?.at ?? -Infinity, this.noTokenAt.get(repo) ?? -Infinity);
      // A failed read is retried after `RETRY_AFTER_FAILURE_MS`, not on every request.
      if ((!hit || this.now() - hit.fetchedAt >= this.ttlMs) && this.now() - failedAt >= RETRY_AFTER_FAILURE_MS) this.refresh(repo);
      if (this.running.has(repo)) out.pending++;
      if (!hit?.value) continue;
      out.repos.set(repo, hit.value);
      out.readAt = Math.min(out.readAt ?? Infinity, hit.fetchedAt);
      out.truncated.push(...hit.value.truncated.map((t) => `${hit.value!.repo}: ${t}`));
    }
    const failed = repos.map((r) => this.failures.get(r)).find((f) => f !== undefined) ?? null;
    out.error = failed?.reason ?? null;
    const empty = out.repos.size === 0;
    out.status = this.noToken && empty ? 'disconnected' : failed && !empty ? 'stale' : failed ? 'error' : empty && out.pending > 0 ? 'loading' : 'connected';
    return out;
  }

  private outcomeOf(repo: string): string {
    return this.noToken ? 'no-token' : (this.failures.get(repo)?.reason ?? 'ok');
  }

  private recordChange(): void {
    this.changes?.record({ type: 'repos', key: DELIVERY_CHANGE_KEY, sessionId: null, accountId: null });
  }

  /** Waits for the reads in flight (tests and the first drawing). */
  async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private refresh(repo: string): void {
    if (this.running.has(repo)) return;
    const [owner, name] = repo.split('/');
    const since = diaIso(this.now() - DELIVERY_FETCH_DAYS * DIA_MS);
    const before = this.outcomeOf(repo);
    const fail = (why: string) => this.failures.set(repo, { reason: `${repo}: ${why}`, at: this.now() });
    const run = this.cache
      .get<DeliveryRaw | null>(deliveryCacheKey(repo), this.ttlMs, async () => ({ value: await this.queue.run(() => this.source!.delivery(owner, name, since)) }))
      .then((r) => {
        this.noToken = false;
        this.noTokenAt.delete(repo);
        if (r.stale) fail(r.staleReason ?? 'o GitHub não respondeu');
        else {
          this.failures.delete(repo);
          this.recordChange();
        }
      })
      .catch((err: unknown) => {
        const cause = err instanceof NoDataError ? err.cause : err;
        if (cause instanceof SemGithubError) {
          this.noToken = true;
          this.failures.delete(repo);
          this.noTokenAt.set(repo, this.now());
          return;
        }
        this.noTokenAt.delete(repo);
        fail(reason(cause ?? err));
        this.log(`delivery: reading ${repo} failed: ${reason(err)}`);
      })
      .finally(() => {
        this.running.delete(repo);
        // A failure, or no token, changes what the screen shows (the banner, the "connect" state): it re-reads too.
        if (this.outcomeOf(repo) !== before && this.outcomeOf(repo) !== 'ok') this.recordChange();
      });
    this.running.set(repo, run);
  }
}

/** A Project's row definition: the repositories that have items in it (drafts have none). */
export function projectGroupOf(board: Pick<ProjectBoard, 'owner' | 'number' | 'title' | 'lanes'>): DeliveryGroup {
  const repos = [...new Set(board.lanes.flatMap((l) => l.items.map((i) => i.repo)).filter((r): r is string => r !== null))].sort();
  return { key: `${board.owner}/${board.number}`, label: board.title, repos };
}

export interface CoreDeliveryOptions {
  /** Demo: the fake GitHub (src/simulator/fake-github.ts) and `DEMO_DELIVERY_PROJECTS`, never the real API. */
  demo: boolean;
  noGithub: boolean;
  /** The core's GitHub cache and queue, shared with the other GitHub reads. */
  cache: GithubCache;
  queue: GithubCallQueue;
  changes: ChangeRecorder;
  /** The session → repository of the Repositories screen (src/api/repos.ts). */
  sessions: Pick<SessoesPorRepo, 'repoDe'>;
  /** The GitHub Projects the console reads (the project kanban); none without one chosen. */
  boards: () => Promise<Pick<ProjectBoard, 'owner' | 'number' | 'title' | 'lanes'>[]>;
  accountRepos: DeliveryOptions['accountRepos'];
  log?: (message: string) => void;
}

/**
 * The Projects without waiting for GitHub: each call answers the last read (none at first) and starts
 * a new one behind, if none is running (the board has its own cache, src/github/project.ts). When the
 * answer changes, the change goes to the cursor and the screen re-reads.
 */
export function latestProjects(boards: CoreDeliveryOptions['boards'], changes: ChangeRecorder | null): NonNullable<DeliveryOptions['projects']> {
  let latest: { projects: DeliveryGroup[]; error: string | null } = { projects: [], error: null };
  let running: Promise<void> | null = null;
  return async () => {
    running ??= boards()
      .then((b) => ({ projects: b.map(projectGroupOf), error: null }), (err: unknown) => ({ projects: latest.projects, error: reason(err) }))
      .then((next) => {
        const changed = JSON.stringify(next) !== JSON.stringify(latest);
        latest = next;
        if (changed) changes?.record({ type: 'repos', key: DELIVERY_CHANGE_KEY, sessionId: null, accountId: null });
      })
      .finally(() => (running = null));
    return latest;
  };
}

/** The Delivery tab's sources as the core wires them (cli.ts). */
export function createCoreDelivery({ demo, noGithub, cache, queue, changes, sessions, boards, accountRepos, log }: CoreDeliveryOptions): DeliveryOptions {
  // The demo points to an address that does not resolve: even if the fake failed, nothing goes to GitHub.
  const source = demo
    ? new GithubDeliverySource(new GithubReposSource({ token: 'demo', fetch: createFakeGithub(DEMO_DELIVERY_GITHUB_DATA, { delayMs: 120 }).fetch, url: 'https://fake-github.invalid/graphql', api: 'https://fake-github.invalid' }))
    : noGithub
      ? null
      : new GithubDeliverySource(new GithubReposSource());
  return {
    github: new DeliveryGithub({ source, cache, queue, changes, ...(log ? { log } : {}) }),
    repoOfCwd: (cwd) => sessions.repoDe(cwd),
    projects: demo ? async () => ({ projects: DEMO_DELIVERY_PROJECTS, error: null }) : latestProjects(boards, changes),
    accountRepos,
  };
}
