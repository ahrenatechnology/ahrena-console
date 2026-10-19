// Leitura para o inbox ("quem precisa de mim"): o status exibido mais os dois estados do Podium,
// "delegando" e "esperando processo em background", que não contam como "esperando você".

import { displayStatus, isUrgent, type Agent, type AwaitingReason, type DisplayStatus, type Session } from '../model.ts';
import { FERRAMENTAS_DE_DELEGACAO, lerMemoria, principalDe, subagentesTrabalhando } from './regras.ts';

/**
 * - `delegating`: o principal está parado esperando os subagentes que lançou;
 * - `background`: o turno terminou, mas há processo rodando por trás (`Bash` em background).
 */
export type EstadoDoInbox = DisplayStatus | 'delegating' | 'background';

export interface LeituraDoInbox {
  /** O mesmo de `displayStatus()`. */
  status: DisplayStatus;
  estado: EstadoDoInbox;
  motivo: AwaitingReason | null;
  urgente: boolean;
  /** Entra no inbox: esperando você, ou em erro. Delegando e background não entram. */
  precisaDeVoce: boolean;
  subagentesAtivos: number;
  processosEmBackground: number;
}

export function lerInbox(session: Session, agentes: readonly Agent[]): LeituraDoInbox {
  const estado = { session, agentes: [...agentes] };
  const status = displayStatus(session);
  const subagentes = subagentesTrabalhando(estado).length;
  const memoria = lerMemoria(session);
  const background = Object.keys(memoria.background).length;
  const p = principalDe(estado);
  const emDelegacao = Object.keys(memoria.delegacoes).length > 0 || (p?.currentTool != null && FERRAMENTAS_DE_DELEGACAO.includes(p.currentTool));

  let inbox: EstadoDoInbox = status;
  if (status === 'waiting' && session.awaitingReason === 'stop') {
    // O turno acabou, mas ainda tem trabalho rodando: a vez não é sua de verdade.
    if (subagentes > 0) inbox = 'delegating';
    else if (background > 0) inbox = 'background';
  } else if (status === 'active' && (subagentes > 0 || emDelegacao)) {
    const outraFerramenta = p?.currentTool != null && !FERRAMENTAS_DE_DELEGACAO.includes(p.currentTool);
    if (!outraFerramenta) inbox = 'delegating';
  }

  return {
    status,
    estado: inbox,
    motivo: session.awaitingReason,
    urgente: isUrgent(session),
    precisaDeVoce: inbox === 'waiting' || inbox === 'error',
    subagentesAtivos: subagentes,
    processosEmBackground: background,
  };
}
