/* #477 the rules behind the queue on the work board: what a drop or an arrow key asks of the core, and what the board refuses. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: browser module, plain JavaScript
import * as q from '../../ui/screens/work-board-queue-state.js';
// @ts-expect-error: idem
import { queueLimit } from '../../ui/screens/work-board-queue.js';
import { instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const c = (n: number, over: Record<string, unknown> = {}) => ({ key: `r/x#${n}`, repo: 'r/x', number: n, type: 'story', column: 'planning', plan: { steps: 2 }, queuePosition: null, ...over });
const queued = [c(1, { column: 'queued', queuePosition: 1 }), c(2, { column: 'queued', queuePosition: 2 }), c(3, { column: 'queued', queuePosition: 3 })];

describe('#477/AC-2 dropPlan', () => {
  test('#477/AC-2 a planned card enqueues at the end, or in front of a queued card', () => {
    assert.deepEqual(q.dropPlan({ card: c(9), to: 'queued', queued }), { kind: 'enqueue', after: 'r/x#3', index: 3, last: true });
    assert.deepEqual(q.dropPlan({ card: c(9), to: 'queued', queued, beforeKey: 'r/x#1' }), { kind: 'enqueue', after: null, index: 0, last: false });
    assert.deepEqual(q.dropPlan({ card: c(9), to: 'queued', queued, beforeKey: 'r/x#3' }), { kind: 'enqueue', after: 'r/x#2', index: 2, last: false });
  });
  test('#477/AC-2 a card without a plan, or of an untrusted repository, is refused with "Planeje antes"', () => {
    assert.match(q.dropPlan({ card: c(9, { plan: null }), to: 'queued', queued }).message, /^Planeje antes/);
    assert.match(q.dropPlan({ card: c(9, { trusted: false }), to: 'queued', queued }).message, /Fora da lista de confiança/);
  });
  test('#477/AC-5 the four fact columns refuse, each with its own words', () => {
    for (const to of ['running', 'review', 'blocked', 'done']) assert.equal(q.dropPlan({ card: c(9), to, queued }).kind, 'refuse');
    assert.match(q.dropPlan({ card: c(9), to: 'review', queued }).message, /Em review vem do PR/);
  });
  test('#477/AC-2 a queued card reorders, dequeues, and a drop where it already is does nothing', () => {
    assert.deepEqual(q.dropPlan({ card: queued[2]!, to: 'queued', queued, beforeKey: 'r/x#1' }), { kind: 'reorder', after: null, index: 0 });
    assert.equal(q.dropPlan({ card: queued[1]!, to: 'queued', queued, beforeKey: 'r/x#3' }).kind, 'none');
    assert.equal(q.dropPlan({ card: queued[2]!, to: 'queued', queued }).kind, 'none');
    assert.equal(q.dropPlan({ card: queued[0]!, to: 'planning', queued }).kind, 'dequeue');
    assert.equal(q.dropPlan({ card: c(9), to: 'planning', queued }).kind, 'none');
  });
  test('#477/AC-5 a card of a fact column is not draggable and an epic neither', () => {
    assert.equal(q.dropPlan({ card: c(9, { column: 'review' }), to: 'queued', queued }).kind, 'none');
    assert.equal(q.dropPlan({ card: c(9, { type: 'epic' }), to: 'queued', queued }).kind, 'none');
  });
});

describe('#477/AC-2 stepPlan', () => {
  test('#477/AC-2 up and down by one place, nothing at the ends', () => {
    assert.deepEqual(q.stepPlan({ card: queued[1]!, queued, dir: -1 }), { kind: 'reorder', after: null, index: 0 });
    assert.deepEqual(q.stepPlan({ card: queued[0]!, queued, dir: 1 }), { kind: 'reorder', after: 'r/x#2', index: 1 });
    assert.equal(q.stepPlan({ card: queued[0]!, queued, dir: -1 }).kind, 'none');
    assert.equal(q.stepPlan({ card: queued[2]!, queued, dir: 1 }).kind, 'none');
  });
});

describe('#477/AC-6 notes and the limit text', () => {
  test('#477/AC-6 a note stays only while the card is in the column it was given in', () => {
    const s = q.setNote(q.initialQueueState(), c(1), 'recusado');
    assert.equal(q.reconcileNotes(s, [c(1)]), s);
    assert.deepEqual(q.reconcileNotes(s, [c(1, { column: 'queued' })]).notes, {});
  });
  test('#477/AC-2 the limit reads N de L rodando; without the counts it is not drawn', () => {
    assert.match(texto(queueLimit({ running: 3, limit: 2, stopped: null })), /3 de 2 rodando/);
    assert.match(texto(queueLimit({ running: 1, limit: 2, stopped: { key: 'r/x#5', reason: 'x' } })), /Fila parada · 1 de 2 rodando; não puxa até resolver a #5/);
    assert.equal(queueLimit({ available: true }), null);
  });
});
