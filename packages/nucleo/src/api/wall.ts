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
// Order (#245): first the ones that need you (`attention.level` `blocked`, errors included), the urgent
// ones first (an error is urgent, as in the panel's "precisam de você"), and among them the most recent
// request; then the idle ones (`idle`: the turn ended, Esc, at the prompt), the most recent first; then
// the others, by the most recent activity.
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
// without it, `metadata.effort` (the simulator writes it; the terminal ingestion does not know the effort yet).
// A terminal-only session: `null`.
//
// Branch: the Desktop's or `metadata.branch`; without them, what the work-by-branch already knows and,
// last, just `git branch --show-current` in the folder, cached for 60 s, no GitHub (`branchDaPasta`).

import type { CodexIndex } from './codex-index.ts';
import { safeTitle } from '../mcp/output.ts';
import { basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { DEFAULT_LIMITS } from '../states/watcher.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DesktopSession } from './desktop-index.ts';
import type { LeituraDaSessao, MontadorDoPainel } from './panel.ts';
import { SessionOpenDescriber } from './session-open.ts';
import type { WallCard, Wall } from './types.ts';

export const WALL_ROUTE = '/api/wall';
/** Quanto tempo a sessão encerrada continua no mural depois da última atividade: o abandono do vigia. */
export const RECENTE_DO_MURAL_MS = DEFAULT_LIMITS.abandonMs;
const PAGINA = 200;

export interface OpcoesDoMural {
  codex?: CodexIndex | null;
  painel: Pick<MontadorDoPainel, 'atualizarFontes' | 'leituraDaSessao' | 'desktopDaSessao'>;
  storage: StoragePort;
  agora?: () => number;
  /** A resposta inteira fica guardada por este tempo. Padrão 2 s. */
  cacheMs?: number;
  /** An ended session stays on the wall this long after its last activity. Default: the watcher's `abandonMs` (180 min). */
  recenteMs?: number;
  /** #285: each card's `open`; without it, no session counts as live in a terminal. */
  open?: SessionOpenDescriber;
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
  private readonly codex: CodexIndex | null;
  private readonly painel: OpcoesDoMural['painel'];
  private readonly storage: StoragePort;
  private readonly agora: () => number;
  private readonly cacheMs: number;
  private readonly recenteMs: number;
  private readonly open: SessionOpenDescriber;
  private cache: { em: number; mural: Wall } | null = null;
  private rodando: Promise<Wall> | null = null;

  constructor({ codex = null, painel, storage, agora = Date.now, cacheMs = 2_000, recenteMs = RECENTE_DO_MURAL_MS, open = new SessionOpenDescriber() }: OpcoesDoMural) {
    this.codex = codex;
    this.open = open;
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
    await Promise.all([this.painel.atualizarFontes(), this.open.refresh()]);
    const lidas: { leitura: LeituraDaSessao; updatedAt: string }[] = [];
    for (const session of await this.candidatas(agora)) {
      // O critério antes da leitura: a arquivada não paga custo, plano nem contexto.
      if (!ehAberta(session, this.painel.desktopDaSessao(session.id), agora, this.recenteMs)) continue;
      lidas.push({ leitura: await this.painel.leituraDaSessao(session), updatedAt: session.updatedAt });
    }
    const rank = (l: LeituraDaSessao) => (l.sessao.attention?.level === 'blocked' ? 0 : l.sessao.attention?.level === 'idle' ? 1 : 2);
    lidas.sort((a, b) => {
      const [x, y] = [a.leitura, b.leitura];
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
      if (rank(x) === 0) return Number(urgenteDe(y)) - Number(urgenteDe(x)) || y.sessao.since.localeCompare(x.sessao.since);
      if (rank(x) === 1) return y.sessao.since.localeCompare(x.sessao.since);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const cards = lidas.map(({ leitura }) => cardDe(leitura, this.open));
    for (const thread of this.codex?.list() ?? []) {
      // Match the wall's recent-activity window without treating it as a live execution signal.
      if (agora - Date.parse(thread.updatedAt) > this.recenteMs) continue;
      cards.push({ id: thread.id, provider: 'codex', group: thread.group,
        title: safeTitle(thread.title) ?? thread.id, project: basename(thread.cwd), branch: null,
        status: 'unknown', state: 'unknown', reason: null, urgent: false, attention: null,
        since: thread.updatedAt, activity: { type: 'idle', text: 'Estado de execução não disponível' },
        model: null, effort: null, agents: { active: 0, total: 0 }, cost: { usd: null, estimate: true },
        plan: null, context: null, open: { target: 'codex-desktop', command: null } });
    }
    // Keep attention priority, then compare activity across both providers.
    const cardRank = (c: WallCard) => c.attention?.level === 'blocked' ? 0 : c.attention?.level === 'idle' ? 1 : 2;
    const updated = new Map(lidas.map(l => [l.leitura.sessao.id, l.updatedAt]));
    cards.sort((a, b) => cardRank(a) - cardRank(b)
      || (cardRank(a) === 0 ? Number(b.urgent) - Number(a.urgent) : 0)
      || (cardRank(a) < 2 ? b.since.localeCompare(a.since)
        : (b.provider === 'codex' ? b.since : updated.get(b.id) ?? b.since).localeCompare(a.provider === 'codex' ? a.since : updated.get(a.id) ?? a.since)));
    const mural: Wall = {
      sourceError: this.codex?.error ?? null,
      version: 1,
      generatedAt: new Date(agora).toISOString(),
      count: {
        all: cards.length,
        waiting: cards.filter((c) => PRECISA.has(c.state)).length,
        active: cards.filter((c) => ATIVA.has(c.state)).length,
        blocked: cards.filter((c) => c.attention?.level === 'blocked').length,
        idle: cards.filter((c) => c.attention?.level === 'idle').length,
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

function cardDe(leitura: LeituraDaSessao, open: SessionOpenDescriber): WallCard {
  const { sessao, desktop, branch, custo, plano, contexto, subagentes } = leitura;
  const pasta = sessao.cwd ?? desktop?.cwd ?? null;
  return {
    id: sessao.id,
    provider: 'claude',
    group: null,
    title: sessao.title,
    project: pasta ? basename(pasta) : null,
    branch,
    status: sessao.status,
    state: sessao.state,
    reason: sessao.reason,
    urgent: urgenteDe(leitura),
    attention: sessao.attention,
    since: sessao.since,
    activity: sessao.activity,
    model: sessao.model,
    effort: leitura.esforco,
    agents: { active: subagentes.active + (principalRodando(sessao.state) ? 1 : 0), total: subagentes.items.length + 1 },
    cost: { usd: custo?.usd ?? null, estimate: true },
    plan: plano ? { done: plano.done, total: plano.total, current: plano.current } : null,
    context: contexto ? { pct: contexto.pct, used: contexto.used, limit: contexto.limit, label: contexto.label } : null,
    open: open.describe({ sessionId: sessao.id, cwd: pasta, local: desktop?.localId ?? null }),
  };
}

/** O mural de um montador do painel, com a mesma porta e o mesmo relógio. */
export function muralDoPainel(painel: MontadorDoPainel, opcoes: Pick<OpcoesDoMural, 'cacheMs' | 'recenteMs' | 'open' | 'codex'> = {}): MontadorDoMural {
  return new MontadorDoMural({ painel, storage: painel.storage, agora: painel.agora, ...opcoes });
}

/** O handler de `GET /api/wall`: a única linha que server.ts precisa. */
export async function responderMural(res: ServerResponse, montador: Pick<MontadorDoMural, 'montar'>): Promise<void> {
  send(res, 200, await montador.montar());
}
