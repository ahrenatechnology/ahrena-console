/* The edit mode of the work board's issue panel (issue 535, wireframes 478-1, 478-2 and 478-3): the same panel, wider,
with the title, the description (Escrever, Pré-visualizar, Salvar), the details that save on choose, the Plan steps, the
comment box, the conflict of a 409 and the refusal band.

Pure render functions over a plain view model and callbacks: no fetch, no state machine. The state layer decides what is
typed, which tab is open, which write is in flight (`busy`, the name of the control that sent it) and what GitHub
answered; this file draws it. The line diff and the clock are above the "DOM" divider, so the test imports them with no DOM.
GitHub-authored text (title, body, comments, steps, labels, the GitHub version) only goes in as text, never as HTML.
The styles are in `work-board-issue-panel.css` (classes `wb-edit-`). */

import { el, icon } from '../dom.js';
import { bodyBlocks, heading, section } from './work-board-issue-panel.js';
import { formatAgo, formatClock, typeLabel, TYPE_LABELS } from './work-board-parts.js';

/** The title of the refusal band when the caller gives none (issue 535). */
const REFUSED_TITLE = 'O GitHub recusou a edição.';
const REFUSED_KEPT = 'O texto continua aqui; nada se perdeu.';
/** The longest middle (lines times lines) the diff compares line by line; past it the whole middle is marked (issue 535). */
const DIFF_CELLS = 4_000_000;

const lines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * "gravado no GitHub às 23:14" from the time the last change reached GitHub (ISO or epoch ms); `null` when unknown,
 * which is before any change.
 */
export function savedAtLabel(at) {
  const clock = formatClock(at);
  return clock ? `gravado no GitHub às ${clock}` : null;
}

/**
 * The line diff of the conflict: both texts as lines, each marked `changed` when the other side does not have it.
 * Common prefix and suffix are trimmed, then the longest common subsequence of the middle decides. Line endings are
 * normalised, so a CRLF text is not "different".
 */
export function diffLines(mine, theirs) {
  const a = lines(mine);
  const b = lines(theirs);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const keepA = new Set();
  const keepB = new Set();
  if (am.length * bm.length <= DIFF_CELLS) {
    const table = Array.from({ length: am.length + 1 }, () => new Array(bm.length + 1).fill(0));
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) table[i][j] = am[i] === bm[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    for (let i = 0, j = 0; i < am.length && j < bm.length; ) {
      if (am[i] === bm[j]) {
        keepA.add(i++);
        keepB.add(j++);
      } else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
    }
  }
  const mark = (all, keep) => all.map((text, i) => ({ text, changed: i >= head && i < all.length - tail && !keep.has(i - head) }));
  return { mine: mark(a, keepA), theirs: mark(b, keepB) };
}

// ---------- DOM: from here, nodes (issue 535) ----------

const ref = (n) => `#${n}`;
const noop = () => {};
const initials = (author) => (String(author ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase();

/** A write in flight disables the control that sent it and marks it busy; the others stay as they were (issue 535). */
const busyAttrs = (busy, name) => (busy === name ? { disabled: true, 'aria-busy': 'true' } : {});

function button({ cls, action, label, name = null, onClick = noop, iconName = null, busy = null, title = null }) {
  return el(
    'button',
    { type: 'button', class: cls, 'data-action': action, 'aria-label': name, title, ...busyAttrs(busy, action), onClick: () => onClick() },
    iconName ? icon(iconName) : null,
    label,
  );
}

function textField(node, value, { onInput = null, onEnter = null, onEscape = null } = {}) {
  node.value = value ?? '';
  if (onInput) node.addEventListener('input', (ev) => onInput(ev.currentTarget.value));
  if (onEnter || onEscape)
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && onEnter) {
        ev.preventDefault?.();
        onEnter(node.value);
      } else if (ev.key === 'Escape' && onEscape) {
        ev.stopPropagation?.();
        onEscape();
      }
    });
  return node;
}

/** The header: type, number, "editando", when the last change reached GitHub, Concluir and close (478-1) (issue 535). */
function editHead({ card, number, savedAt, busy, onDone, onClose }) {
  const saved = savedAtLabel(savedAt);
  return el(
    'div',
    { class: 'wb-panel-head wb-edit-head' },
    el('span', { class: `wb-type wb-type-${TYPE_LABELS[card?.type] ? card.type : 'other'}` }, typeLabel(card)),
    el('span', { class: 'wb-number mono' }, ref(number)),
    el('span', { class: 'wb-pill wb-pill-active wb-edit-badge' }, icon('pencil'), 'editando'),
    saved ? el('span', { class: 'wb-edit-saved', role: 'status' }, icon('done'), saved) : null,
    button({ cls: 'btn outline sm wb-edit-done', action: 'done', label: 'Concluir', onClick: onDone, busy }),
    el('button', { type: 'button', class: 'btn ghost sm icon-only', 'data-action': 'close', 'aria-label': 'Fechar o detalhe', title: 'Fechar o detalhe', onClick: () => onClose?.() }, icon('x')),
  );
}

// ---------- the description: editor, refusal and conflict (issue 535) ----------

/** The refusal band (478-3): GitHub said no. `reason` is a pt-BR sentence the caller built from the answer. */
export function refusalBand({ reason = null, title = REFUSED_TITLE } = {}) {
  return el('div', { class: 'wb-edit-band wb-edit-refusal', role: 'alert' }, icon('shield-alert'), el('div', {}, el('b', {}, title), reason ? ` ${reason}` : null, ` ${REFUSED_KEPT}`));
}

/**
 * The refusal band of a refused write that is not the description's (478-3, issue 535): next to the control that was refused,
 * with Tentar de novo (only when `retry` is not false) and Copiar texto (only when the caller has a text to copy).
 * `refusal` is `{ place, reason, title?, retry?, onRetry?, onCopy? }`; the description's own band is the editor's.
 */
function placeBand(refusal, place, busy) {
  if (!refusal || refusal.place !== place) return null;
  const { reason = null, title = REFUSED_TITLE, retry = true, onRetry = null, onCopy = null } = refusal;
  const acts = [
    retry ? button({ cls: 'btn filled sm', action: 'retry', label: 'Tentar de novo', iconName: 'refresh', onClick: onRetry, busy }) : null,
    onCopy ? button({ cls: 'btn outline sm', action: 'copy', label: 'Copiar texto', iconName: 'copy', onClick: onCopy, busy }) : null,
  ].filter(Boolean);
  return el('div', { class: 'wb-edit-place' }, refusalBand({ reason, title }), acts.length ? el('div', { class: 'wb-edit-row' }, ...acts) : null);
}

function tabs({ number, tab, onTab }) {
  const items = [
    ['write', 'Escrever'],
    ['preview', 'Pré-visualizar'],
  ];
  const list = el(
    'div',
    { class: 'wb-edit-tabs', role: 'tablist', 'aria-label': 'Descrição' },
    ...items.map(([id, label]) =>
      el('button', { type: 'button', class: 'wb-edit-tab', role: 'tab', id: `wb-edit-tab-${id}-${number}`, 'aria-selected': String(tab === id), 'aria-controls': `wb-edit-pane-${number}`, tabindex: tab === id ? '0' : '-1', onClick: () => onTab?.(id) }, label),
    ),
  );
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault?.();
    onTab?.(tab === 'write' ? 'preview' : 'write');
  });
  return list;
}

function editor(body, number, busy) {
  const { text = '', tab = 'write', mode = 'edit', retry = true, onTab = null, onText = null, onSave = null, onCancel = null, onRetry = null, onCopy = null } = body;
  const preview = tab === 'preview';
  const pane = el(
    'div',
    { class: 'wb-edit-pane', role: 'tabpanel', id: `wb-edit-pane-${number}`, 'aria-labelledby': `wb-edit-tab-${preview ? 'preview' : 'write'}-${number}` },
    preview
      ? el('div', { class: 'wb-panel-md wb-edit-preview' }, ...(String(text).trim() ? bodyBlocks(text) : [el('span', { class: 'wb-panel-muted' }, 'Sem descrição.')]))
      : textField(el('textarea', { class: 'wb-edit-textarea', rows: '9', 'aria-label': 'Descrição da issue (Markdown)', spellcheck: 'false' }), text, { onInput: onText }),
  );
  const save = button({ cls: 'btn filled sm', action: 'save-body', label: 'Salvar descrição', iconName: 'done', onClick: onSave, busy });
  const copy = button({ cls: 'btn outline sm', action: 'copy', label: 'Copiar texto', iconName: 'copy', onClick: onCopy, busy });
  // a refusal that cannot be repeated (`retry: false`) has no Tentar de novo: the person saves again, or copies the text (issue 535)
  const acts = mode !== 'refused' ? [save] : retry ? [button({ cls: 'btn filled sm', action: 'retry', label: 'Tentar de novo', iconName: 'refresh', onClick: onRetry, busy }), copy] : [save, copy];
  return [
    mode === 'refused' ? refusalBand(body) : null,
    tabs({ number, tab, onTab }),
    pane,
    el('div', { class: 'wb-edit-row' }, ...acts, button({ cls: 'btn ghost sm', action: 'cancel-body', label: 'Cancelar', onClick: onCancel }), el('span', { class: 'wb-edit-hint' }, 'Markdown')),
  ];
}

function version(label, diff, group) {
  return el(
    'div',
    { class: 'wb-edit-version', role: 'group', 'aria-label': group },
    el('span', { class: 'wb-edit-version-title' }, label),
    el(
      'div',
      { class: 'wb-edit-text' },
      ...diff.map((l) =>
        l.changed ? el('div', { class: 'wb-edit-line', 'data-changed': '' }, el('span', { class: 'wb-edit-sr' }, 'diferente: '), el('mark', { class: 'wb-edit-diff' }, l.text)) : el('div', { class: 'wb-edit-line' }, l.text),
      ),
    ),
  );
}

/**
 * The conflict of a 409 (478-2): the band, the person's version over GitHub's with the differing lines marked (a class,
 * a <mark> and a hidden "diferente", so it is not colour alone) and three exits, none the default. Nothing is written
 * until one is chosen. `conflict.github` is `{ text, author?, updatedAt }`.
 */
export function conflictView({ issueNumber, mine = '', conflict, now = Date.now(), busy = null, subject = null, onOverwrite = null, onKeepGithub = null, onCopyMine = null }) {
  const github = conflict?.github ?? {};
  const diff = diffLines(mine, github.text);
  const when = [github.author, formatAgo(github.updatedAt, now)].filter(Boolean).join(', ');
  const of = subject ? ` ${subject}` : '';
  const exit = (action, label, iconName, onClick) => button({ cls: 'btn outline sm', action, label, iconName, onClick, busy });
  return el(
    'div',
    { class: 'wb-edit-conflict', tabindex: '-1' },
    el('div', { class: 'wb-edit-band', role: 'status' }, icon('git-compare'), el('div', {}, el('b', {}, `A ${ref(issueNumber)} mudou no GitHub enquanto você editava.`), ' Nada foi gravado por cima. Escolha a versão que fica.')),
    version(`A sua versão${of} · não gravada`, diff.mine, 'A sua versão'),
    version(`No GitHub${subject ? `, ${subject}` : ''}${when ? ` · ${when}` : ''}`, diff.theirs, 'A versão do GitHub'),
    el(
      'div',
      { class: 'wb-edit-row wb-edit-exits' },
      exit('overwrite', 'Gravar a minha por cima', 'save', onOverwrite),
      exit('keep-github', 'Ficar com a do GitHub', 'github', onKeepGithub),
      exit('copy-mine', 'Copiar a minha', 'copy', onCopyMine),
    ),
  );
}

function titleField({ title, busy, onTitle, onTitleSave }) {
  const input = el('input', { type: 'text', class: 'wb-edit-title', 'aria-label': 'Título da issue', 'data-action': 'save-title', ...busyAttrs(busy, 'save-title') });
  return textField(input, title, { onInput: onTitle, onEnter: onTitleSave });
}

function descriptionSection({ number, body, now, busy }) {
  const content = body.mode === 'conflict' ? [conflictView({ issueNumber: number, mine: body.text, conflict: body.conflict, now, busy, ...pick(body, 'onOverwrite', 'onKeepGithub', 'onCopyMine', 'subject') })] : editor(body, number, busy);
  return section('description', 'Descrição', heading('Descrição'), ...content);
}

const pick = (obj, ...keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// ---------- the details, saved on choose (issue 535) ----------

function select(name, { value = '', options = [] }, onChange, busy, action) {
  const known = options.some((o) => String(o.value) === String(value));
  const all = known || value === '' || value === null ? options : [{ value, label: String(value) }, ...options];
  const node = el(
    'select',
    { class: 'wb-edit-select', 'aria-label': name, 'data-action': action, ...busyAttrs(busy, action) },
    ...(value === '' || value === null ? [el('option', { value: '', selected: true }, '—')] : []),
    ...all.map((o) => el('option', { value: String(o.value), selected: String(o.value) === String(value) }, o.label)),
  );
  node.value = value ?? '';
  node.addEventListener('change', (ev) => onChange?.(ev.currentTarget.value));
  return node;
}

function labelsField({ values = [], options = [] }, { onLabelAdd, onLabelRemove }, busy) {
  const left = options.filter((o) => !values.includes(o));
  const add = el('select', { class: 'wb-edit-select wb-edit-add-label', 'aria-label': 'Adicionar uma label', 'data-action': 'label', ...busyAttrs(busy, 'label') }, el('option', { value: '', selected: true }, '+ label'), ...left.map((o) => el('option', { value: o }, o)));
  add.value = '';
  add.addEventListener('change', (ev) => ev.currentTarget.value && onLabelAdd?.(ev.currentTarget.value));
  return el(
    'span',
    { class: 'wb-panel-tags' },
    ...values.map((l) => el('span', { class: 'wb-panel-tag wb-edit-chip' }, l, el('button', { type: 'button', class: 'wb-edit-chip-x', 'aria-label': `Tirar a label ${l}`, 'data-action': 'label', ...busyAttrs(busy, 'label'), onClick: () => onLabelRemove?.(l) }, icon('x')))),
    add,
  );
}

function detailsSection({ details = {}, handlers, busy, band = null }) {
  const rows = [
    ['Tipo', select('Tipo', details.type ?? {}, handlers.onType, busy, 'type')],
    ['Labels', labelsField(details.labels ?? {}, handlers, busy)],
    ['Milestone', select('Milestone', details.milestone ?? {}, handlers.onMilestone, busy, 'milestone')],
    ['Pai', select('Pai', details.parent ?? {}, handlers.onParent, busy, 'parent')],
  ];
  return section('details', 'Detalhes', heading('Detalhes', el('span', { class: 'wb-edit-note' }, 'grava ao escolher')), el('dl', { class: 'wb-panel-meta' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), band);
}

// ---------- the Plan steps (issue 535) ----------

function stepRow(step, index, count, plan, dragState) {
  const { editing = null, busy = null, onEdit, onRemove, onMove, onEditText, onEditSave, onEditCancel } = plan;
  const n = index + 1;
  const open = editing?.number === step.number;
  const grip = el('button', { type: 'button', class: 'wb-edit-grip', 'data-action': 'grip', draggable: 'true', 'aria-label': `Reordenar o passo ${n}: ${step.title}`, title: 'Arraste, ou use as setas' }, icon('grip-vertical'));
  grip.addEventListener('keydown', (ev) => {
    const to = ev.key === 'ArrowUp' ? index - 1 : ev.key === 'ArrowDown' ? index + 1 : null;
    if (to === null) return;
    ev.preventDefault?.();
    if (to >= 0 && to < count) onMove?.(step, to);
  });
  grip.addEventListener('dragstart', (ev) => {
    dragState.from = step;
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer?.setData?.('text/plain', String(step.number));
  });
  const row = el('li', { 'data-number': String(step.number), 'data-state': step.state === 'CLOSED' ? 'closed' : 'open', class: open ? 'wb-edit-editing' : null });
  row.addEventListener('dragover', (ev) => dragState.from && ev.preventDefault?.());
  row.addEventListener('drop', (ev) => {
    ev.preventDefault?.();
    const from = dragState.from;
    dragState.from = null;
    if (from && from.number !== step.number) onMove?.(from, index);
  });
  if (open) {
    const input = textField(el('input', { type: 'text', class: 'wb-edit-input', 'aria-label': `Título do passo ${n}` }), editing.text, { onInput: onEditText, onEnter: onEditSave, onEscape: onEditCancel });
    row.append(grip, el('span', { class: 'wb-edit-step-n' }, String(n)), input, button({ cls: 'btn filled sm', action: 'save-step', label: 'Salvar', onClick: onEditSave, busy }));
    return row;
  }
  const label = `o passo ${n}: ${step.title}`;
  row.append(
    grip,
    el('span', { class: 'wb-edit-step-n' }, String(n)),
    el('span', { class: 'wb-panel-step-title', title: step.title }, step.title),
    el(
      'span',
      { class: 'wb-panel-step-ref' },
      el('span', { class: 'mono' }, ref(step.number)),
      el('button', { type: 'button', class: 'wb-edit-icon', 'data-action': 'edit-step', 'aria-label': `Editar ${label}`, onClick: () => onEdit?.(step) }, icon('pencil')),
      el('button', { type: 'button', class: 'wb-edit-icon', 'data-action': 'remove-step', 'aria-label': `Remover ${label}`, ...busyAttrs(busy, `remove:${step.number}`), onClick: () => onRemove?.(step) }, icon('trash')),
    ),
  );
  return row;
}

function planSection(plan = {}) {
  const { steps = [], adding = null, removed = null, busy = null, band = null, onAdd, onAddText, onAddSave, onAddCancel, onUndo } = plan;
  const dragState = { from: null };
  const right = el('span', { class: 'wb-panel-sec-note' }, icon('list-checks'), 'sub-issues Plan');
  const add = adding
    ? el(
        'li',
        { class: 'wb-edit-new-step' },
        icon('plus'),
        textField(el('input', { type: 'text', class: 'wb-edit-input', 'aria-label': 'Título do novo passo' }), adding.text, { onInput: onAddText, onEnter: onAddSave, onEscape: onAddCancel }),
        button({ cls: 'btn filled sm', action: 'save-new-step', label: 'Salvar', onClick: onAddSave, busy }),
      )
    : el('li', { class: 'wb-edit-add-step' }, el('button', { type: 'button', class: 'wb-edit-add', 'data-action': 'add-step', onClick: () => onAdd?.() }, icon('plus'), 'Acrescentar passo'));
  const notice = removed
    ? el('div', { class: 'wb-edit-notice', role: 'status' }, el('span', {}, `Passo “${removed.title}” removido.`), button({ cls: 'btn outline sm', action: 'undo', label: 'Desfazer', onClick: onUndo, busy }))
    : null;
  return section(
    'plan',
    'Plano',
    heading(`Plano · ${plural(steps.length, 'passo', 'passos')}`, right),
    el('ol', { class: 'wb-edit-steps', 'aria-label': 'Passos do plano' }, ...steps.map((s, i) => stepRow(s, i, steps.length, plan, dragState)), add),
    notice,
    band,
    el('span', { class: 'wb-edit-hint' }, 'Arraste para reordenar. Remover fecha a sub-issue como “not planned” no GitHub, com Desfazer.'),
  );
}

// ---------- the comments (issue 535) ----------

function commentsSection({ issue = {}, comment = {}, now, busy, band = null }) {
  const comments = issue.comments ?? [];
  const items = comments.map((c) => {
    const ago = formatAgo(c.createdAt, now);
    return el(
      'div',
      { class: 'wb-panel-comment' },
      el('span', { class: 'wb-panel-avatar', 'aria-hidden': 'true' }, initials(c.author)),
      el('span', {}, el('b', {}, c.author ?? 'ghost'), ago ? el('small', {}, ` · ${ago}`) : null, el('span', { class: 'wb-panel-comment-text' }, c.body)),
    );
  });
  const box = textField(el('textarea', { class: 'wb-edit-textarea wb-edit-comment', rows: '3', placeholder: 'Escreva um comentário (Markdown)…', 'aria-label': 'Escreva um comentário (Markdown)…' }), comment.text, { onInput: comment.onText });
  const send = button({ cls: 'btn outline sm', action: 'comment', label: 'Comentar', iconName: 'conversation', busy });
  send.addEventListener('click', () => comment.onSubmit?.(box.value));
  return section('comments', 'Comentários', heading(`Comentários · ${issue.commentsTotal ?? comments.length}`), ...items, box, band, el('div', { class: 'wb-edit-row wb-edit-end' }, send));
}

/**
 * The panel in edit mode (478-1), and in its conflict (478-2) and refused (478-3) states through `body.mode`.
 *
 * - `card`, `issue` (`number`, `comments`, `commentsTotal`), `now`, `savedAt` (when the last change reached GitHub), `title`.
 * - `body`: `{ mode: 'edit' | 'conflict' | 'refused', text, tab: 'write' | 'preview', reason, conflict, onTab, onText, onSave, onCancel,
 *   onRetry, onCopy, onOverwrite, onKeepGithub, onCopyMine }`.
 * - `details`: `{ type, milestone, parent: { value, options: [{ value, label }] }, labels: { values, options } }`, with
 *   `onType`, `onMilestone`, `onParent`, `onLabelAdd`, `onLabelRemove`.
 * - `plan`: `{ steps, editing: { number, text }, adding: { text }, removed: { number, title } }`, with `onEdit`, `onEditText`,
 *   `onEditSave`, `onEditCancel`, `onRemove`, `onUndo`, `onMove(step, toIndex)`, `onAdd`, `onAddText`, `onAddSave`, `onAddCancel`.
 * - `refusal`: `{ place: 'title' | 'body' | 'details' | 'plan' | 'comment', reason, title?, retry?, onRetry?, onCopy? }`, the refused write: its band is drawn next to
 *   the control (the description's is the editor's, through `body.mode: 'refused'`); `retry: false` hides Tentar de novo, no `onCopy` hides Copiar texto.
 * - `comment`: `{ text, onText, onSubmit }`; `busy`: the control that sent a write (`save-body`, `save-title`, `type`, `milestone`,
 *   `parent`, `label`, `save-step`, `save-new-step`, `remove:<number>`, `undo`, `comment`, `retry`, `overwrite`, `keep-github`, `done`).
 */
export function issueEditPanel({ card = null, issue = {}, now = Date.now(), savedAt = null, title = '', body = {}, details = {}, plan = {}, comment = {}, refusal = null, busy = null, onTitle = null, onTitleSave = null, onType = null, onMilestone = null, onParent = null, onLabelAdd = null, onLabelRemove = null, onDone = null, onClose = null } = {}) {
  const number = issue.number ?? card?.number;
  return el(
    'aside',
    { class: 'card wb-panel wb-edit-panel', role: 'dialog', 'aria-label': `Edição da issue ${ref(number)}` },
    editHead({ card, number, savedAt, busy, onDone, onClose }),
    titleField({ title, busy, onTitle, onTitleSave }),
    placeBand(refusal, 'title', busy),
    descriptionSection({ number, body, now, busy }),
    detailsSection({ details, handlers: { onType, onMilestone, onParent, onLabelAdd, onLabelRemove }, busy, band: placeBand(refusal, 'details', busy) }),
    planSection({ ...plan, busy, band: placeBand(refusal, 'plan', busy) }),
    commentsSection({ issue, comment, now, busy, band: placeBand(refusal, 'comment', busy) }),
  );
}
