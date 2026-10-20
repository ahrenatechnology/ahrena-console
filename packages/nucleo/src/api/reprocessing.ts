// What the history import left out, and how the API fills it in.
//
// - Sessions imported before the plan (#19) or the plan history (#131): the plan write only sees
//   new events, so the old plans never came in, and the old import did not keep the plan tools'
//   input. `rebuildPlan` rebuilds each session's plan and history from the stored events and the
//   same events re-read from the transcript.
// - Decisions (#99): the capture through the hooks only sees what happens while the core is up. The
//   answers to AskUserQuestion, the approved plans and the denied permissions that stayed only in the
//   transcript come in through the transcript capture, which now runs on import (`capturarDoTranscript`)
//   and once for the already imported history (`reprocessarHistorico`).
// - Context meter (item 1.7): the write only sees new events, and the old import did not keep the
//   compaction's `compactMetadata`. `reprocessarContexto` rebuilds each session's meters from the
//   stored events and the compactions re-read from the transcript (and from the subagents).

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { rebuildContextMeters } from '../context/recording.ts';
import { captureTranscriptFile } from '../decisions/capture-transcript.ts';
import type { Decision } from '../decisions/model.ts';
import type { DecisionPort } from '../decisions/port.ts';
import { markNoise } from '../decisions/registry.ts';
import { isDismissedAnswer, looksLikeCorrection, shortChoice } from '../decisions/text.ts';
import { transcriptEvents, type ImportedSession } from '../ingest/history/importer.ts';
import type { Session, SessionEvent } from '../model.ts';
import { isPlanEvent } from '../plan/extraction.ts';
import { rebuildPlan } from '../plan/recording.ts';
import type { Page, StoragePort } from '../storage-port.ts';

/** O nome do reprocessamento; um nome novo faz rodar de novo em todo banco. */
export const REPROCESSAMENTO = 'planos-e-decisoes-1';

const DECISORAS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** O evento pode trazer decisão? Resposta a pergunta, plano, recusa ou o prompt (correção sua). */
export function eventoDeDecisao(e: SessionEvent): boolean {
  if (e.type === 'UserPrompt') return true;
  if (e.type !== 'ToolResult') return false;
  return (e.toolName !== null && DECISORAS.has(e.toolName)) || (e.data as { isError?: unknown } | null)?.isError === true;
}

/** Na importação: captura as decisões do transcript da sessão quando os eventos novos podem trazer alguma. */
export async function capturarDoTranscript(decisoes: DecisionPort, s: ImportedSession, agora = new Date().toISOString()): Promise<number> {
  if (!s.transcriptPath || !s.added.some(eventoDeDecisao)) return 0;
  return (await captureTranscriptFile(decisoes, s.transcriptPath, agora)).created.length;
}

/** O transcript principal da sessão: o que o hook mandou ou o do cursor da importação. */
export function transcriptDe(s: Session, raiz: string): string | null {
  const m = s.metadata as { transcriptPath?: unknown; importacao?: { file?: unknown } } | undefined;
  if (typeof m?.transcriptPath === 'string') return m.transcriptPath;
  if (typeof m?.importacao?.file === 'string') return join(raiz, m.importacao.file);
  return null;
}

export interface Reprocessado {
  sessoes: number;
  /** Sessões com plano e quantos planos elas tiveram. */
  comPlano: number;
  planos: number;
  decisoes: number;
}

/** Uma passada por todas as sessões: refaz os planos e captura as decisões do transcript. */
export async function reprocessarHistorico(o: {
  storage: StoragePort;
  decisoes: DecisionPort | null;
  raiz: string;
  log?: (m: string) => void;
  agora?: () => string;
}): Promise<Reprocessado> {
  const agora = o.agora ?? (() => new Date().toISOString());
  const r: Reprocessado = { sessoes: 0, comPlano: 0, planos: 0, decisoes: 0 };
  let cursor: string | null = null;
  do {
    const page = await o.storage.listSessions({ limit: 200, cursor });
    for (const s of page.items) {
      r.sessoes++;
      try {
        const t = transcriptDe(s, o.raiz);
        const arquivo = t && existsSync(t) ? t : null;
        const relidos = arquivo ? await transcriptEvents(arquivo, s.id, isPlanEvent) : [];
        const n = await rebuildPlan(o.storage, s.id, relidos);
        if (n > 0) (r.comPlano++, (r.planos += n));
        if (o.decisoes && arquivo) r.decisoes += (await captureTranscriptFile(o.decisoes, arquivo, agora())).created.length;
      } catch (err) {
        o.log?.(`reprocessamento de ${s.id}: ${(err as Error).message}`);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return r;
}

/** A limpeza das decisões que a captura antiga gravou e não são decisão. */
export const LIMPEZA_DAS_DECISOES = 'decisoes-ruido-1';

/**
 * Uma passada pelas decisões gravadas, com as regras de hoje:
 * - pergunta fechada sem resposta ("[User dismissed…]") sai das listas;
 * - "correção" inferida de uma mensagem que não responde "não, …" a uma pergunta do agente
 *   (longa, pergunta, dúvida, desabafo) sai das listas, se a pessoa ainda não mexeu nela;
 * - a correção que fica ganha o título curto, com o texto inteiro no detalhe.
 * O que sai fica `descartada`, com o motivo em `metadata.ruido`: no histórico, fora das listas.
 */
export async function limparDecisoes(storage: StoragePort, decisoes: DecisionPort, agora = new Date().toISOString()): Promise<{ ruido: number; encurtadas: number }> {
  const r = { ruido: 0, encurtadas: 0 };
  let cursor: string | null = null;
  do {
    const page = await storage.listSessions({ limit: 200, cursor });
    for (const s of page.items) {
      let c: string | null = null;
      const todas: Decision[] = [];
      do {
        const p: Page<Decision> = await decisoes.listDecisions({ sessionId: s.id, limit: 500, cursor: c });
        todas.push(...p.items);
        c = p.nextCursor;
      } while (c);
      for (const d of todas) {
        if (d.state === 'descartada' || d.state === 'revertida') continue;
        if (d.origin === 'pergunta' && isDismissedAnswer(d.choice)) {
          await markNoise(decisoes, d.id, 'pergunta fechada sem resposta', agora);
          r.ruido++;
          continue;
        }
        if (d.origin !== 'correcao') continue;
        const texto = typeof d.metadata?.texto === 'string' ? d.metadata.texto : d.choice;
        const respondePergunta = d.context?.trim().endsWith('?') === true;
        if (d.inferred && d.state === 'a_confirmar' && !d.metadata?.painel && (!respondePergunta || !looksLikeCorrection(texto))) {
          await markNoise(decisoes, d.id, 'mensagem que não contraria uma proposta', agora);
          r.ruido++;
          continue;
        }
        const curta = shortChoice(texto);
        if (curta !== d.choice) {
          await decisoes.putDecision({ ...d, choice: curta, metadata: { ...d.metadata, texto }, updatedAt: agora });
          r.encurtadas++;
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return r;
}

/** O reprocessamento do medidor de contexto; um nome novo faz rodar de novo em todo banco. */
export const REPROCESSAMENTO_DO_CONTEXTO = 'contexto-1';

/** Os transcripts dos subagentes da sessão, ao lado do principal (`<sessão>/subagents/agent-*.jsonl`). */
function transcriptsDosSubagentes(principal: string): string[] {
  const pasta = join(dirname(principal), basename(principal, '.jsonl'), 'subagents');
  try {
    return readdirSync(pasta).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).map((f) => join(pasta, f));
  } catch {
    return [];
  }
}

/** Uma passada por todas as sessões: refaz os medidores de contexto e os estouros. */
export async function reprocessarContexto(o: { storage: StoragePort; raiz: string; log?: (m: string) => void }): Promise<{ sessoes: number; medidores: number }> {
  const r = { sessoes: 0, medidores: 0 };
  let cursor: string | null = null;
  do {
    const page = await o.storage.listSessions({ limit: 200, cursor });
    for (const s of page.items) {
      r.sessoes++;
      try {
        const t = transcriptDe(s, o.raiz);
        const arquivos = t && existsSync(t) ? [t, ...transcriptsDosSubagentes(t)] : [];
        const relidos: SessionEvent[] = [];
        for (const a of arquivos) relidos.push(...(await transcriptEvents(a, s.id, (e) => e.type === 'Compaction')));
        r.medidores += await rebuildContextMeters(o.storage, s.id, relidos);
      } catch (err) {
        o.log?.(`medidor de contexto de ${s.id}: ${(err as Error).message}`);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return r;
}
