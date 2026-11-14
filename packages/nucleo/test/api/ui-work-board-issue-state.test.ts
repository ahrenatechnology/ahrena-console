// #467, #508: the state behind the issue panel and Planejar (layer 3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { instalarDomFalso, texto } from './fake-dom.ts';
import {
  askPlan,
  cancelPlan,
  cardWithPlanning,
  chooseTarget,
  closePanel,
  closeMissingFolder,
  confirmPlan,
  initialIssueState,
  openPanel,
  panelFailed,
  panelLoaded,
  panelView,
  planAccepted,
  planFailed,
  planMissingFolder,
  planOf,
  planSucceeded,
  retryPanel,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-issue-state.js';
// @ts-expect-error: browser module, plain JavaScript
import { cardPlanParts, planConfirm } from '../../ui/screens/work-board-plan.js';

instalarDomFalso();

const REPO = 'ahrenatechnology/ahrena-console';
type Obj = Record<string, any>;
const card = (n: number, over: Obj = {}): Obj => ({ key: `${REPO}#${n}`, repo: REPO, number: n, title: `Issue ${n}`, level: 'item', type: 'story', column: 'planning', ...over });
const issue = (over: Obj = {}): Obj => ({ fetchedAt: 1_000, stale: false, body: 'texto', ...over });
const text = (node: unknown) => texto(node as never);

describe('the issue panel (AC-1)', () => {
  test('starts closed', () => {
    const s = initialIssueState();
    assert.equal(s.panel.open, false);
    assert.equal(panelView(s), 'closed');
  });

  test('opening a card loads: the skeleton, a new request, nothing to show yet', () => {
    const s = openPanel(initialIssueState(), card(1));
    assert.equal(s.panel.key, card(1).key);
    assert.equal(panelView(s), 'skeleton');
    assert.equal(s.panel.request, 1);
  });

  test('the answer shows the panel; a stale read keeps it with the stale band', () => {
    const s0 = openPanel(initialIssueState(), card(1));
    const s1 = panelLoaded(s0, issue(), 1);
    assert.equal(panelView(s1), 'panel');
    assert.equal(s1.panel.stale, false);
    const s2 = panelLoaded(s0, issue({ stale: true, staleReason: 'offline' }), 1);
    assert.equal(panelView(s2), 'panel');
    assert.equal(s2.panel.stale, true);
    assert.equal(s2.panel.issue.fetchedAt, 1_000);
  });

  test('an answer to an older request, or to a closed panel, is ignored', () => {
    const s = openPanel(openPanel(initialIssueState(), card(1)), card(2));
    assert.equal(s.panel.request, 2);
    assert.equal(panelLoaded(s, issue(), 1), s);
    assert.equal(panelFailed(s, 'x', 1), s);
    const closed = closePanel(s);
    assert.equal(panelLoaded(closed, issue(), 2), closed);
  });

  test('a failed read is the failure with the core reason alone; retry loads again with the header kept', () => {
    const s0 = openPanel(initialIssueState(), card(1));
    const s1 = panelFailed(s0, 'GitHub não respondeu', 1);
    assert.equal(panelView(s1), 'failure');
    assert.equal(s1.panel.reason, 'GitHub não respondeu');
    const s2 = retryPanel(s1);
    assert.equal(panelView(s2), 'skeleton');
    assert.equal(s2.panel.request, 2);
    assert.equal(s2.panel.reason, null);
    assert.equal(s2.panel.key, card(1).key);
    assert.equal(retryPanel(s0), s0, 'nothing to retry while loading');
  });

  test('a stale panel retries without losing what it shows; a failed retry stays stale', () => {
    const s0 = panelLoaded(openPanel(initialIssueState(), card(1)), issue({ stale: true }), 1);
    const s1 = retryPanel(s0);
    assert.equal(panelView(s1), 'panel');
    assert.equal(s1.panel.retrying, true);
    const s2 = panelFailed(s1, 'ainda fora', s1.panel.request);
    assert.equal(panelView(s2), 'panel');
    assert.equal(s2.panel.stale, true);
    assert.equal(s2.panel.retrying, false);
    const s3 = panelLoaded(s1, issue({ stale: false, fetchedAt: 2_000 }), s1.panel.request);
    assert.equal(s3.panel.stale, false);
    assert.equal(s3.panel.issue.fetchedAt, 2_000);
  });

  test('close (and Escape) closes the panel and forgets the answer', () => {
    const s = closePanel(panelLoaded(openPanel(initialIssueState(), card(1)), issue(), 1));
    assert.equal(panelView(s), 'closed');
    assert.equal(s.panel.issue, null);
    assert.equal(closePanel(s), s);
  });

  test('opening another card replaces the panel', () => {
    const s = openPanel(panelLoaded(openPanel(initialIssueState(), card(1)), issue(), 1), card(2));
    assert.equal(s.panel.key, card(2).key);
    assert.equal(panelView(s), 'skeleton');
    assert.equal(s.panel.issue, null);
  });

  test('closing the panel keeps the planning of its card', () => {
    let s = askPlan(initialIssueState(), card(1));
    s = closePanel(openPanel(s, card(1)));
    assert.equal(planOf(s, card(1)).phase, 'confirming');
  });
});

describe('Planejar (AC-2)', () => {
  test('a story, task, bug or spike without a plan can be planned; epic and initiative cannot', () => {
    for (const type of ['story', 'task', 'bug', 'spike']) assert.equal(planOf(askPlan(initialIssueState(), card(1, { type })), card(1, { type })).phase, 'confirming', type);
    for (const type of ['epic', 'initiative']) {
      const s = initialIssueState();
      assert.equal(askPlan(s, card(1, { type })), s, type);
    }
  });

  test('only a card in Planejamento is offered Planejar', () => {
    const s = initialIssueState();
    assert.equal(askPlan(s, card(1, { column: 'running' })), s);
  });

  test('confirming opens on the card with the terminal-less default target, then cancel goes back to idle', () => {
    const c = card(1);
    const s = askPlan(initialIssueState(), c);
    assert.deepEqual([planOf(s, c).phase, planOf(s, c).target, planOf(s, c).replan], ['confirming', 'desktop', false]);
    assert.equal(planOf(chooseTarget(s, c, 'terminal'), c).target, 'terminal');
    assert.equal(planOf(chooseTarget(s, c, 'nope'), c).target, 'desktop');
    assert.equal(planOf(cancelPlan(s, c), c).phase, 'idle');
  });

  test('only one confirmation is open: asking on another card closes the first', () => {
    const s = askPlan(askPlan(initialIssueState(), card(1)), card(2));
    assert.equal(planOf(s, card(1)).phase, 'idle');
    assert.equal(planOf(s, card(2)).phase, 'confirming');
  });

  test('confirm posts with the target: the request is returned, the card shows no action change yet', () => {
    const c = card(1);
    const s = confirmPlan(chooseTarget(askPlan(initialIssueState(), c), c, 'terminal'), c);
    assert.equal(planOf(s, c).phase, 'posting');
    assert.deepEqual(s.post, { key: c.key, number: 1, repo: REPO, target: 'terminal', replan: false });
    assert.equal(confirmPlan(s, c), s, 'a second confirm while posting does nothing');
    assert.equal(cancelPlan(s, c), s, 'no cancel while posting');
  });

  test('confirm without a confirmation open does nothing', () => {
    const s = initialIssueState();
    assert.equal(confirmPlan(s, card(1)), s);
  });
});

describe('planning, planned, failed (AC-3, AC-4)', () => {
  const posted = (c: Obj, replan = false) => confirmPlan(askPlan(initialIssueState(), c, { replan }), c);

  test('accepted: planejando…; the card carries the running badge', () => {
    const c = card(1);
    const s = planAccepted(posted(c), c);
    assert.equal(planOf(s, c).phase, 'planning');
    assert.equal(cardWithPlanning(s, c).planning.state, 'running');
    const parts = cardPlanParts(cardWithPlanning(s, c));
    assert.equal(text(parts.badge), 'planejando…');
    assert.equal(parts.actions, null);
  });

  test('planned with N steps: Replanejar is the secondary action and the steps are on the card', () => {
    const c = card(1);
    const s = planSucceeded(planAccepted(posted(c), c), c, 3);
    assert.equal(planOf(s, c).phase, 'planned');
    assert.equal(planOf(s, c).steps, 3);
    const view = cardWithPlanning(s, c);
    assert.equal(view.plan.steps, 3);
    const parts = cardPlanParts(view);
    assert.match(text(parts.actions), /Replanejar/);
    assert.doesNotMatch(text(parts.actions), /Planejar a/);
  });

  test('a plan that is on the card already is planned without any state', () => {
    const c = card(1, { plan: { steps: 2 } });
    assert.equal(planOf(initialIssueState(), c).phase, 'planned');
    assert.equal(planOf(initialIssueState(), c).steps, 2);
  });

  test('failed: the card is back on Planejar with the core reason alone', () => {
    const c = card(1);
    const s = planFailed(posted(c), c, 'A sessão terminou sem plano');
    assert.equal(planOf(s, c).phase, 'failed');
    const parts = cardPlanParts(cardWithPlanning(s, c));
    assert.match(text(parts.note), /A sessão terminou sem plano/);
    assert.match(text(parts.actions), /Planejar/);
  });

  test('a POST error is a failure with the core error; a failure without a reason has none', () => {
    const c = card(1);
    assert.equal(planOf(planFailed(posted(c), c, 'repo-not-found'), c).reason, 'repo-not-found');
    assert.equal(planOf(planFailed(posted(c), c, undefined), c).reason, null);
  });

  test('a failed replan keeps the failure note plus Replanejar, and the old steps', () => {
    const c = card(1, { plan: { steps: 4 } });
    const s = planFailed(posted(c, true), c, 'falhou');
    const view = cardWithPlanning(s, c);
    assert.equal(view.plan.steps, 4);
    const parts = cardPlanParts(view);
    assert.match(text(parts.note), /falhou/);
    assert.match(text(parts.actions), /Replanejar/);
  });

  test('a failed card can be planned again, with a clean confirmation', () => {
    const c = card(1);
    const s = askPlan(planFailed(posted(c), c, 'falhou'), c);
    assert.equal(planOf(s, c).phase, 'confirming');
    assert.equal(planOf(cancelPlan(s, c), c).phase, 'failed', 'cancel returns to what was there');
    assert.equal(planOf(cancelPlan(s, c), c).reason, 'falhou');
  });

  test('replan reuses the confirmation, worded for a replan', () => {
    const c = card(1, { plan: { steps: 2 } });
    const s = askPlan(initialIssueState(), c, { replan: true });
    assert.equal(planOf(s, c).replan, true);
    assert.equal(planOf(cancelPlan(s, c), c).phase, 'planned');
    assert.equal(askPlan(initialIssueState(), card(2), { replan: true }).plans[card(2).key], undefined, 'no replan without a plan');
  });

  test('no Planejar while planning or posting', () => {
    const c = card(1);
    const s1 = posted(c);
    assert.equal(askPlan(s1, c), s1);
    const s2 = planAccepted(s1, c);
    assert.equal(askPlan(s2, c), s2);
  });

  test('answers for a card that is not posting are ignored', () => {
    const c = card(1);
    const s = initialIssueState();
    assert.equal(planAccepted(s, c), s);
    assert.equal(planFailed(s, c, 'x'), s);
    assert.equal(planSucceeded(s, c, 2), s);
  });

  test('the panel reuses the card badge and note (decision 5)', () => {
    const c = card(1);
    const s = planFailed(posted(c), c, 'falhou');
    const open = panelLoaded(openPanel(s, c), issue(), 1);
    assert.match(text(cardPlanParts(cardWithPlanning(open, c)).note), /falhou/);
  });
});

describe('the missing folder (AC-4)', () => {
  const c = card(1);
  const posted = () => confirmPlan(askPlan(initialIssueState(), c), c);

  test('keeps the core message and command; the card stays where it was', () => {
    const s = planMissingFolder(posted(), c, { message: 'Clone o repo', command: 'git clone x' });
    assert.deepEqual([planOf(s, c).phase, planOf(s, c).message, planOf(s, c).command], ['missing-folder', 'Clone o repo', 'git clone x']);
    assert.equal(cardPlanParts(cardWithPlanning(s, c)).badge, null);
    assert.match(text(cardPlanParts(cardWithPlanning(s, c)).actions), /Planejar/);
  });

  test('closing it goes back to idle, and a card with a plan back to planned', () => {
    const s = closeMissingFolder(planMissingFolder(posted(), c, { message: null, command: 'x' }), c);
    assert.equal(planOf(s, c).phase, 'idle');
    const withPlan = card(2, { plan: { steps: 1 } });
    const t = confirmPlan(askPlan(initialIssueState(), withPlan, { replan: true }), withPlan);
    assert.equal(planOf(closeMissingFolder(planMissingFolder(t, withPlan, { command: 'x' }), withPlan), withPlan).phase, 'planned');
  });

  test('only while posting', () => {
    const s = initialIssueState();
    assert.equal(planMissingFolder(s, c, { command: 'x' }), s);
  });
});

describe('interaction: the confirmation is driven from the state', () => {
  test('Confirm on the rendered confirmation runs the transition', () => {
    const c = card(1);
    let s = askPlan(initialIssueState(), c);
    const view = () =>
      planConfirm({ repo: c.repo, number: c.number, target: planOf(s, c).target, onTarget: (t: string) => (s = chooseTarget(s, c, t)), onCancel: () => (s = cancelPlan(s, c)), onConfirm: () => (s = confirmPlan(s, c)) });
    view().querySelector('[data-target="terminal"]')?.click();
    view().querySelector('[data-action="confirm"]')?.click();
    assert.equal(planOf(s, c).phase, 'posting');
    assert.equal(s.post.target, 'terminal');
  });

  test('Cancel on the rendered confirmation goes back to idle', () => {
    const c = card(1);
    let s = askPlan(initialIssueState(), c);
    planConfirm({ repo: c.repo, number: 1, onCancel: () => (s = cancelPlan(s, c)) }).querySelector('[data-action="cancel"]')?.click();
    assert.equal(planOf(s, c).phase, 'idle');
  });

  test('the Planejar button on the card asks, the Replanejar link asks for a replan', () => {
    let s = initialIssueState();
    const c = card(1);
    cardPlanParts(cardWithPlanning(s, c), { onPlan: (x: Obj) => (s = askPlan(s, x)) }).actions.querySelector('[data-action="plan"]')?.click();
    assert.equal(planOf(s, c).phase, 'confirming');
    const planned = card(2, { plan: { steps: 2 } });
    cardPlanParts(cardWithPlanning(s, planned), { onReplan: (x: Obj) => (s = askPlan(s, x, { replan: true })) }).actions.querySelector('[data-action="replan"]')?.click();
    assert.equal(planOf(s, planned).replan, true);
  });
});

describe('conventions', () => {
  test('the state file has no DOM, no fetch and no #N in comments', () => {
    const src = readFileSync(`${UI_FOLDER}screens/work-board-issue-state.js`, 'utf8');
    assert.doesNotMatch(src, /document\.|window\.|fetch\(|localStorage/);
    assert.doesNotMatch(src, /#\d{3}/);
  });
});
