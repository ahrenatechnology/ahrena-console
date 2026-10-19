// Aplica um evento ao medidor de contexto. Função pura: a gravação (gravacao.ts) lê, aplica em
// ordem e grava.
//
// - Mensagem do assistente com uso (`data.usage`, do transcript): o contexto que ela mandou é o
//   input mais o cache lido e escrito. Vale a mais recente; uma mensagem mais velha que a medição
//   gravada não a substitui.
// - Compactação no transcript (`Compaction`, a marca `compact_boundary`): um estouro. Se a marca traz
//   o contexto depois da compactação (`postTokens`), ele vira a medição até a próxima mensagem.
// - Hook `PreCompact`: outro jeito de ver o mesmo estouro. As duas fontes contam as mesmas
//   compactações, por isso o estouro é o maior entre elas, nunca a soma.

import type { SessionEvent } from '../model.ts';
import { janelaDe } from './janela.ts';
import { COMPACTION_TRIGGERS, type CompactionTrigger, type ContextMeter } from './modelo.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** O agente do medidor: `null` para o principal (sem agente, ou o `<sessão>:main` do importador). */
export function agenteDoMedidor(e: Pick<SessionEvent, 'agentId'>): string | null {
  return e.agentId === null || e.agentId.endsWith(':main') ? null : e.agentId;
}

/** Tokens de contexto de uma mensagem do assistente; `null` se o evento não tem uso. */
export function contextoDaMensagem(e: Pick<SessionEvent, 'data'>): { tokens: number; modelo: string | null } | null {
  const uso = obj(obj(e.data)?.usage);
  const t = obj(uso?.tokens);
  if (!uso || !t) return null;
  const tokens = n(t.input) + n(t.cacheRead) + n(t.cacheWrite5m) + n(t.cacheWrite1h);
  return tokens > 0 ? { tokens, modelo: str(uso.model) } : null;
}

interface Estouro {
  fonte: 'transcript' | 'hook';
  gatilho: CompactionTrigger | null;
  antes: number;
  depois: number;
}

function estouroDe(e: SessionEvent): Estouro | null {
  const d = obj(e.data);
  if (e.type === 'Compaction') {
    const c = obj(d?.compact);
    return { fonte: 'transcript', gatilho: gatilho(c?.trigger), antes: n(c?.preTokens), depois: n(c?.postTokens) };
  }
  if (e.type === 'PreCompact') return { fonte: 'hook', gatilho: gatilho(d?.trigger), antes: 0, depois: 0 };
  return null;
}

const gatilho = (v: unknown): CompactionTrigger | null =>
  COMPACTION_TRIGGERS.includes(v as CompactionTrigger) ? (v as CompactionTrigger) : null;

/** Se o evento muda algum medidor. */
export function eventoDoContexto(e: SessionEvent): boolean {
  return estouroDe(e) !== null || contextoDaMensagem(e) !== null;
}

export function medidorVazio(sessionId: string, agentId: string | null, em: string): ContextMeter {
  return {
    sessionId,
    agentId,
    model: null,
    usedTokens: 0,
    windowTokens: janelaDe(null, null, 0).tokens,
    windowSource: 'modelo',
    compactions: 0,
    compactionsTranscript: 0,
    compactionsHook: 0,
    lastCompactionAt: null,
    lastCompactionTrigger: null,
    measuredAt: null,
    updatedAt: em,
  };
}

/**
 * Devolve o medidor com o evento aplicado, ou `null` se o evento não o muda. O evento precisa ser
 * do agente do medidor (`agenteDoMedidor`). `modeloDaSessao` é o da sessão, que pode trazer `[1m]`.
 */
export function aplicarAoMedidor(atual: ContextMeter, e: SessionEvent, modeloDaSessao: string | null): ContextMeter | null {
  const mensagem = contextoDaMensagem(e);
  const estouro = estouroDe(e);
  if (!mensagem && !estouro) return null;

  const m: ContextMeter = { ...atual, updatedAt: e.createdAt > atual.updatedAt ? e.createdAt : atual.updatedAt };
  const maisNovo = m.measuredAt === null || e.createdAt >= m.measuredAt;
  let visto = 0;

  if (mensagem) {
    visto = mensagem.tokens;
    if (maisNovo) {
      m.usedTokens = mensagem.tokens;
      m.model = mensagem.modelo ?? m.model;
      m.measuredAt = e.createdAt;
    }
  }
  if (estouro) {
    if (estouro.fonte === 'transcript') m.compactionsTranscript++;
    else m.compactionsHook++;
    m.compactions = Math.max(m.compactionsTranscript, m.compactionsHook);
    if (m.lastCompactionAt === null || e.createdAt >= m.lastCompactionAt) {
      m.lastCompactionAt = e.createdAt;
      m.lastCompactionTrigger = estouro.gatilho ?? m.lastCompactionTrigger;
    }
    visto = estouro.antes;
    if (estouro.depois > 0 && maisNovo) {
      m.usedTokens = estouro.depois;
      m.measuredAt = e.createdAt;
    }
  }

  const janela = janelaDe(m.model, modeloDaSessao, Math.max(visto, m.usedTokens), { tokens: m.windowTokens, source: m.windowSource });
  m.windowTokens = janela.tokens;
  m.windowSource = janela.source;
  return m;
}
