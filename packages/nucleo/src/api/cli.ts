#!/usr/bin/env node
// Starts the core's local API: imports the history, follows the transcripts, receives the hooks, runs
// the state machine and answers the panel, all on 127.0.0.1. `npm run api -- --help`; the options are
// in cli-options.ts (the old Portuguese names still work until phase 6 of #173).
//
// One core per installation (#221, decision 0010, src/owner/): if this installation's core is
// already up (the lock in its data folder), this process adopts it (prints the port and version and
// exits 0) instead of starting another. A core of another installation is never adopted. By default
// the port is 0: the system picks a free one, and the core announces it in the log, in the lock and
// in the instance registry (~/.ahrena-console/instances/).
//
// The adoption lines (`… (adotado)`, `atenção: …`, the port that already has a core, `…; saindo`) stay in
// pt-BR for now: test/owner asserts them, and that layer renames them.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseApiOptions } from './cli-options.ts';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { HookDecisionCapture } from '../decisions/capture-hooks.ts';
import { SqliteDecisionStore } from '../decisions/sqlite.ts';
import { SessionStateMachine } from '../states/machine.ts';
import { createMcpServer } from '../mcp/index.ts';
import { GithubCache } from '../github/cache.ts';
import { GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { GITHUB_CALL_LIMIT, GithubCallQueue } from '../github/call-queue.ts';
import { chooseVault, GithubConnection, GithubNotConnectedError } from '../github/connection/index.ts';
import { parseProjectEnv, PROJECT_ENV } from '../github/project-selection.ts';
import { SqliteInstallationSettings } from '../settings/installation-settings.ts';
import { createDemoGithubConnection, parseDemoGithubState } from '../simulator/demo-github-connection.ts';
import { defaultProjectsRoot } from '../ingest/history/files.ts';
import { followTranscripts } from '../ingest/history/follower.ts';
import { Profiles } from '../profiles/profiles.ts';
import { registerClient } from '../owner/clients.ts';
import { isOlderCommit } from '../owner/commit.ts';
import { claimLock, codeWarning, planStart, ReplaceError, watchParent } from '../owner/owner.ts';
import { waitForCore, isPidAlive, reservePort, releasePort } from '../owner/probe.ts';
import { readLock, releaseLock, prepareDir } from '../owner/lock.ts';
import { defaultDataDir, parseInstallation, resolveDataDir, resolvePort } from '../owner/installation.ts';
import { instanceId, listInstances, removeInstance, writeInstance } from '../owner/registry.ts';
import { acquireStartGuard, type StartGuard } from '../owner/start-guard.ts';
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
import { seedHistory } from '../simulator/history.ts';
import { demoLocal, seedDetail } from '../simulator/detail.ts';
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
  DECISION_NOISE_CLEANUP,
  limparDecisoes,
  PLANS_AND_DECISIONS_REPROCESSING,
  CONTEXT_REPROCESSING,
  reprocessarContexto,
  reprocessarHistorico,
} from './reprocessing.ts';
import type { GithubAccess } from './github-access.ts';
import { FRAMEWORK_REPO_ENV } from './framework-install.ts';
import { createCoreGithub, type CoreGithub } from './core-github.ts';
import { startLocalApi, API_VERSION, type LocalApi } from './server.ts';
import { createMessagingRoute } from './messaging.ts';
import { Messaging } from '../messaging/service.ts';
import { SessionOrders } from '../messaging/orders.ts';
import { createOrdersRoute } from './orders.ts';
import { demoMessaging } from '../messaging/demo.ts';
import { SessionsDirectory } from '../messaging/adapters/sessions-dir.ts';
import { SocketInbox } from '../messaging/adapters/socket-inbox.ts';
import { TranscriptTurns } from '../messaging/adapters/transcript-turns.ts';
import { AuditFile, messagingAuditFile } from '../messaging/adapters/audit-file.ts';
import { ListaDeSessoes } from './sessions.ts';
import { ResumosDeSessao } from './summary.ts';
import { FeedDeEventos } from './events.ts';
import { TrabalhoPorBranch } from './work.ts';
import { AlertTracker } from '../telemetry/alerts.ts';
import { collectorFor } from '../telemetry/adapters/system.ts';
import { SqliteTelemetryStore } from '../telemetry/adapters/sqlite.ts';
import { publishAlertChanges, TelemetrySampler } from '../telemetry/sampler.ts';
import { localMachine, TelemetryService, type MachineEntry } from '../telemetry/service.ts';
import { MachinesFileSource } from '../telemetry/machines-config.ts';
import { publishRemoteAttentionChanges, RemoteMachine } from '../telemetry/remote.ts';
import { RemoteMachines } from '../telemetry/remote-machines.ts';
import { INVALID_MACHINES_FILE, publishReconnectChanges, reconnectLogFile, ReconnectRunner } from '../telemetry/reconnect.ts';
import { loopbackGet } from '../telemetry/adapters/loopback-http.ts';
import { MACHINE_READ_ADAPTER_TIMEOUT_MS, MachineReader } from './machine-reader.ts';
import type { TelemetryCollector } from '../telemetry/ports.ts';
import { SqliteToolChecksStore } from '../tools/store.ts';
import { ToolsService } from '../tools/service.ts';
import { MAX_MCP_PROJECTS } from '../tools/mcp-config.ts';
import { publishToolsChanges, ToolsExecutor, toolsLogFile } from '../tools/executor.ts';
import { AwsConnector, publishConnectorChanges } from '../clouds/aws-connector.ts';
import { loopbackWrite } from '../clouds/remote-connectors.ts';
import { createCloudsRoute } from './clouds.ts';
import { createDockerRoute } from './docker.ts';
import { DockerService } from '../docker/service.ts';
import { systemToolRunner } from '../tools/runner.ts';
import { AppUpdateState } from '../app-update/state.ts';
import { createAppUpdateRoute } from './app-update.ts';
import { MachineConnection, publishConnectionChanges } from '../telemetry/connection.ts';
import { PlacementProbe, withPlacement } from '../telemetry/placement.ts';
import { createConnectionRoute } from './connection.ts';
import { LiveClaudeProcesses } from './live-processes.ts';
import { SessionOpenDescriber } from './session-open.ts';
import { createTerminalFocuser, createTerminalOpener } from './terminal-launch.ts';
import { SIMULATED_WORKSTATION, SimulatedCollector, seedTelemetry } from '../simulator/telemetry.ts';

const o = parseApiOptions(process.argv.slice(2));
if (o.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
// The port asked for; 0 (the default) lets the system pick. `boundPort`, below, is the one it got.
const port = resolvePort(o.port);
const installation = parseInstallation(o.installation);
const dataDir = resolveDataDir({ installation, dataDir: o.dataDir });
const demo = o.demo;
// Checked before anything starts: a wrong --demo-github, --demo-project or AHRENA_CONSOLE_PROJECT stops here.
const demoGithubState = parseDemoGithubState(o.demoGithub);
if (o.demoProject !== undefined && o.demoProject !== 'selected' && o.demoProject !== 'none') throw new Error('--demo-project: selected or none');
if (!demo && (o.demoGithub !== undefined || o.demoProject !== undefined)) throw new Error('--demo-github and --demo-project only apply with --demo');
parseProjectEnv(process.env[PROJECT_ENV] ?? '');
const parent = o.parent === undefined ? null : Number(o.parent);
if (parent !== null && !(Number.isInteger(parent) && parent > 0)) throw new Error('--parent: a pid');
if (parent !== null && !isPidAlive(parent)) throw new Error(`--parent: pid ${parent} does not exist`);
const useLock = !demo && !o.noLock;
const commit = checkoutCommit();
const code = { version: API_VERSION, commit, isOlderCommit };
/** The start guard of the data folder, held from before the database opens until the lock is written. */
let startGuard: StartGuard | null = null;
// Until the shutdown below is ready, a signal still exits through `exit`, whose handlers release the
// start guard and the registry entry.
const exitOnSignal = (signal: NodeJS.Signals) => process.exit(signal === 'SIGINT' ? 130 : 143);
process.on('SIGINT', exitOnSignal);
process.on('SIGTERM', exitOnSignal);

function adopt(p: number, version: string, warning: string | null = null): never {
  if (warning) log(`atenção: ${warning}`);
  if (parent !== null && useLock) registerClient(parent, dataDir);
  startGuard?.release();
  process.stdout.write(`núcleo de pé em http://127.0.0.1:${p} · versão ${version} (adotado)\n`);
  process.exit(0);
}

// Before opening the database: adopts the live core of this installation's lock, or recovers the lock
// if it is an orphan.
async function planOrAdopt(): Promise<void> {
  const plan = await planStart({ ...code, dir: dataDir, replace: o.replace, log }).catch((e: unknown) => {
    if (!(e instanceof ReplaceError)) throw e;
    log(e.reason);
    process.exit(1);
  });
  if (plan.action === 'adopt') adopt(plan.lock.port, plan.lock.version, plan.warning);
  if (plan.recovered) log(`orphan lock recovered: ${plan.recovered}`);
}
if (useLock) await planOrAdopt();
// With port 0 two starts of this installation get different ports, and a port-0 start and a
// forced-port start of the same folder do too: the port no longer decides who opens the database.
// The start guard of the data folder does. Whoever holds it looks at the lock again (another start
// may have finished between the first look and the guard), and adopts the core it finds.
if (useLock) {
  process.once('exit', () => startGuard?.release());
  try {
    startGuard = await acquireStartGuard(dataDir);
  } catch (e) {
    await planOrAdopt();
    throw e;
  }
  await planOrAdopt();
  log(`start guard taken for ${dataDir}`);
}

// The port has a single owner: whoever does not get it waits for the core that did and adopts it.
// --demo and --no-lock do not adopt: whoever asks for the demo never gets the real core, nor the opposite.
async function adoptPortHolder(): Promise<never> {
  const v = await waitForCore(port, 30_000);
  if (v && !useLock) {
    log(`a porta ${port} já tem um núcleo (pid ${v.pid ?? '?'}); ${demo ? 'a --demo' : 'a --no-lock'} precisa de uma porta livre: use --port`);
    process.exit(1);
  }
  if (v) {
    // Whoever won the port writes the lock right after listening: waits a little before saying it has none.
    let lockless = v.pid === null;
    for (let i = 0; !lockless && v.pid !== lockPidOfPort(); i++) {
      if (i === 20) lockless = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    // A core of another installation is never adopted (decision 0010): it has its own database.
    if (lockless && isOtherInstallation(v.pid)) {
      log(`port ${port} has the core of another installation (pid ${v.pid}); this one (${installation}, ${dataDir}) needs a free port: use --port`);
      process.exit(1);
    }
    const warning = [lockless ? 'o núcleo nesta porta não tem trava (uma --demo, uma --no-lock ou um núcleo de antes da #86)' : null, codeWarning(v, code)];
    adopt(port, v.version, warning.filter(Boolean).join('; ') || null);
  }
  log(`port ${port} is in use and does not answer as a core`);
  process.exit(1);
}
/** The pid in the lock, when the lock is for this port. */
function lockPidOfPort(): number | null {
  const t = readLock(dataDir);
  return t && t !== 'invalid' && t.port === port ? t.pid : null;
}
/** The same folder, even through a symbolic link (/tmp and /private/tmp on macOS). */
function sameDir(a: string, b: string): boolean {
  const real = (d: string) => {
    try {
      return realpathSync(d);
    } catch {
      return resolve(d);
    }
  };
  return real(a) === real(b);
}
/** The pid is the core of another data folder: in the registry, or holding the `dev` folder's lock. */
function isOtherInstallation(pid: number | null): boolean {
  if (pid === null) return false;
  const registered = listInstances().find((i) => i.pid === pid);
  if (registered) return !sameDir(registered.dataDir, dataDir);
  const devDir = defaultDataDir('dev');
  if (sameDir(devDir, dataDir)) return false;
  const t = readLock(devDir);
  return t !== null && t !== 'invalid' && t.pid === pid;
}
const reserved = await reservePort(port);
const reservation = reserved === 'in-use' ? await adoptPortHolder() : reserved;
const boundPort = (reservation.address() as AddressInfo).port;
const dbPath = demo ? ':memory:' : resolve(o.db ?? process.env.AHRENA_CONSOLE_DB ?? join(dataDir, 'nucleo.sqlite'));
// AHRENA_CONSOLE_DB applies to any installation: two installations with it exported would share a
// database under two locks. Say so.
if (dbPath !== ':memory:' && !sameDir(dirname(dbPath), dataDir)) log(`warning: the database ${dbPath} is outside the data folder ${dataDir} (--db or AHRENA_CONSOLE_DB); another installation must not use the same file`);
if (dbPath !== ':memory:') {
  // The data folder is closed to 0700 (the database lives in it); another folder given in --db stays as it is.
  if (sameDir(dirname(dbPath), dataDir)) prepareDir(dataDir);
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
// The installation settings (#241, decision 0011 §8): the GitHub login, the credential source and the
// Project chosen on the screen. Never a credential.
const settings = new SqliteInstallationSettings(sqlite.db);
// A single queue for the GitHub calls (decision 0001, item 6): the connection's, the screens' and the work's,
// up to `GITHUB_CALL_LIMIT` at once (#341).
const githubQueue = new GithubCallQueue(GITHUB_CALL_LIMIT);
// A single GitHub cache, in the database, for the work and every screen: a rate-limit pause holds for all.
const githubCache = new GithubCache({ store: new SqliteCacheStore(storage.db) });
// The core's GitHub (#241, src/api/core-github.ts): the connection, the credential provider and the
// GitHub-backed screens, built below once the fleet exists. The work by branch takes the same credential.
let coreGithub: CoreGithub | null = null;
const githubAccess: GithubAccess | null =
  o.noGithub && !demo ? null : { token: () => (coreGithub ? coreGithub.connection.token() : Promise.reject(new GithubNotConnectedError())) };
const workSource = demo ? new SimulatorWorkSource() : githubAccess ? new GithubGraphqlSource({ token: githubAccess.token }) : null;
const work = new TrabalhoPorBranch({
  fonte: workSource,
  cache: githubCache,
  ...(demo ? { git: SimulatorWorkSource.git } : {}),
});

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

// #285: where each session opens. The live `claude` processes come from `<config>/sessions/<pid>.json` of
// every configuration folder the profiles know (decision 0006; `profiles` is declared below and only read
// when a request comes). The terminal launchers write their `.command` files in the data folder (0700);
// in the demo there are none, and the route answers with the command to copy.
const liveProcesses = demo ? null : new LiveClaudeProcesses({ folders: async () => ((await profiles?.list()) ?? []).map((p) => p.dir) });
const openDescriber = new SessionOpenDescriber({ live: liveProcesses });
const openTerminal = demo ? null : createTerminalOpener({ dir: join(dataDir, 'terminal-resume') });
const focusTerminal = demo ? null : createTerminalFocuser();

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
// #245: the Sessions list and the Kanban read the same event summaries (a waiting session's attention,
// the last prompt), each session's events once; apart from the panel's, so as not to sweep its 64.
const listSummaries = new ResumosDeSessao(storage, { maximo: 256 });
const detail = new LeiturasDoDetalhe({ storage, montador: panelBuilder, open: openDescriber, ...(demo ? { local: demoLocal } : {}) });

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
// Every GitHub-backed screen (#241, src/api/github-screens.ts): the Repositories screen, the Instructions
// tab (#183), the framework install (#184), the ADRs and PDRs (#174), the Dev Console (#177), the Delivery
// tab (#266), the project kanban (#80) and the list of Projects to choose from; under --demo, each screen's
// fake GitHub. The kanban's Project: AHRENA_CONSOLE_PROJECT > the one chosen on the screen > the demo's
// (unless --demo-project none) > none.
// The console's own GitHub connection (#241, decision 0011): the device flow, the vault of this platform
// (Keychain on macOS, Secret Service on Linux, none elsewhere; touched only when GitHub is first needed),
// the client id of AHRENA_CONSOLE_GITHUB_CLIENT_ID (the built-in one is still empty) and the opt-in `gh`
// source (AHRENA_CONSOLE_GITHUB_SOURCE=gh). Under --demo, the same connection on the fake GitHub, in the
// state of --demo-github, never the real GitHub, Keychain or gh. An identity change clears github_cache
// and rebuilds every screen (and forgets the work by branch).
coreGithub = await createCoreGithub({
  demo,
  noGithub: o.noGithub && !demo,
  connection: async (hooks) =>
    demo
      ? (await createDemoGithubConnection(demoGithubState, { settings, queue: githubQueue, ...hooks, log })).connection
      : new GithubConnection({ vault: chooseVault(), settings, env: process.env, off: o.noGithub, queue: githubQueue, ...hooks, log }),
  cache: githubCache,
  queue: githubQueue,
  changes,
  fleet: mcp.fleet,
  storage,
  decisions,
  settings,
  env: process.env,
  frameworkRepo: process.env[FRAMEWORK_REPO_ENV],
  demoProject: o.demoProject !== 'none',
  onReset: () => work.forget(),
  log,
});
const { connection, screens } = coreGithub;

// Machine telemetry (#175, decision 0008): one sample every 30 s, 12 h in the database, and each
// alert that enters or exits on /api/changes. In --demo, the simulator's synthetic readings, with
// 12 h already seeded, plus a synthetic "workstation" (its reconnect stays `null`). Outside the demo,
// each remote machine of machines.json (#176) is read every 30 s through the port the user's tunnel
// forwards; the file is re-read live (#244, decision 0012): every 30 s by its modification time and
// right before a reconnect, so a machine added, removed or changed applies without a restart.
const sampleStore = new SqliteTelemetryStore(sqlite.db);
const alertTracker = new AlertTracker();
const localEntry = localMachine();
const demoEntries: MachineEntry[] = [];
const samplers: TelemetrySampler[] = [];
let remoteMachines: RemoteMachines<RemoteMachine> | null = null;
let reconnectRunner: ReconnectRunner | null = null;
function addSampler(machineId: string, collector: TelemetryCollector) {
  samplers.push(new TelemetrySampler({ machineId, collector, store: sampleStore, tracker: alertTracker, onAlertChange: publishAlertChanges(changes), log }));
}
if (demo) {
  demoEntries.push({ ...SIMULATED_WORKSTATION, state: () => 'connected' });
  await seedTelemetry(sampleStore, 'local', 'local');
  await seedTelemetry(sampleStore, SIMULATED_WORKSTATION.id, 'workstation');
  addSampler('local', new SimulatedCollector('local'));
  addSampler(SIMULATED_WORKSTATION.id, new SimulatedCollector('workstation'));
} else if (!o.noTelemetry) {
  const platformCollector = collectorFor();
  // Decision 0013 section 5: the Mac's núcleo asks the cloud nothing about itself; only a remote one reads its placement.
  if (platformCollector) addSampler('local', process.platform === 'darwin' ? platformCollector : withPlacement(platformCollector, new PlacementProbe({ log })));
  else log(`telemetry: no collector for ${process.platform}`);
  const get = loopbackGet();
  const onAlertChange = publishAlertChanges(changes);
  const registry: RemoteMachines<RemoteMachine> = new RemoteMachines<RemoteMachine>({
    source: new MachinesFileSource({ ...(o.machines ? { file: o.machines } : {}), log }),
    ownPort: boundPort,
    create: (config) =>
      new RemoteMachine({
        config,
        get,
        store: sampleStore,
        tracker: alertTracker,
        onAlertChange,
        onAttentionChange: publishRemoteAttentionChanges(changes),
        reconnectStatus: (id) => reconnectRunner?.status(id, registry.reconnectOf(id) ?? null) ?? null,
        connectionStatus: (id) => machineConnection?.status(id) ?? Promise.resolve(null),
        suppressUnreachable: (id) => machineConnection?.suppressUnreachable(id) ?? false,
        log,
      }),
    // A machine removed from the file closes its alerts, and the screen and the tray hear about it.
    onRemoved: (id) => {
      for (const alert of alertTracker.update(id, []).exited) onAlertChange({ machineId: id, alert, change: 'exited' });
    },
    onChange: publishReconnectChanges(changes),
    log,
  });
  remoteMachines = registry;
  reconnectRunner = new ReconnectRunner({
    logFile: reconnectLogFile(dataDir),
    // Always the freshest reading of the file: a command removed from it does not run.
    // While the file is invalid, nothing runs, even if the last good reading had a command.
    lookup: async (id) => {
      await registry.refresh();
      const config = registry.reconnectOf(id);
      return config !== undefined && registry.fileInvalid() ? INVALID_MACHINES_FILE : config;
    },
    onSucceeded: (id) => void registry.get(id)?.readNow(),
    onChange: publishReconnectChanges(changes),
    log,
  });
  await registry.refresh();
}
const machineEntries = (): MachineEntry[] => [localEntry, ...demoEntries, ...(remoteMachines?.list() ?? [])];
const telemetryService = samplers.length > 0 || remoteMachines ? new TelemetryService({ store: sampleStore, tracker: alertTracker, machines: machineEntries }) : null;

// Sending a message to a live session (#61): the inbox of each profile folder's `sessions/`, the
// transcript for the confirmation, and the audit in the data folder. Synthetic in the demo.
const messaging = demo
  ? demoMessaging(storage, log)
  : new Messaging({
      live: new SessionsDirectory({ folders: () => profiles!.list() }),
      inbox: new SocketInbox(),
      turns: new TranscriptTurns(),
      audit: new AuditFile(messagingAuditFile(dataDir), log),
      log,
    });
// The Tools screen (#280, decision 0014): this machine's CLIs, runtimes and containers, read with the
// catalog's fixed probes; the latest versions only from the tool_checks cache (a check reads the
// network). Not in --demo: the demo must not read the real machine.
// The executor (layer 2) runs the catalog's actions as jobs and logs their masked output to tools.log.
// The MCP servers (layer 3): Claude Code's ~/.claude.json and the .mcp.json of the sessions' projects (capped).
const toolsService = demo ? null : new ToolsService({ store: new SqliteToolChecksStore(sqlite.db), mcpProjects: () => knownProjects(storage, MAX_MCP_PROJECTS), log });
const toolsExecutor = toolsService ? new ToolsExecutor({ service: toolsService, logFile: toolsLogFile(dataDir), onChange: publishToolsChanges(changes), log }) : null;
// The cloud connectors (#277, decision 0013): this machine's ~/.aws/config, its SSO sessions and their logins (into reconnect.log); the remote machines' through their tunnel port. Not in --demo.
const awsConnector = demo ? null : new AwsConnector({ logFile: reconnectLogFile(dataDir), wakeOnView: true, onChange: publishConnectorChanges(changes), log });
// The connection of each remote machine (#278, decision 0013 section 4): start, stop, reconnect and login-and-start, on the reconnect runner.
const machineConnection = remoteMachines && reconnectRunner ? new MachineConnection({ registry: remoteMachines, startRunner: reconnectRunner, logFile: reconnectLogFile(dataDir), cloud: awsConnector, localReading: () => sampleStore.latest('local'), onChange: publishConnectionChanges(changes), log }) : null;
const clouds = awsConnector ? createCloudsRoute({ aws: awsConnector, remote: { port: (id) => remoteMachines?.get(id)?.port, get: loopbackGet(), write: loopbackWrite() } }) : null;
// The Docker actions (#288, decision 0017): this machine's daemon, on the Tools executor's queue; the remote machines' through their tunnel port. Not in --demo.
// A núcleo accepts a no-Origin write (the tunnel) only with AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1, set by whoever is on that machine.
const acceptRemoteActions = () => process.env.AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS === '1';
const docker =
  toolsService && toolsExecutor
    ? {
        route: createDockerRoute({
          service: new DockerService({
            queue: toolsExecutor,
            run: systemToolRunner,
            env: () => toolsService.processEnv(),
            platform: process.platform,
            resolve: async (name) => (await toolsService.resolveExecutable(name)).path,
            acceptsRemoteActions: acceptRemoteActions,
            log,
          }),
          cancel: (id) => toolsExecutor.cancel(id),
          acceptNoOriginActions: acceptRemoteActions,
          remote: { port: (id) => remoteMachines?.get(id)?.port, get: loopbackGet(), write: loopbackWrite() },
        }),
        acceptNoOrigin: acceptRemoteActions,
      }
    : null;
// The desktop app's update notice (#330): the app reports what it found; the /ui reads it. Not in --demo.
const appUpdate = demo ? null : createAppUpdateRoute(new AppUpdateState(changes));

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

// The API takes over the socket reserved above: the port is never free in between (with port 0,
// the one the system assigned stays this core's).
const api: LocalApi = await startLocalApi({
  listenOn: reservation,
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
  port: boundPort,
  log,
  openInDesktop,
  openDescriber,
  openTerminal,
  focusTerminal,
  localOf: async (id) => {
    await desktop?.refresh();
    return desktop?.sessionByCli(id)?.localId ?? (demo ? demoLocal(id) : null);
  },
  mcp: mcp.server,
  commit,
  changes,
  decisionsUi,
  project: { kanban: null, fonte: demo ? 'demo' : 'github', resolver: screens.project, options: screens.projectOptions, credentialSource: () => connection.credentialSource(), log },
  projectSelection: screens.project,
  connection,
  // --no-github keeps its own off / no-github answers; otherwise 409 github-not-connected before any call.
  githubConnected: coreGithub.connected,
  detail,
  events: new FeedDeEventos({ storage }),
  fleet: mcp.fleet,
  remoteAttention: () => remoteMachines?.list() ?? [],
  analytics: new RotaAnalytics({ storage, contas: accounts, versao: () => changes.current, delivery: screens.delivery }),
  sessions: new ListaDeSessoes({ storage, contas: accounts, desktop, resumos: listSummaries, open: openDescriber }),
  history,
  kanban: new QuadroKanban({ storage, contas: accounts, desktop, resumos: listSummaries }),
  repos: screens.repos,
  agentInstructions: screens.agentInstructions,
  frameworkInstall: screens.frameworkInstall,
  decisions: screens.decisions,
  devConsole: screens.devConsole,
  agentConfig,
  telemetry: telemetryService,
  machineReader: new MachineReader({ get: loopbackGet({ timeoutMs: MACHINE_READ_ADAPTER_TIMEOUT_MS }), machines: () => remoteMachines?.list() ?? [], connectionOf: (id) => machineConnection?.status(id) ?? null }),
  reconnect: machineConnection?.legacy ?? reconnectRunner,
  machineConnection: machineConnection ? createConnectionRoute(machineConnection) : null,
  messaging: createMessagingRoute({ messaging, sessions: storage, accounts, log }),
  orders: createOrdersRoute({ orders: new SessionOrders(), messaging, sessions: storage }),
  tools: toolsExecutor,
  clouds,
  docker,
  appUpdate,
  load: () => ({
    history: follower ? (historyReady ? 'ready' : 'importing') : 'off',
    follower: follower?.stats() ?? null,
    desktopRead: desktop?.filesRead ?? 0,
    work: work.chamadas,
  }),
}).catch(async (e: unknown) => {
  await releasePort(reservation).catch(() => undefined);
  throw e;
});
const apiPort = (api.server.address() as AddressInfo).port;

const lock = useLock ? await claimLock({ dir: dataDir, port: apiPort, version: API_VERSION, parent }) : null;
if (lock && 'conflict' in lock) {
  // Jobs run in their own process groups: end them (SIGTERM, then SIGKILL) so none outlives the núcleo.
  await toolsExecutor?.stopAll().catch(() => undefined);
  await api.close().catch(() => undefined);
  await storage.close();
  adopt(lock.conflict.port, lock.conflict.version);
}
startGuard?.release();
// The instance registry (decision 0010, item 3): only cores with a lock. A --demo or a --no-lock
// core is not this installation's core, so nobody should find it there.
const instance = lock
  ? { id: instanceId(installation), installation, pid: process.pid, port: apiPort, version: API_VERSION, commit, dataDir, startedAt: lock.startedAt }
  : null;
const unregister = () => {
  if (!instance) return;
  try {
    removeInstance(instance.id, { pid: process.pid });
  } catch (e) {
    log(`registry: ${(e as Error).message}`);
  }
};
if (instance) {
  process.once('exit', unregister);
  // The registry is only for finding the core: a failure here is logged, it does not stop the core.
  try {
    writeInstance(instance);
  } catch (e) {
    log(`registry: could not write ${instance.id}: ${(e as Error).message}`);
  }
}
log(`listening on port ${apiPort} · installation ${installation} · data ${demo ? '(demo, in memory)' : dataDir}${instance ? ` · instance ${instance.id}` : ''}`);
log(`local API at ${api.url} · MCP at ${api.url}/mcp${demo ? ` (demo ${o.scenario}: synthetic simulator data)` : ` · database ${dbPath}`}`);

const stopWatchingParent =
  parent === null
    ? () => {}
    : watchParent({
        parent,
        dir: dataDir,
        onGone: (reason) => {
          log(`${reason}; saindo`);
          void shutdown();
        },
      });

// The initial import runs after the port already answers: the panel does not wait for the history.
const stopWatcher = demo ? () => {} : machine.start();
for (const a of samplers) a.start();
remoteMachines?.start();
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
  if (!storage.isReprocessed(PLANS_AND_DECISIONS_REPROCESSING)) {
    const start = Date.now();
    const r = await reprocessarHistorico({ storage, decisoes: decisions, raiz: o.projects ?? defaultProjectsRoot(), log });
    storage.markReprocessed(PLANS_AND_DECISIONS_REPROCESSING, new Date().toISOString());
    log(`reprocessed in ${Math.round((Date.now() - start) / 1000)} s: ${r.sessoes} sessions, ${r.planos} plans in ${r.comPlano}, ${r.decisoes} decisions`);
  }
  if (!storage.isReprocessed(DECISION_NOISE_CLEANUP)) {
    const r = await limparDecisoes(storage, decisions);
    storage.markReprocessed(DECISION_NOISE_CLEANUP, new Date().toISOString());
    log(`decisions cleaned: ${r.ruido} outside the lists, ${r.encurtadas} with a shortened title`);
  }
  if (!storage.isReprocessed(CONTEXT_REPROCESSING)) {
    const r = await reprocessarContexto({ storage, raiz: o.projects ?? defaultProjectsRoot(), log });
    storage.markReprocessed(CONTEXT_REPROCESSING, new Date().toISOString());
    log(`context meter rebuilt: ${r.medidores} meters in ${r.sessoes} sessions`);
  }
}

async function shutdown() {
  stopWatcher();
  messaging.close();
  connection.close();
  if (profileTimer) clearInterval(profileTimer);
  stopWatchingParent();
  unregister();
  if (lock && !('conflict' in lock)) releaseLock(lock.token, dataDir);
  await follower?.stop().catch(() => undefined);
  await Promise.all([...samplers.map((a) => a.stop()), remoteMachines?.stop()]);
  // #280: the jobs run detached, so they would outlive the core; stop them and write their footers first.
  await toolsExecutor?.stopAll().catch(() => undefined);
  await machineConnection?.stopAll().catch(() => undefined);
  await awsConnector?.stop().catch(() => undefined);
  await api.close().catch(() => undefined);
  await storage.close();
  if (demoFolder) rmSync(demoFolder, { recursive: true, force: true });
  process.exit(0);
}
process.off('SIGINT', exitOnSignal);
process.off('SIGTERM', exitOnSignal);
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
