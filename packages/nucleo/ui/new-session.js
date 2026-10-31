// "Nova sessão": the header button of the Dashboard, the wall and Sessions that starts a new Claude Code
// session, in the Claude Desktop or in a terminal (src/api/new-session.ts).
//
// The button opens a popover: the folder (the ones this machine's sessions ran in, from
// `GET /api/new-session/folders`, read on each opening) and one button per target. A click is
// `write('/api/new-session', { folder, target })`; beside the targets come "Abrindo…", the success
// (the popover closes after SUCCESS_MS) or the core's pt-BR error with "Copiar comando".
// Escape or a click outside closes it. The styles are in `new-session.css` (classes `ns-`, index.html).

import { el, icon } from './dom.js';
import { read as defaultRead, write as defaultWrite } from './api.js';

export const NEW_SESSION_ROUTE = '/api/new-session';
export const FOLDERS_ROUTE = '/api/new-session/folders';
/** How long the success stays before the popover closes. */
export const SUCCESS_MS = 2500;

const TARGETS = [
  { target: 'desktop', label: 'Claude Desktop', icon: 'monitor', title: 'Abre uma sessão nova do Claude Code no Claude Desktop, nesta pasta' },
  { target: 'terminal', label: 'Terminal', icon: 'terminal', title: 'Abre o terminal padrão e roda claude nesta pasta' },
];
const OPENED_TEXT = { desktop: 'Aberta no Claude Desktop', terminal: 'Aberta no terminal' };

/** The state after an answer, without DOM: `{ kind: 'ok', text }` or `{ kind: 'fail', text, command }`. */
export function stateOfAnswer(answer, failure = null) {
  if (failure) {
    const command = typeof failure.body?.command === 'string' && failure.body.command ? failure.body.command : null;
    return { kind: 'fail', text: failure.message || 'Não deu para abrir a sessão nova.', command };
  }
  return { kind: 'ok', text: OPENED_TEXT[answer?.opened] ?? 'Aberta' };
}

/** The button and its popover. `read`/`write` swap the transport (tests, the screen's `ctx`). */
export function newSessionButton({ read = defaultRead, write = defaultWrite, successMs = SUCCESS_MS } = {}) {
  const button = el('button', { type: 'button', class: 'btn filled ns-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('plus'), 'Nova sessão');
  const pop = el('div', { class: 'ns-pop', role: 'dialog', 'aria-label': 'Nova sessão', hidden: true });
  const root = el('span', { class: 'ns' }, button, pop);
  let busy = false;
  let closeTimer = null;

  const isOpen = () => !pop.hasAttribute('hidden');

  function close() {
    clearTimeout(closeTimer);
    pop.setAttribute('hidden', '');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener?.('pointerdown', outside, true);
  }

  function outside(ev) {
    if (!root.contains(ev.target)) close();
  }

  async function open() {
    pop.removeAttribute('hidden');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener?.('pointerdown', outside, true);
    pop.replaceChildren(el('div', { class: 'ns-note' }, 'Lendo as pastas…'));
    let data;
    try {
      data = await read(FOLDERS_ROUTE);
    } catch {
      return void pop.replaceChildren(el('div', { class: 'ns-note ns-fail' }, 'Não deu para ler as pastas.'));
    }
    if (!isOpen()) return;
    draw(data);
  }

  function draw({ folders = [], targets = {} } = {}) {
    if (!folders.length) return void pop.replaceChildren(el('div', { class: 'ns-title' }, 'Nova sessão'), el('div', { class: 'ns-note' }, 'Nenhuma pasta conhecida ainda: abra uma sessão do Claude Code numa pasta e ela aparece aqui.'));
    const select = el('select', { class: 'ns-folder', 'aria-label': 'Pasta' });
    for (const f of folders) select.append(el('option', { value: f.path, title: f.path }, f.name));
    let chosen = folders[0].path;
    // The left-to-right mark keeps the leading "/" in place under the right-to-left ellipsis.
    const shown = (p) => `\u200e${p}`;
    const path = el('div', { class: 'ns-path', title: chosen }, shown(chosen));
    select.addEventListener('change', () => {
      chosen = select.value;
      path.textContent = shown(chosen);
      path.setAttribute('title', chosen);
    });
    const status = el('div', { class: 'ns-status', role: 'status', 'aria-live': 'polite' });
    const buttons = TARGETS.map((t) => {
      const b = el('button', { type: 'button', class: 'btn outline ns-target', 'data-target': t.target, title: t.title }, icon(t.icon), t.label);
      // Without its launcher the core answers 501 with the command; the button still offers that.
      if (targets[t.target] === false) b.setAttribute('title', `${t.title} (aqui só dá para copiar o comando)`);
      b.addEventListener('click', () => start(t.target, chosen, status, buttons));
      return b;
    });
    pop.replaceChildren(
      el('div', { class: 'ns-title' }, 'Nova sessão'),
      el('label', { class: 'ns-label' }, 'Pasta', el('span', { class: 'ns-select' }, select, icon('chevron-down'))),
      path,
      el('div', { class: 'ns-label' }, 'Abrir em'),
      el('div', { class: 'ns-targets' }, ...buttons),
      status,
    );
    select.focus?.();
  }

  async function start(target, folder, status, buttons) {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.setAttribute('aria-disabled', 'true');
    buttons.find((b) => b.getAttribute('data-target') === target)?.setAttribute('aria-busy', 'true');
    status.replaceChildren(el('span', { class: 'ns-busy' }, 'Abrindo…'));
    let state;
    try {
      state = stateOfAnswer(await write(NEW_SESSION_ROUTE, { folder, target }));
    } catch (e) {
      state = stateOfAnswer(null, e instanceof Error ? e : new Error(String(e)));
    }
    busy = false;
    for (const b of buttons) {
      b.removeAttribute('aria-disabled');
      b.removeAttribute('aria-busy');
    }
    status.replaceChildren(...[el('span', { class: `ns-${state.kind}` }, state.text), state.kind === 'fail' && state.command ? copyButton(state.command) : null].filter(Boolean));
    if (state.kind === 'ok') closeTimer = setTimeout(close, successMs);
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen()) {
      ev.stopPropagation?.();
      close();
      button.focus?.();
    }
  });
  return root;
}

/** "Copiar comando": `cd '<pasta>' && claude` to the clipboard. */
function copyButton(command) {
  const b = el('button', { type: 'button', class: 'btn outline ns-copy', title: command }, icon('copy'), 'Copiar comando');
  b.addEventListener('click', async () => {
    let done;
    try {
      await navigator.clipboard.writeText(command);
      done = 'Copiado';
    } catch {
      done = 'Não deu para copiar';
    }
    b.replaceChildren(icon('copy'), done);
  });
  return b;
}
