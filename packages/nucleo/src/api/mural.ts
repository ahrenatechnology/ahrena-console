// Monta a resposta de `GET /api/mural` (#34, wireframe C2 "Mural ao vivo"): um card por sessão
// aberta nesta máquina, em todas as contas, com status, modelo, esforço, plano, agentes, contexto e
// custo. O contrato está em api/tipos.ts (`Mural`, `CardDoMural`).
//
// Sessão ABERTA (o critério do mural):
// - não está arquivada no Claude Desktop (a pessoa a tirou da barra lateral); e
// - está `active` (o que inclui esperando, delegando e em background) ou em `error` ainda sem
//   `endedAt` (o vigia da máquina de estados leva a `abandoned` a que fica 180 min parada, e a
//   listagem só busca os erros dentro dessa janela); ou
// - está `completed` (ou em `error` já encerrada) com a última atividade (`updatedAt`) dentro de
//   `recenteMs`, que é o `abandonoMs` do vigia (180 min): o card "Terminou sem erro" do wireframe
//   fica no mural pelo mesmo tempo que uma sessão parada leva para ser dada como abandonada.
// - `abandoned` nunca entra.
//
// Ordem: primeiro as que precisam de você (estado `waiting` ou `error`), as urgentes antes (erro é
// urgente, como no "precisam de você" do painel), e entre elas o pedido mais recente; depois as
// outras, pela atividade mais recente.
//
// Sem ciclo de import: este módulo só importa tipos de painel.ts; servidor.ts monta o mural a partir
// do montador do painel (`muralDoPainel`).
//
// Custo: nada é recalculado por pedido. Cada card sai de `MontadorDoPainel.leituraDaSessao`, que lê o
// custo pelo cache `custos` (no máximo a cada `custoMs` por sessão, ou quando `updatedAt` muda) e os
// eventos pelo resumo incremental (`resumos.ler(id, updatedAt)`). Nenhum pedido varre transcripts
// (decisão 0004). A resposta inteira fica guardada por `cacheMs` (2 s), e pedidos ao mesmo tempo
// esperam a mesma montagem, como o "precisam de você" do painel.
//
// Esforço: o `effort` do índice do Claude Desktop (`local_*.json`, já lido pelo IndiceDoDesktop).
// Sessão só de terminal, ou fora do índice: `null`.

import { basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LIMITES_PADRAO } from '../estados/vigia.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { SessaoDoDesktop } from './indice-desktop.ts';
import type { LeituraDaSessao, MontadorDoPainel } from './painel.ts';
import type { CardDoMural, Mural } from './tipos.ts';

export const ROTA_DO_MURAL = '/api/mural';
/** Quanto tempo a sessão encerrada continua no mural depois da última atividade: o abandono do vigia. */
export const RECENTE_DO_MURAL_MS = LIMITES_PADRAO.abandonoMs;
const PAGINA = 200;

export interface OpcoesDoMural {
  painel: Pick<MontadorDoPainel, 'atualizarFontes' | 'leituraDaSessao' | 'desktopDaSessao'>;
  storage: StoragePort;
  agora?: () => number;
  /** A resposta inteira fica guardada por este tempo. Padrão 2 s. */
  cacheMs?: number;
  /** A encerrada fica no mural até este tempo depois da última atividade. Padrão: `abandonoMs` do vigia (180 min). */
  recenteMs?: number;
}

/** O critério de "aberta" (comentário do módulo), sem a porta: para o teste e para quem quiser. */
export function ehAberta(session: Pick<Session, 'status' | 'endedAt' | 'updatedAt'>, desktop: Pick<SessaoDoDesktop, 'arquivada'> | null, agora: number, recenteMs = RECENTE_DO_MURAL_MS): boolean {
  if (desktop?.arquivada) return false;
  if (session.status === 'abandoned') return false;
  if (session.status === 'active') return true;
  if (session.status === 'error' && !session.endedAt) return true;
  return agora - Date.parse(session.updatedAt) <= recenteMs;
}

const PRECISA = new Set(['waiting', 'error']);
const ATIVA = new Set(['active', 'delegating', 'background']);

export class MontadorDoMural {
  private readonly painel: OpcoesDoMural['painel'];
  private readonly storage: StoragePort;
  private readonly agora: () => number;
  private readonly cacheMs: number;
  private readonly recenteMs: number;
  private cache: { em: number; mural: Mural } | null = null;
  private rodando: Promise<Mural> | null = null;

  constructor({ painel, storage, agora = Date.now, cacheMs = 2_000, recenteMs = RECENTE_DO_MURAL_MS }: OpcoesDoMural) {
    this.painel = painel;
    this.storage = storage;
    this.agora = agora;
    this.cacheMs = cacheMs;
    this.recenteMs = recenteMs;
  }

  async montar(): Promise<Mural> {
    if (this.cache && this.agora() - this.cache.em < this.cacheMs) return this.cache.mural;
    this.rodando ??= this.montarAgora().finally(() => {
      this.rodando = null;
    });
    return this.rodando;
  }

  private async montarAgora(): Promise<Mural> {
    const agora = this.agora();
    await this.painel.atualizarFontes();
    const lidas: { leitura: LeituraDaSessao; updatedAt: string }[] = [];
    for (const session of await this.candidatas(agora)) {
      // O critério antes da leitura: a arquivada não paga custo, plano nem contexto.
      if (!ehAberta(session, this.painel.desktopDaSessao(session.id), agora, this.recenteMs)) continue;
      lidas.push({ leitura: await this.painel.leituraDaSessao(session), updatedAt: session.updatedAt });
    }
    const precisa = (l: LeituraDaSessao) => PRECISA.has(l.inbox.estado);
    lidas.sort((a, b) => {
      const [x, y] = [a.leitura, b.leitura];
      if (precisa(x) !== precisa(y)) return precisa(x) ? -1 : 1;
      if (precisa(x)) return Number(urgenteDe(y)) - Number(urgenteDe(x)) || y.sessao.desde.localeCompare(x.sessao.desde);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const cards = lidas.map(({ leitura }) => cardDe(leitura));
    const mural: Mural = {
      versao: 1,
      geradoEm: new Date(agora).toISOString(),
      contagem: {
        todas: cards.length,
        esperando: cards.filter((c) => PRECISA.has(c.estado)).length,
        ativas: cards.filter((c) => ATIVA.has(c.estado)).length,
      },
      cards,
    };
    this.cache = { em: this.agora(), mural };
    return mural;
  }

  // As `active` inteiras, por índice; das `error` e das `completed`, só as páginas com atividade
  // dentro da janela (a lista vem da mais recente para a mais antiga): o erro encerrado não vira
  // `abandoned` e se acumularia, e o erro vivo mais velho que a janela o vigia já leva a `abandoned`.
  // `abandoned` nem é lida.
  private async candidatas(agora: number): Promise<Session[]> {
    const vistas = new Map<string, Session>();
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ status: ['active'], limit: PAGINA, cursor });
      for (const s of page.items) vistas.set(s.id, s);
      cursor = page.nextCursor;
    } while (cursor);
    const corte = new Date(agora - this.recenteMs).toISOString();
    cursor = null;
    do {
      const page = await this.storage.listSessions({ status: ['error', 'completed'], limit: PAGINA, cursor });
      for (const s of page.items) if (s.updatedAt >= corte) vistas.set(s.id, s);
      const ultima = page.items.at(-1);
      cursor = ultima && ultima.updatedAt >= corte ? page.nextCursor : null;
    } while (cursor);
    return [...vistas.values()];
  }
}

/** Urgente: a espera `notification` ou `interrupted`, e o erro (como o `PrecisaDeVoce` do painel). */
const urgenteDe = (l: LeituraDaSessao) => l.inbox.urgente || l.inbox.estado === 'error';

/** O agente principal conta como um dos agentes da sessão (o wireframe mostra "1" na sessão sem subagentes). */
const principalRodando = (estado: CardDoMural['estado']) => estado === 'active' || estado === 'delegating' || estado === 'background';

function cardDe(leitura: LeituraDaSessao): CardDoMural {
  const { sessao, desktop, branch, custo, plano, contexto, subagentes } = leitura;
  const pasta = sessao.cwd ?? desktop?.cwd ?? null;
  return {
    id: sessao.id,
    titulo: sessao.titulo,
    projeto: pasta ? basename(pasta) : null,
    branch,
    status: sessao.status,
    estado: sessao.estado,
    motivo: sessao.motivo,
    urgente: urgenteDe(leitura),
    desde: sessao.desde,
    atividade: sessao.atividade,
    modelo: sessao.modelo,
    esforco: desktop?.esforco ?? null,
    agentes: { ativos: subagentes.ativos + (principalRodando(sessao.estado) ? 1 : 0), total: subagentes.itens.length + 1 },
    custo: { usd: custo?.usd ?? null, estimativa: true },
    plano: plano ? { feitos: plano.feitos, total: plano.total, atual: plano.atual } : null,
    contexto: contexto ? { pct: contexto.pct, usados: contexto.usados, limite: contexto.limite, rotulo: contexto.rotulo } : null,
  };
}

/** O mural de um montador do painel, com a mesma porta e o mesmo relógio. */
export function muralDoPainel(painel: MontadorDoPainel, opcoes: Pick<OpcoesDoMural, 'cacheMs' | 'recenteMs'> = {}): MontadorDoMural {
  return new MontadorDoMural({ painel, storage: painel.storage, agora: painel.agora, ...opcoes });
}

/** O handler de `GET /api/mural`: a única linha que servidor.ts precisa. */
export async function responderMural(res: ServerResponse, montador: Pick<MontadorDoMural, 'montar'>): Promise<void> {
  send(res, 200, await montador.montar());
}
