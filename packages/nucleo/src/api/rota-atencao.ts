// `GET /api/attention`: quem precisa de você, em todas as contas, para a bandeja do app (#87).
//
// A lista é a do `sessions_needing_attention` do MCP (`precisamDeVoce`, src/mcp): as que esperam
// você ou pararam num erro, com a divisão do painel (#140) entre o que trava a sessão ("needs")
// e o que é só a sua vez ("your-turn"). A ordem é a do wireframe A2, urgentes primeiro: permissão,
// pergunta, plano e decisão; depois erro; depois a sua vez. Dentro de cada grupo, quem espera há
// mais tempo. A conta sai só com rótulo e cor, nunca o id. Sem texto da conversa.
//
// Para acompanhar, o cliente lê esta rota e depois espera em
// `GET /api/changes?since=<cursor>&wait=25`, a partir do `cursor` daqui; com `reset: true`,
// relê tudo.

import { ESTADOS_VIVOS, type LeituraDaFrota, type Motivo } from '../mcp/frota.ts';
import { precisamDeVoce } from '../mcp/ferramentas/atencao.ts';
import type { PrecisaDeVoce } from './tipos.ts';

export const ATTENTION_ROUTE = '/api/attention';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DA_ATENCAO = '/api/atencao';

/** O nível: o que trava a sessão (`needs`) e o que é só a sua vez; os valores do painel. */
export type AttentionLevel = PrecisaDeVoce['level'];
/** O motivo, com os valores do "precisam de você" do painel. */
export type AttentionReason = PrecisaDeVoce['why'];

const MOTIVO: Record<Motivo, AttentionReason> = {
  permission: 'permission',
  question: 'question',
  plan: 'plan',
  decision: 'decision',
  error: 'error',
  turn_ended: 'your-turn',
  interrupted: 'interrupted',
  first_prompt: 'no-prompt',
};

/** O motivo em poucas palavras, como a bandeja mostra ("Pede permissão · 2 min"). */
export const MOTIVO_CURTO: Record<AttentionReason, string> = {
  permission: 'Pede permissão',
  question: 'Fez uma pergunta',
  plan: 'Plano para aprovar',
  decision: 'Pede uma decisão',
  error: 'Com erro',
  'your-turn': 'Sua vez',
  interrupted: 'Interrompida',
  'no-prompt': 'Sessão nova',
};

export interface ItemDaAtencao {
  session: string;
  title: string;
  project: string | null;
  /** Rótulo e cor da conta (decisão 0006); `null` é "Sem conta". */
  account: { label: string; color: string } | null;
  level: AttentionLevel;
  reason: AttentionReason;
  /** A frase curta em pt-BR (`MOTIVO_CURTO`). */
  shortReason: string;
  /** A frase do MCP ("pede permissão para usar Bash"); nunca texto da conversa. */
  longReason: string;
  since: string;
  minutes: number;
  /** O `local_…` do Claude Desktop, quando ele conhece a sessão (`POST /open/<local_…>`). */
  local: string | null;
}

export interface RespostaDaAtencao {
  generatedAt: string;
  /** Para `GET /api/changes?since=`; `null` quando o núcleo subiu sem o cursor. */
  cursor: string | null;
  /** Todas as da lista: o número da barra de menus. */
  total: number;
  /** As de nível `needs`. */
  needs: number;
  yourTurn: number;
  /** Vivas trabalhando (ativas, delegando, em segundo plano). */
  active: number;
  withError: number;
  items: ItemDaAtencao[];
}

export async function montarAtencao(frota: LeituraDaFrota, cursor: string | null): Promise<RespostaDaAtencao> {
  const lista = await precisamDeVoce(frota, null);
  const items = lista.map((i): ItemDaAtencao => {
    const reason = MOTIVO[i.reason];
    return {
      session: i.sessionId,
      title: i.title,
      project: i.project,
      account: i.account ? { label: i.account.label, color: i.account.color } : null,
      level: i.group === 'blocking' ? 'needs' : 'your-turn',
      reason,
      shortReason: MOTIVO_CURTO[reason],
      longReason: i.reasonText,
      since: i.waitingSince,
      minutes: i.waitingMinutes,
      local: i.open.desktopSessionId,
    };
  });
  // Esperando você (0) antes de parada num erro (1), antes da sua vez (2).
  const grupo = (i: ItemDaAtencao) => (i.level === 'your-turn' ? 2 : i.reason === 'error' ? 1 : 0);
  items.sort((a, b) => grupo(a) - grupo(b) || a.since.localeCompare(b.since) || a.session.localeCompare(b.session));
  let active = 0;
  let withError = 0;
  for (const s of await frota.vivas()) {
    if (s.inbox.estado === 'error') withError++;
    else if (ESTADOS_VIVOS.includes(s.inbox.estado) && s.inbox.estado !== 'waiting') active++;
  }
  const needs = items.filter((i) => i.level === 'needs').length;
  return {
    generatedAt: new Date(frota.agora()).toISOString(),
    cursor,
    total: items.length,
    needs,
    yourTurn: items.length - needs,
    active,
    withError,
    items,
  };
}
