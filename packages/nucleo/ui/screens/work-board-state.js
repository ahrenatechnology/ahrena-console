import { CONNECTIONS_UI, githubHttpsUrl } from '../github-connect.js';
import { FILTER_FIELDS, ORIGIN_FIELDS, ancestorValue, originSummary, staleOrganizations } from './work-board-parts.js';

/** The route of the work board (issue 465). */
export const WORK_BOARD_HREF = '/ui/work';

/**
 * The filters, in the order of the bar and of the link: the organization and the Project first (issue 610), then the six
 * of issue 466; the level is not one of them. They all apply together.
 */
export const FILTER_PARAMS = [...ORIGIN_FIELDS, ...FILTER_FIELDS].map((f) => f.param);

const API_PATH = '/api/work';
const DEFAULT_LEVEL = 'item';
const GITHUB = 'https://github.com';
// issue 610: the shapes GET /api/work accepts; a value of another shape is dropped here, the API would answer bad-filter.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PROJECT = /^([^/#\s]+)\/([1-9]\d*)$/;
const isProject = (v) => PROJECT.test(v) && LOGIN.test(PROJECT.exec(v)[1]);
const SHAPES = { org: (v) => LOGIN.test(v), project: isProject };
const wellFormed = (param, value) => value === null || !SHAPES[param] || SHAPES[param](value);
const anyOrigin = (filters) => ORIGIN_FIELDS.some((f) => isSet(filters[f.param]));
const ownerOf = (project) => PROJECT.exec(project)?.[1] ?? '';
const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const CHILD_LEVEL = { initiative: 'epic', epic: 'item' };

const isSet = (v) => v !== null && v !== undefined && v !== '';
const clean = (v) => (isSet(v) ? String(v).trim() || null : null);
const anyFilter = (filters) => FILTER_PARAMS.some((p) => isSet(filters[p]));
const sameFilters = (a, b) => Boolean(a && b) && ['level', ...FILTER_PARAMS].every((p) => a[p] === b[p]);
const noCards = (data) => (data.columns ?? []).every((c) => !(c.cards ?? []).length);

function readSearch(search) {
  const query = new URLSearchParams(search ?? '');
  const filters = { level: clean(query.get('level')) ?? DEFAULT_LEVEL };
  for (const p of FILTER_PARAMS) {
    const value = clean(query.get(p));
    filters[p] = wellFormed(p, value) ? value : null;
  }
  const placed = [...new Set([...query.keys()])].filter((p) => FILTER_PARAMS.includes(p) && isSet(filters[p]));
  return { filters, placed };
}

/**
 * The query string as the board's filters (issue 466): `{ level, org, project, initiative, epic, type, label, repo, status }`,
 * one value each, trimmed, `null` when absent or empty, unknown params ignored; the level defaults to `item`,
 * as GET /api/work does. The values of the six are not checked here: the API answers `bad-filter` with the param.
 * `org` (a login) and `project` (`owner/number`, issue 610) are, and a malformed one is dropped, never sent.
 */
export function filtersFromSearch(search) {
  return readSearch(search).filters;
}

/**
 * The canonical query of the filters (issue 466): the level first, then the set filters in the order of the bar. The Project
 * keeps its slash, `project=owner/3` (issue 610): the link reads as the Project it names.
 */
export function searchFromFilters(filters) {
  const query = new URLSearchParams({ level: filters.level ?? DEFAULT_LEVEL });
  for (const p of FILTER_PARAMS) if (isSet(filters[p])) query.set(p, filters[p]);
  return query.toString().replace(/(^|&)(project=[^&]*)/, (_, lead, pair) => lead + pair.replaceAll('%2F', '/'));
}

/** The link of the slice (issue 466): `/ui/work?level=item&epic=6`. */
export function boardUrl(filters) {
  return `${WORK_BOARD_HREF}?${searchFromFilters(filters)}`;
}

/** The read of GET /api/work for the filters (issue 465); `refresh` re-reads GitHub (Atualizar). */
export function apiPath(filters, { refresh = false } = {}) {
  return `${API_PATH}?${searchFromFilters(filters)}${refresh ? '&refresh=1' : ''}`;
}

function dataPhase(filters, data) {
  const filtered = anyFilter(filters);
  if (filtered && noCards(data)) return 'no-result';
  if ((data.total ?? 0) === 0 && !filtered && filters.level === DEFAULT_LEVEL) return 'empty';
  return data.stale ? 'stale' : 'loaded';
}

// The exact count comes from GET /api/work (issue 502); a core that does not send it suggests nothing.
const countWithout = (param, data) => data.countsWithoutFilter?.[param] ?? 0;

function suggestionFor(filters, placed, data) {
  const active = FILTER_PARAMS.filter((p) => isSet(filters[p]));
  const order = [...placed.filter((p) => active.includes(p)), ...active.filter((p) => !placed.includes(p))].reverse();
  for (const param of order) {
    const count = countWithout(param, data);
    if (count) return { param, value: filters[param], count };
  }
  return null;
}

function viewOf(phase, data, filters) {
  if (phase === 'loading') return 'skeleton';
  if (!data) return 'failure';
  const shown = dataPhase(filters, data);
  return shown === 'empty' || shown === 'no-result' ? shown : 'board';
}

const githubDownOf = (data) => Boolean(data?.stale) && data.staleReason === 'github-unavailable';

// issue 610: single-origin is exactly one read organization and one Project, none with a warning: the header names them as
// before, no origin line, no Organização and Project filters. A core that sends no `organizations` is single-origin, and so
// is one with an empty list that names its one Project. With nothing read yet the screen is waiting for every organization.
function isMultiOrigin({ data, filters, phase }, githubDown) {
  if (!data) return phase === 'loading' || anyOrigin(filters);
  const organizations = data.organizations;
  if (!Array.isArray(organizations)) return false;
  if (!organizations.length) return data.project === null;
  const { read, warned, projects } = originSummary(organizations, { githubDown });
  return !(read.length === 1 && projects === 1 && !warned.length);
}

// issue 610: which of the three empty states of the board over several organizations applies, `null` when the board is not empty.
function emptyKindOf(data, view, multiOrigin, githubDown) {
  if (!multiOrigin || view !== 'empty') return null;
  const { read, warned, projects } = originSummary(data.organizations, { githubDown });
  if (!read.length && warned.length) return 'all-failed';
  return projects === 0 ? 'projects' : 'issues';
}

function derive(state) {
  const { filters, phase, data, dataFilters, placed } = state;
  const shownFor = data ? dataFilters : filters;
  const shown = data ? dataPhase(dataFilters, data) : null;
  const view = viewOf(phase, data, shownFor);
  const githubDown = githubDownOf(data);
  const multiOrigin = isMultiOrigin(state, githubDown);
  return {
    ...state,
    url: boardUrl(filters),
    api: apiPath(filters, { refresh: state.refresh }),
    chainMode: anyFilter(shownFor) ? 'full' : 'compact',
    busy: phase === 'loading' || phase === 'refreshing',
    view,
    stale: Boolean(data?.stale),
    githubDown,
    multiOrigin,
    organizations: data?.organizations ?? [],
    staleOrgs: githubDown ? [] : staleOrganizations(data?.organizations ?? []),
    emptyKind: emptyKindOf(data, view, multiOrigin, githubDown),
    staleReason: data?.staleReason ?? null,
    retryAt: data?.retryAt ?? null,
    suggestion: data && shown === 'no-result' ? suggestionFor(dataFilters, placed, data) : null,
  };
}

/**
 * Start a read (issue 465): with nothing on screen the phase is `loading` (the skeleton); with a board it is
 * `refreshing` and the board stays, only Atualizar busy. `refresh` asks GET /api/work to re-read GitHub.
 * Fetch `state.api` and hand the answer back with `state.request`.
 */
export function startLoad(state, { refresh = false } = {}) {
  return derive({ ...state, phase: state.data ? 'refreshing' : 'loading', error: state.data ? state.error : null, refresh, request: state.request + 1 });
}

function navigate(state, filters, placed, resetNote = null) {
  return startLoad({ ...state, filters, placed, resetNote, navigation: 'push' });
}

/** The state of a fresh screen from the page query string (issue 465): loading; a non-canonical URL is to be replaced. */
export function initialState(search) {
  const { filters, placed } = readSearch(search);
  const given = String(search ?? '').replace(/^\?/, '');
  const navigation = given === searchFromFilters(filters) ? null : 'replace';
  return derive({ filters, placed, phase: 'loading', data: null, dataFilters: null, error: null, refresh: false, request: 1, navigation, resetNote: null, warningsExpanded: false });
}

/** GET /api/work answered 200 for `request` (issues 465 and 466); an answer to an older request is ignored. */
export function loadSucceeded(state, payload, request) {
  if (request !== state.request) return state;
  return derive({ ...state, data: payload, dataFilters: state.filters, error: null, refresh: false, navigation: null, phase: dataPhase(state.filters, payload) });
}

/**
 * GET /api/work failed for `request` with the error body (`{ error, param?, reason? }`, issue 465). A failed
 * Atualizar of the slice on screen keeps the board in its phase with `error` beside it (ADR-0001); a failed
 * read of a new slice, or with nothing on screen, is the phase `error` with no board. An answer to an older
 * request is ignored.
 */
export function loadFailed(state, error, request) {
  if (request !== state.request) return state;
  const base = { ...state, error, refresh: false, navigation: null };
  if (state.data && sameFilters(state.filters, state.dataFilters)) return derive({ ...base, phase: dataPhase(state.dataFilters, state.data) });
  return derive({ ...base, data: null, dataFilters: null, phase: 'error' });
}

// issue 610: the title the Project had on the board, for the note; the value `owner/number` when the options do not know it.
function projectOnBoard(state, value) {
  const found = (state.data?.options?.projects ?? []).find((p) => `${p.owner}/${p.number}`.toLowerCase() === value.toLowerCase());
  const [owner, number] = value.split('/');
  return { owner: found?.owner ?? owner, number: found?.number ?? Number(number), title: found?.title ?? value };
}

/**
 * Set one of the filters (issue 466, 610); `null` or empty removes it, a malformed `org` or `project` changes nothing. The new URL
 * is pushed and loaded. An organization that does not own the chosen Project sends it back to Todos and records
 * `resetNote: { project: { owner, number, title }, to }` for `projectResetNote`; the note goes with the next change.
 */
export function setFilter(state, param, value) {
  if (!FILTER_PARAMS.includes(param)) return state;
  const next = clean(value);
  if (!wellFormed(param, next)) return state;
  if (next === state.filters[param]) return state;
  let filters = { ...state.filters, [param]: next };
  let placed = [...state.placed.filter((p) => p !== param), ...(next === null ? [] : [param])];
  let note = null;
  const chosen = state.filters.project;
  if (param === 'org' && next !== null && isSet(chosen) && !sameLogin(ownerOf(chosen), next)) {
    note = { project: projectOnBoard(state, chosen), to: next };
    filters = { ...filters, project: null };
    placed = placed.filter((p) => p !== 'project');
  }
  return navigate(state, filters, placed, note);
}

/** Limpar filtros (issue 466, 610): the organization, the Project and the six filters go, the level stays. */
export function clearFilters(state) {
  if (!anyFilter(state.filters)) return state;
  return navigate(state, { ...state.filters, ...Object.fromEntries(FILTER_PARAMS.map((p) => [p, null])) }, []);
}

/** Another level (issue 466), keeping the filters. */
export function setLevel(state, level) {
  if (!level || level === state.filters.level) return state;
  return navigate(state, { ...state.filters, level }, state.placed);
}

function parentsOnBoard(state, param) {
  const cards = (state.data?.columns ?? []).flatMap((c) => c.cards ?? []);
  const options = state.data?.options?.[param === 'initiative' ? 'initiatives' : 'epics'] ?? [];
  const byKey = new Map([...cards, ...options].map((o) => [o.key, { key: o.key, number: o.number }]));
  return [...byKey.values()];
}

/**
 * Ver filhos on an initiative or epic card (issue 466): one level down, filtered by that parent; the other
 * filters stay. The filter is the parent's number only when no other filter is on and no parent on the board
 * shares it, else its key. An item has no children here.
 */
export function drill(state, card) {
  if (!card) return state;
  const param = card.level ?? state.filters.level;
  const level = CHILD_LEVEL[param];
  if (!level) return state;
  const otherFilter = FILTER_PARAMS.some((p) => p !== param && isSet(state.filters[p]));
  const value = otherFilter ? card.key : ancestorValue({ key: card.key, number: card.number }, parentsOnBoard(state, param));
  const placed = [...state.placed.filter((p) => p !== param), param];
  return navigate(state, { ...state.filters, level, [param]: value }, placed);
}

/** A step of the path, `{ param }` from boardPath (issue 466): back to the children of that parent. */
export function selectPath(state, step) {
  const level = CHILD_LEVEL[step?.param];
  if (!level) return state;
  const filters = { ...state.filters, level };
  if (step.param === 'initiative') filters.epic = null;
  return navigate(state, filters, state.placed.filter((p) => isSet(filters[p])));
}

/**
 * "Mais N organizações com aviso" and "Mostrar menos" (issue 610): the warning list opens or closes. Nothing is read
 * and the URL stays; `warningsExpanded` survives the next read.
 */
export function toggleWarnings(state) {
  return derive({ ...state, warningsExpanded: !state.warningsExpanded });
}

const NO_TARGET = Object.freeze({ kind: 'none' });
const link = (href) => (href ? { kind: 'link', href } : NO_TARGET);

function projectsPage(organizations) {
  const named = originSummary(organizations ?? []).read.find((o) => LOGIN.test(String(o.login)));
  if (!named) return GITHUB;
  return named.own ? `${GITHUB}/${named.login}?tab=projects` : `${GITHUB}/orgs/${named.login}/projects`;
}

/**
 * What an action of the warning bands or of the empty states does (issue 610). `{ kind: 'toggle' }` is `toggleWarnings`;
 * `{ kind: 'read' }` reads again (`startLoad`); `{ kind: 'link', href }` opens GitHub outside the Console, only an https
 * address on github.com; `{ kind: 'screen', to }` navigates inside the Console; `{ kind: 'none' }` does nothing (an unknown
 * action, or a link the core did not send). Pass `organization` for `approve`, `request`, `sso` and `retry`, and
 * `organizations` (the board's) for `open-projects`.
 */
export function warningTarget(action, { organization = null, organizations = [] } = {}) {
  if (action === 'more') return { kind: 'toggle' };
  if (action === 'retry') return { kind: 'read' };
  if (action === 'approve') return link(githubHttpsUrl(organization?.approvalUrl));
  if (action === 'request') return link(githubHttpsUrl(organization?.requestUrl));
  if (action === 'sso') return LOGIN.test(String(organization?.login)) ? link(`${GITHUB}/orgs/${organization.login}/sso`) : NO_TARGET;
  if (action === 'open-projects') return link(projectsPage(organizations));
  if (action === 'open-github') return link(GITHUB);
  if (action === 'connect') return { kind: 'screen', to: CONNECTIONS_UI };
  return NO_TARGET;
}
