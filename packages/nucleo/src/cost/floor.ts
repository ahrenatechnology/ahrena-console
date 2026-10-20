// Floor after compaction: a bucket's effective total (`tokens + baseline`) never goes down.
//
// When the live count drops (compaction, a transcript rewritten smaller), what vanished becomes floor:
// `baseline' = baseline + (old_live − new_live)`. While the count only grows, the floor stays as it is.
// It is the Agent Monitor's high-water mark rule (the Agent Monitor internal benchmark), applied
// only on a drop; applied on every read, it would take off the floor what the live count grew back.

import { emptyTokenCounts, type TokenCounts, type TokenUsage } from '../model.ts';

const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** The bucket's new floor, given the one stored before (or nothing) and the new live count. Per token category. */
export function applyFloor(previous: Pick<TokenUsage, 'tokens' | 'baseline'> | null | undefined, live: TokenCounts): TokenCounts {
  const floor = emptyTokenCounts();
  if (!previous) return floor;
  for (const k of KEYS) {
    floor[k] = previous.baseline[k] + Math.max(previous.tokens[k] - live[k], 0);
  }
  return floor;
}
