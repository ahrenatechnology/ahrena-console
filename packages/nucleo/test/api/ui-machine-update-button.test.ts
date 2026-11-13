// The Atualizar button of the remote núcleo on /ui (issue 462, decision 0022, layer 4, wireframes 462-1 to 462-6): the
// button on the band, the confirmation that runs the --check first, the progress by phase, every ending, the
// "falta configurar" states with the block to paste, and the band that goes away by itself. Mounted on the fake DOM
// with the simulator's telemetry; the core is faked: `GET /api/machines` carries the `update` the test sets, and the
// writes are recorded and answered by a function the test gives. Nothing here runs a command, reads machines.json or
// touches a real machine.
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
import * as updateFormat from '../../ui/screens/machine-update-format.js';
// @ts-expect-error: idem
import { ICON_NAMES } from '../../ui/dom.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const NOW = Date.now();
const WS = { id: 'ws-exemplo', label: 'Workstation', port: 14720 };
const M = 60_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** A sentence only the fake core says: the screen must show it as it came, never one of its own. */
const CORE_SAYS = 'frase-do-nucleo-0f1e2d3c';
const CHECKOUT = '/home/exemplo/ahrena-console';
const BLOCK = `"update": {\n  "command": ["/usr/bin/ssh", "ahrena-tunnel", "/usr/bin/node", "--input-type=module", "-", "--checkout", "${CHECKOUT}", "--port", "4720"],\n  "timeoutSeconds": 300\n}`;

type Obj = Record<string, unknown>;
const PORTS = [{ localPort: 14720, remoteHost: 'localhost', remotePort: 4720, state: 'up', heldBy: null }];
const connOf = (over: Obj = {}): Obj => ({
  configured: true,
  state: 'up',
  since: iso(3 * 60 * M),
  ports: PORTS,
  cloud: { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'valid', expiresAt: new Date(NOW + 7 * 60 * M).toISOString() },
  lastError: null,
  actions: { start: false, stop: true, reconnect: true, loginAndStart: false },
  command: { start: ['/path/to/connect.sh', 'tunnel', 'start'], stop: ['/path/to/connect.sh', 'tunnel', 'stop'], startTimeoutSeconds: 180, stopTimeoutSeconds: 180 },
  job: null,
  logFile: '/Users/exemplo/.ahrena-console/reconnect.log',
  ...over,
});
const coreOf = (over: Obj = {}, mac: Obj = {}): Obj => ({
  version: '0.0.7',
  commit: '81251bd',
  expectedVersion: '0.0.17',
  mac: { telemetryVersion: 1, credentialCommand: true, checkout: null, ...mac },
  status: 'outdated',
  readAt: iso(M),
  ...over,
});
const updateOf = (over: Obj = {}): Obj => ({
  configured: true,
  problem: null,
  invalidReason: null,
  state: 'idle',
  kind: null,
  phase: null,
  targetVersion: '0.0.17',
  startedAt: null,
  endedAt: null,
  exitCode: null,
  reason: null,
  backupPath: null,
  oldCommit: null,
  newCommit: null,
  canCancel: false,
  timeoutSeconds: 300,
  command: ['/usr/bin/ssh', 'ahrena-tunnel'],
  confirmation: null,
  observedVersion: '0.0.7',
  readyUntil: null,
  message: null,
  setup: { block: null },
  ...over,
});
const msg = (key: string, text = CORE_SAYS) => ({ key, text });

let storage: SqliteStorage;
let service: TelemetryService;
let remote: MachineStatus;
let core: Obj | null;
let update: Obj | null;
let reads = 0;
/** What the faked core answers to a write: it may change `update`; the result is the body of the 202. */
let onWrite: (call: string) => Obj | Error;
const written: string[] = [];

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
  remote = { state: 'connected', reason: null, version: TELEMETRY_VERSION };
  core = coreOf();
  update = updateOf();
  reads = 0;
  written.length = 0;
  onWrite = () => ({ update });
});

async function coreRead(route: string): Promise<unknown> {
  const url = new URL(route, 'http://127.0.0.1');
  let body: unknown;
  if (url.pathname === '/api/machines') {
    reads += 1;
    const list = (await service.machines()) as unknown as Obj[];
    body = list.map((m) => (m.id === WS.id ? { ...m, reconnect: null, connection: connOf(), ...(core ? { core } : {}), ...(update ? { update } : {}) } : { ...m, reconnect: null }));
  } else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
  else if (url.pathname === '/api/telemetry') body = JSON.parse(JSON.stringify(await service.telemetry(url.searchParams.get('machine') ?? 'local', 1)));
  else if (url.pathname === '/api/connectors') body = { connectors: [] };
  else if (url.pathname.startsWith('/api/machines/') && url.pathname.endsWith('/connectors')) body = { machine: WS.id, status: 'ok', connectors: [] };
  else throw new Error(`unexpected route ${route}`);
  return JSON.parse(JSON.stringify(body));
}

interface Mounted {
  area: ElementoFalso;
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount(): Mounted {
  const area = new ElementoFalso('main');
  const abort = new AbortController();
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: { id: WS.id },
    signal: abort.signal,
    read: (route: string) => coreRead(route),
    write: async (route: string, _body: unknown, options?: { method?: string }) => {
      const call = `${options?.method ?? 'POST'} ${route}`;
      written.push(call);
      const answer = onWrite(call);
      if (answer instanceof Error) throw answer;
      // The faked core keeps what it answered: the next read says the same.
      if (answer.update) update = answer.update as Obj;
      return JSON.parse(JSON.stringify(answer));
    },
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((fn: () => void) => (cleanup = fn));
  const m: Mounted = { area, ready, leave: () => (abort.abort(), cleanup?.()) };
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
const action = (area: ElementoFalso, name: string) => area.querySelector(`[data-up-action="${name}"]`);
const buttons = (node: ElementoFalso | null) => (node ? node.querySelectorAll('button').map((b) => texto(b)) : []);
const stubClipboard = (copied: string[]) => Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
// ---------- the pure parts ----------

describe('issue 462 machine-update-format', () => {
  test('AC1 · the update keeps only the closed shapes, and nothing else the core or the remote said', () => {
    const u = updateFormat.normalizeUpdate({ ...updateOf({ state: 'rolled-back', kind: 'update', phase: 'rollback', oldCommit: '81251bd', backupPath: '/home/exemplo/backups/update-1', exitCode: 40, message: msg('exit-40') }), token: CORE_SAYS, command: ['--allow-disconnect'] });
    assert.equal(u.state, 'rolled-back');
    assert.equal(u.oldCommit, '81251bd');
    assert.equal(u.message.text, CORE_SAYS);
    assert.ok(!JSON.stringify(u).includes('allow-disconnect'), 'the command is not carried to the screen');
    assert.ok(!('token' in u));
  });

  test('AC1 · a state, a version or a message out of shape is dropped, and a bad `update` is no update', () => {
    assert.equal(updateFormat.normalizeUpdate(null), null);
    assert.equal(updateFormat.normalizeUpdate({ ...updateOf(), state: 'exploded' }), null);
    assert.equal(updateFormat.normalizeUpdate({ ...updateOf(), configured: 'yes' }), null);
    const u = updateFormat.normalizeUpdate({ ...updateOf({ phase: 'launch', oldCommit: 'not-a-sha', backupPath: '/x\u0007y', targetVersion: '0.0', message: { key: 'Bad Key', text: 'x' }, kind: 'weird' }) });
    assert.equal(u.phase, null);
    assert.equal(u.oldCommit, null);
    assert.equal(u.backupPath, null, 'a control character never reaches the screen');
    assert.equal(u.targetVersion, null);
    assert.equal(u.message, null);
    assert.equal(u.kind, null);
  });

  test('AC2 · the rows follow the phase: done before, now on it, next after; the rollback is an extra row', () => {
    const rows = updateFormat.stepRows({ phase: 'swap' });
    assert.deepEqual(rows.map((r: Obj) => `${r.key}:${r.tone}`), ['check:done', 'backup:done', 'swap:now', 'start:next', 'verify:next']);
    assert.deepEqual(rows.map((r: Obj) => r.label), ['Conferindo', 'Fazendo backup do banco', 'Trocando o código', 'Subindo o núcleo', 'Conferindo que respondeu']);
    const back = updateFormat.stepRows({ phase: 'rollback' });
    assert.equal(back.length, 6);
    assert.equal(back.at(-1).label, 'Voltando ao código anterior');
    assert.ok(updateFormat.stepRows({ phase: null }, { allDone: true }).every((r: Obj) => r.tone === 'done'));
    assert.equal(updateFormat.phaseLabel({ phase: 'swap' }), 'fase 3 de 5');
  });

  test('AC2 · the icons the screen asks for exist', () => {
    for (const name of ['arrow-up-circle', 'search', 'hard-drive', 'repeat', 'power', 'history', 'check-circle-2', 'circle', 'wall-loader', 'copy', 'terminal', 'rotate-cw', 'back', 'x', 'timer', 'alert', 'shield-alert', 'settings', 'chevron-down']) assert.ok(ICON_NAMES.includes(name), name);
  });
});

// ---------- the band and the button (462-1) ----------

describe('issue 462 the band with the button (462-1)', () => {
  test('AC1 · 462-1: outdated and configured, the band has the Atualizar button and the command card waits, collapsed', async () => {
    const m = mount();
    await m.ready;
    const band = part(m.area, 'core-outdated')!;
    assert.equal(band.getAttribute('data-mode'), 'ready');
    assert.match(texto(band), /^O núcleo da Workstation está na 0\.0\.7 e o app, na 0\.0\.17\./);
    assert.deepEqual(buttons(band), ['Atualizar']);
    assert.ok(action(m.area, 'open')!.classList.contains('filled'));
    assert.equal(part(m.area, 'core-update'), null, 'the command is not open');
    const fallback = part(m.area, 'update-fallback')!;
    assert.match(texto(fallback), /^Prefere rodar à mão\? decisão 0021/);
    assert.deepEqual(buttons(fallback), ['Mostrar o comando']);
    assert.deepEqual(written, [], 'nothing is written before the click');
  });

  test('AC3 · 462-1: Mostrar o comando opens the 449 card with the command to paste, and it can be folded back', async () => {
    const m = mount();
    await m.ready;
    action(m.area, 'show-command')!.click();
    const card = part(m.area, 'core-update')!;
    assert.ok(card.querySelector('pre'));
    assert.match(texto(card.querySelector('pre')), /--ref app-v0\.0\.17/);
    assert.equal(part(m.area, 'update-fallback'), null);
    action(m.area, 'hide-command')!.click();
    assert.equal(part(m.area, 'core-update'), null);
    assert.ok(part(m.area, 'update-fallback'));
  });

  test('AC1 · a current núcleo has no band, no button and no card', async () => {
    core = coreOf({ version: '0.0.17', status: 'current' });
    const m = mount();
    await m.ready;
    assert.equal(part(m.area, 'core-outdated'), null);
    assert.equal(action(m.area, 'open'), null);
    assert.equal(part(m.area, 'update-fallback'), null);
  });

  test('AC1 · an older core without `update` keeps the 449 flow, with the command open and no button', async () => {
    update = null;
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'core-update')!.querySelector('pre'));
    assert.equal(action(m.area, 'open'), null);
  });
});

// ---------- the confirmation (462-2) and the run (462-3) ----------

describe('issue 462 the confirmation and the run', () => {
  test('AC1 AC4 · 462-2: the click opens the dialog and writes only the --check (POST …/update/check), nothing that updates', async () => {
    onWrite = () => ({ update: updateOf({ state: 'checking', kind: 'check', phase: 'check', startedAt: iso(1000), canCancel: true }) });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => part(m.area, 'update-dialog') !== null && part(m.area, 'update-dialog')!.getAttribute('data-mode') === 'checking');
    assert.deepEqual(written, ['POST /api/machines/ws-exemplo/update/check']);
    const dialog = part(m.area, 'update-dialog')!;
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.match(texto(dialog), /^Atualizar o núcleo da Workstation Conferindo, sem mudar nada, se a Workstation continuaria conectada a este Mac depois de ir para a 0\.0\.17…/);
    assert.deepEqual(buttons(dialog).slice(-1), ['Cancelar']);
    assert.ok(!buttons(dialog).includes('Atualizar agora'), 'no way to update before the check passes');
  });

  test('AC1 · 462-2: with the check good, the dialog shows the core\'s sentence and the two buttons; Voltar closes it and writes nothing', async () => {
    update = updateOf({ state: 'ready', kind: 'check', readyUntil: new Date(Date.now() + 4 * M).toISOString(), message: msg('check-ready') });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => part(m.area, 'update-dialog') !== null);
    const dialog = part(m.area, 'update-dialog')!;
    assert.deepEqual(written, [], 'a check good for 5 minutes is not repeated');
    assert.match(texto(dialog), /^Atualizar o núcleo da Workstation para a 0\.0\.17\? frase-do-nucleo-0f1e2d3c/);
    assert.match(texto(dialog), /faz o backup do banco de lá, antes de parar qualquer coisa/);
    assert.match(texto(dialog), /Depois que a troca começa, não dá para cancelar\. Nada acontece neste Mac\./);
    assert.deepEqual(buttons(dialog), ['Voltar', 'Atualizar agora']);
    action(m.area, 'back')!.click();
    assert.equal(part(m.area, 'update-dialog'), null);
    assert.deepEqual(written, []);
  });

  test('AC1 AC2 · 462-3: Atualizar agora writes POST …/update, the dialog goes away and the progress shows the phase, the clock and a Cancelar that is off', async () => {
    update = updateOf({ state: 'ready', kind: 'check', readyUntil: new Date(Date.now() + 4 * M).toISOString(), message: msg('check-ready') });
    onWrite = () => ({ update: updateOf({ state: 'running', kind: 'update', phase: 'swap', startedAt: iso(42_000) }) });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => action(m.area, 'confirm') !== null);
    action(m.area, 'confirm')!.click();
    await until(() => part(m.area, 'update-progress') !== null);
    assert.deepEqual(written, ['POST /api/machines/ws-exemplo/update']);
    assert.equal(part(m.area, 'update-dialog'), null);
    const progress = part(m.area, 'update-progress')!;
    assert.match(texto(progress), /^Atualizando a Workstation para a 0\.0\.17 fase 3 de 5 · há 0:4\d/);
    assert.deepEqual(progress.querySelectorAll('li').map((li) => li.getAttribute('data-phase') + ':' + li.getAttribute('class')), ['check:tm-up-done', 'backup:tm-up-done', 'swap:tm-up-now', 'start:tm-up-next', 'verify:tm-up-next']);
    const cancel = action(progress, 'cancel')!;
    assert.equal(cancel.getAttribute('aria-disabled'), 'true');
    assert.equal(cancel.getAttribute('title'), 'Não dá para cancelar a troca');
    cancel.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(written, ['POST /api/machines/ws-exemplo/update'], 'a click on the Cancelar that is off writes nothing');
    const band = part(m.area, 'core-outdated')!;
    assert.equal(band.getAttribute('data-mode'), 'busy');
    assert.match(texto(band), /A atualização para a 0\.0\.17 está em andamento\. A Workstation fica sem conexão por cerca de um minuto; isso é esperado e não gera alerta\./);
    assert.deepEqual(buttons(band), ['Atualizando…']);
    assert.equal(action(band, 'busy')!.getAttribute('aria-busy'), 'true');
    assert.equal(part(m.area, 'update-fallback'), null, 'no second way to update while one runs');
    assert.equal(part(m.area, 'core-update'), null);
  });

  test('AC2 · 462-3: during the --check the Cancelar is on and writes DELETE …/update', async () => {
    update = updateOf({ state: 'checking', kind: 'check', phase: 'check', startedAt: iso(3000), canCancel: true });
    onWrite = () => ({ update: updateOf({ state: 'canceled', kind: 'check', endedAt: iso(0), message: msg('canceled') }) });
    const m = mount();
    await m.ready;
    const progress = part(m.area, 'update-progress')!;
    assert.match(texto(progress), /Só a conferência pode ser cancelada: ela não muda nada\./);
    const cancel = action(progress, 'cancel')!;
    assert.equal(cancel.getAttribute('aria-disabled'), null);
    cancel.click();
    await until(() => written.length === 1);
    assert.deepEqual(written, ['DELETE /api/machines/ws-exemplo/update']);
  });

  test('AC2 · 462-3: the screen re-reads fast while a run goes on', async () => {
    update = updateOf({ state: 'running', kind: 'update', phase: 'backup', startedAt: iso(1000) });
    const m = mount();
    await m.ready;
    const first = reads;
    update = updateOf({ state: 'running', kind: 'update', phase: 'start', startedAt: iso(3000) });
    await until(() => part(m.area, 'update-progress')?.getAttribute('data-phase') === 'start', 5000);
    assert.ok(reads > first);
  });

  test('AC2 · the rollback shows as an extra row', async () => {
    update = updateOf({ state: 'running', kind: 'update', phase: 'rollback', startedAt: iso(70_000) });
    const m = mount();
    await m.ready;
    const rows = part(m.area, 'update-progress')!.querySelectorAll('li');
    assert.equal(rows.length, 6);
    assert.match(texto(rows[5]!), /Voltando ao código anterior/);
  });

  test('AC4 · a write the core refuses (409 check-required) says why and the dialog stays', async () => {
    update = updateOf({ state: 'ready', kind: 'check', readyUntil: new Date(Date.now() + 4 * M).toISOString(), message: msg('check-ready') });
    onWrite = () => Object.assign(new Error('confira de novo antes de atualizar'), { status: 409 });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => action(m.area, 'confirm') !== null);
    action(m.area, 'confirm')!.click();
    await until(() => /confira de novo antes de atualizar/.test(texto(part(m.area, 'update-dialog'))));
    assert.ok(action(m.area, 'confirm'));
  });
});

// ---------- the endings (462-4, 462-5) ----------

describe('issue 462 every ending shows the core\'s sentence', () => {
  const REFUSALS: [string, Obj][] = [
    ['exit-20', { state: 'refused', exitCode: 20 }],
    ['exit-21', { state: 'refused', exitCode: 21 }],
    ['exit-22', { state: 'refused', exitCode: 22 }],
    ['exit-23', { state: 'refused', exitCode: 23 }],
    ['exit-30-dirty-tree', { state: 'refused', exitCode: 30, reason: 'dirty-tree' }],
    ['exit-31', { state: 'refused', exitCode: 31 }],
    ['exit-32-process-mismatch', { state: 'refused', exitCode: 32, reason: 'process-mismatch' }],
    ['exit-33', { state: 'refused', exitCode: 33 }],
  ];
  for (const [key, over] of REFUSALS) {
    test(`AC2 · 462-2/462-4: a refusal by the check (${key}) shows update.message.text in the dialog, with no button to update`, async () => {
      onWrite = () => ({ update: updateOf({ ...over, kind: 'check', endedAt: iso(0), message: msg(key) }) });
      const m = mount();
      await m.ready;
      action(m.area, 'open')!.click();
      await until(() => part(m.area, 'update-dialog')?.getAttribute('data-mode') === 'result');
      const dialog = part(m.area, 'update-dialog')!;
      assert.ok(texto(dialog).includes(CORE_SAYS), 'the core\'s sentence, as it came');
      assert.ok(!texto(dialog).includes('Nada foi parado'), 'the screen adds no sentence of its own');
      assert.ok(buttons(dialog).includes('Entendi'));
      assert.ok(!buttons(dialog).includes('Atualizar agora'));
      assert.equal(action(m.area, 'confirm'), null);
      action(m.area, 'dismiss')!.click();
      assert.equal(part(m.area, 'update-dialog'), null);
      assert.ok(action(m.area, 'open'), 'the button is back');
    });
  }

  test('AC2 · 462-4: exit 22 offers Mostrar o comando, which closes the dialog and opens the card with the command to paste', async () => {
    onWrite = () => ({ update: updateOf({ state: 'refused', exitCode: 22, kind: 'check', endedAt: iso(0), message: msg('exit-22') }) });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => action(m.area, 'show-command') !== null);
    action(m.area, 'show-command')!.click();
    assert.equal(part(m.area, 'update-dialog'), null);
    assert.ok(part(m.area, 'core-update')!.querySelector('pre'));
  });

  test('AC2 · 462-5: success: the band and the button go away by themselves and the result stays, with the core\'s sentence, until Fechar', async () => {
    update = updateOf({ state: 'succeeded', kind: 'update', phase: 'verify', exitCode: 0, startedAt: iso(70_000), endedAt: iso(2000), confirmation: 'confirming', message: msg('confirming', 'conferindo-0f1e') });
    const m = mount();
    await m.ready;
    assert.match(texto(part(m.area, 'update-progress')), /^Conferindo a versão .* conferindo-0f1e$/);
    assert.equal(part(m.area, 'core-outdated')!.getAttribute('data-mode'), 'busy');
    // The remote answers the new version: the core reads it, the status turns current, and the confirmation is confirmed.
    update = updateOf({ state: 'succeeded', kind: 'update', phase: 'verify', exitCode: 0, startedAt: iso(75_000), endedAt: iso(7000), confirmation: 'confirmed', observedVersion: '0.0.17', message: msg('exit-0') });
    core = coreOf({ version: '0.0.17', status: 'current' });
    await until(() => part(m.area, 'update-result') !== null, 5000);
    assert.equal(part(m.area, 'core-outdated'), null, 'the band went away');
    assert.equal(action(m.area, 'open'), null);
    const result = part(m.area, 'update-result')!;
    assert.ok(result.classList.contains('tm-up-ok'));
    assert.match(texto(result), /^Atualizado saída 0 frase-do-nucleo-0f1e2d3c/);
    assert.deepEqual(result.querySelectorAll('li').map((li) => li.getAttribute('class')), Array(5).fill('tm-up-done'));
    action(m.area, 'close-result')!.click();
    assert.equal(part(m.area, 'update-result'), null);
  });

  test('AC2 · 462-5: the version that did not arrive (diverged) says what the core says and offers the command', async () => {
    update = updateOf({ state: 'succeeded', kind: 'update', exitCode: 0, endedAt: iso(3 * M), confirmation: 'diverged', observedVersion: '0.0.7', message: msg('diverged') });
    const m = mount();
    await m.ready;
    const result = part(m.area, 'update-result')!;
    assert.ok(texto(result).includes(CORE_SAYS));
    assert.ok(buttons(result).includes('Mostrar o comando'));
    assert.ok(part(m.area, 'core-outdated'), 'the band stays: the version is still old');
  });

  test('AC2 · 462-5: exit 40 (failed and rolled back) is red, has the sentence, and Tentar de novo checks again', async () => {
    update = updateOf({ state: 'rolled-back', kind: 'update', phase: 'rollback', exitCode: 40, oldCommit: '81251bd', endedAt: iso(M), message: msg('exit-40') });
    onWrite = () => ({ update: updateOf({ state: 'checking', kind: 'check', phase: 'check', startedAt: iso(0), canCancel: true }) });
    const m = mount();
    await m.ready;
    const result = part(m.area, 'update-result')!;
    assert.ok(result.classList.contains('tm-up-bad'));
    assert.match(texto(result), /^Falhou e voltou ao código de antes saída 40 frase-do-nucleo-0f1e2d3c/);
    action(m.area, 'retry')!.click();
    await until(() => written.length === 1);
    assert.deepEqual(written, ['POST /api/machines/ws-exemplo/update/check']);
    assert.equal(part(m.area, 'update-result'), null);
  });

  test('AC2 · 462-5: exit 41 shows the backup path, copies it, and stays on the screen even long after', async () => {
    update = updateOf({ state: 'rollback-failed', kind: 'update', phase: 'rollback', exitCode: 41, oldCommit: '81251bd', backupPath: '/home/exemplo/.ahrena-console/backups/update-20261112', startedAt: iso(5 * 60 * M), endedAt: iso(4 * 60 * M), message: msg('exit-41') });
    const m = mount();
    await m.ready;
    const result = part(m.area, 'update-result')!;
    assert.ok(result.classList.contains('tm-up-bad'));
    assert.equal(result.getAttribute('role'), 'alert');
    assert.equal(texto(result.querySelector('[data-field="backup-path"]')), '/home/exemplo/.ahrena-console/backups/update-20261112');
    const copied: string[] = [];
    stubClipboard(copied);
    action(m.area, 'copy-backup')!.click();
    await until(() => copied.length === 1);
    assert.deepEqual(copied, ['/home/exemplo/.ahrena-console/backups/update-20261112']);
  });

  test('AC2 · 462-5: an old failure goes away by itself after a while; the lost contact after the swap has no Tentar de novo', async () => {
    update = updateOf({ state: 'failed', kind: 'update', exitCode: 255, endedAt: iso(2 * 60 * M), message: msg('ssh-unreachable') });
    const old = mount();
    await old.ready;
    assert.equal(part(old.area, 'update-result'), null);
    old.leave();
    update = updateOf({ state: 'timed-out', kind: 'update', phase: 'swap', endedAt: iso(M), message: msg('timeout-after-swap') });
    const lost = mount();
    await lost.ready;
    assert.ok(texto(part(lost.area, 'update-result')).includes(CORE_SAYS));
    assert.equal(action(lost.area, 'retry'), null, 'the script is still running over there');
  });

  test('AC2 · 462-5: unknown exit and the cancelled check show the core\'s sentence too', async () => {
    update = updateOf({ state: 'failed', kind: 'update', exitCode: 77, endedAt: iso(M), message: msg('unknown-exit') });
    const m = mount();
    await m.ready;
    assert.match(texto(part(m.area, 'update-result')), /^A atualização não aconteceu saída 77 frase-do-nucleo-0f1e2d3c/);
  });

  test('AC2 · the screen writes no sentence of a result: the source has none of the core\'s exit texts', () => {
    const source = readFileSync(new URL('../../ui/screens/machine-update.js', import.meta.url), 'utf8') + readFileSync(new URL('../../ui/screens/machine-update-format.js', import.meta.url), 'utf8');
    for (const phrase of ['Nada foi parado', 'rollback falhou', 'Outra atualização está rodando', 'O SSH não chegou', 'Cancelei antes']) assert.ok(!source.includes(phrase), phrase);
  });
});

// ---------- falta configurar (462-6) ----------

describe('issue 462 falta configurar (462-6)', () => {
  test('AC3 · no connection.update: the band says what is missing, the block comes ready with a copy button, and the command card is open', async () => {
    update = updateOf({ configured: false, problem: 'missing', message: msg('problem-missing', 'falta-0f1e'), setup: { block: BLOCK } });
    const m = mount();
    await m.ready;
    const band = part(m.area, 'core-outdated')!;
    assert.equal(band.getAttribute('data-mode'), 'setup');
    assert.match(texto(band), /O Console de lá roda um código mais antigo que o deste Mac\. falta-0f1e/);
    assert.equal(action(m.area, 'open'), null, 'no dead button');
    const setup = part(m.area, 'update-setup')!;
    assert.match(texto(setup), /^Ativar o botão Atualizar decisão 0022 falta-0f1e/);
    assert.equal(texto(setup.querySelector('[data-field="update-block"]')), BLOCK.replace(/\s+/g, ' ').trim());
    assert.ok(part(m.area, 'core-update')!.querySelector('pre'), 'the 0021 command stays open as the way out');
    assert.equal(part(m.area, 'update-fallback'), null);
    const copied: string[] = [];
    stubClipboard(copied);
    action(setup, 'copy-block')!.click();
    await until(() => copied.length === 1);
    assert.equal(copied[0], BLOCK);
    action(band, 'copy-block-band')!.click();
    await until(() => copied.length === 2);
    assert.deepEqual(written, [], 'nothing is written to the core: the person pastes the block');
  });

  test('AC3 · an invalid connection.update says the core\'s reason and brings the block and the card', async () => {
    update = updateOf({ configured: false, problem: 'invalid', invalidReason: 'forbidden-flag', message: msg('problem-invalid', 'invalido-0f1e'), setup: { block: BLOCK } });
    const m = mount();
    await m.ready;
    assert.match(texto(part(m.area, 'update-setup')), /^O connection\.update está inválido decisão 0022 invalido-0f1e/);
    assert.ok(part(m.area, 'core-update'));
    assert.equal(action(m.area, 'open'), null);
  });

  test('AC3 · no block (the credential has no known shape): the band says it and the card of the command stays, with no setup card', async () => {
    update = updateOf({ configured: false, problem: 'missing', message: msg('problem-missing', 'falta-0f1e'), setup: { block: null } });
    const m = mount();
    await m.ready;
    assert.equal(part(m.area, 'update-setup'), null);
    assert.ok(texto(part(m.area, 'core-outdated')).includes('falta-0f1e'));
    assert.deepEqual(buttons(part(m.area, 'core-outdated')), []);
    assert.ok(part(m.area, 'core-update'));
  });

  test('AC3 · an invalid machines.json shows no button, only what the core says, and the command card', async () => {
    update = updateOf({ configured: false, problem: 'invalid-file', message: msg('problem-invalid-file', 'arquivo-0f1e') });
    const m = mount();
    await m.ready;
    assert.ok(texto(part(m.area, 'core-outdated')).includes('arquivo-0f1e'));
    assert.equal(action(m.area, 'open'), null);
    assert.equal(part(m.area, 'update-setup'), null);
    assert.ok(part(m.area, 'core-update'));
  });

  test('AC3 · 462-6: without connection.credential the 449 flow draws (step 1 is the credential), with no block and no button', async () => {
    core = coreOf({}, { credentialCommand: false });
    update = updateOf({ configured: false, problem: 'credential-missing', message: msg('problem-credential-missing') });
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'owner-auth-setup'));
    assert.match(texto(part(m.area, 'core-update')), /^2 · Atualizar o núcleo da Workstation/);
    assert.equal(action(m.area, 'open'), null);
    assert.equal(part(m.area, 'update-setup'), null);
  });

  test('AC3 · owner-auth-required keeps the 449 flow, whatever `update` says', async () => {
    remote = { state: 'unreachable', reason: 'owner-auth-required', version: TELEMETRY_VERSION };
    const m = mount();
    await m.ready;
    assert.equal(action(m.area, 'open'), null);
    assert.ok(part(m.area, 'owner-auth'));
  });
});

// ---------- the wireframe carry-in fix ----------

describe('issue 462 the wireframe', () => {
  test('AC2 · 462-5 exit 40 says "se estava no ar antes", as the table of decision 0022 section 7 does', () => {
    const html = readFileSync(new URL('../../../../docs/wireframes/index.html', import.meta.url), 'utf8');
    const line = html.split('\n').find((l) => l.includes("cuRes('bad', 'undo-2'"));
    assert.ok(line, 'the exit 40 cell');
    assert.ok(line.includes('O núcleo de lá está no ar como estava, se estava no ar antes.'), line);
  });
});

describe('issue 462 review fixes', () => {
  test('Escape in the checking dialog cancels the --check instead of hiding a run', async () => {
    onWrite = (call) => ({ update: call.startsWith('DELETE') ? updateOf({ state: 'canceled', kind: 'check', endedAt: iso(0), message: msg('canceled') }) : updateOf({ state: 'checking', kind: 'check', phase: 'check', startedAt: iso(1000), canCancel: true }) });
    const m = mount();
    await m.ready;
    action(m.area, 'open')!.click();
    await until(() => part(m.area, 'update-dialog')?.getAttribute('data-mode') === 'checking' && action(m.area, 'cancel')?.getAttribute('aria-disabled') === null);
    const dialog = part(m.area, 'update-dialog')!;
    dialog.ouvintes.get('keydown')?.forEach((fn) => fn({ type: 'keydown', key: 'Escape' }));
    await until(() => written.includes('DELETE /api/machines/ws-exemplo/update'));
  });

  test('a confirmed update ends the band even if the núcleo read is still old', async () => {
    update = updateOf({ state: 'succeeded', kind: 'update', exitCode: 0, endedAt: iso(M), confirmation: 'confirmed', message: msg('exit-0') });
    const m = mount();
    await m.ready;
    assert.equal(action(m.area, 'open'), null);
    assert.ok(part(m.area, 'update-result'));
  });
});
