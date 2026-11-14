/* "Planejar" on the work board (issue 467, issue 508, wireframes 465-2, 465-6 and 467-1): the planning parts of a
card and of the issue panel, the confirmation anchored on the card and the missing-folder popover.

Pure render functions: data and handlers in, nodes out. No fetch, no state: the screen decides when the
confirmation is open, calls POST /api/work/plan and hands the answer back. The styles are in
`work-board-issue-panel.css` (classes `wb-plan-`). */

import { el, icon } from '../dom.js';

/** The types "Planejar" is offered for: epics, initiatives and plan steps are planned elsewhere or not at all. */
export const PLANNABLE_TYPES = new Set(['story', 'task', 'bug', 'spike']);

const ref = (n) => `#${n}`;
const FAILED_FALLBACK = 'O planejamento terminou sem plano';
const FOLDER_TITLE = 'Falta a pasta do repositório nesta máquina';
const TARGETS = [
  { target: 'desktop', label: 'Claude Desktop', icon: 'monitor' },
  { target: 'terminal', label: 'Terminal', icon: 'terminal' },
];

/**
 * What the card offers: `hidden` (no action), `planning` ("planejando…"), `failed` (back to the action, with the reason),
 * `planned` (a plan is out) or `unplanned`.
 */
export function planState(card) {
  if (!PLANNABLE_TYPES.has(card?.type) || card.column !== 'planning') return 'hidden';
  if (card.planning?.state === 'running') return 'planning';
  if (card.planning?.state === 'failed') return 'failed';
  return card.plan?.steps > 0 ? 'planned' : 'unplanned';
}

/**
 * issue 595: the one line that takes the place of the plan and run actions on a repository the owner has not trusted.
 * `place` is `card` (the short form, where space is tight) or `panel` (the full form, naming the owner of the repository).
 */
export function untrustedLine(card, place = 'card') {
  const owner = String(card?.repo ?? '').split('/')[0] || 'Este dono';
  const text = place === 'panel' ? `Repositório fora da lista de confiança: ${owner} não pode Planejar nem Executar plano aqui` : 'Fora da lista de confiança: só leitura';
  return el('div', { class: 'wb-untrusted', role: 'note', 'data-state': 'untrusted' }, icon('lock'), el('span', {}, text));
}

/**
 * The planning parts of a card (and of the panel): `badge` ("planejando…"), `note` (the failure and its reason, in red)
 * and `actions` (Planejar as the one primary action, Replanejar as a link in the line below). `onPlan` and `onReplan`
 * get the card and the button pressed, to anchor the confirmation on it. While planning there is no action. `lead` is a node
 * placed before the links of a card with a plan: the primary action of that state (Executar plano, issue 532).
 */
export function cardPlanParts(card, { onPlan = null, onReplan = null, lead = null, place = 'card' } = {}) {
  const state = planState(card);
  const none = { badge: null, note: null, actions: null };
  if (state === 'hidden') return none;
  const number = ref(card.number);
  const act = (cls, action, label, name, handler, iconName = null) =>
    el('button', { type: 'button', class: cls, 'data-action': action, 'aria-label': name, onClick: (ev) => handler?.(card, ev.currentTarget) }, iconName ? icon(iconName) : null, label);
  if (state === 'planning') {
    const badge = el('span', { class: 'wb-pill wb-pill-active wb-session', role: 'status', 'data-state': 'planning' }, 'planejando…');
    return { ...none, badge };
  }
  // issue 595: on a repository that is not trusted the core refuses Planejar and Executar plano, so none is offered.
  if (card.trusted === false) return { ...none, actions: untrustedLine(card, place) };
  const note = state === 'failed' ? el('div', { class: 'wb-plan-note', role: 'alert' }, icon('alert'), el('span', {}, card.planning.reason || FAILED_FALLBACK)) : null;
  const hasPlan = card.plan?.steps > 0;
  const actions = hasPlan
    ? el('div', { class: 'wb-plan-acts' }, lead, el('div', { class: 'wb-plan-links' }, act('wb-plan-link', 'replan', 'Replanejar', `Replanejar a ${number}`, onReplan)))
    : el('div', { class: 'wb-plan-acts' }, act('btn filled sm wb-plan-act', 'plan', 'Planejar', `Planejar a ${number}`, onPlan, 'bot'));
  return { ...none, note, actions };
}

export function targetChoice(target, onTarget) {
  const group = el(
    'div',
    { class: 'wb-plan-choice', role: 'radiogroup', 'aria-label': 'Abrir em' },
    ...TARGETS.map((t) =>
      el(
        'button',
        { type: 'button', class: 'wb-plan-radio', role: 'radio', 'aria-checked': String(t.target === target), tabindex: t.target === target ? '0' : '-1', 'data-target': t.target, onClick: () => t.target !== target && onTarget?.(t.target) },
        icon(t.icon),
        t.label,
      ),
    ),
  );
  group.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault?.();
    onTarget?.(TARGETS.find((t) => t.target !== target).target);
  });
  return group;
}

/**
 * The confirmation anchored on the card (465-6): repository, the current account (read-only) and where to open.
 * `replan` is the same confirmation worded for a replan.
 */
export function planConfirm({ repo, number, replan = false, target = 'desktop', account = null, busy = false, onTarget = null, onCancel = null, onConfirm = null }) {
  const verb = replan ? 'Replanejar' : 'Planejar';
  const title = `${verb} a ${ref(number)} com a Athena`;
  const rows = [
    el('dt', {}, 'Repositório'),
    el('dd', { class: 'mono wb-plan-trunc', 'data-field': 'repo' }, repo),
    account ? el('dt', {}, 'Conta') : null,
    account ? el('dd', { 'data-field': 'account' }, account) : null,
    el('dt', {}, 'Abrir em'),
    el('dd', { 'data-field': 'target' }, targetChoice(target, onTarget)),
  ];
  const root = el(
    'div',
    { class: 'card wb-plan-pop', role: 'dialog', 'aria-label': title, 'data-kind': replan ? 'replan' : 'plan' },
    el('h3', {}, title),
    el('dl', { class: 'wb-plan-kv' }, ...rows),
    el(
      'p',
      { class: 'wb-plan-hint' },
      `${replan ? 'O plano atual vai para a sessão, que o substitui. ' : ''}O card fica em Planejamento com “planejando…” até o plano sair. Não conta no limite de execuções.`,
    ),
    el(
      'div',
      { class: 'wb-plan-pop-acts' },
      el('button', { type: 'button', class: 'btn outline sm', 'data-action': 'cancel', onClick: () => onCancel?.() }, 'Cancelar'),
      el('button', { type: 'button', class: 'btn filled sm', 'data-action': 'confirm', disabled: busy, 'aria-busy': busy ? 'true' : null, onClick: () => onConfirm?.() }, icon('bot'), verb),
    ),
  );
  root.addEventListener('keydown', (ev) => ev.key === 'Escape' && onCancel?.());
  return root;
}

function copyButton(command, copy) {
  const write = copy ?? ((text) => navigator.clipboard.writeText(text));
  const button = el('button', { type: 'button', class: 'btn filled sm', 'data-action': 'copy', 'aria-live': 'polite' }, icon('copy'), 'Copiar comando');
  button.addEventListener('click', async () => {
    let done;
    try {
      await write(command);
      done = 'Copiado';
    } catch {
      done = 'Não deu para copiar';
    }
    button.replaceChildren(icon('copy'), done);
  });
  return button;
}

/**
 * The repository is not on this machine (465-6): the message, the command to run and "Copiar comando". `message` is the core's
 * own text when it sent one; `copy` replaces the clipboard writer (tests).
 */
export function missingFolder({ repo, title = FOLDER_TITLE, message = null, command = null, copy = null, onClose = null }) {
  const text = message ?? `O Console não achou ${repo} em nenhuma pasta deste Mac. Clone e tente de novo; o card fica onde estava.`;
  const root = el(
    'div',
    { class: 'card wb-plan-pop', role: 'dialog', 'aria-label': title, 'data-kind': 'folder' },
    el('h3', {}, title),
    el('p', { class: 'wb-plan-hint' }, text),
    command ? el('pre', { class: 'wb-plan-cmd', role: 'note', 'aria-label': 'Comando' }, command) : null,
    el(
      'div',
      { class: 'wb-plan-pop-acts' },
      el('button', { type: 'button', class: 'btn outline sm', 'data-action': 'close', onClick: () => onClose?.() }, 'Fechar'),
      command ? copyButton(command, copy) : null,
    ),
  );
  root.addEventListener('keydown', (ev) => ev.key === 'Escape' && onClose?.());
  return root;
}
