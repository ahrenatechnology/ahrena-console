// The machine screens on /ui (issue 178: C24, C25, C26): the pure parts, and the screen mounted on
// the fake DOM against the simulator's synthetic telemetry (this machine, a Mac "mac-exemplo", and a
// remote "ws-exemplo" with the workstation profile on port 14720), read through the same
// TelemetryService the core serves. The remote's state is set per test, like RemoteMachine would.
// No network, no real data, no machines.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { seedTelemetry, SimulatedCollector } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { TELEMETRY_VERSION, type MachineState, type UnreachableReason } from '../../src/telemetry/model.ts';
import { TelemetrySampler } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService, type MachineStatus } from '../../src/telemetry/service.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { pathname: '/ui/machines/local', search: '', port: '4720' };
const replaced: string[] = [];
Object.assign(globalThis, {
  location: here,
  history: {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, 'http://127.0.0.1');
      here.pathname = u.pathname;
      here.search = u.search;
      replaced.push(url);
    },
  },
});

// @ts-expect-error: browser module, plain JavaScript
import { ICON_NAMES } from '../../ui/dom.js';
// @ts-expect-error: idem
import * as format from '../../ui/screens/machine-format.js';
// @ts-expect-error: idem
import * as dashboard from '../../ui/screens/dashboard.js';
// @ts-expect-error: idem
import { createNav } from '../../ui/nav.js';
// @ts-expect-error: idem
import { SCREENS } from '../../ui/screens.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const NOW = Date.now();
const WS = { id: 'ws-exemplo', label: 'Workstation', port: 14720 };

// ---------- the simulator's telemetry, behind the core's service ----------

let storage: SqliteStorage;
let service: TelemetryService;
let serviceAlone: TelemetryService;
let remote: MachineStatus;
let machinesConfigured: boolean;

before(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  await seedTelemetry(store, 'local', 'local', NOW, 1);
  await seedTelemetry(store, WS.id, 'workstation', NOW, 1);
  // The first sample computes the open alerts over what was seeded (load, volume, ports, tunnel).
  await new TelemetrySampler({ machineId: 'local', collector: new SimulatedCollector('local', () => NOW), store, tracker }).sampleOnce();
  await new TelemetrySampler({ machineId: WS.id, collector: new SimulatedCollector('workstation', () => NOW), store, tracker }).sampleOnce();
  const remoteEntry = { id: WS.id, label: WS.label, port: WS.port, state: () => remote.state, status: () => remote };
  const all = [localMachine(), remoteEntry];
  service = new TelemetryService({ store, tracker, machines: all, now: () => NOW });
  // Without remotes: the same store, only this machine.
  serviceAlone = new TelemetryService({ store, tracker, machines: [localMachine()], now: () => NOW });
});
after(() => storage.close());

beforeEach(() => {
  remote = { state: 'connected', reason: null, version: TELEMETRY_VERSION };
  machinesConfigured = true;
  here.search = '';
  replaced.length = 0;
});

const setRemote = (state: MachineState, reason: UnreachableReason | null = null, version: number | null = TELEMETRY_VERSION) => (remote = { state, reason, version });

const ATTENTION = {
  total: 6,
  items: [
    { session: 'l1', title: 'Rodar a migração', project: 'vitrine-demo', level: 'needs', reason: 'permission', shortReason: 'Pede permissão', longReason: 'pede permissão', minutes: 2, machine: null },
    { session: 'r1', title: 'Migração do esquema de pedidos', project: 'motor-de-regras', level: 'needs', reason: 'question', shortReason: 'Fez uma pergunta', longReason: 'x', minutes: 2, machine: { id: WS.id, label: WS.label } },
    { session: 'r2', title: 'Relatório mensal mais rápido', project: 'painel-de-metricas', level: 'needs', reason: 'error', shortReason: 'Com erro', longReason: 'x', minutes: 3, machine: { id: WS.id, label: WS.label } },
    { session: 'r3', title: 'Endpoint de exportação em CSV', project: 'catalogo-exemplo', level: 'your-turn', reason: 'your-turn', shortReason: 'Sua vez', longReason: 'x', minutes: 0, machine: { id: WS.id, label: WS.label } },
    { session: 'r4', title: 'Separar pagamentos', project: 'motor-de-regras', level: 'your-turn', reason: 'your-turn', shortReason: 'Sua vez', longReason: 'x', minutes: 0, machine: { id: WS.id, label: WS.label } },
    { session: 'r5', title: 'Quinta', project: 'x', level: 'your-turn', reason: 'your-turn', shortReason: 'Sua vez', longReason: 'x', minutes: 1, machine: { id: WS.id, label: WS.label } },
    { session: 'o1', title: 'De outra máquina', project: 'y', level: 'needs', reason: 'question', shortReason: 'Fez uma pergunta', longReason: 'x', minutes: 1, machine: { id: 'lab', label: 'Lab' } },
  ],
};

/** A `read` that answers like the core: the route goes to the service, the JSON makes a round trip. */
async function coreRead(route: string): Promise<unknown> {
  const url = new URL(route, 'http://127.0.0.1');
  const svc = machinesConfigured ? service : serviceAlone;
  let body: unknown;
  if (url.pathname === '/api/machines') body = await svc.machines();
  else if (url.pathname === '/api/attention') body = ATTENTION;
  else if (url.pathname === '/api/telemetry') {
    body = await svc.telemetry(url.searchParams.get('machine') ?? 'local', Number(url.searchParams.get('hours') ?? 1) as 1 | 12);
    if (!body) throw Object.assign(new Error(`máquina desconhecida: ${url.searchParams.get('machine')}`), { name: 'ReadError', status: 404 });
  } else throw new Error(`unexpected route ${route}`);
  return JSON.parse(JSON.stringify(body));
}

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  ready: Promise<unknown>;
  change: (changes: unknown[]) => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount(id: string | null, read: (route: string) => Promise<unknown> = coreRead): Mounted {
  here.pathname = id ? `/ui/machines/${id}` : '/ui/machines/local';
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const signal = new AbortController();
  const onChange: ((c: unknown[]) => void)[] = [];
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: id ? { id } : {},
    signal: signal.signal,
    read: (route: string) => (reads.push(route), read(route)),
    onChange: (f: (c: unknown[]) => void) => onChange.push(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((f: () => void) => (cleanup = f));
  const m: Mounted = { area, reads, ready, change: (c) => onChange.forEach((f) => f(c)), leave: () => (signal.abort(), cleanup?.()) };
  open.push(m);
  return m;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const all = (area: ElementoFalso, selector: string) => area.querySelectorAll(selector).map((n) => texto(n));
const cardIds = (area: ElementoFalso) => area.querySelectorAll('.tm-stat').map((n) => n.getAttribute('data-card'));
const part = (area: ElementoFalso, name: string) => area.querySelector(`[data-part="${name}"]`);
const buttons = (area: ElementoFalso) => all(area, 'button');

// ---------- C24: this machine ----------

describe('#178 criterion 2: Esta máquina (C24) with the simulator', () => {
  test('the six cards in the wireframe order: CPU, Memória, Disco, Rede, Claude, Sessões', async () => {
    const m = mount(null);
    await m.ready;
    assert.deepEqual(cardIds(m.area), ['cpu', 'memory', 'disk', 'network', 'claude', 'sessions']);
    const t = texto(m.area);
    assert.match(texto(m.area.querySelector('.cc-head')), /Esta máquina .*mac-exemplo · macOS 26\.1 · 12 núcleos · 36 GB · lido /);
    assert.match(t, /carga \d+,?\d* de 12/);
    assert.match(t, /de 36 GB/);
    assert.match(t, /380 GB livres/);
    assert.match(t, /4 CLI · 7 Desktop/);
    // Sessões: the attention items of this machine only (`machine: null`).
    assert.equal(texto(m.area.querySelector('[data-card="sessions"] .tm-stat-v')), '1');
    assert.equal(texto(m.area.querySelector('[data-card="sessions"] .tm-stat-s')), '1 precisa de você');
  });

  test('the chart with 1 h and 12 h, volumes with the network, alerts, the tunnel, the Claude processes and the ports', async () => {
    const m = mount(null);
    await m.ready;
    const chart = part(m.area, 'chart')!;
    assert.match(texto(chart), /CPU e memória .*−60 min −45 −30 −15 agora CPU, % Memória usada, %/);
    assert.equal(chart.querySelectorAll('polyline.tm-line-a').length, 1);
    assert.equal(chart.querySelectorAll('polyline.tm-line-b').length, 1);
    assert.ok(chart.querySelector('polyline')!.getAttribute('points')!.split(' ').length >= 100, 'about 120 samples in 1 h');
    // Volumes: one <progress> per volume, the total in its unit.
    assert.deepEqual(all(m.area, '.tm-meter-top'), ['/ 232 de 612 GB · 38%', '/Volumes/Dados 0,9 de 2 TB · 45%']);
    assert.equal(m.area.querySelectorAll('progress.tm-bar').length, 2);
    assert.match(texto(m.area), /Rede en0 · rota padrão ↓ [\d,]+ GB · ↑ [\d,]+ GB desde o boot/);
    // O que pede atenção: the port on all interfaces and the busy tunnel port.
    assert.ok(all(m.area, '.tm-alerts li').some((x) => /5432/.test(x)));
    assert.ok(all(m.area, '.tm-alerts li').some((x) => /18080/.test(x)));
    // The tunnel, with each forwarded port's state; the remote core is named from machines.json.
    const tunnel = part(m.area, 'tunnel')!;
    assert.match(texto(tunnel), /ws-exemplo · túnel no ar há 3 h 12 min · 4 portas/);
    assert.deepEqual(all(tunnel, 'tbody tr'), [
      '14720 4720 Respondendo Núcleo da Workstation',
      '13000 3000 Respondendo vite',
      '15173 5173 Ninguém escuta lá nada escuta na 5173 de lá',
      '18080 8080 Ocupada no Mac node, deste Mac, segura a 18080',
    ]);
    // Processos do Claude and the top CPU users.
    assert.match(texto(part(m.area, 'claude')), /claude \(CLI\) 4 .*Claude Desktop 7 .*Os que mais usam CPU node 14% · claude 6%/);
    // Portas em escuta: filter counts, grouping, whose each one is.
    const ports = part(m.area, 'ports')!;
    assert.deepEqual(all(ports, '.tm-seg button'), ['Todas 7', 'Todas as interfaces 1', 'Só loopback 6']);
    assert.deepEqual(all(ports, 'tbody tr'), [
      '3000 só loopback node —',
      '4720 só loopback node Núcleo do console',
      '5432 todas as interfaces postgres —',
      '13000, 14720, 15173 só loopback ssh túnel para ws-exemplo',
      '18080 só loopback node segura a porta do túnel',
    ]);
    ports.querySelector('[data-filter="exposed"]')!.click();
    assert.deepEqual(all(part(m.area, 'ports')!, 'tbody tr'), ['5432 todas as interfaces postgres —']);
    assert.equal(part(m.area, 'ports')!.querySelector('[data-filter="exposed"]')!.getAttribute('aria-pressed'), 'true');
  });

  test('#255 rule 9: the alerts and the Claude processes stack beside the tunnel, and the ports take the whole row', async () => {
    const m = mount(null);
    await m.ready;
    const grid = m.area.querySelector('.tm-grid')!;
    const column = grid.querySelector('.card-column')!;
    assert.equal(column.parentNode, grid);
    assert.ok(column.classList.contains('tm-side'));
    assert.equal(column.children.length, 2);
    assert.ok(column.children[0]!.querySelector('.tm-alerts'), 'O que pede atenção first, as in the wireframe');
    assert.equal(column.children[1]!.getAttribute('data-part'), 'claude');
    // The wireframe order: chart, volumes, tunnel, the stacked column, then the ports on their own row.
    assert.deepEqual(
      grid.children.map((c) => c.getAttribute('data-part') ?? (c.classList.contains('card-column') ? 'column' : c.querySelector('.tm-meter') ? 'volumes' : '?')),
      ['chart', 'volumes', 'tunnel', 'column', 'ports'],
    );
    assert.ok(part(m.area, 'ports')!.classList.contains('tm-span-full'));
  });

  test('#255 rule 9: without a tunnel reading nothing stacks; the alerts take one column and the Claude processes the other two', async () => {
    const noTunnel = async (route: string) => {
      const r = (await coreRead(route)) as { current?: Record<string, unknown> };
      return route.startsWith('/api/telemetry') && r.current ? { ...r, current: { ...r.current, tunnels: null } } : r;
    };
    const m = mount(null, noTunnel);
    await m.ready;
    assert.equal(part(m.area, 'tunnel'), null);
    assert.equal(m.area.querySelector('.card-column'), null);
    const grid = m.area.querySelector('.tm-grid')!;
    assert.ok(grid.children.some((c) => c.querySelector('.tm-alerts')), 'O que pede atenção is a plain grid item');
    assert.equal(part(m.area, 'claude')!.parentNode, grid);
    assert.ok(part(m.area, 'claude')!.classList.contains('tm-span-wide'));
  });

  test('12 h: the toggle reads hours=12, keeps it in the URL and the axis follows', async () => {
    const m = mount(null);
    await m.ready;
    const twelve = m.area.querySelector('.cc-head [data-hours="12"]')!;
    twelve.click();
    await until(() => m.reads.some((r) => r.includes('hours=12')));
    await until(() => /−12 h/.test(texto(part(m.area, 'chart'))));
    assert.deepEqual(replaced, ['/ui/machines/local?hours=12']);
    assert.equal(twelve.getAttribute('aria-pressed'), 'true');
    assert.equal(format.hoursFromSearch('?hours=12'), 12);
    assert.equal(format.hoursFromSearch('?hours=3'), 1);
  });

  test('#178 criterion 3: with no remote configured, Esta máquina explains machines.json; with one, it does not', async () => {
    machinesConfigured = false;
    const alone = mount(null);
    await alone.ready;
    assert.match(texto(alone.area), /Nenhuma máquina remota Sem configuração, só esta máquina aparece\./);
    const config = texto(alone.area.querySelector('.tm-config'));
    assert.match(config, /~\/\.ahrena-console\/machines\.json/);
    // The keys are the ones the core reads.
    const json = config.slice(config.indexOf('{'));
    assert.deepEqual(JSON.parse(json), { machines: [{ id: 'workstation', label: 'Workstation', port: 14720 }] });
    machinesConfigured = true;
    const withRemote = mount(null);
    await withRemote.ready;
    assert.doesNotMatch(texto(withRemote.area), /Nenhuma máquina remota/);
  });
});

// ---------- C25: the remote machine ----------

describe('#178 criterion 2: a remote machine (C25) with the simulator', () => {
  test('the cards: CPU (load against vCPUs), Memória, GPU, Disco, Docker, Sessões lá; the header with the port and the state', async () => {
    const m = mount(WS.id);
    await m.ready;
    assert.deepEqual(cardIds(m.area), ['cpu', 'memory', 'gpu', 'disk', 'docker', 'sessions']);
    const head = texto(m.area.querySelector('.cc-head'));
    assert.match(head, /^Workstation .*ws-exemplo · Ubuntu 24\.04\.1 LTS · 16 vCPUs · 62 GB · GPU Exemplo T4 · porta 14720 do Mac · lido /);
    assert.match(head, /Conectada/);
    assert.match(texto(m.area.querySelector('[data-card="cpu"]')), /CPU .* de 16/);
    assert.match(texto(m.area.querySelector('[data-card="gpu"]')), /de 15 GB VRAM/);
    assert.match(texto(m.area.querySelector('[data-card="disk"]')), /86% \/ · 24 GB livres/);
    assert.match(texto(m.area.querySelector('[data-card="docker"]')), /106 4 stacks · 31,4 GB a liberar/);
    assert.match(texto(m.area.querySelector('[data-card="sessions"]')), /Sessões lá 5 2 precisam de você/);
  });

  test('the load chart with the vCPU line, volumes, Docker in use and reclaimable, the sessions over there, the stacks and the ports with the Mac port', async () => {
    const m = mount(WS.id);
    await m.ready;
    const chart = part(m.area, 'chart')!;
    assert.match(texto(chart), /Carga e memória a linha tracejada é o número de vCPUs .*Carga de 1 min Memória usada, GB \(de 62\) 16 vCPUs/);
    assert.ok(chart.querySelector('line.tm-limit'));
    assert.deepEqual(all(m.area, '.tm-meter-top').slice(0, 3), ['/ 146 de 170 GB · 86%', '/home 109 de 492 GB · 22%', '/tmp 23 de 206 GB · 11%']);
    assert.deepEqual(all(m.area, '.tm-meter-top').slice(3), ['Imagens 25,2 em uso · 8,7 recuperável', 'Containers 1,8 em uso · 0,7 recuperável', 'Volumes 4,6 em uso · 12,6 recuperável', 'Build cache 2,3 em uso · 9,4 recuperável']);
    // The widths come from data through CSSOM, never a style attribute.
    const used = m.area.querySelector('.tm-stack-used')!;
    assert.match(used.style.getPropertyValue('--w'), /^\d+(\.\d)?%$/);
    // Sessions of this machine only, four shown and the rest counted; no link (this core does not serve them).
    const sessions = all(m.area, '.tm-sessions li');
    assert.equal(sessions.length, 4);
    assert.match(sessions[0]!, /Migração do esquema de pedidos motor-de-regras · 2 min Fez uma pergunta/);
    assert.match(sessions[1]!, /Com erro/);
    assert.match(texto(m.area), /e mais 1 · as que esperam também vão para a bandeja/);
    assert.equal(m.area.querySelectorAll('.tm-sessions a').length, 0);
    assert.doesNotMatch(texto(m.area), /De outra máquina/);
    assert.deepEqual(all(part(m.area, 'stacks')!, 'tbody tr'), ['catalogo-local 8 3000', 'loja-validacao 0 · 15 parados 15432, 17233', 'motor-regras-int 12 18353', 'painel-metricas 9 14565']);
    const ports = part(m.area, 'ports')!;
    assert.match(texto(ports), /Portas em escuta lá/);
    assert.deepEqual(all(ports, '.tm-seg button'), ['Todas 8', 'Todas as interfaces 2', 'Só loopback 6']);
    const rows = all(ports, 'tbody tr');
    assert.ok(rows.includes('4720 só loopback node Núcleo do console 14720 Respondendo'), rows.join('\n'));
    assert.ok(rows.includes('3000 só loopback vite catalogo-local 13000 Respondendo'));
    assert.ok(rows.includes('8080 só loopback node — 18080 Ocupada no Mac'));
    assert.ok(rows.includes('15432 todas as interfaces docker-proxy loja-validacao —'));
  });

  test('an unknown machine: "Máquina não encontrada", not a broken screen', async () => {
    const m = mount('nao-existe');
    await m.ready;
    assert.match(texto(m.area), /Máquina não encontrada/);
  });
});

// ---------- C26: the remote's states ----------

describe('#178 criterion 3: a remote without connection (C26)', () => {
  test('port-closed: the "Sem conexão…" band, and the last reading faded with its age', async () => {
    setRemote('unreachable', 'port-closed');
    const m = mount(WS.id);
    await m.ready;
    const band = texto(m.area.querySelector('.error-band'));
    assert.match(band, /^Sem conexão com a Workstation\. A porta 14720 deste Mac não aceita conexão: o túnel parece caído\. Abaixo, a última leitura, de \d\d:\d\d \((agora|há \d+ s)\)\. Tentamos de novo a cada 30 s\. Tentar agora$/);
    assert.match(texto(m.area.querySelector('.cc-head')), /Sem conexão/);
    assert.match(texto(m.area.querySelector('.cc-head .sub')), /última leitura às \d\d:\d\d$/);
    const faded = m.area.querySelector('.tm-faded')!;
    assert.ok(faded, 'the last reading, faded');
    assert.deepEqual(faded.querySelectorAll('.tm-stat').map((n) => n.getAttribute('data-card')), ['cpu', 'memory', 'gpu', 'disk', 'docker', 'sessions']);
    // "Tentar agora" only re-reads.
    const before = m.reads.length;
    m.area.querySelector('.error-band button')!.click();
    await until(() => m.reads.length > before);
  });

  test('no-response: "o túnel está de pé, mas o núcleo de lá não respondeu", with the command to start it', async () => {
    setRemote('unreachable', 'no-response');
    const m = mount(WS.id);
    await m.ready;
    const state = texto(m.area.querySelector('.tm-state'));
    assert.match(state, /O túnel está de pé, mas o núcleo de lá não respondeu A porta 14720 aceita a conexão e ninguém responde em 3 s\. Suba o núcleo na Workstation:/);
    assert.equal(texto(m.area.querySelector('.tm-state .tm-config')), 'node packages/nucleo/src/dono/cli.ts subir');
    assert.match(texto(m.area), /não sobe nem derruba o túnel/);
  });

  test('incompatible-version: the version band, and what both understand stays on screen', async () => {
    setRemote('incompatible-version', null, 7);
    const m = mount(WS.id);
    await m.ready;
    assert.match(texto(m.area.querySelector('.tm-state')), /Versão diferente lá O núcleo da Workstation responde com a telemetria v7 e este entende a v1\./);
    assert.match(texto(m.area.querySelector('.cc-head')), /Versão diferente/);
    assert.equal(m.area.querySelector('.tm-faded'), null);
    assert.ok(m.area.querySelector('.tm-stat'));
  });

  test('before the first read (unreachable, no reason): "Lendo … pela primeira vez"', async () => {
    setRemote('unreachable', null, null);
    const m = mount(WS.id);
    await m.ready;
    assert.match(texto(m.area), /Lendo a Workstation pela primeira vez/);
    assert.match(texto(m.area.querySelector('.cc-head')), /Conectando/);
  });

  // Decision 0012 (issue 244) adds one write, Reconectar, which runs the user's own command and only
  // when machines.json has one (test/api/ui-machine-reconnect.test.ts); without it, nothing changes here.
  test('no button starts, stops or forwards a tunnel: the app only shows', async () => {
    const allowed = new Set(['1 h', '12 h', 'Tentar agora', 'Tentar de novo']);
    for (const [state, reason] of [['connected', null], ['unreachable', 'port-closed'], ['unreachable', 'no-response'], ['incompatible-version', null], ['unreachable', null]] as const) {
      setRemote(state, reason);
      for (const id of [WS.id, null]) {
        const m = mount(id);
        await m.ready;
        const labels = buttons(m.area).filter((b) => !/^(Todas|Todas as interfaces|Só loopback) \d+$/.test(b));
        assert.deepEqual(labels.filter((b) => !allowed.has(b)), [], `${state} ${reason} ${id}`);
      }
    }
    const source = readFileSync(`${UI_FOLDER}screens/machine.js`, 'utf8');
    const writes = [...source.matchAll(/ctx\.write\(([^,]+),/g)].map((m) => m[1]);
    assert.deepEqual(writes, ['reconnectRoute(id)'], 'the machine screen writes only to /api/machines/<id>/reconnect');
  });
});

// ---------- groups null and strange remote shapes ----------

describe('#178 criterion 2: a card whose group is null does not show; strange shapes do not break the screen', () => {
  const base = () => ({
    version: 1,
    hours: 1,
    machine: { id: WS.id, label: WS.label, state: 'connected', reason: null, version: 1, port: WS.port, lastReadAt: new Date(NOW).toISOString(), alerts: 0 },
    series: { at: [new Date(NOW).toISOString()], cpuUsedPct: [10], load1: [1], memoryUsedBytes: [1e9], swapUsedBytes: [null], rxBytesPerSec: [null], txBytesPerSec: [null], gpuUsedPct: [null] },
    alerts: [],
  });
  const readerWith = (current: unknown, extra: Record<string, unknown> = {}) => async (route: string) => {
    if (route.startsWith('/api/telemetry')) return { ...base(), ...extra, current };
    if (route === '/api/machines') return [{ id: 'local', label: 'Esta máquina', state: 'connected' }, base().machine];
    throw new Error('sem atenção');
  };
  const reading = {
    takenAt: new Date(NOW).toISOString(),
    host: { hostname: 'ws-exemplo', os: 'Linux', arch: 'x64', uptimeSec: 1 },
    cpu: { cores: 16, model: null, usedPct: 12, load: { one: 3, five: 2, fifteen: 1 } },
    memory: { totalBytes: 64e9, usedBytes: 10e9, swapTotalBytes: null, swapUsedBytes: null, pressure: null },
    disk: { volumes: [{ mount: '/', totalBytes: 100e9, usedBytes: 50e9, freeBytes: 50e9, usedPct: 50 }] },
  };

  test('null groups: GPU, Docker, ports and the stacks are left out', async () => {
    const m = mount(WS.id, readerWith({ ...reading, gpu: null, network: null, claude: null, topProcesses: null, docker: null, ports: null, tunnels: null }));
    await m.ready;
    assert.deepEqual(cardIds(m.area), ['cpu', 'memory', 'disk']);
    assert.equal(part(m.area, 'ports'), null);
    assert.equal(part(m.area, 'stacks'), null);
    assert.ok(part(m.area, 'chart'));
  });

  test('a remote that sends groups in other shapes: the screen stays up with what it understands', async () => {
    const weird = {
      ...reading,
      gpu: 'T4',
      network: [1, 2],
      claude: { processes: 'many' },
      topProcesses: { node: 3 },
      docker: { running: 'x', stacks: [null, { name: 7 }, { name: 'ok-stack', running: 2, stopped: 'x', ports: ['80', 8080, -1] }], space: [{ type: 'Images' }, { type: 'Build Cache', sizeBytes: 2e9, reclaimableBytes: 9e9 }] },
      ports: [{ port: 'x' }, { port: 22, interface: 'weird' }, null, { port: 70000 }],
      tunnels: [{ destination: 3 }],
      disk: { volumes: [{ mount: '/' }, 'x', { mount: '/data', totalBytes: 10e9, usedBytes: 2e9 }] },
    };
    const m = mount(WS.id, readerWith(weird));
    await m.ready;
    assert.deepEqual(cardIds(m.area), ['cpu', 'memory', 'disk', 'docker']);
    assert.deepEqual(all(part(m.area, 'stacks')!, 'tbody tr'), ['ok-stack 2 8080']);
    assert.deepEqual(all(part(m.area, 'ports')!, 'tbody tr'), ['22 — — — —']);
    assert.match(texto(m.area), /Build cache 0 em uso · 2 recuperável/);
    // A reading that is not an object at all.
    for (const current of ['x', 42, [], null]) {
      const n = mount(WS.id, readerWith(current));
      await n.ready;
      assert.match(texto(n.area), /Ainda não há leitura/, JSON.stringify(current));
    }
  });

  test('normalizeReading never throws and drops what has no shape', () => {
    for (const junk of [undefined, null, 1, 'x', [], { cpu: 'x', memory: [], disk: 'x', docker: [], ports: 'x' }]) {
      const r = format.normalizeReading(junk);
      if (r) {
        assert.equal(r.cpu, null);
        assert.equal(r.memory, null);
        assert.deepEqual(r.volumes, []);
        assert.equal(r.docker, null);
        assert.equal(r.ports, null);
      }
    }
    assert.deepEqual(format.normalizeSeries({ at: ['a', 'b'], cpuUsedPct: [1, 'x'] }).cpuUsedPct, [1, null]);
    assert.deepEqual(format.normalizeAlerts([{ message: 'oi', level: 'nope' }, { level: 'error' }, 'x']).map((a: { level: string }) => a.level), ['info']);
  });
});

// ---------- the pure parts ----------

describe('machine-format.js', () => {
  test('formats in pt-BR', () => {
    assert.equal(format.decimal(21.37), '21,4');
    assert.equal(format.decimal(3), '3');
    assert.equal(format.bytes(140e6), '140 MB');
    assert.equal(format.bytes(1.4e9), '1,4 GB');
    assert.equal(format.bytes(2e12), '2 TB');
    assert.equal(format.rate(310e3), '310 kB/s');
    assert.equal(format.ago(new Date(NOW - 4000).toISOString(), NOW), 'há 4 s');
    assert.equal(format.ago(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), 'há 2 dias');
    assert.equal(format.duration(new Date(NOW - (3 * 60 + 12) * 60_000).toISOString(), NOW), '3 h 12 min');
    assert.equal(format.ago('nunca', NOW), '');
  });

  test('polylines leave a gap where a value is missing', () => {
    assert.equal(format.polylines([1, 2, null, 3], { max: 4, width: 300, height: 120 }).length, 2);
    assert.deepEqual(format.polylines([null, null], { max: 1 }), []);
  });

  test('the remote conditions of C26', () => {
    const m = (state: string, reason: string | null = null) => ({ id: 'ws', label: 'W', state, reason, version: 1, port: 1 });
    assert.equal(format.remoteCondition(m('connected')), null);
    assert.equal(format.remoteCondition(m('unreachable', 'port-closed')), 'band');
    assert.equal(format.remoteCondition(m('unreachable', 'no-response')), 'no-response');
    assert.equal(format.remoteCondition(m('unreachable')), 'first-read');
    assert.equal(format.remoteCondition(m('incompatible-version')), 'version');
    assert.equal(format.remoteCondition({ ...m('unreachable', 'port-closed'), id: 'local' }), null);
  });
});

// ---------- live ----------

describe('#178 criterion 6: live through /api/changes, with simulator data', () => {
  test('an alert of this machine or a machine going down re-reads; another machine\'s alert or a repos change does not', async () => {
    assert.equal(format.touchesMachine([{ type: 'alert', key: 'ws-exemplo:volume-full:/' }], 'ws-exemplo'), true);
    assert.equal(format.touchesMachine([{ type: 'alert', key: 'lab:machine-unreachable' }], 'local'), true);
    assert.equal(format.touchesMachine([{ type: 'alert', key: 'lab:volume-full:/' }], 'ws-exemplo'), false);
    assert.equal(format.touchesMachine([{ type: 'needs-you', key: 'ws-exemplo:s1' }], 'ws-exemplo'), true);
    assert.equal(format.touchesMachine([{ type: 'needs-you', key: 'lab:s1' }], 'ws-exemplo'), false);
    assert.equal(format.touchesMachine([{ type: 'session', key: 's1' }], 'local'), true);
    assert.equal(format.touchesMachine([{ type: 'repos', key: 'lista' }, null], 'local'), false);

    const m = mount(WS.id);
    await m.ready;
    assert.doesNotMatch(texto(m.area), /Sem conexão com a Workstation/);
    m.change([{ type: 'repos', key: 'lista' }]);
    await new Promise((r) => setTimeout(r, 450));
    const before = m.reads.length;
    // The tunnel drops: the core publishes `ws-exemplo:machine-unreachable` and the screen follows.
    setRemote('unreachable', 'port-closed');
    m.change([{ type: 'alert', key: 'ws-exemplo:machine-unreachable', sessionId: null, accountId: null }]);
    await until(() => /Sem conexão com a Workstation/.test(texto(m.area)));
    assert.ok(m.reads.length > before);
    // And it comes back.
    setRemote('connected');
    m.change([{ type: 'alert', key: 'ws-exemplo:machine-unreachable', sessionId: null, accountId: null }]);
    await until(() => !/Sem conexão com a Workstation/.test(texto(m.area)) && /Conectada/.test(texto(m.area)));
  });
});

// ---------- C1: the remote sessions on the Dashboard ----------

describe('Dashboard: remote sessions (supports #176/#178): the machine label and no link', () => {
  test('inboxCards: an item with `machine` carries the label and has no href; a local one keeps its link', () => {
    const cards = dashboard.inboxCards(ATTENTION, [{ session: 'r1', model: 'claude-opus-5-5', task: 'Bash: rm' }]);
    assert.equal(cards[0].href, '/ui/sessions/l1');
    assert.equal(cards[0].machine, null);
    assert.equal(cards[1].href, null);
    assert.deepEqual(cards[1].machine, { id: WS.id, label: 'Workstation' });
    assert.equal(cards[1].foot, 'Workstation', 'the machine, not a local agent of the same id');
  });

  test('mounted: the remote card is not a link and shows the machine', async () => {
    const numbers = { sessions: { total: 1, active: 1, waiting: 0, withError: 0 }, agents: { active: 0, sessions: 0 }, subagents: { active: 0, sessions: 0 }, events: { today: 0, lastHour: 0, total: 0 }, cost: { usd: 0, days: 30, unpriced: [] } };
    const area = new ElementoFalso('main');
    const signal = new AbortController();
    const cleanup = await dashboard.mount(area, {
      read: async (route: string) => (route === '/api/dashboard' ? { numbers, agents: [], activity: [] } : ATTENTION),
      signal: signal.signal,
      onChange: () => {},
      onRestart: () => {},
      counter: () => {},
    });
    try {
      const minis = area.querySelectorAll('.mini');
      assert.equal(minis[0]!.tagName, 'A');
      assert.equal(minis[1]!.tagName, 'DIV');
      assert.equal(minis[1]!.getAttribute('href'), null);
      assert.equal(minis[1]!.getAttribute('data-machine'), WS.id);
      assert.match(texto(minis[1]!), /Workstation$/);
      assert.doesNotMatch(texto(minis[1]!), /Abrir/);
    } finally {
      signal.abort();
      cleanup?.();
    }
  });
});

// ---------- files, classes and icons ----------

const FILES = ['screens/machine.js', 'screens/machine-format.js', 'screens/machine.css'];
const classesOfCss = (file: string) => new Set([...readFileSync(`${UI_FOLDER}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
const SEALS = new Set(['badge', 'p', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);

describe('#178 the screen\'s files, CSS, classes and icons', () => {
  test('criterion 5: every own class in machine.css and in the JS starts with tm-', () => {
    const shell = classesOfCss('shell.css');
    const own = [...classesOfCss('screens/machine.css')].filter((c) => !shell.has(c) && !SEALS.has(c));
    assert.ok(own.length > 30);
    assert.deepEqual(own.filter((c) => !c.startsWith('tm-')), []);
    const js = readFileSync(`${UI_FOLDER}screens/machine.js`, 'utf8');
    const used = [...js.matchAll(/class: [`'"]([^`'"]+)[`'"]/g)].flatMap((m) => m[1]!.split(/\s+/)).map((c) => (c.includes('${') ? c.slice(0, c.indexOf('${')) : c)).filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
    assert.ok(used.length > 20);
    assert.deepEqual(used.filter((c) => !c.startsWith('tm-') && !shell.has(c) && !SEALS.has(c) && !['card', 'btn', 'outline', 'mono', 'eyebrow', 'badge', 'error-band'].includes(c)), []);
  });

  test('#255 rule 9: the stacked column is plain grid items in two columns and a flex column in three; a stretched chart grows', () => {
    const css = readFileSync(`${UI_FOLDER}screens/machine.css`, 'utf8');
    const wide = css.slice(css.indexOf('@media (min-width: 1300px)'));
    assert.match(css, /\.tm-side \{ display: contents; \}/);
    assert.match(wide.slice(0, wide.indexOf('}\n}')), /\.tm-side \{ display: flex; \}/);
    assert.match(css, /\.tm-chart \{[^}]*flex: 1 0 120px;/);
  });

  test('criterion 4 (static part): nothing scrolls horizontally: fixed tables, wrapping text, no overflow-x', () => {
    const css = readFileSync(`${UI_FOLDER}screens/machine.css`, 'utf8');
    assert.doesNotMatch(css, /overflow-x/);
    assert.match(css, /\.tm-table \{[^}]*table-layout: fixed/);
    assert.match(css, /\.tm-grid \{[^}]*minmax\(0, 1fr\)/);
    assert.match(css, /\.tm-stats \{[^}]*minmax\(0, 1fr\)/);
    assert.match(css, /\.tm-config \{[^}]*white-space: pre-wrap/);
  });

  test('criterion 5: the files exist, the screen loads its CSS by data-screen and removes it on leaving', async () => {
    for (const f of FILES) readFileSync(`${UI_FOLDER}${f}`);
    const m = mount(null);
    await m.ready;
    assert.ok(document.head.querySelector('link[data-screen="machine"]'));
    assert.equal((document.head.querySelector('link[data-screen="machine"]') as unknown as ElementoFalso).getAttribute('href'), '/ui/screens/machine.css');
    m.leave();
    open.splice(open.indexOf(m), 1);
    assert.equal(document.head.querySelector('link[data-screen="machine"]'), null);
  });

  test('criterion 5: every icon the screen uses exists; the new ones are not a drawing already there', () => {
    const js = FILES.filter((f) => f.endsWith('.js')).map((f) => readFileSync(`${UI_FOLDER}${f}`, 'utf8')).join('\n');
    const used = new Set([...js.matchAll(/icon\('([a-z-]+)'\)|iconName: '([a-z-]+)'|icon: '([a-z-]+)'/g)].map((m) => m[1] ?? m[2] ?? m[3]));
    for (const name of [...used, 'monitor', 'server', 'memory-stick', 'hard-drive', 'wifi', 'monitor-dot', 'container', 'cable', 'radio-tower', 'server-off', 'git-compare']) assert.ok(ICON_NAMES.includes(name), `missing icon ${name}`);
    const dom = readFileSync(`${UI_FOLDER}dom.js`, 'utf8');
    const drawings = [...dom.matchAll(/^\s+'?([\w-]+)'?: '(<[^']*)',$/gm)];
    for (const name of ['monitor', 'monitor-dot', 'memory-stick', 'hard-drive', 'wifi', 'container', 'cable', 'radio-tower', 'server-off', 'git-compare']) {
      const mine = drawings.find((d) => d[1] === name)![2];
      assert.deepEqual(drawings.filter((d) => d[2] === mine).map((d) => d[1]), [name], `the drawing of ${name} repeats`);
    }
  });
});

// ---------- the sidebar (nav.js) ----------

describe('#178 criterion 1: the sidebar draws the remote machines from /api/machines', () => {
  test('a remote appears in Máquinas with its state dot; a counter and the lit item survive the redraw', async () => {
    let list: unknown = [{ id: 'local', label: 'Esta máquina', state: 'connected' }];
    const nav = new ElementoFalso('nav');
    const reads: string[] = [];
    const { readMachines, highlight, counter } = createNav({ nav, read: async (route: string) => (reads.push(route), list), screens: SCREENS });
    const machinesBlock = () => nav.querySelector('[data-section="machines"]')!;
    assert.deepEqual(machinesBlock().querySelectorAll('a').map((a) => a.getAttribute('data-screen')), ['this-machine']);
    counter('dashboard', 4);
    // The open screen is the remote's, before the list arrives.
    highlight('machine-ws-exemplo');
    list = [...(list as unknown[]), { id: 'ws-exemplo', label: 'Workstation', state: 'unreachable', reason: 'port-closed', port: 14720 }];
    await readMachines();
    assert.deepEqual(reads, ['/api/machines']);
    const links = machinesBlock().querySelectorAll('a');
    assert.deepEqual(links.map((a) => [a.getAttribute('data-screen'), a.getAttribute('href'), texto(a)]), [
      ['this-machine', '/ui/machines/local', 'Esta máquina'],
      ['machine-ws-exemplo', '/ui/machines/ws-exemplo', 'Workstation'],
    ]);
    const dot = links[1]!.querySelector('.cc-nav-dot')!;
    assert.equal(dot.getAttribute('data-state'), 'unreachable');
    assert.equal(dot.getAttribute('role'), 'img');
    assert.equal(dot.getAttribute('aria-label'), 'Sem conexão');
    assert.equal(links[0]!.querySelector('.cc-nav-dot'), null, 'this machine has no dot');
    assert.equal(links[1]!.getAttribute('aria-current'), 'page');
    assert.equal(texto(nav.querySelector('[data-screen="dashboard"] .q')), '4');
    // The machine comes back: one more redraw, the counter and aria-current still there.
    list = (list as { id: string }[]).map((m) => (m.id === 'ws-exemplo' ? { ...m, state: 'connected', reason: null } : m));
    await readMachines();
    assert.equal(nav.querySelector('[data-screen="machine-ws-exemplo"] .cc-nav-dot')!.getAttribute('aria-label'), 'Conectada');
    assert.equal(nav.querySelector('[data-screen="machine-ws-exemplo"]')!.getAttribute('aria-current'), 'page');
    assert.equal(texto(nav.querySelector('[data-screen="dashboard"] .q')), '4');
    // A failed read (no telemetry, offline) keeps the items there.
    const failing = createNav({ nav: new ElementoFalso('nav'), read: async () => Promise.reject(new Error('404')), screens: SCREENS });
    await failing.readMachines();
    await readMachines();
    assert.equal(machinesBlock().querySelectorAll('a').length, 2);
  });
});

// ---------- review round 1 ----------

describe('#178 criterion 2: the chart places samples by time', () => {
  test('a 30-minute hole in the samples breaks the line where it is, not at the next index', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const at: string[] = [];
    const values: number[] = [];
    for (let t = now - 3_600_000 + 30_000; t <= now; t += 30_000) {
      const minute = (now - t) / 60_000;
      if (minute > 15 && minute < 45) continue; // the core was down for 30 min
      at.push(new Date(t).toISOString());
      values.push(50);
    }
    const lines = format.polylines(values, { max: 100, width: 600, height: 120, at, ...format.timeWindow(1, now) });
    assert.equal(lines.length, 2);
    const xs = (line: string) => line.split(' ').map((p) => Number(p.split(',')[0]));
    assert.ok(Math.abs(xs(lines[0]!).at(-1)! - 150) < 6, `the first part ends near −45 min: ${xs(lines[0]!).at(-1)}`);
    assert.ok(Math.abs(xs(lines[1]!)[0]! - 450) < 6, `the second starts near −15 min: ${xs(lines[1]!)[0]}`);
    assert.equal(xs(lines[1]!).at(-1), 600);
    // Without a hole, one line; at 12 h the step is the 2 min bucket.
    assert.equal(format.polylines([1, 2, 3], { max: 4, at: [now - 60_000, now - 30_000, now].map((t) => new Date(t).toISOString()), ...format.timeWindow(1, now) }).length, 1);
    assert.equal(format.timeWindow(12, now).gapMs, 4 * 60_000);
    // A sample outside the window, or with a bad time, is not drawn.
    assert.deepEqual(format.polylines([1, 1], { max: 2, at: [new Date(now - 2 * 3_600_000).toISOString(), 'x'], ...format.timeWindow(1, now) }), []);
  });
});

describe('#178 criterion 2: an id the core refuses and the core without telemetry', () => {
  test('/ui/machines/Foo (400 from the core, or an invalid id) is "Máquina não encontrada", without reading', async () => {
    const m = mount('Foo');
    await m.ready;
    assert.match(texto(m.area), /Máquina não encontrada/);
    assert.deepEqual(m.reads, []);
    assert.equal(format.failureKind({ status: 400, message: 'machine inválida' }), 'not-found');
    assert.equal(format.failureKind({ status: 404, message: 'máquina desconhecida: x' }), 'not-found');
    assert.equal(format.failureKind({ status: 404, message: 'o núcleo subiu sem a telemetria' }), 'no-telemetry');
    assert.equal(format.failureKind({ status: 0, message: 'offline' }), 'error');
  });

  test('the core without telemetry: its own message, not "Sem conexão" with an endless retry', async () => {
    const m = mount(null, async () => Promise.reject(Object.assign(new Error('o núcleo subiu sem a telemetria'), { name: 'ReadError', status: 404 })));
    await m.ready;
    assert.match(texto(m.area), /O núcleo subiu sem a telemetria/);
    assert.doesNotMatch(texto(m.area), /Sem conexão com o núcleo|Tentar de novo/);
  });
});

describe('#178 criterion 6: leaving the screen stops the re-reads', () => {
  test('leaving before the first read comes back: no read afterwards, not even on the 30 s tick', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const m = mount(WS.id, async (route) => (await gate, coreRead(route)));
      assert.equal(m.reads.length, 3, 'the first draw is under way');
      m.leave();
      release();
      await m.ready;
      const after = m.reads.length;
      mock.timers.tick(5 * 30_000);
      m.change([{ type: 'alert', key: 'ws-exemplo:machine-unreachable' }]);
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
      assert.equal(m.reads.length, after, 'nothing read after leaving');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('#178 criterion 2: the focus stays on the button through a repaint', () => {
  test('a port filter keeps the focus after the click and after the re-read', async () => {
    const m = mount(null);
    await m.ready;
    const active = () => (document as unknown as { activeElement: ElementoFalso }).activeElement;
    const exposed = part(m.area, 'ports')!.querySelector('[data-filter="exposed"]')!;
    exposed.focus();
    exposed.click();
    assert.notEqual(active(), exposed, 'the old button is gone');
    assert.equal(active().getAttribute('data-filter'), 'exposed');
    assert.ok(part(m.area, 'ports')!.contains(active()));
    // A re-read (an alert of this machine) repaints everything again.
    const reads = m.reads.length;
    const old = active();
    m.change([{ type: 'alert', key: 'local:port-exposed:5432' }]);
    await until(() => m.reads.length > reads && active() !== old);
    assert.equal(active().getAttribute('data-filter'), 'exposed');
    assert.ok(part(m.area, 'ports')!.contains(active()));
    // And the 12 h button.
    const twelve = m.area.querySelector('[data-hours="12"]')!;
    twelve.focus();
    twelve.click();
    await until(() => /−12 h/.test(texto(part(m.area, 'chart'))));
    assert.equal(active().getAttribute('data-hours'), '12');
  });
});
