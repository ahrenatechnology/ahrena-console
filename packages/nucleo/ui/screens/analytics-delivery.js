// The Analytics Delivery tab (C54 to C56, issue 266): /ui/analytics/delivery.
//
// - Reads `GET /api/analytics/delivery?days=&groupBy=&key=&tz=` through `ctx.read`, with the
//   browser's time zone. The choices (period, axis, row) live in the URL query (`?days=7&groupBy=
//   project&key=owner/1`), written with `history.replaceState`, defaults left out.
// - The axis ("Por repositório" or "Por projeto") switches the whole tab: contributions, small
//   multiples, the effort table and the open items. A row is always a repository or a project,
//   never a person: nothing here shows an author, an assignee or a reviewer.
// - Live: a change re-reads after a few seconds (one re-read per burst); a restart re-reads now. The
//   search and the kind filter of "Em andamento" are client-side, and survive the re-reads.
// - Charts are SVG drawn here; size and position are SVG attributes, colour only by class
//   (analytics.css, prefix an-dl-). Unknown is "—", never zero.
//
// This module imports the shared pieces from analytics.js, which imports this one on demand.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { githubUrl } from '../repos-format.js';
import { analyticsHeader, browserTimeZone, card, DELIVERY_ROUTE, download, GROUP_BYS, PERIODS, quantity, REREAD_MS, stat, tabs, usd } from './analytics.js';
import { connectEmptyFor, isGithubNotConnected } from '../github-connect.js';

const DEFAULTS = { days: 30, groupBy: 'repo', key: null };
const PATH = '/ui/analytics/delivery';
// The key's shape per axis, as the core checks it (src/api/delivery.ts `validKey`): a repository is
// `owner/name`, a project `owner/number`. A key of the other shape would be refused with a 400.
// The owner and name patterns are the core's (src/github/repos-source.ts).
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const PROJECT_NUMBER = /^\d{1,9}$/;
function validKeyFor(groupBy, key) {
  const parts = String(key).split('/');
  if (parts.length !== 2 || !OWNER.test(parts[0])) return false;
  return groupBy === 'project' ? PROJECT_NUMBER.test(parts[1]) : REPO_NAME.test(parts[1]);
}

const SUBS = {
  repo: 'O ritmo de entrega de cada repositório no GitHub, com o esforço do Claude no mesmo repositório',
  project: 'O ritmo de entrega de cada GitHub Project, com o esforço do Claude nos repositórios dele',
};

// ---------- Formatting (pt-BR) ----------

const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const oneDigit = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const known = (n) => n !== null && n !== undefined && Number.isFinite(n);
const plural = (n, one, many) => `${integer.format(n)} ${n === 1 ? one : many}`;
export const DASH = '—';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Median time to merge: "42 min", "9 h", "1,8 d". */
export function leadTime(ms) {
  if (!known(ms) || ms < 0) return DASH;
  if (ms < HOUR) return `${integer.format(Math.max(1, Math.round(ms / MIN)))} min`;
  if (ms < DAY) return `${integer.format(Math.round(ms / HOUR))} h`;
  return `${oneDigit.format(ms / DAY)} d`;
}

/** How long an item has been open: "41 d", "6 h", "12 min". */
export function age(ms) {
  if (!known(ms) || ms < 0) return DASH;
  if (ms >= DAY) return `${integer.format(Math.floor(ms / DAY))} d`;
  if (ms >= HOUR) return `${integer.format(Math.floor(ms / HOUR))} h`;
  return `${integer.format(Math.max(1, Math.floor(ms / MIN)))} min`;
}

/** Claude hours: "180 h", "64,2 h"; unknown is "—", never "0 h". */
export function hours(h) {
  if (!known(h)) return DASH;
  return `${(Math.abs(h) >= 100 ? integer : oneDigit).format(h)} h`;
}

/** A cost that may be unknown: "—" (never "sem preço" nor US$ 0 for unknown). */
export const cost = (v, { short = false } = {}) => (known(v) ? usd(v, { curto: short }) : DASH);

/** "2026-09-21" becomes "21/09". */
export function dayMonth(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  return m ? `${m[3]}/${m[2]}` : String(day ?? '');
}

/** "22:41" in the time zone, or `null`. */
export function hourMinute(iso, timeZone) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

/** The heat level of a value against the largest one: 0 (nothing) to 5. */
export function heatLevel(v, max) {
  if (!known(v) || v <= 0 || !known(max) || max <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((v / max) * 5)));
}

const OPEN_STATES = {
  draft: ['rascunho', 'muted'],
  review: ['esperando review', 'waiting'],
  ciFailed: ['CI ✕', 'error'],
  approved: ['aprovado', 'completed'],
  issueWithPr: [null, 'waiting'],
  issueWithoutPr: ['sem PR', 'muted'],
};

/** The pill of an open item: its pt-BR text and its tone (a class an-dl-p-<tone>). */
export function openState(item) {
  const [text, tone] = OPEN_STATES[item?.state] ?? ['aberto', 'muted'];
  if (item?.state === 'issueWithPr') return { text: known(item.linkedPr) ? `PR #${item.linkedPr} aberto` : 'PR aberto', tone };
  return { text, tone };
}

// ---------- State in the URL ----------

/** The tab's choices from `location.search`; anything invalid falls back to the default. */
export function parseDeliveryQuery(search) {
  const p = new URLSearchParams(search ?? '');
  const days = Number(p.get('days'));
  const groupBy = p.get('groupBy');
  const key = p.get('key');
  const axis = GROUP_BYS.includes(groupBy) ? groupBy : DEFAULTS.groupBy;
  return {
    days: PERIODS.includes(days) ? days : DEFAULTS.days,
    groupBy: axis,
    key: key && validKeyFor(axis, key) ? key : null,
  };
}

const keyParam = (key) => encodeURIComponent(key).replace(/%2F/gi, '/');

/** The query the URL keeps, defaults left out: "" or "?days=7&groupBy=project&key=owner/1". */
export function deliveryQuery({ days, groupBy, key }) {
  const parts = [];
  if (days !== DEFAULTS.days) parts.push(`days=${days}`);
  if (groupBy !== DEFAULTS.groupBy) parts.push(`groupBy=${encodeURIComponent(groupBy)}`);
  if (key) parts.push(`key=${keyParam(key)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** The read route: every parameter explicit, `key` only when there is one. */
export function deliveryRoute({ days, groupBy, key }, timeZone) {
  const k = key ? `&key=${encodeURIComponent(key)}` : '';
  return `${DELIVERY_ROUTE}?days=${encodeURIComponent(days)}&groupBy=${encodeURIComponent(groupBy)}${k}&tz=${encodeURIComponent(timeZone)}`;
}

/** The exported file: what is on screen, named by axis, period and last day. */
export function deliveryFileName(data, { days, groupBy }) {
  const day = typeof data?.until === 'string' ? data.until : typeof data?.today === 'string' ? data.today : 'today';
  return `ahrena-analytics-delivery-${groupBy}-${days}d-${day}.json`;
}

// ---------- Open items: client-side search ----------

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** The open items that match the search (title, repository column or number) and the kind; API order kept. */
export function filterOpenItems(items, { search = '', kind = 'all' } = {}, repoText = (i) => i.repo) {
  const q = fold(search).trim();
  const digits = /^#?\d+$/.test(q) ? q.replace(/^#/, '') : null;
  return (items ?? []).filter((i) => {
    if (kind !== 'all' && i.kind !== kind) return false;
    if (!q) return true;
    if (digits !== null && String(i.number).includes(digits)) return true;
    return fold(i.title).includes(q) || fold(repoText(i)).includes(q) || fold(i.repo).includes(q);
  });
}

/** The answer as the screen draws it: without the time it was made, and with the items' ages as
 *  written ("41 d"). Two reads with the same shape draw the same screen. */
export function sameShape(data) {
  try {
    return JSON.stringify(data, (k, v) => (k === 'generatedAt' ? undefined : k === 'ageMs' ? age(v) : v));
  } catch {
    return null;
  }
}

// ---------- SVG ----------

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attributes)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const f of children.flat()) {
    if (f === null || f === undefined || f === false) continue;
    node.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return node;
}
const r1 = (n) => Math.round(n * 10) / 10;

/** One small multiple: the merged PRs per day on the row's own scale, the Claude hours as a dashed
 *  line behind the bars (on their own scale), the baseline and the first and last days. */
export function smallMultiple(row, calendar, sub = null) {
  const merged = row.mergedPerDay ?? [];
  const hoursPerDay = row.claudeHoursPerDay ?? [];
  const n = Math.max(1, merged.length);
  const W = 300;
  const H = 64;
  const step = W / n;
  const peak = Math.max(0, ...merged);
  const withHours = hoursPerDay.some(known);
  const maxHours = Math.max(0, ...hoursPerDay.filter(known)) || 1;
  const y = (v, max) => r1(H - (v / max) * (H - 6));
  const children = [];
  // The line first: SVG paints in order, so the bars cover it.
  if (withHours) {
    const points = merged.map((_, i) => `${r1(i * step + step / 2)},${y(hoursPerDay[i] ?? 0, maxHours)}`).join(' ');
    children.push(svg('polyline', { class: 'an-dl-hours', points, 'vector-effect': 'non-scaling-stroke' }));
  }
  if (peak > 0) {
    merged.forEach((v, i) => {
      if (v > 0) children.push(svg('rect', { class: 'an-dl-col', x: r1(i * step + step * 0.14), y: y(v, peak), width: r1(step * 0.72), height: r1(H - y(v, peak)), rx: 1.5 }));
    });
  }
  children.push(svg('line', { class: 'an-axis', x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, 'vector-effect': 'non-scaling-stroke' }));
  // One hover target per day, with the day's numbers.
  merged.forEach((v, i) => {
    const h = hoursPerDay[i];
    const text = `${dayMonth(calendar?.[i])}: ${plural(v, 'PR mesclado', 'PRs mesclados')}${known(h) ? ` · ${oneDigit.format(h)} h do Claude` : ''}`;
    children.push(svg('rect', { class: 'an-dl-target', x: r1(i * step), y: 0, width: r1(step), height: H }, svg('title', {}, text)));
  });
  const total = row.total ?? merged.reduce((s, v) => s + v, 0);
  return el(
    'div',
    { class: 'an-dl-small', 'data-row': row.key },
    el('div', { class: 'an-dl-small-top' }, el('b', { class: 'an-trunc', title: row.label }, row.label), el('span', {}, total > 0 ? `pico ${integer.format(row.peak ?? peak)} · total ${integer.format(total)}` : 'total 0')),
    sub ? el('div', { class: 'an-dl-small-sub an-trunc', title: sub }, sub) : null,
    svg('svg', { class: 'an-dl-svg', viewBox: `0 0 ${W} ${H + 1}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `PRs mesclados por dia em ${row.label}` }, children),
    calendar?.length ? el('div', { class: 'an-dl-axis' }, el('span', {}, dayMonth(calendar[0])), el('span', {}, dayMonth(calendar.at(-1)))) : null,
  );
}

// ---------- Pieces ----------

// In the effort table the "· parcial" goes under the value (so the column never widens past 1100), in
// the chip's own text colour, softer: the waiting colour has poor contrast on the strong heat levels.
const partialBelow = (on) => (on ? el('span', { class: 'an-dl-below' }, 'parcial') : null);
const nameHead = (groupBy) => (groupBy === 'project' ? 'Projeto' : 'Repositório');
const th = (text, numeric = true) => el('th', { class: numeric ? 'an-dl-num' : null, scope: 'col' }, text);

function nameCell(row, groupBy) {
  return el(
    'th',
    { class: 'an-dl-name', scope: 'row' },
    el('b', { class: 'an-trunc', title: row.label }, row.label),
    groupBy === 'project' ? el('small', {}, plural((row.repos ?? []).length, 'repositório', 'repositórios')) : null,
  );
}

function heatCell(value, max, text) {
  if (!known(value)) return el('td', { class: 'an-dl-heat an-dl-none' }, DASH);
  return el('td', { class: 'an-dl-heat' }, el('span', { class: `an-dl-chip an-dl-h${heatLevel(value, max)}` }, ...[text].flat()));
}

/** "Contribuições por tipo": one row per repository or project, the colour by the weight inside the row. */
export function contributionsCard(rows, groupBy) {
  const fields = ['openedPrs', 'mergedPrs', 'openedIssues', 'closedIssues', 'reviews'];
  return card(
    'Contribuições por tipo',
    `a cor mostra o peso de cada tipo dentro do próprio ${groupBy === 'project' ? 'projeto' : 'repositório'}`,
    el(
      'div',
      { class: 'an-dl-wrap' },
      el(
        'table',
        { class: 'an-dl-table an-dl-contrib' },
        el('thead', {}, el('tr', {}, th(nameHead(groupBy), false), th('PRs abertos'), th('PRs mesclados'), th('Issues abertas'), th('Issues fechadas'), th('Revisões'))),
        el(
          'tbody',
          {},
          ...rows.map((r) => {
            const values = fields.map((f) => r.contributions?.[f] ?? 0);
            const max = Math.max(0, ...values);
            return el(
              'tr',
              { 'data-row': r.key },
              nameCell(r, null),
              ...values.map((v) => (v > 0 ? el('td', { class: 'an-dl-heat' }, el('span', { class: `an-dl-chip an-dl-h${heatLevel(v, max)}` }, integer.format(v))) : el('td', { class: 'an-dl-heat' }, el('span', { class: 'an-dl-zero', role: 'img', title: 'nenhum', 'aria-label': 'nenhum' }, '·')))),
            );
          }),
        ),
      ),
    ),
  );
}

/** "Ritmo de entrega": a small multiple per row, each on its own scale. */
export function rhythmCard(rows, data, groupBy) {
  const repoLabel = new Map((data?.options?.repos ?? []).map((o) => [o.key, o.label]));
  const days = data?.days ?? (data?.calendar ?? []).length;
  return card(
    'Ritmo de entrega',
    `PRs mesclados por dia · últimos ${days} dias`,
    el(
      'div',
      { class: 'an-leg' },
      el('span', {}, el('i', { class: 'an-dl-key-bar', 'aria-hidden': 'true' }), 'PRs mesclados'),
      el('span', {}, el('i', { class: 'an-dl-key-line', 'aria-hidden': 'true' }), 'horas do Claude'),
      el('span', {}, `Cada gráfico tem escala própria: o pico de cada ${groupBy === 'project' ? 'projeto' : 'repositório'} está no canto.`),
    ),
    el('div', { class: 'an-dl-grid' }, ...rows.map((r) => smallMultiple(r, data?.calendar ?? [], groupBy === 'project' ? (r.repos ?? []).map((k) => repoLabel.get(k) ?? k).join(' · ') : null))),
  );
}

/** "Esforço e entrega": the colour by the weight inside each column. */
export function effortCard(rows, groupBy) {
  const max = (f) => Math.max(0, ...rows.map((r) => r[f]).filter(known));
  const m = { mergedPrs: max('mergedPrs'), claudeHours: max('claudeHours'), costUsd: max('costUsd'), costPerMergedPr: max('costPerMergedPr') };
  return card(
    'Esforço e entrega',
    groupBy === 'project' ? 'o esforço do projeto é a soma dos repositórios dele' : 'a cor mostra o peso de cada valor na coluna',
    el(
      'div',
      { class: 'an-dl-wrap' },
      el(
        'table',
        { class: 'an-dl-table an-dl-effort' },
        el('thead', {}, el('tr', {}, th(nameHead(groupBy), false), th('PRs mesclados'), th('Até o merge'), th('Abertos'), th('Horas do Claude'), th('Custo'), th('Custo por PR'))),
        el(
          'tbody',
          {},
          ...rows.map((r) =>
            el(
              'tr',
              { 'data-row': r.key },
              nameCell(r, groupBy),
              heatCell(r.mergedPrs, m.mergedPrs, integer.format(r.mergedPrs ?? 0)),
              el('td', { class: 'an-dl-num an-dl-plain' }, leadTime(r.medianLeadTimeMs)),
              // Two chunks that never break inside: the cell only wraps between "5 PRs ·" and "21 issues".
              el('td', { class: 'an-dl-num an-dl-plain' }, el('span', { class: 'an-dl-chunk' }, `${plural(r.openPrs ?? 0, 'PR', 'PRs')} ·`), ' ', el('span', { class: 'an-dl-chunk' }, plural(r.openIssues ?? 0, 'issue', 'issues'))),
              heatCell(r.claudeHours, m.claudeHours, hours(r.claudeHours)),
              heatCell(r.costUsd, m.costUsd, [cost(r.costUsd), partialBelow(r.costPartial)]),
              heatCell(r.costPerMergedPr, m.costPerMergedPr, cost(r.costPerMergedPr)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** The six numbers of the period. With GitHub stale, its numbers say up to when. */
export function deliveryStats(data, { staleAt = null } = {}) {
  const t = data?.totals ?? {};
  const days = data?.days ?? 30;
  const merged = t.mergedPrs;
  const open = known(t.openPrs) || known(t.openIssues) ? (t.openPrs ?? 0) + (t.openIssues ?? 0) : null;
  const repos = t.repos ?? 0;
  const withClaude = t.reposWithClaude ?? 0;
  const claudeSub = withClaude === 0 ? 'sem sessões no período' : repos === 1 ? 'no repositório' : `em ${integer.format(withClaude)} dos ${integer.format(repos)} repositórios`;
  const until = staleAt ? `até ${staleAt}` : null;
  return el(
    'div',
    { class: 'an-stats an-six' },
    stat({ id: 'merged', rotulo: 'PRs mesclados', valor: quantity(merged), sub: until ?? (known(merged) ? `~${oneDigit.format(merged / days)} por dia` : DASH), icone: 'merge', cor: 'completed' }),
    stat({ id: 'lead-time', rotulo: 'Até o merge', valor: leadTime(t.medianLeadTimeMs), sub: until ? `mediana, ${until}` : 'mediana, do PR aberto ao merge', icone: 'timer', cor: 'accent' }),
    stat({
      id: 'open',
      rotulo: 'Abertos',
      valor: quantity(open),
      sub: open === null ? DASH : `${plural(t.openPrs ?? 0, 'PR', 'PRs')} · ${plural(t.openIssues ?? 0, 'issue', 'issues')}${until ? ` · ${until}` : ''}`,
      icone: 'git-pull-request',
      cor: 'waiting',
    }),
    stat({ id: 'claude-hours', rotulo: 'Horas do Claude', valor: hours(t.claudeHours), sub: claudeSub, icone: 'clock', cor: 'accent' }),
    stat({ id: 'cost', rotulo: 'Custo', valor: cost(t.costUsd, { short: true }), sub: [`estimativa · ${days} dias`, t.costPartial && known(t.costUsd) ? el('span', { class: 'an-partial' }, ' · parcial') : null], icone: 'an-dollar', cor: 'completed' }),
    stat({ id: 'cost-per-pr', rotulo: 'Custo por PR', valor: cost(t.costPerMergedPr), sub: 'custo ÷ PRs mesclados', icone: 'scale', cor: 'accent' }),
  );
}

/** The repository column of an open item: the repository, or "<project(s)> · repository" per project. */
export function repoColumn(data, groupBy) {
  const labels = new Map([...(data?.options?.projects ?? []), ...(data?.rows ?? [])].map((r) => [r.key, r.label]));
  return (item) => {
    if (groupBy !== 'project') return item.repo;
    const projects = (item.rowKeys ?? []).map((k) => labels.get(k) ?? k);
    return projects.length ? `${projects.join(', ')} · ${item.repo}` : item.repo;
  };
}

function openRow(item, repoText) {
  const { text, tone } = openState(item);
  const url = githubUrl(item.url);
  const kindLabel = item.kind === 'pr' ? 'PR' : 'Issue';
  return el(
    'div',
    { class: 'an-dl-open-row', role: 'listitem', 'data-kind': item.kind },
    el('span', { class: 'an-dl-kind', role: 'img', title: kindLabel, 'aria-label': kindLabel }, icon(item.kind === 'pr' ? 'git-pull-request' : 'dot')),
    el('span', { class: 'an-dl-number' }, `#${item.number}`),
    url ? el('a', { class: 'an-trunc', href: url, target: '_blank', rel: 'noopener noreferrer', title: item.title }, item.title) : el('span', { class: 'an-trunc', title: item.title }, item.title),
    el('span', { class: 'an-dl-repo an-trunc', title: repoText }, repoText),
    el('span', { class: `an-dl-pill an-dl-p-${tone}` }, text),
    el('span', { class: 'an-dl-age' }, age(item.ageMs)),
  );
}

// ---------- The tab ----------

/**
 * The body of the tab with data (after the header and the bar): stats and the four cards.
 * `view` is the state of "Em andamento" that outlives a redraw: `search` (the text in the box), `kind`
 * ('all', 'pr' or 'issue') and `scrollTop` (the list's scroll); the card updates it in place as the
 * person types, filters or scrolls. `focus` is `{ start, end }` when the search box had the focus
 * before the redraw (its caret), so the new box gets it back; otherwise `null`.
 */
export function deliveryScreen(data, { groupBy = data?.groupBy ?? 'repo', view = { search: '', kind: 'all', scrollTop: 0 }, timeZone = 'UTC', focus = null } = {}) {
  const rows = data?.rows ?? [];
  const staleAt = data?.github?.status === 'stale' ? hourMinute(data.github.readAt, timeZone) : null;
  return [deliveryStats(data, { staleAt }), contributionsCard(rows, groupBy), rhythmCard(rows, data, groupBy), effortCard(rows, groupBy), openCard(data, groupBy, view, focus)];
}

function openCard(data, groupBy, view, focus) {
  const items = data?.openItems ?? [];
  const repoText = repoColumn(data, groupBy);
  const list = el('div', { class: 'an-dl-open', role: 'list', 'aria-label': 'PRs e issues abertos' });
  const notes = el('div', { class: 'an-dl-notes' });
  const input = el('input', { type: 'search', placeholder: 'Buscar por título, repositório ou número', 'aria-label': 'Buscar por título, repositório ou número', maxlength: 200 });
  input.value = view.search;
  const kinds = [
    ['all', 'Todos'],
    ['pr', 'PRs'],
    ['issue', 'Issues'],
  ].map(([k, label]) => el('button', { type: 'button', 'data-kind': k, 'aria-pressed': view.kind === k ? 'true' : 'false' }, label));

  // Only the list and its notes are redrawn: the input keeps its focus while typing.
  function drawList() {
    const shown = filterOpenItems(items, view, repoText);
    list.replaceChildren(...shown.map((i) => openRow(i, repoText(i))));
    const lines = [];
    const q = view.search.trim();
    if (!items.length) lines.push('Nada aberto.');
    else if (!shown.length) lines.push(q ? `Nada aberto com “${q}”.` : view.kind === 'pr' ? 'Nenhum PR aberto.' : 'Nenhuma issue aberta.');
    if (data?.openItemsTruncated) lines.push(`Mostrando os ${integer.format(items.length)} mais antigos de ${integer.format(data.openItemsTotal ?? items.length)}.`);
    notes.replaceChildren(...lines.map((l) => el('p', { class: 'an-none' }, l)));
  }

  const toTop = () => {
    view.scrollTop = 0;
    list.scrollTop = 0;
  };
  input.addEventListener('input', (e) => {
    view.search = String((e?.target ?? input).value ?? '');
    drawList();
    toTop();
  });
  list.addEventListener('scroll', () => (view.scrollTop = list.scrollTop ?? 0));
  for (const b of kinds)
    b.addEventListener('click', () => {
      view.kind = b.getAttribute('data-kind');
      for (const o of kinds) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      drawList();
      toTop();
    });
  drawList();
  // After a live re-read: the list where it was, and the caret where it was (once the card is on screen).
  queueMicrotask(() => {
    if (view.scrollTop) list.scrollTop = view.scrollTop;
    if (!focus || typeof input.focus !== 'function') return;
    input.focus({ preventScroll: true });
    if (typeof input.setSelectionRange === 'function' && Number.isInteger(focus.start)) input.setSelectionRange(focus.start, focus.end ?? focus.start);
  });

  return card(
    'Em andamento',
    `${integer.format(data?.openItemsTotal ?? items.length)} abertos · os mais antigos primeiro`,
    el('div', { class: 'an-dl-open-bar' }, el('label', { class: 'an-dl-field' }, icon('search'), input), el('div', { class: 'an-seg', role: 'group', 'aria-label': 'Tipo' }, ...kinds)),
    list,
    notes,
  );
}

export async function mountDelivery(area, ctx, { rereadMs = REREAD_MS } = {}) {
  const timeZone = browserTimeZone();
  const state = parseDeliveryQuery(globalThis.location?.search ?? '');
  const view = { search: '', kind: 'all', scrollTop: 0 };
  let last = null; // the last answer, to export and to keep the screen when a re-read fails
  let nodes = null;
  let failBand = null; // the "Não deu para atualizar." band over the last good screen
  let nodesQuery = null; // the query the nodes on screen were drawn for
  let lastShape = null; // the last answer without what changes on every read
  let turn = 0;
  let wait = null;
  ctx.title?.('Analytics · Entregas');

  function writeUrl() {
    try {
      globalThis.history?.replaceState(globalThis.history.state, '', `${PATH}${deliveryQuery(state)}`);
    } catch {
      // A sandboxed page without history keeps working; the URL just does not follow.
    }
  }

  const change = (patch) => {
    Object.assign(state, patch);
    view.scrollTop = 0; // a new period, axis or row starts the open list at the top
    writeUrl();
    draw();
  };

  const head = (withExport = false) =>
    analyticsHeader(SUBS[state.groupBy], [
      el(
        'div',
        { class: 'an-seg', role: 'group', 'aria-label': 'Período' },
        ...PERIODS.map((p) => el('button', { type: 'button', 'aria-pressed': p === state.days ? 'true' : 'false', 'data-days': p, onClick: () => p !== state.days && change({ days: p }) }, `${p} dias`)),
      ),
      withExport ? el('button', { type: 'button', class: 'btn', title: 'Baixar o JSON do que está na tela', onClick: () => last && download(deliveryFileName(last, state), last) }, icon('an-download'), 'Exportar') : null,
    ].filter(Boolean));

  function bar(data) {
    const groupSeg = el(
      'div',
      { class: 'an-seg', role: 'group', 'aria-label': 'Agrupar' },
      ...[
        ['repo', 'Por repositório'],
        ['project', 'Por projeto'],
      ].map(([g, label]) => el('button', { type: 'button', 'data-group-by': g, 'aria-pressed': state.groupBy === g ? 'true' : 'false', onClick: () => g !== state.groupBy && change({ groupBy: g, key: null }) }, label)),
    );
    const options = state.groupBy === 'project' ? (data?.options?.projects ?? []) : (data?.options?.repos ?? []);
    const all = state.groupBy === 'project' ? 'Todos os projetos' : 'Todos os repositórios';
    const choices = [...options];
    // A key from the URL that the answer does not list still shows as chosen.
    if (state.key && !choices.some((o) => o.key.toLowerCase() === state.key.toLowerCase())) choices.push({ key: state.key, label: state.key });
    const select = el(
      'select',
      { class: 'an-dl-select', 'aria-label': state.groupBy === 'project' ? 'Projeto' : 'Repositório' },
      el('option', { value: '' }, all),
      ...choices.map((o) => el('option', { value: o.key, selected: state.key && o.key.toLowerCase() === state.key.toLowerCase() ? true : null }, o.label)),
    );
    select.value = state.key ? (choices.find((o) => o.key.toLowerCase() === state.key.toLowerCase())?.key ?? '') : '';
    select.addEventListener('change', (e) => {
      const v = String((e?.target ?? select).value ?? '');
      const key = v === '' ? null : v;
      if (key !== state.key) change({ key });
    });
    return el('div', { class: 'an-dl-bar' }, tabs('delivery'), groupSeg, select);
  }

  function notesOf(github) {
    const out = [];
    if ((github?.pending ?? 0) > 0) out.push(`Lendo ${plural(github.pending, 'repositório', 'repositórios')} do GitHub…`);
    for (const t of github?.truncated ?? []) out.push(t);
    return out.length ? el('div', { class: 'an-dl-notes' }, ...out.map((t) => el('p', { class: 'an-none' }, t))) : null;
  }

  function body(data) {
    const github = data?.github ?? { status: 'disconnected' };
    if (github.status === 'disconnected') {
      return [
        tabs('delivery'),
        empty({
          icon: 'github',
          title: 'Conecte o GitHub para ver as entregas',
          text: 'A aba conta PRs e issues dos repositórios das suas sessões. Nada aparece até você conectar uma conta; o console não escolhe repositório por você. Rode gh auth login no terminal e reinicie o núcleo.',
          action: { label: 'Tentar de novo', icon: 'refresh', onClick: () => draw({ quiet: true }) },
        }),
      ];
    }
    const rows = data?.rows ?? [];
    const out = [bar(data)];
    const retry = { label: 'Tentar agora', onClick: () => draw({ quiet: true }) };
    if (github.status === 'stale') {
      const at = hourMinute(github.readAt, timeZone);
      out.push(errorBand({ title: 'O GitHub não respondeu.', text: `Mostrando os PRs e as issues em cache${at ? `, lidos às ${at}` : ''}. Horas e custo do Claude estão em dia: vêm das sessões desta máquina.`, action: retry }));
    } else if (github.status === 'error') {
      out.push(errorBand({ title: 'O GitHub não respondeu.', text: github.error ?? null, action: retry }));
    }
    if (state.groupBy === 'project' && data?.projectsError) out.push(errorBand({ title: 'Não deu para ler os GitHub Projects.', text: data.projectsError }));
    const notes = notesOf(github);
    if (notes) out.push(notes);
    if (!rows.length) {
      if (github.status === 'loading') out.push(loading({ label: 'Lendo o GitHub…', blocks: 2 }));
      else if (github.status === 'error') out.push(empty({ icon: 'github', title: 'Nada em cache ainda', text: 'Os PRs e as issues aparecem quando o GitHub responder. Tente de novo em alguns minutos.' }));
      else if (state.groupBy === 'project' && data?.projectsPending) out.push(loading({ label: 'Lendo os GitHub Projects…', blocks: 2 }));
      else if (state.key) out.push(empty({ title: `Nada em ${state.key} nos últimos ${state.days} dias`, text: 'Escolha outro período ou volte para a lista inteira.', action: { label: 'Ver todos', onClick: () => change({ key: null }) } }));
      else if (state.groupBy === 'project')
        out.push(
          empty({
            icon: 'kanban',
            title: 'Nenhum GitHub Project com atividade',
            text: `Por projeto, a aba junta os repositórios de cada GitHub Project que o console lê. Nenhum deles tem PR ou issue de repositórios lidos nos últimos ${state.days} dias; ponha os repositórios num GitHub Project ou veja Por repositório.`,
          }),
        );
      else out.push(empty({ title: `Nenhum repositório com atividade nos últimos ${state.days} dias`, text: 'A aba mostra os repositórios das suas sessões do Claude Code e os que receberam push no período.' }));
      return out;
    }
    return [...out, ...deliveryScreen(data, { groupBy: state.groupBy, view, timeZone, focus: searchFocus() })];
  }

  /** The search box's caret when it has the focus, to give it back after a redraw; otherwise `null`. */
  function searchFocus() {
    const a = globalThis.document?.activeElement;
    const isSearch = !!a && String(a.tagName ?? '').toUpperCase() === 'INPUT' && a.getAttribute?.('type') === 'search' && typeof area.contains === 'function' && area.contains(a);
    return isSearch ? { start: a.selectionStart ?? null, end: a.selectionEnd ?? null } : null;
  }

  async function draw({ quiet = false } = {}) {
    const mine = ++turn;
    if (!quiet) area.replaceChildren(head(), bar(last && last.groupBy === state.groupBy ? last : null), loading());
    try {
      const data = await ctx.read(deliveryRoute(state, timeZone));
      if (mine !== turn) return;
      last = data;
      failBand?.remove();
      failBand = null;
      const query = deliveryQuery(state);
      const shape = sameShape(data);
      // A live re-read with nothing new keeps the screen as it is: the scroll, an open select, the caret.
      if (quiet && nodes && nodesQuery === query && shape !== null && shape === lastShape) return;
      lastShape = shape;
      nodes = [head(data?.github?.status !== 'disconnected'), ...body(data)];
      nodesQuery = query;
      area.replaceChildren(...nodes);
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== turn) return;
      // issue 241: not connected to GitHub: the shared "Conectar ao GitHub", under the Analytics tabs.
      if (isGithubNotConnected(e)) {
        nodes = null;
        nodesQuery = null;
        lastShape = null;
        failBand = null;
        area.replaceChildren(head(), tabs('delivery'), connectEmptyFor('delivery', ctx.navigate));
        return;
      }
      if (quiet && nodes && nodesQuery === deliveryQuery(state)) {
        // Only the band goes in: the screen below stays in place (and a focused search box keeps its focus).
        failBand?.remove();
        failBand = errorBand({ title: 'Não deu para atualizar.', text: `${e?.message ?? e}. Os números abaixo são da última leitura.`, action: { label: 'Tentar de novo', onClick: () => draw({ quiet: true }) } });
        nodes[0].after(failBand);
        return;
      }
      nodes = null;
      nodesQuery = null;
      lastShape = null;
      failBand = null;
      area.replaceChildren(head(), bar(null), error({ text: e?.message ?? String(e), retry: () => draw() }));
    }
  }

  ctx.onChange(() => {
    if (wait) return;
    wait = setTimeout(() => {
      wait = null;
      draw({ quiet: true });
    }, rereadMs);
  });
  ctx.onRestart(() => draw({ quiet: true }));
  writeUrl();
  await draw();
  return () => {
    clearTimeout(wait);
    wait = null;
    turn++;
  };
}
