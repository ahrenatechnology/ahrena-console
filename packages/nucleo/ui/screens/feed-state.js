// O estado do Feed de atividade (C8, #94), sem DOM: a lista, o cursor do ao vivo, a pausa e as contas
// de tempo. A tela (`feed.js`) desenha o que este módulo decide; o teste exercita os dois.
//
// Issue 243: with `machine=all` the event ids of two machines can repeat, so every set, the open row and
// the dedup use `eventKey` (machine + id). An older page is not globally ordered against the one before
// it (each machine continues from its own cursor), and a machine that comes back during live polling
// brings its newest page once: both are inserted by `createdAt`, never just appended or prepended.

import { itemKey, sessionHref } from '../machine-filter.js';

/** The key of an event: its machine and its id (`local:<id>` for this machine's). */
export const eventKey = (ev) => itemKey(ev);

/** Quantas linhas a lista guarda em memória; o ao vivo corta as mais velhas além disso. */
export const LIMIT = 500;

/**
 * Os status de evento que o núcleo devolve e como o filtro os escreve. issue 245: `waiting` takes both the
 * blocked and the idle events; each row says which one by its `attention` (see `rowPill`).
 */
export const STATUS = {
  active: 'Ativa',
  waiting: 'Precisa de você ou ociosa',
  completed: 'Concluída',
  error: 'Com erro',
};

/**
 * The row pill (issue 245): `{ attention }` when the event stands for one ("Precisa de você", "Ociosa",
 * "Com erro"), else `{ status }` (a waiting one without attention is idle; unknown is completed).
 */
export function rowPill(ev) {
  const a = ev?.attention;
  if (a && (a.level === 'blocked' || a.level === 'idle')) return { attention: { level: a.level, reason: typeof a.reason === 'string' ? a.reason : null } };
  if (ev?.status === 'waiting') return { attention: { level: 'idle', reason: null } };
  return { status: STATUS[ev?.status] ? ev.status : 'completed' };
}

/** O mesmo molde de id que a moldura aceita em `/ui/sessions/:id`. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** O caminho do Detalhe de uma sessão, ou `null` se o id não serve como rota; a remote one carries `?machine=`. */
export function sessionRoute(id, machineId = 'local') {
  return typeof id === 'string' && ID.test(id) ? sessionHref(id, machineId) : null;
}

/** Como a moldura escreve o agente do evento: o principal e o subagente sem tipo (`main`, `subagent`). */
export const AGENTS = { main: 'principal', subagent: 'subagente' };

/** `events` and `older` mirror the body of `/api/events` (`{ events, cursor, older, options }`). */
export function newState() {
  return { events: [], cursor: null, older: null, pausado: false, pendentes: [], chegados: 0, aberto: null };
}

/** A primeira página (ou a releitura): troca a lista inteira e esvazia o que estava pendente. */
export function load(state, response) {
  state.events = [...(response.events ?? [])].slice(0, LIMIT);
  state.cursor = response.cursor ?? null;
  state.older = response.older ?? null;
  state.pendentes = [];
  state.chegados = 0;
  if (state.aberto && !state.events.some((e) => eventKey(e) === state.aberto)) state.aberto = null;
}

const ids = (state) => new Set([...state.events, ...state.pendentes].map(eventKey));

/**
 * Eventos novos do ao vivo (mais novo primeiro). Pausado, eles esperam em `pendentes`; senão entram no
 * topo. Devolve `{ entraram, cortados }`: o que subiu para a lista e o que caiu do fim pelo limite.
 */
export function receiveNewer(state, response) {
  if (response.cursor) state.cursor = response.cursor;
  const seen = ids(state);
  const newOnes = [];
  for (const e of response.events ?? []) {
    if (seen.has(eventKey(e))) continue;
    seen.add(eventKey(e));
    newOnes.push(e);
  }
  if (state.pausado) {
    // Guarda só os `LIMITE` mais novos (mais que isso cairia da lista ao retomar), mas conta todos.
    state.pendentes = [...newOnes, ...state.pendentes].slice(0, LIMIT);
    state.chegados += newOnes.length;
    return { entraram: [], cortados: [] };
  }
  return up(state, newOnes);
}

/** Mais novo primeiro: `createdAt` decrescente e, no empate, `id` decrescente (a ordem do núcleo); then the machine. */
export function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  const ka = eventKey(a);
  const kb = eventKey(b);
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

/**
 * Os novos entram na lista pela ordem: o evento gravado atrasado (com `createdAt` mais velho) cai no
 * lugar dele, não no topo. `noTopo` diz se todos ficaram acima dos que já estavam (a tela só antepõe).
 */
function up(state, newOnes) {
  if (!newOnes.length) return { entraram: [], cortados: [], noTopo: true };
  const top = state.events[0];
  const sorted = [...newOnes].sort(newestFirst);
  const atTop = !top || newestFirst(sorted.at(-1), top) < 0;
  state.events = atTop ? [...sorted, ...state.events] : [...sorted, ...state.events].sort(newestFirst);
  const cutOff = state.events.splice(LIMIT);
  // Cortar o fim deixa o cursor de "mostrar mais" apontando para depois do buraco: some o botão.
  if (cutOff.length) state.older = null;
  if (cutOff.some((e) => eventKey(e) === state.aberto)) state.aberto = null;
  const dropped = new Set(cutOff.map(eventKey));
  return { entraram: sorted.filter((e) => !dropped.has(eventKey(e))), cortados: cutOff, noTopo: atTop };
}

export function pause(state) {
  state.pausado = true;
}

/** Retoma e solta no topo o que chegou durante a pausa. */
export function resume(state) {
  state.pausado = false;
  const newOnes = state.pendentes;
  state.pendentes = [];
  state.chegados = 0;
  return up(state, newOnes);
}

/**
 * A página mais velha ("mostrar mais"), sem repetir. Each event goes to its place by `createdAt` (issue
 * 243: with several machines the page is not older than everything on screen); the answer is the events
 * that came in, and `noFim` says whether they all landed after the ones already there (the screen only
 * appends then).
 */
export function receiveOlder(state, response) {
  const seen = ids(state);
  const stale = [];
  for (const e of response.events ?? []) {
    if (seen.has(eventKey(e))) continue;
    seen.add(eventKey(e));
    stale.push(e);
  }
  const sorted = [...stale].sort(newestFirst);
  const last = state.events.at(-1);
  const atEnd = !last || !sorted.length || newestFirst(last, sorted[0]) < 0;
  state.events = atEnd ? [...state.events, ...sorted] : [...state.events, ...sorted].sort(newestFirst);
  state.older = response.older ?? null;
  const entered = sorted;
  entered.noFim = atEnd;
  return entered;
}

/** Abre a linha (pela chave do evento, `eventKey`), ou fecha se já estava aberta. Uma aberta por vez. */
export function toggleOne(state, key) {
  state.aberto = state.aberto === key ? null : key;
  return state.aberto;
}

// ---------- consulta ----------

/** The filters of the screen, by the names of the parameters of `/api/events`. */
const FILTERS = ['type', 'session', 'tool', 'status', 'search', 'from', 'to'];

/** A rota de `/api/events` com os filtros preenchidos e os extras (`after`, `before`, `limit`). */
export function query(filters = {}, extras = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(extras)) if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`);
  for (const k of FILTERS) {
    const v = filters[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') parts.push(`${k}=${encodeURIComponent(String(v).trim())}`);
  }
  return parts.length ? `/api/events?${parts.join('&')}` : '/api/events';
}

export const hasFilter = (filters = {}) => FILTERS.some((k) => filters[k] !== null && filters[k] !== undefined && String(filters[k]).trim() !== '');

/** `aaaa-mm-dd` de um `<input type="date">` para ISO: o começo do dia local, ou o fim dele. */
export function dayToIso(day, endOfDay = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  if (!m) return null;
  const d = endOfDay ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- tempo ----------

const two = (n) => String(n).padStart(2, '0');
const data = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `23:12`, na hora local. */
export function shortTime(iso) {
  const d = data(iso);
  return d ? `${two(d.getHours())}:${two(d.getMinutes())}` : '';
}

/** `18/10 23:12:04`, na hora local. */
export function dateTime(iso) {
  const d = data(iso);
  return d ? `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : '';
}

/** "agora", "12 s", "1 min", "2 h", "3 d". */
export function relativeTime(iso, now = Date.now()) {
  const d = data(iso);
  if (!d) return '';
  const s = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ---------- texto ----------

/** O pedaço curto de um id, para o Agente ("test-runner · a7c2"). */
export const shortId = (id) => (typeof id === 'string' && id ? id.slice(0, 4) : null);

/** `projeto › sessão › agente`, pulando o que falta. */
export function trail(event) {
  const session = event.session ?? {};
  return [session.project, session.title ?? session.id, agentName(event.agent?.name)].filter(Boolean).join(' › ');
}

/** O nome do agente como a tela escreve: `main` é "principal"; o tipo do subagente fica como veio. */
export const agentName = (name) => (name && Object.hasOwn(AGENTS, name) ? AGENTS[name] : name);
