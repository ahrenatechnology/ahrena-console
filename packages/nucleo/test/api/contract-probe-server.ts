// The server the contract tests drive (#662): the demo server of the API tests with every optional
// route turned on by the module's own route factory, over off or in-memory dependencies: GitHub is
// off (`noGithub`), the machine registry has one machine with no command to run, the messaging ports
// deliver nothing, the whisper address refuses connections, Docker and the port releaser read an
// empty machine. A route the server does not serve falls through to a handler's own unknown-path
// answer, which is what the parity test reads; nothing here answers on a module's behalf.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { createAgentConfigRoute, type ApiOptions } from '../../src/api/index.ts';
import { createAppUpdateRoute } from '../../src/api/app-update.ts';
import { createCloudsRoute } from '../../src/api/clouds.ts';
import { createConnectionRoute } from '../../src/api/connection.ts';
import { createCoreUpdateRoute } from '../../src/api/core-update.ts';
import { createCoreDecisions } from '../../src/api/adrs.ts';
import { createCoreAgentInstructions } from '../../src/api/agent-instructions.ts';
import { createCoreFrameworkInstall } from '../../src/api/framework-install.ts';
import { createDockerRoute } from '../../src/api/docker.ts';
import { createMessagingRoute } from '../../src/api/messaging.ts';
import { createOrdersRoute } from '../../src/api/orders.ts';
import { createPortsRoute } from '../../src/api/ports.ts';
import { createTranscriptionRoute } from '../../src/api/transcription.ts';
import { AppUpdateState } from '../../src/app-update/state.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { AwsConnector } from '../../src/clouds/aws-connector.ts';
import { DockerService } from '../../src/docker/service.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubConnection } from '../../src/github/connection/connection.ts';
import { ManagedRuntime } from '../../src/runtime/service.ts';
import { SqliteRuntimeStore } from '../../src/runtime/sqlite.ts';
import { Messaging } from '../../src/messaging/service.ts';
import { SessionOrders } from '../../src/messaging/orders.ts';
import { serverWithoutCore } from '../../src/mcp/index.ts';
import { PortReleaser } from '../../src/ports/release.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { MachineConnection } from '../../src/telemetry/connection.ts';
import { CoreUpdater } from '../../src/telemetry/core-update.ts';
import { ReconnectRunner } from '../../src/telemetry/reconnect.ts';
import { createTranscription } from '../../src/transcription/whisper.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { localMachine, TelemetryService, type MachineEntry } from '../../src/telemetry/service.ts';
import { ToolsExecutor, type ToolsHost } from '../../src/tools/executor.ts';
import { OWNER_TOKEN, ownerFetch } from '../owner-http.ts';
import { fakeRunner, fakeSpawn } from '../tools/doubles.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';
import { harness } from '../permissions/fakes.ts';

export interface ContractProbeServer {
  /** The base address, `http://127.0.0.1:<port>`. */
  url: string;
  /** A request with the owner's bearer, as the core's own clients make it. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

/** The machine every `{machineId}` path of the contract names. */
export const PROBE_MACHINE = 'workstation';

/** GitHub switched off: the connection answers its status and refuses every action, and nothing leaves the process. */
const connection = new GithubConnection({ vault: null, settings: new MemoryInstallationSettings(), off: true });

const toolsHost: ToolsHost = {
  overview: async () => null,
  check: async () => null,
  actionPlan: async () => ({ kind: 'unknown' }),
  verify: async () => null,
  invalidate: () => {},
  processEnv: async () => ({ PATH: '/usr/bin' }),
  resolveExecutable: async (name) => ({ path: `/usr/bin/${name}`, realPath: `/usr/bin/${name}` }),
};

async function wiring(dir: string): Promise<{ stands: Partial<ApiOptions>; storage: SqliteStorage }> {
  const cache = new GithubCache({ store: new MemoryCacheStore() });
  const changes = new ChangeCursor();
  const queue = new GithubCallQueue();
  const noGithub = { demo: false, noGithub: true, cache, changes, queue };
  const decisions = createCoreDecisions({ ...noGithub, accountRepos: async () => ({ state: 'ready', error: null, account: null, repos: [] }) });
  const instructions = createCoreAgentInstructions(noGithub);
  const framework = createCoreFrameworkInstall(noGithub);

  const status = { state: 'unreachable' as const, reason: 'port-closed' as const, version: null };
  const machine = { port: 14720, status: () => status, readNow: async () => status };
  const registry = {
    refresh: async () => {},
    fileInvalid: () => false,
    connectionOf: (id: string) => (id === PROBE_MACHINE ? null : undefined),
    get: (id: string) => (id === PROBE_MACHINE ? machine : undefined),
  };
  const logFile = join(dir, 'connection.log');
  const startRunner = new ReconnectRunner({ logFile, lookup: async (id) => (id === PROBE_MACHINE ? null : undefined) });
  const machineConnection = new MachineConnection({ registry, startRunner, logFile, cloud: null });
  const updater = new CoreUpdater({
    lookup: async (id) => (id === PROBE_MACHINE ? { kind: 'ok', connection: null } : { kind: 'unknown' }),
    context: (id) => ({ connection: id === PROBE_MACHINE ? null : undefined, fileInvalid: false }),
    appVersion: '0.0.1',
    telemetryVersion: 1,
    script: async () => '',
  });
  const aws = new AwsConnector({ logFile: join(dir, 'aws.log'), home: dir, env: { HOME: dir, PATH: '/usr/bin:/bin' }, run: fakeRunner({}), loginPath: async () => '/usr/bin:/bin' });
  const noRemote = { port: () => undefined, get: async () => ({ kind: 'unreachable' as const, reason: 'port-closed' }), write: async () => ({ kind: 'unreachable' as const, reason: 'port-closed' }) };
  const docker = new DockerService({ queue: { enqueue: () => ({ kind: 'busy' }) as never, jobs: () => ({ current: null, queue: [], recent: [], batch: null }) as never }, run: fakeRunner({}), env: async () => ({}), platform: 'linux', resolve: async () => null, log: () => {} });
  const releaser = new PortReleaser({ listPorts: async () => [], run: async () => '', uid: () => 501, selfPid: 1, ancestors: async () => [], kill: () => {}, sleep: async () => {}, waitMs: { TERM: 1, KILL: 1 } });
  const storage = openSqliteStorage({ path: ':memory:' });
  const remote: MachineEntry = { id: PROBE_MACHINE, label: 'Workstation', port: 14720, state: () => status.state, status: () => status, connection: () => machineConnection.status(PROBE_MACHINE), update: () => updater.status(PROBE_MACHINE) };
  const telemetry = new TelemetryService({ store: new SqliteTelemetryStore(storage.db), tracker: new AlertTracker(), machines: [localMachine(), remote] });
  const executor = new ToolsExecutor({ service: toolsHost, logFile: join(dir, 'tools.log'), spawn: fakeSpawn().spawn, killGroup: () => {}, log: () => {} });
  const stands: Partial<ApiOptions> = {
    telemetry,
    runtime: new ManagedRuntime(storage, new SqliteRuntimeStore(storage.db, changes)),
    reconnect: machineConnection.legacy,
    tools: executor,
    mcp: serverWithoutCore('the contract probe'),
    agentInstructions: instructions.route,
    decisions: decisions.route,
    frameworkInstall: framework.route,
    agentConfig: createAgentConfigRoute({ folders: async () => [], projects: async () => [], backups: join(dir, 'backups') }),
    clouds: createCloudsRoute({ aws, remote: noRemote as never }),
    appUpdate: createAppUpdateRoute(new AppUpdateState(null)),
    machineConnection: createConnectionRoute(machineConnection),
    coreUpdate: createCoreUpdateRoute(updater),
    docker: { route: createDockerRoute({ service: docker, cancel: () => ({ kind: 'unknown' }), acceptNoOriginActions: () => true, remote: null }), acceptNoOrigin: () => true },
    ports: createPortsRoute({ releaser, acceptNoOrigin: () => true, remote: null }),
    ownerProofRetry: async () => null,
    devConsole: { overview: async () => ({ generatedAt: '2026-11-14T12:00:00.000Z', readAt: null, stale: false, staleReason: null, contexts: [], mergeQueue: [] }), view: async () => null },
    githubSync: { status: () => ({ active: false, pausedUntil: null, steps: [] }) },
    connection,
    // The permission routes (#618) over the in-memory doubles, the capability off: a hook route answers 503 `off`, the list `available: false`.
    permissions: { deps: harness(), enabled: () => false, windowCredential: () => null },
  };
  return { stands, storage };
}

export async function startContractProbeServer(): Promise<ContractProbeServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ahrena-contract-probe-'));
  const { stands, storage } = await wiring(dir);
  const transcription = createTranscription({ config: { url: 'http://127.0.0.1:1', bin: '/none', model: '/none' } });
  const messaging = new Messaging({ live: { find: async () => [] }, inbox: { deliver: async () => ({ ok: false }) }, turns: { open: async () => ({ poll: async () => null, close() {} }) }, audit: { record() {} }, pollMs: 10, sleep: async () => {} } as never);
  const orders = new SessionOrders();
  const demo: DemoApi = await startDemoApi({
    messaging: (storage) => createMessagingRoute({ messaging, sessions: storage }),
    orders: (storage) => createOrdersRoute({ orders, messaging, sessions: storage }),
    transcription: createTranscriptionRoute({ transcription }),
    extra: stands,
  });
  return {
    url: demo.api.url,
    fetch: (path, init) => ownerFetch(`${demo.api.url}${path}`, init),
    close: async () => {
      await demo.close();
      transcription.close();
      storage.close();
      messaging.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { OWNER_TOKEN };
