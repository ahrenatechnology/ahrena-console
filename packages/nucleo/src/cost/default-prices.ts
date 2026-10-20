// Default price table, versioned in the code. The user overrides it through the port (`putModelPricing`).
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, checked on 2026-10-18.
// Anthropic API prices (first party), in US$ per million tokens. Bedrock and Vertex have their own prices.
// A model that is not here (Sonnet 3.7, for example) is "unpriced": we do not make up a value.
//
// Each model matches by its id and by its dated id (`claude-sonnet-4-5-20250929`). An open pattern like
// `claude-opus-5%` is not used, so a new model does not inherit another one's price.

import type { ModelPricing } from '../model.ts';

export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICES_CHECKED_ON = '2026-10-18';

export interface DefaultPrice extends ModelPricing {
  /** The model's name for the prices screen. */
  name: string;
}

type Row = [name: string, ids: string[], input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number];

// Name, ids, input, 5 min cache write, 1 h cache write, cache read, output.
const ROWS: Row[] = [
  ['Claude Fable 5.1', ['claude-fable-5-1'], 10, 12.5, 20, 0.25, 50],
  ['Claude Mythos 5.1', ['claude-mythos-5-1'], 10, 12.5, 20, 0.25, 50],
  ['Claude Fable 5', ['claude-fable-5'], 10, 12.5, 20, 1, 50],
  ['Claude Mythos 5', ['claude-mythos-5'], 10, 12.5, 20, 1, 50],
  ['Claude Opus 5.5', ['claude-opus-5-5'], 4, 5, 8, 0.2, 20],
  ['Claude Opus 5', ['claude-opus-5'], 5, 6.25, 10, 0.5, 25],
  ['Claude Opus 4.8', ['claude-opus-4-8'], 5, 6.25, 10, 0.5, 25],
  ['Claude Opus 4.7', ['claude-opus-4-7'], 5, 6.25, 10, 0.5, 25],
  ['Claude Opus 4.6', ['claude-opus-4-6'], 5, 6.25, 10, 0.5, 25],
  ['Claude Opus 4.5', ['claude-opus-4-5'], 5, 6.25, 10, 0.5, 25],
  ['Claude Opus 4.1', ['claude-opus-4-1'], 15, 18.75, 30, 1.5, 75],
  ['Claude Opus 4', ['claude-opus-4', 'claude-opus-4-0'], 15, 18.75, 30, 1.5, 75],
  ['Claude Sonnet 5.5', ['claude-sonnet-5-5'], 2, 2.5, 4, 0.1, 10],
  ['Claude Sonnet 5', ['claude-sonnet-5'], 2, 2.5, 4, 0.2, 10],
  ['Claude Sonnet 4.6', ['claude-sonnet-4-6'], 3, 3.75, 6, 0.3, 15],
  ['Claude Sonnet 4.5', ['claude-sonnet-4-5'], 3, 3.75, 6, 0.3, 15],
  ['Claude Sonnet 4', ['claude-sonnet-4', 'claude-sonnet-4-0'], 3, 3.75, 6, 0.3, 15],
  // A prompt above 100 thousand tokens costs 5x (PRICE_MODIFIERS.longContext in src/pricing.ts).
  ['Claude Haiku 5.5', ['claude-haiku-5-5'], 0.1, 0.125, 0.2, 0.01, 0.5],
  ['Claude Haiku 4.5', ['claude-haiku-4-5'], 1, 1.25, 2, 0.1, 5],
  ['Claude Haiku 3.5', ['claude-3-5-haiku'], 0.8, 1, 1.6, 0.08, 4],
];

const UPDATED_AT = `${PRICES_CHECKED_ON}T00:00:00.000Z`;

export const DEFAULT_PRICES: readonly DefaultPrice[] = ROWS.flatMap(([name, ids, input, w5m, w1h, read, output]) =>
  ids.flatMap((id) =>
    [id, `${id}-20%`].map((pattern) => ({
      name,
      pattern,
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: read,
      cacheWrite5mPerMTok: w5m,
      cacheWrite1hPerMTok: w1h,
      updatedAt: UPDATED_AT,
    })),
  ),
);
