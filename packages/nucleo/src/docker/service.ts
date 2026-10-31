// The Docker screen's data and actions for THIS machine (#288, decision 0017).
//
// - `view()` is `GET /api/docker`: the containers and stacks the daemon lists now, which action ids are
//   offered on each, the five clean options with what they may free, the daemon kind, and the jobs the
//   executor holds. No plan travels here: a plan (the argv, the digest) is asked for when a dialog opens
//   (`plan()`, `GET /api/docker/plan`), so a 179-container list stays small.
// - `act()` rebuilds the plan from a fresh read, compares the digest, and queues the steps on the Tools
//   executor (one job at a time per machine, FIFO, Cancel, masked output in tools.log). Nothing from the
//   request reaches a process but ids that must exist in that read.
// - The reading is cached 5 s so a burst of requests reads the daemon once; a job's end drops it.
// - The machine is always `local` here: the remote machine's núcleo runs its own service, and the Mac
//   only forwards the ids (src/api/docker.ts).

import type { JobsView } from '../tools/service.ts';
import type { EnqueueResult, JobSpec, ToolJob } from '../tools/executor.ts';
import {
  buildDockerPlan,
  CLEAN_KINDS,
  CLEAN_LABELS,
  cleanEstimate,
  DOCKER_TOOL_ID,
  type BlockedReason,
  type CleanKind,
  type DaemonKind,
  type DockerActionId,
  type DockerPlan,
  type Inventory,
} from './catalog.ts';
import { detectDaemon, readInventory, type InventoryContext } from './inventory.ts';

export const DOCKER_API_VERSION = 1;
export const LOCAL_DOCKER_MACHINE = 'local';
const CACHE_MS = 5_000;

export interface DockerStackView {
  name: string;
  running: number;
  stopped: number;
  ports: number[];
  /** The action ids offered now, in the order the screen shows them. */
  actions: DockerActionId[];
}

export interface DockerContainerView {
  id: string;
  name: string;
  image: string;
  running: boolean;
  status: string;
  stack: string | null;
  createdAt: string | null;
  actions: DockerActionId[];
}

/** A stack with no container left but with volumes: only `stack-remove-volumes` applies. */
export interface DockerLeftoverView {
  name: string;
  volumes: number;
  actions: DockerActionId[];
}

export interface DockerCleanView {
  kind: CleanKind;
  label: string;
  /** How many things it removes (containers, images, networks), `null` when unknown. */
  count: number | null;
  /** The most it may free; `null` when unknown. An estimate, never a promise. */
  estimateBytes: number | null;
}

export interface DockerView {
  version: number;
  machine: string;
  takenAt: string;
  /** `false` when the daemon did not answer: only `daemon` may be offered then. */
  available: boolean;
  daemon: { kind: DaemonKind | null; offered: boolean };
  summary: { running: number; stopped: number; stacks: number };
  stacks: DockerStackView[];
  containers: DockerContainerView[];
  leftovers: DockerLeftoverView[];
  clean: DockerCleanView[];
  /** Whether this núcleo takes actions from the tunnel (no `Origin`); the Mac shows Copiar comando otherwise. */
  acceptsRemoteActions: boolean;
  jobs: JobsView<ToolJob>;
}

export type DockerPlanResult = { kind: 'plan'; plan: DockerPlan } | { kind: 'unknown' } | { kind: 'not-offered'; reason: BlockedReason };
export type DockerActResult =
  | { kind: 'unknown' }
  | { kind: 'not-offered'; reason: BlockedReason }
  | { kind: 'stale'; plan: DockerPlan }
  | { kind: 'blocked'; plan: DockerPlan }
  | { kind: 'queued'; job: ToolJob };

/** What the service needs from the Tools executor: the queue and the jobs it holds. */
export interface DockerQueue {
  enqueue(machine: string, spec: JobSpec): EnqueueResult;
  jobs(machine: string): JobsView<ToolJob>;
}

export interface DockerServiceOptions extends InventoryContext {
  queue: DockerQueue;
  acceptsRemoteActions?: () => boolean;
  log?: (message: string) => void;
}

const STACK_ACTIONS: DockerActionId[] = ['stack-stop', 'stack-start', 'stack-remove'];
const CONTAINER_ACTIONS: DockerActionId[] = ['container-stop', 'container-restart', 'container-remove'];

export class DockerService {
  private readonly o: DockerServiceOptions;
  private cache: { at: number; inventory: Promise<Inventory | null> } | null = null;

  constructor(options: DockerServiceOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The daemon's state, cached 5 s; `fresh` skips the cache (a plan is judged against what is true now). */
  private read(fresh: boolean, volumeSizes = false): Promise<Inventory | null> {
    if (!fresh && !volumeSizes && this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.inventory;
    const inventory = readInventory(this.o, { volumeSizes }).catch(() => null);
    if (!volumeSizes) this.cache = { at: this.now(), inventory };
    return inventory;
  }

  invalidate(): void {
    this.cache = null;
  }

  async view(machine: string): Promise<DockerView | null> {
    if (machine !== LOCAL_DOCKER_MACHINE) return null;
    const inv = await this.read(false);
    const base = { version: DOCKER_API_VERSION, machine, takenAt: new Date(this.now()).toISOString(), acceptsRemoteActions: this.o.acceptsRemoteActions?.() ?? false, jobs: this.o.queue.jobs(machine) };
    if (inv === null) {
      // The daemon does not answer: the kind is read again without it, so Reiniciar the Docker can still show its command.
      return { ...base, available: false, daemon: { kind: await this.daemonKind(), offered: true }, summary: { running: 0, stopped: 0, stacks: 0 }, stacks: [], containers: [], leftovers: [], clean: [] };
    }
    const offered = (id: DockerActionId, target: string): DockerActionId | null => (buildDockerPlan(machine, inv, id, target).kind === 'plan' ? id : null);
    const stacks = new Map<string, DockerStackView>();
    for (const c of inv.containers) {
      if (c.stack === null) continue;
      const s = stacks.get(c.stack) ?? { name: c.stack, running: 0, stopped: 0, ports: [], actions: [] };
      if (c.running) s.running++;
      else s.stopped++;
      s.ports = [...new Set([...s.ports, ...c.ports])].sort((a, b) => a - b);
      stacks.set(c.stack, s);
    }
    for (const s of stacks.values()) s.actions = STACK_ACTIONS.filter((a) => offered(a, s.name) !== null);
    const leftovers = [...new Set(inv.volumes.filter((v) => v.stack !== null && !stacks.has(v.stack)).map((v) => v.stack!))].sort().map((name): DockerLeftoverView => ({ name, volumes: inv.volumes.filter((v) => v.stack === name).length, actions: offered('stack-remove-volumes', name) ? ['stack-remove-volumes'] : [] }));
    const stoppedNow = inv.containers.filter((c) => !c.running).length;
    return {
      ...base,
      available: true,
      daemon: { kind: inv.daemon, offered: inv.daemon !== null },
      summary: { running: inv.containers.length - stoppedNow, stopped: stoppedNow, stacks: stacks.size },
      stacks: [...stacks.values()].sort((a, b) => a.name.localeCompare(b.name)),
      containers: inv.containers.map((c) => ({ id: c.id, name: c.name, image: c.image, running: c.running, status: c.status, stack: c.stack, createdAt: c.createdAt, actions: CONTAINER_ACTIONS.filter((a) => offered(a, c.id) !== null) })),
      leftovers,
      clean: CLEAN_KINDS.map((kind): DockerCleanView => ({ kind, label: CLEAN_LABELS[kind], ...cleanEstimate(kind, inv, stoppedNow) })).filter((c) => offered('clean', c.kind) !== null),
    };
  }

  private async daemonKind(): Promise<DaemonKind | null> {
    // Without a `docker ps` answer there is no inventory; the kind comes from the same detection on its own.
    return detectDaemon(this.o).catch(() => null);
  }

  /** The plan a dialog shows. `daemon-restart` also works when the daemon does not answer. */
  async plan(machine: string, actionId: string, target: string | null): Promise<DockerPlanResult> {
    if (machine !== LOCAL_DOCKER_MACHINE) return { kind: 'unknown' };
    const inv = await this.planInventory(actionId);
    if (inv === null) return actionId === 'daemon-restart' ? this.daemonPlanWithoutInventory(machine) : { kind: 'unknown' };
    const r = buildDockerPlan(machine, inv, actionId, target);
    return r.kind === 'plan' ? { kind: 'plan', plan: r.plan } : r.kind === 'not-offered' ? r : { kind: 'unknown' };
  }

  private planInventory(actionId: string): Promise<Inventory | null> {
    // Volume sizes are read only for the plan that lists them; everything else judges against a fresh read.
    return this.read(true, actionId === 'stack-remove-volumes');
  }

  private async daemonPlanWithoutInventory(machine: string): Promise<DockerPlanResult> {
    const kind = await this.daemonKind();
    if (kind === null) return { kind: 'not-offered', reason: 'no-runtime' };
    const empty: Inventory = { containers: [], volumes: [], reclaimable: {}, danglingImages: null, networks: { unused: null }, stoppedOlderThan24h: 0, daemon: kind };
    const r = buildDockerPlan(machine, empty, 'daemon-restart', null);
    return r.kind === 'plan' ? { kind: 'plan', plan: r.plan } : { kind: 'unknown' };
  }

  async act(machine: string, actionId: string, target: string | null, digest: string): Promise<DockerActResult> {
    const r = await this.plan(machine, actionId, target);
    if (r.kind !== 'plan') return r;
    if (r.plan.planDigest !== digest) return { kind: 'stale', plan: r.plan };
    // The núcleo never runs an admin step (decision 0014 section 3): the Docker of the system is shown to copy.
    if (!r.plan.runnable) return { kind: 'blocked', plan: r.plan };
    const { plan } = r;
    const queued = this.o.queue.enqueue(machine, {
      toolId: DOCKER_TOOL_ID,
      actionId: plan.actionId,
      label: plan.label,
      steps: plan.steps,
      timeoutSeconds: plan.timeoutSeconds,
      targetVersion: null,
      key: `${DOCKER_TOOL_ID} ${plan.actionId} ${plan.target ?? ''}`,
      after: () => this.invalidate(),
    });
    this.o.log?.(`docker (${machine}): ${plan.actionId} ${plan.target ?? ''} queued (job ${queued.job.id})`);
    return queued;
  }
}
