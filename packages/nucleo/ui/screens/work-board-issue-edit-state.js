/* issue 535: the state behind the edit mode of the work board's issue panel (layer 3 of 4, wireframes 478-1, 478-2, 478-3).

Pure transitions, like work-board-issue-state.js: state and inputs in, new state out; no DOM, no fetch, no clock. The screen
reads `state.request` (what to send: `{ id, method, route, body, control }`) and `state.reload` (a GET of the issue, `?refresh=1`),
sends it, and hands the answer back to `written`, `rejected`, `reloaded` or `reloadFailed` with the request's `id`; an answer for
an older id is ignored. The panel shows GitHub's answer only: what was typed stays in its field until a write is answered.

Rules the transitions hold:
- One write in flight (`busy` is the control that sent it), and none while a conflict is open: a 409 writes nothing until
  the person chooses one of its three exits.
- The /ui never retries a write by itself (REL-3, follow-up 544). After `github-unavailable` or `written-unread` the state asks
  for a reload with `?refresh=1`; `retryWrite` is only the person's click on the refusal band, and `written-unread` offers none.
- A title, body or step edit carries the `updatedAt` it was opened at; one that is empty (cached before the field existed)
  asks for a reload first. */

export const ISSUE_ROUTE = '/api/work/issue';
export const COMMENTS_ROUTE = '/api/work/issue/comments';
export const STEPS_ROUTE = '/api/work/issue/steps';
export const STEPS_ORDER_ROUTE = '/api/work/issue/steps/order';
export const STEPS_RESTORE_ROUTE = '/api/work/issue/steps/restore';

const CLOSED = { open: false };
const stepKey = (state, number) => `${state.repo}#${number}`;
const stepsOf = (state) => state.issue?.plan?.steps ?? [];

/** The issue as no edit has begun: nothing open. (issue 535) */
export function initialEditState() {
  return CLOSED;
}

/** Editar: the edit mode opens on the issue GET /api/work/issue answered (`issue.repo`, `number`, `title`, `body`, `updatedAt`, `plan`). (issue 535) */
export function startEdit(issue) {
  return {
    open: true,
    repo: issue.repo,
    number: issue.number,
    issue,
    savedAt: null,
    title: issue.title ?? '',
    bases: { title: issue.updatedAt ?? '', body: issue.updatedAt ?? '' },
    body: { text: issue.body ?? '', tab: 'write' },
    steps: { editing: null, adding: null, removed: null },
    comment: { text: '' },
    busy: null,
    request: null,
    last: null,
    reload: null,
    versionTried: [],
    refusal: null,
    conflict: null,
    seq: 0,
  };
}

/** Concluir: back to reading. Not while a write is in flight or a conflict waits for a choice. (issue 535) */
export function finishEdit(state) {
  return !state.open || state.busy || state.conflict ? state : CLOSED;
}

// ---------- requests (issue 535) ----------

const reloadOf = (state, key = null) => {
  if (state.reload) return state;
  const id = state.seq + 1;
  return { ...state, seq: id, reload: { id, key, url: `${ISSUE_ROUTE}?repo=${encodeURIComponent(state.repo)}&number=${state.number}&refresh=1` } };
};

function write(state, control, method, route, body, meta = null) {
  if (!state.open || state.busy || state.conflict) return state;
  const id = state.seq + 1;
  const request = { id, method, route, body: { repo: state.repo, number: state.number, ...body }, control, meta };
  return { ...state, seq: id, busy: control, request, last: request, refusal: null };
}

/** A title, body or step edit needs the version it was opened at; with none, the issue is read again first and nothing is written. (issue 535) */
const needsVersion = (version) => !version;

/**
 * No version: one reload (`key` names the field it is for). If that reload already came back and the version is still empty,
 * the save stops asking and shows the generic refusal band; no write is made without a version (issue 535, finding 4).
 */
function withoutVersion(state, control, key) {
  if (!state.versionTried.includes(key)) return reloadOf(state, key);
  return { ...state, refusal: { control, place: placeOf(control), reason: reasonOf({}), retry: false } };
}

// ---------- title and description (issue 535) ----------

export const typeTitle = (state, text) => (state.open ? { ...state, title: text } : state);

/** Enter on the title: PATCH `{ title, updatedAt }`; blank or unchanged writes nothing. (issue 535) */
export function saveTitle(state) {
  if (!state.open || state.busy || state.conflict) return state;
  const title = state.title.trim();
  if (!title || title === state.issue.title) return state;
  if (needsVersion(state.bases.title)) return withoutVersion(state, 'save-title', 'title');
  return write(state, 'save-title', 'PATCH', ISSUE_ROUTE, { title, updatedAt: state.bases.title }, { text: title });
}

export const typeBody = (state, text) => (state.open ? { ...state, body: { ...state.body, text } } : state);
export const chooseTab = (state, tab) => (state.open && (tab === 'write' || tab === 'preview') ? { ...state, body: { ...state.body, tab } } : state);

/** Salvar descrição: PATCH `{ body, updatedAt }`; unchanged writes nothing. (issue 535) */
export function saveBody(state) {
  if (!state.open || state.busy || state.conflict || state.body.text === state.issue.body) return state;
  if (needsVersion(state.bases.body)) return withoutVersion(state, 'save-body', 'body');
  return write(state, 'save-body', 'PATCH', ISSUE_ROUTE, { body: state.body.text, updatedAt: state.bases.body }, { text: state.body.text });
}

/** Cancelar: the description goes back to GitHub's. (issue 535) */
export const cancelBody = (state) => (state.open && !state.busy && !state.conflict ? { ...state, refusal: null, body: { ...state.body, text: state.issue.body ?? '' } } : state);

// ---------- the details, saved on choose (issue 535) ----------

const patch = (state, control, fields) => write(state, control, 'PATCH', ISSUE_ROUTE, fields);
const orNull = (v) => (v === '' || v === undefined ? null : v);

export function chooseType(state, value) {
  return !state.open || orNull(value) === state.issue.type ? state : patch(state, 'type', { type: orNull(value) });
}
export function chooseMilestone(state, value) {
  return !state.open || orNull(value) === state.issue.milestone ? state : patch(state, 'milestone', { milestone: orNull(value) });
}
/** The parent is saved alone, as the core asks (an `owner/name#N` key, or `null`). (issue 535) */
export function chooseParent(state, value) {
  const current = state.issue?.parents?.at(-1);
  const now = current ? `${current.repo ?? state.repo}#${current.number}` : null;
  return !state.open || orNull(value) === now ? state : patch(state, 'parent', { parent: orNull(value) });
}
export function addLabel(state, label) {
  const labels = state.issue?.labels ?? [];
  return !state.open || !label || labels.includes(label) ? state : patch(state, 'label', { labels: [...labels, label] });
}
export function removeLabel(state, label) {
  const labels = state.issue?.labels ?? [];
  return !state.open || !labels.includes(label) ? state : patch(state, 'label', { labels: labels.filter((l) => l !== label) });
}

// ---------- the Plan steps (issue 535) ----------

const withSteps = (state, patchSteps) => ({ ...state, steps: { ...state.steps, ...patchSteps } });
const stepOf = (state, number) => stepsOf(state).find((s) => s.number === number);

/** The pencil on a step: the row turns into a field. A step with no `updatedAt` asks for a reload with `?refresh=1` first. (issue 535) */
export function startStepEdit(state, number) {
  const step = state.open ? stepOf(state, number) : null;
  if (!step || state.busy || state.conflict) return state;
  if (needsVersion(step.updatedAt)) return withoutVersion(state, 'save-step', `step:${number}`);
  return withSteps(state, { editing: { number, text: step.title, base: step.updatedAt }, adding: null });
}
export const typeStepText = (state, text) => (state.steps?.editing ? withSteps(state, { editing: { ...state.steps.editing, text } }) : state);
export const cancelStepEdit = (state) => (state.steps?.editing && !state.busy && !state.conflict ? { ...withSteps(state, { editing: null }), refusal: null } : state);
/** Salvar on a step: PATCH `{ step, updatedAt, title }`; blank or unchanged writes nothing. (issue 535) */
export function saveStep(state) {
  const editing = state.steps?.editing;
  if (!editing || state.busy || state.conflict) return state;
  const title = editing.text.trim();
  const step = stepOf(state, editing.number);
  if (!title || title === step?.title) return state;
  return write(state, 'save-step', 'PATCH', STEPS_ROUTE, { step: stepKey(state, editing.number), updatedAt: editing.base, title }, { number: editing.number, text: title });
}

export const startAddStep = (state) => (state.open && !state.busy && !state.conflict ? withSteps(state, { adding: { text: '' }, editing: null }) : state);
export const typeNewStep = (state, text) => (state.steps?.adding ? withSteps(state, { adding: { text } }) : state);
export const cancelAddStep = (state) => (state.steps?.adding && !state.busy && !state.conflict ? { ...withSteps(state, { adding: null }), refusal: null } : state);
/** Salvar on the new step: POST `{ title }`; blank writes nothing. (issue 535) */
export function saveNewStep(state) {
  const title = state.steps?.adding?.text.trim();
  return title ? write(state, 'save-new-step', 'POST', STEPS_ROUTE, { title }) : state;
}

/** The handle: the step goes to `toIndex` of the plan. POST `{ step, after }`, `after` the step it goes behind or `null` for the top. (issue 535) */
export function moveStep(state, number, toIndex) {
  const steps = stepsOf(state);
  const from = steps.findIndex((s) => s.number === number);
  if (!state.open || from < 0 || toIndex === from || toIndex < 0 || toIndex >= steps.length) return state;
  const others = steps.filter((s) => s.number !== number);
  const after = toIndex === 0 ? null : stepKey(state, others[toIndex - 1].number);
  return write(state, `move:${number}`, 'POST', STEPS_ORDER_ROUTE, { step: stepKey(state, number), after });
}

/** Remover: DELETE at once (no deferred delete); the notice with Desfazer appears when GitHub answers. (issue 535) */
export function removeStep(state, number) {
  const step = state.open ? stepOf(state, number) : null;
  return step ? write(state, `remove:${number}`, 'DELETE', STEPS_ROUTE, { step: stepKey(state, number) }, { removed: { number, title: step.title } }) : state;
}

/** Desfazer: POST `{ step }` to the restore route, which reopens the sub-issue. (issue 535) */
export function undoRemove(state) {
  const removed = state.steps?.removed;
  return removed ? write(state, 'undo', 'POST', STEPS_RESTORE_ROUTE, { step: stepKey(state, removed.number) }) : state;
}

/** The step count the card shows: the plan GitHub last answered. (issue 535) */
export const stepCount = (state) => (state.open ? stepsOf(state).length : null);

// ---------- the comment (issue 535) ----------

export const typeComment = (state, text) => (state.open ? { ...state, comment: { text } } : state);
export const submitComment = (state) => (state.open && state.comment.text.trim() ? write(state, 'comment', 'POST', COMMENTS_ROUTE, { body: state.comment.text }) : state);

// ---------- GitHub's answers (issue 535) ----------

const current = (state, id) => state.open && state.request?.id === id;

/** The refreshed fields: what GitHub holds becomes what the panel shows; a field the person has changed and not saved keeps its text. (issue 535) */
function adopt(state, issue) {
  // dirty: typed text that differs from what the panel last held and from what GitHub holds now (issue 535)
  const dirtyTitle = state.title !== state.issue.title && state.title !== issue.title;
  const dirtyBody = state.body.text !== state.issue.body && state.body.text !== issue.body;
  return {
    ...state,
    issue,
    title: dirtyTitle ? state.title : issue.title,
    body: { ...state.body, text: dirtyBody ? state.body.text : issue.body },
    // a text typed with no version takes the version the reload brings (issue 535)
    bases: { title: dirtyTitle && state.bases.title ? state.bases.title : issue.updatedAt, body: dirtyBody && state.bases.body ? state.bases.body : issue.updatedAt },
  };
}

/**
 * The core answered 200 with the issue as GitHub returned it, at `at` (epoch ms): "gravado no GitHub às". The field the write (issue 535)
 * saved shows GitHub's text; the others keep what is typed.
 */
export function written(state, issue, id, at) {
  if (!current(state, id)) return state;
  const { control, meta } = state.request;
  const next = adopt(state, issue);
  const saved = { ...next, savedAt: at, busy: null, request: null, refusal: null };
  if (control === 'save-title') return { ...saved, title: issue.title, bases: { ...saved.bases, title: issue.updatedAt } };
  if (control === 'save-body') return { ...saved, body: { ...saved.body, text: issue.body }, bases: { ...saved.bases, body: issue.updatedAt } };
  if (control === 'comment') return { ...saved, comment: { text: '' } };
  if (control === 'save-step') return { ...saved, steps: { ...saved.steps, editing: null } };
  if (control === 'save-new-step') return { ...saved, steps: { ...saved.steps, adding: null } };
  if (control.startsWith('remove:')) return { ...saved, steps: { ...saved.steps, removed: meta.removed } };
  if (control === 'undo') return { ...saved, steps: { ...saved.steps, removed: null } };
  return saved;
}

/**
 * The core answered an error for the request `id`. `failure` is `{ status, error, reason?, param?, title?, body?, updatedAt? }`. (issue 535)
 * - 409 `conflict`: both versions, nothing written, the three exits (`overwrite`, `keepGithub`, `copyMine`).
 * - 409 `not-removed`: the step is no longer removed; the notice goes and the issue is read again.
 * - `github-refused`, and any other refusal: the refusal band, the text kept.
 * - `github-unavailable`: the band, the text kept, and a reload with `?refresh=1`; the write is not repeated.
 * - `written-unread`: GitHub applied it; a reload, no band and no retry.
 */
export function rejected(state, failure, id) {
  if (!current(state, id)) return state;
  const { control, meta } = state.request;
  const settled = { ...state, busy: null, request: null };
  if (failure.status === 409 && failure.error === 'conflict') {
    // what was sent and for which step comes from the request, not from the editor, which may have moved on (issue 535)
    const field = control === 'save-body' ? 'body' : control === 'save-title' ? 'title' : 'step';
    const text = field === 'body' ? failure.body : failure.title;
    return { ...settled, conflict: { field, number: meta?.number ?? null, mine: meta?.text ?? '', github: { text: text ?? '', updatedAt: failure.updatedAt ?? '' } } };
  }
  if (failure.error === 'not-removed') return reloadOf({ ...settled, steps: { ...state.steps, removed: null } });
  const unknownOutcome = failure.error === 'github-unavailable' || failure.error === 'written-unread';
  // a POST that creates something (the comment, a new step) must not be offered again when its outcome is unknown (follow-up 544)
  const creates = control === 'comment' || control === 'save-new-step';
  if (failure.error === 'written-unread' && !creates) return reloadOf({ ...settled, last: null });
  const refused = { ...settled, refusal: { control, place: placeOf(control), reason: reasonOf(failure), retry: !(unknownOutcome && creates) } };
  if (!unknownOutcome) return refused;
  return reloadOf(creates ? { ...refused, last: null } : refused);
}

/** The reason in pt-BR the refusal band says, from the core's error and reason codes. (issue 535) */
export function reasonOf({ error, reason, param } = {}) {
  if (error === 'github-refused') return reason === 'no-scope' ? 'A conexão do Console não tem permissão para escrever nesta issue.' : 'O GitHub não deixou gravar: a conta não pode editar esta issue.';
  if (error === 'github-unavailable') return 'O GitHub não respondeu; não sei se a mudança foi gravada.';
  if (error === 'written-unread') return 'Não consegui ler a resposta do GitHub; não sei se a mudança foi gravada.';
  if (error === 'unknown-value') return `O GitHub não conhece o valor escolhido${param ? ` (${param})` : ''}.`;
  if (error === 'not-found') return 'A issue não existe mais no GitHub.';
  if (error === 'off') return 'O Console está sem conexão com o GitHub.';
  return 'O Console não conseguiu gravar a mudança.';
}

/** Tentar de novo: the person's click on the refusal band repeats the last write, once. Never called by the screen on its own. (issue 535) */
export function retryWrite(state) {
  if (!state.open || state.busy || state.conflict || !state.refusal?.retry || !state.last) return state;
  const id = state.seq + 1;
  const request = { ...state.last, id };
  return { ...state, seq: id, busy: request.control, request, last: request, refusal: null };
}

/** Copiar texto / Copiar a minha: the text for the clipboard, or `null` when there is none. (issue 535) */
export function textToCopy(state) {
  if (!state.open) return null;
  if (state.conflict) return state.conflict.mine;
  const control = state.refusal?.control;
  if (control === 'save-body') return state.body.text;
  if (control === 'save-title') return state.title;
  if (control === 'save-step') return state.steps.editing?.text ?? null;
  if (control === 'save-new-step') return state.steps.adding?.text ?? null;
  if (control === 'comment') return state.comment.text;
  return null;
}

// ---------- the three exits of a conflict (issue 535) ----------

/** Gravar a minha por cima: the same write again, now carrying GitHub's version. Only on this choice. (issue 535) */
export function overwrite(state) {
  const { conflict } = state;
  if (!state.open || !conflict || state.busy) return state;
  const open = { ...state, conflict: null };
  if (conflict.field === 'body') return write(open, 'save-body', 'PATCH', ISSUE_ROUTE, { body: conflict.mine, updatedAt: conflict.github.updatedAt }, { text: conflict.mine });
  if (conflict.field === 'title') return write(open, 'save-title', 'PATCH', ISSUE_ROUTE, { title: conflict.mine, updatedAt: conflict.github.updatedAt }, { text: conflict.mine });
  return write(open, 'save-step', 'PATCH', STEPS_ROUTE, { step: stepKey(state, conflict.number), updatedAt: conflict.github.updatedAt, title: conflict.mine }, { number: conflict.number, text: conflict.mine });
}

/** Ficar com a do GitHub: the editor takes GitHub's text and version; nothing is written. (issue 535) */
export function keepGithub(state) {
  const { conflict } = state;
  if (!state.open || !conflict || state.busy) return state;
  const { text, updatedAt } = conflict.github;
  const open = { ...state, conflict: null };
  if (conflict.field === 'body') return { ...open, issue: { ...open.issue, body: text }, body: { ...open.body, text }, bases: { ...open.bases, body: updatedAt } };
  if (conflict.field === 'title') return { ...open, issue: { ...open.issue, title: text }, title: text, bases: { ...open.bases, title: updatedAt } };
  const steps = stepsOf(open).map((s) => (s.number === conflict.number ? { ...s, title: text, updatedAt } : s));
  return { ...open, issue: { ...open.issue, plan: { ...open.issue.plan, steps } }, steps: { ...open.steps, editing: open.steps.editing?.number === conflict.number ? null : open.steps.editing } };
}

/** Copiar a minha: the conflict stays open; the screen puts `textToCopy` on the clipboard. (issue 535) */
export const copyMine = (state) => state;

// ---------- the reload (issue 535) ----------

/** GET `?refresh=1` answered: what GitHub holds is shown; text typed and not saved stays. (issue 535) */
export function reloaded(state, issue, id) {
  if (!state.open || state.reload?.id !== id) return state;
  return { ...adopt(state, issue), reload: null, versionTried: state.reload.key ? [...state.versionTried, state.reload.key] : state.versionTried };
}

/** The reload failed: nothing changes but the request is over; the person can still copy the text. (issue 535) */
export const reloadFailed = (state, id) => (state.open && state.reload?.id === id ? { ...state, reload: null } : state);

// ---------- what the panel draws (issue 535) ----------

/** Where the refusal band goes: next to the refused control, `'title' | 'body' | 'details' | 'plan' | 'comment'`; `null` with no band (issue 535, approval b). */
const placeOf = (control) => {
  if (control === 'save-title') return 'title';
  if (control === 'save-body') return 'body';
  if (control === 'comment') return 'comment';
  if (['type', 'milestone', 'parent', 'label'].includes(control)) return 'details';
  return 'plan';
};
export const refusalPlace = (state) => (state.open && state.refusal ? state.refusal.place : null);

/** `body.mode` of issueEditPanel: `conflict` while a 409 waits, `refused` only while the band of the description stands, else `edit` (issue 535). */
export function bodyMode(state) {
  if (state.conflict) return 'conflict';
  return refusalPlace(state) === 'body' ? 'refused' : 'edit';
}
