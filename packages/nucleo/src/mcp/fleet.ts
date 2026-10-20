// What the tools read from the machine: the live sessions with state, reason and account, the ones
// ended today and today's cost. All through the port and in-memory caches, like the panel
// (decision 0004): no call scans transcripts.
//
// - Live: the port's `active` and `error` ones, with `readInbox` (1.5). Kept for `cacheMs`, and
//   concurrent calls wait for the same read.
// - Ended today: `completed` and `abandoned` with the last activity today, in the machine's time zone.
// - Today's cost: the day's `aggregateCost` (1.6), recomputed at most every `costMs`.
// - Account: `Contas.daSessao` (decision 0006), the same instance as the panel when the core passes
//   it, so that the "conta 1" label is the same on both surfaces.

import { basename } from 'node:path';
import { aggregateCost, dayOf, type CostReport } from '../cost/aggregation.ts';
import { readInbox, type InboxState, type InboxReading } from '../states/inbox.ts';
import type { Agent, Session, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Contas } from '../api/contas.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from '../api/indice-desktop.ts';
import { atencaoDe, type MotivoDaAtencao } from '../api/atencao.ts';
import { ResumosDeSessao, type ResumoDosEventos } from '../api/resumo.ts';
import type { ContaDoPainel } from '../api/tipos.ts';
import { safeToolName, safeTitle } from './output.ts';

/**
 * Why the session needs you. The split is the panel's (`atencaoDe`, #140): the first five block
 * the session until you act; the last three are "your turn" in the back-and-forth (the turn
 * ended, Esc, a new session at the prompt).
 */
export type McpAttentionReason = 'permission' | 'question' | 'plan' | 'decision' | 'error' | 'turn_ended' | 'interrupted' | 'first_prompt';
export type McpAttentionGroup = 'blocking' | 'your_turn';
export const MCP_ATTENTION_REASONS: readonly McpAttentionReason[] = ['permission', 'question', 'plan', 'decision', 'error', 'turn_ended', 'interrupted', 'first_prompt'];

const REASON_FROM_PANEL: Record<MotivoDaAtencao, McpAttentionReason> = {
  permissao: 'permission',
  pergunta: 'question',
  plano: 'plan',
  decisao: 'decision',
  erro: 'error',
  'sua-vez': 'turn_ended',
  interrompida: 'interrupted',
  'no-prompt': 'first_prompt',
};

export interface FleetSession {
  session: Session;
  inbox: InboxReading;
  desktop: SessaoDoDesktop | null;
  account: ContaDoPainel | null;
  /** Already cleaned (output.ts). */
  title: string;
}

export interface Attention {
  reason: McpAttentionReason;
  group: McpAttentionGroup;
  /** The tool asking for permission, when it has a known name. */
  tool: string | null;
  /** How many options the question has (`AskUserQuestion`); never the text. */
  questionOptions: number | null;
  /** The API error code ("529", "overloaded_error"); never the message. */
  errorCode: string | null;
}

export interface EndedToday {
  id: string;
  status: SessionStatus;
  account: ContaDoPainel | null;
}

export interface FleetOptions {
  storage: StoragePort;
  accounts: Contas;
  desktop?: IndiceDoDesktop | null;
  now?: () => number;
  /** IANA time zone of the days (today's cost, ended today). Default: the machine's. */
  timeZone?: string;
  cacheMs?: number;
  costMs?: number;
}

export class FleetReader {
  readonly storage: StoragePort;
  private readonly accounts: Contas;
  private readonly desktop: IndiceDoDesktop | null;
  readonly now: () => number;
  readonly timeZone: string;
  private readonly cacheMs: number;
  private readonly costMs: number;
  private readonly summaries: ResumosDeSessao;
  private liveCache: { at: number; items: FleetSession[] } | null = null;
  private liveLoading: Promise<FleetSession[]> | null = null;
  private costCache: { at: number; day: string; report: CostReport } | null = null;

  constructor({ storage, accounts, desktop = null, now = Date.now, timeZone, cacheMs = 2_000, costMs = 30_000 }: FleetOptions) {
    this.storage = storage;
    this.accounts = accounts;
    this.desktop = desktop;
    this.now = now;
    this.timeZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    this.cacheMs = cacheMs;
    this.costMs = costMs;
    this.summaries = new ResumosDeSessao(storage, { agora: now, maximo: 256 });
  }

  today(): string {
    return dayOf(new Date(this.now()).toISOString(), this.timeZone);
  }

  /** The `active` and `error` sessions, with the inbox state and the account. Most recent first. */
  async live(): Promise<FleetSession[]> {
    if (this.liveCache && this.now() - this.liveCache.at < this.cacheMs) return this.liveCache.items;
    this.liveLoading ??= (async () => {
      await Promise.all([this.accounts.atualizar(), this.desktop?.atualizar()]);
      const items: FleetSession[] = [];
      for await (const session of this.all({ status: ['active', 'error'] })) {
        const agents: Agent[] = await this.storage.listAgents(session.id);
        const desktop = this.desktop?.sessaoPorCli(session.id) ?? null;
        items.push({ session, inbox: readInbox(session, agents), desktop, account: this.accounts.daSessao(session, desktop), title: titleOf(session, desktop) });
      }
      this.liveCache = { at: this.now(), items };
      return items;
    })().finally(() => {
      this.liveLoading = null;
    });
    return this.liveLoading;
  }

  /** `completed` and `abandoned` with the last activity today. */
  async endedToday(): Promise<EndedToday[]> {
    const today = this.today();
    const out: EndedToday[] = [];
    for await (const s of this.all({ status: ['completed', 'abandoned'] }, today)) {
      const desktop = this.desktop?.sessaoPorCli(s.id) ?? null;
      out.push({ id: s.id, status: s.status, account: this.accounts.daSessao(s, desktop) });
    }
    return out;
  }

  async costToday(): Promise<CostReport> {
    const day = this.today();
    const c = this.costCache;
    if (c && c.day === day && this.now() - c.at < this.costMs) return c.report;
    const report = await aggregateCost(this.storage, { since: day, until: day, timeZone: this.timeZone });
    this.costCache = { at: this.now(), day, report };
    return report;
  }

  /** The account of any session (for the cost of one that is not among the live ones). */
  async accountOf(sessionId: string): Promise<ContaDoPainel | null> {
    const s = await this.storage.getSession(sessionId);
    if (!s) return null;
    return this.accounts.daSessao(s, this.desktop?.sessaoPorCli(s.id) ?? null);
  }

  /** Why a session that needs you is waiting, without conversation text. */
  async attention(s: FleetSession): Promise<Attention> {
    const r = await this.summaries.ler(s.session.id, s.session.updatedAt);
    return classify(s.inbox, r);
  }

  private async *all(query: { status: SessionStatus[] }, sinceDay?: string): AsyncGenerator<Session> {
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ ...query, limit: 500, cursor });
      for (const s of page.items) {
        // Most recent first: the first one from before the day ends the search.
        if (sinceDay && dayOf(s.updatedAt, this.timeZone) < sinceDay) return;
        yield s;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

/**
 * The reason and the group come from `atencaoDe` (src/api/atencao.ts), the same rule as the panel's
 * "precisam de você"; here we only add what MCP shows beyond it, without conversation text.
 */
export function classify(inbox: InboxReading, r: ResumoDosEventos): Attention {
  const { nivel, porque } = atencaoDe(inbox, r);
  const reason = REASON_FROM_PANEL[porque];
  return {
    reason,
    group: nivel === 'precisa' ? 'blocking' : 'your_turn',
    tool: reason === 'permission' ? safeToolName(r.ultimaFerramenta?.nome) : null,
    questionOptions: reason === 'question' ? r.ultimaPergunta?.opcoes || null : null,
    errorCode: reason === 'error' ? errorCodeOf(r.ultimoErro?.texto ?? null) : null,
  };
}

/** Only the code: the HTTP status and the API error type, never the message. */
function errorCodeOf(text: string | null): string | null {
  if (!text) return null;
  const parts = [/\b([45]\d\d)\b/.exec(text)?.[1], /\b([a-z]+(?:_[a-z]+)*_error)\b/.exec(text)?.[1]].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function titleOf(s: Session, d: SessaoDoDesktop | null): string {
  return safeTitle(d?.titulo) ?? safeTitle(s.name) ?? (s.cwd ? safeTitle(basename(s.cwd)) : null) ?? s.id.slice(0, 8);
}

export function projectOf(s: Session): string | null {
  return s.cwd ? safeTitle(basename(s.cwd)) : null;
}

/** Live states in the order they appear in the totals. */
export const LIVE_STATES: readonly InboxState[] = ['active', 'waiting', 'delegating', 'background', 'error'];

/**
 * Matches the session's account against the `account` filter: label (case-insensitive), id, or
 * "none" for "Sem conta". Without a filter, everything passes.
 */
export function matchesAccountFilter(account: ContaDoPainel | null, filter: readonly string[] | null): boolean {
  if (!filter) return true;
  return filter.some((f) => (f.toLowerCase() === 'none' ? account === null : account !== null && (account.id === f || account.label.toLowerCase() === f.toLowerCase())));
}

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}
