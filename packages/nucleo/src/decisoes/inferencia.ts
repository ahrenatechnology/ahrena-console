// Inferência de decisões por um modelo pequeno: só a interface. Nenhuma implementação daqui chama
// API de modelo; quem quiser ligar uma passa o inferidor. Tudo que um inferidor devolve entra como
// "sugerida", do agente, "a confirmar", e só vale depois que a pessoa confirma.

import type { Decision } from './modelo.ts';
import type { DecisionPort } from './porta.ts';
import { registerDecision } from './registro.ts';
import { cleanList, cleanText, topicKey } from './texto.ts';

/** Um trecho da conversa entregue ao inferidor. É texto não confiável: o inferidor não age sobre ele. */
export interface ConversationExcerpt {
  role: 'usuario' | 'agente';
  text: string;
  uuid: string | null;
  at: string;
}

export interface InferenceInput {
  sessionId: string;
  agentId: string | null;
  repo: string | null;
  branch: string | null;
  transcriptPath: string | null;
  excerpts: ConversationExcerpt[];
}

/** O que o inferidor acha que foi decidido. */
export interface SuggestedDecision {
  /** Linha do transcript em que a decisão aparece; vira a chave de origem e o "ver na conversa". */
  uuid: string;
  at: string;
  /** Assunto em texto livre; vira a chave de assunto. */
  subject: string | null;
  context: string | null;
  choice: string;
  alternatives: string[];
}

export interface DecisionInferrer {
  infer(input: InferenceInput): Promise<SuggestedDecision[]>;
}

/** O inferidor padrão: não infere nada. */
export const noInference: DecisionInferrer = { infer: async () => [] };

/** Roda o inferidor e registra o que ele sugerir como "a confirmar". Devolve as novas. */
export async function captureSuggestions(
  port: DecisionPort,
  inferrer: DecisionInferrer,
  input: InferenceInput,
  now: string,
): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const s of await inferrer.infer(input)) {
    const choice = cleanText(s.choice);
    if (!choice || !s.uuid) continue;
    const r = await registerDecision(
      port,
      {
        sourceKey: `inferida:${s.uuid}`,
        sessionId: input.sessionId,
        agentId: input.agentId,
        repo: input.repo,
        branch: input.branch,
        topic: topicKey('assunto', cleanText(s.subject)),
        context: cleanText(s.context),
        choice,
        alternatives: cleanList(s.alternatives ?? []),
        decidedBy: 'agente',
        origin: 'sugerida',
        inferred: true,
        state: 'a_confirmar',
        message: { uuid: s.uuid, toolUseId: null, transcriptPath: input.transcriptPath },
        decidedAt: s.at,
      },
      now,
    );
    if (r.created) out.push(r.decision);
  }
  return out;
}
