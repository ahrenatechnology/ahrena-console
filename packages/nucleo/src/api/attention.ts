// The attention levels (issue #140): what blocks the session until the person acts, and what is only
// their turn in the back-and-forth with the agent. "Precisam de você" counts only the first.
//
// With confidence, from the hooks and the transcript:
// - permission: waiting on `notification` (Notification `permission_prompt`);
// - question with options: Notification `elicitation_dialog`, or an AskUserQuestion with no answer;
// - plan to approve: an ExitPlanMode with no answer;
// - decision asked: the turn's closing in the Desktop (`wrap_up`) with `ask` or `blocked`;
// - error: the session stopped on an error.
// The rest of the waiting (the turn ended, Esc, a new session at the prompt) is the person's turn: no highlight.
// An agent text ending in "?" does not count: it is the natural back-and-forth.

import type { Agent, AwaitingReason, Session, SessionEvent } from '../model.ts';
import { readInbox, type InboxReading } from '../states/inbox.ts';
import { isBlockingNotification } from '../states/rules.ts';
import type { ResumoDosEventos } from './summary.ts';

export type NivelDeAtencao = 'precisa' | 'sua-vez';
export type MotivoDaAtencao = 'permissao' | 'pergunta' | 'plano' | 'decisao' | 'erro' | 'sua-vez' | 'interrompida' | 'no-prompt';

export function atencaoDe(inbox: Pick<InboxReading, 'status' | 'state' | 'reason'>, r: Pick<ResumoDosEventos, 'pendentes' | 'pedidoNoFechamento' | 'ultimoPedido'> | null): { nivel: NivelDeAtencao; porque: MotivoDaAtencao } {
  if (inbox.state === 'error' || inbox.status === 'error') return { nivel: 'precisa', porque: 'erro' };
  const pendente = r?.pendentes.at(-1)?.ferramenta ?? null;
  if (inbox.reason === 'notification') {
    const pergunta = r?.ultimoPedido?.tipo === 'elicitation_dialog' || pendente === 'AskUserQuestion';
    return { nivel: 'precisa', porque: pergunta ? 'pergunta' : pendente === 'ExitPlanMode' ? 'plano' : 'permissao' };
  }
  if (pendente) return { nivel: 'precisa', porque: pendente === 'ExitPlanMode' ? 'plano' : 'pergunta' };
  if (inbox.reason === 'stop' && r?.pedidoNoFechamento) return { nivel: 'precisa', porque: 'decisao' };
  if (inbox.reason === 'interrupted') return { nivel: 'sua-vez', porque: 'interrompida' };
  if (inbox.reason === 'session_start') return { nivel: 'sua-vez', porque: 'no-prompt' };
  return { nivel: 'sua-vez', porque: 'sua-vez' };
}

// ---------------------------------------------------------------------------------------------
// #245: the English attention every /ui route answers, one shape for every screen.
//
// `attention: { level, reason } | null`:
// - `level` `blocked` ("Precisa de você" on screen): the session is stuck until the person acts, with
//   the reason `permission`, `question`, `plan`, `decision` or `error` (the `precisa` level above);
// - `level` `idle` ("Ociosa" on screen): the turn ended and nothing blocks, with the reason
//   `turn_ended`, `interrupted` or `first_prompt` (the `sua-vez` level above);
// - `null`: the session is not waiting on you and not in error (working, delegating, in background,
//   completed, abandoned).
// The reason values are the MCP's (`McpAttentionReason`, src/mcp/fleet.ts), so a screen, the tray and an
// agent name a reason alike. Everything comes from `atencaoDe`: no route re-derives the split.
// ---------------------------------------------------------------------------------------------

export type SessionAttentionLevel = 'blocked' | 'idle';
export const BLOCKED_REASONS = ['permission', 'question', 'plan', 'decision', 'error'] as const;
export const IDLE_REASONS = ['turn_ended', 'interrupted', 'first_prompt'] as const;
export const SESSION_ATTENTION_REASONS = [...BLOCKED_REASONS, ...IDLE_REASONS] as const;
export type SessionAttentionReason = (typeof SESSION_ATTENTION_REASONS)[number];

export interface SessionAttention {
  level: SessionAttentionLevel;
  reason: SessionAttentionReason;
}

const LEVEL_OF: Readonly<Record<NivelDeAtencao, SessionAttentionLevel>> = { precisa: 'blocked', 'sua-vez': 'idle' };
const REASON_OF: Readonly<Record<MotivoDaAtencao, SessionAttentionReason>> = {
  permissao: 'permission',
  pergunta: 'question',
  plano: 'plan',
  decisao: 'decision',
  erro: 'error',
  'sua-vez': 'turn_ended',
  interrompida: 'interrupted',
  'no-prompt': 'first_prompt',
};

/** `atencaoDe` in English. */
export function englishAttention({ nivel, porque }: { nivel: NivelDeAtencao; porque: MotivoDaAtencao }): SessionAttention {
  return { level: LEVEL_OF[nivel], reason: REASON_OF[porque] };
}

/** The attention of a session from its inbox reading and event summary; `null` when it does not need you. */
export function sessionAttention(
  inbox: Pick<InboxReading, 'status' | 'state' | 'reason' | 'needsYou'>,
  r: Pick<ResumoDosEventos, 'pendentes' | 'pedidoNoFechamento' | 'ultimoPedido'> | null,
): SessionAttention | null {
  return inbox.needsYou ? englishAttention(atencaoDe(inbox, r)) : null;
}

/**
 * The attention of a stored session. Only a waiting session reads its event summary (through the
 * caller's cache): an error needs none, and the rest have no attention.
 */
export async function readSessionAttention(
  session: Session,
  agents: readonly Agent[],
  summaries: { ler(sessionId: string, updatedAt: string): Promise<ResumoDosEventos> },
): Promise<SessionAttention | null> {
  const inbox = readInbox(session, agents);
  if (!inbox.needsYou) return null;
  const r = inbox.state === 'error' ? null : await summaries.ler(session.id, session.updatedAt);
  return sessionAttention(inbox, r);
}

/**
 * The attention one event stands for, for the activity feed: the session state that event alone would
 * leave, read by the same `atencaoDe`. A blocking request (the `BLOCKING_NOTIFICATIONS` of the state
 * machine, or a `PermissionRequest`) is blocked; the end of a turn, an idle notification and Esc are idle;
 * an API error is blocked; every other event has none.
 */
export function eventAttention(e: Pick<SessionEvent, 'type' | 'data' | 'summary'>): SessionAttention | null {
  const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
  const waiting = (reason: AwaitingReason) => ({ status: 'waiting' as const, state: 'waiting' as const, reason, needsYou: true });
  const asked = (tipo: string | null) => ({ pendentes: [], pedidoNoFechamento: null, ultimoPedido: { texto: e.summary, tipo, em: '' } });
  switch (e.type) {
    case 'Notification': {
      const tipo = typeof data.notification_type === 'string' ? data.notification_type : null;
      return sessionAttention(waiting(isBlockingNotification(tipo, e.summary, data) ? 'notification' : 'stop'), asked(tipo));
    }
    case 'PermissionRequest':
      return sessionAttention(waiting('notification'), asked('permission_prompt'));
    case 'Stop':
      return sessionAttention(waiting('stop'), null);
    case 'Interrupted':
      return sessionAttention(waiting('interrupted'), null);
    case 'APIError':
    case 'StopFailure':
      return sessionAttention({ status: 'error', state: 'error', reason: null, needsYou: true }, null);
    default:
      return null;
  }
}
