// Session decisions model (issue #99): what was decided, what was discarded, who decided,
// where it came from, the link to the message, the scope and the state, with the replacement chain.
// Dates are ISO 8601 strings in UTC, as in the rest of the model.

import { InvalidModelError, type Metadata } from '../model.ts';

/**
 * De onde veio a decisão:
 * - `pergunta`: resposta a uma pergunta do agente (`AskUserQuestion`);
 * - `plano`: aprovação de um plano (`ExitPlanMode`);
 * - `permissao`: permitir ou negar uma ferramenta;
 * - `correcao`: a pessoa contrariou uma proposta do agente;
 * - `sugerida`: o agente (ou um modelo pequeno) propôs; só vale depois de confirmada.
 */
export const DECISION_ORIGINS = ['pergunta', 'plano', 'permissao', 'correcao', 'sugerida'] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

/**
 * Estado da decisão. `descartada` é o "Descartar" de uma decisão a confirmar: fica no histórico,
 * fora das listas de vigentes, em vez de ser apagada.
 */
export const DECISION_STATES = ['vigente', 'substituida', 'revertida', 'a_confirmar', 'descartada'] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/** Até onde a decisão vale: a sessão, a família (sessões ligadas por /clear, compactação ou filha) ou o branch. */
export const DECISION_SCOPES = ['sessao', 'familia', 'branch'] as const;
export type DecisionScope = (typeof DECISION_SCOPES)[number];

export const DECIDERS = ['usuario', 'agente'] as const;
export type Decider = (typeof DECIDERS)[number];

/** Por que uma sessão foi ligada à anterior. */
export const SESSION_LINK_REASONS = ['clear', 'compact', 'resume', 'filha'] as const;
export type SessionLinkReason = (typeof SESSION_LINK_REASONS)[number];

/** O "ver na conversa": onde está a mensagem que originou a decisão. Nunca o texto dela. */
export interface MessageRef {
  /** `uuid` da linha do transcript. */
  uuid: string | null;
  /** `tool_use_id` da chamada (pergunta, plano, permissão). */
  toolUseId: string | null;
  transcriptPath: string | null;
}

export interface Decision {
  /** Estável: vem da sessão e da chave de origem, então capturar duas vezes não duplica. */
  id: string;
  /** Chave de origem, ex.: `tool:<tool_use_id>:q0`, `prompt:<uuid>`, `inferida:<id>`. */
  sourceKey: string;
  sessionId: string;
  agentId: string | null;
  /** Sessão raiz da família; igual a `sessionId` enquanto a sessão não está ligada a outra. */
  familyId: string;
  /** Número na família: o "D4" da interface. */
  seq: number;
  /** Pasta do repositório (o `cwd` da sessão), para agrupar branches de repositórios diferentes. */
  repo: string | null;
  branch: string | null;
  /** Assunto: decisões vigentes com o mesmo assunto na família se substituem. */
  topic: string | null;
  /** Contexto: a pergunta, o pedido de permissão, a proposta que foi corrigida. */
  context: string | null;
  /** O que foi decidido. */
  choice: string;
  /** O que foi descartado ("não: …"). */
  alternatives: string[];
  decidedBy: Decider;
  origin: DecisionOrigin;
  /** `true` quando a captura deduziu que houve decisão (correção por texto, sugestão). */
  inferred: boolean;
  state: DecisionState;
  scope: DecisionScope;
  /** A decisão que esta substituiu. */
  supersedes: string | null;
  /** A decisão que substituiu esta. */
  supersededBy: string | null;
  message: MessageRef;
  /** A pessoa liberou o texto para sair da máquina (hub). Sem isso, só metadados saem. */
  textReleased: boolean;
  /** Caminho do registro em `docs/decisoes/` quando a decisão foi promovida (#103). */
  promotedTo: string | null;
  decidedAt: string;
  updatedAt: string;
  metadata: Metadata;
}

/** Ligação de uma sessão à anterior: é o que faz a família. */
export interface SessionLink {
  sessionId: string;
  parentSessionId: string;
  /** Raiz da família, copiada da mãe na hora da ligação. */
  familyId: string;
  reason: SessionLinkReason;
  linkedAt: string;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function fail(entity: string, message: string): never {
  throw new InvalidModelError(`${entity}: ${message}`);
}

function requireText(entity: string, field: string, v: unknown): void {
  if (typeof v !== 'string' || v.length === 0) fail(entity, `${field} é obrigatório`);
}

function optionalText(entity: string, field: string, v: unknown): void {
  if (v !== null && (typeof v !== 'string' || v.length === 0)) fail(entity, `${field} precisa ser texto ou null`);
}

function requireTimestamp(entity: string, field: string, v: unknown): void {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) fail(entity, `${field} precisa ser data ISO 8601 em UTC`);
}

function requireOneOf(entity: string, field: string, v: unknown, allowed: readonly string[]): void {
  if (!allowed.includes(v as string)) fail(entity, `${field} inválido: ${JSON.stringify(v)}`);
}

export function validateDecision(d: Decision): void {
  const e = 'Decision';
  requireText(e, 'id', d.id);
  requireText(e, 'sourceKey', d.sourceKey);
  requireText(e, 'sessionId', d.sessionId);
  optionalText(e, 'agentId', d.agentId);
  requireText(e, 'familyId', d.familyId);
  if (!Number.isInteger(d.seq) || d.seq < 1) fail(e, 'seq precisa ser inteiro >= 1');
  optionalText(e, 'repo', d.repo);
  optionalText(e, 'branch', d.branch);
  optionalText(e, 'topic', d.topic);
  optionalText(e, 'context', d.context);
  requireText(e, 'choice', d.choice);
  if (!Array.isArray(d.alternatives) || d.alternatives.some((a) => typeof a !== 'string' || a.length === 0)) {
    fail(e, 'alternatives precisa ser lista de textos');
  }
  requireOneOf(e, 'decidedBy', d.decidedBy, DECIDERS);
  requireOneOf(e, 'origin', d.origin, DECISION_ORIGINS);
  requireOneOf(e, 'state', d.state, DECISION_STATES);
  requireOneOf(e, 'scope', d.scope, DECISION_SCOPES);
  if (typeof d.inferred !== 'boolean') fail(e, 'inferred precisa ser booleano');
  if (typeof d.textReleased !== 'boolean') fail(e, 'textReleased precisa ser booleano');
  optionalText(e, 'supersedes', d.supersedes);
  optionalText(e, 'supersededBy', d.supersededBy);
  if (d.supersedes === d.id || d.supersededBy === d.id) fail(e, 'uma decisão não substitui a si mesma');
  if ((d.state === 'substituida') !== (d.supersededBy !== null)) {
    fail(e, 'substituida e supersededBy andam juntos');
  }
  if (d.origin === 'sugerida' && d.decidedBy !== 'agente') fail(e, 'decisão sugerida é do agente');
  if (!d.message || typeof d.message !== 'object') fail(e, 'message é obrigatório');
  optionalText(e, 'message.uuid', d.message.uuid);
  optionalText(e, 'message.toolUseId', d.message.toolUseId);
  optionalText(e, 'message.transcriptPath', d.message.transcriptPath);
  optionalText(e, 'promotedTo', d.promotedTo);
  requireTimestamp(e, 'decidedAt', d.decidedAt);
  requireTimestamp(e, 'updatedAt', d.updatedAt);
}

export function validateSessionLink(l: SessionLink): void {
  const e = 'SessionLink';
  requireText(e, 'sessionId', l.sessionId);
  requireText(e, 'parentSessionId', l.parentSessionId);
  requireText(e, 'familyId', l.familyId);
  if (l.sessionId === l.parentSessionId) fail(e, 'uma sessão não é mãe de si mesma');
  if (l.familyId === l.sessionId) fail(e, 'a família de uma sessão ligada é a da mãe');
  requireOneOf(e, 'reason', l.reason, SESSION_LINK_REASONS);
  requireTimestamp(e, 'linkedAt', l.linkedAt);
}

/** Decisão que entra nas listas de "vigentes" e na injeção do início da sessão (#100). */
export function isCurrent(d: Pick<Decision, 'state'>): boolean {
  return d.state === 'vigente';
}
