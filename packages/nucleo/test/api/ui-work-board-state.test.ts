// #465 #466 the work board's view state (layer 3): URL <-> filters, the phases, drill-down, chain mode and the no-result suggestion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { DEFAULT_WORK_BOARD_FILTERS, parseWorkBoardFilters } from '../../src/github/work-board.ts';
import { WORK_LEVELS } from '../../src/github/work.ts';
import {
  FILTER_PARAMS,
  WORK_BOARD_HREF,
  apiPath,
  boardUrl,
  clearFilters,
  drill,
  filtersFromSearch,
  initialState,
  loadFailed,
  loadSucceeded,
  searchFromFilters,
  selectPath,
  setFilter,
  setLevel,
  startLoad,
  toggleWarnings,
  warningTarget,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-state.js';
// @ts-expect-error: browser module, plain JavaScript
import { FILTER_FIELDS, ORIGIN_FIELDS, suggestionText } from '../../ui/screens/work-board-parts.js';

const REPO = 'ahrenatechnology/ahrena-console';
const OTHER = 'ahrenatechnology/ahrena-framework';
const FILE = 'screens/work-board-state.js';

type Json = Record<string, any>;

function card(n: number, over: Json = {}): Json {
  return { key: `${REPO}#${n}`, repo: REPO, number: n, title: `Issue ${n}`, level: 'item', type: 'story', column: 'planning', ...over };
}

const NO_OPTIONS = { initiatives: [], epics: [], types: [], labels: [], repos: [], statuses: [] };

function payload(over: Json = {}): Json {
  const cards: Json[] = over.cards ?? [card(500)];
  const columns = ['planning', 'queued', 'running', 'review', 'blocked', 'done'].map((id) => {
    const inColumn = cards.filter((c) => c.column === id);
    return { id, label: id, criterion: '', count: inColumn.length, cards: inColumn };
  });
  const { cards: _cards, ...rest } = over;
  return {
    project: { title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/1', primaryRepo: REPO },
    filters: { ...DEFAULT_WORK_BOARD_FILTERS },
    levels: [...WORK_LEVELS],
    columns,
    blockedReasons: [],
    doneWindowDays: 14,
    queue: { available: false },
    options: NO_OPTIONS,
    total: cards.length,
    matched: cards.length,
    fetchedAt: 1_000,
    stale: false,
    staleReason: null,
    ...rest,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function loaded(search: string, body: Json = payload()): Json {
  const s = initialState(search);
  return loadSucceeded(s, body, s.request);
}

describe('#466/AC-3 the filters live in the URL, in English', () => {
  test('#466/AC-3 a query becomes the seven fields, one value each; unknown params ignored, empty dropped, level defaults to item like the API', () => {
    assert.deepEqual(filtersFromSearch(''), { level: 'item', org: null, project: null, initiative: null, epic: null, type: null, label: null, repo: null, status: null });
    assert.equal(filtersFromSearch('').level, DEFAULT_WORK_BOARD_FILTERS.level, 'the same default as GET /api/work');
    assert.deepEqual(filtersFromSearch('?level=epic&initiative=1&epic=&type=bug&label=%20ui%20&repo=ahrena-console&status=in-progress&foo=bar&type=task'), {
      level: 'epic',
      org: null,
      project: null,
      initiative: '1',
      epic: null,
      type: 'bug',
      label: 'ui',
      repo: 'ahrena-console',
      status: 'in-progress',
    });
    assert.deepEqual(FILTER_PARAMS, [...ORIGIN_FIELDS, ...FILTER_FIELDS].map((f: Json) => f.param), 'the organization, the Project, then the six filters, in the order of the bar');
  });

  test('#466/AC-3 the link is canonical: level first, the filters in the order of the bar, as the wireframe link', () => {
    const filters = filtersFromSearch('status=in-progress&repo=ahrena-console&label=ui&type=bug&epic=6&initiative=1&level=item');
    assert.equal(WORK_BOARD_HREF, '/ui/work');
    assert.equal(boardUrl(filters), '/ui/work?level=item&initiative=1&epic=6&type=bug&label=ui&repo=ahrena-console&status=in-progress');
    assert.equal(boardUrl(filtersFromSearch('')), '/ui/work?level=item');
  });

  test('#466/AC-3 the round trip is stable, keys with a repo and labels with spaces included', () => {
    for (const search of ['', 'level=plan', `level=item&epic=${encodeURIComponent(`${OTHER}#6`)}&label=design system`, 'initiative=1&type=bug']) {
      const once = searchFromFilters(filtersFromSearch(search));
      assert.equal(searchFromFilters(filtersFromSearch(once)), once, search);
      assert.deepEqual(filtersFromSearch(once), filtersFromSearch(search), search);
    }
    assert.equal(filtersFromSearch(searchFromFilters(filtersFromSearch(`epic=${encodeURIComponent(`${OTHER}#6`)}`))).epic, `${OTHER}#6`);
  });

  test('#466/AC-3 the API reads the same filters back from the /api/work query; refresh=1 only for Atualizar', () => {
    const filters = filtersFromSearch('level=item&initiative=1&epic=6&type=bug&label=ui&repo=ahrena-console&status=in-progress');
    const path = apiPath(filters);
    assert.ok(path.startsWith('/api/work?'), path);
    assert.doesNotMatch(path, /refresh/);
    const parsed = parseWorkBoardFilters(new URL(path, 'http://127.0.0.1').searchParams);
    assert.deepEqual(parsed, { level: 'item', org: null, project: null, initiative: 1, epic: 6, type: 'bug', label: 'ui', repo: 'ahrena-console', status: 'in-progress' });
    assert.match(apiPath(filters, { refresh: true }), /&refresh=1$/);
  });
});

describe('#465/AC-2 the phases of the screen (465-5, 465-3)', () => {
  test('#465/AC-2 first open: loading, nothing on screen, busy, the first request ready for the canonical /api/work', () => {
    const s = initialState('?level=item');
    assert.equal(s.phase, 'loading');
    assert.equal(s.view, 'skeleton');
    assert.equal(s.busy, true);
    assert.equal(s.data, null);
    assert.equal(s.api, '/api/work?level=item');
    assert.equal(s.url, '/ui/work?level=item');
    assert.equal(s.navigation, null, 'the URL is already canonical');
    assert.equal(typeof s.request, 'number');
  });

  test('#465/AC-2 a URL that is not canonical is replaced, not pushed', () => {
    assert.equal(initialState('').navigation, 'replace');
    assert.equal(initialState('?epic=6&level=item').navigation, 'replace');
    assert.equal(initialState('?level=item&epic=6').navigation, null);
  });

  test('#465/AC-2 loaded: the board with the payload, not busy', () => {
    const body = payload();
    const s = loaded('level=item', body);
    assert.equal(s.phase, 'loaded');
    assert.equal(s.view, 'board');
    assert.equal(s.busy, false);
    assert.equal(s.data, body);
    assert.equal(s.error, null);
    assert.equal(s.navigation, null);
  });

  test('#465/AC-2 Atualizar: the board stays with its data and only Atualizar is busy, asking refresh=1', () => {
    const before = loaded('level=item');
    const s = startLoad(before, { refresh: true });
    assert.equal(s.phase, 'refreshing');
    assert.equal(s.view, 'board');
    assert.equal(s.busy, true);
    assert.equal(s.data, before.data);
    assert.match(s.api, /refresh=1/);
    assert.notEqual(s.request, before.request);
    const after = loadSucceeded(s, payload({ fetchedAt: 2_000 }), s.request);
    assert.equal(after.phase, 'loaded');
    assert.equal(after.data.fetchedAt, 2_000);
    assert.doesNotMatch(after.api, /refresh/, 'refresh=1 is for that one read');
  });

  test('#465/AC-2 Tentar agora with nothing on screen loads again from the skeleton', () => {
    const s0 = initialState('level=item');
    const failed = loadFailed(s0, { error: 'github-unavailable', reason: '502' }, s0.request);
    const again = startLoad(failed, { refresh: true });
    assert.equal(again.phase, 'loading');
    assert.equal(again.view, 'skeleton');
    assert.equal(again.error, null);
  });

  test('#465/AC-2 empty: the project has no issue at all, unfiltered at the item level (465-3)', () => {
    const s = loaded('level=item', payload({ cards: [], total: 0, matched: 0 }));
    assert.equal(s.phase, 'empty');
    assert.equal(s.view, 'empty');
  });

  test('#466/AC-2 another level with no node is the board with empty columns, not the empty project', () => {
    const s = loaded('level=initiative', payload({ cards: [], total: 0, matched: 0, filters: { ...DEFAULT_WORK_BOARD_FILTERS, level: 'initiative' } }));
    assert.equal(s.phase, 'loaded');
    assert.equal(s.view, 'board');
  });

  test('#465/AC-2 a response that arrives after a newer request is ignored', () => {
    const first = initialState('level=item');
    const second = setLevel(first, 'epic');
    const late = loadSucceeded(second, payload(), first.request);
    assert.equal(late, second);
    const lateFail = loadFailed(second, { error: 'github-unavailable' }, first.request);
    assert.equal(lateFail, second);
  });
});

describe('#465/AC-4 GitHub down (465-4, ADR-0001)', () => {
  test('#465/AC-4 a 200 with stale keeps the board, with the reason for the band', () => {
    const s = loaded('level=item', payload({ stale: true, staleReason: 'GitHub respondeu 502' }));
    assert.equal(s.phase, 'stale');
    assert.equal(s.view, 'board');
    assert.equal(s.stale, true);
    assert.equal(s.staleReason, 'GitHub respondeu 502');
  });

  test('#496/AC-2 the retry time of the payload is exposed, null when absent', () => {
    assert.equal(loaded('level=item', payload({ stale: true, retryAt: 5_000 })).retryAt, 5_000);
    assert.equal(loaded('level=item', payload({ stale: true })).retryAt, null);
  });

  test('#465/AC-4 the first read failed with nothing stored: error, no data, the code kept for the screen to word', () => {
    const s0 = initialState('level=item');
    const s = loadFailed(s0, { error: 'github-unavailable', reason: 'GitHub respondeu 502' }, s0.request);
    assert.equal(s.phase, 'error');
    assert.equal(s.view, 'failure');
    assert.equal(s.busy, false);
    assert.equal(s.data, null);
    assert.deepEqual(s.error, { error: 'github-unavailable', reason: 'GitHub respondeu 502' });
  });

  test('#465/AC-4 a refresh that fails while data is on screen keeps the board and reports the error', () => {
    const before = loaded('level=item', payload({ stale: true, staleReason: 'timeout' }));
    const busy = startLoad(before, { refresh: true });
    const s = loadFailed(busy, { error: 'github-unavailable', reason: 'timeout' }, busy.request);
    assert.equal(s.phase, 'stale', 'the phase the kept data gives');
    assert.equal(s.view, 'board');
    assert.equal(s.data, before.data);
    assert.equal(s.busy, false);
    assert.deepEqual(s.error, { error: 'github-unavailable', reason: 'timeout' });
    const retry = startLoad(s, { refresh: true });
    const ok = loadSucceeded(retry, payload(), retry.request);
    assert.equal(ok.error, null, 'the next good read clears the error');
  });
});

describe('#466/AC-2 levels and drill-down (466-1)', () => {
  test('#466/AC-2 changing the level keeps the filters, pushes the new URL and loads it with the board kept', () => {
    const before = loaded('level=item&label=ui');
    const s = setLevel(before, 'epic');
    assert.equal(s.filters.level, 'epic');
    assert.equal(s.filters.label, 'ui');
    assert.equal(s.url, '/ui/work?level=epic&label=ui');
    assert.equal(s.api, '/api/work?level=epic&label=ui');
    assert.equal(s.navigation, 'push');
    assert.equal(s.phase, 'refreshing');
    assert.equal(s.view, 'board');
    assert.notEqual(s.request, before.request);
    assert.equal(setLevel(before, 'item'), before, 'the same level changes nothing');
  });

  test('#466/AC-2 Ver filhos on an epic goes to the item level with the epic filter, keeping the other filters', () => {
    const epic = card(6, { level: 'epic', type: 'epic', column: 'blocked' });
    const before = loaded('level=epic&initiative=1&label=ui', payload({ cards: [epic], filters: { ...DEFAULT_WORK_BOARD_FILTERS, level: 'epic' } }));
    const s = drill(before, epic);
    assert.deepEqual(s.filters, { level: 'item', org: null, project: null, initiative: '1', epic: `${REPO}#6`, type: null, label: 'ui', repo: null, status: null }, 'with another filter on, the options may hide a same-numbered epic: the key');
    assert.equal(s.url, `/ui/work?level=item&initiative=1&epic=${encodeURIComponent(`${REPO}#6`)}&label=ui`);
    assert.equal(parseWorkBoardFilters(new URL(s.api, 'http://127.0.0.1').searchParams).epic, `${REPO}#6`);
    assert.equal(s.navigation, 'push');
    assert.equal(s.busy, true);
  });

  test('#466/AC-2 Ver filhos on an initiative goes to the epic level with the initiative filter', () => {
    const initiative = card(1, { level: 'initiative', type: 'initiative' });
    const before = loaded('level=initiative', payload({ cards: [initiative], filters: { ...DEFAULT_WORK_BOARD_FILTERS, level: 'initiative' } }));
    const s = drill(before, initiative);
    assert.equal(s.url, '/ui/work?level=epic&initiative=1');
  });

  test('#466/AC-2 two repos with the same epic number: the drill filters by the key the API accepts', () => {
    const a = card(6, { level: 'epic', type: 'epic' });
    const b = card(6, { key: `${OTHER}#6`, repo: OTHER, level: 'epic', type: 'epic' });
    const before = loaded('level=epic', payload({ cards: [a, b], filters: { ...DEFAULT_WORK_BOARD_FILTERS, level: 'epic' } }));
    const s = drill(before, b);
    assert.equal(s.filters.epic, `${OTHER}#6`);
    assert.equal(parseWorkBoardFilters(new URL(s.api, 'http://127.0.0.1').searchParams).epic, `${OTHER}#6`);
  });

  test('#466/AC-2 Ver filhos with no other filter on and no same-numbered parent uses the bare number', () => {
    const epic = card(6, { level: 'epic', type: 'epic' });
    const s = drill(loaded('level=epic', payload({ cards: [epic], filters: { ...DEFAULT_WORK_BOARD_FILTERS, level: 'epic' } })), epic);
    assert.equal(s.url, '/ui/work?level=item&epic=6');
  });

  test('#466/AC-2 an item card, or no card, has no children to drill into', () => {
    const before = loaded('level=epic');
    assert.equal(drill(before, card(500)), before);
    assert.equal(drill(before, null), before);
    assert.equal(drill(before, undefined), before);
  });

  test('#466/AC-2 the path goes back up: the initiative step drops the epic and shows the epics', () => {
    const before = loaded('level=item&initiative=1&epic=6');
    const up = selectPath(before, { param: 'initiative' });
    assert.equal(up.url, '/ui/work?level=epic&initiative=1');
    assert.equal(up.navigation, 'push');
    const epic = selectPath(loaded('level=plan&initiative=1&epic=6'), { param: 'epic' });
    assert.equal(epic.url, '/ui/work?level=item&initiative=1&epic=6');
  });

  test('#466/AC-2 while a new slice is read, the board shown is still judged by the filters it was read for', () => {
    const before = loaded('level=item');
    const s = setFilter(before, 'type', 'bug');
    assert.equal(s.url, '/ui/work?level=item&type=bug', 'the chips and the URL show the new filter');
    assert.equal(s.phase, 'refreshing');
    assert.equal(s.view, 'board');
    assert.equal(s.chainMode, 'compact', 'the cards on screen were read with no filter');
    assert.deepEqual(s.dataFilters, before.filters);
    const empty = loaded('level=item&label=ui', payload({ cards: [], matched: 0, total: 1 }));
    const widened = setFilter(empty, 'label', null);
    assert.equal(widened.view, 'no-result', 'the old slice keeps its own view until the new one arrives');
  });

  test('#466/AC-2 a failed read of a new slice does not keep the old slice under the new chips', () => {
    const before = loaded('level=item');
    const s = setLevel(before, 'epic');
    const failed = loadFailed(s, { error: 'github-unavailable', reason: 'timeout' }, s.request);
    assert.equal(failed.phase, 'error');
    assert.equal(failed.view, 'failure');
    assert.equal(failed.data, null);
    assert.deepEqual(failed.error, { error: 'github-unavailable', reason: 'timeout' });
    const retry = startLoad(failed, { refresh: true });
    assert.equal(retry.phase, 'loading');
    assert.equal(retry.api, '/api/work?level=epic&refresh=1', 'Tentar agora reads the current filters');
  });
});

describe('#466/AC-3 setting and clearing the filters', () => {
  test('#466/AC-3 a filter is set, changed and removed; each change pushes and loads the new URL', () => {
    const before = loaded('level=item');
    const s = setFilter(before, 'type', 'bug');
    assert.equal(s.url, '/ui/work?level=item&type=bug');
    assert.equal(s.navigation, 'push');
    assert.equal(s.busy, true);
    assert.equal(setFilter(s, 'type', 'bug'), s, 'the same value changes nothing');
    assert.equal(setFilter(s, 'type', '').url, '/ui/work?level=item');
    assert.equal(setFilter(s, 'type', null).filters.type, null);
    assert.equal(setFilter(s, 'level', 'epic'), s, 'the level is not a filter: setLevel changes it');
  });

  test('#466/AC-3 Limpar filtros removes the six filters and keeps the level', () => {
    const before = loaded('level=epic&initiative=1&type=epic&label=ui');
    const s = clearFilters(before);
    assert.equal(s.url, '/ui/work?level=epic');
    assert.equal(s.navigation, 'push');
    const clean = loaded('level=epic');
    assert.equal(clearFilters(clean), clean, 'nothing to clear changes nothing');
  });

  test('#466/AC-3 the transitions never change the state they are given', () => {
    const before = deepFreeze(loaded('level=item&label=ui', payload({ cards: [card(6, { level: 'epic', type: 'epic' })] })));
    assert.doesNotThrow(() => {
      setFilter(before, 'type', 'bug');
      setLevel(before, 'epic');
      clearFilters(before);
      drill(before, before.data.columns[0].cards[0]);
      selectPath(before, { param: 'initiative' });
      const busy = startLoad(before, { refresh: true });
      loadSucceeded(busy, payload(), busy.request);
      loadFailed(busy, { error: 'off' }, busy.request);
    });
  });
});

describe('#466/AC-4 the parent chain mode', () => {
  test('#466/AC-4 compact by default; the level alone is not a filter and keeps it compact', () => {
    assert.equal(initialState('').chainMode, 'compact');
    assert.equal(initialState('level=plan').chainMode, 'compact');
  });

  test('#466/AC-4 full when any of the six filters is on, as after a drill', () => {
    for (const param of FILTER_PARAMS) assert.equal(initialState(`level=item&${param}=${param === 'project' ? 'x/1' : 'x'}`).chainMode, 'full', param);
    const epic = card(6, { level: 'epic', type: 'epic' });
    const drilled = drill(loaded('level=epic', payload({ cards: [epic] })), epic);
    assert.equal(loadSucceeded(drilled, payload(), drilled.request).chainMode, 'full');
  });
});

describe('#466/AC-3 the filter with no result (466-3)', () => {
  const noCards = { cards: [], matched: 0 };

  test('#502/AC-1 filters on and no card: the suggestion drops the last filter set, with the exact count from /api/work', () => {
    let s = loaded('level=item');
    s = setFilter(s, 'repo', 'ahrena-console');
    s = setFilter(s, 'status', 'in-progress');
    const body = payload({ ...noCards, total: 9, countsWithoutFilter: { repo: 2, status: 4 } });
    s = loadSucceeded(s, body, s.request);
    assert.equal(s.phase, 'no-result');
    assert.equal(s.view, 'no-result');
    assert.deepEqual(s.suggestion, { param: 'status', value: 'in-progress', count: 4 });
    assert.equal(suggestionText(s.suggestion, s.filters, body.options), 'Sem o Status in-progress, há 4 issues neste recorte.');
  });

  test('#502/AC-1 when the last filter alone brings nothing back, the one before it is suggested', () => {
    let s = loaded('level=item');
    s = setFilter(s, 'status', 'in-progress');
    s = setFilter(s, 'repo', 'ahrena-console');
    s = loadSucceeded(s, payload({ ...noCards, total: 9, countsWithoutFilter: { status: 3, repo: 0 } }), s.request);
    assert.deepEqual(s.suggestion, { param: 'status', value: 'in-progress', count: 3 });
  });

  test('#502/AC-1 each of the eight filters is suggested with its exact count, combined with another filter', () => {
    const values = { org: 'ahrena', project: 'ahrena/3', initiative: `${REPO}#1`, epic: `${REPO}#6`, type: 'bug', label: 'ui', repo: 'ahrena-console', status: 'in-progress' };
    for (const param of FILTER_PARAMS) {
      const other = FILTER_PARAMS.find((p) => p !== param) as string;
      let s = loaded('level=item');
      s = setFilter(s, other, values[other as keyof typeof values]);
      s = setFilter(s, param, values[param as keyof typeof values]);
      s = loadSucceeded(s, payload({ ...noCards, total: 50, countsWithoutFilter: { [other]: 0, [param]: 7 } }), s.request);
      assert.equal(s.phase, 'no-result', param);
      assert.deepEqual(s.suggestion, { param, value: values[param as keyof typeof values], count: 7 }, param);
    }
  });

  test('#502/AC-1 type, label, initiative and epic with other filters on use the count from /api/work, not the options', () => {
    const s = loaded(
      'level=item&epic=6&label=design-system',
      payload({ ...noCards, total: 9, countsWithoutFilter: { epic: 0, label: 3 }, options: { ...NO_OPTIONS, labels: [{ name: 'ui', count: 2 }] } }),
    );
    assert.deepEqual(s.suggestion, { param: 'label', value: 'design-system', count: 3 });
  });

  test('#502/AC-1 a filtered board whose matches all left the done window still suggests the filter, with the count of the window', () => {
    const s = loaded('level=item&label=ui', payload({ cards: [], matched: 3, total: 5, countsWithoutFilter: { label: 5 } }));
    assert.equal(s.phase, 'no-result');
    assert.deepEqual(s.suggestion, { param: 'label', value: 'ui', count: 5 });
    assert.equal(loaded('level=item', payload({ cards: [], matched: 3, total: 3 })).phase, 'loaded', 'unfiltered, it is the board with Concluído trimmed');
  });

  test('#502/AC-1 a single filter: the suggestion names it with the count of the level', () => {
    const s = loaded('level=item&label=design-system', payload({ ...noCards, total: 2, countsWithoutFilter: { label: 2 } }));
    assert.deepEqual(s.suggestion, { param: 'label', value: 'design-system', count: 2 });
    assert.equal(suggestionText(s.suggestion, s.filters, NO_OPTIONS), 'Sem a label design-system, há 2 issues neste recorte.');
  });

  test('#502/AC-2 no positive count for any active filter: no suggestion, only Limpar filtros', () => {
    const s = loaded('level=item&type=bug&repo=x', payload({ ...noCards, total: 9, countsWithoutFilter: { type: 0, repo: 0 } }));
    assert.equal(s.phase, 'no-result');
    assert.equal(s.suggestion, null);
  });

  test('#502/AC-2 a core that sends no countsWithoutFilter gives no suggestion', () => {
    const s = loaded('level=item&type=bug&repo=x', payload({ ...noCards, total: 9 }));
    assert.equal(s.phase, 'no-result');
    assert.equal(s.suggestion, null);
  });

  test('#466/AC-3 with cards on the board there is no suggestion', () => {
    assert.equal(loaded('level=item&type=story').suggestion, null);
  });
});

describe('#465/AC-5 the state module is pure and English (ADR-0009)', () => {
  test('#465/AC-5 no DOM, no fetch, no window or location access, no colour or issue reference by hand', () => {
    const text = readFileSync(`${UI_FOLDER}${FILE}`, 'utf8');
    assert.doesNotMatch(text, /\bfetch\(|\bwindow\b|\bdocument\b|\blocation\.|\bhistory\.|innerHTML/);
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])/i, 'the colour guard reads an issue reference as a colour');
  });

  test('#465/AC-5 every key and value of the state is English', () => {
    const s = loaded('level=item&label=ui');
    assert.deepEqual(
      Object.keys(s).sort(),
      ['api', 'busy', 'chainMode', 'data', 'dataFilters', 'emptyKind', 'error', 'filters', 'githubDown', 'multiOrigin', 'navigation', 'organizations', 'phase', 'placed', 'request', 'refresh', 'resetNote', 'retryAt', 'stale', 'staleOrgs', 'staleReason', 'suggestion', 'url', 'view', 'warningsExpanded'].sort(),
    );
    for (const value of [s.phase, s.view, s.chainMode]) assert.match(value, /^[a-z-]+$/);
  });
});

const org = (login: string, over: Json = {}): Json => ({ login, own: false, state: 'read', readAt: 1_000, projects: [{ owner: login, number: 1, title: `${login} board` }], ...over });
const PLATFORM = { owner: 'acme-labs', number: 3, title: 'Plataforma' };
const ROADMAP = { owner: 'northwind', number: 1, title: 'Roadmap' };
const ORGS = [org('acme-labs', { projects: [PLATFORM, { owner: 'acme-labs', number: 4, title: 'Mobile' }] }), org('northwind', { projects: [ROADMAP] }), org('mira-dev', { own: true })];
const multi = (search: string, over: Json = {}): Json => loaded(search, payload({ project: null, organizations: ORGS, options: { ...NO_OPTIONS, orgs: [], projects: [PLATFORM, ROADMAP] }, ...over }));

describe('#610/AC-1 the organization and the Project are filters, first in order', () => {
  test('#610/AC-1 org and project come first in the link and in GET /api/work, level first, project as owner/number', () => {
    const filters = filtersFromSearch('status=in-progress&type=bug&project=acme-labs/3&org=acme-labs&level=item');
    assert.deepEqual(filters.org, 'acme-labs');
    assert.deepEqual(filters.project, 'acme-labs/3');
    assert.equal(boardUrl(filters), '/ui/work?level=item&org=acme-labs&project=acme-labs/3&type=bug&status=in-progress');
    assert.equal(searchFromFilters(filtersFromSearch(searchFromFilters(filters))), searchFromFilters(filters), 'the round trip is stable');
    const parsed = parseWorkBoardFilters(new URL(apiPath(filters), 'http://127.0.0.1').searchParams);
    assert.deepEqual(parsed, { level: 'item', org: 'acme-labs', project: 'acme-labs/3', initiative: null, epic: null, type: 'bug', label: null, repo: null, status: 'in-progress' });
  });

  test('#610/AC-1 a canonical link with the slash is not replaced; an encoded one is read the same', () => {
    assert.equal(initialState('?level=item&org=acme-labs&project=acme-labs/3').navigation, null);
    assert.equal(filtersFromSearch('project=acme-labs%2F3').project, 'acme-labs/3');
  });

  test('#610/AC-1 a malformed project or organization is dropped, never sent: the API would answer 400 bad-filter', () => {
    for (const bad of ['acme-labs', 'acme-labs/', 'acme-labs/0', 'acme-labs/x', '/3', 'a/b/3', 'acme labs/3', 'acme-labs#3']) {
      const s = initialState(`?project=${encodeURIComponent(bad)}&org=acme-labs`);
      assert.equal(s.filters.project, null, bad);
      assert.doesNotMatch(s.api, /project/, bad);
      assert.equal(s.navigation, 'replace', `${bad}: the URL is cleaned`);
      assert.equal(s.url, '/ui/work?level=item&org=acme-labs');
    }
    assert.equal(initialState('?org=-bad-').filters.org, null);
    assert.equal(initialState('?org=a%20b').filters.org, null);
    const s = loaded('level=item');
    assert.equal(setFilter(s, 'project', 'not-a-project'), s, 'a malformed project is not set');
  });

  test('#610/AC-1 the filters AND: org and project narrow with the six, chain mode is full, clearFilters clears them', () => {
    const s = multi('org=acme-labs&project=acme-labs/3&type=story');
    assert.equal(s.chainMode, 'full');
    assert.equal(s.api, '/api/work?level=item&org=acme-labs&project=acme-labs/3&type=story');
    const cleared = clearFilters(s);
    assert.equal(cleared.url, '/ui/work?level=item');
    assert.equal(cleared.filters.org, null);
    assert.equal(cleared.filters.project, null);
    assert.equal(cleared.navigation, 'push');
    assert.equal(loaded('org=acme-labs').chainMode, 'full');
  });

  test('#610/AC-1 setting project and org pushes the URL and loads', () => {
    const s = setFilter(multi('level=item'), 'project', 'acme-labs/3');
    assert.equal(s.url, '/ui/work?level=item&project=acme-labs/3');
    assert.equal(s.navigation, 'push');
    assert.equal(s.busy, true);
    assert.equal(s.resetNote, null);
    assert.equal(setFilter(s, 'org', 'acme-labs').url, '/ui/work?level=item&org=acme-labs&project=acme-labs/3');
  });
});

describe('#610/AC-2 changing the organization resets a Project it does not own, and says why', () => {
  test('#610/AC-2 an org that does not own the Project drops it and records the note with the Project title from the options', () => {
    const before = multi('org=acme-labs&project=acme-labs/3');
    const s = setFilter(before, 'org', 'northwind');
    assert.equal(s.filters.org, 'northwind');
    assert.equal(s.filters.project, null);
    assert.equal(s.url, '/ui/work?level=item&org=northwind');
    assert.deepEqual(s.resetNote, { project: { owner: 'acme-labs', number: 3, title: 'Plataforma' }, to: 'northwind' });
    assert.equal(s.navigation, 'push');
  });

  test('#610/AC-2 without the title in the options, the note names owner/number', () => {
    const s = setFilter(loaded('org=acme-labs&project=acme-labs/9'), 'org', 'northwind');
    assert.deepEqual(s.resetNote, { project: { owner: 'acme-labs', number: 9, title: 'acme-labs/9' }, to: 'northwind' });
  });

  test('#610/AC-2 the owner of the Project keeps it; Todas keeps it; the login compares without case', () => {
    const before = multi('org=northwind&project=acme-labs/3');
    assert.equal(setFilter(multi('org=northwind'), 'project', 'acme-labs/3').resetNote, null);
    assert.equal(setFilter(before, 'org', 'Acme-Labs').filters.project, 'acme-labs/3');
    assert.equal(setFilter(before, 'org', null).filters.project, 'acme-labs/3');
    assert.equal(setFilter(before, 'org', null).resetNote, null);
    assert.equal(setFilter(loaded('level=item'), 'org', 'northwind').resetNote, null, 'no Project, nothing to reset');
  });

  test('#610/AC-2 the note goes with the next change and stays while the new board loads', () => {
    const reset = setFilter(multi('org=acme-labs&project=acme-labs/3'), 'org', 'northwind');
    const answered = loadSucceeded(reset, payload({ project: null, organizations: ORGS }), reset.request);
    assert.deepEqual(answered.resetNote, reset.resetNote);
    assert.equal(setFilter(answered, 'type', 'bug').resetNote, null);
    assert.equal(clearFilters(setFilter(answered, 'type', 'bug')).resetNote, null);
    assert.equal(setLevel(answered, 'epic').resetNote, null);
  });
});

describe('#610/AC-3 more than three warnings: the rest opens', () => {
  const warned = ['a-org', 'b-org', 'c-org', 'd-org', 'e-org'].map((l) => org(l, { state: 'restricted', readAt: null, projects: [] }));
  test('#610/AC-3 Mais N toggles expanded and nothing else: no read, no URL change', () => {
    const s = multi('level=item', { organizations: [...ORGS, ...warned] });
    assert.equal(s.warningsExpanded, false);
    const open = toggleWarnings(s);
    assert.equal(open.warningsExpanded, true);
    assert.equal(open.navigation, null);
    assert.equal(open.request, s.request);
    assert.equal(open.busy, false);
    assert.equal(open.data, s.data);
    assert.equal(toggleWarnings(open).warningsExpanded, false);
  });

  test('#610/AC-3 a new read keeps it open; the toggle never changes the state it is given', () => {
    const s = deepFreeze(toggleWarnings(multi('level=item', { organizations: [...ORGS, ...warned] })));
    assert.doesNotThrow(() => toggleWarnings(s));
    const again = startLoad(s, { refresh: true });
    assert.equal(loadSucceeded(again, payload({ project: null, organizations: ORGS }), again.request).warningsExpanded, true);
  });

  test('#610/AC-3 the toggle is the "more" action', () => {
    assert.deepEqual(warningTarget('more'), { kind: 'toggle' });
  });
});

describe('#610/AC-4 what the board is: one origin or many, GitHub down, stale organizations, which empty', () => {
  test('#610/AC-4 exactly one read organization and one Project with no warning is single-origin: no origin line, no org/project filters', () => {
    const one = multi('level=item', { organizations: [org('acme-labs', { projects: [PLATFORM] })], project: { ...PLATFORM, url: 'https://github.com/orgs/acme-labs/projects/3' } });
    assert.equal(one.multiOrigin, false);
    assert.equal(multi('level=item', { organizations: [org('acme-labs', { projects: [PLATFORM] }), org('northwind', { state: 'saml', readAt: null, projects: [] })] }).multiOrigin, true, 'a warning makes it multi');
    assert.equal(multi('level=item', { organizations: [org('acme-labs', { projects: [PLATFORM, ROADMAP] })] }).multiOrigin, true, 'two Projects');
    assert.equal(multi('level=item').multiOrigin, true);
  });

  test('#610/AC-4 a core with no organizations, or the legacy one Project with an empty list, is single-origin', () => {
    assert.equal(loaded('level=item').multiOrigin, false);
    assert.equal(loaded('level=item', payload({ organizations: [] })).multiOrigin, false);
    assert.equal(loaded('level=item', payload({ project: null, organizations: [] })).multiOrigin, true, 'no Project at all is the multi empty');
  });

  test('#610/AC-4 while nothing is known the loading is the multi one, unless the link has no organization or Project and the read failed', () => {
    assert.equal(initialState('level=item').multiOrigin, true);
    const failed = initialState('level=item');
    assert.equal(loadFailed(failed, { error: 'no-project', status: 404 }, failed.request).multiOrigin, false);
    const bad = initialState('level=item&org=acme-labs');
    assert.equal(loadFailed(bad, { error: 'bad-filter', param: 'org', status: 400 }, bad.request).multiOrigin, true);
  });

  test('#610/AC-4 githubDown is stale with the github-unavailable reason', () => {
    assert.equal(multi('level=item', { stale: true, staleReason: 'github-unavailable' }).githubDown, true);
    assert.equal(multi('level=item', { stale: true, staleReason: 'dado velho' }).githubDown, false);
    assert.equal(multi('level=item', { stale: false, staleReason: 'github-unavailable' }).githubDown, false);
    assert.equal(loaded('level=item').githubDown, false);
  });

  test('#610/AC-4 stale organizations are the ones that failed now and were read before; none when GitHub is down (the board is faded whole)', () => {
    const north = org('northwind', { state: 'failed', readAt: 500, projects: [ROADMAP] });
    const never = org('initech', { state: 'failed', readAt: null, projects: [] });
    assert.deepEqual(multi('level=item', { organizations: [ORGS[0], north, never] }).staleOrgs, ['northwind']);
    assert.deepEqual(multi('level=item', { organizations: [ORGS[0], north], stale: true, staleReason: 'github-unavailable' }).staleOrgs, []);
    assert.deepEqual(multi('level=item').staleOrgs, []);
    assert.deepEqual(loaded('level=item').staleOrgs, []);
  });

  test('#610/AC-4 the organizations of the read are exposed for the header, the warnings and the filters; none before the first read', () => {
    assert.deepEqual(multi('level=item').organizations, ORGS);
    assert.deepEqual(initialState('').organizations, []);
  });

  test('#610/AC-4 which empty applies: issues, projects or all-failed; none unless the board is empty', () => {
    const none = { total: 0, matched: 0, cards: [] };
    assert.equal(multi('level=item', none).emptyKind, 'issues');
    assert.equal(multi('level=item', { ...none, organizations: [] }).emptyKind, 'projects');
    assert.equal(multi('level=item', { ...none, organizations: [org('acme-labs', { projects: [] }), org('mira-dev', { own: true, projects: [] })] }).emptyKind, 'projects');
    const failed = [org('globex', { state: 'restricted', readAt: null, projects: [] }), org('initech', { state: 'failed', readAt: null, projects: [] })];
    assert.equal(multi('level=item', { ...none, organizations: failed }).emptyKind, 'all-failed');
    assert.equal(multi('level=item', { ...none, organizations: [ORGS[0], ...failed] }).emptyKind, 'issues', 'one read organization with Projects is not all-failed');
    assert.equal(multi('level=item').emptyKind, null);
    assert.equal(multi('level=item&type=bug', none).emptyKind, null, 'filtered with no result is the 466 no-result');
    assert.equal(loaded('level=item', payload({ cards: [], total: 0 })).emptyKind, null, 'single-origin keeps the empty Project');
  });
});

describe('#610/AC-3 the targets of the warning and empty-state actions', () => {
  const restricted = org('globex', { state: 'restricted', readAt: null, projects: [], approvalUrl: 'https://github.com/organizations/globex/settings/oauth_application_policy', requestUrl: 'https://github.com/settings/connections/applications/abc' });
  test('#610/AC-3 approve and request open the URLs the organization carries, only when https on github.com', () => {
    assert.deepEqual(warningTarget('approve', { organization: restricted }), { kind: 'link', href: restricted.approvalUrl });
    assert.deepEqual(warningTarget('request', { organization: restricted }), { kind: 'link', href: restricted.requestUrl });
    assert.deepEqual(warningTarget('approve', { organization: { ...restricted, approvalUrl: 'javascript:alert(1)' } }), { kind: 'none' });
    assert.deepEqual(warningTarget('request', { organization: { ...restricted, requestUrl: 'https://evil.example/x' } }), { kind: 'none' });
    assert.deepEqual(warningTarget('approve', { organization: org('globex', { state: 'restricted' }) }), { kind: 'none' });
    assert.deepEqual(warningTarget('approve', {}), { kind: 'none' });
  });

  test('#610/AC-3 retry reads again; sso opens the organization SSO page on GitHub', () => {
    assert.deepEqual(warningTarget('retry', { organization: org('initech') }), { kind: 'read' });
    assert.deepEqual(warningTarget('sso', { organization: org('umbrella-corp', { state: 'saml' }) }), { kind: 'link', href: 'https://github.com/orgs/umbrella-corp/sso' });
    assert.deepEqual(warningTarget('sso', { organization: { login: 'not a login' } }), { kind: 'none' });
  });

  test('#610/AC-4 open-projects, open-github and connect: the Projects of the first organization read, GitHub, and the connections screen', () => {
    const organizations = [org('acme-labs'), org('mira-dev', { own: true })];
    assert.deepEqual(warningTarget('open-projects', { organizations }), { kind: 'link', href: 'https://github.com/orgs/acme-labs/projects' });
    assert.deepEqual(warningTarget('open-projects', { organizations: [org('mira-dev', { own: true })] }), { kind: 'link', href: 'https://github.com/mira-dev?tab=projects' });
    assert.deepEqual(warningTarget('open-projects', { organizations: [] }), { kind: 'link', href: 'https://github.com' });
    assert.deepEqual(warningTarget('open-github'), { kind: 'link', href: 'https://github.com' });
    assert.deepEqual(warningTarget('connect'), { kind: 'screen', to: '/ui/connections' });
  });

  test('#610/AC-4 an action that is not known has no target', () => {
    assert.deepEqual(warningTarget('switch-project'), { kind: 'none' });
    assert.deepEqual(warningTarget(undefined), { kind: 'none' });
  });
});
