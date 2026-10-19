// Tamanho da janela de contexto pelo modelo e pelo modo.
// A janela padrão dos modelos Claude é de 200k; a longa (1M) vem do modo da sessão, que o Claude Code
// marca com o sufixo `[1m]` no modelo (ex.: `claude-opus-5-5[1m]`). O transcript grava o modelo sem
// o sufixo, então a sessão que já mandou mais que a janela padrão também está na longa.

import type { WindowSource } from './modelo.ts';

export const JANELA_PADRAO = 200_000;
export const JANELA_LONGA = 1_000_000;

/** Janela padrão por modelo, quando ela não é a de 200k. O primeiro padrão que casa vale. */
export const JANELAS_POR_MODELO: readonly { padrao: RegExp; tokens: number }[] = [];

const SUFIXO_LONGO = /\[1m\]/i;

export interface Janela {
  tokens: number;
  source: WindowSource;
}

/**
 * A janela do agente, dado o modelo da medição, o da sessão (que pode trazer o sufixo), o maior
 * contexto já visto e a janela gravada antes. A janela não encolhe: a sessão que chegou na longa
 * continua nela.
 */
export function janelaDe(
  modelo: string | null,
  modeloDaSessao: string | null,
  maiorVisto: number,
  anterior: Janela | null = null,
): Janela {
  let janela: Janela;
  if ((modelo && SUFIXO_LONGO.test(modelo)) || (modeloDaSessao && SUFIXO_LONGO.test(modeloDaSessao))) {
    janela = { tokens: JANELA_LONGA, source: 'sufixo' };
  } else {
    const doModelo = modelo ? JANELAS_POR_MODELO.find((j) => j.padrao.test(modelo))?.tokens : undefined;
    janela = { tokens: doModelo ?? JANELA_PADRAO, source: 'modelo' };
  }
  if (maiorVisto > janela.tokens) janela = { tokens: JANELA_LONGA, source: 'observado' };
  if (anterior && anterior.tokens > janela.tokens) return anterior;
  return janela;
}
