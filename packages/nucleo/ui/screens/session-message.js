// Sending a message to a live session (#61, wireframes C51 to C53): the compose box at the bottom of
// the Detail's Conversa tab, and the "Mandar mensagem" action of the Dashboard and Sessões lists.
//
// The routes (src/api/messaging.ts):
// - `GET /api/sessions/<id>/messaging`: whether the box can send (`available` or `reason`), where the
//   live process runs (`entrypoint`, `remoteControl`, `account`, `configDir`) and the message in flight;
// - `POST /api/sessions/<id>/messages` `{ text }`: same origin only, the page's own `write()`;
// - `GET /api/sessions/<id>/messages/<messageId>`: the state, polled while it is "sending".
//
// What the person types lives only in the textarea and in the POST body: never in a URL, a log or the
// DOM as HTML. Everything from the core goes in through `textContent` (`el()`).

import { el, icon } from '../dom.js';

const HOUR = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** The text limit of the core, in UTF-8 bytes (decision 0003). */
export const MAX_BYTES = 16 * 1024;

/** How often the box asks for the state of a message in flight; the tests make it short. */
export const timing = { pollMs: 1000 };

const STYLE = '/ui/screens/session-message.css';

/** The sm- classes live in one file, shared by the Detail, the Dashboard and Sessões. */
export function useMessageStyle() {
  if (document.querySelector(`link[href="${STYLE}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'session-message' }));
}

/** The route of a session's messaging: `kind` is `messaging`, `messages` or `messages/<id>`. */
export const messagingRoute = (sessionId, kind) => `/api/sessions/${encodeURIComponent(sessionId)}/${kind}`;

/** The Detail on Conversa with the box focused: where "Mandar mensagem" goes. */
export const composeHref = (sessionId) => `/ui/sessions/${encodeURIComponent(sessionId)}?focus=message#conversation`;

/** The size the core counts: UTF-8 bytes. */
export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/** "51 / 16 KiB". */
export const counterText = (bytes) => `${bytes} / 16 KiB`;

/** Where the live process runs, as the person knows it; an unknown entrypoint is just "Claude Code". */
export function entrypointLabel(entrypoint) {
  return (
    {
      'claude-desktop': 'Claude Desktop',
      cli: 'Terminal',
      'sdk-cli': 'claude -p',
      'sdk-ts': 'Agent SDK',
      'sdk-py': 'Agent SDK',
      'claude-vscode': 'VS Code',
    }[entrypoint ?? ''] ?? 'Claude Code'
  );
}

/** "no Claude Desktop", "no terminal": where a permission is answered. */
function whereToAnswer(entrypoint) {
  return entrypoint === 'claude-desktop' ? 'no Claude Desktop' : entrypoint === 'cli' ? 'no terminal' : 'na sessão';
}

/** The issue of the delivery through the Workstation's core. */
const WORKSTATION_ISSUE = 282;

const NUMBER_WORDS = { 2: 'Dois', 3: 'Três', 4: 'Quatro' };

/** Why the box is off (C53): the bold title and the explanation. */
export function unavailableText(reason, processes = 0) {
  switch (reason) {
    case 'no_live_process':
      return { title: 'Sem processo vivo.', text: 'A sessão não está aberta nesta máquina, então não há para onde entregar. Abra no Claude Desktop; quando o processo voltar, a caixa liga sozinha.' };
    case 'other_machine':
      return { title: 'A sessão roda em outra máquina.', text: `A entrega pelo núcleo de lá vem no #${WORKSTATION_ISSUE}; o Remote Control não leva mensagem do console (só uma sessão do Claude logada manda por ele).` };
    case 'ambiguous': {
      const n = Number.isInteger(processes) && processes >= 2 ? processes : 2;
      return { title: `${NUMBER_WORDS[n] ?? n} processos dizem ser esta sessão.`, text: 'Para não entregar no lugar errado, não mandamos. Feche um deles e a caixa volta.' };
    }
    case 'unsupported_platform':
      return { title: 'Não dá neste sistema.', text: 'No Windows, a caixa de entrada da sessão exige o token dela, e o núcleo nunca lê esse arquivo.' };
    default:
      return { title: 'Mandar mensagem desligado.', text: 'O núcleo não disse por quê.' };
  }
}

/** Why a message was not delivered (C52, state 4), one sentence. */
export function failureText(reason) {
  return (
    {
      connection_refused: 'O processo da sessão recusou a conexão: ele pode ter saído agora.',
      socket_gone: 'A caixa de entrada da sessão sumiu: o processo pode ter saído agora.',
      timeout: 'A caixa de entrada da sessão não respondeu a tempo.',
      socket_error: 'Deu erro ao escrever na caixa de entrada da sessão.',
      no_live_process: 'A sessão não tem processo vivo nesta máquina.',
      ambiguous: 'Mais de um processo diz ser esta sessão, e não mandamos para não entregar no lugar errado.',
      other_machine: 'A sessão roda em outra máquina.',
      unsupported_platform: 'Neste sistema a caixa de entrada exige o token da sessão.',
    }[reason ?? ''] ?? 'A mensagem não chegou à sessão.'
  );
}

const hourOf = (iso) => (iso ? HOUR.format(new Date(iso)) : null);

/** The status line of a message, by its state (C52): `{ kind, icon, title, text }`, or `null`. */
export function messageStatus(message) {
  if (!message) return null;
  switch (message.state) {
    case 'sending':
      return { kind: 'busy', icon: 'wall-loader', title: 'Enviando…', text: 'Entregando na caixa de entrada da sessão. A caixa fica travada até a resposta do núcleo.' };
    case 'delivered': {
      const at = hourOf(message.deliveredAt ?? message.settledAt);
      return { kind: 'ok', icon: 'check-circle-2', title: at ? `Entregue às ${at}.` : 'Entregue.', text: at ? `A sessão começou um turno novo às ${at}; a mensagem está na conversa, acima.` : 'A sessão começou um turno novo; a mensagem está na conversa, acima.' };
    }
    case 'sent_unconfirmed': {
      const at = hourOf(message.sentAt ?? message.createdAt);
      return {
        kind: 'wait',
        icon: 'clock',
        title: at ? `Enviada às ${at}, sem confirmação.` : 'Enviada, sem confirmação.',
        text: 'Em 60 s a sessão não começou um turno novo. Ela pode estar segurando a mensagem pela política de mensagens entre sessões; entra quando a sessão aceitar. Mandar de novo duplica.',
      };
    }
    case 'not_delivered':
      return { kind: 'fail', icon: 'error', title: 'Não entregue.', text: `${failureText(message.reason)} O texto continua na caixa.` };
    default:
      return null;
  }
}

// ---------- Availability for the lists, without flooding the core ----------
//
// Each availability lists the live processes of every configuration folder, so the lists ask only
// for the rows on screen that can have a process (never a completed session), at most `PARALLEL` at
// a time, and keep the answer for `TTL_MS`: a live change re-draws the list from the cache.

const TTL_MS = 15_000;
const PARALLEL = 4;
const cache = new Map();

/** The availability of the session if the cache has a fresh one: the answer, `null` (unknown) or `undefined` (not asked). */
export function cachedAvailability(sessionId, now = Date.now()) {
  const c = cache.get(sessionId);
  if (!c || now - c.at > TTL_MS) return undefined;
  return c.value;
}

/** The last answer known, however old (a list draws it while a fresh one is on the way); `undefined` when never asked. */
export function lastAvailability(sessionId) {
  return cache.get(sessionId)?.value;
}

/** Keeps an answer read elsewhere (the Detail reads it fresh). */
export function rememberAvailability(sessionId, value, now = Date.now()) {
  cache.set(sessionId, { at: now, value });
}

/** Forgets every answer (tests). */
export function forgetAvailability() {
  cache.clear();
}

const pending = new Map();

/**
 * Asks for the availability of the `sessionIds` not in the cache, `PARALLEL` at a time, and calls
 * `onEach(id, value)` as each one comes back. A failure keeps `null` for the TTL, so a core without
 * the route is not asked again on every draw. A give-up (`AbortError`) keeps nothing.
 */
export async function loadAvailability(read, sessionIds, onEach = () => {}) {
  const missing = [...new Set(sessionIds)].filter((id) => cachedAvailability(id) === undefined);
  const queue = [...missing];
  async function worker() {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let p = pending.get(id);
      if (!p) {
        p = read(messagingRoute(id, 'messaging'))
          // An answer that is not an availability (an older core) is as good as no answer.
          .then((answer) => (typeof answer?.available === 'boolean' ? answer : null))
          .then((value) => (rememberAvailability(id, value), value))
          .catch((e) => {
            if (e?.name === 'AbortError') throw e;
            rememberAvailability(id, null);
            return null;
          })
          .finally(() => pending.delete(id));
        pending.set(id, p);
      }
      let value;
      try {
        value = await p;
      } catch (e) {
        if (e?.name !== 'AbortError') throw e;
        // The lookup was shared with a screen that left: ask again once, with this caller's own read.
        value = await read(messagingRoute(id, 'messaging'))
          .then((answer) => (typeof answer?.available === 'boolean' ? answer : null))
          .catch((e2) => (e2?.name === 'AbortError' ? undefined : null));
        if (value === undefined) return;
        rememberAvailability(id, value);
      }
      onEach(id, value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
}

/**
 * The list action (C53): a "Mandar mensagem" button when the session has one live process here,
 * "sem processo vivo" when it has none, and nothing while unknown. `compact` draws only the icon.
 */
export function messageAction(sessionId, availability, navigate, { variant = 'button' } = {}) {
  if (availability === undefined || availability === null) return null;
  if (!availability.available) {
    return availability.reason === 'no_live_process' ? el('span', { class: 'sm-none', title: 'Sem processo vivo nesta máquina' }, 'sem processo vivo') : null;
  }
  const go = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    navigate(composeHref(sessionId));
  };
  if (variant === 'link') {
    return el('button', { type: 'button', class: 'sm-link-action', onClick: go }, icon('conversation'), 'Mandar mensagem');
  }
  return el('button', { type: 'button', class: 'btn outline sm-row-action', title: 'Mandar mensagem', 'aria-label': 'Mandar mensagem', onClick: go }, icon('conversation'), el('span', { class: 'sm-row-label' }, 'Mandar mensagem'));
}

// ---------- The compose box (C51 to C53) ----------

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? '');

/**
 * The compose box of a session. `head()` is the Detail's top (`GET /api/sessions/<id>`): title,
 * `open` for the open action, the permission banner and its command. `openControl()` draws the Detail's
 * open action (issue 285) for a session with no live process, or `null`; `onDelivered()` re-reads the conversation.
 * Returns `{ node, refresh(), focus() }`.
 */
export function createComposeBox(ctx, sessionId, { head = () => null, openControl = () => null, onDelivered = () => {}, onShowConversation = () => {} } = {}) {
  useMessageStyle();
  const kbd = isMac() ? '⌘↵' : 'Ctrl↵';
  const placeholder = `Escreva para a sessão… (${kbd} envia)`;

  let availability = null;
  /** This box's own message, from the 202 of its POST: `{ messageId, state, … }`. Only it touches the text. */
  let message = null;
  /**
   * A message in flight that this box did not send (another tab, a reopened page): `{ messageId, text }`.
   * The box waits for it to settle, with the text untouched, and then sends again normally.
   */
  let foreign = null;
  /** A refusal or failure of the request itself: `{ kind, title, text }`. */
  let notice = null;
  let sending = false;
  let retryUntil = 0;
  let poll = null;
  let retryTimer = null;
  let wantFocus = false;

  const textarea = el('textarea', { class: 'sm-input', rows: '3', 'aria-label': 'Mensagem para a sessão', placeholder, spellcheck: 'true' });
  const counter = el('span', { class: 'sm-count mono' });
  const field = el('div', { class: 'sm-field' }, textarea, counter);
  const dest = el('div', { class: 'sm-dest' });
  const status = el('div', { class: 'sm-status-slot' });
  const actions = el('span', { class: 'sm-actions' });
  const note = el(
    'p',
    { class: 'sm-note' },
    icon('info'),
    el('span', {}, 'Chega à sessão como mensagem ', el('b', {}, 'de outra sessão'), ': não aprova permissão, não roda comando e não muda configuração.'),
  );
  const foot = el('div', { class: 'sm-foot' }, note, actions);
  const node = el('section', { class: 'card sm-compose', 'aria-label': 'Mandar mensagem à sessão' }, dest, field, status, foot);

  const text = () => textarea.value ?? '';
  const bytes = () => byteLength(text());
  const sendable = () => availability?.available && !sending && !foreign && text().trim().length > 0 && bytes() <= MAX_BYTES && Date.now() >= retryUntil;

  textarea.addEventListener('input', () => {
    // A new text after a settled message starts over: the old state no longer describes the box.
    if (!sending && message && message.state !== 'not_delivered') message = null;
    if (!sending) notice = null;
    draw();
  });
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      send();
    }
  });

  function commandButtons(remoteControl) {
    const why = 'Só o mod do painel roda comandos: mandado como mensagem, chegaria como texto';
    return [
      el('button', { type: 'button', class: 'sm-cmd mono', disabled: true, title: why }, '/compact'),
      el('button', { type: 'button', class: 'sm-cmd mono', disabled: true, title: why }, '/clear'),
      remoteControl ? null : el('button', { type: 'button', class: 'sm-cmd', disabled: true, title: 'Ligar o Remote Control desta sessão depende do mod do painel' }, icon('live'), 'Remote control'),
      el('span', { class: 'sm-why' }, icon('lock'), 'dependem do mod'),
    ];
  }

  function sendButton(label = 'Enviar', { busy = false, iconName = 'your-turn', enabled = sendable() } = {}) {
    return el(
      'button',
      { type: 'button', class: 'btn filled sm-send', disabled: !enabled, 'aria-busy': busy ? 'true' : null, onClick: () => send() },
      icon(iconName),
      label,
      label === 'Enviar' ? el('span', { class: 'sm-kbd mono' }, kbd) : null,
    );
  }

  function statusLine(s, action = null) {
    if (!s) return null;
    return el('div', { class: `sm-status sm-${s.kind}`, role: s.kind === 'fail' ? 'alert' : 'status' }, icon(s.icon), el('p', {}, el('b', {}, s.title), ' ', ...withCode(s.text)), action);
  }

  function destination(a) {
    const s = head()?.session;
    const account = a.account
      ? el('span', { class: 'sm-account', title: a.configDir ? `Conta da pasta ${a.configDir}` : null }, accountDot(a.account.color), a.account.label)
      : a.configDir
        ? el('span', { class: 'sm-account mono', title: 'Pasta de configuração do processo vivo' }, a.configDir)
        : null;
    return [
      el('span', { class: 'sm-to' }, 'Para'),
      el('b', { class: 'sm-title' }, s?.title ?? sessionId),
      el('span', { class: 'sm-chip' }, icon(a.entrypoint === 'cli' ? 'terminal' : 'monitor'), entrypointLabel(a.entrypoint)),
      account,
      a.remoteControl ? el('span', { class: 'sm-rc' }, icon('live'), 'Remote Control ligado') : null,
      el('span', { class: 'sm-live' }, el('i', { class: 'sm-dot' }), 'processo vivo nesta máquina'),
    ];
  }

  function permissionWarning() {
    const h = head();
    if (h?.session?.banner?.type !== 'permission' || !availability?.blockedOnPerson) return null;
    const command = h.command ? `o \`${h.command}\`` : 'a ferramenta';
    return statusLine({
      kind: 'wait',
      icon: 'shield',
      title: 'Esta mensagem não responde à permissão.',
      text: `Permitir ou negar ${command} continua ${whereToAnswer(availability.entrypoint)}. A mensagem espera na caixa de entrada da sessão e o Claude lê quando a ferramenta voltar.`,
    });
  }

  function draw() {
    const a = availability;
    const n = bytes();
    counter.textContent = counterText(n);
    counter.classList.toggle('sm-over', n > MAX_BYTES);
    counter.hidden = !text();

    if (!a) {
      node.setAttribute('class', 'card sm-compose sm-off');
      dest.replaceChildren();
      textarea.disabled = true;
      status.replaceChildren();
      actions.replaceChildren(sendButton('Enviar', { enabled: false }));
      note.hidden = true;
      return;
    }

    if (!a.available && !message) {
      // C53: dashed, no destination, no note and no commands; the reason and what to do.
      const why = unavailableText(a.reason, a.processes);
      node.setAttribute('class', 'card sm-compose sm-off');
      dest.replaceChildren();
      textarea.disabled = true;
      textarea.placeholder = 'Mandar mensagem desligado nesta sessão';
      status.replaceChildren(statusLine({ kind: 'info', icon: 'info', title: why.title, text: why.text }));
      note.hidden = true;
      actions.replaceChildren(...(a.reason === 'no_live_process' ? [openControl()].filter(Boolean) : []), sendButton('Enviar', { enabled: false }));
      // Nothing to focus: a box that turns on minutes later must not take the focus then.
      wantFocus = false;
      return;
    }

    node.setAttribute('class', 'card sm-compose');
    note.hidden = false;
    textarea.placeholder = placeholder;
    dest.replaceChildren(...(a.available ? destination(a).filter(Boolean) : []));
    const state = message?.state ?? null;
    textarea.disabled = sending || state === 'sending';
    textarea.classList.toggle('sm-faded', textarea.disabled);

    const lines = [];
    const s = messageStatus(sending ? { state: 'sending' } : message);
    if (s) lines.push(statusLine(s));
    if (foreign) lines.push(statusLine({ kind: 'wait', icon: 'clock', title: 'Outra mensagem a caminho.', text: foreign.text }));
    if (notice) lines.push(statusLine({ kind: notice.kind, icon: notice.kind === 'fail' ? 'error' : 'clock', title: notice.title, text: notice.text }));
    if (!s && !notice && !foreign) lines.push(permissionWarning());
    status.replaceChildren(...lines.filter(Boolean));

    const send = [];
    if (sending || state === 'sending') send.push(sendButton('Enviando…', { busy: true, iconName: 'wall-loader', enabled: false }));
    else if (state === 'not_delivered') send.push(sendButton('Tentar de novo', { iconName: 'refresh', enabled: sendable() }));
    else {
      if (state === 'delivered') send.push(el('button', { type: 'button', class: 'btn outline', onClick: () => onShowConversation() }, icon('conversation'), 'Ver na conversa'));
      send.push(sendButton());
    }
    actions.replaceChildren(...commandButtons(a.remoteControl).filter(Boolean), ...send);
    if (wantFocus && !textarea.disabled) {
      wantFocus = false;
      textarea.focus();
      node.scrollIntoView?.({ block: 'nearest' });
    }
  }

  const FOREIGN_TEXT = 'Ainda há uma mensagem a caminho desta sessão. Espere a confirmação.';

  async function readAvailability() {
    try {
      const a = await ctx.read(messagingRoute(sessionId, 'messaging'));
      availability = a;
      rememberAvailability(sessionId, a);
      // A message in flight that this box did not send (the page was reopened, another tab): wait for it.
      if (a.inFlight && !sending && message?.messageId !== a.inFlight && foreign?.messageId !== a.inFlight) {
        foreign = { messageId: a.inFlight, text: FOREIGN_TEXT };
        watch(a.inFlight);
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (!availability) availability = { available: false, reason: null, processes: 0 };
    }
    draw();
  }

  function stopPolling() {
    clearTimeout(poll);
    poll = null;
  }

  /** The id being watched: this box's own message while it is sending, or else the foreign one. */
  const watched = () => (message?.state === 'sending' ? message.messageId : (foreign?.messageId ?? null));

  /** Asks for the state of message `id` until it settles; a failing core is asked less and less often, then given up on. */
  function watch(id, failures = 0) {
    stopPolling();
    const delay = failures ? Math.min(timing.pollMs * 2 ** failures, timing.pollMs * 16) : timing.pollMs;
    poll = setTimeout(async () => {
      try {
        const m = await ctx.read(messagingRoute(sessionId, `messages/${encodeURIComponent(id)}`));
        if (watched() !== id) return;
        if (m.state === 'sending') return void watch(id);
        if (foreign?.messageId === id) {
          // Not ours: the text stays as it is, and the box can send again.
          foreign = null;
          return void draw();
        }
        settle(m);
      } catch (e) {
        if (e?.name === 'AbortError' || watched() !== id) return;
        if (e?.status === 404 || failures >= 5) return void lost(id, e?.status === 404);
        watch(id, failures + 1);
      }
    }, delay);
  }

  /** The core forgot the message (it restarted) or stopped answering: nobody knows whether it arrived. */
  function lost(id, forgotten) {
    if (foreign?.messageId === id) foreign = null;
    if (message?.messageId === id) message = null;
    notice = {
      kind: 'wait',
      title: 'Sem notícia da mensagem.',
      text: forgotten ? 'O núcleo reiniciou e não sabe mais dela. Veja na conversa se ela chegou antes de mandar de novo.' : 'O núcleo parou de responder sobre ela. Veja na conversa se ela chegou antes de mandar de novo.',
    };
    draw();
  }

  /** This box's own message changed state. */
  function settle(m) {
    message = m;
    if (m.state === 'sending') return void (draw(), watch(m.messageId));
    stopPolling();
    notice = null;
    // Delivered or sent: the text left the box. Not delivered: it stays, for "Tentar de novo".
    if (m.state === 'delivered' || m.state === 'sent_unconfirmed') textarea.value = '';
    if (m.state === 'delivered') onDelivered();
    draw();
  }

  async function send() {
    if (!sendable()) return;
    sending = true;
    notice = null;
    message = null;
    draw();
    try {
      const m = await ctx.write(messagingRoute(sessionId, 'messages'), { text: text() });
      sending = false;
      settle(m);
    } catch (e) {
      sending = false;
      if (e?.name === 'AbortError') return;
      const reason = e?.body?.reason ?? null;
      if (reason === 'in_flight' && e.body.messageId) {
        // Someone else's message is on the way: wait for it; this text stays in the box, unsent.
        foreign = { messageId: e.body.messageId, text: e.message || FOREIGN_TEXT };
        watch(e.body.messageId);
      } else if (reason === 'rate_limited') {
        const wait = Number(e.body.retryAfterMs) || e.retryIn || 10_000;
        retryUntil = Date.now() + wait;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => draw(), wait + 50);
        notice = { kind: 'wait', title: 'Espere um pouco.', text: e.message };
      } else {
        notice = { kind: 'fail', title: 'Não enviada.', text: e?.message ?? 'O núcleo não aceitou a mensagem.' };
      }
      draw();
    }
  }

  ctx.signal?.addEventListener?.('abort', () => {
    stopPolling();
    clearTimeout(retryTimer);
  });

  draw();
  readAvailability();
  return {
    node,
    /** Re-reads the availability (a live change of the session); the text and the message in flight stay. */
    refresh: () => (sending || watched() ? undefined : readAvailability()),
    /** Focuses the text as soon as the box can take it ("Mandar mensagem" from a list). */
    focus() {
      wantFocus = true;
      draw();
    },
  };
}

function accountDot(color) {
  const dot = el('i', { class: 'sm-account-dot' });
  if (/^#[0-9a-f]{3,8}$/i.test(color ?? '')) dot.style.setProperty('--sm-account-color', color);
  return dot;
}

/** Text with `code` between backticks: each piece becomes a text node or `<code>`, never HTML. */
function withCode(text) {
  return String(text ?? '')
    .split(/`([^`\n]+)`/)
    .map((p, i) => (i % 2 ? el('code', { class: 'sm-code' }, p) : p));
}
