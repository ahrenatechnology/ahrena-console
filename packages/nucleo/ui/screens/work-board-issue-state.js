// The state behind the issue panel and "Planejar" on the work board (issue 467, issue 508, layer 3).
//
// Pure transitions: state and inputs in, new state out; no DOM, no fetch. The screen reads `state.panel.request` and
// `state.post` to know what to fetch (GET /api/work/issue, POST /api/work/plan) and hands the answers back to the
// transitions; the render parts of work-board-issue-panel.js and work-board-plan.js take what `panelView`,
// `planOf` and `cardWithPlanning` give them.

import { PLANNABLE_TYPES } from './work-board-plan.js';

const DEFAULT_TARGET = 'desktop';
const TARGETS = ['desktop', 'terminal'];

const CLOSED_PANEL = { open: false, key: null, card: null, request: 0, issue: null, stale: false, retrying: false, reason: null };

/** A fresh screen: no panel open and no card being planned. `plans` holds the planning of each card by key. */
export function initialIssueState() {
  return { panel: CLOSED_PANEL, plans: {}, post: null };
}

// ---- The panel (AC-1) ----

/** Which card is open: the skeleton while the issue loads (decision 1); a new request for GET /api/work/issue. */
export function openPanel(state, card) {
  const request = state.panel.request + 1;
  return { ...state, panel: { ...CLOSED_PANEL, open: true, key: card.key, card, request } };
}

/** What the panel renders: `closed`, `skeleton`, `failure` (the red band with Tentar de novo) or `panel`. */
export function panelView(state) {
  const { open, issue, reason } = state.panel;
  if (!open) return 'closed';
  if (issue) return 'panel';
  return reason !== null ? 'failure' : 'skeleton';
}

/** GET /api/work/issue answered for `request`; a stale answer keeps the panel with the stale band (decision 2). */
export function panelLoaded(state, issue, request) {
  if (!state.panel.open || request !== state.panel.request) return state;
  return { ...state, panel: { ...state.panel, issue, stale: Boolean(issue?.stale), retrying: false, reason: null } };
}

/**
 * GET /api/work/issue failed for `request` with the core's reason, alone (decision 7). A panel already showing an issue
 * stays on it, stale; with nothing to show it is the failure.
 */
export function panelFailed(state, reason, request) {
  const { panel } = state;
  if (!panel.open || request !== panel.request) return state;
  if (panel.issue) return { ...state, panel: { ...panel, stale: true, retrying: false } };
  return { ...state, panel: { ...panel, reason: reason ? String(reason) : '' } };
}

/** Tentar de novo / Tentar agora: read again. The failure goes back to the skeleton; a stale panel stays and is `retrying`. */
export function retryPanel(state) {
  const { panel } = state;
  if (!panel.open || panel.retrying) return state;
  const request = panel.request + 1;
  if (panel.issue && panel.stale) return { ...state, panel: { ...panel, retrying: true, request } };
  if (!panel.issue && panel.reason !== null) return { ...state, panel: { ...panel, reason: null, request } };
  return state;
}

/** Close, or Escape: the panel goes and forgets its answer; the planning of its card stays. */
export function closePanel(state) {
  return state.panel.open ? { ...state, panel: { ...CLOSED_PANEL, request: state.panel.request } } : state;
}

// ---- Planning (AC-2 to AC-4) ----

const stepsOf = (entry, card) => entry?.steps ?? card?.plan?.steps ?? 0;

/**
 * The planning of a card: `{ phase, steps, target, replan, reason, message, command }` with the phase `idle`, `confirming`,
 * `posting`, `planning` (planejando…), `planned` (N steps), `failed` or `missing-folder`. A card nothing happened to is
 * `planned` when the core sent it with a plan, else `idle`.
 */
export function planOf(state, card) {
  const entry = state.plans[card.key];
  const steps = stepsOf(entry, card);
  const base = { steps, target: DEFAULT_TARGET, replan: false, reason: null, message: null, command: null };
  if (entry) return { ...base, ...entry, steps };
  return { ...base, phase: steps > 0 ? 'planned' : 'idle' };
}

const isPlannable = (card) => PLANNABLE_TYPES.has(card?.type) && card.column === 'planning';
const BUSY = new Set(['posting', 'planning']);

function put(state, key, entry) {
  const plans = { ...state.plans };
  if (entry) plans[key] = entry;
  else delete plans[key];
  return { ...state, plans };
}

// Closes any other open confirmation: only one is anchored at a time.
function withoutOtherConfirmation(state, key) {
  return Object.entries(state.plans).reduce((s, [k, e]) => (k !== key && e.phase === 'confirming' ? put(s, k, e.prior ?? null) : s), state);
}

/**
 * Planejar, or Replanejar with `replan` (decision 4: the same confirmation): opens the confirmation on the card. Epics and
 * initiatives, cards outside Planejamento, a card already planning, and a replan with no plan do nothing.
 */
export function askPlan(state, card, { replan = false } = {}) {
  const now = planOf(state, card);
  if (!isPlannable(card) || BUSY.has(now.phase) || now.phase === 'confirming') return state;
  if (replan ? now.steps === 0 : now.phase === 'planned') return state;
  const prior = state.plans[card.key] ?? null;
  return put(withoutOtherConfirmation(state, card.key), card.key, { phase: 'confirming', steps: now.steps, target: DEFAULT_TARGET, replan, prior });
}

/** Where to open (Claude Desktop or Terminal) on the confirmation; an unknown target is ignored. */
export function chooseTarget(state, card, target) {
  const entry = state.plans[card.key];
  return entry?.phase === 'confirming' && TARGETS.includes(target) ? put(state, card.key, { ...entry, target }) : state;
}

/** Cancelar: the card goes back to what it was before the confirmation. Not while posting. */
export function cancelPlan(state, card) {
  const entry = state.plans[card.key];
  return entry?.phase === 'confirming' ? put(state, card.key, entry.prior) : state;
}

/** Confirm: POST /api/work/plan is to be sent; `state.post` is its body. */
export function confirmPlan(state, card) {
  const entry = state.plans[card.key];
  if (entry?.phase !== 'confirming') return state;
  const post = { key: card.key, number: card.number, repo: card.repo, target: entry.target, replan: entry.replan };
  return { ...put(state, card.key, { ...entry, phase: 'posting' }), post };
}

const posting = (state, card) => (state.plans[card.key]?.phase === 'posting' ? state.plans[card.key] : null);
const settle = (state, card, entry) => ({ ...put(state, card.key, entry), post: state.post?.key === card.key ? null : state.post });

/** The core accepted the POST: the session is running, the card says "planejando…". */
export function planAccepted(state, card) {
  const entry = posting(state, card);
  return entry ? { ...state, plans: { ...state.plans, [card.key]: { ...entry, phase: 'planning' } } } : state;
}

/** The plan is out with `steps` steps: "plano · N passos", and Replanejar is the secondary action. */
export function planSucceeded(state, card, steps) {
  const entry = state.plans[card.key];
  if (!entry || !BUSY.has(entry.phase)) return state;
  return settle(state, card, { phase: 'planned', steps });
}

/** The planning failed, or the POST answered an error other than 501 (decision 6): the core's reason alone, the card back on Planejar. */
export function planFailed(state, card, reason) {
  const entry = state.plans[card.key];
  if (!entry || !BUSY.has(entry.phase)) return state;
  return settle(state, card, { phase: 'failed', steps: entry.steps, reason: reason ? String(reason) : null });
}

/** The repository is not on this machine: the core's message and command (decision 9); the card stays where it was. */
export function planMissingFolder(state, card, { message = null, command = null } = {}) {
  const entry = posting(state, card);
  return entry ? settle(state, card, { phase: 'missing-folder', steps: entry.steps, message, command, prior: entry.prior }) : state;
}

/** Fechar on the missing-folder block: the card is as it was. */
export function closeMissingFolder(state, card) {
  const entry = state.plans[card.key];
  return entry?.phase === 'missing-folder' ? put(state, card.key, entry.prior) : state;
}

/**
 * The card as the render parts of work-board-plan.js read it: `planning` running or failed with its reason, and `plan.steps`
 * once there is a plan (kept through a failed replan, decision 13). The same card feeds the panel (decision 5).
 */
export function cardWithPlanning(state, card) {
  const { phase, steps, reason } = planOf(state, card);
  const plan = steps > 0 ? { ...card.plan, steps } : card.plan;
  if (phase === 'planning') return { ...card, plan, planning: { state: 'running' } };
  if (phase === 'failed') return { ...card, plan, planning: { state: 'failed', reason } };
  return { ...card, plan, planning: undefined };
}
