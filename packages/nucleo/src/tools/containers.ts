// The containers card (#280, decision 0014 section 7): which runtime this machine uses, whether it
// runs, the VM and the container counts. Read-only, local, through the injected runner (5 s each).
//
// - macOS: Colima (recommended) from `colima status --json` (exit 0 = running); no Colima: Colima
//   missing, with the catalog's install. Docker Desktop found (context `desktop-linux` or a binary
//   inside Docker.app) goes in `detected`, read only.
// - Linux: Docker without root when the user unit exists (`systemctl --user cat docker.service`),
//   its state from `systemctl --user is-active docker`; else Docker Engine, `systemctl is-active
//   docker` (start and stop ask for sudo: admin actions, shown to copy).
// - Windows: Podman (`podman machine inspect`), else Podman missing; Docker Desktop in `detected`.
// - Linux with Docker Desktop: it is the runtime, read only.
// - Counts from `docker ps -a --format {{.State}}`, the disk from `docker system df`, the context from
//   `docker context show`. `version` and `note` are pt-BR, for display.

import type { ActionId, ContainerRuntimeId, Platform } from './catalog.ts';
import { DOCKER_DF_ARGS, parseDockerDf } from '../telemetry/adapters/common.ts';
import type { Detection } from './probe.ts';
import { PROBE_TIMEOUT_MS, type RunResult, type ToolRunner } from './runner.ts';

export type ContainerState = 'running' | 'stopped' | 'starting' | 'missing';

export interface ContainerVm {
  cpus: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  arch: string | null;
  vmType: string | null;
}

/** A read-only runtime found next to the proposal (Docker Desktop): shown, never started nor updated. */
export interface DetectedRuntime {
  runtime: ContainerRuntimeId;
  version: string | null;
  state: ContainerState;
}

export interface ContainersView<A> {
  runtime: ContainerRuntimeId | null;
  /** The catalog entry the actions belong to (`POST /api/tools/<id>/actions/<actionId>`, layer 2). */
  id: string | null;
  state: ContainerState;
  readOnly: boolean;
  /** pt-BR, for display: `Colima 0.9.1 · Docker CLI 28.5.1 · perfil default`. */
  version: string | null;
  vm: ContainerVm | null;
  /** What `docker system df` counts (images, containers, volumes, build cache), when running. */
  diskUsedBytes: number | null;
  dockerContext: string | null;
  containers: { running: number; stopped: number } | null;
  /** pt-BR one-liner, or `null`. */
  note: string | null;
  detected: DetectedRuntime[];
  actions: A[];
}

export interface ContainersContext<A> {
  platform: Platform;
  detections: ReadonlyMap<string, Detection>;
  run: ToolRunner;
  env: NodeJS.ProcessEnv;
  /** The full path of an executable on the login PATH, or `null`. */
  resolve: (name: string) => Promise<string | null>;
  /** The action of a catalog entry as the API shows it, or `null` when the catalog has none. */
  action: (toolId: string, actionId: ActionId) => A | null;
}

const ok = (r: RunResult | null): r is RunResult => r !== null && r.code === 0;

export function parseColimaStatus(out: string): ContainerVm | null {
  try {
    const j = JSON.parse(out) as { cpu?: number; memory?: number; disk?: number; arch?: string; driver?: string; vm_type?: string };
    const driver = j.vm_type ?? j.driver ?? null;
    const vmType = driver === null ? null : /virtualization|^vz$/i.test(driver) ? 'vz' : /qemu/i.test(driver) ? 'qemu' : driver.toLowerCase();
    const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    return { cpus: num(j.cpu), memoryBytes: num(j.memory), diskBytes: num(j.disk), arch: j.arch ?? null, vmType };
  } catch {
    return null;
  }
}

export function parseDockerStates(out: string): { running: number; stopped: number } {
  const states = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const running = states.filter((s) => s === 'running').length;
  return { running, stopped: states.length - running };
}

export function parsePodmanMachineState(out: string): ContainerState {
  const s = /"State"\s*:\s*"(\w+)"/.exec(out)?.[1]?.toLowerCase();
  return s === 'running' ? 'running' : s === 'starting' ? 'starting' : 'stopped';
}

const NOTES = {
  colimaMissing: 'A proposta é o Colima com o Docker CLI: código aberto e sem licença por empresa.',
  engine: 'O serviço é do sistema: iniciar e parar pedem sudo.',
  rootless: 'Docker sem root: inicia e para sem senha.',
  podmanMissing: 'O Podman Desktop é código aberto; o docker continua funcionando pelo socket compatível. Ligar o WSL 2 pede administrador.',
  desktop: 'O console mostra o estado do Docker Desktop, mas não o inicia nem o atualiza.',
};

/** `colima status --json`'s profile: `colima` is the default one. */
export function colimaProfile(out: string): string | null {
  try {
    const name = (JSON.parse(out) as { display_name?: string }).display_name;
    if (!name) return null;
    return name === 'colima' ? 'default' : name.replace(/^colima-/, '');
  } catch {
    return null;
  }
}

/** `docker version --format {{.Server.Platform.Name}}`: `Docker Desktop 4.48.0 (207573)` → `4.48.0`. */
export function parseDockerDesktopVersion(out: string): string | null {
  return /Docker Desktop (\d+(?:\.\d+)+)/.exec(out)?.[1] ?? null;
}

export async function readContainers<A>(ctx: ContainersContext<A>): Promise<ContainersView<A>> {
  const run = async (exe: string | null, args: string[]) => (exe ? ctx.run([exe, ...args], { timeoutMs: PROBE_TIMEOUT_MS, env: ctx.env }).catch(() => null) : null);
  const det = (id: string) => ctx.detections.get(id);
  const docker = det('container-docker-desktop') ?? det('docker');
  const dockerExe = docker?.binaryPath ?? null;
  const dockerCli = docker?.installed ? `Docker CLI ${docker.installed}` : null;
  const context = dockerExe ? (await run(dockerExe, ['context', 'show']))?.stdout.trim() || null : null;
  const running = async () => {
    const [ps, df] = await Promise.all([run(dockerExe, ['ps', '-a', '--format', '{{.State}}']), run(dockerExe, DOCKER_DF_ARGS)]);
    return {
      containers: ok(ps) ? parseDockerStates(ps.stdout) : null,
      diskUsedBytes: ok(df) ? parseDockerDf(df.stdout).reduce((sum, r) => sum + r.sizeBytes, 0) : null,
    };
  };
  const actions = (toolId: string, ids: ActionId[]) => ids.map((id) => ctx.action(toolId, id)).filter((a): a is A => a !== null);
  const view = (v: Partial<ContainersView<A>> & Pick<ContainersView<A>, 'runtime' | 'id' | 'state'>): ContainersView<A> => ({
    runtime: v.runtime,
    id: v.id,
    state: v.state,
    readOnly: false,
    version: null,
    vm: null,
    diskUsedBytes: null,
    dockerContext: context,
    containers: null,
    note: null,
    detected: [],
    actions: [],
    ...v,
  });
  /** Docker Desktop, when the docker on the PATH is its own (context `desktop-linux`, or inside the app). */
  const dockerDesktop = async (): Promise<DetectedRuntime | null> => {
    if (!docker?.installed) return null;
    const inApp = /\/Docker\.app\/|Docker[\\/]Docker[\\/]resources/i.test(docker.realPath ?? '');
    if (context !== 'desktop-linux' && !inApp) return null;
    const r = await run(dockerExe, ['version', '--format', '{{.Server.Platform.Name}}']);
    return { runtime: 'docker-desktop', version: ok(r) ? parseDockerDesktopVersion(r.stdout) : null, state: ok(r) ? 'running' : 'stopped' };
  };
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;

  if (ctx.platform === 'darwin' || ctx.platform === 'win32') {
    const desktop = await dockerDesktop();
    const detected = desktop ? [desktop] : [];
    if (ctx.platform === 'darwin') {
      const colima = det('container-colima');
      if (!colima?.installed) return view({ runtime: 'colima', id: 'container-colima', state: 'missing', note: NOTES.colimaMissing, detected, actions: actions('container-colima', ['install']) });
      const status = await run(colima.binaryPath, ['status', '--json']);
      const state: ContainerState = ok(status) ? 'running' : 'stopped';
      const profile = ok(status) ? colimaProfile(status.stdout) : null;
      return view({
        runtime: 'colima',
        id: 'container-colima',
        state,
        version: join(`Colima ${colima.installed}`, dockerCli, profile ? `perfil ${profile}` : null),
        vm: ok(status) ? parseColimaStatus(status.stdout) : null,
        ...(state === 'running' ? await running() : {}),
        detected,
        actions: actions('container-colima', [state === 'running' ? 'stop' : 'start']),
      });
    }
    const podman = det('container-podman');
    if (!podman?.installed) return view({ runtime: 'podman', id: 'container-podman', state: 'missing', note: NOTES.podmanMissing, detected, actions: actions('container-podman', ['install']) });
    const inspect = await run(podman.binaryPath, ['machine', 'inspect']);
    const state: ContainerState = ok(inspect) ? parsePodmanMachineState(inspect.stdout) : 'stopped';
    return view({
      runtime: 'podman',
      id: 'container-podman',
      state,
      version: `Podman ${podman.installed}`,
      ...(state === 'running' ? await running() : {}),
      detected,
      actions: actions('container-podman', [state === 'running' ? 'stop' : 'start']),
    });
  }

  // Linux
  const desktop = await dockerDesktop();
  if (desktop) return view({ runtime: 'docker-desktop', id: 'container-docker-desktop', state: desktop.state, readOnly: true, version: join(desktop.version ? `Docker Desktop ${desktop.version}` : 'Docker Desktop', dockerCli), note: NOTES.desktop, ...(desktop.state === 'running' ? await running() : {}) });
  const systemctl = docker?.installed ? await ctx.resolve('systemctl') : null;
  const rootless = systemctl ? await run(systemctl, ['--user', 'cat', 'docker.service']) : null;
  const unitState = (active: string | undefined): ContainerState => (active === 'active' ? 'running' : active === 'activating' ? 'starting' : 'stopped');
  if (ok(rootless)) {
    const state = unitState((await run(systemctl, ['--user', 'is-active', 'docker']))?.stdout.trim());
    return view({
      runtime: 'docker-rootless',
      id: 'container-docker-rootless',
      state,
      version: join(`Docker sem root ${docker?.installed ?? ''}`.trim(), 'systemd do usuário'),
      note: NOTES.rootless,
      ...(state === 'running' ? await running() : {}),
      actions: actions('container-docker-rootless', [state === 'running' ? 'stop' : 'start']),
    });
  }
  if (docker?.installed) {
    const state = unitState((await run(systemctl, ['is-active', 'docker']))?.stdout.trim());
    return view({
      runtime: 'docker-engine',
      id: 'container-docker-engine',
      state,
      version: join(`Docker Engine ${docker.installed}`, 'systemd'),
      note: NOTES.engine,
      ...(state === 'running' ? await running() : {}),
      actions: actions('container-docker-engine', [state === 'running' ? 'stop' : 'start']),
    });
  }
  return view({ runtime: 'docker-engine', id: 'container-docker-engine', state: 'missing' });
}
