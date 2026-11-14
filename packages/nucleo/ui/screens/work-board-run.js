/* "Executar plano" on the work board (issue 468, issue 532, wireframes 465-2, 465-6 and 467-1): the execution parts of a
card and of the issue panel, the confirmation anchored on the card and the notice after confirming. The sibling of
`work-board-plan.js`, which it reuses for the planning parts, the choice of where to open and the missing-folder popover.

Pure render functions: data and handlers in, nodes out. No fetch, no state: the screen decides when the confirmation is
open, calls POST /api/work/run and hands the answer back (the limit full as `full`, the missing folder as `missingFolder`
of work-board-plan.js). The styles are in `work-board-issue-panel.css` (classes `wb-run-`, and `wb-plan-` where shared). */

import { el, icon } from '../dom.js';
import { PLANNABLE_TYPES, cardPlanParts, planState, targetChoice } from './work-board-plan.js';

const ref = (n) => `#${n}`;
/** Where the session opened, by the core's `opened` (the words of open-action.js; issue 532). */
const WHERE = { desktop: 'abrindo no Claude Desktop', terminal: 'abrindo no Terminal', focused: 'Terminal à frente' };
/** The columns a live session still gets "Abrir sessão" in: Em review and Concluído have no action (465-2, issue 532). */
const LIVE_COLUMNS = new Set(['running', 'blocked']);

/**
 * What the card offers for execution: `hidden` (no action here), `booting` ("subindo…"), `live` (Abrir sessão),
 * `queued` (Executar plano on a card in Na fila, 465-2), `planningLive` ("planejando…" with Abrir sessão, 465-2),
 * `planned` (Executar plano) or what `planState` says (`unplanned`, `planning`, `failed`, `hidden`). "Has a plan" is `plan.steps > 0`, as for Planejar.
 */
export function runState(card) {
  if (!PLANNABLE_TYPES.has(card?.type)) return 'hidden';
  if (card.execution?.state === 'booting') return 'booting';
  const live = card.sessions?.count > 0 && card.sessions.state !== 'idle';
  if (live && LIVE_COLUMNS.has(card.column)) return 'live';
  if (card.column === 'queued') return card.plan?.steps > 0 ? 'queued' : 'hidden';
  const planning = planState(card);
  if (planning === 'planning' && live && card.sessions.ids?.length > 0) return 'planningLive';
  if ((planning === 'planned' || planning === 'failed') && card.plan?.steps > 0) return 'planned';
  return planning;
}

/**
 * The execution parts of a card (and of the panel), the superset of `cardPlanParts`: `badge` ("subindo…" while a run
 * boots), `note`, and `actions` (Executar plano as the one primary action over Replanejar, Planejar without a plan, Abrir
 * sessão with a live session). `onRun` and `onOpenSession` get the card and the button pressed.
 */
export function cardRunParts(card, { onRun = null, onReplan = null, onPlan = null, onOpenSession = null } = {}) {
  const state = runState(card);
  const number = ref(card?.number);
  if (state === 'booting') {
    const badge = el('span', { class: 'wb-pill wb-pill-waiting wb-session wb-run-boot', role: 'status', 'data-state': 'booting' }, icon('wall-loader'), 'subindo…');
    return { badge, note: null, actions: null };
  }
  if (state === 'live' || state === 'planningLive') {
    const open = el('button', { type: 'button', class: 'btn outline sm wb-plan-act', 'data-action': 'open-session', 'aria-label': `Abrir a sessão da ${number}`, onClick: (ev) => onOpenSession?.(card, ev.currentTarget) }, icon('external'), 'Abrir sessão');
    const badge = state === 'planningLive' ? cardPlanParts(card).badge : null;
    return { badge, note: null, actions: el('div', { class: 'wb-plan-acts' }, open) };
  }
  if (state === 'queued') {
    const run = el('button', { type: 'button', class: 'btn outline sm wb-plan-act', 'data-action': 'run', 'aria-label': `Executar o plano da ${number}`, onClick: (ev) => onRun?.(card, ev.currentTarget) }, icon('play'), 'Executar plano');
    return { badge: null, note: null, actions: el('div', { class: 'wb-plan-acts' }, run) };
  }
  const lead =
    state === 'planned'
      ? el('button', { type: 'button', class: 'btn filled sm wb-plan-act', 'data-action': 'run', 'aria-label': `Executar o plano da ${number}`, onClick: (ev) => onRun?.(card, ev.currentTarget) }, icon('play'), 'Executar plano')
      : null;
  return cardPlanParts(card, { onPlan, onReplan, lead });
}

/**
 * The confirmation anchored on the card (465-6): repository, folder, where to open and the start of the prompt. No account
 * row (issue 524). `full` (`{ running, limit }`, the core's 409) adds the warning and turns the button into "Executar mesmo
 * assim"; `running` and `limit` alone put the count in the hint.
 */
export function runConfirm({ repo, number, folder = null, target = 'desktop', prompt = null, running = null, limit = null, full = null, busy = false, onTarget = null, onCancel = null, onConfirm = null }) {
  const title = `Executar o plano da ${ref(number)}`;
  const rows = [
    el('dt', {}, 'Repositório'),
    el('dd', { class: 'mono wb-plan-trunc', 'data-field': 'repo' }, repo),
    folder ? el('dt', {}, 'Pasta') : null,
    folder ? el('dd', { class: 'mono wb-plan-trunc', 'data-field': 'folder' }, folder) : null,
    el('dt', {}, 'Abrir em'),
    el('dd', { 'data-field': 'target' }, targetChoice(target, onTarget)),
  ];
  const warn = full
    ? el(
        'div',
        { class: 'wb-run-warn', role: 'alert', 'data-field': 'limit' },
        icon('gauge'),
        el('div', {}, el('b', {}, 'Passa do limite.'), ` Já há ${full.running} de ${full.limit} rodando; esta seria a ${full.running + 1}ª execução. A fila não puxa ninguém até voltar a ter vaga.`),
      )
    : null;
  const count = running !== null && limit !== null ? ` Conta como 1 das ${limit} execuções; hoje há ${running} rodando.` : '';
  const hint = full ? 'Executar mesmo assim abre a sessão agora.' : `Abre a sessão agora e o card vai direto para Em execução.${count}`;
  const label = full ? 'Executar mesmo assim' : 'Executar plano';
  const root = el(
    'div',
    { class: 'card wb-plan-pop', role: 'dialog', 'aria-label': title, 'data-kind': full ? 'run-full' : 'run' },
    el('h3', {}, title),
    warn,
    el('dl', { class: 'wb-plan-kv' }, ...rows),
    prompt ? el('div', { class: 'wb-run-prompt', 'data-field': 'prompt' }, prompt) : null,
    el('p', { class: 'wb-plan-hint' }, hint),
    el(
      'div',
      { class: 'wb-plan-pop-acts' },
      el('button', { type: 'button', class: 'btn outline sm', 'data-action': 'cancel', onClick: () => onCancel?.() }, 'Cancelar'),
      el('button', { type: 'button', class: 'btn filled sm', 'data-action': 'confirm', disabled: busy, 'aria-busy': busy ? 'true' : null, onClick: () => !busy && onConfirm?.() }, icon('play'), label),
    ),
  );
  root.addEventListener('keydown', (ev) => ev.key === 'Escape' && onCancel?.());
  return root;
}

/** The notice after confirming (465-6): where the session opened, with "Abrir" when the screen can open it. */
export function runNotice({ number, opened = 'desktop', onOpen = null, onClose = null }) {
  const where = WHERE[opened] ?? WHERE.desktop;
  const text = opened === 'focused' ? `${WHERE.focused} para a ${ref(number)}` : `Sessão da Athena ${where} para a ${ref(number)}`;
  return el(
    'div',
    { class: 'wb-run-notice', role: 'status', 'data-field': 'notice' },
    icon('check-circle-2'),
    el('span', { 'data-field': 'text' }, text),
    onOpen ? el('button', { type: 'button', class: 'wb-plan-link', 'data-action': 'open', onClick: () => onOpen() }, 'Abrir') : null,
    el('button', { type: 'button', class: 'btn ghost sm icon-only', 'data-action': 'close', 'aria-label': 'Fechar o aviso', onClick: () => onClose?.() }, icon('x')),
  );
}
