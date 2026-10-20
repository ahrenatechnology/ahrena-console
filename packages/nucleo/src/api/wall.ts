// Builds the response of `GET /api/wall` (#34, wireframe C2 "Mural ao vivo"): one card per session
// open on this machine, across all accounts, with status, model, effort, plan, agents, context and
// cost. The contract is in api/types.ts (`Wall`, `WallCard`).
//
// An OPEN session (the wall's criterion):
// - is not archived in the Claude Desktop (the person removed it from the sidebar); and
// - is `active` (which includes waiting, delegating and in background) or in `error` still without
//   `endedAt` (the state machine's watcher moves the one idle for 180 min to `abandoned`, and the
//   listing only fetches the errors inside that window); or
// - is `completed` (or in an already ended `error`) with its last activity (`updatedAt`) within
//   `recenteMs`, which is the watcher's `abandonMs` (180 min): the wireframe's "Terminou sem erro"
//   card stays on the wall as long as an idle session takes to be considered abandoned.
// - `abandoned` never comes in.
//
// Order: first the ones that need you (state `waiting` or `error`), the urgent ones first (an error is
// urgent, as in the panel's "precisam de você"), and among them the most recent request; then the
// others, by the most recent activity.
//
// No import cycle: this module only imports types from panel.ts; server.ts builds the wall from
// the panel builder (`muralDoPainel`).
//
// Cost: nothing is recomputed per request. Each card comes from `MontadorDoPainel.leituraDaSessao`, which
// reads the cost through the `custos` cache (at most every `custoMs` per session, or when `updatedAt`
// changes) and the events through the incremental summary (`resumos.ler(id, updatedAt)`). No request
// scans transcripts (decision 0004). The whole response is kept for `cacheMs` (2 s), and concurrent
// requests wait for the same build, like the panel's "precisam de você".
//
// Effort: the `effort` of the Claude Desktop index (`local_*.json`, already read by DesktopIndex) and,
// without it, `metadata.esforco` (the simulator writes it; the terminal ingestion does not know the effort yet).
// A terminal-only session: `null`.
//
// Branch: the Desktop's or `metadata.branch`; without them, what the work-by-branch already knows and,
// last, just `git branch --show-current` in the folder, cached for 60 s, no GitHub (`branchDaPasta`).

import { basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { DEFAULT_LIMITS } from '../states/watcher.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DesktopSession } from './desktop-index.ts';
import type { LeituraDaSessao, MontadorDoPainel } from './panel.ts';
import type { WallCard, Wall } from './types.ts';

export const WALL_ROUTE = '/api/wall';
/** Quanto tempo a sessão encerrada continua no mural depois da última atividade: o abandono do vigia. */
export const RECENTE_DO_MURAL_MS = DEFAULT_LIMITS.abandonMs;
const PAGINA = 200;

export interface OpcoesDoMural {
  painel: Pick<MontadorDoPainel, 'atualizarFontes' | 'leituraDaSessao' | 'desktopDaSessao'>;
  storage: StoragePort;
  agora?: () => number;
  /** A resposta inteira fica guardada por este tempo. Padrão 2 s. */
  cacheMs?: number;
  /** An ended session stays on the wall this long after its last activity. Default: the watcher's `abandonMs` (180 min). */
  recenteMs?: number;
}

/** O critério de "aberta" (comentário do módulo), sem a porta: para o teste e para quem quiser. */
export function ehAberta(session: Pick<Session, 'status' | 'endedAt' | 'updatedAt'>, desktop: Pick<DesktopSession, 'archived'> | null, agora: number, recenteMs = RECENTE_DO_MURAL_MS): boolean {
  if (desktop?.archived) return false;
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
  private cache: { em: number; mural: Wall } | null = null;
  private rodando: Promise<Wall> | null = null;

  constructor({ painel, storage, agora = Date.now, cacheMs = 2_000, recenteMs = RECENTE_DO_MURAL_MS }: OpcoesDoMural) {
    this.painel = painel;
    this.storage = storage;
    this.agora = agora;
    this.cacheMs = cacheMs;
    this.recenteMs = recenteMs;
  }

  async montar(): Promise<Wall> {
    if (this.cache && this.agora() - this.cache.em < this.cacheMs) return this.cache.mural;
    this.rodando ??= this.montarAgora().finally(() => {
      this.rodando = null;
    });
    return this.rodando;
  }

  private async montarAgora(): Promise<Wall> {
    const agora = this.agora();
    await this.painel.atualizarFontes();
    const lidas: { leitura: LeituraDaSessao; updatedAt: string }[] = [];
    for (const session of await this.candidatas(agora)) {
      // O critério antes da leitura: a arquivada não paga custo, plano nem contexto.
      if (!ehAberta(session, this.painel.desktopDaSessao(session.id), agora, this.recenteMs)) continue;
      lidas.push({ leitura: await this.painel.leituraDaSessao(session), updatedAt: session.updatedAt });
    }
    const precisa = (l: LeituraDaSessao) => PRECISA.has(l.inbox.state);
    lidas.sort((a, b) => {
      const [x, y] = [a.leitura, b.leitura];
      if (precisa(x) !== precisa(y)) return precisa(x) ? -1 : 1;
      if (precisa(x)) return Number(urgenteDe(y)) - Number(urgenteDe(x)) || y.sessao.since.localeCompare(x.sessao.since);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const cards = lidas.map(({ leitura }) => cardDe(leitura));
    const mural: Wall = {
      version: 1,
      generatedAt: new Date(agora).toISOString(),
      count: {
        all: cards.length,
        waiting: cards.filter((c) => PRECISA.has(c.state)).length,
        active: cards.filter((c) => ATIVA.has(c.state)).length,
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

/** Urgente: a espera `notification` ou `interrupted`, e o erro (como o `NeedsYouItem` do painel). */
const urgenteDe = (l: LeituraDaSessao) => l.inbox.urgent || l.inbox.state === 'error';

/** O agente principal conta como um dos agentes da sessão (o wireframe mostra "1" na sessão sem subagentes). */
const principalRodando = (estado: WallCard['state']) => estado === 'active' || estado === 'delegating' || estado === 'background';

function cardDe(leitura: LeituraDaSessao): WallCard {
  const { sessao, desktop, branch, custo, plano, contexto, subagentes } = leitura;
  const pasta = sessao.cwd ?? desktop?.cwd ?? null;
  return {
    id: sessao.id,
    title: sessao.title,
    project: pasta ? basename(pasta) : null,
    branch,
    status: sessao.status,
    state: sessao.state,
    reason: sessao.reason,
    urgent: urgenteDe(leitura),
    since: sessao.since,
    activity: sessao.activity,
    model: sessao.model,
    effort: leitura.esforco,
    agents: { active: subagentes.active + (principalRodando(sessao.state) ? 1 : 0), total: subagentes.items.length + 1 },
    cost: { usd: custo?.usd ?? null, estimate: true },
    plan: plano ? { done: plano.done, total: plano.total, current: plano.current } : null,
    context: contexto ? { pct: contexto.pct, used: contexto.used, limit: contexto.limit, label: contexto.label } : null,
  };
}

/** O mural de um montador do painel, com a mesma porta e o mesmo relógio. */
export function muralDoPainel(painel: MontadorDoPainel, opcoes: Pick<OpcoesDoMural, 'cacheMs' | 'recenteMs'> = {}): MontadorDoMural {
  return new MontadorDoMural({ painel, storage: painel.storage, agora: painel.agora, ...opcoes });
}

/** O handler de `GET /api/wall`: a única linha que server.ts precisa. */
export async function responderMural(res: ServerResponse, montador: Pick<MontadorDoMural, 'montar'>): Promise<void> {
  send(res, 200, await montador.montar());
}
