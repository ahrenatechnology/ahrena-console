// The app's update notice (issue 330, wireframes C77 to C80): the card on top of every screen and the
// version panel that opens from the version in the sidebar footer.
//
// The state is the núcleo's (`GET /api/app-update`, api/app-update.ts): the app reports it, this file
// only draws it and sends the clicks (`POST /api/app-update/actions/<check|install|dismiss|ack>`).
// - In the app window (`window.__AHRENA_APP__`, set by the app): Atualizar, Depois and Buscar agora.
// - In a browser tab with the app open: the same card, but Atualizar says it is done in the app
//   (it restarts the app, which you are not looking at); Depois and Buscar agora work.
// - Without an app reporting to this núcleo: no card, no dot; the panel explains and the button is off.
// - Where nothing can be written (the claude.ai artifact): the card reads, the buttons are off.
// Nothing from the release notes becomes HTML: it goes in through `textContent`.

import { el, icon } from './dom.js';
import { canWrite } from './api.js';

export const APP_UPDATE_ROUTE = '/api/app-update';
const ACTION_ROUTE = `${APP_UPDATE_ROUTE}/actions/`;
/** The "Atualizado" card goes away by itself after this long. */
export const DONE_MS = 10_000;
const DEV_EVERY = 'a cada 10 min';
const STABLE_EVERY = 'a cada 6 h';
const READ_ONLY_WHY = 'No app do Ahrena Console';

/** Where this page is: the app's window, a browser tab, or a place that cannot write. */
export function whereAmI(win = globalThis) {
  if (!canWrite()) return 'read-only';
  return win.__AHRENA_APP__ === true ? 'app' : 'browser';
}

/** "3 min", "2 h", "menos de 1 min": a span of milliseconds. */
export function span(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

/** "5,2 de 12,4 MB". */
export function megabytes(progress) {
  if (!progress) return '';
  const mb = (b) => (b / 1_000_000).toFixed(1).replace('.', ',');
  return progress.total ? `${mb(progress.done)} de ${mb(progress.total)} MB` : `${mb(progress.done)} MB`;
}

export function percent(progress) {
  if (!progress?.total) return null;
  return Math.min(100, Math.floor((progress.done * 100) / progress.total));
}

/** The line of the cadence: "verificado há 3 min · próxima em 7 min". */
export function cadence(view, now) {
  if (!view.lastCheckAt) return null;
  const checked = `verificado há ${span(now - view.lastCheckAt)}`;
  const next = view.nextCheckAt ? ` · próxima em ${view.nextCheckAt > now ? span(view.nextCheckAt - now) : 'instantes'}` : '';
  return `${checked}${next}`;
}

export function modeText(view) {
  return view.mode === 'stable' ? { pill: 'estável', every: STABLE_EVERY } : { pill: 'modo dev', every: DEV_EVERY };
}

/** Whether the version has something to offer: the dot of the sidebar. */
export const hasUpdate = (view) => Boolean(view?.app && view.available);

const MANUAL_ERRORS = new Set(['offline', 'channel-down']);

/** What the card says, or `null` when it is not shown (C77, C78). */
export function noticeOf(view) {
  if (!view?.app) return null;
  const to = view.available?.version ?? null;
  if (view.phase === 'downloading') return { kind: 'downloading', version: to };
  if (view.phase === 'installing') return { kind: 'installing', version: to };
  if (view.phase === 'error' && !MANUAL_ERRORS.has(view.error) && to) return { kind: 'error', version: to, why: view.error };
  if (view.updated) return { kind: 'done', version: view.updated.to };
  if (to && !view.dismissed) return { kind: 'available', version: to };
  return null;
}

function bar(progress) {
  const p = percent(progress);
  const fill = el('span', { class: 'up-fill' });
  if (p !== null) fill.style.setProperty('--w', `${p}%`);
  return el('div', { class: 'up-progress' }, el('span', { class: 'up-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p ?? undefined }, fill), el('span', { class: 'mono' }, megabytes(progress)));
}

/** The card on top of the screen. `act(action, version)` sends a click. */
export function drawNotice(view, { where, act }) {
  const n = noticeOf(view);
  if (!n) return null;
  const off = where === 'read-only';
  const button = (label, onClick, { filled = false, why = null } = {}) => el('button', { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, onClick, disabled: off || Boolean(why), title: off ? READ_ONLY_WHY : (why ?? undefined) }, label);
  // Tentar de novo restarts the app like Atualizar: off in a browser tab too.
  const retry = () => (where === 'browser' ? button('Tentar de novo', null, { filled: true, why: 'Atualizar é no app, pela bandeja' }) : button('Tentar de novo', () => act('install'), { filled: true }));
  const sub = (...parts) => el('span', { class: 'up-sub' }, parts.filter(Boolean).join(' · '));
  const current = `Você está na versão ${view.appVersion}`;
  const card = (cls, ic, title, subline, actions = [], extra = null) =>
    el('section', { class: `up-banner ${cls}`, role: 'status', 'data-kind': n.kind }, el('span', { class: 'up-ic' }, icon(ic)), el('div', { class: 'up-text' }, el('b', {}, title), subline, extra), actions.length ? el('div', { class: 'up-act' }, ...actions) : null);
  if (n.kind === 'available') {
    const install = where === 'browser' ? button('Atualizar', null, { filled: true, why: 'Atualizar é no app, pela bandeja' }) : button('Atualizar', () => act('install'), { filled: true });
    const note = where === 'browser' ? 'Atualizar é no app: abra pela bandeja.' : null;
    return card('', 'an-download', `Atualização disponível: versão ${n.version}`, sub(current, note ?? view.available.notes), [install, button('Depois', () => act('dismiss', n.version))]);
  }
  if (n.kind === 'downloading') return card('', 'wall-loader', `Baixando a versão ${n.version}…`, null, [], bar(view.progress));
  if (n.kind === 'installing') return card('', 'refresh', `Instalando a versão ${n.version} e reiniciando…`, sub('O app fecha e abre sozinho', 'as sessões do Claude não param'));
  if (n.kind === 'error') {
    const text = n.why === 'signature' ? `A assinatura não confere. ${current}.` : `A conexão caiu no download. ${current}.`;
    return card('up-err', 'error', `Não deu para atualizar para a ${n.version}`, sub(text), [retry()]);
  }
  return card('up-ok', 'check-circle-2', `Atualizado para a versão ${n.version}`, sub(view.updated.notes ?? `Antes: ${view.updated.from}`), [button('Fechar', () => act('ack'))]);
}

/** What the panel says for each state of C79. */
export function panelState(view, where) {
  if (!view?.app) return { kind: 'no-app' };
  if (view.phase === 'checking') return { kind: 'checking' };
  if (view.phase === 'downloading') return { kind: 'downloading' };
  if (view.phase === 'installing') return { kind: 'installing' };
  if (view.phase === 'error' && MANUAL_ERRORS.has(view.error)) return { kind: view.error };
  if (view.phase === 'error') return { kind: 'error' };
  if (view.available) return { kind: 'available' };
  return { kind: 'up-to-date' };
}

/** The panel that opens from the version in the footer. */
export function drawPanel(view, { where, act, now = Date.now() }) {
  const state = panelState(view, where);
  const off = where === 'read-only';
  const button = (label, onClick, { filled = false, disabled = false, why = null } = {}) => el('button', { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, onClick, disabled: off || disabled, title: off ? READ_ONLY_WHY : (why ?? undefined) }, label);
  const mode = view?.app ? modeText(view) : null;
  const status = (ic, title, text) => el('div', { class: 'up-st' }, el('span', { class: 'ic' }, icon(ic)), el('div', {}, el('b', {}, title), el('span', {}, text)));
  const search = (label = 'Buscar agora', filled = false) => button(label, () => act('check'), { filled });
  let body;
  switch (state.kind) {
    case 'no-app':
      body = [status('port', 'Sem o app do Ahrena Console nesta máquina', 'Este núcleo foi subido pela extensão do Claude Desktop, ou o app é anterior à busca de versões. Ninguém consulta o canal de atualizações daqui.'), el('div', { class: 'up-pa' }, button('Buscar agora', null, { disabled: true, why: 'Precisa do app' }))];
      break;
    case 'checking':
      body = [status('wall-loader', 'Procurando…', 'Consultando o canal de atualizações.'), el('div', { class: 'up-pa' }, button('Buscar agora', null, { disabled: true }))];
      break;
    case 'downloading':
      body = [status('wall-loader', `Baixando a ${view.available?.version ?? ''}…`, `Você está na versão ${view.appVersion}.`), bar(view.progress)];
      break;
    case 'installing':
      body = [status('refresh', 'Instalando e reiniciando…', 'O app fecha e abre sozinho.')];
      break;
    case 'offline':
      body = [status('offline', 'Sem rede', 'Não deu para consultar o canal. Confira a conexão.'), el('div', { class: 'up-pa' }, search('Tentar de novo', true))];
      break;
    case 'channel-down':
      body = [status('error', 'Canal fora do ar', 'O canal de atualizações não respondeu. A próxima consulta segue o intervalo normal.'), el('div', { class: 'up-pa' }, search('Tentar de novo', true))];
      break;
    case 'error':
      body = [status('error', `Não deu para atualizar para a ${view.available?.version ?? ''}`, `Você continua na versão ${view.appVersion}.`), el('div', { class: 'up-pa' }, where === 'browser' ? button('Tentar de novo', null, { filled: true, disabled: true, why: 'Atualizar é no app, pela bandeja' }) : button('Tentar de novo', () => act('install'), { filled: true }), search())];
      break;
    case 'available': {
      const install = where === 'browser' ? button('Atualizar', null, { filled: true, disabled: true, why: 'Atualizar é no app, pela bandeja' }) : button('Atualizar', () => act('install'), { filled: true });
      body = [status('an-download', `Versão ${view.available.version} disponível`, view.available.notes ?? `Você está na versão ${view.appVersion}.`), el('div', { class: 'up-pa' }, install, search())];
      if (where === 'browser') body.splice(1, 0, el('span', { class: 'up-note' }, 'Atualizar é no app: abra pela bandeja.'));
      break;
    }
    default:
      body = [status('check-circle-2', 'Você está na versão mais nova', `${view.appVersion}${view.lastCheckAt ? ` · conferido ${now - view.lastCheckAt < 60_000 ? 'agora' : `há ${span(now - view.lastCheckAt)}`}` : ''}`), el('div', { class: 'up-pa' }, search())];
  }
  const line = view?.app ? cadence(view, now) : null;
  return el(
    'div',
    { class: 'up-panel card', role: 'dialog', 'aria-label': 'Versão do app' },
    el('div', { class: 'up-ph' }, el('div', { class: 'up-pn' }, el('b', {}, 'Ahrena Console'), el('small', { class: 'mono' }, view?.appVersion ? `v${view.appVersion}` : '')), mode ? el('span', { class: 'up-mode mono' }, mode.pill) : null),
    el('div', { class: 'up-body' }, ...body),
    mode ? el('div', { class: 'up-cad' }, line ? el('span', {}, line) : null, el('span', {}, `Consulta ${mode.every}${view.mode === 'dev' ? ' (modo dev)' : ''}`)) : null,
  );
}

/**
 * Wires the card and the panel. `noticeNode` is the strip above the screens; `panelNode` the popover;
 * `trigger()` returns the version button of the footer (redrawn by the shell), so the dot can follow.
 */
export function createAppUpdate({ read, write, noticeNode, panelNode, win = globalThis, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let view = null;
  let open = false;
  let doneTimer = null;
  const where = () => whereAmI(win);

  async function act(action, version) {
    try {
      view = await write(`${ACTION_ROUTE}${action}`, version ? { version } : null);
    } catch {
      // The núcleo said no (no app, a stale version): read what is true now.
      return refresh();
    }
    draw();
  }

  function draw() {
    const card = view ? drawNotice(view, { where: where(), act }) : null;
    if (card) {
      noticeNode.replaceChildren(card);
      noticeNode.removeAttribute('hidden');
    } else {
      noticeNode.replaceChildren();
      noticeNode.setAttribute('hidden', '');
    }
    // The "Atualizado" card goes by itself; Fechar does the same.
    // Only the app window times it out, and only while it is seen: a background tab must not eat the card.
    const seen = where() === 'app' && win.document?.visibilityState !== 'hidden';
    if (view?.updated && seen && !doneTimer) doneTimer = setTimer(() => ((doneTimer = null), act('ack')), DONE_MS);
    if (!view?.updated && doneTimer) (clearTimer(doneTimer), (doneTimer = null));
    if (open) drawOpenPanel();
  }

  function drawOpenPanel() {
    panelNode.replaceChildren(drawPanel(view ?? { app: false }, { where: where(), act, now: now() }));
    panelNode.removeAttribute('hidden');
  }

  async function refresh() {
    try {
      view = await read(APP_UPDATE_ROUTE);
    } catch {
      // A core without the route (an older one, --demo): no card, no dot.
      view = null;
    }
    draw();
    return view;
  }

  return {
    refresh,
    draw,
    act,
    /** The footer button: opens or closes the panel. */
    toggle() {
      open = !open;
      if (open) drawOpenPanel();
      else panelNode.setAttribute('hidden', '');
      return open;
    },
    close() {
      open = false;
      panelNode.setAttribute('hidden', '');
    },
    get isOpen() {
      return open;
    },
    get view() {
      return view;
    },
    /** Redraws the open panel (the relative times move); the shell calls it every 30 s. */
    tick() {
      if (open) drawOpenPanel();
    },
  };
}

/** A change batch with the app's update state moving. */
export const appUpdateChanged = (changes) => Array.isArray(changes) && changes.some((c) => c?.type === 'app-update');
