// Montagem das decisões capturadas, igual para o hook e para o transcript: os dois caminhos
// produzem a mesma chave de origem para a mesma chamada, e o registro não duplica.

import type { DecisionDraft } from './registro.ts';
import { DECISION_LIST_MAX, cleanList, cleanText, planTitle, toolSubject, topicKey } from './texto.ts';

/** Onde a decisão aconteceu. */
export interface CaptureBase {
  sessionId: string;
  agentId: string | null;
  repo: string | null;
  branch: string | null;
  transcriptPath: string | null;
  uuid: string | null;
  toolUseId: string | null;
  at: string;
}

/** Ferramentas que são a própria decisão; não passam pela captura de permissão. */
export const DECISION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function common(base: CaptureBase): Pick<DecisionDraft, 'sessionId' | 'agentId' | 'repo' | 'branch' | 'message' | 'decidedAt'> {
  return {
    sessionId: base.sessionId,
    agentId: base.agentId,
    repo: base.repo,
    branch: base.branch,
    message: { uuid: base.uuid, toolUseId: base.toolUseId, transcriptPath: base.transcriptPath },
    decidedAt: base.at,
  };
}

/**
 * Uma decisão por pergunta respondida do `AskUserQuestion`. `answers` é o mapa pergunta → resposta
 * do Claude Code; em múltipla escolha, as opções vêm juntas, separadas por vírgula.
 */
export function questionDrafts(base: CaptureBase, input: unknown, answers: unknown): DecisionDraft[] {
  if (!isObj(input) || !Array.isArray(input.questions) || !isObj(answers)) return [];
  const out: DecisionDraft[] = [];
  for (const [i, q] of input.questions.slice(0, DECISION_LIST_MAX).entries()) {
    if (!isObj(q) || typeof q.question !== 'string') continue;
    const raw = answers[q.question];
    const choice = cleanText(raw);
    const question = cleanText(q.question);
    if (!choice || !question) continue;
    const labels = cleanList(Array.isArray(q.options) ? q.options.map((o) => (isObj(o) ? o.label : null)) : []);
    const chosen = q.multiSelect === true ? cleanList(String(raw).split(/,\s*/)) : [choice];
    out.push({
      ...common(base),
      sourceKey: `tool:${base.toolUseId}:q${i}`,
      topic: topicKey('pergunta', question),
      context: question,
      choice,
      alternatives: labels.filter((l) => !chosen.includes(l)),
      decidedBy: 'usuario',
      origin: 'pergunta',
      inferred: false,
      metadata: {
        header: cleanText(q.header, 60),
        multiSelect: q.multiSelect === true,
        // A resposta não é uma das opções: a pessoa escreveu a sua ("Other").
        freeText: !chosen.some((c) => labels.includes(c)),
      },
    });
  }
  return out;
}

/** A aprovação de um plano. As alternativas são os planos recusados antes dele na sessão. */
export function planDraft(base: CaptureBase, input: unknown, rejected: readonly string[]): DecisionDraft {
  const plan = isObj(input) ? input.plan : null;
  return {
    ...common(base),
    sourceKey: `tool:${base.toolUseId}`,
    topic: 'plano',
    context: 'Plano aprovado',
    choice: planTitle(plan) ?? 'Plano aprovado',
    alternatives: cleanList(rejected),
    decidedBy: 'usuario',
    origin: 'plano',
    inferred: false,
    metadata: { steps: typeof plan === 'string' ? (plan.match(/^\s*(\d+\.|[-*])\s+/gm) ?? []).length : 0 },
  };
}

/** Permitir ou negar uma ferramenta, quando houve pedido de permissão. */
export function permissionDraft(base: CaptureBase, toolName: string, input: unknown, allowed: boolean): DecisionDraft {
  const subject = toolSubject(cleanText(toolName, 60) ?? 'ferramenta', input);
  return {
    ...common(base),
    sourceKey: `tool:${base.toolUseId}`,
    topic: topicKey('permissao', subject),
    context: `Pedido de permissão: ${subject}`,
    choice: `${allowed ? 'Permitir' : 'Negar'} ${subject}`,
    alternatives: [allowed ? 'negar' : 'permitir'],
    decidedBy: 'usuario',
    origin: 'permissao',
    inferred: false,
    metadata: { tool: cleanText(toolName, 60), allowed },
  };
}

/**
 * "Correção sua". Vinda da recusa de um plano com texto, é determinística; vinda de uma mensagem
 * que começa contrariando a proposta, é inferida e fica a confirmar.
 */
export function correctionDraft(
  base: CaptureBase,
  opts: { sourceKey: string; text: string; proposal: string | null; topic: string | null; inferred: boolean },
): DecisionDraft {
  return {
    ...common(base),
    sourceKey: opts.sourceKey,
    topic: opts.topic,
    context: opts.proposal,
    choice: opts.text,
    alternatives: opts.proposal ? [opts.proposal] : [],
    decidedBy: 'usuario',
    origin: 'correcao',
    inferred: opts.inferred,
    state: opts.inferred ? 'a_confirmar' : 'vigente',
  };
}
