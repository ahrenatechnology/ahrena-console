// #465 #466 the work board's components (layer 2): pure render functions over GET /api/work, in the fake DOM.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { UI_FOLDER, respondUi } from '../../src/api/ui.ts';
import { WORK_BLOCKED_REASONS, WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';
import { WORK_LEVELS } from '../../src/github/work.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  BLOCKED_LABELS,
  COLUMNS,
  FILTER_FIELDS,
  LEVEL_LABELS,
  SWITCH_PROJECT_HREF,
  boardColumns,
  boardPath,
  cardAge,
  chainText,
  emptyProject,
  filterBar,
  filterChips,
  firstReadFailure,
  formatAgo,
  formatClock,
  levelSwitch,
  noResult,
  orgWarnings,
  orgsEmpty,
  parentCard,
  projectResetNote,
  readLabel,
  sessionText,
  staleBand,
  staleOrganizations,
  usualRepos,
  workBoardError,
  workBoardHeader,
  workCard,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-parts.js';

instalarDomFalso();

const FILES = ['screens/work-board-parts.js', 'screens/work-board-queue.js', 'screens/work-board-queue-state.js', 'screens/work-board-queue-layer.js', 'work-board.css'];
const REPO = 'ahrenatechnology/ahrena-console';
const NOW = new Date(2026, 10, 13, 23, 12, 40).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Card = Record<string, unknown>;
const INITIATIVE = { key: `${REPO}#1`, number: 1, title: 'Console como cockpit', level: 'initiative' };
const EPIC = { key: `${REPO}#6`, number: 6, title: 'Quadro do trabalho', level: 'epic' };
function card(n: number, over: Card = {}): Card {
  return {
    key: `${REPO}#${n}`,
    repo: REPO,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    level: 'item',
    type: 'story',
    typeName: 'User Story',
    state: 'open',
    column: 'planning',
    columnSince: ago(5 * HOUR),
    parent: { key: EPIC.key, number: 6 },
    chain: [INITIATIVE, EPIC],
    projectStatus: { id: 'todo', name: 'Todo' },
    labels: [],
    milestone: null,
    plan: null,
    sessions: { count: 0, state: null, ids: [] },
    pullRequest: null,
    blocked: null,
    queuePosition: null,
    doneAt: null,
    doneBy: null,
    children: null,
    ...over,
  };
}
const pr = (over: Card = {}) => ({ number: 512, url: `https://github.com/${REPO}/pull/512`, state: 'open', ci: 'running', review: 'pending', changesRequested: 0, ...over });
const blocked = (reason: string) => ({ reason, label: WORK_BLOCKED_REASONS.find((r) => r.id === reason)!.label });

const CARDS = {
  planning: [card(506, { plan: { steps: 5 } }), card(511, { type: 'spike', typeName: 'Spike', repo: 'ahrenatechnology/ahrena-framework', projectStatus: null })],
  queued: [card(507, { column: 'queued', plan: { steps: 4 }, queuePosition: 1 })],
  running: [card(505, { column: 'running', type: 'task', sessions: { count: 2, state: 'working', ids: ['a', 'b'] } })],
  review: [card(497, { column: 'review', pullRequest: pr() })],
  blocked: [
    card(498, { column: 'blocked', type: 'task', sessions: { count: 1, state: 'needs-you', ids: ['c'] }, blocked: blocked('needs-you'), columnSince: ago(12 * MIN) }),
    card(495, { column: 'blocked', pullRequest: pr({ number: 508, ci: 'ok', review: 'changes-requested', changesRequested: 3 }), blocked: blocked('review-rounds') }),
    card(504, { column: 'blocked', type: 'bug', pullRequest: pr({ number: 510, ci: 'failed' }), blocked: blocked('ci-failed') }),
  ],
  done: [
    card(490, { column: 'done', state: 'closed', doneAt: ago(2 * DAY), doneBy: 'merged', pullRequest: pr({ number: 491, state: 'merged', ci: 'ok', review: 'approved' }) }),
    card(488, { column: 'done', state: 'closed', type: 'spike', doneAt: ago(3 * DAY), doneBy: 'closed' }),
    card(487, { column: 'done', state: 'closed', doneAt: ago(4 * DAY), doneBy: 'closed' }),
  ],
};
const PAYLOAD_COLUMNS = WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
  const cards = CARDS[id as keyof typeof CARDS];
  return { id, label, criterion, count: cards.length, cards };
});
const OPTIONS = {
  initiatives: [{ key: `${REPO}#1`, repo: REPO, number: 1, title: 'Console como cockpit', count: 9 }],
  epics: [
    { key: `${REPO}#6`, repo: REPO, number: 6, title: 'Quadro do trabalho', count: 7 },
    { key: `${REPO}#7`, repo: REPO, number: 7, title: 'Máquinas remotas', count: 2 },
  ],
  types: [{ id: 'story', count: 4 }, { id: 'bug', count: 2 }],
  labels: [{ name: 'ui', count: 2 }],
  repos: [{ name: REPO, count: 9 }],
  statuses: [{ id: 'todo', name: 'Todo', count: 5 }, { id: 'in-progress', name: 'In Progress', count: 3 }],
};
const NO_FILTERS = { level: 'item', initiative: null, epic: null, type: null, label: null, repo: null, status: null };
const OUT_OF_SCOPE = /Planejar|Executar plano|Pôr na fila|Replanejar|Abrir sessão|Tirar da fila|Arrastar/;

const buttons = (root: ElementoFalso) => root.querySelectorAll('button');
const buttonNamed = (root: ElementoFalso, name: RegExp) => buttons(root).find((b) => name.test(texto(b)) || name.test(b.getAttribute('aria-label') ?? ''));

describe('the work board files: served, and the /ui file rules', () => {
  test('the core serves screens/work-board-parts.js and work-board.css with the right type', async () => {
    for (const [file, type] of [['screens/work-board-parts.js', /^text\/javascript/], ['work-board.css', /^text\/css/]] as const) {
      let status = 0;
      let headers: Record<string, string | number> = {};
      let body = '';
      const res = {
        writeHead(s: number, h: Record<string, string | number>) {
          status = s;
          headers = h ?? {};
          return this;
        },
        setHeader() {},
        end(b?: Buffer | string) {
          body = String(b ?? '');
        },
      } as unknown as ServerResponse;
      await respondUi(res, `/ui/${file}`);
      assert.equal(status, 200, file);
      assert.match(String(headers['content-type']), type, file);
      assert.equal(body, readFileSync(`${UI_FOLDER}${file}`, 'utf8'), file);
    }
  });

  test('the files call nothing outside, write no colour, no inline style, no innerHTML, no fetch, no URL access', () => {
    for (const file of FILES) {
      const text = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      const urls = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${file} names an external address`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${file} writes a colour by hand`);
      assert.doesNotMatch(text, /style=|innerHTML|\bfetch\(/, `${file} uses inline style, innerHTML or fetch`);
    }
    const js = readFileSync(`${UI_FOLDER}screens/work-board-parts.js`, 'utf8');
    assert.doesNotMatch(js, /\blocation\.|\bhistory\.|URLSearchParams|ctx\.read/, 'the components neither read nor write the URL, nor read the API');
  });

  test('the CSS styles only wb- classes or the frame ones, none of another screen, and the JS uses only classes that exist', () => {
    const classes = (file: string) => new Set([...readFileSync(`${UI_FOLDER}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const frame = classes('shell.css');
    const mine = [...classes('work-board.css')].filter((c) => !frame.has(c));
    assert.deepEqual(mine.filter((c) => !c.startsWith('wb-')), [], 'own class without the wb- prefix');
    const others = readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && !['work-board.css', 'shell.css', 'brand.css'].includes(a));
    for (const other of others) {
      const theirs = classes(other);
      assert.deepEqual(mine.filter((c) => theirs.has(c)), [], `work-board.css and ${other} style the same classes`);
    }
    const js = readFileSync(`${UI_FOLDER}screens/work-board-parts.js`, 'utf8');
    const used = new Set([...js.matchAll(/\bwb-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.endsWith('-')));
    for (const c of used) assert.ok(mine.includes(c), `${c} is not in work-board.css`);
    for (const id of WORK_BOARD_COLUMNS.map((c) => c.id)) assert.ok(mine.includes(`wb-dot-${id}`), `wb-dot-${id} is not in work-board.css`);
    for (const t of ['story', 'task', 'spike', 'bug', 'epic', 'initiative', 'plan', 'other']) assert.ok(mine.includes(`wb-type-${t}`), `wb-type-${t}`);
    for (const r of WORK_BLOCKED_REASONS.map((x) => x.id)) assert.ok(mine.includes(`wb-reason-${r}`), `wb-reason-${r}`);
  });

  test('#465/AC-2 the CSS lays the six columns side by side at 1440 and two rows of three at 1100, never scrolling sideways', () => {
    const css = readFileSync(`${UI_FOLDER}work-board.css`, 'utf8');
    assert.match(css, /\.wb-board\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
    const narrow = /@media \(max-width: (\d+)px\)\s*\{[^@]*\.wb-board\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.exec(css);
    assert.ok(narrow, 'a media query folds the board into three columns');
    assert.ok(Number(narrow[1]) >= 1100 && Number(narrow[1]) < 1440, 'the fold happens between 1100 and 1440');
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /overflow-x:\s*(auto|scroll)/);
  });

  test('the on-screen copy mirrors the domain: the six columns, the reasons and the four levels', () => {
    assert.deepEqual(COLUMNS, WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => ({ id, label, criterion })));
    assert.deepEqual(Object.keys(BLOCKED_LABELS), WORK_BLOCKED_REASONS.map((r) => r.id));
    assert.deepEqual(Object.keys(LEVEL_LABELS), [...WORK_LEVELS]);
    assert.deepEqual(FILTER_FIELDS.map((f: { param: string }) => f.param), ['initiative', 'epic', 'type', 'label', 'repo', 'status']);
  });
});

describe('#465/AC-2 the header and the time of the last GitHub read', () => {
  test('#465/AC-2 formatters: relative time and the hour in pt-BR', () => {
    assert.equal(formatAgo(ago(40_000), NOW), 'há 40 s');
    assert.equal(formatAgo(ago(31 * MIN), NOW), 'há 31 min');
    assert.equal(formatAgo(ago(3 * HOUR + 5 * MIN), NOW), 'há 3 h');
    assert.equal(formatAgo(ago(2 * DAY + HOUR), NOW), 'há 2 d');
    assert.equal(formatAgo(NOW - 5_000, NOW), 'há 5 s', 'epoch milliseconds too');
    assert.equal(formatAgo(null, NOW), null);
    assert.equal(formatAgo('not a date', NOW), null);
    assert.equal(formatClock(new Date(2026, 10, 13, 9, 5).getTime()), '09:05');
    assert.equal(readLabel({ fetchedAt: NOW - 40_000, now: NOW }), 'lido às 23:12 · há 40 s');
    assert.equal(readLabel({ fetchedAt: null, now: NOW }), 'nunca lido');
    assert.equal(readLabel({ fetchedAt: NOW, now: NOW, reading: true }), 'lendo o GitHub…');
  });

  test('#465/AC-2 header: title, project, last read and Atualizar, which calls back and turns busy', () => {
    let refreshed = 0;
    const project = { owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3', primaryRepo: REPO };
    const head = workBoardHeader({ project, fetchedAt: NOW - 40_000, now: NOW, onRefresh: () => refreshed++ });
    assert.equal(texto(head.querySelector('h1')).replace(' Ao vivo', ''), 'Quadro do trabalho');
    assert.ok(head.querySelector('.ico svg')!.innerHTMLFalso.includes('M9 3v18'), 'the header draws the columns-3 icon, not the sessions Kanban one');
    assert.match(texto(head), new RegExp(`${REPO} · GitHub Project “Ahrena Console”`));
    assert.match(texto(head.querySelector('.wb-read')), /lido às 23:12 · há 40 s/);
    assert.ok(!head.querySelector('.wb-read')!.classList.contains('wb-read-old'));
    const refresh = buttonNamed(head, /^Atualizar$/)!;
    assert.equal(refresh.getAttribute('type'), 'button');
    refresh.click();
    assert.equal(refreshed, 1);

    const busy = workBoardHeader({ project, fetchedAt: null, now: NOW, reading: true, busy: true, onRefresh: () => refreshed++ });
    const spinning = buttonNamed(busy, /^Atualizar$/)!;
    assert.equal(spinning.getAttribute('aria-busy'), 'true');
    assert.ok(spinning.hasAttribute('disabled'));
    assert.match(texto(busy.querySelector('.wb-read')), /lendo o GitHub…/);

    const stale = workBoardHeader({ project, fetchedAt: NOW - 31 * MIN, now: NOW, stale: true });
    assert.ok(stale.querySelector('.wb-read')!.classList.contains('wb-read-old'), 'the hour turns yellow while the data is old');
  });
});

describe('#466/AC-2 the level switch and the path', () => {
  test('#466/AC-2 the four levels of WORK_LEVELS, the current one pressed; a click asks for the level', () => {
    const asked: string[] = [];
    const bar = levelSwitch({ levels: [...WORK_LEVELS], level: 'item', onLevelChange: (l: string) => asked.push(l) });
    const group = bar.querySelector('[role="group"]')!;
    assert.equal(group.getAttribute('aria-label'), 'Nível');
    const levels = group.querySelectorAll('button');
    assert.deepEqual(levels.map(texto), ['Iniciativa', 'Épico/Milestone', 'Item', 'Plano de execução']);
    assert.deepEqual(levels.map((b) => b.getAttribute('data-level')), [...WORK_LEVELS]);
    assert.deepEqual(levels.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true', 'false']);
    assert.match(texto(bar), /história, tarefa técnica, spike e bug/);
    levels[1]!.click();
    levels[2]!.click();
    assert.deepEqual(asked, ['epic'], 'the current level is not asked again');
  });

  test('#466/AC-2 the path "Iniciativa #1 › Épico #6" on the right, built from the filters; an earlier step calls back', () => {
    const path = boardPath({ ...NO_FILTERS, initiative: 1, epic: 6 }, OPTIONS);
    assert.deepEqual(path.map((p: { text: string }) => p.text), ['Iniciativa #1', 'Épico #6']);
    assert.equal(path[1].title, 'Quadro do trabalho');
    assert.deepEqual(boardPath(NO_FILTERS, OPTIONS), []);
    const chosen: unknown[] = [];
    const bar = levelSwitch({ levels: [...WORK_LEVELS], level: 'item', path, onLevelChange: () => {}, onPathSelect: (p: unknown) => chosen.push(p) });
    const nav = bar.querySelector('nav')!;
    assert.equal(nav.getAttribute('aria-label'), 'Caminho');
    assert.match(texto(nav), /Iniciativa #1 Épico #6 Quadro do trabalho/);
    assert.equal(nav.querySelector('[aria-current="location"]')!.textContent.startsWith('Épico #6'), true);
    nav.querySelector('button')!.click();
    assert.equal((chosen[0] as { param: string }).param, 'initiative');
  });
});

describe('#466/AC-3 the filter bar', () => {
  test('#466/AC-3 the six filters fed by the options with counts; a change calls back with the English param', () => {
    const changes: [string, unknown][] = [];
    const bar = filterBar({ filters: NO_FILTERS, options: OPTIONS, onFilterChange: (p: string, v: unknown) => changes.push([p, v]), onClear: () => {}, onCopyLink: () => {} });
    const selects = bar.querySelectorAll('select');
    assert.deepEqual(selects.map((s) => s.getAttribute('data-param')), ['initiative', 'epic', 'type', 'label', 'repo', 'status']);
    assert.deepEqual(bar.querySelectorAll('.wb-field-label').map(texto), ['Iniciativa', 'Épico/Milestone', 'Tipo', 'Label', 'Repositório', 'Status do Project']);
    assert.deepEqual(selects.map((s) => texto(s.querySelector('option'))), ['Todas', 'Todos', 'Todos', 'Todas', 'Todos', 'Todos']);
    assert.deepEqual(selects[2]!.querySelectorAll('option').map(texto), ['Todos', 'História (4)', 'Bug (2)']);
    assert.deepEqual(selects[1]!.querySelectorAll('option').map((o) => o.getAttribute('value')), ['', '6', '7']);
    assert.match(texto(selects[1]!.querySelectorAll('option')[1]!), /#6 Quadro do trabalho \(7\)/);
    assert.deepEqual(selects[4]!.querySelectorAll('option').map(texto), ['Todos', 'ahrena-console (9)']);
    assert.deepEqual(selects[5]!.querySelectorAll('option').map((o) => o.getAttribute('value')), ['', 'todo', 'in-progress']);
    selects[2]!.value = 'bug';
    selects[2]!.dispatchEvent({ type: 'change' });
    selects[2]!.value = '';
    selects[2]!.dispatchEvent({ type: 'change' });
    assert.deepEqual(changes, [['type', 'bug'], ['type', null]]);
    assert.equal(bar.querySelectorAll('.wb-chip').length, 0, 'no chip and no Limpar filtros without a filter');
    assert.equal(buttonNamed(bar, /Limpar filtros/), undefined);
  });

  test('#466/AC-3 active filters become chips joined by E, each with ×; Limpar filtros and Copiar link call back', () => {
    const changes: [string, unknown][] = [];
    let cleared = 0;
    let copied = 0;
    const filters = { ...NO_FILTERS, initiative: 1, epic: 6, type: 'bug', label: 'ui', status: 'in-progress' };
    const link = '/ui/work?level=item&initiative=1&epic=6&type=bug&label=ui&status=in-progress';
    const bar = filterBar({ filters, options: OPTIONS, link, onFilterChange: (p: string, v: unknown) => changes.push([p, v]), onClear: () => cleared++, onCopyLink: () => copied++ });
    const chips = bar.querySelectorAll('.wb-chip');
    assert.deepEqual(chips.map(texto), ['Iniciativa: #1', 'Épico/Milestone: #6', 'Tipo: Bug', 'Label: ui', 'Status do Project: In Progress']);
    assert.match(texto(bar.querySelector('.wb-chips')), /^Todos os filtros juntos: Iniciativa: #1 E Épico\/Milestone: #6 E/);
    const selects = bar.querySelectorAll('select');
    assert.equal(selects[1]!.value, '6');
    assert.equal(selects[2]!.value, 'bug');
    assert.ok(bar.querySelectorAll('.wb-field').filter((f) => f.classList.contains('wb-field-set')).length === 5);
    const remove = chips[3]!.querySelector('button')!;
    assert.equal(remove.getAttribute('aria-label'), 'Tirar o filtro Label');
    remove.click();
    buttonNamed(bar, /Limpar filtros/)!.click();
    assert.equal(texto(bar.querySelector('.wb-link code')), link);
    assert.match(texto(bar.querySelector('.wb-link')), /Link deste recorte/);
    buttonNamed(bar, /Copiar link/)!.click();
    assert.deepEqual([changes, cleared, copied], [[['label', null]], 1, 1]);
    assert.deepEqual(filterChips(filters, OPTIONS).map((c: { param: string }) => c.param), ['initiative', 'epic', 'type', 'label', 'status']);
  });

  test('#466/AC-3 a value with no option still shows as chosen; disabled turns every control off', () => {
    const bar = filterBar({ filters: { ...NO_FILTERS, label: 'design-system' }, options: OPTIONS, disabled: true, onFilterChange: () => {}, onClear: () => {}, onCopyLink: () => {} });
    assert.equal(bar.querySelectorAll('select')[3]!.value, 'design-system');
    assert.ok(bar.classList.contains('wb-off'));
    for (const control of [...bar.querySelectorAll('select'), ...buttons(bar)]) assert.ok(control.hasAttribute('disabled'), texto(control));
  });
});

describe('#465/AC-2 the card (465-2), data only', () => {
  test('#465/AC-2 anatomy: type, number, title, GitHub link, parent, Status as data, time in the column, plan chip', () => {
    const node = workCard(CARDS.planning[0], { chainMode: 'compact', primaryRepo: REPO, now: NOW });
    assert.equal(node.tagName, 'ARTICLE');
    assert.ok(node.classList.contains('card') && node.classList.contains('wb-card'));
    assert.equal(node.getAttribute('data-column'), 'planning');
    assert.equal(texto(node.querySelector('.wb-type')), 'História');
    assert.ok(node.querySelector('.wb-type')!.classList.contains('wb-type-story'));
    assert.equal(texto(node.querySelector('.wb-number')), '#506');
    assert.equal(texto(node.querySelector('h3')), 'Issue 506');
    const link = node.querySelector('.wb-card-top a.wb-card-github')!;
    assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues/506`);
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(texto(node.querySelector('.wb-chain')), '↑ #6');
    assert.equal(texto(node.querySelector('.wb-status')), 'Status: Todo');
    assert.equal(texto(node.querySelector('.wb-age')), 'há 5 h');
    assert.ok(node.querySelector('.wb-data .wb-age'), 'the time in the column ends the data row');
    assert.equal(node.querySelector('.wb-card-top .wb-age'), null);
    assert.equal(texto(node.querySelector('.wb-plan')), 'plano · 5 passos');
    assert.equal(node.querySelector('.wb-repo'), null, 'no repository on a card of the primary repo');
    assert.equal(node.querySelector('.wb-queue-pos'), null);
  });

  test('#465/AC-2 another repo, no Status, queue position, two sessions, PR with CI and review', () => {
    const other = workCard(CARDS.planning[1], { primaryRepo: REPO, now: NOW });
    assert.equal(texto(other.querySelector('.wb-repo')), 'ahrena-framework');
    assert.equal(texto(other.querySelector('.wb-status')), 'Status: Sem status');
    assert.equal(texto(other.querySelector('.wb-type')), 'Spike');

    const queued = workCard(CARDS.queued[0], { primaryRepo: REPO, now: NOW });
    const pos = queued.querySelector('.wb-queue-pos')!;
    assert.equal(texto(pos), '1º');
    assert.equal(pos.getAttribute('aria-hidden'), 'true');
    assert.equal(texto(queued.querySelector('.wb-card-top .wb-sr-only')), '1º na fila');
    assert.equal(texto(queued.querySelector('.wb-plan')), 'plano · 4 passos');

    const running = workCard(CARDS.running[0], { primaryRepo: REPO, now: NOW });
    assert.equal(texto(running.querySelector('.wb-session')), '2 sessões');
    assert.ok(running.querySelector('.wb-session')!.classList.contains('wb-session-working'));
    assert.equal(sessionText({ count: 1, state: 'working' }), 'trabalhando');
    assert.equal(sessionText({ count: 1, state: 'needs-you' }), 'precisa de você');
    assert.equal(sessionText({ count: 1, state: 'idle' }), 'ociosa');
    assert.equal(sessionText({ count: 0, state: null }), null);

    const review = workCard(CARDS.review[0], { primaryRepo: REPO, now: NOW });
    const prLink = review.querySelector('a.wb-pr')!;
    assert.equal(texto(prLink), '#512');
    assert.equal(prLink.getAttribute('href'), `https://github.com/${REPO}/pull/512`);
    assert.equal(texto(review.querySelector('.wb-ci')), 'CI …');
    assert.equal(texto(review.querySelector('.wb-review')), 'review');
    assert.equal(texto(workCard(CARDS.done[0], { primaryRepo: REPO, now: NOW }).querySelector('.wb-ci')), 'CI ✓');
    assert.equal(texto(workCard(CARDS.blocked[2], { primaryRepo: REPO, now: NOW }).querySelector('.wb-ci')), 'CI ✕');
    assert.equal(texto(workCard(CARDS.blocked[1], { primaryRepo: REPO, now: NOW }).querySelector('.wb-review')), 'ajustes');
  });

  test('#465/AC-2 Concluído counts from the merge or the close; the plan chip only in Planejamento and Na fila', () => {
    assert.equal(cardAge(CARDS.done[0], NOW), 'mergeada há 2 d');
    assert.equal(cardAge(CARDS.done[1], NOW), 'fechada há 3 d');
    assert.equal(cardAge(card(8, { type: 'epic', column: 'done', doneAt: ago(5 * DAY), doneBy: 'closed' }), NOW), 'fechado há 5 d');
    assert.equal(cardAge(card(9, { column: 'running', columnSince: ago(40 * MIN) }), NOW), 'há 40 min');
    const running = workCard(card(500, { column: 'running', plan: { steps: 3 }, sessions: { count: 1, state: 'working', ids: ['x'] } }), { now: NOW, primaryRepo: REPO });
    assert.equal(running.querySelector('.wb-plan'), null);
    assert.equal(texto(running.querySelector('.wb-session')), 'trabalhando');
    assert.equal(texto(workCard(card(1, { plan: { steps: 1 } }), { now: NOW }).querySelector('.wb-plan')), 'plano · 1 passo');
  });

  test('#465/AC-2 no out-of-scope action: no Planejar, Executar plano, Pôr na fila, Replanejar, Abrir sessão, no drag handle', () => {
    for (const c of Object.values(CARDS).flat()) {
      const node = workCard(c, { primaryRepo: REPO, now: NOW });
      assert.equal(buttons(node).length, 0, `card ${c.number} has a button`);
      assert.doesNotMatch(texto(node), OUT_OF_SCOPE);
      assert.equal(node.querySelector('[draggable]'), null);
      assert.equal(node.querySelector('.wb-grip'), null);
    }
  });
});

describe('#465/AC-3 Bloqueado says why', () => {
  test('#465/AC-3 each reason with its label, its icon tone; the ones from GitHub are marked to fade', () => {
    const [needs, rounds, ci] = CARDS.blocked.map((c) => workCard(c, { primaryRepo: REPO, now: NOW }));
    assert.equal(texto(needs!.querySelector('.wb-reason')), 'Precisa de você');
    assert.ok(needs!.querySelector('.wb-reason')!.classList.contains('wb-reason-needs-you'));
    assert.ok(!needs!.querySelector('.wb-reason')!.classList.contains('wb-gh'), 'needs-you comes from the core and stays strong');
    assert.ok(needs!.classList.contains('wb-card-attn'));
    assert.equal(texto(rounds!.querySelector('.wb-reason')), 'Mudança pedida depois de 3 rodadas');
    assert.ok(rounds!.querySelector('.wb-reason')!.classList.contains('wb-gh'));
    assert.equal(texto(ci!.querySelector('.wb-reason')), 'CI falhou');
    assert.ok(ci!.querySelector('.wb-reason')!.classList.contains('wb-reason-ci-failed'));
    assert.ok(ci!.classList.contains('wb-card-fail'));
    assert.equal(texto(needs!.querySelector('.wb-session')), 'precisa de você');
    assert.ok(needs!.querySelector('.wb-session')!.classList.contains('wb-session-needs-you'));
  });

  test('#465/AC-3 the column keeps the API order (reason, then oldest) and is marked when it holds cards', () => {
    const board = boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', primaryRepo: REPO, now: NOW, queueAvailable: true, doneWindowDays: 14 });
    const col = board.querySelector('[data-column="blocked"]')!;
    assert.deepEqual(col.querySelectorAll('.wb-number').map(texto), ['#498', '#495', '#504']);
    assert.ok(col.classList.contains('wb-col-attn'));
  });
});

describe('#465/AC-2 the six columns', () => {
  test('#465/AC-2 in order, each a section with heading, criterion, count and its cards', () => {
    const board = boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', primaryRepo: REPO, now: NOW, queueAvailable: true, doneWindowDays: 14 });
    assert.equal(board.getAttribute('role'), 'region');
    assert.equal(board.getAttribute('aria-label'), 'Quadro por ciclo do agente');
    const cols = board.querySelectorAll('section.wb-col');
    assert.deepEqual(cols.map((c) => c.getAttribute('data-column')), ['planning', 'queued', 'running', 'review', 'blocked', 'done']);
    assert.deepEqual(cols.map((c) => texto(c.querySelector('.wb-col-name'))), ['Planejamento', 'Na fila', 'Em execução', 'Em review', 'Bloqueado', 'Concluído']);
    assert.deepEqual(cols.map((c) => texto(c.querySelector('.wb-criterion'))), WORK_BOARD_COLUMNS.map((c) => c.criterion));
    assert.deepEqual(cols.map((c) => texto(c.querySelector('.wb-count'))), ['2', '1', '1', '1', '3', '3']);
    for (const c of cols) {
      const h2 = c.querySelector('h2')!;
      assert.equal(c.getAttribute('aria-labelledby'), h2.getAttribute('id'));
    }
    assert.equal(cols[4]!.querySelector('.wb-count')!.getAttribute('aria-hidden'), 'true');
    assert.equal(texto(cols[4]!.querySelector('h2 .wb-sr-only')), ': 3 issues');
    assert.equal(buttons(board).filter((b) => !/ver todas/.test(texto(b))).length, 0, 'no action button on the board');
    assert.doesNotMatch(texto(board), OUT_OF_SCOPE);
  });

  test('#465/AC-2 an empty column says Nenhuma; Na fila without the queue shows its empty state and no limit line', () => {
    const columns = PAYLOAD_COLUMNS.map((c) => (c.id === 'queued' || c.id === 'review' ? { ...c, count: 0, cards: [] } : c));
    const board = boardColumns({ columns, level: 'item', primaryRepo: REPO, now: NOW, queueAvailable: false, doneWindowDays: 14 });
    const queued = board.querySelector('[data-column="queued"]')!;
    assert.match(texto(queued.querySelector('.wb-none')), /^Nenhuma/);
    assert.equal(queued.getAttribute('data-queue'), 'off');
    assert.doesNotMatch(texto(queued), /rodando/);
    assert.equal(texto(board.querySelector('[data-column="review"] .wb-none')), 'Nenhuma');
  });

  test('#465/AC-2 Concluído shows the 14-day window: two at sight and "ver todas" opens the rest', () => {
    const board = boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', primaryRepo: REPO, now: NOW, queueAvailable: true, doneWindowDays: 14 });
    const done = board.querySelector('[data-column="done"]')!;
    const items = done.querySelectorAll('li');
    assert.deepEqual(items.map((i) => i.hidden), [false, false, true]);
    const more = buttonNamed(done, /ver todas/)!;
    assert.equal(texto(more), '+ 1 fechada nos últimos 14 dias · ver todas');
    assert.equal(more.hasAttribute('aria-expanded'), false);
    more.click();
    assert.deepEqual(items.map((i) => i.hidden), [false, false, false]);
    assert.equal(documentoFalso.activeElement, items[2]!.querySelector('a'), 'focus moves to the first revealed card');
    assert.equal(done.querySelector('.wb-done-more'), null);
    const few = boardColumns({ columns: PAYLOAD_COLUMNS.map((c) => (c.id === 'done' ? { ...c, count: 2, cards: c.cards.slice(0, 2) } : c)), level: 'item', now: NOW, queueAvailable: true, doneWindowDays: 14 });
    assert.equal(texto(few.querySelector('[data-column="done"] .wb-window')), 'Fechadas nos últimos 14 dias');
  });
});

describe('#466/AC-4 the item shows its parent chain', () => {
  test('#466/AC-4 compact "↑ #6" by default, the whole chain "#1 › #6 › #500" when a filter is on', () => {
    const c = card(500, { column: 'running' });
    assert.equal(chainText(c, 'compact'), '↑ #6');
    assert.equal(chainText(c, 'full'), '#1 › #6 › #500');
    assert.equal(chainText(card(2, { parent: null, chain: [] }), 'full'), null);
    const full = workCard(c, { chainMode: 'full', now: NOW });
    assert.equal(texto(full.querySelector('.wb-chain')), '#1 › #6 › #500');
    assert.equal(texto(full.querySelector('.wb-chain b')), '#500');
    const board = boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', chainMode: 'full', now: NOW, queueAvailable: true, doneWindowDays: 14 });
    assert.ok(board.querySelectorAll('.wb-chain').every((n) => texto(n).startsWith('#1 › #6 › ')));
  });
});

describe('#466/AC-2 the epic and initiative card (466-1)', () => {
  const epic = card(6, {
    level: 'epic',
    type: 'epic',
    typeName: 'Epic',
    column: 'blocked',
    parent: { key: INITIATIVE.key, number: 1 },
    chain: [INITIATIVE],
    blocked: blocked('needs-you'),
    columnSince: ago(12 * MIN),
    children: { total: 7, done: 1, byColumn: { planning: 2, running: 1, blocked: 3, done: 1 }, blocked: { 'needs-you': 1, 'ci-failed': 2 } },
  });

  test('#466/AC-2 children closed, per column and blocked, "Ver filhos ›" calls back; no action', () => {
    const drilled: unknown[] = [];
    const node = parentCard(epic, { now: NOW, onDrill: (c: unknown) => drilled.push(c) });
    assert.ok(node.classList.contains('wb-parent-card'));
    assert.equal(texto(node.querySelector('.wb-type')), 'Épico');
    assert.equal(texto(node.querySelector('.wb-number')), '#6');
    assert.equal(texto(node.querySelector('.wb-chain')), '↑ #1');
    assert.match(texto(node.querySelector('.wb-progress')), /1\/7 filhas concluídas/);
    const bar = node.querySelector('[role="progressbar"]')!;
    assert.deepEqual([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')], ['1', '7']);
    assert.deepEqual(node.querySelectorAll('.wb-dist li').map((li) => li.getAttribute('aria-label')), ['Planejamento: 2', 'Em execução: 1', 'Bloqueado: 3', 'Concluído: 1']);
    assert.equal(texto(node.querySelector('.wb-reason')), '3 filhas bloqueadas · 1 precisa de você · 2 CI falhou');
    const drill = buttonNamed(node, /Ver filhos/)!;
    assert.equal(texto(drill), 'Ver filhos (7)');
    assert.equal(drill.getAttribute('aria-label'), 'Ver filhos (7) de #6');
    drill.click();
    assert.deepEqual(drilled, [epic]);
    assert.equal(buttons(node).length, 1, 'only Ver filhos');
    assert.doesNotMatch(texto(node), OUT_OF_SCOPE);
  });

  test('#466/AC-2 at the epic and initiative levels the columns draw parent cards; Ver filhos reaches onDrill', () => {
    const drilled: unknown[] = [];
    const columns = COLUMNS.map((c: { id: string }) => ({ ...c, count: c.id === 'blocked' ? 1 : 0, cards: c.id === 'blocked' ? [epic] : [] }));
    const board = boardColumns({ columns, level: 'epic', now: NOW, queueAvailable: true, doneWindowDays: 14, onDrill: (c: unknown) => drilled.push(c) });
    assert.equal(board.querySelectorAll('.wb-parent-card').length, 1);
    buttonNamed(board, /Ver filhos/)!.click();
    assert.equal(drilled.length, 1);
  });
});

describe('#465/AC-4 GitHub down (465-4, ADR-0001)', () => {
  test('#465/AC-4 the stale band: reason, when the board is from, Tentar agora calls back', () => {
    let retried = 0;
    const band = staleBand({ fetchedAt: NOW - 31 * MIN, now: NOW, reason: 'network', onRetry: () => retried++ });
    assert.equal(band.getAttribute('role'), 'status');
    assert.match(texto(band), /^GitHub indisponível\. Mostrando o quadro de 22:41 \(há 31 min\)\. As sessões e a fila continuam ao vivo\. Motivo: falha de rede ao falar com o GitHub\./);
    buttonNamed(band, /Tentar agora/)!.click();
    assert.equal(retried, 1);
    const busy = staleBand({ fetchedAt: NOW - MIN, now: NOW, reason: null, busy: true, onRetry: () => {} });
    assert.doesNotMatch(texto(busy), /Motivo/);
    assert.equal(buttonNamed(busy, /Tentar agora/)!.getAttribute('aria-busy'), 'true');
  });

  test('#496/AC-2 the stale band says when it tries again, between the board time and the live note', () => {
    const band = staleBand({ fetchedAt: NOW - 31 * MIN, now: NOW, retryAt: NOW + 2 * MIN });
    assert.match(texto(band), /^GitHub indisponível\. Mostrando o quadro de 22:41 \(há 31 min\)\. Tentamos de novo em 2 min\. As sessões e a fila continuam ao vivo\./);
    const withReason = texto(staleBand({ fetchedAt: NOW - 31 * MIN, now: NOW, reason: 'network', retryAt: NOW + 2 * MIN }));
    assert.match(withReason, /Tentamos de novo em 2 min\. As sessões e a fila continuam ao vivo\. Motivo: falha de rede/);
  });

  test('#496/AC-2 without a retry time the band has no "Tentamos de novo" line', () => {
    for (const retryAt of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
      assert.doesNotMatch(texto(staleBand({ fetchedAt: NOW - MIN, now: NOW, retryAt })), /Tentamos de novo/);
    }
  });

  test('#496/AC-2 overdue or under one minute shows 1 min, never zero or negative', () => {
    for (const retryAt of [NOW + 10_000, NOW, NOW - 5 * MIN]) {
      assert.match(texto(staleBand({ fetchedAt: NOW - MIN, now: NOW, retryAt })), /Tentamos de novo em 1 min\./);
    }
  });

  test('#496/AC-2 the wait rounds to whole minutes', () => {
    assert.match(texto(staleBand({ fetchedAt: NOW - MIN, now: NOW, retryAt: NOW + 2 * MIN + 20_000 })), /em 2 min\./);
    assert.match(texto(staleBand({ fetchedAt: NOW - MIN, now: NOW, retryAt: NOW + 2 * MIN + 40_000 })), /em 3 min\./);
  });

  test('#465/AC-4 the stale board fades what comes from GitHub (Status, PR, CI, review); sessions and queue stay live', () => {
    const board = boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', primaryRepo: REPO, now: NOW, queueAvailable: true, doneWindowDays: 14, stale: true });
    assert.ok(board.classList.contains('wb-board-stale'));
    for (const sel of ['.wb-status', '.wb-pr', '.wb-ci', '.wb-review', '.wb-plan']) assert.ok(board.querySelectorAll(sel).every((n) => n.classList.contains('wb-gh')), sel);
    for (const sel of ['.wb-session', '.wb-queue-pos']) assert.ok(board.querySelectorAll(sel).every((n) => !n.classList.contains('wb-gh')), sel);
    const css = readFileSync(`${UI_FOLDER}work-board.css`, 'utf8');
    assert.match(css, /\.wb-board-stale \.wb-gh\s*\{[^}]*opacity/);
  });

  test('#465/AC-4 the first read failed with nothing stored: an alert with the reason and Tentar agora; the columns show "–"', () => {
    let retried = 0;
    const node = firstReadFailure({ reason: 'github-error', onRetry: () => retried++ });
    assert.equal(node.getAttribute('role'), 'alert');
    assert.equal(texto(node.querySelector('h2')), 'Ainda não conseguimos ler o GitHub');
    assert.match(texto(node), /A primeira leitura falhou \(o GitHub respondeu com erro\) e não há quadro guardado para mostrar\./);
    buttonNamed(node, /Tentar agora/)!.click();
    assert.equal(retried, 1);
    const board = boardColumns({ mode: 'blank', counts: '–', now: NOW });
    assert.deepEqual(board.querySelectorAll('.wb-count').map(texto), ['–', '–', '–', '–', '–', '–']);
    assert.equal(board.querySelectorAll('.wb-none').length, 0);
  });

  test('#465/AC-4 an error message written elsewhere shows as an alert band with its retry', () => {
    let retried = 0;
    const band = workBoardError({ title: 'O GitHub não está conectado.', text: 'Conecte em Conexões.', onRetry: () => retried++ });
    assert.equal(band.getAttribute('role'), 'alert');
    assert.equal(texto(band.querySelector('b')), 'O GitHub não está conectado.');
    assert.match(texto(band), /Conecte em Conexões\./);
    buttonNamed(band, /Tentar de novo/)!.click();
    assert.equal(retried, 1);
    assert.equal(buttons(workBoardError({ title: 'Sem Project.' })).length, 0);
  });
});

describe('#465/AC-2 the empty project (465-3) and the loading board (465-5)', () => {
  test('#465/AC-2 empty project: what the board would show, the Project on GitHub and switching the Project; six columns at zero, filters off', () => {
    const node = emptyProject({ project: { title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3' } });
    assert.equal(texto(node.querySelector('h2')), 'Nenhuma issue neste projeto ainda');
    assert.match(texto(node), /O GitHub Project “Ahrena Console” não tem nenhuma issue\. Quando tiver, cada uma entra em Planejamento/);
    const links = node.querySelectorAll('a');
    assert.deepEqual(links.map(texto), ['Abrir o Project no GitHub', 'Trocar de Project']);
    assert.equal(links[0]!.getAttribute('href'), 'https://github.com/orgs/ahrenatechnology/projects/3');
    assert.equal(links[1]!.getAttribute('href'), SWITCH_PROJECT_HREF);
    assert.equal(SWITCH_PROJECT_HREF, '/ui/project');
    const board = boardColumns({ mode: 'blank', counts: '0', now: NOW });
    assert.deepEqual(board.querySelectorAll('.wb-count').map(texto), ['0', '0', '0', '0', '0', '0']);
    assert.equal(board.querySelectorAll('.wb-none').length, 0, 'no Nenhuma per column: the empty state above explains');
  });

  test('#465/AC-2 loading: six columns of skeleton cards, counts "…", busy for assistive tech', () => {
    const board = boardColumns({ mode: 'skeleton', counts: '…', now: NOW });
    assert.equal(board.getAttribute('aria-busy'), 'true');
    assert.deepEqual(board.querySelectorAll('section.wb-col').map((c) => c.querySelectorAll('.wb-skeleton').length), [3, 1, 2, 2, 2, 2]);
    assert.deepEqual(board.querySelectorAll('.wb-count').map(texto), ['…', '…', '…', '…', '…', '…']);
    assert.equal(texto(board.querySelector('h2 .wb-sr-only')), ': carregando');
    assert.ok(board.querySelectorAll('.wb-skeleton').every((s) => s.getAttribute('aria-hidden') === 'true'));
  });
});

describe('#466/AC-3 the filter with no result (466-3)', () => {
  test('#466/AC-3 the line, the suggestion given as data and Limpar filtros', () => {
    const changes: [string, unknown][] = [];
    let cleared = 0;
    const filters = { ...NO_FILTERS, label: 'design-system' };
    const node = noResult({ suggestion: { param: 'label', count: 2 }, filters, options: OPTIONS, onClear: () => cleared++, onFilterChange: (p: string, v: unknown) => changes.push([p, v]) });
    assert.equal(node.getAttribute('role'), 'status');
    assert.equal(texto(node.querySelector('h2')), 'Nenhuma issue com estes filtros.');
    assert.match(texto(node), /Os seis filtros valem juntos\. Sem a label design-system, há 2 issues neste recorte\./);
    buttonNamed(node, /Limpar filtros/)!.click();
    buttonNamed(node, /Tirar a label/)!.click();
    assert.deepEqual([cleared, changes], [1, [['label', null]]]);
    const plain = noResult({ suggestion: null, filters, options: OPTIONS, onClear: () => {}, onFilterChange: () => {} });
    assert.deepEqual(buttons(plain).map(texto), ['Limpar filtros']);
    assert.match(texto(noResult({ suggestion: { param: 'epic', count: 1 }, filters: { ...NO_FILTERS, epic: 6 }, options: OPTIONS, onClear: () => {} })), /Sem o épico #6, há 1 issue neste recorte\./);
  });

  test('#466/AC-3 the columns stay with their names and zero, without Nenhuma', () => {
    const board = boardColumns({ mode: 'blank', counts: '0', now: NOW });
    assert.equal(board.querySelectorAll('section.wb-col').length, 6);
    assert.deepEqual(board.querySelectorAll('.wb-col-name').map(texto), ['Planejamento', 'Na fila', 'Em execução', 'Em review', 'Bloqueado', 'Concluído']);
  });
});

describe('#465/AC-5 English internals, pt-BR on screen (ADR-0009)', () => {
  const PORTUGUESE = /[à-ú]|coluna|fila|bloquead|conclu|planej|filtro|nivel|cartao|card[oa]s?-|projeto|sessao|sessoes|quadro|filh|caminho|motivo|rotulo|cabecalho|vazio|carregando|erro\b|limpar|copiar|atualizar|repositorio|etiqueta|tipo\b|iniciativa|epico|plano\b|passos?\b/i;

  test('#465/AC-5 every class token and every data-* name and value the components render is English; the copy is pt-BR', () => {
    const filters = { ...NO_FILTERS, initiative: 1, epic: 6, type: 'bug', label: 'ui', repo: REPO, status: 'in-progress' };
    const project = { owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3', primaryRepo: REPO };
    const epic = card(6, { level: 'epic', type: 'epic', column: 'blocked', blocked: blocked('needs-you'), children: { total: 2, done: 1, byColumn: { blocked: 1, done: 1 }, blocked: { 'needs-you': 1 } } });
    const roots = [
      workBoardHeader({ project, fetchedAt: NOW - MIN, now: NOW, stale: true, busy: true, onRefresh: () => {} }),
      levelSwitch({ levels: [...WORK_LEVELS], level: 'item', path: boardPath(filters, OPTIONS), onLevelChange: () => {}, onPathSelect: () => {} }),
      filterBar({ filters, options: OPTIONS, link: '/ui/work?level=item', onFilterChange: () => {}, onClear: () => {}, onCopyLink: () => {} }),
      boardColumns({ columns: PAYLOAD_COLUMNS, level: 'item', chainMode: 'full', primaryRepo: REPO, now: NOW, queueAvailable: false, doneWindowDays: 14, stale: true }),
      boardColumns({ mode: 'skeleton', counts: '…', now: NOW }),
      parentCard(epic, { now: NOW, onDrill: () => {} }),
      staleBand({ fetchedAt: NOW - MIN, now: NOW, reason: 'x', onRetry: () => {} }),
      firstReadFailure({ reason: 'x', onRetry: () => {} }),
      emptyProject({ project }),
      noResult({ suggestion: { param: 'label', count: 2 }, filters, options: OPTIONS, onClear: () => {}, onFilterChange: () => {} }),
      workBoardError({ title: 'Falhou.', onRetry: () => {} }),
    ];
    const classes = new Set<string>();
    const data = new Set<string>();
    for (const root of roots) {
      for (const node of [root, ...root.querySelectorAll('*')]) {
        for (const c of (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) classes.add(c);
        for (const [name, value] of node.atributos) {
          if (!name.startsWith('data-')) continue;
          data.add(name);
          if (name !== 'data-key') data.add(value);
        }
      }
    }
    const wb = [...classes].filter((c) => c.startsWith('wb-'));
    assert.ok(wb.length > 40, 'the walk saw the board');
    for (const name of [...wb, ...data].filter(Boolean)) {
      assert.match(name, /^[a-z0-9-]+$/, `${name} is not a plain English token`);
      assert.doesNotMatch(name, PORTUGUESE, `${name} reads Portuguese`);
    }
    assert.ok(data.has('data-column') && data.has('data-param') && data.has('data-level') && data.has('data-queue'));
    const copy = roots.map(texto).join(' ');
    for (const words of ['Quadro do trabalho', 'Atualizar', 'Nível', 'Iniciativa', 'Limpar filtros', 'Copiar link', 'Planejamento', 'Na fila', 'Em execução', 'Em review', 'Bloqueado', 'Concluído', 'Ver filhos', 'Tentar agora', 'Trocar de Project', 'Nenhuma issue com estes filtros.']) {
      assert.ok(copy.includes(words), `the screen says "${words}"`);
    }
  });
});

// #610 (598-1 to 598-4): the components of the work board over every organization, in the fake DOM.
const proj = (owner: string, number: number, title: string) => ({ owner, number, title });
const PLATFORM = proj('acme-labs', 3, 'Plataforma');
const MOBILE = proj('acme-labs', 4, 'Mobile');
const ROADMAP = proj('northwind', 1, 'Roadmap');
const SUPPORT = proj('northwind', 2, 'Suporte');
const EXPERIMENTS = proj('mira-dev', 1, 'Experimentos');
const org = (login: string, projects: ReturnType<typeof proj>[], over: Card = {}) => ({ login, own: false, state: 'read', readAt: NOW - 40_000, projects, ...over });
const warned = (login: string, state: string, over: Card = {}) => org(login, [], { state, readAt: null, ...over });
const ORGS = [org('acme-labs', [PLATFORM, MOBILE]), org('northwind', [ROADMAP, SUPPORT]), org('mira-dev', [EXPERIMENTS], { own: true })];
const ORG_OPTIONS = {
  ...OPTIONS,
  orgs: [{ login: 'acme-labs', own: false, count: 2 }, { login: 'northwind', own: false, count: 2 }, { login: 'mira-dev', own: true, count: 1 }],
  projects: [...[PLATFORM, MOBILE, ROADMAP, SUPPORT, EXPERIMENTS].map((p) => ({ ...p, count: 1 }))],
};
const from = (owner: string, project: ReturnType<typeof proj>) => ({ organization: owner, project });
const originCard = (n: number, owner: string, project: ReturnType<typeof proj>, over: Card = {}) => card(n, { repo: `${owner}/app`, parent: null, chain: [], origin: from(owner, project), ...over });
const ORIGIN_COLUMNS = [
  { id: 'planning', label: 'Planejamento', criterion: '', count: 4, cards: [originCard(509, 'acme-labs', PLATFORM), originCard(499, 'acme-labs', MOBILE), originCard(503, 'northwind', ROADMAP), originCard(511, 'mira-dev', EXPERIMENTS, { repo: 'mira-dev/other' })] },
];
const WARNING_ORGS = (kinds: [string, string][]) => kinds.map(([login, state]) => warned(login, state));
const FIVE = WARNING_ORGS([['globex', 'restricted'], ['initech', 'failed'], ['umbrella-corp', 'saml'], ['hooli', 'failed'], ['pied-piper', 'failed']]);

describe('#610/AC-1 the header counts organizations and Projects (598-1)', () => {
  test('#610/AC-1 several origins: "3 organizações · 5 Projects", the names with the account as "(você)"', () => {
    const head = workBoardHeader({ organizations: ORGS, fetchedAt: NOW - 40_000, now: NOW });
    assert.match(texto(head.querySelector('.wb-orgs-count')), /^3 organizações · 5 Projects$/);
    assert.match(texto(head), /acme-labs, northwind e mira-dev \(você\)/);
    assert.match(texto(head), /a coluna vem dos sinais; só a fila é sua/);
    assert.doesNotMatch(texto(head), /GitHub Project “/);
  });

  test('#610/AC-1 one organization and one Project: today\'s header names them, nothing counts', () => {
    const named = workBoardHeader({ organizations: [org('acme-labs', [PLATFORM])], fetchedAt: NOW, now: NOW });
    assert.match(texto(named), /acme-labs · GitHub Project “Plataforma” · a coluna vem dos sinais/);
    assert.equal(named.querySelector('.wb-orgs-count'), null);
    const today = workBoardHeader({ project: { owner: 'acme-labs', number: 3, title: 'Plataforma', primaryRepo: 'acme-labs/app' }, fetchedAt: NOW, now: NOW });
    assert.match(texto(today), /acme-labs\/app · GitHub Project “Plataforma” · a coluna vem dos sinais/);
  });

  test('#610/AC-1 the count leaves out an organization with a warning and marks "N com aviso"', () => {
    const head = workBoardHeader({ organizations: [...ORGS, ...WARNING_ORGS([['globex', 'restricted'], ['initech', 'failed']])], fetchedAt: NOW, now: NOW });
    assert.match(texto(head.querySelector('.wb-orgs-count')), /^3 organizações · 5 Projects$/);
    assert.match(texto(head.querySelector('.wb-warn-count')), /^2 com aviso$/);
    assert.doesNotMatch(texto(head), /globex/);
  });

  test('#610/AC-1 an organization read before that fails now stays in the count and the names, and is also "1 com aviso"', () => {
    const stale = org('northwind', [ROADMAP, SUPPORT], { state: 'failed', readAt: NOW - 31 * MIN });
    const head = workBoardHeader({ organizations: [ORGS[0], stale, ORGS[2]], fetchedAt: NOW, now: NOW });
    assert.match(texto(head.querySelector('.wb-orgs-count')), /^3 organizações · 5 Projects$/);
    assert.match(texto(head), /acme-labs, northwind e mira-dev \(você\)/);
    assert.match(texto(head.querySelector('.wb-warn-count')), /^1 com aviso$/);
  });

  test('#610/AC-1 singular and zero: "1 organização · 2 Projects", and "0 organizações · 0 Projects" with no Project', () => {
    const one = workBoardHeader({ organizations: [org('acme-labs', [PLATFORM, MOBILE])], now: NOW });
    assert.match(texto(one.querySelector('.wb-orgs-count')), /^1 organização · 2 Projects$/);
    const none = workBoardHeader({ organizations: [org('acme-labs', [])], now: NOW });
    assert.match(texto(none.querySelector('.wb-orgs-count')), /^0 organizações · 0 Projects$/);
  });

  test('#610/AC-1 loading shows "… organizações · … Projects"; GitHub down still counts every organization; all with a warning says none was read', () => {
    const loading = workBoardHeader({ organizations: null, loading: true, reading: true, now: NOW, busy: true });
    assert.match(texto(loading.querySelector('.wb-orgs-count')), /^… organizações · … Projects$/);
    const down = workBoardHeader({ organizations: ORGS.map((o) => ({ ...o, state: 'failed' })), githubDown: true, stale: true, fetchedAt: NOW - 31 * MIN, now: NOW });
    assert.match(texto(down.querySelector('.wb-orgs-count')), /^3 organizações · 5 Projects$/);
    assert.equal(down.querySelector('.wb-warn-count'), null);
    const all = workBoardHeader({ organizations: WARNING_ORGS([['globex', 'restricted'], ['initech', 'failed'], ['umbrella-corp', 'saml']]), now: NOW });
    assert.match(texto(all.querySelector('.wb-orgs-count')), /^Nenhuma organização lida$/);
    assert.match(texto(all.querySelector('.wb-warn-count')), /^3 com aviso$/);
  });
});

describe('#610/AC-1 the card says where it comes from (598-1)', () => {
  const origin = (n: number) => workCard(originCard(n, 'acme-labs', PLATFORM), { showOrigin: true, now: NOW });

  test('#610/AC-1 the origin line is "organização · Project" and is left out without showOrigin', () => {
    const withLine = origin(509);
    assert.match(texto(withLine.querySelector('.wb-origin')), /^acme-labs · Plataforma$/);
    assert.equal(workCardWithout().querySelector('.wb-origin'), null);
    function workCardWithout() {
      return workCard(originCard(509, 'acme-labs', PLATFORM), { now: NOW });
    }
    assert.ok(withLine.querySelector('.wb-origin')!.getAttribute('title'), 'the line carries a title');
  });

  test('#610/AC-1 the repository shows only on a card of another repository than its organization\'s usual one', () => {
    const board = boardColumns({ columns: ORIGIN_COLUMNS.map((c) => ({ ...c, cards: [...c.cards, originCard(500, 'acme-labs', PLATFORM)] })), showOrigin: true, now: NOW });
    const byNumber = (n: number) => board.querySelectorAll('article.wb-card').find((c) => texto(c).includes(`#${n}`))!;
    assert.equal(byNumber(509).querySelector('.wb-repo'), null, 'acme-labs/app is acme-labs\' usual repository');
    assert.ok(byNumber(503).querySelector('.wb-repo'), 'an organization with a single card has no usual repository: its repository shows');
    assert.ok(byNumber(511).querySelector('.wb-repo'), 'mira-dev/other is the only one of mira-dev');
    assert.match(texto(byNumber(511).querySelector('.wb-origin')), /^mira-dev · Experimentos$/);
  });

  test('#610/AC-1 usualRepos: the repository holding most of an organization\'s cards, only past one card; a tie goes to the first by name', () => {
    const columns = [{ id: 'planning', cards: [originCard(1, 'acme-labs', PLATFORM, { repo: 'acme-labs/b' }), originCard(2, 'acme-labs', PLATFORM, { repo: 'acme-labs/a' }), originCard(3, 'acme-labs', PLATFORM, { repo: 'acme-labs/b' }), originCard(4, 'northwind', ROADMAP), originCard(5, 'tie', ROADMAP, { repo: 'tie/z' }), originCard(6, 'tie', ROADMAP, { repo: 'tie/y' })] }];
    assert.deepEqual(usualRepos(columns), { 'acme-labs': 'acme-labs/b', tie: 'tie/y' });
  });

  test('#610/AC-1 with a chosen Project the board\'s main repository stays the rule', () => {
    const node = workCard(originCard(509, 'acme-labs', PLATFORM, { repo: 'acme-labs/other' }), { showOrigin: true, primaryRepo: 'acme-labs/app', now: NOW });
    assert.ok(node.querySelector('.wb-repo'));
    const same = workCard(originCard(509, 'acme-labs', PLATFORM), { showOrigin: true, primaryRepo: 'acme-labs/app', now: NOW });
    assert.equal(same.querySelector('.wb-repo'), null);
  });

  test('#610/AC-3 a card of an organization that failed now is dimmed; the others are not', () => {
    const board = boardColumns({ columns: ORIGIN_COLUMNS, showOrigin: true, staleOrgs: ['northwind'], now: NOW });
    const cards = board.querySelectorAll('article.wb-card');
    assert.deepEqual(cards.filter((c) => c.classList.contains('wb-org-stale')).map((c) => /#(\d+)/.exec(texto(c))![1]), ['503']);
  });
});

describe('#610/AC-2 the Organização and Project filters (598-2)', () => {
  const bar = (over: Card = {}) => filterBar({ filters: { ...NO_FILTERS, org: null, project: null }, options: ORG_OPTIONS, organizations: ORGS, origin: true, ...over });
  const select = (root: ElementoFalso, param: string) => root.querySelector(`select[data-param="${param}"]`)!;

  test('#610/AC-2 both selects come before the six, "Todas" and "Todos", labelled, with the account as "(você)"', () => {
    const root = bar();
    const selects = root.querySelectorAll('select');
    assert.deepEqual(selects.map((s) => s.getAttribute('data-param')), ['org', 'project', 'initiative', 'epic', 'type', 'label', 'repo', 'status']);
    assert.deepEqual(root.querySelectorAll('.wb-field-label').slice(0, 2).map(texto), ['Organização', 'Project']);
    assert.equal(texto(select(root, 'org').querySelector('option')), 'Todas');
    assert.equal(texto(select(root, 'project').querySelector('option')), 'Todos');
    assert.deepEqual(select(root, 'org').querySelectorAll('option').map((o) => o.getAttribute('value')), ['', 'acme-labs', 'northwind', 'mira-dev']);
    assert.match(texto(select(root, 'org')), /mira-dev \(você\) \(1\)/);
    for (const s of selects) assert.equal(s.closest('label')?.tagName, 'LABEL', 'every select sits in its label');
    assert.ok(root.querySelector('.wb-fields')!.classList.contains('wb-fields-origin'));
  });

  test('#610/AC-2 without origin the bar is the six filters of today', () => {
    const root = filterBar({ filters: NO_FILTERS, options: OPTIONS });
    assert.equal(select(root, 'org'), null);
    assert.equal(select(root, 'project'), null);
    assert.equal(root.querySelectorAll('select').length, 6);
    assert.ok(!root.querySelector('.wb-fields')!.classList.contains('wb-fields-origin'));
  });

  test('#610/AC-2 with Todas the Projects are grouped by organization, the value is owner/number; with an organization only its Projects', () => {
    const all = select(bar(), 'project');
    const groups = all.querySelectorAll('optgroup');
    assert.deepEqual(groups.map((g) => g.getAttribute('label')), ['acme-labs', 'northwind', 'mira-dev (você)']);
    assert.deepEqual(all.querySelectorAll('option').map((o) => o.getAttribute('value')), ['', 'acme-labs/3', 'acme-labs/4', 'northwind/1', 'northwind/2', 'mira-dev/1']);
    const narrow = select(bar({ filters: { ...NO_FILTERS, org: 'acme-labs', project: null } }), 'project');
    assert.deepEqual(narrow.querySelectorAll('option').map((o) => o.getAttribute('value')), ['', 'acme-labs/3', 'acme-labs/4']);
    assert.doesNotMatch(texto(narrow), /Roadmap/);
  });

  test('#610/AC-2 an organization with a warning and no card is not an option; one that keeps its cards is', () => {
    const root = bar({ organizations: [...ORGS, warned('globex', 'restricted')], options: { ...ORG_OPTIONS, orgs: [...ORG_OPTIONS.orgs, { login: 'globex', own: false, count: 0 }] } });
    assert.doesNotMatch(texto(select(root, 'org')), /globex/);
    const stale = org('northwind', [ROADMAP, SUPPORT], { state: 'failed' });
    const kept = bar({ organizations: [ORGS[0], stale, ORGS[2]] });
    assert.match(texto(select(kept, 'org')), /northwind/);
  });

  test('#610/AC-2 a change calls back with the English param and the value, "Todas" with null', () => {
    const changes: [string, unknown][] = [];
    const root = bar({ onFilterChange: (p: string, v: unknown) => changes.push([p, v]) });
    for (const [param, value] of [['org', 'acme-labs'], ['project', 'acme-labs/3'], ['org', '']] as const) {
      select(root, param).value = value;
      select(root, param).dispatchEvent({ type: 'change' });
    }
    assert.deepEqual(changes, [['org', 'acme-labs'], ['project', 'acme-labs/3'], ['org', null]]);
  });

  test('#610/AC-2 the chips of org and Project come first, with the name and the title, each with a named ×', () => {
    const changes: [string, unknown][] = [];
    const filters = { ...NO_FILTERS, org: 'acme-labs', project: 'acme-labs/3', type: 'story' };
    const root = bar({ filters, link: '/ui/work?org=acme-labs&project=acme-labs/3&level=item&type=story', onFilterChange: (p: string, v: unknown) => changes.push([p, v]) });
    const chips = root.querySelectorAll('.wb-chip');
    assert.deepEqual(chips.map(texto), ['Organização: acme-labs', 'Project: Plataforma', 'Tipo: História']);
    assert.deepEqual(chips.map((c) => c.getAttribute('data-param')), ['org', 'project', 'type']);
    assert.equal(chips[1]!.querySelector('button')!.getAttribute('aria-label'), 'Tirar o filtro Project');
    chips[0]!.querySelector('button')!.dispatchEvent({ type: 'click' });
    assert.deepEqual(changes, [['org', null]]);
    assert.equal(select(root, 'org').value, 'acme-labs');
    assert.equal(select(root, 'project').value, 'acme-labs/3');
    assert.deepEqual(filterChips({ org: 'mira-dev', project: 'mira-dev/9' }, ORG_OPTIONS).map((c: { value: string }) => c.value), ['mira-dev (você)', 'mira-dev/9']);
  });

  test('#610/AC-2 a Project of a read that is no longer an option stays selected, with its value', () => {
    const root = bar({ filters: { ...NO_FILTERS, org: null, project: 'acme-labs/9' } });
    assert.equal(select(root, 'project').value, 'acme-labs/9');
  });

  test('#610/AC-2 loading turns every select off', () => {
    const root = bar({ disabled: true });
    assert.ok(root.querySelectorAll('select').every((s) => s.hasAttribute('disabled')));
    assert.ok(root.classList.contains('wb-off'));
  });

  test('#610/AC-2 the reset note says which Project went back to Todos and why, as a status', () => {
    const note = projectResetNote({ project: { owner: 'acme-labs', number: 3, title: 'Plataforma' }, to: 'northwind' });
    assert.equal(texto(note), 'O Project “Plataforma” é de acme-labs, não de northwind: voltou para Todos.');
    assert.equal(note.getAttribute('role'), 'status');
    assert.ok(note.classList.contains('wb-reset-note'));
  });
});

describe('#610/AC-3 the organization warnings (598-3)', () => {
  const bands = (organizations: unknown[], over: Card = {}) => orgWarnings({ organizations, now: NOW, ...over });
  const names = (root: ElementoFalso | null) => root!.querySelectorAll('button').map(texto);

  test('#610/AC-3 restricted: yellow band with Aprovar (dono) and Pedir acesso that call back with the organization', () => {
    const actions: [string, string][] = [];
    const root = bands([...ORGS, warned('globex', 'restricted', { approvalUrl: 'x', requestUrl: 'y' })], { onAction: (k: string, o: { login: string }) => actions.push([k, o.login]) });
    const band = root!.querySelector('.wb-warn-band')!;
    assert.match(texto(band), /globex restringe apps OAuth/);
    assert.deepEqual(names(band), ['Aprovar (dono)', 'Pedir acesso']);
    assert.ok(band.classList.contains('wb-warn-restricted') && band.classList.contains('wb-warn-attn'));
    assert.equal(band.getAttribute('role'), 'status');
    for (const b of band.querySelectorAll('button')) b.dispatchEvent({ type: 'click' });
    assert.deepEqual(actions, [['approve', 'globex'], ['request', 'globex']]);
  });

  test('#610/AC-3 SSO: says so and offers Entrar pelo SSO', () => {
    const actions: string[] = [];
    const root = bands([warned('umbrella-corp', 'saml')], { onAction: (k: string) => actions.push(k) });
    assert.match(texto(root), /umbrella-corp exige login pelo SSO/);
    assert.deepEqual(names(root), ['Entrar pelo SSO']);
    root!.querySelector('button')!.dispatchEvent({ type: 'click' });
    assert.deepEqual(actions, ['sso']);
  });

  test('#610/AC-3 failed with nothing stored: red band as an alert, the reason in pt-BR, Tentar de novo', () => {
    const actions: string[] = [];
    const root = bands([warned('initech', 'failed', { reason: 'rate-limited' })], { onAction: (k: string) => actions.push(k) });
    const band = root!.querySelector('.wb-warn-band')!;
    assert.match(texto(band), /Não conseguimos ler os Projects de initech.*nada guardado/i);
    assert.match(texto(band), /Motivo: o GitHub limitou as chamadas/);
    assert.ok(band.classList.contains('wb-warn-fail'));
    assert.equal(band.getAttribute('role'), 'alert');
    assert.deepEqual(names(band), ['Tentar de novo']);
    band.querySelector('button')!.dispatchEvent({ type: 'click' });
    assert.deepEqual(actions, ['retry']);
    assert.doesNotMatch(texto(band), /rate-limited/, 'the raw code never shows');
  });

  test('#610/AC-3 an organization read before that fails now: "agora", the read time, the cards dimmed', () => {
    const at = NOW - 31 * MIN;
    const stale = org('northwind', [ROADMAP, SUPPORT], { state: 'failed', readAt: at });
    const root = bands([stale]);
    const text = texto(root);
    assert.match(text, /Não conseguimos ler os Projects de northwind agora/);
    assert.ok(text.includes(`última leitura dela, às ${formatClock(at)} (há 31 min), com os cards esmaecidos`));
    assert.deepEqual(names(root), ['Tentar de novo']);
    assert.deepEqual(staleOrganizations([ORGS[0], stale, warned('initech', 'failed')]), ['northwind']);
  });

  test('#610/AC-3 busy turns the retry off and marks it busy', () => {
    const root = bands([warned('initech', 'failed')], { busy: true });
    const retry = root!.querySelector('button')!;
    assert.ok(retry.hasAttribute('disabled'));
    assert.equal(retry.getAttribute('aria-busy'), 'true');
  });

  test('#610/AC-3 more than three: three bands, then "Mais N organizações com aviso"', () => {
    const root = bands([...ORGS, ...FIVE]);
    assert.ok(root!.classList.contains('wb-warns'));
    assert.equal(root!.children.filter((c) => c.classList.contains('wb-warn-band')).length, 3);
    assert.deepEqual(root!.querySelectorAll('.wb-warn-band').map((b) => /(globex|initech|umbrella-corp)/.exec(texto(b))![1]), ['globex', 'initech', 'umbrella-corp']);
    assert.equal(texto(root!.querySelector('.wb-warns-more')), 'Mais 2 organizações com aviso');
    assert.equal(bands([...ORGS, ...FIVE.slice(0, 3)])!.querySelector('.wb-warns-more'), null, 'exactly three show no "Mais"');
    assert.equal(texto(bands([...ORGS, ...FIVE.slice(0, 4)])!.querySelector('.wb-warns-more')), 'Mais 1 organização com aviso');
  });

  test('#610/AC-3 "Mais N" is a button that asks to expand, collapsed it is not pressed', () => {
    const asked: unknown[][] = [];
    const root = bands([...ORGS, ...FIVE], { onAction: (...args: unknown[]) => asked.push(args) });
    const more = root!.querySelector('.wb-warns-more')!;
    assert.equal(more.tagName.toLowerCase(), 'button');
    assert.equal(more.getAttribute('type'), 'button');
    assert.equal(more.getAttribute('data-action'), 'more');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    more.click();
    assert.deepEqual(asked, [['more']]);
  });

  test('#610/AC-3 expanded: every band renders and the toggle offers "Mostrar menos"', () => {
    const asked: unknown[][] = [];
    const root = bands([...ORGS, ...FIVE], { expanded: true, onAction: (...args: unknown[]) => asked.push(args) });
    assert.equal(root!.children.filter((c) => c.classList.contains('wb-warn-band')).length, 5);
    const toggle = root!.querySelector('.wb-warns-more')!;
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('data-action'), 'more');
    assert.equal(texto(toggle), 'Mostrar menos');
    toggle.click();
    assert.deepEqual(asked, [['more']]);
    assert.equal(bands([...ORGS, ...FIVE.slice(0, 3)], { expanded: true })!.querySelector('.wb-warns-more'), null, 'three or fewer have no toggle even expanded');
  });

  test('#610/AC-3 the toggle is a named, keyboard-reachable control', () => {
    for (const expanded of [false, true]) {
      const toggle = bands([...ORGS, ...FIVE], { expanded })!.querySelector('.wb-warns-more')!;
      assert.ok(texto(toggle).trim().length > 0, 'it has an accessible name');
      assert.equal(toggle.hasAttribute('disabled'), false);
      assert.equal(toggle.hasAttribute('tabindex'), false, 'a native button needs no tabindex');
      assert.match(toggle.getAttribute('aria-expanded') ?? '', /^(true|false)$/);
    }
  });

  test('#610/AC-3 no warning, no component; GitHub down shows none per organization', () => {
    assert.equal(bands(ORGS), null);
    assert.equal(bands(ORGS.map((o) => ({ ...o, state: 'failed' })), { githubDown: true }), null);
  });
});

describe('#610/AC-1 and AC-3 the states with no card (598-4)', () => {
  const states = (kind: string, over: Card = {}) => orgsEmpty({ kind, organizations: ORGS, ...over });
  const labels = (root: ElementoFalso) => root.querySelectorAll('button').map(texto);

  test('#610/AC-1 no issue in any Project read: says what the board shows, leads to GitHub and to the connection', () => {
    const actions: string[] = [];
    const root = states('issues', { onAction: (k: string) => actions.push(k) });
    assert.match(texto(root), /Nenhuma issue nos Projects das suas organizações/);
    assert.match(texto(root), /Os 5 Projects de acme-labs, northwind e mira-dev \(você\) não têm nenhuma issue/);
    assert.deepEqual(labels(root), ['Abrir os Projects no GitHub', 'Conceder acesso a outra organização']);
    for (const b of root.querySelectorAll('button')) b.dispatchEvent({ type: 'click' });
    assert.deepEqual(actions, ['open-projects', 'connect']);
    assert.doesNotMatch(texto(root), /Trocar de Project/);
  });

  test('#610/AC-1 no Project at all: "Nenhum Project para mostrar", GitHub and the connection, no "Trocar de Project"', () => {
    const root = states('projects', { organizations: [org('acme-labs', [])] });
    assert.match(texto(root), /Nenhum Project para mostrar/);
    assert.deepEqual(labels(root), ['Abrir o GitHub', 'Conceder acesso a outra organização']);
    assert.doesNotMatch(texto(root), /Trocar de Project/);
  });

  test('#610/AC-3 every organization with a warning: an alert with Tentar agora, busy while it reads', () => {
    const actions: string[] = [];
    const root = states('all-failed', { onAction: (k: string) => actions.push(k) });
    assert.match(texto(root), /Não conseguimos ler nenhuma organização/);
    assert.deepEqual(labels(root), ['Tentar agora']);
    root.querySelector('button')!.dispatchEvent({ type: 'click' });
    assert.deepEqual(actions, ['retry']);
    assert.equal(root.querySelector('h2')!.tagName, 'H2');
    const busy = states('all-failed', { busy: true });
    assert.ok(busy.querySelector('button')!.hasAttribute('disabled'));
    assert.equal(busy.querySelector('button')!.getAttribute('aria-busy'), 'true');
  });

  test('#610/AC-1 loading: the columns are skeletons with counts in "…" and the filters are off', () => {
    const board = boardColumns({ mode: 'skeleton', counts: '…', showOrigin: true, now: NOW });
    assert.equal(board.getAttribute('aria-busy'), 'true');
    assert.equal(board.querySelectorAll('article.wb-card').length, 0);
    const off = filterBar({ filters: NO_FILTERS, options: {}, organizations: [], origin: true, disabled: true });
    assert.ok(off.querySelectorAll('select').every((s) => s.hasAttribute('disabled')));
  });

  test('#610 English internals: every new class and data-* token is English, the copy is pt-BR', () => {
    const roots = [
      workBoardHeader({ organizations: [...ORGS, ...FIVE], now: NOW }),
      filterBar({ filters: { ...NO_FILTERS, org: 'acme-labs', project: 'acme-labs/3' }, options: ORG_OPTIONS, organizations: ORGS, origin: true, link: '/ui/work' }),
      orgWarnings({ organizations: [...ORGS, ...FIVE], now: NOW }),
      orgsEmpty({ kind: 'issues', organizations: ORGS }),
      projectResetNote({ project: PLATFORM, to: 'northwind' }),
      boardColumns({ columns: ORIGIN_COLUMNS, showOrigin: true, staleOrgs: ['northwind'], now: NOW }),
    ];
    const names = new Set<string>();
    for (const root of roots) {
      for (const node of [root, ...root.querySelectorAll('*')]) {
        for (const c of (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) if (c.startsWith('wb-')) names.add(c);
        for (const [name, value] of node.atributos) if (name.startsWith('data-') && name !== 'data-key') (names.add(name), names.add(value));
      }
    }
    for (const name of [...names].filter(Boolean)) {
      assert.match(name, /^[a-z0-9-]+$/, name);
      assert.doesNotMatch(name, /organizacao|aviso|origem|cabecalho|filtro|projeto|cartao/i, `${name} reads Portuguese`);
    }
    for (const token of ['wb-origin', 'wb-warns', 'wb-warn-band', 'wb-orgs-count', 'wb-reset-note', 'wb-org-stale', 'wb-warns-more']) assert.ok(names.has(token), `${token} is rendered`);
  });
});
