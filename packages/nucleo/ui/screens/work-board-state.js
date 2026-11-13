import { FILTER_FIELDS, ancestorValue } from './work-board-parts.js';

/** The route of the work board (issue 465). */
export const WORK_BOARD_HREF = '/ui/work';

/** The six filters, in the order of the bar and of the link (issue 466); the level is not one of them. */
export const FILTER_PARAMS = FILTER_FIELDS.map((f) => f.param);

const API_PATH = '/api/work';
const DEFAULT_LEVEL = 'item';
const CHILD_LEVEL = { initiative: 'epic', epic: 'item' };
const PARENT_PARAMS = new Set(['initiative', 'epic']);
const SUMMED_OPTIONS = { type: 'types', repo: 'repos', status: 'statuses' };

const isSet = (v) => v !== null && v !== undefined && v !== '';
const clean = (v) => (isSet(v) ? String(v).trim() || null : null);
const anyFilter = (filters) => FILTER_PARAMS.some((p) => isSet(filters[p]));

function readSearch(search) {
  const query = new URLSearchParams(search ?? '');
  const filters = { level: clean(query.get('level')) ?? DEFAULT_LEVEL };
  for (const p of FILTER_PARAMS) filters[p] = clean(query.get(p));
  const placed = [...new Set([...query.keys()])].filter((p) => FILTER_PARAMS.includes(p) && isSet(filters[p]));
  return { filters, placed };
}

/**
 * The query string as the board's filters (issue 466): `{ level, initiative, epic, type, label, repo, status }`,
 * one value each, trimmed, `null` when absent or empty, unknown params ignored; the level defaults to `item`,
 * as GET /api/work does. Values are not checked here: the API answers `bad-filter` with the param.
 */
export function filtersFromSearch(search) {
  return readSearch(search).filters;
}

/** The canonical query of the filters (issue 466): the level first, then the set filters in the order of the bar. */
export function searchFromFilters(filters) {
  const query = new URLSearchParams({ level: filters.level ?? DEFAULT_LEVEL });
  for (const p of FILTER_PARAMS) if (isSet(filters[p])) query.set(p, filters[p]);
  return query.toString();
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
  const matched = data.matched ?? 0;
  const filtered = anyFilter(filters);
  if (matched === 0 && filtered) return 'no-result';
  if ((data.total ?? 0) === 0 && !filtered && filters.level === DEFAULT_LEVEL) return 'empty';
  return data.stale ? 'stale' : 'loaded';
}

function countWithout(param, filters, data) {
  const active = FILTER_PARAMS.filter((p) => isSet(filters[p]));
  if (active.length === 1 && active[0] === param) return data.total ?? 0;
  const list = SUMMED_OPTIONS[param] ? data.options?.[SUMMED_OPTIONS[param]] : null;
  return list ? list.reduce((sum, o) => sum + (o.count ?? 0), 0) : null;
}

function suggestionFor(filters, placed, data) {
  const active = FILTER_PARAMS.filter((p) => isSet(filters[p]));
  const order = [...placed.filter((p) => active.includes(p)), ...active.filter((p) => !placed.includes(p))].reverse();
  for (const param of order) {
    const count = countWithout(param, filters, data);
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

function derive(state) {
  const { filters, phase, data, placed } = state;
  const shown = data ? dataPhase(filters, data) : null;
  return {
    ...state,
    url: boardUrl(filters),
    api: apiPath(filters, { refresh: state.refresh }),
    chainMode: anyFilter(filters) ? 'full' : 'compact',
    busy: phase === 'loading' || phase === 'refreshing',
    view: viewOf(phase, data, filters),
    stale: Boolean(data?.stale),
    staleReason: data?.staleReason ?? null,
    suggestion: data && shown === 'no-result' ? suggestionFor(filters, placed, data) : null,
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

function navigate(state, filters, placed, navigation = 'push') {
  return startLoad({ ...state, filters, placed, navigation });
}

/** The state of a fresh screen from the page query string (issue 465): loading; a non-canonical URL is to be replaced. */
export function initialState(search) {
  const { filters, placed } = readSearch(search);
  const given = String(search ?? '').replace(/^\?/, '');
  const navigation = given === searchFromFilters(filters) ? null : 'replace';
  return derive({ filters, placed, phase: 'loading', data: null, error: null, refresh: false, request: 1, navigation });
}

/** The browser went back or forward (issue 466): follow the URL, without pushing it again. */
export function locationChanged(state, search) {
  const { filters, placed } = readSearch(search);
  return navigate(state, filters, placed, null);
}

/** GET /api/work answered 200 for `request` (issues 465 and 466); an answer to an older request is ignored. */
export function loadSucceeded(state, payload, request) {
  if (request !== state.request) return state;
  return derive({ ...state, data: payload, error: null, refresh: false, navigation: null, phase: dataPhase(state.filters, payload) });
}

/**
 * GET /api/work failed for `request` with the error body (`{ error, param?, reason? }`, issue 465). With
 * nothing on screen the phase is `error`; with a board, the board stays in its phase and `error` is reported
 * beside it (ADR-0001). An answer to an older request is ignored.
 */
export function loadFailed(state, error, request) {
  if (request !== state.request) return state;
  const phase = state.data ? dataPhase(state.filters, state.data) : 'error';
  return derive({ ...state, error, refresh: false, navigation: null, phase });
}

/** Set one of the six filters (issue 466); `null` or empty removes it. The new URL is pushed and loaded. */
export function setFilter(state, param, value) {
  if (!FILTER_PARAMS.includes(param)) return state;
  const next = clean(value);
  if (next === state.filters[param]) return state;
  const placed = [...state.placed.filter((p) => p !== param), ...(next === null ? [] : [param])];
  return navigate(state, { ...state.filters, [param]: next }, placed);
}

/** Limpar filtros (issue 466): the six filters go, the level stays. */
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
 * Ver filhos on an initiative or epic card (issue 466): one level down, filtered by that parent, by its
 * number or, when two repos share it, by its key; the other filters stay. An item has no children here.
 */
export function drill(state, card) {
  const param = card?.level ?? state.filters.level;
  const level = CHILD_LEVEL[param];
  if (!level || !PARENT_PARAMS.has(param)) return state;
  const value = ancestorValue({ key: card.key, number: card.number }, parentsOnBoard(state, param));
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
