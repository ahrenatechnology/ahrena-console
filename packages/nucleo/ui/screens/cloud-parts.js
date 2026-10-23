// The DOM pieces the cloud screens share (issue 277): Conexões (catalog and AWS, cloud-connections.js) and the
// "Perfis de nuvem" card of each machine (cloud-profiles.js). The texts come from cloud-format.js.
//
// - `createLogins` holds Entrar and Cancelar: POST and DELETE on the login route of the session the core
//   sent (this Mac or a remote one), the write in flight, the refusal in pt-BR, and the remote that cannot
//   log in by itself (C67 state 4: the screen shows the command instead).
// - `loginBandFor` draws what a session shows while a login runs or just ended: waiting for the browser
//   with the time against the limit (C59), the device code shown big with "Abrir a página de login" and
//   "Copiar o código" (C67), entered, did not finish, or the command to run over there.
// - `tickClocks` advances, once a second, the time of every running login on screen without repainting.

import { el, icon } from '../dom.js';
import { LOCAL_ID, canLogin, deviceCodeLeft, portalLine, endedText, fallbackCommand, isFallback, loginBand, loginClock, loginCommand, loginLabel, loginRoute, writeErrorText } from './cloud-format.js';

const STYLE = '/ui/screens/clouds.css';

/** Puts clouds.css in the head once, and takes it out when the screen goes. */
export function loadCloudStyle(signal) {
  const doc = globalThis.document;
  if (!doc?.head) return;
  let link = doc.head.querySelector('link[data-screen="clouds"]');
  if (!link) {
    link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'clouds' });
    doc.head.append(link);
  }
  signal?.addEventListener('abort', () => link.remove?.());
}

export const pill = ({ tone, label }) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);

const key = (machineId, name) => `${machineId}|${name}`;

/**
 * Entrar and Cancelar for the sessions of one screen. `onUpdate({ machineId, name, login })` runs after
 * every move (and with the core's `login` when a write answered one): the screen repaints and re-reads.
 */
export function createLogins({ ctx, onUpdate }) {
  const busy = new Map();
  const notices = new Map();
  const fallbacks = new Set();

  async function send(machineId, session, method) {
    const route = loginRoute(machineId, session?.name);
    const k = key(machineId, session?.name);
    if (!route || busy.has(k) || ctx.signal.aborted) return;
    busy.set(k, method);
    notices.delete(k);
    onUpdate({ machineId, name: session.name });
    let login = null;
    try {
      const body = method === 'DELETE' ? null : machineId === LOCAL_ID ? { mode: 'browser' } : {};
      const answer = await ctx.write(route, body, method === 'DELETE' ? { method } : undefined);
      login = answer?.login ?? null;
      fallbacks.delete(k);
    } catch (e) {
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      if (machineId !== LOCAL_ID && method === 'POST' && isFallback(e)) fallbacks.add(k);
      // Cancelar on a login that already ended (409 not-running): the re-read shows how it ended.
      else if (!(method === 'DELETE' && e?.status === 409)) notices.set(k, writeErrorText(e));
    } finally {
      busy.delete(k);
    }
    if (!ctx.signal.aborted) onUpdate({ machineId, name: session.name, login });
  }

  return {
    /** Entrar. On a remote whose CLI has no device code, it shows the command instead of asking. */
    start(machineId, session, aws) {
      if (machineId !== LOCAL_ID && aws && aws.cli.found && !aws.cli.deviceCodeSupported) {
        fallbacks.add(key(machineId, session.name));
        return onUpdate({ machineId, name: session.name });
      }
      return send(machineId, session, 'POST');
    },
    cancel: (machineId, session) => send(machineId, session, 'DELETE'),
    busy: (machineId, name) => busy.get(key(machineId, name)) ?? null,
    notice: (machineId, name) => notices.get(key(machineId, name)) ?? null,
    fallback: (machineId, name) => fallbacks.has(key(machineId, name)),
    dismiss(machineId, name) {
      notices.delete(key(machineId, name));
      fallbacks.delete(key(machineId, name));
      onUpdate({ machineId, name });
    },
  };
}

/** The action of a session's row or card: Cancelar while it runs, Entrar / Entrar de novo when it can. */
export function sessionAction(machineId, session, aws, logins, { offline = false } = {}) {
  if (offline) return null;
  const working = logins.busy(machineId, session.name);
  if (session.login.state === 'running') {
    return el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'cancel', 'data-session': session.name, disabled: Boolean(working), onClick: () => logins.cancel(machineId, session) }, icon('x'), 'Cancelar');
  }
  if (!canLogin(aws, session)) return null;
  const label = loginLabel(session);
  const filled = label === 'Entrar';
  return el(
    'button',
    { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, 'data-cl-action': 'login', 'data-session': session.name, disabled: Boolean(working), 'aria-busy': working ? 'true' : null, onClick: () => logins.start(machineId, session, aws) },
    icon(working ? 'refresh' : filled ? 'log-in' : 'refresh'),
    label,
  );
}

async function copy(text, node, label) {
  try {
    await globalThis.navigator?.clipboard?.writeText(String(text ?? ''));
    node.replaceChildren(icon('done'), 'Copiado');
  } catch {
    node.replaceChildren(icon('copy'), 'Selecione e copie');
  }
  setTimeout(() => node.replaceChildren(icon('copy'), label), 2000);
}

export function copyButton(text, label = 'Copiar') {
  const b = el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'copy' }, icon('copy'), label);
  b.addEventListener('click', () => copy(text, b, label));
  return b;
}

/** The band's text: the inline pieces (text, bold) run together in one paragraph; each block goes on its own line. */
function bandText(body) {
  const out = [];
  let line = null;
  for (const part of body) {
    if (part === null || part === undefined || part === false) continue;
    const inline = typeof part === 'string' || ['B', 'SPAN', 'CODE'].includes(part.tagName);
    if (inline) {
      line ??= el('p', { class: 'cl-band-line' });
      line.append(part);
      continue;
    }
    if (line) out.push(line);
    line = null;
    out.push(part);
  }
  if (line) out.push(line);
  return out;
}

const band = (tone, iconName, body, actions = [], role = 'status') =>
  el('div', { class: `cl-band cl-band-${tone}`, role }, el('span', { class: `cl-band-ic${tone === 'running' ? ' cl-spin' : ''}` }, icon(iconName)), el('div', { class: 'cl-band-text' }, ...bandText(body)), actions.length ? el('div', { class: 'cl-band-actions' }, ...actions) : null);

/** The time against the limit; `tickClocks` advances it. */
function clock(login, now) {
  const c = loginClock(login, now);
  return el(
    'div',
    { class: 'cl-time' },
    el('progress', { class: 'cl-progress', max: c.max, value: c.seconds, 'data-cl-bar': '', 'data-cl-start': login.startedAt ?? '', 'data-cl-max': c.max }),
    el('span', { 'data-cl-elapsed': '', 'data-cl-start': login.startedAt ?? '', 'data-cl-max': c.max }, `${c.elapsed} de ${c.limit}`),
  );
}

/** Advances every running login's time inside `root`, once a second, without repainting. */
export function tickClocks(root, now = Date.now()) {
  for (const n of root.querySelectorAll('[data-cl-elapsed]')) {
    const c = loginClock({ startedAt: n.getAttribute('data-cl-start'), timeoutSeconds: Number(n.getAttribute('data-cl-max')) || 300 }, now);
    const tail = n.textContent.includes(' · ') ? n.textContent.slice(n.textContent.indexOf(' · ')) : '';
    n.textContent = `${c.elapsed} de ${c.limit}${tail}`;
  }
  for (const n of root.querySelectorAll('[data-cl-bar]')) {
    const c = loginClock({ startedAt: n.getAttribute('data-cl-start'), timeoutSeconds: Number(n.getAttribute('data-cl-max')) || 300 }, now);
    n.setAttribute('value', String(c.seconds));
  }
}

const steps = (on) =>
  el(
    'div',
    { class: 'cl-steps' },
    ...['rodando o login da aws CLI', 'aguardando o navegador', 'conferindo a sessão'].flatMap((s, i) => [
      i ? el('span', { class: 'cl-step-sep', 'aria-hidden': 'true' }, '→') : null,
      el('span', { class: `cl-step${i < on ? ' cl-step-done' : i === on ? ' cl-step-on' : ''}` }, icon(i < on ? 'check-circle-2' : i === on ? 'wall-loader' : 'circle'), s),
    ]),
  );

// Which page the person is about to confirm on (decision 0013 §2a).
function portalNote(uri, session) {
  const line = portalLine(uri, session);
  return line ? [el('div', { class: 'cl-portal' }, 'A página é ', el('b', { class: 'mono' }, line.host), line.text)] : [];
}

function deviceCodeBand(session, where, now) {
  const l = session.login;
  const dc = l.deviceCode;
  const body = [el('b', {}, `Entrando na AWS na ${where}…`), ' '];
  if (!dc) {
    body.push('Esperando a aws CLI de lá mostrar o código de confirmação.', clock(l, now));
  } else {
    const open = el('a', { class: 'btn filled', href: dc.verificationUri, target: '_blank', rel: 'noopener noreferrer', 'data-cl-action': 'open-login' }, icon('external'), 'Abrir a página de login');
    body.push(
      'A aws CLI de lá espera você confirmar este código no navegador ',
      el('b', {}, 'deste Mac'),
      ':',
      el('div', { class: 'cl-code-row' }, el('span', { class: 'mono cl-user-code', 'aria-label': `Código ${dc.userCode}` }, dc.userCode), open, copyButton(dc.userCode, 'Copiar o código')),
      ...portalNote(dc.verificationUri, session),
    );
    const c = loginClock(l, now);
    const left = deviceCodeLeft(dc, now);
    body.push(
      el(
        'div',
        { class: 'cl-time' },
        el('progress', { class: 'cl-progress', max: c.max, value: c.seconds, 'data-cl-bar': '', 'data-cl-start': l.startedAt ?? '', 'data-cl-max': c.max }),
        el('span', { 'data-cl-elapsed': '', 'data-cl-start': l.startedAt ?? '', 'data-cl-max': c.max }, `${c.elapsed} de ${c.limit}${left ? ` · ${left}` : ''}`),
      ),
    );
  }
  body.push(el('div', { class: 'mono cl-cmd' }, `Roda lá: ${loginCommand(session, 'device-code')}`));
  return band('running', 'wall-loader', body);
}

/**
 * The band of one session, or `null`: the refusal of the last write, the command to run over there,
 * the login running, or how it just ended. `where` is the remote machine's label, `null` for this Mac.
 */
export function loginBandFor(machineId, session, aws, logins, { where = null, now = Date.now() } = {}) {
  const notice = logins.notice(machineId, session.name);
  if (notice) {
    return band('error', 'error', [el('b', {}, 'Não deu certo. '), notice], [el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'dismiss', onClick: () => logins.dismiss(machineId, session.name) }, 'Fechar')], 'alert');
  }
  if (logins.fallback(machineId, session.name)) {
    const cmd = fallbackCommand(session);
    return band(
      'neutral',
      'terminal',
      [
        el('b', {}, 'O núcleo de lá não sabe entrar sozinho. '),
        `A aws CLI da ${where ?? 'máquina'} é anterior ao login por código (ou o núcleo de lá é de uma versão antiga). Rode num terminal de lá:`,
        el('div', { class: 'mono cl-config' }, cmd),
      ],
      [copyButton(cmd, 'Copiar'), el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'dismiss', onClick: () => logins.dismiss(machineId, session.name) }, 'Fechar')],
    );
  }
  const kind = loginBand(session, now);
  if (!kind) return null;
  const l = session.login;
  if (kind === 'running') {
    if (l.mode === 'device-code' || machineId !== LOCAL_ID) return deviceCodeBand(session, where ?? 'máquina', now);
    return band('running', 'wall-loader', [
      el('b', {}, `Entrando em ${session.name}…`),
      ' aguardando o login no navegador. A página que abriu é sua: entre por lá e o console segue sozinho.',
      steps(1),
      clock(l, now),
      el('div', { class: 'mono cl-cmd' }, `Roda: ${loginCommand(session, 'browser')} · até ${Math.round((l.timeoutSeconds ?? 300) / 60)} min`),
    ]);
  }
  const t = endedText(kind, session, { where: machineId === LOCAL_ID ? null : where, now });
  if (kind === 'succeeded') return band('ok', 'check-circle-2', [el('b', {}, t.title), ` ${t.text}`]);
  const retry = canLogin(aws, session) ? [el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'retry', 'data-session': session.name, onClick: () => logins.start(machineId, session, aws) }, icon('refresh'), 'Tentar de novo')] : [];
  return band('error', kind === 'timed-out' ? 'hourglass' : 'error', [el('b', {}, t.title), ` ${t.text}`, l.logFile ? el('div', { class: 'mono cl-cmd' }, `A saída ficou no log da instalação: ${l.logFile}`) : null], retry);
}

/** Whether any login on screen is running (the screen then re-reads sooner and ticks the clocks). */
export const anyRunning = (sessions) => sessions.some((s) => s.login.state === 'running');
