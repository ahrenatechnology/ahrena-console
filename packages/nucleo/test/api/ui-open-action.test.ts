// The shared "open the session where it runs" action of the /ui (#285, C70 and C71): what it shows
// per target, what the click sends and the states beside the button. The writer is a stub: nothing
// here reaches a core, a terminal or the Claude Desktop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const { describeOpenAction, openAction, openedText, openRoute, stateOfAnswer, SUCCESS_MS } = await import('../../ui/open-action.js');
// @ts-expect-error: idem
const { ICON_NAMES } = await import('../../ui/dom.js');

const UUID = '4d2a9c35-1b7e-4c11-9d0a-2f6c8e1a7b30';
const COMMAND = `cd '/tmp/demo' && claude --resume ${UUID}`;

type Call = { route: string; body: unknown };
/** A writer stub: records the call and answers with `answer` (or throws it, when it is an Error). */
function stubWriter(answer: unknown) {
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const write = async (route: string, body: unknown) => {
    calls.push({ route, body });
    await gate;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { write, calls, release };
}
function writeError(message: string, status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(message), { name: 'WriteError', status, body });
}
const settle = () => new Promise((ok) => setTimeout(ok, 0));
const byClass = (root: ElementoFalso, c: string) => root.querySelectorAll(`.${c}`);
const clickEvent = () => ({ type: 'click' }) as { type: string; defaultPrevented?: boolean };

describe('open action: what it shows per target', () => {
  test('the five targets: label, icon, title and disabled', () => {
    assert.deepEqual(
      ['desktop', 'terminal', 'terminal-live'].map((target) => {
        const d = describeOpenAction({ target, command: null });
        return [d.label, d.icon, d.title, d.disabled, d.external];
      }),
      [
        ['Abrir no Claude Desktop', 'monitor', 'Abre a conversa no Claude Desktop', false, true],
        ['Abrir no terminal', 'terminal', 'Abre o terminal padrão e roda claude --resume na pasta da sessão', false, true],
        ['Ir para o terminal', 'square-terminal', 'Já roda num terminal; traz a janela à frente', false, false],
      ],
    );
    const remote = describeOpenAction({ target: 'remote', command: null }, { machine: 'ws-exemplo' });
    assert.deepEqual([remote.label, remote.disabled, remote.where, remote.smallLabel], ['Abrir no terminal', true, 'roda em ws-exemplo', 'Roda em ws-exemplo']);
    const unknown = describeOpenAction({ target: 'remote', command: null });
    assert.deepEqual([unknown.where, unknown.smallLabel, unknown.title], ['roda em outra máquina', 'Roda em outra máquina', 'A sessão roda em outra máquina']);
    assert.equal(describeOpenAction({ target: 'none', command: null }), null);
    assert.equal(describeOpenAction(undefined), null);
    for (const t of ['desktop', 'terminal', 'terminal-live']) assert.ok(ICON_NAMES.includes(describeOpenAction({ target: t }).icon));
    assert.ok(ICON_NAMES.includes('server') && ICON_NAMES.includes('external') && ICON_NAMES.includes('copy'));
  });

  test('the success text by `opened`, and the failure keeps the core text and its command', () => {
    assert.deepEqual(['desktop', 'terminal', 'focused'].map(openedText), ['Aberta no Claude Desktop', 'Aberta no terminal', 'Terminal à frente']);
    assert.deepEqual(stateOfAnswer({ ok: true, opened: 'focused' }), { kind: 'ok', text: 'Terminal à frente' });
    assert.deepEqual(stateOfAnswer(null, writeError('Nenhum terminal respondeu', 502, { error: 'x', command: COMMAND })), { kind: 'fail', text: 'Nenhum terminal respondeu', command: COMMAND });
    assert.deepEqual(stateOfAnswer(null, writeError('Sem pasta', 422, { error: 'Sem pasta' })), { kind: 'fail', text: 'Sem pasta', command: null });
    assert.equal(openRoute(UUID), `/api/sessions/${UUID}/open`);
  });

  test('the DOM per size: full has the label and the external mark, small the label, icon only the icon with aria-label', () => {
    const full = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'full' }) as ElementoFalso;
    const fullButton = full.querySelector('button')!;
    assert.equal(texto(fullButton), 'Abrir no Claude Desktop');
    assert.equal(fullButton.querySelectorAll('svg').length, 2, 'monitor and the external mark');
    assert.equal(full.querySelector('.open-status')!.getAttribute('role'), 'status');
    assert.equal(full.querySelector('.open-status')!.getAttribute('aria-live'), 'polite');

    const small = openAction({ id: UUID, open: { target: 'terminal', command: COMMAND } }, { size: 'small' }) as ElementoFalso;
    assert.equal(texto(small.querySelector('button')), 'Abrir no terminal');
    assert.equal(small.querySelector('button')!.querySelectorAll('svg').length, 1, 'no external mark in the foot');

    const live = openAction({ id: UUID, open: { target: 'terminal-live', command: COMMAND } }, { size: 'icon' }) as ElementoFalso;
    const iconButton = live.querySelector('button')!;
    assert.equal(texto(iconButton), '');
    assert.equal(iconButton.getAttribute('aria-label'), 'Ir para o terminal');
    assert.equal(iconButton.getAttribute('title'), 'Já roda num terminal; traz a janela à frente');

    const remoteFull = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'full' }) as ElementoFalso;
    assert.equal(remoteFull.querySelector('button')!.getAttribute('aria-disabled'), 'true');
    assert.equal(texto(remoteFull), 'Abrir no terminal roda em outra máquina');
    const remoteSmall = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'small', machine: 'ws-exemplo' }) as ElementoFalso;
    assert.equal(texto(remoteSmall), 'Roda em ws-exemplo');
    const remoteIcon = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'icon', machine: 'ws-exemplo' }) as ElementoFalso;
    assert.equal(remoteIcon.querySelector('button')!.getAttribute('title'), 'A sessão roda em ws-exemplo');

    assert.equal(openAction({ id: 'demo-1', open: { target: 'none', command: null } }, { size: 'icon' }), null, 'none: no button at all');
  });
});

describe('open action: the click', () => {
  test('busy "Abrindo…" with the button disabled, then the success beside it, gone after a while', async () => {
    for (const [target, opened, text] of [['desktop', 'desktop', 'Aberta no Claude Desktop'], ['terminal', 'terminal', 'Aberta no terminal'], ['terminal-live', 'focused', 'Terminal à frente']]) {
      const w = stubWriter({ ok: true, opened });
      const root = openAction({ id: UUID, open: { target, command: null } }, { size: 'full', write: w.write, successMs: 20 }) as ElementoFalso;
      const button = root.querySelector('button')!;
      const ev = clickEvent();
      button.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true);
      assert.deepEqual(w.calls, [{ route: `/api/sessions/${UUID}/open`, body: {} }]);
      assert.equal(texto(root.querySelector('.open-status')), 'Abrindo…');
      assert.ok(button.hasAttribute('disabled'));
      button.click();
      assert.equal(w.calls.length, 1, 'a click while in flight sends nothing');
      w.release();
      await settle();
      assert.ok(!button.hasAttribute('disabled'));
      assert.equal(texto(root.querySelector('.open-status')), text);
      assert.equal(byClass(root, 'open-copy').length, 0);
      await new Promise((ok) => setTimeout(ok, 40));
      assert.equal(texto(root.querySelector('.open-status')), '', 'the success fades');
    }
    assert.equal(SUCCESS_MS, 4000);
  });

  test('an error with a command shows the core text and "Copiar comando", which copies it', async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
    const w = stubWriter(writeError('Nenhum app de terminal respondeu', 502, { error: 'Nenhum app de terminal respondeu', command: COMMAND }));
    w.release();
    const root = openAction({ id: UUID, open: { target: 'terminal', command: COMMAND } }, { size: 'full', write: w.write }) as ElementoFalso;
    root.querySelector('button')!.click();
    await settle();
    assert.equal(texto(root.querySelector('.open-fail')), 'Nenhum app de terminal respondeu');
    const copy = root.querySelector('.open-copy')!;
    assert.equal(texto(copy), 'Copiar comando');
    copy.click();
    await settle();
    assert.deepEqual(copied, [COMMAND], 'the command of the answer, not screen text');
    assert.equal(texto(copy), 'Copiado');
  });

  test('an error without a command shows only the text; the remote button sends nothing', async () => {
    const w = stubWriter(writeError('A sessão não tem pasta para abrir', 422, { error: 'A sessão não tem pasta para abrir' }));
    w.release();
    const root = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'icon', write: w.write }) as ElementoFalso;
    root.querySelector('button')!.click();
    await settle();
    assert.equal(texto(root.querySelector('.open-status')), 'A sessão não tem pasta para abrir');
    assert.equal(byClass(root, 'open-copy').length, 0);

    const r = stubWriter({ ok: true });
    const remote = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'icon', write: r.write }) as ElementoFalso;
    remote.querySelector('button')!.click();
    assert.equal(r.calls.length, 0);
  });

  test('a click inside the action never reaches the card or row around it', () => {
    const w = stubWriter({ ok: true, opened: 'desktop' });
    const row = documentoFalso.createElement('tr');
    let navigated = 0;
    row.addEventListener('click', () => void navigated++);
    const root = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'icon', write: w.write }) as ElementoFalso;
    row.append(root);
    root.querySelector('button')!.click();
    root.querySelector('.open-status')!.click();
    assert.equal(navigated, 0);
    assert.equal(w.calls.length, 1);
    w.release();
  });
});

test('open-action.css: only open- classes, no colour by hand, loaded once by index.html', () => {
  const css = readFileSync(`${UI_FOLDER}open-action.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const shell = new Set([...readFileSync(`${UI_FOLDER}shell.css`, 'utf8').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const own = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))].filter((c) => !shell.has(c));
  assert.deepEqual(own.filter((c) => !c.startsWith('open-')), [], 'own class without the open- prefix');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i);
  const page = readFileSync(`${UI_FOLDER}index.html`, 'utf8');
  assert.equal(page.match(/href="\/ui\/open-action\.css"/g)?.length, 1);
});

// ---------- The Detail (C70): the action in the header row, beside Atualizar, and nowhere else ----------

describe('Detail: the open action in the header (C70)', () => {
  const head = (extra: Record<string, unknown> = {}) => ({
    session: {
      id: UUID,
      title: 'Retry com backoff na fila',
      status: 'waiting',
      attention: { level: 'idle', reason: 'turn_ended' },
      since: new Date().toISOString(),
      startedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      model: 'claude-sonnet-5-5',
      cwd: '/tmp/demo',
      banner: null,
    },
    counts: { agents: 1, events: 96 },
    cost: null,
    branch: 'feat/9-retry',
    endedAt: null,
    command: null,
    local: 'local_00000000-0000-4000-8000-000000000000',
    opensSession: true,
    open: { target: 'desktop', command: null },
    ...extra,
  });

  async function mountDetail(data: Record<string, unknown>, write: (route: string, body: unknown) => Promise<unknown>) {
    Object.assign(globalThis, { location: { hash: '', pathname: `/ui/sessions/${UUID}`, search: '' }, history: { replaceState() {} } });
    // @ts-expect-error: browser module, plain JavaScript
    const { mount } = await import('../../ui/screens/session-detail.js');
    const area = documentoFalso.createElement('main');
    const base = `/api/sessions/${UUID}`;
    const abort = () => Object.assign(new Error('left'), { name: 'AbortError' });
    const ctx = {
      params: { id: UUID },
      read: async (route: string) => {
        if (route === base) return data;
        throw abort();
      },
      write,
      title() {},
      onChange() {},
      onRestart() {},
      navigate() {},
    };
    const leave = await mount(area, ctx);
    return { area, leave };
  }

  test('idle: the button sits in the header row, before Atualizar; the idle line has none', async () => {
    const w = stubWriter({ ok: true, opened: 'desktop' });
    const { area, leave } = await mountDetail(head(), w.write);
    try {
      const row = area.querySelector('.sd-row')!;
      const kids = row.children;
      const action = row.querySelector('.open-action')!;
      assert.ok(action, 'the action is in the header row');
      assert.equal(kids[kids.indexOf(action) + 1]!.getAttribute('class'), 'sd-refresh', 'right before Atualizar');
      assert.equal(texto(action.querySelector('button')), 'Abrir no Claude Desktop');
      const idle = area.querySelector('.sd-idle')!;
      assert.ok(idle, 'the idle line is drawn');
      assert.equal(idle.querySelectorAll('button').length, 0, 'no open button in the idle line');
      action.querySelector('button')!.click();
      assert.deepEqual(w.calls, [{ route: `/api/sessions/${UUID}/open`, body: {} }]);
      w.release();
    } finally {
      leave?.();
    }
  });

  test('blocked: the yellow band has no button; a terminal session says so in the header', async () => {
    const blocked = head({
      session: { ...head().session, attention: { level: 'blocked', reason: 'permission' }, banner: { type: 'permission', text: 'Pede permissão para npm run migrate', since: new Date().toISOString() } },
      command: 'npm run migrate',
      local: null,
      open: { target: 'terminal', command: COMMAND },
    });
    const { area, leave } = await mountDetail(blocked, stubWriter({}).write);
    try {
      const band = area.querySelector('.sd-band')!;
      assert.ok(band, 'the band is drawn');
      assert.equal(band.querySelectorAll('button').length, 0, 'no open button in the band');
      assert.equal(texto(area.querySelector('.sd-row .open-action button')), 'Abrir no terminal');
      assert.equal(area.querySelectorAll('.open-action').length, 1, 'one action on the page');
    } finally {
      leave?.();
    }
  });

  test('none: no button in the header', async () => {
    const { area, leave } = await mountDetail(head({ open: { target: 'none', command: null } }), stubWriter({}).write);
    try {
      assert.equal(area.querySelectorAll('.open-action').length, 0);
      assert.ok(area.querySelector('.sd-refresh'));
    } finally {
      leave?.();
    }
  });
});

// ---------- Sessions (C71): the icon in the row's last cell ----------

describe('Sessions: the open icon in the row (C71)', () => {
  const row = (id: string, open: Record<string, unknown> | undefined) => ({
    id,
    title: `Sessão ${id}`,
    status: 'active',
    attention: null,
    lastActivity: new Date().toISOString(),
    running: true,
    durationMs: 12 * 60_000,
    agents: 1,
    costUsd: 1.84,
    cwd: '/tmp/demo',
    account: null,
    open,
  });
  const LIST = {
    items: [row(UUID, { target: 'desktop', command: null }), row('b91d04aa-0000-4000-8000-000000000001', { target: 'terminal', command: COMMAND }), row('c3f09b52-0000-4000-8000-000000000002', { target: 'terminal-live', command: COMMAND }), row('demo-1', { target: 'none', command: null })],
    page: 1,
    pages: 1,
    total: 4,
    perPage: 10,
    registered: 4,
    directories: [],
    counts: {},
  };

  test('monitor, terminal and square terminal by target; none leaves the cell empty; the click opens without navigating the row', async () => {
    Object.assign(globalThis, { location: { hash: '', pathname: '/ui/sessions', search: '' }, history: { replaceState() {} } });
    // @ts-expect-error: browser module, plain JavaScript
    const { mount } = await import('../../ui/screens/sessions.js');
    const area = documentoFalso.createElement('main');
    const navigated: string[] = [];
    const w = stubWriter({ ok: true, opened: 'terminal' });
    const leave = await mount(area, { params: {}, read: async () => LIST, write: w.write, navigate: (r: string) => void navigated.push(r), onChange() {}, onRestart() {}, title() {} });
    try {
      const cells = area.querySelectorAll('td.sessions-open');
      assert.equal(cells.length, 4, 'every row keeps the cell');
      assert.deepEqual(
        cells.map((c) => c.querySelector('button')?.getAttribute('aria-label') ?? null),
        ['Abrir no Claude Desktop', 'Abrir no terminal', 'Ir para o terminal', null],
      );
      assert.deepEqual(
        cells.slice(0, 3).map((c) => c.querySelector('button')!.getAttribute('data-open-target')),
        ['desktop', 'terminal', 'terminal-live'],
      );
      cells[1]!.querySelector('button')!.click();
      assert.deepEqual(navigated, [], 'the row does not navigate');
      assert.deepEqual(w.calls.map((c) => c.route), ['/api/sessions/b91d04aa-0000-4000-8000-000000000001/open']);
      w.release();
      await settle();
      assert.equal(texto(cells[1]!.querySelector('.open-status')), 'Aberta no terminal');
      // The rest of the row still opens the Detail.
      cells[0]!.parentNode!.querySelector('td.st')!.click();
      assert.deepEqual(navigated, [`/ui/sessions/${UUID}`]);
    } finally {
      leave?.();
    }
  });
});

// ---------- Dashboard (C71): the icon beside "Abrir ›" in the "precisam de você" inbox ----------

describe('Dashboard: the open icon in the inbox (C71)', () => {
  test('the icon sits beside "Abrir ›", outside any link; its click opens without following the card link; a remote card has none', async () => {
    // @ts-expect-error: browser module, plain JavaScript
    const dashboard = await import('../../ui/screens/dashboard.js');
    const numbers = { sessions: { total: 2, active: 0, waiting: 2, withError: 0 }, agents: { active: 0, sessions: 0 }, subagents: { active: 0, sessions: 0 }, events: { today: 0, lastHour: 0, total: 0 }, cost: { usd: 0, days: 30, unpriced: [] } };
    const attention = {
      total: 2,
      items: [
        { session: UUID, title: 'Migração', project: 'motor-de-regras', level: 'needs', reason: 'permission', shortReason: 'Pede permissão', longReason: 'pede permissão', minutes: 2, machine: null, open: { target: 'terminal-live', command: COMMAND } },
        { session: 'r1', title: 'Remota', project: 'painel', level: 'needs', reason: 'question', shortReason: 'Fez uma pergunta', longReason: 'x', minutes: 3, machine: { id: 'ws', label: 'ws-exemplo' }, open: { target: 'remote', command: null } },
      ],
    };
    const area = documentoFalso.createElement('main');
    const signal = new AbortController();
    const w = stubWriter({ ok: true, opened: 'focused' });
    const cleanup = await dashboard.mount(area, {
      read: async (route: string) => (route === '/api/dashboard' ? { numbers, agents: [], activity: [] } : attention),
      write: w.write,
      signal: signal.signal,
      onChange: () => {},
      onRestart: () => {},
      counter: () => {},
      navigate: () => {},
    });
    try {
      const minis = area.querySelectorAll('.mini');
      assert.equal(minis.length, 2);
      const actions = minis[0]!.querySelector('.dash-mini-actions')!;
      assert.equal(texto(actions), 'Abrir ›');
      const button = actions.querySelector('button')!;
      assert.equal(button.getAttribute('aria-label'), 'Ir para o terminal');
      assert.equal(button.closest('a'), null, 'the button is not inside a link');
      assert.equal(actions.querySelector('a')!.getAttribute('href'), `/ui/sessions/${UUID}`, '"Abrir ›" still goes to the Detail');
      let reached = 0;
      minis[0]!.addEventListener('click', () => void reached++);
      const ev = clickEvent();
      button.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true);
      assert.equal(reached, 0, 'the card does not see the click');
      assert.deepEqual(w.calls.map((c) => c.route), [`/api/sessions/${UUID}/open`]);
      w.release();
      await settle();
      assert.equal(texto(actions.querySelector('.open-status')), 'Terminal à frente');
      assert.equal(minis[1]!.querySelectorAll('button').length, 0, 'remote: the foot names the machine, no icon');
    } finally {
      signal.abort();
      cleanup?.();
    }
  });
});
