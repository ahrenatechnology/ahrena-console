/* issue 467, issue 508: the issue panel and "Planejar" wired into the live work board (layer 4, the contract).

 The one object the board screen (work-board.js) talks to. It keeps the state of work-board-issue-state.js, reads
 GET /api/work/issue, sends POST /api/work/plan, and learns when a planning run ends from the board's own
 GET /api/work (a card's `planning` and `plan.steps`), which the screen hands to `learn` on every draw. The screen asks it
 for the card renderer, to wrap its nodes with the panel, and to put the focus where the person's last action sends it. */

import { el } from '../dom.js';
import { githubDownReason, workCard } from './work-board-parts.js';
import { cardPlanParts, missingFolder, planConfirm } from './work-board-plan.js';
import { issuePanel, issuePanelFailure, issuePanelLoading, issuePanelStage } from './work-board-issue-panel.js';
import { createEditLayer } from './work-board-issue-edit-layer.js';
import {
  askPlan,
  cancelPlan,
  cardWithPlanning,
  chooseTarget,
  closeMissingFolder,
  closePanel,
  confirmPlan,
  initialIssueState,
  openPanel,
  panelFailed,
  panelLoaded,
  panelView,
  planAccepted,
  planFailed,
  planMissingFolder,
  planSucceeded,
  retryPanel,
} from './work-board-issue-state.js';

const STYLE = '/ui/work-board-issue-panel.css';
const ISSUE_ROUTE = '/api/work/issue';
const PLAN_ROUTE = '/api/work/plan';
const MISSING_FOLDER = 501;
const POLL_MS = 15_000;
const SAME_FAILURE_WAIT = 3_000;
const POPUP_PHASES = new Set(['confirming', 'posting', 'missing-folder']);

const MESSAGES = {
  'not-found': 'A issue não existe mais no GitHub.',
  off: 'O núcleo subiu sem GitHub (--no-github).',
  'github-not-connected': 'O console não está conectado ao GitHub.',
};

/** issue 508: the core's reason for a failed GET /api/work/issue, in pt-BR (its answers are codes: work-issue.ts). */
function issueReason(error) {
  const body = error?.body && typeof error.body === 'object' ? error.body : {};
  if (body.error === 'github-unavailable') return `Motivo: ${githubDownReason(body.reason) ?? 'o GitHub não respondeu'}.`;
  if (Object.hasOwn(MESSAGES, body.error)) return MESSAGES[body.error];
  return error?.status ? `O núcleo respondeu ${error.status}.` : (error?.message ?? 'O núcleo não respondeu.');
}

/** issue 508: the core's reason for a POST /api/work/plan that did not open a session: its own `error` text (work-plan.ts). */
const planReason = (error) => (typeof error?.body?.error === 'string' && error.body.error ? error.body.error : (error?.message ?? null));

// issue 508: the keys of the card's buttons, so a redraw gives the focus back to the same one (the panel's get their own).
function keyed(parts, key) {
  for (const b of parts.actions?.querySelectorAll?.('button') ?? []) b.setAttribute('data-key', key);
  return parts;
}

/**
 * issue 508: the view and interaction half of the issue layer: where the focus goes, the card renderer, the panel and the
 * confirmation. It reads the layer's state through `state()` and changes it only through `apply(next, intent)`; `retry` and
 * `confirm` are the layer's own, because they touch what the layer keeps (the forced re-read, the failure it saw before).
 */
function createIssueView({ area, state, apply, cardFor, retry, confirm, run, onAsk, edit }) {
  let focus = null;
  let anchorInPanel = false;

  const shownCard = (card) => {
    // issue 535: the step count GitHub answered for an edited issue, until the board's own read says the same.
    const counted = edit.countFor(card.key);
    const counting = counted === null ? card : { ...card, plan: counted > 0 ? { ...card.plan, steps: counted } : null };
    const planned = state().plans[card.key] ? cardWithPlanning(state(), counting) : counting;
    return run ? run.card(planned) : planned;
  };
  const focusOn = (intent) => {
    focus = intent;
  };

  const open = (card) => {
    const s = state();
    if (s.panel.open && s.panel.key === card.key) return;
    apply(openPanel(s, cardFor(card.key) ?? card), { kind: 'panel' });
  };
  const close = () => apply(closePanel(state()), { kind: 'card', key: state().panel.key });
  const ask = (replan) => (card, button) => {
    onAsk?.();
    anchorInPanel = Boolean(button?.closest?.('.wb-panel'));
    const base = cardFor(card.key) ?? card;
    apply(askPlan(state(), base, { replan }), { kind: 'popup' });
  };
  const handlers = { onPlan: ask(false), onReplan: ask(true) };

  function popupFor(card) {
    const entry = state().plans[card.key];
    if (!entry || !POPUP_PHASES.has(entry.phase)) return null;
    const base = cardFor(card.key) ?? card;
    const where = () => ({ kind: 'plan-button', key: card.key });
    let node;
    if (entry.phase === 'missing-folder') {
      node = missingFolder({ repo: card.repo, message: entry.message, command: entry.command, onClose: () => apply(closeMissingFolder(state(), base), where()) });
    } else {
      node = planConfirm({
        repo: card.repo,
        number: card.number,
        replan: entry.replan,
        target: entry.target,
        busy: entry.phase === 'posting',
        onTarget: (target) => apply(chooseTarget(state(), base, target), { kind: 'popup' }),
        onCancel: () => apply(cancelPlan(state(), base), where()),
        onConfirm: () => confirm(card),
      });
    }
    // issue 508: Escape on the confirmation closes only it, not the panel it may sit in.
    node.addEventListener('keydown', (ev) => ev.key === 'Escape' && ev.stopPropagation?.());
    return node;
  }

  const panelHolds = (card) => state().panel.open && state().panel.key === card.key;
  const partsOf = (card) => (run ? run.parts(card, handlers) : cardPlanParts(card, handlers));
  const hostedInPanel = (card) => anchorInPanel && panelHolds(card);

  /** issue 508: the card of the board with its planning parts, the open one marked and the confirmation anchored on it. */
  function renderCard(card, options) {
    const shown = shownCard(card);
    const parts = keyed(partsOf(shown), card.key);
    const node = workCard(shown, { ...options, parts, onOpen: open, selected: state().panel.open && state().panel.key === card.key });
    const pop = (hostedInPanel(card) ? null : popupFor(shown)) ?? run?.popup(shown, 'card', panelHolds(card)) ?? null;
    return pop ? el('div', { class: 'wb-anchor' }, node, pop) : node;
  }

  function panel() {
    const s = state();
    const view = panelView(s);
    if (view === 'closed') return null;
    const { key, issue, reason, stale, retrying } = s.panel;
    const card = shownCard(cardFor(key) ?? s.panel.card);
    const now = Date.now();
    let node;
    if (view === 'skeleton') node = issuePanelLoading({ card, now, onClose: close });
    else if (view === 'failure') node = issuePanelFailure({ card, reason, now, onRetry: retry, onClose: close });
    else if (edit.isOpen(key)) node = edit.render({ card, now, onClose: close });
    else {
      const parts = keyed(partsOf(card), `panel:${key}`);
      node = issuePanel({ card, issue: { ...issue, stale: stale || issue.stale }, now, parts, onRetry: retrying ? null : retry, onEdit: () => edit.open(issue), onClose: close });
      const pop = (hostedInPanel(card) ? popupFor(card) : null) ?? run?.popup(card, 'panel', true) ?? null;
      if (pop) (node.querySelector('.wb-panel-acts') ?? node).append(pop);
    }
    node.setAttribute('tabindex', '-1');
    return node;
  }

  /** issue 508: the board nodes, with the panel on their right when one is open. */
  function wrap(nodes) {
    edit.capture();
    // issue 508: a redraw replaces the panel, so the focus on the panel itself (not on one of its buttons) is given back to it.
    const active = globalThis.document?.activeElement;
    if (!focus && active?.tagName === 'ASIDE' && active.closest?.('aside.wb-panel') === active && area.contains(active)) focus = { kind: 'panel' };
    const side = panel();
    return side ? [issuePanelStage({ board: el('div', { class: 'wb-panel-board' }, ...nodes), panel: side })] : nodes;
  }

  /** issue 508: what changes what `wrap` and `renderCard` draw, for the screen's "did it change" check. */
  const signature = () => [state().panel, state().plans, anchorInPanel, edit.signature()];

  /** issue 508: after a draw, the focus goes where the person's last action sends it (the panel, the card, the confirmation). */
  function afterDraw() {
    // issue 535: the edit mode puts the focus where its own action sends it; the panel itself is only for a read panel.
    if (edit.afterDraw()) {
      focus = null;
      return;
    }
    if (!focus) return;
    const { kind, key } = focus;
    focus = null;
    const card = key ? `article[data-key="${key}"]` : null;
    const target =
      kind === 'panel' ? area.querySelector('aside.wb-panel')
      : kind === 'card' ? area.querySelector(card)
      : kind === 'plan-button' ? (area.querySelector(`aside.wb-panel button[data-action="plan"]`) ?? area.querySelector(`aside.wb-panel button[data-action="replan"]`) ?? area.querySelector(`${card} button[data-action="plan"]`) ?? area.querySelector(card))
      : (area.querySelector('.wb-plan-pop [aria-checked="true"]') ?? area.querySelector('.wb-plan-pop button'));
    target?.focus();
  }

  return { renderCard, wrap, signature, afterDraw, focusOn };
}

/**
 * issue 508: the issue layer of the board. `cards()` is the board's cards, `redraw()` draws the screen again and `reread()` reads
 * GET /api/work quietly; `ctx` is the screen's (read, write, signal). It keeps the state and its effects; the view half is
 * createIssueView's.
 */
export function createIssueLayer({ ctx, area, cards, options = () => ({}), redraw, reread, run = null, onAsk = null }) {
  let s = initialIssueState();
  let alive = true;
  let learning = false;
  let fetched = 0;
  let forceNext = false;
  let sent = null;
  let poll = null;
  const seen = new Set();
  const accepted = new Map();
  const before = new Map();

  const link = globalThis.document?.head?.querySelector?.('link[data-screen="work-issue"]') ?? el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'work-issue' });
  if (!link.parentNode) globalThis.document?.head?.append(link);

  const cardFor = (key) => cards().find((c) => c.key === key) ?? (s.panel.key === key ? s.panel.card : null);

  async function loadIssue({ request, card }) {
    const force = forceNext ? '&refresh=1' : '';
    forceNext = false;
    try {
      const issue = await ctx.read(`${ISSUE_ROUTE}?repo=${encodeURIComponent(card.repo)}&number=${card.number}${force}`);
      if (alive) apply(panelLoaded(s, issue, request));
    } catch (e) {
      if (alive && e?.name !== 'AbortError') apply(panelFailed(s, issueReason(e), request));
    }
  }

  async function sendPlan(post) {
    const card = cardFor(post.key);
    try {
      await ctx.write(PLAN_ROUTE, { repo: post.repo, number: post.number, target: post.target, replan: post.replan });
      if (!alive) return;
      accepted.set(post.key, Date.now());
      apply(planAccepted(s, card));
      void reread();
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      if (e?.status === MISSING_FOLDER) apply(planMissingFolder(s, card, { message: e.body?.error ?? null, command: e.body?.command ?? null }));
      else apply(planFailed(s, card, planReason(e)));
    }
  }

  const running = () => Object.values(s.plans).some((e) => e.phase === 'planning') || cards().some((c) => c.planning?.state === 'running');

  function pollSoon() {
    if (poll || !alive || !running()) return;
    poll = setTimeout(async () => {
      poll = null;
      await reread();
      pollSoon();
    }, POLL_MS);
    poll.unref?.();
  }

  function effects() {
    const { panel } = s;
    if (panel.open && panel.request !== fetched) {
      fetched = panel.request;
      void loadIssue(panel);
    }
    if (s.post && s.post !== sent) {
      sent = s.post;
      void sendPlan(s.post);
    }
    pollSoon();
  }

  function apply(next, intent = null) {
    if (next === s) return;
    const done = Object.entries(s.plans).some(([k, e]) => e.phase === 'planning' && next.plans[k]?.phase === 'planned');
    s = next;
    // issue 535: the edit belongs to the open panel of its issue; a closed panel, or another card, ends it.
    if (edit.key() && (!s.panel.open || s.panel.key !== edit.key())) edit.close();
    if (intent) view.focusOn(intent);
    effects();
    // issue 508: the steps of a plan that just came out are in the issue, not in the one the panel read before.
    if (done && s.panel.open && s.plans[s.panel.key]?.phase === 'planned') reloadPanel();
    if (!learning) redraw();
  }

  function reloadPanel() {
    s = { ...s, panel: { ...s.panel, request: s.panel.request + 1 } };
    forceNext = true;
    effects();
  }

  function learn() {
    edit.learn(cards());
    let next = s;
    for (const card of cards()) {
      const entry = next.plans[card.key];
      if (entry?.phase !== 'planning') continue;
      if (card.planning?.state === 'running') seen.add(card.key);
      else if (card.planning?.state === 'failed') {
        const old = before.get(card.key) === card.planning.reason && !seen.has(card.key) && Date.now() - (accepted.get(card.key) ?? 0) < SAME_FAILURE_WAIT;
        if (!old) next = planFailed(next, card, card.planning.reason);
      } else if (card.plan?.steps > 0 && (!entry.replan || seen.has(card.key))) next = planSucceeded(next, card, card.plan.steps);
    }
    learning = true;
    try {
      apply(next);
    } finally {
      learning = false;
    }
    pollSoon();
  }

  const retry = () => {
    forceNext = true;
    apply(retryPanel(s));
  };

  function confirm(card) {
    const base = cardFor(card.key) ?? card;
    before.set(card.key, base.planning?.state === 'failed' ? base.planning.reason : null);
    seen.delete(card.key);
    apply(confirmPlan(s, base));
  }

  function stop() {
    alive = false;
    edit.stop();
    clearTimeout(poll);
    link.remove();
  }

  // issue 535: Editar turns the panel into the edit mode; Concluir gives the read panel the issue GitHub last answered.
  const edit = createEditLayer({
    ctx,
    area,
    redraw: () => redraw(),
    choices: () => ({ cards: cards(), options: options() }),
    onSaved: () => void reread(),
    onFinished: (issue) => apply(panelLoaded(s, issue, s.panel.request)),
  });

  const view = createIssueView({ area, state: () => s, apply, cardFor, retry, confirm, run, onAsk, edit });

  // issue 532: the screen closes this layer's open confirmation when the run layer opens its own (one at a time, 465-6).
  const closeConfirmation = () => Object.keys(s.plans).forEach((key) => apply(cancelPlan(s, { key })));

  return { renderCard: view.renderCard, wrap: view.wrap, signature: view.signature, learn, afterDraw: view.afterDraw, closeConfirmation, stop };
}
