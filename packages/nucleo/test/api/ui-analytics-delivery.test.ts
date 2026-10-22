// The Analytics Delivery tab of the /ui (#266, C54 to C56): formatting, what each card shows and the
// tab mounted in a minimal DOM, with synthetic answers in the shape of /api/analytics/delivery.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: browser module, plain JavaScript
import { findScreen } from '../../ui/screens.js';

// ---------- A minimal DOM: only what dom.js, states.js and the tab use ----------

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  after(node: FakeNode) {
    const parent = this.parent!;
    node.remove();
    node.parent = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  get textContent(): string {
    return this.children.map((f) => f.textContent).join('');
  }
  all(match: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    for (const f of this.children) {
      if (f instanceof FakeElement && match(f)) out.push(f);
      out.push(...f.all(match));
    }
    return out;
  }
}
class FakeText extends FakeNode {
  readonly data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => void)[]>();
  html = '';
  value = '';
  focused = 0;
  selection: [number, number] | null = null;
  scrollTop = 0;
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(type: string, f: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  dispatch(type: string, event: unknown = {}) {
    for (const f of this.listeners.get(type) ?? []) f(event);
  }
  click() {
    this.dispatch('click');
  }
  focus() {
    this.focused++;
  }
  setSelectionRange(start: number, end: number) {
    this.selection = [start, end];
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  set innerHTML(v: string) {
    this.html = v;
  }
  get classes() {
    return (this.getAttribute('class') ?? '').split(/\s+/);
  }
}
const head = new FakeElement('head');
Object.assign(globalThis, {
  Node: FakeNode,
  document: {
    head,
    documentElement: new FakeElement('html'),
    createElement: (t: string) => new FakeElement(t),
    createElementNS: (_ns: string, t: string) => new FakeElement(t),
    createTextNode: (t: string) => new FakeText(t),
    querySelector: (sel: string) => head.all((e) => sel === `link[href="${e.getAttribute('href')}"]`)[0] ?? null,
  },
});
const urls: string[] = [];
const setLocation = (search: string) => Object.assign(globalThis, { location: { search, pathname: '/ui/analytics/delivery' } });
Object.assign(globalThis, { history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => urls.push(url) } });
setLocation('');

// @ts-expect-error: browser module, plain JavaScript
const analytics = await import('../../ui/screens/analytics.js');
// @ts-expect-error: browser module, plain JavaScript
const delivery = await import('../../ui/screens/analytics-delivery.js');
const { leadTime, age, hours, cost, heatLevel, parseDeliveryQuery, deliveryQuery, deliveryRoute, filterOpenItems, deliveryFileName, openState } = delivery;

const withClass = (r: FakeNode, c: string) => r.all((e) => e.classes.includes(c));
const byTag = (r: FakeNode, t: string) => r.all((e) => e.tag === t);
/** The text read on screen, without the <title> tooltips. */
const visible = (n: FakeNode): string => (n instanceof FakeText ? n.data : n instanceof FakeElement && n.tag === 'title' ? '' : n.children.map(visible).join(''));
const card = (r: FakeNode, title: string) => withClass(r, 'an-card').find((c) => byTag(c, 'h2')[0]?.textContent === title)!;

// ---------- Synthetic answers (simulator vocabulary) ----------

const DAY = 86_400_000;
const HOUR = 3_600_000;
function calendar(until: string, n: number) {
  const end = Date.parse(`${until}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

type Row = Record<string, unknown>;
function row(key: string, label: string, merged: number[], hoursPerDay: (number | null)[], extra: Row = {}): Row {
  const total = merged.reduce((s, v) => s + v, 0);
  return {
    key,
    label,
    repos: [key],
    mergedPrs: total,
    mergedPerDay: merged,
    claudeHoursPerDay: hoursPerDay,
    peak: Math.max(0, ...merged),
    total,
    medianLeadTimeMs: total ? 9 * HOUR : null,
    openPrs: 4,
    openIssues: 9,
    contributions: { openedPrs: 4, mergedPrs: total, openedIssues: 9, closedIssues: 0, reviews: 52 },
    claudeHours: hoursPerDay.some((h) => h !== null) ? 64.2 : null,
    costUsd: hoursPerDay.some((h) => h !== null) ? 128.4 : null,
    costPartial: false,
    costPerMergedPr: hoursPerDay.some((h) => h !== null) && total ? 128.4 / total : null,
    ...extra,
  };
}

function answer({ days = 7, groupBy = 'repo', key = null as string | null, status = 'connected', rows: rowsIn = null as Row[] | null, extra = {} as Row } = {}) {
  const cal = calendar('2026-10-20', days);
  const z = (n: number) => Array.from({ length: days }, () => n);
  const rows =
    rowsIn ??
    (groupBy === 'repo'
      ? [
          row('sim-org/motor-de-regras', 'sim-org/motor-de-regras', [2, 0, 4, 1, 0, 0, 3].slice(0, days).concat(z(0)).slice(0, days), [3.1, 0, 2, 5, 0, 0, 1].slice(0, days).concat(z(0)).slice(0, days)),
          row('sim-org/app-receitas', 'sim-org/app-receitas', [0, 1, 0, 0, 0, 0, 0].concat(z(0)).slice(0, days), z(0).map(() => null), { costPartial: false }),
          row('sim-org/fila-de-tarefas', 'sim-org/fila-de-tarefas', z(0), [1, 1, 0, 0, 0, 0, 0].concat(z(0)).slice(0, days), { costUsd: 18.2, costPartial: true, costPerMergedPr: null }),
        ]
      : [row('sim-org/1', 'Loja de exemplo', [1, 1, 0, 0, 0, 0, 2].concat(z(0)).slice(0, days), z(0).map(() => 1), { repos: ['sim-org/vitrine-demo', 'sim-org/catalogo-exemplo'] })]);
  return {
    generatedAt: '2026-10-20T22:45:00.000Z',
    timeZone: 'UTC',
    days,
    today: '2026-10-20',
    since: cal[0],
    until: '2026-10-20',
    calendar: cal,
    groupBy,
    key,
    github: { status, readAt: '2026-10-20T22:41:00.000Z', error: status === 'error' ? 'gh: limite de requisições' : null, pending: 0, truncated: [] as string[] },
    totals: { mergedPrs: 99, medianLeadTimeMs: 9 * HOUR, openPrs: 15, openIssues: 40, claudeHours: 180, costUsd: 329, costPartial: false, costPerMergedPr: 3.3232, repos: 7, reposWithClaude: 6 },
    rows,
    openItems:
      groupBy === 'repo'
        ? [
            { kind: 'issue', number: 312, title: 'Exportar o relatório em CSV', url: 'https://github.com/sim-org/painel-de-metricas/issues/312', repo: 'sim-org/painel-de-metricas', createdAt: '', ageMs: 41 * DAY, state: 'issueWithoutPr', linkedPr: null, rowKeys: ['sim-org/painel-de-metricas'], author: 'pessoa-a', assignees: ['pessoa-b'] },
            { kind: 'pr', number: 298, title: 'Trocar o motor de templates', url: 'https://github.com/sim-org/catalogo-exemplo/pull/298', repo: 'sim-org/catalogo-exemplo', createdAt: '', ageMs: 23 * DAY, state: 'draft', linkedPr: null, rowKeys: ['sim-org/catalogo-exemplo'], author: 'pessoa-a' },
            { kind: 'issue', number: 87, title: 'Retry com backoff na fila', url: 'https://github.com/sim-org/fila-de-tarefas/issues/87', repo: 'sim-org/fila-de-tarefas', createdAt: '', ageMs: 19 * DAY, state: 'issueWithPr', linkedPr: 91, rowKeys: ['sim-org/fila-de-tarefas'] },
            { kind: 'pr', number: 1204, title: 'Separar pagamentos em serviços', url: 'https://github.com/sim-org/motor-de-regras/pull/1204', repo: 'sim-org/motor-de-regras', createdAt: '', ageMs: 6 * DAY, state: 'ciFailed', linkedPr: null, rowKeys: ['sim-org/motor-de-regras'] },
            { kind: 'pr', number: 455, title: 'Cache das consultas do catálogo', url: 'https://example.invalid/455', repo: 'sim-org/catalogo-exemplo', createdAt: '', ageMs: 6 * HOUR, state: 'review', linkedPr: null, rowKeys: ['sim-org/catalogo-exemplo'] },
            { kind: 'pr', number: 1211, title: 'Migração do esquema de pedidos', url: 'https://github.com/sim-org/motor-de-regras/pull/1211', repo: 'sim-org/motor-de-regras', createdAt: '', ageMs: 12 * 60_000, state: 'approved', linkedPr: null, rowKeys: ['sim-org/motor-de-regras'] },
          ]
        : [{ kind: 'pr', number: 455, title: 'Cache das consultas do catálogo', url: 'https://github.com/sim-org/catalogo-exemplo/pull/455', repo: 'sim-org/catalogo-exemplo', createdAt: '', ageMs: 4 * DAY, state: 'review', linkedPr: null, rowKeys: ['sim-org/1'] }],
    openItemsTotal: 55,
    openItemsTruncated: true,
    options: {
      repos: [
        { key: 'sim-org/motor-de-regras', label: 'sim-org/motor-de-regras' },
        { key: 'sim-org/vitrine-demo', label: 'sim-org/vitrine-demo' },
        { key: 'sim-org/catalogo-exemplo', label: 'sim-org/catalogo-exemplo' },
      ],
      projects: [{ key: 'sim-org/1', label: 'Loja de exemplo', repos: ['sim-org/vitrine-demo', 'sim-org/catalogo-exemplo'] }],
    },
    projectsError: null as string | null,
    projectsPending: false,
    ...extra,
  };
}

async function mountTab({ search = '', read }: { search?: string; read: (route: string) => Promise<unknown> }) {
  setLocation(search);
  urls.length = 0;
  const area = new FakeElement('main');
  const routes: string[] = [];
  const changes: (() => void)[] = [];
  const restarts: (() => void)[] = [];
  const ctx = {
    params: { tab: 'delivery' },
    signal: new AbortController().signal,
    read: async (route: string) => (routes.push(route), read(route)),
    onChange: (f: () => void) => changes.push(f),
    onRestart: (f: () => void) => restarts.push(f),
    counter: () => {},
    title: () => {},
    navigate: () => {},
    liveState: () => 'live',
  };
  const cleanup = await analytics.mount(area, ctx, { releituraMs: 5 });
  return { area, routes, changes, restarts, cleanup };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const routeFor = (r: string) => answer({ days: Number(/days=(\d+)/.exec(r)![1]), groupBy: /groupBy=(\w+)/.exec(r)![1], key: /key=([^&]+)/.exec(r) ? decodeURIComponent(/key=([^&]+)/.exec(r)![1]) : null });

// ---------- Formatting ----------

describe('Delivery: formatting', () => {
  test('lead time, age and hours in pt-BR; unknown is "—" (#266/AC-1, AC-7)', () => {
    assert.equal(leadTime(42 * 60_000), '42 min');
    assert.equal(leadTime(9 * HOUR), '9 h');
    assert.equal(leadTime(1.8 * DAY), '1,8 d');
    assert.equal(leadTime(null), '—');
    assert.equal(age(41 * DAY + 3 * HOUR), '41 d');
    assert.equal(age(6 * HOUR), '6 h');
    assert.equal(age(12 * 60_000), '12 min');
    assert.equal(hours(180), '180 h');
    assert.equal(hours(64.2), '64,2 h');
    assert.equal(hours(null), '—');
    assert.equal(cost(null), '—', 'unknown cost is "—", never "sem preço" nor US$ 0');
    assert.equal(cost(3.3232), '~US$ 3,32');
    assert.equal(cost(329, { short: true }), '~US$ 329');
  });

  test('heat level is relative to the largest value (#266/AC-3, AC-11)', () => {
    assert.equal(heatLevel(0, 10), 0);
    assert.equal(heatLevel(null, 10), 0);
    assert.equal(heatLevel(10, 10), 5);
    assert.equal(heatLevel(1, 10), 1);
    assert.equal(heatLevel(5, 0), 0);
  });

  test('open item states in pt-BR (#266/AC-4)', () => {
    assert.deepEqual(
      ['draft', 'review', 'ciFailed', 'approved', 'issueWithoutPr'].map((state) => openState({ state }).text),
      ['rascunho', 'esperando review', 'CI ✕', 'aprovado', 'sem PR'],
    );
    assert.equal(openState({ state: 'issueWithPr', linkedPr: 91 }).text, 'PR #91 aberto');
    assert.deepEqual(openState({ state: 'somethingNew' }), { text: 'aberto', tone: 'muted' }, 'an unknown state never shows the raw code');
  });

  test('the export file name (#266/AC-6)', () => {
    assert.equal(deliveryFileName({ until: '2026-10-20' }, { days: 30, groupBy: 'project' }), 'ahrena-analytics-delivery-project-30d-2026-10-20.json');
  });
});

describe('Delivery: state in the URL (#266/AC-6)', () => {
  test('reads the query; invalid values fall back to the defaults', () => {
    assert.deepEqual(parseDeliveryQuery(''), { days: 30, groupBy: 'repo', key: null });
    assert.deepEqual(parseDeliveryQuery('?days=7&groupBy=project&key=sim-org/1'), { days: 7, groupBy: 'project', key: 'sim-org/1' });
    assert.deepEqual(parseDeliveryQuery('?days=12&groupBy=person&key=nada'), { days: 30, groupBy: 'repo', key: null });
    assert.deepEqual(parseDeliveryQuery('?key=../x'), { days: 30, groupBy: 'repo', key: null });
    assert.deepEqual(parseDeliveryQuery('?groupBy=project&key=acme/api'), { days: 30, groupBy: 'project', key: null }, 'a repository key is not a project key');
    assert.deepEqual(parseDeliveryQuery('?key=sim-org/1'), { days: 30, groupBy: 'repo', key: 'sim-org/1' }, 'a repository may be named with digits');
    assert.deepEqual(parseDeliveryQuery('?key=-bad/x'), { days: 30, groupBy: 'repo', key: null });
    assert.deepEqual(parseDeliveryQuery('?key=sim-org/..'), { days: 30, groupBy: 'repo', key: null });
  });
  test('writes the query without defaults, and builds the read route', () => {
    assert.equal(deliveryQuery({ days: 30, groupBy: 'repo', key: null }), '');
    assert.equal(deliveryQuery({ days: 90, groupBy: 'repo', key: 'sim-org/motor-de-regras' }), '?days=90&key=sim-org/motor-de-regras');
    assert.equal(deliveryRoute({ days: 7, groupBy: 'project', key: 'sim-org/1' }, 'America/Sao_Paulo'), '/api/analytics/delivery?days=7&groupBy=project&key=sim-org%2F1&tz=America%2FSao_Paulo');
    assert.equal(deliveryRoute({ days: 30, groupBy: 'repo', key: null }, 'UTC'), '/api/analytics/delivery?days=30&groupBy=repo&tz=UTC');
  });
});

describe('Delivery: client-side search (#266/AC-4)', () => {
  const items = answer().openItems;
  const numbers = (list: { number: number }[]) => list.map((i) => i.number);
  test('by title (accent and case insensitive), repository and number, API order kept', () => {
    assert.deepEqual(numbers(filterOpenItems(items, { search: 'CATALOGO' })), [298, 455], 'repository, without the accent');
    assert.deepEqual(numbers(filterOpenItems(items, { search: 'migracao' })), [1211], 'title, without the accent');
    assert.deepEqual(numbers(filterOpenItems(items, { search: '455' })), [455]);
    assert.deepEqual(numbers(filterOpenItems(items, { search: '#455' })), [455]);
    assert.deepEqual(numbers(filterOpenItems(items, {})), [312, 298, 87, 1204, 455, 1211], 'oldest first, as the API sent');
  });
  test('by kind', () => {
    assert.deepEqual(numbers(filterOpenItems(items, { kind: 'issue' })), [312, 87]);
    assert.deepEqual(numbers(filterOpenItems(items, { kind: 'pr', search: 'motor' })), [298, 1204, 1211], 'title or repository');
  });
});

// ---------- The tab mounted ----------

describe('Delivery: the tab per repository', () => {
  test('header, bar, the six numbers of the period (#266/AC-1)', async () => {
    const { area, routes, cleanup } = await mountTab({ read: async (r) => routeFor(r) });
    try {
      assert.match(routes[0]!, /^\/api\/analytics\/delivery\?days=30&groupBy=repo&tz=[^&]+$/);
      const text = visible(area);
      assert.match(text, /O ritmo de entrega de cada repositório no GitHub, com o esforço do Claude no mesmo repositório/);
      assert.match(text, /Exportar/);
      const tabLinks = byTag(withClass(area, 'an-tabs')[0]!, 'a');
      assert.deepEqual(tabLinks.map((a) => [a.textContent, a.getAttribute('aria-current')]), [['Visão geral', null], ['Custo', null], ['Entregas', 'page']]);
      const stats = withClass(area, 'an-stat');
      assert.deepEqual(stats.map((s) => s.getAttribute('data-card')), ['merged', 'lead-time', 'open', 'claude-hours', 'cost', 'cost-per-pr']);
      assert.deepEqual(stats.map(visible), [
        'PRs mesclados99~3,3 por dia',
        'Até o merge9 hmediana, do PR aberto ao merge',
        'Abertos5515 PRs · 40 issues',
        'Horas do Claude180 hem 6 dos 7 repositórios',
        'Custo~US$ 329estimativa · 30 dias',
        'Custo por PR~US$ 3,32custo ÷ PRs mesclados',
      ]);
      const select = byTag(area, 'select')[0]!;
      assert.deepEqual(byTag(select, 'option').map((o) => o.textContent), ['Todos os repositórios', 'sim-org/motor-de-regras', 'sim-org/vitrine-demo', 'sim-org/catalogo-exemplo']);
    } finally {
      cleanup();
    }
  });

  test('contributions per type: a row per repository, colour by the weight inside the row, zero is a muted dot (#266/AC-11)', async () => {
    const { area, cleanup } = await mountTab({ search: '?days=7', read: async (r) => routeFor(r) });
    try {
      const c = card(area, 'Contribuições por tipo');
      assert.match(visible(c), /a cor mostra o peso de cada tipo dentro do próprio repositório/);
      assert.deepEqual(byTag(byTag(c, 'thead')[0]!, 'th').map((t) => t.textContent), ['Repositório', 'PRs abertos', 'PRs mesclados', 'Issues abertas', 'Issues fechadas', 'Revisões']);
      const first = byTag(byTag(c, 'tbody')[0]!, 'tr')[0]!;
      assert.equal(first.getAttribute('data-row'), 'sim-org/motor-de-regras');
      const chips = withClass(first, 'an-dl-chip');
      assert.deepEqual(chips.map((s) => s.textContent), ['4', '10', '9', '52']);
      assert.ok(chips.at(-1)!.classes.includes('an-dl-h5'), 'the largest of the row is the strongest');
      assert.ok(chips[0]!.classes.includes('an-dl-h1'));
      assert.deepEqual(withClass(first, 'an-dl-zero').map((z) => z.textContent), ['·'], 'zero closed issues: a dot, not a chip');
    } finally {
      cleanup();
    }
  });

  test('delivery rhythm: one small multiple per row, own scale, peak and total, "total 0", the hours line behind the bars (#266/AC-2)', async () => {
    const { area, cleanup } = await mountTab({ search: '?days=7', read: async (r) => routeFor(r) });
    try {
      const c = card(area, 'Ritmo de entrega');
      assert.match(visible(c), /PRs mesclados por dia · últimos 7 dias/);
      assert.match(visible(c), /Cada gráfico tem escala própria: o pico de cada repositório está no canto\./);
      const smalls = withClass(c, 'an-dl-small');
      assert.equal(smalls.length, 3);
      assert.deepEqual(smalls.map((s) => visible(withClass(s, 'an-dl-small-top')[0]!)), ['sim-org/motor-de-regraspico 4 · total 10', 'sim-org/app-receitaspico 1 · total 1', 'sim-org/fila-de-tarefastotal 0']);

      const svgOf = (s: FakeElement) => byTag(s, 'svg').find((g) => g.classes.includes('an-dl-svg'))!;
      const first = svgOf(smalls[0]!);
      assert.equal(first.getAttribute('preserveAspectRatio'), 'none');
      assert.ok(first.getAttribute('viewBox'));
      const kids = first.children as FakeElement[];
      const lineAt = kids.findIndex((k) => k.classes.includes('an-dl-hours'));
      const firstBar = kids.findIndex((k) => k.classes.includes('an-dl-col'));
      assert.ok(lineAt >= 0 && lineAt < firstBar, 'the dashed line is drawn before (behind) the bars');
      const bars = withClass(first, 'an-dl-col');
      const tallest = Math.max(...bars.map((b) => Number(b.getAttribute('height'))));
      const second = withClass(svgOf(smalls[1]!), 'an-dl-col');
      assert.equal(Number(second[0]!.getAttribute('height')), tallest, 'each chart on its own scale: a peak of 1 is as tall as a peak of 4');
      assert.equal(withClass(svgOf(smalls[1]!), 'an-dl-hours').length, 0, 'no Claude hours: no line');
      assert.equal(withClass(svgOf(smalls[2]!), 'an-dl-col').length, 0, 'no merge: only the baseline');
      assert.equal(withClass(svgOf(smalls[2]!), 'an-axis').length, 1);
      const tips = byTag(first, 'title').map((t) => t.textContent);
      assert.equal(tips.length, 7);
      assert.equal(tips[0], '14/10: 2 PRs mesclados · 3,1 h do Claude');
      assert.equal(tips[1], '15/10: 0 PRs mesclados · 0 h do Claude');
      assert.deepEqual(withClass(smalls[0]!, 'an-dl-axis').map(visible), ['14/1020/10']);
    } finally {
      cleanup();
    }
  });

  test('effort and delivery: heat by column, nulls are "—", partial cost says so (#266/AC-3, AC-7)', async () => {
    const { area, cleanup } = await mountTab({ search: '?days=7', read: async (r) => routeFor(r) });
    try {
      const c = card(area, 'Esforço e entrega');
      assert.match(visible(c), /a cor mostra o peso de cada valor na coluna/);
      assert.deepEqual(byTag(byTag(c, 'thead')[0]!, 'th').map((t) => t.textContent), ['Repositório', 'PRs mesclados', 'Até o merge', 'Abertos', 'Horas do Claude', 'Custo', 'Custo por PR']);
      const rows = byTag(byTag(c, 'tbody')[0]!, 'tr');
      const cells = (r: FakeElement) => (r.children as FakeElement[]).map(visible);
      assert.deepEqual(cells(rows[0]!), ['sim-org/motor-de-regras', '10', '9 h', '4 PRs · 9 issues', '64,2 h', '~US$ 128,40', '~US$ 12,84']);
      assert.deepEqual(cells(rows[1]!), ['sim-org/app-receitas', '1', '9 h', '4 PRs · 9 issues', '—', '—', '—'], 'no session: hours, cost and cost per PR are "—"');
      assert.deepEqual(cells(rows[2]!), ['sim-org/fila-de-tarefas', '0', '—', '4 PRs · 9 issues', '64,2 h', '~US$ 18,20parcial', '—'], 'no merge: cost per PR is "—"');
      const name = rows[0]!.children[0] as FakeElement;
      assert.deepEqual([name.tag, name.getAttribute('scope')], ['th', 'row'], 'the row name is a row header');
      assert.ok(withClass(rows[0]!, 'an-dl-chip')[0]!.classes.includes('an-dl-h5'), 'the most merged of the column');
      assert.ok(withClass(rows[1]!, 'an-dl-chip')[0]!.classes.includes('an-dl-h1'));
      assert.ok(withClass(rows[2]!, 'an-dl-chip')[0]!.classes.includes('an-dl-h0'));
      assert.doesNotMatch(visible(area), /US\$ 0[,.]00|sem preço/, 'unknown is never US$ 0 nor "sem preço"');
    } finally {
      cleanup();
    }
  });

  test('em andamento: oldest first, states, links only to github.com, search and kind re-render only the list, focus and caret kept (#266/AC-4)', async () => {
    let total = 55;
    const { area, changes, routes, cleanup } = await mountTab({ read: async (r) => ({ ...routeFor(r), openItemsTotal: total }) });
    try {
      const c = card(area, 'Em andamento');
      assert.match(visible(c), /55 abertos · os mais antigos primeiro/);
      const rowsOf = () => withClass(c, 'an-dl-open-row');
      assert.deepEqual(rowsOf().map((r) => withClass(r, 'an-dl-number')[0]!.textContent), ['#312', '#298', '#87', '#1204', '#455', '#1211']);
      assert.deepEqual(rowsOf().map((r) => withClass(r, 'an-dl-pill')[0]!.textContent), ['sem PR', 'rascunho', 'PR #91 aberto', 'CI ✕', 'esperando review', 'aprovado']);
      assert.deepEqual(rowsOf().map((r) => withClass(r, 'an-dl-age')[0]!.textContent), ['41 d', '23 d', '19 d', '6 d', '6 h', '12 min']);
      const links = byTag(c, 'a');
      assert.equal(links.length, 5, 'the item whose url is not github.com has no link');
      assert.ok(links.every((a) => a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') ?? '')));
      assert.match(visible(c), /Mostrando os 6 mais antigos de 55\./);

      const input = byTag(c, 'input')[0]!;
      assert.equal(input.getAttribute('type'), 'search');
      assert.equal(input.getAttribute('placeholder'), 'Buscar por título, repositório ou número');
      const list = withClass(c, 'an-dl-open')[0]!;
      input.value = '#455';
      input.dispatch('input', { target: input });
      assert.strictEqual(byTag(c, 'input')[0], input, 'the input is the same node: only the list was redrawn');
      assert.strictEqual(withClass(c, 'an-dl-open')[0], list);
      assert.deepEqual(rowsOf().map((r) => withClass(r, 'an-dl-number')[0]!.textContent), ['#455']);

      input.value = 'motor';
      input.dispatch('input', { target: input });
      byTag(c, 'button').find((b) => b.getAttribute('data-kind') === 'issue')!.click();
      assert.equal(rowsOf().length, 0);
      assert.match(visible(c), /Nada aberto com “motor”\./);
      byTag(c, 'button').find((b) => b.getAttribute('data-kind') === 'pr')!.click();
      assert.equal(rowsOf().length, 3);

      // A live re-read with something new keeps the search, the kind, the focus and the caret.
      Object.assign(input, { selectionStart: 2, selectionEnd: 4 });
      Object.assign(area, { contains: (n: unknown) => n === input });
      (globalThis.document as unknown as { activeElement: unknown }).activeElement = input;
      total = 56;
      changes.forEach((f) => f());
      await until(() => routes.length === 2);
      await until(() => card(area, 'Em andamento') !== c);
      const again = card(area, 'Em andamento');
      const newInput = byTag(again, 'input')[0]!;
      await until(() => newInput.focused === 1);
      assert.deepEqual(newInput.selection, [2, 4], 'the caret is where it was');
      (globalThis.document as unknown as { activeElement: unknown }).activeElement = null;
      assert.equal(newInput.value, 'motor');
      assert.equal(byTag(again, 'button').find((b) => b.getAttribute('data-kind') === 'pr')!.getAttribute('aria-pressed'), 'true');
      assert.equal(withClass(again, 'an-dl-open-row').length, 3);
    } finally {
      cleanup();
    }
  });

  test('period and row choices re-read and go into the URL; the read keeps the key (#266/AC-6)', async () => {
    const { area, routes, cleanup } = await mountTab({ search: '?days=90&key=sim-org/motor-de-regras', read: async (r) => routeFor(r) });
    try {
      assert.match(routes[0]!, /^\/api\/analytics\/delivery\?days=90&groupBy=repo&key=sim-org%2Fmotor-de-regras&tz=/);
      assert.equal(urls[0], '/ui/analytics/delivery?days=90&key=sim-org/motor-de-regras');
      byTag(area, 'button').find((b) => b.getAttribute('data-days') === '7')!.click();
      await until(() => routes.length === 2);
      assert.match(routes[1]!, /days=7&groupBy=repo&key=sim-org%2Fmotor-de-regras/);
      assert.equal(urls.at(-1), '/ui/analytics/delivery?days=7&key=sim-org/motor-de-regras');
      await until(() => withClass(area, 'an-stat').length === 6);
      const select = byTag(area, 'select')[0]!;
      select.value = '';
      select.dispatch('change', { target: select });
      await until(() => routes.length === 3);
      assert.match(routes[2]!, /^\/api\/analytics\/delivery\?days=7&groupBy=repo&tz=/);
      assert.equal(urls.at(-1), '/ui/analytics/delivery?days=7');
    } finally {
      cleanup();
    }
  });
});

describe('Delivery: per project', () => {
  test('the axis switch changes the route, the labels and clears the key (#266/AC-5)', async () => {
    const { area, routes, cleanup } = await mountTab({ search: '?key=sim-org/motor-de-regras', read: async (r) => routeFor(r) });
    try {
      byTag(area, 'button').find((b) => b.getAttribute('data-group-by') === 'project')!.click();
      await until(() => routes.length === 2);
      assert.match(routes[1]!, /^\/api\/analytics\/delivery\?days=30&groupBy=project&tz=/, 'the key is cleared');
      assert.equal(urls.at(-1), '/ui/analytics/delivery?groupBy=project');
      await until(() => withClass(area, 'an-stat').length === 6);
      const text = visible(area);
      assert.match(text, /O ritmo de entrega de cada GitHub Project, com o esforço do Claude nos repositórios dele/);
      assert.match(text, /dentro do próprio projeto/);
      assert.match(text, /o pico de cada projeto está no canto/);
      assert.match(text, /o esforço do projeto é a soma dos repositórios dele/);
      assert.equal(byTag(byTag(card(area, 'Esforço e entrega'), 'thead')[0]!, 'th')[0]!.textContent, 'Projeto');
      assert.match(visible(card(area, 'Esforço e entrega')), /Loja de exemplo2 repositórios/);
      assert.equal(visible(withClass(area, 'an-dl-small-sub')[0]!), 'sim-org/vitrine-demo · sim-org/catalogo-exemplo');
      assert.equal(withClass(card(area, 'Em andamento'), 'an-dl-repo')[0]!.textContent, 'Loja de exemplo · sim-org/catalogo-exemplo');
      assert.deepEqual(byTag(byTag(area, 'select')[0]!, 'option').map((o) => o.textContent), ['Todos os projetos', 'Loja de exemplo']);
      assert.equal(byTag(area, 'button').find((b) => b.getAttribute('data-group-by') === 'project')!.getAttribute('aria-pressed'), 'true');
    } finally {
      cleanup();
    }
  });

  test('a GitHub Projects read failure shows a band; no rows explain the projects, with no default (#266/AC-5)', async () => {
    const { area, cleanup } = await mountTab({ search: '?groupBy=project', read: async () => answer({ groupBy: 'project', rows: [], extra: { projectsError: 'gh: sem escopo read:project', openItems: [] } }) });
    try {
      const text = visible(area);
      assert.match(text, /Não deu para ler os GitHub Projects\. gh: sem escopo read:project/);
      assert.match(text, /Nenhum GitHub Project com atividade/);
      assert.equal(withClass(area, 'an-stat').length, 0);
    } finally {
      cleanup();
    }
  });
});

describe('Delivery: states', () => {
  test('GitHub not connected: the empty state that explains how, pointing at no repository (#266/AC-8)', async () => {
    const d = answer({ status: 'disconnected', rows: [], extra: { openItems: [], options: { repos: [], projects: [] } } });
    const { area, cleanup } = await mountTab({ read: async () => d });
    try {
      const text = visible(area);
      assert.match(text, /Conecte o GitHub para ver as entregas/);
      assert.match(text, /o console não escolhe repositório por você\. O núcleo está sem credencial do GitHub: veja o estado em Conexões ou, se ele subiu com --no-github, reinicie sem essa opção\./);
      assert.doesNotMatch(text, /gh auth login/);
      assert.equal(withClass(area, 'an-stat').length, 0);
      assert.equal(byTag(area, 'select').length, 0, 'no repository picker without GitHub');
      assert.doesNotMatch(text, /sim-org/);
      assert.equal(withClass(area, 'an-tabs').length, 1);
    } finally {
      cleanup();
    }
  });

  test('GitHub out: the band with the cache read time, then the cached data (#266/AC-8)', async () => {
    const { area, cleanup } = await mountTab({ read: async (r) => ({ ...routeFor(r), github: { status: 'stale', readAt: '2026-10-20T22:41:00.000Z', error: 'HTTP 502', pending: 2, truncated: ['3 repositórios de fora: o teto é 30'] } }) });
    try {
      const band = withClass(area, 'error-band')[0]!;
      assert.match(visible(band), /O GitHub não respondeu\. Mostrando os PRs e as issues em cache, lidos às \d{2}:\d{2}\. Horas e custo do Claude estão em dia: vêm das sessões desta máquina\.Tentar agora/);
      assert.equal(withClass(area, 'an-stat').length, 6);
      assert.match(visible(withClass(area, 'an-stat')[0]!), /até \d{2}:\d{2}/);
      assert.match(visible(area), /Lendo 2 repositórios do GitHub…/);
      assert.match(visible(area), /3 repositórios de fora: o teto é 30/);
    } finally {
      cleanup();
    }
  });

  test('GitHub not read yet: the bar and "Lendo o GitHub…" (#266/AC-8)', async () => {
    const { area, cleanup } = await mountTab({ read: async () => answer({ status: 'loading', rows: [], extra: { openItems: [] } }) });
    try {
      assert.match(visible(area), /Lendo o GitHub…/);
      assert.equal(byTag(area, 'select').length, 1);
    } finally {
      cleanup();
    }
  });

  test('by project, the Projects not read yet show "Lendo os GitHub Projects…", not the empty state (#266/AC-8)', async () => {
    const { area, cleanup } = await mountTab({ search: '?groupBy=project', read: async () => answer({ groupBy: 'project', rows: [], extra: { projectsPending: true, openItems: [] } }) });
    try {
      assert.match(visible(area), /Lendo os GitHub Projects…/);
      assert.doesNotMatch(visible(area), /Nenhum GitHub Project com atividade/);
    } finally {
      cleanup();
    }
  });

  test('by project with a key, the Projects not read yet show "Lendo os GitHub Projects…", not "Nada em …" (#266/AC-8)', async () => {
    const { area, cleanup } = await mountTab({ search: '?groupBy=project&key=sim-org/7', read: async () => answer({ groupBy: 'project', rows: [], extra: { projectsPending: true, openItems: [] } }) });
    try {
      assert.match(visible(area), /Lendo os GitHub Projects…/);
      assert.doesNotMatch(visible(area), /Nada em sim-org\/7/);
    } finally {
      cleanup();
    }
  });

  test('a key with no rows offers "Ver todos", which clears it; no rows at all says the period (#266/AC-6)', async () => {
    const { area, routes, cleanup } = await mountTab({ search: '?key=sim-org/nada', read: async () => answer({ rows: [], extra: { openItems: [] } }) });
    try {
      assert.match(visible(area), /Nada em sim-org\/nada nos últimos 30 dias/);
      byTag(area, 'button').find((b) => b.textContent === 'Ver todos')!.click();
      await until(() => routes.length === 2);
      assert.doesNotMatch(routes[1]!, /key=/);
      await until(() => /Nenhum repositório com atividade nos últimos 30 dias/.test(visible(area)));
    } finally {
      cleanup();
    }
  });

  test('a failed read: the error; a failed live re-read keeps the data with a band (#266/AC-8)', async () => {
    let fail = true;
    const { area, restarts, cleanup } = await mountTab({
      read: async (r) => {
        if (fail) throw new Error('O núcleo não respondeu');
        return routeFor(r);
      },
    });
    try {
      assert.match(visible(area), /Sem conexão com o núcleo.*Tentar de novo/);
      fail = false;
      byTag(area, 'button').find((b) => /Tentar de novo/.test(b.textContent))!.click();
      await until(() => withClass(area, 'an-stat').length === 6);
      fail = true;
      restarts.forEach((f) => f());
      await until(() => withClass(area, 'error-band').length === 1);
      assert.equal(withClass(area, 'an-stat').length, 6);
    } finally {
      cleanup();
    }
  });
});

test('no axis per person: extra author or assignee fields never render, rows are repositories (#266/AC-9)', async () => {
  const { area, cleanup } = await mountTab({ read: async (r) => routeFor(r) });
  try {
    const text = area.textContent;
    assert.doesNotMatch(text, /pessoa-a|pessoa-b/);
    assert.doesNotMatch(text, /autor|responsável/i);
    const rowKeys = area.all((e) => e.getAttribute('data-row') !== null).map((e) => e.getAttribute('data-row'));
    assert.ok(rowKeys.length > 0 && rowKeys.every((k) => /^sim-org\//.test(k!)));
  } finally {
    cleanup();
  }
});

test('the registry: /ui/analytics/delivery opens the Analytics screen with the delivery tab (#266/AC-6)', () => {
  const d = findScreen('/ui/analytics/delivery');
  assert.deepEqual(d.params, { tab: 'delivery' });
  assert.equal(d.screen.highlights, 'analytics');
  assert.equal(d.screen.file, '/ui/screens/analytics.js');
});

test('the route and the axes of the tab are the core\'s (#266/AC-5, AC-6)', async () => {
  const core = await import('../../src/api/delivery.ts');
  assert.equal(analytics.DELIVERY_ROUTE, core.DELIVERY_ROUTE);
  assert.deepEqual(analytics.GROUP_BYS, [...core.GROUP_BYS]);
});

test('the numbers with no session and no merge are "—", never 0; a partial cost says so (#266/AC-7)', () => {
  const totals = { mergedPrs: 0, medianLeadTimeMs: null, openPrs: 1, openIssues: 2, claudeHours: null, costUsd: null, costPartial: false, costPerMergedPr: null, repos: 1, reposWithClaude: 0 };
  const values = (t: Record<string, unknown>) => withClass(delivery.deliveryStats({ days: 30, totals: t }), 'an-v').map(visible);
  assert.deepEqual(values(totals), ['0', '—', '3', '—', '—', '—']);
  const partialTotals = { ...totals, mergedPrs: 4, claudeHours: 2.5, costUsd: 12.4, costPartial: true, costPerMergedPr: 3.1, reposWithClaude: 1 };
  assert.deepEqual(values(partialTotals), ['4', '—', '3', '2,5 h', '~US$ 12,40', '~US$ 3,10'], 'the value stays alone');
  const costCard = withClass(delivery.deliveryStats({ days: 30, totals: partialTotals }), 'an-stat').find((s) => s.getAttribute('data-card') === 'cost')!;
  const sub = withClass(costCard, 'an-s')[0]!;
  assert.equal(visible(sub), 'estimativa · 30 dias · parcial', 'partial goes in the sub line, as in the Cost tab');
  assert.equal(withClass(sub, 'an-partial')[0]!.textContent, ' · parcial');
  assert.equal(visible(withClass(delivery.deliveryStats({ days: 30, totals }), 'an-s')[4]!), 'estimativa · 30 dias');
});

test('a live re-read with nothing new keeps the screen as it is (#266/AC-4)', async () => {
  let n = 0;
  const { area, routes, changes, cleanup } = await mountTab({ read: async (r) => ({ ...routeFor(r), generatedAt: `2026-10-20T22:45:0${n++ % 10}.000Z` }) });
  try {
    const before = card(area, 'Em andamento');
    changes.forEach((f) => f());
    await until(() => routes.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(card(area, 'Em andamento'), before, 'same answer (but the time): nothing redrawn');
  } finally {
    cleanup();
  }
});

test('a failed quiet re-read after a new choice does not bring back the old period (#266/AC-6)', async () => {
  let mode: 'ok' | 'hang' | 'fail' = 'ok';
  const { area, restarts, cleanup } = await mountTab({
    read: (r) => (mode === 'ok' ? Promise.resolve(routeFor(r)) : mode === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('O núcleo não respondeu'))),
  });
  try {
    assert.equal(withClass(area, 'an-stat').length, 6);
    mode = 'hang';
    byTag(area, 'button').find((b) => b.getAttribute('data-days') === '7')!.click();
    mode = 'fail';
    restarts.forEach((f) => f());
    await until(() => /Sem conexão com o núcleo/.test(visible(area)));
    assert.equal(withClass(area, 'an-stat').length, 0, 'the 30-day numbers do not come back under ?days=7');
    assert.equal(byTag(area, 'button').find((b) => b.getAttribute('data-days') === '7')!.getAttribute('aria-pressed'), 'true');
  } finally {
    cleanup();
  }
});

test('an a11y pass: the kind icon is an image, a zero cell is read as "nenhum" (#266/AC-4, AC-11)', async () => {
  const { area, cleanup } = await mountTab({ read: async (r) => routeFor(r) });
  try {
    const kind = withClass(area, 'an-dl-kind')[0]!;
    assert.deepEqual([kind.getAttribute('role'), kind.getAttribute('aria-label')], ['img', 'Issue']);
    const zero = withClass(area, 'an-dl-zero')[0]!;
    assert.deepEqual([zero.getAttribute('role'), zero.getAttribute('aria-label')], ['img', 'nenhum']);
  } finally {
    cleanup();
  }
});

test('the URL key check agrees with the core\'s validKey on edge keys (#266/AC-6)', async () => {
  const { validKey } = await import('../../src/api/delivery.ts');
  const keys = ['sim-org/motor-de-regras', 'sim-org/1', 'sim-org/..', 'sim-org/.', 'sim-org/.github', 'sim-org/a.b_c-d', '-bad/x', 'bad-/x', 'a--b/x', 'sim-org/x/y', 'sim-org/', '/x', 'sim-org', 'sim-org/12345678901', 'sim-org/123456789', `${'a'.repeat(39)}/x`, `${'a'.repeat(40)}/x`, `sim-org/${'r'.repeat(100)}`, `sim-org/${'r'.repeat(101)}`, 'sim-org/nome com espaço'];
  for (const groupBy of ['repo', 'project'] as const)
    for (const key of keys) {
      const core = validKey(groupBy, key);
      const screen = parseDeliveryQuery(`?groupBy=${groupBy}&key=${encodeURIComponent(key)}`).key;
      assert.equal(screen !== null, core !== undefined && core !== null, `${groupBy} ${key}: the screen and the core disagree`);
    }
});

test('a failed re-read band goes away on the next good read, even with the same answer; the search box stays (#266/AC-8)', async () => {
  let fail = false;
  const { area, restarts, cleanup } = await mountTab({
    read: async (r) => {
      if (fail) throw new Error('caiu');
      return routeFor(r);
    },
  });
  try {
    const input = byTag(card(area, 'Em andamento'), 'input')[0]!;
    fail = true;
    restarts.forEach((f) => f());
    await until(() => withClass(area, 'error-band').length === 1);
    assert.strictEqual(byTag(card(area, 'Em andamento'), 'input')[0], input, 'only the band went in');
    assert.strictEqual(area.children[1], withClass(area, 'error-band')[0], 'right under the header');
    fail = false;
    restarts.forEach((f) => f());
    await until(() => withClass(area, 'error-band').length === 0);
    assert.strictEqual(byTag(card(area, 'Em andamento'), 'input')[0], input, 'same answer: nothing else redrawn');
  } finally {
    cleanup();
  }
});

test('a new period starts the open list at the top (#266/AC-4)', async () => {
  const { area, routes, cleanup } = await mountTab({ read: async (r) => routeFor(r) });
  try {
    const list = withClass(area, 'an-dl-open')[0]!;
    list.scrollTop = 300;
    list.dispatch('scroll');
    byTag(area, 'button').find((b) => b.getAttribute('data-days') === '7')!.click();
    await until(() => routes.length === 2 && withClass(area, 'an-dl-open')[0] !== list && withClass(area, 'an-dl-open').length === 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(withClass(area, 'an-dl-open')[0]!.scrollTop, 0);
  } finally {
    cleanup();
  }
});
