#!/usr/bin/env node
// Starts the core's local API: imports the history, follows the transcripts, receives the hooks, runs
// the state machine and answers the panel, all on 127.0.0.1. `npm run api -- --help`; the options are
// in cli-options.ts (the old Portuguese names still work until phase 6 of #173).
//
// One core per machine (#86, src/owner/): if one is already up, this process adopts it (prints the
// port and version and exits 0) instead of starting another.
//
// The adoption lines (`… (adotado)`, `atenção: …`, the port that already has a core, `…; saindo`) stay in
// pt-BR for now: test/owner asserts them, and that layer renames them.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseApiOptions } from './cli-options.ts';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { HookDecisionCapture } from '../decisions/capture-hooks.ts';
import { SqliteDecisionStore } from '../decisions/sqlite.ts';
import { SessionStateMachine } from '../states/machine.ts';
import { createMcpServer } from '../mcp/index.ts';
import { GithubCache } from '../github/cache.ts';
import { ghCliToken, GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { createGithubProject, GithubProject, type ProjectRef } from '../github/project.ts';
import { defaultProjectsRoot } from '../ingest/history/files.ts';
import { followTranscripts } from '../ingest/history/follower.ts';
import { Profiles } from '../profiles/profiles.ts';
import { registerClient } from '../owner/clients.ts';
import { isOlderCommit } from '../owner/commit.ts';
import { claimLock, codeWarning, planStart, watchParent } from '../owner/owner.ts';
import { waitForCore, isPidAlive, reservePort, releasePort } from '../owner/probe.ts';
import { readLock, releaseLock, defaultDir, prepareDir } from '../owner/lock.ts';
import { ChangeCursor } from '../changes/cursor.ts';
import { onMachineChange, withChanges, SessionAccounts, decisionsWithChanges } from '../changes/sources.ts';
import { waitForChanges } from '../changes/mcp.ts';
import {
  demoAlias,
  PANEL_SCENARIOS,
  SimulatorWorkSource,
  demoRecordFolders,
  seedPanelScenario,
  seedPanelDecisions,
  type PanelScenario,
} from '../simulator/panel.ts';
import { seedDemoWorkflows } from '../simulator/workflows.ts';
import { seedPanelHistory } from '../simulator/history-ended.ts';
import { SessionHistory } from '../history/reading.ts';
import { SIMULATOR_PROJECT, SimulatorProject } from '../simulator/project.ts';
import { seedHistory } from '../simulator/history.ts';
import { demoLocal, seedDetail } from '../simulator/detail.ts';
import { upgradeDemoUrl } from '../simulator/legacy-ids.ts';
import { mountDemoAgentConfig, knownProjects } from '../agent-config/index.ts';
import { createAgentConfigRoute } from './agent-config.ts';
import { Accounts } from './accounts.ts';
import { DecisoesDaUi } from './decisions-ui.ts';
import { QuadroKanban } from './kanban.ts';
import { LeiturasDoDetalhe } from './session-detail.ts';
import { DesktopIndex } from './desktop-index.ts';
import { RotaAnalytics } from './analytics-route.ts';
import { MontadorDoPainel } from './panel.ts';
import {
  capturarDoTranscript,
  LIMPEZA_DAS_DECISOES,
  limparDecisoes,
  REPROCESSAMENTO,
  REPROCESSAMENTO_DO_CONTEXTO,
  reprocessarContexto,
  reprocessarHistorico,
} from './reprocessing.ts';
import { criarReposDoNucleo } from './repos.ts';
import { startLocalApi, API_VERSION, type LocalApi } from './server.ts';
import { ListaDeSessoes } from './sessions.ts';
import { FeedDeEventos } from './events.ts';
import { TrabalhoPorBranch } from './work.ts';
import { createDevConsole, disabledDevConsoleSource, GithubDevConsoleSource } from '../dev-console/index.ts';
import { DEV_CONSOLE_SIMULATOR_CONTEXTS, devConsoleSimulatorGit, SimulatedDevConsoleSource } from '../simulator/dev-console.ts';
import { AlertTracker } from '../telemetry/alerts.ts';
import { collectorFor } from '../telemetry/adapters/system.ts';
import { SqliteTelemetryStore } from '../telemetry/adapters/sqlite.ts';
import { publishAlertChanges, TelemetrySampler } from '../telemetry/sampler.ts';
import { localMachine, TelemetryService, type MachineEntry } from '../telemetry/service.ts';
import { loadMachinesConfig } from '../telemetry/machines-config.ts';
import { publishRemoteAttentionChanges, RemoteMachine } from '../telemetry/remote.ts';
import { loopbackGet } from '../telemetry/adapters/loopback-http.ts';
import type { TelemetryCollector } from '../telemetry/ports.ts';
import { SIMULATED_WORKSTATION, SimulatedCollector, seedTelemetry } from '../simulator/telemetry.ts';

const o = parseApiOptions(process.argv.slice(2));
if (o.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
const port = Number(o.port ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
const demo = o.demo;
const parent = o.parent === undefined ? null : Number(o.parent);
if (parent !== null && !(Number.isInteger(parent) && parent > 0)) throw new Error('--parent: a pid');
if (parent !== null && !isPidAlive(parent)) throw new Error(`--parent: pid ${parent} does not exist`);
const useLock = !demo && !o.noLock;
const commit = checkoutCommit();
const code = { version: API_VERSION, commit, isOlderCommit };

function adopt(p: number, version: string, warning: string | null = null): never {
  if (warning) log(`atenção: ${warning}`);
  if (parent !== null && useLock) registerClient(parent);
  process.stdout.write(`núcleo de pé em http://127.0.0.1:${p} · versão ${version} (adotado)\n`);
  process.exit(0);
}

// Before opening the database: adopts the live core of the lock, or recovers the lock if it is an orphan.
if (useLock) {
  const plan = await planStart({ ...code, replace: o.replace, log });
  if (plan.action === 'adopt') adopt(plan.lock.port, plan.lock.version, plan.warning);
  if (plan.recovered) log(`orphan lock recovered: ${plan.recovered}`);
}

// The port has a single owner: whoever does not get it waits for the core that did and adopts it.
// --demo and --no-lock do not adopt: whoever asks for the demo never gets the real core, nor the opposite.
async function adoptPortHolder(): Promise<never> {
  const v = await waitForCore(port, 30_000);
  if (v && !useLock) {
    log(`a porta ${port} já tem um núcleo (pid ${v.pid ?? '?'}); ${demo ? 'a --demo' : 'a --sem-trava'} precisa de uma porta livre: use --porta`);
    process.exit(1);
  }
  if (v) {
    // Whoever won the port writes the lock right after listening: waits a little before saying it has none.
    let lockless = v.pid === null;
    for (let i = 0; !lockless && v.pid !== lockPidOfPort(); i++) {
      if (i === 20) lockless = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    const warning = [lockless ? 'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)' : null, codeWarning(v, code)];
    adopt(port, v.version, warning.filter(Boolean).join('; ') || null);
  }
  log(`port ${port} is in use and does not answer as a core`);
  process.exit(1);
}
/** The pid in the lock, when the lock is for this port. */
function lockPidOfPort(): number | null {
  const t = readLock();
  return t && t !== 'invalid' && t.port === port ? t.pid : null;
}
const reservation = await reservePort(port);
if (reservation === 'in-use') await adoptPortHolder();
const dbPath = demo ? ':memory:' : (o.db ?? process.env.AHRENA_CONSOLE_DB ?? join(homedir(), '.ahrena-console', 'nucleo.sqlite'));
if (dbPath !== ':memory:') {
  // The core's folder is closed to 0700 (the database lives in it); another folder given in --db stays as it is.
  if (dirname(dbPath) === defaultDir()) prepareDir();
  else mkdirSync(dirname(dbPath), { recursive: true });
}

// Every write goes through the change cursor (item 2.4): the long polling comes from it.
const changes = new ChangeCursor();
const sqlite = openSqliteStorage({ path: dbPath });
const sessionAccounts = new SessionAccounts(sqlite);
const storage = withChanges(sqlite, changes, sessionAccounts);
// The session decisions (#99) in the same database: the hooks capture, the panel reads and confirms (#102).
const decisions = decisionsWithChanges(new SqliteDecisionStore(sqlite.db), changes, sessionAccounts);
const capture = new HookDecisionCapture({ decisions });
const machine = new SessionStateMachine({
  storage,
  log,
  onChange: onMachineChange(changes, sessionAccounts),
  ...(demo ? { probe: null } : {}),
});
const desktop = demo || o.noDesktop ? null : new DesktopIndex();
const workSource = demo ? new SimulatorWorkSource() : o.noGithub ? null : new GithubGraphqlSource({ token: () => ghCliToken() });
// A single GitHub cache, in the database, for the work and the repositories: a rate-limit pause holds for both.
const githubCache = new GithubCache({ store: new SqliteCacheStore(storage.db) });
const work = new TrabalhoPorBranch({
  fonte: workSource,
  cache: githubCache,
  ...(demo ? { git: SimulatorWorkSource.git } : {}),
});
// The project kanban (#80): C11's fake GitHub under --demo; otherwise the Project of AHRENA_CONSOLE_PROJECT.
// Without the variable there is no default Project: the screen explains how to pick one.
function projectFromEnv(value = process.env.AHRENA_CONSOLE_PROJECT ?? ''): ProjectRef | null {
  if (!value.trim()) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\d{1,9})$/.exec(value.trim());
  if (!m) throw new Error(`AHRENA_CONSOLE_PROJECT: owner/number, like my-org/3 (got "${value}")`);
  return { owner: m[1], number: Number(m[2]) };
}
const chosenProject = demo || o.noGithub ? null : projectFromEnv();
const projectCache = new GithubCache({ store: new SqliteCacheStore(storage.db) });
const kanban = demo
  ? new GithubProject({ source: new SimulatorProject(), cache: projectCache, project: SIMULATOR_PROJECT })
  : chosenProject
    ? createGithubProject({ project: chosenProject, cache: projectCache, token: () => ghCliToken() })
    : null;

// The commit of the API's checkout, so the panel footer says which version is live.
function checkoutCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// The folder's commit now, checked at most every 30 s: if it changed since the start, the footer warns.
let folder = { at: 0, commit: null as string | null };
function folderCommit(): string | null {
  if (Date.now() - folder.at > 30_000) folder = { at: Date.now(), commit: checkoutCommit() };
  return folder.commit;
}

// On macOS, the API opens the conversation in the Claude Desktop: `open` with the address as argument, no shell.
const openInDesktop =
  process.platform === 'darwin' && !demo
    ? (url: string) =>
        new Promise<void>((resolve, reject) => execFile('open', [url], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve())))
    : null;

// The same `Accounts` in the panel and in the MCP: the "conta 1" label is the same on both surfaces.
const accounts = new Accounts({ storage, ...(demo ? { file: null } : {}) });
const panelBuilder = new MontadorDoPainel({
  commit,
  commitDaPasta: folderCommit,
  abreSessao: openInDesktop !== null,
  storage,
  contas: accounts,
  desktop,
  trabalho: work,
  decisoes: decisions,
  ...(demo ? { apelido: demoAlias } : {}),
});

// The /ui's Decisions page and tab (#103). In the demo, Promote writes to a temporary folder, created
// now and deleted on exit, instead of /simulacao; outside the demo, to the decision's own repository.
const demoFolder = demo ? mkdtempSync(join(tmpdir(), 'ahrena-console-demo-')) : null;
const decisionsUi = new DecisoesDaUi({
  decisions,
  storage,
  // The tab and Promote see the session as the panel's Confirm does: the same rule, the builder's.
  alvoDe: (id) => panelBuilder.alvoDaSessao(id),
  ...(demoFolder ? { raiz: demoRecordFolders(demoFolder) } : {}),
  localDe: async (id) => {
    await desktop?.refresh();
    return desktop?.sessionByCli(id)?.localId ?? null;
  },
});

if (demo) {
  const scenario = o.scenario as PanelScenario;
  if (!PANEL_SCENARIOS.includes(scenario)) throw new Error(`--scenario: one of ${PANEL_SCENARIOS.join(', ')}`);
  await seedPanelScenario(storage, scenario);
  await seedPanelDecisions(decisions, scenario);
  if (scenario === 'p4') await seedDemoWorkflows(storage); // #96 and #97: the sessions of the Workflows screens
  // Simulated history (fixed seed, from yesterday backwards) for the Analytics screen charts.
  await seedHistory(storage);
  await seedDetail(storage);
  await seedPanelHistory(storage, decisions, scenario);
}
const detail = new LeiturasDoDetalhe({ storage, montador: panelBuilder, ...(demo ? { local: demoLocal } : {}) });

// The history of the ended sessions (#33), with the Desktop index title when there is one.
const history = new SessionHistory({ storage, decisions, titleOf: (s) => desktop?.sessionByCli(s.id)?.title ?? null });

// Profiles: the current account of each configuration folder goes to the port, with the org name
// as its label. Re-read every minute, to pick up a new `claude auth login`.
const profiles = demo ? null : new Profiles({ storage });
const syncProfiles = () =>
  profiles
    ?.sync()
    .then((ps) => ps.length)
    .catch((e) => (log(`profiles: ${(e as Error).message}`), 0));
if (profiles) log(`profiles: ${await syncProfiles()} configuration folder(s)`);
// The Agent Config screen (#63): the profiles' folders and the sessions' cwd; in the demo, fictitious folders.
const demoAgentConfig = demo ? mountDemoAgentConfig() : null;
if (demoAgentConfig) process.once('exit', demoAgentConfig.remove);
const agentConfig = demoAgentConfig
  ? createAgentConfigRoute({ folders: async () => demoAgentConfig.folders, projects: async () => [demoAgentConfig.project], backups: demoAgentConfig.backups, log })
  : createAgentConfigRoute({ folders: () => profiles!.list(), projects: () => knownProjects(storage), log });
const profileTimer = profiles ? setInterval(() => void syncProfiles(), 60_000) : null;
profileTimer?.unref();

// New tools (e.g. `wait_for_changes`, 2.4) come in here with `mcp.server.register(...)`.
const mcp = createMcpServer({ storage, accounts, desktop, log });
mcp.server.register(waitForChanges({ changes, accounts }));
const repos = criarReposDoNucleo({ demo, semGithub: o.noGithub, cache: githubCache, frota: mcp.fleet, mudancas: changes, log });

// The Dev Console (#177): the synthetic context and the fake GitHub under --demo; otherwise GitHub through the 0001 cache.
const devConsole = createDevConsole({
  storage,
  frota: mcp.fleet,
  decisions,
  cache: githubCache,
  source: demo ? new SimulatedDevConsoleSource() : o.noGithub ? disabledDevConsoleSource() : new GithubDevConsoleSource(),
  ...(demo ? { file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit } : {}),
});

// Machine telemetry (#175, decision 0008): one sample every 30 s, 12 h in the database, and each
// alert that enters or exits on /api/changes. In --demo, the simulator's synthetic readings, with
// 12 h already seeded, plus a synthetic "workstation". Outside the demo, each remote machine of
// machines.json (#176) is read every 30 s through the port the user's tunnel forwards.
const sampleStore = new SqliteTelemetryStore(sqlite.db);
const alertTracker = new AlertTracker();
const machineEntries: MachineEntry[] = [localMachine()];
const samplers: TelemetrySampler[] = [];
const remoteMachines: RemoteMachine[] = [];
function addSampler(machineId: string, collector: TelemetryCollector) {
  samplers.push(new TelemetrySampler({ machineId, collector, store: sampleStore, tracker: alertTracker, onAlertChange: publishAlertChanges(changes), log }));
}
if (demo) {
  machineEntries.push({ ...SIMULATED_WORKSTATION, state: () => 'connected' });
  await seedTelemetry(sampleStore, 'local', 'local');
  await seedTelemetry(sampleStore, SIMULATED_WORKSTATION.id, 'workstation');
  addSampler('local', new SimulatedCollector('local'));
  addSampler(SIMULATED_WORKSTATION.id, new SimulatedCollector('workstation'));
} else if (!o.noTelemetry) {
  const platformCollector = collectorFor();
  if (platformCollector) addSampler('local', platformCollector);
  else log(`telemetry: no collector for ${process.platform}`);
  const machinesConfig = await loadMachinesConfig({ ...(o.machines ? { file: o.machines } : {}), log });
  const get = loopbackGet();
  for (const config of machinesConfig.machines) {
    if (config.port === port) {
      log(`machines: ${config.id} uses port ${config.port}, this core's own; skipped`);
      continue;
    }
    const remote = new RemoteMachine({
      config,
      get,
      store: sampleStore,
      tracker: alertTracker,
      onAlertChange: publishAlertChanges(changes),
      onAttentionChange: publishRemoteAttentionChanges(changes),
      log,
    });
    remoteMachines.push(remote);
    machineEntries.push(remote);
  }
  if (remoteMachines.length > 0) log(`telemetry: ${remoteMachines.length} remote machine(s): ${remoteMachines.map((m) => `${m.id} on port ${m.port}`).join(', ')}`);
}
const telemetryService = samplers.length > 0 || remoteMachines.length > 0 ? new TelemetryService({ store: sampleStore, tracker: alertTracker, machines: machineEntries }) : null;

let historyReady = false;
const follower =
  demo || o.noHistory
    ? null
    : followTranscripts({
        storage,
        root: o.projects,
        scanIntervalMs: Math.max(1, Number(o.scanInterval) || 30) * 1000,
        // The decisions only the transcript has (answers, plans, refusals), also from sessions without hooks.
        onSession: (session) => capturarDoTranscript(decisions, session).then(() => undefined),
        onError: (e) => log(`follower: ${(e as Error).message}`),
      });

if (reservation !== 'in-use') await releasePort(reservation);
const api: LocalApi = await startLocalApi({
  panelBuilder,
  hooks: {
    storage,
    // The same profiles: the folder a hook reveals enters the next listings.
    profiles: profiles ?? undefined,
    onEvent: async (r) => {
      await machine.onHook(r);
      await capture.onEvent(r.event);
    },
    log,
  },
  port,
  log,
  openInDesktop,
  mcp: mcp.server,
  commit,
  changes,
  decisionsUi,
  project: { kanban, fonte: demo ? 'demo' : 'github', semProjeto: !demo && !o.noGithub && !chosenProject, log },
  detail,
  events: new FeedDeEventos({ storage }),
  fleet: mcp.fleet,
  remoteAttention: remoteMachines,
  analytics: new RotaAnalytics({ storage, contas: accounts, versao: () => changes.current }),
  sessions: new ListaDeSessoes({ storage, contas: accounts, desktop }),
  history,
  kanban: new QuadroKanban({ storage, contas: accounts, desktop }),
  repos: repos.rota,
  // The demo's old session ids (before #173) still open the session (src/simulator/legacy-ids.ts).
  ...(demo ? { demoUrl: upgradeDemoUrl } : {}),
  devConsole,
  agentConfig,
  telemetry: telemetryService,
  load: () => ({
    history: follower ? (historyReady ? 'ready' : 'importing') : 'off',
    follower: follower?.stats() ?? null,
    desktopRead: desktop?.filesRead ?? 0,
    work: work.chamadas,
  }),
}).catch(async (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  await storage.close();
  return adoptPortHolder();
});

const lock = useLock ? await claimLock({ port, version: API_VERSION, parent }) : null;
if (lock && 'conflict' in lock) {
  await api.close().catch(() => undefined);
  await storage.close();
  adopt(lock.conflict.port, lock.conflict.version);
}
log(`local API at ${api.url} · MCP at ${api.url}/mcp${demo ? ` (demo ${o.scenario}: synthetic simulator data)` : ` · database ${dbPath}`}`);

const stopWatchingParent =
  parent === null
    ? () => {}
    : watchParent({
        parent,
        onGone: (reason) => {
          log(`${reason}; saindo`);
          void shutdown();
        },
      });

// The initial import runs after the port already answers: the panel does not wait for the history.
const stopWatcher = demo ? () => {} : machine.start();
for (const a of samplers) a.start();
for (const m of remoteMachines) m.start();
if (follower) {
  follower
    .start()
    .then(() => {
      historyReady = true;
      log(`history imported; following ${o.projects ?? '~/.claude/projects'}`);
      return reprocessOnce();
    })
    .catch((e) => log(`follower did not start: ${(e as Error).message}`));
}

// Once per database, after the initial import: plans and decisions of the sessions imported before the
// capture existed, the cleanup of what the old capture wrote that is not a decision, and the context
// meters of the sessions imported before item 1.7.
async function reprocessOnce() {
  if (!storage.reprocessado(REPROCESSAMENTO)) {
    const start = Date.now();
    const r = await reprocessarHistorico({ storage, decisoes: decisions, raiz: o.projects ?? defaultProjectsRoot(), log });
    storage.marcarReprocessado(REPROCESSAMENTO, new Date().toISOString());
    log(`reprocessed in ${Math.round((Date.now() - start) / 1000)} s: ${r.sessoes} sessions, ${r.planos} plans in ${r.comPlano}, ${r.decisoes} decisions`);
  }
  if (!storage.reprocessado(LIMPEZA_DAS_DECISOES)) {
    const r = await limparDecisoes(storage, decisions);
    storage.marcarReprocessado(LIMPEZA_DAS_DECISOES, new Date().toISOString());
    log(`decisions cleaned: ${r.ruido} outside the lists, ${r.encurtadas} with a shortened title`);
  }
  if (!storage.reprocessado(REPROCESSAMENTO_DO_CONTEXTO)) {
    const r = await reprocessarContexto({ storage, raiz: o.projects ?? defaultProjectsRoot(), log });
    storage.marcarReprocessado(REPROCESSAMENTO_DO_CONTEXTO, new Date().toISOString());
    log(`context meter rebuilt: ${r.medidores} meters in ${r.sessoes} sessions`);
  }
}

async function shutdown() {
  stopWatcher();
  if (profileTimer) clearInterval(profileTimer);
  stopWatchingParent();
  if (lock && !('conflict' in lock)) releaseLock(lock.token);
  await follower?.stop().catch(() => undefined);
  await Promise.all([...samplers, ...remoteMachines].map((a) => a.stop()));
  await api.close().catch(() => undefined);
  await storage.close();
  if (demoFolder) rmSync(demoFolder, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
