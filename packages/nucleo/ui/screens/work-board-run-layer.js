/* issue 468, issue 532: "Executar plano" wired into the live work board (layer 3, the contract).

 The sibling of the issue layer (work-board-issue.js): it keeps the state of work-board-run-state.js, sends POST /api/work/run,
 opens a live session through the session-open route of open-action.js, and learns that the core took a run over from the
 board's own GET /api/work, which the screen hands to `learn` on every draw. The issue layer asks it, through the small
 `run` seam it accepts, for the card as it shows now, the card's and the panel's parts and the confirmation anchored on the
 card; the screen asks it for the columns (a booting card is drawn in Em execução), the notices and the focus. */

import { el, icon } from '../dom.js';
import { openSession, stateOfAnswer } from '../open-action.js';
import { missingFolder } from './work-board-plan.js';
import { cardRunParts, runConfirm, runNotice } from './work-board-run.js';
import {
  askRun,
  cancelRun,
  cardWithRun,
  chooseRunTarget,
  closeRunMissingFolder,
  closeRunNotice,
  confirmRun,
  initialRunState,
  reconcileRuns,
  runAccepted,
  runFailed,
  runLimitFull,
  runMissingFolder,
  runNoticeOf,
  runOf,
  sessionIdOf,
} from './work-board-run-state.js';

const RUN_ROUTE = '/api/work/run';
const LIMIT_FULL = 409;
const MISSING_FOLDER = 501;
const POLL_MS = 15_000;
const POPUP_PHASES = new Set(['confirming', 'posting', 'missing-folder']);
const BOOTING_COLUMN = 'running';
const OPEN_FAILED = 'Não deu para abrir a sessão.';

/** issue 532: the core's reason for a POST /api/work/run that did not open a session: its own `error` text (work-run.ts). */
const runReason = (error) => (typeof error?.body?.error === 'string' && error.body.error ? error.body.error : (error?.message ?? null));

// issue 532: a card the person's run moved to Em execução (booting) leaves its column for the top of that one.
function movedToRunning(state, columns) {
  const moved = [];
  const kept = columns.map((c) => {
    const cards = (c.cards ?? []).filter((card) => {
      const shown = cardWithRun(state, card);
      if (c.id === BOOTING_COLUMN || shown.column !== BOOTING_COLUMN) return true;
      moved.push(shown);
      return false;
    });
    return cards.length === (c.cards ?? []).length ? c : { ...c, cards, count: (c.count ?? 0) - ((c.cards ?? []).length - cards.length) };
  });
  return { kept, moved };
}

/**
 * issue 532: the run layer of the board. `cards()` is the board's cards, `redraw()` draws the screen again and `reread()`
 * reads GET /api/work quietly; `ctx` is the screen's (write, signal).
 */
export function createRunLayer({ ctx, area, cards, redraw, reread }) {
  let s = initialRunState();
  let alive = true;
  let sent = null;
  let poll = null;
  let focus = null;
  let anchorInPanel = false;
  let openFailure = null;

  const find = (key) => cards().find((c) => c.key === key) ?? null;
  const byPost = (post) => cards().find((c) => c.repo === post.repo && c.number === post.number) ?? null;

  function apply(next, intent = null) {
    if (next === s) return;
    s = next;
    if (intent) focus = intent;
    effects();
    redraw();
  }

  async function sendRun(post) {
    const card = byPost(post);
    // issue 532: a card the board no longer carries has nothing to settle.
    if (!card) return;
    try {
      const done = await ctx.write(RUN_ROUTE, post);
      if (!alive) return;
      apply(runAccepted(s, card, { opened: done?.opened }));
      void reread();
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      const body = e?.body ?? {};
      if (e?.status === LIMIT_FULL) apply(runLimitFull(s, card, { running: body.running, limit: body.limit, error: runReason(e) }), { kind: 'popup' });
      else if (e?.status === MISSING_FOLDER) apply(runMissingFolder(s, card, { message: body.error ?? null, command: body.command ?? null }), { kind: 'popup' });
      else apply(runFailed(s, card, runReason(e)));
    }
  }

  const booting = () => Object.values(s.runs).some((e) => e.phase === 'booting');

  function pollSoon() {
    if (poll || !alive || !booting()) return;
    poll = setTimeout(async () => {
      poll = null;
      await reread();
      pollSoon();
    }, POLL_MS);
    poll.unref?.();
  }

  function effects() {
    if (s.post && s.post !== sent) {
      sent = s.post;
      void sendRun(s.post);
    }
    pollSoon();
  }

  async function openLive(card) {
    const id = sessionIdOf(card);
    if (!id) return;
    openFailure = null;
    try {
      await openSession(id, { write: ctx.write });
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      openFailure = stateOfAnswer(null, e).text || OPEN_FAILED;
    }
    if (alive) redraw();
  }

  const ask = (card, button) => {
    anchorInPanel = Boolean(button?.closest?.('.wb-panel'));
    openFailure = null;
    apply(askRun(s, find(card.key) ?? card), { kind: 'popup' });
  };

  /** issue 532: the confirmation or the missing-folder block of a card, or null; `place` is where the caller draws it. */
  function popup(card, place, panelOpen) {
    const entry = runOf(s, card);
    if (!POPUP_PHASES.has(entry.phase)) return null;
    const inPanel = anchorInPanel && panelOpen;
    if ((place === 'panel') !== inPanel) return null;
    const base = find(card.key) ?? card;
    const back = { kind: 'run-button', key: card.key };
    const node =
      entry.phase === 'missing-folder'
        ? missingFolder({ repo: card.repo, message: entry.message, command: entry.command, onClose: () => apply(closeRunMissingFolder(s, base), back) })
        : runConfirm({
            repo: card.repo,
            number: card.number,
            target: entry.target,
            full: entry.full,
            busy: entry.phase === 'posting',
            onTarget: (target) => apply(chooseRunTarget(s, base, target), { kind: 'popup' }),
            onCancel: () => apply(cancelRun(s, base), back),
            onConfirm: () => apply(confirmRun(s, base)),
          });
    // issue 532: Escape on the confirmation closes only it, not the panel it may sit in.
    node.addEventListener('keydown', (ev) => ev.key === 'Escape' && ev.stopPropagation?.());
    return node;
  }

  function learn() {
    const next = reconcileRuns(s, cards());
    if (next !== s) s = next;
    pollSoon();
  }

  /** issue 532: the board's columns with the card of a run that is booting drawn in Em execução. */
  function columns(source) {
    if (!source || !Object.values(s.runs).some((e) => e.phase === 'booting')) return source;
    const { kept, moved } = movedToRunning(s, source);
    if (!moved.length) return source;
    return kept.map((c) => (c.id === BOOTING_COLUMN ? { ...c, cards: [...moved, ...(c.cards ?? [])], count: (c.count ?? 0) + moved.length } : c));
  }

  /** issue 532: the notice after confirming and the failure of an open that did not work. */
  function notices() {
    const out = [];
    const notice = runNoticeOf(s);
    if (notice) {
      const id = sessionIdOf(find(s.notice.key));
      out.push(runNotice({ ...notice, onOpen: id ? () => openLive(find(s.notice.key)) : null, onClose: () => apply(closeRunNotice(s)) }));
    }
    if (openFailure) {
      const close = el('button', { type: 'button', class: 'btn ghost sm icon-only', 'data-action': 'close-open-failure', 'aria-label': 'Fechar o aviso', onClick: () => ((openFailure = null), redraw()) }, icon('x'));
      out.push(el('div', { class: 'wb-plan-note', role: 'alert', 'data-field': 'open-failure' }, icon('alert'), el('span', {}, openFailure), close));
    }
    return out;
  }

  /** issue 532: after a draw, the focus goes where the person's last action sends it (the confirmation, the run button). */
  function afterDraw() {
    if (!focus) return;
    const { kind, key } = focus;
    focus = null;
    const card = `article[data-key="${key}"]`;
    const target =
      kind === 'run-button'
        ? (area.querySelector('aside.wb-panel button[data-action="run"]') ?? area.querySelector(`${card} button[data-action="run"]`) ?? area.querySelector(card))
        : (area.querySelector('.wb-plan-pop [aria-checked="true"]') ?? area.querySelector('.wb-plan-pop button'));
    target?.focus();
  }

  /** issue 532: what changes what the screen draws from this layer, for its "did it change" check. */
  const signature = () => [s, anchorInPanel, openFailure];

  function stop() {
    alive = false;
    clearTimeout(poll);
  }

  /** issue 532: the seam work-board-issue.js takes: the card as it shows, its parts and the confirmation anchored on it. */
  const seam = {
    card: (card) => cardWithRun(s, card),
    parts: (card, handlers) => cardRunParts(card, { ...handlers, onRun: ask, onOpenSession: openLive }),
    popup,
  };

  return { seam, learn, columns, notices, afterDraw, signature, stop };
}
