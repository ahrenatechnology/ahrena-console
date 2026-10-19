// O que uma decisão leva para o hub (épico 7). Por padrão só metadados: nenhum texto que veio da
// conversa (assunto, contexto, escolha, alternativas) nem caminho local da máquina. O texto só sai
// quando a pessoa libera aquela decisão (`releaseDecisionText`).

import type { Decision, DecisionOrigin, DecisionScope, DecisionState, Decider } from './modelo.ts';

export interface DecisionHubText {
  topic: string | null;
  context: string | null;
  choice: string;
  alternatives: string[];
}

export interface DecisionHubRecord {
  id: string;
  sessionId: string;
  agentId: string | null;
  familyId: string;
  seq: number;
  branch: string | null;
  origin: DecisionOrigin;
  state: DecisionState;
  scope: DecisionScope;
  decidedBy: Decider;
  inferred: boolean;
  supersedes: string | null;
  supersededBy: string | null;
  /** Ids da mensagem no transcript, sem o caminho do arquivo. */
  message: { uuid: string | null; toolUseId: string | null };
  alternativesCount: number;
  promoted: boolean;
  decidedAt: string;
  updatedAt: string;
  textReleased: boolean;
  /** Só presente quando o texto foi liberado. */
  text?: DecisionHubText;
}

/** Os campos que podem sair para o hub sem a pessoa liberar o texto. */
export const HUB_METADATA_FIELDS = [
  'id', 'sessionId', 'agentId', 'familyId', 'seq', 'branch', 'origin', 'state', 'scope', 'decidedBy',
  'inferred', 'supersedes', 'supersededBy', 'message', 'alternativesCount', 'promoted', 'decidedAt',
  'updatedAt', 'textReleased',
] as const;

export function decisionForHub(d: Decision): DecisionHubRecord {
  const record: DecisionHubRecord = {
    id: d.id,
    sessionId: d.sessionId,
    agentId: d.agentId,
    familyId: d.familyId,
    seq: d.seq,
    branch: d.branch,
    origin: d.origin,
    state: d.state,
    scope: d.scope,
    decidedBy: d.decidedBy,
    inferred: d.inferred,
    supersedes: d.supersedes,
    supersededBy: d.supersededBy,
    message: { uuid: d.message.uuid, toolUseId: d.message.toolUseId },
    alternativesCount: d.alternatives.length,
    promoted: d.promotedTo !== null,
    decidedAt: d.decidedAt,
    updatedAt: d.updatedAt,
    textReleased: d.textReleased,
  };
  if (d.textReleased) {
    record.text = { topic: d.topic, context: d.context, choice: d.choice, alternatives: [...d.alternatives] };
  }
  return record;
}
