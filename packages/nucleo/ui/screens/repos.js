// Repositórios (C22, issue 104): as organizações e os repositórios da conta do GitHub, com atividade,
// issues, PRs, CI e as sessões que mexem em cada um. Lê `GET /api/repos` (src/api/repos-tipos.ts).
//
// - Os filtros ficam montados entre as releituras: só a lista e os cards são redesenhados, e a busca
//   não perde o foco enquanto a pessoa digita.
// - `carregando` do núcleo (o GitHub ainda não respondeu): relê a cada 5 s, além da mudança
//   `repos`/`list` do Ao vivo. O que a tela desenha sai de `estadoDaTela` (repos-format.js).

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { screenState, filterRepos, integer, changeMatters, SORTS, percentage, relative, NO_GITHUB, sparkline, hasList, DASH, VISIBILITIES } from '../repos-format.js';

const SVG = 'http://www.w3.org/2000/svg';
const REREAD_MS = 5000;

/** O estilo das duas telas de repositórios, uma vez por página. */
export function loadStyle() {
  if (!document.querySelector('link[data-screen="repos"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/repos.css', 'data-screen': 'repos' }));
}

const CI = {
  ok: ['b-completed', 'CI ✓', 'CI passou'],
  running: ['b-waiting', 'CI …', 'CI rodando'],
  failed: ['b-error', 'CI ✕', 'CI falhou'],
};

/** A pílula do CI do branch padrão, ou o traço sem CI. O leitor de tela ouve "CI passou". */
export function ciPill(ci) {
  const c = CI[ci];
  if (!c) return el('span', { class: 'repo-muted' }, DASH);
  return el('span', { class: `repo-pill ${c[0]}` }, el('span', { 'aria-hidden': 'true' }, c[1]), el('span', { class: 'repo-sr-only' }, c[2]));
}

/** `/ui/repos/<dono>/<repo>`, com os segmentos escapados. */
export const repoRoute = (owner, name) => `/ui/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

function svg(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, String(v));
  return node;
}

function spark(values) {
  const points = sparkline(values, 90, 22);
  if (!points) return el('span', { class: 'repo-muted', title: 'O GitHub ainda não mandou as semanas' }, DASH);
  const s = svg('svg', { viewBox: '0 0 90 22', preserveAspectRatio: 'none', class: 'repo-spark', role: 'img', 'aria-label': `Commits por semana nas últimas 12 semanas: ${values.join(', ')}` });
  s.append(svg('polyline', { points: points }));
  return s;
}

function stat(label, value, sub, iconName, color) {
  return el(
    'section',
    { class: 'card repo-stat' },
    el('span', { class: 'repo-stat-label' }, label),
    el('span', { class: `repo-stat-ic ${color}` }, icon(iconName)),
    el('span', { class: 'repo-stat-v' }, value),
    el('span', { class: 'repo-stat-s' }, sub),
  );
}

function sessions({ active: activeOnes, needYou: needing }) {
  if (!activeOnes) return el('span', { class: 'repo-muted' }, DASH);
  return el(
    'span',
    { class: 'repo-sessions-inner' },
    el('span', { class: 'badge b-active', title: `${activeOnes} ${activeOnes === 1 ? 'sessão viva' : 'sessões vivas'}` }, el('span', { class: 'p' }), String(activeOnes), el('span', { class: 'repo-sr-only' }, activeOnes === 1 ? ' sessão viva' : ' sessões vivas')),
    needing ? el('span', { class: 'reason' }, `${needing} ${needing === 1 ? 'precisa' : 'precisam'} de você`) : null,
  );
}

const COLUMNS = [
  ['repo-col-name', 'Repositório'],
  ['repo-col-lang', 'Linguagem'],
  ['repo-col-commits', 'Commits · 12 sem.'],
  ['repo-col-issues', 'Issues'],
  ['repo-col-prs', 'PRs'],
  ['repo-col-ci', 'CI'],
  ['repo-col-sessions', 'Sessões'],
  ['repo-col-push', 'Último push'],
];

export async function mount(area, ctx) {
  loadStyle();
  const filter = { busca: '', dono: '', vis: 'todos', ordem: 'recente' };
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;

  // ---------- cabeçalho ----------
  const accountChip = el('span', { class: 'repo-chip', hidden: true });
  const refresh = el('button', { type: 'button', class: 'btn' }, icon('refresh'), 'Atualizar');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    refresh.setAttribute('aria-busy', 'true');
    try {
      await read({ forcar: true });
    } finally {
      refresh.disabled = false;
      refresh.removeAttribute('aria-busy');
    }
  });
  const head = header({ icon: 'repos', title: 'Repositórios', sub: 'Organizações e repositórios da sua conta do GitHub', actions: [accountChip, refresh] });

  // ---------- filtros: montados uma vez ----------
  const search = el('input', { type: 'search', placeholder: 'Buscar repositórios…', 'aria-label': 'Buscar repositórios', autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', () => ((filter.busca = search.value), drawList()));

  const orgs = el('select', { 'aria-label': 'Organização' });
  orgs.addEventListener('change', () => ((filter.dono = orgs.value), drawList()));
  let selectOwners = null;

  const order = el('select', { 'aria-label': 'Ordenar por' }, ...SORTS.map(([v, label]) => el('option', { value: v }, label)));
  order.addEventListener('change', () => ((filter.ordem = order.value), drawList()));

  const visButtons = VISIBILITIES.map(([v, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === filter.vis) }, label);
    b.addEventListener('click', () => {
      filter.vis = v;
      for (const x of visButtons) x.setAttribute('aria-pressed', String(x === b));
      drawList();
    });
    return b;
  });

  const filters = el(
    'div',
    { class: 'card repo-filters', role: 'search' },
    el('label', { class: 'repo-field repo-field-search' }, icon('search'), search),
    el('label', { class: 'repo-field repo-field-list' }, orgs, icon('chevron-down')),
    el('label', { class: 'repo-field repo-field-list' }, order, icon('chevron-down')),
    el('div', { class: 'repo-seg', role: 'group', 'aria-label': 'Visibilidade' }, ...visButtons),
  );

  const band = el('div', { hidden: true });
  const stats = el('div', { class: 'repo-stats' });
  const list = el('div', { class: 'repo-groups' });

  function fillOrgs() {
    const owners = data.groups.map((g) => g.owner);
    if (selectOwners && selectOwners.join('\n') === owners.join('\n')) return;
    selectOwners = owners;
    if (filter.dono && !owners.includes(filter.dono)) filter.dono = '';
    orgs.replaceChildren(
      el('option', { value: '' }, 'Todas as organizações'),
      ...data.groups.map((g) => el('option', { value: g.owner }, g.type === 'personal' ? 'você (pessoal)' : g.owner)),
    );
    orgs.value = filter.dono;
  }

  function drawStats() {
    const r = data.summary;
    stats.replaceChildren(
      stat('Organizações', integer(r.organizations), '+ a conta pessoal', 'organization', 'repo-c-accent'),
      stat('Repositórios', integer(r.repositories), `${integer(r.withSessionsThisMonth)} com sessões este mês`, 'repos', 'repo-c-accent'),
      stat('PRs abertos', integer(r.openPrs), `${integer(r.prsAwaitingReview)} esperando review`, 'git-pull-request', 'repo-c-wait'),
      stat('Issues abertas', integer(r.openIssues), `${integer(r.issuesClosedThisWeek)} fechadas na semana`, 'dot', 'repo-c-accent'),
      stat('CI', percentage(r.ci.greenRate), r.ci.greenRate === null ? `sem execuções · ${r.ci.days} dias` : `de execuções verdes · ${r.ci.days} dias`, 'ok', 'repo-c-ok'),
    );
  }

  function row(r, now) {
    const href = repoRoute(r.owner, r.name);
    const complete = `${r.fullName} · ${r.visibility === 'public' ? 'público' : 'privado'}`;
    const tr = el(
      'tr',
      { class: 'repo-row' },
      el('td', { class: 'repo-name' }, el('a', { href, title: r.name }, r.name), el('small', { title: complete }, complete)),
      el('td', { title: r.language }, r.language ?? el('span', { class: 'repo-muted' }, DASH)),
      el('td', {}, spark(r.commits12)),
      el('td', { class: 'repo-num' }, integer(r.openIssues)),
      el('td', { class: 'repo-num' }, integer(r.openPrs)),
      el('td', {}, ciPill(r.ci)),
      el('td', { class: 'repo-sessions' }, sessions(r.sessions)),
      el('td', { class: 'repo-muted', title: r.lastPush ? new Date(r.lastPush).toLocaleString('pt-BR') : null }, relative(r.lastPush, now)),
      el('td', { class: 'repo-arrow' }, icon('chevron-right')),
    );
    // A linha inteira leva ao repositório; o link do nome é o caminho pelo teclado.
    tr.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || (ev.target instanceof Element && ev.target.closest('a'))) return;
      if (getSelection()?.toString()) return;
      ctx.navigate(href);
    });
    return tr;
  }

  function group(g, now) {
    const n = g.repos.length;
    return el(
      'section',
      { class: 'repo-group' },
      el('div', { class: 'repo-group-head' }, icon(g.type === 'personal' ? 'person' : 'organization'), el('h2', {}, g.type === 'personal' ? 'você (pessoal)' : g.owner), el('span', {}, `${n} ${n === 1 ? 'repositório' : 'repositórios'}`)),
      el(
        'div',
        { class: 'card' },
        el(
          'table',
          { class: 'repo-table' },
          el('colgroup', {}, ...COLUMNS.map(([c]) => el('col', { class: c })), el('col', { class: 'repo-col-arrow' })),
          el('thead', {}, el('tr', {}, ...COLUMNS.map(([, t]) => el('th', { scope: 'col' }, t)), el('th', { scope: 'col', 'aria-label': 'Abrir' }))),
          el('tbody', {}, ...g.repos.map((r) => row(r, now))),
        ),
      ),
    );
  }

  function drawList() {
    if (!data) return;
    // Quem estava com o foco num link da lista continua nele depois do redesenho.
    const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    const groups = filterRepos(data.groups, filter);
    const now = Date.now();
    list.replaceChildren(...(groups.length ? groups.map((g) => group(g, now)) : [empty({ icon: 'search', title: 'Nenhum repositório com esse filtro', text: 'Mude a busca, a organização ou a visibilidade.' })]));
    if (focused) [...list.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === focused)?.focus();
  }

  const none = () => empty({ icon: 'repos', title: 'Nenhum repositório', text: 'A conta do GitHub não tem repositórios, fora os arquivados.' });
  const retry = () => (area.replaceChildren(head, loading()), read());

  function draw() {
    clearTimeout(timer);
    timer = null;
    accountChip.hidden = !data?.account;
    accountChip.replaceChildren(icon('github'), `conta: ${data?.account ?? ''}`);

    const e = screenState({ dados: data, falha: failure, temDado: hasList(data) });
    if (e.reler) timer = setTimeout(read, REREAD_MS);
    if (e.tela === 'error') return area.replaceChildren(head, failure ? error({ text: failure.message, retry }) : error({ title: 'O GitHub não respondeu', text: data.error ?? 'A leitura dos repositórios falhou.', retry: () => (area.replaceChildren(head, loading()), read({ forcar: true })) }));
    if (e.tela === 'loading') return area.replaceChildren(head, loading());
    if (e.tela === 'reading') return area.replaceChildren(head, loading({ label: 'Lendo o GitHub…' }));
    if (e.tela === 'no-github') return area.replaceChildren(head, empty({ icon: 'github', ...NO_GITHUB }));
    if (e.tela !== 'data') return area.replaceChildren(head, none());

    if (!area.contains(filters)) area.replaceChildren(head, band, stats, filters, list);
    const when = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (e.faixa === 'connection') band.replaceChildren(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura${when ? `, de ${when}` : ''}.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    else if (e.faixa === 'github') band.replaceChildren(errorBand({ title: 'GitHub com problema.', text: `${data.error}. Mostrando os repositórios${when ? ` de ${when}` : ' da última leitura'}.` }));
    else band.replaceChildren();
    band.hidden = !band.firstChild;

    if (data.groups.length === 0) {
      stats.replaceChildren();
      list.replaceChildren(none());
      return;
    }
    fillOrgs();
    drawStats();
    drawList();
  }

  async function read({ forcar: force = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    try {
      const d = await ctx.read(force ? '/api/repos?refresh=1' : '/api/repos');
      if (n !== request) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  ctx.onChange((changes) => {
    if (changeMatters(changes)) read();
  });
  ctx.onRestart(() => read());

  area.replaceChildren(head, loading());
  await read();
  return () => {
    clearTimeout(timer);
    timer = null;
    request++;
  };
}
