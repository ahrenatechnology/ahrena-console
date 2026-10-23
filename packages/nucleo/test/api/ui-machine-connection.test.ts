// The remote machine's connection on /ui (issue 278, decision 0013, wireframes C62 to C65): the pure parts of
// machine-connection-format.js, and the machine screen mounted on the fake DOM with the simulator's
// telemetry and a fake `connection` (and `placement`) per test, shaped like GET /api/machines and
// GET /api/telemetry. No network, no machines.json, no process runs: the writes are recorded and answered here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
import * as f from '../../ui/screens/machine-connection-format.js';
// @ts-expect-error: idem
import { machineItems } from '../../ui/screens.js';
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
const LOG = '/Users/exemplo/.ahrena-console/reconnect.log';
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;
const M = 60_000;

type Obj = Record<string, unknown>;
const PORTS = [
  { localPort: 14720, remoteHost: 'localhost', remotePort: 4720, state: 'up', heldBy: null },
  { localPort: 13000, remoteHost: 'localhost', remotePort: 3000, state: 'up', heldBy: null },
  { localPort: 15173, remoteHost: 'localhost', remotePort: 5173, state: 'idle', heldBy: null },
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
  logFile: LOG,
  ...over,
});
const down = (over: Obj = {}): Obj =>
  connOf({ state: 'down', since: iso(5 * H), ports: [], actions: { start: true, stop: false, reconnect: true, loginAndStart: false }, ...over });
const expired = { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'expired', expiresAt: iso(5 * H) };
const PLACEMENT = { provider: 'aws', kind: 'managed-instance', region: 'regiao-exemplo-1', zone: null, instanceId: 'mi-0exemplo000000', source: 'ssm-registration', readAt: iso(60_000) };

// ---------- the simulator's telemetry behind the core's service, and the fake connection ----------

let storage: SqliteStorage;
let service: TelemetryService;
let remote: MachineStatus;
let connection: Obj | null | undefined;
let placement: Obj | null | undefined;
let reconnect: Obj | null;
let connectors: Obj;

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
  placement = PLACEMENT;
  reconnect = { configured: true, command: START, timeoutSeconds: 180, state: 'idle', startedAt: null, endedAt: null, exitCode: null, startedBy: null, logFile: LOG };
  connectors = { connectors: [{ kind: 'aws', state: 'expired', cli: { found: true, version: 2, deviceCodeSupported: true }, configFile: { status: 'ok' }, sessions: [], outOfScope: [] }] };
});

const setRemote = (state: MachineState, reason: UnreachableReason | null = null) => (remote = { state, reason, version: TELEMETRY_VERSION });

async function coreRead(route: string): Promise<unknown> {
  const url = new URL(route, 'http://127.0.0.1');
  let body: unknown;
  if (url.pathname === '/api/machines') {
    const list = (await service.machines()) as unknown as Obj[];
    body = list.map((m) => (m.id === WS.id ? { ...m, reconnect, ...(connection === undefined ? {} : { connection }) } : { ...m, reconnect: null }));
  } else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
  else if (url.pathname === '/api/telemetry') {
    const machine = url.searchParams.get('machine') ?? 'local';
    const t = JSON.parse(JSON.stringify(await service.telemetry(machine, Number(url.searchParams.get('hours') ?? 1) as 1 | 12)));
    if (machine === WS.id && t.current && placement !== undefined) t.current.placement = placement;
    body = t;
  } else if (url.pathname === '/api/connectors') body = connectors;
  else if (url.pathname.startsWith('/api/machines/') && url.pathname.endsWith('/connectors')) body = { machine: WS.id, status: 'ok', connectors: [] };
  else throw new Error(`unexpected route ${route}`);
  return JSON.parse(JSON.stringify(body));
}

interface Write {
  route: string;
  body: unknown;
  options: { method?: string } | undefined;
}
type Answer = (w: Write) => Promise<unknown>;

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  writes: Write[];
  navigated: string[];
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

const echo: Answer = async () => ({ connection });

function mount(answer: Answer = echo): Mounted {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: Write[] = [];
  const navigated: string[] = [];
  const signal = new AbortController();
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: { id: WS.id },
    signal: signal.signal,
    read: (route: string) => (reads.push(route), coreRead(route)),
    write: (route: string, body: unknown, options?: { method?: string }) => {
      const w = { route, body, options };
      writes.push(w);
      return answer(w);
    },
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (r: string) => navigated.push(r),
  };
  const ready = screen.mount(area, ctx).then((fn: () => void) => (cleanup = fn));
  const m: Mounted = { area, reads, writes, navigated, ready, leave: () => (signal.abort(), cleanup?.()) };
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
const band = (area: ElementoFalso) => part(area, 'connection-band');
const buttons = (node: ElementoFalso | null) => (node ? node.querySelectorAll('button').map((b) => texto(b)) : []);
const button = (area: ElementoFalso, action: string) => area.querySelector(`[data-mc-action="${action}"]`)!;
const pill = (area: ElementoFalso) => texto(area.querySelector('.cc-head .badge'));
const cell = (area: ElementoFalso, key: string) => texto(area.querySelector(`[data-cell="${key}"]`));
const sub = (area: ElementoFalso) => texto(area.querySelector('.cc-head .sub'));

// ---------- the pure parts ----------

describe('#278 machine-connection-format: the connection of GET /api/machines', () => {
  test('normalizeConnection keeps the contract shape and drops what it does not know', () => {
    assert.equal(f.normalizeConnection(undefined), null);
    assert.equal(f.normalizeConnection({ state: 'exploded' }), null);
    const c = f.normalizeConnection({ ...connOf({ lastError: { reason: 'exit-code', at: iso(0), exitCode: 255, holder: null, output: 'SEGREDO' } }), output: 'SEGREDO' });
    assert.equal(JSON.stringify(c).includes('SEGREDO'), false);
    assert.deepEqual(c.command, { start: START, stop: STOP, startTimeoutSeconds: 180, stopTimeoutSeconds: 180 });
    assert.equal(c.ports.length, 3);
    assert.equal(f.normalizeConnection(connOf({ lastError: { reason: 'made-up' } })).lastError, null);
    assert.equal(f.normalizeConnection(connOf({ cloud: { connector: 'gcp', profile: 'x' } })).cloud, null);
    assert.equal(f.normalizePlacement(null), null);
    assert.deepEqual(f.normalizePlacement({ provider: 'mars', source: 'guess' }), { provider: 'unknown', kind: null, region: null, zone: null, instanceId: null, source: null, readAt: null });
  });

  test('the routes take only a valid id and a known action', () => {
    assert.equal(f.actionRoute('ws-exemplo', 'login-and-start'), '/api/machines/ws-exemplo/connection/login-and-start');
    assert.equal(f.actionRoute('ws-exemplo', 'rm'), null);
    assert.equal(f.actionRoute('../x', 'start'), null);
    assert.equal(f.actionRoute('local', 'start'), null);
    assert.equal(f.cancelRoute('ws-exemplo'), '/api/machines/ws-exemplo/connection');
    assert.equal(f.cancelRoute('A B'), null);
  });

  test('the mode: full with a stop or a cloud profile, start-only with only the start, none without a command', () => {
    assert.equal(f.connectionMode(null), null);
    assert.equal(f.connectionMode(f.normalizeConnection(connOf())), 'full');
    assert.equal(f.connectionMode(f.normalizeConnection(connOf({ command: { start: START, stop: null, startTimeoutSeconds: 180, stopTimeoutSeconds: null } }))), 'full', 'the cloud profile is enough');
    assert.equal(f.connectionMode(f.normalizeConnection(connOf({ cloud: null, command: { start: START, stop: null, startTimeoutSeconds: 180, stopTimeoutSeconds: null } }))), 'start-only');
    assert.equal(f.connectionMode(f.normalizeConnection(connOf({ configured: false, command: null, cloud: null }))), 'none');
  });

  test('the pill of each state', () => {
    const p = (over: Obj) => f.connectionPill(f.normalizeConnection(connOf(over)));
    assert.deepEqual(p({}), ['b-completed', 'Conectada']);
    assert.deepEqual(p({ state: 'down' }), ['b-error', 'Sem conexão']);
    assert.deepEqual(p({ state: 'failing' }), ['b-error', 'Sem conexão']);
    assert.deepEqual(p({ state: 'stopped' }), ['b-abandoned', 'Parada por você']);
    const job = (kind: string, step: string) => ({ kind, steps: ['login', 'start', 'read'], step, state: 'running', startedAt: iso(1000), stepStartedAt: iso(1000) });
    assert.deepEqual(p({ state: 'starting', job: job('login-and-start', 'login') }), ['b-waiting', 'Entrando na AWS']);
    assert.deepEqual(p({ state: 'starting', job: job('login-and-start', 'start') }), ['b-waiting', 'Subindo o túnel']);
    assert.deepEqual(p({ state: 'stopping', job: { ...job('stop', 'stop'), steps: ['stop', 'read'] } }), ['b-waiting', 'Parando o túnel']);
  });

  test('the header gains the provider and the region before the port', () => {
    const pl = f.normalizePlacement(PLACEMENT);
    assert.equal(f.headerWithPlacement('ws-exemplo · Ubuntu 24.04 · 16 vCPUs · porta 14720 do Mac · lido há 6 s', pl), 'ws-exemplo · Ubuntu 24.04 · 16 vCPUs · AWS · regiao-exemplo-1 · porta 14720 do Mac · lido há 6 s');
    assert.equal(f.headerWithPlacement('ws-exemplo · lido há 6 s', pl), 'ws-exemplo · AWS · regiao-exemplo-1 · lido há 6 s');
    assert.equal(f.headerWithPlacement('ws-exemplo · lido há 6 s', f.normalizePlacement({ provider: 'unknown' })), 'ws-exemplo · lido há 6 s');
    assert.equal(f.headerWithPlacement('ws-exemplo', null), 'ws-exemplo');
  });

  test('the trio: up, down with the session expired, stopped, and the login step', () => {
    const machine = { id: WS.id, label: WS.label, port: WS.port, state: 'connected', reason: null };
    const reading = { takenAt: iso(6000) };
    const t = (over: Obj, m: Obj = machine) => f.connectionTrio(f.normalizeConnection(connOf(over)), m, reading, NOW).map((c: Obj) => [c.label, c.tone, c.value, c.sub]);
    const up = t({});
    assert.deepEqual(up[0], ['Túnel', 'ok', 'No ar', 'há 3 h 12 min · 3 portas']);
    assert.deepEqual([up[1]![0], up[1]![1], up[1]![3]], ['Sessão AWS', 'ok', 'perfil-dev · faltam 7 h']);
    assert.match(up[1]![2] as string, /^Válida até (amanhã )?\d\d:\d\d$/);
    assert.deepEqual(up[2], ['Núcleo de lá', 'ok', 'Respondendo', 'lido há 6 s']);
    const off = { ...machine, state: 'unreachable', reason: 'port-closed' };
    const d = t({ state: 'down', since: iso(5 * H), ports: [], cloud: expired }, off);
    assert.deepEqual(d[0]!.slice(0, 3), ['Túnel', 'bad', 'Fora']);
    assert.match(d[0]![3] as string, /^desde \d\d:\d\d · nenhum processo ssh$/);
    assert.deepEqual(d[1]!.slice(0, 3), ['Sessão AWS', 'bad', 'Expirada há 5 h']);
    assert.match(d[1]![3] as string, /^perfil-dev · expirou às \d\d:\d\d$/);
    assert.deepEqual(d[2]!.slice(0, 3), ['Núcleo de lá', 'off', 'Sem leitura']);
    assert.deepEqual(t({ state: 'stopped', since: iso(M) }, off)[0]!.slice(0, 3), ['Túnel', 'off', 'Parado por você']);
    const login = t({ state: 'starting', job: { kind: 'login-and-start', steps: ['login', 'start', 'read'], step: 'login', state: 'running', startedAt: iso(48_000), stepStartedAt: iso(48_000) } }, off);
    assert.deepEqual(login.map((c) => c[2]), ['Esperando', 'Entrando…', 'Sem leitura']);
    assert.deepEqual(t({ cloud: null })[1]!.slice(0, 3), ['Sessão de nuvem', 'off', 'Nenhuma']);
    assert.deepEqual(t({ cloud: { ...expired, state: 'expiring', expiresAt: new Date(NOW + 14 * M + 30_000).toISOString() } })[1]!.slice(0, 4), ['Sessão AWS', 'warn', 'Expira em 15 min', 'perfil-dev · o túnel cai junto']);
  });

  test('each reason in plain words, with where it came from and the right actions', () => {
    const machine = { id: WS.id, label: WS.label, port: WS.port, state: 'unreachable', reason: 'port-closed' };
    const r = (lastError: Obj, over: Obj = {}) => f.reasonBand(f.normalizeConnection(down({ lastError: { at: iso(0), exitCode: null, holder: null, ...lastError }, ...over })), machine, { takenAt: iso(5 * H - M) }, NOW);
    const sso = r({ reason: 'sso-expired' }, { cloud: expired });
    assert.equal(sso.title, 'Túnel fora · SSO expirado há 5 h.');
    assert.match(sso.text, /^A sessão sessao-exemplo, que o perfil-dev usa, expirou às \d\d:\d\d, e o túnel caiu às \d\d:\d\d\. Entre na AWS e o console sobe o túnel em seguida\.$/);
    assert.equal(sso.command, 'Roda: aws sso login --sso-session sessao-exemplo, depois /caminho/para/conectar.sh tunnel start');
    assert.equal(sso.from, 'do estado do perfil-dev no conector AWS');
    assert.deepEqual(sso.actions, ['only-login', 'login-and-start']);
    const busy = r({ reason: 'port-busy', holder: 'node' });
    assert.deepEqual([busy.title, busy.text, busy.from, busy.actions], ['Porta 14720 ocupada no Mac.', 'O node deste Mac segura a porta que o túnel usa; o encaminhamento não sobe.', 'da sonda da porta', ['see-local', 'start']]);
    assert.equal(r({ reason: 'port-busy', exitCode: 255 }).from, 'de um padrão conhecido no log desta execução');
    const ssm = r({ reason: 'ssm-agent-offline', exitCode: 255 });
    assert.equal(ssm.title, 'Agente SSM da Workstation offline.');
    assert.equal(ssm.from, 'de um padrão conhecido no log desta execução (alvo não conectado)');
    assert.equal(r({ reason: 'host-unknown', exitCode: 255 }).title, 'Host desconhecido no ~/.ssh/config.');
    assert.equal(r({ reason: 'key-refused', exitCode: 255 }).text, 'A Workstation recusou a chave deste Mac.');
    const code = r({ reason: 'exit-code', exitCode: 255 });
    assert.equal(code.title, 'O comando saiu com o código 255.');
    assert.equal(code.text, `Nenhum motivo conhecido apareceu. A saída ficou no log da instalação: ${LOG}`);
    assert.equal(code.from, 'nenhum padrão reconheceu a saída');
    assert.equal(r({ reason: 'exit-code' }, { job: { kind: 'start', steps: ['start', 'read'], step: 'start', state: 'timed-out', startedAt: iso(M), endedAt: iso(0) } }).title, 'O comando passou de 3 min e foi encerrado.');
    const core = r({ reason: 'core-not-answering' });
    assert.deepEqual([core.tone, core.title, core.actions], ['waiting', 'Túnel no ar, núcleo de lá parado.', ['retry']]);
    assert.equal(f.reasonBand(f.normalizeConnection(down()), machine, null, NOW), null);
  });

  test('the job: its steps, the step clock and what runs', () => {
    const job = { kind: 'login-and-start', steps: ['login', 'start', 'read'], step: 'start', state: 'running', startedAt: iso(70_000), stepStartedAt: iso(16_000), stepTimeoutSeconds: 180 };
    const c = f.normalizeConnection(connOf({ state: 'starting', job, cloud: { ...expired, state: 'valid', expiresAt: new Date(NOW + 8 * H).toISOString() } }));
    assert.deepEqual(f.jobSteps(c.job, 'Workstation'), [{ label: 'entrando na AWS', at: 'done' }, { label: 'subindo o túnel', at: 'on' }, { label: 'lendo a Workstation', at: 'next' }]);
    assert.deepEqual(f.stepClock(c.job, NOW), { elapsed: '0:16', limit: '3:00', seconds: 16, max: 180 });
    const b = f.jobBand(c, 'Workstation', NOW);
    assert.equal(b.title, 'Subindo o túnel…');
    assert.match(b.text, /^a sessão AWS vale até .+; agora roda o comando de subir\.$/);
    assert.equal(b.command, 'Roda: /caminho/para/conectar.sh tunnel start · até 3 min');
    const l = f.jobBand(f.normalizeConnection(connOf({ state: 'starting', job: { ...job, step: 'login', stepTimeoutSeconds: 300 } })), 'Workstation', NOW);
    assert.deepEqual(l, { title: 'Entrando na AWS…', text: 'aguardando o login no navegador. Quando terminar, o console sobe o túnel sozinho.', command: 'Roda: aws sso login --sso-session sessao-exemplo · até 5 min' });
  });

  test('Onde roda: known, unknown, an older core over there, no reading', () => {
    const k = f.placementView(f.normalizePlacement(PLACEMENT));
    assert.deepEqual(k.fields.map((x: Obj) => x.value), ['AWS', 'Instância gerenciada (SSM)', 'regiao-exemplo-1', 'mi-0exemplo000000']);
    assert.match(k.source, /^Fonte: registro do agente SSM \(sem metadados de instância nesta máquina\) · lido às \d\d:\d\d$/);
    assert.match(f.placementView(f.normalizePlacement(PLACEMENT), { stale: true }).source, /· da última leitura, às \d\d:\d\d$/);
    const u = f.placementView(f.normalizePlacement({ provider: 'unknown', source: null }));
    assert.deepEqual(u.fields.map((x: Obj) => x.value), ['desconhecido', 'desconhecido', 'desconhecida', '—']);
    assert.equal(u.source, 'Nem metadados de instância, nem registro do agente SSM, nem DMI: não chutamos.');
    assert.equal(f.placementView(null).source, 'O núcleo de lá não diz onde roda: é de uma versão anterior.');
    assert.equal(f.placementView(null, { hasReading: false }).source, 'Ainda não há leitura de lá.');
  });

  test('the setup example and a refusal in pt-BR', () => {
    const ex = f.connectionExample(WS);
    assert.match(ex, /"connection": \{/);
    assert.match(ex, /"cloudProfile": \{ "connector": "aws", "profile": "perfil-dev" \}/);
    assert.equal(f.writeProblem({ status: 409, body: { error: 'outra ação da conexão está em andamento nesta máquina', reason: 'busy' } }, 'start'), 'Não deu para subir o túnel: outra ação da conexão está em andamento nesta máquina.');
    assert.equal(f.writeProblem({ status: 0 }, 'stop'), 'Não deu para parar o túnel: o núcleo não respondeu.');
  });

  test('the sidebar: a connection stopped by you is its own state, with its words', async () => {
    const items = machineItems([{ id: WS.id, label: WS.label, state: 'unreachable', connection: { state: 'stopped' } }, { id: 'outra', state: 'unreachable', connection: { state: 'down' } }]);
    assert.deepEqual(items.map((i: Obj) => i.state), ['stopped', 'unreachable']);
    // @ts-expect-error: browser module
    const { MACHINE_STATE_LABELS } = await import('../../ui/nav.js');
    assert.equal(MACHINE_STATE_LABELS.stopped, 'Parada por você');
  });
});

// ---------- the screen ----------

describe('#278 the Workstation screen with its connection (C62 to C65)', () => {
  test('an older core without `connection`: the screen as it was, no connection part', async () => {
    connection = undefined;
    placement = undefined;
    const m = mount();
    await m.ready;
    assert.equal(part(m.area, 'connection'), null);
    assert.equal(part(m.area, 'placement'), null);
    assert.equal(pill(m.area), 'Conectada');
    assert.doesNotMatch(sub(m.area), /AWS/);
  });

  test('C62 up: the trio, the ports, what runs, Reconectar and Parar, and Onde roda; the header has AWS and the region', async () => {
    const m = mount();
    await m.ready;
    const card = part(m.area, 'connection')!;
    assert.match(texto(card.querySelector('h2')), /^Conexão\s*túnel SSH sobre AWS SSM/);
    assert.deepEqual(buttons(card.querySelector('.mc-act')), ['Reconectar', 'Parar o túnel']);
    assert.equal(cell(m.area, 'tunnel'), 'Túnel No ar há 3 h 12 min · 3 portas');
    assert.match(cell(m.area, 'core'), /^Núcleo de lá Respondendo lido /);
    assert.deepEqual(card.querySelectorAll('tbody tr').map((r) => r.getAttribute('data-port')), ['14720', '13000', '15173']);
    assert.match(texto(card.querySelector('tbody tr')), /14720.*4720.*Respondendo.*Núcleo da Workstation/);
    assert.deepEqual(card.querySelectorAll('.mc-cmds span').map((s) => texto(s)), ['subir: /caminho/para/conectar.sh tunnel start', 'parar: /caminho/para/conectar.sh tunnel stop', 'nuvem: aws · perfil-dev (sessao-exemplo)']);
    const place = part(m.area, 'placement')!;
    assert.match(texto(place), /Instância gerenciada \(SSM\).*regiao-exemplo-1.*mi-0exemplo000000/);
    assert.equal(band(m.area), null);
    assert.equal(pill(m.area), 'Conectada');
    assert.match(sub(m.area), / · AWS · regiao-exemplo-1 · porta 14720 do Mac · lido /);
    assert.equal(m.area.querySelector('.tm-faded'), null);
    assert.ok(globalThis.document.head.querySelector('link[data-screen="machine-connection"]'));
  });

  test('C63 down with SSO expired: the red band, "Entrar na AWS e subir o túnel" POSTs only the id, "Só entrar" logs in this Mac in browser mode', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ cloud: expired, lastError: { reason: 'sso-expired', at: iso(5 * H), exitCode: null, holder: null }, actions: { start: true, stop: false, reconnect: true, loginAndStart: true } });
    const m = mount(async (w) => (w.route.startsWith('/api/connectors') ? { login: { state: 'running', mode: 'browser', startedAt: new Date().toISOString(), timeoutSeconds: 300 } } : { connection }));
    await m.ready;
    const b = band(m.area)!;
    assert.ok(b.classList.contains('error-band'));
    assert.match(texto(b), /^Túnel fora · SSO expirado há 5 h\. A sessão sessao-exemplo, que o perfil-dev usa, expirou às/);
    assert.deepEqual(buttons(b), ['Só entrar', 'Entrar na AWS e subir o túnel']);
    assert.ok(button(m.area, 'login-and-start').classList.contains('filled'));
    assert.equal(pill(m.area), 'Sem conexão');
    assert.ok(m.area.querySelector('.tm-faded'), 'the rest of the reading fades');
    assert.match(texto(part(m.area, 'placement')), /da última leitura, às/);
    button(m.area, 'login-and-start').click();
    await until(() => m.writes.length === 1);
    assert.deepEqual(m.writes[0], { route: '/api/machines/ws-exemplo/connection/login-and-start', body: {}, options: undefined });
    await until(() => !button(m.area, 'login-and-start').hasAttribute('disabled'));
    button(m.area, 'only-login').click();
    await until(() => m.writes.length === 2);
    assert.deepEqual(m.writes[1], { route: '/api/connectors/aws/sessions/sessao-exemplo/login', body: { mode: 'browser' }, options: undefined });
    await until(() => texto(band(m.area)).startsWith('Entrando na AWS…'));
    assert.match(texto(band(m.area)), /Só o login: o túnel fica como está\./);
    button(m.area, 'only-login-cancel').click();
    await until(() => m.writes.length === 3);
    assert.deepEqual(m.writes[2], { route: '/api/connectors/aws/sessions/sessao-exemplo/login', body: null, options: { method: 'DELETE' } });
  });

  test('C64 1: the login-and-start job: steps, the time against the limit (ticking), Cancelar DELETEs', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ state: 'starting', cloud: expired, job: { kind: 'login-and-start', steps: ['login', 'start', 'read'], step: 'login', state: 'running', startedAt: iso(48_000), endedAt: null, stepStartedAt: iso(48_000), stepTimeoutSeconds: 300, startedBy: 'ui' } });
    const m = mount();
    await m.ready;
    const b = band(m.area)!;
    assert.match(texto(b), /^Entrando na AWS… aguardando o login no navegador\. Quando terminar, o console sobe o túnel sozinho\./);
    assert.deepEqual(b.querySelectorAll('.tm-rc-steps li').map((li) => texto(li)), ['entrando na AWS', 'subindo o túnel', 'lendo a Workstation']);
    assert.ok(b.querySelectorAll('.tm-rc-steps li')[0]!.classList.contains('tm-rc-on'));
    const first = texto(b.querySelector('[data-mc-elapsed]'));
    assert.match(first, /^0:4\d de 5:00$/);
    await until(() => texto(m.area.querySelector('[data-mc-elapsed]')) !== first, 2500);
    assert.equal(texto(b.querySelector('.tm-rc-cmd')), 'Roda: aws sso login --sso-session sessao-exemplo · até 5 min');
    assert.equal(pill(m.area), 'Entrando na AWS');
    assert.deepEqual(buttons(b), ['Cancelar']);
    button(m.area, 'cancel').click();
    await until(() => m.writes.length === 1);
    assert.deepEqual(m.writes[0], { route: '/api/machines/ws-exemplo/connection', body: null, options: { method: 'DELETE' } });
  });

  test('C64 2: starting the tunnel', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ state: 'starting', job: { kind: 'login-and-start', steps: ['login', 'start', 'read'], step: 'start', state: 'running', startedAt: iso(70_000), endedAt: null, stepStartedAt: iso(16_000), stepTimeoutSeconds: 180, startedBy: 'ui' } });
    const m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^Subindo o túnel… a sessão AWS vale até .+; agora roda o comando de subir\./);
    assert.equal(cell(m.area, 'tunnel'), 'Túnel Subindo rodando o comando de subir');
    assert.equal(pill(m.area), 'Subindo o túnel');
  });

  test('C64 3: Parar asks first; Cancelar closes without a write, Escape too; confirming POSTs stop', async () => {
    const m = mount();
    await m.ready;
    button(m.area, 'stop-ask').click();
    await until(() => part(m.area, 'stop-dialog') !== null);
    const d = part(m.area, 'stop-dialog')!;
    assert.equal(d.getAttribute('role'), 'dialog');
    assert.equal(texto(d.querySelector('h2')), 'Parar o túnel da Workstation?');
    assert.match(texto(d), /As 3 portas param de encaminhar para este Mac\. As sessões do Claude lá continuam rodando/);
    assert.match(texto(d), /Roda: \/caminho\/para\/conectar\.sh tunnel stop · até 3 min/);
    assert.ok(m.area.querySelector('.tm-faded'), 'the cards fade behind the question');
    button(m.area, 'dialog-cancel').click();
    await until(() => part(m.area, 'stop-dialog') === null);
    assert.equal(m.writes.length, 0);
    button(m.area, 'stop-ask').click();
    await until(() => part(m.area, 'stop-dialog') !== null);
    part(m.area, 'stop-dialog')!.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await until(() => part(m.area, 'stop-dialog') === null);
    button(m.area, 'stop-ask').click();
    await until(() => part(m.area, 'stop-dialog') !== null);
    assert.ok(button(m.area, 'stop').classList.contains('mc-danger'));
    button(m.area, 'stop').click();
    await until(() => m.writes.length === 1);
    assert.deepEqual(m.writes[0], { route: '/api/machines/ws-exemplo/connection/stop', body: {}, options: undefined });
  });

  test('C64 4: stopped by you: the neutral band, the grey pill, Subir o túnel in the card', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ state: 'stopped', since: iso(10 * M) });
    const m = mount();
    await m.ready;
    const b = band(m.area)!;
    assert.equal(b.getAttribute('data-tone'), 'neutral');
    assert.match(texto(b), /^Túnel parado por você às \d\d:\d\d\. A Workstation não some/);
    assert.equal(pill(m.area), 'Parada por você');
    assert.deepEqual(buttons(part(m.area, 'connection')!.querySelector('.mc-act')), ['Subir o túnel']);
    button(m.area, 'start').click();
    await until(() => m.writes.length === 1);
    assert.equal(m.writes[0]!.route, '/api/machines/ws-exemplo/connection/start');
  });

  test('C65: the 15-minute warning with "Entrar na AWS"', async () => {
    connection = connOf({ cloud: { ...expired, state: 'expiring', expiresAt: new Date(NOW + 14 * M + 30_000).toISOString() } });
    const m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^A sessão AWS expira em 1\d min\. O túnel da Workstation cai junto\. Entre agora e ele continua no ar\. do estado do perfil-dev no conector AWS/);
    assert.deepEqual(buttons(band(m.area)), ['Entrar na AWS']);
  });

  test('C65: port busy, with "Ver em Esta máquina"; the SSM agent offline; the exit code with the log path', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ state: 'failing', lastError: { reason: 'port-busy', at: iso(0), exitCode: null, holder: 'node' } });
    let m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^Porta 14720 ocupada no Mac\. O node deste Mac segura a porta que o túnel usa; o encaminhamento não sobe\. da sonda da porta/);
    assert.deepEqual(buttons(band(m.area)), ['Ver em Esta máquina', 'Tentar de novo']);
    button(m.area, 'see-local').click();
    assert.deepEqual(m.navigated, ['/ui/machines/local']);
    m.leave();
    connection = down({ state: 'failing', lastError: { reason: 'ssm-agent-offline', at: iso(0), exitCode: 255, holder: null } });
    m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^Agente SSM da Workstation offline\./);
    assert.match(texto(band(m.area)), /alvo não conectado/);
    assert.deepEqual(buttons(band(m.area)), ['Tentar de novo']);
    m.leave();
    connection = down({ state: 'failing', lastError: { reason: 'exit-code', at: iso(0), exitCode: 255, holder: null } });
    m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), new RegExp(`^O comando saiu com o código 255\\. Nenhum motivo conhecido apareceu\\. A saída ficou no log da instalação: ${LOG.replace(/[./]/g, '\\$&')}`));
  });

  test('C65: a refused write shows the core\'s sentence under the band', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ state: 'failing', lastError: { reason: 'key-refused', at: iso(0), exitCode: 255, holder: null } });
    const err = Object.assign(new Error('outra ação da conexão está em andamento nesta máquina'), { status: 409, body: { error: 'outra ação da conexão está em andamento nesta máquina', reason: 'busy' } });
    const m = mount(async () => {
      throw err;
    });
    await m.ready;
    assert.match(texto(band(m.area)), /^Chave SSH recusada\. A Workstation recusou a chave deste Mac\./);
    button(m.area, 'start').click();
    await until(() => band(m.area)?.querySelector('.tm-rc-problem') != null);
    assert.equal(texto(band(m.area)!.querySelector('.tm-rc-problem')), 'Não deu para subir o túnel: outra ação da conexão está em andamento nesta máquina.');
  });

  test('C65: a machine with only `reconnect`: the C50 band stays, the setup card shows the `connection` example; placement unknown', async () => {
    setRemote('unreachable', 'port-closed');
    connection = down({ cloud: null, command: { start: START, stop: null, startTimeoutSeconds: 180, stopTimeoutSeconds: null } });
    placement = { provider: 'unknown', kind: null, region: null, zone: null, instanceId: null, source: null, readAt: iso(0) };
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'reconnect'), 'the #244 band');
    assert.deepEqual(buttons(part(m.area, 'reconnect')), ['Tentar agora', 'Reconectar']);
    const setup = part(m.area, 'connection-setup')!;
    assert.match(texto(setup.querySelector('pre')), /"connection": \{/);
    assert.equal(part(m.area, 'connection'), null);
    const place = part(m.area, 'placement')!;
    assert.deepEqual(place.querySelectorAll('.mc-kv-v').map((v) => texto(v)), ['desconhecido', 'desconhecido', 'desconhecida', '—']);
    assert.match(texto(place), /não chutamos/);
    assert.equal(pill(m.area), 'Sem conexão');
  });

  test('a core that answers with a connection but no command in machines.json keeps the #244 setup card', async () => {
    setRemote('unreachable', 'port-closed');
    reconnect = { configured: false, command: null, timeoutSeconds: null, state: 'idle', startedAt: null, endedAt: null, exitCode: null, startedBy: null, logFile: null };
    connection = down({ configured: false, command: null, cloud: null, actions: { start: false, stop: false, reconnect: false, loginAndStart: false } });
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'reconnect-setup'));
    assert.equal(part(m.area, 'connection'), null);
    assert.ok(part(m.area, 'placement'));
  });
});

// ---------- files, classes and icons ----------

describe('#278 files, classes and icons', () => {
  const classesOfCss = (file: string) => new Set([...readFileSync(`${UI_FOLDER}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const SEALS = new Set(['badge', 'p', 'b-completed', 'b-waiting', 'b-error', 'b-abandoned', 'btn', 'icon', 'mono']);

  test('every own class of machine-connection.css is mc-*, no other sheet styles an mc- class, and the JS uses only mc- or shared ones', () => {
    const own = [...classesOfCss('screens/machine-connection.css')].filter((c) => !SEALS.has(c));
    assert.ok(own.length > 20);
    assert.deepEqual(own.filter((c) => !c.startsWith('mc-')), []);
    const sheets = [...readdirSync(UI_FOLDER), ...readdirSync(`${UI_FOLDER}screens`).map((a) => `screens/${a}`)].filter((a) => a.endsWith('.css') && a !== 'screens/machine-connection.css');
    for (const other of sheets) assert.deepEqual([...classesOfCss(other)].filter((c) => own.includes(c)), [], other);
    const js = readFileSync(`${UI_FOLDER}screens/machine-connection.js`, 'utf8');
    const shell = classesOfCss('shell.css');
    const machine = classesOfCss('screens/machine.css');
    const used = [...js.matchAll(/class: [`'"]([^`'"]+)[`'"]/g)].flatMap((m) => m[1]!.split(/\s+/)).map((c) => (c.includes('${') ? c.slice(0, c.indexOf('${')) : c)).filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
    assert.deepEqual([...new Set(used.filter((c) => !c.startsWith('mc-') && !shell.has(c) && !machine.has(c) && !SEALS.has(c) && !['card'].includes(c)))], []);
    assert.doesNotMatch(readFileSync(`${UI_FOLDER}screens/machine-connection.css`, 'utf8'), /overflow-x|#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  test('the icons the connection uses exist in dom.js', () => {
    const js = readFileSync(`${UI_FOLDER}screens/machine-connection.js`, 'utf8') + readFileSync(`${UI_FOLDER}screens/machine-connection-format.js`, 'utf8');
    const names = new Set([...js.matchAll(/(?:icon\(|iconName: |icon: )'([a-z0-9-]+)'/g)].map((m) => m[1]!));
    assert.ok(names.size > 10);
    assert.deepEqual([...names].filter((n) => !ICON_NAMES.includes(n)), []);
  });
});
