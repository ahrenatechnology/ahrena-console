/* issue 595 (layer 2 of issue 584): an untrusted repository's card and panel offer no Planejar, Executar plano or queue
action, and say why in one line with a lock icon. The trusted ones are unchanged. Pure render functions in the fake DOM. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
// @ts-expect-error: browser module, plain JavaScript
import { cardPlanParts } from '../../ui/screens/work-board-plan.js';
// @ts-expect-error: browser module, plain JavaScript
import { cardRunParts } from '../../ui/screens/work-board-run.js';
// @ts-expect-error: browser module, plain JavaScript
import { issuePanel } from '../../ui/screens/work-board-issue-panel.js';
// @ts-expect-error: browser module, plain JavaScript
import { workCard } from '../../ui/screens/work-board-parts.js';

instalarDomFalso();

const REPO = 'ahrenatechnology/ahrena-console';
const NOW = new Date(2026, 10, 14, 10, 0, 0).getTime();
const CARD_LINE = 'Fora da lista de confiança: só leitura';
const PANEL_LINE = 'Repositório fora da lista de confiança: ahrenatechnology não pode Planejar nem Executar plano aqui';
const ACTIONS = '[data-action="plan"], [data-action="replan"], [data-action="run"], [data-action="queue"], [data-action="unqueue"]';

type Obj = Record<string, unknown>;
function card(n: number, over: Obj = {}): Obj {
  return {
    key: `${REPO}#${n}`, repo: REPO, number: n, title: `Issue ${n}`, url: `https://github.com/${REPO}/issues/${n}`,
    level: 'item', type: 'story', typeName: 'User Story', state: 'open', column: 'planning', columnSince: new Date(NOW).toISOString(),
    parent: { key: `${REPO}#6`, number: 6 }, chain: [], projectStatus: { id: 'todo', name: 'Todo' }, labels: [], milestone: null,
    plan: null, planning: null, sessions: { count: 0, state: null, ids: [] }, pullRequest: null, blocked: null, queuePosition: null,
    doneAt: null, doneBy: null, children: null, trusted: true, ...over,
  };
}
const issue = (n: number): Obj => ({
  key: `${REPO}#${n}`, repo: REPO, type: 'story', number: n, title: `Issue ${n}`, state: 'OPEN', url: `https://github.com/${REPO}/issues/${n}`,
  labels: [], milestone: null, projectStatus: 'Todo', parents: [], body: 'Texto.', plan: { steps: [] }, pullRequest: null, comments: [], trusted: true,
  fetchedAt: new Date(NOW).toISOString(), stale: false, staleReason: null,
});
const all = (root: ElementoFalso, selector: string) => root.querySelectorAll(selector);
const line = (root: ElementoFalso) => root.querySelector('.wb-untrusted');

describe('595/AC-1 the untrusted repository card', () => {
  for (const [name, subject] of [
    ['without a plan', card(1, { trusted: false })],
    ['with a plan', card(2, { trusted: false, plan: { steps: 3 } })],
    ['queued with a plan', card(3, { trusted: false, column: 'queued', plan: { steps: 3 } })],
    ['with a failed planning', card(4, { trusted: false, plan: { steps: 3 }, planning: { state: 'failed', reason: 'x' } })],
  ] as const) {
    test(`${name}: no Planejar, Executar plano or queue action; the short line with a lock icon takes their place`, () => {
      const parts = cardRunParts(subject, {});
      const root = workCard(subject, { parts, now: NOW });
      assert.equal(all(root, ACTIONS).length, 0);
      assert.ok(!/Planejar|Replanejar|Executar plano|Pôr na fila|Tirar da fila/.test(texto(root)), texto(root));
      const found = line(root)!;
      assert.equal(texto(found), CARD_LINE);
      assert.equal(found.querySelectorAll('svg').length, 1);
      assert.equal(found.getAttribute('role'), 'note');
    });
  }

  test('cardPlanParts alone says the same', () => {
    const parts = cardPlanParts(card(5, { trusted: false }), {});
    assert.equal(texto(parts.actions), CARD_LINE);
  });

  test('a type Planejar is never offered for still shows nothing', () => {
    const parts = cardRunParts(card(6, { trusted: false, type: 'epic' }), {});
    assert.equal(parts.actions, null);
  });

  test('a live session keeps Abrir sessão: it is not one of the hidden actions', () => {
    const live = card(7, { trusted: false, column: 'running', sessions: { count: 1, state: 'working', ids: ['a'] } });
    const parts = cardRunParts(live, {});
    assert.equal(all(parts.actions, '[data-action="open-session"]').length, 1);
  });
});

describe('595/AC-2 the untrusted repository panel', () => {
  test('the full line with a lock icon is in the actions row, under the chain and above DESCRIÇÃO, and no action shows', () => {
    const subject = card(8, { trusted: false, plan: { steps: 3 } });
    const withChain = { ...issue(8), parents: [{ key: `${REPO}#6`, repo: REPO, number: 6, title: 'Pai', url: '', state: 'OPEN', type: 'epic' }] };
    const root = issuePanel({ card: subject, issue: withChain, now: NOW, parts: cardRunParts(subject, { place: 'panel' }) });
    const row = root.querySelector('.wb-panel-acts')!;
    assert.equal(texto(line(row)!), PANEL_LINE);
    assert.equal(line(row)!.querySelectorAll('svg').length, 1);
    assert.equal(all(root, ACTIONS).length, 0);
    const order = [...root.children].map((c: ElementoFalso) => c.getAttribute('data-section') ?? c.getAttribute('class') ?? '');
    const at = (needle: string) => order.findIndex((c: string) => c.includes(needle));
    assert.ok(at('wb-panel-chain') < at('wb-panel-acts'));
    assert.ok(at('wb-panel-acts') < at('description'));
  });
});

describe('595/AC-3 a trusted repository is unchanged', () => {
  test('the card and the panel carry the same actions and no line', () => {
    for (const trusted of [true, undefined]) {
      const subject = card(9, { plan: { steps: 3 }, ...(trusted === undefined ? {} : { trusted }) });
      if (trusted === undefined) delete subject.trusted;
      const cardRoot = workCard(subject, { parts: cardRunParts(subject, {}), now: NOW });
      assert.equal(texto(one(cardRoot, '[data-action="run"]')), 'Executar plano');
      assert.equal(texto(one(cardRoot, '[data-action="replan"]')), 'Replanejar');
      assert.equal(line(cardRoot), null);
      const panelRoot = issuePanel({ card: subject, issue: issue(9), now: NOW, parts: cardRunParts(subject, { place: 'panel' }) });
      assert.equal(texto(one(panelRoot, '[data-action="run"]')), 'Executar plano');
      assert.equal(line(panelRoot), null);
    }
    const bare = card(10);
    assert.equal(texto(one(workCard(bare, { parts: cardRunParts(bare, {}), now: NOW }), '[data-action="plan"]')), 'Planejar');
  });
});

function one(root: ElementoFalso, selector: string): ElementoFalso {
  const found = root.querySelector(selector);
  assert.ok(found, `${selector} not found`);
  return found;
}

describe('595 the files follow the /ui rules', () => {
  test('wb-untrusted is styled with tokens and no hand-written colour', () => {
    const css = readFileSync(`${UI_FOLDER}work-board-issue-panel.css`, 'utf8');
    const rule = css.split('\n').filter((l) => l.includes('.wb-untrusted'));
    assert.ok(rule.length > 0, '.wb-untrusted is not styled');
    assert.doesNotMatch(rule.join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
