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
import { loading, error, empty, errorBand } from '../states.js';
import { attentionPill } from '../attention.js';
import {
  ATTENTION_ROUTE,
  DASH,
  LOCAL_ID,
  MACHINES_JSON_EXAMPLE,
  MACHINES_ROUTE,
  PORT_FILTERS,
  REREAD_MS,
  SESSIONS_SHOWN,
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
  reconnectView,
  bytes,
  chartOf,
  dockerRows,
  duration,
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
  remoteCondition,
  remoteCorePort,
  remotePortOwner,
  sessionMeta,
  sessionAttention,
  sessionsOf,
  stackContainers,
  statCards,
  statePill,
  telemetryRoute,
  touchesMachine,
  tunnelPortWhat,
  volumeLine,
  yOf,
} from './machine-format.js';
import { cloudProfiles } from './cloud-profiles.js';
import { dockerActions } from './docker-actions.js';
import { machineConnection } from './machine-connection.js';

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
    { class: 'card tm-card tm-span-wide', 'data-part': 'chart' },
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

function volumesCard(reading, { local }) {
  const children = reading.volumes.map(meter);
  if (local && reading.network) {
    const n = reading.network;
    const totals = n.rxBytesTotal !== null && n.txBytesTotal !== null ? `↓ ${bytes(n.rxBytesTotal)} · ↑ ${bytes(n.txBytesTotal)} desde o boot` : null;
    children.push(el('div', { class: 'eyebrow tm-sub-eyebrow' }, 'Rede'), el('div', { class: 'tm-legend' }, n.interface ? el('span', {}, `${n.interface} · rota padrão`) : null, totals ? el('span', { class: 'mono' }, totals) : null));
  }
  return card('Volumes', 'hard-drive', null, ...children);
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
  return card('O que pede atenção', 'bell', String(alerts.length), body);
}

function table(head, rows, extraClass = '') {
  return el('table', { class: `tm-table${extraClass}` }, head ? el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))) : null, el('tbody', {}, ...rows));
}

const td = (content, cls = null) => el('td', { class: cls }, content ?? DASH);

function tunnelCard(tunnels, machines, remoteReadings, now) {
  const blocks = [];
  if (!tunnels.length) blocks.push(el('p', { class: 'tm-muted' }, 'Nenhum túnel ssh encaminhando portas agora. O app só mostra: subir o túnel continua com a ferramenta que você já usa.'));
  for (const t of tunnels) {
    const machine = machineOfTunnel(t, machines);
    const remotePorts = machine ? (remoteReadings.get(machine.id)?.ports ?? null) : null;
    const since = t.since ? `no ar há ${duration(t.since, now)} · ` : '';
    blocks.push(
      el('div', { class: 'tm-legend' }, pill(['b-completed', `${t.destination} · túnel`]), el('span', {}, `${since}${t.ports.length} ${t.ports.length === 1 ? 'porta' : 'portas'}`)),
      table(
        ['No Mac', 'Lá', 'Estado', 'O que é, lido do núcleo de lá'],
        t.ports.map((p) =>
          el(
            'tr',
            { 'data-port': p.localPort },
            td(String(p.localPort), 'mono'),
            td(String(p.remotePort), 'mono'),
            el('td', {}, pill(TUNNEL_PORT_STATE[p.state])),
            td(tunnelPortWhat(p, { machine, remotePorts }), p.state === 'up' ? null : 'tm-muted'),
          ),
        ),
        ' tm-cols-tunnel',
      ),
    );
  }
  return el('section', { class: 'card tm-card tm-span-wide', 'data-part': 'tunnel' }, el('h2', { class: 'tm-title' }, icon('cable'), el('span', {}, 'Túnel e portas encaminhadas'), el('small', { class: 'tm-note' }, 'lido dos processos ssh e da sonda de cada porta')), ...blocks);
}

const percent = (n) => (n === null ? DASH : `${String(Math.round(n * 10) / 10).replace('.', ',')}%`);

function claudeCard(claude, top, { wide = false } = {}) {
  const rows = [
    ['claude (CLI)', claude.cli],
    ['Claude Desktop', claude.desktop],
  ]
    .filter(([, g]) => g)
    .map(([name, g]) => el('tr', {}, td(name), td(String(g.count), 'mono'), td(percent(g.cpuPct), 'mono'), td(g.memoryBytes === null ? DASH : bytes(g.memoryBytes), 'mono')));
  return el(
    'section',
    { class: `card tm-card ${wide ? 'tm-span-wide' : 'tm-span-half'}`, 'data-part': 'claude' },
    el('h2', { class: 'tm-title' }, icon('bot'), el('span', {}, 'Processos do Claude')),
    table(['Processo', 'Qtde', 'CPU', 'Memória'], rows),
    top?.length ? el('div', { class: 'eyebrow tm-sub-eyebrow' }, 'Os que mais usam CPU') : null,
    top?.length ? el('p', { class: 'tm-legend mono tm-wrap' }, top.map((p) => `${p.name} ${Math.round(p.cpuPct)}%`).join(' · ')) : null,
  );
}

function dockerCard(docker) {
  const rows = dockerRows(docker.space);
  const meters = rows.map((r) => {
    const used = el('i', { class: 'tm-stack-part tm-stack-used' });
    const free = el('i', { class: 'tm-stack-part tm-stack-free' });
    used.style.setProperty('--w', `${r.usedPct.toFixed(1)}%`);
    free.style.setProperty('--w', `${r.reclaimablePct.toFixed(1)}%`);
    return el('div', { class: 'tm-meter' }, el('div', { class: 'tm-meter-top' }, el('span', {}, r.label), el('span', { class: 'mono' }, r.text)), el('div', { class: 'tm-stack', role: 'img', 'aria-label': `${r.label}: ${r.text}` }, used, free));
  });
  const body = meters.length
    ? [...meters, el('div', { class: 'tm-legend' }, el('span', {}, el('i', { class: 'tm-key tm-key-a' }), 'Em uso'), el('span', {}, el('i', { class: 'tm-key tm-key-b' }), 'Recuperável'))]
    : [el('p', { class: 'tm-muted' }, `${docker.running} em execução · ${docker.stopped} parados. O espaço em disco não respondeu a tempo.`)];
  return card('Docker', 'container', meters.length ? 'em GB' : null, ...body);
}

function sessionsCard(items) {
  if (!items.length) return card('Sessões do Claude lá', 'sessions', 'do /api/attention de lá', el('p', { class: 'tm-muted' }, 'Nenhuma sessão de lá precisa de você nem está ociosa agora.'));
  const shown = items.slice(0, SESSIONS_SHOWN);
  const rest = items.length - shown.length;
  return card(
    'Sessões do Claude lá',
    'sessions',
    'do /api/attention de lá',
    el(
      'ul',
      { class: 'tm-sessions' },
      ...shown.map((i) => el('li', { 'data-session': String(i.session ?? '') }, el('div', { class: 'tm-session-name' }, el('b', {}, String(i.title || i.project || i.session || '')), el('small', { class: 'mono' }, sessionMeta(i))), attentionPill(sessionAttention(i)))),
    ),
    rest > 0 ? el('p', { class: 'tm-muted tm-small' }, `e mais ${rest} · as que esperam também vão para a bandeja`) : null,
  );
}

function stacksCard(stacks) {
  return el(
    'section',
    { class: 'card tm-card tm-span-full', 'data-part': 'stacks' },
    el('h2', { class: 'tm-title' }, icon('layers'), el('span', {}, 'Stacks Docker')),
    table(
      ['Stack', 'Containers', 'Portas'],
      stacks.map((s) => el('tr', { 'data-stack': s.name }, td(s.name, 'mono'), td(stackContainers(s), 'mono'), td(s.ports.length ? s.ports.join(', ') : DASH, 'mono'))),
    ),
  );
}

const LISTEN = { all: ['b-waiting', 'todas as interfaces'], loopback: ['b-abandoned', 'só loopback'] };

function portsCard(portsList, { local, owner, forwards, filter, setFilter }) {
  const segment = el(
    'div',
    { class: 'tm-seg', role: 'group', 'aria-label': 'Filtrar as portas' },
    ...PORT_FILTERS.map(([id, label]) => el('button', { type: 'button', 'aria-pressed': String(filter === id), 'data-filter': id, onClick: () => setFilter(id) }, `${label} ${portFilter(portsList, id).length}`)),
  );
  const rows = portRows(portFilter(portsList, filter), owner).map((r) => {
    const listen = LISTEN[r.interface] ? el('span', { class: `tm-pill ${LISTEN[r.interface][0]}` }, LISTEN[r.interface][1]) : el('span', { class: 'mono' }, r.address ?? DASH);
    const cells = [td(r.ports.join(', '), 'mono'), el('td', {}, listen), td(r.process), td(r.owner, r.owner ? null : 'tm-muted')];
    if (!local) {
      const f = r.ports.length === 1 ? forwards.get(r.ports[0]) : null;
      cells.push(f ? el('td', { class: 'mono' }, `${f.localPort} `, pill(TUNNEL_PORT_STATE[f.state])) : td(DASH, 'tm-muted'));
    }
    return el('tr', { 'data-port': r.ports[0] }, ...cells);
  });
  const head = ['Porta', 'Escuta em', 'Processo', 'De quem', ...(local ? [] : ['No Mac'])];
  return el(
    'section',
    // The whole row: the list is long, and a short card beside it would leave a hole (rule 9, issue 255).
    { class: 'card tm-card tm-span-full', 'data-part': 'ports' },
    el('h2', { class: 'tm-title' }, icon('radio-tower'), el('span', {}, local ? 'Portas em escuta' : 'Portas em escuta lá'), segment),
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
function rcBand({ tone, iconName, spin = false, role = 'status', title, text, lines = [], actions = [] }) {
  return el(
    'div',
    { class: `${tone === 'error' ? 'error-band ' : ''}tm-rc-band tm-rc-${tone}`, role, 'data-part': 'reconnect' },
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
  const offline = ['band', 'no-response'].includes(remoteCondition(machine));
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

// ---------- the body ----------

/** Everything under the header for one reading: the cards, then the grid. Exported for the test. */
export function machineBody(data, { local, filter = 'all', setFilter = () => {}, now = Date.now(), ownPort = null, dockerActions: hasActions = false } = {}) {
  const { reading, series, alerts, machines, machine, sessions, localReading, remoteReadings = new Map(), hours = 1 } = data;
  const parts = [];
  if (!reading) {
    parts.push(empty({ icon: 'activity', title: 'Ainda não há leitura', text: local ? 'A primeira amostra chega em até 30 s.' : `O núcleo ainda não leu a ${machine?.label ?? 'máquina'}.` }));
    return parts;
  }
  parts.push(el('div', { class: 'tm-stats' }, ...statCards(reading, { local, sessions, alerts, now }).map(statCard)));
  const grid = [chart(series, reading, { local, hours, now })];
  if (local) {
    if (reading.volumes.length || reading.network) grid.push(volumesCard(reading, { local }));
    if (reading.tunnels) grid.push(tunnelCard(reading.tunnels, machines, remoteReadings, now));
    // The two short cards stack beside the tunnel (rule 9, issue 255): the long port list goes below, on
    // its own row, instead of next to the Claude processes with a hole under them.
    // Without a tunnel reading (a Linux core, a failed probe) there is nothing to stack beside: the
    // alerts take one column and the Claude processes the other two, so the row stays full.
    const claude = reading.claude ? claudeCard(reading.claude, reading.topProcesses, { wide: !reading.tunnels }) : null;
    if (reading.tunnels) grid.push(el('div', { class: 'card-column tm-side' }, alertsCard(alerts, now), claude));
    else grid.push(alertsCard(alerts, now), ...(claude ? [claude] : []));
    if (reading.ports) grid.push(portsCard(reading.ports, { local, owner: localPortOwner(reading.tunnels, ownPort), forwards: new Map(), filter, setFilter }));
    if (!machines.some((m) => m.id !== LOCAL_ID)) grid.push(el('div', { class: 'tm-span-full' }, noRemoteCard()));
  } else {
    grid.push(alertsCard(alerts, now));
    if (reading.volumes.length) grid.push(volumesCard(reading, { local }));
    if (reading.docker) grid.push(dockerCard(reading.docker));
    if (sessions) grid.push(sessionsCard(sessions));
    // The Docker actions card (below the grid) lists the stacks with their buttons: this read-only one stays only without it.
    if (reading.docker?.stacks.length && !hasActions) grid.push(stacksCard(reading.docker.stacks));
    if (reading.ports) {
      const owner = remotePortOwner(reading.docker, remoteCorePort(localReading, machine));
      grid.push(portsCard(reading.ports, { local, owner, forwards: forwardsOf(localReading, machine), filter, setFilter }));
    }
  }
  parts.push(el('div', { class: 'tm-grid' }, ...grid));
  return parts;
}

/** The C26 part of a remote that is not connected: what goes above the (maybe faded) reading. */
export function conditionParts(machine, reading, { retry = () => {}, version = null, now = Date.now() } = {}) {
  const condition = remoteCondition(machine);
  if (condition === 'band') {
    const b = bandText(machine, reading, now);
    return { faded: true, parts: [errorBand({ title: b.title, text: b.text, action: { label: 'Tentar agora', onClick: retry } })] };
  }
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
  // The "Perfis de nuvem" card (issue 277, C66 and C67): its own module, which reads and polls by itself.
  const cloud = cloudProfiles(ctx, id);
  // The Docker card with the actions (issue 288, C81 to C85): its own module, which reads by itself; it replaces the read-only stacks card while it shows the stacks.
  const docker = dockerActions(ctx, id, { repaint: () => last && paint(last) });
  // The remote's connection (issue 278, C62 to C65): its own module; `null` keeps the screen as it was.
  const conn = local ? null : machineConnection(ctx, id, { reread: () => draw(), repaint: () => last && paint(last) });

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
        conditionParts(machine, data.reading, { retry: () => draw(), version: data.version, now }));
    const condition = conn?.view(data, legacy, now) ?? legacy;
    const line = headerLine(data.reading, machine, { local, offline: condition.faded, now });
    if (sub) sub.textContent = (conn ? conn.headerLine(line) : line) || (local ? 'A telemetria medida pelo núcleo daqui' : 'Máquina remota');
    if (!local && machine) pillSlot.replaceChildren(pill(conn?.pill() ?? statePill(machine)));
    const ownPort = Number(globalThis.location?.port) || null;
    const body = data.reading || local || remoteCondition(machine) === null ? machineBody(data, { local, filter, setFilter, now, ownPort, dockerActions: docker.available() }) : [];
    const shown = condition.faded && data.reading ? [el('div', { class: 'tm-faded', 'aria-label': 'Última leitura guardada' }, ...body)] : body;
    replaceKeepingFocus(head, ...condition.parts, cloud.node(label), ...shown, docker.node());
  }

  // A repaint (a filter, the 30 s re-read) rebuilds the buttons: the focus goes back to the same one.
  function replaceKeepingFocus(...nodes) {
    const active = globalThis.document?.activeElement;
    let key = null;
    if (active && area.contains(active)) {
      if (active.getAttribute?.('data-filter')) key = `[data-filter="${active.getAttribute('data-filter')}"]`;
      else if (active.getAttribute?.('data-hours')) key = `[data-hours="${active.getAttribute('data-hours')}"]`;
      else if (active.getAttribute?.('data-rc-action')) key = `[data-rc-action="${active.getAttribute('data-rc-action')}"]`;
      else if (active.getAttribute?.('data-mc-action')) key = `[data-mc-action="${active.getAttribute('data-mc-action')}"]`;
    }
    area.replaceChildren(...nodes);
    if (!key) return;
    // Reconectar becomes Cancelar (and back): the focus goes to the band's first button.
    const target = area.querySelector(key) ?? (key.startsWith('[data-rc-action') ? area.querySelector('[data-rc-action]') : null);
    target?.focus();
  }

  const reconnectKey = (machine) => `${machine?.reconnect?.state ?? ''}|${machine?.reconnect?.startedAt ?? ''}`;

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
      const remoteReadings = new Map();
      if (!local) localReading = normalizeReading((await optional(telemetryRoute(LOCAL_ID, 1)))?.current);
      else if (reading?.tunnels) {
        const reached = reading.tunnels.map((t) => machineOfTunnel(t, machines)).filter((m) => m && m.state === 'connected');
        for (const m of new Set(reached)) {
          const r = normalizeReading((await optional(telemetryRoute(m.id, 1)))?.current);
          if (r) remoteReadings.set(m.id, r);
        }
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
        remoteReadings,
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
    clearInterval(background);
    clearInterval(ticker);
  };
  if (ctx.signal.aborted) stop();
  else ctx.signal.addEventListener('abort', stop);

  await draw();
  if (ctx.signal.aborted) stop();
  return stop;
}
