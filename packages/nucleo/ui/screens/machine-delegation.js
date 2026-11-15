// The components of "Delegar ao Claude" on a saturation alert (issue 568, wireframe 566-17 and 566-18, and the button of
// 566-4, 566-5, 566-8, 566-11 and 566-12), drawn from plain data. No read, no POST, no timer and no screen state are
// here: each function draws one state, and the buttons call the handlers the state layer gives.
//
//   delegateButton({ emphasis }, { onDelegate })       the button; `emphasis` is `primary` or `secondary`
//   delegateOffer({ cause, remote, host }, { onDelegate })   the Resolver's row: title, line and the button
//   delegateDialog(view, handlers)                     the dialog in one state, inside its veil
//   delegateStatus({ via })                            "aberto", beside the alert's button
//   focusDelegateDialog(root)                          puts the focus in a drawn dialog
//
// `view` of the dialog: `state` (loading, ready, opening, closed, changed, too-large, unsupported, failed), `alertId`,
// `remote`, `host` (the SSH host, for the Workstation's sentences), `label` (the machine's name on screen), `via`,
// `preview` (`{ prompt, size }`), `noDiagnosis`, `failure` (`{ reason }`, a stable code), `copied`.
// `handlers`: `onSelect(via)`, `onOpen`, `onCopy`, `onCancel`. The words are in `machine-delegation-format.js`.

import { el, icon } from '../dom.js';
import {
  DELEGATE_LABEL,
  OFFER_TITLE,
  SIZE_NOTE,
  defaultVia,
  delegateEmphasis,
  failedText,
  noteIsAlert,
  noteState,
  noteText,
  offerText,
  openLabel,
  openedText,
  promptParts,
  sizeLine,
  targetsFor,
} from './machine-delegation-format.js';

/** The id of the dialog's title, which the dialog names in `aria-labelledby`; one dialog is open at a time. */
export const delegateTitleId = 'dg-delegate-title';

/** The button "Delegar ao Claude": cheio (`primary`) or contorno (`secondary`). */
export function delegateButton({ emphasis = 'secondary' } = {}, { onDelegate } = {}) {
  const primary = emphasis === 'primary';
  return el(
    'button',
    { type: 'button', class: `btn ${primary ? 'filled' : 'outline'} tm-dl-btn`, 'data-dg-action': 'delegate', 'data-emphasis': primary ? 'primary' : 'secondary', onClick: onDelegate },
    icon('bot'),
    DELEGATE_LABEL,
  );
}

/** The Resolver's row: the cause decides the emphasis and the title (Q15, Q16). */
export function delegateOffer({ cause, remote = false, host = null } = {}, handlers = {}) {
  const emphasis = delegateEmphasis(cause);
  return el(
    'div',
    { class: `tm-dl-offer${emphasis === 'primary' ? ' tm-dl-pri' : ''}`, 'data-part': 'delegate-offer' },
    icon('bot'),
    el('div', {}, el('b', {}, OFFER_TITLE[emphasis]), el('small', {}, offerText({ remote, host }))),
    delegateButton({ emphasis }, handlers),
  );
}

/** "Aberto": the session opened and the person still has to send; a polite status, so it is read without taking the focus. */
export function delegateStatus({ via = 'desktop' } = {}) {
  return el('span', { class: 'tm-dl-status', 'data-part': 'delegate-status', 'data-dg-state': 'opened', 'data-via': via, role: 'status' }, icon('check-circle-2'), openedText(via));
}

const mono = (text) => el('span', { class: 'mono' }, text);

function targetRow(t, checked, onSelect) {
  return el(
    'button',
    { type: 'button', role: 'radio', 'aria-checked': String(checked), class: `tm-dl-opt${checked ? ' tm-dl-on' : ''}`, 'data-dg-target': t.via, onClick: () => onSelect?.(t.via) },
    el('span', { class: 'tm-dl-dot', 'aria-hidden': 'true' }, checked ? icon('check-circle-2') : null),
    el(
      'span',
      { class: 'tm-dl-opt-b' },
      el('span', { class: 'tm-dl-opt-t' }, el('b', {}, t.title), t.tag ? el('span', { class: 'chip' }, t.tag) : null),
      el('span', { class: 'tm-dl-opt-d' }, t.text, t.host ? [' ', mono(t.host), ' ', t.tail] : null),
    ),
  );
}

function promptBlock(preview) {
  const parts = promptParts(preview.prompt).map((p) => {
    if (p.kind === 'tag') return el('span', { class: 'tm-dl-tag' }, p.text);
    if (p.kind === 'data') return el('span', { class: 'tm-dl-data' }, p.text);
    return el('span', {}, p.text);
  });
  return el('pre', { class: 'tm-dl-prompt', 'data-part': 'delegate-prompt', tabindex: '0', 'aria-label': 'O prompt' }, ...parts);
}

const promptSkeleton = () => el('div', { class: 'tm-dl-prompt tm-dl-skel tm-dg-skel', 'aria-hidden': 'true', 'data-part': 'delegate-prompt-loading' }, ...[0, 1, 2, 3].map((i) => el('i', { class: `tm-dg-w${i}` })));

/** The note's text with the drawing's bold on "não é enviado". */
function noteBody(text) {
  const at = text.indexOf('não é enviado');
  if (at < 0) return text;
  return [text.slice(0, at), el('b', {}, 'não é enviado'), text.slice(at + 'não é enviado'.length)];
}

function note(state, via, failure, host) {
  const own = noteState(state);
  const alert = noteIsAlert(own);
  const base = { class: `tm-dl-note${alert ? ' tm-dl-err' : ''}`, 'data-part': 'delegate-note', 'data-dg-state': own };
  if (own === 'failed') {
    const f = failedText({ reason: failure?.reason, host });
    return el('div', { ...base, role: 'alert' }, icon('error'), el('span', {}, f.before, ' ', f.text));
  }
  if (alert) return el('div', { ...base, role: 'alert' }, icon('error'), el('span', {}, noteText(own, { via })));
  const calm = own === 'ready' ? { icon: 'shield-check' } : { icon: own === 'closed' ? 'check-circle-2' : 'info', role: 'status' };
  return el('div', { ...base, role: calm.role }, icon(calm.icon), el('span', {}, noteBody(noteText(own, { via }))));
}

/** The dialog 566-17 in one state, inside its veil; the caller appends it to the page. */
export function delegateDialog(view = {}, handlers = {}) {
  const { state = 'ready', alertId = '', remote = false, host = null, label = remote ? 'Workstation' : 'Esta máquina', preview = null, noDiagnosis = false, failure = null, copied = false } = view;
  const targets = targetsFor({ remote, host });
  const via = targets.some((t) => t.via === view.via) ? view.via : defaultVia({ remote });
  const loading = state === 'loading';
  const opening = state === 'opening';
  const hint = preview ? sizeLine({ size: preview.size, noDiagnosis, via }) : null;
  const canAsk = state !== 'closed';
  const copyLabel = copied ? 'Copiado' : 'Copiar o prompt';

  const dialog = el(
    'div',
    { class: 'card tm-dl-dialog', 'data-part': 'delegate-dialog', 'data-dg-state': state, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': delegateTitleId, 'aria-busy': loading ? 'true' : null },
    el(
      'div',
      { class: 'tm-dl-head' },
      icon('bot'),
      el('b', { id: delegateTitleId }, DELEGATE_LABEL),
      el('span', { class: 'tm-muted' }, alertId ? `${label} · ${alertId}` : label),
      el('button', { type: 'button', class: 'btn ghost icon-only tm-dl-x', 'aria-label': 'Fechar', 'data-dg-action': 'delegate-close', onClick: handlers.onCancel }, icon('x')),
    ),
    el('div', { class: 'tm-dl-sec' }, el('div', { class: 'eyebrow' }, 'Onde abrir'), el('div', { role: 'radiogroup', 'aria-label': 'Onde abrir', class: 'tm-dl-opts', 'data-part': 'delegate-targets' }, ...targets.map((t) => targetRow(t, t.via === via, handlers.onSelect)))),
    el(
      'div',
      { class: 'tm-dl-sec' },
      el('div', { class: 'eyebrow' }, 'O prompt, exatamente como vai'),
      loading || !preview ? promptSkeleton() : promptBlock(preview),
      hint ? el('span', { class: 'tm-dl-hint' }, `${hint} · ${SIZE_NOTE}`) : null,
    ),
    note(state, via, failure, host),
    el(
      'div',
      { class: 'tm-dl-actions' },
      el('button', { type: 'button', class: 'btn outline', 'data-dg-action': 'delegate-copy', disabled: !preview || loading, onClick: handlers.onCopy }, icon(copied ? 'check-circle-2' : 'copy'), copyLabel),
      el('button', { type: 'button', class: 'btn outline', 'data-dg-action': 'delegate-cancel', onClick: handlers.onCancel }, 'Cancelar'),
      canAsk
        ? el('button', { type: 'button', class: 'btn filled', 'data-dg-action': 'delegate-open', disabled: loading || opening || !preview, onClick: handlers.onOpen }, icon(opening ? 'wall-loader' : state === 'failed' ? 'refresh' : 'external'), openLabel(state, via))
        : null,
    ),
  );
  return el('div', { class: 'tm-dl-veil', role: 'presentation' }, dialog);
}

/** Puts the focus in a drawn dialog: on the checked target, or on the first button when the targets are not there. */
export function focusDelegateDialog(root) {
  const first = root?.querySelector?.('[data-dg-target][aria-checked="true"]') ?? root?.querySelector?.('button');
  first?.focus?.();
  return first ?? null;
}
