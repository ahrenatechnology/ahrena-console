// Grava o plano pela porta: aplica os eventos novos ao plano gravado, em ordem, e grava uma vez.
// Quem chama é a ingestão (hooks e importador do transcript), com os eventos que acabou de gravar.
// Cada mudança passa também pelo histórico (historico.ts): os planos que fecharam e o aberto
// são gravados pela porta, um registro por plano.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { aplicarAoPlano, eventoDoPlano } from './extracao.ts';
import { seguirHistorico } from './historico.ts';
import type { PlanRecord, SessionPlan } from './modelo.ts';

/** Devolve o plano gravado, ou `null` se nenhum evento mudou o plano. */
export async function atualizarPlano(
  porta: Pick<StoragePort, 'getPlan' | 'putPlan' | 'putPlanRecord'>,
  sessionId: string,
  eventos: readonly SessionEvent[],
): Promise<SessionPlan | null> {
  const doPlano = eventos
    .filter((e) => e.sessionId === sessionId && eventoDoPlano(e))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : a.i - b.i))
    .map(({ e }) => e);
  if (doPlano.length === 0) return null;
  let plano = await porta.getPlan(sessionId);
  let mudou = false;
  const registros = new Map<number, PlanRecord>();
  for (const e of doPlano) {
    const novo = aplicarAoPlano(plano, sessionId, e);
    if (novo) {
      const h = seguirHistorico(plano, novo, e);
      for (const r of h.registros) registros.set(r.seq, r);
      plano = h.plano;
      mudou = true;
    }
  }
  if (!mudou || !plano) return null;
  for (const r of registros.values()) await porta.putPlanRecord(r);
  await porta.putPlan(plano);
  return plano;
}

/**
 * Refaz o plano e o histórico da sessão a partir de todos os eventos gravados. Para as sessões
 * importadas antes do plano (#19) ou do histórico (#131): a gravação incremental só vê eventos novos.
 * Devolve quantos planos a sessão teve.
 */
export async function reconstruirPlano(
  porta: Pick<StoragePort, 'listEvents' | 'getPlan' | 'putPlan' | 'putPlanRecord' | 'deletePlanRecords'>,
  sessionId: string,
  /** Os mesmos eventos relidos do transcript, com os campos que a importação antiga não guardou. */
  relidos: readonly SessionEvent[] = [],
): Promise<number> {
  const porId = new Map<string, SessionEvent>();
  let cursor: string | null = null;
  do {
    const page = await porta.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) if (eventoDoPlano(e)) porId.set(e.id, e);
    cursor = page.nextCursor;
  } while (cursor);
  for (const e of relidos) if (e.sessionId === sessionId && eventoDoPlano(e)) porId.set(e.id, e);
  const doPlano = [...porId.values()];
  if (doPlano.length === 0) return 0;
  await porta.deletePlanRecords(sessionId);
  // Do zero: o plano gravado só viu parte dos eventos.
  let planos = 0;
  const doZero = {
    getPlan: async () => null,
    putPlan: (p: SessionPlan) => porta.putPlan(p),
    putPlanRecord: (r: PlanRecord) => ((planos = Math.max(planos, r.seq)), porta.putPlanRecord(r)),
  };
  await atualizarPlano(doZero, sessionId, doPlano);
  return planos;
}
