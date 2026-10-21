// What the Ferramentas screen shows (C72 to C76, issue 280, decision 0014), without the DOM: the
// routes, the defensive reading of `GET /api/tools`, the stats, the bands, the row actions, the
// confirm dialog's text and the job lines. The test imports this file directly.
//
// The screen never builds a command: it shows the steps the core sent (each argv joined by spaces)
// and POSTs the item id, the action id and the plan's digest. Values of MCP env and headers never
// reach this file (the core drops them); only names and counts are shown.

export const TOOLS_ROUTE = '/api/tools';
export const CHECKS_ROUTE = '/api/tools/checks';
export const MCP_CHECKS_ROUTE = '/api/tools/mcp/checks';
export const MACHINES_ROUTE = '/api/machines';
export const LOCAL_ID = 'local';
/** While a job runs or a first check is reading, the screen re-reads this often. */
export const POLL_MS = 2000;
/** How long a finished job keeps its band on top (unless closed). */
export const BAND_MS = 30 * 60_000;
export const DASH = '—';

const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_ID = /^[A-Za-z0-9][\w:.-]{0,79}$/;
const JOB_ID = /^[\w-]{1,64}$/;
const ACTIONS = new Set(['install', 'update', 'start', 'stop']);

export const isMachineId = (id) => typeof id === 'string' && MACHINE_ID.test(id);

/** The machine of `?machine=`; anything else is this machine. */
export function machineFromSearch(search) {
  const id = new URLSearchParams(search ?? '').get('machine');
  return isMachineId(id) ? id : LOCAL_ID;
}

export const toolsRoute = (machine) => `${TOOLS_ROUTE}?machine=${encodeURIComponent(machine)}`;
export const screenUrl = (machine) => (machine === LOCAL_ID ? '/ui/tools' : `/ui/tools?machine=${encodeURIComponent(machine)}`);
export function actionRoute(toolId, actionId) {
  if (!TOOL_ID.test(String(toolId)) || !ACTIONS.has(actionId)) throw new Error(`ação inválida: ${toolId} ${actionId}`);
  return `${TOOLS_ROUTE}/${encodeURIComponent(toolId)}/actions/${actionId}`;
}
export function jobRoute(id) {
  if (!JOB_ID.test(String(id))) throw new Error(`trabalho inválido: ${id}`);
  return `${TOOLS_ROUTE}/jobs/${id}`;
}

// ---------- reading the body, field by field ----------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v, max = 200) => (Array.isArray(v) ? v.slice(0, max) : []);
const oneOf = (v, values, fallback) => (values.includes(v) ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

const ITEM_STATES = ['ok', 'outdated', 'missing', 'manual', 'failed', 'checking', 'na'];
const BLOCKED = ['admin', 'offline', 'no-manager', 'remote-read-only', 'invalid-version'];
const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'];

function normalizeSteps(v) {
  return list(v, 10)
    .filter((s) => Array.isArray(s) && s.length && s.every((a) => typeof a === 'string'))
    .map((s) => s.slice(0, 40).map((a) => a.slice(0, 300)));
}

export function normalizeAction(a) {
  if (!isObject(a) || !ACTIONS.has(a.id)) return null;
  const blockedReason = oneOf(a.blockedReason, BLOCKED, null);
  const admin = a.admin === true;
  return {
    id: a.id,
    runnable: a.runnable === true && !admin && blockedReason === null,
    admin,
    blockedReason: admin ? 'admin' : blockedReason,
    steps: normalizeSteps(a.steps),
    timeoutSeconds: num(a.timeoutSeconds) ?? 600,
    targetVersion: str(a.targetVersion, 40),
    planDigest: str(a.planDigest, 64),
  };
}
const actionsOf = (v) => list(v, 6).map(normalizeAction).filter(Boolean);

function normalizeItem(i) {
  if (!isObject(i) || !TOOL_ID.test(String(i.id)) || !str(i.label)) return null;
  return {
    id: i.id,
    label: str(i.label, 80),
    group: oneOf(i.group, ['cli', 'runtime', 'container', 'mcp'], 'cli'),
    binary: str(i.binary, 60),
    manager: str(i.manager, 120),
    installed: str(i.installed, 40),
    latest: str(i.latest, 40),
    latestCheckedAt: isoOrNull(i.latestCheckedAt),
    latestError: str(i.latestError, 300),
    source: str(i.source, 30),
    state: oneOf(i.state, ITEM_STATES, 'checking'),
    note: str(i.note, 300),
    actions: actionsOf(i.actions),
  };
}

function normalizeContainers(c) {
  if (!isObject(c)) return null;
  const vm = isObject(c.vm) ? { cpus: num(c.vm.cpus), memoryBytes: num(c.vm.memoryBytes), diskBytes: num(c.vm.diskBytes), arch: str(c.vm.arch, 20), vmType: str(c.vm.vmType, 20) } : null;
  const counts = isObject(c.containers) ? { running: num(c.containers.running) ?? 0, stopped: num(c.containers.stopped) ?? 0 } : null;
  return {
    toolId: str(c.toolId, 80) ?? str(c.id, 80),
    runtime: oneOf(c.runtime, ['colima', 'docker-engine', 'docker-rootless', 'podman', 'docker-desktop'], null),
    state: oneOf(c.state, ['running', 'stopped', 'starting', 'missing'], 'missing'),
    readOnly: c.readOnly === true,
    version: str(c.version, 200),
    vm,
    diskUsedBytes: num(c.diskUsedBytes),
    dockerContext: str(c.dockerContext, 60),
    containers: counts,
    note: str(c.note, 400),
    detected: list(c.detected, 4)
      .filter(isObject)
      .map((d) => ({ runtime: oneOf(d.runtime, ['colima', 'docker-engine', 'docker-rootless', 'podman', 'docker-desktop'], null), version: str(d.version, 40), state: oneOf(d.state, ['running', 'stopped', 'starting', 'missing'], 'stopped') }))
      .filter((d) => d.runtime),
    actions: actionsOf(c.actions),
  };
}

function normalizeServer(s) {
  if (!isObject(s) || !str(s.name)) return null;
  // Only names and counts: a value that came by mistake has no field to land in.
  const names = (v) => list(v, 20).filter((n) => typeof n === 'string' && /^[\w.-]{1,80}$/.test(n));
  return {
    id: str(s.id, 80) ?? s.name,
    name: str(s.name, 80),
    scope: oneOf(s.scope, ['user', 'local', 'project'], 'user'),
    project: str(s.project, 120),
    transport: oneOf(s.transport, ['stdio', 'http', 'sse'], 'stdio'),
    command: str(s.command, 80),
    package: str(s.package, 120),
    version: str(s.version, 40),
    latest: str(s.latest, 40),
    host: str(s.host, 120),
    envCount: num(s.envCount) ?? 0,
    envNames: names(s.envNames),
    headerCount: num(s.headerCount) ?? 0,
    headerNames: names(s.headerNames),
    state: oneOf(s.state, ['connected', 'failed', 'needs-login', 'unknown'], 'unknown'),
    note: str(s.note, 300),
    actions: actionsOf(s.actions),
  };
}

export function normalizeJob(j) {
  if (!isObject(j) || !JOB_ID.test(String(j.id)) || !str(j.toolId)) return null;
  return {
    id: j.id,
    toolId: j.toolId,
    actionId: oneOf(j.actionId, [...ACTIONS], 'update'),
    label: str(j.label, 80) ?? j.toolId,
    machine: str(j.machine, 64) ?? LOCAL_ID,
    state: oneOf(j.state, JOB_STATES, 'queued'),
    steps: normalizeSteps(j.steps),
    step: Math.max(0, num(j.step) ?? 0),
    phase: oneOf(j.phase, ['running', 'verifying'], 'running'),
    startedAt: isoOrNull(j.startedAt),
    endedAt: isoOrNull(j.endedAt),
    exitCode: num(j.exitCode),
    timeoutSeconds: num(j.timeoutSeconds) ?? 600,
    targetVersion: str(j.targetVersion, 40),
    output: list(j.output, 200).filter((l) => typeof l === 'string').map((l) => l.slice(0, 500)),
    logFile: str(j.logFile, 300),
  };
}

/** The body of `GET /api/tools`, field by field; `null` when it is not one. */
export function normalizeOverview(body) {
  if (!isObject(body) || !isObject(body.machine) || !Array.isArray(body.items)) return null;
  const m = body.machine;
  const managers = isObject(body.managers) ? body.managers : {};
  const manager = (k) => (isObject(managers[k]) ? { present: managers[k].present === true, install: str(managers[k].install, 400), listsUpdatedAt: isoOrNull(managers[k].listsUpdatedAt) } : { present: false, install: null, listsUpdatedAt: null });
  const jobs = isObject(body.jobs) ? body.jobs : {};
  const mcp = isObject(body.mcp) ? body.mcp : {};
  return {
    machine: {
      id: isMachineId(m.id) ? m.id : LOCAL_ID,
      label: str(m.label, 60) ?? 'Esta máquina',
      platform: oneOf(m.platform, ['darwin', 'linux', 'win32'], 'darwin'),
      os: str(m.os, 60),
      arch: str(m.arch, 20),
      host: str(m.host, 60),
    },
    checkedAt: isoOrNull(body.checkedAt),
    nextCheckAt: isoOrNull(body.nextCheckAt),
    network: oneOf(body.network, ['online', 'offline', 'unknown'], 'unknown'),
    managers: { homebrew: manager('homebrew'), winget: manager('winget'), apt: manager('apt') },
    actionsAllowed: body.actionsAllowed === true,
    stale: body.stale === true,
    readAt: isoOrNull(body.readAt),
    items: list(body.items, 200).map(normalizeItem).filter(Boolean),
    containers: normalizeContainers(body.containers),
    mcp: { statusCheckedAt: isoOrNull(mcp.statusCheckedAt), servers: list(mcp.servers, 100).map(normalizeServer).filter(Boolean) },
    jobs: {
      current: normalizeJob(jobs.current),
      queue: list(jobs.queue, 50).map(normalizeJob).filter(Boolean),
      recent: list(jobs.recent, 20).map(normalizeJob).filter(Boolean),
    },
  };
}

/** The remotes of `GET /api/machines` (this machine is always first in the selector). */
export function remotesOf(body) {
  return list(body, 50)
    .filter((m) => isObject(m) && isMachineId(m.id) && m.id !== LOCAL_ID)
    .map((m) => ({ id: m.id, label: str(m.label, 40) ?? m.id, state: str(m.state, 30) }));
}

// ---------- text ----------

/** A step as the person reads it: the argv joined by spaces, nothing quoted or added. */
export const argvLine = (step) => step.join(' ');

const pad = (n) => String(n).padStart(2, '0');
export function timeOfDay(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function ago(iso, now) {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}
/** "0:18", "10:00", "1:02:05". */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
/** "24 s", "1 min 2 s", "1 h 3 min". */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const timeoutText = (seconds) => (seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`);
export function bytes(n) {
  if (n === null || n === undefined) return DASH;
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: n >= 1e10 ? 0 : 1 })} GB`;
  return `${Math.round(n / 1e6)} MB`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const machineName = (o) => (o.machine.id === LOCAL_ID ? 'Esta máquina' : o.machine.label);
export const isRemote = (o) => o.machine.id !== LOCAL_ID;

/** The header's subtitle. */
export function subtitleOf(o, now) {
  const parts = [];
  if (isRemote(o) && o.machine.host) parts.push(o.machine.host);
  if (o.machine.os) parts.push(o.machine.os);
  if (!isRemote(o) && o.machine.arch) parts.push(o.machine.arch);
  if (o.stale) {
    const at = o.readAt ?? o.checkedAt;
    parts.push(at ? `última leitura às ${timeOfDay(at)}, ${ago(at, now)}` : 'sem leitura ainda');
    return parts.join(' · ');
  }
  if (isRemote(o)) parts.push('lido do núcleo de lá');
  if (!o.checkedAt) parts.push('verificando pela primeira vez');
  else if (isRemote(o)) parts.push(`versões mais recentes verificadas lá às ${timeOfDay(o.checkedAt)}`);
  else parts.push(`verificado às ${timeOfDay(o.checkedAt)}, ${ago(o.checkedAt, now)}, no cache dos gerenciadores e dos fornecedores`);
  return parts.join(' · ');
}

// ---------- states and badges ----------

const STATE_BADGE = {
  ok: ['b-completed', 'Em dia'],
  outdated: ['b-waiting', 'Desatualizada'],
  missing: ['b-abandoned', 'Faltando'],
  failed: ['b-error', 'Falhou'],
  manual: ['tl-b-idle', 'Instalada à mão'],
  checking: ['tl-b-idle', 'Verificando'],
  na: ['tl-b-idle', 'Não se aplica'],
  running: ['b-active', 'Atualizando'],
  installing: ['b-active', 'Instalando'],
};
export const badgeOf = (state) => STATE_BADGE[state] ?? STATE_BADGE.checking;

const ENDED = new Set(['succeeded', 'failed', 'timed-out', 'canceled']);
export const isEnded = (j) => ENDED.has(j.state);

/** The job of a tool on this machine: running, queued, or the last one that ended. */
export function jobOf(o, toolId) {
  if (o.jobs.current?.toolId === toolId) return o.jobs.current;
  const queued = o.jobs.queue.find((j) => j.toolId === toolId);
  if (queued) return queued;
  return o.jobs.recent.find((j) => j.toolId === toolId) ?? null;
}

/** The badge of an item row, with its job on top of the item's state. */
export function itemBadge(o, item, now) {
  const job = jobOf(o, item.id);
  if (job?.state === 'running') return badgeOf(job.actionId === 'install' ? 'installing' : 'running');
  if (job && (job.state === 'failed' || job.state === 'timed-out') && job.endedAt && now - Date.parse(job.endedAt) < BAND_MS && item.state !== 'ok') return badgeOf('failed');
  return badgeOf(item.state);
}

/** An item that asks for something from the person (the "Pedem ação" filter). */
export const needsAction = (i) => i.state === 'outdated' || i.state === 'missing' || i.state === 'failed' || (i.state === 'manual' && i.actions.length > 0);

/** The main action of a row (the one the button shows), or `null`. */
export const mainAction = (i) => i.actions.find((a) => a.id === 'update') ?? i.actions.find((a) => a.id === 'install') ?? i.actions[0] ?? null;

/**
 * What the action cell of a row shows:
 * `busy` (running), `queued`, `done` (ended well a moment ago), `run` (Atualizar/Instalar, enabled),
 * `off` (the same button, disabled, with the reason), `sudo` (Precisa de sudo, opens the commands),
 * `copy` (Copiar comando: a remote that does not accept actions), `none` (—).
 */
export function rowAction(o, item, now, { frozen = false } = {}) {
  if (frozen) return { kind: 'none' };
  const job = jobOf(o, item.id);
  if (job?.state === 'running') return { kind: 'busy', job };
  if (job?.state === 'queued') return { kind: 'queued', job };
  const a = mainAction(item);
  if (!a) return job?.state === 'succeeded' && job.endedAt && now - Date.parse(job.endedAt) < BAND_MS ? { kind: 'done', job } : { kind: 'none' };
  if (a.admin || a.blockedReason === 'admin') return { kind: 'sudo', action: a };
  if (a.blockedReason === 'remote-read-only') return { kind: 'copy', action: a };
  if (!a.runnable) return { kind: 'off', action: a, reason: BLOCKED_TEXT[a.blockedReason] ?? 'Indisponível agora' };
  return { kind: 'run', action: a };
}

export const BLOCKED_TEXT = {
  offline: 'Sem rede: instalar e atualizar ficam desligados',
  'no-manager': 'Falta o gerenciador de pacotes desta máquina',
  'invalid-version': 'A versão mais recente não foi lida: verifique de novo',
  'remote-read-only': 'A máquina remota não aceita ações daqui',
  admin: 'Pede senha de administrador: o console não roda',
};

export function actionLabel(actionId, remote) {
  const base = { install: 'Instalar', update: 'Atualizar', start: 'Iniciar', stop: 'Parar' }[actionId] ?? 'Rodar';
  return remote && (actionId === 'install' || actionId === 'update') ? `${base} lá` : base;
}

// ---------- filters, Atualizar N and the stats ----------

export const FILTERS = [
  ['all', 'Todas'],
  ['action', 'Pedem ação'],
  ['ok', 'Em dia'],
];
export function filterItems(items, filter) {
  if (filter === 'action') return items.filter(needsAction);
  if (filter === 'ok') return items.filter((i) => i.state === 'ok');
  return items;
}
export const filterCounts = (items) => ({ all: items.length, action: items.filter(needsAction).length, ok: items.filter((i) => i.state === 'ok').length });

/** "Atualizar N": the runnable updates of CLIs and runtimes, without sudo, in screen order (not MCP). */
export function updatable(o) {
  if (!o.actionsAllowed || o.stale) return [];
  return o.items
    .filter((i) => (i.group === 'cli' || i.group === 'runtime') && i.state === 'outdated' && !jobOf(o, i.id)?.state?.match(/^(queued|running)$/))
    .map((i) => ({ item: i, action: i.actions.find((a) => a.id === 'update' && a.runnable && !a.admin) }))
    .filter((x) => x.action);
}

const RUNTIME_LABEL = { colima: 'Colima', 'docker-engine': 'Docker Engine', 'docker-rootless': 'Docker sem root', podman: 'Podman Desktop', 'docker-desktop': 'Docker Desktop' };
export const runtimeLabel = (r) => RUNTIME_LABEL[r] ?? 'Sem runtime';
const CONTAINER_STATE = { running: ['b-completed', 'Rodando'], stopped: ['tl-b-idle', 'Parado'], starting: ['b-active', 'Iniciando'], missing: ['b-abandoned', 'Faltando'] };
export const containerBadge = (state) => CONTAINER_STATE[state] ?? CONTAINER_STATE.missing;

export function mcpBadge(s) {
  if (s.version && s.latest && s.version !== s.latest && s.actions.length) return badgeOf('outdated');
  return { connected: ['b-completed', 'Conectado'], failed: ['b-error', 'Falhou'], 'needs-login': ['b-waiting', 'Precisa de login'], unknown: ['tl-b-idle', 'Não verificado'] }[s.state];
}

/** Everything in order: nothing outdated, missing or failed, no MCP failing, the containers up. */
export function allOk(o) {
  if (!o.checkedAt || o.stale || o.network === 'offline') return false;
  if (o.items.some((i) => i.state !== 'ok' && i.state !== 'na')) return false;
  if (o.mcp.servers.some((s) => s.state === 'failed' || s.state === 'needs-login' || (s.version && s.latest && s.version !== s.latest))) return false;
  return !o.containers || o.containers.state === 'running';
}

/** The cards on top: six, or three when everything is in order (C74 1). */
export function statCards(o) {
  const cli = o.items.filter((i) => i.group === 'cli' && i.state !== 'na');
  const rt = o.items.filter((i) => i.group === 'runtime' && i.state !== 'na');
  const na = o.items.filter((i) => i.state === 'na');
  const servers = o.mcp.servers;
  const failed = servers.filter((s) => s.state === 'failed').length;
  const login = servers.filter((s) => s.state === 'needs-login').length;
  const mcpSub = failed || login ? [failed ? `${failed} falhou` : null, login ? `${login} precisa de login` : null].filter(Boolean).join(' · ') : o.mcp.statusCheckedAt ? 'todos conectados' : 'estado não verificado';
  const c = o.containers;
  const ctValue = c?.runtime ? runtimeLabel(c.runtime).split(' ')[0] : 'Nenhum';
  const ctSub = !c || c.state === 'missing' ? 'nenhum runtime' : c.state === 'running' ? `rodando${c.containers ? ` · ${plural(c.containers.running, 'container no ar', 'containers no ar')}` : ''}` : containerBadge(c.state)[1].toLowerCase();
  const checking = !o.checkedAt;
  const ok = cli.filter((i) => i.state === 'ok').length;
  const manual = cli.filter((i) => i.state === 'manual').length;
  const cliSub = checking ? 'lendo as versões' : [ok === cli.length ? 'todas em dia' : `${ok} em dia`, manual ? `${manual} instalada${manual === 1 ? '' : 's'} à mão` : null, na.length ? `${na.map((i) => i.label).join(', ')} não se aplica` : null].filter(Boolean).join(' · ');
  if (allOk(o)) {
    return [
      { id: 'cli', label: 'CLIs', value: String(cli.length), sub: 'todas em dia', icon: 'terminal', tone: 'ok' },
      { id: 'mcp', label: 'Servidores MCP', value: String(servers.length), sub: servers.length ? 'todos conectados' : 'nenhum configurado', icon: 'plug', tone: 'ok' },
      { id: 'containers', label: 'Containers', value: ctValue, sub: ctSub, icon: 'container', tone: 'ok' },
    ];
  }
  const outdated = [...cli, ...rt].filter((i) => i.state === 'outdated' || (i.state === 'manual' && i.actions.some((a) => a.id === 'update')));
  const oCli = outdated.filter((i) => i.group === 'cli' && i.state === 'outdated').length;
  const oRt = outdated.filter((i) => i.group === 'runtime' && i.state === 'outdated').length;
  const outdatedOnly = oCli + oRt;
  const sudo = [...cli, ...rt].filter((i) => i.state === 'outdated' && mainAction(i)?.admin);
  const outSub = checking
    ? 'esperando o gerenciador'
    : outdatedOnly
      ? [oCli ? plural(oCli, 'CLI', 'CLIs') : null, oRt ? plural(oRt, 'plataforma', 'plataformas') : null, sudo.length ? `${sudo.length} com sudo` : 'todas sem sudo'].filter(Boolean).join(' · ')
      : 'nada desatualizado';
  const missing = o.items.filter((i) => i.state === 'missing');
  const runtimeManual = rt.filter((i) => i.state === 'manual');
  return [
    { id: 'cli', label: 'CLIs', value: String(cli.length), sub: cliSub, icon: 'terminal', tone: 'accent' },
    { id: 'outdated', label: 'Desatualizadas', value: checking ? DASH : String(outdatedOnly), sub: outSub, icon: 'arrow-up-circle', tone: outdatedOnly ? 'warn' : 'muted' },
    { id: 'missing', label: 'Faltando', value: checking ? DASH : String(missing.length), sub: missing.length ? `${missing.map((i) => i.id).join(', ')}${missing.some((i) => i.actions.some((a) => a.id === 'install' && a.runnable)) ? ' · o catálogo instala' : ''}` : 'nada faltando', icon: 'circle-dashed', tone: 'muted' },
    { id: 'mcp', label: 'Servidores MCP', value: String(servers.length), sub: mcpSub, icon: 'plug', tone: failed ? 'bad-text' : login ? 'warn' : 'ok' },
    { id: 'runtime', label: 'Plataformas', value: String(rt.length), sub: runtimeManual.length ? `${runtimeManual.length} instalada${runtimeManual.length === 1 ? '' : 's'} à mão (${runtimeManual.map((i) => i.label).join(', ')})` : rt.map((i) => i.label).join(', ') || 'nenhuma', icon: 'layers', tone: 'accent' },
    { id: 'containers', label: 'Containers', value: ctValue, sub: ctSub, icon: 'container', tone: c?.state === 'running' ? 'ok' : 'muted' },
  ];
}

// ---------- the bands on top ----------

/**
 * The machine-level band, at most one: the remote out (stale), no network, no package manager,
 * the remote's read-only or actions-on notice, or "Tudo em dia".
 */
export function machineBand(o, now) {
  if (o.stale) return { kind: 'stale', title: `Sem conexão com a ${o.machine.label}.`, text: 'Abaixo, a última leitura, desbotada. Nada roda lá enquanto ela estiver fora; Reconectar fica na tela da máquina.' };
  if (o.network === 'offline') {
    const at = o.checkedAt ? `do cache, de ${timeOfDay(o.checkedAt)} (${ago(o.checkedAt, now)})` : 'ainda não foram lidas';
    return { kind: 'offline', title: 'Sem rede.', text: `As versões instaladas estão certas (são lidas aqui). As mais recentes são ${at}. Instalar e atualizar ficam desligados até a rede voltar.` };
  }
  if (o.machine.platform === 'darwin' && !o.managers.homebrew.present) {
    return { kind: 'no-homebrew', title: 'Sem Homebrew, o console só lê.', text: 'As CLIs e as versões aparecem, mas instalar e atualizar ficam desligados. O instalador do Homebrew pede a sua senha de administrador, então o console não roda: rode no Terminal e volte aqui.', command: o.managers.homebrew.install };
  }
  if (o.machine.platform === 'win32' && !o.managers.winget.present) {
    return { kind: 'no-winget', title: 'Sem o winget, o console só lê.', text: 'O winget vem no App Installer da Microsoft Store. Com ele, o catálogo usa winget upgrade --id <id> --scope user; um pacote que só instala para a máquina toda pede administrador e mostra o comando.' };
  }
  if (isRemote(o) && !o.actionsAllowed) {
    return { kind: 'read-only', title: 'Só leitura.', text: `A ${o.machine.label} não aceita ações vindas deste Mac, e cada ação vira Copiar comando, para rodar num terminal de lá. Para ligar, na própria máquina, grave "tools": { "acceptRemoteActions": true } no ~/.ahrena-console/config.json de lá. A escolha é de quem está na máquina, não deste Mac.` };
  }
  if (isRemote(o)) return { kind: 'remote-actions', title: `Ações ligadas na ${o.machine.label}.`, text: 'Quem roda é o núcleo de lá, com o catálogo de lá e como o seu usuário de lá. O confirmar diz onde roda e mostra o comando de lá. sudo continua com você.' };
  if (allOk(o)) {
    const rt = o.items.filter((i) => i.group === 'runtime').length;
    const cli = o.items.filter((i) => i.group === 'cli' && i.state !== 'na').length;
    const ct = o.containers?.runtime ? ` e o ${runtimeLabel(o.containers.runtime)}` : '';
    const next = o.nextCheckAt ? ` A próxima verificação é às ${timeOfDay(o.nextCheckAt)}, ou quando você pedir.` : '';
    return { kind: 'all-ok', title: 'Tudo em dia.', text: `${plural(cli, 'CLI', 'CLIs')}, ${plural(o.mcp.servers.length, 'servidor MCP', 'servidores MCP')}, ${plural(rt, 'plataforma', 'plataformas')}${ct}, verificados às ${timeOfDay(o.checkedAt)}.${next}` };
  }
  return null;
}

/** The band of the last job that ended, while it is fresh and not closed. */
export function jobBand(o, now, closed = new Set()) {
  const job = o.jobs.recent.find((j) => isEnded(j) && j.endedAt);
  if (!job || closed.has(job.id) || now - Date.parse(job.endedAt) > BAND_MS) return null;
  const cmd = job.steps.map(argvLine).join(' e depois ');
  const took = job.startedAt ? duration(Date.parse(job.endedAt) - Date.parse(job.startedAt)) : null;
  const item = o.items.find((i) => i.id === job.toolId);
  const log = job.logFile ? `A saída fica no log: ${job.logFile}` : null;
  if (job.state === 'succeeded') {
    const verb = job.actionId === 'stop' ? 'parado' : job.actionId === 'start' ? 'rodando' : null;
    const title = verb ? `${job.label} ${verb}.` : `${job.label}${job.targetVersion ? ` na ${job.targetVersion}` : ' em dia'}.`;
    return { kind: 'done', job, title, text: `${cmd} saiu com o código 0${took ? ` em ${took}` : ''}${verb ? '.' : ', e o núcleo conferiu a versão.'}`, log };
  }
  if (job.state === 'canceled') return { kind: 'canceled', job, title: `Cancelado: ${job.label}.`, text: `${cmd} parou a pedido${took ? `, depois de ${took}` : ''}. Rode de novo quando quiser.`, log };
  const why = job.state === 'timed-out' ? `passou do tempo limite de ${timeoutText(job.timeoutSeconds)}` : `saiu com o código ${job.exitCode ?? '?'}${took ? ` depois de ${took}` : ''}`;
  const keeps = item?.installed ? ` O ${item.binary ?? item.id} continua na ${item.installed}.` : '';
  const verb = job.actionId === 'install' ? 'instalou' : job.actionId === 'start' ? 'iniciou' : job.actionId === 'stop' ? 'parou' : 'atualizou';
  return {
    kind: 'failed',
    job,
    title: `Não ${verb} ${job.label}.`,
    text: `${cmd} ${why}.${keeps}`,
    lines: job.output.slice(-6),
    log: job.logFile ? `As últimas linhas da saída; o resto está em ${job.logFile}.` : 'As últimas linhas da saída.',
  };
}

// ---------- the confirm dialog ----------

/** The confirm of one action: what runs, exactly, where and as whom. */
export function confirmView(o, target, action, { changed = false } = {}) {
  const remote = isRemote(o);
  const verb = { install: 'Instalar', update: 'Atualizar', start: 'Iniciar', stop: 'Parar' }[action.id];
  const from = target.installed && action.targetVersion && action.targetVersion !== target.installed ? `${target.installed} → ${action.targetVersion}` : action.targetVersion ? `versão ${action.targetVersion}` : null;
  const rows = [
    ['Onde', remote ? `Na ${o.machine.label} · pelo núcleo de lá · como o seu usuário de lá` : 'Esta máquina · como o seu usuário'],
    ['De onde', [target.manager ?? (target.runtime ? runtimeLabel(target.runtime) : null), from].filter(Boolean).join(' · ') || DASH],
    ['Tempo limite', `${timeoutText(action.timeoutSeconds)}${action.steps.length > 1 ? ' por passo' : ''} · Cancelar a qualquer momento`],
  ];
  if (target.note) rows.push(['Observação', target.note]);
  return {
    title: `${verb} ${target.label ?? target.name ?? runtimeLabel(target.runtime)}${remote ? ` na ${o.machine.label}` : ''}`,
    rows,
    steps: action.steps.map(argvLine),
    changed,
    note: remote
      ? `Do catálogo do núcleo da ${o.machine.label}, que é o mesmo código deste. Este Mac só manda o id do item e da ação; a ${o.machine.label} aceitou ações remotas no config.json de lá.`
      : 'Do catálogo do núcleo, revisado no código. Não pede senha de administrador. Nada digitado na tela vira comando.',
    ok: 'Confirmar e rodar',
  };
}

/** The confirm of "Atualizar N": every command, in the order they will run. */
export function bulkConfirmView(o, list) {
  const remote = isRemote(o);
  const left = o.items.filter((i) => (i.group === 'cli' || i.group === 'runtime') && i.latest && i.installed && i.latest !== i.installed && mainAction(i)?.admin);
  return {
    title: `Atualizar ${plural(list.length, 'item', 'itens')}${remote ? ` na ${o.machine.label}` : ''}`,
    rows: [
      ['Onde', remote ? `Na ${o.machine.label} · como o seu usuário de lá` : `${machineName(o)} · como o seu usuário`],
      ['Ordem', 'um de cada vez, na ordem abaixo'],
      ['Tempo limite', `${timeoutText(Math.max(...list.map((x) => x.action.timeoutSeconds)))} cada`],
    ],
    steps: list.map((x) => x.action.steps.map(argvLine).join(' e depois ')),
    labels: list.map((x) => x.item.label),
    note: `Nenhum pede senha.${left.length ? ` Fica de fora: ${left.map((i) => i.id).join(', ')}, que precisa${left.length === 1 ? '' : 'm'} de sudo (veja a linha).` : ''}`,
    ok: `Confirmar os ${list.length}`,
  };
}

/** The action of a 409 answer's plan, in the shape of `items[].actions`. */
export function actionFromPlan(previous, plan) {
  if (!isObject(plan)) return null;
  return normalizeAction({ ...previous, ...plan, id: previous.id, runnable: plan.admin !== true, blockedReason: plan.admin === true ? 'admin' : null });
}

// ---------- the running job ----------

/** The steps line of a running job: each step, then "conferindo a versão". */
export function jobSteps(job) {
  const out = job.steps.map((s, i) => ({ label: argvLine(s), state: job.phase === 'verifying' || i < job.step ? 'done' : i === job.step ? 'on' : 'next' }));
  out.push({ label: job.actionId === 'start' || job.actionId === 'stop' ? 'conferindo o estado' : 'conferindo a versão', state: job.phase === 'verifying' ? 'on' : 'next' });
  return out;
}
export function jobClock(job, now) {
  const elapsed = job.startedAt ? now - Date.parse(job.startedAt) : 0;
  const total = job.timeoutSeconds * 1000 * Math.max(1, job.steps.length);
  return { elapsed: clock(elapsed), total: clock(total), pct: Math.max(0, Math.min(100, (elapsed / total) * 100)) };
}
export const queueLine = (o) => (o.jobs.queue.length ? `Na fila: ${o.jobs.queue.map((j) => j.label).join(', ')}` : null);

/** The screen should re-read soon: a job running or queued, a first check, or Colima starting. */
export const busy = (o) => !!o && (!!o.jobs.current || o.jobs.queue.length > 0 || !o.checkedAt || o.items.some((i) => i.state === 'checking') || o.containers?.state === 'starting');

// ---------- MCP ----------

export function mcpScope(s) {
  const scope = { user: 'usuário', local: 'local', project: 'projeto' }[s.scope];
  return s.scope === 'project' && s.project ? `${scope} · ${s.project}` : scope;
}
export function mcpSource(s) {
  if (s.package) return `npm ${s.package}${s.version ? ` ${s.version}` : ''}`;
  if (s.host) return s.host;
  if (s.command) return `${s.command} (comando)`;
  return DASH;
}
/** The small line under the name: never a value of env or of a header, only names and counts. */
export function mcpNote(s) {
  const parts = [];
  if (s.note) parts.push(s.note);
  if (s.headerCount) parts.push(`${s.headerCount === 1 ? 'cabeçalho' : 'cabeçalhos'} ${s.headerNames.length ? s.headerNames.join(', ') : s.headerCount} · ${s.headerCount === 1 ? 'valor oculto' : 'valores ocultos'}`);
  if (s.envCount) parts.push(`${plural(s.envCount, 'variável de ambiente', 'variáveis de ambiente')} · ${s.envCount === 1 ? 'valor oculto' : 'valores ocultos'}`);
  if (!parts.length && s.transport === 'stdio') parts.push('sem variáveis de ambiente');
  return parts.join(' · ');
}
/** The action of an MCP row: Atualizar/Copiar comando when the catalog knows it, else login or Agent Config. */
export function mcpAction(o, s, now, { frozen = false } = {}) {
  if (frozen) return { kind: 'none' };
  if (s.actions.length) return rowAction(o, { ...s, id: s.id }, now);
  if (s.state === 'needs-login') return { kind: 'login' };
  if (s.state === 'failed') return { kind: 'config' };
  return { kind: 'none' };
}

// ---------- containers ----------

export function containerRows(c, o) {
  const rows = [];
  if (c.version) rows.push(['Runtime', c.version]);
  for (const d of c.detected) rows.push(['Achamos', `${runtimeLabel(d.runtime)}${d.version ? ` ${d.version}` : ''} · ${containerBadge(d.state)[1].toLowerCase()} · o console só lê`]);
  if (c.dockerContext) rows.push(['Contexto do docker', `${c.dockerContext} · em uso`]);
  if (c.vm) {
    const mem = c.vm.memoryBytes ? `${Math.round(c.vm.memoryBytes / 1024 ** 3)} GB` : null;
    const vm = [c.vm.cpus ? `${c.vm.cpus} CPUs` : null, mem, c.state === 'running' ? c.vm.arch : null, c.state === 'running' ? c.vm.vmType : null].filter(Boolean).join(' · ');
    rows.push(['VM', c.state === 'stopped' ? `${vm} · parada` : vm]);
  }
  if (c.containers) rows.push(['Containers', `${c.containers.running} rodando · ${c.containers.stopped} ${c.containers.stopped === 1 ? 'parado' : 'parados'}`]);
  if (c.diskUsedBytes !== null && !c.vm?.diskBytes) rows.push(['Disco', `${bytes(c.diskUsedBytes)} em uso`]);
  return rows;
}
/** The disk meter of the VM: `{ used, total, pct }`, or `null`. */
export function containerDisk(c) {
  if (!c.vm?.diskBytes || c.diskUsedBytes === null) return null;
  return { text: `${bytes(c.diskUsedBytes)} de ${bytes(c.vm.diskBytes)}`, pct: Math.max(0, Math.min(100, (c.diskUsedBytes / c.vm.diskBytes) * 100)) };
}
