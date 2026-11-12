// The remote núcleo's version and the update command on /ui (issue 449, decision 0021, layer 4, wireframes 449-1 to
// 449-5): the Versão row of the Conexão card, the warning when the remote is outdated, the command to paste over there
// (single-quoted checkout, the Mac's flags, the bootstrap below the first release with the script), the variants for a
// Mac without connection.credential and for owner-auth-required, the Copiar button, and the arrow on the sidebar item.
// Mounted on the fake DOM with the simulator's telemetry; the machine summary carries the `core` the core would send.
// Nothing here runs a command, reads machines.json or touches a real machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { seedTelemetry, SimulatedCollector } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { FIRST_UPDATER_VERSION, hasUpdater } from '../../src/telemetry/core-version.ts';
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
import * as coreFormat from '../../ui/screens/machine-core-format.js';
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
const H = 3_600_000;
const M = 60_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** Stands for anything the core must not send to the screen beyond `core.mac`: it must never be on it. */
const SENTINEL = 'sentinela-0f1e2d3c';

type Obj = Record<string, unknown>;
const PORTS = [{ localPort: 14720, remoteHost: 'localhost', remotePort: 4720, state: 'up', heldBy: null }];
const connOf = (over: Obj = {}): Obj => ({
  configured: true,
  state: 'up',
  since: iso(3 * H),
  ports: PORTS,
  cloud: { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'valid', expiresAt: new Date(NOW + 7 * H).toISOString() },
  lastError: null,
  actions: { start: false, stop: true, reconnect: true, loginAndStart: false },
  command: { start: ['/path/to/connect.sh', 'tunnel', 'start'], stop: ['/path/to/connect.sh', 'tunnel', 'stop'], startTimeoutSeconds: 180, stopTimeoutSeconds: 180 },
  job: null,
  logFile: '/Users/exemplo/.ahrena-console/reconnect.log',
  ...over,
});
const refused = (): Obj => connOf({ state: 'down', since: iso(2 * M), actions: { start: true, stop: false, reconnect: true, loginAndStart: false } });
const coreOf = (over: Obj = {}, mac: Obj = {}): Obj => ({
  version: '0.0.7',
  commit: '81251bd',
  expectedVersion: '0.0.17',
  mac: { telemetryVersion: 1, credentialCommand: true, checkout: null, ...mac },
  status: 'outdated',
  readAt: iso(M),
  ...over,
});

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
  writes: string[];
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount(): Mounted {
  const area = new ElementoFalso('main');
  const writes: string[] = [];
  const abort = new AbortController();
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: { id: WS.id },
    signal: abort.signal,
    read: (route: string) => coreRead(route),
    write: async (route: string) => (writes.push(route), { connection }),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((fn: () => void) => (cleanup = fn));
  const m: Mounted = { area, writes, ready, leave: () => (abort.abort(), cleanup?.()) };
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
function everything(node: ElementoFalso): string {
  const out: string[] = [texto(node)];
  const visit = (n: ElementoFalso) => {
    for (const v of n.atributos.values()) out.push(v);
    n.children.forEach(visit);
  };
  visit(node);
  return out.join('\n');
}
const stubClipboard = (copied: string[]) => Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });

const COMMAND = (checkout: string, ref: string, cred = 'yes') =>
  `git -C ${checkout} fetch origin --tags \\\n  && git -C ${checkout} show ${ref}:scripts/remote-core/update-remote-core.mjs > ~/.ahrena-console/update-remote-core.mjs \\\n  && node ~/.ahrena-console/update-remote-core.mjs --checkout ${checkout} --ref ${ref} \\\n       --mac-telemetry-version 1 --mac-credential-command ${cred}`;

// ---------- the pure parts ----------

describe('#449 machine-core-format', () => {
  test('AC1 · the first updater version the screen knows is the core\'s, so the bootstrap switches where the release does', () => {
    assert.equal(coreFormat.FIRST_UPDATER_VERSION, FIRST_UPDATER_VERSION);
    for (const v of ['0.0.15', '0.0.16', '0.0.17', '0.0.18', '0.1.0', '1.0.0', 'x', '']) assert.equal(coreFormat.hasUpdater(v), hasUpdater(v), v);
  });

  test('AC1 · normalizeCore keeps only the exact shapes and only core.mac of what the Mac declares', () => {
    const c = coreFormat.normalizeCore({ ...coreOf({}, { checkout: '/home/exemplo/ahrena-console' }), token: SENTINEL, mac: { telemetryVersion: 1, credentialCommand: false, checkout: '/home/exemplo/ahrena-console', secret: SENTINEL } });
    assert.deepEqual(c, { version: '0.0.7', commit: '81251bd', expectedVersion: '0.0.17', status: 'outdated', readAt: c.readAt, mac: { telemetryVersion: 1, credentialCommand: false, checkout: '/home/exemplo/ahrena-console' } });
    assert.ok(!JSON.stringify(c).includes(SENTINEL));
    assert.equal(coreFormat.normalizeCore(null), null);
    assert.equal(coreFormat.normalizeCore('x'), null);
    assert.equal(coreFormat.normalizeCore(coreOf({ status: 'whatever' })).status, 'unknown');
    assert.equal(coreFormat.normalizeCore(coreOf({ version: '0.0.7; rm -rf /' })).version, null);
    assert.equal(coreFormat.normalizeCore(coreOf({ commit: 'zz' })).commit, null);
    assert.equal(coreFormat.normalizeCore(coreOf({ expectedVersion: 'dev' })), null, 'without the app version there is nothing to compare or to ref');
    for (const checkout of ['relative/path', '/a/../b', '/a\nb', `/${'x'.repeat(600)}`, '~/x', 42]) assert.equal(coreFormat.normalizeCore(coreOf({}, { checkout })).mac.checkout, null, String(checkout).slice(0, 20));
    assert.equal(coreFormat.normalizeCore(coreOf({}, { telemetryVersion: 'a' })), null, 'a flag the guard needs, unknown: no command');
  });

  test('AC1 · 449-2: the update command has the explicit ref and the Mac\'s flags; the checkout is single-quoted or the literal placeholder', () => {
    const base = coreFormat.normalizeCore(coreOf());
    assert.equal(coreFormat.updateCommand(base), COMMAND('<checkout>', 'app-v0.0.17'));
    const quoted = coreFormat.normalizeCore(coreOf({}, { checkout: "/home/exemplo/o'brien repo" }));
    assert.equal(coreFormat.updateCommand(quoted), COMMAND("'/home/exemplo/o'\\''brien repo'", 'app-v0.0.17'));
    assert.equal(coreFormat.updateCommand(coreFormat.normalizeCore(coreOf({}, { credentialCommand: false, telemetryVersion: 2 }))), COMMAND('<checkout>', 'app-v0.0.17', 'no').replace('--mac-telemetry-version 1', '--mac-telemetry-version 2'));
  });

  test('AC1 · the bootstrap below the first updater release takes the script from main and only checks', () => {
    const old = coreFormat.normalizeCore(coreOf({ expectedVersion: '0.0.16' }, { checkout: '/home/exemplo/repo' }));
    assert.equal(coreFormat.updateKind(old), 'bootstrap');
    const cmd = coreFormat.bootstrapCommand(old);
    assert.ok(cmd.includes("git -C '/home/exemplo/repo' show origin/main:scripts/remote-core/update-remote-core.mjs"), cmd);
    assert.ok(cmd.includes("--checkout '/home/exemplo/repo' --ref origin/main --check"), cmd);
    assert.ok(cmd.includes('--mac-telemetry-version 1 --mac-credential-command yes'), cmd);
    assert.ok(!cmd.includes('app-v0.0.16'), 'that tag has no script');
    assert.equal(coreFormat.updateKind(coreFormat.normalizeCore(coreOf())), 'update');
  });
});

// ---------- the screen ----------

describe('#449 the Versão row (449-1)', () => {
  const rows: Array<[string, Obj, string, string]> = [
    ['current', coreOf({ version: '0.0.17', commit: '5d37501', status: 'current' }), 'Núcleo de lá 0.0.17 commit 5d37501', 'Situação Em dia igual à do app'],
    ['outdated', coreOf(), 'Núcleo de lá 0.0.7 commit 81251bd', 'Situação Defasado abaixo do app'],
    ['ahead', coreOf({ version: '0.0.18', commit: '9a3f2c1', status: 'ahead' }), 'Núcleo de lá 0.0.18 commit 9a3f2c1', 'Situação Mais nova sem aviso'],
    ['unknown', coreOf({ version: null, commit: null, status: 'unknown' }), 'Núcleo de lá — sem versão nem commit', 'Situação Sem versão sem versão válida'],
  ];
  for (const [status, core, remoteText, statusText] of rows) {
    test(`AC1 · 449-1: ${status} shows the remote version and commit, the app version and the status in the Conexão card`, async () => {
      extra = { core };
      const m = mount();
      await m.ready;
      const row = part(m.area, 'core-version')!;
      assert.ok(row, 'the Versão row');
      assert.ok(part(m.area, 'connection')!.contains(row), 'inside the Conexão card');
      assert.equal(cell(m.area, 'core-remote'), remoteText);
      assert.equal(cell(m.area, 'core-app'), 'App deste Mac 0.0.17 este Mac');
      assert.equal(cell(m.area, 'core-status'), statusText);
      assert.match(texto(row), /Versão e commit vêm do \/api\/overview do núcleo de lá, que responde sem a prova do dono\./);
      if (status !== 'outdated') {
        assert.equal(part(m.area, 'core-outdated'), null, 'only the outdated warns');
        assert.equal(part(m.area, 'core-update'), null, 'and only it has the command');
      }
    });
  }

  test('AC1 · 449-1: a machine whose núcleo never answered (core null) has no row and no warning', async () => {
    const m = mount();
    await m.ready;
    assert.equal(part(m.area, 'core-version'), null);
    assert.equal(part(m.area, 'core-outdated'), null);
  });

  test('AC1 · 449-1: a machine without a connection in machines.json shows the row as its own card', async () => {
    connection = undefined;
    extra = { core: coreOf() };
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'core-version'), 'the row');
    assert.equal(part(m.area, 'connection'), null);
  });
});

describe('#449 outdated and connected (449-2)', () => {
  test('AC1 · 449-2: the yellow band says what is outdated and what to do, and the card has the command and a Copiar button', async () => {
    extra = { core: coreOf() };
    const m = mount();
    await m.ready;
    const band = part(m.area, 'core-outdated')!;
    assert.ok(band.classList.contains('tm-rc-waiting'), 'yellow, not the red of a failure');
    assert.equal(band.getAttribute('role'), 'status');
    assert.match(texto(band), /^O núcleo da Workstation está na 0\.0\.7 e o app, na 0\.0\.17\. O Console de lá roda um código mais antigo que o deste Mac, e as correções das versões novas não chegam até ele\. Este Mac não atualiza a Workstation: a atualização é um comando que você roda lá, logo abaixo\./);
    assert.match(texto(band), /lido do núcleo de lá às \d\d:\d\d, sem a prova do dono · serve para avisar, commit 81251bd/);
    assert.deepEqual(buttons(band), [], 'the band has no button: nothing runs on this Mac');
    const card = part(m.area, 'core-update')!;
    assert.match(texto(card), /^Atualizar o núcleo da Workstation decisão 0021 Cole no terminal da Workstation/);
    assert.match(texto(card), /a telemetria na versão 1 e o comando de credencial configurado\./);
    assert.equal(texto(card.querySelector('pre')), COMMAND('<checkout>', 'app-v0.0.17').replace(/\s+/g, ' ').trim());
    assert.match(texto(card), /Faz o backup do banco antes de parar o núcleo\./);
    assert.match(texto(card), /Recusa, sem parar nada, se a Workstation ficasse sem conexão com este Mac\./);
    assert.match(texto(card), /Volta ao código de antes se o núcleo novo não responder\./);
    assert.match(texto(card), /Para só conferir, sem mudar nada, acrescente --check ao final\./);
    assert.match(texto(card), /Esta tela relê a Workstation a cada 30 s: quando o núcleo de lá chegar à 0\.0\.17, o aviso sai sozinho\./);
    assert.deepEqual(buttons(card), ['Copiar o comando']);
    assert.ok(card.querySelector('button')!.classList.contains('filled'), 'primary');
    assert.match(texto(card), /Nada roda neste Mac\./);
    assert.deepEqual(m.writes, [], 'no write: the screen never runs anything');
  });

  test('AC1 · 449-2: the checkout of connection.checkout comes single-quoted in every place of the command', async () => {
    extra = { core: coreOf({}, { checkout: '/home/exemplo/ahrena console' }) };
    const m = mount();
    await m.ready;
    const copied: string[] = [];
    stubClipboard(copied);
    part(m.area, 'core-update')!.querySelector('button')!.click();
    await until(() => copied.length === 1);
    assert.equal(copied[0], COMMAND("'/home/exemplo/ahrena console'", 'app-v0.0.17'));
    assert.ok(!copied[0]!.includes('<checkout>'));
  });

  test('AC1 · 449-2: Copiar writes the exact command, says Copiado for a moment with the other note, and posts nothing', async () => {
    extra = { core: coreOf() };
    const m = mount();
    await m.ready;
    const copied: string[] = [];
    stubClipboard(copied);
    const button = part(m.area, 'core-update')!.querySelector('button')!;
    button.click();
    await until(() => copied.length === 1);
    assert.equal(copied[0], COMMAND('<checkout>', 'app-v0.0.17'));
    await until(() => button.getAttribute('data-state') === 'done');
    assert.match(texto(button), /Copiado/);
    assert.match(texto(part(m.area, 'core-update')), /Cole no terminal da Workstation\./);
    assert.deepEqual(m.writes, []);
  });

  test('AC1 · 449-2: the same version with an older commit says so, with the same command', async () => {
    extra = { core: coreOf({ version: '0.0.17', commit: '3be19c4' }) };
    const m = mount();
    await m.ready;
    const band = part(m.area, 'core-outdated')!;
    assert.match(texto(band), /^O núcleo da Workstation tem a mesma versão do app \(0\.0\.17\), mas um commit mais antigo\. A versão só muda no release, então o código de lá é de antes do deste Mac \(commit 3be19c4\)\./);
    assert.match(texto(part(m.area, 'core-update')), /--ref app-v0\.0\.17/);
    assert.equal(cell(m.area, 'core-status'), 'Situação Defasado commit mais antigo');
  });

  test('AC1 · the app below the first updater release gets the bootstrap instead of --ref app-v<version>', async () => {
    extra = { core: coreOf({ expectedVersion: '0.0.16' }, { checkout: '/home/exemplo/repo' }) };
    const m = mount();
    await m.ready;
    const card = part(m.area, 'core-update')!;
    assert.equal(card.getAttribute('data-kind'), 'bootstrap');
    assert.match(texto(card), /primeira vez/);
    assert.match(texto(card), /0\.0\.17 ?, a primeira que traz o script de atualização/);
    assert.match(texto(card), /--allow-disconnect/);
    const pre = texto(card.querySelector('pre'));
    assert.ok(pre.includes("show origin/main:scripts/remote-core/update-remote-core.mjs"), pre);
    assert.ok(pre.includes('--ref origin/main --check'), pre);
    assert.ok(!pre.includes('app-v0.0.16'));
    const copied: string[] = [];
    stubClipboard(copied);
    card.querySelector('button')!.click();
    await until(() => copied.length === 1);
    assert.equal(copied[0], coreFormat.bootstrapCommand(coreFormat.normalizeCore(coreOf({ expectedVersion: '0.0.16' }, { checkout: '/home/exemplo/repo' }))));
  });

  test('AC1 · no alert and no band outside the screen: the attention list is untouched', async () => {
    extra = { core: coreOf() };
    const m = mount();
    await m.ready;
    const list = (await coreRead('/api/attention')) as { total: number };
    assert.equal(list.total, 0);
  });
});

describe('#449 outdated, and this Mac cannot sign in after the update (449-3, 449-4)', () => {
  test('AC4 · 449-3: without connection.credential the band says to configure it first, step 1 is the 388 example and step 2 the command with "no"', async () => {
    extra = { core: coreOf({}, { credentialCommand: false }) };
    const m = mount();
    await m.ready;
    const band = part(m.area, 'core-outdated')!;
    assert.ok(band.classList.contains('tm-rc-waiting'));
    assert.match(texto(band), /^Configure o comando de credencial antes de atualizar a Workstation\. A versão 0\.0\.17 só responde a quem prova ser o dono \(decisão 0020\), e este Mac ainda não tem o comando de credencial no machines\.json\./);
    assert.match(texto(band), /--mac-credential-command no/);
    assert.match(texto(band), /código 21 antes de parar o núcleo que funciona/);
    assert.match(texto(band), /o núcleo de lá está na 0\.0\.7, lido sem a prova do dono/);
    const setup = part(m.area, 'owner-auth-setup')!;
    assert.match(texto(setup), /^1 · Comando de credencial decisão 0020 Grave em connection\.credential/);
    assert.ok(texto(setup.querySelector('pre')).includes('"remote-credential", "--port", "4720"]'));
    assert.deepEqual(buttons(setup), ['Copiar o exemplo']);
    const card = part(m.area, 'core-update')!;
    assert.match(texto(card), /^2 · Atualizar o núcleo da Workstation/);
    assert.match(texto(card), /sem comando de credencial/);
    assert.match(texto(card), /Com no, recusa com o código 21 e não para nada\./);
    assert.ok(texto(card.querySelector('pre')).endsWith('--mac-credential-command no'));
    assert.ok(card.querySelector('button')!.classList.contains('outline'), 'secondary while the credential is missing');
    const order = m.area.querySelectorAll('[data-part]').map((p) => p.getAttribute('data-part')!);
    assert.ok(order.indexOf('core-outdated') < order.indexOf('owner-auth-setup') && order.indexOf('owner-auth-setup') < order.indexOf('core-update'), order.join(','));
  });

  test('AC4 · 449-4: in owner-auth-required the 388-1 band stays, the version is still read, and the update card comes as step 2 with "no"', async () => {
    setRemote('unreachable', 'owner-auth-required');
    connection = refused();
    extra = { core: coreOf({ version: '0.0.15', commit: 'd41e8a0' }, { credentialCommand: false }) };
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'owner-auth'), 'the 388-1 band, unchanged');
    assert.equal(part(m.area, 'core-outdated'), null, 'one band at a time');
    assert.equal(cell(m.area, 'core-remote'), 'Núcleo de lá 0.0.15 commit d41e8a0');
    assert.equal(cell(m.area, 'core-status'), 'Situação Defasado abaixo do app');
    assert.equal(m.area.querySelectorAll('[data-part="owner-auth-setup"]').length, 1, 'the credential card is the 388 one, once');
    const card = part(m.area, 'core-update')!;
    assert.match(texto(card), /^2 · Atualizar o núcleo da Workstation/);
    assert.ok(texto(card.querySelector('pre')).endsWith('--mac-credential-command no'));
  });

  test('AC4 · owner-auth-failed has the update card too (an old núcleo is its first cause), owner-auth-mismatch does not (it may be another machine)', async () => {
    setRemote('unreachable', 'owner-auth-failed');
    connection = refused();
    extra = { core: coreOf() };
    const failed = mount();
    await failed.ready;
    assert.ok(part(failed.area, 'core-update'));
    assert.match(texto(part(failed.area, 'core-update')), /^Atualizar o núcleo da Workstation/);
    failed.leave();
    setRemote('unreachable', 'owner-auth-mismatch');
    const mismatch = mount();
    await mismatch.ready;
    assert.equal(part(mismatch.area, 'core-update'), null);
    assert.equal(part(mismatch.area, 'core-outdated'), null);
  });
});

describe('#449 what reaches the screen', () => {
  test('AC1 · nothing but the validated version, commit and core.mac is shown', async () => {
    extra = { core: { ...coreOf({ version: '0.0.7', commit: '81251bd' }), raw: SENTINEL, token: SENTINEL, mac: { telemetryVersion: 1, credentialCommand: true, checkout: null, secret: SENTINEL } } };
    const m = mount();
    await m.ready;
    assert.ok(part(m.area, 'core-update'));
    assert.ok(!everything(m.area).includes(SENTINEL));
  });
});

// ---------- the sidebar ----------

describe('#449 the arrow on the sidebar item (449-5)', () => {
  const list = [
    { id: 'ws-a', label: 'A', state: 'connected', reason: null, core: coreOf() },
    { id: 'ws-b', label: 'B', state: 'connected', reason: null, core: coreOf({ version: '0.0.17', commit: 'abc1234', status: 'current' }) },
    { id: 'ws-c', label: 'C', state: 'connected', reason: null, core: coreOf({ version: '0.0.18', status: 'ahead' }) },
    { id: 'ws-d', label: 'D', state: 'connected', reason: null, core: coreOf({ version: null, commit: null, status: 'unknown' }) },
    { id: 'ws-e', label: 'E', state: 'unreachable', reason: 'owner-auth-required', core: coreOf() },
    { id: 'ws-f', label: 'F', state: 'connected', reason: null, core: null },
  ];

  test('AC1 · 449-5: only the outdated machines are marked, and the dot is still the tunnel\'s and the proof\'s', async () => {
    assert.deepEqual(machineItems(list).map((i: Obj) => i.coreOutdated === true), [true, false, false, false, true, false]);
    assert.deepEqual(machineItems(list).map((i: Obj) => i.state), ['connected', 'connected', 'connected', 'connected', 'owner-auth', 'connected']);
    const nav = new ElementoFalso('nav');
    const { readMachines } = createNav({ nav, read: async () => list, screens: SCREENS });
    await readMachines();
    const flag = (id: string) => nav.querySelector(`[data-screen="machine-${id}"] .cc-nav-flag`);
    for (const id of ['ws-a', 'ws-e']) {
      assert.ok(flag(id), id);
      assert.equal(flag(id)!.getAttribute('title'), 'Núcleo defasado');
      assert.equal(flag(id)!.getAttribute('aria-label'), 'Núcleo defasado');
    }
    for (const id of ['ws-b', 'ws-c', 'ws-d', 'ws-f']) assert.equal(flag(id), null, id);
    assert.equal(nav.querySelector('[data-screen="machine-ws-a"] .cc-nav-dot')!.getAttribute('data-state'), 'connected');
    assert.equal(nav.querySelector('[data-screen="machine-ws-e"] .cc-nav-dot')!.getAttribute('data-state'), 'owner-auth');
    const children = nav.querySelector('[data-screen="machine-ws-a"]')!.children.map((c) => c.classList.contains('cc-nav-flag') ? 'flag' : c.classList.contains('cc-nav-dot') ? 'dot' : 'other');
    assert.ok(children.indexOf('flag') < children.indexOf('dot'), 'the arrow sits beside the name, before the dot');
  });

  test('AC1 · 449-5: the sidebar item does not leak anything of core.mac', () => {
    const item = machineItems([{ id: 'ws-a', label: 'A', state: 'connected', core: coreOf({}, { checkout: '/home/exemplo/repo' }) }])[0];
    assert.ok(!JSON.stringify(item).includes('/home/exemplo/repo'));
  });

  test('AC1 · 449-5: the icons exist and the styles use only brand tokens', () => {
    for (const name of ['arrow-up-circle', 'copy', 'terminal', 'key-round']) assert.ok(ICON_NAMES.includes(name), name);
    const shell = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    assert.match(shell, /\.cc-nav-flag \{[^}]*var\(--status-waiting-text\)/);
    for (const file of ['shell.css', 'screens/machine.css']) {
      const css = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      const block = css.split('\n').filter((l) => /cc-nav-flag|tm-core-/.test(l)).join('\n');
      assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `${file}: a color outside the brand tokens`);
    }
  });
});
