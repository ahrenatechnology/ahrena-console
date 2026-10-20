// Regras das decisões sobre a porta: registrar sem duplicar, numerar na família, substituir pelo
// assunto, confirmar, descartar, reverter, ligar sessões e consultar a cadeia nos dois sentidos.

import { createHash } from 'node:crypto';
import { InvalidModelError, type Metadata } from '../model.ts';
import type { Page } from '../storage-port.ts';
import {
  isCurrent,
  type Decider,
  type Decision,
  type DecisionOrigin,
  type DecisionScope,
  type DecisionState,
  type MessageRef,
  type SessionLink,
  type SessionLinkReason,
} from './modelo.ts';
import type { DecisionPort, ListDecisionsQuery } from './porta.ts';

/** O que uma captura produz. O registro completa id, família, número e cadeia. */
export interface DecisionDraft {
  sourceKey: string;
  sessionId: string;
  agentId?: string | null;
  repo?: string | null;
  branch?: string | null;
  topic: string | null;
  context: string | null;
  choice: string;
  alternatives: string[];
  decidedBy: Decider;
  origin: DecisionOrigin;
  inferred: boolean;
  /** Padrão `vigente`; sugerida sempre entra `a_confirmar`. */
  state?: Extract<DecisionState, 'vigente' | 'a_confirmar'>;
  /** Padrão `familia`: a decisão segue a sessão pelo /clear, pela compactação e para as filhas. */
  scope?: DecisionScope;
  message?: Partial<MessageRef>;
  decidedAt: string;
  metadata?: Metadata;
}

export interface RegisterResult {
  decision: Decision;
  /** `false` quando a decisão já existia (captura repetida, ou pelo hook e depois pelo transcript). */
  created: boolean;
}

export class DecisionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionStateError';
  }
}

export function decisionId(sessionId: string, sourceKey: string): string {
  return `dec:${createHash('sha256').update(`${sessionId}\0${sourceKey}`).digest('hex').slice(0, 32)}`;
}

/** O "D4" da interface. */
export function decisionLabel(d: Pick<Decision, 'seq'>): string {
  return `D${d.seq}`;
}

/** Família da sessão: a da ligação dela, ou ela mesma. */
export async function familyOf(port: DecisionPort, sessionId: string): Promise<string> {
  return (await port.getSessionLink(sessionId))?.familyId ?? sessionId;
}

async function listAll(port: DecisionPort, query: ListDecisionsQuery): Promise<Decision[]> {
  const out: Decision[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Decision> = await port.listDecisions({ ...query, limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Registra a decisão. Se a mesma origem já foi registrada, só completa o que faltava (branch,
 * repositório, agente, link para a mensagem) e não mexe em estado nem cadeia.
 */
export async function registerDecision(port: DecisionPort, draft: DecisionDraft, now: string): Promise<RegisterResult> {
  const id = decisionId(draft.sessionId, draft.sourceKey);
  const existing = await port.getDecision(id);
  if (existing) {
    const merged: Decision = {
      ...existing,
      agentId: existing.agentId ?? draft.agentId ?? null,
      repo: existing.repo ?? draft.repo ?? null,
      branch: existing.branch ?? draft.branch ?? null,
      message: {
        uuid: existing.message.uuid ?? draft.message?.uuid ?? null,
        toolUseId: existing.message.toolUseId ?? draft.message?.toolUseId ?? null,
        transcriptPath: existing.message.transcriptPath ?? draft.message?.transcriptPath ?? null,
      },
    };
    if (sameJson(merged, existing)) return { decision: existing, created: false };
    merged.updatedAt = now;
    await port.putDecision(merged);
    return { decision: merged, created: false };
  }

  const familyId = await familyOf(port, draft.sessionId);
  const suggested = draft.origin === 'sugerida';
  const decision: Decision = {
    id,
    sourceKey: draft.sourceKey,
    sessionId: draft.sessionId,
    agentId: draft.agentId ?? null,
    familyId,
    seq: (await port.lastSeq(familyId)) + 1,
    repo: draft.repo ?? null,
    branch: draft.branch ?? null,
    topic: draft.topic,
    context: draft.context,
    choice: draft.choice,
    alternatives: draft.alternatives,
    decidedBy: suggested ? 'agente' : draft.decidedBy,
    origin: draft.origin,
    inferred: suggested ? true : draft.inferred,
    state: suggested ? 'a_confirmar' : (draft.state ?? 'vigente'),
    scope: draft.scope ?? 'familia',
    supersedes: null,
    supersededBy: null,
    message: {
      uuid: draft.message?.uuid ?? null,
      toolUseId: draft.message?.toolUseId ?? null,
      transcriptPath: draft.message?.transcriptPath ?? null,
    },
    textReleased: false,
    promotedTo: null,
    decidedAt: draft.decidedAt,
    updatedAt: now,
    metadata: draft.metadata ?? {},
  };
  await port.putDecision(decision);
  if (isCurrent(decision) && decision.topic) await rebuildTopic(port, familyId, decision.topic, now);
  return { decision: (await port.getDecision(id)) ?? decision, created: true };
}

/**
 * Refaz a cadeia de um assunto na família: as decisões vigentes e substituídas, em ordem de
 * `decidedAt`, ficam cada uma substituída pela seguinte, e só a última vale. Ordenar a cada vez
 * deixa a cadeia certa mesmo quando a captura chega fora de ordem (hook agora, transcript depois).
 */
async function rebuildTopic(port: DecisionPort, familyId: string, topic: string, now: string): Promise<void> {
  const all = await listAll(port, { familyId, states: ['vigente', 'substituida'] });
  const chain = all
    .filter((d) => d.topic === topic)
    .sort((a, b) => (a.decidedAt === b.decidedAt ? a.seq - b.seq : a.decidedAt < b.decidedAt ? -1 : 1));
  for (const [i, d] of chain.entries()) {
    const prev = chain[i - 1] ?? null;
    const next = chain[i + 1] ?? null;
    const want: Decision = {
      ...d,
      state: next ? 'substituida' : 'vigente',
      supersededBy: next?.id ?? null,
      // Quem já saiu da cadeia (revertida) deixa de ser apontado; o elo passa para o anterior vivo.
      supersedes: prev?.id ?? null,
    };
    if (!sameJson(want, d)) await port.putDecision({ ...want, updatedAt: now });
  }
}

async function requireDecision(port: DecisionPort, id: string): Promise<Decision> {
  const d = await port.getDecision(id);
  if (!d) throw new DecisionStateError(`decisão ${id} não existe`);
  return d;
}

async function setState(port: DecisionPort, d: Decision, state: DecisionState, now: string): Promise<Decision> {
  const next: Decision = { ...d, state, supersededBy: null, updatedAt: now };
  await port.putDecision(next);
  if (d.topic) await rebuildTopic(port, d.familyId, d.topic, now);
  return (await port.getDecision(d.id)) ?? next;
}

/** "Confirmar": a decisão a confirmar passa a valer e entra na cadeia do assunto. */
export async function confirmDecision(port: DecisionPort, id: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  if (d.state !== 'a_confirmar') throw new DecisionStateError(`só decisão a confirmar é confirmada (${d.state})`);
  return setState(port, d, 'vigente', now);
}

/** "Descartar": a decisão a confirmar sai das listas, mas fica no histórico. */
export async function discardDecision(port: DecisionPort, id: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  if (d.state !== 'a_confirmar') throw new DecisionStateError(`só decisão a confirmar é descartada (${d.state})`);
  return setState(port, d, 'descartada', now);
}

/**
 * Reverte uma decisão que vale. Se ela tinha substituído outra, a anterior volta a valer:
 * desfazer a troca é voltar ao que era.
 */
export async function revertDecision(port: DecisionPort, id: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  if (d.state !== 'vigente') throw new DecisionStateError(`só decisão vigente é revertida (${d.state})`);
  return setState(port, { ...d, supersedes: null }, 'revertida', now);
}

/**
 * Volta a decisão para "a confirmar": o "Desfazer" de um Confirmar ou de um Descartar feito sem
 * querer. Ela sai da cadeia do assunto, e a anterior volta a valer.
 */
export async function reopenDecision(port: DecisionPort, id: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  if (d.state !== 'vigente' && d.state !== 'descartada') throw new DecisionStateError(`só decisão vigente ou descartada volta a confirmar (${d.state})`);
  return setState(port, { ...d, supersedes: null }, 'a_confirmar', now);
}

/** Tira das listas o que a captura antiga gravou e não é decisão (pergunta fechada sem resposta, conversa). */
export async function markNoise(port: DecisionPort, id: string, reason: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  return setState(port, { ...d, metadata: { ...d.metadata, ruido: reason } }, 'descartada', now);
}

/** A pessoa liberou o texto da decisão para sair da máquina. */
export async function releaseDecisionText(port: DecisionPort, id: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  if (d.textReleased) return d;
  const next = { ...d, textReleased: true, updatedAt: now };
  await port.putDecision(next);
  return next;
}

/** Marca a decisão como promovida a registro em `docs/decisoes/` (o rascunho é da #103). */
export async function markPromoted(port: DecisionPort, id: string, path: string, now: string): Promise<Decision> {
  const d = await requireDecision(port, id);
  const next = { ...d, promotedTo: path, updatedAt: now };
  await port.putDecision(next);
  return next;
}

/** A cadeia de substituição da decisão, da mais antiga à mais nova, andando nos dois sentidos. */
export async function decisionChain(port: DecisionPort, id: string): Promise<Decision[]> {
  const start = await requireDecision(port, id);
  const before: Decision[] = [];
  const seen = new Set([start.id]);
  for (let cur = start; cur.supersedes && !seen.has(cur.supersedes); ) {
    const prev = await port.getDecision(cur.supersedes);
    if (!prev) break;
    seen.add(prev.id);
    before.unshift(prev);
    cur = prev;
  }
  const after: Decision[] = [];
  for (let cur = start; cur.supersededBy && !seen.has(cur.supersededBy); ) {
    const next = await port.getDecision(cur.supersededBy);
    if (!next) break;
    seen.add(next.id);
    after.push(next);
    cur = next;
  }
  return [...before, start, ...after];
}

export interface LinkSessionInput {
  sessionId: string;
  parentSessionId: string;
  reason: SessionLinkReason;
  linkedAt: string;
}

/**
 * Liga a sessão à anterior (depois de /clear, de uma compactação que trocou de sessão, de um resume
 * ou numa sessão filha). A sessão entra na família da mãe; o que ela já tinha decidido, e as sessões
 * que já estavam ligadas a ela, vão junto, com número novo na família.
 * Quem descobre a mãe é a ligação de sessões do histórico (#33); aqui só se grava.
 */
export async function linkSession(port: DecisionPort, input: LinkSessionInput, now: string): Promise<SessionLink> {
  const familyId = await familyOf(port, input.parentSessionId);
  const current = await port.getSessionLink(input.sessionId);
  if (current) {
    if (current.familyId === familyId) return current;
    throw new InvalidModelError('SessionLink: a sessão já está ligada a outra família');
  }
  // A sessão ainda é raiz: a família dela é ela mesma.
  const oldFamily = input.sessionId;
  if (familyId === oldFamily) throw new InvalidModelError('SessionLink: a mãe já é desta família; ligar faria um ciclo');
  const link: SessionLink = { ...input, familyId };
  await port.putSessionLink(link);

  for (const l of await port.listSessionLinks(oldFamily)) await port.putSessionLink({ ...l, familyId });
  const moved = (await listAll(port, { familyId: oldFamily })).sort((a, b) =>
    a.decidedAt === b.decidedAt ? a.seq - b.seq : a.decidedAt < b.decidedAt ? -1 : 1,
  );
  let seq = await port.lastSeq(familyId);
  const topics = new Set<string>();
  for (const d of moved) {
    await port.putDecision({ ...d, familyId, seq: ++seq, updatedAt: now });
    if (d.topic) topics.add(d.topic);
  }
  for (const t of topics) await rebuildTopic(port, familyId, t, now);
  return link;
}

/**
 * As vizinhas da sessão pelo /clear, para o histórico (#33): a anterior é a mãe quando a ligação é
 * `clear`; a seguinte, a primeira sessão ligada a esta por `clear`. Compactação, resume e filha não contam.
 */
export async function clearNeighbours(port: Pick<DecisionPort, 'getSessionLink' | 'listSessionLinks'>, sessionId: string): Promise<{ previous: string | null; next: string | null }> {
  const link = await port.getSessionLink(sessionId);
  const next = (await port.listSessionLinks(link?.familyId ?? sessionId)).find((l) => l.parentSessionId === sessionId && l.reason === 'clear');
  return { previous: link?.reason === 'clear' ? link.parentSessionId : null, next: next?.sessionId ?? null };
}

/** Nível de consulta das decisões que valem para uma sessão. */
export type DecisionLevel = DecisionScope;

/**
 * As decisões vigentes que valem para a sessão, no nível pedido, mais recentes primeiro:
 * - `sessao`: as da própria sessão;
 * - `familia`: as da sessão e as de escopo família ou branch das outras sessões da família;
 * - `branch`: as da família e as de escopo branch de outras famílias no mesmo branch.
 * É o que a injeção no início da sessão (#100) e a ferramenta MCP (#101) consultam.
 */
export async function currentDecisionsFor(
  port: DecisionPort,
  target: { sessionId: string; branch?: string | null; repo?: string | null },
  level: DecisionLevel,
): Promise<Decision[]> {
  const own = await listAll(port, { sessionId: target.sessionId, states: ['vigente'] });
  if (level === 'sessao') return own;
  const familyId = await familyOf(port, target.sessionId);
  const byId = new Map(own.map((d) => [d.id, d]));
  for (const d of await listAll(port, { familyId, states: ['vigente'] })) {
    if (d.scope !== 'sessao') byId.set(d.id, d);
  }
  if (level === 'branch' && target.branch) {
    for (const d of await listAll(port, { branch: target.branch, repo: target.repo ?? null, states: ['vigente'] })) {
      if (d.scope === 'branch') byId.set(d.id, d);
    }
  }
  return [...byId.values()].sort((a, b) => (a.decidedAt === b.decidedAt ? b.seq - a.seq : a.decidedAt < b.decidedAt ? 1 : -1));
}
