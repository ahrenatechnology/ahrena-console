// Conexões (issue 241, wireframe C39 to C41 and C44) mounted on the fake DOM: every state of
// `GET /api/connections`, the writes and how their refusals are phrased, the live re-read, the
// countdown and the poll of a pending code, and `?start=1`. No network: the screen gets a fake transport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// The GitHub detail: at /ui/connections/github once Conexões is the catalog of connectors (#277); at
// /ui/connections with a core without the cloud routes (ui-clouds.test.ts covers that fallback).
const here = { pathname: '/ui/connections/github', search: '' };
const replaced: string[] = [];
Object.assign(globalThis, {
  location: here,
  history: { state: null as unknown, replaceState(s: unknown, _t: string, url: string) { this.state = s; replaced.push(url); here.search = new URL(url, 'http://x').search; } },
});

// @ts-expect-error: browser module, plain JavaScript
const { mount, providerPill, countdown, pollDelay, verificationLink, requiredScopes, START_ROUTE, CANCEL_ROUTE, DISCONNECT_ROUTE, SOURCE_ROUTE } = await import('../../ui/screens/connections.js');
// @ts-expect-error: idem
const { WriteError, ReadError } = await import('../../ui/api.js');
// @ts-expect-error: idem
const { findScreen, SCREENS } = await import('../../ui/screens.js');

type Status = Record<string, unknown>;
const BASE = { source: 'console', sourceFrom: 'default', vault: 'keychain', clientId: 'cid', ghInstalled: true, requiredScopes: ['repo', 'read:org', 'project'] };
const disconnected = (extra: Status = {}): Status => ({ ...BASE, state: 'disconnected', lastError: null, ...extra });
const pending = (extra: Status = {}): Status => ({ ...BASE, state: 'pending', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 14 * 60_000 + 12_000).toISOString(), interval: 5, ...extra });
const connected = (extra: Status = {}): Status => ({
  ...BASE,
  state: 'connected',
  login: 'dev-sintetico',
  scopes: ['repo', 'read:org', 'project'],
  missingScopes: [],
  scopesChecked: true,
  orgs: [{ login: 'exemplo-labs', access: 'granted' }],
  orgsChecked: true,
  revokeUrl: 'https://github.com/settings/connections/applications/cid',
  ...extra,
});
const unavailable = (reason: string, extra: Status = {}): Status => ({ ...BASE, state: 'unavailable', reason, ...extra });

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  writes: { route: string; body: unknown }[];
  navigated: string[];
  change: (c: unknown[]) => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

async function mountWith({ read, write, search = '', state = null }: { read: (route: string) => Promise<unknown>; write?: (route: string, body: unknown) => Promise<unknown>; search?: string; state?: unknown }): Promise<Mounted> {
  here.search = search;
  (globalThis as unknown as { history: { state: unknown } }).history.state = state;
  replaced.length = 0;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: Mounted['writes'] = [];
  const navigated: string[] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const signal = new AbortController();
  const ctx = {
    params: {},
    signal: signal.signal,
    read: (route: string) => (reads.push(route), read(route)),
    write: (route: string, body: unknown) => (writes.push({ route, body }), (write ?? (() => Promise.reject(new Error('no writer'))))(route, body)),
    onChange: (f: (c: unknown[]) => void) => changes.push(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (r: string) => navigated.push(r),
  };
  const cleanup = await mount(area, ctx);
  const m: Mounted = { area, reads, writes, navigated, change: (c) => changes.forEach((f) => f(c)), leave: () => (signal.abort(), cleanup?.()) };
  open.push(m);
  return m;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const card = (m: Mounted) => m.area.querySelector('section.conn-card')!;
const button = (m: Mounted, action: string) => m.area.querySelector(`[data-action="${action}"]`);
const answer = (github: Status) => async () => ({ github });

describe('Conexões: the registry and the files', () => {
  test('the last item of Controle, at /ui/connections, with the plug icon', () => {
    const { screen } = findScreen('/ui/connections');
    assert.equal(screen.id, 'connections');
    assert.equal(screen.file, '/ui/screens/connections.js');
    assert.deepEqual(SCREENS.find((s: { id: string }) => s.id === 'connections').item, { label: 'Conexões', icon: 'plug', section: 'control' });
    const control = SCREENS.filter((s: { item?: { section: string } }) => s.item?.section === 'control').map((s: { id: string }) => s.id);
    assert.equal(control.at(-1), 'connections');
  });

  test('every class of connections.css is conn-*, and the screen loads it', () => {
    const css = readFileSync(`${UI_FOLDER}screens/connections.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const own = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))].filter((c) => !['btn', 'icon', 'on', 'filled', 'outline'].includes(c));
    assert.deepEqual(own.filter((c) => !c.startsWith('conn-')), []);
    assert.match(readFileSync(`${UI_FOLDER}screens/connections.js`, 'utf8'), /\/ui\/screens\/connections\.css/);
  });
});

describe('Conexões: the pure parts', () => {
  test('the pill of each state', () => {
    assert.deepEqual(providerPill(disconnected()), { label: 'não conectado', tone: 'waiting' });
    assert.deepEqual(providerPill(disconnected({ lastError: 'expired' })), { label: 'não conectado', tone: 'error' });
    assert.deepEqual(providerPill(pending()), { label: 'esperando a autorização', tone: 'waiting', busy: true });
    assert.deepEqual(providerPill(connected()), { label: 'conectado', tone: 'completed' });
    assert.deepEqual(providerPill(connected({ missingScopes: ['project'] })), { label: 'conectado, incompleto', tone: 'waiting' });
    assert.deepEqual(providerPill(unavailable('no-vault')), { label: 'indisponível', tone: 'waiting' });
  });

  test('the countdown never goes below zero; the poll honours interval between 2 and 10 s', () => {
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);
    assert.equal(countdown(new Date(now + 852_000).toISOString(), now), '14:12');
    assert.equal(countdown(new Date(now - 5000).toISOString(), now), '0:00');
    assert.equal(countdown('not a date', now), null);
    assert.equal(pollDelay({ interval: 5 }), 5000);
    assert.equal(pollDelay({ interval: 1 }), 2000);
    assert.equal(pollDelay({ interval: 60 }), 10000);
    assert.equal(pollDelay({}), 5000);
  });

  test('the verification link is https on github.com only', () => {
    assert.deepEqual(verificationLink({ verificationUri: 'https://github.com/login/device' }), { href: 'https://github.com/login/device', label: 'Abrir github.com/login/device' });
    for (const bad of ['http://github.com/login/device', 'https://evil.example/login/device', 'javascript:alert(1)', 'https://user:pw@github.com/login/device', null]) {
      assert.equal(verificationLink({ verificationUri: bad }), null, String(bad));
    }
  });

  test('the scopes come from requiredScopes, or the default three', () => {
    assert.deepEqual(requiredScopes({ requiredScopes: ['repo'] }), ['repo']);
    assert.deepEqual(requiredScopes({}), ['repo', 'read:org', 'project']);
  });
});

describe('Conexões: every state (C39 to C41, C44)', () => {
  test('C39 disconnected: Conectar, the three scopes with why, the vault, the source and the screens waiting', async () => {
    const m = await mountWith({ read: answer(disconnected()) });
    assert.deepEqual(m.reads, ['/api/connections']);
    assert.match(texto(m.area.querySelector('header.cc-head')), /Conexões Ao vivo .* nunca sai do Keychain\./);
    assert.equal(card(m).getAttribute('data-state'), 'disconnected');
    assert.match(texto(card(m).querySelector('.conn-title')), /GitHub não conectado/);
    assert.equal(texto(button(m, 'connect')), 'Conectar ao GitHub');
    assert.deepEqual(card(m).querySelectorAll('li.conn-scope').map((l) => l.getAttribute('data-scope')), ['repo', 'read:org', 'project']);
    assert.match(texto(card(m).querySelector('[data-scope="project"]')), /Ler os Projects e mover um card no Kanban do projeto\./);
    assert.match(texto(card(m)), /O console só escreve no GitHub em dois casos/);
    assert.match(texto(m.area.querySelector('[data-card="vault"]')), /Cofre Keychain do macOS Item dev\.ahrena\.console\.github/);
    assert.match(texto(m.area.querySelector('[data-card="source"]')), /Ahrena Console Login do gh desta máquina/);
    assert.equal(m.area.querySelector('[data-source="console"]')!.getAttribute('aria-pressed'), 'true');
    const used = m.area.querySelector('[data-card="used-by"]')!;
    assert.deepEqual(used.querySelectorAll('a').map((a) => a.getAttribute('href')), ['/ui/repos', '/ui/project', '/ui/dev-console', '/ui/adrs']);
    assert.equal((texto(used).match(/esperando a conexão/g) ?? []).length, 4);
  });

  for (const [lastError, title] of [
    ['expired', 'O código expirou antes da autorização'],
    ['denied', 'Você recusou no GitHub'],
    ['github-error', 'O GitHub não completou a conexão'],
    ['vault-error', 'Não deu para guardar a credencial'],
  ] as const) {
    test(`C44 lastError ${lastError}: "${title}" and Gerar outro código`, async () => {
      const m = await mountWith({ read: answer(disconnected({ lastError })) });
      assert.equal(card(m).getAttribute('data-last-error'), lastError);
      assert.equal(texto(card(m).querySelector('.conn-message-title')), title);
      assert.equal(texto(button(m, 'connect')), 'Gerar outro código');
      assert.ok(card(m).querySelector('.conn-pill-error'));
      assert.doesNotMatch(texto(m.area), new RegExp(`\\b${lastError}\\b`), 'never the raw code');
    });
  }

  test('C92 revoked (#372): what happened, the three causes, Reconectar como <login> and the security log', async () => {
    assert.deepEqual(providerPill(disconnected({ lastError: 'revoked' })), { label: 'precisa reconectar', tone: 'error' });
    const m = await mountWith({ read: answer(disconnected({ lastError: 'revoked', login: 'dev-sintetico', securityLogUrl: 'https://github.com/settings/security-log' })) });
    assert.equal(card(m).getAttribute('data-last-error'), 'revoked');
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'O GitHub não aceita mais a credencial de dev-sintetico');
    assert.match(texto(card(m)), /respondeu que ela não vale mais \(401\)/);
    assert.equal(card(m).querySelectorAll('li.conn-cause').length, 3);
    assert.match(texto(card(m)), /mais de dez credenciais/);
    assert.equal(texto(button(m, 'connect')), 'Reconectar como dev-sintetico');
    const log = card(m).querySelectorAll('a').find((a) => a.getAttribute('href') === 'https://github.com/settings/security-log')!;
    assert.equal(log.getAttribute('target'), '_blank');
    assert.match(texto(card(m).querySelector('.conn-pill-error')), /precisa reconectar/);
    assert.doesNotMatch(texto(m.area), /\brevoked\b/, 'never the raw code');
  });

  test('C92 revoked without a login: the generic title and Reconectar', async () => {
    const m = await mountWith({ read: answer(disconnected({ lastError: 'revoked' })) });
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'O GitHub não aceita mais a credencial guardada');
    assert.equal(texto(button(m, 'connect')), 'Reconectar');
    assert.equal(card(m).querySelectorAll('a').filter((a) => /security-log/.test(a.getAttribute('href') ?? '')).length, 0, 'no securityLogUrl, no link');
  });

  test('C40 pending: the code with Copiar, the github.com link in a new tab, the countdown and Cancelar', async () => {
    const m = await mountWith({ read: answer(pending()) });
    assert.equal(card(m).getAttribute('data-state'), 'pending');
    assert.equal(texto(card(m).querySelector('.conn-user-code')), 'WDJB-MJHT');
    assert.equal(texto(button(m, 'copy')), 'Copiar código');
    const a = button(m, 'open-github')!;
    assert.equal(a.tagName, 'A');
    assert.equal(a.getAttribute('href'), 'https://github.com/login/device');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(texto(a), 'Abrir github.com/login/device');
    assert.match(texto(card(m).querySelector('.conn-expires')), /^expira em 14:1[12]$/);
    assert.match(texto(card(m).querySelector('.conn-waiting')), /Esta tela muda sozinha/);
    assert.equal(texto(button(m, 'cancel')), 'Cancelar');
    assert.match(texto(m.area), /Ninguém do console pede esse código por mensagem/);
  });

  test('C40 pending with a verification address that is not https on github.com: no link', async () => {
    const m = await mountWith({ read: answer(pending({ verificationUri: 'https://phishing.example/login/device' })) });
    assert.equal(button(m, 'open-github'), null);
    assert.equal(m.area.querySelectorAll('a').filter((a) => /phishing/.test(a.getAttribute('href') ?? '')).length, 0);
    assert.match(texto(card(m)), /Abra github\.com\/login\/device no navegador/);
  });

  test('C41 connected: the login, the granted scopes, Reconectar and Desconectar, the screens working', async () => {
    const m = await mountWith({ read: answer(connected()) });
    assert.equal(card(m).getAttribute('data-state'), 'connected');
    assert.match(texto(card(m).querySelector('.conn-account')), /dev-sintetico pelo device flow do console/);
    assert.deepEqual(card(m).querySelectorAll('li.conn-scope').map((l) => l.getAttribute('data-ok')), ['true', 'true', 'true']);
    assert.equal(texto(button(m, 'reconnect')), 'Reconectar');
    assert.equal(texto(button(m, 'disconnect')), 'Desconectar');
    assert.match(texto(m.area.querySelector('[data-card="vault"]')), /Conta dev-sintetico/);
    assert.equal((texto(m.area.querySelector('[data-card="used-by"]')).match(/funcionando/g) ?? []).length, 4);
    const orgs = m.area.querySelectorAll('[data-card="orgs"] li.conn-org');
    assert.deepEqual(orgs.map((o) => `${o.getAttribute('data-org')}:${o.getAttribute('data-access')}`), ['exemplo-labs:granted']);
    assert.match(texto(orgs[0]!), /exemplo-labs liberada/);
  });

  test('#336 organizations: the ones the token sees, the pending ones with their links, and where to approve the hidden ones', async () => {
    const m = await mountWith({
      read: answer(
        connected({
          orgs: [
            {
              login: 'estudio-ficticio',
              access: 'pending',
              approvalUrl: 'https://github.com/organizations/estudio-ficticio/settings/oauth_application_policy',
              requestUrl: 'https://github.com/settings/connections/applications/cid',
            },
            { login: '<img src=x onerror=alert(1)>', access: 'pending', approvalUrl: 'javascript:alert(1)', requestUrl: 'https://evil.example/x' },
            { login: 'exemplo-labs', access: 'granted' },
          ],
        }),
      ),
    });
    const section = m.area.querySelector('[data-card="orgs"]')!;
    const orgs = section.querySelectorAll('li.conn-org');
    assert.equal(orgs.length, 3);
    assert.match(texto(orgs[0]!), /estudio-ficticio acesso pendente · aprovar \(dono\) · pedir/);
    assert.deepEqual(orgs[0]!.querySelectorAll('a').map((a) => a.getAttribute('href')), [
      'https://github.com/organizations/estudio-ficticio/settings/oauth_application_policy',
      'https://github.com/settings/connections/applications/cid',
    ]);
    assert.equal(orgs[1]!.querySelector('a'), null, 'a link off https github.com is dropped');
    assert.equal(texto(orgs[1]!.querySelector('.conn-trunc')), '<img src=x onerror=alert(1)>', 'GitHub data is text, never HTML');
    assert.match(texto(orgs[2]!), /exemplo-labs liberada/);
    assert.match(texto(section), /O GitHub esconde as organizações que ainda não aprovaram o Ahrena Console\./);
    assert.match(texto(section), /Third-party access › OAuth app policy/);
    assert.ok(section.querySelectorAll('a').some((a) => a.getAttribute('href') === 'https://github.com/settings/connections/applications/cid'));
  });

  test('#336 Conferir de novo posts the orgs route', async () => {
    const m = await mountWith({ read: answer(connected()), write: async () => ({ github: connected({ orgsChecked: false }) }) });
    const recheck = m.area.querySelector('[data-card="orgs"] [data-action="recheck-orgs"]')!;
    assert.equal(texto(recheck), 'Conferir de novo');
    recheck.click();
    await tick();
    assert.deepEqual(m.writes.map((w) => w.route), ['/api/connections/github/orgs']);
    assert.match(texto(m.area.querySelector('[data-card="orgs"]')), /Conferindo as organizações…/);
  });

  test('C44 missing scopes: the missing one marked, what stops working and Reconectar', async () => {
    const m = await mountWith({ read: answer(connected({ scopes: ['repo', 'read:org'], missingScopes: ['project'] })) });
    assert.deepEqual(card(m).querySelectorAll('li.conn-scope').map((l) => `${l.getAttribute('data-scope')}:${l.getAttribute('data-ok')}`), ['repo:true', 'read:org:true', 'project:false']);
    assert.match(texto(card(m).querySelector('[data-scope="project"]')), /falta · Ler os Projects/);
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'Falta o escopo project');
    assert.match(texto(card(m).querySelector('.conn-message')), /O Kanban do projeto não lê nem move cards\. Reconectar pede os três escopos de novo\./);
    assert.ok(button(m, 'reconnect-scopes'));
  });

  test('C44 no-client-id: Conectar disabled, the explanation and Como configurar', async () => {
    const m = await mountWith({ read: answer(unavailable('no-client-id', { clientId: null })) });
    assert.equal(card(m).getAttribute('data-reason'), 'no-client-id');
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'Build de desenvolvimento sem o aplicativo do GitHub');
    assert.ok(button(m, 'connect')!.hasAttribute('disabled'));
    assert.doesNotMatch(texto(card(m)), /AHRENA_CONSOLE_GITHUB_CLIENT_ID|montado do código/, 'no environment variable on the screen: that is for developers');
    const how = card(m).querySelectorAll('a').find((a) => /^Como configurar/.test(texto(a)))!;
    assert.match(how.getAttribute('href')!, /^https:\/\/docs\.github\.com\/en\//);
  });

  test('C44 no-vault: nowhere safe; with gh installed, Usar o login do gh posts the gh source', async () => {
    const m = await mountWith({ read: answer(unavailable('no-vault', { vault: null })), write: async () => ({ github: connected({ source: 'gh', sourceFrom: 'settings', revokeUrl: undefined }) }) });
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'Não há onde guardar a credencial com segurança');
    assert.match(texto(m.area.querySelector('[data-card="vault"]')), /Cofre Nenhum nesta máquina/);
    button(m, 'use-gh')!.click();
    await tick();
    assert.deepEqual(m.writes, [{ route: SOURCE_ROUTE, body: { source: 'gh' } }]);
    assert.equal(card(m).getAttribute('data-state'), 'connected');
    assert.ok(m.area.querySelector('[data-band="gh"]'));
  });

  test('C44 no-vault without gh: no gh button', async () => {
    const m = await mountWith({ read: answer(unavailable('no-vault', { vault: null, ghInstalled: false })) });
    assert.equal(button(m, 'use-gh'), null);
  });

  for (const [reason, title] of [
    ['gh-not-installed', 'O gh não está instalado nesta máquina'],
    ['gh-not-authenticated', 'O gh desta máquina não tem login'],
  ] as const) {
    test(`C44 ${reason}: "${title}" and Voltar ao padrão`, async () => {
      const m = await mountWith({ read: answer(unavailable(reason, { source: 'gh', sourceFrom: 'settings' })) });
      assert.equal(texto(card(m).querySelector('.conn-message-title')), title);
      assert.ok(m.area.querySelector('[data-band="gh"]'));
      assert.ok(card(m).querySelector('[data-action="source-console"]'));
    });
  }

  test('C44 github-off: the core started with --no-github', async () => {
    const m = await mountWith({ read: answer(unavailable('github-off')) });
    assert.equal(texto(card(m).querySelector('.conn-message-title')), 'O núcleo subiu sem o GitHub');
    assert.equal(button(m, 'connect'), null);
  });

  test('C44 the gh source: the band, Voltar ao padrão posts console; no Desconectar, no organizations', async () => {
    let github = connected({ source: 'gh', sourceFrom: 'settings', revokeUrl: undefined, orgsChecked: false });
    const m = await mountWith({ read: async () => ({ github }), write: async () => ((github = connected()), { github }) });
    const band = m.area.querySelector('[data-band="gh"]')!;
    assert.match(texto(band), /Usando o login do gh\. A fonte desta máquina é o gh auth, escolhida em Conexões\. Desconectar aqui não mexe no gh\./);
    assert.equal(button(m, 'disconnect'), null);
    assert.equal(m.area.querySelector('[data-card="orgs"]'), null);
    assert.match(texto(card(m).querySelector('.conn-account')), /pelo login do gh desta máquina/);
    band.querySelector('[data-action="source-console"]')!.click();
    await tick();
    assert.deepEqual(m.writes, [{ route: SOURCE_ROUTE, body: { source: 'console' } }]);
    assert.equal(m.area.querySelector('[data-band="gh"]'), null);
  });

  test('C44 the gh source from AHRENA_CONSOLE_GITHUB_SOURCE: the screen does not switch it', async () => {
    const m = await mountWith({ read: answer(connected({ source: 'gh', sourceFrom: 'env', revokeUrl: undefined })) });
    assert.match(texto(m.area.querySelector('[data-band="gh"]')), /por AHRENA_CONSOLE_GITHUB_SOURCE=gh/);
    assert.equal(m.area.querySelector('[data-band="gh"] button'), null);
    assert.ok(m.area.querySelectorAll('[data-card="source"] button').every((b) => b.hasAttribute('disabled')));
    assert.match(texto(m.area.querySelector('[data-card="source"]')), /Definida por AHRENA_CONSOLE_GITHUB_SOURCE/);
  });

  test('a read failure: the error state with Tentar de novo', async () => {
    const m = await mountWith({
      read: async () => {
        throw new ReadError('O núcleo em 127.0.0.1:4720 não respondeu', { status: 0 });
      },
    });
    assert.match(texto(m.area.querySelector('section.state')), /Sem conexão com o núcleo/);
  });
});

describe('Conexões: the writes (contract)', () => {
  test('Conectar posts start and draws the code it answers', async () => {
    const m = await mountWith({ read: answer(disconnected()), write: async () => ({ github: pending() }) });
    button(m, 'connect')!.click();
    await tick();
    assert.deepEqual(m.writes, [{ route: START_ROUTE, body: {} }]);
    assert.equal(START_ROUTE, '/api/connections/github/start');
    assert.equal(texto(m.area.querySelector('.conn-user-code')), 'WDJB-MJHT');
  });

  test('Cancelar posts cancel and goes back to disconnected', async () => {
    const m = await mountWith({ read: answer(pending()), write: async () => ({ github: disconnected() }) });
    button(m, 'cancel')!.click();
    await tick();
    assert.deepEqual(m.writes.map((w) => w.route), [CANCEL_ROUTE]);
    assert.equal(card(m).getAttribute('data-state'), 'disconnected');
  });

  test('Desconectar asks first: the dialog names the login, links Revogar no GitHub, Cancelar closes it and Desconectar posts', async () => {
    const m = await mountWith({ read: answer(connected()), write: async () => ({ github: disconnected() }) });
    button(m, 'disconnect')!.click();
    const dialog = m.area.querySelector('[role="dialog"]')!;
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(texto(dialog), /^Desconectar dev-sintetico\? Apagamos a credencial do cofre/);
    const revoke = dialog.querySelectorAll('a').find((a) => /Revogar no GitHub/.test(texto(a)))!;
    assert.equal(revoke.getAttribute('href'), 'https://github.com/settings/connections/applications/cid');
    assert.equal(revoke.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(m.writes.length, 0, 'nothing is written before the confirmation');
    button(m, 'dialog-cancel')!.click();
    assert.equal(m.area.querySelector('[role="dialog"]'), null);
    button(m, 'disconnect')!.click();
    button(m, 'confirm-disconnect')!.click();
    await tick();
    assert.deepEqual(m.writes.map((w) => w.route), [DISCONNECT_ROUTE]);
    assert.equal(card(m).getAttribute('data-state'), 'disconnected');
    assert.equal(m.area.querySelector('[role="dialog"]'), null);
  });

  test('the dialog without a revokeUrl that is https on github.com: no revoke link', async () => {
    const m = await mountWith({ read: answer(connected({ revokeUrl: 'http://github.com/x' })) });
    button(m, 'disconnect')!.click();
    assert.equal(m.area.querySelector('[role="dialog"] a'), null);
  });

  test('the source switch posts { source } and draws the answer', async () => {
    const m = await mountWith({ read: answer(disconnected()), write: async (_r, body) => ({ github: (body as { source: string }).source === 'gh' ? connected({ source: 'gh', sourceFrom: 'settings' }) : disconnected() }) });
    m.area.querySelector('[data-source="gh"]')!.click();
    await tick();
    assert.deepEqual(m.writes, [{ route: SOURCE_ROUTE, body: { source: 'gh' } }]);
    assert.equal(m.area.querySelector('[data-source="gh"]')!.getAttribute('aria-pressed'), 'true');
  });

  // Every refusal of the four writes, phrased: never the machine code.
  for (const [status, body, phrase] of [
    [409, { error: 'github-unavailable', reason: 'no-client-id' }, 'Build de desenvolvimento sem o aplicativo do GitHub.'],
    [409, { error: 'github-unavailable', reason: 'no-vault' }, 'Não há onde guardar a credencial com segurança.'],
    [409, { error: 'source-is-gh' }, 'A fonte é o login do gh: conectar e desconectar ficam com o gh. Volte ao padrão para usar a conexão do console.'],
    [502, { error: 'github-error' }, 'O GitHub recusou o pedido do código. Tente de novo em instantes.'],
    [400, { error: 'invalid' }, 'O núcleo recusou o pedido.'],
    [409, { error: 'gh-not-installed' }, 'O gh não está instalado nesta máquina.'],
    [403, { error: 'forbidden' }, 'O núcleo só aceita esse pedido da própria janela do console.'],
    [0, null, 'O núcleo não respondeu.'],
  ] as const) {
    test(`a refused start (${status} ${body?.error ?? 'no answer'}): "${phrase}", then the screen re-reads`, async () => {
      const m = await mountWith({
        read: answer(disconnected()),
        write: async () => {
          throw new WriteError(body?.error ?? 'x', { status, body });
        },
      });
      button(m, 'connect')!.click();
      await tick();
      await tick();
      const band = m.area.querySelector('.error-band')!;
      assert.equal(texto(band.querySelector('p')), `Não deu certo. ${phrase}`);
      if (body) assert.doesNotMatch(texto(band), new RegExp(String(body.error)));
      assert.deepEqual(m.reads, ['/api/connections', '/api/connections']);
    });
  }
});

describe('Conexões: state (live, poll, countdown, ?start=1)', () => {
  test('a connections change re-reads; another type does not', async () => {
    let github = disconnected();
    const m = await mountWith({ read: async () => ({ github }) });
    m.change([{ type: 'session', key: 's' }]);
    assert.equal(m.reads.length, 1);
    github = connected();
    m.change([{ type: 'connections', key: 'github' }]);
    await tick();
    assert.equal(m.reads.length, 2);
    assert.equal(card(m).getAttribute('data-state'), 'connected');
  });

  test('pending advances by itself: it re-reads after interval and draws connected', async () => {
    let n = 0;
    const m = await mountWith({ read: async () => ({ github: n++ === 0 ? pending({ interval: 1 }) : connected() }) });
    assert.equal(card(m).getAttribute('data-state'), 'pending');
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(card(m).getAttribute('data-state'), 'connected');
    assert.ok(m.reads.length >= 2);
  });

  test('the countdown ticks every second without redrawing the card', async () => {
    const m = await mountWith({ read: answer(pending({ expiresAt: new Date(Date.now() + 65_000).toISOString() })) });
    const node = card(m).querySelector('.conn-expires')!;
    const first = texto(node);
    await new Promise((r) => setTimeout(r, 1100));
    assert.notEqual(texto(node), first);
    assert.equal(card(m).querySelector('.conn-expires'), node, 'the same node');
  });

  test('?start=1 (the C42 button) starts the flow once and takes the flag out of the URL', async () => {
    const m = await mountWith({ read: answer(disconnected()), write: async () => ({ github: pending() }), search: '?start=1', state: { startConnect: true } });
    assert.deepEqual(m.writes, [{ route: START_ROUTE, body: {} }]);
    assert.deepEqual(replaced, ['/ui/connections']);
    assert.equal(card(m).getAttribute('data-state'), 'pending');
  });

  test('?start=1 when already connected or pending writes nothing', async () => {
    for (const github of [connected(), pending(), unavailable('no-client-id')]) {
      const m = await mountWith({ read: answer(github), search: '?start=1', state: { startConnect: true } });
      assert.deepEqual(m.writes, [], String(github.state));
    }
  });

  test('?start=1 on a cold load (a link another site opened, no history state) starts nothing', async () => {
    const m = await mountWith({ read: answer(disconnected()), write: async () => ({ github: pending() }), search: '?start=1' });
    assert.deepEqual(m.writes, []);
    assert.deepEqual(replaced, ['/ui/connections'], 'the flag still leaves the URL');
    assert.equal(card(m).getAttribute('data-state'), 'disconnected');
  });
});
