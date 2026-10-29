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
// - `abandoned` never comes in, except (#333) the one that was waiting on a blocking request when the
//   watcher abandoned it (`waitingAsAbandoned`): it stays, with the age of the request, until it is archived.
//
// The "Paradas" band (#333): the not archived sessions the wall does not show (ended or abandoned more than
// 180 min ago, asking nothing), within 30 days, as `parked` (`total` and the most recent rows).
// Nested children (#333): each card carries the sessions it opened, every level (`children`, `tree`), from the
// Desktop index's parent link (`startedBy`, as the Workflows tree of #332). A session with an open ancestor
// nests in it and is a card of its own only when it needs you (`attention.level` `blocked`), with `parentId`.
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

import { basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { readMemory } from '../states/rules.ts';
import { DEFAULT_LIMITS } from '../states/watcher.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DesktopSession } from './desktop-index.ts';
import type { LeituraDaSessao, MontadorDoPainel } from './panel.ts';
import { SessionOpenDescriber } from './session-open.ts';
import type { WallCard, WallChild, WallTree, Wall } from './types.ts';

export const WALL_ROUTE = '/api/wall';
/** Quanto tempo a sessão encerrada continua no mural depois da última atividade: o abandono do vigia. */
export const RECENTE_DO_MURAL_MS = DEFAULT_LIMITS.abandonMs;
const PAGINA = 200;

export interface OpcoesDoMural {
  painel: Pick<MontadorDoPainel, 'atualizarFontes' | 'leituraDaSessao' | 'desktopDaSessao' | 'desktopByLocal' | 'desktopChildren'>;
  storage: StoragePort;
  agora?: () => number;
  /** A resposta inteira fica guardada por este tempo. Padrão 2 s. */
  cacheMs?: number;
  /** An ended session stays on the wall this long after its last activity. Default: the watcher's `abandonMs` (180 min). */
  recenteMs?: number;
  /** #333: how far back the "Paradas" band looks. Default 30 days. */
  parkedWindowMs?: number;
  /** #285: each card's `open`; without it, no session counts as live in a terminal. */
  open?: SessionOpenDescriber;
}

/** #333: the "Paradas" band looks this far back: older than that is history, not something in play. */
export const PARKED_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** #333: the rows of the "Paradas" band when the request does not say. */
export const PARKED_PAGE = 7;
/** #333: the most rows of the band one request reads; the total always counts them all. */
export const PARKED_MAX = 100;

/** O critério de "aberta" (comentário do módulo), sem a porta: para o teste e para quem quiser. */
export function ehAberta(session: Pick<Session, 'status' | 'endedAt' | 'updatedAt'>, desktop: Pick<DesktopSession, 'archived'> | null, agora: number, recenteMs = RECENTE_DO_MURAL_MS): boolean {
  if (desktop?.archived) return false;
  if (session.status === 'abandoned') return false;
  if (session.status === 'active') return true;
  if (session.status === 'error' && !session.endedAt) return true;
  return agora - Date.parse(session.updatedAt) <= recenteMs;
}

/**
 * #333: an abandoned session that was waiting on a blocking request when the watcher abandoned it (the
 * state machine keeps `waitingWhenAbandoned`; the ones abandoned before that read the event summary as
 * if the turn had ended, which finds a pending question or plan and a decision asked at the turn's close).
 * Esc and a new session at the prompt asked nothing. The same `attention` rule as everywhere else, no new heuristic.
 */
export function waitingAsAbandoned(session: Session): Session | null {
  if (session.status !== 'abandoned') return null;
  const w = readMemory(session).waitingWhenAbandoned;
  if (w && w.reason !== 'notification' && w.reason !== 'stop') return null;
  return { ...session, awaitingInputSince: w?.since ?? session.updatedAt, awaitingReason: w?.reason ?? 'stop' };
}

const PRECISA = new Set(['waiting', 'error']);
const ATIVA = new Set(['active', 'delegating', 'background']);

/** One session as the wall sees it this round: open, asking something, and its reading (read once, when asked). */
interface Situation {
  session: Session;
  desktop: DesktopSession | null;
  /** On the wall as a card (alive, recently ended, or asking you something). */
  open: boolean;
  reading(): Promise<LeituraDaSessao>;
}

export class MontadorDoMural {
  private readonly painel: OpcoesDoMural['painel'];
  private readonly storage: StoragePort;
  private readonly agora: () => number;
  private readonly cacheMs: number;
  private readonly recenteMs: number;
  private readonly parkedWindowMs: number;
  private readonly open: SessionOpenDescriber;
  private cache: { em: number; mural: Wall; byLimit: Map<number, Wall> } | null = null;
  private rodando: Promise<Wall> | null = null;

  constructor({ painel, storage, agora = Date.now, cacheMs = 2_000, recenteMs = RECENTE_DO_MURAL_MS, parkedWindowMs = PARKED_WINDOW_MS, open = new SessionOpenDescriber() }: OpcoesDoMural) {
    this.open = open;
    this.painel = painel;
    this.storage = storage;
    this.agora = agora;
    this.cacheMs = cacheMs;
    this.recenteMs = recenteMs;
    this.parkedWindowMs = parkedWindowMs;
  }

  /** `parkedLimit`: how many rows of "Paradas" come back (default 7, at most 100); the total is always whole. */
  async montar({ parkedLimit = PARKED_PAGE }: { parkedLimit?: number } = {}): Promise<Wall> {
    const limit = Math.min(Math.max(Math.trunc(parkedLimit) || PARKED_PAGE, 1), PARKED_MAX);
    if (!this.cache || this.agora() - this.cache.em >= this.cacheMs) {
      this.rodando ??= this.montarAgora().finally(() => {
        this.rodando = null;
      });
      await this.rodando;
    }
    const { mural, byLimit } = this.cache!;
    if (!byLimit.has(limit)) byLimit.set(limit, { ...mural, parked: { total: mural.parked.total, items: mural.parked.items.slice(0, limit) } });
    return byLimit.get(limit)!;
  }

  private async montarAgora(): Promise<Wall> {
    const agora = this.agora();
    await Promise.all([this.painel.atualizarFontes(), this.open.refresh()]);
    const situations = new Map<string, Situation | null>();
    const situationOf = async (session: Session): Promise<Situation | null> => {
      if (situations.has(session.id)) return situations.get(session.id)!;
      const s = await this.situationOf(session, agora);
      situations.set(session.id, s);
      return s;
    };
    const candidates = await this.candidatas(agora);
    const open: Situation[] = [];
    const stopped: Situation[] = [];
    for (const session of candidates) {
      // O critério antes da leitura: a arquivada não paga custo, plano nem contexto.
      const s = await situationOf(session);
      if (!s) continue;
      (s.open ? open : stopped).push(s);
    }
    const openIds = new Set(open.map((s) => s.session.id));
    /** The nearest ancestor that passes `accept` (a card, an open one): where this session nests. */
    const leaderOf = (s: Situation, accept: (cliId: string) => boolean = (id) => openIds.has(id)): string | null => {
      const seen = new Set<string>();
      let up = s.desktop?.parentLocalId ?? null;
      while (up && !seen.has(up)) {
        seen.add(up);
        const mother = this.painel.desktopByLocal(up);
        if (!mother) return null;
        if (mother.cliSessionId && accept(mother.cliSessionId)) return mother.cliSessionId;
        up = mother.parentLocalId;
      }
      return null;
    };
    const leaders = new Map(open.map((s) => [s.session.id, leaderOf(s)]));
    // A cycle in the index (each the other's mother) would nest everyone out of the wall: those lead themselves.
    for (const id of leaders.keys()) {
      const seen = new Set<string>([id]);
      for (let up = leaders.get(id) ?? null; up; up = leaders.get(up) ?? null) {
        if (up === id) {
          leaders.set(id, null);
          break;
        }
        if (seen.has(up)) break;
        seen.add(up);
      }
    }
    const lidas = await Promise.all(
      open.map(async (s) => {
        const leitura = await s.reading();
        const { children, tree } = await this.treeOf(s, situationOf);
        return { leitura, updatedAt: s.session.updatedAt, children, tree, parentId: leaders.get(s.session.id) ?? null };
      }),
    );
    // A child nests in its leader's card; on its own it stays on the wall only when it needs you.
    const onWall = lidas.filter((l) => !l.parentId || l.leitura.sessao.attention?.level === 'blocked');
    const rank = (l: LeituraDaSessao) => (l.sessao.attention?.level === 'blocked' ? 0 : l.sessao.attention?.level === 'idle' ? 1 : 2);
    onWall.sort((a, b) => {
      const [x, y] = [a.leitura, b.leitura];
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
      if (rank(x) === 0) return Number(urgenteDe(y)) - Number(urgenteDe(x)) || y.sessao.since.localeCompare(x.sessao.since);
      if (rank(x) === 1) return y.sessao.since.localeCompare(x.sessao.since);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    // The card's `parentId` is the nearest ancestor that is on the wall too (the in-between ones nest and show only in the tree).
    const wallIds = new Set(onWall.map((l) => l.leitura.sessao.id));
    const sits = new Map(open.map((s) => [s.session.id, s]));
    const cards = onWall.map((l) => cardDe(l.leitura, this.open, l.children, l.tree, l.parentId ? leaderOf(sits.get(l.leitura.sessao.id)!, (id) => wallIds.has(id)) : null));
    // "Paradas": what is not on the wall and does not nest in a leader (that one counts in the leader's tree).
    const parked = stopped.filter((s) => !leaderOf(s)).sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
    const parkedCards = await Promise.all(parked.slice(0, PARKED_MAX).map(async (s) => cardDe(await s.reading(), this.open, [], null, null)));
    const mural: Wall = {
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
      parked: { total: parked.length, items: parkedCards },
    };
    this.cache = { em: this.agora(), mural, byLimit: new Map() };
    return mural;
  }

  /** Whether the session is on the wall, and its reading: for the abandoned one that asked, the reading as if it still waited. */
  private async situationOf(session: Session, agora: number): Promise<Situation | null> {
    const desktop = this.painel.desktopDaSessao(session.id);
    if (desktop?.archived) return null;
    const open = ehAberta(session, desktop, agora, this.recenteMs);
    if (!open) {
      const asking = waitingAsAbandoned(session);
      if (asking) {
        const reading = await this.painel.leituraDaSessao(asking);
        if (reading.sessao.attention?.level === 'blocked') return { session, desktop, open: true, reading: async () => reading };
      }
    }
    let memo: Promise<LeituraDaSessao> | null = null;
    return { session, desktop, open, reading: () => (memo ??= this.painel.leituraDaSessao(session)) };
  }

  /** The sessions this one opened, every level, with the counts of the whole tree. The archived and the unknown are left out. */
  private async treeOf(s: Situation, situationOf: (session: Session) => Promise<Situation | null>): Promise<{ children: WallChild[]; tree: WallTree | null }> {
    if (!s.desktop) return { children: [], tree: null };
    const visited = new Set<string>([s.desktop.localId]);
    const walk = async (mother: DesktopSession): Promise<WallChild[]> => {
      const out: WallChild[] = [];
      for (const child of this.painel.desktopChildren(mother.localId)) {
        if (child.archived || !child.cliSessionId || visited.has(child.localId)) continue;
        visited.add(child.localId);
        const session = await this.storage.getSession(child.cliSessionId);
        const sit = session ? await situationOf(session) : null;
        if (!sit) continue;
        const { sessao } = await sit.reading();
        const blocked = sessao.attention?.level === 'blocked';
        out.push({ id: sit.session.id, title: sessao.title, status: sessao.status, state: sessao.state, attention: sessao.attention, since: sessao.since, parked: !sit.open && !blocked, children: await walk(child) });
      }
      return out;
    };
    const children = await walk(s.desktop);
    if (children.length === 0) return { children, tree: null };
    const all: WallChild[] = [];
    const flat = (nodes: WallChild[]) => nodes.forEach((n) => (all.push(n), flat(n.children)));
    flat(children);
    return {
      children,
      tree: {
        total: all.length,
        blocked: all.filter((n) => n.attention?.level === 'blocked').length,
        active: all.filter((n) => ATIVA.has(n.state)).length,
        parked: all.filter((n) => n.parked).length,
      },
    };
  }

  // As `active` inteiras, por índice; das `error`, `completed` e `abandoned`, só as páginas com atividade
  // dentro da janela das Paradas (a lista vem da mais recente para a mais antiga). #333: a janela agora é
  // a das Paradas (30 dias); quem fica no mural é decidido sessão a sessão (`situationOf`).
  private async candidatas(agora: number): Promise<Session[]> {
    const vistas = new Map<string, Session>();
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ status: ['active'], limit: PAGINA, cursor });
      for (const s of page.items) vistas.set(s.id, s);
      cursor = page.nextCursor;
    } while (cursor);
    const corte = new Date(agora - this.parkedWindowMs).toISOString();
    cursor = null;
    do {
      const page = await this.storage.listSessions({ status: ['error', 'completed', 'abandoned'], limit: PAGINA, cursor });
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

function cardDe(leitura: LeituraDaSessao, open: SessionOpenDescriber, children: WallChild[], tree: WallTree | null, parentId: string | null): WallCard {
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
    children,
    tree,
    parentId,
  };
}

/** O mural de um montador do painel, com a mesma porta e o mesmo relógio. */
export function muralDoPainel(painel: MontadorDoPainel, opcoes: Pick<OpcoesDoMural, 'cacheMs' | 'recenteMs' | 'parkedWindowMs' | 'open'> = {}): MontadorDoMural {
  return new MontadorDoMural({ painel, storage: painel.storage, agora: painel.agora, ...opcoes });
}

/** O handler de `GET /api/wall`: a única linha que server.ts precisa. */
export async function responderMural(res: ServerResponse, montador: Pick<MontadorDoMural, 'montar'>, parkedLimit?: number): Promise<void> {
  send(res, 200, await montador.montar({ parkedLimit }));
}
