// Preço e custo de um bucket de uso. É sempre estimativa: não há leitura de fatura.
// Modificadores (fast, região, batch) e o custo das ferramentas de servidor ficam para o item 1.6.

import type { ModelPricing, TokenCounts, TokenUsage } from './model.ts';

/** Multiplicadores sobre o preço de input quando o preço de cache não foi informado. */
export const CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2.0 } as const;

function likeToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

/** Acha o preço do modelo. Vale o padrão mais longo que casa; `null` quando nenhum casa. */
export function resolvePricing(model: string, prices: readonly ModelPricing[]): ModelPricing | null {
  let best: ModelPricing | null = null;
  for (const p of prices) {
    if (!likeToRegExp(p.pattern).test(model)) continue;
    if (!best || p.pattern.length > best.pattern.length) best = p;
  }
  return best;
}

export type CostEstimate =
  | { estimate: true; priced: true; pattern: string; costUsd: number }
  /** Modelo sem preço: aparece como "sem preço", nunca como custo zero. */
  | { estimate: true; priced: false; pattern: null; costUsd: null };

/** Tokens efetivos do bucket: o vivo mais o piso da compactação. */
export function effectiveTokens(usage: Pick<TokenUsage, 'tokens' | 'baseline'>): TokenCounts {
  const { tokens: t, baseline: b } = usage;
  return {
    input: t.input + b.input,
    output: t.output + b.output,
    cacheRead: t.cacheRead + b.cacheRead,
    cacheWrite5m: t.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: t.cacheWrite1h + b.cacheWrite1h,
  };
}

export function estimateCost(
  usage: Pick<TokenUsage, 'model' | 'tokens' | 'baseline'>,
  prices: readonly ModelPricing[],
): CostEstimate {
  const p = resolvePricing(usage.model, prices);
  if (!p) return { estimate: true, priced: false, pattern: null, costUsd: null };

  const t = effectiveTokens(usage);
  const cacheRead = p.cacheReadPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.read;
  const cacheWrite5m = p.cacheWrite5mPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.write5m;
  const cacheWrite1h = p.cacheWrite1hPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.write1h;
  const costUsd =
    (t.input * p.inputPerMTok +
      t.output * p.outputPerMTok +
      t.cacheRead * cacheRead +
      t.cacheWrite5m * cacheWrite5m +
      t.cacheWrite1h * cacheWrite1h) /
    1_000_000;
  return { estimate: true, priced: true, pattern: p.pattern, costUsd };
}
