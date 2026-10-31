// The closed catalog of Docker actions (#288, decision 0017): what the núcleo may run on the daemon and
// how each argv list is built. Nothing here reads a request: a plan is built from an `Inventory` (what
// the daemon says now) plus the ids the screen sent, and every id must exist in that inventory.
//
// - Each step is an argv list: `docker`, then the arguments one by one. No shell, no `&&`, no `$VAR`.
// - Stack actions name a Compose project (the `com.docker.compose.project` label) and act on the
//   container ids the daemon lists for it; container actions name a 12-character id. Neither is ever a
//   command, a path or a free name.
// - `stack-remove` never touches volumes. `stack-remove-volumes` is its own action, offered only when
//   the stack has no container left, and it never lists a volume a container (of any stack) still mounts.
// - `clean` has five kinds, each one command. No `system prune`, no `--all`, no `volume prune`: those
//   delete what is still in use (volumes wait for the "Liberar volume" step).
// - `daemon-restart`: the Docker without root (`systemctl --user`) and Colima run without a password; the
//   Docker of the system asks for sudo, so its plan is `admin` and only shown to copy (the executor
//   refuses any step whose executable is sudo, doas…, whatever this file says).
// - The `planDigest` covers the machine, the action, the target, the steps and the timeout: the screen
//   sends back the one it showed, and the núcleo refuses (409) to run anything else.

import { createHash } from 'node:crypto';
import { isAdminExecutable } from '../tools/catalog.ts';

export const DOCKER_ACTIONS = ['stack-stop', 'stack-start', 'stack-remove', 'stack-remove-volumes', 'container-stop', 'container-restart', 'container-remove', 'clean', 'daemon-restart'] as const;
export type DockerActionId = (typeof DOCKER_ACTIONS)[number];

export const CLEAN_KINDS = ['containers-24h', 'containers', 'images', 'networks', 'builder'] as const;
export type CleanKind = (typeof CLEAN_KINDS)[number];

export const DAEMON_KINDS = ['colima', 'rootless', 'system'] as const;
export type DaemonKind = (typeof DAEMON_KINDS)[number];

/** A Compose project name, as Compose writes it in the label. */
export const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** The short id `docker ps` shows. */
export const CONTAINER_ID = /^[a-f0-9]{12}$/;
export const PLAN_DIGEST = /^[0-9a-f]{16}$/;

export const DOCKER_TOOL_ID = 'docker';
/** The most ids one command carries (a stack with more is split by the caller; none exists today). */
const MAX_IDS = 200;

export interface DockerContainer {
  /** The 12-character id. */
  id: string;
  name: string;
  image: string;
  running: boolean;
  /** `Up 2 days`, `Exited (0) 6 days ago`, as the daemon says. */
  status: string;
  /** The Compose project, or `null`. */
  stack: string | null;
  /** Named volumes the container mounts. */
  volumes: string[];
  /** ISO time the container was created, or `null`. */
  createdAt: string | null;
  /** Host ports it publishes, sorted. */
  ports: number[];
}

export interface DockerVolume {
  name: string;
  stack: string | null;
  sizeBytes: number | null;
}

export interface Inventory {
  containers: DockerContainer[];
  volumes: DockerVolume[];
  /** What `docker system df` says is reclaimable, by type (`Containers`, `Images`, `Build Cache`). */
  reclaimable: Record<string, number | null>;
  /** The images without a tag (`docker images -f dangling=true`): count and bytes, or `null` when unread. */
  danglingImages: { count: number; bytes: number } | null;
  networks: { unused: number | null };
  /** `containers-24h`: how many stopped containers are older than 24 h, from their creation time. */
  stoppedOlderThan24h: number;
  daemon: DaemonKind | null;
}

export type BlockedReason = 'admin' | 'stack-present' | 'nothing-to-do' | 'no-runtime';

export interface DockerPlanVolume {
  name: string;
  sizeBytes: number | null;
  /** `null` when it will be removed; else why it stays (`tessera306-api-1`). */
  keptBy: string | null;
}

export interface DockerPlan {
  actionId: DockerActionId;
  /** The stack name, the container id, the clean kind or `null`. */
  target: string | null;
  /** pt-BR, for display and for the job: `Parar a stack tessera306`. */
  label: string;
  steps: string[][];
  timeoutSeconds: number;
  admin: boolean;
  runnable: boolean;
  blockedReason: BlockedReason | null;
  /** The containers or volumes the steps touch, for the confirmation. */
  ids: string[];
  /** The volumes of `stack-remove-volumes`, with the ones that stay. */
  volumes: DockerPlanVolume[];
  /** What `clean` says it may free (an estimate, `null` when unknown). */
  estimateBytes: number | null;
  /** How many things the command touches (containers, images, networks), when known. */
  count: number | null;
  /** The counts the confirmation states: running containers a stop or restart interrupts, etc. */
  running: number;
  planDigest: string;
}

export type PlanOutcome = { kind: 'plan'; plan: DockerPlan } | { kind: 'unknown-target' } | { kind: 'not-offered'; reason: BlockedReason };

export function planDigest(p: { machine: string; actionId: string; target: string | null; steps: readonly (readonly string[])[]; timeoutSeconds: number }): string {
  // Fixed key order: the same plan always gives the same digest.
  const canonical = JSON.stringify({ machine: p.machine, actionId: p.actionId, target: p.target, steps: p.steps, timeoutSeconds: p.timeoutSeconds });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const label = {
  'stack-stop': (t: string) => `Parar a stack ${t}`,
  'stack-start': (t: string) => `Subir a stack ${t}`,
  'stack-remove': (t: string) => `Remover a stack ${t}`,
  'stack-remove-volumes': (t: string) => `Remover os volumes da stack ${t}`,
  'container-stop': (t: string) => `Parar o container ${t}`,
  'container-restart': (t: string) => `Reiniciar o container ${t}`,
  'container-remove': (t: string) => `Remover o container ${t}`,
} as const;

export const CLEAN_LABELS: Record<CleanKind, string> = {
  'containers-24h': 'Limpar os containers parados há mais de 1 dia',
  containers: 'Limpar todos os containers parados',
  images: 'Limpar as imagens sem nome',
  networks: 'Limpar as redes sem uso',
  builder: 'Limpar o cache de build',
};

/** The one command of each clean kind. */
export const CLEAN_ARGV: Record<CleanKind, string[]> = {
  'containers-24h': ['docker', 'container', 'prune', '--force', '--filter', 'until=24h'],
  containers: ['docker', 'container', 'prune', '--force'],
  images: ['docker', 'image', 'prune', '--force'],
  networks: ['docker', 'network', 'prune', '--force'],
  builder: ['docker', 'builder', 'prune', '--force'],
};

const DAEMON_ARGV: Record<DaemonKind, string[]> = {
  colima: ['colima', 'restart'],
  rootless: ['systemctl', '--user', 'restart', 'docker'],
  system: ['sudo', 'systemctl', 'restart', 'docker'],
};

const STOP_SECONDS_PER_CONTAINER = 12;

function finish(machine: string, p: Omit<DockerPlan, 'planDigest' | 'admin' | 'runnable' | 'blockedReason'> & { blockedReason?: BlockedReason | null }): DockerPlan {
  const admin = p.steps.some((s) => isAdminExecutable(s[0] ?? ''));
  const blockedReason = admin ? 'admin' : (p.blockedReason ?? null);
  return {
    ...p,
    admin,
    blockedReason,
    runnable: blockedReason === null && p.steps.length > 0,
    planDigest: planDigest({ machine, actionId: p.actionId, target: p.target, steps: p.steps, timeoutSeconds: p.timeoutSeconds }),
  };
}

const empty = { ids: [] as string[], volumes: [] as DockerPlanVolume[], estimateBytes: null, count: null, running: 0 };
const timeoutFor = (containers: number) => Math.min(1800, 60 + containers * STOP_SECONDS_PER_CONTAINER);

/**
 * The plan of one action, or why there is none. `target` is validated here against the inventory: a
 * stack that has no container, an id the daemon does not list or a kind outside `CLEAN_KINDS` is
 * `unknown-target`. An action that has nothing to do right now (stop a stack with nothing running) is
 * `not-offered`, so the screen never shows a button for it.
 */
export function buildDockerPlan(machine: string, inventory: Inventory, actionId: string, target: string | null): PlanOutcome {
  const containers = inventory.containers;
  switch (actionId) {
    case 'stack-stop':
    case 'stack-start':
    case 'stack-remove': {
      if (target === null || !STACK_NAME.test(target)) return { kind: 'unknown-target' };
      const mine = containers.filter((c) => c.stack === target);
      if (mine.length === 0) return { kind: 'unknown-target' };
      const running = mine.filter((c) => c.running);
      const stopped = mine.filter((c) => !c.running);
      const name = label[actionId](target);
      if (actionId === 'stack-stop') {
        if (running.length === 0) return { kind: 'not-offered', reason: 'nothing-to-do' };
        return { kind: 'plan', plan: finish(machine, { ...empty, actionId, target, label: name, steps: [['docker', 'stop', ...ids(running)]], timeoutSeconds: timeoutFor(running.length), ids: ids(running), running: running.length }) };
      }
      if (actionId === 'stack-start') {
        if (stopped.length === 0) return { kind: 'not-offered', reason: 'nothing-to-do' };
        return { kind: 'plan', plan: finish(machine, { ...empty, actionId, target, label: name, steps: [['docker', 'start', ...ids(stopped)]], timeoutSeconds: timeoutFor(stopped.length), ids: ids(stopped) }) };
      }
      const steps: string[][] = [];
      if (running.length > 0) steps.push(['docker', 'stop', ...ids(running)]);
      steps.push(['docker', 'rm', ...ids(mine)]);
      return { kind: 'plan', plan: finish(machine, { ...empty, actionId, target, label: name, steps, timeoutSeconds: timeoutFor(mine.length), ids: ids(mine), running: running.length }) };
    }
    case 'stack-remove-volumes': {
      if (target === null || !STACK_NAME.test(target)) return { kind: 'unknown-target' };
      const mine = inventory.volumes.filter((v) => v.stack === target);
      if (mine.length === 0) return { kind: 'unknown-target' };
      // The volumes go only after the stack: with a container of it still there, volume rm would fail anyway.
      if (containers.some((c) => c.stack === target)) return { kind: 'not-offered', reason: 'stack-present' };
      const volumes = mine.map((v): DockerPlanVolume => ({ name: v.name, sizeBytes: v.sizeBytes, keptBy: containers.find((c) => c.volumes.includes(v.name))?.name ?? null }));
      const removable = volumes.filter((v) => v.keptBy === null);
      if (removable.length === 0) return { kind: 'not-offered', reason: 'nothing-to-do' };
      const known = removable.every((v) => v.sizeBytes !== null);
      return {
        kind: 'plan',
        plan: finish(machine, { ...empty, actionId, target, label: label[actionId](target), steps: [['docker', 'volume', 'rm', ...removable.map((v) => v.name)]], timeoutSeconds: 120, volumes, estimateBytes: known ? removable.reduce((a, v) => a + (v.sizeBytes ?? 0), 0) : null, count: removable.length }),
      };
    }
    case 'container-stop':
    case 'container-restart':
    case 'container-remove': {
      if (target === null || !CONTAINER_ID.test(target)) return { kind: 'unknown-target' };
      const c = containers.find((x) => x.id === target);
      if (!c) return { kind: 'unknown-target' };
      const name = label[actionId](c.name);
      const base = { ...empty, actionId, target, label: name, timeoutSeconds: 90, ids: [c.id], running: c.running ? 1 : 0 };
      if (actionId === 'container-stop') {
        if (!c.running) return { kind: 'not-offered', reason: 'nothing-to-do' };
        return { kind: 'plan', plan: finish(machine, { ...base, steps: [['docker', 'stop', c.id]] }) };
      }
      if (actionId === 'container-restart') return { kind: 'plan', plan: finish(machine, { ...base, steps: [['docker', 'restart', c.id]] }) };
      return { kind: 'plan', plan: finish(machine, { ...base, steps: c.running ? [['docker', 'stop', c.id], ['docker', 'rm', c.id]] : [['docker', 'rm', c.id]] }) };
    }
    case 'clean': {
      if (target === null || !(CLEAN_KINDS as readonly string[]).includes(target)) return { kind: 'unknown-target' };
      const kind = target as CleanKind;
      const stopped = containers.filter((c) => !c.running).length;
      const est = cleanEstimate(kind, inventory, stopped);
      if (est.count === 0 && kind !== 'builder' && kind !== 'networks') return { kind: 'not-offered', reason: 'nothing-to-do' };
      return { kind: 'plan', plan: finish(machine, { ...empty, actionId, target, label: CLEAN_LABELS[kind], steps: [CLEAN_ARGV[kind]], timeoutSeconds: kind === 'builder' ? 600 : 300, estimateBytes: est.bytes, count: est.count }) };
    }
    case 'daemon-restart': {
      if (inventory.daemon === null) return { kind: 'not-offered', reason: 'no-runtime' };
      const running = containers.filter((c) => c.running).length;
      return { kind: 'plan', plan: finish(machine, { ...empty, actionId, target: inventory.daemon, label: 'Reiniciar o Docker', steps: [DAEMON_ARGV[inventory.daemon]], timeoutSeconds: 120, running }) };
    }
    default:
      return { kind: 'unknown-target' };
  }
}

const ids = (cs: readonly DockerContainer[]) => cs.slice(0, MAX_IDS).map((c) => c.id);

/** What a clean kind may free: an upper bound from `docker system df`, never a promise. */
export function cleanEstimate(kind: CleanKind, inv: Inventory, stoppedNow: number): { count: number | null; bytes: number | null } {
  switch (kind) {
    case 'containers':
      return { count: stoppedNow, bytes: inv.reclaimable.Containers ?? null };
    case 'containers-24h':
      return { count: inv.stoppedOlderThan24h, bytes: inv.reclaimable.Containers ?? null };
    case 'images':
      return { count: inv.danglingImages?.count ?? null, bytes: inv.danglingImages?.bytes ?? null };
    case 'networks':
      return { count: inv.networks.unused, bytes: 0 };
    case 'builder':
      return { count: null, bytes: inv.reclaimable['Build Cache'] ?? null };
  }
}
