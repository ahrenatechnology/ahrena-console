// The machine screens (C24, C25, C26, issue 178; C50, issue 244) without the DOM: what each card shows, read from
// `GET /api/telemetry?machine=<id>&hours=1|12` and `GET /api/machines` (src/telemetry/model.ts).
//
// A remote machine's groups (`gpu`, `network`, `claude`, `docker`, `topProcesses`, `ports`, `tunnels`)
// come as the remote sent them, so every group goes through a `normalize…` that keeps only what has
// the expected shape: a group that is not an object becomes `null` (its card does not show), a list
// keeps only the entries with the shape, a number that is not finite becomes `null`. Nothing here
// throws on a strange reading. The test imports this file directly.

export const MACHINES_ROUTE = '/api/machines';
export const TELEMETRY_ROUTE = '/api/telemetry';
export const ATTENTION_ROUTE = '/api/attention';
export const LOCAL_ID = 'local';
export const WINDOWS = [1, 12];
/** The core samples every 30 s; the screen re-reads at the same pace (a new sample publishes nothing). */
export const REREAD_MS = 30_000;
/** A volume at or above this is yellow; at or above `VOLUME_FULL_PCT` + 5, red (the core alerts at 85). */
export const VOLUME_FULL_PCT = 85;
/** The sessions of a remote machine listed in its card; the rest is "e mais N". */
export const SESSIONS_SHOWN = 4;
export const DASH = '—';

const GB = 1e9;
const GiB = 1024 ** 3;

// ---------- formats ----------

const fmt = (digits) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const f0 = fmt(0);
const f1 = fmt(1);

/** 21.37 → "21,4"; 3 → "3"; a whole number keeps no decimal. */
export function decimal(n) {
  if (!Number.isFinite(n)) return DASH;
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? f0.format(r) : f1.format(r);
}

/** Bytes in decimal units: "140 MB", "1,4 GB", "2 TB". */
export function bytes(n) {
  if (!Number.isFinite(n)) return DASH;
  if (n >= 1e12) return `${decimal(n / 1e12)} TB`;
  if (n >= GB) return `${decimal(n / GB)} GB`;
  if (n >= 1e6) return `${f0.format(Math.round(n / 1e6))} MB`;
  if (n >= 1e3) return `${f0.format(Math.round(n / 1e3))} kB`;
  return `${f0.format(Math.round(n))} B`;
}

/** Bytes per second: "2,4 MB/s", "310 kB/s". */
export const rate = (n) => (Number.isFinite(n) ? `${bytes(n)}/s` : DASH);

/** Memory in GiB, as the systems report it: 36 GiB → "36". */
export const gib = (n) => decimal(n / GiB);

/** "agora", "há 12 s", "há 4 min", "há 3 h", "há 2 dias". */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 3) return 'agora';
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86_400);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** "3 h 12 min", "12 min", "2 dias". */
export function duration(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  const d = Math.floor(m / (24 * 60));
  return `${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** The time of day, "22:41". */
export function clockTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const plural = (n, one, many) => `${f0.format(n)} ${n === 1 ? one : many}`;

// ---------- routes ----------

export const screenRoute = (id) => `/ui/machines/${encodeURIComponent(id)}`;
export const telemetryRoute = (id, hours) => `${TELEMETRY_ROUTE}?machine=${encodeURIComponent(id)}&hours=${hours}`;

/** `?hours=12` in the screen's URL; anything else is the 1 h default. */
export function hoursFromSearch(search) {
  return new URLSearchParams(search ?? '').get('hours') === '12' ? 12 : 1;
}

// ---------- shape checks ----------

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const list = (v, max = 500) => (Array.isArray(v) ? v.slice(0, max) : []);

/** The machine summary of `GET /api/machines`, or `null` without an id. */
export function normalizeMachine(m) {
  if (!isObject(m) || !str(m.id, 64)) return null;
  return {
    id: m.id,
    label: str(m.label, 40) ?? m.id,
    state: str(m.state, 40) ?? 'unreachable',
    reason: m.reason === 'port-closed' || m.reason === 'no-response' ? m.reason : null,
    version: num(m.version),
    port: num(m.port),
    lastReadAt: str(m.lastReadAt, 40),
    alerts: num(m.alerts) ?? 0,
    reconnect: normalizeReconnect(m.reconnect),
  };
}

/** The list of machines, the valid ones, in the core's order. */
export const normalizeMachines = (body) => list(body, 100).map(normalizeMachine).filter(Boolean);

function normalizeCpu(c) {
  if (!isObject(c)) return null;
  const load = isObject(c.load) ? { one: num(c.load.one), five: num(c.load.five), fifteen: num(c.load.fifteen) } : { one: null, five: null, fifteen: null };
  return { cores: num(c.cores), model: str(c.model), usedPct: num(c.usedPct), load };
}

function normalizeMemory(m) {
  if (!isObject(m) || num(m.totalBytes) === null || num(m.usedBytes) === null) return null;
  return { totalBytes: m.totalBytes, usedBytes: m.usedBytes, swapTotalBytes: num(m.swapTotalBytes), swapUsedBytes: num(m.swapUsedBytes) };
}

function normalizeGpu(g) {
  if (!isObject(g)) return null;
  const out = { name: str(g.name), usedPct: num(g.usedPct), memoryUsedBytes: num(g.memoryUsedBytes), memoryTotalBytes: num(g.memoryTotalBytes) };
  return out.usedPct === null && out.memoryUsedBytes === null ? null : out;
}

function normalizeVolumes(d) {
  if (!isObject(d)) return [];
  return list(d.volumes, 50)
    .filter((v) => isObject(v) && str(v.mount, 300) && num(v.totalBytes) > 0 && num(v.usedBytes) !== null)
    .map((v) => ({ mount: v.mount.slice(0, 300), totalBytes: v.totalBytes, usedBytes: v.usedBytes, freeBytes: num(v.freeBytes) ?? v.totalBytes - v.usedBytes, usedPct: num(v.usedPct) ?? (v.usedBytes / v.totalBytes) * 100 }));
}

function normalizeNetwork(n) {
  if (!isObject(n)) return null;
  return { interface: str(n.interface, 40), rxBytesPerSec: num(n.rxBytesPerSec), txBytesPerSec: num(n.txBytesPerSec), rxBytesTotal: num(n.rxBytesTotal), txBytesTotal: num(n.txBytesTotal) };
}

const group = (g) => (isObject(g) && num(g.count) !== null ? { count: g.count, cpuPct: num(g.cpuPct), memoryBytes: num(g.memoryBytes) } : null);

function normalizeClaude(c) {
  if (!isObject(c)) return null;
  const out = { processes: group(c.processes), cli: group(c.cli), desktop: group(c.desktop) };
  return out.processes ? out : null;
}

function normalizeTop(t) {
  if (!Array.isArray(t)) return null;
  return list(t, 20).filter((p) => isObject(p) && str(p.name, 80) && num(p.cpuPct) !== null).map((p) => ({ name: p.name.slice(0, 80), cpuPct: p.cpuPct }));
}

const ports = (v) => list(v, 50).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

function normalizeDocker(d) {
  if (!isObject(d)) return null;
  const stacks = list(d.stacks, 100)
    .filter((s) => isObject(s) && str(s.name, 100))
    .map((s) => ({ name: s.name.slice(0, 100), running: num(s.running) ?? 0, stopped: num(s.stopped) ?? 0, ports: ports(s.ports) }));
  const space = Array.isArray(d.space)
    ? list(d.space, 10)
        .filter((s) => isObject(s) && str(s.type, 40) && num(s.sizeBytes) !== null)
        .map((s) => ({ type: s.type, sizeBytes: s.sizeBytes, reclaimableBytes: Math.min(s.sizeBytes, Math.max(0, num(s.reclaimableBytes) ?? 0)) }))
    : null;
  return { running: num(d.running) ?? 0, stopped: num(d.stopped) ?? 0, stacks, space };
}

function normalizePorts(p) {
  if (!Array.isArray(p)) return null;
  return list(p, 500)
    .filter((x) => isObject(x) && Number.isInteger(x.port) && x.port > 0 && x.port < 65536)
    .map((x) => ({ port: x.port, interface: ['all', 'loopback', 'address'].includes(x.interface) ? x.interface : 'address', address: str(x.address, 60), process: str(x.process, 60) }));
}

const TUNNEL_STATES = ['up', 'idle', 'busy', 'down'];

function normalizeTunnels(t) {
  if (!Array.isArray(t)) return null;
  return list(t, 20)
    .filter((x) => isObject(x) && str(x.destination, 120))
    .map((x) => ({
      destination: x.destination.slice(0, 120),
      since: str(x.since, 40),
      ports: list(x.ports, 100)
        .filter((p) => isObject(p) && Number.isInteger(p.localPort) && Number.isInteger(p.remotePort))
        .map((p) => ({ localPort: p.localPort, remotePort: p.remotePort, state: TUNNEL_STATES.includes(p.state) ? p.state : 'down', heldBy: str(p.heldBy, 60) })),
    }));
}

/** The newest reading with every group checked; `null` without a reading. */
export function normalizeReading(r) {
  if (!isObject(r)) return null;
  const host = isObject(r.host) ? { hostname: str(r.host.hostname, 100), os: str(r.host.os, 100) } : { hostname: null, os: null };
  return {
    takenAt: str(r.takenAt, 40),
    host,
    cpu: normalizeCpu(r.cpu),
    memory: normalizeMemory(r.memory),
    gpu: normalizeGpu(r.gpu),
    volumes: normalizeVolumes(r.disk),
    network: normalizeNetwork(r.network),
    claude: normalizeClaude(r.claude),
    topProcesses: normalizeTop(r.topProcesses),
    docker: normalizeDocker(r.docker),
    ports: normalizePorts(r.ports),
    tunnels: normalizeTunnels(r.tunnels),
  };
}

const SERIES_KEYS = ['cpuUsedPct', 'load1', 'memoryUsedBytes'];

/** The series the chart draws, each column as long as `at`, with `null` where a value is missing. */
export function normalizeSeries(s) {
  const at = isObject(s) ? list(s.at, 2000).map((x) => (typeof x === 'string' ? x : null)) : [];
  const out = { at };
  for (const k of SERIES_KEYS) out[k] = at.map((_, i) => num(isObject(s) && Array.isArray(s[k]) ? s[k][i] : null));
  return out;
}

const LEVELS = ['error', 'warning'];

export function normalizeAlerts(a) {
  return list(a, 50)
    .filter((x) => isObject(x) && str(x.message, 300))
    .map((x) => ({ id: str(x.id, 200) ?? x.message, level: LEVELS.includes(x.level) ? x.level : 'info', message: x.message.slice(0, 300), detail: str(x.detail, 300), since: str(x.since, 40), kind: str(x.kind, 40) }));
}

// ---------- the cards ----------

/** The value's color for a used percentage: yellow from 85, red from 90 (the volume alert is at 85). */
export const levelOf = (pct) => (pct >= 90 ? 'bad' : pct >= VOLUME_FULL_PCT ? 'warn' : 'ok');

/** The sessions of this machine in `GET /api/attention`: `machine: null` is this machine. */
export function sessionsOf(attention, machineId) {
  if (!isObject(attention)) return null;
  const local = machineId === LOCAL_ID;
  return list(attention.items, 500).filter((i) => isObject(i) && (local ? !i.machine : isObject(i.machine) && i.machine.id === machineId));
}

/**
 * The cards on top, in the wireframe's order: on this machine CPU, Memória, Disco, Rede, Claude and
 * Sessões; on a remote one CPU, Memória, GPU, Disco, Docker and Sessões lá. A card whose group is
 * `null` is left out. Each card: `{ id, label, icon, value, unit, sub, tone }`.
 */
export function statCards(reading, { local, sessions = null, alerts = [], now = Date.now() } = {}) {
  if (!reading) return [];
  const cards = [];
  const { cpu, memory, gpu, volumes, network, claude, docker } = reading;
  if (cpu) {
    const saturated = cpu.cores !== null && cpu.load.one !== null && cpu.load.one > cpu.cores;
    if (local) cards.push({ id: 'cpu', label: 'CPU', icon: 'model', value: cpu.usedPct === null ? DASH : `${f0.format(Math.round(cpu.usedPct))}%`, unit: null, sub: cpu.load.one === null ? '' : `carga ${decimal(cpu.load.one)}${cpu.cores ? ` de ${cpu.cores}` : ''}`, tone: saturated ? 'bad' : 'ok' });
    else {
      const loadAlert = alerts.find((a) => a.kind === 'load-high');
      const sub = saturated ? (loadAlert?.since ? `saturada ${ago(loadAlert.since, now)}` : 'saturada') : cpu.usedPct === null ? '' : `${f0.format(Math.round(cpu.usedPct))}% de uso`;
      cards.push({ id: 'cpu', label: 'CPU', icon: 'model', value: cpu.load.one === null ? DASH : decimal(cpu.load.one), unit: cpu.cores ? `de ${cpu.cores}` : null, sub, tone: saturated ? 'bad' : 'ok' });
    }
  }
  if (memory) {
    const swap = memory.swapUsedBytes === null ? '' : local || memory.swapTotalBytes === null ? `swap ${gib(memory.swapUsedBytes)} GB` : `swap ${gib(memory.swapUsedBytes)} de ${gib(memory.swapTotalBytes)}`;
    cards.push({ id: 'memory', label: 'Memória', icon: 'memory-stick', value: gib(memory.usedBytes), unit: `de ${gib(memory.totalBytes)} GB`, sub: swap, tone: 'ok' });
  }
  if (!local && gpu) {
    const vram = gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null ? `${gib(gpu.memoryUsedBytes)} de ${gib(gpu.memoryTotalBytes)} GB VRAM` : (gpu.name ?? '');
    cards.push({ id: 'gpu', label: 'GPU', icon: 'monitor-dot', value: gpu.usedPct === null ? DASH : `${f0.format(Math.round(gpu.usedPct))}%`, unit: null, sub: vram, tone: 'ok' });
  }
  const root = volumes.find((v) => v.mount === '/') ?? volumes[0];
  if (root) {
    const free = `${bytes(root.freeBytes)} livres`;
    cards.push({ id: 'disk', label: 'Disco', icon: 'hard-drive', value: `${f0.format(Math.round(root.usedPct))}%`, unit: null, sub: local ? free : `${root.mount} · ${free}`, tone: levelOf(root.usedPct) === 'ok' ? 'ok' : 'warn' });
  }
  if (local && network) {
    cards.push({ id: 'network', label: 'Rede', icon: 'wifi', value: network.rxBytesPerSec === null ? DASH : decimal(network.rxBytesPerSec / (network.rxBytesPerSec >= 1e6 ? 1e6 : 1e3)), unit: network.rxBytesPerSec === null ? null : `${network.rxBytesPerSec >= 1e6 ? 'MB/s' : 'kB/s'} ↓`, sub: network.txBytesPerSec === null ? '' : `↑ ${rate(network.txBytesPerSec)}`, tone: 'ok' });
  }
  if (local && claude) {
    const parts = [claude.cli ? `${claude.cli.count} CLI` : null, claude.desktop ? `${claude.desktop.count} Desktop` : null].filter(Boolean);
    cards.push({ id: 'claude', label: 'Claude', icon: 'bot', value: f0.format(claude.processes.count), unit: 'proc.', sub: parts.join(' · '), tone: 'ok' });
  }
  if (!local && docker) {
    const reclaimable = docker.space ? docker.space.reduce((s, x) => s + x.reclaimableBytes, 0) : null;
    const sub = [plural(docker.stacks.length, 'stack', 'stacks'), reclaimable ? `${bytes(reclaimable)} a liberar` : null].filter(Boolean).join(' · ');
    cards.push({ id: 'docker', label: 'Docker', icon: 'container', value: f0.format(docker.running + docker.stopped), unit: null, sub, tone: 'ok' });
  }
  if (sessions) {
    const urgent = sessions.filter((i) => i.level === 'needs').length;
    cards.push({ id: 'sessions', label: local ? 'Sessões' : 'Sessões lá', icon: 'sessions', value: f0.format(sessions.length), unit: null, sub: urgent ? `${urgent} ${urgent === 1 ? 'precisa' : 'precisam'} de você` : sessions.length ? 'na sua vez' : 'ninguém esperando você', tone: 'session' });
  }
  return cards;
}

/** A volume's line: "232 de 612 GB · 38%", in the unit of the total. */
export function volumeLine(v) {
  const unit = v.totalBytes >= 1e12 ? 1e12 : GB;
  const name = unit === 1e12 ? 'TB' : 'GB';
  return `${decimal(v.usedBytes / unit)} de ${decimal(v.totalBytes / unit)} ${name} · ${f0.format(Math.round(v.usedPct))}%`;
}

const DOCKER_TYPES = { Images: 'Imagens', 'Local Volumes': 'Volumes', 'Build Cache': 'Build cache', Containers: 'Containers' };

/** Docker space in GB: in use and reclaimable, and each part's share of the biggest row (0 to 100). */
export function dockerRows(space) {
  if (!space?.length) return [];
  const max = Math.max(...space.map((s) => s.sizeBytes), 1);
  return space.map((s) => {
    const inUse = s.sizeBytes - s.reclaimableBytes;
    return { label: DOCKER_TYPES[s.type] ?? s.type, text: `${decimal(inUse / GB)} em uso · ${decimal(s.reclaimableBytes / GB)} recuperável`, usedPct: (inUse / max) * 100, reclaimablePct: (s.reclaimableBytes / max) * 100 };
  });
}

/** "12" or "0 · 15 parados". */
export const stackContainers = (s) => (s.stopped ? `${s.running} · ${s.stopped} ${s.stopped === 1 ? 'parado' : 'parados'}` : String(s.running));

export const TUNNEL_PORT_STATE = { up: ['b-completed', 'Respondendo'], idle: ['b-abandoned', 'Ninguém escuta lá'], busy: ['b-waiting', 'Ocupada no Mac'], down: ['b-error', 'Fora do túnel'] };

/** The machine that a tunnel reaches: the one whose `port` (machines.json) the tunnel forwards. */
export function machineOfTunnel(tunnel, machines) {
  return machines.find((m) => m.id !== LOCAL_ID && m.port !== null && tunnel.ports.some((p) => p.localPort === m.port)) ?? null;
}

/**
 * "O que é" of a forwarded port: the remote core when it is the machine's port; what listens on
 * the other side when that machine's reading has it; the state's own explanation otherwise.
 */
export function tunnelPortWhat(p, { machine = null, remotePorts = null } = {}) {
  if (p.state === 'idle') return `nada escuta na ${p.remotePort} de lá`;
  if (p.state === 'busy') return `${p.heldBy ?? 'outro processo'}, deste Mac, segura a ${p.localPort}`;
  if (p.state === 'down') return 'nada escuta nesta porta do Mac';
  if (machine && p.localPort === machine.port) return `Núcleo da ${machine.label}`;
  const there = remotePorts?.find((x) => x.port === p.remotePort);
  return there?.process ?? DASH;
}

/**
 * The listening ports in rows: the same interface, process and owner become one row ("13000,
 * 14720, 15173 · ssh · túnel para ws-exemplo"). `owner(port)` says whose the port is.
 */
export function portRows(portsList, owner = () => null) {
  const rows = [];
  const byKey = new Map();
  for (const p of [...portsList].sort((a, b) => a.port - b.port)) {
    const who = owner(p) ?? null;
    const key = `${p.interface}|${p.address ?? ''}|${p.process ?? ''}|${who ?? ''}`;
    const row = byKey.get(key);
    if (row && who) row.ports.push(p.port);
    else {
      const next = { ports: [p.port], interface: p.interface, address: p.address, process: p.process, owner: who };
      rows.push(next);
      if (who) byKey.set(key, next);
    }
  }
  return rows;
}

export const PORT_FILTERS = [
  ['all', 'Todas'],
  ['exposed', 'Todas as interfaces'],
  ['loopback', 'Só loopback'],
];

export function portFilter(portsList, filter) {
  if (filter === 'exposed') return portsList.filter((p) => p.interface === 'all');
  if (filter === 'loopback') return portsList.filter((p) => p.interface === 'loopback');
  return portsList;
}

/** Whose a port of THIS machine is: the console's core, a tunnel, or what holds a tunnel's port. */
export function localPortOwner(tunnels, ownPort) {
  return (p) => {
    if (p.port === ownPort) return 'Núcleo do console';
    for (const t of tunnels ?? []) {
      const forwarded = t.ports.find((x) => x.localPort === p.port);
      if (!forwarded) continue;
      if (forwarded.state === 'busy' && p.process !== 'ssh') return 'segura a porta do túnel';
      return `túnel para ${t.destination}`;
    }
    return null;
  };
}

/** Whose a port of a REMOTE machine is: its core (the port the tunnel reaches) or a Docker stack. */
export function remotePortOwner(docker, corePort) {
  return (p) => {
    if (corePort !== null && p.port === corePort) return 'Núcleo do console';
    const stack = docker?.stacks.find((s) => s.ports.includes(p.port));
    return stack ? stack.name : null;
  };
}

/** The remote port → `{ localPort, state }` of this Mac's tunnel to the machine (the "No Mac" column). */
export function forwardsOf(localReading, machine) {
  const out = new Map();
  for (const t of localReading?.tunnels ?? []) {
    if (!machine || !t.ports.some((p) => p.localPort === machine.port)) continue;
    for (const p of t.ports) out.set(p.remotePort, { localPort: p.localPort, state: p.state });
  }
  return out;
}

/** The remote core's port: the far side of the tunnel port that machines.json names. */
export function remoteCorePort(localReading, machine) {
  for (const t of localReading?.tunnels ?? []) for (const p of t.ports) if (machine && p.localPort === machine.port) return p.remotePort;
  return null;
}

// ---------- the chart ----------

/**
 * The chart of the window: on this machine CPU % and memory used %, from 0 to 100; on a remote one
 * the 1 min load and the memory used in GB, with the core count as the dashed line.
 */
export function chartOf(series, reading, { local }) {
  const cores = reading?.cpu?.cores ?? null;
  const total = reading?.memory?.totalBytes ?? null;
  if (local) {
    return {
      title: 'CPU e memória',
      note: 'a cada 30 s · guardado por 12 h',
      max: 100,
      limit: null,
      lines: [
        { tone: 'a', label: 'CPU, %', values: series.cpuUsedPct },
        { tone: 'b', label: 'Memória usada, %', values: total ? series.memoryUsedBytes.map((v) => (v === null ? null : (v / total) * 100)) : series.memoryUsedBytes.map(() => null) },
      ],
      limitLabel: null,
    };
  }
  const memory = series.memoryUsedBytes.map((v) => (v === null ? null : v / GiB));
  const values = [...series.load1, ...memory].filter((v) => v !== null);
  const max = Math.max(cores ? cores * 2 : 0, ...values, 1);
  return {
    title: 'Carga e memória',
    note: cores ? 'a linha tracejada é o número de vCPUs' : '',
    max: Math.ceil(max),
    limit: cores,
    lines: [
      { tone: 'a', label: 'Carga de 1 min', values: series.load1 },
      { tone: 'b', label: total ? `Memória usada, GB (de ${gib(total)})` : 'Memória usada, GB', values: memory },
    ],
    limitLabel: cores ? `${cores} vCPUs` : null,
  };
}

/** The core's sampling step in a window: 30 s in 1 h; at 12 h, 2 min buckets (`MAX_SERIES_POINTS` 360). */
export const stepMs = (hours) => (hours === 12 ? (12 * 3_600_000) / 360 : 30_000);

/** The time box of the chart: the window ending now, and the gap that breaks a line (twice the step). */
export const timeWindow = (hours, now = Date.now()) => ({ from: now - hours * 3_600_000, to: now, gapMs: 2 * stepMs(hours) });

/**
 * The polylines of one line in a `width` × `height` box. Each point is placed by its time (`at[i]`)
 * inside `[from, to]`: the core does not fill the holes (src/telemetry/series.ts), so a missing value
 * or two samples further apart than `gapMs` break the line. Without `at`, points are spread by index.
 */
export function polylines(values, { max, width = 600, height = 120, at = null, from = null, to = null, gapMs = Infinity }) {
  const out = [];
  let current = [];
  let previous = null;
  const n = values.length;
  const byTime = Array.isArray(at) && Number.isFinite(from) && Number.isFinite(to) && to > from;
  const y = (v) => (height - 4 - (Math.min(v, max) / max) * (height - 14)).toFixed(1);
  const cut = () => {
    if (current.length) out.push(current);
    current = [];
  };
  values.forEach((v, i) => {
    let x;
    if (byTime) {
      const t = Date.parse(at[i]);
      if (v === null || !Number.isFinite(t) || t < from || t > to) {
        cut();
        previous = null;
        return;
      }
      if (previous !== null && t - previous > gapMs) cut();
      previous = t;
      x = ((t - from) / (to - from)) * width;
    } else {
      if (v === null) return cut();
      x = n > 1 ? (i * width) / (n - 1) : 0;
    }
    current.push(`${x.toFixed(1)},${y(v)}`);
  });
  cut();
  // A single point draws nothing: it becomes a tiny segment.
  return out.map((pts) => (pts.length === 1 ? [pts[0], pts[0]] : pts).join(' '));
}

export const yOf = (v, { max, height = 120 }) => Number((height - 4 - (Math.min(v, max) / max) * (height - 14)).toFixed(1));

export const axisLabels = (hours) => (hours === 12 ? ['−12 h', '−9 h', '−6 h', '−3 h', 'agora'] : ['−60 min', '−45', '−30', '−15', 'agora']);

// The machine id of the core (src/telemetry/model.ts `MACHINE_ID`).
const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isMachineId = (id) => typeof id === 'string' && MACHINE_ID.test(id);

/**
 * What a failed telemetry read means: `not-found` (an id the core refuses, 400, or does not know,
 * 404), `no-telemetry` (the core started without it: 404 with its own message) or `error`.
 */
export function failureKind(e) {
  const message = String(e?.body?.error ?? e?.message ?? '');
  if (e?.status === 404 && /sem a telemetria/.test(message)) return 'no-telemetry';
  if (e?.status === 404 || e?.status === 400) return 'not-found';
  return 'error';
}

// ---------- the header and the states (C26) ----------

/** The header's line: "mac-exemplo · macOS 26.1 · 12 núcleos · 36 GB · lido há 4 s". */
export function headerLine(reading, machine, { local, offline, now = Date.now() }) {
  const r = reading;
  const parts = [];
  if (r?.host.hostname) parts.push(r.host.hostname);
  if (r?.host.os) parts.push(r.host.os);
  if (r?.cpu?.cores) parts.push(`${r.cpu.cores} ${local ? 'núcleos' : 'vCPUs'}`);
  if (r?.memory) parts.push(`${gib(r.memory.totalBytes)} GB`);
  if (!local && r?.gpu?.name) parts.push(r.gpu.name);
  if (!local && machine?.port) parts.push(`porta ${machine.port} do Mac`);
  if (r?.takenAt) parts.push(offline ? `última leitura às ${clockTime(r.takenAt)}` : `lido ${ago(r.takenAt, now)}`);
  return parts.join(' · ');
}

/** The state pill of a remote machine in the header. */
export function statePill(machine) {
  if (machine.reconnect?.state === 'running') return ['b-waiting', 'Reconectando'];
  if (machine.state === 'connected') return ['b-completed', 'Conectada'];
  if (machine.state === 'incompatible-version') return ['b-waiting', 'Versão diferente'];
  if (machine.state === 'unreachable' && !machine.reason) return ['b-abandoned', 'Conectando'];
  return ['b-error', 'Sem conexão'];
}

/**
 * What a remote machine that is not `connected` shows (C26): `band` (the tunnel is down: the red band
 * over the faded last reading), `no-response` (the tunnel is up and the core over there is not),
 * `version` (another telemetry version), `first-read` (configured, not read yet). `null` when connected.
 */
export function remoteCondition(machine) {
  if (!machine || machine.id === LOCAL_ID || machine.state === 'connected') return null;
  if (machine.state === 'incompatible-version') return 'version';
  if (machine.state === 'unreachable' && machine.reason === 'port-closed') return 'band';
  if (machine.state === 'unreachable' && machine.reason === 'no-response') return 'no-response';
  if (machine.state === 'unreachable') return 'first-read';
  return 'band';
}

/** The band of a remote whose tunnel is down: what the core saw and the age of the last reading. */
export function bandText(machine, reading, now = Date.now()) {
  const port = machine.port ? `A porta ${machine.port} deste Mac não aceita conexão: o túnel parece caído.` : 'O túnel parece caído.';
  const last = reading?.takenAt ? ` Abaixo, a última leitura, de ${clockTime(reading.takenAt)} (${ago(reading.takenAt, now)}).` : ' Ainda não há leitura dela guardada.';
  return { title: `Sem conexão com a ${machine.label}.`, text: `${port}${last} Tentamos de novo a cada 30 s.` };
}

// ---------- Reconectar (C50, issue 244, decision 0012) ----------
//
// `GET /api/machines` gives each remote a `reconnect` (null on this machine and on a core that does
// not have it): whether `machines.json` has a command, the command itself (to show what runs, never
// its output) and the state of the last run. The screen only POSTs and DELETEs the machine's id.

export const RECONNECT_STATES = ['idle', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'];
/** How long the green "Reconectada às …" band stays after a run that brought the machine back. */
export const RECONNECTED_SHOWN_MS = 10 * 60_000;

export const reconnectRoute = (id) => `${MACHINES_ROUTE}/${encodeURIComponent(id)}/reconnect`;

/** The `reconnect` of a machine, or `null` when the core sent none (or not an object). */
export function normalizeReconnect(r) {
  if (!isObject(r)) return null;
  const command = Array.isArray(r.command) ? r.command.slice(0, 32).filter((a) => typeof a === 'string').map((a) => a.slice(0, 1024)) : [];
  const timeout = num(r.timeoutSeconds);
  return {
    configured: r.configured === true && command.length > 0,
    command: command.length ? command : null,
    timeoutSeconds: timeout !== null && timeout > 0 ? timeout : null,
    state: RECONNECT_STATES.includes(r.state) ? r.state : 'idle',
    startedAt: str(r.startedAt, 40),
    endedAt: str(r.endedAt, 40),
    exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
    startedBy: r.startedBy === 'ui' || r.startedBy === 'local' ? r.startedBy : null,
    logFile: str(r.logFile, 1024),
  };
}

/** "42 s", "1 min 26 s", "3 min". */
export function spanText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** The elapsed clock, "1:12" (and "1:02:05" past an hour, which the limit never allows). */
export function clockOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Milliseconds between two ISO times, or `null`. */
function between(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

/** The running clock against the limit: `{ elapsed: "1:12", limit: "3:00", seconds, max }`. */
export function reconnectClock(rc, now = Date.now()) {
  const ms = between(rc.startedAt, new Date(now).toISOString()) ?? 0;
  const max = rc.timeoutSeconds ?? 0;
  const seconds = Math.min(Math.floor(ms / 1000), max || Infinity);
  return { elapsed: clockOf(seconds * 1000), limit: max ? clockOf(max * 1000) : null, seconds, max };
}

/** The mono line under the band: "Roda: /caminho/para/conectar.sh tunnel restart · até 3 min". */
export function commandLine(rc) {
  if (!rc?.command) return null;
  return `Roda: ${rc.command.join(' ')}${rc.timeoutSeconds ? ` · até ${spanText(rc.timeoutSeconds * 1000)}` : ''}`;
}

/** Where the command's output went, never the output itself (variant A of C50). */
export const logLine = (rc) => (rc.logFile ? `A saída ficou no log da instalação: ${rc.logFile}` : 'A saída ficou no reconnect.log da instalação.');

/**
 * What the reconnect part of a remote shows (C50), or `null` for the C25/C26 screen as it was:
 * - `running` (2, and 6 when the tray started it): whatever the connection says;
 * - with the tunnel down (the C26 band): `offer` (1, maybe with a `note` about the last run),
 *   `failed` and `timed-out` (4), `setup` (5, no command in machines.json);
 * - connected: `succeeded` (3) for a while after the run that brought it back.
 * A core without `reconnect` (null) keeps C26 as it was.
 */
export function reconnectView(machine, now = Date.now()) {
  const rc = machine?.reconnect;
  if (!rc || machine.id === LOCAL_ID) return null;
  if (rc.state === 'running') return { kind: 'running', fromTray: rc.startedBy === 'local' };
  const condition = remoteCondition(machine);
  if (condition === null) {
    if (rc.state !== 'succeeded') return null;
    const ended = Date.parse(rc.endedAt ?? '');
    return Number.isFinite(ended) && now - ended < RECONNECTED_SHOWN_MS ? { kind: 'succeeded' } : null;
  }
  if (condition !== 'band') return null;
  if (!rc.configured) return { kind: 'setup' };
  if (rc.state === 'failed') return { kind: 'failed' };
  if (rc.state === 'timed-out') return { kind: 'timed-out' };
  if (rc.state === 'succeeded') return { kind: 'offer', note: `O comando terminou bem, mas a ${machine.label} não respondeu. Tentamos de novo a cada 30 s.` };
  if (rc.state === 'canceled') return { kind: 'offer', note: rc.endedAt ? `A última reconexão foi cancelada às ${clockTime(rc.endedAt)}.` : 'A última reconexão foi cancelada.' };
  return { kind: 'offer', note: null };
}

/** The title and text of the bands that end a run: 3 (`succeeded`) and 4 (`failed`, `timed-out`). */
export function reconnectResult(machine, kind) {
  const rc = machine.reconnect;
  const took = between(rc.startedAt, rc.endedAt);
  const after = took === null ? '' : ` depois de ${spanText(took)}`;
  if (kind === 'succeeded') {
    return { title: `Reconectada às ${clockTime(rc.endedAt)}`, text: `· a leitura voltou. O comando saiu com o código 0${after}, e o núcleo leu a ${machine.label} na hora.` };
  }
  if (kind === 'timed-out') {
    const limit = rc.timeoutSeconds ? `passou de ${spanText(rc.timeoutSeconds * 1000)}` : 'passou do tempo limite';
    return { title: 'Não reconectou.', text: `O comando ${limit} e foi encerrado. Se um login ficou aberto no navegador, ele não conta mais.` };
  }
  const code = rc.exitCode === null ? 'terminou sem código de saída' : `saiu com o código ${rc.exitCode}`;
  return { title: 'Não reconectou.', text: `O comando ${code}${after}. A ${machine.label} continua sem conexão.` };
}

/** The setup card's example (5), for this machine, with a generic script: no provider, host or account. */
export function reconnectExample(machine) {
  const port = machine.port ? `, "port": ${machine.port}` : '';
  return [
    '~/.ahrena-console/machines.json',
    `{ "machines": [ { "id": ${JSON.stringify(machine.id)}, "label": ${JSON.stringify(machine.label)}${port},`,
    '    "reconnect": { "command": ["/caminho/para/conectar.sh", "tunnel", "restart"],',
    '                   "timeoutSeconds": 180 } } ] }',
  ].join('\n');
}

/** The pill of a session in the attention list: with error, needing you, or your turn. */
export function sessionPill(item) {
  if (item.reason === 'error') return ['b-error', 'Com erro'];
  if (item.level === 'needs') return ['b-waiting', typeof item.shortReason === 'string' ? item.shortReason.slice(0, 40) : 'Esperando você'];
  return ['b-active', 'Sua vez'];
}

/** "motor-de-regras · 2 min" under a session's name. */
export function sessionMeta(item) {
  const age = Number.isFinite(item.minutes) ? (item.minutes < 1 ? 'agora' : `${Math.round(item.minutes)} min`) : null;
  return [typeof item.project === 'string' ? item.project.slice(0, 200) : null, age].filter(Boolean).join(' · ');
}

/** The example `machines.json`, with the keys the core reads (src/telemetry/machines-config.ts). */
export const MACHINES_JSON_EXAMPLE = '~/.ahrena-console/machines.json\n{ "machines": [{ "id": "workstation",\n  "label": "Workstation", "port": 14720 }] }';

/** The command that starts the core on the remote machine. */
export const START_CORE_COMMAND = 'node packages/nucleo/src/dono/cli.ts subir';

/**
 * Whether a `/api/changes` batch concerns this screen: an alert of this machine, any machine going
 * down or coming back (`<id>:machine-unreachable`, the sidebar and the tunnel table change), a
 * remote session of this machine entering or leaving the attention list (`<id>:<session>`), or, on
 * this machine, a session of its own.
 */
export function touchesMachine(changes, machineId) {
  const local = machineId === LOCAL_ID;
  return (changes ?? []).some((c) => {
    if (!isObject(c) || typeof c.key !== 'string') return false;
    if (c.type === 'alert') return c.key.startsWith(`${machineId}:`) || c.key.endsWith(':machine-unreachable');
    if (c.type === 'needs-you') return local || c.key.startsWith(`${machineId}:`);
    return local && c.type === 'session';
  });
}
