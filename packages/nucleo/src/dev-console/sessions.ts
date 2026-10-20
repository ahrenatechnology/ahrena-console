// The Dev Console sessions (decision 0008, section 4): which repository and branch each session is
// on, which belong to the context, who is working, who needs you (the `/api/attention` rule) and the
// suggested decisions still unanswered. All derived: the repository comes from the folder's git
// remote, the branch from the Claude Desktop index or from git.

import { diaDe } from '../custo/agregacao.ts';
import { gitDoSistema, issueDoBranch, repoDoRemote, type Git } from '../api/trabalho.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { decisionLabel } from '../decisoes/registro.ts';
import { precisamDeVoce } from '../mcp/ferramentas/atencao.ts';
import { ESTADOS_VIVOS, minutosDesde, type LeituraDaFrota, type Motivo } from '../mcp/frota.ts';
import type { Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { repoKey, type ContextSession } from './model.ts';

export interface SessionLocation {
  repo: string | null;
  branch: string | null;
}

/** Where a folder is: repository (`owner/repo`) and branch. */
export type LocateFolder = (cwd: string) => Promise<SessionLocation>;

/** From the folder's git, kept for `ttlMs` (60 s): the Dev Console re-reads without running git on every request. */
export function gitLocator({ git = gitDoSistema, ttlMs = 60_000, now = Date.now }: { git?: Git; ttlMs?: number; now?: () => number } = {}): LocateFolder {
  const memo = new Map<string, { at: number; value: Promise<SessionLocation> }>();
  return (cwd) => {
    const hit = memo.get(cwd);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = (async () => {
      const [remote, branch] = await Promise.all([git(cwd, ['remote', 'get-url', 'origin']), git(cwd, ['branch', '--show-current'])]);
      return { repo: remote ? repoDoRemote(remote) : null, branch };
    })().catch(() => ({ repo: null, branch: null }));
    memo.set(cwd, { at: now(), value });
    return value;
  };
}

/**
 * The depends-on-you reasons: every `/api/attention` reason where the session needs you
 * (permission, question, plan, decision, error, interrupted), except your turn in the back and
 * forth (`turn_ended`) and a new session at its first prompt (`first_prompt`).
 */
export const DEPENDS_ON_YOU_REASONS = ['permission', 'question', 'plan', 'decision', 'error', 'interrupted'] as const satisfies readonly Motivo[];
export type DependsOnYouReason = (typeof DEPENDS_ON_YOU_REASONS)[number];
const isDependsOnYouReason = (m: Motivo): m is DependsOnYouReason => (DEPENDS_ON_YOU_REASONS as readonly Motivo[]).includes(m);

export interface WaitingSessionItem {
  kind: 'session';
  sessionId: string;
  title: string;
  repo: string;
  issue: number | null;
  reason: DependsOnYouReason;
  /** The pt-BR phrase `/api/attention` builds ("pede permissão para usar Bash"); never conversation text. */
  reasonText: string;
  since: string;
  minutes: number;
}

export interface SuggestedDecisionItem {
  kind: 'suggested-decision';
  decisionId: string;
  /** The UI's "D4". */
  label: string;
  choice: string;
  alternatives: string[];
  sessionId: string;
  title: string;
  repo: string;
  issue: number | null;
  since: string;
  minutes: number;
}

export type DependsOnYouItem = WaitingSessionItem | SuggestedDecisionItem;

/** A decision in force taken today (the machine's day) in one of the context's sessions, live or ended today: the C27 "Decisões tomadas hoje". */
export interface DecisionTodayItem {
  decisionId: string;
  /** The UI's "D4". */
  label: string;
  choice: string;
  sessionId: string;
  repo: string;
  decidedAt: string;
  minutes: number;
}

export interface SessionsOfContexts {
  /** The live sessions of each repository. */
  byRepo: Map<string, ContextSession[]>;
  /** The depends-on-you items of each repository. */
  dependsOnYou: Map<string, DependsOnYouItem[]>;
  /** The decisions in force taken today, per repository. */
  decisionsToday: Map<string, DecisionTodayItem[]>;
}

export interface DevConsoleSessionsOptions {
  frota: LeituraDaFrota;
  decisions?: Pick<DecisionPort, 'listDecisions'> | null;
  locate?: LocateFolder;
}

const MAX_CHOICE = 200;

export class DevConsoleSessions {
  private readonly frota: LeituraDaFrota;
  private readonly decisions: Pick<DecisionPort, 'listDecisions'> | null;
  private readonly locate: LocateFolder;

  constructor({ frota, decisions = null, locate = gitLocator({ now: frota.agora }) }: DevConsoleSessionsOptions) {
    this.frota = frota;
    this.decisions = decisions;
    this.locate = locate;
  }

  /** A session's repository (lower case, `repoKey`) and branch: the Desktop branch wins over git's. */
  async where(session: Pick<Session, 'cwd'>, desktopBranch: string | null = null): Promise<SessionLocation> {
    if (!session.cwd) return { repo: null, branch: desktopBranch };
    const l = await this.locate(session.cwd);
    return { repo: l.repo ? repoKey(l.repo) : null, branch: desktopBranch ?? l.branch };
  }

  /** The live sessions of the requested repositories, and what of theirs depends on you. */
  async read(repos: ReadonlySet<string>): Promise<SessionsOfContexts> {
    const now = this.frota.agora();
    const byRepo = new Map<string, ContextSession[]>();
    const dependsOnYou = new Map<string, DependsOnYouItem[]>();
    const decisionsToday = new Map<string, DecisionTodayItem[]>();
    const today = this.frota.hoje();
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

    const waiting = new Map((await precisamDeVoce(this.frota, null)).map((i) => [i.sessionId, i]));
    // The live list is cached (`frota.cacheMs`) and the ended-today one is not: a session that completes
    // inside that window is in both, and is scanned once.
    const scanned = new Set<string>();
    for (const s of await this.frota.vivas()) {
      const { repo, branch } = await this.where(s.session, s.desktop?.branch ?? null);
      if (!repo || !repos.has(repo)) continue;
      const w = waiting.get(s.session.id);
      const reason = w && isDependsOnYouReason(w.reason) ? w.reason : null;
      const estado = s.inbox.state;
      push(byRepo, repo, {
        id: s.session.id,
        title: s.titulo,
        repo,
        branch,
        working: ESTADOS_VIVOS.includes(estado) && estado !== 'waiting' && estado !== 'error',
        waitingOnYou: reason !== null,
      });
      const issue = branch ? issueDoBranch(branch) : null;
      if (w && reason) {
        push(dependsOnYou, repo, { kind: 'session', sessionId: s.session.id, title: s.titulo, repo, issue, reason, reasonText: w.reasonText, since: w.waitingSince, minutes: w.waitingMinutes });
      }
      if (!this.decisions) continue;
      const page = await this.decisions.listDecisions({ sessionId: s.session.id, states: ['a_confirmar'], limit: 50 });
      for (const d of page.items) {
        if (d.origin !== 'sugerida') continue;
        push(dependsOnYou, repo, {
          kind: 'suggested-decision',
          decisionId: d.id,
          label: decisionLabel(d),
          choice: d.choice.slice(0, MAX_CHOICE),
          alternatives: d.alternatives.map((a) => a.slice(0, MAX_CHOICE)),
          sessionId: s.session.id,
          title: s.titulo,
          repo,
          issue,
          since: d.decidedAt,
          minutes: minutosDesde(d.decidedAt, now),
        });
      }
      scanned.add(s.session.id);
      await this.decisionsTakenToday(s.session.id, repo, today, now, (item) => push(decisionsToday, repo, item));
    }
    // Sessions that ended today count too: a decision taken at 09:00 stays "taken today" after its session completes at 09:30.
    if (this.decisions) {
      const ended = (await this.frota.encerradasHoje()).filter((e) => !scanned.has(e.id));
      const found = await Promise.all(
        ended.map(async (e) => {
          const session = await this.frota.storage.getSession(e.id);
          if (!session) return [];
          const { repo } = await this.where(session);
          if (!repo || !repos.has(repo)) return [];
          const items: DecisionTodayItem[] = [];
          await this.decisionsTakenToday(session.id, repo, today, now, (item) => items.push(item));
          return items;
        }),
      );
      for (const item of found.flat()) push(decisionsToday, item.repo, item);
    }
    for (const list of dependsOnYou.values()) list.sort((a, b) => a.since.localeCompare(b.since));
    return { byRepo, dependsOnYou, decisionsToday };
  }

  /**
   * The decisions in force a session took today (the machine's day, `frota.fusoHorario`). The port
   * lists most recent first, so the first decision from another day ends the scan; the 50 cap is
   * deliberate (more than 50 decisions in force in one session in one day is not a footer).
   */
  private async decisionsTakenToday(sessionId: string, repo: string, today: string, now: number, push: (item: DecisionTodayItem) => void): Promise<void> {
    if (!this.decisions) return;
    const page = await this.decisions.listDecisions({ sessionId, states: ['vigente'], limit: 50 });
    for (const d of page.items) {
      if (diaDe(d.decidedAt, this.frota.fusoHorario) !== today) break;
      push({ decisionId: d.id, label: decisionLabel(d), choice: d.choice.slice(0, MAX_CHOICE), sessionId, repo, decidedAt: d.decidedAt, minutes: minutosDesde(d.decidedAt, now) });
    }
  }
}

/** The repositories with a session in the last `days` days (7), most recent first. */
export async function recentRepos(
  storage: Pick<StoragePort, 'listSessions'>,
  where: (s: Session) => Promise<SessionLocation>,
  { now = Date.now(), days = 7 }: { now?: number; days?: number } = {},
): Promise<string[]> {
  const since = new Date(now - days * 24 * 60 * 60_000).toISOString();
  const seen = new Set<string>();
  const cwds = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await storage.listSessions({ limit: 500, cursor });
    for (const s of page.items) {
      // Most recent first: the first one older than the window ends the scan.
      if (s.updatedAt < since) return [...seen];
      if (!s.cwd || cwds.has(s.cwd)) continue;
      cwds.add(s.cwd);
      const { repo } = await where(s);
      if (repo) seen.add(repo);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...seen];
}
