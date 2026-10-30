// What the Docker actions card shows and sends (issue 288, decision 0017, wireframes C92 to C95). Pure: the
// test imports it without the DOM. Nothing here builds a command: the argv of every dialog comes from
// `GET /api/docker/plan`, and the screen sends back only an action id, a target id and the plan's digest.

import { bytes, DASH } from './machine-format.js';

export const DOCKER_ROUTE = '/api/docker';
export const PAGE_SIZE = 25;
export const POLL_MS = 15_000;
export const RUNNING_POLL_MS = 2_000;

const MACHINE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TARGET = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ACTIONS = ['stack-stop', 'stack-start', 'stack-remove', 'stack-remove-volumes', 'container-stop', 'container-restart', 'container-remove', 'clean', 'daemon-restart'];

export const dockerRoute = (machine) => `${DOCKER_ROUTE}?machine=${encodeURIComponent(machine)}`;
export const planRoute = (machine, action, target) => `${DOCKER_ROUTE}/plan?machine=${encodeURIComponent(machine)}&action=${encodeURIComponent(action)}${target ? `&target=${encodeURIComponent(target)}` : ''}`;
export const actionRoute = (action) => `${DOCKER_ROUTE}/actions/${action}`;
export const jobRoute = (id) => `${DOCKER_ROUTE}/jobs/${id}`;
export const isDockerAction = (a) => ACTIONS.includes(a);
export const isTarget = (t) => typeof t === 'string' && (TARGET.test(t) || /^[a-f0-9]{12}$/.test(t));
export const isMachine = (m) => MACHINE.test(m);

/** [icon, label, danger] of each action, as the buttons say it. */
export const ACTION_BUTTONS = {
  'stack-stop': ['square', 'Parar', false],
  'stack-start': ['play', 'Subir', false],
  'stack-remove': ['trash', 'Remover…', true],
  'stack-remove-volumes': ['trash', 'Remover os volumes…', true],
  'container-stop': ['square', 'Parar', false],
  'container-restart': ['rotate-cw', 'Reiniciar', false],
  'container-remove': ['trash', 'Remover…', true],
};

export const FILTERS = [
  ['all', 'Todos'],
  ['running', 'Rodando'],
  ['stopped', 'Parados'],
  ['loose', 'Sem stack'],
];

const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
const count = (v) => (Number.isFinite(v) ? v : 0);

/** The body of `GET /api/docker` as the card reads it: `{ status, view }`; `view` is `null` unless `status` is `ok`. */
export function normalizeDocker(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.status === 'unreachable' || body.status === 'unsupported') return { status: body.status, view: null };
  if (body.status !== 'ok' || body.version !== 1) return null;
  const jobs = body.jobs ?? {};
  return {
    status: 'ok',
    view: {
      available: body.available === true,
      daemon: { kind: str(body.daemon?.kind) || null, offered: body.daemon?.offered === true },
      summary: { running: count(body.summary?.running), stopped: count(body.summary?.stopped), stacks: count(body.summary?.stacks) },
      stacks: list(body.stacks).map((s) => ({ name: str(s.name), running: count(s.running), stopped: count(s.stopped), ports: list(s.ports).filter(Number.isInteger), actions: list(s.actions).filter(isDockerAction) })),
      containers: list(body.containers).map((c) => ({ id: str(c.id), name: str(c.name), image: str(c.image), running: c.running === true, status: str(c.status), stack: c.stack ? str(c.stack) : null, createdAt: c.createdAt ? str(c.createdAt) : null, actions: list(c.actions).filter(isDockerAction) })),
      leftovers: list(body.leftovers).map((s) => ({ name: str(s.name), volumes: count(s.volumes), actions: list(s.actions).filter(isDockerAction) })),
      clean: list(body.clean).map((c) => ({ kind: str(c.kind), label: str(c.label), count: Number.isFinite(c.count) ? c.count : null, estimateBytes: Number.isFinite(c.estimateBytes) ? c.estimateBytes : null })),
      acceptsRemoteActions: body.acceptsRemoteActions === true,
      jobs: { current: dockerJob(jobs.current), queue: list(jobs.queue).map(dockerJob).filter(Boolean), recent: list(jobs.recent).map(dockerJob).filter(Boolean) },
    },
  };
}

/** A job of this card (`toolId` docker), or `null` for any other (the Tools screen's). */
function dockerJob(j) {
  if (!j || typeof j !== 'object' || j.toolId !== 'docker' || typeof j.id !== 'string') return null;
  return { id: j.id, actionId: str(j.actionId), label: str(j.label), state: str(j.state), step: count(j.step), steps: list(j.steps).map((s) => list(s).map(str)), startedAt: j.startedAt ? str(j.startedAt) : null, endedAt: j.endedAt ? str(j.endedAt) : null, exitCode: Number.isFinite(j.exitCode) ? j.exitCode : null, timeoutSeconds: count(j.timeoutSeconds), output: list(j.output).map(str), logFile: str(j.logFile) };
}

export const jobRunning = (j) => j?.state === 'running';

/** The plan of a dialog (`GET /api/docker/plan`), checked field by field; `null` when it is not one. */
export function normalizePlan(body) {
  const p = body?.plan;
  if (!p || typeof p !== 'object' || !isDockerAction(p.actionId) || !/^[0-9a-f]{16}$/.test(str(p.planDigest))) return null;
  return {
    actionId: p.actionId,
    target: p.target ? str(p.target) : null,
    label: str(p.label),
    steps: list(p.steps).map((s) => list(s).map(str)),
    timeoutSeconds: count(p.timeoutSeconds),
    admin: p.admin === true,
    runnable: p.runnable === true,
    ids: list(p.ids).map(str),
    volumes: list(p.volumes).map((v) => ({ name: str(v.name), sizeBytes: Number.isFinite(v.sizeBytes) ? v.sizeBytes : null, keptBy: v.keptBy ? str(v.keptBy) : null })),
    estimateBytes: Number.isFinite(p.estimateBytes) ? p.estimateBytes : null,
    count: Number.isFinite(p.count) ? p.count : null,
    running: count(p.running),
    planDigest: p.planDigest,
  };
}

/** The command lines of a plan, one per step; more than three ids say "e mais N" (the digest covers all of them). */
export function commandLines(plan) {
  return plan.steps.map((s) => {
    const shown = s.length > 5 ? [...s.slice(0, 5), `… e mais ${s.length - 5}`] : s;
    return shown.join(' ');
  });
}

/** The whole command text of a plan, to copy: every id, one line per step. */
export function commandText(plan) {
  return plan.steps.map((s) => s.join(' ')).join('\n');
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What happens, in a sentence, for the dialog of `plan`. */
export function whatHappens(plan) {
  const ids = plan.ids.length;
  switch (plan.actionId) {
    case 'stack-stop':
      return `${plural(plan.running, 'container rodando é parado', 'containers rodando são parados')}, um por um, com 10 s para fechar. Dados e volumes ficam.`;
    case 'stack-start':
      return `${plural(ids, 'container parado sobe', 'containers parados sobem')} de novo. Dados e volumes ficam.`;
    case 'stack-remove': {
      const stopped = plan.running ? `${plural(plan.running, 'container rodando é parado', 'containers rodando são parados')} e ` : '';
      return `${stopped}${plural(ids, 'container é removido', 'containers são removidos')}. As imagens, os volumes e as redes ficam.`;
    }
    case 'stack-remove-volumes':
      return `${plural(plan.count ?? 0, 'volume é apagado', 'volumes são apagados')}${plan.estimateBytes === null ? '' : ` (${bytes(plan.estimateBytes)})`}. Os dados somem e não voltam.`;
    case 'container-stop':
      return 'O container é parado, com 10 s para fechar. Dados e volumes ficam.';
    case 'container-restart':
      return 'Para e sobe de novo. Quem usa as portas dele perde a conexão por alguns segundos.';
    case 'container-remove':
      return `${plan.running ? 'Ele é parado e removido' : 'O container sai'}. A imagem e os volumes ficam.`;
    case 'clean':
      return `${plan.count === null ? 'Remove o que não tem uso' : plural(plan.count, 'item sai', 'itens saem')}${plan.estimateBytes === null ? '' : `, no máximo ${bytes(plan.estimateBytes)}`}. Nada em uso é tocado.`;
    case 'daemon-restart':
      return `O daemon para e sobe. ${plan.running ? `${plural(plan.running, 'container que roda para', 'containers que rodam param')}` : 'Nenhum container roda agora'}; só voltam sozinhos os de restart: always.`;
    default:
      return '';
  }
}

export const timeoutText = (seconds) => (seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`) + ' · Cancelar a qualquer momento';

/** `Total reclaimed space: 1.2GB` in a prune's output, as pt-BR text, or `null`. */
export function reclaimedFrom(output) {
  for (const line of [...output].reverse()) {
    const m = /Total reclaimed space:\s*([\d.]+)\s*([kKMGT]?B)/.exec(line);
    if (m) return `${m[1].replace('.', ',')} ${m[2].toUpperCase()}`;
  }
  return null;
}

export function containerFilter(containers, filter, query) {
  const q = query.trim().toLowerCase();
  return containers.filter((c) => (filter === 'running' ? c.running : filter === 'stopped' ? !c.running : filter === 'loose' ? c.stack === null : true) && (q === '' || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || c.id.startsWith(q)));
}

export function filterCounts(containers) {
  return { all: containers.length, running: containers.filter((c) => c.running).length, stopped: containers.filter((c) => !c.running).length, loose: containers.filter((c) => c.stack === null).length };
}

/** `há 2 dias`, from the creation time. */
export function since(createdAt, now = Date.now()) {
  const t = Date.parse(createdAt ?? '');
  if (Number.isNaN(t)) return DASH;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** The container name's prefix before its last hash-like suffix, to group the dozens of `floci-aws-gp-local-ecs-*`. */
export function namePrefix(name) {
  const m = /^(.*?)[-_][0-9a-f]{6,}$/.exec(name);
  return m ? m[1] : name;
}

export function stackLine(s) {
  return [s.running ? `${s.running} rodando` : null, s.stopped ? `${s.stopped} ${s.stopped === 1 ? 'parado' : 'parados'}` : null].filter(Boolean).join(' · ');
}

/** The pt-BR text for a refused write. */
export function refusalText(e) {
  const reason = e?.body?.reason;
  if (e?.status === 403 && reason === 'remote-actions-disabled') return 'A Workstation não aceita ações pelo túnel: suba o núcleo de lá com --accept-remote-actions, ou copie o comando.';
  if (e?.status === 404) return 'O Docker mudou desde que a tela leu: atualizando a lista.';
  if (e?.status === 409 && e?.body?.plan) return 'O plano mudou desde que você abriu: confira o novo comando.';
  if (e?.status === 409) return e?.message || 'Esta ação não está disponível agora.';
  return e?.message || 'O núcleo não respondeu.';
}
