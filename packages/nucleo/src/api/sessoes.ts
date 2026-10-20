// A lista de sessões da tela Sessões (C3, #28): `GET /api/sessions`, paginada e com os filtros no
// servidor.
//
// | Parâmetro | Valores                                                              | Padrão      |
// | --------- | -------------------------------------------------------------------- | ----------- |
// | `status`  | `all`, `active`, `waiting`, `completed`, `error`, `abandoned`        | `all`       |
// | `search`  | texto: título, id ou diretório, sem diferença de caixa                | —           |
// | `dir`     | um diretório exato (os de `directories` na resposta)                  | —           |
// | `order`   | `activity`, `duration` ou `cost`                                      | `activity`  |
// | `direction` | `desc` ou `asc`                                                     | `desc`      |
// | `page`    | a partir de 1, com `POR_PAGINA` itens                                 | 1           |
//
// The old parameter names, values (`status=esperando`, `order=custo`) and route are aliases, and the
// old route answers the body in its old keys: src/api/legacy-routes.ts (phase 2b of #173).
//
// Tudo pela porta e por caches em memória (decisão 0004). O custo de uma sessão é refeito só quando
// o `updatedAt` dela muda, e só para as sessões da página, a não ser que a ordem seja por custo.
// A conta sai com rótulo e cor, nunca o id (decisão 0006). O título passa por `safeTitle`, como
// no MCP.

import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { send } from '../ingest/hooks/receiver.ts';
import { sessionCostSlices, costReport } from '../cost/aggregation.ts';
import { currentPrices } from '../cost/table.ts';
import { safeTitle } from '../mcp/output.ts';
import { displayStatus, type AwaitingReason, type DisplayStatus, type ModelPricing, type Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Contas } from './contas.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from './indice-desktop.ts';

export const SESSIONS_ROUTE = '/api/sessions';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DAS_SESSOES = '/api/sessoes';
export const POR_PAGINA = 10;

/** `all`, or one `DisplayStatus`. */
export const FILTROS_DE_STATUS = ['all', 'active', 'waiting', 'completed', 'error', 'abandoned'] as const;
export type FiltroDeStatus = (typeof FILTROS_DE_STATUS)[number];
export const ORDENS = ['activity', 'duration', 'cost'] as const;
export type Ordem = (typeof ORDENS)[number];

export interface PedidoDeSessoes {
  status: FiltroDeStatus;
  busca: string | null;
  dir: string | null;
  ordem: Ordem;
  sentido: 'desc' | 'asc';
  pagina: number;
}

export interface LinhaDeSessao {
  id: string;
  title: string;
  status: DisplayStatus;
  /** Por que espera, quando espera (`notification`, `interrupted`, `stop`, `session_start`). */
  reason: AwaitingReason | null;
  lastActivity: string;
  start: string;
  /** Ativa ou esperando: a duração ainda corre. */
  running: boolean;
  durationMs: number;
  agents: number;
  /** Estimativa; `null` quando há uso e nada dele tem preço. */
  costUsd: number | null;
  cwd: string | null;
  account: { label: string; color: string } | null;
}

export interface ListaDeSessoesHttp {
  total: number;
  /** Todas as sessões registradas, sem filtro: o "12 sessões registradas" do cabeçalho. */
  registered: number;
  page: number;
  perPage: number;
  pages: number;
  /** Os diretórios do filtro, em ordem alfabética. */
  directories: string[];
  items: LinhaDeSessao[];
}

export class ErroDoPedido extends Error {}

const BUSCA_MAXIMA = 200;
const CAMINHO = /^\/[^\0\n]{0,1023}$/;

/** Os parâmetros da URL, validados; parâmetro inválido lança `ErroDoPedido` (400). */
export function pedidoDeSessoes(url: URL): PedidoDeSessoes {
  const p = url.searchParams;
  // The error cites the parameter by its new name; the old route translates it back.
  const um = <T extends string>(nome: string, validos: readonly T[], padrao: T): T => {
    const v = p.get(nome) || padrao;
    if (!validos.includes(v as T)) throw new ErroDoPedido(`${nome}: um de ${validos.join(', ')}`);
    return v as T;
  };
  const busca = (p.get('search') ?? '').trim();
  if (busca.length > BUSCA_MAXIMA) throw new ErroDoPedido('search grande demais');
  const dir = p.get('dir') || null;
  if (dir !== null && !CAMINHO.test(dir)) throw new ErroDoPedido('dir: um caminho absoluto');
  const pagina = Number(p.get('page') || 1);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 100_000) throw new ErroDoPedido('page: um inteiro a partir de 1');
  return {
    status: um('status', FILTROS_DE_STATUS, 'all'),
    busca: busca || null,
    dir,
    ordem: um('order', ORDENS, 'activity'),
    sentido: um('direction', ['desc', 'asc'] as const, 'desc'),
    pagina,
  };
}

export interface OpcoesDaLista {
  storage: StoragePort;
  contas: Contas;
  desktop?: IndiceDoDesktop | null;
  agora?: () => number;
}

export class ListaDeSessoes {
  private readonly storage: StoragePort;
  private readonly contas: Contas;
  private readonly desktop: IndiceDoDesktop | null;
  private readonly agora: () => number;
  private readonly custos = new Map<string, { updatedAt: string; usd: number | null }>();

  constructor({ storage, contas, desktop = null, agora = Date.now }: OpcoesDaLista) {
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.agora = agora;
  }

  async listar(pedido: PedidoDeSessoes): Promise<ListaDeSessoesHttp> {
    await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);
    const agora = this.agora();
    const todas: { s: Session; desktop: SessaoDoDesktop | null; titulo: string }[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        const desktop = this.desktop?.sessaoPorCli(s.id) ?? null;
        todas.push({ s, desktop, titulo: tituloDe(s, desktop) });
      }
      cursor = page.nextCursor;
    } while (cursor);

    const diretorios = [...new Set(todas.map((t) => t.s.cwd).filter((c): c is string => !!c))].sort();
    const busca = pedido.busca?.toLowerCase() ?? null;
    const alvo = pedido.status === 'all' ? null : pedido.status;
    let filtradas = todas.filter(
      ({ s, titulo }) =>
        (!alvo || displayStatus(s) === alvo) &&
        (!pedido.dir || s.cwd === pedido.dir) &&
        (!busca || titulo.toLowerCase().includes(busca) || s.id.toLowerCase().includes(busca) || (s.cwd ?? '').toLowerCase().includes(busca)),
    );

    // A porta já devolve por atividade, mais recentes primeiro; as outras ordens desempatam por ela.
    const sinal = pedido.sentido === 'desc' ? 1 : -1;
    if (pedido.ordem === 'duration') {
      const dur = new Map(filtradas.map(({ s }) => [s.id, duracaoDe(s, agora)]));
      filtradas = [...filtradas].sort((a, b) => sinal * (dur.get(b.s.id)! - dur.get(a.s.id)!));
    } else if (pedido.ordem === 'cost') {
      const custo = new Map<string, number>();
      for (const { s } of filtradas) custo.set(s.id, (await this.custoDe(s)) ?? -1);
      filtradas = [...filtradas].sort((a, b) => sinal * (custo.get(b.s.id)! - custo.get(a.s.id)!));
    } else if (pedido.sentido === 'asc') filtradas = [...filtradas].reverse();

    const total = filtradas.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    const pagina = Math.min(pedido.pagina, paginas);
    const itens: LinhaDeSessao[] = [];
    for (const { s, desktop, titulo } of filtradas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA)) {
      const status = displayStatus(s);
      const conta = this.contas.daSessao(s, desktop);
      itens.push({
        id: s.id,
        title: titulo,
        status,
        reason: status === 'waiting' ? s.awaitingReason : null,
        lastActivity: s.updatedAt,
        start: s.startedAt,
        running: status === 'active' || status === 'waiting',
        durationMs: duracaoDe(s, agora),
        agents: (await this.storage.listAgents(s.id)).length,
        costUsd: await this.custoDe(s),
        cwd: s.cwd,
        account: conta ? { label: conta.label, color: conta.color } : null,
      });
    }
    return { total, registered: todas.length, page: pagina, perPage: POR_PAGINA, pages: paginas, directories: diretorios, items: itens };
  }

  private async custoDe(s: Session): Promise<number | null> {
    const c = this.custos.get(s.id);
    if (c && c.updatedAt === s.updatedAt) return c.usd;
    const usd = await custoDaSessao(this.storage, s.id, await currentPrices(this.storage));
    this.custos.set(s.id, { updatedAt: s.updatedAt, usd });
    return usd;
  }
}

/** O custo da sessão em US$: `null` quando há tokens de modelo sem preço; 0 sem tokens. O Kanban (#31) também usa. */
export async function custoDaSessao(storage: StoragePort, sessionId: string, precos: ModelPricing[]): Promise<number | null> {
  const { total } = costReport(await sessionCostSlices(storage, sessionId, precos));
  return total.costUsd ?? (total.totalTokens === 0 ? 0 : null);
}

/** Do início até agora (ativa) ou até o fim. O Kanban (#31) também usa. */
export function duracaoDe(s: Session, agora: number): number {
  const fim = s.status === 'active' ? agora : Date.parse(s.endedAt ?? s.updatedAt);
  return Math.max(0, fim - Date.parse(s.startedAt));
}

/** O título: o do Desktop, o nome da sessão, a pasta ou o começo do id. O Kanban (#31) também usa. */
export function tituloDe(s: Session, d: SessaoDoDesktop | null): string {
  return safeTitle(d?.titulo) ?? safeTitle(s.name) ?? (s.cwd ? safeTitle(basename(s.cwd)) : null) ?? s.id.slice(0, 8);
}

/** `GET /api/sessions`: 400 com a explicação quando um parâmetro não vale. */
export async function responderSessoes(res: ServerResponse, url: URL, lista: ListaDeSessoes): Promise<void> {
  let pedido: PedidoDeSessoes;
  try {
    pedido = pedidoDeSessoes(url);
  } catch (e) {
    if (e instanceof ErroDoPedido) return send(res, 400, { error: e.message });
    throw e;
  }
  send(res, 200, await lista.listar(pedido));
}
