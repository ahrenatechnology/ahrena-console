// Tabela de preços padrão, versionada no código. O usuário sobrescreve pela porta (`putModelPricing`).
//
// Fonte: https://platform.claude.com/docs/en/about-claude/pricing, consultada em 2026-10-18.
// Preços da API da Anthropic (primeira parte), em US$ por milhão de tokens. Bedrock e Vertex têm preço próprio.
// Modelo que não está aqui (Sonnet 3.7, por exemplo) fica "sem preço": não inventamos valor.
//
// Cada modelo casa pelo id e pelo id com data (`claude-sonnet-4-5-20250929`). Padrão aberto como
// `claude-opus-5%` não é usado, para um modelo novo não herdar o preço de outro.

import type { ModelPricing } from '../model.ts';

export const FONTE_DOS_PRECOS = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRECOS_CONSULTADOS_EM = '2026-10-18';

export interface PrecoPadrao extends ModelPricing {
  /** Nome do modelo para a tela de preços. */
  nome: string;
}

type Linha = [nome: string, ids: string[], input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number];

// Nome, ids, input, escrita de cache 5 min, escrita de cache 1 h, leitura de cache, output.
const LINHAS: Linha[] = [
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
  // Prompt acima de 100 mil tokens custa 5x (PRICE_MODIFIERS.longContext em src/pricing.ts).
  ['Claude Haiku 5.5', ['claude-haiku-5-5'], 0.1, 0.125, 0.2, 0.01, 0.5],
  ['Claude Haiku 4.5', ['claude-haiku-4-5'], 1, 1.25, 2, 0.1, 5],
  ['Claude Haiku 3.5', ['claude-3-5-haiku'], 0.8, 1, 1.6, 0.08, 4],
];

const ATUALIZADO_EM = `${PRECOS_CONSULTADOS_EM}T00:00:00.000Z`;

export const PRECOS_PADRAO: readonly PrecoPadrao[] = LINHAS.flatMap(([nome, ids, input, w5m, w1h, read, output]) =>
  ids.flatMap((id) =>
    [id, `${id}-20%`].map((pattern) => ({
      nome,
      pattern,
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: read,
      cacheWrite5mPerMTok: w5m,
      cacheWrite1hPerMTok: w1h,
      updatedAt: ATUALIZADO_EM,
    })),
  ),
);
