// Choosing the Project of the project kanban (issue 241, wireframe C43 and the C44 band): the list with
// search, owner filter and closed toggle, the field that becomes columns, Usar, the options errors, the
// AHRENA_CONSOLE_PROJECT band and "Trocar de Project" on the board. Fake DOM, fake transport.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const picker = await import('../../ui/screens/project-picker.js');
// @ts-expect-error: idem
const { mount } = await import('../../ui/screens/project.js');
// @ts-expect-error: idem
const { ReadError, WriteError } = await import('../../ui/api.js');

const P = (owner: string, number: number, title: string, extra: Record<string, unknown> = {}) => ({ owner, ownerType: owner === 'dev-sintetico' ? 'user' : 'organization', number, title, url: `https://github.com/orgs/${owner}/projects/${number}`, items: number * 10, hasStatusField: true, closed: false, ...extra });
const PROJECTS = [
  P('exemplo-labs', 3, 'Roadmap do app'),
  P('exemplo-labs', 7, 'Motor de regras · 4º tri'),
  P('estudio-ficticio', 2, 'Receitas v2'),
  P('dev-sintetico', 1, 'Pessoal'),
  P('estudio-ficticio', 5, 'Pesquisa de UX', { hasStatusField: false }),
  P('estudio-ficticio', 9, 'Arquivo antigo', { closed: true }),
];
const OPTIONS = (extra: Record<string, unknown> = {}) => ({ projects: PROJECTS, selection: null, envOverride: null, fetchedAt: '2026-10-21T12:00:00Z', stale: false, reason: null, ...extra });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await tick(5);
  }
};

describe('the picker: pure parts', () => {
  test('the owner filter: everyone with the count, the person and each organization', () => {
    assert.deepEqual(picker.ownerFilters(PROJECTS), [
      { id: 'all', label: 'Todos · 6' },
      { id: 'mine', label: 'Seus' },
      { id: 'org:estudio-ficticio', label: 'estudio-ficticio' },
      { id: 'org:exemplo-labs', label: 'exemplo-labs' },
    ]);
  });

  test('search, owner and closed', () => {
    const titles = (o: Record<string, unknown>) => picker.filterProjects(PROJECTS, o).map((p: { title: string }) => p.title);
    assert.deepEqual(titles({}), ['Roadmap do app', 'Motor de regras · 4º tri', 'Receitas v2', 'Pessoal', 'Pesquisa de UX']);
    assert.deepEqual(titles({ showClosed: true }).at(-1), 'Arquivo antigo');
    assert.deepEqual(titles({ query: 'MOTOR' }), ['Motor de regras · 4º tri']);
    assert.deepEqual(titles({ query: 'labs #3' }), ['Roadmap do app']);
    assert.deepEqual(titles({ owner: 'mine' }), ['Pessoal']);
    assert.deepEqual(titles({ owner: 'org:estudio-ficticio' }), ['Receitas v2', 'Pesquisa de UX']);
  });

  test('the field: Status by default, a control character refused', () => {
    assert.equal(picker.fieldOf(''), 'Status');
    assert.equal(picker.fieldOf('  Fase '), 'Fase');
    assert.equal(picker.fieldOf('a\u0001b'), null);
  });

  test('every options error in pt-BR', () => {
    const t = (status: number, body: unknown, retryIn: number | null = null) => picker.optionsErrorText(new ReadError('x', { status, body, retryIn })).title;
    assert.equal(t(429, { code: 'rate-limited' }), 'O GitHub limitou as chamadas');
    assert.match(picker.optionsErrorText(new ReadError('x', { status: 429, body: { code: 'rate-limited' }, retryIn: 30_000 })).text, /Tente de novo em 30 s\./);
    assert.equal(t(502, { code: 'github-down' }), 'O GitHub não respondeu');
    assert.equal(t(503, { code: 'off' }), 'O núcleo subiu sem o GitHub');
    assert.equal(t(400, { error: 'invalid' }), 'O núcleo recusou essa escolha');
    assert.equal(t(0, null), 'Sem conexão com o núcleo');
  });

  test('the CSS is its own file, every class pp-*', () => {
    const css = readFileSync(`${UI_FOLDER}screens/project-picker.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const own = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))].filter((c) => !['btn', 'icon', 'on', 'filled', 'outline', 'state'].includes(c));
    assert.deepEqual(own.filter((c) => !c.startsWith('pp-')), []);
    for (const other of [...readdirSync(UI_FOLDER), ...readdirSync(`${UI_FOLDER}screens`).map((a) => `screens/${a}`)].filter((a) => a.endsWith('.css') && a !== 'screens/project-picker.css')) {
      assert.doesNotMatch(readFileSync(`${UI_FOLDER}${other}`, 'utf8'), /\.pp-/, other);
    }
  });
});

interface Picked {
  box: ElementoFalso;
  reads: string[];
  writes: { route: string; body: unknown }[];
  saved: unknown[];
  notConnected: number;
}
async function mountPicker(read: (route: string) => Promise<unknown>, write: (route: string, body: unknown) => Promise<unknown> = async (_r, body) => ({ selection: { ...(body as object), from: 'settings' }, envOverride: null })) {
  const box = new ElementoFalso('div');
  const out: Picked = { box, reads: [], writes: [], saved: [], notConnected: 0 };
  const ctx = { read: (r: string) => (out.reads.push(r), read(r)), write: (route: string, body: unknown) => (out.writes.push({ route, body }), write(route, body)), signal: new AbortController().signal };
  picker.mountPicker(box, ctx, { onSaved: (r: unknown) => out.saved.push(r), onNotConnected: () => out.notConnected++ });
  await tick();
  await tick();
  return out;
}
const rows = (box: ElementoFalso) => box.querySelectorAll('tr[data-project]').map((r) => r.getAttribute('data-project'));
const use = (box: ElementoFalso) => box.querySelector('[data-action="use-project"]')!;

describe('the picker (C43 1100)', () => {
  test('lists the open Projects with items and the field; the one without Status says so', async () => {
    const m = await mountPicker(async () => OPTIONS());
    assert.deepEqual(m.reads, ['/api/project/options']);
    assert.deepEqual(rows(m.box), ['exemplo-labs/3', 'exemplo-labs/7', 'estudio-ficticio/2', 'dev-sintetico/1', 'estudio-ficticio/5']);
    const first = m.box.querySelector('tr[data-project="exemplo-labs/3"]')!;
    assert.match(texto(first), /Roadmap do app exemplo-labs · #3 30/);
    assert.equal(first.querySelector('input.pp-field')!.value, 'Status');
    const ux = m.box.querySelector('tr[data-project="estudio-ficticio/5"]')!;
    assert.equal(ux.querySelector('input.pp-field')!.value, '');
    assert.match(texto(ux), /sem campo Status/);
    assert.deepEqual(m.box.querySelectorAll('.pp-seg-option').map(texto), ['Todos · 6', 'Seus', 'estudio-ficticio', 'exemplo-labs']);
    assert.ok(use(m.box).hasAttribute('disabled'), 'nothing chosen yet');
    assert.match(texto(m.box.querySelector('.pp-foot')), /Escolha um Project da lista\./);
  });

  test('search, the owner filter and the closed toggle', async () => {
    const m = await mountPicker(async () => OPTIONS());
    const search = m.box.querySelector('input.pp-search-input')!;
    search.value = 'receitas';
    search.dispatchEvent({ type: 'input' });
    await tick(5);
    assert.deepEqual(rows(m.box), ['estudio-ficticio/2']);
    search.value = '';
    search.dispatchEvent({ type: 'input' });
    m.box.querySelector('[data-owner="mine"]')!.click();
    assert.deepEqual(rows(m.box), ['dev-sintetico/1']);
    m.box.querySelector('[data-owner="all"]')!.click();
    m.box.querySelector('.pp-chip')!.click();
    assert.equal(m.box.querySelector('.pp-chip')!.getAttribute('aria-pressed'), 'true');
    assert.ok(rows(m.box).includes('estudio-ficticio/9'));
  });

  test('choose a row and Usar: posts { owner, number, field } and hands the answer back', async () => {
    const m = await mountPicker(async () => OPTIONS());
    m.box.querySelector('tr[data-project="exemplo-labs/7"]')!.click();
    assert.equal(texto(use(m.box)), 'Usar “Motor de regras · 4º tri”');
    assert.equal(use(m.box).hasAttribute('disabled'), false);
    use(m.box).click();
    await tick();
    assert.deepEqual(m.writes, [{ route: '/api/project/selection', body: { owner: 'exemplo-labs', number: 7, field: 'Status' } }]);
    assert.equal(m.saved.length, 1);
  });

  test('a Project without Status needs the field typed before Usar', async () => {
    const m = await mountPicker(async () => OPTIONS());
    m.box.querySelector('tr[data-project="estudio-ficticio/5"]')!.click();
    assert.ok(use(m.box).hasAttribute('disabled'));
    assert.match(texto(m.box.querySelector('.pp-foot')), /escreva o nome do campo/);
    const field = m.box.querySelector('tr[data-project="estudio-ficticio/5"] input.pp-field')!;
    field.value = 'Fase';
    field.dispatchEvent({ type: 'input' });
    use(m.box).click();
    await tick();
    assert.deepEqual(m.writes.at(-1)!.body, { owner: 'estudio-ficticio', number: 5, field: 'Fase' });
  });

  test('the saved selection comes chosen', async () => {
    const m = await mountPicker(async () => OPTIONS({ selection: { owner: 'exemplo-labs', number: 3, field: 'Status', from: 'settings' } }));
    assert.ok(m.box.querySelector('tr[data-project="exemplo-labs/3"]')!.classList.contains('on'));
    assert.equal(texto(use(m.box)), 'Usar “Roadmap do app”');
  });

  test('a refused save shows the band and keeps the list', async () => {
    const m = await mountPicker(
      async () => OPTIONS(),
      async () => {
        throw new WriteError('invalid', { status: 400, body: { error: 'invalid' } });
      },
    );
    m.box.querySelector('tr[data-project="exemplo-labs/3"]')!.click();
    use(m.box).click();
    await tick();
    await tick();
    assert.match(texto(m.box.querySelector('.error-band')), /O núcleo recusou essa escolha\./);
    assert.equal(rows(m.box).length, 5);
    assert.equal(m.saved.length, 0);
  });

  test('the AHRENA_CONSOLE_PROJECT band: Usar stays off', async () => {
    const m = await mountPicker(async () => OPTIONS({ envOverride: { variable: 'AHRENA_CONSOLE_PROJECT', value: 'exemplo-labs/7' } }));
    assert.match(texto(m.box.querySelector('[data-band="env-override"]')), /AHRENA_CONSOLE_PROJECT está definida\. O Kanban do projeto mostra exemplo-labs\/7 por ela/);
    m.box.querySelector('tr[data-project="exemplo-labs/3"]')!.click();
    assert.ok(use(m.box).hasAttribute('disabled'));
  });

  test('a stale list says so', async () => {
    const m = await mountPicker(async () => OPTIONS({ stale: true, reason: 'o GitHub não respondeu' }));
    assert.match(texto(m.box.querySelector('.error-band')), /GitHub indisponível\. Mostrando a lista em cache\. o GitHub não respondeu/);
  });

  for (const [status, code, title] of [
    [429, 'rate-limited', 'O GitHub limitou as chamadas'],
    [502, 'github-down', 'O GitHub não respondeu'],
    [503, 'off', 'O núcleo subiu sem o GitHub'],
  ] as const) {
    test(`options ${status} ${code}: "${title}" with Tentar de novo, which re-reads with refresh`, async () => {
      let n = 0;
      const m = await mountPicker(async () => {
        if (n++ === 0) throw new ReadError('x', { status, body: { code } });
        return OPTIONS();
      });
      assert.match(texto(m.box.querySelector('section.state')), new RegExp(title));
      m.box.querySelector('section.state button')!.click();
      await tick();
      await tick();
      assert.equal(m.reads.at(-1), '/api/project/options?refresh=1');
      assert.equal(rows(m.box).length, 5);
    });
  }

  test('options 409 github-not-connected hands back to the caller (the shared C42 empty state)', async () => {
    const m = await mountPicker(async () => {
      throw new ReadError('x', { status: 409, body: { error: 'github-not-connected' } });
    });
    assert.equal(m.notConnected, 1);
  });

  test('no Project at all: the empty state with Atualizar', async () => {
    const m = await mountPicker(async () => OPTIONS({ projects: [] }));
    assert.match(texto(m.box), /Nenhum GitHub Project na conta/);
  });
});

// ---------- on the board: the env band and "Trocar de Project" ----------

const BOARD = (extra: Record<string, unknown> = {}) => ({
  project: { owner: 'exemplo-labs', number: 3, title: 'Roadmap do app', url: null, field: 'Status' },
  lanes: [{ id: 'bk', name: 'Backlog', color: null, cards: [] }],
  milestones: [],
  total: 0,
  fetchedAt: Date.now(),
  stale: false,
  reason: null,
  source: 'demo',
  selection: { owner: 'exemplo-labs', number: 3, field: 'Status', from: 'settings' },
  envOverride: null,
  ...extra,
});
const open: (() => void)[] = [];
afterEach(() => open.splice(0).forEach((f) => f()));

async function mountBoard(read: (route: string) => Promise<unknown>, write: (route: string, body: unknown) => Promise<unknown> = async () => ({})) {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: { route: string; body: unknown }[] = [];
  const signal = new AbortController();
  const ctx = {
    params: {},
    signal: signal.signal,
    read: (r: string) => (reads.push(r), read(r)),
    write: (route: string, body: unknown) => (writes.push({ route, body }), write(route, body)),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const cleanup = await mount(area, ctx);
  open.push(() => (signal.abort(), cleanup()));
  return { area, reads, writes };
}

describe('the board (C43 1440, C44)', () => {
  test('the header names the Project, its owner and number, and offers Trocar de Project', async () => {
    const m = await mountBoard(async () => BOARD());
    assert.equal(texto(m.area.querySelector('header .sub')), 'GitHub Project “Roadmap do app” · exemplo-labs #3 · por Status · arraste para mudar');
    const sw = m.area.querySelector('.pp-switch')!;
    assert.equal(sw.hasAttribute('hidden'), false);
    assert.equal(texto(sw.querySelector('[data-action="switch-project"]')), 'Trocar de Project');
    assert.equal(m.area.querySelector('[data-band="env-override"]'), null);
  });

  test('with AHRENA_CONSOLE_PROJECT: the band, and no switch', async () => {
    const m = await mountBoard(async () => BOARD({ selection: { owner: 'exemplo-labs', number: 7, field: 'Status', from: 'env' }, envOverride: { variable: 'AHRENA_CONSOLE_PROJECT', value: 'exemplo-labs/7' } }));
    assert.match(texto(m.area.querySelector('[data-band="env-override"]')), /AHRENA_CONSOLE_PROJECT está definida/);
    assert.ok(m.area.querySelector('.pp-switch')!.hasAttribute('hidden'));
  });

  test('Trocar de Project: the popover lists the Projects with the current one checked; a click saves and the board is read again', async () => {
    let selected = 3;
    const m = await mountBoard(
      async (r) => (r === '/api/project/options' ? OPTIONS() : BOARD({ project: { owner: 'exemplo-labs', number: selected, title: selected === 3 ? 'Roadmap do app' : 'Motor de regras · 4º tri', url: null, field: 'Status' } })),
      async (_r, body) => ((selected = (body as { number: number }).number), { selection: body, envOverride: null }),
    );
    const button = m.area.querySelector('[data-action="switch-project"]')!;
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    await until(() => m.area.querySelectorAll('.pp-pop-item').length > 0);
    const items = m.area.querySelectorAll('.pp-pop-item');
    assert.equal(items.find((i) => i.getAttribute('aria-current') === 'true')!.getAttribute('data-project'), 'exemplo-labs/3');
    assert.equal(m.area.querySelector('.pp-pop input.pp-field')!.value, 'Status');
    items.find((i) => i.getAttribute('data-project') === 'exemplo-labs/7')!.click();
    await until(() => /Motor de regras/.test(texto(m.area.querySelector('header .sub'))));
    assert.deepEqual(m.writes, [{ route: '/api/project/selection', body: { owner: 'exemplo-labs', number: 7, field: 'Status' } }]);
    assert.ok(m.area.querySelector('.pp-pop')!.hasAttribute('hidden'));
  });

  test('picker → Usar → the board', async () => {
    let chosen = false;
    const m = await mountBoard(
      async (r) => {
        if (r === '/api/project/options') return OPTIONS();
        if (!chosen) throw new ReadError('x', { status: 503, body: { code: 'no-project' } });
        return BOARD();
      },
      async (_r, body) => ((chosen = true), { selection: body, envOverride: null }),
    );
    await until(() => m.area.querySelectorAll('tr[data-project]').length > 0);
    assert.ok(m.area.querySelector('header .actions')!.hasAttribute('hidden'), 'no board actions while choosing');
    m.area.querySelector('tr[data-project="exemplo-labs/3"]')!.click();
    m.area.querySelector('[data-action="use-project"]')!.click();
    await until(() => m.area.querySelectorAll('section.prj-col').length > 0);
    assert.equal(m.area.querySelector('header .actions')!.hasAttribute('hidden'), false);
  });
});
