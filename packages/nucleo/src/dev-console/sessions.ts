// As sessões do Dev Console (decisão 0008, seção 4): de que repositório e branch é cada sessão,
// quais são do contexto, quem trabalha, quem espera você (pergunta, plano, decisão: a mesma regra
// do `/api/atencao`) e as decisões sugeridas ainda sem resposta. Tudo derivado: o repositório sai
// do remote do git da pasta, o branch do índice do Claude Desktop ou do git.

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

/** Onde está uma pasta: repositório (`owner/repo`) e branch. */
export type LocateFolder = (cwd: string) => Promise<SessionLocation>;

/** Pelo git da pasta, guardado por `ttlMs` (60 s): o Dev Console relê sem rodar git a cada pedido. */
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
 * Os motivos do "depende de você": todos os do `/api/atencao` em que a sessão precisa de você
 * (permissão, pergunta, plano, decisão, erro, interrompida), menos a sua vez no bate-bola
 * (`turn_ended`) e a sessão nova no prompt (`first_prompt`).
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
  /** A frase do `/api/atencao` ("pede permissão para usar Bash"); nunca texto da conversa. */
  reasonText: string;
  since: string;
  minutes: number;
}

export interface SuggestedDecisionItem {
  kind: 'suggested-decision';
  decisionId: string;
  /** O "D4" da interface. */
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

export interface SessionsOfContexts {
  /** As vivas de cada repositório. */
  byRepo: Map<string, ContextSession[]>;
  /** O "depende de você" de cada repositório. */
  dependsOnYou: Map<string, DependsOnYouItem[]>;
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

  /** O repositório (em minúsculas, `repoKey`) e o branch de uma sessão: o branch do Desktop vence o do git. */
  async where(session: Pick<Session, 'cwd'>, desktopBranch: string | null = null): Promise<SessionLocation> {
    if (!session.cwd) return { repo: null, branch: desktopBranch };
    const l = await this.locate(session.cwd);
    return { repo: l.repo ? repoKey(l.repo) : null, branch: desktopBranch ?? l.branch };
  }

  /** As sessões vivas dos repositórios pedidos, e o que delas depende de você. */
  async read(repos: ReadonlySet<string>): Promise<SessionsOfContexts> {
    const now = this.frota.agora();
    const byRepo = new Map<string, ContextSession[]>();
    const dependsOnYou = new Map<string, DependsOnYouItem[]>();
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

    const waiting = new Map((await precisamDeVoce(this.frota, null)).map((i) => [i.sessionId, i]));
    for (const s of await this.frota.vivas()) {
      const { repo, branch } = await this.where(s.session, s.desktop?.branch ?? null);
      if (!repo || !repos.has(repo)) continue;
      const w = waiting.get(s.session.id);
      const reason = w && isDependsOnYouReason(w.reason) ? w.reason : null;
      const estado = s.inbox.estado;
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
    }
    for (const list of dependsOnYou.values()) list.sort((a, b) => a.since.localeCompare(b.since));
    return { byRepo, dependsOnYou };
  }
}

/** Os repositórios com sessão nos últimos `days` dias (7), a mais recente primeiro. */
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
      // Mais recentes primeiro: a primeira de antes da janela encerra a busca.
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
