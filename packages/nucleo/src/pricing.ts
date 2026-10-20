// Preço e custo de um bucket de uso. É sempre estimativa: não há leitura de fatura.
//
// Os modificadores (batch, região US, fast, contexto longo) e o preço da busca na web seguem a página
// pública de preços: https://platform.claude.com/docs/en/about-claude/pricing (consultada em 2026-10-18).
// The default price table lives in src/cost/default-prices.ts.

import type { ModelPricing, TokenCounts, TokenUsage } from './model.ts';

/** Multiplicadores sobre o preço de input quando o preço de cache não foi informado. */
export const CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2.0 } as const;

/** `contextSize` de uma requisição na faixa de contexto longo (prompt acima do limite do modelo). */
export const LONG_CONTEXT = 'long';

/**
 * Modificadores de preço. Valem sobre todas as categorias de token, cache incluído, e se acumulam.
 * Modelo em modo fast sem multiplicador conhecido fica "sem preço", em vez de custar o preço padrão.
 */
export const PRICE_MODIFIERS = {
  /** `service_tier = batch`: 50% de desconto. */
  batch: 0.5,
  /** `inference_geo = us` (só inferência nos EUA): 1,1x nos modelos 4.6 em diante; os anteriores não aceitam o parâmetro. */
  usInference: 1.1,
  /** Modo fast, pelo padrão do modelo (o mais longo vale). Opus 5.5: US$ 8/40; Opus 5 e 4.8: US$ 10/50. */
  fast: [
    { pattern: 'claude-opus-5-5%', multiplier: 2 },
    { pattern: 'claude-opus-5', multiplier: 2 },
    { pattern: 'claude-opus-5-20%', multiplier: 2 },
    { pattern: 'claude-opus-4-8%', multiplier: 2 },
  ],
  /** Faixa de contexto longo: prompt (input + leitura e escrita de cache) acima do limite custa `multiplier` vezes. */
  longContext: [{ pattern: 'claude-haiku-5-5%', thresholdTokens: 100_000, multiplier: 5 }],
} as const;

/** Ferramentas de servidor. Web fetch não tem cobrança além dos tokens; execução de código é cobrada por hora de contêiner e fica de fora. */
export const SERVER_TOOL_PRICES = { webSearchPerThousand: 10 } as const;

function likeToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

function longestMatch<T extends { pattern: string }>(model: string, items: readonly T[]): T | null {
  let best: T | null = null;
  for (const p of items) {
    if (!likeToRegExp(p.pattern).test(model)) continue;
    if (!best || p.pattern.length > best.pattern.length) best = p;
  }
  return best;
}

/** Acha o preço do modelo. Vale o padrão mais longo que casa; `null` quando nenhum casa. */
export function resolvePricing(model: string, prices: readonly ModelPricing[]): ModelPricing | null {
  return longestMatch(model, prices);
}

/** Por que não há preço: o modelo não está na tabela, ou está mas não há preço para o modo fast dele. */
export type UnpricedReason = 'model' | 'fast';

export type CostEstimate =
  | { estimate: true; priced: true; pattern: string; costUsd: number }
  /** Sem preço: aparece como "sem preço", nunca como custo zero. */
  | { estimate: true; priced: false; pattern: string | null; costUsd: null; reason: UnpricedReason };

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

/** Tokens do prompt de uma requisição: o que decide a faixa de contexto longo. */
export function promptTokens(t: TokenCounts): number {
  return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/** Faixa de contexto de uma requisição: `LONG_CONTEXT` quando o modelo tem faixa longa e o prompt passou do limite. */
export function contextSizeFor(model: string, tokens: TokenCounts): string {
  const tier = longestMatch(model, PRICE_MODIFIERS.longContext);
  return tier && promptTokens(tokens) > tier.thresholdTokens ? LONG_CONTEXT : '';
}

export type CostInput = Pick<TokenUsage, 'model' | 'tokens' | 'baseline'> &
  Partial<Pick<TokenUsage, 'speed' | 'inferenceGeo' | 'serviceTier' | 'contextSize' | 'webSearchRequests'>>;

/** Multiplicador das dimensões do bucket, ou `null` quando o modo fast do modelo não tem preço. */
function tokenMultiplier(u: CostInput): number | null {
  let m = 1;
  if (u.serviceTier === 'batch') m *= PRICE_MODIFIERS.batch;
  if (u.inferenceGeo === 'us') m *= PRICE_MODIFIERS.usInference;
  if (u.speed === 'fast') {
    const fast = longestMatch(u.model, PRICE_MODIFIERS.fast);
    if (!fast) return null;
    m *= fast.multiplier;
  }
  if (u.contextSize === LONG_CONTEXT) m *= longestMatch(u.model, PRICE_MODIFIERS.longContext)?.multiplier ?? 1;
  return m;
}

export function estimateCost(usage: CostInput, prices: readonly ModelPricing[]): CostEstimate {
  const p = resolvePricing(usage.model, prices);
  if (!p) return { estimate: true, priced: false, pattern: null, costUsd: null, reason: 'model' };
  const multiplier = tokenMultiplier(usage);
  if (multiplier === null) return { estimate: true, priced: false, pattern: p.pattern, costUsd: null, reason: 'fast' };

  const t = effectiveTokens(usage);
  const cacheRead = p.cacheReadPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.read;
  const cacheWrite5m = p.cacheWrite5mPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.write5m;
  const cacheWrite1h = p.cacheWrite1hPerMTok ?? p.inputPerMTok * CACHE_MULTIPLIERS.write1h;
  const tokensUsd =
    (t.input * p.inputPerMTok +
      t.output * p.outputPerMTok +
      t.cacheRead * cacheRead +
      t.cacheWrite5m * cacheWrite5m +
      t.cacheWrite1h * cacheWrite1h) /
    1_000_000;
  const webSearchUsd = ((usage.webSearchRequests ?? 0) * SERVER_TOOL_PRICES.webSearchPerThousand) / 1000;
  return { estimate: true, priced: true, pattern: p.pattern, costUsd: tokensUsd * multiplier + webSearchUsd };
}
