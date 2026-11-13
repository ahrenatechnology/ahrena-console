import { el, header, icon } from '../dom.js';
import { errorBand } from '../states.js';

/** The six columns of the work board (issue 465), the same copy as WORK_BOARD_COLUMNS, for the states with no payload. */
export const COLUMNS = [
  { id: 'planning', label: 'Planejamento', criterion: 'Aberta, sem sessão de execução e fora da fila' },
  { id: 'queued', label: 'Na fila', criterion: 'Planejada e posta na fila; espera vaga' },
  { id: 'running', label: 'Em execução', criterion: 'Sessão da Athena trabalhando' },
  { id: 'review', label: 'Em review', criterion: 'PR aberto esperando o Argos' },
  { id: 'blocked', label: 'Bloqueado', criterion: 'Precisa de você, 3 rodadas ou CI falhou' },
  { id: 'done', label: 'Concluído', criterion: 'PR mergeado ou issue fechada' },
];

/** The reasons of Bloqueado in lower case, as the parent card lists them (issue 465). */
export const BLOCKED_LABELS = {
  'needs-you': 'precisa de você',
  'review-rounds': 'mudança pedida depois de 3 rodadas',
  'ci-failed': 'CI falhou',
};

/** The four levels of WORK_LEVELS on screen (issue 466). */
export const LEVEL_LABELS = { initiative: 'Iniciativa', epic: 'Épico/Milestone', item: 'Item', plan: 'Plano de execução' };

/** The type slugs on screen (issue 465). */
export const TYPE_LABELS = { story: 'História', task: 'Tarefa técnica', spike: 'Spike', bug: 'Bug', epic: 'Épico', initiative: 'Iniciativa', plan: 'Plano' };

/** The six filters, in the order of the bar, with the English URL param (issue 466). */
export const FILTER_FIELDS = [
  { param: 'initiative', label: 'Iniciativa', all: 'Todas', article: 'a iniciativa' },
  { param: 'epic', label: 'Épico/Milestone', all: 'Todos', article: 'o épico' },
  { param: 'type', label: 'Tipo', all: 'Todos', article: 'o tipo' },
  { param: 'label', label: 'Label', all: 'Todas', article: 'a label' },
  { param: 'repo', label: 'Repositório', all: 'Todos', article: 'o repositório' },
  { param: 'status', label: 'Status do Project', all: 'Todos', article: 'o Status' },
];

/** Where the person switches the GitHub Project: the project kanban's "Trocar de Project" (issue 465). */
export const SWITCH_PROJECT_HREF = '/ui/project';

const PATH_LABELS = { initiative: 'Iniciativa', epic: 'Épico' };
const REASON_ICONS = { 'needs-you': 'hand', 'review-rounds': 'repeat', 'ci-failed': 'error' };
const CI = { ok: ['CI ✓', 'completed'], failed: ['CI ✕', 'error'], running: ['CI …', 'waiting'] };
const REVIEW = { approved: ['aprovado', 'completed'], 'changes-requested': ['ajustes', 'error'], pending: ['review', 'waiting'] };
const SESSIONS = { working: 'trabalhando', 'needs-you': 'precisa de você', idle: 'ociosa' };
const TYPE_CLASSES = new Set(Object.keys(TYPE_LABELS));
const PLAN_COLUMNS = new Set(['planning', 'queued']);
const SKELETON_CARDS = [3, 1, 2, 2, 2, 2];
const DONE_AT_SIGHT = 2;

const ref = (n) => `#${n}`;
const pad = (n) => String(n).padStart(2, '0');
const shortRepo = (name) => String(name ?? '').split('/').pop();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const toMs = (at) => (typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN);
const isSet = (v) => v !== null && v !== undefined && v !== '';

/** "há 40 s", "há 31 min", "há 3 h", "há 2 d"; `at` is ISO or epoch ms; `null` when unknown. */
export function formatAgo(at, now) {
  const ms = toMs(at);
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return null;
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `há ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
}

/** The local hour "23:12"; `null` when unknown. */
export function formatClock(at) {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The last GitHub read in the header (issue 465): "lido às 23:12 · há 40 s", "nunca lido" or "lendo o GitHub…". */
export function readLabel({ fetchedAt, now, reading = false }) {
  if (reading) return 'lendo o GitHub…';
  const clock = formatClock(fetchedAt);
  return clock ? `lido às ${clock} · ${formatAgo(fetchedAt, now)}` : 'nunca lido';
}

/** The card's type on screen; an unknown type keeps GitHub's name. */
export function typeLabel(card) {
  return TYPE_LABELS[card?.type] ?? card?.typeName ?? 'Issue';
}

/** Time in the column (issue 465); in Concluído since the merge or the close: "mergeada há 2 d". */
export function cardAge(card, now) {
  if (card?.column === 'done' && card.doneAt && card.doneBy) {
    const ago = formatAgo(card.doneAt, now);
    const male = card.type === 'epic';
    const verb = card.doneBy === 'merged' ? (male ? 'mergeado' : 'mergeada') : male ? 'fechado' : 'fechada';
    return ago ? `${verb} ${ago}` : null;
  }
  return formatAgo(card?.columnSince, now);
}

/** The parent (issue 466): "↑ parent" in `compact`, the whole chain "initiative › epic › item" in `full`; `null` without one. */
export function chainText(card, chainMode = 'compact') {
  if (!card?.parent) return null;
  if (chainMode === 'full') return [...(card.chain ?? []).map((c) => ref(c.number)), ref(card.number)].join(' › ');
  return `↑ ${ref(card.parent.number)}`;
}

/** The sessions badge (issue 465): "2 sessões" past one, else the state; `null` without a session. */
export function sessionText(sessions) {
  const count = sessions?.count ?? 0;
  if (count < 1) return null;
  if (count > 1) return `${count} sessões`;
  return SESSIONS[sessions.state] ?? null;
}

/** "plano · 5 passos" (issue 465). */
export function planText(plan) {
  return `plano · ${plural(plan.steps, 'passo', 'passos')}`;
}

const sameNumber = (value, number) => (typeof value === 'number' || /^\d+$/.test(String(value))) && Number(value) === number;
const matchesAncestor = (option, value) => String(value) === option.key || sameNumber(value, option.number);
const isDuplicate = (option, all) => all.filter((o) => o.number === option.number).length > 1;

/** The URL value of an initiative or epic option (issue 466): the number, or the key when two repos share it. */
export function ancestorValue(option, all = []) {
  return isDuplicate(option, all) ? option.key : String(option.number);
}

function ancestorText(option, all) {
  return isDuplicate(option, all) ? `${shortRepo(option.repo)}${ref(option.number)}` : ref(option.number);
}

function rawAncestorText(value) {
  const text = String(value);
  return /^\d+$/.test(text) ? ref(text) : text.split('/').pop();
}

function chipValue(param, value, options = {}) {
  if (param === 'initiative' || param === 'epic') {
    const list = (param === 'initiative' ? options.initiatives : options.epics) ?? [];
    const found = list.find((o) => matchesAncestor(o, value));
    return found ? ancestorText(found, list) : rawAncestorText(value);
  }
  if (param === 'type') return TYPE_LABELS[value] ?? String(value);
  if (param === 'repo') return shortRepo(value);
  if (param === 'status') return value === 'no-status' ? 'Sem status' : ((options.statuses ?? []).find((s) => s.id === value)?.name ?? String(value));
  return String(value);
}

/** The active filters as chips (issue 466): `{ param, label, value }` in the bar's order. */
export function filterChips(filters = {}, options = {}) {
  return FILTER_FIELDS.filter((f) => isSet(filters?.[f.param])).map((f) => ({ param: f.param, label: f.label, value: chipValue(f.param, filters[f.param], options) }));
}

/** The path on the right of the level switch (issue 466): "Iniciativa #1", "Épico #6", with the title when known. */
export function boardPath(filters = {}, options = {}) {
  return ['initiative', 'epic']
    .filter((param) => isSet(filters?.[param]))
    .map((param) => {
      const list = (param === 'initiative' ? options.initiatives : options.epics) ?? [];
      const found = list.find((o) => matchesAncestor(o, filters[param]));
      const number = found ? ancestorText(found, list) : rawAncestorText(filters[param]);
      return { param, value: filters[param], text: `${PATH_LABELS[param]} ${number}`, title: found?.title ?? null };
    });
}

function choicesFor(param, options, current) {
  const list = (key) => options?.[key] ?? [];
  let choices;
  if (param === 'initiative' || param === 'epic') {
    const all = list(param === 'initiative' ? 'initiatives' : 'epics');
    choices = all.map((o) => ({
      value: ancestorValue(o, all),
      text: `${ancestorText(o, all)}${o.title ? ` ${o.title}` : ''} (${o.count})`,
      match: isSet(current) && matchesAncestor(o, current),
    }));
  } else if (param === 'type') {
    choices = list('types').map((t) => ({ value: t.id, text: `${TYPE_LABELS[t.id] ?? t.id} (${t.count})`, match: current === t.id }));
  } else if (param === 'label') {
    choices = list('labels').map((l) => ({ value: l.name, text: `${l.name} (${l.count})`, match: isSet(current) && String(current).toLowerCase() === l.name.toLowerCase() }));
  } else if (param === 'repo') {
    const same = (name) => isSet(current) && [name.toLowerCase(), shortRepo(name).toLowerCase()].includes(String(current).toLowerCase());
    choices = list('repos').map((r) => ({ value: r.name, text: `${shortRepo(r.name)} (${r.count})`, match: same(r.name) }));
  } else {
    choices = list('statuses').map((s) => ({ value: s.id, text: `${s.name} (${s.count})`, match: current === s.id }));
  }
  const chosen = choices.find((c) => c.match) ?? null;
  if (isSet(current) && !chosen) {
    const extra = { value: String(current), text: chipValue(param, current, options), match: true };
    return { choices: [...choices, extra], selected: extra.value };
  }
  return { choices, selected: chosen?.value ?? '' };
}

/** The header (issue 465): title, the Project, the last GitHub read and Atualizar (`onRefresh`, `busy`). */
export function workBoardHeader({ project = null, fetchedAt = null, now = Date.now(), stale = false, reading = false, busy = false, onRefresh = null } = {}) {
  const old = stale || (!reading && !isSet(fetchedAt));
  const read = el('span', { class: `wb-read${old ? ' wb-read-old' : ''}` }, icon('github'), el('span', {}, readLabel({ fetchedAt, now, reading })));
  const refresh = el(
    'button',
    { type: 'button', class: 'btn outline', 'data-action': 'refresh', 'aria-busy': busy ? 'true' : null, disabled: busy, onClick: () => onRefresh?.() },
    icon('refresh'),
    'Atualizar',
  );
  const where = project ? [project.primaryRepo, `GitHub Project “${project.title}”`].filter(Boolean).join(' · ') : null;
  return header({ icon: 'columns-3', title: 'Quadro do trabalho', sub: where ? `${where} · a coluna vem dos sinais` : null, actions: [read, refresh] });
}

/** The level switch above the filters and the path on the right (issue 466). */
export function levelSwitch({ levels = Object.keys(LEVEL_LABELS), level = 'item', path = [], disabled = false, onLevelChange = null, onPathSelect = null } = {}) {
  const group = el(
    'div',
    { class: 'wb-levels', role: 'group', 'aria-label': 'Nível' },
    ...levels.map((l) =>
      el('button', { type: 'button', class: 'wb-level', 'data-level': l, 'aria-pressed': String(l === level), disabled, onClick: () => l !== level && onLevelChange?.(l) }, LEVEL_LABELS[l] ?? l),
    ),
  );
  const steps = path.flatMap((p, i) => {
    const last = i === path.length - 1;
    const sep = i ? el('span', { class: 'wb-path-sep', 'aria-hidden': 'true' }, icon('chevron-right')) : null;
    if (last) return [sep, el('span', { class: 'wb-path-here', 'aria-current': 'location' }, el('b', {}, p.text), p.title ? el('span', { class: 'wb-path-title' }, p.title) : null)];
    const step = onPathSelect
      ? el('button', { type: 'button', class: 'wb-path-step', 'data-action': 'path', 'data-param': p.param, disabled, onClick: () => onPathSelect(p) }, p.text)
      : el('span', { class: 'wb-path-step' }, p.text);
    return [sep, step];
  });
  return el(
    'div',
    { class: 'wb-level-bar' },
    el('span', { class: 'wb-level-bar-label', 'aria-hidden': 'true' }, 'Nível'),
    group,
    level === 'item' ? el('span', { class: 'wb-level-note' }, 'história, tarefa técnica, spike e bug') : null,
    steps.length ? el('nav', { class: 'wb-path', 'aria-label': 'Caminho' }, ...steps) : null,
  );
}

/** The filter bar (issue 466): six selects, the chips with ×, Limpar filtros and the link with Copiar link. */
export function filterBar({ filters = {}, options = {}, link = null, disabled = false, onFilterChange = null, onClear = null, onCopyLink = null } = {}) {
  const fields = FILTER_FIELDS.map((f) => {
    const { choices, selected } = choicesFor(f.param, options, filters?.[f.param]);
    const select = el(
      'select',
      { class: 'wb-select', name: f.param, 'data-param': f.param, disabled },
      el('option', { value: '' }, f.all),
      ...choices.map((c) => el('option', { value: c.value, selected: c.value === selected }, c.text)),
    );
    select.value = selected;
    select.addEventListener('change', () => onFilterChange?.(f.param, select.value || null));
    return el('label', { class: `wb-field${isSet(filters?.[f.param]) ? ' wb-field-set' : ''}` }, el('span', { class: 'wb-field-label' }, f.label), select);
  });
  const chips = filterChips(filters, options);
  const chipRow = chips.length
    ? el(
        'div',
        { class: 'wb-chips' },
        el('span', { class: 'wb-chips-label' }, 'Todos os filtros juntos:'),
        ...chips.flatMap((c, i) => [
          i ? el('span', { class: 'wb-and' }, 'E') : null,
          el(
            'span',
            { class: 'wb-chip', 'data-param': c.param },
            `${c.label}: `,
            el('b', {}, c.value),
            el('button', { type: 'button', class: 'wb-chip-remove', 'data-action': 'remove-filter', 'data-param': c.param, 'aria-label': `Tirar o filtro ${c.label}`, disabled, onClick: () => onFilterChange?.(c.param, null) }, icon('x')),
          ),
        ]),
        el('button', { type: 'button', class: 'btn ghost wb-clear', 'data-action': 'clear', disabled, onClick: () => onClear?.() }, icon('filter'), 'Limpar filtros'),
      )
    : null;
  const linkRow = link
    ? el(
        'div',
        { class: 'wb-link' },
        el('span', { class: 'wb-link-label' }, 'Link deste recorte'),
        el('code', {}, link),
        el('button', { type: 'button', class: 'btn outline', 'data-action': 'copy-link', disabled, onClick: () => onCopyLink?.() }, icon('copy'), 'Copiar link'),
      )
    : null;
  return el('section', { class: `card wb-filters${disabled ? ' wb-off' : ''}`, 'aria-label': 'Filtros' }, el('div', { class: 'wb-fields' }, ...fields), chipRow, linkRow);
}

function chainNode(card, chainMode) {
  if (!card.parent) return null;
  if (chainMode !== 'full') return el('div', { class: 'wb-chain', title: 'Pai' }, chainText(card, 'compact'));
  const above = (card.chain ?? []).map((c) => `${ref(c.number)} › `).join('');
  return el('div', { class: 'wb-chain', title: 'Cadeia de pais' }, above, el('b', {}, ref(card.number)));
}

function reasonNode(blocked) {
  if (!blocked) return null;
  const fromGithub = blocked.reason !== 'needs-you';
  return el('div', { class: `wb-reason wb-reason-${blocked.reason}${fromGithub ? ' wb-gh' : ''}` }, icon(REASON_ICONS[blocked.reason] ?? 'alert'), el('span', {}, blocked.label));
}

const srOnly = (text) => el('span', { class: 'wb-sr-only' }, text);

function ageNode(card, now) {
  const age = cardAge(card, now);
  return age ? el('span', { class: 'wb-age' }, age) : null;
}

function cardTop(card, { primaryRepo, now, withAge }) {
  const otherRepo = primaryRepo && card.repo && card.repo.toLowerCase() !== primaryRepo.toLowerCase();
  const position = card.queuePosition;
  return el(
    'div',
    { class: 'wb-card-top' },
    isSet(position) ? el('span', { class: 'wb-queue-pos', title: 'Posição na fila', 'aria-hidden': 'true' }, `${position}º`) : null,
    isSet(position) ? srOnly(`${position}º na fila`) : null,
    el('span', { class: `wb-type wb-type-${TYPE_CLASSES.has(card.type) ? card.type : 'other'}` }, typeLabel(card)),
    el('span', { class: 'wb-number mono' }, ref(card.number)),
    otherRepo ? el('span', { class: 'wb-repo mono', title: card.repo }, shortRepo(card.repo)) : null,
    withAge ? ageNode(card, now) : null,
  );
}

const cardTitle = (card) =>
  el('h3', { class: 'wb-card-title' }, el('a', { href: card.url, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir a issue no GitHub' }, card.title));

const pill = (kind, tone, text, extra = '') => el('span', { class: `wb-pill wb-pill-${tone} ${kind}${extra}` }, text);

function cardBadges(card) {
  const session = sessionText(card.sessions);
  const p = card.pullRequest;
  const parts = [
    session ? pill('wb-session', card.sessions.state === 'needs-you' ? 'waiting' : card.sessions.state === 'idle' ? 'idle' : 'active', session, ` wb-session-${card.sessions.state ?? 'working'}`) : null,
    p ? el('a', { class: 'wb-pr wb-gh', href: p.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `PR ${ref(p.number)} no GitHub` }, icon('git-pull-request'), ref(p.number)) : null,
    p?.ci && CI[p.ci] ? pill('wb-ci', CI[p.ci][1], CI[p.ci][0], ' wb-gh') : null,
    p?.review && REVIEW[p.review] ? pill('wb-review', REVIEW[p.review][1], REVIEW[p.review][0], ' wb-gh') : null,
  ].filter(Boolean);
  return parts.length ? el('div', { class: 'wb-badges' }, ...parts) : null;
}

const toneOf = (card) => (!card.blocked ? '' : card.blocked.reason === 'ci-failed' ? ' wb-card-fail' : ' wb-card-attn');

/** A card at the item and plan levels (issue 465, 465-2): data only, no action and no drag handle. */
export function workCard(card, { chainMode = 'compact', primaryRepo = null, now = Date.now() } = {}) {
  return el(
    'article',
    { class: `card wb-card${toneOf(card)}`, 'data-key': card.key, 'data-column': card.column },
    cardTop(card, { primaryRepo, now, withAge: false }),
    cardTitle(card),
    chainNode(card, chainMode),
    reasonNode(card.blocked),
    el(
      'div',
      { class: 'wb-data' },
      el('span', { class: 'wb-status wb-gh', title: 'Status do GitHub Project' }, `Status: ${card.projectStatus?.name ?? 'Sem status'}`),
      card.plan && PLAN_COLUMNS.has(card.column) ? el('span', { class: 'wb-plan wb-gh' }, icon('list-checks'), planText(card.plan)) : null,
      ageNode(card, now),
    ),
    cardBadges(card),
  );
}

function childrenReason(blocked = {}) {
  const counts = Object.keys(BLOCKED_LABELS).filter((r) => blocked[r]).map((r) => [r, blocked[r]]);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return null;
  return [plural(total, 'filha bloqueada', 'filhas bloqueadas'), ...counts.map(([r, n]) => `${n} ${BLOCKED_LABELS[r]}`)].join(' · ');
}

/** An initiative or epic card (issue 466, 466-1): children closed, per column, blocked, and "Ver filhos ›" (`onDrill`). */
export function parentCard(card, { primaryRepo = null, now = Date.now(), onDrill = null } = {}) {
  const kids = card.children ?? { total: 0, done: 0, byColumn: {}, blocked: {} };
  const reason = childrenReason(kids.blocked);
  const fill = el('span', { class: 'wb-progress-fill' });
  fill.style.setProperty('--done-share', `${kids.total ? Math.round((kids.done / kids.total) * 100) : 0}%`);
  const byColumn = kids.byColumn ?? {};
  return el(
    'article',
    { class: `card wb-card wb-parent-card${toneOf(card)}`, 'data-key': card.key, 'data-column': card.column },
    cardTop(card, { primaryRepo, now, withAge: true }),
    cardTitle(card),
    chainNode(card, 'compact'),
    reason ? el('div', { class: `wb-reason wb-reason-${card.blocked?.reason ?? 'needs-you'}` }, icon('hand'), el('span', {}, reason)) : null,
    el(
      'div',
      { class: 'wb-progress' },
      el('span', {}, `${kids.done}/${kids.total} filhas concluídas`),
      el('span', { class: 'wb-progress-track', role: 'progressbar', 'aria-label': 'Filhas concluídas', 'aria-valuemin': '0', 'aria-valuemax': String(kids.total), 'aria-valuenow': String(kids.done) }, fill),
    ),
    el(
      'ul',
      { class: 'wb-dist', 'aria-label': 'Filhas por coluna' },
      ...COLUMNS.filter((c) => byColumn[c.id]).map((c) =>
        el('li', { 'data-column': c.id, title: c.label, 'aria-label': `${c.label}: ${byColumn[c.id]}` }, el('span', { class: `wb-dot wb-dot-${c.id}`, 'aria-hidden': 'true' }), String(byColumn[c.id])),
      ),
    ),
    el('button', { type: 'button', class: 'wb-drill', 'data-action': 'drill', 'data-key': card.key, 'aria-label': `Ver filhos (${kids.total}) de ${ref(card.number)}`, onClick: () => onDrill?.(card) }, `Ver filhos (${kids.total})`, icon('chevron-right')),
  );
}

function countLabel(count) {
  if (count === '…') return 'carregando';
  if (/^\d+$/.test(count)) return plural(Number(count), 'issue', 'issues');
  return 'sem dado';
}

const skeletonCard = () => el('div', { class: 'card wb-card wb-skeleton', 'aria-hidden': 'true' }, el('div', { class: 'bone short' }), el('div', { class: 'bone' }), el('div', { class: 'bone medium' }));

function doneMore(hidden, doneWindowDays) {
  const more = el('button', { type: 'button', class: 'wb-done-more' }, `+ ${plural(hidden.length, 'fechada', 'fechadas')} nos últimos ${doneWindowDays} dias · ver todas`);
  more.addEventListener('click', () => {
    for (const li of hidden) li.hidden = false;
    hidden[0]?.querySelector('a')?.focus();
    more.remove();
  });
  return more;
}

/**
 * The six columns (issue 465): `mode` is `cards` (the payload's cards), `blank` (names and counts only: empty
 * project, no result, first read failed) or `skeleton` (loading); `counts` overrides every count ("…", "–", "0").
 * `stale` fades what comes from GitHub (ADR-0001); `chainMode` is `compact` or `full`.
 */
export function boardColumns({
  columns = null,
  level = 'item',
  chainMode = 'compact',
  primaryRepo = null,
  now = Date.now(),
  queueAvailable = true,
  doneWindowDays = 14,
  stale = false,
  mode = 'cards',
  counts = null,
  onDrill = null,
} = {}) {
  const source = columns ?? COLUMNS.map((c) => ({ ...c, count: 0, cards: [] }));
  const parents = level === 'initiative' || level === 'epic';
  const render = (c) => (parents ? parentCard(c, { primaryRepo, now, onDrill }) : workCard(c, { chainMode, primaryRepo, now }));
  const column = (c, i) => {
    const cards = mode === 'cards' ? (c.cards ?? []) : [];
    const count = counts !== null ? String(counts) : String(c.count ?? cards.length);
    const headingId = `wb-col-${c.id}`;
    const items = cards.map((card) => el('li', { class: 'wb-card-item' }, render(card)));
    const hidden = c.id === 'done' && items.length > DONE_AT_SIGHT ? items.slice(DONE_AT_SIGHT) : [];
    for (const li of hidden) li.hidden = true;
    let body = null;
    if (mode === 'skeleton') body = el('div', { class: 'wb-cards' }, ...Array.from({ length: SKELETON_CARDS[i] ?? 1 }, skeletonCard));
    else if (mode === 'cards') body = items.length ? el('ul', { class: 'wb-cards' }, ...items) : el('p', { class: 'wb-none' }, 'Nenhuma');
    const windowNote = mode === 'cards' && c.id === 'done' && !hidden.length ? el('p', { class: 'wb-window' }, `Fechadas nos últimos ${doneWindowDays} dias`) : null;
    return el(
      'section',
      {
        class: `wb-col${mode === 'cards' && c.id === 'blocked' && cards.length ? ' wb-col-attn' : ''}`,
        'data-column': c.id,
        'data-queue': c.id === 'queued' && !queueAvailable ? 'off' : null,
        'aria-labelledby': headingId,
      },
      el(
        'h2',
        { class: 'wb-col-head', id: headingId },
        el('span', { class: `wb-dot wb-dot-${c.id}`, 'aria-hidden': 'true' }),
        el('span', { class: 'wb-col-name' }, c.label),
        el('span', { class: 'wb-count', 'aria-hidden': 'true' }, count),
        srOnly(`: ${countLabel(count)}`),
      ),
      el('p', { class: 'wb-criterion' }, c.criterion),
      windowNote,
      body,
      hidden.length ? doneMore(hidden, doneWindowDays) : null,
    );
  };
  return el(
    'div',
    { class: `wb-board${stale ? ' wb-board-stale' : ''}`, role: 'region', 'aria-label': 'Quadro por ciclo do agente', 'aria-busy': mode === 'skeleton' ? 'true' : null, 'data-mode': mode },
    ...source.map(column),
  );
}

/** The stale band (issue 465, ADR-0001): the board is from `fetchedAt`, why, and Tentar agora (`onRetry`). */
export function staleBand({ fetchedAt = null, now = Date.now(), reason = null, busy = false, onRetry = null } = {}) {
  const when = formatClock(fetchedAt);
  const from = when ? `Mostrando o quadro de ${when} (${formatAgo(fetchedAt, now)}).` : 'Mostrando o último quadro lido.';
  const why = reason ? ` Motivo: ${String(reason).replace(/\.+$/, '')}.` : '';
  return el(
    'div',
    { class: 'error-band wb-stale-band', role: 'status' },
    icon('offline'),
    el('p', {}, el('b', {}, 'GitHub indisponível.'), ` ${from} As sessões e a fila continuam ao vivo.${why}`),
    el('button', { type: 'button', class: 'btn outline', 'data-action': 'retry', 'aria-busy': busy ? 'true' : null, disabled: busy, onClick: () => onRetry?.() }, icon('refresh'), 'Tentar agora'),
  );
}

/** The first read failed and nothing is stored (issue 465, 465-4): an alert with the reason and Tentar agora. */
export function firstReadFailure({ reason = null, busy = false, onRetry = null } = {}) {
  return el(
    'section',
    { class: 'card state center wb-first-failure', role: 'alert' },
    el('div', { class: 'seal error' }, icon('offline')),
    el('h2', {}, 'Ainda não conseguimos ler o GitHub'),
    el('p', {}, `A primeira leitura falhou${reason ? ` (${reason})` : ''} e não há quadro guardado para mostrar.`),
    el('button', { type: 'button', class: 'btn filled', 'data-action': 'retry', 'aria-busy': busy ? 'true' : null, disabled: busy, onClick: () => onRetry?.() }, icon('refresh'), 'Tentar agora'),
  );
}

/** The Project with no issue (issue 465, 465-3): what the board would show, the Project on GitHub and switching it. */
export function emptyProject({ project = null, switchHref = SWITCH_PROJECT_HREF } = {}) {
  const title = project?.title ? `O GitHub Project “${project.title}”` : 'O GitHub Project';
  return el(
    'section',
    { class: 'card state center wb-empty' },
    el('div', { class: 'seal' }, icon('empty')),
    el('h2', {}, 'Nenhuma issue neste projeto ainda'),
    el('p', {}, `${title} não tem nenhuma issue. Quando tiver, cada uma entra em Planejamento e anda pelas colunas conforme o agente trabalha.`),
    el(
      'div',
      { class: 'wb-empty-actions' },
      project?.url ? el('a', { class: 'btn outline', href: project.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Abrir o Project no GitHub') : null,
      el('a', { class: 'btn outline', href: switchHref }, icon('repeat'), 'Trocar de Project'),
    ),
  );
}

/** "Sem a label design-system, há 2 issues neste recorte." from `{ param, value?, count }` (issue 466). */
export function suggestionText(suggestion, filters = {}, options = {}) {
  const field = FILTER_FIELDS.find((f) => f.param === suggestion.param);
  const value = chipValue(suggestion.param, suggestion.value ?? filters?.[suggestion.param], options);
  return `Sem ${field?.article ?? 'o filtro'} ${value}, há ${plural(suggestion.count, 'issue', 'issues')} neste recorte.`;
}

/** No issue for the filters (issue 466, 466-3): the line, the optional suggestion and Limpar filtros. */
export function noResult({ suggestion = null, filters = {}, options = {}, onClear = null, onFilterChange = null } = {}) {
  const field = suggestion ? FILTER_FIELDS.find((f) => f.param === suggestion.param) : null;
  return el(
    'section',
    { class: 'card wb-no-result', role: 'status' },
    el('span', { class: 'wb-no-result-icon', 'aria-hidden': 'true' }, icon('filter')),
    el(
      'div',
      { class: 'wb-no-result-text' },
      el('h2', {}, 'Nenhuma issue com estes filtros.'),
      el('p', {}, `Os seis filtros valem juntos.${suggestion ? ` ${suggestionText(suggestion, filters, options)}` : ''}`),
      el(
        'div',
        { class: 'wb-no-result-actions' },
        el('button', { type: 'button', class: 'btn filled', 'data-action': 'clear', onClick: () => onClear?.() }, icon('filter'), 'Limpar filtros'),
        field ? el('button', { type: 'button', class: 'btn outline', 'data-action': 'remove-filter', 'data-param': field.param, onClick: () => onFilterChange?.(field.param, null) }, icon('x'), `Tirar ${field.article}`) : null,
      ),
    ),
  );
}

/** An error the screen already wrote in pt-BR (issue 465): the alert band, with a retry when given. */
export function workBoardError({ title, text = null, retryLabel = 'Tentar de novo', onRetry = null } = {}) {
  return errorBand({ title, text, action: onRetry ? { label: retryLabel, onClick: onRetry } : null });
}
