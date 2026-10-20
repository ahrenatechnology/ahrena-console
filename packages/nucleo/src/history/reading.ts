// Reading the history (#33, C15) through the port: the ended sessions, the page by the rules in
// model.ts and, only for the page's items, the cost (the same calculation as the panel) and the
// neighbours across /clear (the decisions' session link). Without the decisions port, the
// neighbours come back `null`.
//
// The session list is read in full on every request (the port has no index on `endedAt`); each
// session's cost is kept while its `updatedAt` does not change.

import { parcelasDaSessao, relatorioDeCusto } from '../custo/agregacao.ts';
import { precosVigentes } from '../custo/tabela.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { clearNeighbours } from '../decisoes/registro.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { endedSessionOf, historyPage, type HistoryPage, type HistoryRequest, type EndedSession } from './model.ts';

/** The session before or after the /clear. */
export interface HistoryNeighbour {
  id: string;
  title: string | null;
}

export interface HistoryItem extends EndedSession {
  durationMs: number;
  /** Estimate in US$; `null` with no recorded usage or no price for the model. */
  costUsd: number | null;
  /** The session before the /clear. */
  previous: HistoryNeighbour | null;
  /** The new session after the /clear. */
  next: HistoryNeighbour | null;
}

export type HistoryResponse = HistoryPage<HistoryItem>;

type HistoryStorage = Pick<StoragePort, 'listSessions' | 'getSession' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

export interface SessionHistoryOptions {
  storage: HistoryStorage;
  /** The session link (#99); without it, `previous` and `next` come back `null`. */
  decisions?: Pick<DecisionPort, 'getSessionLink' | 'listSessionLinks'> | null;
  /** IANA time zone of the days. Default: the core machine's. */
  timeZone?: string;
  /** A title from outside the database (the Desktop index); without it, or when it gives `null`, the session name. */
  titleOf?: (s: Session) => string | null;
}

export const machineTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export class SessionHistory {
  private readonly storage: HistoryStorage;
  private readonly decisions: SessionHistoryOptions['decisions'];
  private readonly timeZone: string;
  private readonly titleOf: (s: Session) => string | null;
  private readonly costs = new Map<string, { updatedAt: string; usd: number | null }>();

  constructor({ storage, decisions = null, timeZone = machineTimeZone(), titleOf = () => null }: SessionHistoryOptions) {
    this.storage = storage;
    this.decisions = decisions;
    this.timeZone = timeZone;
    this.titleOf = titleOf;
  }

  async page(request: HistoryRequest): Promise<HistoryResponse> {
    const byId = new Map<string, Session>();
    const ended: EndedSession[] = [];
    let cursor: string | null = null;
    do {
      const batch = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of batch.items) {
        byId.set(s.id, s);
        const e = endedSessionOf(s, this.titleOf(s));
        if (e) ended.push(e);
      }
      cursor = batch.nextCursor;
    } while (cursor);

    const page = historyPage(ended, request, this.timeZone);
    const prices = await precosVigentes(this.storage);
    const days = [];
    for (const d of page.days) {
      const sessions: HistoryItem[] = [];
      for (const e of d.sessions) {
        const neighbours = this.decisions ? await clearNeighbours(this.decisions, e.id) : { previous: null, next: null };
        sessions.push({
          ...e,
          durationMs: Math.max(0, Date.parse(e.end) - Date.parse(e.start)),
          costUsd: await this.costOf(byId.get(e.id)!, prices),
          previous: await this.neighbour(neighbours.previous, byId),
          next: await this.neighbour(neighbours.next, byId),
        });
      }
      days.push({ day: d.day, sessions });
    }
    return { days, next: page.next };
  }

  // The same number as the panel (custoDe in api/painel.ts); with no usage, `null` instead of zero.
  private async costOf(s: Session, prices: Awaited<ReturnType<typeof precosVigentes>>): Promise<number | null> {
    const kept = this.costs.get(s.id);
    if (kept && kept.updatedAt === s.updatedAt) return kept.usd;
    const total = relatorioDeCusto(await parcelasDaSessao(this.storage, s.id, prices)).total;
    const usd = total.totalDeTokens === 0 ? null : total.custoUsd;
    this.costs.set(s.id, { updatedAt: s.updatedAt, usd });
    return usd;
  }

  private async neighbour(id: string | null, byId: Map<string, Session>): Promise<HistoryNeighbour | null> {
    if (!id) return null;
    const s = byId.get(id) ?? (await this.storage.getSession(id));
    return { id, title: s ? (this.titleOf(s) ?? s.name ?? null) : null };
  }
}
