// Medidor de contexto (item 1.7): quanto da janela a sessão, ou um subagente, ocupa agora, e
// quantas vezes a janela estourou (cada compactação, automática ou `/compact`). Como no Podium,
// a partir de 2 estouros a sessão ganha um alerta.

import { InvalidModelError } from '../model.ts';

/** A partir de quantos estouros a sessão (ou o agente) ganha o alerta. */
export const ALERTA_A_PARTIR_DE = 2;

export const COMPACTION_TRIGGERS = ['auto', 'manual'] as const;
export type CompactionTrigger = (typeof COMPACTION_TRIGGERS)[number];

/**
 * De onde veio o tamanho da janela:
 * - `modelo`: o padrão do modelo;
 * - `sufixo`: o modelo da sessão pede a janela longa (`[1m]`);
 * - `observado`: a sessão já passou da janela padrão, então está na longa.
 */
export const WINDOW_SOURCES = ['modelo', 'sufixo', 'observado'] as const;
export type WindowSource = (typeof WINDOW_SOURCES)[number];

/** Medidor de um agente da sessão. A chave é (sessionId, agentId); `agentId` nulo é o principal. */
export interface ContextMeter {
  sessionId: string;
  /** Id do subagente como os eventos gravam; `null` é o agente principal. */
  agentId: string | null;
  /** Modelo da última medição. */
  model: string | null;
  /** Tokens que a última mensagem do assistente mandou: input mais cache (lido e escrito). */
  usedTokens: number;
  windowTokens: number;
  windowSource: WindowSource;
  /** Estouros: o maior entre as duas fontes, que contam as mesmas compactações. */
  compactions: number;
  /** Marcas `compact_boundary` no transcript. */
  compactionsTranscript: number;
  /** Hooks `PreCompact`. */
  compactionsHook: number;
  lastCompactionAt: string | null;
  lastCompactionTrigger: CompactionTrigger | null;
  /** Hora do evento que deu `usedTokens`; nulo enquanto não houve medição. */
  measuredAt: string | null;
  updatedAt: string;
}

/** 0 a 100, arredondado. */
export function pctDoContexto(m: Pick<ContextMeter, 'usedTokens' | 'windowTokens'>): number {
  if (m.windowTokens <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, m.usedTokens) / m.windowTokens) * 100));
}

export function alertaDeContexto(m: Pick<ContextMeter, 'compactions'>): boolean {
  return m.compactions >= ALERTA_A_PARTIR_DE;
}

/** "62.6k / 200k (31%)". */
export function rotuloDoContexto(m: Pick<ContextMeter, 'usedTokens' | 'windowTokens'>): string {
  return `${tokensCurtos(m.usedTokens)} / ${tokensCurtos(m.windowTokens)} (${pctDoContexto(m)}%)`;
}

function tokensCurtos(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function fail(message: string): never {
  throw new InvalidModelError(`ContextMeter: ${message}`);
}

const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const iso = (v: unknown, nullable: boolean) => (nullable && v === null) || (typeof v === 'string' && ISO_UTC.test(v));

export function validateContextMeter(m: ContextMeter): void {
  if (typeof m.sessionId !== 'string' || m.sessionId.length === 0) fail('sessionId é obrigatório');
  if (m.agentId !== null && (typeof m.agentId !== 'string' || m.agentId.length === 0)) fail('agentId precisa ser texto ou nulo');
  for (const k of ['usedTokens', 'compactions', 'compactionsTranscript', 'compactionsHook'] as const) {
    if (!count(m[k])) fail(`${k} precisa ser inteiro >= 0`);
  }
  if (!Number.isInteger(m.windowTokens) || m.windowTokens <= 0) fail('windowTokens precisa ser inteiro > 0');
  if (!WINDOW_SOURCES.includes(m.windowSource)) fail(`windowSource inválido: ${JSON.stringify(m.windowSource)}`);
  if (m.compactions !== Math.max(m.compactionsTranscript, m.compactionsHook)) fail('compactions precisa ser o maior entre as duas fontes');
  if (m.lastCompactionTrigger !== null && !COMPACTION_TRIGGERS.includes(m.lastCompactionTrigger)) {
    fail(`lastCompactionTrigger inválido: ${JSON.stringify(m.lastCompactionTrigger)}`);
  }
  if (!iso(m.lastCompactionAt, true)) fail('lastCompactionAt precisa ser data ISO 8601 em UTC');
  if (!iso(m.measuredAt, true)) fail('measuredAt precisa ser data ISO 8601 em UTC');
  if (!iso(m.updatedAt, false)) fail('updatedAt precisa ser data ISO 8601 em UTC');
}
