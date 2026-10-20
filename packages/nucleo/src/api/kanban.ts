// O Kanban só leitura (#31): `GET /api/kanban`, as sessões ou os agentes em colunas por status,
// paginadas no servidor.
//
// | Parâmetro | Valores                                                  | Padrão    |
// | --------- | -------------------------------------------------------- | --------- |
// | `view`     | `sessions` ou `agents`                                   | `sessions` |
// | `column`   | uma coluna da visão; sem ela, vêm todas, na página 1     | —          |
// | `page`     | a partir de 1, com `POR_PAGINA` itens; só com `column`   | 1          |
//
// The JSON keys and the view and column values are English since #173 phase 2b; the route never had an
// old path, so its body simply turned English. The old parameter names (`visao`, `coluna`, `pagina`)
// and values (`sessoes`, `agentes`, `ativa`, `trabalhando`…) are still read: src/api/legacy-routes.ts.
//
// #245: the waiting column splits in two, by the session's `attention` (src/api/attention.ts):
// Visão sessões: `active`, `blocked` ("Precisam de você", as de erro incluídas), `idle` ("Ociosas"),
// `completed`, `abandoned`. A waiting session with no attention (delegating, in background) is `active`.
// Visão agentes: `working`, `blocked`, `idle`, `done`, `error`; o principal de cada sessão (o
// id é o da sessão) e cada subagente (`<sessão>:<agente>`). O principal herda o status e a atenção da
// sessão: esperando, vai para `blocked` ou `idle`; com erro, para `error`. Cada card traz `attention`
// (o subagente, `null`).
// O subagente que terminou é `completed`, o que falhou é `error`; o que não terminou roda
// (`active`) enquanto a sessão está viva, mesmo quando ela precisa de você ou está ociosa (o principal espera, ele não), e
// segue a sessão quando ela se encerrou (concluída, com erro ou abandonada). Agente de sessão
// abandonada vai para Concluídos com o status `abandoned`: parou, e a pílula diz como.
//
// Tudo pela porta e por caches em memória (decisão 0004): os agentes de uma sessão encerrada são
// relidos só quando o `updatedAt` dela muda; o custo e o último prompt, só para os cards das páginas
// devolvidas. A conta sai com rótulo e cor, nunca o id (decisão 0006). O título passa por
// `safeTitle`, como no MCP. Os itens vêm pela atividade mais recente, desempate pelo id.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { DEFAULT_PRICES } from '../cost/default-prices.ts';
import { currentPrices } from '../cost/table.ts';
import { safeTitle } from '../mcp/output.ts';
import { displayStatus, type Agent, type AwaitingReason, type DisplayStatus, type ModelPricing, type Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Accounts } from './accounts.ts';
import { readSessionAttention, type SessionAttention } from './attention.ts';
import type { DesktopIndex, DesktopSession } from './desktop-index.ts';
import { ResumosDeSessao } from './summary.ts';
import { custoDaSessao, duracaoDe, tituloDe } from './sessions.ts';

export const KANBAN_ROUTE = '/api/kanban';
export const POR_PAGINA = 10;
/** O último prompt e a descrição do subagente, numa linha, até aqui. */
export const TEXTO_MAXIMO = 120;

export const VISOES = ['sessions', 'agents'] as const;
export type Visao = (typeof VISOES)[number];

export const COLUNAS_DAS_SESSOES = [
  { id: 'active', label: 'Ativas' },
  { id: 'blocked', label: 'Precisam de você' },
  { id: 'idle', label: 'Ociosas' },
  { id: 'completed', label: 'Concluídas' },
  { id: 'abandoned', label: 'Abandonadas' },
] as const;

export const COLUNAS_DOS_AGENTES = [
  { id: 'working', label: 'Trabalhando' },
  { id: 'blocked', label: 'Precisam de você' },
  { id: 'idle', label: 'Ociosos' },
  { id: 'done', label: 'Concluídos' },
  { id: 'error', label: 'Erro' },
] as const;

export type ColunaDeSessao = (typeof COLUNAS_DAS_SESSOES)[number]['id'];
export type ColunaDeAgente = (typeof COLUNAS_DOS_AGENTES)[number]['id'];

/** A coluna da visão sessões: pela atenção (#245), senão pelo status. */
export function colunaDaSessao(status: DisplayStatus, attention: SessionAttention | null): ColunaDeSessao {
  if (attention) return attention.level;
  if (status === 'completed' || status === 'abandoned') return status;
  return status === 'error' ? 'blocked' : 'active';
}

/** A coluna da visão agentes para o status e a atenção do card (#245: só o principal tem atenção). */
export function colunaDoAgente(status: DisplayStatus, attention: SessionAttention | null = null): ColunaDeAgente {
  if (status === 'error') return 'error';
  if (status === 'completed' || status === 'abandoned') return 'done';
  return attention ? attention.level : 'working';
}

/** The session card of the Kanban: the Sessions list row (`GET /api/sessions`), with the last prompt and the model. */
export interface CardDeSessao {
  id: string;
  title: string;
  status: DisplayStatus;
  reason: AwaitingReason | null;
  /** #245: `blocked` ou `idle`, com o motivo; `null` quando não espera você nem está com erro. */
  attention: SessionAttention | null;
  /** O último prompt da pessoa, numa linha, até `TEXTO_MAXIMO` caracteres. */
  lastPrompt: string | null;
  lastActivity: string;
  start: string;
  running: boolean;
  durationMs: number;
  agents: number;
  /** Rótulo legível ("Opus 5.5"); o id cru quando a tabela não conhece o modelo. */
  model: string | null;
  costUsd: number | null;
  cwd: string | null;
  account: { label: string; color: string } | null;
}

export interface CardDeAgente {
  /** O id da sessão para o principal; `<sessão>:<agente>` para o subagente. */
  id: string;
  sessionId: string;
  main: boolean;
  /** "Agente principal" ou o tipo do subagente ("Explore"). */
  name: string;
  /** A tarefa do subagente; para o principal, o título da sessão. */
  description: string;
  status: DisplayStatus;
  reason: AwaitingReason | null;
  /** #245: a da sessão, no principal; `null` no subagente. */
  attention: SessionAttention | null;
  model: string | null;
  start: string;
  lastActivity: string;
  running: boolean;
  durationMs: number;
}

export interface Coluna<T = CardDeSessao | CardDeAgente> {
  id: string;
  label: string;
  total: number;
  page: number;
  hasMore: boolean;
  items: T[];
}

export interface KanbanHttp {
  view: Visao;
  perPage: number;
  columns: Coluna[];
}

export interface PedidoDoKanban {
  visao: Visao;
  /** `null`: todas as colunas, na página 1. */
  coluna: string | null;
  pagina: number;
}

export class ErroDoPedidoDoKanban extends Error {}

/** Os parâmetros da URL, validados; parâmetro inválido lança `ErroDoPedidoDoKanban` (400). */
export function pedidoDoKanban(url: URL): PedidoDoKanban {
  const p = url.searchParams;
  const visao = p.get('view') || 'sessions';
  if (!VISOES.includes(visao as Visao)) throw new ErroDoPedidoDoKanban(`view: um de ${VISOES.join(', ')}`);
  const colunas: readonly { id: string }[] = visao === 'sessions' ? COLUNAS_DAS_SESSOES : COLUNAS_DOS_AGENTES;
  const coluna = p.get('column') || null;
  if (coluna !== null && !colunas.some((c) => c.id === coluna)) {
    throw new ErroDoPedidoDoKanban(`column: uma de ${colunas.map((c) => c.id).join(', ')}`);
  }
  const textoDaPagina = p.get('page');
  if (textoDaPagina !== null && coluna === null) throw new ErroDoPedidoDoKanban('page: só com column');
  const pagina = textoDaPagina === null ? 1 : Number(textoDaPagina);
  if (!/^\d+$/.test(textoDaPagina ?? '1') || !Number.isInteger(pagina) || pagina < 1 || pagina > 100_000) {
    throw new ErroDoPedidoDoKanban('page: um inteiro a partir de 1');
  }
  return { visao: visao as Visao, coluna, pagina };
}

/** O rótulo legível do modelo pela tabela de preços ("claude-opus-5-5" → "Opus 5.5"); senão o id cru. */
export function rotuloDoModelo(modelo: string | null | undefined): string | null {
  if (!modelo) return null;
  const id = modelo.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  const nome = DEFAULT_PRICES.find((p) => p.pattern === id)?.name;
  return nome ? nome.replace(/^Claude /, '') : modelo;
}

export interface OpcoesDoKanban {
  storage: StoragePort;
  contas: Accounts;
  desktop?: DesktopIndex | null;
  /** Os resumos de eventos (o último prompt). Sem eles, o Kanban tem os seus (256), para não varrer o cache do painel (64). */
  resumos?: ResumosDeSessao;
  agora?: () => number;
}

interface SessaoLida {
  s: Session;
  status: DisplayStatus;
  attention: SessionAttention | null;
  desktop: DesktopSession | null;
  titulo: string;
}

export class QuadroKanban {
  private readonly storage: StoragePort;
  private readonly contas: Accounts;
  private readonly desktop: DesktopIndex | null;
  private readonly resumos: ResumosDeSessao;
  private readonly agora: () => number;
  private readonly custos = new Map<string, { updatedAt: string; usd: number | null }>();
  private readonly agentes = new Map<string, { updatedAt: string; agentes: Agent[] }>();

  constructor({ storage, contas, desktop = null, resumos, agora = Date.now }: OpcoesDoKanban) {
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.resumos = resumos ?? new ResumosDeSessao(storage, { agora, maximo: 256 });
    this.agora = agora;
  }

  /**
   * O status do card de um subagente: terminou (`completed`) ou falhou (`error`) pelo que o núcleo
   * gravou; senão roda enquanto a sessão está viva (ativa ou esperando) e segue a sessão encerrada.
   */
  static statusDoSubagente(a: Pick<Agent, 'status'>, sessao: Pick<Session, 'status' | 'awaitingInputSince'>): DisplayStatus {
    if (a.status === 'completed') return 'completed';
    if (a.status === 'error') return 'error';
    const daSessao = displayStatus(sessao);
    return daSessao === 'waiting' ? 'active' : daSessao;
  }

  async montar(pedido: PedidoDoKanban): Promise<KanbanHttp> {
    await Promise.all([this.contas.refresh(), this.desktop?.refresh()]);
    const sessoes = await this.lerSessoes();
    const colunas =
      pedido.visao === 'sessions' ? await this.colunasDeSessoes(sessoes, pedido, await currentPrices(this.storage)) : await this.colunasDeAgentes(sessoes, pedido);
    return { view: pedido.visao, perPage: POR_PAGINA, columns: colunas };
  }

  private async lerSessoes(): Promise<SessaoLida[]> {
    const todas: SessaoLida[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        const desktop = this.desktop?.sessionByCli(s.id) ?? null;
        const status = displayStatus(s);
        // #245: only a waiting or errored session has attention; only a waiting one reads its events.
        const attention = status === 'waiting' || status === 'error' ? await readSessionAttention(s, await this.agentesDe(s), this.resumos) : null;
        todas.push({ s, status, attention, desktop, titulo: tituloDe(s, desktop) });
      }
      cursor = page.nextCursor;
    } while (cursor);
    // Sessão que saiu do banco sai dos caches também.
    const ids = new Set(todas.map((x) => x.s.id));
    for (const cache of [this.custos, this.agentes]) for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    return todas;
  }

  private async colunasDeSessoes(sessoes: SessaoLida[], pedido: PedidoDoKanban, precos: ModelPricing[]): Promise<Coluna<CardDeSessao>[]> {
    const ordenadas = [...sessoes].sort((a, b) => maisRecente(a.s.updatedAt, a.s.id, b.s.updatedAt, b.s.id));
    const pedidas = COLUNAS_DAS_SESSOES.filter((c) => pedido.coluna === null || c.id === pedido.coluna);
    const agora = this.agora();
    const colunas: Coluna<CardDeSessao>[] = [];
    for (const c of pedidas) {
      const daColuna = ordenadas.filter((x) => colunaDaSessao(x.status, x.attention) === c.id);
      const { pagina, temMais, fatia } = paginar(daColuna, pedido.pagina);
      const itens: CardDeSessao[] = [];
      for (const x of fatia) itens.push(await this.cardDeSessao(x, agora, precos));
      colunas.push({ id: c.id, label: c.label, total: daColuna.length, page: pagina, hasMore: temMais, items: itens });
    }
    return colunas;
  }

  private async cardDeSessao({ s, status, attention, desktop, titulo }: SessaoLida, agora: number, precos: ModelPricing[]): Promise<CardDeSessao> {
    const conta = this.contas.ofSession(s, desktop);
    const resumo = await this.resumos.ler(s.id, s.updatedAt);
    return {
      id: s.id,
      title: titulo,
      status,
      reason: status === 'waiting' ? s.awaitingReason : null,
      attention,
      lastPrompt: umaLinha(resumo.ultimoPrompt, TEXTO_MAXIMO),
      lastActivity: s.updatedAt,
      start: s.startedAt,
      running: status === 'active' || status === 'waiting',
      durationMs: duracaoDe(s, agora),
      agents: (await this.agentesDe(s)).length,
      model: rotuloDoModelo(s.model),
      costUsd: await this.custoDe(s, precos),
      cwd: s.cwd,
      account: conta ? { label: conta.label, color: conta.color } : null,
    };
  }

  private async colunasDeAgentes(sessoes: SessaoLida[], pedido: PedidoDoKanban): Promise<Coluna<CardDeAgente>[]> {
    const agora = this.agora();
    const cards: CardDeAgente[] = [];
    for (const x of sessoes) {
      cards.push(principalDe(x, agora));
      for (const a of await this.agentesDe(x.s)) if (a.type === 'subagent') cards.push(subagenteDe(a, x.s, agora));
    }
    cards.sort((a, b) => maisRecente(a.lastActivity, a.id, b.lastActivity, b.id));
    const pedidas = COLUNAS_DOS_AGENTES.filter((c) => pedido.coluna === null || c.id === pedido.coluna);
    return pedidas.map((c) => {
      const daColuna = cards.filter((a) => colunaDoAgente(a.status, a.attention) === c.id);
      const { pagina, temMais, fatia } = paginar(daColuna, pedido.pagina);
      return { id: c.id, label: c.label, total: daColuna.length, page: pagina, hasMore: temMais, items: fatia };
    });
  }

  /** Os agentes da sessão; de uma sessão encerrada, guardados até o `updatedAt` dela mudar. */
  private async agentesDe(s: Session): Promise<Agent[]> {
    const viva = s.status === 'active' || s.awaitingInputSince !== null;
    const c = this.agentes.get(s.id);
    if (!viva && c && c.updatedAt === s.updatedAt) return c.agentes;
    const agentes = await this.storage.listAgents(s.id);
    if (viva) this.agentes.delete(s.id);
    else this.agentes.set(s.id, { updatedAt: s.updatedAt, agentes });
    return agentes;
  }

  private async custoDe(s: Session, precos: ModelPricing[]): Promise<number | null> {
    const c = this.custos.get(s.id);
    if (c && c.updatedAt === s.updatedAt) return c.usd;
    const usd = await custoDaSessao(this.storage, s.id, precos);
    this.custos.set(s.id, { updatedAt: s.updatedAt, usd });
    return usd;
  }
}

function principalDe({ s, status, attention, titulo }: SessaoLida, agora: number): CardDeAgente {
  return {
    id: s.id,
    sessionId: s.id,
    main: true,
    name: 'Agente principal',
    description: titulo,
    status,
    reason: status === 'waiting' ? s.awaitingReason : null,
    attention,
    model: rotuloDoModelo(s.model),
    start: s.startedAt,
    lastActivity: s.updatedAt,
    running: status === 'active' || status === 'waiting',
    durationMs: duracaoDe(s, agora),
  };
}

function subagenteDe(a: Agent, s: Session, agora: number): CardDeAgente {
  const status = QuadroKanban.statusDoSubagente(a, s);
  const rodando = status === 'active';
  const fim = rodando ? agora : Date.parse(a.endedAt ?? a.updatedAt);
  const modelo = typeof a.metadata?.model === 'string' ? a.metadata.model : null;
  return {
    id: a.id.startsWith(`${s.id}:`) ? a.id : `${s.id}:${a.id}`,
    sessionId: s.id,
    main: false,
    name: safeTitle(a.subagentType) ?? safeTitle(a.name) ?? 'Subagente',
    description: umaLinha(a.task, TEXTO_MAXIMO) ?? '',
    status,
    reason: null,
    attention: null,
    model: rotuloDoModelo(modelo),
    start: a.startedAt,
    lastActivity: a.updatedAt,
    running: rodando,
    durationMs: Math.max(0, fim - Date.parse(a.startedAt)),
  };
}

/** Mais recente primeiro; empate pelo id, em ordem crescente. */
function maisRecente(da: string, ia: string, db: string, ib: string): number {
  if (da !== db) return da < db ? 1 : -1;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function paginar<T>(itens: T[], pagina: number): { pagina: number; temMais: boolean; fatia: T[] } {
  const inicio = (pagina - 1) * POR_PAGINA;
  return { pagina, temMais: itens.length > inicio + POR_PAGINA, fatia: itens.slice(inicio, inicio + POR_PAGINA) };
}

/** Numa linha: sem controle nem quebra, espaços colapsados, cortado com "…". */
function umaLinha(t: string | null | undefined, maximo: number): string | null {
  if (!t) return null;
  // eslint-disable-next-line no-control-regex
  const limpo = t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return limpo.length > maximo ? `${limpo.slice(0, maximo - 1)}…` : limpo;
}

/** `GET /api/kanban`: 400 com a explicação quando um parâmetro não vale. */
export async function responderKanban(res: ServerResponse, url: URL, quadro: QuadroKanban): Promise<void> {
  let pedido: PedidoDoKanban;
  try {
    pedido = pedidoDoKanban(url);
  } catch (e) {
    if (e instanceof ErroDoPedidoDoKanban) return send(res, 400, { error: e.message });
    throw e;
  }
  send(res, 200, await quadro.montar(pedido));
}
