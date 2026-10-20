// The console shell (#26): sidebar, client-side routing, "Ao vivo" and the screen area.
// Screens register in screens.js; the screen contract is in README.md.

import { write, read } from './api.js';
import { startLive } from './live.js';
import { header, el, icon } from './dom.js';
import { error, empty } from './states.js';
import { findScreen, legacyUrl, litItem } from './screens.js';
import { createNav } from './nav.js';

const nav = document.getElementById('nav');
const area = document.getElementById('content');
const liveCard = document.getElementById('live');
const port = document.getElementById('port');

port.textContent = location.host;

// ---------- Sidebar ----------

// One block per section (C1, C24): the everyday screens, then Machines and Control. The remote
// machines (issue 178) come from `GET /api/machines` and are added by nav.js (`createNav`).
const { readMachines, highlight, counter } = createNav({ nav, read });
// A remote's state also changes without an alert (another version over there): re-read now and then.
setInterval(readMachines, 60_000);

// ---------- Live ----------

let version = null;
let liveState = { state: 'connecting', error: null, nextAttempt: null };
const listeners = { change: new Set(), restart: new Set() };

// The first `restart` is the connection's: the screen has just read, it does not need to re-read.
// After it (or after a drop), every `restart` makes the screen re-read.
let connected = false;
function restart() {
  readVersion();
  readMachines();
  if (!connected) return void (connected = true);
  if (screenFailed) return open();
  for (const f of listeners.restart) f();
}

async function readVersion() {
  try {
    version = (await read('/api/overview')).versao ?? null;
  } catch {}
  drawLive();
}

const LABELS = { connecting: 'Conectando', live: 'Ao vivo', offline: 'Sem conexão' };

function drawLive() {
  const { state, error: e, nextAttempt } = liveState;
  const seconds = nextAttempt ? Math.max(1, Math.round((nextAttempt - Date.now()) / 1000)) : null;
  liveCard.dataset.state = state;
  liveCard.title = state === 'offline' ? `${e?.message ?? 'O núcleo não respondeu'}. Tentando de novo${seconds ? ` em ${seconds} s` : ''}.` : '';
  liveCard.replaceChildren(
    icon(state === 'offline' ? 'offline' : 'live'),
    el('b', {}, LABELS[state]),
    el('span', { class: 'version mono' }, version ? `v${version}` : ''),
  );
  for (const p of document.querySelectorAll('[data-live]')) {
    p.dataset.state = state;
    p.textContent = LABELS[state];
  }
}

startLive({
  read,
  onState(next) {
    // After a drop, the next answer re-reads everything, even if it is the first.
    if (next.state === 'offline') connected = true;
    liveState = next;
    drawLive();
  },
  onRestart: restart,
  onChange(changes) {
    // A machine that goes down or comes back (`<id>:machine-unreachable`) changes its dot.
    if (changes.some((c) => c.tipo === 'alert')) readMachines();
    for (const f of listeners.change) f(changes);
  },
});

// ---------- Routing ----------

let leaving = null;
let screenFailed = false;

// `route` may carry the query (`/ui/agent-config?tab=skills`): it stays in the URL for the screen to read.
function navigate(route) {
  if (route !== location.pathname + location.search) history.pushState(null, '', route);
  open();
}

async function open() {
  leaving?.abort();
  const leave = new AbortController();
  leaving = leave;
  screenFailed = false;
  // An old URL (`/ui/sessoes/<id>`) becomes the new one, in place, before routing.
  const next = legacyUrl(location);
  if (next) history.replaceState(history.state, '', next);
  const found = findScreen(location.pathname);
  if (!found) {
    highlight(null);
    document.title = 'Ahrena Console';
    area.replaceChildren(empty({ title: 'Página não encontrada', text: `Nada em ${location.pathname}.`, action: { label: 'Ir para o Dashboard', onClick: () => navigate('/ui') } }));
    return;
  }
  const { screen, params } = found;
  highlight(litItem(screen, params));
  document.title = `Ahrena Console · ${screen.title}`;
  if (!screen.file) {
    area.replaceChildren(
      header({ icon: screen.icon, title: screen.title, sub: screen.sub ?? params.id ?? null }),
      empty({ title: 'Esta tela ainda não existe', text: 'Ela chega na próxima versão do console.' }),
    );
    drawLive();
    return;
  }
  const ctx = {
    params,
    read: (route, options) => read(route, { signal: leave.signal, ...options }),
    write: (route, body, options) => write(route, body, { signal: leave.signal, ...options }),
    signal: leave.signal,
    navigate,
    counter,
    title: (text) => (document.title = `Ahrena Console · ${text}`),
    onChange: (f) => (listeners.change.add(f), leave.signal.addEventListener('abort', () => listeners.change.delete(f))),
    onRestart: (f) => (listeners.restart.add(f), leave.signal.addEventListener('abort', () => listeners.restart.delete(f))),
    liveState: () => liveState.state,
  };
  try {
    const module = await import(screen.file);
    if (leave.signal.aborted) return;
    area.replaceChildren();
    const cleanup = await module.mount(area, ctx);
    if (typeof cleanup === 'function') leave.signal.addEventListener('abort', cleanup);
    drawLive();
  } catch (e) {
    if (leave.signal.aborted || e?.name === 'AbortError') return;
    screenFailed = true;
    area.replaceChildren(error({ title: 'A tela não abriu', text: e?.message ?? String(e), retry: () => open() }));
  }
}

// Internal links (`/ui...`) switch screens without reloading the page.
document.addEventListener('click', (ev) => {
  const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !(url.pathname === '/ui' || url.pathname.startsWith('/ui/'))) return;
  ev.preventDefault();
  navigate(url.pathname + url.search);
});
addEventListener('popstate', open);

open();
