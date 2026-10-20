// Decisions port. It sits next to the storage port, with the same rules so it fits the hub's
// DynamoDB without changing its callers: everything async, "put" of the whole record, queries by
// access pattern (session, family, branch) and pagination by opaque cursor.

import type { Page } from '../storage-port.ts';
import type { Decision, DecisionState, SessionLink } from './model.ts';

/** Um dos três escopos de consulta. Branch sem `repo` junta o mesmo branch de todos os repositórios. */
export type DecisionFilter =
  | { sessionId: string }
  | { familyId: string }
  | { branch: string; repo?: string | null };

export type ListDecisionsQuery = DecisionFilter & {
  /** Filtra pelo estado; omitido, vêm todos. */
  states?: readonly DecisionState[];
  /** Padrão 50, máximo 500. */
  limit?: number;
  cursor?: string | null;
};

export interface DecisionPort {
  /** Grava a decisão inteira (cria ou substitui). Valida antes. */
  putDecision(decision: Decision): Promise<void>;
  getDecision(id: string): Promise<Decision | null>;
  /** Mais recentes primeiro, por `decidedAt`. */
  listDecisions(query: ListDecisionsQuery): Promise<Page<Decision>>;
  /** Maior `seq` já usado na família; 0 quando não há nenhuma. */
  lastSeq(familyId: string): Promise<number>;

  /** Grava a ligação da sessão (cria ou substitui). */
  putSessionLink(link: SessionLink): Promise<void>;
  getSessionLink(sessionId: string): Promise<SessionLink | null>;
  /** Sessões ligadas à família, na ordem da ligação. A raiz não aparece: ela não tem ligação. */
  listSessionLinks(familyId: string): Promise<SessionLink[]>;
}
