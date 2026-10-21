// Ferramentas under --demo only (issue 280, decision 0014, wireframes C72 to C76): synthetic bodies of
// `GET /api/tools` for this machine (an example Mac) and the simulated Workstation (an example Linux),
// shaped like the contract the real layers build (`src/tools/`, `src/api/tools.ts`), and a fake job
// queue that answers the screen's writes. Nothing here runs a process, reads the machine or touches
// the network: every "command" is text, every job is a timer over the clock.
//
// The fixtures are also the screen tests' bodies (test/api/ui-tools.test.ts), one per state of the
// wireframes: `toolsFixture(scenario, machine, now)`. The demo picks the scenario from
// AHRENA_CONSOLE_DEMO_TOOLS_SCENARIO (default `default`), so each state can be looked at in the app.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SIMULATED_WORKSTATION } from './telemetry.ts';

export const TOOLS_DEMO_SCENARIOS = [
  'default', // C72: this Mac with work to do; the Workstation read-only (C75 1)
  'all-ok', // C74 1
  'first-check', // C74 2: no cache yet
  'offline', // C74 3
  'no-homebrew', // C74 4
  'windows-no-winget', // C74 6 and C76 6
  'remote-actions', // C75 2: the Workstation accepts actions
  'remote-stale', // C75 3: the Workstation is out, the last reading faded
  'colima-stopped', // C76 2
  'colima-starting', // C76 3
  'no-runtime', // C76 4
  'linux-engine-stopped', // C76 5, on the Workstation
] as const;
export type ToolsDemoScenario = (typeof TOOLS_DEMO_SCENARIOS)[number];

type Step = string[];
export interface DemoAction {
  id: 'install' | 'update' | 'start' | 'stop';
  runnable: boolean;
  admin: boolean;
  blockedReason: 'admin' | 'offline' | 'no-manager' | 'remote-read-only' | null;
  steps: Step[];
  timeoutSeconds: number;
  targetVersion: string | null;
  planDigest: string;
}

const MIN = 60_000;
const GB = 1e9;
const GiB = 1024 ** 3;

/** The contract's digest: sha256 hex (first 16) of the canonical plan. */
export function demoDigest(machine: string, toolId: string, actionId: string, sourceId: string, steps: Step[], timeoutSeconds: number): string {
  return createHash('sha256').update(JSON.stringify({ machine, toolId, actionId, sourceId, steps, timeoutSeconds })).digest('hex').slice(0, 16);
}

interface ActionSeed {
  id: DemoAction['id'];
  steps: Step[];
  admin?: boolean;
  timeoutSeconds?: number;
  targetVersion?: string | null;
}

function action(machine: string, toolId: string, sourceId: string, seed: ActionSeed, gate: { allowed: boolean; offline: boolean; noManager: boolean }): DemoAction {
  const admin = seed.admin ?? false;
  const timeoutSeconds = seed.timeoutSeconds ?? 600;
  const blockedReason = admin ? 'admin' : gate.offline && seed.id !== 'start' && seed.id !== 'stop' ? 'offline' : gate.noManager ? 'no-manager' : !gate.allowed ? 'remote-read-only' : null;
  return {
    id: seed.id,
    runnable: blockedReason === null,
    admin,
    blockedReason,
    steps: seed.steps,
    timeoutSeconds,
    targetVersion: seed.targetVersion ?? null,
    planDigest: demoDigest(machine, toolId, seed.id, sourceId, seed.steps, timeoutSeconds),
  };
}

// [id, label, group, binary, manager, installed, latest, source, state, note, actions]
type Row = [string, string, 'cli' | 'runtime', string, string | null, string | null, string | null, string | null, string, string | null, ActionSeed[]];

const MAC_ROWS: Row[] = [
  ['claude', 'Claude Code', 'cli', 'claude', 'instalador nativo', '2.1.299', '2.1.312', 'native', 'outdated', null, [{ id: 'update', steps: [['claude', 'update']], targetVersion: '2.1.312' }]],
  ['git', 'Git', 'cli', 'git', 'Homebrew', '2.51.1', '2.51.1', 'homebrew', 'ok', null, []],
  ['gh', 'GitHub CLI', 'cli', 'gh', 'Homebrew', '2.81.0', '2.83.1', 'homebrew', 'outdated', null, [{ id: 'update', steps: [['brew', 'upgrade', 'gh']], targetVersion: '2.83.1' }]],
  ['aws', 'AWS CLI', 'cli', 'aws', 'instalador oficial (.pkg)', '2.31.12', '2.31.18', 'official', 'manual', 'veio do instalador oficial, em /usr/local/aws-cli, que é do root', [{ id: 'update', steps: [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], admin: true, targetVersion: '2.31.18' }]],
  ['session-manager-plugin', 'Plugin do SSM da AWS', 'cli', 'session-manager-plugin', 'Homebrew (cask)', '1.2.764.0', '1.2.764.0', 'homebrew', 'ok', null, []],
  ['wrangler', 'Cloudflare Wrangler', 'cli', 'wrangler', 'npm global · Node do fnm', '4.45.0', '4.47.2', 'npm', 'outdated', null, [{ id: 'update', steps: [['npm', 'install', '-g', 'wrangler@4.47.2']], targetVersion: '4.47.2' }]],
  ['gcloud', 'Google Cloud CLI', 'cli', 'gcloud', 'Homebrew (cask)', null, '545.0.0', null, 'missing', null, [{ id: 'install', steps: [['brew', 'install', '--cask', 'gcloud-cli']], targetVersion: '545.0.0' }]],
  ['docker', 'Docker CLI', 'cli', 'docker', 'Homebrew', '28.5.1', '28.5.1', 'homebrew', 'ok', null, []],
  ['colima', 'Colima', 'cli', 'colima', 'Homebrew', '0.9.1', '0.9.1', 'homebrew', 'ok', null, []],
  ['jq', 'jq', 'cli', 'jq', 'Homebrew', '1.8.1', '1.8.1', 'homebrew', 'ok', null, []],
  ['rg', 'ripgrep', 'cli', 'rg', 'Homebrew', '15.1.0', '15.1.0', 'homebrew', 'ok', null, []],
  ['node', 'Node.js', 'runtime', 'node', 'fnm', '24.10.0', '24.11.0', 'fnm', 'outdated', 'LTS 24 · a 22 também está instalada', [{ id: 'update', steps: [['fnm', 'install', '24.11.0'], ['fnm', 'default', '24.11.0']], targetVersion: '24.11.0' }]],
  ['typescript', 'TypeScript', 'runtime', 'tsc', 'npm global · Node do fnm', '5.9.3', '5.9.3', 'npm', 'ok', 'o de cada projeto fica no package.json dele', []],
  ['python', 'Python', 'runtime', 'python3', 'uv · também pyenv (3.11.9)', '3.13.9', '3.14.0', 'uv', 'outdated', 'não troca o Python dos projetos', [{ id: 'update', steps: [['uv', 'python', 'install', '3.14.0']], targetVersion: '3.14.0' }]],
  ['rust', 'Rust', 'runtime', 'rustc', 'rustup · stable', '1.91.0', '1.91.0', 'rustup', 'ok', 'cargo 1.91.0', []],
  ['go', 'Go', 'runtime', 'go', 'Homebrew', '1.25.3', '1.25.3', 'homebrew', 'ok', 'o toolchain do go.mod baixa sozinho', []],
];

const WS_ROWS: Row[] = [
  ['claude', 'Claude Code', 'cli', 'claude', 'instalador nativo', '2.1.312', '2.1.312', 'native', 'ok', null, []],
  ['git', 'Git', 'cli', 'git', 'apt · Ubuntu', '2.43.0', '2.43.0', 'apt', 'ok', null, []],
  ['gh', 'GitHub CLI', 'cli', 'gh', 'apt · repositório do GitHub CLI', '2.80.0', '2.83.1', 'apt', 'outdated', null, [{ id: 'update', steps: [['sudo', 'apt-get', 'install', '--only-upgrade', 'gh']], admin: true, targetVersion: '2.83.1' }]],
  ['aws', 'AWS CLI', 'cli', 'aws', 'instalador oficial (.zip)', '2.31.18', '2.31.18', 'official', 'ok', null, []],
  ['session-manager-plugin', 'Plugin do SSM da AWS', 'cli', 'session-manager-plugin', 'pacote .deb', '1.2.764.0', '1.2.764.0', 'apt', 'ok', null, []],
  ['wrangler', 'Cloudflare Wrangler', 'cli', 'wrangler', 'npm global · Node do fnm', '4.45.0', '4.47.2', 'npm', 'outdated', null, [{ id: 'update', steps: [['npm', 'install', '-g', 'wrangler@4.47.2']], targetVersion: '4.47.2' }]],
  ['gcloud', 'Google Cloud CLI', 'cli', 'gcloud', 'apt · repositório do Google', '545.0.0', '545.0.0', 'apt', 'ok', null, []],
  ['docker', 'Docker CLI', 'cli', 'docker', 'apt · Docker Engine', '28.5.1', '28.5.1', 'apt', 'ok', null, []],
  ['colima', 'Colima', 'cli', 'colima', null, null, null, null, 'na', 'só no macOS', []],
  ['jq', 'jq', 'cli', 'jq', 'apt · Ubuntu', '1.7.1', '1.7.1', 'apt', 'ok', null, []],
  ['rg', 'ripgrep', 'cli', 'rg', 'apt · Ubuntu', '14.1.0', '14.1.0', 'apt', 'ok', null, []],
  ['node', 'Node.js', 'runtime', 'node', 'fnm', '24.11.0', '24.11.0', 'fnm', 'ok', 'LTS 24', []],
  ['typescript', 'TypeScript', 'runtime', 'tsc', 'npm global · Node do fnm', '5.9.3', '5.9.3', 'npm', 'ok', 'o de cada projeto fica no package.json dele', []],
  ['python', 'Python', 'runtime', 'python3', 'uv', '3.14.0', '3.14.0', 'uv', 'ok', 'o python3 do Ubuntu (3.12) fica para o sistema', []],
  ['rust', 'Rust', 'runtime', 'rustc', 'rustup · stable', '1.90.0', '1.91.0', 'rustup', 'outdated', 'cargo 1.90.0', [{ id: 'update', steps: [['rustup', 'update', 'stable']], timeoutSeconds: 900, targetVersion: '1.91.0' }]],
  ['go', 'Go', 'runtime', 'go', 'tarball oficial em /usr/local/go', '1.25.1', '1.25.3', 'official', 'manual', 'em /usr/local, do root', [{ id: 'update', steps: [['sudo', 'rm', '-rf', '/usr/local/go'], ['sudo', 'tar', '-C', '/usr/local', '-xzf', 'go1.25.3.linux-amd64.tar.gz']], admin: true, targetVersion: '1.25.3' }]],
];

function mcpServers(machine: string, gate: { allowed: boolean; offline: boolean; noManager: boolean }, remote: boolean) {
  const server = (o: Record<string, unknown>) => ({ scope: 'user', project: null, transport: 'stdio', command: null, package: null, version: null, latest: null, host: null, envCount: 0, envNames: [], headerCount: 0, headerNames: [], state: 'connected', note: null, actions: [], ...o });
  const playwright = server({
    id: 'playwright',
    name: 'playwright',
    command: 'npx',
    package: '@playwright/mcp',
    version: remote ? '0.0.43' : '0.0.41',
    latest: '0.0.43',
    actions: remote
      ? []
      : [action(machine, 'mcp:playwright', 'npm', { id: 'update', targetVersion: '0.0.43', steps: [['claude', 'mcp', 'remove', '-s', 'user', 'playwright'], ['claude', 'mcp', 'add', '-s', 'user', 'playwright', '--', 'npx', '-y', '@playwright/mcp@0.0.43']] }, gate)],
  });
  const own = server({ id: 'ahrena-console', name: 'ahrena-console', command: 'ahrena-console', version: '0.0.32', note: 'este app · atualiza junto com ele' });
  const github = server({ id: 'github', name: 'github', transport: 'http', host: 'api.githubcopilot.com', headerCount: 1, headerNames: ['Authorization'] });
  if (remote) return [own, github, playwright];
  return [
    own,
    github,
    playwright,
    server({ id: 'docs-exemplo', name: 'docs-exemplo', transport: 'http', host: 'mcp.exemplo.dev', state: 'needs-login', note: 'o login é do Claude Code, não do console' }),
    server({ id: 'postgres-local', name: 'postgres-local', scope: 'project', project: 'catalogo-exemplo', command: 'docker', envCount: 3, envNames: ['PGHOST', 'PGUSER', 'PGPASSWORD'], state: 'failed' }),
  ];
}

const iso = (now: number, msAgo: number) => new Date(now - msAgo).toISOString();

/** The `GET /api/tools` body of a scenario, for `local` or the simulated Workstation. */
export function toolsFixture(scenario: ToolsDemoScenario, machine: string, now = Date.now()): Record<string, unknown> {
  const remote = machine !== 'local';
  const windows = scenario === 'windows-no-winget' && !remote;
  const offline = scenario === 'offline' && !remote;
  const noManager = (scenario === 'no-homebrew' || windows) && !remote;
  const allowed = !remote || scenario === 'remote-actions';
  const gate = { allowed, offline, noManager };
  const firstCheck = scenario === 'first-check' && !remote;
  const allOk = scenario === 'all-ok' && !remote;
  const checkedAt = firstCheck ? null : offline ? iso(now, 15 * 3600_000) : iso(now, (remote ? 65 : 58) * MIN);

  const rows = remote ? WS_ROWS : MAC_ROWS;
  const items = rows.map(([id, label, group, binary, manager, installed, latest, source, state, note, seeds], i) => {
    const okNow = allOk && (state === 'outdated' || state === 'missing' || state === 'manual');
    const reading = firstCheck && i >= 2;
    return {
      id,
      label,
      group,
      inCatalog: true,
      binary,
      manager: reading ? null : manager,
      installed: okNow ? latest : reading ? null : installed,
      latest: firstCheck ? null : latest,
      latestCheckedAt: firstCheck ? null : checkedAt,
      latestError: null,
      source: reading ? null : okNow ? (source ?? 'homebrew') : source,
      state: firstCheck ? 'checking' : okNow ? 'ok' : state,
      note: okNow ? null : note,
      actions: firstCheck || okNow ? [] : seeds.map((s) => action(machine, id, source ?? 'homebrew', s, gate)),
    };
  });

  const containers = containersOf(scenario, machine, gate, now);
  const servers = mcpServers(machine, gate, remote).map((s) => (allOk ? { ...s, state: 'connected', version: s.latest ?? s.version, actions: [] } : s));
  const platform = windows ? 'win32' : remote ? 'linux' : 'darwin';
  const label = remote ? SIMULATED_WORKSTATION.label : 'Esta máquina';
  const stale = remote && scenario === 'remote-stale';
  return {
    version: 1,
    machine: { id: machine, label, platform, os: windows ? 'Windows 11' : remote ? 'Ubuntu 24.04' : 'macOS 26', arch: remote ? 'x64' : 'arm64', host: remote ? 'ws-exemplo' : null },
    checkedAt,
    nextCheckAt: checkedAt ? new Date(Date.parse(checkedAt) + 6 * 3600_000).toISOString() : null,
    network: offline ? 'offline' : 'online',
    managers: {
      homebrew: platform === 'darwin' ? (scenario === 'no-homebrew' ? { present: false, install: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' } : { present: true }) : { present: false },
      winget: { present: false },
      apt: platform === 'linux' ? { present: true, listsUpdatedAt: iso(now, 26 * 3600_000) } : { present: false, listsUpdatedAt: null },
    },
    actionsAllowed: allowed && !offline && !stale,
    stale,
    readAt: stale ? iso(now, 14 * MIN) : null,
    items: windows ? items.filter((i) => !['colima', 'session-manager-plugin'].includes(i.id)).map((i) => (i.source === 'homebrew' ? { ...i, manager: 'winget', source: 'winget' } : i)) : items,
    containers,
    mcp: { statusCheckedAt: firstCheck ? null : checkedAt, servers },
    jobs: { current: null, queue: [], recent: [] },
  };
}

function containersOf(scenario: ToolsDemoScenario, machine: string, gate: { allowed: boolean; offline: boolean; noManager: boolean }, now: number) {
  const remote = machine !== 'local';
  const base = { readOnly: false, vm: null, dockerContext: null, containers: null, diskUsedBytes: null, note: null, detected: [] as unknown[], actions: [] as DemoAction[] };
  if (remote) {
    const stopped = scenario === 'linux-engine-stopped';
    return {
      ...base,
      id: 'docker-engine',
      runtime: 'docker-engine',
      state: stopped ? 'stopped' : 'running',
      version: 'Docker Engine 28.5.1 · systemd · containerd 2.1',
      containers: stopped ? { running: 0, stopped: 106 } : { running: 38, stopped: 68 },
      diskUsedBytes: 34 * GB,
      note: stopped
        ? 'O serviço é do sistema: iniciar pede sudo, e o console não roda sudo. Docker sem root (rootless) é a alternativa que dispensa a senha.'
        : null,
      actions: [action(machine, 'docker-engine', 'apt', stopped ? { id: 'start', steps: [['sudo', 'systemctl', 'start', 'docker']], admin: true } : { id: 'stop', steps: [['sudo', 'systemctl', 'stop', 'docker']], admin: true }, gate)],
    };
  }
  if (scenario === 'windows-no-winget') {
    return {
      ...base,
      id: 'podman-desktop',
      runtime: null,
      state: 'missing',
      version: null,
      note: 'O Docker Desktop é comum, mas pede licença paga em empresa maior. O Podman Desktop é código aberto, e o docker continua funcionando pelo socket compatível. Ligar o WSL 2 pede administrador: se faltar, a tela mostra o comando.',
      detected: [{ runtime: 'docker-desktop', version: '4.48', state: 'running' }],
      actions: [action(machine, 'podman-desktop', 'winget', { id: 'install', steps: [['winget', 'install', '--id', 'RedHat.Podman-Desktop', '--scope', 'user']] }, gate)],
    };
  }
  if (scenario === 'no-runtime') {
    return {
      ...base,
      id: 'colima',
      runtime: null,
      state: 'missing',
      version: null,
      note: 'A proposta é o Colima com o Docker CLI: código aberto e sem licença por empresa. Achamos o Docker Desktop? O console mostra o estado dele, mas não o inicia nem o atualiza.',
      actions: [action(machine, 'colima', 'homebrew', { id: 'install', steps: [['brew', 'install', 'colima', 'docker']] }, gate)],
    };
  }
  const state = scenario === 'colima-stopped' ? 'stopped' : scenario === 'colima-starting' ? 'starting' : 'running';
  return {
    ...base,
    id: 'colima',
    runtime: 'colima',
    state,
    version: 'Colima 0.9.1 · Docker CLI 28.5.1 · perfil default',
    vm: { cpus: 4, memoryBytes: 8 * GiB, diskBytes: 100 * GB, arch: 'aarch64', vmType: 'vz' },
    diskUsedBytes: 31 * GB,
    dockerContext: 'colima',
    containers: state === 'running' ? { running: 3, stopped: 5 } : { running: 0, stopped: 8 },
    actions: state === 'starting' ? [] : [action(machine, 'colima', 'homebrew', state === 'running' ? { id: 'stop', steps: [['colima', 'stop']], timeoutSeconds: 180 } : { id: 'start', steps: [['colima', 'start']], timeoutSeconds: 180 }, gate)],
    ...(state === 'starting' ? { startingJob: true, at: now } : {}),
  };
}

// ---------- the demo route: the fixtures plus a fake queue ----------

type Json = Record<string, unknown>;
interface DemoJob extends Json {
  id: string;
  toolId: string;
  actionId: string;
  label: string;
  machine: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'canceled';
  steps: Step[];
  step: number;
  phase: 'running' | 'verifying';
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  timeoutSeconds: number;
  targetVersion: string | null;
  output: string[];
  logFile: string;
}

/** Fake output, one line per second, by the step's executable. */
function fakeOutput(step: Step, target: string | null): string[] {
  const exe = step[0];
  if (exe === 'brew') return [`==> ${step[1] === 'upgrade' ? 'Upgrading' : 'Installing'} ${step.slice(2).join(' ')}`, `==> Fetching downloads for: ${step.at(-1)}`, `==> Downloading ${step.at(-1)} ${target ?? ''}`.trim(), `==> Pouring ${step.at(-1)}--${target ?? 'latest'}.bottle.tar.gz`, `${step.at(-1)} ${target ?? ''} installed`.trim()];
  if (exe === 'npm') return ['npm http fetch GET 200 registry.npmjs.org (cache revalidated)', `added 1 package, changed 42 packages in 6s`];
  if (exe === 'colima') return step[1] === 'stop' ? ['INFO[0000] stopping colima', 'INFO[0002] stopping ...  context=docker', 'INFO[0004] done'] : ['INFO[0000] starting colima', 'INFO[0000] runtime: docker', 'INFO[0003] creating and starting ...  context=vm', 'INFO[0012] done'];
  return [`${step.join(' ')}`, '...', 'pronto'];
}

const JOB_STEP_MS = 6000;
const VERIFY_MS = 1500;
const LOG_FILE = '/Users/exemplo/.ahrena-console/tools.log';

export interface ToolsDemo {
  /** The writes from /ui itself: `Origin` exactly `http://<Host>`, Host loopback with our port. */
  allows(req: IncomingMessage, port: number): boolean;
  /** Answers `/api/tools…`; `false` when the path is not one of its routes. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export function createToolsDemo({ scenario = 'default', now = () => Date.now() }: { scenario?: string; now?: () => number } = {}): ToolsDemo {
  const chosen: ToolsDemoScenario = (TOOLS_DEMO_SCENARIOS as readonly string[]).includes(scenario) ? (scenario as ToolsDemoScenario) : 'default';
  const machines = new Map<string, Json>();
  const queues = new Map<string, { current: DemoJob | null; queue: DemoJob[]; recent: DemoJob[] }>();
  let seq = 0;
  // The first POST of wrangler finds a newer "latest" (the cache changed under the dialog): 409.
  const bumped = new Set<string>();

  const bodyOf = (machine: string): Json | null => {
    if (machine !== 'local' && machine !== SIMULATED_WORKSTATION.id) return null;
    if (!machines.has(machine)) {
      machines.set(machine, toolsFixture(chosen, machine, now()));
      queues.set(machine, { current: null, queue: [], recent: [] });
    }
    return machines.get(machine)!;
  };

  const findTarget = (body: Json, toolId: string): Json | null => {
    const items = body.items as Json[];
    const item = items.find((i) => i.id === toolId);
    if (item) return item;
    const c = body.containers as Json;
    if (c?.id === toolId) return c;
    const mcp = (body.mcp as Json).servers as Json[];
    return mcp.find((s) => `mcp:${s.id}` === toolId) ?? null;
  };

  function finish(machine: string, job: DemoJob, at: number) {
    const body = bodyOf(machine)!;
    const target = findTarget(body, job.toolId);
    job.state = 'succeeded';
    job.exitCode = 0;
    job.endedAt = new Date(at).toISOString();
    if (target && 'installed' in target) {
      target.installed = job.targetVersion ?? target.latest;
      target.state = 'ok';
      target.actions = [];
    } else if (target && 'runtime' in target) {
      const running = job.actionId === 'start';
      target.state = running ? 'running' : 'stopped';
      target.containers = running ? { running: 3, stopped: 5 } : { running: 0, stopped: 8 };
      target.actions = [action(machine, String(target.id), 'homebrew', running ? { id: 'stop', steps: [['colima', 'stop']], timeoutSeconds: 180 } : { id: 'start', steps: [['colima', 'start']], timeoutSeconds: 180 }, { allowed: true, offline: false, noManager: false })];
    } else if (target) {
      target.version = job.targetVersion;
      target.actions = [];
    }
  }

  /** Moves the queue along the clock: each step takes JOB_STEP_MS, then the version check. */
  function advance(machine: string) {
    const q = queues.get(machine);
    if (!q) return;
    const t = now();
    for (;;) {
      if (!q.current) {
        const next = q.queue.shift();
        if (!next) return;
        next.state = 'running';
        next.startedAt = new Date(t).toISOString();
        q.current = next;
        const body = bodyOf(machine)!;
        const c = body.containers as Json;
        if (c?.id === next.toolId && next.actionId === 'start') c.state = 'starting';
      }
      const job = q.current;
      const started = Date.parse(job.startedAt!);
      const elapsed = t - started;
      const stepsMs = job.steps.length * JOB_STEP_MS;
      job.step = Math.min(job.steps.length - 1, Math.floor(elapsed / JOB_STEP_MS));
      job.phase = elapsed >= stepsMs ? 'verifying' : 'running';
      const lines: string[] = [];
      job.steps.forEach((s, i) => {
        const out = fakeOutput(s, job.targetVersion);
        const shown = i < job.step || job.phase === 'verifying' ? out.length : i === job.step ? Math.min(out.length, Math.floor((elapsed - i * JOB_STEP_MS) / 1000) + 1) : 0;
        lines.push(...out.slice(0, shown));
      });
      job.output = lines.slice(-200);
      if (elapsed < stepsMs + VERIFY_MS) return;
      finish(machine, job, started + stepsMs + VERIFY_MS);
      q.recent.unshift(job);
      q.recent.splice(10);
      q.current = null;
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: IncomingMessage): Promise<Json | null> => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) return null;
    }
    try {
      const v = JSON.parse(raw || '{}');
      return v && typeof v === 'object' ? (v as Json) : null;
    } catch {
      return null;
    }
  };
  const jobsView = (machine: string) => {
    const q = queues.get(machine)!;
    return JSON.parse(JSON.stringify({ current: q.current, queue: q.queue, recent: q.recent }));
  };

  return {
    allows(req, port) {
      const host = req.headers.host;
      const origin = req.headers.origin;
      if ((req.method !== 'POST' && req.method !== 'DELETE') || typeof origin !== 'string') return false;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
      const raw = req.url ?? '';
      return !raw.includes('?') && raw.startsWith('/api/tools/') && origin === `http://${host}`;
    },
    async handle(req, res, url) {
      const path = url.pathname;
      if (path !== '/api/tools' && !path.startsWith('/api/tools/')) return false;
      if (path === '/api/tools') {
        if (req.method !== 'GET') return (send(res, 405, { error: 'use GET' }), true);
        const machine = url.searchParams.get('machine') ?? 'local';
        const body = bodyOf(machine);
        if (!body) return (send(res, 404, { error: `máquina desconhecida: ${machine}` }), true);
        advance(machine);
        return (send(res, 200, { ...body, jobs: jobsView(machine) }), true);
      }
      if (path === '/api/tools/checks' || path === '/api/tools/mcp/checks') {
        if (req.method !== 'POST') return (send(res, 405, { error: 'use POST' }), true);
        const machine = String((await readJson(req))?.machine ?? 'local');
        const body = bodyOf(machine);
        if (!body) return (send(res, 404, { error: `máquina desconhecida: ${machine}` }), true);
        if (path === '/api/tools/checks') body.checkedAt = new Date(now()).toISOString();
        else (body.mcp as Json).statusCheckedAt = new Date(now()).toISOString();
        return (send(res, 202, { ok: true }), true);
      }
      const cancel = /^\/api\/tools\/jobs\/([\w-]{1,64})$/.exec(path);
      if (cancel) {
        if (req.method !== 'DELETE') return (send(res, 405, { error: 'use DELETE' }), true);
        for (const [machine, q] of queues) {
          advance(machine);
          const job = q.current?.id === cancel[1] ? q.current : q.queue.find((j) => j.id === cancel[1]);
          if (!job) continue;
          job.state = 'canceled';
          job.endedAt = new Date(now()).toISOString();
          job.exitCode = null;
          if (q.current === job) q.current = null;
          q.queue = q.queue.filter((j) => j !== job);
          q.recent.unshift(job);
          return (send(res, 200, { job }), true);
        }
        return (send(res, 404, { error: 'trabalho desconhecido' }), true);
      }
      const act = /^\/api\/tools\/([\w:.-]{1,80})\/actions\/(install|update|start|stop)$/.exec(path);
      if (!act) return (send(res, 404, { error: 'rota desconhecida' }), true);
      if (req.method !== 'POST') return (send(res, 405, { error: 'use POST' }), true);
      const request = await readJson(req);
      const machine = String(request?.machine ?? 'local');
      const body = bodyOf(machine);
      if (!body) return (send(res, 404, { error: `máquina desconhecida: ${machine}` }), true);
      const target = findTarget(body, act[1]!);
      const a = ((target?.actions as DemoAction[] | undefined) ?? []).find((x) => x.id === act[2]);
      if (!target || !a) return (send(res, 404, { error: 'ação desconhecida' }), true);
      if (!a.runnable) return (send(res, 403, { error: a.admin ? 'pede senha de administrador: o console não roda' : 'esta máquina não aceita a ação' }), true);
      if (act[1] === 'wrangler' && !bumped.has(machine)) {
        bumped.add(machine);
        const steps = [['npm', 'install', '-g', 'wrangler@4.47.3']];
        const fresh = { ...a, steps, targetVersion: '4.47.3', planDigest: demoDigest(machine, 'wrangler', a.id, 'npm', steps, a.timeoutSeconds) };
        target.latest = '4.47.3';
        target.actions = [fresh];
        return (send(res, 409, { error: 'o plano mudou: confira de novo', plan: { steps, sourceId: 'npm', targetVersion: '4.47.3', timeoutSeconds: a.timeoutSeconds, admin: false, planDigest: fresh.planDigest } }), true);
      }
      if (request?.planDigest !== a.planDigest) return (send(res, 409, { error: 'o plano mudou: confira de novo', plan: { steps: a.steps, sourceId: target.source ?? null, targetVersion: a.targetVersion, timeoutSeconds: a.timeoutSeconds, admin: a.admin, planDigest: a.planDigest } }), true);
      const job: DemoJob = {
        id: `job-${++seq}`,
        toolId: act[1]!,
        actionId: a.id,
        label: String(target.label ?? target.name ?? act[1]),
        machine,
        state: 'queued',
        steps: a.steps,
        step: 0,
        phase: 'running',
        startedAt: null,
        endedAt: null,
        exitCode: null,
        timeoutSeconds: a.timeoutSeconds,
        targetVersion: a.targetVersion,
        output: [],
        logFile: LOG_FILE,
      };
      advance(machine);
      queues.get(machine)!.queue.push(job);
      advance(machine);
      return (send(res, 202, { job }), true);
    },
  };
}
