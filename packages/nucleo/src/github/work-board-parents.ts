/*
 * #465 the parents the Project cites but does not hold, with their ancestors: one batched read of
 * `WorkSource.nodes` per set of keys, behind the ADR-0001 cache. Inside the TTL it never calls GitHub;
 * GitHub down after one read serves the last value; with nothing stored it throws, and the work board
 * service turns that into a reason.
 */

import { GITHUB_TTL, type GithubCache } from './cache.ts';
import type { WorkSource } from './source.ts';
import type { ParentLookup } from './work-board.ts';
import type { WorkNode } from './work.ts';

export interface CachedParentLookupOptions {
  source: Pick<WorkSource, 'nodes'>;
  cache: GithubCache;
}

/** #465 the same set of keys, in any order, is the same cache entry. */
export const parentsCacheKey = (keys: readonly string[]): string => `github:work-board:parents:${sortedUnique(keys).join(',')}`;

const sortedUnique = (keys: readonly string[]): string[] => [...new Set(keys)].sort();

export class CachedParentLookup implements ParentLookup {
  private readonly source: Pick<WorkSource, 'nodes'>;
  private readonly cache: GithubCache;

  constructor({ source, cache }: CachedParentLookupOptions) {
    this.source = source;
    this.cache = cache;
  }

  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    const sorted = sortedUnique(keys);
    const r = await this.cache.get<WorkNode[]>(parentsCacheKey(sorted), GITHUB_TTL.issues, async () => ({ value: await this.source.nodes(sorted) }));
    return r.value;
  }
}
