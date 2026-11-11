// The remote owner proof on /ui (#388, decision 0020 section 6, wireframes 388-1 to 388-4): the three reasons
// a remote's core refuses this Mac (`owner-auth-required`, `owner-auth-failed`, `owner-auth-mismatch`) as the
// machine screen, its connection card, the sidebar dot and the alert title say them. The pure parts, and the
// screen mounted on the fake DOM with the simulator's telemetry and a fake `connection` shaped like
// GET /api/machines. No network, no machines.json, no process runs, and no real credential: the only "secret"
// is a sentinel that must never reach the screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { seedTelemetry, SimulatedCollector } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { TELEMETRY_VERSION, type MachineState, type UnreachableReason } from '../../src/telemetry/model.ts';
import { TelemetrySampler } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService, type MachineStatus } from '../../src/telemetry/service.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { pathname: '/ui/machines/ws-exemplo', search: '', port: '4720' };
Object.assign(globalThis, { location: here, history: { state: null, replaceState: () => {} } });

// @ts-expect-error: browser module, plain JavaScript
import * as format from '../../ui/screens/machine-format.js';
// @ts-expect-error: idem
import { machineItems, SCREENS } from '../../ui/screens.js';
// @ts-expect-error: idem
import { createNav } from '../../ui/nav.js';
// @ts-expect-error: idem
import { ICON_NAMES } from '../../ui/dom.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const UI_FOLDER = new URL('../../ui/', import.meta.url).pathname;
const NOW = Date.now();
const WS = { id: 'ws-exemplo', label: 'Workstation', port: 14720 };
const START = ['/caminho/para/conectar.sh', 'tunnel', 'start'];
const STOP = ['/caminho/para/conectar.sh', 'tunnel', 'stop'];
const H = 3_600_000;
const M = 60_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** Stands for a credential, a key or a command's output: it must never be on the screen (AC3). */
const SENTINEL = 'sentinela-credencial-0f1e2d3c';
const OWNER_AUTH: UnreachableReason[] = ['owner-auth-required', 'owner-auth-failed', 'owner-auth-mismatch'];

type Obj = Record<string, unknown>;
const PORTS = [
  { localPort: 14720, remoteHost: 'localhost', remotePort: 4720, state: 'up', heldBy: null },
  { localPort: 13000, remoteHost: 'localhost', remotePort: 3000, state: 'up', heldBy: null },
];
const connOf = (over: Obj = {}): Obj => ({
  configured: true,
  state: 'up',
  since: iso(3 * H + 12 * M),
  ports: PORTS,
  cloud: { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'valid', expiresAt: new Date(NOW + 7 * H).toISOString() },
  lastError: null,
  actions: { start: false, stop: true, reconnect: true, loginAndStart: false },
  command: { start: START, stop: STOP, startTimeoutSeconds: 180, stopTimeoutSeconds: 180 },
  job: null,
  logFile: '/Users/exemplo/.ahrena-console/reconnect.log',
  ...over,
});
/** What the core sends for a remote whose core refuses the proof: the machine is unreachable, so the connection is `down` with the ports up. */
const refused = (over: Obj = {}): Obj => connOf({ state: 'down', since: iso(2 * M), actions: { start: true, stop: false, reconnect: true, loginAndStart: false }, ...over });

// ---------- the simulator's telemetry behind the core's service, and the fake connection ----------

let storage: SqliteStorage;
let service: TelemetryService;
let remote: MachineStatus;
let connection: Obj | null | undefined;
let extra: Obj;

before(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  await seedTelemetry(store, 'local', 'local', NOW, 1);
  await seedTelemetry(store, WS.id, 'workstation', NOW, 1);
  await new TelemetrySampler({ machineId: WS.id, collector: new SimulatedCollector('workstation', () => NOW), store, tracker }).sampleOnce();
  const remoteEntry = { id: WS.id, label: WS.label, port: WS.port, state: () => remote.state, status: () => remote };
  service = new TelemetryService({ store, tracker, machines: [localMachine(), remoteEntry], now: () => NOW });
});
after(() => storage.close());

beforeEach(() => {
  setRemote('connected');
  connection = connOf();
  extra = {};
});

const setRemote = (state: MachineState, reason: UnreachableReason | null = null) => (remote = { state, reason, version: TELEMETRY_VERSION });

async function coreRead(route: string): Promise<unknown> {
  const url = new URL(route, 'http://127.0.0.1');
  let body: unknown;
  if (url.pathname === '/api/machines') {
    const list = (await service.machines()) as unknown as Obj[];
    body = list.map((m) => (m.id === WS.id ? { ...m, reconnect: null, ...extra, ...(connection === undefined ? {} : { connection }) } : { ...m, reconnect: null }));
  } else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
  else if (url.pathname === '/api/telemetry') body = JSON.parse(JSON.stringify(await service.telemetry(url.searchParams.get('machine') ?? 'local', 1)));
  else if (url.pathname === '/api/connectors') body = { connectors: [] };
  else if (url.pathname.startsWith('/api/machines/') && url.pathname.endsWith('/connectors')) body = { machine: WS.id, status: 'ok', connectors: [] };
  else throw new Error(`unexpected route ${route}`);
  return JSON.parse(JSON.stringify(body));
}

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount(): Mounted {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const signal = new AbortController();
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: { id: WS.id },
    signal: signal.signal,
    read: (route: string) => (reads.push(route), coreRead(route)),
    write: async () => ({ connection }),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((fn: () => void) => (cleanup = fn));
  const m: Mounted = { area, reads, ready, leave: () => (signal.abort(), cleanup?.()) };
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
const part = (area: ElementoFalso, name: string) => area.querySelector(`[data-part="${name}"]`);
const buttons = (node: ElementoFalso | null) => (node ? node.querySelectorAll('button').map((b) => texto(b)) : []);
const cell = (area: ElementoFalso, key: string) => texto(area.querySelector(`[data-cell="${key}"]`));
const pill = (area: ElementoFalso) => texto(area.querySelector('.cc-head .badge'));
const wrap = (nodes: ElementoFalso[]) => {
  const box = new ElementoFalso('div');
  for (const n of nodes) if (n) box.append(n);
  return box;
};
/** Every text and attribute value under a node: where a leak would show. */
function everything(node: ElementoFalso): string {
  const out: string[] = [texto(node)];
  const visit = (n: ElementoFalso) => {
    for (const v of n.atributos.values()) out.push(v);
    n.children.forEach(visit);
  };
  visit(node);
  return out.join('\n');
}
const machineOf = (reason: UnreachableReason) => format.normalizeMachine({ id: WS.id, label: WS.label, port: WS.port, state: 'unreachable', reason });

// ---------- the pure parts ----------

describe('#388 the owner-proof reasons in machine-format', () => {
  test('AC1 · 388-1 to 388-3: normalizeMachine keeps the three owner-proof reasons and remoteCondition maps each to its own condition', () => {
    for (const reason of OWNER_AUTH) {
      const m = machineOf(reason);
      assert.equal(m.reason, reason);
      assert.equal(format.remoteCondition(m), reason);
    }
    assert.equal(format.normalizeMachine({ id: WS.id, state: 'unreachable', reason: 'owner-auth-something' }).reason, null, 'an unknown reason is dropped');
    assert.equal(format.remoteCondition(machineOf('port-closed')), 'band');
    assert.equal(format.remoteCondition(machineOf('no-response')), 'no-response');
  });
});

describe('#388 the owner-proof bands (conditionParts)', () => {
  test('AC1 · 388-1: owner-auth-required shows the credential command example, Copiar o exemplo and Tentar agora', async () => {
    let retried = 0;
    const c = screen.conditionParts(machineOf('owner-auth-required'), null, { retry: () => (retried++, Promise.resolve()) });
    assert.equal(c.faded, true, 'the last reading fades');
    const box = wrap(c.parts);
    const band = box.querySelector('[data-part="owner-auth"]')!;
    assert.ok(band.classList.contains('tm-rc-waiting'), 'the band is yellow');
    assert.equal(band.getAttribute('data-reason'), 'owner-auth-required');
    assert.match(texto(band), /^A Workstation pede a prova do dono, e este Mac ainda não sabe pedi-la\. O núcleo de lá só responde a quem prova ser o dono, e esta máquina não tem o comando de credencial no machines\.json\./);
    assert.match(texto(band), /O núcleo de lá também precisa ter a credencial remota; se for antigo, atualize-o\./);
    assert.match(texto(band), /do núcleo de lá, que recusou o pedido sem prova/);
    assert.deepEqual(buttons(band), ['Tentar agora']);
    assert.ok(band.querySelector('button')!.classList.contains('filled'));
    const setup = box.querySelector('[data-part="owner-auth-setup"]')!;
    assert.match(texto(setup), /^Comando de credencial decisão 0020 Grave em connection\.credential , troque os dois caminhos pelos da Workstation e clique em Tentar agora\./);
    const example = texto(setup.querySelector('pre'));
    for (const piece of ['"credential": {', '"/usr/bin/ssh", "-T", "-o", "BatchMode=yes"', '"ahrena-tunnel"', '"/caminho/para/node", "/caminho/para/ahrena-console/packages/nucleo/src/owner/cli.ts"', '"remote-credential", "--port", "4720"]', '"timeoutSeconds": 20 }']) {
      assert.ok(example.includes(piece), piece);
    }
    assert.match(texto(setup), /Lista, sem shell: só roda o que está no arquivo\./);
    assert.match(texto(setup), /Nenhum segredo no comando: a credencial volta pela saída do ssh e não vai para log nem para a tela\./);
    assert.match(texto(setup), /O token deste Mac nunca vai para lá\./);
    assert.deepEqual(buttons(setup), ['Copiar o exemplo']);
    const copied: string[] = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
    setup.querySelector('button')!.click();
    await until(() => copied.length === 1);
    assert.ok(copied[0]!.startsWith('"credential": {'), 'the JSON, without the file note');
    assert.ok(copied[0]!.includes('"/caminho/para/node"'));
    band.querySelector('button')!.click();
    await until(() => retried === 1);
  });

  test('AC1 · 388-2: owner-auth-failed is the red band with the three likeliest causes and Tentar agora', () => {
    const c = screen.conditionParts(machineOf('owner-auth-failed'), null, { retry: () => {} });
    assert.equal(c.faded, true);
    const band = wrap(c.parts).querySelector('[data-part="owner-auth"]')!;
    assert.ok(band.classList.contains('tm-rc-error'));
    assert.equal(band.getAttribute('role'), 'alert');
    assert.match(texto(band), /^A Workstation recusou o acesso: a prova do dono falhou\. O comando de credencial rodou e não trouxe uma prova que o núcleo de lá aceite\./);
    assert.deepEqual(band.querySelectorAll('li').map((li) => texto(li)), [
      'O núcleo de lá é antigo , de antes da credencial remota. Atualize e reinicie o núcleo na Workstation.',
      'O SSH não entrou : a chave foi recusada, o host mudou ou a sessão pediu login.',
      'O núcleo de lá reiniciou e recusou a renovação de novo, ou a porta 14720 leva a outro núcleo.',
    ]);
    assert.match(texto(band), /Tentamos de novo sozinhos em 30 s, 1 min e depois a cada 5 min\./);
    assert.match(texto(band), /do comando de credencial · o código de saída fica no nucleo\.log deste Mac, nunca na tela/);
    assert.deepEqual(buttons(band), ['Tentar agora']);
    assert.equal(wrap(c.parts).querySelector('[data-part="owner-auth-setup"]'), null);
  });

  test('AC4 · 388-3: owner-auth-mismatch shows the two steps, a secondary Tentar agora and no button that accepts the new identity', () => {
    const c = screen.conditionParts(machineOf('owner-auth-mismatch'), null, { retry: () => {} });
    assert.equal(c.faded, true);
    const band = wrap(c.parts).querySelector('[data-part="owner-auth"]')!;
    assert.ok(band.classList.contains('tm-rc-error'));
    assert.match(texto(band), /^Esta não parece ser a mesma Workstation\. Quem respondeu agora tem outra identidade de máquina, ou outro usuário,/);
    assert.match(texto(band), /Por segurança, este Mac parou de mandar pedidos assinados para lá\./);
    assert.deepEqual(band.querySelectorAll('li').map((li) => texto(li)), [
      'Confira se o túnel leva à máquina certa : o host ahrena-tunnel no ~/.ssh/config deste Mac e a porta 14720.',
      'Trocou de máquina ou de usuário de propósito? Reinicie o núcleo deste Mac: a identidade fica guardada só enquanto ele roda, e a próxima prova vira a nova referência.',
    ]);
    assert.match(texto(band), /da prova de agora, comparada com a primeira/);
    assert.deepEqual(buttons(wrap(c.parts)), ['Tentar agora'], 'nothing accepts the other identity');
    assert.ok(band.querySelector('button')!.classList.contains('outline'), 'Tentar agora is secondary');
  });

  test('AC1 · 388-1 to 388-3: the icons of the owner-proof bands exist in dom.js', () => {
    for (const name of ['lock', 'key-round', 'shield-alert', 'copy', 'refresh']) assert.ok(ICON_NAMES.includes(name), name);
  });
});

// ---------- the screen with its connection ----------

describe('#388 the Workstation screen when its core refuses the proof', () => {
  const CORE = {
    'owner-auth-required': ['Núcleo de lá Acesso bloqueado falta a prova do dono', 'Acesso bloqueado'],
    'owner-auth-failed': ['Núcleo de lá Prova falhou o comando de credencial não trouxe prova', 'Prova do dono falhou'],
    'owner-auth-mismatch': ['Núcleo de lá Outra identidade não é a máquina da primeira prova', 'Identidade diferente'],
  } as const;

  for (const reason of OWNER_AUTH) {
    test(`AC1 · ${reason === 'owner-auth-required' ? '388-1' : reason === 'owner-auth-failed' ? '388-2' : '388-3'}: ${reason} fades the last reading, keeps Conexão live and says the reason in the core tile`, async () => {
      setRemote('unreachable', reason);
      connection = refused();
      const m = mount();
      await m.ready;
      const band = part(m.area, 'owner-auth');
      assert.ok(band, 'the owner-proof band');
      assert.equal(band.getAttribute('data-reason'), reason);
      assert.equal(part(m.area, 'connection-band'), null, 'not the tunnel-down band');
      assert.equal(cell(m.area, 'core'), CORE[reason][0]);
      assert.match(cell(m.area, 'tunnel'), /^Túnel No ar/, 'the tunnel is up: the port answers');
      assert.equal(pill(m.area), CORE[reason][1]);
      assert.ok(m.area.querySelector('.tm-faded'), 'the last reading fades');
      assert.ok(m.area.querySelector('[data-band="connection"]')!.parentNode === m.area, 'Conexão is not faded');
      const cmds = part(m.area, 'connection')!.querySelectorAll('.mc-cmds span').map((s) => texto(s));
      if (reason === 'owner-auth-required') assert.ok(cmds.includes('prova do dono: sem connection.credential no machines.json'), cmds.join(' | '));
      else assert.ok(!cmds.some((t) => t.startsWith('prova do dono: sem')), 'configured: never "sem connection.credential"');
    });
  }

  test('AC2 · 388-4: the way back: connected again, the band goes, nothing fades and the core tile answers', async () => {
    setRemote('unreachable', 'owner-auth-required');
    connection = refused();
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'owner-auth'));
    setRemote('connected');
    connection = connOf();
    const again = mount();
    await again.ready;
    assert.equal(part(again.area, 'owner-auth'), null);
    assert.equal(part(again.area, 'owner-auth-setup'), null);
    assert.equal(again.area.querySelector('.tm-faded'), null);
    assert.match(cell(again.area, 'core'), /^Núcleo de lá Respondendo/);
    assert.equal(pill(again.area), 'Conectada');
    assert.equal(screen.conditionParts(format.normalizeMachine({ id: WS.id, label: WS.label, state: 'connected' }), null).parts.length, 0);
  });

  test('AC3 · 388-1 to 388-3: no credential, key or command output reaches the screen', async () => {
    for (const reason of OWNER_AUTH) {
      setRemote('unreachable', reason);
      connection = refused({ lastError: { reason: SENTINEL, at: iso(M), exitCode: 1, holder: SENTINEL }, credential: { command: ['/usr/bin/ssh', SENTINEL] }, output: SENTINEL });
      extra = { credential: SENTINEL, token: SENTINEL, detail: SENTINEL, stderr: SENTINEL };
      const m = mount();
      await m.ready;
      assert.ok(part(m.area, 'owner-auth'), reason);
      assert.ok(!everything(m.area).includes(SENTINEL), `${reason}: the sentinel is on the screen`);
      m.leave();
    }
  });
});

// ---------- the sidebar ----------

describe('#388 the sidebar dot', () => {
  test('388-4: one waiting dot for the three owner-proof reasons, with the reason as its label; the tunnel down keeps the grey dot', async () => {
    const list = [
      { id: 'ws-a', label: 'A', state: 'unreachable', reason: 'owner-auth-required' },
      { id: 'ws-b', label: 'B', state: 'unreachable', reason: 'owner-auth-failed' },
      { id: 'ws-c', label: 'C', state: 'unreachable', reason: 'owner-auth-mismatch' },
      { id: 'ws-d', label: 'D', state: 'unreachable', reason: 'port-closed' },
      { id: 'ws-e', label: 'E', state: 'connected', reason: null },
    ];
    assert.deepEqual(machineItems(list).map((i: Obj) => i.state), ['owner-auth', 'owner-auth', 'owner-auth', 'unreachable', 'connected']);
    const nav = new ElementoFalso('nav');
    const { readMachines } = createNav({ nav, read: async () => list, screens: SCREENS });
    await readMachines();
    const dot = (id: string) => nav.querySelector(`[data-screen="machine-${id}"] .cc-nav-dot`)!;
    const labels = ['ws-a', 'ws-b', 'ws-c', 'ws-d', 'ws-e'].map((id) => [dot(id).getAttribute('data-state'), dot(id).getAttribute('aria-label'), dot(id).getAttribute('title')]);
    assert.deepEqual(labels, [
      ['owner-auth', 'Acesso bloqueado', 'Acesso bloqueado'],
      ['owner-auth', 'Prova do dono falhou', 'Prova do dono falhou'],
      ['owner-auth', 'Identidade diferente', 'Identidade diferente'],
      ['unreachable', 'Sem conexão', 'Sem conexão'],
      ['connected', 'Conectada', 'Conectada'],
    ]);
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    assert.match(css, /\.cc-nav-dot\[data-state="owner-auth"\] \{ background: var\(--status-waiting-dot\); \}/);
  });

  test('388-4: a connection stopped by you stays its own grey state, whatever the reason', () => {
    const items = machineItems([{ id: 'ws-a', state: 'unreachable', reason: 'owner-auth-failed', connection: { state: 'stopped' } }]);
    assert.equal(items[0].state, 'stopped');
  });
});
