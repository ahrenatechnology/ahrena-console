// The diagnosis next to a saturation alert (issue 566, wireframe 566-1 to 566-9) without the DOM: which alerts have
// a diagnosis, which sections each one shows and in what order, how a list is cut, what the read line says, the tone
// of the Memória card, what a failure says and the probable cause of the Resolver block. It reads the shape of
// `GET /api/diagnosis` (docs/contracts/diagnosis.md, issue 565); the read itself is not here. The test imports this
// file directly. Nothing here throws on a strange value: a list that is not a list is empty, a number that is not
// finite is a dash.

import { ago, bytes, decimal, DASH, levelOf, VOLUME_FULL_PCT } from './machine-format.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** The alert kinds that have a diagnosis; the others stay plain rows (Q3). */
export const SATURATION_KINDS = ['load-high', 'memory-high', 'swap-high', 'volume-full'];
export const isSaturationKind = (kind) => SATURATION_KINDS.includes(kind);

/** The screen waits this long for the route before it becomes a failure with "Tentar de novo" (Q11). */
export const READ_CEILING_MS = 20_000;
/** A list shows this many rows, and "Mostrar os 10" opens up to `OPEN_ROWS` (Q4). */
export const CLOSED_ROWS = 5;
export const OPEN_ROWS = 10;

const SECTION_ORDER = {
  'load-high': ['processes-by-cpu'],
  'memory-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'swap-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'volume-full': ['largest-folders', 'docker-df', 'known-caches', 'journal'],
};

/** The sections of the diagnosis that this kind shows, in order; an id the screen does not know is left out. */
export function sectionsFor(kind, diagnosis) {
  const order = SECTION_ORDER[kind] ?? [];
  const list = Array.isArray(diagnosis?.sections) ? diagnosis.sections : [];
  return order.map((id) => list.find((s) => s?.id === id)).filter(Boolean);
}

/** `memory` (memory-high, swap-high), `load` or `disk`: what the skeleton and the loading line are about. */
export function groupOf(kind) {
  if (kind === 'memory-high' || kind === 'swap-high') return 'memory';
  if (kind === 'load-high') return 'load';
  if (kind === 'volume-full') return 'disk';
  return null;
}

/** The mount an alert id carries: `volume-full:/Volumes/Data` is `/Volumes/Data`. */
export function mountOf(alertId) {
  const i = typeof alertId === 'string' ? alertId.indexOf(':') : -1;
  return i < 0 ? '' : alertId.slice(i + 1);
}

/** `{ items, total, canExpand }`: 5 rows, or up to 10 when open; nothing to open when there are 5 or fewer. */
export function visibleItems(items, expanded) {
  const list = Array.isArray(items) ? items : [];
  const total = Math.min(list.length, OPEN_ROWS);
  return { items: list.slice(0, expanded ? OPEN_ROWS : CLOSED_ROWS), total, canExpand: total > CLOSED_ROWS };
}

/** "Mostrar os 10" for processes, "Mostrar as 10" for folders, "Mostrar menos" once open. */
export function moreLabel(sectionId, total, expanded) {
  if (expanded) return 'Mostrar menos';
  return `Mostrar ${sectionId === 'largest-folders' ? 'as' : 'os'} ${total}`;
}

const fixed = (digits) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const f0 = fixed(0);
const f1 = fixed(1);

/** The GB figure alone, always with one decimal: 19 GiB → "19,0". */
export const gbNumber = (n) => (Number.isFinite(n) ? f1.format(n / GiB) : DASH);

/** Memory as the systems report it, in binary units: "9,8 GB", "300 MB". */
export function gbText(n) {
  if (!Number.isFinite(n)) return DASH;
  if (n >= GiB) return `${gbNumber(n)} GB`;
  if (n >= MiB) return `${f0.format(Math.round(n / MiB))} MB`;
  return `${f0.format(Math.round(n / 1024))} kB`;
}

/** "102%", "7,4%". */
export const cpuText = (n) => (Number.isFinite(n) ? `${decimal(n)}%` : DASH);

const swapPct = (swap) => (swap?.totalBytes > 0 && Number.isFinite(swap.usedBytes) ? Math.round((swap.usedBytes / swap.totalBytes) * 100) : null);

/** "19,0 de 20,4 GB · 93%", or "sem swap" when the machine has none. */
export function swapLine(swap) {
  const pct = swapPct(swap);
  return pct === null ? 'sem swap' : `${gbNumber(swap.usedBytes)} de ${gbNumber(swap.totalBytes)} GB · ${pct}%`;
}

/** The colour of the swap bar: the volumes' own limits (85 yellow, 90 red). */
export const swapTone = (swap) => levelOf(swapPct(swap) ?? 0);

const DOCKER_TYPES = { images: 'Imagens', 'local volumes': 'Volumes', volumes: 'Volumes', 'build cache': 'Build cache', containers: 'Containers' };
export const dockerTypeLabel = (type) => DOCKER_TYPES[String(type).toLowerCase()] ?? String(type);

const CACHE_TITLES = { 'npm-cache': 'npm', 'pip-cache': 'pip', 'xcode-derived-data': 'Xcode DerivedData' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const DAY_MS = 86_400_000;

/** The folder that holds every path: the longest shared parent, "" when they share none ("~/Workspace/a" and ".../b" give "~/Workspace") (issue 566). */
function commonParent(paths) {
  const parents = paths.map((p) => String(p ?? '').split('/').slice(0, -1));
  const shared = parents.reduce((acc, parts) => {
    const n = acc.findIndex((seg, i) => parts[i] !== seg);
    return n < 0 ? acc : acc.slice(0, n);
  }, parents[0] ?? []);
  const joined = shared.join('/');
  return joined || (String(paths[0] ?? '').startsWith('/') ? '/' : '');
}

/**
 * "9 sem uso há mais de 14 dias, em ~/Workspace" (566-6): the number, the age limit and the folder the core served in
 * `worktrees` (`{ oldAfterDays, root }`); `root` is `null` when there is no shared folder to name. A field the core did not
 * send (an old remote) comes from the items instead: the whole days the least idle one has been unused, and the folder
 * that holds every path (issue 566).
 */
function worktreeLine(trees, now, served) {
  const ages = trees.map((t) => (now - new Date(t?.lastUsedAt ?? NaN).getTime()) / DAY_MS).filter(Number.isFinite);
  const guessed = ages.length === trees.length ? Math.floor(Math.min(...ages)) : 0;
  const limit = Number.isInteger(served?.oldAfterDays) && served.oldAfterDays >= 1 ? served.oldAfterDays : null;
  const days = limit ?? guessed;
  const folder = served?.root === null || typeof served?.root === 'string' ? (served.root ?? '') : commonParent(trees.map((t) => t.path));
  const where = folder ? `, em ${folder}` : '';
  return days >= 1 ? `${trees.length} sem uso há mais de ${plural(days, 'dia', 'dias')}${where}` : `${plural(trees.length, 'worktree', 'worktrees')}${where}`;
}

/** The rows of "Caches conhecidos": one per cache, and every old worktree folded into one row with its number, idle time and size; `worktrees` is what the section served (issue 566). */
export function cacheRows(items, now = Date.now(), worktrees = undefined) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.filter((i) => i?.id !== 'worktree').map((i) => ({ title: CACHE_TITLES[i.actionId] ?? String(i.id), path: String(i.path ?? ''), bytes: i.bytes }));
  const trees = list.filter((i) => i?.id === 'worktree');
  if (trees.length) rows.push({ title: 'Worktrees antigas', path: worktreeLine(trees, now, worktrees), bytes: trees.reduce((sum, t) => sum + (Number.isFinite(t.bytes) ? t.bytes : 0), 0) });
  return rows;
}

const clock = (t) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;

/** "lido às 14:32 · há 12 s", from the diagnosis' `takenAt`; empty when it is not a date (Q5). */
export function readLine(takenAt, now = Date.now()) {
  const t = new Date(takenAt ?? NaN);
  return Number.isFinite(t.getTime()) ? `lido às ${clock(t)} · ${ago(t.toISOString(), now)}` : '';
}

// `memoryTone` lives in machine-format.js, where the Memória card takes it (a file that imports this one could not be imported back). (issue 566)
export { memoryTone } from './machine-format.js';

const ROUTE = 'GET /api/diagnosis';
const ROUTE_FAILED = 'A rota de diagnóstico não respondeu. O alerta continua aberto: só o diagnóstico não veio.';
const WORKSTATION_FAILED = 'A Workstation não respondeu ao pedido de diagnóstico. O túnel ou o núcleo de lá pode ter caído; o alerta e os números são da última leitura.';

/** `{ reason, code }`: a sentence for the person and the status line in mono; never a response body. */
export function failureText({ status = null, remote = false } = {}) {
  if (Number.isInteger(status)) {
    const viaThisCore = status === 502 && remote;
    return { reason: viaThisCore ? WORKSTATION_FAILED : ROUTE_FAILED, code: `${ROUTE} · erro ${status}${viaThisCore ? ' do núcleo daqui' : ''}` };
  }
  return { reason: ROUTE_FAILED, code: `${ROUTE} · sem resposta` };
}

/** The two biggest by RSS at this share of the memory in use make the cause obvious. */
export const MEMORY_SHARE = 0.4;
/** The three biggest by CPU at this share of the load make it obvious. */
export const LOAD_SHARE = 0.5;
export const LOAD_TOP = 3;

/** How the cause names this machine when the screen does not say otherwise: the drawn screen is the Mac's (566-5) (issue 566). */
const MACHINE_HERE = 'o Mac';

/** What the screen says of a section that did not come, from its `status` and `id` (wireframe D4); the núcleo's `reason` is never the sentence. */
export function unavailableText(section) {
  if (section?.status === 'timeout') return 'A leitura passou de 10 s e foi cortada. As outras seções chegaram.';
  if (section?.id === 'docker-df') return 'O Docker não respondeu.';
  return 'As outras seções chegaram.';
}

/** The line under a section that came only in part; the núcleo's `partial.reason` goes beside it as code. */
export const PARTIAL_LINE = 'Só parte desta seção foi lida.';

const DOCKER_MISSING = 'O Docker não respondeu: o que ele guarda não entrou na conta.';

const t = (text) => ({ text });
const mono = (text) => ({ text, mono: true });
const bold = (text) => ({ text, bold: true });

/** The plain sentence of a cause, as a reader gets it. */
export const causeText = (parts) => parts.map((p) => p.text).join('');

const readyItems = (section) => (section?.status === 'ok' && Array.isArray(section.items) ? section.items : []);
const sectionOf = (diagnosis, id) => (Array.isArray(diagnosis?.sections) ? diagnosis.sections.find((s) => s?.id === id) : undefined);
const positive = (n) => Number.isFinite(n) && n > 0;

function listOf(names) {
  const out = [];
  names.forEach((n, i) => out.push(...(i === 0 ? [] : [t(i === names.length - 1 ? ' e ' : ', ')]), ...n));
  return out;
}

function memoryCause(diagnosis, context) {
  const items = readyItems(sectionOf(diagnosis, 'processes-by-rss')).slice(0, 2);
  const used = context?.memoryUsedBytes;
  if (!items.length || !positive(used)) return null;
  const sum = items.reduce((s, p) => s + (Number.isFinite(p.rssBytes) ? p.rssBytes : 0), 0);
  const obvious = Math.round(sum * 100) >= Math.round(used * MEMORY_SHARE * 100);
  const [a, b] = items;
  const total = [bold(gbNumber(sum)), t(` dos ${gbNumber(used)} GB em uso`)];
  if (!obvious) {
    const who = b ? [mono(a.name), t(' e '), mono(b.name), t(' somam só ')] : [mono(a.name), t(' soma só ')];
    return { obvious, parts: [t('não há uma óbvia. '), ...who, ...total, t('.')], note: 'A causa não é óbvia.' };
  }
  const machine = typeof context?.machine === 'string' && context.machine ? context.machine : MACHINE_HERE;
  const swap = diagnosis.kind === 'swap-high' ? (b ? ` e empurram ${machine} para o swap` : ` e empurra ${machine} para o swap`) : '';
  const first = [mono(a.name), t(' segura '), bold(gbText(a.rssBytes)), t(` e ${cpuText(a.cpuPct)} de CPU`)];
  const second = b ? [t(', e '), mono(b.name), t(' mais '), bold(gbText(b.rssBytes)), t(` a ${cpuText(b.cpuPct)}`), t('. Os dois somam '), ...total] : [t('. Sozinho, soma '), ...total];
  return { obvious, parts: [...first, ...second, t(`${swap}.`)], note: 'Uma leitura dos processos acima, não uma certeza: o console aponta o que mais pesa.' };
}

function loadCause(diagnosis, context) {
  const items = readyItems(sectionOf(diagnosis, 'processes-by-cpu')).slice(0, LOAD_TOP);
  const load = context?.load;
  if (!items.length || !positive(load)) return null;
  const pct = items.reduce((s, p) => s + (Number.isFinite(p.cpuPct) ? p.cpuPct : 0), 0);
  const cores = pct / 100;
  const obvious = Math.round(pct * 100) >= Math.round(load * LOAD_SHARE * 10000);
  const named = listOf(items.map((p) => [mono(p.name), t(` (${cpuText(p.cpuPct)})`)]));
  const sum = [t(' somam '), bold(`${decimal(cores)} ${cores < 2 ? 'núcleo' : 'núcleos'}`), t(` dos ${decimal(load)} de carga`)];
  if (!obvious) return { obvious, parts: [t('não há uma óbvia. '), ...named, ...sum, t(': o resto está espalhado em muitos processos pequenos.')], note: 'A causa não é óbvia.' };
  return { obvious, parts: [...named, ...sum, t(' e explicam a maior parte dela.')], note: 'Uma leitura dos processos acima, não uma certeza: o console aponta o que mais pesa.' };
}

function diskCause(diagnosis, context) {
  const caches = sectionOf(diagnosis, 'known-caches');
  const v = context?.volume;
  if (caches?.status !== 'ok' || !positive(v?.totalBytes) || !Number.isFinite(v.usedBytes)) return null;
  const safe = readyItems(caches).reduce((s, c) => s + (c?.actionId && Number.isFinite(c.bytes) ? c.bytes : 0), 0);
  const limit = (VOLUME_FULL_PCT / 100) * v.totalBytes;
  const obvious = v.usedBytes - safe < limit;
  const head = [t('o '), mono(v.mount || '/'), t(` está em ${Math.round((v.usedBytes / v.totalBytes) * 100)}% (${bytes(v.usedBytes)} de ${bytes(v.totalBytes)}). `)];
  const docker = sectionOf(diagnosis, 'docker-df');
  const dockerMissing = docker && docker.status !== 'ok';
  if (obvious) {
    const after = Math.floor(((v.usedBytes - safe) / v.totalBytes) * 100);
    return {
      obvious,
      parts: [...head, t('O que se refaz sozinho soma '), bold(bytes(safe)), t(` e leva o volume a cerca de ${after}%, abaixo dos ${VOLUME_FULL_PCT}%.`)],
      note: dockerMissing ? DOCKER_MISSING : 'Os tamanhos são os do diagnóstico acima; a prévia lê de novo antes de rodar.',
    };
  }
  const missing = bytes(v.usedBytes - limit);
  const body = safe > 0 ? [t('Os caches que se refazem somam '), bold(bytes(safe)), t(`. Para sair dos ${VOLUME_FULL_PCT}% faltam ${missing}: só os caches não bastam.`)] : [t(`Nenhum cache que se refaz sozinho foi achado. Para sair dos ${VOLUME_FULL_PCT}% faltam ${missing}.`)];
  return { obvious, parts: [...head, ...body], note: dockerMissing ? DOCKER_MISSING : 'A causa não é óbvia.' };
}

/**
 * The cause the Resolver block states, derived on the screen from the diagnosis by a fixed rule (Q12), always written as
 * "provável". `context` is what the screen already read: `{ memoryUsedBytes, load, volume: { mount, usedBytes, totalBytes } }`.
 * It returns `{ obvious, parts, note }` (`parts` are `{ text, mono?, bold? }`), or `null` when the diagnosis or the number
 * to compare against is missing: no cause is better than a made-up one.
 */
export function probableCause(diagnosis, context = {}) {
  switch (diagnosis?.kind) {
    case 'memory-high':
    case 'swap-high':
      return memoryCause(diagnosis, context);
    case 'load-high':
      return loadCause(diagnosis, context);
    case 'volume-full':
      return diskCause(diagnosis, context);
    default:
      return null;
  }
}
