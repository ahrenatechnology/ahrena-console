/* issue 477: the execution queue wired into the live work board (layer 3, the state and the contract).

 The sibling of the issue and run layers. It sends POST /api/work/queue, DELETE /api/work/queue, POST /api/work/queue/order and
 POST /api/work/queue/retry, and then re-reads GET /api/work: the board's own answer is the truth (queue positions, the limit,
 the stopped queue), nothing is moved optimistically. It owns the drag and drop (Planejamento <-> Na fila, reorder inside Na fila),
 the arrow keys on a queued card, the refusals of the columns of facts and the red note of a card whose drop the core refused.
 The issue layer asks it for the card's parts and a decorated card node; the screen asks it to wire the board's columns. */

import { queueParts, dropMark, refuseMessage, queueGrip } from './work-board-queue.js';
import {
  clearNote,
  dropPlan,
  enqueueRefusal,
  QUEUE_COLUMNS,
  initialQueueState,
  isQueueCard,
  queueReason,
  queuedCards,
  reconcileNotes,
  setBusy,
  setNote,
  setRetrying,
  stepPlan,
} from './work-board-queue-state.js';

const QUEUE_ROUTE = '/api/work/queue';
const ORDER_ROUTE = '/api/work/queue/order';
const RETRY_ROUTE = '/api/work/queue/retry';
const DEFAULT_TARGET = 'desktop';

/**
 * `cards()` is the board's cards, `queue()` the `queue` of GET /api/work, `target()` the last place the person chose to open a
 * session (the queue stores it, wireframe decision 13), `redraw()` draws the screen again and `reread()` reads GET /api/work.
 */
export function createQueueLayer({ ctx, area, cards, queue, target = () => DEFAULT_TARGET, redraw, reread }) {
  let s = initialQueueState();
  let alive = true;
  let drag = null;
  let refused = null;
  let deferred = false;
  let focus = null;

  const available = () => queue()?.available !== false;
  const find = (key) => cards().find((c) => c.key === key) ?? null;
  const stoppedKey = () => queue()?.stopped?.key ?? null;

  function apply(next) {
    if (next === s) return;
    s = next;
    if (drag) deferred = true;
    else redraw();
  }

  async function settle(card, work) {
    apply(setBusy(clearNote(s, card.key), card.key, true));
    try {
      await work();
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      apply(setNote(s, find(card.key) ?? card, queueReason(e)));
    } finally {
      if (alive) {
        await reread();
        apply(setBusy(s, card.key, false));
      }
    }
  }

  const post = (card, route, body) => ctx.write(route, { repo: card.repo, number: card.number, ...body });

  function enqueue(card, plan = {}) {
    const refusal = enqueueRefusal(card);
    if (refusal) return apply(setNote(s, card, refusal));
    return settle(card, async () => {
      await post(card, QUEUE_ROUTE, { target: target() });
      if (plan.last === false) {
        try {
          await post(card, ORDER_ROUTE, { after: plan.after });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          throw new Error(`Entrou na fila, mas não deu para mudar a posição: ${queueReason(e)}`);
        }
      }
    });
  }

  const dequeue = (card) => settle(card, () => ctx.write(QUEUE_ROUTE, { repo: card.repo, number: card.number }, { method: 'DELETE', jsonBody: true }));
  const reorder = (card, after) => settle(card, () => post(card, ORDER_ROUTE, { after }));

  async function retry() {
    const key = stoppedKey();
    const card = key ? find(key) : null;
    if (!card || s.retrying) return;
    apply(setRetrying(clearNote(s, key), true));
    try {
      await ctx.write(RETRY_ROUTE, {});
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      apply(setNote(s, find(key) ?? card, queueReason(e)));
    } finally {
      if (alive) {
        await reread();
        apply(setRetrying(s, false));
      }
    }
  }

  function run(card, plan) {
    if (plan.kind === 'enqueue') return enqueue(card, plan);
    if (plan.kind === 'dequeue') return dequeue(card);
    if (plan.kind === 'reorder') return reorder(card, plan.after);
    if (plan.kind === 'refuse') return apply(setNote(s, card, plan.message));
    return undefined;
  }

  // ---------- the card ----------

  /** The card's parts with the queue's: Pôr na fila, Tirar da fila, the stopped reason and Tentar de novo. */
  function parts(card, base) {
    if (!available()) return base;
    const queued = card.column === 'queued';
    const offer = card.column === 'planning' && PLAN_OK(card);
    const stopped = queue()?.stopped;
    return queueParts(base, card, {
      queued,
      offer,
      stoppedReason: queued && stopped?.key === card.key ? stopped.reason : null,
      note: s.notes[card.key]?.text ?? null,
      busy: Boolean(s.busy[card.key]),
      retrying: s.retrying,
      onEnqueue: (c) => enqueue(find(c.key) ?? c, { last: true }),
      onDequeue: (c) => dequeue(find(c.key) ?? c),
      onRetry: retry,
    });
  }

  const PLAN_OK = (card) => isQueueCard(card) && card.plan?.steps > 0 && card.trusted !== false;

  /** The card node made draggable, with its handle and the arrow keys of a queued card. */
  function decorate(node, card) {
    if (!available() || !isQueueCard(card) || s.busy[card.key]) return node;
    const queued = card.column === 'queued';
    node.setAttribute('draggable', 'true');
    if (queued) node.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    node.querySelector('.wb-card-top')?.append(queueGrip(queued));
    node.addEventListener('dragstart', (ev) => {
      if (ev.target !== node) return;
      drag = { key: card.key };
      refused = null;
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData?.('text/plain', card.key);
      }
      const board = node.closest?.('.wb-board');
      setTimeout(() => {
        if (!drag) return;
        board?.classList.add('wb-dragging');
        node.classList.add('wb-drag');
      }, 0);
    });
    node.addEventListener('dragend', () => {
      const lost = refused;
      drag = null;
      refused = null;
      node.classList.remove('wb-drag');
      node.closest?.('.wb-board')?.classList.remove('wb-dragging');
      clearMarks(node.closest?.('.wb-board'));
      if (lost) apply(setNote(s, find(lost.key) ?? card, lost.message));
      if (deferred) {
        deferred = false;
        redraw();
      }
    });
    if (queued) {
      node.addEventListener('keydown', (ev) => {
        const dir = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
        if (!dir || ev.target !== node || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
        ev.preventDefault?.();
        const plan = stepPlan({ card: find(card.key) ?? card, queued: queuedCards(cards()), dir });
        if (plan.kind === 'none') return;
        focus = card.key;
        run(card, plan);
      });
    }
    return node;
  }

  // ---------- the columns ----------

  function clearMarks(board) {
    for (const col of board?.querySelectorAll?.('.wb-col') ?? []) {
      col.classList.remove('wb-target', 'wb-refuse');
      for (const n of [...col.querySelectorAll('.wb-drop-item'), ...col.querySelectorAll('.wb-refuse-msg')]) n.remove();
    }
  }

  // The queued card the pointer is above: the first (not the dragged one) whose middle is below it, else the one under the pointer.
  function beforeKeyAt(col, ev) {
    const items = [...col.querySelectorAll('article.wb-card')].filter((n) => n.getAttribute('data-key') !== drag?.key);
    if (typeof ev.clientY === 'number' && items.some((n) => typeof n.getBoundingClientRect === 'function')) {
      const hit = items.find((n) => {
        const r = n.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      return hit?.getAttribute('data-key') ?? null;
    }
    const under = ev.target?.closest?.('article[data-key]');
    const key = under?.getAttribute('data-key');
    return key && key !== drag?.key && items.includes(under) ? key : null;
  }

  function planAt(col, ev) {
    const card = drag ? find(drag.key) : null;
    if (!card) return { kind: 'none' };
    const to = col.getAttribute('data-column');
    return dropPlan({ card, to, queued: queuedCards(cards()), beforeKey: to === 'queued' ? beforeKeyAt(col, ev) : null });
  }

  function mark(col, plan, ev) {
    clearMarks(col.parentNode);
    if (plan.kind === 'refuse') {
      col.classList.add('wb-refuse');
      col.insertBefore(refuseMessage(plan.message), col.querySelector('ul.wb-cards') ?? col.querySelector('.wb-none'));
      return;
    }
    col.classList.add('wb-target');
    if (plan.kind !== 'enqueue' && plan.kind !== 'reorder') return;
    const first = plan.kind === 'reorder' && plan.index === 0 ? 'passa a 1º' : `${plan.kind === 'reorder' ? 'passa a' : 'entra em'} ${plan.index + 1}º`;
    const before = beforeKeyAt(col, ev);
    const at = before ? col.querySelector(`article[data-key="${before}"]`)?.closest?.('li') : null;
    const holder = col.querySelector('ul.wb-cards');
    const note = dropMark(`Solta aqui · ${first}`);
    if (at) at.parentNode.insertBefore(note, at);
    else if (holder) holder.append(note);
    else col.insertBefore(note, col.querySelector('.wb-none'));
  }

  /** Makes the columns of a board node take drops. Called by the screen on every board it draws. */
  function wire(board) {
    if (!available()) return board;
    for (const col of board.querySelectorAll('section.wb-col')) {
      if (!QUEUE_COLUMNS.has(col.getAttribute('data-column'))) col.setAttribute('data-fact', 'true');
      col.addEventListener('dragover', (ev) => {
        if (!drag) return;
        const plan = planAt(col, ev);
        if (plan.kind === 'none') return;
        ev.preventDefault?.();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = plan.kind === 'refuse' ? 'none' : 'move';
        refused = plan.kind === 'refuse' ? { key: drag.key, message: plan.message } : null;
        mark(col, plan, ev);
      });
      col.addEventListener('dragleave', (ev) => {
        if (!drag || col.contains(ev.relatedTarget)) return;
        clearMarks(col.parentNode);
      });
      col.addEventListener('drop', (ev) => {
        if (!drag) return;
        ev.preventDefault?.();
        const plan = planAt(col, ev);
        const key = drag.key;
        refused = null;
        clearMarks(col.parentNode);
        const card = find(key);
        if (card) run(card, plan);
      });
    }
    return board;
  }

  function learn() {
    const next = reconcileNotes(s, cards());
    if (next !== s) s = next;
  }

  /** The focus goes back to a card the arrow keys moved, after the board is drawn again. */
  function afterDraw() {
    if (!focus || s.busy[focus]) return;
    const key = focus;
    focus = null;
    area.querySelector(`article[data-key="${key}"]`)?.focus();
  }

  const signature = () => [s];
  const dragging = () => drag !== null;
  const stop = () => {
    alive = false;
  };

  return { parts, decorate, wire, learn, afterDraw, signature, dragging, stop };
}
