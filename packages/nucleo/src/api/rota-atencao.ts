// `GET /api/attention`: quem precisa de você, em todas as contas, para a bandeja do app (#87).
//
// A lista é a do `sessions_needing_attention` do MCP (`precisamDeVoce`, src/mcp): as que esperam
// você ou pararam num erro, com a divisão do painel (#140) entre o que trava a sessão ("precisa")
// e o que é só a sua vez ("sua-vez"). A ordem é a do wireframe A2, urgentes primeiro: permissão,
// pergunta, plano e decisão; depois erro; depois a sua vez. Dentro de cada grupo, quem espera há
// mais tempo. A conta sai só com rótulo e cor, nunca o id. Sem texto da conversa.
//
// Para acompanhar, o cliente lê esta rota e depois espera em
// `GET /api/changes?since=<cursor>&wait=25`, a partir do `cursor` daqui; com `reiniciar: true`,
// relê tudo.

import { ESTADOS_VIVOS, type LeituraDaFrota, type Motivo } from '../mcp/frota.ts';
import { precisamDeVoce } from '../mcp/ferramentas/atencao.ts';
import type { MotivoDaAtencao, NivelDeAtencao } from './atencao.ts';

export const ATTENTION_ROUTE = '/api/attention';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DA_ATENCAO = '/api/atencao';

const MOTIVO: Record<Motivo, MotivoDaAtencao> = {
  permission: 'permissao',
  question: 'pergunta',
  plan: 'plano',
  decision: 'decisao',
  error: 'erro',
  turn_ended: 'sua-vez',
  interrupted: 'interrompida',
  first_prompt: 'no-prompt',
};

/** O motivo em poucas palavras, como a bandeja mostra ("Pede permissão · 2 min"). */
export const MOTIVO_CURTO: Record<MotivoDaAtencao, string> = {
  permissao: 'Pede permissão',
  pergunta: 'Fez uma pergunta',
  plano: 'Plano para aprovar',
  decisao: 'Pede uma decisão',
  erro: 'Com erro',
  'sua-vez': 'Sua vez',
  interrompida: 'Interrompida',
  'no-prompt': 'Sessão nova',
};

export interface ItemDaAtencao {
  sessao: string;
  titulo: string;
  projeto: string | null;
  /** Rótulo e cor da conta (decisão 0006); `null` é "Sem conta". */
  conta: { rotulo: string; cor: string } | null;
  nivel: NivelDeAtencao;
  motivo: MotivoDaAtencao;
  motivoCurto: string;
  /** A frase do MCP ("pede permissão para usar Bash"); nunca texto da conversa. */
  motivoLongo: string;
  desde: string;
  minutos: number;
  /** O `local_…` do Claude Desktop, quando ele conhece a sessão (`POST /open/<local_…>`). */
  local: string | null;
}

export interface RespostaDaAtencao {
  geradoEm: string;
  /** Para `GET /api/changes?since=`; `null` quando o núcleo subiu sem o cursor. */
  cursor: string | null;
  /** Todas as da lista: o número da barra de menus. */
  total: number;
  precisam: number;
  suaVez: number;
  /** Vivas trabalhando (ativas, delegando, em segundo plano). */
  ativas: number;
  comErro: number;
  itens: ItemDaAtencao[];
}

export async function montarAtencao(frota: LeituraDaFrota, cursor: string | null): Promise<RespostaDaAtencao> {
  const lista = await precisamDeVoce(frota, null);
  const itens = lista.map((i): ItemDaAtencao => {
    const motivo = MOTIVO[i.reason];
    return {
      sessao: i.sessionId,
      titulo: i.title,
      projeto: i.project,
      conta: i.account ? { rotulo: i.account.label, cor: i.account.color } : null,
      nivel: i.group === 'blocking' ? 'precisa' : 'sua-vez',
      motivo,
      motivoCurto: MOTIVO_CURTO[motivo],
      motivoLongo: i.reasonText,
      desde: i.waitingSince,
      minutos: i.waitingMinutes,
      local: i.open.desktopSessionId,
    };
  });
  // Esperando você (0) antes de parada num erro (1), antes da sua vez (2).
  const grupo = (i: ItemDaAtencao) => (i.nivel === 'sua-vez' ? 2 : i.motivo === 'erro' ? 1 : 0);
  itens.sort((a, b) => grupo(a) - grupo(b) || a.desde.localeCompare(b.desde) || a.sessao.localeCompare(b.sessao));
  let ativas = 0;
  let comErro = 0;
  for (const s of await frota.vivas()) {
    if (s.inbox.estado === 'error') comErro++;
    else if (ESTADOS_VIVOS.includes(s.inbox.estado) && s.inbox.estado !== 'waiting') ativas++;
  }
  const precisam = itens.filter((i) => i.nivel === 'precisa').length;
  return {
    geradoEm: new Date(frota.agora()).toISOString(),
    cursor,
    total: itens.length,
    precisam,
    suaVez: itens.length - precisam,
    ativas,
    comErro,
    itens,
  };
}
