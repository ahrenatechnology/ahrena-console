// What the Mac believes of the remote núcleo's Docker answers (#288, decision 0017 section 5): every
// answer is re-projected field by field, with known enums, capped lengths and counts, before it reaches
// the screen. The remote is another núcleo (ours, on the user's own machine), but its Docker names and
// output are text from containers, so nothing is passed through as it came.

import { CLEAN_KINDS, DAEMON_KINDS, DOCKER_ACTIONS, PLAN_DIGEST, type BlockedReason, type DockerActionId, type DockerPlan } from './catalog.ts';
import type { DockerView } from './service.ts';
import type { ToolJob } from '../tools/executor.ts';

const MAX_CONTAINERS = 1000;
const MAX_STACKS = 200;
const MAX_JOBS = 20;
const MAX_OUTPUT_LINES = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown, max = 1e12): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const actions = (v: unknown): DockerActionId[] => arr(v, 10).flatMap((a) => oneOf(a, DOCKER_ACTIONS) ?? []);
const BLOCKED: readonly BlockedReason[] = ['admin', 'stack-present', 'nothing-to-do', 'no-runtime'];
const STATES = ['queued', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'] as const;
const MACHINE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeJob(v: unknown): ToolJob | null {
  const j = obj(v);
  if (!j) return null;
  const id = str(j.id, 12);
  const state = oneOf(j.state, STATES);
  if (!id || !/^[a-f0-9]{12}$/.test(id) || !state) return null;
  return {
    id,
    toolId: str(j.toolId, 64) ?? '',
    actionId: str(j.actionId, 64) ?? '',
    label: str(j.label, 200) ?? '',
    machine: str(j.machine, 64) ?? '',
    state,
    steps: arr(j.steps, 8).map((s) => arr(s, 400).flatMap((a) => str(a, 300) ?? [])),
    step: int(j.step, 1000) ?? 0,
    phase: j.phase === 'verifying' ? 'verifying' : 'running',
    startedAt: str(j.startedAt, 40),
    endedAt: str(j.endedAt, 40),
    exitCode: num(j.exitCode),
    timeoutSeconds: int(j.timeoutSeconds, 86_400) ?? 0,
    targetVersion: null,
    output: arr(j.output, MAX_OUTPUT_LINES).flatMap((l) => str(l, 500) ?? []),
    logFile: str(j.logFile, 300) ?? '',
  };
}

function sanitizeJobs(v: unknown): DockerView['jobs'] {
  const j = obj(v);
  const list = (x: unknown) => arr(x, MAX_JOBS).flatMap((e) => sanitizeJob(e) ?? []);
  const batch = obj(j?.batch);
  return { current: sanitizeJob(j?.current), queue: list(j?.queue), recent: list(j?.recent), batch: batch ? { total: int(batch.total, 1e6) ?? 0, done: int(batch.done, 1e6) ?? 0 } : null };
}

export function sanitizePlan(v: unknown): DockerPlan | null {
  const p = obj(v);
  if (!p) return null;
  const actionId = oneOf(p.actionId, DOCKER_ACTIONS);
  const digest = str(p.planDigest, 16);
  if (!actionId || !digest || !PLAN_DIGEST.test(digest)) return null;
  return {
    actionId,
    target: str(p.target, 128),
    label: str(p.label, 200) ?? '',
    steps: arr(p.steps, 8).map((s) => arr(s, 400).flatMap((a) => str(a, 300) ?? [])),
    timeoutSeconds: int(p.timeoutSeconds, 86_400) ?? 0,
    admin: p.admin === true,
    runnable: p.runnable === true,
    blockedReason: oneOf(p.blockedReason, BLOCKED),
    ids: arr(p.ids, 400).flatMap((i) => str(i, 64) ?? []),
    volumes: arr(p.volumes, 100).flatMap((e) => {
      const o = obj(e);
      const name = str(o?.name, 200);
      return name ? [{ name, sizeBytes: int(o?.sizeBytes), keptBy: str(o?.keptBy, 200) }] : [];
    }),
    estimateBytes: int(p.estimateBytes),
    count: int(p.count, 1e9),
    running: int(p.running, 1e6) ?? 0,
    planDigest: digest,
  };
}

/** The remote's `GET /api/docker` as this Mac shows it, under the remote machine's id; `null` when it is not that shape. */
export function sanitizeDockerView(v: unknown, machine: string): DockerView | null {
  const b = obj(v);
  if (!b || b.version !== 1 || !MACHINE.test(machine)) return null;
  const daemon = obj(b.daemon);
  const summary = obj(b.summary);
  return {
    version: 1,
    machine,
    takenAt: str(b.takenAt, 40) ?? '',
    available: b.available === true,
    daemon: { kind: oneOf(daemon?.kind, DAEMON_KINDS), offered: daemon?.offered === true },
    summary: { running: int(summary?.running, 1e6) ?? 0, stopped: int(summary?.stopped, 1e6) ?? 0, stacks: int(summary?.stacks, 1e6) ?? 0 },
    stacks: arr(b.stacks, MAX_STACKS).flatMap((e) => {
      const s = obj(e);
      const name = str(s?.name, 128);
      return name ? [{ name, running: int(s?.running, 1e6) ?? 0, stopped: int(s?.stopped, 1e6) ?? 0, ports: arr(s?.ports, 64).flatMap((p) => int(p, 65535) ?? []), actions: actions(s?.actions) }] : [];
    }),
    containers: arr(b.containers, MAX_CONTAINERS).flatMap((e) => {
      const c = obj(e);
      const id = str(c?.id, 12);
      if (!id || !/^[a-f0-9]{12}$/.test(id)) return [];
      return [{ id, name: str(c?.name, 200) ?? '', image: str(c?.image, 300) ?? '', running: c?.running === true, status: str(c?.status, 120) ?? '', stack: str(c?.stack, 128), createdAt: str(c?.createdAt, 40), actions: actions(c?.actions) }];
    }),
    leftovers: arr(b.leftovers, MAX_STACKS).flatMap((e) => {
      const s = obj(e);
      const name = str(s?.name, 128);
      return name ? [{ name, volumes: int(s?.volumes, 1e6) ?? 0, actions: actions(s?.actions) }] : [];
    }),
    clean: arr(b.clean, 10).flatMap((e) => {
      const c = obj(e);
      const kind = oneOf(c?.kind, CLEAN_KINDS);
      return kind ? [{ kind, label: str(c?.label, 200) ?? '', count: int(c?.count, 1e9), estimateBytes: int(c?.estimateBytes) }] : [];
    }),
    acceptsRemoteActions: b.acceptsRemoteActions === true,
    jobs: sanitizeJobs(b.jobs),
  };
}

export { sanitizeJobs };
