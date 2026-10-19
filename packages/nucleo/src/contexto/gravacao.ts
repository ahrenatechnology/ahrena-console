// Grava o medidor de contexto pela porta: aplica os eventos novos aos medidores gravados, em ordem,
// e grava uma vez cada medidor que mudou. Quem chama é a ingestão (hooks e importador do transcript),
// com os eventos que acabou de gravar; evento repetido não chega aqui, então nada conta duas vezes.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { agenteDoMedidor, aplicarAoMedidor, eventoDoContexto, medidorVazio } from './medicao.ts';
import type { ContextMeter } from './modelo.ts';

/** Devolve os medidores gravados (os que mudaram). */
export async function atualizarContexto(
  porta: Pick<StoragePort, 'getSession' | 'listContextMeters' | 'putContextMeter'>,
  sessionId: string,
  eventos: readonly SessionEvent[],
): Promise<ContextMeter[]> {
  const doContexto = eventos
    .filter((e) => e.sessionId === sessionId && eventoDoContexto(e))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : a.i - b.i))
    .map(({ e }) => e);
  if (doContexto.length === 0) return [];

  const modeloDaSessao = (await porta.getSession(sessionId))?.model ?? null;
  const gravados = new Map((await porta.listContextMeters(sessionId)).map((m) => [m.agentId, m] as const));
  const mudados = new Map<string | null, ContextMeter>();
  for (const e of doContexto) {
    const agente = agenteDoMedidor(e);
    const atual = mudados.get(agente) ?? gravados.get(agente) ?? medidorVazio(sessionId, agente, e.createdAt);
    const novo = aplicarAoMedidor(atual, e, modeloDaSessao);
    if (novo) mudados.set(agente, novo);
  }
  for (const m of mudados.values()) await porta.putContextMeter(m);
  return [...mudados.values()];
}
