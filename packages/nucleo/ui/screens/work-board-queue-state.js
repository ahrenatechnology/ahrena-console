/* issue 477: the state and the rules behind the execution queue on the work board (layer 3).

 Pure functions: cards and inputs in, decisions out; no DOM, no fetch. `dropPlan` and `stepPlan` say what a drop or an arrow key
 asks of the core (enqueue, dequeue, reorder) or why the board refuses it (AC-2, AC-5); the transitions below keep the red note
 of a card and the cards with a request in flight. The render parts are in work-board-queue.js, the wiring in work-board-queue-layer.js. */

import { PLANNABLE_TYPES } from './work-board-plan.js';

/** The two columns a card may be dragged between: the person's order. The other four are facts of the session and of GitHub. */
export const QUEUE_COLUMNS = new Set(['planning', 'queued']);

const FACT_REFUSALS = {
  running: 'Em execução vem da sessão: não recebe card. Solte em Planejamento ou Na fila.',
  review: 'Em review vem do PR: não recebe card. Solte em Planejamento ou Na fila.',
  blocked: 'Bloqueado vem da sessão, do PR e do CI: não recebe card. Solte em Planejamento ou Na fila.',
  done: 'Concluído vem do GitHub: não recebe card. Solte em Planejamento ou Na fila.',
};
const NO_PLAN = 'Planeje antes: item sem plano não entra na fila';
const UNTRUSTED = 'Planeje antes: Fora da lista de confiança, só leitura';

/** The cards of Na fila in queue order, from the board's cards. */
export const queuedCards = (cards) =>
  cards
    .filter((c) => c.column === 'queued')
    .sort((a, b) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity));

/** Whether the card is one the person may drag or queue at all: an item with a type that has a plan, in Planejamento or Na fila. */
export const isQueueCard = (card) => PLANNABLE_TYPES.has(card?.type) && QUEUE_COLUMNS.has(card.column);

/** The reason a card of Planejamento cannot enter the queue, in pt-BR, or null when it can (the core checks again: 403, 422, 409). */
export function enqueueRefusal(card) {
  if (!(card?.plan?.steps > 0)) return NO_PLAN;
  if (card.trusted === false) return UNTRUSTED;
  return null;
}

/** The pt-BR a column of facts answers a dragged card with. */
export const factRefusal = (column) => FACT_REFUSALS[column] ?? FACT_REFUSALS.review;

/**
 * The `after` of POST /api/work/queue/order for putting `card` before the card `beforeKey` (null: at the end) among the
 * queued cards `keys`, in order. `null` means the top. Returns `{ index, after, same }`: the index it lands at and whether that
 * is where the card already is.
 */
export function placeBefore(keys, key, beforeKey) {
  const rest = keys.filter((k) => k !== key);
  const at = beforeKey ? rest.indexOf(beforeKey) : -1;
  const index = at < 0 ? rest.length : at;
  return { index, after: index === 0 ? null : rest[index - 1], same: keys.indexOf(key) === index };
}

/**
 * What dropping `card` on the column `to` asks for: `{ kind: 'enqueue' | 'dequeue' | 'reorder', after?, index? }`,
 * `{ kind: 'refuse', message }` or `{ kind: 'none' }`. `queued` is the cards of Na fila, `beforeKey` the queued card it
 * lands in front of (null: the end).
 */
export function dropPlan({ card, to, queued, beforeKey = null }) {
  if (!isQueueCard(card)) return { kind: 'none' };
  if (!QUEUE_COLUMNS.has(to)) return { kind: 'refuse', message: factRefusal(to) };
  if (to === 'planning') return card.column === 'queued' ? { kind: 'dequeue' } : { kind: 'none' };
  const place = placeBefore(
    queued.map((c) => c.key),
    card.key,
    beforeKey,
  );
  if (card.column === 'queued') return place.same ? { kind: 'none' } : { kind: 'reorder', after: place.after, index: place.index };
  const refusal = enqueueRefusal(card);
  if (refusal) return { kind: 'refuse', message: refusal };
  return { kind: 'enqueue', after: place.after, index: place.index, last: place.index === queued.length };
}

/** An arrow key on a queued card: `dir` is -1 (up) or 1 (down); `{ kind: 'reorder', after }` or `{ kind: 'none' }` at the ends. */
export function stepPlan({ card, queued, dir }) {
  const keys = queued.map((c) => c.key);
  const at = keys.indexOf(card.key);
  const to = at + dir;
  if (card.column !== 'queued' || at < 0 || to < 0 || to >= keys.length) return { kind: 'none' };
  const rest = keys.filter((k) => k !== card.key);
  return { kind: 'reorder', after: to === 0 ? null : rest[to - 1], index: to };
}

/** A fresh screen: no note on any card, nothing in flight. */
export function initialQueueState() {
  return { notes: {}, busy: {}, retrying: false };
}

const without = (map, key) => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

/** The red note of a card (a refusal, a failed drop or a failed retry), with the columns it stays through (the one it was given in, by default). */
export function setNote(state, card, text, columns = [card.column]) {
  return { ...state, notes: { ...state.notes, [card.key]: { text, columns } } };
}

export const clearNote = (state, key) => (state.notes[key] ? { ...state, notes: without(state.notes, key) } : state);

/** A request for the card is in flight (`on`) or settled. */
export const setBusy = (state, key, on) => (Boolean(state.busy[key]) === on ? state : { ...state, busy: on ? { ...state.busy, [key]: true } : without(state.busy, key) });

export const setRetrying = (state, retrying) => (state.retrying === retrying ? state : { ...state, retrying });

/** After a board read: a note stays only on a card that is still in the column it was given in (a moved card has settled). */
export function reconcileNotes(state, cards) {
  const stale = Object.entries(state.notes).filter(([key, n]) => !n.columns.includes(cards.find((c) => c.key === key)?.column));
  return stale.reduce((s, [key]) => clearNote(s, key), state);
}

/** The pt-BR of a failed queue request: the core's own `error`, else the transport's message. */
export const queueReason = (error) => (typeof error?.body?.error === 'string' && error.body.error ? error.body.error : (error?.message ?? 'O núcleo não respondeu'));

/** The issue number of a key `owner/name#N`, for the banner. */
export const numberOfKey = (key) => /#(\d+)$/.exec(String(key ?? ''))?.[1] ?? null;
