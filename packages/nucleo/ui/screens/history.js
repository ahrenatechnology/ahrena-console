// Histórico (C15, #33): as sessões encerradas, agrupadas por dia, do mais recente ao mais antigo.
// Busca no cabeçalho, mais dias ao rolar (sem botão) e a ligação depois do `/clear` (3.8).
//
// As funções puras exportadas (rota, datas, valores) não tocam o DOM: os testes as importam no node.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';

/** Quantos dias cada página traz. */
export const DAYS_PER_PAGE = 7;

const SEARCH_DEBOUNCE_MS = 300;
const LIVE_WAIT_MS = 500;
const LIVE_MAX_WAIT_MS = 2000;
/** O tamanho máximo da busca: o núcleo recusa mais que isso (BUSCA_MAXIMA em src/historico/modelo.ts). */
export const MAX_SEARCH = 100;

// ---------- Funções puras ----------

/** A rota da API do histórico, só com os parâmetros presentes. */
export function historyRoute({ antes: before = null, busca: search = '', dias: days = DAYS_PER_PAGE } = {}) {
  const parts = [];
  if (before) parts.push(`before=${encodeURIComponent(before)}`);
  if (days) parts.push(`days=${encodeURIComponent(days)}`);
  if (search) parts.push(`search=${encodeURIComponent(search)}`);
  return parts.length ? `/api/history?${parts.join('&')}` : '/api/history';
}

const WEEK = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * O rótulo de um dia (`AAAA-MM-DD`, lido como data local): "Hoje · sábado, 18 out", "Ontem · sexta,
 * 17 out", "quinta, 16 out" e, se o ano não é o de `hoje`, "quinta, 16 out 2025".
 */
export function dayLabel(day, today = new Date()) {
  const [a, m, d] = String(day).split('-').map(Number);
  const data = new Date(a, m - 1, d);
  // Data inexistente (30 de fevereiro) não volta igual: sai como veio.
  if (!a || !m || !d || data.getFullYear() !== a || data.getMonth() !== m - 1 || data.getDate() !== d) return String(day);
  const base = `${WEEK[data.getDay()]}, ${data.getDate()} ${MONTHS[data.getMonth()]}${data.getFullYear() !== today.getFullYear() ? ` ${data.getFullYear()}` : ''}`;
  if (sameDay(data, today)) return `Hoje · ${base}`;
  if (sameDay(data, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return `Ontem · ${base}`;
  return base;
}

/** "~US$ 1,96"; abaixo de meio centavo, "<US$ 0,01"; sem valor, "—". */
export function formatCost(usd) {
  if (usd === null || usd === undefined || typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  if (usd > 0 && usd < 0.005) return '<US$ 0,01';
  const [integer, cents] = Math.abs(usd).toFixed(2).split('.');
  const thousands = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `~US$ ${usd < 0 ? '-' : ''}${thousands},${cents}`;
}

/** "<1 min", "52 min", "1 h 12 min", "2 h"; sem valor, "—". */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return '<1 min';
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const min = total % 60;
  return min ? `${h} h ${min} min` : `${h} h`;
}

/** Os 8 primeiros caracteres do id. */
export const shortId = (id) => String(id ?? '').slice(0, 8);

/**
 * Ao vivo: a primeira página relida (`novos`) mais os dias já carregados que são mais antigos que o
 * dia mais antigo dela. Primeira página vazia: lista vazia.
 */
export function mergeDays(currentOnes, newOnes) {
  if (!newOnes?.length) return [];
  const oldest = newOnes[newOnes.length - 1].dia;
  return [...newOnes, ...(currentOnes ?? []).filter((d) => d.dia < oldest)];
}

/** Anexa uma página seguinte: se o primeiro dia novo é o último carregado, as sessões vão juntas. */
export function appendDays(currentOnes, newOnes) {
  const list = [...(currentOnes ?? [])];
  for (const day of newOnes ?? []) {
    const last = list[list.length - 1];
    if (last && last.dia === day.dia) {
      const ids = new Set(last.sessoes.map((s) => s.id));
      list[list.length - 1] = { ...last, sessoes: [...last.sessoes, ...day.sessoes.filter((s) => !ids.has(s.id))] };
    } else list.push(day);
  }
  return list;
}

// ---------- Peças ----------

const STATUS = {
  completed: 'Concluída',
  error: 'Com erro',
  abandoned: 'Abandonada',
  active: 'Ativa',
  waiting: 'Esperando você',
};

function badge(status) {
  const known = Object.hasOwn(STATUS, status);
  return el('span', { class: `badge b-${known ? status : 'abandoned'}` }, el('span', { class: 'p' }), known ? STATUS[status] : String(status ?? '—'));
}

const sessionRoute = (id) => `/ui/sessions/${encodeURIComponent(id)}`;

function row(s) {
  const id = String(s.id);
  const previous = s.anterior
    ? el(
        'div',
        { class: 'hist-o hist-trunc hist-continued' },
        icon('continued'),
        ' continuou depois do ',
        el('code', {}, '/clear'),
        ' em ',
        el('a', { class: 'hist-accent hist-previous', href: sessionRoute(String(s.anterior.id)) }, s.anterior.titulo || shortId(s.anterior.id)),
      )
    : null;
  return el(
    'div',
    { class: 'hist-row' },
    badge(s.status),
    el('div', { class: 'hist-trunc hist-block' }, el('a', { class: 'hist-target', href: sessionRoute(id) }, el('b', { class: 'hist-title' }, s.titulo || 'Sem título')), ' ', el('span', { class: 'hist-o mono' }, shortId(id)), previous),
    el('span', { class: 'hist-o mono hist-trunc hist-project' }, s.projeto || '—'),
    el('span', { class: 'hist-o mono hist-trunc hist-model' }, s.modelo || '—'),
    el('span', { class: 'hist-o mono hist-duration' }, formatDuration(s.duracaoMs)),
    el('span', { class: 'mono hist-cost' }, formatCost(s.custoUsd)),
    el('span', { class: 'hist-muted hist-arrow' }, icon('chevron-right')),
  );
}

function group(day, today) {
  const label = dayLabel(day.dia, today);
  const n = day.sessoes.length;
  return el(
    'section',
    { class: 'hist-group', 'aria-label': label },
    el('h2', { class: 'eyebrow hist-day' }, icon('calendar'), label, el('span', { class: 'hist-n' }, `${n} ${n === 1 ? 'sessão' : 'sessões'}`)),
    el('div', { class: 'card hist-rows' }, ...day.sessoes.map(row)),
  );
}

// ---------- Tela ----------

export function mount(area, ctx) {
  // O estilo da tela, uma vez por página.
  if (!document.querySelector('link[data-screen="history"]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/ui/history.css', 'data-screen': 'history' }));
  }
  const input = el('input', { type: 'search', placeholder: 'Buscar…', 'aria-label': 'Buscar no histórico', maxlength: MAX_SEARCH, autocomplete: 'off', spellcheck: 'false' });
  const field = el('label', { class: 'hist-search' }, icon('search'), input);
  const head = header({ icon: 'history', title: 'Histórico', sub: 'Sessões encerradas, por dia', actions: [field] });
  // Três regiões: a faixa do ao vivo, a lista e o rodapé (faixa da página seguinte ou sentinela).
  // As faixas são nós estáveis: um redesenho da lista não as recria nem as anuncia de novo.
  const top = el('div', { class: 'hist-region', hidden: true });
  const list = el('div', { class: 'hist-region' });
  const footer = el('div', { class: 'hist-region', hidden: true });
  const sentinel = el('div', { class: 'hist-sentinel', 'aria-hidden': 'true' });
  const body = el('div', { class: 'hist-body' }, top, list, footer);
  area.replaceChildren(head, body);

  let search = '';
  let days = [];
  let next = null;
  let generation = 0;
  let control = null; // um por geração: mudar de geração cancela o que ela pediu
  let ready = false; // a primeira leitura deu certo: o ao vivo pode reler
  let loadingMore = false;
  let liveBand = null;
  let moreBand = null;
  let liveTurn = 0;
  let searchWait = null;
  let liveWait = null;
  let firstPending = null;
  let ended = false;

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((inputs) => inputs.some((e) => e.isIntersecting) && loadMore(), { root: area, rootMargin: '0px 0px 300px 0px' })
      : null;

  const aborted = (e) => e?.name === 'AbortError' || ended;

  function newGeneration() {
    control?.abort();
    control = new AbortController();
    return ++generation;
  }

  // O `ctx.ler` põe o sinal da tela antes das opções: o nosso o substituiria, então vão os dois juntos.
  function read(route) {
    const signal = ctx.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctx.signal, control.signal]) : control.signal;
    return ctx.read(route, { signal: signal });
  }

  function pickLane(region, node) {
    if (region.firstChild !== node || region.childNodes.length !== (node ? 1 : 0)) region.replaceChildren(...(node ? [node] : []));
    region.hidden = !node;
  }

  function focusAfterRetry(link) {
    if (body.contains(document.activeElement)) return;
    (link ?? list.querySelector('a.hist-target') ?? input).focus();
  }

  function drawList() {
    // Quem navega pelo teclado não perde o lugar quando a lista é redesenhada.
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusTarget = focused?.matches('a[href]') ? { href: focused.getAttribute('href'), classe: focused.className } : null;

    const today = new Date();
    const children = [];
    if (!days.length && (!next || !observer)) {
      children.push(
        search
          ? empty({ title: 'Nenhuma sessão encontrada', text: `Nada com “${search}” no histórico.` })
          : empty({ title: 'Nenhuma sessão encerrada ainda', text: 'As sessões aparecem aqui quando terminam.' }),
      );
    } else if (!days.length) children.push(loading()); // páginas vazias: o sentinela segue buscando
    for (const day of days) children.push(group(day, today));
    list.replaceChildren(...children);

    if (focusTarget) {
      for (const a of list.querySelectorAll('a[href]')) {
        if (a.getAttribute('href') === focusTarget.href && a.className === focusTarget.classe) {
          a.focus({ preventScroll: true });
          break;
        }
      }
    }
    pickLane(top, liveBand);
    const withSentinel = !moreBand && next && observer;
    pickLane(footer, moreBand ?? (withSentinel ? sentinel : null));
    // Observar de novo dispara a checagem: numa tela alta, o sentinela já visível pede a próxima página.
    observer?.disconnect();
    if (withSentinel) observer.observe(sentinel);
  }

  async function restart() {
    const g = newGeneration();
    clearTimeout(liveWait);
    firstPending = null;
    days = [];
    next = null;
    ready = false;
    loadingMore = false;
    liveBand = null;
    moreBand = null;
    observer?.disconnect();
    pickLane(top, null);
    pickLane(footer, null);
    list.replaceChildren(loading());
    try {
      const r = await read(historyRoute({ busca: search }));
      if (g !== generation || ended) return;
      days = r?.dias ?? [];
      next = r?.proximo ?? null;
      ready = true;
      drawList();
    } catch (e) {
      if (aborted(e) || g !== generation) return;
      // Status 0: o núcleo não respondeu (o título padrão). Outro status: ele respondeu com erro.
      list.replaceChildren(error({ title: e?.status ? 'Não deu para ler o histórico' : undefined, text: e?.message ?? String(e), retry: restart }));
    }
  }

  async function loadMore() {
    if (!ready || !next || loadingMore) return;
    const g = generation;
    loadingMore = true;
    try {
      const r = await read(historyRoute({ antes: next, busca: search }));
      if (g !== generation || ended) return;
      days = appendDays(days, r?.dias ?? []);
      next = r?.proximo ?? null;
      moreBand = null;
    } catch (e) {
      if (aborted(e) || g !== generation) return;
      moreBand ??= errorBand({ title: 'Não deu para carregar mais dias', text: e?.message ?? String(e), action: { label: 'Tentar de novo', onClick: retryMore } });
    }
    loadingMore = false;
    drawList();
  }

  async function retryMore() {
    const before = list.querySelectorAll('a.hist-target').length;
    await loadMore();
    // Deu certo: o foco vai para a primeira sessão que chegou.
    focusAfterRetry(list.querySelectorAll('a.hist-target')[before]);
  }

  async function reread() {
    if (!ready) return;
    const g = generation;
    const turn = ++liveTurn;
    try {
      const r = await read(historyRoute({ busca: search }));
      if (g !== generation || turn !== liveTurn || ended) return;
      const newOnes = r?.dias ?? [];
      const oldest = newOnes.length ? newOnes[newOnes.length - 1].dia : null;
      // Os dias já carregados além da primeira página ficam, e o cursor deles também.
      const keepOld = oldest !== null && days.some((d) => d.dia < oldest);
      days = mergeDays(days, newOnes);
      if (!keepOld) next = r?.proximo ?? null;
      liveBand = null;
    } catch (e) {
      if (aborted(e) || g !== generation || turn !== liveTurn) return;
      liveBand ??= errorBand({ title: 'Não deu para atualizar o histórico', text: e?.message ?? String(e), action: { label: 'Tentar de novo', onClick: retryLive } });
    }
    drawList();
  }

  async function retryLive() {
    await reread();
    focusAfterRetry(null);
  }

  input.addEventListener('input', () => {
    clearTimeout(searchWait);
    searchWait = setTimeout(() => {
      const value = input.value.trim();
      if (value === search) return;
      search = value;
      restart();
    }, SEARCH_DEBOUNCE_MS);
  });

  // Espera a rajada de mudanças assentar, mas relê no máximo ESPERA_MAXIMA_DO_AO_VIVO_MS depois da
  // primeira mudança pendente, mesmo que elas não parem.
  ctx.onChange((changes) => {
    if (!changes?.some((m) => m.type === 'session')) return;
    const now = Date.now();
    firstPending ??= now;
    clearTimeout(liveWait);
    const delay = Math.max(0, Math.min(LIVE_WAIT_MS, firstPending + LIVE_MAX_WAIT_MS - now));
    liveWait = setTimeout(() => {
      firstPending = null;
      reread();
    }, delay);
  });
  // Núcleo reiniciado ou conexão de volta: com a lista no ar, relê sem perder páginas nem rolagem.
  ctx.onRestart(() => (ready ? reread() : restart()));

  restart();

  return () => {
    ended = true;
    generation++;
    control?.abort();
    observer?.disconnect();
    clearTimeout(searchWait);
    clearTimeout(liveWait);
  };
}
