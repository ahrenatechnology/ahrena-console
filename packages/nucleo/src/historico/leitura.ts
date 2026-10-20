// A leitura do histórico (#33, C15) pela porta: as sessões encerradas, a página pelas regras de
// modelo.ts e, só para os itens da página, o custo (o mesmo cálculo do painel) e as vizinhas pelo
// /clear (a ligação de sessões das decisões). Sem a porta das decisões, as vizinhas vêm `null`.
//
// A lista de sessões é lida inteira a cada pedido (sem índice por `endedAt` na porta); o custo de
// cada sessão fica guardado enquanto o `updatedAt` dela não muda.

import { parcelasDaSessao, relatorioDeCusto } from '../custo/agregacao.ts';
import { precosVigentes } from '../custo/tabela.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { clearNeighbours } from '../decisoes/registro.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { encerradaDe, paginaDoHistorico, type PaginaDoHistorico, type PedidoDoHistorico, type SessaoEncerrada } from './modelo.ts';

/** A sessão de antes ou de depois do /clear. */
export interface VizinhaDoHistorico {
  id: string;
  titulo: string | null;
}

export interface ItemDoHistorico extends SessaoEncerrada {
  duracaoMs: number;
  /** Estimativa em US$; `null` sem uso gravado ou sem preço para o modelo. */
  custoUsd: number | null;
  /** A sessão de antes do /clear. */
  anterior: VizinhaDoHistorico | null;
  /** A sessão nova depois do /clear. */
  seguinte: VizinhaDoHistorico | null;
}

export type RespostaDoHistorico = PaginaDoHistorico<ItemDoHistorico>;

type PortaDeLeitura = Pick<StoragePort, 'listSessions' | 'getSession' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

export interface OpcoesDoHistorico {
  storage: PortaDeLeitura;
  /** A ligação de sessões (#99); sem ela, `anterior` e `seguinte` vêm `null`. */
  decisoes?: Pick<DecisionPort, 'getSessionLink' | 'listSessionLinks'> | null;
  /** Fuso IANA dos dias. Padrão: o da máquina do núcleo. */
  fusoHorario?: string;
  /** Título de fora do banco (o índice do Desktop); sem ele, ou quando dá `null`, o nome da sessão. */
  tituloDe?: (s: Session) => string | null;
}

export const fusoDaMaquina = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export class HistoricoDeSessoes {
  private readonly storage: PortaDeLeitura;
  private readonly decisoes: OpcoesDoHistorico['decisoes'];
  private readonly fuso: string;
  private readonly tituloDe: (s: Session) => string | null;
  private readonly custos = new Map<string, { updatedAt: string; usd: number | null }>();

  constructor({ storage, decisoes = null, fusoHorario = fusoDaMaquina(), tituloDe = () => null }: OpcoesDoHistorico) {
    this.storage = storage;
    this.decisoes = decisoes;
    this.fuso = fusoHorario;
    this.tituloDe = tituloDe;
  }

  async pagina(pedido: PedidoDoHistorico): Promise<RespostaDoHistorico> {
    const porId = new Map<string, Session>();
    const encerradas: SessaoEncerrada[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        porId.set(s.id, s);
        const e = encerradaDe(s, this.tituloDe(s));
        if (e) encerradas.push(e);
      }
      cursor = page.nextCursor;
    } while (cursor);

    const pagina = paginaDoHistorico(encerradas, pedido, this.fuso);
    const precos = await precosVigentes(this.storage);
    const dias = [];
    for (const d of pagina.dias) {
      const sessoes: ItemDoHistorico[] = [];
      for (const e of d.sessoes) {
        const vizinhas = this.decisoes ? await clearNeighbours(this.decisoes, e.id) : { previous: null, next: null };
        sessoes.push({
          ...e,
          duracaoMs: Math.max(0, Date.parse(e.fim) - Date.parse(e.inicio)),
          custoUsd: await this.custoDe(porId.get(e.id)!, precos),
          anterior: await this.vizinha(vizinhas.previous, porId),
          seguinte: await this.vizinha(vizinhas.next, porId),
        });
      }
      dias.push({ dia: d.dia, sessoes });
    }
    return { dias, proximo: pagina.proximo };
  }

  // O mesmo número do painel (custoDe em api/painel.ts); sem uso, `null` em vez de zero.
  private async custoDe(s: Session, precos: Awaited<ReturnType<typeof precosVigentes>>): Promise<number | null> {
    const guardado = this.custos.get(s.id);
    if (guardado && guardado.updatedAt === s.updatedAt) return guardado.usd;
    const total = relatorioDeCusto(await parcelasDaSessao(this.storage, s.id, precos)).total;
    const usd = total.totalDeTokens === 0 ? null : total.custoUsd;
    this.custos.set(s.id, { updatedAt: s.updatedAt, usd });
    return usd;
  }

  private async vizinha(id: string | null, porId: Map<string, Session>): Promise<VizinhaDoHistorico | null> {
    if (!id) return null;
    const s = porId.get(id) ?? (await this.storage.getSession(id));
    return { id, titulo: s ? (this.tituloDe(s) ?? s.name ?? null) : null };
  }
}
