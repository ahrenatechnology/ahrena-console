import { PROVIDERS, legacySessionIdentity, unknownCapabilities, type Provider, type SessionIdentity, type SessionCapabilities } from '../identity.ts';
// The session list of the Sessions screen (C3, #28): `GET /api/sessions`, paginated and with the filters
// on the server.
//
// | Parameter | Values                                                               | Default     |
// | --------- | -------------------------------------------------------------------- | ----------- |
// | `status`  | `all`, `active`, `waiting`, `blocked`, `idle`, `completed`, `error`, `abandoned` | `all` |
// | `search`  | text: title, id or directory, case-insensitive                       | —           |
// | `dir`     | an exact directory (those in `directories` in the response)          | —           |
// | `order`   | `activity`, `duration` or `cost`                                     | `activity`  |
// | `direction` | `desc` or `asc`                                                    | `desc`      |
// | `page`    | from 1, with `perPage` items                                         | 1           |
// | `perPage` | from 1 to `PER_PAGE_MAX`: the screen asks for the rows that fit (#279) | `POR_PAGINA` |
//
// #245: each row carries `attention` (`blocked` or `idle`, with the reason, or `null`; src/api/attention.ts),
// `status=blocked` and `status=idle` filter by it (`blocked` takes the errors too, as "Precisam de você"
// does), and `counts` has one number per `status` value, with the search and the directory applied, for
// the pills. The old route answers neither.
//
// Everything through the port and in-memory caches (decision 0004). A session's cost is redone only when
// its `updatedAt` changes, and only for the page's sessions, unless the order is by cost.
// The account goes out with label and color, never the id (decision 0006). The title goes through
// `safeTitle`, as in the MCP.

import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { send } from '../ingest/hooks/receiver.ts';
import { sessionCostSlices, costReport } from '../cost/aggregation.ts';
import { currentPrices } from '../cost/table.ts';
import { safeTitle } from '../mcp/output.ts';
import { displayStatus, type AwaitingReason, type DisplayStatus, type ModelPricing, type Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Accounts } from './accounts.ts';
import { readSessionAttention, type SessionAttention } from './attention.ts';
import type { DesktopIndex, DesktopSession } from './desktop-index.ts';
import { SessionOpenDescriber, type SessionOpen } from './session-open.ts';
import { ResumosDeSessao } from './summary.ts';

export const SESSIONS_ROUTE = '/api/sessions';
export const POR_PAGINA = 10;
/** #279: the most rows one page may ask for. */
export const PER_PAGE_MAX = 100;

/** `all`, one `DisplayStatus`, or one attention level (#245). */
export const FILTROS_DE_STATUS = ['all', 'active', 'waiting', 'blocked', 'idle', 'completed', 'error', 'abandoned'] as const;
export type FiltroDeStatus = (typeof FILTROS_DE_STATUS)[number];
/** #245: the attention levels as `status` filter values. */
const ATTENTION_FILTERS: readonly FiltroDeStatus[] = ['blocked', 'idle'];
export const ORDENS = ['activity', 'duration', 'cost'] as const;
export type Ordem = (typeof ORDENS)[number];

export interface PedidoDeSessoes {
  provider?: Provider;
  profileId?: string;
  status: FiltroDeStatus;
  busca: string | null;
  dir: string | null;
  ordem: Ordem;
  sentido: 'desc' | 'asc';
  pagina: number;
  perPage: number;
}

export interface LinhaDeSessao {
  identity: SessionIdentity;
  capabilities: SessionCapabilities;
  id: string;
  title: string;
  status: DisplayStatus;
  /** Por que espera, quando espera (`notification`, `interrupted`, `stop`, `session_start`). */
  reason: AwaitingReason | null;
  /** #245: `blocked` ("Precisa de você") or `idle` ("Ociosa"), with the reason; `null` when not waiting on you and not in error. */
  attention: SessionAttention | null;
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
  /** #285: where the row's open icon goes and the command to copy. */
  open: SessionOpen;
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
  /** #245: quantas cada valor de `status` traria, com a busca e o diretório: os números das pílulas. */
  counts: Record<FiltroDeStatus, number>;
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
  const provider = p.get('provider');
  if (provider !== null && !PROVIDERS.includes(provider as Provider)) throw new ErroDoPedido('provider inválido');
  const profileId = p.get('profileId');
  if (profileId !== null && (!profileId || profileId.length > 4096 || /[\u0000-\u001f]/.test(profileId))) throw new ErroDoPedido('profileId inválido');
  const busca = (p.get('search') ?? '').trim();
  if (busca.length > BUSCA_MAXIMA) throw new ErroDoPedido('search grande demais');
  const dir = p.get('dir') || null;
  if (dir !== null && !CAMINHO.test(dir)) throw new ErroDoPedido('dir: um caminho absoluto');
  const pagina = Number(p.get('page') || 1);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 100_000) throw new ErroDoPedido('page: um inteiro a partir de 1');
  const perPage = Number(p.get('perPage') || POR_PAGINA);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > PER_PAGE_MAX) throw new ErroDoPedido(`perPage: um inteiro de 1 a ${PER_PAGE_MAX}`);
  return {
    ...(provider ? { provider: provider as Provider } : {}),
    ...(profileId ? { profileId } : {}),
    status: um('status', FILTROS_DE_STATUS, 'all'),
    busca: busca || null,
    dir,
    ordem: um('order', ORDENS, 'activity'),
    sentido: um('direction', ['desc', 'asc'] as const, 'desc'),
    pagina,
    perPage,
  };
}

export interface OpcoesDaLista {
  storage: StoragePort;
  contas: Accounts;
  desktop?: DesktopIndex | null;
  /** The event summaries the attention of a waiting session reads (#245); its own (256) without them. */
  resumos?: ResumosDeSessao;
  agora?: () => number;
  /** #285: each row's `open`; without it, no session counts as live in a terminal. */
  open?: SessionOpenDescriber;
}

export class ListaDeSessoes {
  private readonly storage: StoragePort;
  private readonly contas: Accounts;
  private readonly desktop: DesktopIndex | null;
  private readonly agora: () => number;
  private readonly resumos: ResumosDeSessao;
  private readonly open: SessionOpenDescriber;
  private readonly custos = new Map<string, { updatedAt: string; usd: number | null }>();

  constructor({ storage, contas, desktop = null, resumos, agora = Date.now, open = new SessionOpenDescriber() }: OpcoesDaLista) {
    this.open = open;
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.resumos = resumos ?? new ResumosDeSessao(storage, { agora, maximo: 256 });
    this.agora = agora;
  }

  async listar(pedido: PedidoDeSessoes): Promise<ListaDeSessoesHttp> {
    await Promise.all([this.contas.refresh(), this.desktop?.refresh(), this.open.refresh()]);
    const agora = this.agora();
    const todas: { s: Session; desktop: DesktopSession | null; titulo: string; status: DisplayStatus; attention: SessionAttention | null }[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        const desktop = this.desktop?.sessionByCli(s.id) ?? null;
        todas.push({ s, desktop, titulo: tituloDe(s, desktop), status: displayStatus(s), attention: await this.attentionOf(s) });
      }
      cursor = page.nextCursor;
    } while (cursor);

    const diretorios = [...new Set(todas.map((t) => t.s.cwd).filter((c): c is string => !!c))].sort();
    const busca = pedido.busca?.toLowerCase() ?? null;
    const searched = todas.filter(
      ({ s, titulo }) =>
        (!pedido.provider || (s.identity?.provider ?? 'claude') === pedido.provider) &&
        (!pedido.profileId || s.identity?.profileId === pedido.profileId) &&
        (!pedido.dir || s.cwd === pedido.dir) &&
        (!busca || titulo.toLowerCase().includes(busca) || s.id.toLowerCase().includes(busca) || (s.cwd ?? '').toLowerCase().includes(busca)),
    );
    const counts = Object.fromEntries(FILTROS_DE_STATUS.map((f) => [f, searched.filter((t) => passesFilter(t, f)).length])) as Record<FiltroDeStatus, number>;
    let filtradas = searched.filter((t) => passesFilter(t, pedido.status));

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
    const { perPage } = pedido;
    const paginas = Math.max(1, Math.ceil(total / perPage));
    const pagina = Math.min(pedido.pagina, paginas);
    const itens: LinhaDeSessao[] = [];
    for (const { s, desktop, titulo, status, attention } of filtradas.slice((pagina - 1) * perPage, pagina * perPage)) {
      const conta = this.contas.ofSession(s, desktop);
      itens.push({
        id: s.id,
        identity: s.identity ?? legacySessionIdentity(s.id),
        capabilities: s.capabilities ?? unknownCapabilities(),
        title: titulo,
        status,
        reason: status === 'waiting' ? s.awaitingReason : null,
        attention,
        lastActivity: s.updatedAt,
        start: s.startedAt,
        running: status === 'active' || status === 'waiting',
        durationMs: duracaoDe(s, agora),
        agents: (await this.storage.listAgents(s.id)).length,
        costUsd: await this.custoDe(s),
        cwd: s.cwd,
        account: conta ? { label: conta.label, color: conta.color } : null,
        open: this.open.describe({ sessionId: s.id, identity: s.identity, cwd: s.cwd ?? desktop?.cwd ?? null, local: desktop?.localId ?? null }),
      });
    }
    return { total, registered: todas.length, page: pagina, perPage, pages: paginas, directories: diretorios, counts, items: itens };
  }

  /** #245: only a waiting or errored session has attention; only a waiting one reads its agents and events. */
  private async attentionOf(s: Session): Promise<SessionAttention | null> {
    const status = displayStatus(s);
    if (status !== 'waiting' && status !== 'error') return null;
    return readSessionAttention(s, status === 'waiting' ? await this.storage.listAgents(s.id) : [], this.resumos);
  }

  private async custoDe(s: Session): Promise<number | null> {
    const c = this.custos.get(s.id);
    if (c && c.updatedAt === s.updatedAt) return c.usd;
    const usd = await custoDaSessao(this.storage, s.id, await currentPrices(this.storage));
    this.custos.set(s.id, { updatedAt: s.updatedAt, usd });
    return usd;
  }
}

/** Whether a row passes a `status` filter: `all`, its displayed status, or its attention level (#245). */
function passesFilter(t: { status: DisplayStatus; attention: SessionAttention | null }, filtro: FiltroDeStatus): boolean {
  if (filtro === 'all') return true;
  if (ATTENTION_FILTERS.includes(filtro)) return t.attention?.level === filtro;
  return t.status === filtro;
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
export function tituloDe(s: Session, d: DesktopSession | null): string {
  return safeTitle(d?.title) ?? safeTitle(s.name) ?? (s.cwd ? safeTitle(basename(s.cwd)) : null) ?? s.id.slice(0, 8);
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
