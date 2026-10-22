// The cloud connectors on /ui (issue 277, wireframes C57 to C61, C66 and C67): the pure formats of
// cloud-format.js, the CSS and class prefix, the registry, and the screens mounted on the fake DOM
// against answers shaped like the core's: the catalog (and the fallback to the GitHub detail on a core
// without the routes), the AWS screen, the "Perfis de nuvem" card of this Mac and of a remote machine
// (device code, the command when the remote cannot log in, the faded last reading), and the sidebar dot.
// No network, no real aws: placeholders only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, mock, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
const here = { pathname: '/ui/connections', search: '' };
const replaced: string[] = [];
Object.assign(globalThis, {
  location: here,
  history: {
    state: null as unknown,
    replaceState(s: unknown, _t: string, url: string) {
      this.state = s;
      replaced.push(url);
      const u = new URL(url, 'http://127.0.0.1');
      here.pathname = u.pathname;
      here.search = u.search;
    },
  },
});

// @ts-expect-error: browser module, plain JavaScript
const format = await import('../../ui/screens/cloud-format.js');
// @ts-expect-error: idem
const { cloudProfiles, profilesView } = await import('../../ui/screens/cloud-profiles.js');
// @ts-expect-error: idem
const awsScreen = await import('../../ui/screens/cloud-connections.js');
// @ts-expect-error: idem
const connections = await import('../../ui/screens/connections.js');
// @ts-expect-error: idem
const { findScreen, litItem, SCREENS } = await import('../../ui/screens.js');
// @ts-expect-error: idem
const { createNav } = await import('../../ui/nav.js');

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => Object.assign(new Error('não encontrado'), { name: 'ReadError', status: 404, body: { error: 'não encontrado' } });

type Obj = Record<string, unknown>;
const login = (extra: Obj = {}): Obj => ({ state: 'idle', mode: null, startedAt: null, endedAt: null, timeoutSeconds: 300, exitCode: null, startedBy: null, logFile: '/caminho/para/reconnect.log', deviceCode: null, ...extra });
const session = (extra: Obj = {}): Obj => ({
  name: 'sessao-exemplo',
  kind: 'sso-session',
  startUrlHost: 'exemplo.awsapps.com',
  region: 'regiao-exemplo-1',
  loginSupported: true,
  state: 'expired',
  expiresAt: iso(NOW - 5 * 3_600_000),
  checkedAt: iso(NOW - 60_000),
  profiles: [
    { name: 'perfil-dev', accountId: '111111111111', roleName: 'PapelExemplo', region: 'regiao-exemplo-1' },
    { name: 'perfil-dados', accountId: '222222222222', roleName: 'PapelLeitura', region: 'regiao-exemplo-2' },
  ],
  login: login(),
  ...extra,
});
const aws = (extra: Obj = {}): Obj => ({
  kind: 'aws',
  state: 'expired',
  cli: { found: true, version: 2, deviceCodeSupported: true },
  configFile: { status: 'ok' },
  sessions: [session()],
  outOfScope: [{ name: 'perfil-chave', reason: 'no-sso' }],
  ...extra,
});
const connectorsBody = (a: Obj | null = aws()) => ({ connectors: [...(a ? [a] : []), { kind: 'gcp', state: 'soon' }, { kind: 'azure', state: 'soon' }] });
const DEVICE = { verificationUri: 'https://device.sso.regiao-exemplo-1.amazonaws.com/', userCode: 'ABCD-EFGH', expiresAt: iso(Date.now() + 9 * 60_000) };

describe('issue 277: the pure formats (cloud-format.js)', () => {
  test('the session pill: valid until, expiring in, expired for, never, unknown, and a running login wins', () => {
    const s = (state: string, expiresAt: string | null, l: Obj = login()) => format.sessionPill(format.normalizeConnectors(connectorsBody(aws({ sessions: [session({ state, expiresAt, login: l })] }))).aws.sessions[0], NOW);
    assert.deepEqual(s('expired', iso(NOW - 5 * 3_600_000)), { tone: 'b-error', label: 'Expirada há 5 h' });
    assert.deepEqual(s('expiring', iso(NOW + 14 * 60_000)), { tone: 'b-waiting', label: 'Expira em 14 min' });
    assert.match(s('valid', iso(NOW + 3_600_000)).label, /^Válida até \d\d:\d\d$/);
    assert.deepEqual(s('never', null), { tone: 'b-abandoned', label: 'Nunca entrou' });
    assert.deepEqual(s('unknown', null), { tone: 'b-abandoned', label: 'Desconhecida' });
    assert.deepEqual(s('expired', null, login({ state: 'running', startedAt: iso(NOW) })), { tone: 'b-waiting', label: 'Entrando…' });
    assert.equal(format.timeLeft(iso(NOW + (7 * 60 + 12) * 60_000), NOW), '7 h 12 min');
    assert.equal(format.timeLeft('x', NOW), null);
  });

  test('the connector pill, the catalog lines and the sidebar dot sum up the worst session', () => {
    const n = (a: Obj) => format.normalizeConnectors(connectorsBody(a)).aws;
    assert.deepEqual(format.connectorPill(n(aws()), NOW), { tone: 'b-error', label: '1 sessão expirada' });
    assert.deepEqual(format.connectorPill(n(aws({ state: 'missing-cli' })), NOW), { tone: 'b-waiting', label: 'aws CLI não encontrada' });
    assert.deepEqual(format.connectorPill(n(aws({ state: 'not-configured', sessions: [] })), NOW), { tone: 'b-abandoned', label: 'Não configurada' });
    assert.equal(format.awsConnected(n(aws())), true);
    assert.equal(format.awsConnected(n(aws({ state: 'not-configured', sessions: [] }))), false);
    const lines = format.awsCardLines(n(aws()), NOW).map((l: (string | Obj)[]) => l.map((p) => (typeof p === 'string' ? p : Object.values(p)[0])).join(''));
    assert.equal(lines[0], '1 sessão SSO · 3 perfis lidos do ~/.aws/config');
    assert.match(lines[1], /^sessao-exemplo expirou às \d\d:\d\d$/);
    assert.deepEqual(format.connectorsDot(connectorsBody()), { state: 'cloud-error', label: 'AWS · 1 sessão expirada' });
    assert.equal(format.connectorsDot(connectorsBody(aws({ state: 'valid', sessions: [session({ state: 'valid' })] }))).state, 'cloud-ok');
    assert.equal(format.connectorsDot(connectorsBody(aws({ state: 'expiring', sessions: [session({ state: 'expiring', expiresAt: iso(NOW + 600_000) })] }))).state, 'cloud-warn');
    assert.equal(format.connectorsDot(connectorsBody(null)).state, 'cloud-none');
    assert.equal(format.connectorsDot({ error: 'não encontrado' }), null, 'not the cloud answer: no dot');
  });

  test('normalizing: a core without the routes is null; bad fields are dropped; a device code only with an AWS https URI and the AWS code shape', () => {
    assert.equal(format.normalizeConnectors(null), null);
    assert.equal(format.normalizeConnectors({ github: {} }), null);
    const bad = format.normalizeConnectors({ connectors: [{ kind: 'aws', state: 'weird', sessions: [{ name: 'dev prod', loginSupported: true, state: 'x', login: { state: 'running', deviceCode: { verificationUri: 'https://phishing.example/', userCode: 'ABCD-EFGH' } } }, 'junk'] }] }).aws;
    assert.equal(bad.state, 'unknown');
    assert.equal(bad.sessions.length, 1);
    assert.equal(bad.sessions[0].loginSupported, false, 'a name with a space never goes on a command line');
    assert.equal(bad.sessions[0].login.deviceCode, null);
    const good = format.normalizeConnectors(connectorsBody(aws({ sessions: [session({ login: login({ state: 'running', mode: 'device-code', deviceCode: DEVICE }) })] }))).aws;
    assert.equal(good.sessions[0].login.deviceCode.userCode, 'ABCD-EFGH');
    for (const uri of ['http://device.sso.regiao-exemplo-1.amazonaws.com/', 'https://amazonaws.com.evil.example/', 'https://user:pw@x.awsapps.com/', 'javascript:alert(1)', null]) assert.equal(format.verificationLink(uri), null, String(uri));
    assert.equal(format.verificationLink('https://exemplo.awsapps.com/start/#/device'), 'https://exemplo.awsapps.com/start/#/device');
    assert.deepEqual(format.normalizeRemote({ status: 'unreachable', connectors: [] }), { status: 'unreachable', connectors: null });
    assert.equal(format.normalizeRemote({ nope: 1 }), null);
  });

  test('the login route takes only a safe name and a machine id; the screen never builds a path from anything else', () => {
    assert.equal(format.loginRoute('local', 'sessao-exemplo'), '/api/connectors/aws/sessions/sessao-exemplo/login');
    assert.equal(format.loginRoute('workstation', 'sessao-exemplo'), '/api/machines/workstation/connectors/aws/sessions/sessao-exemplo/login');
    for (const [m, n] of [['local', 'dev prod'], ['local', '../x'], ['local', 'a/b'], ['Work Station', 'sessao-exemplo'], ['local', '']]) assert.equal(format.loginRoute(m, n), null, `${m} ${n}`);
    assert.equal(format.awsScreenRoute('workstation'), '/ui/connections/aws?machine=workstation');
    assert.equal(format.awsScreenRoute('local'), '/ui/connections/aws');
    assert.equal(format.machineFromSearch('?machine=../x'), 'local');
    assert.equal(format.machineFromSearch('?machine=workstation'), 'workstation');
  });

  test('the login band: running, a recent end, nothing after 10 min; the clock against the limit; the commands said on screen', () => {
    const s = (l: Obj, state = 'expired') => format.normalizeConnectors(connectorsBody(aws({ sessions: [session({ state, login: l })] }))).aws.sessions[0];
    assert.equal(format.loginBand(s(login({ state: 'running', startedAt: iso(NOW - 48_000) })), NOW), 'running');
    assert.equal(format.loginBand(s(login({ state: 'timed-out', endedAt: iso(NOW - 60_000) })), NOW), 'timed-out');
    assert.equal(format.loginBand(s(login({ state: 'timed-out', endedAt: iso(NOW - 11 * 60_000) })), NOW), null);
    assert.equal(format.loginBand(s(login({ state: 'failed', endedAt: iso(NOW - 60_000) }), 'valid'), NOW), null, 'a failure the session got past says nothing');
    assert.equal(format.loginBand(s(login({ state: 'succeeded', endedAt: iso(NOW - 60_000) }), 'valid'), NOW), 'succeeded');
    assert.deepEqual(format.loginClock({ startedAt: iso(NOW - 48_000), timeoutSeconds: 300 }, NOW), { elapsed: '0:48', limit: '5:00', seconds: 48, max: 300 });
    assert.equal(format.loginClock({ startedAt: iso(NOW - 900_000), timeoutSeconds: 300 }, NOW).seconds, 300);
    const one = s(login());
    assert.equal(format.loginCommand(one, 'browser'), 'aws sso login --sso-session sessao-exemplo');
    assert.equal(format.loginCommand(one, 'device-code'), 'aws sso login --sso-session sessao-exemplo --use-device-code --no-browser');
    assert.equal(format.fallbackCommand(one), 'aws sso login --sso-session sessao-exemplo --use-device-code');
    assert.equal(format.fallbackCommand({ ...one, kind: 'legacy', name: 'perfil-antigo' }), 'aws sso login --profile perfil-antigo --use-device-code');
    assert.equal(format.endedText('timed-out', s(login({ state: 'timed-out', endedAt: iso(NOW) }))).text, 'Passou de 5 min sem resposta do navegador e o console encerrou a aws CLI. A sessão continua expirada.');
  });

  test('a remote without the login route (404 without reason) or without the device code shows the command; other refusals are phrased', () => {
    assert.equal(format.isFallback({ status: 404, body: { error: 'não encontrado' } }), true);
    assert.equal(format.isFallback({ status: 404, body: { error: 'x', reason: 'unknown' } }), false);
    assert.equal(format.isFallback({ status: 409, body: { reason: 'device-code-unsupported' } }), true);
    assert.equal(format.writeErrorText({ status: 502, body: { reason: 'unreachable' } }), 'A máquina não respondeu. Confira o túnel e tente de novo.');
    assert.equal(format.writeErrorText({ status: 409, body: { error: 'a aws CLI desta máquina é a v1; o login por SSO precisa da v2', reason: 'cli-unsupported' } }), 'a aws CLI desta máquina é a v1; o login por SSO precisa da v2');
    assert.equal(format.writeErrorText({ status: 0 }), 'O núcleo não respondeu.');
  });

  test('the states that are not the happy path (C60), the numbers (C58), and every session of every machine, closest to expiring first (C61)', () => {
    const n = (a: Obj) => format.normalizeConnectors(connectorsBody(a)).aws;
    const problems = format.awsProblems(n(aws({ configFile: { status: 'error', error: { line: 14, message: 'seção sem nome' } }, sessions: [session(), session({ name: 'dev prod', loginSupported: false, state: 'unknown' })] })));
    assert.deepEqual(problems.map((p: { id: string }) => p.id), ['config-error', 'name-dev prod', 'unknown']);
    assert.match(problems[0].text, /^Linha 14: seção sem nome\./);
    assert.deepEqual(format.awsProblems(n(aws({ cli: { found: false, version: null }, state: 'missing-cli', sessions: [] }))).map((p: { id: string }) => p.id), ['missing-cli']);
    assert.deepEqual(format.awsProblems(n(aws({ cli: { found: true, version: 1 }, state: 'unsupported-cli' }))).map((p: { id: string }) => p.id), ['unsupported-cli']);
    assert.equal(format.canLogin(n(aws({ configFile: { status: 'error', error: { line: 1, message: 'x' } } })), n(aws()).sessions[0]), false, 'a broken file turns Entrar off');
    assert.deepEqual(format.awsStats(n(aws())).map((s: { value: string }) => s.value), ['1', '3', '0', '1']);
    const mac = n(aws({ sessions: [session({ name: 'sessao-lab', state: 'valid', expiresAt: iso(NOW + 6 * 3_600_000) }), session({ state: 'expiring', expiresAt: iso(NOW + 14 * 60_000) })] }));
    const ws = n(aws({ sessions: [session({ expiresAt: iso(NOW - 9 * 3_600_000) })] }));
    const rows = format.allSessions([{ id: 'local', label: 'Este Mac', aws: mac }, { id: 'workstation', label: 'Workstation', aws: ws }]);
    assert.deepEqual(rows.map((r: { machine: string; session: { name: string } }) => `${r.machine}:${r.session.name}`), ['Workstation:sessao-exemplo', 'Este Mac:sessao-exemplo', 'Este Mac:sessao-lab']);
  });

  test('the Perfis de nuvem card: what each reading shows', () => {
    const a = format.normalizeConnectors(connectorsBody()).aws;
    assert.equal(profilesView({ local: true, status: 'hidden', aws: null, hasReading: false }), 'hidden');
    assert.equal(profilesView({ local: false, status: 'unsupported', aws: null, hasReading: false }), 'unsupported');
    assert.equal(profilesView({ local: false, status: 'unreachable', aws: null, hasReading: false }), 'unreachable');
    assert.equal(profilesView({ local: false, status: 'unreachable', aws: a, hasReading: true }), 'table', 'the last reading stays, faded');
    assert.equal(profilesView({ local: true, status: 'ok', aws: { ...a, state: 'missing-cli', sessions: [] }, hasReading: true }), 'missing-cli');
    assert.equal(profilesView({ local: true, status: 'ok', aws: null, hasReading: true }), 'not-configured');
  });
});

describe('issue 277: files, classes, icons and the registry', () => {
  const classesOfCss = (file: string) => new Set([...readFileSync(`${UI_FOLDER}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const SEALS = new Set(['badge', 'p', 'b-completed', 'b-waiting', 'b-error', 'b-abandoned', 'btn', 'icon', 'on', 'filled', 'outline', 'mono']);
  const FILES = ['screens/cloud-connections.js', 'screens/cloud-parts.js', 'screens/cloud-profiles.js'];

  test('every own class of clouds.css and of the cloud modules is cl-*; the modules load clouds.css', () => {
    const shell = classesOfCss('shell.css');
    const own = [...classesOfCss('screens/clouds.css')].filter((c) => !SEALS.has(c));
    assert.ok(own.length > 40);
    assert.deepEqual(own.filter((c) => !c.startsWith('cl-')), []);
    const used = FILES.flatMap((f) => [...readFileSync(`${UI_FOLDER}${f}`, 'utf8').matchAll(/class: [`'"]([^`'"]+)[`'"]/g)].flatMap((m) => m[1]!.split(/\s+/)))
      .map((c) => (c.includes('${') ? c.slice(0, c.indexOf('${')) : c))
      .filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
    assert.deepEqual([...new Set(used.filter((c) => !c.startsWith('cl-') && !shell.has(c) && !SEALS.has(c) && !['card', 'mono', 'eyebrow'].includes(c)))], []);
    assert.match(readFileSync(`${UI_FOLDER}screens/cloud-parts.js`, 'utf8'), /\/ui\/screens\/clouds\.css/);
    // No other screen CSS defines a cl- class (UI rule 1).
    for (const other of ['screens/machine.css', 'screens/connections.css', 'shell.css']) assert.deepEqual([...classesOfCss(other)].filter((c) => c.startsWith('cl-')), [], other);
  });

  test('the icons the cloud screens use exist in dom.js', async () => {
    // @ts-expect-error: browser module
    const { ICON_NAMES } = await import('../../ui/dom.js');
    const files = [...FILES, 'screens/cloud-format.js'].map((f) => readFileSync(`${UI_FOLDER}${f}`, 'utf8')).join('\n');
    const names = [...files.matchAll(/(?:icon\(|icon: |iconName: )'([a-z0-9-]+)'/g)].map((m) => m[1]!);
    assert.ok(names.includes('cloud') && names.includes('log-in'));
    assert.deepEqual([...new Set(names.filter((n) => !ICON_NAMES.includes(n)))], []);
  });

  test('/ui/connections/aws and /ui/connections/github light Conexões; Conexões has the dot of the worst connector', async () => {
    const aws = findScreen('/ui/connections/aws');
    assert.equal(aws.screen.file, '/ui/screens/cloud-connections.js');
    assert.equal(litItem(aws.screen, aws.params), 'connections');
    const gh = findScreen('/ui/connections/github');
    assert.equal(gh.screen.file, '/ui/screens/connections.js');
    assert.equal(litItem(gh.screen, gh.params), 'connections');
    let answer: () => Promise<unknown> = async () => connectorsBody();
    const nav = new ElementoFalso('nav');
    const { readConnectors } = createNav({ nav, read: async (route: string) => (route === '/api/connectors' ? answer() : []), screens: SCREENS });
    assert.equal(nav.querySelector('[data-screen="connections"] .cc-nav-dot'), null);
    await readConnectors();
    const dot = nav.querySelector('[data-screen="connections"] .cc-nav-dot')!;
    assert.equal(dot.getAttribute('data-state'), 'cloud-error');
    assert.equal(dot.getAttribute('aria-label'), 'AWS · 1 sessão expirada');
    // Offline keeps the dot; a core without the route takes it away.
    answer = async () => Promise.reject(Object.assign(new Error('offline'), { status: 0 }));
    await readConnectors();
    assert.ok(nav.querySelector('[data-screen="connections"] .cc-nav-dot'));
    answer = async () => Promise.reject(notFound());
    await readConnectors();
    assert.equal(nav.querySelector('[data-screen="connections"] .cc-nav-dot'), null);
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    for (const s of ['cloud-ok', 'cloud-warn', 'cloud-error']) assert.match(css, new RegExp(`\\.cc-nav-dot\\[data-state="${s}"\\]`));
  });
});

// ---------- the screens on the fake DOM ----------

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  writes: { route: string; body: unknown; options: unknown }[];
  navigated: { route: string; state: unknown }[];
  change: (c: unknown[]) => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function context(read: (route: string) => Promise<unknown>, write?: (route: string, body: unknown, options: unknown) => Promise<unknown>) {
  const reads: string[] = [];
  const writes: Mounted['writes'] = [];
  const navigated: Mounted['navigated'] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const signal = new AbortController();
  const ctx = {
    params: {},
    signal: signal.signal,
    read: (route: string) => (reads.push(route), read(route)),
    write: (route: string, body: unknown, options: unknown) => (writes.push({ route, body, options }), (write ?? (async () => ({})))(route, body, options)),
    onChange: (f: (c: unknown[]) => void) => changes.push(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (route: string, state: unknown = null) => navigated.push({ route, state }),
  };
  return { ctx, reads, writes, navigated, changes, signal };
}

async function mountScreen(module: { mount: (a: ElementoFalso, c: unknown) => Promise<unknown> }, path: string, read: (route: string) => Promise<unknown>, write?: (route: string, body: unknown, options: unknown) => Promise<unknown>): Promise<Mounted> {
  const u = new URL(path, 'http://127.0.0.1');
  here.pathname = u.pathname;
  here.search = u.search;
  const area = new ElementoFalso('main');
  const c = context(read, write);
  const cleanup = (await module.mount(area, c.ctx)) as (() => void) | undefined;
  const m: Mounted = { area, reads: c.reads, writes: c.writes, navigated: c.navigated, change: (x) => c.changes.forEach((f) => f(x)), leave: () => (c.signal.abort(), cleanup?.()) };
  open.push(m);
  return m;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const GITHUB = { github: { state: 'connected', login: 'dev-sintetico', scopes: ['repo', 'read:org', 'project'], source: 'console' } };
const MACHINES = [{ id: 'local', label: 'Esta máquina', state: 'connected' }, { id: 'workstation', label: 'Workstation', state: 'connected', port: 14720 }];

describe('issue 277: Conexões, the catalog (C57, C60, C61)', () => {
  test('a core without the cloud routes (404) keeps the GitHub detail at /ui/connections, as before', async () => {
    const m = await mountScreen(connections, '/ui/connections', async (route) => {
      if (route === '/api/connectors') throw notFound();
      return GITHUB;
    });
    assert.deepEqual(m.reads, ['/api/connectors', '/api/connections']);
    assert.ok(m.area.querySelector('section.conn-card'), 'the GitHub detail');
    assert.equal(m.area.querySelector('.cl-conn'), null);
  });

  test('with the routes: GitHub and AWS under Conectadas, the Em breve cards to add, and every session of every machine', async () => {
    const m = await mountScreen(connections, '/ui/connections', async (route) => {
      if (route === '/api/connectors') return connectorsBody();
      if (route === '/api/connections') return GITHUB;
      if (route === '/api/machines') return MACHINES;
      if (route === '/api/machines/workstation/connectors') return { machine: 'workstation', status: 'ok', ...connectorsBody(aws({ sessions: [session({ expiresAt: iso(NOW - 9 * 3_600_000) })] })) };
      throw new Error(`unexpected ${route}`);
    });
    const ids = (grid: string) => m.area.querySelectorAll(`[data-grid="${grid}"] .card`).map((c) => c.getAttribute('data-connector') ?? c.getAttribute('data-card'));
    assert.deepEqual(ids('connected'), ['github', 'aws']);
    assert.deepEqual(ids('add'), ['gcp', 'azure', 'other']);
    assert.match(texto(m.area.querySelector('[data-connector="aws"]')), /1 sessão expirada/);
    assert.equal(m.area.querySelector('[data-connector="github"] a[data-cl-action="open-github"]')!.getAttribute('href'), '/ui/connections/github');
    const rows = m.area.querySelectorAll('[data-card="all-sessions"] tbody tr').map((r) => `${r.getAttribute('data-machine')}:${r.getAttribute('data-session')}`);
    assert.deepEqual(rows, ['workstation:sessao-exemplo', 'local:sessao-exemplo']);
    // Entrar opens that machine's AWS screen, which starts the login (the click's history state carries it).
    m.area.querySelector('[data-card="all-sessions"] tr[data-machine="workstation"] button[data-cl-action="login"]')!.click();
    assert.deepEqual(m.navigated, [{ route: '/ui/connections/aws?machine=workstation&login=sessao-exemplo', state: { startLogin: 'sessao-exemplo' } }]);
    assert.deepEqual(m.writes, [], 'the catalog itself writes nothing');
  });

  test('no cloud configured: the dashed "Nenhuma nuvem conectada" card, and AWS under Adicionar with aws configure sso', async () => {
    const m = await mountScreen(connections, '/ui/connections', async (route) => {
      if (route === '/api/connectors') return connectorsBody(aws({ state: 'not-configured', sessions: [], outOfScope: [] }));
      if (route === '/api/connections') return GITHUB;
      return [];
    });
    assert.ok(m.area.querySelector('[data-grid="connected"] [data-card="no-cloud"]'));
    const card = m.area.querySelector('[data-grid="add"] [data-connector="aws"]')!;
    assert.match(texto(card), /Não configurada/);
    assert.match(texto(card), /aws configure sso/);
    assert.equal(m.area.querySelector('[data-card="all-sessions"]'), null, 'no remote machine, no list');
  });
});

describe('issue 277: Conexões › AWS (C58, C59)', () => {
  test('the sessions with their profiles; Entrar POSTs the browser mode, the waiting band shows the time and the command; Cancelar DELETEs', async () => {
    let state = connectorsBody();
    const m = await mountScreen(
      awsScreen,
      '/ui/connections/aws',
      async (route) => (route === '/api/connectors' ? state : route === '/api/machines' ? [MACHINES[0]] : null),
      async (route, _body, options) => {
        const running = login({ state: 'running', mode: 'browser', startedAt: new Date().toISOString(), startedBy: 'ui' });
        state = connectorsBody(aws({ sessions: [session({ login: (options as { method?: string })?.method === 'DELETE' ? login({ state: 'canceled', endedAt: new Date().toISOString() }) : running })] }));
        return { login: (state.connectors[0] as { sessions: Obj[] }).sessions[0]!.login };
      },
    );
    const card = () => m.area.querySelector('section[data-session="sessao-exemplo"]')!;
    assert.deepEqual(card().querySelectorAll('tbody tr').map((r) => texto(r.querySelector('td'))), ['perfil-dev', 'perfil-dados']);
    assert.match(texto(m.area.querySelector('[data-card="out-of-scope"]')), /perfil-chave/);
    assert.equal(m.area.querySelector('.cl-seg'), null, 'no remote machine: no selector');
    card().querySelector('button[data-cl-action="login"]')!.click();
    await until(() => Boolean(card()?.querySelector('.cl-band-running')));
    assert.deepEqual(m.writes[0], { route: '/api/connectors/aws/sessions/sessao-exemplo/login', body: { mode: 'browser' }, options: undefined });
    assert.match(texto(card()), /Entrando em sessao-exemplo…/);
    assert.match(texto(card()), /0:0\d de 5:00/);
    assert.match(texto(card()), /Roda: aws sso login --sso-session sessao-exemplo · até 5 min/);
    card().querySelector('button[data-cl-action="cancel"]')!.click();
    await until(() => Boolean(card()?.querySelector('.cl-band-error')));
    assert.deepEqual(m.writes[1], { route: '/api/connectors/aws/sessions/sessao-exemplo/login', body: null, options: { method: 'DELETE' } });
    assert.match(texto(card()), /O login foi cancelado\./);
  });

  test('a remote machine: Entrar asks for the device code over there, shown big with the AWS link and Copiar o código', async () => {
    let state: Obj = { machine: 'workstation', status: 'ok', ...connectorsBody() };
    (globalThis as unknown as { history: { state: unknown } }).history.state = { startLogin: 'sessao-exemplo' };
    const m = await mountScreen(
      awsScreen,
      '/ui/connections/aws?machine=workstation&login=sessao-exemplo',
      async (route) => (route === '/api/machines' ? MACHINES : route === '/api/machines/workstation/connectors' ? state : null),
      async () => {
        state = { machine: 'workstation', status: 'ok', ...connectorsBody(aws({ sessions: [session({ login: login({ state: 'running', mode: 'device-code', startedAt: new Date().toISOString(), deviceCode: DEVICE }) })] })) };
        return { login: login({ state: 'running', mode: 'device-code', startedAt: new Date().toISOString(), deviceCode: DEVICE }) };
      },
    );
    await until(() => Boolean(m.area.querySelector('.cl-user-code')));
    assert.equal(m.writes[0]!.route, '/api/machines/workstation/connectors/aws/sessions/sessao-exemplo/login', 'the catalog click started it once');
    assert.equal(replaced.at(-1), '/ui/connections/aws?machine=workstation', 'the login flag leaves the URL');
    assert.equal(texto(m.area.querySelector('.cl-user-code')), 'ABCD-EFGH');
    const link = m.area.querySelector('a[data-cl-action="open-login"]')!;
    assert.equal(link.getAttribute('href'), 'https://device.sso.regiao-exemplo-1.amazonaws.com/');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(texto(m.area), /Copiar o código/);
    assert.match(texto(m.area), /Roda lá: aws sso login --sso-session sessao-exemplo --use-device-code --no-browser/);
    assert.deepEqual(m.area.querySelectorAll('.cl-seg button').map((b) => texto(b)), ['Este Mac', 'Workstation']);
  });

  test('a cold link with ?login= (no click from this page) starts nothing', async () => {
    (globalThis as unknown as { history: { state: unknown } }).history.state = null;
    const m = await mountScreen(awsScreen, '/ui/connections/aws?login=sessao-exemplo', async (route) => (route === '/api/connectors' ? connectorsBody() : []));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(m.writes, []);
  });
});

describe('issue 277: the Perfis de nuvem card (C66, C67)', () => {
  function card(machineId: string, read: (route: string) => Promise<unknown>, write?: (route: string, body: unknown, options: unknown) => Promise<unknown>) {
    const c = context(read, write);
    const profiles = cloudProfiles(c.ctx, machineId);
    open.push({ area: new ElementoFalso('main'), reads: c.reads, writes: c.writes, navigated: [], change: (x) => c.changes.forEach((f) => f(x)), leave: () => c.signal.abort() });
    return { ...c, profiles, change: (x: unknown[]) => c.changes.forEach((f) => f(x)) };
  }

  test('nothing is read before the first paint; a core without the routes hides the card', async () => {
    const c = card('local', async () => Promise.reject(notFound()));
    assert.deepEqual(c.reads, []);
    const node = c.profiles.node('Esta máquina');
    await until(() => c.reads.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(node.hasAttribute('hidden'));
    assert.equal(c.profiles.node('Esta máquina'), node, 'the same element across repaints');
  });

  test('this Mac: one row per session with its state and Entrar; a connector change re-reads', async () => {
    const c = card('local', async () => connectorsBody(aws({ sessions: [session(), session({ name: 'sessao-lab', state: 'valid', expiresAt: iso(Date.now() + 3_600_000) })] })));
    const node = c.profiles.node('Esta máquina');
    await until(() => !node.hasAttribute('hidden'));
    assert.deepEqual(node.querySelectorAll('tbody tr').map((r) => r.getAttribute('data-session')), ['sessao-exemplo', 'sessao-lab']);
    assert.deepEqual(node.querySelectorAll('tbody button').map((b) => texto(b)), ['Entrar', 'Entrar de novo']);
    assert.match(texto(node), /deste Mac · lidos do ~\/.aws\/config daqui/);
    assert.equal(node.querySelector('a.cl-link')!.getAttribute('href'), '/ui/connections');
    c.change([{ type: 'connector', key: 'aws' }]);
    await until(() => c.reads.length === 2);
    c.change([{ type: 'alert', key: 'local:x' }]);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.reads.length, 2, 'only a connector change');
  });

  test('a remote core without the login route (404 without reason): the command to run over there, with Copiar', async () => {
    const c = card(
      'workstation',
      async () => ({ machine: 'workstation', status: 'ok', ...connectorsBody() }),
      async () => Promise.reject(Object.assign(new Error('não encontrado'), { status: 404, body: { error: 'não encontrado' } })),
    );
    const node = c.profiles.node('Workstation');
    await until(() => !node.hasAttribute('hidden'));
    assert.match(texto(node), /da Workstation · lidos pelo núcleo de lá, pelo túnel/);
    node.querySelector('button[data-cl-action="login"]')!.click();
    await until(() => Boolean(node.querySelector('.cl-band-neutral')));
    assert.equal(c.writes[0]!.route, '/api/machines/workstation/connectors/aws/sessions/sessao-exemplo/login');
    assert.match(texto(node), /O núcleo de lá não sabe entrar sozinho\./);
    assert.equal(texto(node.querySelector('.cl-band-neutral .cl-config')), 'aws sso login --sso-session sessao-exemplo --use-device-code');
    assert.ok(node.querySelector('.cl-band-neutral button[data-cl-action="copy"]'));
  });

  test('a remote is polled every 30 s; one that stops answering keeps the last reading, faded, without Entrar', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    try {
      let status = 'ok';
      const c = card('workstation', async () => (status === 'ok' ? { machine: 'workstation', status: 'ok', ...connectorsBody() } : { machine: 'workstation', status: 'unreachable', reason: 'port-closed', connectors: [] }));
      const node = c.profiles.node('Workstation');
      await flush();
      assert.ok(node.querySelector('button[data-cl-action="login"]'));
      assert.equal(c.reads.length, 1);
      status = 'unreachable';
      mock.timers.tick(29_000);
      await flush();
      assert.equal(c.reads.length, 1, 'not before 30 s');
      mock.timers.tick(1_000);
      await flush();
      assert.equal(c.reads.length, 2);
      assert.ok(node.classList.contains('cl-faded'));
      assert.deepEqual(node.querySelectorAll('tbody tr').map((r) => r.getAttribute('data-session')), ['sessao-exemplo'], 'the last reading');
      assert.equal(node.querySelector('button[data-cl-action="login"]'), null);
      assert.match(texto(node), /Sem conexão: estes são os de \d\d:\d\d\. Entrar volta quando a Workstation responder\./);
    } finally {
      mock.timers.reset();
    }
  });
});
