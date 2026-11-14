/*
 * #598 #609 the Projects the work board reads when it spans every granted organization: the organizations the GitHub
 * connection granted (`orgs.granted`) and the person's own account. The list of Projects is `ProjectOptions` (the 1 h
 * cached list, github/project-options.ts); each Project's board goes through its own ADR-0001 cache entry, the one the
 * chosen-Project kanban already uses (`github/project.ts`), so a Project read here and in the kanban is one read.
 *
 * What an owner becomes (`WorkBoardOrganization`):
 * - `read`: its open Projects with a Status field were read; `readAt` is the oldest of their reads.
 * - `restricted`: it is in `orgs.pending` (it restricts OAuth Apps), or GitHub refused its Projects for that reason: reason
 *   `oauth-restricted`, with the approval and request URLs the connection builds.
 * - `saml`: GitHub refused its Projects behind SAML.
 * - `failed`: GitHub refused it otherwise (`forbidden`), or a read of one of its Projects failed (`network`, `rate-limited`,
 *   `no-scope`, `github-error`). Cards stored from an earlier read stay, and `readAt` is the time of that read.
 * The reason is always a code; GitHub's message goes to the log, never to the response (#495).
 * Where one Project of an owner failed, that owner is `failed` with the code, keeps the stored cards of the Projects that failed
 * with their `readAt`, and is not a trusted owner (#609). When EVERY Project tried failed, it is GitHub being down and not a
 * warning per owner: the stored cards stay with `stale` (ADR-0001), and with nothing stored the read is `NoDataError` (the
 * route's 502).
 *
 * Closed Projects and Projects with no Status field are skipped. The owners the board read (`readOwners`) are the default of
 * the trusted owners (github/trusted-owners.ts): the owners with a Project read, never one with a warning.
 */

import { githubFailureOf, NoDataError, type GithubCache, type GithubFailure, type StaleCode } from './cache.ts';
import type { GithubOrg } from './connection/connection.ts';
import type { SyncStep } from './background-sync.ts';
import { SYNC_WORK_PROJECTS_EVERY_MS } from './background-sync.ts';
import type { GithubAccess } from './github-source.ts';
import { createGithubProject, type ProjectBoard, type ProjectRef } from './project.ts';
import type { OwnerBlockReason, ProjectOption, ProjectOptionsList, ProjectOwner } from './project-options.ts';
import type { WorkBoardOrganization, WorkProjectBoard } from './work-board.ts';

/** #609 One Project read, with the owner it counts under. */
export interface WorkProjectRead {
  organization: string;
  board: ProjectBoard;
}

export interface WorkProjectsRead {
  organizations: WorkBoardOrganization[];
  /** #609 In board order: the organizations in order, the account last, each one's Projects by number. */
  boards: WorkProjectRead[];
  /** #609 The oldest read among the boards, epoch ms; `0` when none was read. */
  fetchedAt: number;
  /** #609 GitHub did not answer for any owner that was read: the boards are the stored ones. */
  stale: boolean;
  staleCode: StaleCode | null;
}

export interface WorkBoardProjectsOptions {
  options: { list(): Promise<ProjectOptionsList>; snapshot(): Promise<ProjectOptionsList | null> };
  /** #609 The organizations the connection granted and the ones that restrict the app (`GithubConnection.status().orgs`). */
  orgs: () => Promise<readonly GithubOrg[]>;
  /** #609 The board of one Project, through its own cache entry. */
  project: (ref: ProjectRef) => WorkProjectBoard;
  now?: () => number;
  /** #609 The raw error of a failed read goes here; the response only gets a code. */
  log?: (message: string) => void;
}

export interface WorkProjectsReadOptions {
  /** #609 The background sync and the refresh button: re-read GitHub (the cache keeps its 30 s floor). */
  force?: boolean;
  /** ADR-0015 answer the stored boards and call GitHub only for what is not stored. */
  fromStore?: boolean;
}

const OWNER_REASON = { 'oauth-restricted': 'restricted', saml: 'saml', forbidden: 'failed' } as const;

export class WorkBoardProjects {
  private readonly options: WorkBoardProjectsOptions['options'];
  private readonly orgs: WorkBoardProjectsOptions['orgs'];
  private readonly project: WorkBoardProjectsOptions['project'];
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private owners: string[] = [];

  constructor({ options, orgs, project, now = Date.now, log = () => {} }: WorkBoardProjectsOptions) {
    this.options = options;
    this.orgs = orgs;
    this.project = project;
    this.now = now;
    this.log = log;
  }

  /** #609 The owners (lower case) with a Project read by the last read: the default of the trusted owners. */
  readOwners(): string[] {
    return [...this.owners];
  }

  async read({ force = false, fromStore = false }: WorkProjectsReadOptions = {}): Promise<WorkProjectsRead> {
    const listed = await this.list(fromStore && !force);
    const connection = await this.orgs();
    const byOwner = new Map<string, ProjectOwner>(listed.owners.map((o) => [o.login.toLowerCase(), o]));
    const account = listed.owners.find((o) => o.ownerType === 'user') ?? null;

    // #609 The entries in order: granted, then the ones that restrict the app, then the ones GitHub refused, the account last.
    const entries: WorkBoardOrganization[] = [];
    const seen = new Set<string>();
    const add = (entry: WorkBoardOrganization) => {
      if (seen.has(entry.login.toLowerCase())) return;
      seen.add(entry.login.toLowerCase());
      entries.push(entry);
    };
    const warning = (login: string, state: 'restricted' | 'saml' | 'failed', reason: OwnerBlockReason | GithubFailure, urls: { approvalUrl: string; requestUrl: string } | null = null): WorkBoardOrganization => ({
      login,
      own: false,
      state,
      readAt: null,
      projects: [],
      reason,
      ...(urls ?? {}),
    });
    const pending = connection.flatMap((o) => (o.access === 'pending' ? [o] : []));
    for (const o of pending) add(warning(o.login, 'restricted', 'oauth-restricted', { approvalUrl: o.approvalUrl, requestUrl: o.requestUrl }));
    for (const o of listed.owners) {
      if (!o.blocked || o.ownerType !== 'organization') continue;
      this.log(`work board: ${o.login} refused its Projects: ${o.blocked.message}`);
      add(warning(o.login, OWNER_REASON[o.blocked.reason], o.blocked.reason));
    }
    const granted = connection.flatMap((o) => (o.access === 'granted' && !seen.has(o.login.toLowerCase()) ? [o.login] : []));
    const toRead: { login: string; own: boolean }[] = granted.map((login) => ({ login, own: false }));
    if (account && account.blocked === null) toRead.push({ login: account.login, own: true });
    else if (account?.blocked) {
      this.log(`work board: ${account.login} refused its Projects: ${account.blocked.message}`);
      entries.push({ ...warning(account.login, OWNER_REASON[account.blocked.reason], account.blocked.reason), own: true });
    }

    const boards: WorkProjectRead[] = [];
    const failures = new Map<string, GithubFailure>();
    let tried = 0;
    let failedProjects = 0;
    for (const { login, own } of toRead) {
      const projects = readableProjects(listed.projects, login);
      const entry: WorkBoardOrganization = { login: byOwner.get(login.toLowerCase())?.login ?? login, own, state: 'read', readAt: null, projects: [] };
      let readAt: number | null = null;
      for (const p of projects) {
        tried += 1;
        const source = this.project({ owner: p.owner, number: p.number });
        let board: ProjectBoard | null = null;
        try {
          board = (fromStore && !force ? await source.snapshot?.() : null) ?? (await source.board({ force }));
        } catch (err) {
          this.log(`work board: Project ${p.owner}/${p.number} not read: ${err instanceof Error ? err.message : String(err)}`);
          failures.set(entry.login, githubFailureOf(err));
          failedProjects += 1;
          continue;
        }
        if (board.stale && board.staleCode && board.staleCode !== 'sync-pending') {
          failures.set(entry.login, board.staleCode);
          failedProjects += 1;
          if (board.staleReason) this.log(`work board: Project ${p.owner}/${p.number} stale: ${board.staleReason}`);
        }
        boards.push({ organization: entry.login, board });
        entry.projects.push({ owner: p.owner, number: p.number, title: board.title || p.title });
        readAt = readAt === null ? board.fetchedAt : Math.min(readAt, board.fetchedAt);
      }
      entry.readAt = readAt;
      add(entry);
    }

    // #609 The organizations with Projects first, then the ones with a warning, the person's account last (a stable sort).
    const rank = (e: WorkBoardOrganization) => (e.own ? 2 : e.projects.length ? 0 : 1);
    const ordered = [...entries].sort((a, b) => rank(a) - rank(b));
    // #609 GitHub being down is every Project tried failing; otherwise each owner with a failed Project is a warning.
    let stale = false;
    let staleCode: StaleCode | null = null;
    if (tried > 0 && failedProjects === tried) {
      const code = [...failures.values()][0] ?? 'github-error';
      if (!boards.length) throw new NoDataError(`no Project of any organization could be read: ${code}`, { failure: code });
      stale = true;
      staleCode = code;
    } else {
      for (const e of ordered) {
        const code = failures.get(e.login);
        if (code) Object.assign(e, { state: 'failed', reason: code });
      }
    }

    this.owners = ordered.filter((e) => e.state === 'read' && e.projects.length > 0).map((e) => e.login.toLowerCase());
    const stored = boards.map((b) => b.board.fetchedAt);
    return { organizations: ordered, boards, fetchedAt: stored.length ? Math.min(...stored) : this.now(), stale, staleCode };
  }

  /** #609 The list of Projects: the stored one for a read from the store, else through the 1 h cache. */
  private async list(fromStore: boolean): Promise<ProjectOptionsList> {
    return (fromStore ? await this.options.snapshot() : null) ?? (await this.options.list());
  }
}

/** #609 The open Projects of an owner that have a Status field, by number. */
function readableProjects(projects: readonly ProjectOption[], login: string): ProjectOption[] {
  return projects.filter((p) => p.owner.toLowerCase() === login.toLowerCase() && !p.closed && p.hasStatusField).sort((a, b) => a.number - b.number);
}

/**
 * The background sync's step for the Projects of every organization (#609): forces the read of each one so the board
 * answers from the store. A read where GitHub did not answer fails, as the `project` step does, so the sync log says it.
 */
export function workProjectsSyncStep(projects: WorkBoardProjects, connected: () => Promise<boolean>): SyncStep {
  return {
    name: 'work-projects',
    everyMs: SYNC_WORK_PROJECTS_EVERY_MS,
    async run() {
      if (!(await connected().catch(() => false))) return 'skipped';
      const read = await projects.read({ force: true });
      if (read.stale) throw new Error(`the Projects were not read: ${read.staleCode ?? 'github-error'}`);
      return 'done';
    },
  };
}

/**
 * #609 the core's wiring of the reader: built when the connection has GitHub access and the Projects list is there, never
 * under --demo (the simulator has one Project) nor --no-github (no access); `null` otherwise, and the board reads its one
 * chosen Project. Each Project is read through the same cache entry as the chosen-Project kanban, with the connection's token.
 */
export function createWorkBoardProjects(o: {
  demo: boolean;
  projectOptions: WorkBoardProjectsOptions['options'] | null | undefined;
  access: GithubAccess | null;
  connection: { status(): Promise<{ orgs?: readonly GithubOrg[] }> };
  cache: GithubCache;
  log?: (message: string) => void;
}): WorkBoardProjects | null {
  const { access, projectOptions } = o;
  if (o.demo || !projectOptions || !access) return null;
  return new WorkBoardProjects({
    options: projectOptions,
    orgs: async () => (await o.connection.status()).orgs ?? [],
    project: (ref) => createGithubProject({ project: ref, cache: o.cache, token: access.token, ...(access.fetch ? { fetch: access.fetch } : {}), ...(access.url ? { url: access.url } : {}) }),
    ...(o.log ? { log: o.log } : {}),
  });
}

/** #609 the sync steps of the reader: the `work-projects` step, or none when the core has no reader. */
export function workProjectsSyncSteps(projects: WorkBoardProjects | null, connected: () => Promise<boolean>): SyncStep[] {
  return projects ? [workProjectsSyncStep(projects, connected)] : [];
}
