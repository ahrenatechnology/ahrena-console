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

import type { InboxReading } from '../states/inbox.ts';
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
