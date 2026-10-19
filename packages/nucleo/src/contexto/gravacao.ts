// Grava o medidor de contexto pela porta: aplica os eventos novos aos medidores gravados, em ordem,
// e grava uma vez cada medidor que mudou. Quem chama é a ingestão (hooks e importador do transcript),
// com os eventos que acabou de gravar; evento repetido não chega aqui, então nada conta duas vezes.
// `reconstruirContexto` refaz os medidores do zero, para o reprocessamento do histórico.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { agenteDoMedidor, aplicarAoMedidor, eventoDoContexto, instante, medidorVazio } from './medicao.ts';
import type { ContextMeter } from './modelo.ts';

/** Devolve os medidores gravados (os que mudaram). */
export async function atualizarContexto(
  porta: Pick<StoragePort, 'getSession' | 'listContextMeters' | 'putContextMeter'>,
  sessionId: string,
  eventos: readonly SessionEvent[],
): Promise<ContextMeter[]> {
  const doContexto = eventos
    .filter((e) => e.sessionId === sessionId && eventoDoContexto(e))
    .map((e, i) => ({ e, i, t: instante(e.createdAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
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

/**
 * Refaz do zero os medidores da sessão a partir dos eventos gravados e dos mesmos eventos relidos
 * do transcript (que trazem o `compactMetadata` que a importação antiga não guardou). O relido
 * substitui o gravado de mesmo id. Devolve quantos medidores gravou.
 */
export async function reconstruirContexto(
  porta: Pick<StoragePort, 'getSession' | 'listEvents' | 'putContextMeter' | 'deleteContextMeters'>,
  sessionId: string,
  relidos: readonly SessionEvent[] = [],
): Promise<number> {
  const porId = new Map<string, SessionEvent>();
  let cursor: string | null = null;
  do {
    const page = await porta.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) if (eventoDoContexto(e)) porId.set(e.id, e);
    cursor = page.nextCursor;
  } while (cursor);
  for (const e of relidos) if (e.sessionId === sessionId && eventoDoContexto(e)) porId.set(e.id, e);
  if (porId.size === 0) return 0;
  await porta.deleteContextMeters(sessionId);
  const doZero = { getSession: porta.getSession.bind(porta), listContextMeters: async () => [], putContextMeter: porta.putContextMeter.bind(porta) };
  return (await atualizarContexto(doZero, sessionId, [...porId.values()])).length;
}
