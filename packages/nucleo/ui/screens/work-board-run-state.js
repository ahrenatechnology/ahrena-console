/* issue 468, issue 532: the state behind "Executar plano" on the work board (layer 3).

 Pure transitions: state and inputs in, new state out; no DOM, no fetch. The sibling of `work-board-issue-state.js`
 (Planejar), in the same shape. The screen reads `state.post` to know what to send to POST /api/work/run and hands the
 answer back to the transitions; the render parts of work-board-run.js take what `runOf`, `cardWithRun`, `runNoticeOf`
 and `sessionIdOf` give them. After each board read the screen calls `reconcileRuns`: the core's `execution` then takes
 over from the optimistic booting state kept here. */

import { runState } from './work-board-run.js';

const DEFAULT_TARGET = 'desktop';
const TARGETS = ['desktop', 'terminal'];
const BUSY = new Set(['posting']);

/** A fresh screen: nothing confirming. `runs` holds the run of each card by key; `notice` is the one after confirming. */
export function initialRunState() {
  return { runs: {}, post: null, notice: null };
}

/**
 * The run of a card: `{ phase, target, full, reason, message, command, opened }` with the phase `idle`, `confirming`
 * (`full` is the core's 409 `{ running, limit }` once it answered), `posting`, `booting` (subindo…), `failed` or
 * `missing-folder`. A card nothing happened to is `idle`.
 */
export function runOf(state, card) {
  const base = { target: DEFAULT_TARGET, full: null, reason: null, message: null, command: null, opened: null };
  return { ...base, phase: 'idle', ...state.runs[card.key] };
}

// issue 532: sets or clears the entry of one card.
function put(state, key, entry) {
  const runs = { ...state.runs };
  if (entry) runs[key] = entry;
  else delete runs[key];
  return { ...state, runs };
}

// issue 532: only one confirmation is anchored at a time; opening one closes the others, as Planejar does.
function withoutOtherConfirmation(state, key) {
  return Object.entries(state.runs).reduce((s, [k, e]) => (k !== key && e.phase === 'confirming' ? put(s, k, e.prior ?? null) : s), state);
}

/**
 * Executar plano: opens the confirmation on the card. Only a card the components offer Executar plano on (a plan, in
 * Planejamento or Na fila) gets it: epics, initiatives, cards without a plan, live and running cards do nothing.
 */
export function askRun(state, card) {
  const phase = runOf(state, card).phase;
  if (!['planned', 'queued'].includes(runState(card)) || !['idle', 'failed'].includes(phase)) return state;
  const prior = state.runs[card.key] ?? null;
  return put(withoutOtherConfirmation(state, card.key), card.key, { phase: 'confirming', target: DEFAULT_TARGET, full: null, prior });
}

/** Where to open (Claude Desktop or Terminal) on the confirmation; an unknown target is ignored. */
export function chooseRunTarget(state, card, target) {
  const entry = state.runs[card.key];
  return entry?.phase === 'confirming' && TARGETS.includes(target) ? put(state, card.key, { ...entry, target }) : state;
}

/** Cancelar: the card goes back to what it was before the confirmation. Not while posting. */
export function cancelRun(state, card) {
  const entry = state.runs[card.key];
  return entry?.phase === 'confirming' ? put(state, card.key, entry.prior) : state;
}

/**
 * Confirm: POST /api/work/run is to be sent; `state.post` is its body. After a 409 the same press is "Executar mesmo
 * assim" and the body carries `force: true`.
 */
export function confirmRun(state, card) {
  const entry = state.runs[card.key];
  if (entry?.phase !== 'confirming') return state;
  const post = { repo: card.repo, number: card.number, target: entry.target, ...(entry.full ? { force: true } : {}) };
  return { ...put(state, card.key, { ...entry, phase: 'posting' }), post };
}

// issue 532: the entry while its POST is in flight; the answers below only count then.
const posting = (state, card) => (BUSY.has(state.runs[card.key]?.phase) ? state.runs[card.key] : null);
const settle = (state, card, entry) => ({ ...put(state, card.key, entry), post: state.post?.number === card.number && state.post?.repo === card.repo ? null : state.post });

/** 200 `{ ok, opened, key }`: the card is in Em execução with "subindo…", and the notice says where the session opened. */
export function runAccepted(state, card, { opened = DEFAULT_TARGET } = {}) {
  const entry = posting(state, card);
  if (!entry) return state;
  return { ...settle(state, card, { phase: 'booting', target: entry.target, opened }), notice: { key: card.key, number: card.number, opened } };
}

/** 409 `{ error, running, limit }`: the confirmation stays open with the count; the next confirm sends `force: true`. */
export function runLimitFull(state, card, { running, limit }) {
  const entry = posting(state, card);
  return entry ? settle(state, card, { ...entry, phase: 'confirming', full: { running, limit } }) : state;
}

/** 501 `{ error, command }`: the core's message and command; the card stays where it was. */
export function runMissingFolder(state, card, { message = null, command = null } = {}) {
  const entry = posting(state, card);
  return entry ? settle(state, card, { phase: 'missing-folder', target: entry.target, message, command, prior: entry.prior }) : state;
}

/** Fechar on the missing-folder block: the card is as it was. */
export function closeRunMissingFolder(state, card) {
  const entry = state.runs[card.key];
  return entry?.phase === 'missing-folder' ? put(state, card.key, entry.prior) : state;
}

/** Any other failure (422, 502, 503, the network): the core's reason alone, the card back on its action. */
export function runFailed(state, card, reason) {
  const entry = posting(state, card);
  return entry ? settle(state, card, { phase: 'failed', target: entry.target, reason: reason ? String(reason) : null }) : state;
}

/** The notice after confirming, as `runNotice` takes it, or null. */
export function runNoticeOf(state) {
  return state.notice ? { number: state.notice.number, opened: state.notice.opened } : null;
}

/** Fechar the notice: the run stays. */
export function closeRunNotice(state) {
  return state.notice ? { ...state, notice: null } : state;
}

/**
 * After a board read: a card the core now carries in `execution` (or in Em execução) is the core's, and the optimistic
 * booting state is dropped. A read from before the core recorded the run keeps it.
 */
export function reconcileRuns(state, cards) {
  const taken = Object.entries(state.runs).filter(([key, e]) => {
    if (e.phase !== 'booting') return false;
    const read = cards.find((c) => c.key === key);
    return Boolean(read && (read.execution || read.column === 'running'));
  });
  return taken.reduce((s, [key]) => put(s, key, null), state);
}

/** The session "Abrir sessão" opens: the first of the card (issue 532), or null. */
export function sessionIdOf(card) {
  return card?.sessions?.ids?.[0] ?? null;
}

/**
 * The card as the render parts of work-board-run.js read it: booting shows it in Em execução with "subindo…"; a failure
 * in Planejamento is `planning` failed with its reason, as Planejar's. The core's own `execution` always wins.
 */
export function cardWithRun(state, card) {
  if (card.execution) return card;
  const { phase, reason } = runOf(state, card);
  if (phase === 'booting') return { ...card, column: 'running', execution: { state: 'booting' } };
  if (phase === 'failed' && card.column === 'planning') return { ...card, planning: { state: 'failed', reason } };
  return card;
}
