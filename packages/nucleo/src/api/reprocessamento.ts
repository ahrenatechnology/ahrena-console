// O que a importação do histórico deixou de fora, e como a API completa.
//
// - Sessões importadas antes do plano (#19) ou do histórico de planos (#131): a gravação do plano
//   só vê eventos novos, então os planos antigos nunca entraram, e a importação antiga não guardou
//   a entrada das ferramentas do plano. `reconstruirPlano` refaz o plano e o histórico de cada
//   sessão a partir dos eventos gravados e dos mesmos eventos relidos do transcript.
// - Decisões (#99): a captura pelos hooks só vê o que acontece com o núcleo no ar. As respostas ao
//   AskUserQuestion, os planos aprovados e as permissões negadas que ficaram só no transcript
//   entram pela captura do transcript, que agora roda na importação (`capturarDoTranscript`) e
//   uma vez para o histórico já importado (`reprocessarHistorico`).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureTranscriptFile } from '../decisoes/captura-transcript.ts';
import type { Decision } from '../decisoes/modelo.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { markNoise } from '../decisoes/registro.ts';
import { isDismissedAnswer, looksLikeCorrection, shortChoice } from '../decisoes/texto.ts';
import { eventosDoTranscript, type SessaoImportada } from '../ingest/historico/importer.ts';
import type { Session, SessionEvent } from '../model.ts';
import { eventoDoPlano } from '../plano/extracao.ts';
import { reconstruirPlano } from '../plano/gravacao.ts';
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
export async function capturarDoTranscript(decisoes: DecisionPort, s: SessaoImportada, agora = new Date().toISOString()): Promise<number> {
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
        const relidos = arquivo ? await eventosDoTranscript(arquivo, s.id, eventoDoPlano) : [];
        const n = await reconstruirPlano(o.storage, s.id, relidos);
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
