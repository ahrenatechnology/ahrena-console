// Open the session where it runs (issue 285, wireframes C70 and C71): one action shared by the Detail
// header, the wall card foot, the Sessions row and the Dashboard inbox, so the four behave the same.
//
// The core decides the target and sends it on every surface as `open: { target, command }`
// (src/api/session-open.ts); the click is `POST /api/sessions/<uuid>/open` through the write layer
// (`write()`, never `fetch`), and the answer becomes the state beside the button:
//
// | Answer                                 | Beside the button                                       |
// | -------------------------------------- | ------------------------------------------------------- |
// | in flight                              | "Abrindo…", the button aria-busy and refusing clicks    |
// | 200 `{ opened: 'desktop' }`            | "Aberta no Claude Desktop", gone after SUCCESS_MS        |
// | 200 `{ opened: 'terminal' }`           | "Aberta no terminal", gone after SUCCESS_MS              |
// | 200 `{ opened: 'focused' }`            | "Terminal à frente", gone after SUCCESS_MS               |
// | error with `command`                   | the core's pt-BR error and "Copiar comando"             |
// | error without `command`                | the core's pt-BR error                                  |
//
// Sizes: `full` (Detail: icon, label and, for what leaves the console, the external mark), `small`
// (wall foot: icon and label) and `icon` (Sessions row, Dashboard inbox: the icon alone, the action in
// `title` and `aria-label`, the state in a small popover). Every click inside the action stops there:
// the card or the row around it never navigates. The styles are in `open-action.css` (index.html).

import { el, icon } from './dom.js';
import { write as defaultWrite } from './api.js';

/** How long a success stays beside the button. */
export const SUCCESS_MS = 4000;

const OPENED_TEXT = { desktop: 'Aberta no Claude Desktop', terminal: 'Aberta no terminal', focused: 'Terminal à frente' };

/** The text of a success, by the route's `opened`. */
export const openedText = (opened) => OPENED_TEXT[opened] ?? 'Aberta';

/** The write route of a session's open. */
export const openRoute = (id) => `/api/sessions/${encodeURIComponent(id)}/open`;

/**
 * What the action shows for an `open` descriptor, without DOM; `null` when there is nothing to show
 * (`none`, or no descriptor). `machine` is the remote machine's name, when the surface knows it.
 */
export function describeOpenAction(open, { machine = null } = {}) {
  switch (open?.target) {
    case 'desktop':
      return { target: 'desktop', label: 'Abrir no Claude Desktop', icon: 'monitor', external: true, title: 'Abre a conversa no Claude Desktop', disabled: false, where: null };
    case 'terminal':
      return { target: 'terminal', label: 'Abrir no terminal', icon: 'terminal', external: true, title: 'Abre o terminal padrão e roda claude --resume na pasta da sessão', disabled: false, where: null };
    case 'terminal-live':
      return { target: 'terminal-live', label: 'Ir para o terminal', icon: 'square-terminal', external: false, title: 'Já roda num terminal; traz a janela à frente', disabled: false, where: null };
    case 'remote': {
      const name = typeof machine === 'string' && machine ? machine : null;
      return {
        target: 'remote',
        label: 'Abrir no terminal',
        icon: 'terminal',
        external: false,
        title: name ? `A sessão roda em ${name}` : 'A sessão roda em outra máquina',
        disabled: true,
        where: name ? `roda em ${name}` : 'roda em outra máquina',
        // The wall foot has no room for both: the button itself says where (C71).
        smallLabel: name ? `Roda em ${name}` : 'Roda em outra máquina',
      };
    }
    default:
      return null;
  }
}

/** Asks the core to open the session: the answer (`{ ok, opened }`) or the `WriteError` it threw. */
export function openSession(id, { write = defaultWrite } = {}) {
  return write(openRoute(id), {});
}

/** The state after an answer, without DOM: `{ kind: 'ok', text }` or `{ kind: 'fail', text, command }`. */
export function stateOfAnswer(answer, failure = null) {
  if (failure) {
    const command = typeof failure.body?.command === 'string' && failure.body.command ? failure.body.command : null;
    return { kind: 'fail', text: failure.message || 'Não deu para abrir a sessão.', command };
  }
  return { kind: 'ok', text: openedText(answer?.opened) };
}

const stop = (ev) => {
  ev.preventDefault?.();
  ev.stopPropagation?.();
};

// ---------- The state of each session's open, kept across redraws ----------
//
// The screens redraw often (Sessions every second while changes stream, the wall and the Dashboard
// after 400 ms, the Detail header on each change of its session), and each redraw builds a new
// action. The state lives here, by session id, so a new action shows what the old one showed: busy
// ("Abrindo…", a click refused), the failure with "Copiar comando" (until the next click, "Fechar" or
// FAIL_MS) and the success (only for the time it has left).

/** How long a failure stays when nobody clicks again or closes it. */
export const FAIL_MS = 60_000;

/** id → `{ kind: 'busy'|'ok'|'fail', text, command, until }`. */
const states = new Map();
/** id → the redraw functions of the actions built for it. */
const views = new Map();

/** The current state of a session's open, without DOM (`null`: nothing beside the button). */
export function openStateOf(id, now = Date.now()) {
  const st = states.get(id);
  if (!st) return null;
  if (st.until !== null && st.until <= now) {
    states.delete(id);
    return null;
  }
  return st;
}

/** Forgets every state (tests). */
export function resetOpenStates() {
  states.clear();
  views.clear();
}

function setState(id, st) {
  if (st) states.set(id, st);
  else states.delete(id);
  for (const draw of [...(views.get(id) ?? [])]) draw();
}

/**
 * The action for one session (`{ id, open }`), or `null` when there is nothing to open.
 * `size`: 'full' | 'small' | 'icon'. `write` swaps the transport (tests, the screen's `ctx.write`).
 */
export function openAction(session, { size = 'full', write = defaultWrite, machine = null, className = null, successMs = SUCCESS_MS, failMs = FAIL_MS } = {}) {
  const d = describeOpenAction(session?.open, { machine });
  if (!d) return null;
  const id = session.id;
  const compact = size === 'icon';
  const label = size === 'small' && d.smallLabel ? d.smallLabel : d.label;
  // Where the button cannot say "roda em…" beside it (wall foot, icon), the server icon says it.
  const iconName = d.target === 'remote' && size !== 'full' ? 'server' : d.icon;

  const button = compact
    ? el('button', { type: 'button', class: 'open-icon', title: d.title, 'aria-label': d.disabled ? d.title : d.label, 'data-open-target': d.target }, icon(iconName))
    : el(
        'button',
        { type: 'button', class: `btn outline open-button`, title: d.title, 'data-open-target': d.target },
        icon(iconName),
        label,
        size === 'full' && d.external ? icon('external') : null,
      );
  // aria-disabled keeps the title readable on hover; the click does nothing.
  if (d.disabled) button.setAttribute('aria-disabled', 'true');
  const status = el('span', { class: 'open-status', role: 'status', 'aria-live': 'polite' });
  const why = size === 'full' && d.where ? el('span', { class: 'open-why' }, icon('server'), d.where) : null;
  const root = el('span', { class: `open-action open-size-${size}${className ? ` ${className}` : ''}`, 'data-open-target': d.target }, button, why, status);
  // Nothing inside the action reaches the card or the row around it.
  root.addEventListener('click', (ev) => ev.stopPropagation?.());
  // Escape closes a failure (the icon's popover covers the rows below it).
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && openStateOf(id)?.kind === 'fail') {
      ev.stopPropagation?.();
      setState(id, null);
    }
  });

  let timer = null;

  function draw() {
    // A redraw dropped this action from the page: it stops listening.
    if (root.isConnected === false && status.getAttribute('data-state') !== null) return void forget();
    clearTimeout(timer);
    const st = openStateOf(id);
    // In flight: aria-disabled and aria-busy, not `disabled`, so the focus stays on the button.
    if (st?.kind === 'busy') {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
    } else {
      button.removeAttribute('aria-busy');
      if (!d.disabled) button.removeAttribute('aria-disabled');
    }
    status.setAttribute('data-state', st?.kind ?? 'idle');
    if (!st) return void status.replaceChildren();
    const msg = el('span', { class: `open-msg open-${st.kind}`, title: st.text }, st.text);
    const copy = st.kind === 'fail' && st.command ? copyButton(st.command, compact || size === 'small') : null;
    const close = st.kind === 'fail' && compact ? closeButton(() => setState(id, null)) : null;
    status.replaceChildren(...[msg, copy, close].filter(Boolean));
    if (st.until !== null) {
      timer = setTimeout(draw, Math.max(0, st.until - Date.now()));
      // In node (the tests) a pending fade does not hold the process open; browsers return a number.
      timer?.unref?.();
    }
  }

  function forget() {
    clearTimeout(timer);
    views.get(id)?.delete(draw);
    if (views.get(id)?.size === 0) views.delete(id);
  }

  if (!views.has(id)) views.set(id, new Set());
  views.get(id).add(draw);
  draw();

  button.addEventListener('click', async (ev) => {
    stop(ev);
    if (d.disabled || openStateOf(id)?.kind === 'busy') return;
    // The next click clears a failure.
    setState(id, { kind: 'busy', text: 'Abrindo…', command: null, until: null });
    let state;
    try {
      state = stateOfAnswer(await openSession(id, { write }));
    } catch (e) {
      if (e?.name === 'AbortError') state = null;
      else state = stateOfAnswer(null, e instanceof Error ? e : new Error(String(e)));
    }
    if (!state) return setState(id, null);
    setState(id, { ...state, command: state.kind === 'fail' ? state.command : null, until: Date.now() + (state.kind === 'ok' ? successMs : failMs) });
  });
  return root;
}

/** "Fechar": the icon's failure popover goes away. */
function closeButton(onClose) {
  const b = el('button', { type: 'button', class: 'open-close', title: 'Fechar', 'aria-label': 'Fechar' }, icon('x'));
  b.addEventListener('click', (ev) => {
    stop(ev);
    onClose();
  });
  return b;
}

/** "Copiar comando": the resume line to the clipboard, with "Copiado" as the answer. */
function copyButton(command, iconOnly) {
  const text = el('span', { class: 'open-copy-label' }, 'Copiar comando');
  const b = el('button', { type: 'button', class: `btn outline open-copy${iconOnly ? ' open-copy-icon' : ''}`, title: 'Copiar comando', 'aria-label': 'Copiar comando' }, icon('copy'), iconOnly ? null : text);
  b.addEventListener('click', async (ev) => {
    stop(ev);
    let done;
    try {
      await navigator.clipboard.writeText(command);
      done = 'Copiado';
    } catch {
      done = 'Não deu para copiar';
    }
    text.textContent = done;
    b.setAttribute('title', done);
    b.setAttribute('aria-label', done);
    b.setAttribute('data-copied', done === 'Copiado' ? 'true' : 'false');
  });
  return b;
}
