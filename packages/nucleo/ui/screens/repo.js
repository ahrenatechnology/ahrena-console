// Repositório (C23, issue 105): as métricas que a API do GitHub dá, num período (30 dias, 90 dias, 1
// ano) que vale para a tela inteira. Lê `GET /api/repos/<dono>/<repo>?period=` (src/api/repos-types.ts).
//
// - The period lives in `?period=` (default 90d; `1y` is the year): switching rewrites the URL without a new history entry and re-reads.
// - Campo `null` vira "—"; se o GitHub ainda calcula (`computing`) ou o núcleo ainda monta
//   (`loading`), "calculando…" (`valueOrPending`). Número nenhum é inventado.
// - Com escrita no repositório, o último card é "Tráfego e segurança"; sem, "Comunidade".
// - `loading` ou `computing`: relê a cada 5 s, além da mudança `repos` do Ao vivo.
// - As abas ficam no cabeçalho. Métricas é `/ui/repos/<dono>/<repo>`; ADRs (C29, issue 174) é
//   `/ui/repos/<dono>/<repo>/adrs`, com o conteúdo de repo-adrs.js; Instruções (C32, issue 183) é
//   `/ui/repos/<dono>/<repo>/instructions`, com o conteúdo de agent-instructions.js. Nas abas ADRs e
//   Instruções, a leitura das métricas só enche o cabeçalho (chips e contagens das abas).

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import {
  activityGrid,
  dayLabel,
  frequencyGrid,
  trafficCardKind,
  signed,
  decimal,
  duration,
  screenState,
  slices,
  ago,
  integer,
  kilo,
  languages,
  thousand,
  changeMatters,
  periodFrom,
  PERIODS,
  percentage,
  currentResponse,
  periodLabel,
  NO_GITHUB,
  hasRepo,
  DASH,
  githubUrl,
  valueOrPending,
} from '../repos-format.js';
import { loadStyle, ciPill } from './repos.js';
import { mountInstructions } from './agent-instructions.js';
import { mountRepoDecisions } from './repo-adrs.js';
import { connectEmptyFor, isGithubNotConnected } from '../github-connect.js';

/** As abas com URL própria: a da rota (`:tab`) e a Métricas, sem segmento. */
const TABS = ['metrics', 'adrs', 'instructions'];

const SVG = 'http://www.w3.org/2000/svg';
const REREAD_MS = 5000;
const CONTRIBUTORS = 10;

const TYPE_COLOR = { História: 'repo-k-accent', 'Tarefa técnica': 'repo-k-orange-light', Bug: 'repo-k-error', Spike: 'repo-k-wait', Épico: 'repo-k-pink' };
const LANGUAGE_COLORS = ['repo-k-accent', 'repo-k-orange-light', 'repo-k-orange-dark', 'repo-k-muted'];

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, String(v));
  for (const f of children) node.append(f);
  return node;
}

const barH = (pct, color) => {
  const i = el('i', { class: color });
  i.style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
  return i;
};

const srOnly = (text) => el('span', { class: 'repo-sr-only' }, text);

function card(title, right, ...children) {
  return el('section', { class: 'card repo-card' }, el('h2', { class: 'repo-ttl' }, title, right ? el('span', { class: 'repo-ttl-r' }, right) : null), ...children);
}

const note = (text) => el('p', { class: 'repo-empty' }, text);
/** A nota da amostra paginada que não cobre o total: `Por tipo sobre 100 de 240 issues lidas.` */
const partialSample = (a, start, name) => (a?.truncated ? el('span', { class: 'repo-note' }, `${start} sobre ${integer(a.read)} de ${integer(a.total)} ${name}.`) : null);

// The grids follow GitHub's contribution graph: one cell per day (commits) or per week (code
// frequency), coloured by heat level. The SVG scales to the card, up to 1.5× its own size, so 30 days
// do not turn into giant tiles.
const STEP = 13;
const CELL = 10;
const GRID_LEFT = 28;
const GRID_TOP = 14;
// The heat classes by level, spelled out so the class guard checks each against repos.css.
const HEAT = ['repo-h0', 'repo-h1', 'repo-h2', 'repo-h3', 'repo-h4'];
const ADDED = ['repo-ha0', 'repo-ha1', 'repo-ha2', 'repo-ha3', 'repo-ha4'];
const REMOVED = ['repo-hr0', 'repo-hr1', 'repo-hr2', 'repo-hr3', 'repo-hr4'];
const capped = (node, width) => (node.style.maxWidth = `${Math.round(width * 1.5)}px`, node);
const legend = () => el('div', { class: 'repo-leg repo-heat-leg' }, el('span', {}, 'menos'), ...HEAT.map((h) => el('span', { class: `repo-heat-sample ${h}`, 'aria-hidden': 'true' })), el('span', {}, 'mais'));

function commitsChart(c) {
  const grid = activityGrid(c.days);
  const width = GRID_LEFT + grid.columns * STEP;
  const children = [
    ...grid.months.map((m) => svg('text', { x: GRID_LEFT + m.column * STEP, y: 9 }, m.label)),
    ...['seg', 'qua', 'sex'].map((d, i) => svg('text', { x: 0, y: GRID_TOP + i * 2 * STEP + 8 }, d)),
    ...grid.cells.map((x) =>
      svg('rect', { class: `repo-heat-cell ${HEAT[x.level]}`, x: GRID_LEFT + x.column * STEP, y: GRID_TOP + x.row * STEP, width: CELL, height: CELL, rx: 2 }, svg('title', {}, `${dayLabel(x.day)}: ${integer(x.commits)} ${x.commits === 1 ? 'commit' : 'commits'}`)),
    ),
  ];
  const g = svg('svg', { viewBox: `0 0 ${width} ${GRID_TOP + 7 * STEP}`, class: 'repo-chart repo-heat', role: 'img', 'aria-label': `Commits por dia, ${c.weeks.length} semanas: ${integer(c.total)} no total, ${integer(c.weeks.at(-1) ?? 0)} nesta semana` }, ...children);
  return [capped(g, width), legend()];
}

function frequencyChart(f) {
  const BIG = 19;
  const SIDE = 16;
  const weeks = frequencyGrid(f.weeks);
  const n = weeks.length;
  const width = GRID_LEFT + n * BIG;
  const row = (y, level, text) =>
    weeks.map((w, i) => svg('rect', { class: `repo-heat-cell ${level(w)}`, x: GRID_LEFT + i * BIG, y, width: SIDE, height: SIDE, rx: 2.5 }, svg('title', {}, text(w))));
  const g = svg(
    'svg',
    { viewBox: `0 0 ${width} ${2 * BIG + 14}`, class: 'repo-chart repo-heat', role: 'img', 'aria-label': `Frequência de código, ${n} semanas: ${signed(f.added, kilo)} linhas adicionadas e ${signed(-f.removed, kilo)} removidas` },
    svg('text', { x: 0, y: 12 }, 'adic.'),
    svg('text', { x: 0, y: BIG + 12 }, 'rem.'),
    ...row(0, (w) => ADDED[w.addedLevel], (w) => `Semana de ${dayLabel(w.week)}: ${signed(w.added, kilo)} linhas`),
    ...row(BIG, (w) => REMOVED[w.removedLevel], (w) => `Semana de ${dayLabel(w.week)}: ${signed(-w.removed, kilo)} linhas`),
    svg('text', { x: GRID_LEFT, y: 2 * BIG + 12 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: width, y: 2 * BIG + 12, 'text-anchor': 'end' }, 'esta semana'),
  );
  return capped(g, width);
}

export async function mount(area, ctx) {
  loadStyle();
  const { owner: owner, repo: name } = ctx.params;
  const tab = ctx.params.tab ?? 'metrics';
  const base = `/ui/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let period = periodFrom(location.search);
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;
  /** Quantas decisões (ADR e PDR) o repositório tem: só se sabe com a aba ADRs aberta. */
  let decisionCount = null;

  // ---------- o cabeçalho: montado uma vez, o segmentado não perde o foco ----------
  const title = el('h1', {}, `${owner}/${name}`);
  const ciSlot = el('span', {});
  const visSlot = el('span', {});
  const periodButtons = PERIODS.map(([v, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === period) }, label);
    b.addEventListener('click', () => switchPeriod(v));
    return b;
  });
  const openOnGithub = el('a', { class: 'btn outline', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icon('external'), 'Abrir no GitHub');
  const chips = el('div', { class: 'repo-chips' });
  const tabsNav = el('nav', { class: 'repo-tabs', 'aria-label': 'Seções do repositório' });
  const head = el(
    'header',
    { class: 'repo-head' },
    el(
      'div',
      { class: 'repo-head-l1' },
      el('a', { class: 'repo-back', href: '/ui/repos', 'aria-label': 'Voltar para Repositórios' }, icon('back')),
      title,
      ciSlot,
      visSlot,
      el('div', { class: 'repo-head-dir' }, tab === 'metrics' ? el('div', { class: 'repo-seg', role: 'group', 'aria-label': 'Período' }, ...periodButtons) : null, openOnGithub),
    ),
    chips,
    tabsNav,
  );
  const band = el('div', { hidden: true });
  const content = el('div', { class: 'repo-groups' });
  area.replaceChildren(head, band, content);
  if (!TABS.includes(tab)) {
    tabsNav.replaceChildren(...tabs());
    content.replaceChildren(
      empty({ icon: 'repos', title: 'Aba não encontrada', text: `O repositório não tem a aba ${tab}.`, action: { label: 'Ver as métricas', icon: 'analytics', onClick: () => ctx.navigate(base) } }),
    );
    return () => {};
  }

  function switchPeriod(v) {
    if (v === period) return;
    period = v;
    for (const [i, b] of periodButtons.entries()) b.setAttribute('aria-pressed', String(PERIODS[i][0] === v));
    history.replaceState(history.state, '', `${location.pathname}?period=${v}`);
    data = null;
    failure = null;
    content.replaceChildren(loading({ label: `Lendo ${periodLabel(v)}…` }));
    read();
  }

  // ---------- os valores ----------
  const value = (v, field, format) => valueOrPending(v, data, field, format).texto;

  function stat(label, field, v, format, sub, iconName, color) {
    const r = valueOrPending(v, data, field, format);
    const has = v !== null && v !== undefined;
    return el(
      'section',
      { class: 'card repo-stat' },
      el('span', { class: 'repo-stat-label' }, label),
      el('span', { class: `repo-stat-ic ${color}` }, icon(iconName)),
      el('span', { class: has ? 'repo-stat-v' : 'repo-stat-v repo-pending' }, r.texto),
      el('span', { class: 'repo-stat-s' }, has ? sub : ''),
    );
  }

  function chip(iconName, title, visible, reader = null) {
    return el('span', { class: 'repo-chip', title: title }, icon(iconName), visible, reader ? srOnly(reader) : null);
  }

  function drawHeader() {
    const r = data?.repo;
    title.textContent = r?.fullName ?? `${owner}/${name}`;
    ctx.title(tab === 'instructions' ? `${title.textContent} · Instruções` : tab === 'adrs' ? `${title.textContent} · ADRs` : title.textContent);
    ciSlot.replaceChildren(...(r?.ci ? [ciPill(r.ci)] : []));
    visSlot.replaceChildren(...(r ? [el('span', { class: 'repo-chip repo-chip-sans' }, r.visibility === 'public' ? 'público' : 'privado')] : []));
    const url = r ? githubUrl(r.url) : null;
    openOnGithub.hidden = !url;
    if (url) openOnGithub.setAttribute('href', url);
    else openOnGithub.removeAttribute('href');
    tabsNav.replaceChildren(...tabs());
    if (!r) return chips.replaceChildren();
    const now = Date.now();
    const list = [
      r.defaultBranch ? chip('branch', 'Branch padrão', r.defaultBranch, ' (branch padrão)') : null,
      chip('star', 'Estrelas', integer(r.stars), r.stars === 1 ? ' estrela' : ' estrelas'),
      chip('subagent', 'Forks', integer(r.forks), r.forks === 1 ? ' fork' : ' forks'),
      chip('eye', 'Observadores', integer(r.watchers), r.watchers === 1 ? ' observador' : ' observadores'),
      r.release ? chip('tag', 'Última release', `${r.release.tag} · ${ago(r.release.at, now)}`, ' (última release)') : null,
      r.license ? chip('license', 'Licença', r.license, ' (licença)') : null,
    ];
    // `replaceChildren` escreveria "null": só os chips que existem.
    chips.replaceChildren(...list.filter(Boolean));
  }

  /** A fila de abas (C29): Métricas, Issues, PRs, CI, Sessões, Decisões, ADRs e Instruções; a aberta com `aria-current`. */
  function tabs() {
    const url = data?.repo ? githubUrl(data.repo.url) : null;
    const count = (label, n) => (typeof n === 'number' ? `${label} (${integer(n)})` : label);
    const outside = (path, iconName, label) =>
      url ? el('a', { href: `${url}/${path}`, target: '_blank', rel: 'noopener noreferrer' }, icon(iconName), label) : el('span', {}, icon(iconName), label);
    const own = (id, href, iconName, label) => (tab === id ? el('span', { 'aria-current': 'page' }, icon(iconName), label) : el('a', { href }, icon(iconName), label));
    return [
      own('metrics', base, 'analytics', 'Métricas'),
      outside('issues', 'dot', count('Issues', data?.tabs?.issues)),
      outside('pulls', 'git-pull-request', count('PRs', data?.tabs?.prs)),
      outside('actions', 'ci', 'CI'),
      // A tela Sessões não filtra por repositório: a busca casa com o diretório, e o clone tem o nome do repo.
      el('a', { href: `/ui/sessions?search=${encodeURIComponent(name)}`, title: `Sessões cujo diretório tem "${name}"` }, icon('sessions'), count('Sessões', data?.tabs?.sessions)),
      el('span', { 'aria-disabled': 'true', title: 'As decisões ainda não têm contagem por repositório' }, icon('decision'), 'Decisões'),
      // Decisões são as das sessões; ADRs são os registros que estão no repositório (ADR e PDR).
      own('adrs', `${base}/adrs`, 'scroll-text', count('ADRs', decisionCount)),
      own('instructions', `${base}/instructions`, 'book-open', 'Instruções'),
    ];
  }

  function kpis() {
    const { lines: rows, commits, prs, issues, ci } = data;
    const periodText = periodLabel(data.period ?? period);
    const median = (ms, text) => (ms === null ? 'sem mediana no período' : text(duration(ms)));
    const ciSub = ci ? `${integer(ci.runs)} execuções${ci.averageDurationMs === null ? '' : ` · ${duration(ci.averageDurationMs)} médio`}` : '';
    return el(
      'div',
      { class: 'repo-stats repo-stats-6' },
      stat('Linhas', 'lines', rows?.total ?? null, thousand, rows ? `${signed(rows.inPeriod, thousand)} em ${periodText}` : '', 'lines', 'repo-c-accent'),
      stat('Commits', 'commits', commits?.total ?? null, integer, commits ? `~${integer(commits.perWeek)} por semana` : '', 'decision', 'repo-c-accent'),
      stat('PRs mergeados', 'prs', prs?.merged ?? null, integer, prs ? median(prs.medianTimeToMergeMs, (d) => `merge em ${d} (mediana)`) : '', 'merge', 'repo-c-ok'),
      stat('Issues fechadas', 'issues', issues?.closed ?? null, integer, issues ? median(issues.medianTimeToCloseMs, (d) => `fecha em ${d} (mediana)`) : '', 'ok', 'repo-c-ok'),
      stat('Review', 'prs', prs?.medianTimeToFirstReviewMs ?? null, duration, 'até o 1º review (mediana)', 'conversation', 'repo-c-wait'),
      stat('CI verde', 'ci', ci?.greenRate ?? null, percentage, ciSub, 'ci', 'repo-c-ok'),
    );
  }

  function commitsCard() {
    const c = data.commits;
    if (!c) return card('Commits por dia', null, note(value(null, 'commits')));
    if (!c.weeks.length || !c.days?.length) return card('Commits por dia', null, note('Nenhuma semana no período'));
    return card('Commits por dia', `${c.weeks.length} ${c.weeks.length === 1 ? 'semana' : 'semanas'}`, ...commitsChart(c));
  }

  function frequencyCard() {
    const f = data.frequency;
    const t = 'Frequência de código';
    const r = 'linhas adicionadas e removidas por semana';
    if (!f) return card(t, r, note(value(null, 'frequency')));
    if (!f.weeks.length) return card(t, r, note('Nenhuma semana no período'));
    return card(
      t,
      r,
      frequencyChart(f),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Adicionadas ', el('b', {}, signed(f.added, kilo))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-error' }), 'Removidas ', el('b', {}, signed(-f.removed, kilo))),
      ),
    );
  }

  function issuesCard() {
    const i = data.issues;
    const t = 'Issues fechadas por tipo';
    if (!i) return card(t, 'fechadas · abertas', note(value(null, 'issues')));
    if (!i.byType.length) return card(t, 'fechadas · abertas', note('Nenhuma issue no período'));
    const max = Math.max(1, ...i.byType.map((x) => x.closed));
    return card(
      t,
      'fechadas · abertas',
      el(
        'div',
        {},
        ...i.byType.map((x) =>
          el(
            'div',
            { class: 'repo-type' },
            el('span', { class: 'repo-trunc', title: x.type }, x.type),
            el('div', { class: 'repo-bar', 'aria-hidden': 'true' }, barH((x.closed / max) * 100, TYPE_COLOR[x.type] ?? 'repo-k-muted')),
            el(
              'span',
              { class: 'repo-type-q' },
              el('span', { 'aria-hidden': 'true' }, `${integer(x.closed)} · ${integer(x.open)}`),
              srOnly(`${integer(x.closed)} ${x.closed === 1 ? 'fechada' : 'fechadas'}, ${integer(x.open)} ${x.open === 1 ? 'aberta' : 'abertas'}`),
            ),
          ),
        ),
      ),
      partialSample(i.sample, 'Por tipo', 'issues lidas'),
    );
  }

  function prsCard() {
    const p = data.prs;
    const periodText = periodLabel(data.period ?? period);
    if (!p) return card('Pull requests', periodText, note(value(null, 'prs')));
    const [m, f, a] = slices([p.merged, p.closedUnmerged, p.open]);
    const size = p.medianSize ? `${signed(p.medianSize.added)} ${signed(-p.medianSize.removed)}` : DASH;
    return card(
      'Pull requests',
      periodText,
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, barH(m, 'repo-k-ok'), barH(f, 'repo-k-muted'), barH(a, 'repo-k-wait')),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Mergeados ', el('b', {}, integer(p.merged))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-muted' }), 'Fechados sem merge ', el('b', {}, integer(p.closedUnmerged))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-wait' }), 'Abertos ', el('b', {}, integer(p.open))),
      ),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Tamanho mediano ', el('b', {}, size)),
        el('span', {}, 'Rodadas de review ', el('b', {}, decimal(p.reviewRounds))),
        el('span', {}, 'Abertos por agentes ', el('b', {}, percentage(p.agentShare))),
      ),
      partialSample(p.sample, 'Medianas', 'PRs lidos'),
    );
  }

  function languagesCard() {
    const l = data.languages;
    if (!l) return card('Linguagens', 'bytes', note(value(null, 'languages')));
    const parts = languages(l);
    if (!parts.length) return card('Linguagens', 'bytes', note('Nenhuma linguagem detectada'));
    const color = (p, i) => (p.nome === 'Outras' ? 'repo-k-border' : LANGUAGE_COLORS[i]);
    return card(
      'Linguagens',
      'bytes',
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, ...parts.map((p, i) => barH(p.pct, color(p, i)))),
      el('div', { class: 'repo-lang' }, ...parts.map((p, i) => el('span', {}, el('span', { class: `repo-dot ${color(p, i)}` }), el('span', { class: 'repo-trunc' }, p.nome), el('span', { class: 'repo-lang-pct' }, `${Math.round(p.pct)}%`)))),
    );
  }

  function contributorsCard() {
    const c = data.contributors;
    if (!c) return card('Quem contribuiu', null, note(value(null, 'contributors')));
    if (!c.length) return card('Quem contribuiu', null, note('Ninguém contribuiu no período'));
    return el(
      'div',
      { class: 'card' },
      el(
        'table',
        { class: 'repo-table' },
        el('colgroup', {}, el('col', { class: 'repo-contrib-who' }), el('col', { class: 'repo-contrib-n' }), el('col', { class: 'repo-contrib-n' }), el('col', { class: 'repo-contrib-n' })),
        el(
          'thead',
          {},
          el('tr', {}, el('th', { scope: 'col' }, 'Quem contribuiu'), el('th', { scope: 'col', class: 'repo-dir' }, 'Commits'), el('th', { scope: 'col', class: 'repo-dir' }, 'Adicionadas'), el('th', { scope: 'col', class: 'repo-dir' }, 'Removidas')),
        ),
        el(
          'tbody',
          {},
          ...c.slice(0, CONTRIBUTORS).map((p) =>
            el(
              'tr',
              {},
              el('td', { title: p.login }, p.login),
              el('td', { class: 'repo-num repo-dir' }, integer(p.commits)),
              el('td', { class: 'repo-num repo-dir repo-c-ok' }, signed(p.added, kilo)),
              el('td', { class: 'repo-num repo-dir repo-c-error' }, signed(-p.removed, kilo)),
            ),
          ),
        ),
      ),
    );
  }

  function trafficCard() {
    const periodText = periodLabel(data.period ?? period);
    const releases = el(
      'span',
      {},
      'Releases ',
      el('b', {}, value(data.releases, 'releases', integer)),
      data.releases !== null && data.releases !== undefined ? ` em ${periodText}` : null,
      data.releasesTotal !== null && data.releasesTotal !== undefined ? ` · ${integer(data.releasesTotal)} no total` : null,
    );
    const community = el('span', {}, 'Saúde da comunidade ', el('b', {}, value(data.community, 'community', (n) => `${integer(n)}%`)));
    // Sem escrita (critério 5 da issue 105), tráfego e alertas somem: só a comunidade.
    if (trafficCardKind(data) === 'community') return card('Comunidade', null, el('div', { class: 'repo-leg' }, community, releases));

    const t = data.traffic ?? null;
    const s = data.security ?? null;
    const alert = (label, n) => {
      const color = !s || n === null ? 'repo-k-muted' : n > 0 ? 'repo-k-wait' : 'repo-k-ok';
      return el('span', {}, el('span', { class: `repo-dot ${color}` }), `${label} `, el('b', {}, s ? (n === null ? 'desligado' : integer(n)) : value(null, 'security')));
    };
    const origins = !t ? [el('b', {}, value(null, 'traffic'))] : t.referrers.length ? t.referrers.flatMap((o, i) => (i ? [', ', el('b', {}, o)] : [el('b', {}, o)])) : [el('b', {}, DASH)];
    return card(
      'Tráfego e segurança',
      `${t?.days ?? 14} dias`,
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Visitas ', el('b', {}, value(t?.views ?? null, 'traffic', integer)), t ? ` (${integer(t.uniques)} únicas)` : null),
        el('span', {}, 'Clones ', el('b', {}, value(t?.clones ?? null, 'traffic', integer))),
      ),
      el('div', { class: 'repo-leg' }, el('span', {}, 'Origem: ', ...origins)),
      el('div', { class: 'repo-leg' }, alert('Alertas do Dependabot', s?.dependabot ?? null), alert('Code scanning', s?.codeScanning ?? null)),
      el('div', { class: 'repo-leg' }, community, releases),
      el('span', { class: 'repo-note' }, 'Tráfego e alertas só aparecem para quem tem acesso de escrita no repositório.'),
    );
  }

  function metrics() {
    return [
      kpis(),
      el('div', { class: 'repo-two' }, commitsCard(), frequencyCard()),
      el('div', { class: 'repo-three' }, issuesCard(), prsCard(), languagesCard()),
      el('div', { class: 'repo-end' }, contributorsCard(), trafficCard()),
    ];
  }

  // ---------- os estados ----------
  const retry = () => (content.replaceChildren(loading()), read());
  const notFound = () =>
    empty({ icon: 'repos', title: 'Repositório não encontrado', text: `${owner}/${name} não existe ou a conta do GitHub não tem acesso a ele.`, action: { label: 'Voltar para Repositórios', icon: 'back', onClick: () => ctx.navigate('/ui/repos') } });

  function draw() {
    clearTimeout(timer);
    timer = null;
    drawHeader();
    const e = screenState({ dados: data, falha: failure, temDado: hasRepo(data) });
    if (e.reler) timer = setTimeout(read, REREAD_MS);
    // Na aba Instruções, as métricas só enchem o cabeçalho: o conteúdo e os estados são da aba.
    if (tab !== 'metrics') return;

    const when = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (e.faixa === 'connection') band.replaceChildren(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura${when ? `, de ${when}` : ''}.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    else if (e.faixa === 'github') band.replaceChildren(errorBand({ title: 'GitHub com problema.', text: `${data.error}. Mostrando as métricas${when ? ` de ${when}` : ' da última leitura'}.` }));
    else band.replaceChildren();
    band.hidden = !band.firstChild;

    if (isGithubNotConnected(failure)) return content.replaceChildren(connectEmptyFor('repo', ctx.navigate));
    if (e.tela === 'error') return content.replaceChildren(failure ? error({ text: failure.message, retry }) : error({ title: 'O GitHub não respondeu', text: data.error ?? 'A leitura do repositório falhou.', retry }));
    if (e.tela === 'loading') return content.replaceChildren(loading());
    if (e.tela === 'reading') return content.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
    if (e.tela === 'no-github') return content.replaceChildren(empty({ icon: 'github', ...NO_GITHUB }));
    if (e.tela !== 'data') return content.replaceChildren(notFound());
    content.replaceChildren(...metrics());
  }

  async function read() {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    const p = period;
    // Resposta de um pedido velho ou de um período que a pessoa já trocou: descartada.
    const stillValid = () => currentResponse({ pedido: n, ultimo: request, periodo: p, periodoAtual: period });
    try {
      const d = await ctx.read(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?period=${p}`);
      if (!stillValid()) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || !stillValid()) return;
      failure = e instanceof Error ? e : new Error(String(e));
      if (isGithubNotConnected(e)) data = null;
    }
    draw();
  }

  ctx.onChange((changes) => {
    if (changeMatters(changes, `${owner}/${name}`)) read();
  });
  ctx.onRestart(() => read());

  if (tab === 'adrs') {
    drawHeader();
    const header = read();
    const leaveDecisions = await mountRepoDecisions(content, ctx, {
      owner,
      name,
      onCount: (n) => {
        if (n === decisionCount) return;
        decisionCount = n;
        tabsNav.replaceChildren(...tabs());
      },
    });
    await header;
    return () => {
      clearTimeout(timer);
      timer = null;
      request++;
      leaveDecisions?.();
    };
  }

  if (tab === 'instructions') {
    drawHeader();
    const header = read();
    const leaveInstructions = await mountInstructions(content, ctx, { owner, name });
    await header;
    return () => {
      clearTimeout(timer);
      timer = null;
      request++;
      leaveInstructions?.();
    };
  }

  content.replaceChildren(loading());
  await read();
  return () => {
    clearTimeout(timer);
    timer = null;
    request++;
  };
}
