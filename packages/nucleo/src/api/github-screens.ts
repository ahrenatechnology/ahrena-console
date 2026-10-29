// Every GitHub-backed screen of the core, built in one place (#241, decision 0011 §4-5): the
// Repositories screen, the Instructions tab, the framework install, the ADRs and PDRs, the Dev
// Console, the Delivery tab, the project kanban (through the Project resolver) and the list of
// Projects to choose from. They all take the credential from the one provider (`github.token`).
//
// Identity change (disconnect, connecting a different login, switching the credential source): no
// data read with the previous identity may be served afterwards. `resetIdentity()` deletes every row
// of `github_cache` (a superset of "the keys read with it": one credential is active per
// installation), drops the reads in flight and the rate-limit pause, and builds the services again.
// The routes handed to the server are stable functions that delegate to the current services, so the
// server never holds a service built with the previous identity. The session → repository map is
// not rebuilt: it comes from git, not from GitHub.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCoreDecisions, type AccountRepos, type DecisionsRoute } from './adrs.ts';
import { createCoreAgentInstructions, type AgentInstructionsRoute } from './agent-instructions.ts';
import type { DeliveryOptions } from './analytics-route.ts';
import { createCoreDelivery } from './delivery-github.ts';
import { createCoreFrameworkInstall, type FrameworkInstallRoute } from './framework-install.ts';
import type { GithubAccess } from './github-access.ts';
import { criarReposDoNucleo, type RotaDosRepos } from './repos.ts';
import type { SessoesPorRepo } from './repos-sessions.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import { createDevConsole, disabledDevConsoleSource, GithubDevConsoleSource, type CreateDevConsoleOptions, type DevConsole } from '../dev-console/index.ts';
import type { GithubCache } from '../github/cache.ts';
import type { GithubCallQueue } from '../github/call-queue.ts';
import { createGithubProject, GithubProject } from '../github/project.ts';
import { GithubProjectOptionsSource, ProjectOptions } from '../github/project-options.ts';
import { ProjectResolver } from '../github/project-selection.ts';
import type { FleetReader } from '../mcp/fleet.ts';
import type { InstallationSettings } from '../settings/installation-settings.ts';
import { DEV_CONSOLE_SIMULATOR_CONTEXTS, devConsoleSimulatorGit, SimulatedDevConsoleSource } from '../simulator/dev-console.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, FAKE_GITHUB_BASE } from '../simulator/fake-github.ts';
import { SIMULATOR_PROJECT, SimulatorProject } from '../simulator/project.ts';
import { SYNC_DECISIONS_EVERY_MS, SYNC_PROJECT_EVERY_MS, type SyncStep } from '../github/background-sync.ts';

export interface GithubScreensOptions {
  /** --demo: each screen's fake GitHub; the credential still comes from `github` when given. */
  demo: boolean;
  /** --no-github: no transport, the screens answer their `no-github` states. */
  noGithub: boolean;
  /** The credential provider (and, in tests, the transport). Required outside the demo and --no-github. */
  github: GithubAccess | null;
  /** The core's GitHub cache over `github_cache` (decision 0001): one instance for every screen. */
  cache: GithubCache;
  /** Other caches over the same table, cleared with it on an identity change. */
  otherCaches?: GithubCache[];
  queue: GithubCallQueue;
  changes: ChangeCursor;
  fleet: FleetReader;
  storage: CreateDevConsoleOptions['storage'];
  decisions?: CreateDevConsoleOptions['decisions'];
  /** The installation settings (`project.selection`). */
  settings: InstallationSettings;
  /** For `AHRENA_CONSOLE_PROJECT`. */
  env?: NodeJS.ProcessEnv;
  /** `AHRENA_CONSOLE_FRAMEWORK_REPO`. */
  frameworkRepo?: string;
  /** --demo-project: whether the demo starts with the simulator's Project selected. Default true. */
  demoProject?: boolean;
  /** Overrides for the Dev Console outside the demo (tests pass `file: null`). */
  devConsole?: Partial<Pick<CreateDevConsoleOptions, 'file' | 'contexts' | 'git'>>;
  /** Called after every rebuild, for memory held outside these screens (e.g. the panel's work by branch). */
  onReset?: () => void;
  /** Decision 0015: a background sync keeps the ADRs and PDRs fresh, so a read never starts a build. */
  backgroundSync?: boolean;
  log?: (message: string) => void;
}

/** The services of one identity. */
export interface GithubScreenServices {
  repos: ReturnType<typeof criarReposDoNucleo>['repos'];
  reposRoute: RotaDosRepos;
  agentInstructions: ReturnType<typeof createCoreAgentInstructions>['service'];
  agentInstructionsRoute: AgentInstructionsRoute;
  frameworkInstall: ReturnType<typeof createCoreFrameworkInstall>['service'];
  frameworkInstallRoute: FrameworkInstallRoute;
  decisions: ReturnType<typeof createCoreDecisions>['service'];
  decisionsRoute: DecisionsRoute;
  devConsole: DevConsole;
  delivery: DeliveryOptions;
  sessions: SessoesPorRepo;
}

export interface GithubScreens {
  /** Stable routes and objects for the server; each delegates to the current services. */
  repos: RotaDosRepos;
  agentInstructions: AgentInstructionsRoute;
  frameworkInstall: FrameworkInstallRoute;
  decisions: DecisionsRoute;
  devConsole: Pick<DevConsole, 'overview' | 'view'>;
  delivery: DeliveryOptions;
  sessions: SessoesPorRepo;
  /** The project kanban's Project (env > setting > demo > none); `null` under --no-github. */
  project: ProjectResolver<GithubProject> | null;
  /** The Projects the account sees; `null` under --no-github. */
  projectOptions: ProjectOptions | null;
  /** The services in use now. */
  current(): GithubScreenServices;
  /** The GitHub identity changed: clear `github_cache` and in-flight reads, then build every service again. */
  resetIdentity(): Promise<void>;
}

export function createGithubScreens(o: GithubScreensOptions): GithubScreens {
  const { demo, noGithub, github, cache, queue, changes, log } = o;
  if (!demo && !noGithub && !github) throw new TypeError('the GitHub screens need the github access (credential provider)');

  const project: ProjectResolver<GithubProject> | null = noGithub
    ? null
    : new ProjectResolver({
        env: o.env ?? process.env,
        settings: o.settings,
        demoSelection: demo && o.demoProject !== false ? SIMULATOR_PROJECT : null,
        build: (selection) =>
          demo
            ? new GithubProject({ source: new SimulatorProject(), cache, project: selection })
            : createGithubProject({
                project: selection,
                cache,
                token: github!.token,
                ...(github!.fetch ? { fetch: github!.fetch } : {}),
                ...(github!.url ? { url: github!.url } : {}),
              }),
      });

  const projectOptions = noGithub
    ? null
    : new ProjectOptions({
        source: new GithubProjectOptionsSource(
          demo
            ? { token: github?.token ?? 'demo', fetch: createFakeGithub(DEMO_GITHUB_DATA).fetch, url: `${FAKE_GITHUB_BASE}/graphql` }
            : { token: github!.token, ...(github!.fetch ? { fetch: github!.fetch } : {}), ...(github!.url ? { url: github!.url } : {}) },
        ),
        cache,
        queue,
      });

  let sessions: SessoesPorRepo | undefined;

  const build = (): GithubScreenServices => {
    const repos = criarReposDoNucleo({ demo, semGithub: noGithub, cache, frota: o.fleet, mudancas: changes, log, queue, github, sessions });
    sessions = repos.sessions;
    const accountRepos = async () => {
      const l = await repos.repos.lista();
      return l.groups.flatMap((g) => g.repos.map((r) => ({ fullName: r.fullName, lastPush: r.lastPush })));
    };
    const delivery = createCoreDelivery({
      demo,
      noGithub,
      cache,
      queue,
      changes,
      sessions: repos.sessions,
      boards: async () => {
        const kanban = project?.kanban();
        return kanban ? [await kanban.board()] : [];
      },
      accountRepos,
      github,
      ...(log ? { log } : {}),
    });
    const agentInstructions = createCoreAgentInstructions({ demo, noGithub, cache, changes, queue, github, ...(log ? { log } : {}) });
    const frameworkInstall = createCoreFrameworkInstall({ demo, noGithub, cache, changes, queue, frameworkRepo: o.frameworkRepo, github, ...(log ? { log } : {}) });
    const decisions = createCoreDecisions({
      demo,
      noGithub,
      cache,
      changes,
      queue,
      github,
      syncOnRead: !o.backgroundSync,
      ...(log ? { log } : {}),
      accountRepos: async (): Promise<AccountRepos> => {
        const l = await repos.repos.lista();
        return { state: l.state, error: l.error, account: l.account, repos: l.groups.flatMap((g) => g.repos.map((r) => ({ owner: r.owner, name: r.name, lastPush: r.lastPush }))) };
      },
    });
    const devConsole = createDevConsole({
      storage: o.storage,
      frota: o.fleet,
      decisions: o.decisions ?? null,
      cache,
      source: demo ? new SimulatedDevConsoleSource() : github && !noGithub ? new GithubDevConsoleSource({ token: github.token, ...(github.fetch ? { fetch: github.fetch } : {}), ...(github.url ? { url: github.url } : {}) }) : disabledDevConsoleSource(),
      ...(demo ? { file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit } : (o.devConsole ?? {})),
    });
    return {
      repos: repos.repos,
      reposRoute: repos.rota,
      agentInstructions: agentInstructions.service,
      agentInstructionsRoute: agentInstructions.route,
      frameworkInstall: frameworkInstall.service,
      frameworkInstallRoute: frameworkInstall.route,
      decisions: decisions.service,
      decisionsRoute: decisions.route,
      devConsole,
      delivery,
      sessions: repos.sessions,
    };
  };

  let current = build();
  const stableSessions = current.sessions;

  return {
    repos: (res: ServerResponse, url: URL) => current.reposRoute(res, url),
    agentInstructions: (res: ServerResponse, url: URL) => current.agentInstructionsRoute(res, url),
    frameworkInstall: (req: IncomingMessage, res: ServerResponse, url: URL) => current.frameworkInstallRoute(req, res, url),
    decisions: (res: ServerResponse, url: URL) => current.decisionsRoute(res, url),
    devConsole: {
      overview: (...args: Parameters<DevConsole['overview']>) => current.devConsole.overview(...args),
      view: (...args: Parameters<DevConsole['view']>) => current.devConsole.view(...args),
    },
    delivery: {
      github: { read: (repos) => current.delivery.github.read(repos) },
      repoOfCwd: (cwd) => stableSessions.repoDe(cwd),
      projects: () => current.delivery.projects!(),
      accountRepos: () => current.delivery.accountRepos!(),
    },
    sessions: stableSessions,
    project,
    projectOptions,
    current: () => current,
    async resetIdentity() {
      await Promise.all([cache, ...(o.otherCaches ?? [])].map((c) => c.clear()));
      project?.reset();
      current = build();
      o.onReset?.();
    },
  };
}

/**
 * The background sync's steps over these screens (decision 0015): the chosen Project's board every
 * 2 min and the ADR/PDR index every 15 min. `connected` is the core's GitHub connection; without it
 * both steps are skipped.
 */
export function githubSyncSteps(screens: Pick<GithubScreens, 'project' | 'current'>, connected: (() => Promise<boolean>) | null): SyncStep[] {
  const ready = async () => (connected ? connected().catch(() => false) : false);
  return [
    {
      name: 'project',
      everyMs: SYNC_PROJECT_EVERY_MS,
      async run() {
        const kanban = screens.project?.kanban();
        if (!kanban || !(await ready())) return 'skipped';
        const board = await kanban.board({ force: true });
        if (board.stale) throw new Error(board.staleReason ?? 'o GitHub não respondeu; ficou o quadro guardado');
        return 'done';
      },
    },
    {
      name: 'decisions',
      everyMs: SYNC_DECISIONS_EVERY_MS,
      async run() {
        if (!(await ready())) return 'skipped';
        return screens.current().decisions.sync();
      },
    },
  ];
}
