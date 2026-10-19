// Os níveis de atenção (issue #140): o que bloqueia a sessão até a pessoa agir, e o que é só a vez
// dela no bate-bola com o agente. "Precisam de você" conta só o primeiro.
//
// Com confiança, pelos hooks e pelo transcript:
// - permissão: espera por `notification` (Notification `permission_prompt`);
// - pergunta com opções: Notification `elicitation_dialog`, ou um AskUserQuestion sem resposta;
// - plano para aprovar: um ExitPlanMode sem resposta;
// - decisão pedida: o fechamento do turno no Desktop (`wrap_up`) com `ask` ou `blocked`;
// - erro: a sessão parou num erro.
// O resto da espera (o turno acabou, Esc, sessão nova no prompt) é a vez da pessoa: sem destaque.
// Um texto do agente terminado em "?" não conta: é o bate-bola natural.

import type { LeituraDoInbox } from '../estados/leitura.ts';
import type { ResumoDosEventos } from './resumo.ts';

export type NivelDeAtencao = 'precisa' | 'sua-vez';
export type MotivoDaAtencao = 'permissao' | 'pergunta' | 'plano' | 'decisao' | 'erro' | 'sua-vez' | 'interrompida' | 'no-prompt';

export function atencaoDe(inbox: Pick<LeituraDoInbox, 'status' | 'estado' | 'motivo'>, r: Pick<ResumoDosEventos, 'pendentes' | 'pedidoNoFechamento' | 'ultimoPedido'> | null): { nivel: NivelDeAtencao; porque: MotivoDaAtencao } {
  if (inbox.estado === 'error' || inbox.status === 'error') return { nivel: 'precisa', porque: 'erro' };
  const pendente = r?.pendentes.at(-1)?.ferramenta ?? null;
  if (inbox.motivo === 'notification') {
    const pergunta = r?.ultimoPedido?.tipo === 'elicitation_dialog' || pendente === 'AskUserQuestion';
    return { nivel: 'precisa', porque: pergunta ? 'pergunta' : pendente === 'ExitPlanMode' ? 'plano' : 'permissao' };
  }
  if (pendente) return { nivel: 'precisa', porque: pendente === 'ExitPlanMode' ? 'plano' : 'pergunta' };
  if (inbox.motivo === 'stop' && r?.pedidoNoFechamento) return { nivel: 'precisa', porque: 'decisao' };
  if (inbox.motivo === 'interrupted') return { nivel: 'sua-vez', porque: 'interrompida' };
  if (inbox.motivo === 'session_start') return { nivel: 'sua-vez', porque: 'no-prompt' };
  return { nivel: 'sua-vez', porque: 'sua-vez' };
}
