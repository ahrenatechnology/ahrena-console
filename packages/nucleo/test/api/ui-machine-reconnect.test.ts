// Reconectar a máquina remota on /ui (issue 244, decision 0012, wireframe C50): the pure parts of
// machine-format.js, the write helper's DELETE, and the machine screen mounted on the fake DOM with the
// simulator's telemetry and a fake `reconnect` per test, shaped like the contract of GET /api/machines.
// No network, no real machines.json, no process runs: the writes are recorded and answered here.
import assert from 'node:assert/strict';
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
import { WriteError, httpWriter } from '../../ui/api.js';
// @ts-expect-error: idem
import * as format from '../../ui/screens/machine-format.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const NOW = Date.now();
const WS = { id: 'ws-exemplo', label: 'Workstation', port: 14720 };
const COMMAND = ['/caminho/para/conectar.sh', 'tunnel', 'restart'];
const LOG = '/Users/exemplo/.ahrena-console/reconnect.log';
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Reconnect = Record<string, unknown> | null;
const rcOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  configured: true,
  command: COMMAND,
  timeoutSeconds: 180,
  state: 'idle',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  startedBy: null,
  logFile: LOG,
  ...over,
});

// ---------- the simulator's telemetry behind the core's service, and the fake reconnect ----------

let storage: SqliteStorage;
let service: TelemetryService;
let remote: MachineStatus;
let reconnect: Reconnect;

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
  remote = { state: 'unreachable', reason: 'port-closed', version: TELEMETRY_VERSION };
  reconnect = rcOf();
});

const setRemote = (state: MachineState, reason: UnreachableReason | null = null) => (remote = { state, reason, version: TELEMETRY_VERSION });

async function coreRead(route: string): Promise<unknown> {
  const url = new URL(route, 'http://127.0.0.1');
  let body: unknown;
  if (url.pathname === '/api/machines') {
    const list = (await service.machines()) as unknown as Record<string, unknown>[];
    body = list.map((m) => ({ ...m, reconnect: m.id === WS.id ? reconnect : null }));
  } else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
  else if (url.pathname === '/api/telemetry') body = await service.telemetry(url.searchParams.get('machine') ?? 'local', Number(url.searchParams.get('hours') ?? 1) as 1 | 12);
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
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

const startedNow: Answer = async () => (reconnect = rcOf({ state: 'running', startedAt: new Date().toISOString(), startedBy: 'ui' }), { reconnect });

function mount(answer: Answer = startedNow): Mounted {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: Write[] = [];
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
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((f: () => void) => (cleanup = f));
  const m: Mounted = { area, reads, writes, ready, leave: () => (signal.abort(), cleanup?.()) };
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
const band = (area: ElementoFalso) => area.querySelector('[data-part="reconnect"]');
const buttons = (node: ElementoFalso | null) => (node ? node.querySelectorAll('button').map((b) => texto(b)) : []);
const button = (area: ElementoFalso, action: string) => area.querySelector(`[data-rc-action="${action}"]`)!;
const pill = (area: ElementoFalso) => texto(area.querySelector('.cc-head .badge'));

// ---------- the pure parts ----------

describe('#244 machine-format: the reconnect of GET /api/machines', () => {
  test('normalizeReconnect keeps the contract shape and nothing else', () => {
    assert.equal(format.normalizeReconnect(null), null);
    assert.equal(format.normalizeReconnect('x'), null);
    const r = format.normalizeReconnect({ ...rcOf({ state: 'running', startedAt: iso(1000), startedBy: 'local' }), output: 'SEGREDO', lines: ['SEGREDO'] });
    assert.deepEqual(r, { configured: true, command: COMMAND, timeoutSeconds: 180, state: 'running', startedAt: iso(1000), endedAt: null, exitCode: null, startedBy: 'local', logFile: LOG });
    // An unknown state is idle; "configured" needs a command; a strange startedBy is null.
    assert.equal(format.normalizeReconnect(rcOf({ state: 'exploded' })).state, 'idle');
    assert.equal(format.normalizeReconnect(rcOf({ command: [] })).configured, false);
    assert.equal(format.normalizeReconnect(rcOf({ command: null })).configured, false);
    assert.equal(format.normalizeReconnect(rcOf({ startedBy: 'evil.example' })).startedBy, null);
    assert.equal(format.normalizeReconnect(rcOf({ exitCode: 1.5 })).exitCode, null);
    // GET /api/machines carries it per machine.
    assert.equal(format.normalizeMachine({ id: 'local', state: 'connected' }).reconnect, null);
    assert.equal(format.normalizeMachine({ id: WS.id, state: 'connected', reconnect: rcOf() }).reconnect.configured, true);
  });

  test('the route, the command line, the spans and the clock', () => {
    assert.equal(format.reconnectRoute('ws-exemplo'), '/api/machines/ws-exemplo/reconnect');
    assert.equal(format.reconnectRoute('a/b'), '/api/machines/a%2Fb/reconnect');
    const rc = format.normalizeReconnect(rcOf());
    assert.equal(format.commandLine(rc), 'Roda: /caminho/para/conectar.sh tunnel restart · até 3 min');
    assert.equal(format.commandLine({ ...rc, timeoutSeconds: 90 }), 'Roda: /caminho/para/conectar.sh tunnel restart · até 1 min 30 s');
    assert.equal(format.commandLine({ ...rc, command: null }), null);
    assert.equal(format.spanText(42_000), '42 s');
    assert.equal(format.spanText(86_000), '1 min 26 s');
    assert.equal(format.clockOf(72_000), '1:12');
    assert.equal(format.clockOf(180_000), '3:00');
    const clock = format.reconnectClock({ ...rc, startedAt: iso(72_000) }, NOW);
    assert.deepEqual(clock, { elapsed: '1:12', limit: '3:00', seconds: 72, max: 180 });
    // Past the limit (the core is about to stop it), the clock stays at the limit.
    assert.equal(format.reconnectClock({ ...rc, startedAt: iso(500_000) }, NOW).elapsed, '3:00');
    assert.equal(format.logLine(rc), `A saída ficou no log da instalação: ${LOG}`);
  });

  test('reconnectView maps the machine and the run to the six states of C50', () => {
    const m = (state: string, reason: string | null, rc: Reconnect) => format.normalizeMachine({ id: WS.id, label: WS.label, port: WS.port, state, reason, reconnect: rc });
    const kind = (state: string, reason: string | null, rc: Reconnect) => format.reconnectView(m(state, reason, rc), NOW)?.kind ?? null;
    assert.equal(kind('unreachable', 'port-closed', null), null, 'a core without reconnect: C26 as it was');
    assert.equal(kind('unreachable', 'port-closed', rcOf()), 'offer');
    assert.equal(kind('unreachable', 'port-closed', rcOf({ configured: false, command: null })), 'setup');
    assert.equal(kind('unreachable', 'port-closed', rcOf({ state: 'running', startedAt: iso(5000) })), 'running');
    assert.equal(kind('connected', null, rcOf({ state: 'running', startedAt: iso(5000) })), 'running');
    assert.equal(kind('unreachable', 'port-closed', rcOf({ state: 'failed', exitCode: 1 })), 'failed');
    assert.equal(kind('unreachable', 'port-closed', rcOf({ state: 'timed-out' })), 'timed-out');
    assert.equal(kind('connected', null, rcOf({ state: 'succeeded', exitCode: 0, endedAt: iso(60_000) })), 'succeeded');
    assert.equal(kind('connected', null, rcOf({ state: 'succeeded', exitCode: 0, endedAt: iso(format.RECONNECTED_SHOWN_MS + 1000) })), null, 'the green band goes away');
    assert.equal(kind('connected', null, rcOf()), null);
    const doneButDown = format.reconnectView(m('unreachable', 'port-closed', rcOf({ state: 'succeeded', exitCode: 0, endedAt: iso(5000) })), NOW);
    assert.deepEqual(doneButDown, { kind: 'offer', note: 'O comando terminou bem, mas a Workstation não respondeu. Tentamos de novo a cada 30 s.' });
    assert.match(format.reconnectView(m('unreachable', 'port-closed', rcOf({ state: 'canceled', endedAt: iso(5000) })), NOW).note, /^A última reconexão foi cancelada às \d\d:\d\d\.$/);
    // The other C26 conditions keep their cards; the tray's run shows as "pela bandeja".
    assert.equal(kind('unreachable', 'no-response', rcOf()), null);
    assert.equal(kind('incompatible-version', null, rcOf()), null);
    assert.equal(format.reconnectView(m('unreachable', 'port-closed', rcOf({ state: 'running', startedBy: 'local' })), NOW).fromTray, true);
    assert.deepEqual(format.statePill(m('unreachable', 'port-closed', rcOf({ state: 'running' }))), ['b-waiting', 'Reconectando']);
  });

  test('the result texts: exit code, duration and the limit, never the output', () => {
    const m = (rc: Reconnect) => format.normalizeMachine({ id: WS.id, label: WS.label, state: 'unreachable', reason: 'port-closed', reconnect: rc });
    assert.deepEqual(format.reconnectResult(m(rcOf({ state: 'failed', exitCode: 1, startedAt: iso(42_000), endedAt: iso(0) })), 'failed'), {
      title: 'Não reconectou.',
      text: 'O comando saiu com o código 1 depois de 42 s. A Workstation continua sem conexão.',
    });
    assert.equal(format.reconnectResult(m(rcOf({ state: 'failed', exitCode: null, startedAt: iso(42_000), endedAt: iso(0) })), 'failed').text, 'O comando terminou sem código de saída depois de 42 s. A Workstation continua sem conexão.');
    assert.equal(format.reconnectResult(m(rcOf({ state: 'timed-out' })), 'timed-out').text, 'O comando passou de 3 min e foi encerrado. Se um login ficou aberto no navegador, ele não conta mais.');
    const ok = format.reconnectResult(m(rcOf({ state: 'succeeded', exitCode: 0, startedAt: iso(86_000), endedAt: iso(0) })), 'succeeded');
    assert.match(ok.title, /^Reconectada às \d\d:\d\d$/);
    assert.equal(ok.text, '· a leitura voltou. O comando saiu com o código 0 depois de 1 min 26 s, e o núcleo leu a Workstation na hora.');
  });

  test('a reconnect state change on /api/changes (`<id>:reconnect`) re-reads that machine\'s screen only', () => {
    const change = [{ type: 'alert', key: `${WS.id}:reconnect` }];
    assert.equal(format.touchesMachine(change, WS.id), true);
    assert.equal(format.touchesMachine(change, 'outra'), false);
    assert.equal(format.touchesMachine(change, 'local'), false);
  });

  test('the setup example is this machine with a generic script', () => {
    const ex = format.reconnectExample({ id: WS.id, label: WS.label, port: WS.port });
    assert.match(ex, /^~\/\.ahrena-console\/machines\.json\n\{ "machines": \[ \{ "id": "ws-exemplo", "label": "Workstation", "port": 14720,\n/);
    assert.match(ex, /"reconnect": \{ "command": \["\/caminho\/para\/conectar\.sh", "tunnel", "restart"\],/);
    assert.match(ex, /"timeoutSeconds": 180 \} \} \] \}$/);
    assert.doesNotMatch(ex, /aws|ssm|ssh |amazon|profile/i);
  });
});

// ---------- the write helper ----------

describe('#244 the write helper: POST and DELETE, only /api/ on the local core', () => {
  test('DELETE goes without a body and without credentials; other methods are refused before the fetch', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const write = httpWriter({ base: 'http://127.0.0.1:4720', fetch: async (url: URL, init: RequestInit) => (sent.push({ url: String(url), init }), new Response(JSON.stringify({ reconnect: { state: 'canceled' } }), { status: 200 })) });
    assert.deepEqual(await write('/api/machines/ws-exemplo/reconnect', null, { method: 'DELETE' }), { reconnect: { state: 'canceled' } });
    assert.equal(sent[0]!.url, 'http://127.0.0.1:4720/api/machines/ws-exemplo/reconnect');
    assert.equal(sent[0]!.init.method, 'DELETE');
    assert.equal(sent[0]!.init.body, undefined);
    assert.equal(sent[0]!.init.credentials, 'omit');
    await write('/api/machines/ws-exemplo/reconnect', {});
    assert.equal(sent[1]!.init.method, 'POST');
    assert.equal(sent[1]!.init.body, '{}');
    for (const method of ['PUT', 'GET', 'PATCH']) await assert.rejects(write('/api/machines/ws-exemplo/reconnect', {}, { method }), (e: Error) => e instanceof WriteError && /método de escrita não aceito/.test(e.message));
    await assert.rejects(write('/ui/machines/ws-exemplo', null, { method: 'DELETE' }), /rota fora da API/);
    assert.equal(sent.length, 2);
  });
});

// ---------- the screen (C50) ----------

describe('#244 the machine screen with Reconectar (C50)', () => {
  test('1: offline with a command: the band offers Reconectar and shows what runs, over the faded reading', async () => {
    const m = mount();
    await m.ready;
    const b = band(m.area)!;
    assert.ok(b.classList.contains('error-band'));
    assert.match(texto(b), /^Sem conexão com a Workstation\. A porta 14720 deste Mac não aceita conexão: o túnel parece caído\. Abaixo, a última leitura, de \d\d:\d\d/);
    assert.equal(texto(b.querySelector('.tm-rc-cmd')), 'Roda: /caminho/para/conectar.sh tunnel restart · até 3 min');
    assert.deepEqual(buttons(b), ['Tentar agora', 'Reconectar']);
    assert.ok(button(m.area, 'start').classList.contains('filled'), 'Reconectar is the primary button');
    assert.ok(m.area.querySelector('.tm-faded'));
    assert.equal(pill(m.area), 'Sem conexão');
    // "Tentar agora" only re-reads: no write.
    const before = m.reads.length;
    button(m.area, 'retry').click();
    await until(() => m.reads.length > before);
    assert.equal(m.writes.length, 0);
  });

  test('Reconectar POSTs only the id; the answer turns the band into 2 at once, with the time against the limit', async () => {
    const m = mount();
    await m.ready;
    button(m.area, 'start').click();
    await until(() => texto(band(m.area)).startsWith('Reconectando…'));
    assert.deepEqual(m.writes, [{ route: '/api/machines/ws-exemplo/reconnect', body: {}, options: undefined }]);
    const b = band(m.area)!;
    assert.ok(b.classList.contains('tm-rc-running'));
    assert.match(texto(b), /^Reconectando… aguardando o login no navegador\. Se o comando abriu uma página de login, ela é sua: entre por lá e o console segue sozinho\./);
    assert.deepEqual(b.querySelectorAll('.tm-rc-steps li').map((li) => texto(li)), ['rodando o comando', 'aguardando o login', 'lendo a Workstation']);
    assert.match(texto(b.querySelector('[data-rc-elapsed]')), /^0:0\d de 3:00$/);
    assert.equal(b.querySelector('progress')!.getAttribute('max'), '180');
    assert.equal(texto(b.querySelector('.tm-rc-cmd')), 'Roda: /caminho/para/conectar.sh tunnel restart · até 3 min');
    assert.deepEqual(buttons(b), ['Cancelar', 'Reconectando…']);
    assert.ok(button(m.area, 'running').hasAttribute('disabled'), 'one at a time: the main button is off');
    await until(() => pill(m.area) === 'Reconectando');
    assert.ok(m.area.querySelector('.tm-faded'));
  });

  test('2: the elapsed time ticks here once a second while running', async () => {
    reconnect = rcOf({ state: 'running', startedAt: iso(72_000), startedBy: 'ui' });
    const m = mount();
    await m.ready;
    const first = texto(m.area.querySelector('[data-rc-elapsed]'));
    assert.match(first, /^1:1\d de 3:00$/);
    await until(() => texto(m.area.querySelector('[data-rc-elapsed]')) !== first, 2500);
    assert.match(texto(m.area.querySelector('[data-rc-elapsed]')), /^1:1\d de 3:00$/);
    assert.match(m.area.querySelector('[data-rc-bar]')!.getAttribute('value')!, /^7\d$/);
  });

  test('6: started by the tray: "pela bandeja", the main button says "Um por vez" and is off', async () => {
    reconnect = rcOf({ state: 'running', startedAt: iso(40_000), startedBy: 'local' });
    const m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^Reconectando, pela bandeja… aguardando o login/);
    assert.deepEqual(buttons(band(m.area)), ['Cancelar', 'Um por vez']);
    assert.ok(button(m.area, 'running').hasAttribute('disabled'));
    assert.equal(pill(m.area), 'Reconectando');
  });

  test('Cancelar DELETEs; the answer (canceled) brings back 1 with a short line', async () => {
    reconnect = rcOf({ state: 'running', startedAt: iso(10_000), startedBy: 'ui' });
    const m = mount(async () => (reconnect = rcOf({ state: 'canceled', startedAt: iso(10_000), endedAt: new Date().toISOString(), startedBy: 'ui' }), { reconnect }));
    await m.ready;
    button(m.area, 'cancel').click();
    await until(() => !texto(band(m.area)).startsWith('Reconectando'));
    assert.deepEqual(m.writes, [{ route: '/api/machines/ws-exemplo/reconnect', body: null, options: { method: 'DELETE' } }]);
    assert.match(texto(band(m.area)!.querySelector('.tm-rc-note')), /^A última reconexão foi cancelada às \d\d:\d\d\.$/);
    assert.deepEqual(buttons(band(m.area)), ['Tentar agora', 'Reconectar']);
  });

  test('4a: failed: exit code, duration and where the log is, "Tentar de novo" POSTs again; no output on screen', async () => {
    reconnect = { ...rcOf({ state: 'failed', exitCode: 1, startedAt: iso(42_000), endedAt: iso(0), startedBy: 'ui' }), output: 'CODIGO-DO-DISPOSITIVO', lines: ['conta@exemplo'] };
    const m = mount();
    await m.ready;
    const b = band(m.area)!;
    assert.ok(b.classList.contains('error-band'));
    assert.equal(texto(b.querySelector('.tm-rc-text p')), 'Não reconectou. O comando saiu com o código 1 depois de 42 s. A Workstation continua sem conexão.');
    assert.equal(texto(b.querySelector('.tm-rc-cmd')), `A saída ficou no log da instalação: ${LOG}`);
    assert.deepEqual(buttons(b), ['Tentar de novo']);
    assert.doesNotMatch(texto(m.area), /CODIGO-DO-DISPOSITIVO|conta@exemplo/);
    button(m.area, 'start').click();
    await until(() => m.writes.length === 1);
    assert.equal(m.writes[0]!.route, '/api/machines/ws-exemplo/reconnect');
  });

  test('4b: timed out: "passou de 3 min e foi encerrado"', async () => {
    reconnect = rcOf({ state: 'timed-out', startedAt: iso(180_000), endedAt: iso(0), startedBy: 'ui' });
    const m = mount();
    await m.ready;
    assert.match(texto(band(m.area)), /^Não reconectou\. O comando passou de 3 min e foi encerrado\. Se um login ficou aberto no navegador, ele não conta mais\./);
  });

  test('3: reconnected: the green band with the time, over the live reading (not faded)', async () => {
    setRemote('connected');
    reconnect = rcOf({ state: 'succeeded', exitCode: 0, startedAt: iso(86_000 + 4000), endedAt: iso(4000), startedBy: 'ui' });
    const m = mount();
    await m.ready;
    const b = band(m.area)!;
    assert.ok(b.classList.contains('tm-rc-ok'));
    assert.match(texto(b), /^Reconectada às \d\d:\d\d · a leitura voltou\. O comando saiu com o código 0 depois de 1 min 26 s, e o núcleo leu a Workstation na hora\.$/);
    assert.deepEqual(buttons(b), []);
    assert.equal(m.area.querySelector('.tm-faded'), null);
    assert.equal(pill(m.area), 'Conectada');
  });

  test('3, still down: the command ended well but the machine did not answer: back to 1 with that line', async () => {
    reconnect = rcOf({ state: 'succeeded', exitCode: 0, startedAt: iso(30_000), endedAt: iso(2000), startedBy: 'ui' });
    const m = mount();
    await m.ready;
    assert.equal(texto(band(m.area)!.querySelector('.tm-rc-note')), 'O comando terminou bem, mas a Workstation não respondeu. Tentamos de novo a cada 30 s.');
    assert.deepEqual(buttons(band(m.area)), ['Tentar agora', 'Reconectar']);
  });

  test('5: no command: no dead button, the card teaches how to configure it', async () => {
    reconnect = rcOf({ configured: false, command: null, timeoutSeconds: null });
    const m = mount();
    await m.ready;
    assert.deepEqual(buttons(band(m.area)), ['Tentar agora']);
    assert.equal(m.area.querySelector('[data-rc-action="start"]'), null);
    const card = m.area.querySelector('[data-part="reconnect-setup"]')!;
    assert.match(texto(card), /^Reconectar daqui O console pode rodar, com um clique, o comando que você já usa para subir o túnel\./);
    assert.match(texto(card), /Tenha um comando que sobe o túnel\..*Acrescente reconnect à máquina no machines\.json\..*Pronto\. O console relê o arquivo ao salvar, sem reiniciar, e o botão Reconectar aparece aqui e na bandeja\./);
    assert.match(texto(card.querySelector('.tm-config')), /"id": "ws-exemplo", "label": "Workstation", "port": 14720/);
    assert.match(texto(card), /Uma lista, sem shell: o console roda exatamente o que está no arquivo\. Nada da tela vira comando\./);
    assert.deepEqual(buttons(card), []);
  });

  test('a refused write (409, not configured) says why in the band; a new state hides it', async () => {
    const refused = Object.assign(new Error('A Workstation não tem reconnect no machines.json.'), { name: 'WriteError', status: 409 });
    const m = mount(async () => Promise.reject(refused));
    await m.ready;
    button(m.area, 'start').click();
    await until(() => !!m.area.querySelector('.tm-rc-problem'));
    assert.equal(texto(m.area.querySelector('.tm-rc-problem')), 'Não deu para reconectar: A Workstation não tem reconnect no machines.json.');
    reconnect = rcOf({ state: 'running', startedAt: iso(1000), startedBy: 'local' });
    button(m.area, 'retry').click();
    await until(() => texto(band(m.area)).startsWith('Reconectando, pela bandeja'));
    assert.equal(m.area.querySelector('.tm-rc-problem'), null);
  });

  test('a core without reconnect (null) keeps C26 exactly: only "Tentar agora"', async () => {
    reconnect = null;
    const m = mount();
    await m.ready;
    assert.equal(band(m.area), null);
    assert.deepEqual(buttons(m.area.querySelector('.error-band')), ['Tentar agora']);
  });
});
