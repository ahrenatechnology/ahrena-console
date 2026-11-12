// The machine screens (issue 178, decision 0008): "Esta máquina" (C24, `/ui/machines/local`), a
// remote machine (C25, `/ui/machines/<id>`) and the remote's states without a connection (C26).
//
// Reads `GET /api/telemetry?machine=<id>&hours=1|12`, `GET /api/machines` and `GET /api/attention`
// (the "Sessões" card and, on a remote, its sessions). A remote screen also reads this machine's
// telemetry, for the "No Mac" column (the tunnel port that reaches each remote port); this
// machine's screen reads, for each tunnel to a connected remote, that remote's reading ("O que é").
// Those extra reads are optional: when one fails, the column says "—".
//
// The app does not know the tunnel: no button here builds, stops or forwards one ("Tentar agora"
// re-reads). The one write is Reconectar (C50, issue 244, decision 0012): when the remote's tunnel is
// down and machines.json has a `reconnect` command for it, "Reconectar" POSTs the machine's id to
// `/api/machines/<id>/reconnect` and "Cancelar" DELETEs it; the core runs the command the person
// wrote, and the screen shows the state, the elapsed time (ticking here once a second) and the exit
// code, never the command's output. Without a command, a card says how to configure one.
// Live: an alert of this machine or a machine going down on `/api/changes` re-reads at once, and a
// new sample (every 30 s, which publishes nothing) is picked up by re-reading every 30 s.
//
// What each card shows comes from machine-format.js, which the test imports without the DOM.

import { header, el, icon } from '../dom.js';
import { runButtonAction } from '../button-action.js';
import { loading, error, empty, errorBand } from '../states.js';
import {
  ATTENTION_ROUTE,
  DASH,
  LOCAL_ID,
  MACHINES_JSON_EXAMPLE,
  MACHINES_ROUTE,
  OWNER_AUTH_CREDENTIAL_EXAMPLE,
  ownerAuthReason,
  PORT_FILTERS,
  REREAD_MS,
  START_CORE_COMMAND,
  TUNNEL_PORT_STATE,
  WINDOWS,
  axisLabels,
  bandText,
  commandLine,
  logLine,
  normalizeReconnect,
  reconnectClock,
  reconnectExample,
  reconnectResult,
  reconnectRoute,
  ownerProofRetryRoute,
  reconnectView,
  bytes,
  chartOf,
  ago,
  forwardsOf,
  headerLine,
  hoursFromSearch,
  levelOf,
  localPortOwner,
  machineOfTunnel,
  normalizeAlerts,
  normalizeMachines,
  normalizeReading,
  normalizeSeries,
  polylines,
  timeWindow,
  failureKind,
  isMachineId,
  portFilter,
  portRows,
  releaseAction,
  releaseRoute,
  withoutReleased,
  remoteCondition,
  remoteCorePort,
  remotePortOwner,
  sessionsOf,
  statCards,
  statePill,
  telemetryRoute,
  touchesMachine,
  volumeLine,
  yOf,
} from './machine-format.js';
import { cloudProfiles } from './cloud-profiles.js';
import { dockerActions } from './docker-actions.js';
import { openRelease } from './port-release.js';
import { machineConnection } from './machine-connection.js';
import { updateParts, versionNode } from './machine-core.js';
import { machineTerminals } from './machine-terminals.js';

const STYLE = '/ui/screens/machine.css';
const SVG = 'http://www.w3.org/2000/svg';
const DEBOUNCE_MS = 400;

function attachSheet() {
  const already = document.head.querySelector('link[data-screen="machine"]');
  if (already) return already;
  const link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'machine' });
  document.head.append(link);
  return link;
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, String(v));
  return node;
}

// ---------- pieces ----------

const pill = ([tone, label]) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);

function card(title, iconName, note, ...children) {
  return el('section', { class: 'card tm-card' }, el('h2', { class: 'tm-title' }, icon(iconName), el('span', {}, title), note ? el('small', { class: 'tm-note' }, note) : null), ...children);
}

function statCard(c) {
  return el(
    'div',
    { class: `card tm-stat${c.tone === 'bad' ? ' tm-bad' : ''}`, 'data-card': c.id },
    el('span', { class: 'tm-stat-label' }, c.label),
    el('span', { class: `tm-stat-ic tm-c-${c.tone === 'bad' ? 'error' : c.tone === 'warn' || c.tone === 'session' ? 'waiting' : 'accent'}` }, icon(c.icon)),
    el('span', { class: 'tm-stat-v' }, c.value, c.unit ? el('small', {}, c.unit) : null),
    el('span', { class: 'tm-stat-s' }, c.sub),
  );
}

function chart(series, reading, { local, hours, now = Date.now() }) {
  const c = chartOf(series, reading, { local });
  const box = { max: c.max, width: 600, height: 120 };
  const s = svg('svg', { class: 'tm-chart', viewBox: '0 0 600 120', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${c.title} ${hours === 12 ? 'nas últimas 12 h' : 'na última hora'}` });
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const y = yOf(f * c.max, box);
    s.append(svg('line', { class: 'tm-gridline', x1: 0, x2: 600, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' }));
  }
  if (c.limit) {
    const y = yOf(c.limit, box);
    s.append(svg('line', { class: 'tm-limit', x1: 0, x2: 600, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' }));
  }
  const time = { ...box, at: series.at, ...timeWindow(hours, now) };
  for (const line of c.lines) for (const points of polylines(line.values, time)) s.append(svg('polyline', { class: `tm-line tm-line-${line.tone}`, points, 'vector-effect': 'non-scaling-stroke' }));
  const hasData = c.lines.some((l) => l.values.some((v) => v !== null));
  return el(
    'section',
    { class: 'card tm-card', 'data-part': 'chart' },
    el('h2', { class: 'tm-title' }, icon('activity'), el('span', {}, c.title), c.note ? el('small', { class: 'tm-note' }, c.note) : null),
    hasData ? s : el('p', { class: 'tm-muted' }, 'Ainda não há amostras nesta janela.'),
    el('div', { class: 'tm-axis mono' }, ...axisLabels(hours).map((t) => el('span', {}, t))),
    el(
      'div',
      { class: 'tm-legend' },
      ...c.lines.map((l) => el('span', {}, el('i', { class: `tm-key tm-key-${l.tone}` }), l.label)),
      c.limitLabel ? el('span', {}, el('i', { class: 'tm-key tm-key-limit' }), c.limitLabel) : null,
    ),
  );
}

function meter(v) {
  return el(
    'div',
    { class: 'tm-meter' },
    el('div', { class: 'tm-meter-top' }, el('b', { class: 'mono' }, v.mount), el('span', { class: 'mono' }, volumeLine(v))),
    el('progress', { class: `tm-bar tm-bar-${levelOf(v.usedPct)}`, max: 100, value: Math.round(Math.max(0, Math.min(100, v.usedPct))), 'aria-label': `${v.mount}: ${volumeLine(v)}` }),
  );
}

function volumesCard(reading) {
  const children = reading.volumes.map(meter);
  if (reading.network) {
    const n = reading.network;
    const totals = n.rxBytesTotal !== null && n.txBytesTotal !== null ? `↓ ${bytes(n.rxBytesTotal)} · ↑ ${bytes(n.txBytesTotal)} desde o boot` : null;
    children.push(el('div', { class: 'eyebrow tm-sub-eyebrow' }, 'Rede'), el('div', { class: 'tm-legend' }, n.interface ? el('span', {}, `${n.interface} · rota padrão`) : null, totals ? el('span', { class: 'mono' }, totals) : null));
  }
  const node = card('Volumes', 'hard-drive', null, ...children);
  node.setAttribute('data-part', 'volumes');
  return node;
}

const ALERT_ICON = { error: ['error', 'tm-c-error'], warning: ['alert', 'tm-c-waiting'], info: ['info', 'tm-c-muted'] };

function alertsCard(alerts, now) {
  const body = alerts.length
    ? el(
        'ul',
        { class: 'tm-alerts' },
        ...alerts.map((a) =>
          el(
            'li',
            { 'data-alert': a.id },
            el('span', { class: `tm-alert-ic ${ALERT_ICON[a.level][1]}` }, icon(ALERT_ICON[a.level][0])),
            el('div', { class: 'tm-alert-text' }, el('span', {}, a.message), a.detail ? el('small', {}, a.detail) : null),
            a.since ? el('span', { class: 'tm-alert-age' }, ago(a.since, now)) : null,
          ),
        ),
      )
    : el('p', { class: 'tm-muted' }, 'Nada pede atenção agora.');
  const node = card('O que pede atenção', 'bell', String(alerts.length), body);
  node.classList.add('tm-quiet');
  node.setAttribute('data-part', 'alerts');
  return node;
}

function table(head, rows, extraClass = '') {
  return el('table', { class: `tm-table${extraClass}` }, head ? el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))) : null, el('tbody', {}, ...rows));
}

const td = (content, cls = null) => el('td', { class: cls }, content ?? DASH);

const percent = (n) => (n === null ? DASH : `${String(Math.round(n * 10) / 10).replace('.', ',')}%`);

function claudeCard(claude, top, { provider = 'Claude' } = {}) {
  const rows = [
    [`${provider} (CLI)`, claude.cli],
    [`${provider} Desktop`, claude.desktop],
  ]
    .filter(([, g]) => g)
    .map(([name, g]) => el('tr', {}, td(name), td(String(g.count), 'mono'), td(percent(g.cpuPct), 'mono'), td(g.memoryBytes === null ? DASH : bytes(g.memoryBytes), 'mono')));
  return el(
    'section',
    { class: 'card tm-card tm-quiet', 'data-part': provider.toLowerCase() },
    el('h2', { class: 'tm-title' }, icon('bot'), el('span', {}, `Processos do ${provider}`)),
    table(['Processo', 'Qtde', 'CPU', 'Memória'], rows),
    top?.length ? el('div', { class: 'eyebrow tm-sub-eyebrow' }, 'Os que mais usam CPU') : null,
    top?.length ? el('p', { class: 'tm-legend mono tm-wrap' }, top.map((p) => `${p.name} ${Math.round(p.cpuPct)}%`).join(' · ')) : null,
  );
}

// The Ação cell of a row (issue 286): Liberar, or why not, or Ver a stack, or the command to copy.
function releaseCell(row, act) {
  const a = releaseAction(row, act.context);
  const why = (text) => (text ? el('small', { class: 'tm-rp-why' }, text) : null);
  const button = (label, iconName, props) => el('button', { type: 'button', class: 'btn outline', 'data-port-action': props['data-port-action'], ...props }, icon(iconName), label);
  let content;
  if (a.kind === 'release') content = [button('Liberar', a.warn ? 'alert' : 'power', { 'data-port-action': 'release', onClick: () => act.release(row, Boolean(a.warn)) }), why(a.warn)];
  else if (a.kind === 'stack') content = [button('Ver a stack', 'container', { 'data-port-action': 'stack', onClick: () => act.stack() }), why(a.why)];
  else if (a.kind === 'copy') content = [button('Copiar comando', 'copy', { 'data-port-action': 'copy', onClick: (e) => act.copy(a.command, e.currentTarget) }), el('small', { class: 'tm-rp-why mono' }, a.command)];
  else content = [button('Liberar', 'power', { 'data-port-action': 'off', disabled: true }), why(a.why)];
  return el('td', { class: 'tm-rp-act' }, ...content.filter(Boolean));
}

const LISTEN = { all: ['b-waiting', 'todas as interfaces'], loopback: ['b-abandoned', 'só loopback'] };

function portsCard(portsList, { local, owner, forwards, filter, setFilter, act = null, band = null }) {
  const segment = el(
    'div',
    { class: 'tm-seg', role: 'group', 'aria-label': 'Filtrar as portas' },
    ...PORT_FILTERS.map(([id, label]) => el('button', { type: 'button', 'aria-pressed': String(filter === id), 'data-filter': id, onClick: () => setFilter(id) }, `${label} ${portFilter(portsList, id).length}`)),
  );
  const rows = portRows(portFilter(portsList, filter), owner).map((r) => {
    const listen = LISTEN[r.interface] ? el('span', { class: `tm-pill ${LISTEN[r.interface][0]}` }, LISTEN[r.interface][1]) : el('span', { class: 'mono' }, r.address ?? DASH);
    const cells = [td(r.ports.join(', '), 'mono'), el('td', {}, listen), el('td', {}, r.process ?? DASH, r.pid ? el('small', { class: 'tm-rp-pid mono' }, `pid ${r.pid}`) : null), td(r.owner, r.owner ? null : 'tm-muted')];
    if (!local) {
      const f = r.ports.length === 1 ? forwards.get(r.ports[0]) : null;
      cells.push(f ? el('td', { class: 'mono' }, `${f.localPort} `, pill(TUNNEL_PORT_STATE[f.state])) : td(DASH, 'tm-muted'));
    }
    if (act) cells.push(releaseCell(r, act));
    return el('tr', { 'data-port': r.ports[0] }, ...cells);
  });
  const head = ['Porta', 'Escuta em', 'Processo', 'De quem', ...(local ? [] : ['No Mac']), ...(act ? ['Ação'] : [])];
  return el(
    'section',
    // Band 7, issue 434.
    { class: 'card tm-card', 'data-part': 'ports' },
    el('h2', { class: 'tm-title' }, icon('radio-tower'), el('span', {}, local ? 'Portas em escuta' : 'Portas em escuta lá'), segment),
    band,
    rows.length ? table(head, rows, local ? ' tm-cols-ports' : ' tm-cols-ports-remote') : el('p', { class: 'tm-muted' }, 'Nenhuma porta neste filtro.'),
  );
}

function stateCard({ iconName, tone = null, title, text, code = null, retry = null }) {
  return el(
    'section',
    { class: 'card tm-state' },
    el('span', { class: `tm-state-ic${tone ? ` tm-c-${tone}` : ''}` }, icon(iconName)),
    el('b', {}, title),
    el('span', { class: 'tm-muted' }, text),
    code ? el('pre', { class: 'tm-config' }, code) : null,
    retry ? el('button', { type: 'button', class: 'btn outline', onClick: retry }, icon('refresh'), 'Tentar de novo') : null,
  );
}

const showOnlyNote = () =>
  el('div', { class: 'tm-only-shows', role: 'note' }, icon('info'), el('p', {}, 'O app ', el('b', {}, 'não sobe nem derruba o túnel'), ': só mostra. Subir, parar e encaminhar portas continua com a ferramenta que você já usa (decisão 0008).'));

const noRemoteCard = () =>
  stateCard({ iconName: 'plug', title: 'Nenhuma máquina remota', text: 'Sem configuração, só esta máquina aparece. Para acompanhar outra, rode o núcleo nela, encaminhe a 4720 de lá por um túnel e grave:', code: MACHINES_JSON_EXAMPLE });

// ---------- Reconectar (C50) ----------

function rcButton({ label, iconName = null, filled = false, action, busy = false, disabled = false, onClick = null }) {
  return el(
    'button',
    { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, 'data-rc-action': action, 'aria-busy': busy ? 'true' : null, disabled: disabled || busy, onClick },
    iconName ? icon(iconName) : null,
    label,
  );
}

const rcProblem = (problem) => (problem ? el('p', { class: 'tm-rc-problem', role: 'alert' }, problem) : null);
const rcCommand = (text) => (text ? el('p', { class: 'tm-rc-cmd' }, text) : null);

/** The band of C50: an icon, the text column and the buttons on the right. */
function rcBand({ tone, iconName, spin = false, role = 'status', title, text, lines = [], actions = [], part = 'reconnect', reason = null }) {
  return el(
    'div',
    { class: `${tone === 'error' ? 'error-band ' : ''}tm-rc-band tm-rc-${tone}`, role, 'data-part': part, 'data-reason': reason },
    el('span', { class: `tm-rc-ic${spin ? ' tm-rc-spin' : ''}` }, icon(iconName)),
    el('div', { class: 'tm-rc-text' }, el('p', {}, el('b', {}, title), text ? ` ${text}` : null), ...lines),
    actions.length ? el('div', { class: 'tm-rc-actions' }, ...actions) : null,
  );
}

function rcSteps(machine) {
  const steps = [
    ['tm-rc-done', 'wall-check', 'rodando o comando'],
    ['tm-rc-on', 'wall-loader', 'aguardando o login'],
    ['', 'dot', `lendo a ${machine.label}`],
  ];
  return el('ol', { class: 'tm-rc-steps', 'aria-label': 'Andamento da reconexão' }, ...steps.map(([cls, name, text]) => el('li', { class: cls || null }, icon(name), text)));
}

function rcTime(rc, now) {
  const c = reconnectClock(rc, now);
  return el(
    'div',
    { class: 'tm-rc-time' },
    c.max ? el('progress', { class: 'tm-rc-bar', max: c.max, value: c.seconds, 'aria-label': 'Tempo contra o limite', 'data-rc-bar': '' }) : null,
    el('span', { class: 'mono', 'data-rc-elapsed': '' }, c.limit ? `${c.elapsed} de ${c.limit}` : c.elapsed),
  );
}

function setupCard(machine) {
  return el(
    'section',
    { class: 'card tm-card tm-rc-setup', 'data-part': 'reconnect-setup' },
    el('h2', { class: 'tm-title' }, icon('plug'), el('span', {}, 'Reconectar daqui')),
    el('p', { class: 'tm-muted' }, 'O console pode rodar, com um clique, o comando que você já usa para subir o túnel. Ele não sabe montar túnel nenhum: só roda o que você escrever.'),
    el(
      'ol',
      { class: 'tm-rc-howto' },
      el('li', {}, el('b', {}, 'Tenha um comando que sobe o túnel.'), ' ', el('span', { class: 'tm-muted' }, 'O seu script, o que você já roda no terminal.')),
      el('li', {}, el('b', {}, 'Acrescente ', el('code', {}, 'reconnect'), ' à máquina no machines.json.'), el('pre', { class: 'tm-config' }, reconnectExample(machine))),
      el('li', {}, el('b', {}, 'Pronto.'), ' ', el('span', { class: 'tm-muted' }, 'O console relê o arquivo ao salvar, sem reiniciar, e o botão Reconectar aparece aqui e na bandeja.')),
    ),
    el('div', { class: 'tm-legend' }, el('span', {}, icon('list'), ' Uma lista, sem shell: o console roda exatamente o que está no arquivo.'), el('span', {}, icon('lock'), ' Nada da tela vira comando.')),
  );
}

/**
 * The C50 part of a remote, in place of the C26 one, or `null` when C26 (or C25) stays as it was.
 * `pending` is the write on its way ('start' or 'cancel'), `problem` the message of the last one that failed.
 */
export function reconnectParts(machine, reading, { retry = () => {}, start = () => {}, cancel = () => {}, pending = null, problem = null, now = Date.now() } = {}) {
  const view = reconnectView(machine, now);
  if (!view) return null;
  const rc = machine.reconnect;
  // The last reading fades as in C26: with the tunnel down, or up with no core answering.
  const offline = ['band', 'no-response', 'owner-auth-required', 'owner-auth-failed', 'owner-auth-mismatch'].includes(remoteCondition(machine));
  const again = (label, iconName) => rcButton({ label, iconName, filled: true, action: 'start', busy: pending === 'start', onClick: start });
  const tryNow = () => rcButton({ label: 'Tentar agora', action: 'retry', onClick: retry });
  if (view.kind === 'running') {
    return {
      faded: offline,
      parts: [
        rcBand({
          tone: 'running',
          iconName: 'wall-loader',
          spin: true,
          title: view.fromTray ? 'Reconectando, pela bandeja…' : 'Reconectando…',
          text: 'aguardando o login no navegador. Se o comando abriu uma página de login, ela é sua: entre por lá e o console segue sozinho.',
          lines: [rcSteps(machine), rcTime(rc, now), rcCommand(commandLine(rc)), rcProblem(problem)],
          actions: [
            rcButton({ label: 'Cancelar', iconName: 'x', action: 'cancel', busy: pending === 'cancel', onClick: cancel }),
            rcButton({ label: view.fromTray ? 'Um por vez' : 'Reconectando…', iconName: 'wall-loader', filled: true, action: 'running', busy: true }),
          ],
        }),
      ],
    };
  }
  if (view.kind === 'succeeded') {
    const r = reconnectResult(machine, 'succeeded');
    return { faded: false, parts: [rcBand({ tone: 'ok', iconName: 'ok', title: r.title, text: r.text })] };
  }
  if (view.kind === 'failed' || view.kind === 'timed-out') {
    const r = reconnectResult(machine, view.kind);
    return { faded: true, parts: [rcBand({ tone: 'error', iconName: 'error', role: 'alert', title: r.title, text: r.text, lines: [rcCommand(logLine(rc)), rcProblem(problem)], actions: [again('Tentar de novo', 'refresh')] })] };
  }
  const b = bandText(machine, reading, now);
  if (view.kind === 'setup') {
    return { faded: true, parts: [rcBand({ tone: 'error', iconName: 'offline', role: 'alert', title: b.title, text: b.text, lines: [rcProblem(problem)], actions: [tryNow()] }), setupCard(machine)] };
  }
  return {
    faded: true,
    parts: [
      rcBand({
        tone: 'error',
        iconName: 'offline',
        role: 'alert',
        title: b.title,
        text: b.text,
        lines: [view.note ? el('p', { class: 'tm-rc-note' }, view.note) : null, rcCommand(commandLine(rc)), rcProblem(problem)],
        actions: [tryNow(), again('Reconectar', 'plug')],
      }),
    ],
  };
}

// ---------- the owner proof (issue 388, wireframes 388-1 to 388-3) ----------

/** "Tentar agora": asks the core for the proof now (the credential over SSH, skipping the wait once) and then reads the machine, busy until the answer. */
function ownerAuthRetry(retry, filled) {
  const button = el('button', { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, 'data-action': 'owner-auth-retry' }, icon('refresh'), 'Tentar agora');
  button.addEventListener('click', () => runButtonAction(button, () => retry(), { busyLabel: 'Pedindo a prova…' }));
  return button;
}

const fromLine = (text) => el('p', { class: 'tm-rc-note tm-muted' }, text);
const causes = (...items) => el('ol', { class: 'tm-rc-howto' }, ...items.map(([bold, rest]) => el('li', {}, el('b', {}, bold), rest)));

/** 388-1: where to write the credential command, the example and "Copiar o exemplo". */
function ownerAuthSetup(machine, { step = null } = {}) {
  const copy = el('button', { type: 'button', class: 'btn outline', 'data-action': 'owner-auth-copy' }, icon('copy'), 'Copiar o exemplo');
  copy.addEventListener('click', () => runButtonAction(copy, () => globalThis.navigator.clipboard.writeText(OWNER_AUTH_CREDENTIAL_EXAMPLE), { doneLabel: 'Copiado' }));
  return el(
    'section',
    { class: 'card tm-card tm-rc-setup', 'data-part': 'owner-auth-setup' },
    el('h2', { class: 'tm-title' }, icon('key-round'), el('span', {}, `${step ? `${step} · ` : ''}Comando de credencial`), el('small', { class: 'tm-muted' }, 'decisão 0020')),
    el(
      'p',
      { class: 'tm-muted' },
      'Grave em ',
      el('code', {}, 'connection.credential'),
      `, troque os dois caminhos pelos da ${machine.label} e ${step ? 'salve' : 'clique em Tentar agora'}. O `,
      el('code', {}, 'node'),
      ' vai com o caminho inteiro: um ',
      el('code', {}, 'ssh'),
      ' com comando não carrega o PATH do seu shell.',
    ),
    el('pre', { class: 'tm-config' }, `~/.ahrena-console/machines.json · na ${machine.label}, dentro de "connection"\n${OWNER_AUTH_CREDENTIAL_EXAMPLE}`),
    el(
      'div',
      { class: 'tm-legend' },
      el('span', {}, icon('list'), ' Lista, sem shell: só roda o que está no arquivo.'),
      el('span', {}, icon('lock'), ' Nenhum segredo no comando: a credencial volta pela saída do ssh e não vai para log nem para a tela.'),
      el('span', {}, icon('shield'), ' O token deste Mac nunca vai para lá.'),
    ),
    el('div', { class: 'tm-rc-actions' }, copy),
  );
}

/**
 * The part of a remote whose core refuses this Mac for want of the owner's proof (decision 0020 section 6): one band
 * per reason, and for `owner-auth-required` the card with the credential command. Never a credential, a key or what a
 * command printed: only fixed sentences, the machine's label and its port.
 */
export function ownerAuthParts(machine, { retry = () => {} } = {}) {
  const label = machine.label;
  const port = machine.port ?? 'do túnel';
  const reason = ownerAuthReason(machine);
  if (reason === 'owner-auth-required') {
    return [
      rcBand({
        tone: 'waiting',
        iconName: 'lock',
        part: 'owner-auth',
        reason,
        title: `A ${label} pede a prova do dono, e este Mac ainda não sabe pedi-la.`,
        text: 'O núcleo de lá só responde a quem prova ser o dono, e esta máquina não tem o comando de credencial no machines.json. Configure-o abaixo: o Mac roda o comando pelo SSH que já entra lá e recebe uma credencial curta, que fica só na memória do núcleo daqui. O núcleo de lá também precisa ter a credencial remota; se for antigo, atualize-o.',
        lines: [fromLine('do núcleo de lá, que recusou o pedido sem prova')],
        actions: [ownerAuthRetry(retry, true)],
      }),
      ownerAuthSetup(machine),
    ];
  }
  if (reason === 'owner-auth-failed') {
    return [
      rcBand({
        tone: 'error',
        iconName: 'key-round',
        role: 'alert',
        part: 'owner-auth',
        reason,
        title: `A ${label} recusou o acesso: a prova do dono falhou.`,
        text: 'O comando de credencial rodou e não trouxe uma prova que o núcleo de lá aceite. O que costuma ser, nesta ordem:',
        lines: [
          causes(
            ['O núcleo de lá é antigo', `, de antes da credencial remota. Atualize e reinicie o núcleo na ${label}.`],
            ['O SSH não entrou', ': a chave foi recusada, o host mudou ou a sessão pediu login.'],
            ['O núcleo de lá reiniciou', ` e recusou a renovação de novo, ou a porta ${port} leva a outro núcleo.`],
          ),
          el('p', {}, 'Tentamos de novo sozinhos em 30 s, 1 min e depois a cada 5 min.'),
          fromLine('do comando de credencial · o código de saída fica no nucleo.log deste Mac, nunca na tela'),
        ],
        actions: [ownerAuthRetry(retry, true)],
      }),
    ];
  }
  return [
    rcBand({
      tone: 'error',
      iconName: 'shield-alert',
      role: 'alert',
      part: 'owner-auth',
      reason,
      title: `Esta não parece ser a mesma ${label}.`,
      text: `Quem respondeu agora tem outra identidade de máquina, ou outro usuário, do que a ${label} que provou ser sua na primeira vez desde que o núcleo deste Mac subiu. Por segurança, este Mac parou de mandar pedidos assinados para lá.`,
      lines: [
        el(
          'ol',
          { class: 'tm-rc-howto' },
          el('li', {}, el('b', {}, 'Confira se o túnel leva à máquina certa'), ': o host ', el('span', { class: 'mono' }, 'ahrena-tunnel'), ` no ~/.ssh/config deste Mac e a porta ${port}.`),
          el('li', {}, el('b', {}, 'Trocou de máquina ou de usuário de propósito?'), ' Reinicie o núcleo deste Mac: a identidade fica guardada só enquanto ele roda, e a próxima prova vira a nova referência.'),
        ),
        fromLine('da prova de agora, comparada com a primeira'),
      ],
      actions: [ownerAuthRetry(retry, false)],
    }),
  ];
}

// ---------- the body ----------

/** `release` is `{ release(row, warn), stack(), copy(command, button), band }` from the screen; without it the card only shows. */
function releaseOptions(release, context) {
  return release ? { act: { context, release: release.release, stack: release.stack, copy: release.copy }, band: release.band ?? null } : {};
}

/**
 * One card that could not be read (issue 434, error case): the reason in plain words, what the system said in
 * small type when there is one, and "Tentar de novo". Only this card is replaced; the rest of the screen goes on.
 */
function readErrorCard({ part, iconName, title, what, detail = null, retry, label }) {
  const button = el('button', { type: 'button', class: 'btn sm outline', 'data-action': 'retry-read', 'data-retry-for': part, 'aria-label': `Tentar de novo: ${label}` }, icon('refresh'), 'Tentar de novo');
  button.addEventListener('click', () => runButtonAction(button, () => retry(), { busyLabel: 'Lendo…' }));
  return el(
    'section',
    { class: 'card tm-card tm-read-error', 'data-part': part },
    el('h2', { class: 'tm-title' }, icon(iconName), el('span', {}, title)),
    el('div', { class: 'tm-read-error-box', role: 'status' }, icon('error'), el('div', {}, el('b', {}, what), el('p', { class: 'tm-muted' }, 'O resto da tela segue; só este card ficou sem leitura.'), detail ? el('small', { class: 'mono tm-muted' }, detail) : null, button)),
  );
}

/** The band of Processos do Claude (and the Codex ones) beside O que pede atenção, both in a quiet tone. */
function processesBand(reading, alerts, now) {
  const claude = reading.claude ? claudeCard(reading.claude, reading.topProcesses) : null;
  const codex = reading.codex ? claudeCard(reading.codex, null, { provider: 'Codex' }) : null;
  const left = [claude, codex].filter(Boolean);
  const children = [];
  if (left.length === 1) children.push(left[0]);
  else if (left.length > 1) children.push(el('div', { class: 'card-column' }, ...left));
  children.push(alertsCard(alerts, now));
  return el('div', { class: `tm-band tm-band-half${left.length ? '' : ' tm-band-single'}`, 'data-band': 'attention' }, ...children);
}

/**
 * Everything under the header for one reading, band by band (issue 434, criterion 2): the resource cards,
 * the chart beside Volumes, Processos do Claude beside O que pede atenção, then (remote only) `connection`, the
 * Sessões de terminal, the ports and `docker`. The profiles above and the bands of the condition are the
 * screen's. Exported for the test.
 */
export function machineBody(data, { local, filter = 'all', setFilter = () => {}, now = Date.now(), ownPort = null, release = null, terminals = null, connection = null, docker = null, retry = () => {} } = {}) {
  const { reading, series, alerts, machines, machine, sessions, localReading, hours = 1 } = data;
  const parts = [];
  if (!reading) {
    if (connection) parts.push(connection);
    parts.push(empty({ icon: 'activity', title: 'Ainda não há leitura', text: local ? 'A primeira amostra chega em até 30 s.' : `O núcleo ainda não leu a ${machine?.label ?? 'máquina'}.` }));
    if (docker) parts.push(docker);
    return parts;
  }
  parts.push(el('div', { class: 'tm-stats' }, ...statCards(reading, { local, sessions, alerts, now }).map(statCard)));
  const volumes = reading.volumes.length || reading.network
    ? volumesCard(reading)
    : readErrorCard({ part: 'volumes', iconName: 'hard-drive', title: 'Volumes', what: 'Não consegui ler os volumes.', detail: 'A leitura chegou vazia; o núcleo tenta de novo a cada 30 s.', retry, label: 'ler os volumes' });
  parts.push(el('div', { class: 'tm-band tm-band-23', 'data-band': 'chart' }, chart(series, reading, { local, hours, now }), volumes));
  parts.push(processesBand(reading, alerts, now));
  if (connection) parts.push(connection);
  const terminalsNode = terminals?.card(reading.terminals, sessions, { now });
  if (terminalsNode) parts.push(terminalsNode);
  if (!reading.ports) parts.push(readErrorCard({ part: 'ports', iconName: 'radio-tower', title: local ? 'Portas em escuta' : 'Portas em escuta lá', what: 'Não consegui ler as portas em escuta.', detail: 'A leitura chegou vazia; o núcleo tenta de novo a cada 30 s.', retry, label: 'as portas em escuta' }));
  else if (local) parts.push(portsCard(reading.ports, { local, owner: localPortOwner(reading.tunnels, ownPort), forwards: new Map(), filter, setFilter, ...releaseOptions(release, { ownPort, remote: null }) }));
  else {
    const owner = remotePortOwner(reading.docker, remoteCorePort(localReading, machine));
    parts.push(portsCard(reading.ports, { local, owner, forwards: forwardsOf(localReading, machine), filter, setFilter, ...releaseOptions(release, { ownPort, remote: data.releaseCap ?? { status: 'unsupported', remoteActions: false } }) }));
  }
  if (docker) parts.push(docker);
  if (local && !machines.some((m) => m.id !== LOCAL_ID)) parts.push(noRemoteCard());
  return parts;
}

/** "34 GB, 31 recuperáveis": what the Docker of the machine takes and how much of it a clean could free. */
function dockerSpaceNote(space) {
  if (!space?.length) return null;
  const total = space.reduce((sum, x) => sum + x.sizeBytes, 0);
  const free = space.reduce((sum, x) => sum + x.reclaimableBytes, 0);
  return `${bytes(total)}, ${bytes(free)} recuperáveis`;
}

/** The nodes in runs: those not in `live` go together into a `.tm-faded` box, the live ones stay as they are. */
function fadedRuns(nodes, live, attributes) {
  const out = [];
  let run = null;
  for (const node of nodes) {
    if (live.has(node)) {
      run = null;
      out.push(node);
      continue;
    }
    if (!run) {
      run = el('div', { class: 'tm-faded', ...attributes });
      out.push(run);
    }
    run.append(node);
  }
  return out;
}

/** The C26 part of a remote that is not connected: what goes above the (maybe faded) reading. */
export function conditionParts(machine, reading, { retry = () => {}, ownerProofRetry = retry, version = null, now = Date.now() } = {}) {
  const condition = remoteCondition(machine);
  if (condition === 'band') {
    const b = bandText(machine, reading, now);
    return { faded: true, parts: [errorBand({ title: b.title, text: b.text, action: { label: 'Tentar agora', onClick: retry } })] };
  }
  if (ownerAuthReason(machine)) return { faded: true, parts: ownerAuthParts(machine, { retry: ownerProofRetry }) };
  if (condition === 'no-response') {
    const port = machine.port ? `A porta ${machine.port} aceita a conexão` : 'O túnel aceita a conexão';
    return {
      faded: true,
      parts: [
        stateCard({ iconName: 'server-off', tone: 'waiting', title: 'O túnel está de pé, mas o núcleo de lá não respondeu', text: `${port} e ninguém responde em 3 s. Suba o núcleo na ${machine.label}:`, code: START_CORE_COMMAND, retry }),
        showOnlyNote(),
      ],
    };
  }
  if (condition === 'version') {
    const there = machine.version === null ? 'responde sem a versão da telemetria' : `responde com a telemetria v${machine.version}`;
    return {
      faded: false,
      parts: [stateCard({ iconName: 'git-compare', tone: 'waiting', title: 'Versão diferente lá', text: `O núcleo da ${machine.label} ${there} e este entende a v${version ?? '?'}. Mostramos o que as duas entendem; os cards que faltam ficam de fora até atualizar lá.` }), showOnlyNote()],
    };
  }
  if (condition === 'first-read') {
    return {
      faded: false,
      parts: [stateCard({ iconName: 'cable', title: `Lendo a ${machine.label} pela primeira vez`, text: machine.port ? `O núcleo pergunta pela porta ${machine.port} deste Mac a cada 30 s; a primeira resposta ainda não voltou.` : 'A primeira resposta ainda não voltou.', retry }), showOnlyNote()],
    };
  }
  return { faded: false, parts: [] };
}

// ---------- the screen ----------

export async function mount(area, ctx) {
  const sheet = attachSheet();
  ctx.signal.addEventListener('abort', () => sheet.remove());
  const id = ctx.params?.id ?? LOCAL_ID;
  const local = id === LOCAL_ID;
  let hours = hoursFromSearch(globalThis.location?.search);
  let filter = 'all';
  let last = null;
  let request = 0;
  // Reconectar: the write on its way ('start' | 'cancel'), and the last failed one, tied to the
  // reconnect state it failed on (a new state from the core hides it).
  let pending = null;
  let problem = null;
  // Liberar uma porta (issue 286): the ports released since the last sample, and the note that says so.
  const released = new Map();
  let releaseNote = null;
  let noteTimer = null;
  // The "Perfis de nuvem" card (issue 277, C66 and C67): its own module, which reads and polls by itself.
  const cloud = cloudProfiles(ctx, id);
  // The Docker card with the actions (issue 288, C92 to C95): its own module, which reads by itself; it replaces the read-only stacks card while it shows the stacks.
  const docker = dockerActions(ctx, id, { readOnlyStacks: () => last?.reading?.docker?.stacks ?? null, spaceNote: () => dockerSpaceNote(last?.reading?.docker?.space) });
  // The remote's connection (issue 278, C62 to C65): its own module; `null` keeps the screen as it was.
  const conn = local ? null : machineConnection(ctx, id, { reread: () => draw(), repaint: () => last && paint(last) });
  // The terminal sessions card (issue 350, C96 to C99): the actions and their confirmations are its own.
  const terminals = machineTerminals(ctx, { id, local, label: () => (local ? 'Esta máquina' : (last?.machine?.label ?? id)), repaint: () => last && paint(last), reread: () => draw() });

  const hourButtons = WINDOWS.map((h) => el('button', { type: 'button', 'aria-pressed': String(h === hours), 'data-hours': h, onClick: () => setHours(h) }, `${h} h`));
  const toggle = el('div', { class: 'tm-seg', role: 'group', 'aria-label': 'Janela do gráfico' }, ...hourButtons);
  const pillSlot = el('span', { class: 'tm-pill-slot' });
  const titleText = el('span', { class: 'tm-head-title' }, local ? 'Esta máquina' : id);
  const head = header({ icon: local ? 'monitor' : 'server', title: titleText, sub: ' ', actions: local ? [toggle] : [pillSlot, toggle] });
  const sub = head.querySelector('.sub');
  area.replaceChildren(head, loading({ label: local ? 'Lendo esta máquina' : 'Lendo a máquina' }));

  function setHours(h) {
    if (h === hours) return;
    hours = h;
    for (const b of hourButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.hours) === h));
    const path = globalThis.location?.pathname ?? `/ui/machines/${id}`;
    globalThis.history?.replaceState?.(globalThis.history.state, '', h === 12 ? `${path}?hours=12` : path);
    draw();
  }

  function setFilter(f) {
    filter = f;
    if (last) paint(last);
  }

  const optional = async (route) => {
    try {
      return await ctx.read(route);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return null;
    }
  };

  function paint(data) {
    const now = Date.now();
    const { machine } = data;
    const label = local ? 'Esta máquina' : (machine?.label ?? id);
    titleText.textContent = label;
    ctx.title(label);
    const shownProblem = problem && problem.key === reconnectKey(machine) ? problem.message : null;
    const legacy = local
      ? { faded: false, parts: [] }
      : (reconnectParts(machine, data.reading, { retry: () => draw(), start: () => reconnect('POST'), cancel: () => reconnect('DELETE'), pending, problem: shownProblem, now }) ??
        conditionParts(machine, data.reading, { retry: () => draw(), ownerProofRetry: () => retryOwnerProof(), version: data.version, now }));
    const condition = conn?.view(data, legacy, now) ?? legacy;
    const line = headerLine(data.reading, machine, { local, offline: condition.faded, now });
    if (sub) sub.textContent = (conn ? conn.headerLine(line) : line) || (local ? 'A telemetria medida pelo núcleo daqui' : 'Máquina remota');
    // The owner proof (issue 388) says its reason on the pill, over the connection's "Sem conexão": the tunnel is up.
    if (!local && machine) pillSlot.replaceChildren(pill((ownerAuthReason(machine) && machine.reconnect?.state !== 'running' ? statePill(machine) : null) ?? conn?.pill() ?? statePill(machine)));
    const ownPort = Number(globalThis.location?.port) || null;
    terminals.take(data.reading?.terminals ?? null, data.sessions);
    const shownData = data.reading ? { ...data, reading: withoutReleased(data.reading, released) } : data;
    const release = { release: startRelease, stack: showStacks, copy: copyCommand, band: releaseBand() };
    const dialog = terminals.dialogNode();
    const connection = condition.row ?? null;
    docker.refresh();
    const dockerNode = docker.node();
    const body = data.reading || local || remoteCondition(machine) === null ? machineBody(shownData, { local, filter, setFilter, now, ownPort, release: condition.faded ? null : release, terminals, connection, docker: dockerNode, retry: () => draw() }) : [];
    // Without a body (a remote that is not connected and has no reading) the cards that read by themselves stay.
    const bands = body.length ? body : [connection, dockerNode].filter(Boolean);
    // The last reading fades (offline) or sits behind a question (a dialog); the connection and Docker cards, which act, never do.
    const live = new Set([connection, dockerNode]);
    const fade = condition.faded ? { 'aria-label': 'Última leitura guardada' } : dialog ? {} : null;
    const shown = fade ? fadedRuns(bands, live, fade) : bands;
    // The remote núcleo's version and update command (issue 449): the row lives in the Conexão card when it shows, else alone.
    const coreParts = local || !machine ? [] : [...updateParts(machine, { ownerAuth: ownerAuthReason(machine), credentialSetup: (step) => ownerAuthSetup(machine, { step }) }), ...(machine.core && !condition.versionShown ? [versionNode(machine.core, { card: true })] : [])];
    replaceKeepingFocus(head, ...condition.parts, ...coreParts, ...(dialog ? [dialog] : []), ...(terminals.bandNode() ? [terminals.bandNode()] : []), cloud.node(label), ...shown);
  }

  // A repaint (a filter, the 30 s re-read) rebuilds the buttons: the focus goes back to the same one.
  function replaceKeepingFocus(...nodes) {
    const active = globalThis.document?.activeElement;
    let key = null;
    if (active && area.contains(active)) {
      if (active.getAttribute?.('data-filter')) key = `[data-filter="${active.getAttribute('data-filter')}"]`;
      else if (active.getAttribute?.('data-hours')) key = `[data-hours="${active.getAttribute('data-hours')}"]`;
      else if (active.getAttribute?.('data-rc-action')) key = `[data-rc-action="${active.getAttribute('data-rc-action')}"]`;
      else if (active.getAttribute?.('data-retry-for')) key = `[data-retry-for="${active.getAttribute('data-retry-for')}"]`;
      else if (active.getAttribute?.('data-mc-action')) key = `[data-mc-action="${active.getAttribute('data-mc-action')}"]`;
    }
    area.replaceChildren(...nodes);
    if (!key) return;
    // Reconectar becomes Cancelar (and back): the focus goes to the band's first button.
    const target = area.querySelector(key) ?? (key.startsWith('[data-rc-action') ? area.querySelector('[data-rc-action]') : null);
    target?.focus();
  }

  function releaseBand() {
    if (!releaseNote) return null;
    return el('div', { class: 'tm-rc-band tm-rc-ok tm-rp-band', role: 'status', 'data-part': 'release-note' }, icon('ok'), el('div', {}, el('b', {}, `Porta ${releaseNote.port} liberada.`), ` ${releaseNote.process ?? 'O processo'} (pid ${releaseNote.pid}) saiu com ${releaseNote.signal === 'KILL' ? 'SIGKILL' : 'SIGTERM'}.`));
  }

  function startRelease(row, warn) {
    const tunnel = warn ? last?.reading?.tunnels?.find((t) => t.ports.some((p) => row.ports.includes(p.localPort))) : null;
    openRelease(ctx, {
      machineId: id,
      machineLabel: last?.machine?.label ?? id,
      row,
      warn,
      tunnelMachineId: tunnel ? (machineOfTunnel(tunnel, last.machines)?.id ?? null) : null,
      onRefresh: () => draw(),
      onDone: ({ port, pid, process, signal }) => {
        for (const p of row.ports) released.set(`${p}:${pid}`, Date.now());
        releaseNote = { port, pid, process, signal };
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
          releaseNote = null;
          if (last && !ctx.signal.aborted) paint(last);
        }, 20_000);
        if (last) paint(last);
        draw();
      },
    });
  }

  // "Ver a stack": the Docker part is its own card on the Workstation's screen (issue 288).
  function showStacks() {
    area.querySelector?.('[data-part="docker-actions"]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  function copyCommand(command, button) {
    globalThis.navigator?.clipboard?.writeText?.(command)?.then?.(() => {
      const before = button.lastChild?.textContent;
      if (before) button.lastChild.textContent = 'Copiado';
      setTimeout(() => button.lastChild && before && (button.lastChild.textContent = before), 1500);
    });
  }

  const reconnectKey = (machine) => `${machine?.reconnect?.state ?? ''}|${machine?.reconnect?.startedAt ?? ''}`;

  // "Tentar agora" on the owner-proof bands (issue 388, 388-2 and 388-4): the core requests the proof over SSH now,
  // skipping its wait once, and reads the machine; then the screen reads it again. The answer carries only the
  // state and the reason. A failure still redraws, then leaves the button saying it failed.
  async function retryOwnerProof() {
    if (ctx.signal.aborted) return;
    let failure = null;
    try {
      await ctx.write(ownerProofRetryRoute(id), {});
    } catch (e) {
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      if (e?.status === 404) return notFound();
      failure = e;
    }
    await draw();
    if (failure) throw failure;
  }

  // POST starts (or joins the run already going), DELETE cancels. The answer's `reconnect` repaints at
  // once; the re-read and `/api/changes` bring the rest.
  async function reconnect(method) {
    if (pending || ctx.signal.aborted) return;
    pending = method === 'DELETE' ? 'cancel' : 'start';
    problem = null;
    if (last) paint(last);
    try {
      const answer = await ctx.write(reconnectRoute(id), method === 'DELETE' ? null : {}, method === 'DELETE' ? { method } : undefined);
      const rc = normalizeReconnect(answer?.reconnect);
      if (rc && last?.machine) last = { ...last, machine: { ...last.machine, reconnect: rc } };
    } catch (e) {
      pending = null;
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      if (e?.status === 404) return notFound();
      // Cancelar on a run that already ended (409): nothing to say, the re-read shows how it ended.
      if (!(method === 'DELETE' && e?.status === 409)) {
        const what = method === 'DELETE' ? 'cancelar' : 'reconectar';
        problem = { key: reconnectKey(last?.machine), message: `Não deu para ${what}: ${e?.message || 'o núcleo não respondeu'}` };
      }
    }
    pending = null;
    if (ctx.signal.aborted) return;
    if (last) paint(last);
    draw();
  }

  // While a reconnect runs, the elapsed time ticks here, once a second, without repainting.
  function tick() {
    const rc = last?.machine?.reconnect;
    if (rc?.state !== 'running') return;
    const c = reconnectClock(rc, Date.now());
    for (const n of area.querySelectorAll('[data-rc-elapsed]')) n.textContent = c.limit ? `${c.elapsed} de ${c.limit}` : c.elapsed;
    for (const n of area.querySelectorAll('[data-rc-bar]')) n.setAttribute('value', String(c.seconds));
  }

  async function draw() {
    if (ctx.signal.aborted) return;
    const mine = ++request;
    if (!isMachineId(id)) return notFound();
    try {
      const [telemetry, machinesBody, attention] = await Promise.all([ctx.read(telemetryRoute(id, hours)), optional(MACHINES_ROUTE), optional(ATTENTION_ROUTE)]);
      const machines = normalizeMachines(machinesBody);
      const reading = normalizeReading(telemetry?.current);
      const machine = machines.find((m) => m.id === id) ?? normalizeMachines([telemetry?.machine])[0] ?? null;
      let localReading = null;
      let releaseCap = null;
      if (!local) {
        localReading = normalizeReading((await optional(telemetryRoute(LOCAL_ID, 1)))?.current);
        const cap = await optional(releaseRoute(id));
        releaseCap = { status: typeof cap?.status === 'string' ? cap.status : 'unsupported', remoteActions: cap?.remoteActions === true };
      }
      if (mine !== request || ctx.signal.aborted) return;
      conn?.take(machinesBody, telemetry);
      last = {
        version: typeof telemetry?.version === 'number' ? telemetry.version : null,
        hours,
        reading,
        series: normalizeSeries(telemetry?.series),
        alerts: normalizeAlerts(telemetry?.alerts),
        machines,
        machine,
        sessions: sessionsOf(attention, id),
        localReading,
        releaseCap,
      };
      paint(last);
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== request || ctx.signal.aborted) return;
      last = null;
      const kind = failureKind(e);
      if (kind === 'not-found' && !local) return notFound();
      if (kind === 'no-telemetry') {
        area.replaceChildren(head, empty({ icon: 'activity', title: 'O núcleo subiu sem a telemetria', text: 'Ele foi iniciado com --no-telemetry, ou esta plataforma não tem coletor. Reinicie o núcleo sem a opção para ver as máquinas.' }));
        return;
      }
      replaceKeepingFocus(head, error({ text: e?.message, retry: () => draw() }));
    }
  }

  // An id the core refuses (400) or does not know (404): no endless retry, a way back.
  function notFound() {
    last = null;
    area.replaceChildren(head, empty({ icon: 'server', title: 'Máquina não encontrada', text: `Nenhuma máquina "${id}" no ~/.ahrena-console/machines.json deste núcleo.`, action: { label: 'Ir para Esta máquina', onClick: () => ctx.navigate('/ui/machines/local') } }));
  }

  let wait = null;
  const rereadSoon = () => {
    clearTimeout(wait);
    if (!ctx.signal.aborted) wait = setTimeout(() => draw(), DEBOUNCE_MS);
  };
  ctx.onChange((changes) => {
    if (touchesMachine(changes, id)) rereadSoon();
  });
  ctx.onRestart(() => draw());
  const background = setInterval(() => draw(), REREAD_MS);
  const ticker = local ? null : setInterval(tick, 1000);
  // The teardown hangs on the signal, not only on the returned function: leaving before the first
  // read comes back aborts the signal before the shell could register that function.
  const stop = () => {
    clearTimeout(wait);
    clearTimeout(noteTimer);
    clearInterval(background);
    clearInterval(ticker);
  };
  if (ctx.signal.aborted) stop();
  else ctx.signal.addEventListener('abort', stop);

  await draw();
  if (ctx.signal.aborted) stop();
  return stop;
}
