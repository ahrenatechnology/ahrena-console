/* issue 477: the render parts of the execution queue on the work board (wireframes 477-1 and 477-2).

 Pure render functions: data and handlers in, nodes out. No fetch, no state: the layer (work-board-queue-layer.js) decides what
 each button does. The styles are in `work-board.css` (classes `wb-limit`, `wb-lock`, `wb-grip`, `wb-drop`, `wb-refuse-msg`). */

import { el, icon } from '../dom.js';
import { numberOfKey } from './work-board-queue-state.js';

const ref = (n) => `#${n}`;

/**
 * The limit at the top of Na fila: "N de L rodando", "3 de 2 rodando" when lowering the limit left more running than it allows,
 * and "Fila parada · 1 de 2 rodando" with "não puxa até resolver a issue 507" while a pull that failed stops the queue. `null` when
 * the core did not send the counts.
 */
export function queueLimit(queue) {
  if (!Number.isFinite(queue?.running) || !Number.isFinite(queue?.limit)) return null;
  const count = `${queue.running} de ${queue.limit} rodando`;
  if (queue.stopped) {
    const number = numberOfKey(queue.stopped.key);
    return el(
      'div',
      { class: 'wb-limit wb-paused', role: 'status', 'data-state': 'stopped', title: 'Limite de execuções simultâneas: preferência da instalação' },
      icon('pause'),
      el('span', {}, el('b', {}, 'Fila parada'), ` · ${count}; não puxa até resolver${number ? ` a ${ref(number)}` : ''}`),
    );
  }
  const full = queue.running >= queue.limit;
  return el(
    'div',
    { class: `wb-limit${full ? ' wb-full' : ''}`, role: 'status', 'data-state': full ? 'full' : 'free', title: 'Limite de execuções simultâneas: preferência da instalação' },
    icon('gauge'),
    el('span', {}, el('b', {}, count)),
  );
}

/** The handle a draggable card shows in its top line (arrastar, or use the arrows on a queued card). */
export const queueGrip = (queued) =>
  el('span', { class: 'wb-grip', 'aria-hidden': 'true', title: queued ? 'Arraste, ou use as setas para cima e para baixo' : 'Arraste para Na fila' }, icon('grip-vertical'));

/** The red note of a card: a refusal, a drop the core refused or a failed retry. */
export const queueNote = (text) => el('div', { class: 'wb-plan-note wb-queue-note', role: 'alert', 'data-field': 'queue-note' }, icon('alert'), el('span', {}, text));

/** The transient message a column of facts (or Na fila, for a card without a plan) shows while a card hovers over it. */
export const refuseMessage = (text) => el('div', { class: 'wb-refuse-msg', role: 'status', 'data-field': 'refusal' }, icon('alert'), el('span', {}, text));

/** The place a dragged card would land in: "Solta aqui · entra em 3º" or "passa a 1º". */
export const dropMark = (text) => el('li', { class: 'wb-card-item wb-drop-item', 'aria-hidden': 'true' }, el('div', { class: 'wb-drop' }, text));

const link = (action, label, name, onClick, busy) =>
  el('button', { type: 'button', class: 'wb-plan-link', 'data-action': action, 'aria-label': name, disabled: busy, onClick: (ev) => onClick?.(ev.currentTarget) }, label);

/**
 * The queue's part of a card's parts (`{ badge, note, actions }` of work-board-run.js): "Pôr na fila" beside Replanejar on a
 * card with a plan in Planejamento, "Tirar da fila" under Executar plano on a queued card, and on the card whose pull failed the
 * reason in red with "Tentar de novo" in place of Executar plano. `note` is the red note the layer holds for the card (a refusal
 * or a failed request). It adds to the node `parts.actions` (the `wb-plan-acts` of work-board-run.js), which that function builds fresh on
 * every call: a change of that structure must come with this one. A repository outside the trusted list keeps what the parts say ("Fora da lista de confiança").
 */
export function queueParts(parts, card, { queued = false, offer = false, stoppedReason = null, note = null, busy = false, retrying = false, onEnqueue = null, onDequeue = null, onRetry = null } = {}) {
  const number = ref(card.number);
  const marked = note ? queueNote(note) : stoppedReason ? queueNote(stoppedReason) : null;
  const out = { ...parts, note: marked ?? parts.note };
  if (queued && stoppedReason) {
    const retry = el(
      'button',
      { type: 'button', class: 'btn filled sm wb-plan-act', 'data-action': 'queue-retry', 'aria-label': `Tentar de novo (fila parada na ${number})`, 'aria-busy': retrying ? 'true' : null, disabled: retrying, onClick: () => onRetry?.() },
      icon('refresh'),
      'Tentar de novo',
    );
    out.actions = el('div', { class: 'wb-plan-acts' }, retry, el('div', { class: 'wb-plan-links' }, link('dequeue', 'Tirar da fila', `Tirar da fila (${number})`, () => onDequeue?.(card), busy)));
    return out;
  }
  if (queued && parts.actions?.querySelector) {
    if (parts.actions.classList?.contains('wb-plan-acts')) parts.actions.append(el('div', { class: 'wb-plan-links' }, link('dequeue', 'Tirar da fila', `Tirar da fila (${number})`, () => onDequeue?.(card), busy)));
    return out;
  }
  if (offer && parts.actions?.querySelector) {
    const links = parts.actions.querySelector('.wb-plan-links');
    const put = link('enqueue', 'Pôr na fila', `Pôr na fila (${number})`, () => onEnqueue?.(card), busy);
    if (links) links.append(put);
    else parts.actions.append(el('div', { class: 'wb-plan-links' }, put));
  }
  return out;
}
