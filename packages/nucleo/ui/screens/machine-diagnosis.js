// The components of the diagnosis next to a saturation alert (issue 566, wireframe 566-3 to 566-9), drawn from the
// data of docs/contracts/diagnosis.md (issue 565). No read, no screen state and no timer are here: `diagnosisPanel`
// draws one state from a plain object, and the buttons call the handlers the state layer gives (`onRetry`,
// `onReread`, `onMore`, and the toggle's `onToggle`). Everything that comes from the machine goes in as text.
//
//   diagnosisPanel({ state, alert, diagnosis, failure, remote, label, context, expanded, now }, { onRetry, onReread, onMore })
//
// `state` is `loading`, `ready`, `failed`, `closed` (404: the alert already closed) or `unsupported` (501). The Resolver
// block has its header and the probable cause only; the groups of the next stories get the empty
// `[data-slot="resolver-actions"]`. The words are in `machine-diagnosis-format.js`; the style is in `machine.css`.

import { el, icon } from '../dom.js';
import { bytes, DASH } from './machine-format.js';
import {
  cacheRows,
  cpuText,
  dockerTypeLabel,
  failureText,
  groupOf,
  gbText,
  isSaturationKind,
  mountOf,
  moreLabel,
  probableCause,
  readLine,
  sectionsFor,
  swapLine,
  swapTone,
  unavailableText,
  PARTIAL_LINE,
  visibleItems,
} from './machine-diagnosis-format.js';

/** The id the panel carries, which the row's toggle names in `aria-controls`. */
export const diagnosisPanelId = (alertId) => `dg-${alertId}`;

const asList = (items) => (Array.isArray(items) ? items : []);

/** The "Ver diagnóstico" / "Diagnóstico" button on the alert row (566-4, 1). */
export function diagnosisToggle({ open, controls, onToggle }) {
  return el(
    'button',
    { type: 'button', class: 'tm-dg-toggle', 'aria-expanded': String(Boolean(open)), 'aria-controls': controls, 'data-dg-action': 'toggle', onClick: onToggle },
    icon(open ? 'chevron-down' : 'chevron-right'),
    open ? 'Diagnóstico' : 'Ver diagnóstico',
  );
}

function panelRoot(state, alert, { cls = '', role, label = null, busy = false } = {}, ...children) {
  return el(
    'div',
    { class: `tm-dg-panel${cls ? ` ${cls}` : ''}`, id: diagnosisPanelId(alert.id), 'data-part': 'diagnosis', 'data-dg-state': state, role, 'aria-label': label, 'aria-busy': busy ? 'true' : null },
    ...children,
  );
}

const td = (content, cls = null) => el('td', { class: cls }, content ?? DASH);

function dataTable(head, rowNodes, rightFrom = 99) {
  return el(
    'table',
    { class: 'tm-table tm-dg-tab' },
    head ? el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { scope: 'col', class: i >= rightFrom ? 'tm-dg-r' : null }, h)))) : null,
    el('tbody', {}, ...rowNodes),
  );
}

const sectionBox = (id, status, wide, ...children) => el('div', { class: `tm-dg-sec${wide ? ' tm-dg-wide' : ''}`, 'data-section': id, 'data-status': status }, ...children);

const sectionHead = (iconName, title, tail = null) => el('div', { class: 'eyebrow tm-dg-sec-head' }, icon(iconName), ...title, tail ? el('span', { class: 'tm-dg-sec-tail' }, tail) : null);

const monoText = (text) => el('span', { class: 'mono tm-dg-plain' }, text);

const moreButton = (id, total, expanded, onMore) =>
  el(
    'button',
    { type: 'button', class: 'tm-dg-more', 'data-dg-action': 'more', 'aria-expanded': String(expanded), onClick: () => onMore?.(id) },
    icon(expanded ? 'chevron-down' : 'chevron-right'),
    moreLabel(id, total, expanded),
  );

const reasonCode = (reason) => (typeof reason === 'string' && reason ? el('span', { class: 'mono tm-dg-code' }, reason) : null);

const partialNote = (section) => (section.partial?.reason ? el('small', { class: 'tm-muted tm-dg-partial' }, `${PARTIAL_LINE} `, reasonCode(section.partial.reason)) : null);

const TITLES = {
  'processes-by-rss': ['memory-stick', () => ['Processos por memória']],
  'processes-by-cpu': ['model', () => ['Processos por CPU']],
  swap: ['repeat', () => ['Swap']],
  'largest-folders': ['folder-tree', (mount) => ['Maiores pastas de ', monoText(mount || '/')]],
  'docker-df': ['container', () => ['Docker', monoText('docker system df')]],
  'known-caches': ['layers', () => ['Caches conhecidos']],
  journal: ['scroll-text', () => ['Journal do systemd', monoText('journalctl --disk-usage')]],
};

const BADGES = { timeout: ['b-waiting', 'Tempo esgotado', 'hourglass'], unavailable: ['b-abandoned', 'Indisponível', 'slash'] };

function unavailableSection(section, mount, wide) {
  const [tone, label, iconName] = BADGES[section.status] ?? BADGES.unavailable;
  const [headIcon, title] = TITLES[section.id];
  return sectionBox(
    section.id,
    section.status,
    wide,
    sectionHead(headIcon, title(mount), el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label)),
    el('div', { class: 'tm-dg-state' }, icon(iconName), el('div', { class: 'tm-dg-msg' }, el('span', { class: 'tm-dg-line' }, unavailableText(section)), reasonCode(section.reason))),
  );
}

function processesSection(section, wide, { expanded, onMore }) {
  const by = section.id === 'processes-by-rss' ? 'rss' : 'cpu';
  const shown = visibleItems(section.items, expanded.has(section.id));
  const rows = shown.items.map((p) =>
    el('tr', {}, td(String(p.pid), 'mono tm-muted'), td(String(p.name), 'tm-dg-nm'), td(gbText(p.rssBytes), `mono tm-dg-r${by === 'rss' ? ' tm-dg-by' : ''}`), td(cpuText(p.cpuPct), `mono tm-dg-r${by === 'cpu' ? ' tm-dg-by' : ''}`)),
  );
  const [headIcon, title] = TITLES[section.id];
  return sectionBox(
    section.id,
    'ok',
    wide,
    sectionHead(headIcon, title(), `${shown.items.length} de ${shown.total}`),
    dataTable(['pid', 'Processo', 'RSS', 'CPU'], rows, 2),
    shown.canExpand ? moreButton(section.id, shown.total, expanded.has(section.id), onMore) : null,
    partialNote(section),
  );
}

function swapSection(section, wide) {
  const swap = asList(section.items)[0];
  const line = swapLine(swap);
  const pct = swap?.totalBytes > 0 ? Math.round((swap.usedBytes / swap.totalBytes) * 100) : 0;
  const [headIcon, title] = TITLES.swap;
  return sectionBox(
    'swap',
    'ok',
    wide,
    sectionHead(headIcon, title()),
    el(
      'div',
      { class: 'tm-meter' },
      el('div', { class: 'tm-meter-top' }, el('b', { class: 'mono' }, 'swap'), el('span', { class: 'mono' }, line)),
      el('progress', { class: `tm-bar tm-bar-${swapTone(swap)}`, max: 100, value: Math.max(0, Math.min(100, pct)), 'aria-label': `Swap: ${line}` }),
    ),
    partialNote(section),
  );
}

function foldersSection(section, wide, mount, { expanded, onMore }) {
  const shown = visibleItems(section.items, expanded.has(section.id));
  const rows = shown.items.map((f) => el('tr', {}, td(String(f.path), 'mono tm-dg-nm'), td(bytes(f.bytes), 'mono tm-dg-r tm-dg-by')));
  const [headIcon, title] = TITLES['largest-folders'];
  return sectionBox(
    section.id,
    'ok',
    wide,
    sectionHead(headIcon, title(mount), `${shown.items.length} de ${shown.total}`),
    dataTable(['Pasta', 'Tamanho'], rows, 1),
    shown.canExpand ? moreButton(section.id, shown.total, expanded.has(section.id), onMore) : null,
    partialNote(section),
  );
}

function dockerSection(section, wide) {
  const rows = asList(section.items).map((d) => el('tr', {}, td(dockerTypeLabel(d.type)), td(bytes(d.usedBytes), 'mono tm-dg-r'), td(bytes(d.reclaimableBytes), 'mono tm-dg-r tm-dg-by')));
  const [headIcon, title] = TITLES['docker-df'];
  return sectionBox('docker-df', 'ok', wide, sectionHead(headIcon, title()), dataTable(['Tipo', 'Em uso', 'Recuperável'], rows, 1), partialNote(section));
}

function cachesSection(section, wide, now) {
  const rows = cacheRows(section.items, now).map((c) => el('tr', {}, el('td', {}, c.title, el('small', { class: 'mono' }, c.path)), td(bytes(c.bytes), 'mono tm-dg-r tm-dg-by')));
  const [headIcon, title] = TITLES['known-caches'];
  return sectionBox('known-caches', 'ok', wide, sectionHead(headIcon, title()), dataTable(['Cache', 'Tamanho'], rows, 1), partialNote(section));
}

function journalSection(section, wide) {
  const used = asList(section.items)[0];
  const [headIcon, title] = TITLES.journal;
  return sectionBox('journal', 'ok', wide, sectionHead(headIcon, title()), dataTable(null, [el('tr', {}, td('Em uso pelos journals'), td(bytes(used?.bytes), 'mono tm-dg-r tm-dg-by'))]), partialNote(section));
}

function section(s, ctx, wide) {
  if (s.status !== 'ok') return unavailableSection(s, ctx.mount, wide);
  switch (s.id) {
    case 'processes-by-rss':
    case 'processes-by-cpu':
      return processesSection(s, wide, ctx);
    case 'swap':
      return swapSection(s, wide);
    case 'largest-folders':
      return foldersSection(s, wide, ctx.mount, ctx);
    case 'docker-df':
      return dockerSection(s, wide);
    case 'known-caches':
      return cachesSection(s, wide, ctx.now);
    default:
      return journalSection(s, wide);
  }
}

function causePart(p) {
  if (p.mono) return el('span', { class: 'mono' }, p.text);
  if (p.bold) return el('b', {}, p.text);
  return p.text;
}

/** The Resolver block: its header and the probable cause, with the empty slot for the groups of the next stories. */
export function resolverBlock(cause) {
  if (!cause) return null;
  return el(
    'div',
    { class: 'tm-rs', 'data-part': 'resolver', 'data-obvious': String(cause.obvious), role: 'group', 'aria-label': 'Resolver' },
    el('div', { class: 'tm-rs-head' }, icon('settings'), el('b', {}, 'Resolver')),
    el('div', { class: 'tm-rs-cause' }, icon('lightbulb'), el('div', {}, el('b', {}, 'Causa provável:'), ' ', ...cause.parts.map(causePart), cause.note ? el('small', {}, cause.note) : null)),
    el('div', { class: 'tm-rs-actions', 'data-slot': 'resolver-actions' }),
  );
}

const LOADING_LINE = { memory: 'lendo os processos por memória e por CPU e o swap', load: 'lendo os processos por CPU', disk: 'lendo as pastas, o Docker, os caches e o journal' };
const SKELETON = { memory: { cols: [5, 5], below: [1] }, load: { cols: [5], below: [] }, disk: { cols: [4, 4, 3, 1], below: [] } };

const skeleton = (rows) => el('div', { class: 'tm-dg-sec tm-dg-skel', 'aria-hidden': 'true' }, ...Array.from({ length: rows }, (_, i) => el('i', { class: `tm-dg-w${i % 5}` })));

/** 566-3: "Carregando diagnóstico", with the skeleton in the shape of the ready panel. */
export function diagnosisLoading(alert) {
  const group = groupOf(alert.kind);
  const { cols, below } = SKELETON[group];
  return panelRoot(
    'loading',
    alert,
    { role: 'status', busy: true },
    el('div', { class: 'tm-dg-head' }, el('span', { class: 'tm-dg-spin' }, icon('wall-loader')), el('b', {}, 'Carregando diagnóstico'), el('span', { class: 'tm-muted' }, LOADING_LINE[group])),
    el('div', { class: `tm-dg-cols${group === 'load' ? ' tm-dg-one' : ''}` }, ...cols.map(skeleton)),
    ...below.map(skeleton),
  );
}

/** 566-4 to 566-6: the sections of the alert's kind, the read line, "Ler de novo" and the Resolver. */
export function diagnosisReady(alert, diagnosis, { context = {}, machine, expanded = new Set(), now = Date.now(), onReread, onMore } = {}) {
  const ctx = { mount: mountOf(diagnosis.alertId ?? alert.id), expanded: expanded instanceof Set ? expanded : new Set(expanded), onMore, now };
  const present = sectionsFor(alert.kind, diagnosis);
  const group = groupOf(alert.kind);
  const inCols = group === 'memory' ? present.filter((s) => s.id !== 'swap') : present;
  const below = group === 'memory' ? present.filter((s) => s.id === 'swap') : [];
  const lonely = group === 'disk' && inCols.length % 2 === 1;
  const read = readLine(diagnosis.takenAt, now);
  return panelRoot(
    'ready',
    alert,
    { role: 'region', label: `Diagnóstico do alerta ${alert.message}` },
    el(
      'div',
      { class: 'tm-dg-head' },
      icon('activity'),
      el('b', {}, 'Diagnóstico'),
      read ? el('span', { class: 'tm-muted' }, read) : null,
      el('button', { type: 'button', class: 'tm-dg-link', 'data-dg-action': 'reread', onClick: onReread }, icon('refresh'), 'Ler de novo'),
    ),
    inCols.length ? el('div', { class: `tm-dg-cols${group === 'load' ? ' tm-dg-one' : ''}` }, ...inCols.map((s, i) => section(s, ctx, lonely && i === inCols.length - 1))) : null,
    ...below.map((s) => section(s, ctx, false)),
    resolverBlock(probableCause({ ...diagnosis, kind: alert.kind }, { ...context, ...(machine ? { machine } : {}) })),
  );
}

/** 566-8: "Não deu para diagnosticar" and "Tentar de novo"; the Workstation's 502 changes the sentence only. */
export function diagnosisFailed(alert, failure, { onRetry } = {}) {
  const { reason, code } = failureText(failure ?? {});
  return panelRoot(
    'failed',
    alert,
    { cls: 'tm-dg-fail', role: 'alert' },
    el('span', { class: 'tm-dg-ic' }, icon('error')),
    el('div', { class: 'tm-dg-msg' }, el('b', {}, 'Não deu para diagnosticar'), el('span', {}, reason), el('span', { class: 'mono tm-dg-code' }, code)),
    el('div', { class: 'tm-dg-btns' }, el('button', { type: 'button', class: 'btn filled', 'data-dg-action': 'retry', onClick: onRetry }, icon('refresh'), 'Tentar de novo')),
  );
}

function calm(state, alert, iconName, title, text, cls = '') {
  return panelRoot(state, alert, { cls: `tm-dg-calm${cls ? ` ${cls}` : ''}`, role: 'status' }, el('span', { class: 'tm-dg-ic' }, icon(iconName)), el('div', { class: 'tm-dg-msg' }, el('b', {}, title), el('span', {}, text)));
}

/** 566-8, 404: the alert closed while the diagnosis was read. Calm, no button: asking again would give the same answer. */
export const diagnosisClosed = (alert) => calm('closed', alert, 'check-circle-2', 'Este alerta já fechou', 'O alerta fechou enquanto o diagnóstico era lido. A lista se atualiza na próxima leitura, em até 30 s.');

/** 566-9, 501: the núcleo does not diagnose. Calm, no retry; the way out is to update the núcleo there. */
export function diagnosisUnsupported(alert, { remote = true, label = 'Workstation' } = {}) {
  if (remote) {
    return calm(
      'unsupported',
      alert,
      'git-compare',
      `O núcleo da ${label} ainda não faz diagnóstico`,
      'Ele é mais antigo que o deste app e não conhece a rota. O alerta continua valendo. Atualize o núcleo de lá pelo aviso da linha Versão do card Conexão e o diagnóstico passa a aparecer aqui.',
      'tm-dg-old',
    );
  }
  return calm('unsupported', alert, 'git-compare', 'O núcleo desta máquina ainda não faz diagnóstico', 'O alerta continua valendo.', 'tm-dg-old');
}

/** One state of the panel from a plain object; `null` for a kind with no diagnosis or a state with nothing to draw. */
export function diagnosisPanel(v, handlers = {}) {
  const alert = v?.alert;
  if (!alert || !isSaturationKind(alert.kind)) return null;
  switch (v.state) {
    case 'loading':
      return diagnosisLoading(alert);
    case 'ready':
      return v.diagnosis ? diagnosisReady(alert, v.diagnosis, { context: v.context, machine: v.remote ? `a ${v.label || 'Workstation'}` : undefined, expanded: v.expanded, now: v.now, onReread: handlers.onReread, onMore: handlers.onMore }) : null;
    case 'failed':
      return diagnosisFailed(alert, { remote: Boolean(v.remote), ...v.failure }, handlers);
    case 'closed':
      return diagnosisClosed(alert);
    case 'unsupported':
      return diagnosisUnsupported(alert, { remote: v.remote !== false, label: v.label });
    default:
      return null;
  }
}
