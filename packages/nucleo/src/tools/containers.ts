// The containers card (#280, decision 0014 section 7): which runtime this machine uses, whether it
// runs, the VM and the container counts. Read-only, local, through the injected runner (5 s each).
//
// - macOS: Colima (recommended) from `colima status --json` (exit 0 = running); Docker Desktop found
//   (context `desktop-linux` or a binary inside Docker.app) is read only; neither: Colima missing, with
//   the catalog's install.
// - Linux: Docker without root when the user unit exists (`systemctl --user cat docker.service`),
//   its state from `systemctl --user is-active docker`; else Docker Engine, `systemctl is-active
//   docker` (start and stop ask for sudo: admin actions, shown to copy).
// - Windows: Podman (`podman machine inspect`), else Docker Desktop read only, else Podman missing.
// - Counts from `docker ps -a --format {{.State}}`, the context from `docker context show`.

import type { ActionId, ContainerRuntimeId, Platform } from './catalog.ts';
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

export interface ContainersView<A> {
  runtime: ContainerRuntimeId | null;
  /** The catalog entry the actions belong to (`POST /api/tools/<toolId>/actions/<id>`, layer 2). */
  toolId: string | null;
  state: ContainerState;
  readOnly: boolean;
  version: string | null;
  vm: ContainerVm | null;
  dockerContext: string | null;
  containers: { running: number; stopped: number } | null;
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

export async function readContainers<A>(ctx: ContainersContext<A>): Promise<ContainersView<A>> {
  const run = async (exe: string | null, args: string[]) => (exe ? ctx.run([exe, ...args], { timeoutMs: PROBE_TIMEOUT_MS, env: ctx.env }).catch(() => null) : null);
  const det = (id: string) => ctx.detections.get(id);
  const docker = det('container-docker-desktop') ?? det('docker');
  const dockerExe = docker?.binaryPath ?? null;
  const context = dockerExe ? (await run(dockerExe, ['context', 'show']))?.stdout.trim() || null : null;
  const counts = async () => {
    const r = await run(dockerExe, ['ps', '-a', '--format', '{{.State}}']);
    return ok(r) ? parseDockerStates(r.stdout) : null;
  };
  const actions = (toolId: string, ids: ActionId[]) => ids.map((id) => ctx.action(toolId, id)).filter((a): a is A => a !== null);
  const view = (v: Partial<ContainersView<A>> & Pick<ContainersView<A>, 'runtime' | 'toolId' | 'state'>): ContainersView<A> => ({
    runtime: v.runtime,
    toolId: v.toolId,
    state: v.state,
    readOnly: false,
    version: null,
    vm: null,
    dockerContext: context,
    containers: null,
    actions: [],
    ...v,
  });
  const dockerDesktop = async (): Promise<ContainersView<A> | null> => {
    if (!docker?.installed) return null;
    const inApp = /\/Docker\.app\/|Docker[\\/]Docker[\\/]resources/i.test(docker.realPath ?? '');
    if (context !== 'desktop-linux' && !inApp) return null;
    const info = await run(dockerExe, ['info', '--format', '{{.ServerVersion}}']);
    const state: ContainerState = ok(info) ? 'running' : 'stopped';
    return view({ runtime: 'docker-desktop', toolId: 'container-docker-desktop', state, readOnly: true, version: docker.installed, containers: state === 'running' ? await counts() : null });
  };

  if (ctx.platform === 'darwin') {
    const colima = det('container-colima');
    if (colima?.installed) {
      const status = await run(colima.binaryPath, ['status', '--json']);
      const state: ContainerState = ok(status) ? 'running' : 'stopped';
      return view({
        runtime: 'colima',
        toolId: 'container-colima',
        state,
        version: colima.installed,
        vm: ok(status) ? parseColimaStatus(status.stdout) : null,
        containers: state === 'running' ? await counts() : null,
        actions: actions('container-colima', [state === 'running' ? 'stop' : 'start']),
      });
    }
    return (await dockerDesktop()) ?? view({ runtime: 'colima', toolId: 'container-colima', state: 'missing', actions: actions('container-colima', ['install']) });
  }

  if (ctx.platform === 'linux') {
    const desktop = await dockerDesktop();
    if (desktop) return desktop;
    const systemctl = docker?.installed ? await ctx.resolve('systemctl') : null;
    const rootless = systemctl ? await run(systemctl, ['--user', 'cat', 'docker.service']) : null;
    if (ok(rootless)) {
      const active = (await run(systemctl, ['--user', 'is-active', 'docker']))?.stdout.trim();
      const state: ContainerState = active === 'active' ? 'running' : active === 'activating' ? 'starting' : 'stopped';
      return view({
        runtime: 'docker-rootless',
        toolId: 'container-docker-rootless',
        state,
        version: docker?.installed ?? null,
        containers: state === 'running' ? await counts() : null,
        actions: actions('container-docker-rootless', [state === 'running' ? 'stop' : 'start']),
      });
    }
    if (docker?.installed) {
      const active = (await run(systemctl, ['is-active', 'docker']))?.stdout.trim();
      const state: ContainerState = active === 'active' ? 'running' : active === 'activating' ? 'starting' : 'stopped';
      return view({
        runtime: 'docker-engine',
        toolId: 'container-docker-engine',
        state,
        version: docker.installed,
        containers: state === 'running' ? await counts() : null,
        actions: actions('container-docker-engine', [state === 'running' ? 'stop' : 'start']),
      });
    }
    return view({ runtime: 'docker-engine', toolId: 'container-docker-engine', state: 'missing' });
  }

  const podman = det('container-podman');
  if (podman?.installed) {
    const inspect = await run(podman.binaryPath, ['machine', 'inspect']);
    const state: ContainerState = ok(inspect) ? parsePodmanMachineState(inspect.stdout) : 'stopped';
    return view({
      runtime: 'podman',
      toolId: 'container-podman',
      state,
      version: podman.installed,
      containers: state === 'running' ? await counts() : null,
      actions: actions('container-podman', [state === 'running' ? 'stop' : 'start']),
    });
  }
  return (await dockerDesktop()) ?? view({ runtime: 'podman', toolId: 'container-podman', state: 'missing', actions: actions('container-podman', ['install']) });
}
