// O vigia cobre os hooks que se perdem. Função pura: recebe o estado, a hora e o que a sonda viu,
// e devolve o evento sintético que a regra pede (ou nenhum). A máquina aplica e grava.
//
// Regras, nesta ordem (a primeira que casar vale):
// 1. sonda: nenhum processo `claude` vivo no `cwd` da sessão → `SessionEnd` sintético (vira `completed`);
// 2. abandono: sessão `active` parada há 180 min → `Abandoned`;
// 3. turno morto: o principal está `working`, sem ferramenta, sem subagente, e nada mudou em 120 s →
//    `Interrupted` (vira waiting com motivo `interrupted`).
// A cura de erro não é regra do vigia: ela acontece na transição, quando chega progresso depois do erro.

import { createHash } from 'node:crypto';
import type { SessionEvent } from '../model.ts';
import { lerMemoria, principalDe, subagentesTrabalhando, ultimaAtividade, type EstadoDaSessao } from './regras.ts';

export interface Limites {
  /** Turno sem nenhum sinal por este tempo é dado por morto. Padrão 120 s. */
  turnoMortoMs: number;
  /** Sessão ativa parada por este tempo vira `abandoned`. Padrão 180 min. */
  abandonoMs: number;
  /** A sonda só encerra sessão parada há pelo menos isto, para não pegar o processo ainda subindo. Padrão 30 s. */
  carenciaDaSondaMs: number;
}

export const LIMITES_PADRAO: Readonly<Limites> = {
  turnoMortoMs: 120_000,
  abandonoMs: 180 * 60_000,
  carenciaDaSondaMs: 30_000,
};

export type RegraDoVigia = 'sonda' | 'abandono' | 'turno_morto';

export interface Vigilia {
  regra: RegraDoVigia;
  evento: SessionEvent;
}

/** Normaliza um diretório para comparar com o que a sonda devolve. */
export function normalizarDiretorio(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/**
 * Decide se alguma regra do vigia vale agora.
 * `vivos` é o conjunto de diretórios com processo `claude` vivo; `null` quando a sonda está desligada ou falhou.
 */
export function vigiar(
  estado: EstadoDaSessao,
  agora: Date,
  vivos: ReadonlySet<string> | null,
  limites: Limites = LIMITES_PADRAO,
): Vigilia | null {
  const s = estado.session;
  if (s.endedAt || (s.status !== 'active' && s.status !== 'error')) return null;
  const parado = agora.getTime() - Date.parse(ultimaAtividade(estado));

  if (vivos && s.cwd && parado >= limites.carenciaDaSondaMs && !vivos.has(normalizarDiretorio(s.cwd))) {
    return { regra: 'sonda', evento: sintetico(estado, agora, 'SessionEnd', 'processo encerrado (sonda)', { reason: 'processo_encerrado' }) };
  }

  if (s.status !== 'active') return null;

  if (parado >= limites.abandonoMs) {
    return { regra: 'abandono', evento: sintetico(estado, agora, 'Abandoned', 'sem atividade há 180 min', null) };
  }

  const p = principalDe(estado);
  const memoria = lerMemoria(s);
  if (
    !s.awaitingInputSince &&
    p?.status === 'working' &&
    !p.currentTool &&
    Object.keys(memoria.delegacoes).length === 0 &&
    subagentesTrabalhando(estado).length === 0 &&
    parado >= limites.turnoMortoMs
  ) {
    return { regra: 'turno_morto', evento: sintetico(estado, agora, 'Interrupted', 'turno sem sinal há 120 s (vigia)', null) };
  }
  return null;
}

function sintetico(estado: EstadoDaSessao, agora: Date, type: string, summary: string, extra: Record<string, unknown> | null): SessionEvent {
  const createdAt = agora.toISOString();
  const sessionId = estado.session.id;
  const digest = createHash('sha256').update(`${sessionId}\0${type}\0${createdAt}`).digest('hex').slice(0, 32);
  return {
    id: `estado:${digest}`,
    sessionId,
    agentId: principalDe(estado)?.id ?? null,
    type,
    toolName: null,
    summary,
    data: { sintetico: true, ...extra },
    createdAt,
  };
}
