// The remote machine's connection on its screen (issue 278, decision 0013, wireframes C62 to C65): the card
// "Conexão" (the trio Túnel / Sessão AWS / Núcleo de lá, the tunnel's ports, what runs, Reconectar and
// Parar o túnel), the card "Onde roda" (provider, kind, region and id, read by the core over there), and
// the band above them: the reason of a drop in plain words with the right action (SSO expired: "Entrar na
// AWS e subir o túnel" and "Só entrar"), the job that runs (its steps and time against the limit, with
// Cancelar), the Parar confirmation, "Parada por você" and the warning before the session expires.
//
// - machine.js mounts it with a small hook: `machineConnection(ctx, id, { reread, repaint })` once,
//   `take(machinesBody, telemetry)` after every read, and `view(data, legacy)` in every paint, which gives
//   `null` when the core sent no `connection` (an older core: the screen stays as it was), or the parts
//   that go above the reading (`legacy` is what C26 and C50 would have shown, kept where it still applies).
// - The writes take only the machine id: POST `/api/machines/<id>/connection/<action>`, DELETE to cancel.
//   "Só entrar" is the issue-277 login of this Mac's session of the linked profile, in browser mode.
// - Live: machine.js re-reads on `<id>:connection` (an `alert` change); "Só entrar" follows its login on
//   the `connector` changes and every 3 s while it runs. The clocks tick here once a second.

import { el, icon } from '../dom.js';
import { LOCAL_ID, TUNNEL_PORT_STATE, remoteCondition } from './machine-format.js';
import { CONNECTORS_ROUTE, RUNNING_POLL_MS, loginClock, loginRoute, normalizeConnectors } from './cloud-format.js';
import {
  actionRoute,
  cancelRoute,
  cardActions,
  commandLines,
  connectionExample,
  connectionMode,
  connectionPill,
  connectionPorts,
  connectionTrio,
  downBand,
  endedJobNote,
  expiringWarning,
  headerWithPlacement,
  jobBand,
  jobSteps,
  loginLine,
  normalizeConnection,
  normalizePlacement,
  placementView,
  reasonBand,
  stepClock,
  stopDialog,
  stoppedBand,
  writeProblem,
} from './machine-connection-format.js';

const STYLE = '/ui/screens/machine-connection.css';

function attachSheet(signal) {
  const doc = globalThis.document;
  if (!doc?.head) return;
  let link = doc.head.querySelector('link[data-screen="machine-connection"]');
  if (!link) {
    link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'machine-connection' });
    doc.head.append(link);
  }
  signal?.addEventListener('abort', () => link.remove?.());
}

const pill = ([tone, label]) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);

function button({ label, iconName = null, kind = 'outline', action, busy = false, disabled = false, onClick = null }) {
  return el(
    'button',
    { type: 'button', class: `btn ${kind}`, 'data-mc-action': action, 'aria-busy': busy ? 'true' : null, disabled: disabled || busy, onClick },
    iconName ? icon(iconName) : null,
    label,
  );
}

/** A band in the C50 look (machine.css): icon, the text column, the buttons on the right. */
function band({ tone, iconName, spin = false, role = 'status', title, text = null, lines = [], actions = [], part = 'connection-band' }) {
  const cls = tone === 'error' ? 'error-band tm-rc-band tm-rc-error' : tone === 'neutral' ? 'tm-rc-band mc-neutral' : tone === 'ok' ? 'tm-rc-band tm-rc-ok' : 'tm-rc-band tm-rc-running';
  return el(
    'div',
    { class: cls, role, 'data-part': part, 'data-tone': tone },
    el('span', { class: `tm-rc-ic${spin ? ' tm-rc-spin' : ''}` }, icon(iconName)),
    el('div', { class: 'tm-rc-text' }, el('p', {}, el('b', {}, title), text ? ` ${text}` : null), ...lines),
    actions.filter(Boolean).length ? el('div', { class: 'tm-rc-actions' }, ...actions.filter(Boolean)) : null,
  );
}

const line = (cls, text) => (text ? el('p', { class: cls }, text) : null);

function clock(start, max, now, parts) {
  const c = parts(now);
  return el(
    'div',
    { class: 'tm-rc-time' },
    c.max ? el('progress', { class: 'tm-rc-bar', max: c.max, value: c.seconds, 'aria-label': 'Tempo contra o limite', 'data-mc-bar': '', 'data-mc-start': start ?? '', 'data-mc-max': c.max }) : null,
    el('span', { class: 'mono', 'data-mc-elapsed': '', 'data-mc-start': start ?? '', 'data-mc-max': c.max ?? '' }, c.limit ? `${c.elapsed} de ${c.limit}` : c.elapsed),
  );
}

function steps(job, label) {
  return el(
    'ol',
    { class: 'tm-rc-steps', 'aria-label': 'Andamento' },
    ...jobSteps(job, label).map((s) => el('li', { class: s.at === 'done' ? 'tm-rc-done' : s.at === 'on' ? 'tm-rc-on' : null }, icon(s.at === 'done' ? 'wall-check' : s.at === 'on' ? 'wall-loader' : 'dot'), s.label)),
  );
}

// ---------- the cards ----------

const TONE = { ok: 'mc-ok', warn: 'mc-warn', bad: 'mc-bad', off: 'mc-off' };

function trioNode(cells) {
  return el(
    'div',
    { class: 'mc-trio' },
    ...cells.map((c) => el('div', { class: 'mc-cell', 'data-cell': c.key }, el('span', { class: 'mc-k' }, c.label), el('span', { class: `mc-v ${TONE[c.tone]}` }, icon(c.icon), el('span', {}, c.value)), el('span', { class: 'mc-s' }, c.sub))),
  );
}

function portsNode(rows, machine) {
  if (!rows.length) return el('p', { class: 'mc-muted' }, machine?.port ? `Nenhum processo ssh encaminha a porta ${machine.port} deste Mac agora.` : 'Nenhum processo ssh encaminha portas agora.');
  const td = (content, cls = null) => el('td', { class: cls }, content);
  return el(
    'table',
    { class: 'tm-table tm-cols-tunnel' },
    el('thead', {}, el('tr', {}, ...['No Mac', 'Lá', 'Estado', 'O que é'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((p) => el('tr', { 'data-port': p.localPort }, td(String(p.localPort), 'mono'), td(String(p.remotePort), 'mono'), el('td', {}, pill(TUNNEL_PORT_STATE[p.state])), td(p.what, p.muted ? 'mc-muted' : null)))),
  );
}

// The buttons sit beside the heading, not inside it: the heading's name stays "Conexão".
function title(iconName, text, note, actions = []) {
  const h = el('h2', { class: 'mc-title' }, icon(iconName), el('span', {}, text), note ? el('small', { class: 'mc-note' }, note) : null);
  return actions.length ? el('div', { class: 'mc-head' }, h, el('div', { class: 'mc-act' }, ...actions)) : h;
}

function placementCard(placement, { stale, hasReading, wide = false }) {
  const v = placementView(placement, { stale, hasReading });
  return el(
    'section',
    { class: `card mc-card mc-place${wide ? ' mc-wide' : ''}`, 'data-part': 'placement' },
    title('map-pin', 'Onde roda', 'lido pelo núcleo de lá'),
    el('div', { class: 'mc-kv' }, ...v.fields.map((f) => el('div', { 'data-field': f.key }, el('span', { class: 'mc-k' }, f.label), el('span', { class: `mc-kv-v${v.known ? '' : ' mc-muted'}${f.mono ? ' mono' : ''}` }, f.value)))),
    el('p', { class: 'mc-src' }, v.source),
  );
}

function setupCard(machine) {
  return el(
    'section',
    { class: 'card mc-card mc-setup', 'data-part': 'connection-setup' },
    title('cable', 'Conexão', 'só com o comando de subir'),
    el('p', { class: 'mc-muted' }, 'Esta máquina tem só o ', el('code', {}, 'reconnect'), ': o Reconectar continua igual. Com uma ', el('code', {}, 'connection'), ', ganha Subir, Parar, o estado da sessão de nuvem que o túnel exige e o motivo da queda.'),
    el('pre', { class: 'tm-config' }, connectionExample(machine)),
    el('div', { class: 'tm-legend' }, el('span', {}, icon('list'), ' Listas, sem shell: só roda o que está no arquivo.'), el('span', {}, icon('cloud'), ' O perfil precisa existir em Conexões › AWS.'), el('span', {}, icon('lock'), ' Nada da tela vira comando.')),
  );
}

const grid = (...cards) => el('div', { class: 'mc-grid' }, ...cards);

// ---------- the controller ----------

export function machineConnection(ctx, id, { reread = () => {}, repaint = () => {} } = {}) {
  let connection = null;
  let placement = null;
  let hasReading = false;
  let pending = null;
  let problem = null; // { key, message }
  let dialog = false;
  let focusNext = null;
  // "Só entrar": the login of this Mac's session, followed here. `{ session, login }`.
  let only = null;
  let onlyTimer = null;
  let started = false;
  // The nodes of the last paint: the clocks tick and the focus lands inside them.
  let rendered = [];
  const find = (selector) => rendered.flatMap((n) => [...(n.matches?.(selector) ? [n] : []), ...n.querySelectorAll(selector)]);

  const keyOf = () => `${connection?.state ?? ''}|${connection?.job?.startedAt ?? ''}|${connection?.job?.state ?? ''}`;

  function changed() {
    repaint();
    if (focusNext) {
      const target = focusNext;
      focusNext = null;
      setTimeout(() => find(`[data-mc-action="${target}"]`)[0]?.focus?.(), 0);
    }
  }

  async function act(action) {
    if (pending || ctx.signal.aborted) return;
    pending = action;
    problem = null;
    if (action !== 'only-login') only = only?.login.state === 'running' ? only : null;
    changed();
    try {
      if (action === 'cancel') {
        const answer = await ctx.write(cancelRoute(id), null, { method: 'DELETE' });
        take1(answer?.connection);
      } else if (action === 'only-login') {
        const session = connection?.cloud?.session;
        const route = loginRoute(LOCAL_ID, session);
        if (!route) throw Object.assign(new Error('a sessão deste perfil não tem um nome que vá para a linha de comando'), { status: 409 });
        const answer = await ctx.write(route, { mode: 'browser' });
        only = { session, login: loginOf(answer?.login) ?? { state: 'running', startedAt: new Date().toISOString(), timeoutSeconds: 300, endedAt: null } };
        followOnly();
      } else if (action === 'only-login-cancel') {
        const route = loginRoute(LOCAL_ID, only?.session);
        if (route) {
          const answer = await ctx.write(route, null, { method: 'DELETE' });
          if (only) only = { ...only, login: loginOf(answer?.login) ?? { ...only.login, state: 'canceled', endedAt: new Date().toISOString() } };
        }
      } else {
        dialog = false;
        const answer = await ctx.write(actionRoute(id, action), {});
        take1(answer?.connection);
      }
    } catch (e) {
      pending = null;
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      // Cancelar on something that already ended (409): the re-read shows how it ended.
      if (!((action === 'cancel' || action === 'only-login-cancel') && e?.status === 409)) problem = { key: keyOf(), message: writeProblem(e, action === 'only-login-cancel' ? 'cancel' : action) };
    }
    pending = null;
    if (ctx.signal.aborted) return;
    changed();
    reread();
  }

  function take1(raw) {
    const c = normalizeConnection(raw);
    if (c) connection = c;
  }

  const loginOf = (l) => (l && typeof l === 'object' && typeof l.state === 'string' ? { state: l.state, startedAt: l.startedAt ?? null, endedAt: l.endedAt ?? null, timeoutSeconds: Number.isInteger(l.timeoutSeconds) ? l.timeoutSeconds : 300 } : null);

  async function readOnly() {
    if (!only || ctx.signal.aborted) return;
    try {
      const c = normalizeConnectors(await ctx.read(CONNECTORS_ROUTE));
      const s = c?.aws?.sessions.find((x) => x.name === only?.session);
      if (s && only) {
        const was = only.login.state;
        only = { ...only, login: loginOf(s.login) ?? only.login };
        if (was === 'running' && only.login.state !== 'running') reread();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
    if (!ctx.signal.aborted) changed();
    followOnly();
  }

  function followOnly() {
    clearTimeout(onlyTimer);
    if (only?.login.state === 'running' && !ctx.signal.aborted) onlyTimer = setTimeout(readOnly, RUNNING_POLL_MS);
  }

  // The clocks on screen, once a second, without repainting.
  function tick() {
    const now = Date.now();
    for (const n of find('[data-mc-elapsed]')) {
      const max = Number(n.getAttribute('data-mc-max')) || null;
      const c = stepClock({ stepStartedAt: n.getAttribute('data-mc-start'), stepTimeoutSeconds: max }, now);
      n.textContent = c.limit ? `${c.elapsed} de ${c.limit}` : c.elapsed;
    }
    for (const n of find('[data-mc-bar]')) {
      const c = stepClock({ stepStartedAt: n.getAttribute('data-mc-start'), stepTimeoutSeconds: Number(n.getAttribute('data-mc-max')) || null }, now);
      n.setAttribute('value', String(c.seconds));
    }
  }

  const ticker = setInterval(tick, 1000);
  ctx.onChange((changes) => {
    if (only && changes.some((c) => c?.type === 'connector')) readOnly();
  });
  const stop = () => {
    clearInterval(ticker);
    clearTimeout(onlyTimer);
  };
  if (ctx.signal.aborted) stop();
  else ctx.signal.addEventListener('abort', stop);

  // ---------- the parts of one paint ----------

  function bandFor(machine, reading, legacy, now) {
    const c = connection;
    const label = machine?.label ?? id;
    const busy = (a) => pending === a;
    const job = c.job?.state === 'running' ? c.job : null;
    const buttons = {
      'only-login': () => (c.cloud?.session && !job ? button({ label: 'Só entrar', iconName: 'log-in', action: 'only-login', busy: busy('only-login'), disabled: Boolean(pending), onClick: () => act('only-login') }) : null),
      'login-and-start': () =>
        c.actions.loginAndStart
          ? button({ label: 'Entrar na AWS e subir o túnel', iconName: 'log-in', kind: 'filled', action: 'login-and-start', busy: busy('login-and-start'), disabled: Boolean(pending), onClick: () => act('login-and-start') })
          : buttons.start('Subir o túnel'),
      start: (label = 'Tentar de novo') => (c.actions.start ? button({ label, iconName: label === 'Subir o túnel' ? 'resume' : 'refresh', kind: 'filled', action: 'start', busy: busy('start'), disabled: Boolean(pending), onClick: () => act('start') }) : null),
      retry: () => button({ label: 'Tentar agora', iconName: 'refresh', action: 'retry', onClick: () => reread() }),
      'see-local': () => button({ label: 'Ver em Esta máquina', action: 'see-local', onClick: () => ctx.navigate('/ui/machines/local') }),
    };
    const shownProblem = problem && problem.key === keyOf() ? line('tm-rc-problem', problem.message) : null;
    const note = line('tm-rc-note', endedJobNote(c, now) ?? onlyNote());

    if (job) {
      const b = jobBand(c, label, now);
      return band({
        tone: 'running',
        iconName: 'wall-loader',
        spin: true,
        title: b.title,
        text: b.text,
        lines: [steps(job, label), clock(job.stepStartedAt, job.stepTimeoutSeconds, now, (t) => stepClock(job, t)), line('tm-rc-cmd', b.command), shownProblem],
        actions: [button({ label: 'Cancelar', iconName: 'x', action: 'cancel', busy: busy('cancel'), onClick: () => act('cancel') })],
      });
    }
    if (only?.login.state === 'running') {
      const l = only.login;
      return band({
        tone: 'running',
        iconName: 'wall-loader',
        spin: true,
        title: 'Entrando na AWS…',
        text: 'aguardando o login no navegador. Só o login: o túnel fica como está.',
        lines: [clock(l.startedAt, l.timeoutSeconds, now, (t) => loginClock(l, t)), line('tm-rc-cmd', `Roda: ${loginLine(only.session)}`), shownProblem],
        actions: [button({ label: 'Cancelar', iconName: 'x', action: 'only-login-cancel', busy: busy('only-login-cancel'), onClick: () => act('only-login-cancel') })],
      });
    }
    if (c.state === 'stopped') {
      const b = stoppedBand(c, machine);
      return band({ tone: 'neutral', iconName: 'pause', title: b.title, text: b.text, lines: [shownProblem] });
    }
    if (c.state === 'up') {
      const w = expiringWarning(c, machine, now);
      if (w) return band({ tone: 'running', iconName: 'alert', title: w.title, text: w.text, lines: [line('mc-from', w.from), note, shownProblem], actions: [c.cloud?.session ? button({ label: 'Entrar na AWS', iconName: 'log-in', kind: 'filled', action: 'only-login', busy: busy('only-login'), disabled: Boolean(pending), onClick: () => act('only-login') }) : null] });
      if (shownProblem) return band({ tone: 'error', iconName: 'error', role: 'alert', title: problem.message, actions: [button({ label: 'Fechar', action: 'dismiss', onClick: () => ((problem = null), changed()) })] });
      return null;
    }
    const r = reasonBand(c, machine, reading, now) ?? (remoteCondition(machine) === 'first-read' && legacy.parts.length ? null : downBand(c, machine, reading, now));
    if (!r) return shownProblem ? band({ tone: 'error', iconName: 'error', role: 'alert', title: problem.message }) : null;
    return band({
      tone: r.tone === 'waiting' ? 'running' : 'error',
      iconName: r.icon,
      role: r.tone === 'error' ? 'alert' : 'status',
      title: r.title,
      text: r.text,
      lines: [line('mc-from', r.from), note, line('tm-rc-cmd', r.command), shownProblem],
      actions: r.actions.map((a) => buttons[a]?.(a === 'start' && r.kind === 'down' ? 'Subir o túnel' : undefined)),
      part: 'connection-band',
    });
  }

  function onlyNote() {
    const l = only?.login;
    if (!l || l.state === 'running' || l.state === 'succeeded') return null;
    return l.state === 'canceled' ? 'O login foi cancelado; a sessão continua como estava.' : 'O login não terminou; a sessão continua como estava.';
  }

  function connectionCard(machine, reading, data, now) {
    const c = connection;
    const busy = (a) => pending === a;
    const actions = cardActions(c).map((a) =>
      a === 'reconnect'
        ? button({ label: 'Reconectar', iconName: 'refresh', action: 'reconnect', busy: busy('reconnect'), disabled: Boolean(pending), onClick: () => act('reconnect') })
        : a === 'stop'
          ? button({ label: 'Parar o túnel', iconName: 'square', action: 'stop-ask', disabled: Boolean(pending), onClick: () => ((dialog = true), (focusNext = 'dialog-cancel'), changed()) })
          : button({ label: 'Subir o túnel', iconName: 'resume', kind: 'filled', action: 'start', busy: busy('start'), disabled: Boolean(pending), onClick: () => act('start') }),
    );
    const cmds = commandLines(c);
    return el(
      'section',
      { class: 'card mc-card mc-conn', 'data-part': 'connection', 'data-state': c.state },
      title('cable', 'Conexão', c.cloud ? 'túnel SSH sobre AWS SSM' : 'o túnel do machines.json', actions),
      trioNode(connectionTrio(c, machine, reading, now)),
      portsNode(connectionPorts(c, machine, reading?.ports ?? null), machine),
      cmds.length ? el('div', { class: 'mc-cmds' }, ...cmds.map((t) => el('span', {}, t))) : null,
    );
  }

  function dialogNode(machine) {
    const d = stopDialog(connection, machine);
    const close = () => ((dialog = false), (focusNext = 'stop-ask'), changed());
    const node = el(
      'section',
      { class: 'card mc-dialog', role: 'dialog', 'aria-labelledby': 'mc-dialog-title', 'data-part': 'stop-dialog' },
      el('h2', { id: 'mc-dialog-title' }, d.title),
      el('p', {}, d.text),
      line('tm-rc-cmd', d.command),
      el(
        'div',
        { class: 'mc-dact' },
        button({ label: 'Cancelar', action: 'dialog-cancel', onClick: close }),
        button({ label: 'Parar o túnel', iconName: 'square', kind: 'mc-danger', action: 'stop', busy: pending === 'stop', onClick: () => act('stop') }),
      ),
    );
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    return node;
  }

  return {
    /** After every read of the machine screen: the raw `GET /api/machines` and `GET /api/telemetry` answers. */
    take(machinesBody, telemetry) {
      const raw = Array.isArray(machinesBody) ? machinesBody.find((m) => m && m.id === id) : null;
      connection = normalizeConnection(raw?.connection);
      hasReading = Boolean(telemetry?.current);
      placement = normalizePlacement(telemetry?.current?.placement);
      if (connection && !started) {
        started = true;
        attachSheet(ctx.signal);
      }
    },
    /** The header's state pill, or `null` for the machine screen's own. */
    pill() {
      return connection && connectionMode(connection) === 'full' ? connectionPill(connection) : null;
    },
    /** The header's line with the provider and the region. */
    headerLine(text) {
      return connection ? headerWithPlacement(text, placement) : text;
    },
    /**
     * What goes above the reading, `{ faded, parts }`, or `null` without a `connection` (the screen as it
     * was). `legacy` is what the machine screen would show without it (C26 and C50).
     */
    view(data, legacy, now = Date.now()) {
      if (!connection) return null;
      const mode = connectionMode(connection);
      const { machine, reading } = data;
      const offline = machine?.state !== 'connected' && machine?.state !== 'incompatible-version';
      const place = (wide = false) => placementCard(placement, { stale: offline, hasReading, wide });
      if (mode === 'none') return { faded: legacy.faded, parts: [...legacy.parts, grid(place(true))] };
      if (mode === 'start-only') return { faded: legacy.faded, parts: [...legacy.parts, grid(setupCard(machine), place())] };
      if (connection.state !== 'up' || !connection.command?.stop) dialog = false;
      const b = bandFor(machine, reading, legacy, now);
      const parts = [];
      if (b) parts.push(b);
      // Up with another telemetry version, or the green "Reconectada" of C50: the old part still says it.
      // Its "the app only shows" note is not true any more: it stays out.
      else if (connection.state === 'up' || remoteCondition(machine) === 'first-read') parts.push(...legacy.parts.filter((p) => !p.classList?.contains('tm-only-shows')));
      const top = grid(connectionCard(machine, reading, data, now), place());
      if (dialog) parts.push(dialogNode(machine), el('div', { class: 'tm-faded' }, top));
      else parts.push(top);
      const faded = offline && remoteCondition(machine) !== 'first-read';
      rendered = parts;
      return { faded, parts };
    },
  };
}
