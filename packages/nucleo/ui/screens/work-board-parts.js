import { el, header, icon } from '../dom.js';
import { errorBand } from '../states.js';
import { queueLimit } from './work-board-queue.js';

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

/** The two filters of issue 610, before the six: the organization and the Project (`owner/number`), with the English URL param. */
export const ORIGIN_FIELDS = [
  { param: 'org', label: 'Organização', all: 'Todas', article: 'a organização' },
  { param: 'project', label: 'Project', all: 'Todos', article: 'o Project' },
];

/** The most warnings shown as a band; the rest is "Mais N organizações com aviso" (issue 610). */
export const MAX_WARNING_BANDS = 3;

/** Where the person switches the GitHub Project: the project kanban's "Trocar de Project" (issue 465). */
export const SWITCH_PROJECT_HREF = '/ui/project';

const PATH_LABELS = { initiative: 'Iniciativa', epic: 'Épico' };
const REASON_ICONS = { 'needs-you': 'hand', 'review-rounds': 'repeat', 'ci-failed': 'error' };
const CI = { ok: ['CI ✓', 'completed'], failed: ['CI ✕', 'error'], running: ['CI …', 'waiting'] };
const REVIEW = { approved: ['aprovado', 'completed'], 'changes-requested': ['ajustes', 'error'], pending: ['review', 'waiting'] };
const SESSIONS = { working: 'trabalhando', 'needs-you': 'precisa de você', idle: 'ociosa' };
const TYPE_CLASSES = new Set(Object.keys(TYPE_LABELS));
/** issue 477: the columns that are facts of the session and of GitHub and refuse a dragged card (a lock shows while one is dragged). */
const FACT_COLUMNS = new Set(['running', 'review', 'blocked', 'done']);
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

/** The organization as the person reads it: the own account is "login (você)" (issue 610). */
export const orgLabel = (org) => (org.own ? `${org.login} (você)` : org.login);

const isRead = (org) => org.state === 'read';
const projectValue = (p) => `${p.owner}/${p.number}`;
const projectsOf = (orgs) => orgs.flatMap((o) => o.projects ?? []);

function chipValue(param, value, options = {}) {
  if (param === 'org') {
    const found = (options.orgs ?? []).find((o) => o.login === value);
    return found ? orgLabel(found) : String(value);
  }
  if (param === 'project') return (options.projects ?? []).find((p) => projectValue(p) === value)?.title ?? String(value);
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

/** The active filters as chips (issue 466): `{ param, label, value }` in the bar's order, the organization and the Project first (issue 610). */
export function filterChips(filters = {}, options = {}) {
  return [...ORIGIN_FIELDS, ...FILTER_FIELDS].filter((f) => isSet(filters?.[f.param])).map((f) => ({ param: f.param, label: f.label, value: chipValue(f.param, filters[f.param], options) }));
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

// issue 610: an organization with a warning and no card is not an option, there is nothing of it to filter.
const orgChoices = (options, organizations, current) => {
  const hidden = new Set(organizations.filter((o) => !isRead(o)).map((o) => o.login));
  const choices = (options?.orgs ?? []).filter((o) => o.count > 0 || !hidden.has(o.login) || o.login === current).map((o) => ({ value: o.login, text: `${orgLabel(o)} (${o.count})`, match: o.login === current }));
  return choices;
};

// issue 610: with an organization chosen, only its Projects; with Todas, every Project grouped by organization.
const projectGroups = (options, org) => {
  const own = new Map((options?.orgs ?? []).map((o) => [o.login, o]));
  const owners = [...new Set((options?.projects ?? []).filter((p) => !org || p.owner === org).map((p) => p.owner))];
  return owners.map((owner) => ({
    label: own.has(owner) ? orgLabel(own.get(owner)) : owner,
    choices: (options.projects ?? []).filter((p) => p.owner === owner).map((p) => ({ value: projectValue(p), text: `${p.title} (${p.count})` })),
  }));
};

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

/**
 * What the header counts (issue 610): the organizations on the board and their Projects. An organization with a
 * warning and no earlier read is not counted; one that failed now but was read before (`failed` with `readAt`) keeps
 * its dimmed cards, so it stays in the count and the names and is also counted as warned. With GitHub down
 * (`githubDown`) every organization is counted, as the last read held them, and none is warned. With no Project the
 * count is zero organizations too.
 */
export function originSummary(organizations = [], { githubDown = false } = {}) {
  const onBoard = (o) => isRead(o) || (o.state === 'failed' && isSet(o.readAt));
  const read = githubDown ? organizations : organizations.filter(onBoard);
  const projects = projectsOf(read).length;
  return { read, warned: githubDown ? [] : organizations.filter((o) => !isRead(o)), projects, orgs: projects ? read.length : 0 };
}

/** The organizations that failed now but were read before: their last cards stay, dimmed (issue 610, decision 0001). */
export function staleOrganizations(organizations = []) {
  return organizations.filter((o) => o.state === 'failed' && isSet(o.readAt)).map((o) => o.login);
}

const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`);

// issue 610: the line under the title when the board spans organizations: the count, the names, "N com aviso".
// `null` when exactly one organization and one Project were read, none with a warning: the header names them as before.
function originSub({ organizations, githubDown, loading }) {
  if (loading) return [el('span', { class: 'wb-orgs-count' }, '… organizações · … Projects'), ' · lendo cada organização no GitHub'];
  const { read, warned, projects, orgs } = originSummary(organizations, { githubDown });
  if (read.length === 1 && projects === 1 && !warned.length) return null;
  const noneRead = !read.length && warned.length > 0;
  const counter = el('span', { class: 'wb-orgs-count' }, noneRead ? 'Nenhuma organização lida' : `${plural(orgs, 'organização', 'organizações')} · ${plural(projects, 'Project', 'Projects')}`);
  const names = orgs ? joinNames(read.map(orgLabel)) : '';
  const warnMark = warned.length ? el('span', { class: 'wb-warn-count' }, icon('alert'), `${warned.length} com aviso`) : null;
  return [counter, names ? ' · ' : null, names ? el('span', { class: 'mono' }, names) : null, warnMark ? ' · ' : null, warnMark, ' · a coluna vem dos sinais; só a fila é sua'];
}

/**
 * The header (issue 465): title, the Project, the last GitHub read and Atualizar (`onRefresh`, `busy`). Over several
 * organizations (issue 610, `organizations`) it counts them instead; with one organization and one Project it names
 * them as before; `loading` shows the counters in "…".
 */
export function workBoardHeader({ project = null, organizations = null, githubDown = false, loading = false, fetchedAt = null, now = Date.now(), stale = false, reading = false, busy = false, onRefresh = null } = {}) {
  const old = stale || (!reading && !isSet(fetchedAt));
  const read = el('span', { class: `wb-read${old ? ' wb-read-old' : ''}` }, icon('github'), el('span', {}, readLabel({ fetchedAt, now, reading })));
  const refresh = el(
    'button',
    { type: 'button', class: 'btn outline', 'data-action': 'refresh', 'aria-busy': busy ? 'true' : null, disabled: busy, onClick: () => onRefresh?.() },
    icon('refresh'),
    'Atualizar',
  );
  const actions = [read, refresh];
  if (loading || organizations) {
    const sub = originSub({ organizations: organizations ?? [], githubDown, loading });
    if (sub) return header({ icon: 'columns-3', title: 'Quadro do trabalho', sub, actions });
    const named = originSummary(organizations, { githubDown }).read[0].projects[0];
    return header({ icon: 'columns-3', title: 'Quadro do trabalho', sub: `${project?.primaryRepo ?? named.owner} · GitHub Project “${named.title}” · a coluna vem dos sinais`, actions });
  }
  const where = project ? [project.primaryRepo, `GitHub Project “${project.title}”`].filter(Boolean).join(' · ') : null;
  return header({ icon: 'columns-3', title: 'Quadro do trabalho', sub: where ? `${where} · a coluna vem dos sinais` : null, actions });
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

function filterSelect(f, { choices, selected, groups = null }, { current, disabled, onFilterChange }) {
  const option = (c) => el('option', { value: c.value, selected: c.value === selected }, c.text);
  const select = el(
    'select',
    { class: 'wb-select', name: f.param, 'data-param': f.param, disabled },
    el('option', { value: '' }, f.all),
    ...(groups ? groups.map((g) => el('optgroup', { label: g.label }, ...g.choices.map(option))) : choices.map(option)),
  );
  select.value = selected;
  select.addEventListener('change', () => onFilterChange?.(f.param, select.value || null));
  return el('label', { class: `wb-field${isSet(current) ? ' wb-field-set' : ''}` }, el('span', { class: 'wb-field-label' }, f.label), select);
}

// issue 610: the Organização and Project selects. A chosen value that is no option any more stays, selected, as the six do.
function originFields(filters, options, organizations, ctl) {
  const [orgField, projectField] = ORIGIN_FIELDS;
  const orgs = orgChoices(options, organizations, filters?.org);
  const orgExtra = isSet(filters?.org) && !orgs.some((c) => c.match);
  const orgAll = orgExtra ? [...orgs, { value: String(filters.org), text: chipValue('org', filters.org, options), match: true }] : orgs;
  const groups = projectGroups(options, filters?.org);
  const known = groups.flatMap((g) => g.choices);
  const projectSelected = isSet(filters?.project) ? String(filters.project) : '';
  const projectGroupsAll = projectSelected && !known.some((c) => c.value === projectSelected) ? [...groups, { label: 'Outro Project', choices: [{ value: projectSelected, text: chipValue('project', projectSelected, options) }] }] : groups;
  return [
    filterSelect(orgField, { choices: orgAll, selected: isSet(filters?.org) ? String(filters.org) : '' }, { ...ctl, current: filters?.org }),
    filterSelect(projectField, { choices: [], groups: projectGroupsAll, selected: projectSelected }, { ...ctl, current: filters?.project }),
  ];
}

/**
 * The filter bar (issue 466): six selects, the chips with ×, Limpar filtros and the link with Copiar link. With `origin`
 * (issue 610) the Organização and Project selects join them first, fed by `options.orgs` and `options.projects`; `organizations`
 * are the entries of the read, to leave out one with a warning and no card.
 */
export function filterBar({ filters = {}, options = {}, organizations = [], origin = false, link = null, disabled = false, onFilterChange = null, onClear = null, onCopyLink = null } = {}) {
  const ctl = { disabled, onFilterChange };
  const fields = [
    ...(origin ? originFields(filters, options, organizations, ctl) : []),
    ...FILTER_FIELDS.map((f) => filterSelect(f, choicesFor(f.param, options, filters?.[f.param]), { ...ctl, current: filters?.[f.param] })),
  ];
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
  return el('section', { class: `card wb-filters${disabled ? ' wb-off' : ''}`, 'aria-label': 'Filtros' }, el('div', { class: `wb-fields${origin ? ' wb-fields-origin' : ''}` }, ...fields), chipRow, linkRow);
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

const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The repository of each organization's cards when most of them share it (issue 610): the one holding the most of an
 * organization's cards, only when that organization has more than one card; a tie goes to the first by name.
 */
export function usualRepos(columns = []) {
  const counts = new Map();
  for (const card of columns.flatMap((c) => c.cards ?? [])) {
    const owner = card.origin?.organization;
    if (!owner || !card.repo) continue;
    const repos = counts.get(owner) ?? new Map();
    repos.set(card.repo, (repos.get(card.repo) ?? 0) + 1);
    counts.set(owner, repos);
  }
  const usual = {};
  for (const [owner, repos] of counts) {
    if ([...repos.values()].reduce((sum, n) => sum + n, 0) < 2) continue;
    usual[owner] = [...repos].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0][0];
  }
  return usual;
}

// issue 610: the repository stays on a card of another repository than the board's main one (a chosen Project) or than the usual
// one of its organization; where the board spans organizations and an organization has no usual repository, it shows.
function showsRepo(card, { primaryRepo, usualRepo, showOrigin }) {
  if (!card.repo) return false;
  const baseline = primaryRepo ?? usualRepo ?? null;
  return baseline ? !sameRepo(card.repo, baseline) : showOrigin;
}

function cardTop(card, { primaryRepo, usualRepo = null, showOrigin = false, now, withAge }) {
  const otherRepo = showsRepo(card, { primaryRepo, usualRepo, showOrigin });
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
    githubLink(card),
  );
}

// issue 536: the title opens the detail in the Console (a button, so Enter and focus work); GitHub is the separate icon link.
const cardTitle = (card, onOpen) =>
  el(
    'h3',
    { class: 'wb-card-title' },
    onOpen ? el('button', { type: 'button', class: 'wb-card-open', 'data-action': 'open', 'data-key': card.key, onClick: () => onOpen(card) }, card.title) : card.title,
  );

// issue 610: "organização · Project" in mono, under the title, when the board spans organizations.
function originLine(origin) {
  if (!origin) return null;
  return el('div', { class: 'wb-origin', title: 'Organização e Project de origem' }, el('span', { class: 'mono' }, origin.organization), el('span', { 'aria-hidden': 'true' }, '·'), el('span', { class: 'wb-origin-project' }, origin.project?.title ?? ''));
}

const githubLink = (card) =>
  el('a', { class: 'wb-card-github', href: card.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Abrir no GitHub', title: 'Abrir no GitHub' }, icon('external'));

const pill = (kind, tone, text, extra = '') => el('span', { class: `wb-pill wb-pill-${tone} ${kind}${extra}` }, text);

function cardBadges(card, planning = null) {
  const session = sessionText(card.sessions);
  const p = card.pullRequest;
  const parts = [
    planning,
    session ? pill('wb-session', card.sessions.state === 'needs-you' ? 'waiting' : card.sessions.state === 'idle' ? 'idle' : 'active', session, ` wb-session-${card.sessions.state ?? 'working'}`) : null,
    p ? el('a', { class: 'wb-pr wb-gh', href: p.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `PR ${ref(p.number)} no GitHub` }, icon('git-pull-request'), ref(p.number)) : null,
    p?.ci && CI[p.ci] ? pill('wb-ci', CI[p.ci][1], CI[p.ci][0], ' wb-gh') : null,
    p?.review && REVIEW[p.review] ? pill('wb-review', REVIEW[p.review][1], REVIEW[p.review][0], ' wb-gh') : null,
  ].filter(Boolean);
  return parts.length ? el('div', { class: 'wb-badges' }, ...parts) : null;
}

const toneOf = (card) => (card.planning?.state === 'failed' ? ' wb-card-fail' : !card.blocked ? '' : card.blocked.reason === 'ci-failed' ? ' wb-card-fail' : ' wb-card-attn');

const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** A click on the card outside its buttons and links, or Enter on the card itself, opens the detail (issue 467). */
function opensDetail(node, card, onOpen) {
  const onControl = (target) => {
    for (let n = target; n && n !== node; n = n.parentNode) if (INTERACTIVE.has(n.tagName)) return true;
    return false;
  };
  node.addEventListener('click', (ev) => !onControl(ev.target) && onOpen(card));
  node.addEventListener('keydown', (ev) => ev.key === 'Enter' && ev.target === node && onOpen(card));
}

/**
 * A card at the item and plan levels (issue 465, 465-2). `parts` is the planning of the card (`cardPlanParts`, issue 467):
 * its note, badge and actions; `onOpen` opens the detail and `selected` marks the open one.
 */
export function workCard(card, { chainMode = 'compact', primaryRepo = null, usualRepo = null, showOrigin = false, dimmed = false, now = Date.now(), parts = null, onOpen = null, selected = false } = {}) {
  const node = el(
    'article',
    { class: `card wb-card${toneOf(card)}${dimmed ? ' wb-org-stale' : ''}`, 'data-key': card.key, 'data-column': card.column },
    cardTop(card, { primaryRepo, usualRepo, showOrigin, now, withAge: false }),
    cardTitle(card, onOpen),
    showOrigin ? originLine(card.origin) : null,
    chainNode(card, chainMode),
    reasonNode(card.blocked),
    parts?.note ?? null,
    el(
      'div',
      { class: 'wb-data' },
      el('span', { class: 'wb-status wb-gh', title: 'Status do GitHub Project' }, `Status: ${card.projectStatus?.name ?? 'Sem status'}`),
      card.plan && PLAN_COLUMNS.has(card.column) ? el('span', { class: 'wb-plan wb-gh' }, icon('list-checks'), planText(card.plan)) : null,
      ageNode(card, now),
    ),
    cardBadges(card, parts?.badge ?? null),
    parts?.actions ?? null,
  );
  if (selected) node.setAttribute('data-selected', '');
  if (onOpen) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('data-openable', '');
    opensDetail(node, card, onOpen);
  }
  return node;
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
 * `stale` fades what comes from GitHub (ADR-0001); `chainMode` is `compact` or `full`. Over several organizations
 * (issue 610) `showOrigin` gives each card its origin line and `staleOrgs` dims the cards of an organization that failed now.
 */
export function boardColumns({
  columns = null,
  level = 'item',
  chainMode = 'compact',
  primaryRepo = null,
  now = Date.now(),
  queueAvailable = true,
  queue = null,
  doneWindowDays = 14,
  stale = false,
  mode = 'cards',
  counts = null,
  onDrill = null,
  showOrigin = false,
  staleOrgs = [],
  renderCard = workCard,
} = {}) {
  const source = columns ?? COLUMNS.map((c) => ({ ...c, count: 0, cards: [] }));
  const parents = level === 'initiative' || level === 'epic';
  const usual = showOrigin ? usualRepos(source) : {};
  const dim = new Set(staleOrgs);
  const origin = (c) => (showOrigin ? { showOrigin, usualRepo: usual[c.origin?.organization] ?? null, dimmed: dim.has(c.origin?.organization) } : {});
  const render = (c) => (parents ? parentCard(c, { primaryRepo, now, onDrill }) : renderCard(c, { chainMode, primaryRepo, now, ...origin(c) }));
  const column = (c, i) => {
    const raw = mode === 'cards' ? (c.cards ?? []) : [];
    // issue 477: Na fila reads in queue order.
    const cards = c.id === 'queued' ? [...raw].sort((a, b) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity)) : raw;
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
        FACT_COLUMNS.has(c.id) ? el('span', { class: 'wb-lock', title: 'Não recebe card arrastado', 'aria-hidden': 'true' }, icon('lock')) : null,
        el('span', { class: 'wb-count', 'aria-hidden': 'true' }, count),
        srOnly(`: ${countLabel(count)}`),
      ),
      el('p', { class: 'wb-criterion' }, c.criterion),
      mode === 'cards' && !parents && c.id === 'queued' && queueAvailable ? queueLimit(queue) : null,
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

/** The pt-BR of each stable reason code the core sends when GitHub is down (issue 495); the raw code never shows. */
export const GITHUB_DOWN_REASONS = Object.freeze({
  network: 'falha de rede ao falar com o GitHub',
  'rate-limited': 'o GitHub limitou as chamadas',
  'no-scope': 'o token do GitHub não tem a permissão necessária',
  'github-error': 'o GitHub respondeu com erro',
  'sync-pending': 'o sincronismo em segundo plano ainda não releu o quadro',
});
const UNKNOWN_GITHUB_DOWN_REASON = 'motivo não identificado';

/** The pt-BR text of a reason code; `null` without a code, a neutral text for a code not in the map. */
export function githubDownReason(code) {
  if (!code) return null;
  return Object.hasOwn(GITHUB_DOWN_REASONS, code) ? GITHUB_DOWN_REASONS[code] : UNKNOWN_GITHUB_DOWN_REASON;
}

/** The stale band (issue 465, ADR-0001): the board is from `fetchedAt`, why, when the core tries again (`retryAt`, epoch ms, issue 496), and Tentar agora (`onRetry`). */
export function staleBand({ fetchedAt = null, now = Date.now(), reason = null, retryAt = null, busy = false, subject = 'board', onRetry = null } = {}) {
  const when = formatClock(fetchedAt);
  const issue = subject === 'issue';
  const from = when ? `Mostrando ${issue ? 'a issue' : 'o quadro'} de ${when} (${formatAgo(fetchedAt, now)}).` : `Mostrando ${issue ? 'a última issue lida' : 'o último quadro lido'}.`;
  const retry = Number.isFinite(retryAt) ? ` Tentamos de novo em ${Math.max(1, Math.round((retryAt - now) / 60_000))} min.` : '';
  const why = reason ? ` Motivo: ${githubDownReason(reason)}.` : '';
  return el(
    'div',
    { class: 'error-band wb-stale-band', role: 'status' },
    icon('offline'),
    el('p', {}, el('b', {}, 'GitHub indisponível.'), ` ${from}${retry} As sessões e a fila continuam ao vivo.${why}`),
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
    el('p', {}, `A primeira leitura falhou${reason ? ` (${githubDownReason(reason)})` : ''} e não há quadro guardado para mostrar.`),
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

/** The note under the filters when a changed organization sent the Project back to Todos (issue 610, 598-2). */
export function projectResetNote({ project, to }) {
  return el('p', { class: 'wb-reset-note', role: 'status' }, icon('info'), `O Project “${project.title}” é de ${project.owner}, não de ${to}: voltou para Todos.`);
}

const WARNING_KINDS = {
  restricted: { tone: 'attn', icon: 'shield-alert', actions: [['approve', 'Aprovar (dono)'], ['request', 'Pedir acesso']] },
  saml: { tone: 'attn', icon: 'lock', actions: [['sso', 'Entrar pelo SSO']] },
  failed: { tone: 'fail', icon: 'offline', actions: [['retry', 'Tentar de novo']] },
};

function warningText(org, now) {
  const name = el('span', { class: 'mono' }, org.login);
  if (org.state === 'restricted') {
    return [el('b', {}, name, ' restringe apps OAuth.'), ' Ainda não aprovou o Ahrena Console: os Projects dela ficam fora do quadro até lá.', el('span', { class: 'wb-warn-why' }, 'Um dono da organização aprova; quem não é dono pede a aprovação.')];
  }
  if (org.state === 'saml') {
    return [el('b', {}, name, ' exige login pelo SSO (SAML).'), ' Os Projects dela ficam fora do quadro até você entrar pelo SSO no GitHub.', el('span', { class: 'wb-warn-why' }, 'Depois de entrar, Atualizar lê de novo.')];
  }
  const reason = org.reason ? ` Motivo: ${githubDownReason(org.reason)}.` : '';
  if (isSet(org.readAt)) {
    const when = formatClock(org.readAt);
    return [
      el('b', {}, 'Não conseguimos ler os Projects de ', name, ' agora.'),
      ` Mostrando a última leitura dela, às ${when} (${formatAgo(org.readAt, now)}), com os cards esmaecidos.${reason}`,
      el('span', { class: 'wb-warn-why' }, 'As outras organizações estão atualizadas e seguem como estão.'),
    ];
  }
  return [el('b', {}, 'Não conseguimos ler os Projects de ', name, '.'), ` Não há nada guardado dela.${reason}`, el('span', { class: 'wb-warn-why' }, 'As outras organizações não dependem desta.')];
}

function warningBand(org, { now, busy, onAction }) {
  const kind = WARNING_KINDS[org.state] ?? WARNING_KINDS.failed;
  return el(
    'div',
    { class: `wb-warn-band wb-warn-${org.state in WARNING_KINDS ? org.state : 'failed'} wb-warn-${kind.tone}`, role: kind.tone === 'fail' ? 'alert' : 'status', 'data-organization': org.login },
    icon(kind.icon),
    el('p', {}, ...warningText(org, now)),
    el(
      'div',
      { class: 'wb-warn-actions' },
      ...kind.actions.map(([action, label]) => {
        const retry = action === 'retry';
        return el('button', { type: 'button', class: 'btn outline', 'data-action': action, 'aria-busy': retry && busy ? 'true' : null, disabled: retry && busy, onClick: () => onAction?.(action, org) }, label);
      }),
    ),
  );
}

/**
 * The warnings of the organizations that restrict the app, ask for SSO or failed to read (issue 610, 598-3): one band each,
 * the first three, then the toggle "Mais N organizações com aviso" (a button, `aria-expanded`); `expanded` renders every band
 * and the toggle reads "Mostrar menos". `null` with none, and with GitHub down (`githubDown`), whose one band is `staleBand`.
 * `onAction(action, organization)`: `approve`, `request`, `sso`, `retry`, and `more` (no organization) for the toggle.
 */
export function orgWarnings({ organizations = [], githubDown = false, now = Date.now(), busy = false, expanded = false, onAction = null } = {}) {
  const list = githubDown ? [] : organizations.filter((o) => !isRead(o));
  if (!list.length) return null;
  const more = list.length - MAX_WARNING_BANDS;
  const toggle =
    more > 0
      ? el(
          'button',
          { type: 'button', class: 'wb-warns-more', 'data-action': 'more', 'aria-expanded': expanded ? 'true' : 'false', onClick: () => onAction?.('more') },
          icon('chevron-down'),
          expanded ? 'Mostrar menos' : `Mais ${plural(more, 'organização', 'organizações')} com aviso`,
        )
      : null;
  return el('div', { class: 'wb-warns' }, ...(expanded ? list : list.slice(0, MAX_WARNING_BANDS)).map((o) => warningBand(o, { now, busy, onAction })), toggle);
}

/**
 * The states with no card over several organizations (issue 610, 598-4): `issues` (no issue in any Project read),
 * `projects` (no Project at all) and `all-failed` (every organization has a warning). "Trocar de Project" is not offered:
 * the Project filter replaces it. `onAction(action)`: `open-projects`, `open-github`, `connect` or `retry`.
 */
export function orgsEmpty({ kind = 'issues', organizations = [], busy = false, onAction = null } = {}) {
  const { read, projects } = originSummary(organizations);
  const act = (action, iconName, label, tone = 'outline') =>
    el('button', { type: 'button', class: `btn ${tone}`, 'data-action': action, 'aria-busy': action === 'retry' && busy ? 'true' : null, disabled: action === 'retry' && busy, onClick: () => onAction?.(action) }, icon(iconName), label);
  const connect = act('connect', 'plug', 'Conceder acesso a outra organização');
  const views = {
    issues: {
      seal: el('div', { class: 'seal' }, icon('empty')),
      title: 'Nenhuma issue nos Projects das suas organizações',
      text: [`Os ${plural(projects, 'Project', 'Projects')} de ${joinNames(read.map(orgLabel))} não têm nenhuma issue. Quando tiverem, cada uma entra em Planejamento e anda pelas colunas conforme o agente trabalha.`],
      actions: [act('open-projects', 'external', 'Abrir os Projects no GitHub'), connect],
    },
    projects: {
      seal: el('div', { class: 'seal' }, icon('kanban')),
      title: 'Nenhum Project para mostrar',
      text: ['As organizações que você concedeu ao Console e a sua conta não têm nenhum GitHub Project. Crie um no GitHub ou conceda acesso a outra organização.'],
      actions: [act('open-github', 'external', 'Abrir o GitHub'), connect],
    },
    'all-failed': {
      seal: el('div', { class: 'seal error' }, icon('offline')),
      title: 'Não conseguimos ler nenhuma organização',
      text: ['Cada aviso acima diz o motivo e o que fazer. Quando uma for resolvida, o quadro aparece com ela.'],
      actions: [act('retry', 'refresh', 'Tentar agora', 'filled')],
    },
  };
  const view = views[kind] ?? views.issues;
  return el(
    'section',
    { class: `card state center wb-empty wb-orgs-empty wb-orgs-${kind}`, role: kind === 'all-failed' ? 'alert' : null },
    view.seal,
    el('h2', {}, view.title),
    el('p', {}, ...view.text),
    el('div', { class: 'wb-empty-actions' }, ...view.actions),
  );
}
