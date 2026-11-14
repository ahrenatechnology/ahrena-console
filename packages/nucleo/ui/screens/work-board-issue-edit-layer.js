/* issue 535: the edit mode of the issue panel wired into the live work board (layer 4 of 4, the contract; wireframes 478-1 to 478-3).

 The sibling of work-board-issue.js and work-board-run-layer.js: it keeps the state of work-board-issue-edit-state.js, sends what
 that state asks for (`state.request`, one write at a time: PATCH /api/work/issue, POST /api/work/issue/comments, PATCH, POST and
 DELETE /api/work/issue/steps, POST /api/work/issue/steps/order and /restore) and feeds the answer back (`written` with GitHub's
 issue, `rejected` with the core's error), and reads the issue again when the state asks (`state.reload`, GET with `?refresh=1`).
 The issue layer asks it for the edit panel, for the step count the card shows, and for the focus after a draw.

 Rules this file holds:
 - The /ui never repeats a write by itself (REL-3, follow-up 544). A rejected fetch, a timeout and a 5xx with no body are an
   unknown outcome, `github-unavailable`: the state shows the band and asks for a reload; only the person's click on Tentar de
   novo sends the write again, and never for a comment or a new step, which would be created twice.
 - What is typed goes into the state silently (no redraw, so the field keeps its caret and focus); every other change redraws, and the
   focus is given back to the control the person was on, or to the one that takes its place.
 - Text from GitHub and from the person only goes in as text (the components use textContent). */

import { icon } from '../dom.js';
import { issueEditPanel } from './work-board-issue-edit.js';
import {
  addLabel,
  bodyMode,
  cancelAddStep,
  cancelBody,
  cancelStepEdit,
  chooseMilestone,
  chooseParent,
  chooseTab,
  chooseType,
  finishEdit,
  initialEditState,
  keepGithub,
  moveStep,
  overwrite,
  refusalPlace,
  rejected,
  reloadFailed,
  reloaded,
  removeLabel,
  removeStep,
  retryWrite,
  saveBody,
  saveNewStep,
  saveStep,
  saveTitle,
  startAddStep,
  startEdit,
  startStepEdit,
  stepCount,
  submitComment,
  textToCopy,
  typeBody,
  typeComment,
  typeNewStep,
  typeStepText,
  typeTitle,
  undoRemove,
  written,
} from './work-board-issue-edit-state.js';
import { TYPE_LABELS } from './work-board-parts.js';

/** How long a write may wait for the core before it is given up as an unknown outcome. */
export const WRITE_TIMEOUT_MS = 30_000;

const COPIED = 'Copiado';
const NOT_COPIED = 'Não deu para copiar';
const BAND_TITLES = {
  'github-refused': 'O GitHub recusou a edição.',
  'github-unavailable': 'O GitHub não confirmou a edição.',
  'written-unread': 'O GitHub não confirmou a edição.',
};
const NEUTRAL_TITLE = 'A edição não foi gravada.';
const CLEAR = { value: '', label: '—' };

const unique = (list) => [...new Set(list.filter(Boolean))];
const asList = (nodes) => [...nodes];

/**
 * The failure the state understands, from what the writer threw. A rejected fetch (status 0), a timeout and a 5xx that carries no
 * error code of the core's are an unknown outcome: `github-unavailable`.
 */
function failureOf(err, timedOut) {
  const body = err?.body && typeof err.body === 'object' ? err.body : {};
  const status = err?.status ?? 0;
  if (timedOut || status === 0 || (!body.error && status >= 500)) return { status: status || 502, error: 'github-unavailable', reason: 'timeout' };
  return { status, ...body };
}

const isIssue = (answer) => answer && typeof answer === 'object' && typeof answer.title === 'string' && typeof answer.number === 'number';

/**
 * The edit layer of the board. `ctx` is the screen's (read, write, signal), `area` its root, `redraw()` draws the screen again,
 * `choices()` is `{ cards, options }` of the board (what the details can be set to), `onSaved()` tells the screen GitHub took a
 * change (it reads the board again) and `onFinished(issue)` that Concluir went back to reading, with GitHub's last issue.
 */
export function createEditLayer({ ctx, area, redraw, choices, onSaved = null, onFinished = null }) {
  let e = initialEditState();
  let alive = true;
  let rev = 0;
  let sentRequest = null;
  let sentReload = null;
  /** The error code each refusal came with, for the title of its band. */
  const failures = new WeakMap();
  let focus = null;
  let captured = null;
  /** The step count the card shows for an issue GitHub answered, until the board's own read says the same. */
  const counts = new Map();

  const keyOf = () => (e.open ? `${e.repo}#${e.number}` : null);

  // ---------- the state and what it asks for ----------

  function apply(next, intent = null) {
    if (next === e) return;
    const before = e;
    e = next;
    rev += 1;
    if (intent) focus = intent;
    else if (!before.conflict && e.conflict) focus = { kind: 'conflict' };
    if (e.open && e.issue !== before.issue) counts.set(keyOf(), stepCount(e));
    effects();
    redraw();
  }

  /** What is typed lands in the state with no redraw: the field already shows it. */
  const type = (change) => (text) => {
    e = change(e, text);
  };

  function effects() {
    if (e.request && e.request !== sentRequest) {
      sentRequest = e.request;
      void send(e.request);
    }
    if (e.reload && e.reload !== sentReload) {
      sentReload = e.reload;
      void fetchAgain(e.reload);
    }
  }

  async function send(request) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, WRITE_TIMEOUT_MS);
    timer.unref?.();
    const leave = () => controller.abort();
    ctx.signal?.addEventListener('abort', leave, { once: true });
    try {
      const answer = await ctx.write(request.route, request.body, { method: request.method, signal: controller.signal, jsonBody: true });
      if (!alive) return;
      if (!isIssue(answer)) throw Object.assign(new Error('answer'), { status: 502, body: { error: 'written-unread' } });
      apply(written(e, answer, request.id, Date.now()));
      onSaved?.();
    } catch (err) {
      if (!alive || (err?.name === 'AbortError' && !timedOut)) return;
      const failure = failureOf(err, timedOut);
      const next = rejected(e, failure, request.id);
      if (next.refusal && next.refusal !== e.refusal) failures.set(next.refusal, failure.error ?? null);
      apply(next);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', leave);
    }
  }

  async function fetchAgain(reload) {
    try {
      const issue = await ctx.read(reload.url);
      if (!alive) return;
      if (!isIssue(issue)) throw new Error('answer');
      apply(reloaded(e, issue, reload.id));
    } catch (err) {
      if (!alive || err?.name === 'AbortError') return;
      apply(reloadFailed(e, reload.id));
    }
  }

  // ---------- opening and leaving ----------

  /** Editar: the panel turns into the edit mode on the issue the read answered. */
  function open(issue) {
    apply(startEdit(issue), { kind: 'title' });
  }

  /** Concluir: back to reading, with the issue as GitHub last answered. A write in flight or a conflict keeps the person here. */
  function finish() {
    const next = finishEdit(e);
    if (next === e) return;
    const issue = e.issue;
    e = next;
    rev += 1;
    focus = { kind: 'edit-button' };
    onFinished?.(issue);
  }

  /** The panel closed or went to another issue: the edit is forgotten, nothing is written. */
  function close() {
    if (!e.open) return;
    e = initialEditState();
    rev += 1;
    captured = null;
    focus = null;
  }

  const isOpen = (key) => e.open && keyOf() === key;

  // ---------- the clipboard ----------

  async function copy() {
    const text = textToCopy(e);
    if (text === null) return;
    const action = e.conflict ? 'copy-mine' : 'copy';
    let said;
    try {
      await globalThis.navigator.clipboard.writeText(text);
      said = COPIED;
    } catch {
      said = NOT_COPIED;
    }
    const button = alive ? area.querySelector(`aside.wb-edit-panel button[data-action="${action}"]`) : null;
    if (!button) return;
    button.setAttribute('aria-live', 'polite');
    button.replaceChildren(icon(said === COPIED ? 'done' : 'error'), said);
  }

  // ---------- what the details can be set to ----------

  function details() {
    const { cards = [], options = {} } = choices();
    const issue = e.issue;
    const types = new Map();
    for (const c of cards) if (c.typeName) types.set(c.typeName, TYPE_LABELS[c.type] ?? c.typeName);
    const labels = unique([...(options.labels ?? []).map((l) => l.name), ...(issue.labels ?? [])]);
    const milestones = unique([...cards.map((c) => c.milestone), issue.milestone]);
    const parent = issue.parents?.at(-1);
    const parentKey = parent ? `${parent.repo ?? e.repo}#${parent.number}` : '';
    const parents = new Map();
    for (const o of [...(options.initiatives ?? []), ...(options.epics ?? [])]) parents.set(o.key, `#${o.number}${o.title ? ` ${o.title}` : ''}`);
    if (parent && !parents.has(parentKey)) parents.set(parentKey, `#${parent.number}${parent.title ? ` ${parent.title}` : ''}`);
    return {
      type: { value: issue.type ?? '', options: [...types].map(([value, label]) => ({ value, label })) },
      milestone: { value: issue.milestone ?? '', options: [...(issue.milestone ? [CLEAR] : []), ...milestones.map((value) => ({ value, label: value }))] },
      parent: { value: parentKey, options: [...(parentKey ? [CLEAR] : []), ...[...parents].map(([value, label]) => ({ value, label }))] },
      labels: { values: issue.labels ?? [], options: labels },
    };
  }

  // ---------- the panel ----------

  const SUBJECTS = { title: 'do título', step: 'do passo' };

  function render({ card, now = Date.now(), onClose = null }) {
    const issue = e.issue;
    const place = refusalPlace(e);
    const refused = e.refusal;
    const title = BAND_TITLES[failures.get(refused)] ?? NEUTRAL_TITLE;
    const retry = refused ? refused.retry !== false : true;
    const withText = (change, save) => (value) => apply(save(typeof value === 'string' ? change(e, value) : e));
    return issueEditPanel({
      card,
      issue: { number: e.number, comments: issue.comments, commentsTotal: issue.commentsTotal },
      now,
      savedAt: e.savedAt,
      title: e.title,
      busy: e.busy,
      body: {
        mode: bodyMode(e),
        text: e.conflict ? e.conflict.mine : e.body.text,
        tab: e.body.tab,
        reason: refused?.reason ?? null,
        title,
        retry,
        conflict: e.conflict ? { github: e.conflict.github } : null,
        subject: SUBJECTS[e.conflict?.field] ?? null,
        onTab: (tab) => apply(chooseTab(e, tab)),
        onText: type(typeBody),
        onSave: () => apply(saveBody(e)),
        onCancel: () => apply(cancelBody(e)),
        onRetry: () => apply(retryWrite(e)),
        onCopy: copy,
        onOverwrite: () => apply(overwrite(e)),
        onKeepGithub: () => apply(keepGithub(e), { kind: 'field', field: e.conflict?.field, number: e.conflict?.number }),
        onCopyMine: copy,
      },
      details: details(),
      plan: {
        steps: issue.plan?.steps ?? [],
        editing: e.steps.editing,
        adding: e.steps.adding,
        removed: e.steps.removed,
        onEdit: (step) => apply(startStepEdit(e, step.number), { kind: 'step-input', number: step.number }),
        onEditText: type(typeStepText),
        onEditSave: withText(typeStepText, saveStep),
        onEditCancel: () => apply(cancelStepEdit(e), { kind: 'step-pencil', number: e.steps.editing?.number }),
        onRemove: (step) => apply(removeStep(e, step.number)),
        onUndo: () => apply(undoRemove(e)),
        onMove: (step, toIndex) => apply(moveStep(e, step.number, toIndex)),
        onAdd: () => apply(startAddStep(e), { kind: 'new-step' }),
        onAddText: type(typeNewStep),
        onAddSave: withText(typeNewStep, saveNewStep),
        onAddCancel: () => apply(cancelAddStep(e), { kind: 'add-button' }),
      },
      comment: { text: e.comment.text, onText: type(typeComment), onSubmit: withText(typeComment, submitComment) },
      refusal:
        place && place !== 'body'
          ? { place, reason: refused.reason, title, retry, onRetry: () => apply(retryWrite(e)), onCopy: textToCopy(e) === null ? null : copy }
          : null,
      onTitle: type(typeTitle),
      onTitleSave: withText(typeTitle, saveTitle),
      onType: (value) => apply(chooseType(e, value)),
      onMilestone: (value) => apply(chooseMilestone(e, value)),
      onParent: (value) => apply(chooseParent(e, value)),
      onLabelAdd: (label) => apply(addLabel(e, label)),
      onLabelRemove: (label) => apply(removeLabel(e, label)),
      onDone: finish,
      onClose,
    });
  }

  // ---------- the focus, which a redraw would otherwise lose ----------

  const panelNode = () => area.querySelector('aside.wb-edit-panel');
  const withLabel = (root, name) => asList(root.querySelectorAll('[aria-label]')).find((n) => n.getAttribute('aria-label') === name) ?? null;

  /** Before a draw: what the person is on inside the edit panel (the draw is about to replace it). */
  function capture() {
    const active = globalThis.document?.activeElement;
    const root = panelNode();
    if (!root || !active || !root.contains(active) || active === root) {
      captured = null;
      return;
    }
    captured = {
      id: active.getAttribute?.('id') ?? null,
      label: active.getAttribute?.('aria-label') ?? null,
      action: active.getAttribute?.('data-action') ?? null,
      number: active.closest?.('li')?.getAttribute('data-number') ?? null,
      tag: active.tagName,
    };
  }

  function target(root, intent) {
    switch (intent.kind) {
      case 'title':
        return root.querySelector('input.wb-edit-title');
      case 'conflict':
        return root.querySelector('.wb-edit-conflict');
      case 'new-step':
        return withLabel(root, 'Título do novo passo');
      case 'add-button':
        return root.querySelector('button[data-action="add-step"]');
      case 'step-input':
        return root.querySelector(`li[data-number="${intent.number}"] input`);
      case 'step-pencil':
        return root.querySelector(`li[data-number="${intent.number}"] button[data-action="edit-step"]`);
      case 'field':
        if (intent.field === 'title') return root.querySelector('input.wb-edit-title');
        if (intent.field === 'step') return target(root, { kind: 'step-pencil', number: intent.number });
        return withLabel(root, 'Descrição da issue (Markdown)');
      default:
        return null;
    }
  }

  /** The control the person was on, or the one that took its place; never the page. */
  function restore(root) {
    const c = captured;
    if (!c) return null;
    const byId = c.id ? root.querySelector(`[id="${c.id}"]`) : null;
    if (byId) return byId;
    const byLabel = c.label ? withLabel(root, c.label) : null;
    if (byLabel) return byLabel;
    const inRow = c.number ? `li[data-number="${c.number}"] ` : '';
    const byAction = c.action ? root.querySelector(`${inRow}button[data-action="${c.action}"]`) : null;
    if (byAction) return byAction;
    if (c.number && c.tag === 'INPUT') return root.querySelector(`li[data-number="${c.number}"] button[data-action="edit-step"]`);
    if (c.action === 'remove-step') return root.querySelector('button[data-action="undo"]') ?? root.querySelector('button[data-action="add-step"]');
    if (c.action === 'save-new-step') return root.querySelector('button[data-action="add-step"]');
    return root;
  }

  /** After a draw: the intent of the last action, else the control the person was on. `true` when the focus was placed here. */
  function afterDraw() {
    const intent = focus;
    focus = null;
    const root = panelNode();
    if (intent?.kind === 'edit-button') {
      captured = null;
      const back = area.querySelector('aside.wb-panel button[data-action="edit"]');
      back?.focus();
      return Boolean(back);
    }
    const found = root ? ((intent && target(root, intent)) ?? restore(root)) : null;
    captured = null;
    found?.focus();
    return Boolean(found);
  }

  /** What the board's own read says about each issue: an override the board agrees with is not needed any more. */
  function learn(cards) {
    for (const c of cards) {
      if (!counts.has(c.key)) continue;
      if ((c.plan?.steps ?? 0) === counts.get(c.key)) counts.delete(c.key);
    }
  }

  /** The step count GitHub last answered for the issue, or `null` when the edit mode has not heard of it. */
  const countFor = (key) => (counts.has(key) ? counts.get(key) : null);

  const signature = () => [rev, [...counts]];

  function stop() {
    alive = false;
  }

  return { open, close, isOpen, key: keyOf, render, signature, capture, afterDraw, learn, countFor, stop };
}
