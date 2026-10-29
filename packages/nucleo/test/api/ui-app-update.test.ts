// The app's update notice on /ui (issue 330, wireframes C77 to C80): the card on top of every screen and
// the version panel. The pure formats, the card for each state, where the page is (app, browser, read-only),
// the panel for each state and the wiring in index.html and app.js. No network: the core's answers are made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const up = await import('../../ui/app-update.js');
// @ts-expect-error: idem
const { useWriter } = await import('../../ui/api.js');

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
type Obj = Record<string, unknown>;
const view = (extra: Obj = {}): Obj => ({
  app: true,
  appVersion: '0.0.9',
  mode: 'dev',
  available: { version: '0.0.10', notes: 'Aviso de versão nova no topo da /ui', publishedAt: null },
  dismissed: false,
  phase: 'idle',
  progress: null,
  error: null,
  lastCheckAt: NOW - 3 * 60_000,
  nextCheckAt: NOW + 7 * 60_000,
  updated: null,
  requests: { check: 0, install: 0 },
  ...extra,
});

function buttons(node: ElementoFalso | null): ElementoFalso[] {
  const found: ElementoFalso[] = [];
  const walk = (n: ElementoFalso) => {
    if (n.tagName?.toLowerCase() === 'button') found.push(n);
    n.children.forEach(walk);
  };
  if (node) walk(node);
  return found;
}
const labelled = (node: ElementoFalso | null, label: string) => buttons(node).find((b) => texto(b) === label);

describe('formats', () => {
  test('a span, the bytes and the percent', () => {
    assert.equal(up.span(10_000), 'menos de 1 min');
    assert.equal(up.span(3 * 60_000), '3 min');
    assert.equal(up.span(3 * 3_600_000 + 5 * 60_000), '3 h');
    assert.equal(up.megabytes({ done: 5_200_000, total: 12_400_000 }), '5,2 de 12,4 MB');
    assert.equal(up.megabytes({ done: 5_200_000, total: null }), '5,2 MB');
    assert.equal(up.percent({ done: 5_200_000, total: 12_400_000 }), 41);
    assert.equal(up.percent({ done: 5, total: null }), null);
  });

  test('the cadence line and the mode', () => {
    assert.equal(up.cadence(view(), NOW), 'verificado há 3 min · próxima em 7 min');
    assert.equal(up.cadence(view({ lastCheckAt: null }), NOW), null);
    assert.equal(up.cadence(view({ nextCheckAt: NOW - 1 }), NOW), 'verificado há 3 min · próxima em instantes');
    assert.deepEqual(up.modeText(view()), { pill: 'modo dev', every: 'a cada 10 min' });
    assert.deepEqual(up.modeText(view({ mode: 'stable' })), { pill: 'estável', every: 'a cada 6 h' });
  });
});

describe('the card (C77, C78)', () => {
  test('which state shows a card', () => {
    assert.equal(up.noticeOf(null), null);
    assert.equal(up.noticeOf(view({ app: false })), null, 'no app: nothing');
    assert.equal(up.noticeOf(view({ available: null })), null);
    assert.equal(up.noticeOf(view({ dismissed: true })), null, 'Depois hides it');
    assert.equal(up.noticeOf(view())?.kind, 'available');
    assert.equal(up.noticeOf(view({ phase: 'downloading' }))?.kind, 'downloading');
    assert.equal(up.noticeOf(view({ phase: 'installing' }))?.kind, 'installing');
    assert.equal(up.noticeOf(view({ phase: 'error', error: 'download' }))?.kind, 'error');
    assert.equal(up.noticeOf(view({ phase: 'error', error: 'offline', dismissed: true })), null, 'a failed manual check shows in the panel only');
    assert.equal(up.noticeOf(view({ phase: 'error', error: 'offline' }))?.kind, 'available');
    assert.equal(up.noticeOf(view({ available: null, appVersion: '0.0.10', updated: { from: '0.0.9', to: '0.0.10', notes: 'x' } }))?.kind, 'done');
    assert.equal(up.hasUpdate(view({ dismissed: true })), true, 'the dot survives Depois');
    assert.equal(up.hasUpdate(view({ app: false })), false);
  });

  test('available: Atualizar and Depois in the app, and the clicks go to the núcleo', () => {
    const acts: unknown[][] = [];
    const card = up.drawNotice(view(), { where: 'app', act: (...a: unknown[]) => acts.push(a) });
    assert.match(texto(card), /Atualização disponível: versão 0\.0\.10/);
    assert.match(texto(card), /Você está na versão 0\.0\.9 · Aviso de versão nova no topo da \/ui/);
    labelled(card, 'Atualizar')!.click?.();
    labelled(card, 'Depois')!.click?.();
    assert.deepEqual(acts, [['install'], ['dismiss', '0.0.10']]);
  });

  test('in a browser Atualizar is off and says it is in the app; Depois still works', () => {
    const card = up.drawNotice(view(), { where: 'browser', act: () => {} });
    assert.equal(labelled(card, 'Atualizar')!.hasAttribute('disabled'), true);
    assert.match(texto(card), /Atualizar é no app/);
    assert.equal(labelled(card, 'Depois')!.hasAttribute('disabled'), false);
  });

  test('Tentar de novo restarts the app like Atualizar: off in a browser, in the card and in the panel', () => {
    const failed = view({ phase: 'error', error: 'download' });
    assert.equal(labelled(up.drawNotice(failed, { where: 'browser', act: () => {} }), 'Tentar de novo')!.hasAttribute('disabled'), true);
    assert.equal(labelled(up.drawPanel(failed, { where: 'browser', act: () => {}, now: NOW }), 'Tentar de novo')!.hasAttribute('disabled'), true);
    assert.equal(labelled(up.drawNotice(failed, { where: 'app', act: () => {} }), 'Tentar de novo')!.hasAttribute('disabled'), false);
  });

  test('read-only (the artifact): both buttons are off, with the reason', () => {
    const card = up.drawNotice(view(), { where: 'read-only', act: () => {} });
    for (const b of buttons(card)) {
      assert.equal(b.hasAttribute('disabled'), true);
      assert.equal(b.getAttribute('title'), 'No app do Ahrena Console');
    }
  });

  test('downloading shows the bar and the MB, with no buttons', () => {
    const card = up.drawNotice(view({ phase: 'downloading', progress: { done: 5_200_000, total: 12_400_000 } }), { where: 'app', act: () => {} });
    assert.match(texto(card), /Baixando a versão 0\.0\.10…/);
    assert.match(texto(card), /5,2 de 12,4 MB/);
    assert.equal(buttons(card).length, 0);
  });

  test('error: red, says you stay where you were, and offers Tentar de novo; a bad signature says so', () => {
    const acts: unknown[][] = [];
    const card = up.drawNotice(view({ phase: 'error', error: 'download' }), { where: 'app', act: (...a: unknown[]) => acts.push(a) });
    assert.match(card.getAttribute('class'), /up-err/);
    assert.match(texto(card), /Não deu para atualizar para a 0\.0\.10/);
    assert.match(texto(card), /Você está na versão 0\.0\.9/);
    labelled(card, 'Tentar de novo')!.click?.();
    assert.deepEqual(acts, [['install']]);
    assert.match(texto(up.drawNotice(view({ phase: 'error', error: 'signature' }), { where: 'app', act: () => {} })), /A assinatura não confere/);
  });

  test('done: green, what changed, Fechar', () => {
    const card = up.drawNotice(view({ available: null, appVersion: '0.0.10', updated: { from: '0.0.9', to: '0.0.10', notes: 'O que mudou' } }), { where: 'app', act: () => {} });
    assert.match(card.getAttribute('class'), /up-ok/);
    assert.match(texto(card), /Atualizado para a versão 0\.0\.10/);
    assert.match(texto(card), /O que mudou/);
    assert.ok(labelled(card, 'Fechar'));
  });

  test('release notes are text, never HTML', () => {
    const card = up.drawNotice(view({ available: { version: '0.0.10', notes: '<img src=x onerror=alert(1)>', publishedAt: null } }), { where: 'app', act: () => {} });
    assert.match(texto(card), /<img src=x onerror=alert\(1\)>/);
  });
});

describe('the panel (C79, C80)', () => {
  const panel = (v: Obj, where = 'app', act = () => {}) => up.drawPanel(v, { where, act, now: NOW });

  test('up to date: the version, the check and the cadence of the mode', () => {
    const acts: unknown[][] = [];
    const p = panel(view({ available: null }), 'app', (...a: unknown[]) => acts.push(a));
    assert.match(texto(p), /Você está na versão mais nova/);
    assert.match(texto(p), /0\.0\.9 · conferido há 3 min/);
    assert.match(texto(p), /modo dev/);
    assert.match(texto(p), /verificado há 3 min · próxima em 7 min/);
    assert.match(texto(p), /Consulta a cada 10 min \(modo dev\)/);
    labelled(p, 'Buscar agora')!.click?.();
    assert.deepEqual(acts, [['check']]);
  });

  test('stable: the pill and the 6 h', () => {
    const p = panel(view({ available: null, mode: 'stable' }));
    assert.match(texto(p), /estável/);
    assert.match(texto(p), /Consulta a cada 6 h/);
    assert.doesNotMatch(texto(p), /modo dev/);
  });

  test('available, checking, downloading and the two errors', () => {
    assert.match(texto(panel(view())), /Versão 0\.0\.10 disponível/);
    assert.ok(labelled(panel(view()), 'Atualizar'));
    assert.equal(labelled(panel(view(), 'browser'), 'Atualizar')!.hasAttribute('disabled'), true);
    assert.match(texto(panel(view({ phase: 'checking' }))), /Procurando…/);
    assert.equal(labelled(panel(view({ phase: 'checking' })), 'Buscar agora')!.hasAttribute('disabled'), true);
    assert.match(texto(panel(view({ phase: 'downloading', progress: { done: 1_000_000, total: 10_000_000 } }))), /Baixando a 0\.0\.10…/);
    assert.match(texto(panel(view({ phase: 'error', error: 'offline' }))), /Sem rede/);
    assert.match(texto(panel(view({ phase: 'error', error: 'channel-down' }))), /Canal fora do ar/);
    assert.ok(labelled(panel(view({ phase: 'error', error: 'offline' })), 'Tentar de novo'));
  });

  test('without the app: it explains, and the button is off', () => {
    const p = panel({ app: false });
    assert.match(texto(p), /Sem o app do Ahrena Console nesta máquina/);
    assert.equal(labelled(p, 'Buscar agora')!.hasAttribute('disabled'), true);
  });

  test('read-only: Buscar agora is off', () => {
    assert.equal(labelled(panel(view({ available: null }), 'read-only'), 'Buscar agora')!.hasAttribute('disabled'), true);
  });
});

describe('the wiring', () => {
  const nodes = () => {
    const panelNode = new ElementoFalso('div');
    panelNode.setAttribute('hidden', '');
    return { noticeNode: new ElementoFalso('div'), panelNode };
  };

  test('refresh draws the card; an old core without the route draws nothing; a click re-draws with the answer', async () => {
    useWriter(async () => view({ dismissed: true }));
    const n = nodes();
    let answer: Obj | Error = view();
    const widget = up.createAppUpdate({ read: async () => (answer instanceof Error ? Promise.reject(answer) : answer), write: async () => view({ dismissed: true }), ...n, win: { __AHRENA_APP__: true } });
    await widget.refresh();
    assert.match(texto(n.noticeNode), /Atualização disponível/);
    assert.equal(n.noticeNode.hasAttribute('hidden'), false);
    await widget.act('dismiss', '0.0.10');
    assert.equal(n.noticeNode.hasAttribute('hidden'), true, 'Depois hides the card');
    answer = new Error('404');
    await widget.refresh();
    assert.equal(n.noticeNode.hasAttribute('hidden'), true);
  });

  test('the panel opens and closes, and follows the state while open', async () => {
    useWriter(async () => view());
    const n = nodes();
    let current = view({ available: null });
    const widget = up.createAppUpdate({ read: async () => current, write: async () => current, ...n, win: { __AHRENA_APP__: true } });
    await widget.refresh();
    assert.equal(n.panelNode.hasAttribute('hidden'), true);
    assert.equal(widget.toggle(), true);
    assert.match(texto(n.panelNode), /Você está na versão mais nova/);
    current = view();
    await widget.refresh();
    assert.match(texto(n.panelNode), /Versão 0\.0\.10 disponível/);
    widget.close();
    assert.equal(n.panelNode.hasAttribute('hidden'), true);
  });

  test('the "Atualizado" card goes away by itself after 10 s, by an ack', async () => {
    useWriter(async () => view());
    const n = nodes();
    const sent: string[] = [];
    let timer: (() => void) | null = null;
    const widget = up.createAppUpdate({
      read: async () => view({ available: null, updated: { from: '0.0.9', to: '0.0.10', notes: null } }),
      write: async (route: string) => (sent.push(route), view({ available: null })),
      ...n,
      win: { __AHRENA_APP__: true },
      setTimer: (f: () => void, ms: number) => ((timer = f), assert.equal(ms, up.DONE_MS), 1),
      clearTimer: () => {},
    });
    await widget.refresh();
    assert.match(texto(n.noticeNode), /Atualizado para a versão 0\.0\.10/);
    timer!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ['/api/app-update/actions/ack']);
    assert.equal(n.noticeNode.hasAttribute('hidden'), true);
  });

  test('the "Atualizado" timeout runs only in the app window and only while the page is visible', async () => {
    for (const [win, starts] of [[{ __AHRENA_APP__: true, document: { visibilityState: 'hidden' } }, false], [{ document: { visibilityState: 'visible' } }, false], [{ __AHRENA_APP__: true, document: { visibilityState: 'visible' } }, true]] as const) {
      useWriter(async () => view());
      let started = 0;
      const widget = up.createAppUpdate({ read: async () => view({ available: null, updated: { from: '0.0.9', to: '0.0.10', notes: null } }), write: async () => view(), ...nodes(), win, setTimer: () => (started++, 1), clearTimer: () => {} });
      await widget.refresh();
      assert.equal(started > 0, starts);
    }
  });

  test('Atualizar shows busy at once, ignores a second click, and stays busy while the núcleo only counted it', async () => {
    useWriter(async () => view());
    const n = nodes();
    const sent: string[] = [];
    let release: (() => void) | null = null;
    const widget = up.createAppUpdate({
      read: async () => view({ requests: { check: 0, install: 1 } }),
      write: (route: string) => (sent.push(route), new Promise<Obj>((r) => (release = () => r(view({ requests: { check: 0, install: 1 } }))))),
      ...n,
      win: { __AHRENA_APP__: true },
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await widget.refresh();
    const going = widget.act('install');
    const busy = labelled(n.noticeNode, 'Iniciando…');
    assert.ok(busy, 'the button says the click went out before the answer');
    assert.equal(busy!.getAttribute('aria-busy'), 'true');
    assert.equal(labelled(n.noticeNode, 'Depois')!.hasAttribute('disabled'), true);
    await widget.act('install');
    assert.deepEqual(sent, ['/api/app-update/actions/install'], 'a second click sends nothing');
    release!();
    await going;
    await widget.refresh();
    assert.ok(labelled(n.noticeNode, 'Iniciando…'), 'the app has not moved yet: still busy');
  });

  test('the busy state ends when the app moves, when the click fails, or after PENDING_MS', async () => {
    for (const ending of ['phase', 'fail', 'timeout'] as const) {
      useWriter(async () => view());
      const n = nodes();
      let current = view();
      let timer: (() => void) | null = null;
      const widget = up.createAppUpdate({
        read: async () => current,
        write: async () => (ending === 'fail' ? Promise.reject(new Error('404')) : current),
        ...n,
        win: { __AHRENA_APP__: true },
        setTimer: (f: () => void, ms: number) => (ms === up.PENDING_MS ? (timer = f) : null, 1),
        clearTimer: () => {},
      });
      await widget.refresh();
      widget.toggle();
      await widget.act('check');
      if (ending === 'fail') {
        assert.ok(labelled(n.panelNode, 'Buscar agora'), ending);
        continue;
      }
      assert.ok(labelled(n.panelNode, 'Buscando…'), ending);
      assert.equal(labelled(n.panelNode, 'Atualizar')!.hasAttribute('disabled'), true, 'the other button waits');
      if (ending === 'phase') {
        current = view({ phase: 'idle', lastCheckAt: NOW });
        await widget.refresh();
      } else timer!();
      assert.ok(labelled(n.panelNode, 'Buscar agora'), ending);
    }
  });

  test('index.html has the strip above the main area and the panel; app.js wires the footer version', () => {
    const page = readFileSync(`${UI_FOLDER}index.html`, 'utf8');
    assert.match(page, /<div class="cc-notice" id="update-notice" hidden><\/div>\s*<main class="cc-main" id="content"><\/main>/);
    assert.match(page, /<div class="up-pop" id="update-panel" hidden><\/div>/);
    assert.match(page, /href="\/ui\/app-update\.css"/);
    const app = readFileSync(`${UI_FOLDER}app.js`, 'utf8');
    assert.match(app, /if \(appUpdateChanged\(changes\)\) appUpdate\.refresh\(\)/);
    assert.match(app, /class: 'version up-version mono'/);
  });
});
