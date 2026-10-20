// A tela Sessões (C3, #28): a tabela das sessões com busca, filtro por diretório, ordenação, as
// pílulas de status e 10 por página. Filtro, ordem e página vão para o servidor (`GET /api/sessions`,
// src/api/sessions.ts) e ficam na query da URL, para o Voltar do Detalhe cair no mesmo lugar.
// A linha leva ao Detalhe, `/ui/sessions/<id>`.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { attentionBadges, attentionOf, statusWithoutAttention } from '../attention.js';

// The `status` and `order` values of `/api/sessions` (English since phase 2b of issue 173). issue 245: the
// old waiting pill split in two, "Precisam de você" (`blocked`, with the errors) and "Ociosas" (`idle`).
export const PILLS = [
  ['all', 'Todas'],
  ['active', 'Ativas'],
  ['blocked', 'Precisam de você'],
  ['idle', 'Ociosas'],
  ['completed', 'Concluídas'],
  ['error', 'Erro'],
  ['abandoned', 'Abandonadas'],
];

// O rótulo da ordem diz também o sentido: o ⇅ ao lado inverte.
const ORDERS = {
  activity: { desc: 'Atividade: recente', asc: 'Atividade: antiga' },
  duration: { desc: 'Duração: maior', asc: 'Duração: menor' },
  cost: { desc: 'Custo: maior', asc: 'Custo: menor' },
};

export const STATUS = {
  active: 'Ativa',
  completed: 'Concluída',
  error: 'Com erro',
  abandoned: 'Abandonada',
};

/** An old bookmark's `?status=waiting` (or `esperando`) opens the ones that need you. */
const STATUS_ALIASES = { waiting: 'blocked' };

const DEFAULTS = { status: 'all', search: '', dir: '', order: 'activity', direction: 'desc', page: 1 };

/**
 * The screen state from the query (`?status=waiting&page=2`); what is not valid falls back to the
 * default. An old bookmark's values (`esperando`, `custo`) were swapped by the shell (`legacyUrl`).
 */
export function stateFromQuery(query) {
  const p = new URLSearchParams(query);
  const page = Number(p.get('page'));
  const status = STATUS_ALIASES[p.get('status') ?? ''] ?? p.get('status');
  const order = p.get('order');
  return {
    status: PILLS.some(([v]) => v === status) ? status : DEFAULTS.status,
    search: (p.get('search') ?? '').slice(0, 200),
    dir: (p.get('dir') ?? '').startsWith('/') ? p.get('dir') : '',
    order: Object.hasOwn(ORDERS, order ?? '') ? order : DEFAULTS.order,
    direction: p.get('direction') === 'asc' ? 'asc' : 'desc',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** A query do estado, só com o que difere do padrão (`''` quando é tudo padrão). */
export function queryFromState(state) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v !== DEFAULTS[k] && v !== '') p.set(k, String(v));
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** A rota da API para o estado: sempre com status, ordem, sentido e página. */
export function listRoute(state) {
  const p = new URLSearchParams({ status: state.status, order: state.order, direction: state.direction, page: String(state.page) });
  if (state.search.trim()) p.set('search', state.search.trim());
  if (state.dir) p.set('dir', state.dir);
  return `/api/sessions?${p}`;
}

/** "agora", "há 2 min", "há 1 h", "há 3 d". */
export function age(iso, now = Date.now()) {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!(min >= 1)) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / (60 * 24))} d`;
}

/** "< 1 min", "12 min", "3 h 10", "2 d 4 h". */
export function duration(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** "~US$ 1,84", ou "sem preço" quando o uso não tem preço. */
export function cost(usd) {
  if (usd === null || usd === undefined) return 'sem preço';
  return `~US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "1–10 de 12"; "0 de 0" sem nada. */
export function band({ total, page, perPage }) {
  if (!total) return '0 de 0';
  const from = (page - 1) * perPage + 1;
  return `${from}–${Math.min(total, page * perPage)} de ${total}`;
}

/** O id curto da linha: os 8 primeiros de um UUID; o id inteiro nos outros casos. */
export function shortId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

// As colunas, na ordem; a classe dá a largura de cada uma (sessions.css).
export const COLUMNS = [
  ['c-session', 'Sessão'],
  ['c-status', 'Status'],
  ['c-activity', 'Última atividade'],
  ['c-duration', 'Duração'],
  ['c-agents', 'Agentes'],
  ['c-cost', 'Custo'],
  ['c-dir', 'Diretório'],
  ['c-arrow', ''],
];

const COLOR = /^#[0-9a-f]{3,8}$/i;
const lastPart = (cwd) => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

function selector(label, options, value, onChange) {
  const s = el('select', { class: 'field-sel', 'aria-label': label });
  for (const [v, text] of options) s.append(el('option', { value: v, selected: v === value }, text));
  s.addEventListener('change', () => onChange(s.value));
  return el('label', { class: 'field' }, s, icon('open-list'));
}

/** The status cell: the attention pill and its reason (issue 245), or the status badge. */
export function badgeEl(status, attention) {
  if (attentionOf(attention)) return attentionBadges(attention);
  // Waiting without attention does not wait on the person (delegating…): "Ativa". Nothing raw on screen.
  const st = statusWithoutAttention(status);
  if (!Object.hasOwn(STATUS, st)) return [];
  return [el('span', { class: `badge b-${st}` }, el('span', { class: 'p' }), STATUS[st])];
}

/** "Precisam de você 5": the pill label and the count of `counts` (none when the core did not say). */
export function pillCount(counts, status) {
  const n = counts?.[status];
  return Number.isInteger(n) ? String(n) : null;
}

function account(c) {
  if (!c) return null;
  const dot = el('i', { class: 'account-dot' });
  if (COLOR.test(c.color)) dot.style.setProperty('--cor-da-conta', c.color);
  return el('span', { class: 'account' }, dot, c.label);
}

export async function mount(area, ctx) {
  // O estilo da tela, uma vez por página.
  if (!document.querySelector('link[data-screen="sessions"]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/ui/sessions.css', 'data-screen': 'sessions' }));
  }

  let state = stateFromQuery(location.search);
  let last = null;
  let request = 0;

  const head = header({
    icon: 'sessions',
    title: 'Sessões',
    sub: '…',
    actions: [el('button', { type: 'button', class: 'btn', onClick: () => read() }, icon('refresh'), 'Atualizar')],
  });
  const sub = head.querySelector('.sub');

  // ---------- filtros ----------
  const search = el('input', { type: 'search', placeholder: 'Buscar sessões…', 'aria-label': 'Buscar sessões', value: state.search, maxlength: 200 });
  let searchWait = null;
  search.addEventListener('input', () => {
    clearTimeout(searchWait);
    searchWait = setTimeout(() => change({ search: search.value, page: 1 }), 250);
  });
  const searchField = el('label', { class: 'field search' }, icon('search'), search);
  const dirSlot = el('span', { class: 'dir-slot' });
  const orderSlot = el('span', { class: 'order-slot' });
  const invert = el('button', { type: 'button', class: 'field square', 'aria-label': 'Inverter a ordem', title: 'Inverter a ordem', onClick: () => change({ direction: state.direction === 'desc' ? 'asc' : 'desc', page: 1 }) }, icon('invert'));
  const pills = el('div', { class: 'seg', role: 'group', 'aria-label': 'Status' });
  for (const [v, label] of PILLS) pills.append(el('button', { type: 'button', 'data-status': v, onClick: () => change({ status: v, page: 1 }) }, label, el('b', { class: 'sessions-pill-count' })));
  const filters = el('div', { class: 'card filters' }, searchField, dirSlot, orderSlot, invert, pills);

  const body = el('div', { class: 'sessions-body' }, loading({ label: 'Carregando as sessões' }));
  area.replaceChildren(head, filters, body);

  function drawFilters(directories, counts = null) {
    const dirs = state.dir && !directories.includes(state.dir) ? [...directories, state.dir] : directories;
    dirSlot.replaceChildren(selector('Diretório', [['', 'Todos os projetos'], ...dirs.map((d) => [d, lastPart(d)])], state.dir, (dir) => change({ dir, page: 1 })));
    orderSlot.replaceChildren(selector('Ordenar por', Object.entries(ORDERS).map(([v, r]) => [v, r[state.direction]]), state.order, (order) => change({ order: order, page: 1 })));
    for (const b of pills.children) {
      b.setAttribute('aria-pressed', String(b.dataset.status === state.status));
      const n = b.querySelector('.sessions-pill-count');
      if (n) n.replaceChildren(pillCount(counts, b.dataset.status) ?? '');
    }
  }

  function change(partial) {
    state = { ...state, ...partial };
    history.replaceState(null, '', `${location.pathname}${queryFromState(state)}`);
    read();
  }

  // ---------- tabela ----------
  function row(s) {
    const target = `/ui/sessions/${encodeURIComponent(s.id)}`;
    const tr = el(
      'tr',
      { class: 'session-row' },
      el('td', { class: 'nm' }, el('a', { href: target, title: s.title }, el('b', {}, s.title)), el('small', {}, el('span', { class: 'mono' }, shortId(s.id)), account(s.account))),
      el('td', { class: 'st' }, ...badgeEl(s.status, s.attention)),
      el('td', { class: 'c-muted', title: new Date(s.lastActivity).toLocaleString('pt-BR') }, age(s.lastActivity)),
      // Os dois pedaços não quebram por dentro: na coluna estreita, o tempo desce para a linha de baixo.
      el('td', { class: 'mono dur' }, s.running ? el('span', { class: 'c-active' }, 'rodando ·') : null, s.running ? ' ' : null, el('span', {}, duration(s.durationMs))),
      el('td', { class: 'mono' }, String(s.agents)),
      el('td', { class: 'mono' }, cost(s.costUsd)),
      // Corta no começo (o fim do caminho é o que distingue): o LRM mantém a barra inicial no lugar.
      el('td', { class: 'dir', title: s.cwd ?? '' }, s.cwd ? `\u200e${s.cwd}\u200e` : '—'),
      el('td', { class: 'c-muted arrow' }, icon('chevron-right')),
    );
    tr.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('a')) return;
      ctx.navigate(target);
    });
    return tr;
  }

  function table(list) {
    return el(
      'div',
      { class: 'card' },
      el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...COLUMNS.map(([className, c]) => el('th', { scope: 'col', class: className }, c)))), el('tbody', {}, ...list.items.map(row))),
    );
  }

  function footer(list) {
    return el(
      'div',
      { class: 'sessions-footer' },
      el('span', {}, band(list)),
      el(
        'span',
        { class: 'pages' },
        el('button', { type: 'button', class: 'btn outline', disabled: list.page <= 1, onClick: () => change({ page: list.page - 1 }) }, 'Anterior'),
        el('button', { type: 'button', class: 'btn outline', disabled: list.page >= list.pages, onClick: () => change({ page: list.page + 1 }) }, 'Próxima'),
      ),
    );
  }

  function draw(list) {
    sub.textContent = list.registered === 1 ? '1 sessão registrada' : `${list.registered} sessões registradas`;
    // A página pedida pode ter sumido (a lista encolheu): fica a que o núcleo devolveu.
    if (list.page !== state.page) {
      state = { ...state, page: list.page };
      history.replaceState(null, '', `${location.pathname}${queryFromState(state)}`);
    }
    drawFilters(list.directories, list.counts);
    if (list.items.length) return body.replaceChildren(table(list), footer(list));
    const filtering = state.status !== 'all' || state.search.trim() || state.dir;
    body.replaceChildren(
      filtering
        ? empty({ title: 'Nenhuma sessão com esses filtros', text: 'Mude a busca, o diretório ou o status.', action: { label: 'Limpar os filtros', onClick: () => ((search.value = ''), change({ status: 'all', search: '', dir: '', page: 1 })) } })
        : empty({ icon: 'sessions', title: 'Nenhuma sessão ainda', text: 'As sessões do Claude Code desta máquina aparecem aqui assim que o núcleo as vê.' }),
    );
  }

  async function read() {
    const mine = ++request;
    try {
      const list = await ctx.read(listRoute(state));
      if (mine !== request) return;
      last = list;
      draw(list);
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== request) return;
      // Com uma lista na tela, ela fica e a faixa avisa; sem lista, o erro ocupa o lugar.
      if (last) {
        body.querySelector('.error-band')?.remove();
        body.prepend(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: () => read() } }));
      } else body.replaceChildren(error({ text: e.message, retry: () => read() }));
    }
  }

  // Ao vivo: qualquer mudança de sessão relê a página atual, no máximo uma vez por segundo.
  let liveWait = null;
  ctx.onChange(() => {
    if (liveWait) return;
    liveWait = setTimeout(() => {
      liveWait = null;
      read();
    }, 1000);
  });
  ctx.onRestart(() => read());

  drawFilters([]);
  await read();
  return () => {
    clearTimeout(searchWait);
    clearTimeout(liveWait);
  };
}
