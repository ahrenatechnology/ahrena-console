// What a click on a `.btn` gives back (issue 435): one helper for busy, done and failed, so no screen
// invents its own. The look is the component's (shell.css); this file only sets the attributes it styles.
//
// | State    | On the button                                                   | Clicks   |
// | -------- | --------------------------------------------------------------- | -------- |
// | busy     | aria-busy="true" + aria-disabled="true" (never `disabled`)      | ignored  |
// | done     | data-state="done", the done label, back to normal after DONE_MS | normal   |
// | failed   | data-state="failed", the retry label, a note with the error     | retry    |
// | disabled | aria-disabled="true" and the reason in `title` (and a note)     | ignored  |
//
// Busy keeps the focus (the button is never `disabled`), keeps the width (so the row does not jump)
// and leaves the label alone unless `busyLabel` says what is going on ("Reiniciando…").

import { el, icon } from './dom.js';

/** How long "done" stays on the button before it goes back to normal. */
export const DONE_MS = 2000;

const FAILED_LABEL = 'Tentar de novo';
const FALLBACK_ERROR = 'Não deu certo. Tente de novo.';

/** The error in plain words: the message of a thrown `Error`, else the fallback. Never a stack. */
export function plainError(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text || FALLBACK_ERROR;
}

/** The state a button is in, from its attributes (`idle` when none is set). */
export function buttonStateOf(button) {
  if (button.getAttribute('aria-busy') === 'true') return 'busy';
  const state = button.getAttribute('data-state');
  if (state === 'done' || state === 'failed') return state;
  if (button.getAttribute('aria-disabled') === 'true' || button.hasAttribute?.('disabled')) return 'disabled';
  return 'idle';
}

/** Marks the button busy (or not), without `disabled`: the keyboard focus stays on it. */
export function setBusy(button, busy, { keepWidth = false } = {}) {
  if (busy) {
    const width = button.offsetWidth;
    if (width) button.style.setProperty('min-width', `${width}px`);
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    if (!keepWidth) button.style.removeProperty('min-width');
  }
}

/**
 * Disables the button with its reason: `reason` goes in `title` (and in the accessible name through
 * `aria-describedby` when `describedBy` is the id of a visible note). `null` enables it again.
 * A disabled button without a reason is a defect: pass the reason or leave the button enabled.
 */
export function setDisabled(button, reason, { describedBy = null } = {}) {
  if (reason) {
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('title', reason);
    if (describedBy) button.setAttribute('aria-describedby', describedBy);
  } else {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('title');
    button.removeAttribute('aria-describedby');
  }
}

/** The note beside a button: a short sentence, `error` in red (announced at once), else muted. */
export function buttonNote(text, { tone = 'info', iconName = null } = {}) {
  const error = tone === 'error';
  return el('span', { class: 'btn-note', 'data-tone': tone, role: error ? 'alert' : 'status', 'aria-live': error ? null : 'polite' }, iconName ? icon(iconName) : null, text);
}

function rememberChildren(button) {
  if (!button.btnOriginal) button.btnOriginal = [...button.childNodes];
}

function restoreChildren(button) {
  if (button.btnOriginal) button.replaceChildren(...button.btnOriginal);
  button.btnOriginal = null;
}

/** The label (and the icon, when the state has one) shown while a state lasts. */
function showLabel(button, label, iconName) {
  rememberChildren(button);
  const hasIcon = button.btnOriginal.some((n) => n.classList?.contains('icon'));
  button.replaceChildren(...[iconName && hasIcon ? icon(iconName) : null, label].filter((x) => x !== null && x !== ''));
}

function removeNote(button) {
  const held = button.btnNote;
  if (held) held.owned ? held.node.remove() : held.node.replaceChildren();
  button.btnNote = null;
}

function placeNote(button, note) {
  const parent = button.parentNode;
  if (!parent) return;
  const kids = Array.from(parent.childNodes);
  parent.insertBefore(note, kids[kids.indexOf(button) + 1] ?? null);
}

function reset(button) {
  clearTimeout(button.btnTimer);
  button.btnTimer = null;
  button.removeAttribute('data-state');
  restoreChildren(button);
}

/**
 * Runs `action` for a click on `button`: busy while it runs, then done (and back to normal after
 * `doneMs`) or failed (the button reads "Tentar de novo" and a note says what went wrong in plain
 * words, until the next click). A click while busy or disabled does nothing and returns `{ ignored: true }`.
 * Otherwise the answer is `{ ok: true, value }` or `{ ok: false, error }`; the action's own error
 * never escapes, so a handler can `await` this without a try/catch.
 *
 * `options`: `busyLabel` (the label while busy), `doneLabel` (default: the label stays), `failedLabel`,
 * `errorText(error)` (default `plainError`), `doneMs`, `note` (an element to hold the error; default:
 * one inserted right after the button). An `AbortError` is not a failure: the button goes back to normal.
 */
export async function runButtonAction(button, action, { busyLabel = null, doneLabel = null, failedLabel = FAILED_LABEL, errorText = plainError, doneMs = DONE_MS, note = null } = {}) {
  const before = buttonStateOf(button);
  if (before === 'busy' || before === 'disabled') return { ignored: true };
  reset(button);
  removeNote(button);
  setBusy(button, true);
  if (busyLabel) showLabel(button, busyLabel, null);
  let result;
  try {
    result = { ok: true, value: await action() };
  } catch (error) {
    result = { ok: false, error };
  }
  // The width lock stays until the final label is on the button, so the row does not jump in between.
  setBusy(button, false, { keepWidth: true });
  const releaseWidth = () => button.style.removeProperty('min-width');
  if (result.ok) {
    if (!doneLabel) return (restoreChildren(button), releaseWidth(), result);
    button.setAttribute('data-state', 'done');
    showLabel(button, doneLabel, 'check-circle-2');
    releaseWidth();
    button.btnTimer = setTimeout(() => reset(button), doneMs);
    button.btnTimer?.unref?.();
    return result;
  }
  if (result.error?.name === 'AbortError') return (restoreChildren(button), releaseWidth(), result);
  button.setAttribute('data-state', 'failed');
  showLabel(button, failedLabel, 'error');
  releaseWidth();
  const message = buttonNote(errorText(result.error), { tone: 'error', iconName: 'error' });
  button.btnNote = { node: note ?? message, owned: !note };
  if (note) note.replaceChildren(...message.childNodes);
  else placeNote(button, message);
  return result;
}
