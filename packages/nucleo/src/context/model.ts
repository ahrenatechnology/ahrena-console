// Context meter (item 1.7): how much of the window the session, or a subagent, takes up now, and
// how many times the window overflowed (each automatic compaction; the manual one stays apart). As in
// Podium, from 2 overflows on the session gets an alert.

import { InvalidModelError } from '../model.ts';

/** From how many overflows the session (or the agent) gets the alert. */
export const ALERT_THRESHOLD = 2;

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
  /**
   * Estouros: as compactações automáticas (a janela encheu). O maior entre as duas fontes, que
   * contam as mesmas compactações. A manual (`/compact`, o botão Compactar) não é estouro.
   */
  compactions: number;
  /** Marcas `compact_boundary` automáticas no transcript. */
  compactionsTranscript: number;
  /** Hooks `PreCompact` automáticos. */
  compactionsHook: number;
  /** Compactações manuais, à parte: o maior entre as duas fontes. */
  manualCompactions: number;
  manualCompactionsTranscript: number;
  manualCompactionsHook: number;
  /** A última compactação, automática ou manual. */
  lastCompactionAt: string | null;
  lastCompactionTrigger: CompactionTrigger | null;
  /** Hora do evento que deu `usedTokens`; nulo enquanto não houve medição. */
  measuredAt: string | null;
  updatedAt: string;
}

/** 0 to 100, rounded. */
export function contextPct(m: Pick<ContextMeter, 'usedTokens' | 'windowTokens'>): number {
  if (m.windowTokens <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, m.usedTokens) / m.windowTokens) * 100));
}

export function contextAlert(m: Pick<ContextMeter, 'compactions'>): boolean {
  return m.compactions >= ALERT_THRESHOLD;
}

/** "62.6k / 200k (31%)". */
export function contextLabel(m: Pick<ContextMeter, 'usedTokens' | 'windowTokens'>): string {
  return `${shortTokens(m.usedTokens)} / ${shortTokens(m.windowTokens)} (${contextPct(m)}%)`;
}

function shortTokens(n: number): string {
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
  for (const k of ['usedTokens', 'compactions', 'compactionsTranscript', 'compactionsHook', 'manualCompactions', 'manualCompactionsTranscript', 'manualCompactionsHook'] as const) {
    if (!count(m[k])) fail(`${k} precisa ser inteiro >= 0`);
  }
  if (!Number.isInteger(m.windowTokens) || m.windowTokens <= 0) fail('windowTokens precisa ser inteiro > 0');
  if (!WINDOW_SOURCES.includes(m.windowSource)) fail(`windowSource inválido: ${JSON.stringify(m.windowSource)}`);
  if (m.compactions !== Math.max(m.compactionsTranscript, m.compactionsHook)) fail('compactions precisa ser o maior entre as duas fontes');
  if (m.manualCompactions !== Math.max(m.manualCompactionsTranscript, m.manualCompactionsHook)) {
    fail('manualCompactions precisa ser o maior entre as duas fontes');
  }
  if (m.lastCompactionTrigger !== null && !COMPACTION_TRIGGERS.includes(m.lastCompactionTrigger)) {
    fail(`lastCompactionTrigger inválido: ${JSON.stringify(m.lastCompactionTrigger)}`);
  }
  if (!iso(m.lastCompactionAt, true)) fail('lastCompactionAt precisa ser data ISO 8601 em UTC');
  if (!iso(m.measuredAt, true)) fail('measuredAt precisa ser data ISO 8601 em UTC');
  if (!iso(m.updatedAt, false)) fail('updatedAt precisa ser data ISO 8601 em UTC');
}
