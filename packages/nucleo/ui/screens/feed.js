// O Feed de atividade (C8, #94): todos os eventos das sessões, ao vivo, com filtros, pausa e uma
// linha aberta com o detalhe. Lê `GET /api/events`; o estado (lista, cursor, pausa) está em
// `feed-state.js`, e esta tela só desenha.
//
// - Primeira leitura (ou filtro novo, ou "Atualizar", ou o núcleo reiniciado): a página do topo.
// - Ao vivo: a cada mudança do long polling, pede `after=<cursor>` e põe os novos no topo. Um pedido
//   em voo por vez; mudança que chega no meio pede um único pedido a mais no fim.
// - Pausa: a lista congela; o que chega espera e aparece como "N novos", que solta tudo ao retomar.
// - "Mostrar mais": pede `before=<older>` e põe os mais velhos no fim.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { attentionPill } from '../attention.js';
import {
  toggleOne,
  load,
  query,
  dateTime,
  dayToIso,
  shortTime,
  shortId,
  newState,
  pause,
  receiveOlder,
  receiveNewer,
  resume,
  sessionRoute,
  STATUS,
  rowPill,
  relativeTime,
  hasFilter,
  trail,
  agentName,
} from './feed-state.js';

const CSS = '/ui/feed.css';
const CLOCK_MS = 5000;
/** O `limit` padrão de `/api/events`: um lote do ao vivo com esse tamanho diz que há mais. */
const LIVE_BATCH = 50;
const TYPING_MS = 300;

function attachCss() {
  if (document.head.querySelector('link[data-screen="feed"]')) return null;
  const link = el('link', { rel: 'stylesheet', href: CSS, 'data-screen': 'feed' });
  document.head.append(link);
  return link;
}

const isAbort = (e) => e?.name === 'AbortError';

export async function mount(area, ctx) {
  const css = attachCss();
  const state = newState();
  const filters = {};
  const items = new Map(); // id → nó da linha (com o detalhe, quando aberta)
  let generation = 0;
  let ready = false;
  let inFlight = false;
  let again = false;
  let typing = null;

  // ---------- cabeçalho ----------

  const pauseButton = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onClick: () => (state.pausado ? drop() : freeze()) });
  const refreshButton = el('button', { type: 'button', class: 'btn', onClick: () => reload() }, icon('refresh'), 'Atualizar');
  const head = header({ icon: 'activity', title: 'Feed de atividade', sub: 'Todos os eventos das sessões, ao vivo', actions: [pauseButton, refreshButton] });

  // ---------- sobre ----------

  const about = el(
    'details',
    { class: 'card feed-about' },
    el('summary', {}, icon('info'), el('b', {}, 'Sobre eventos, filtros e agrupamento'), el('span', {}, ' · como ler as pílulas, o ciclo de vida e os filtros')),
    el(
      'div',
      { class: 'feed-about-body' },
      el('p', {}, 'Cada linha é um evento gravado pelo núcleo, do mais novo para o mais velho. A pílula diz em que estado a sessão ficou depois dele: Ativa, Precisa de você (travada até você agir), Ociosa (o turno acabou e nada trava), Concluída ou Com erro.'),
      el('p', {}, 'Uma sessão nasce, roda turnos, chama ferramentas e subagentes, e termina. O caminho projeto › sessão › agente diz de onde o evento veio; "Sessão" abre o detalhe dela.'),
      el('p', {}, 'Os filtros se somam. A busca olha o resumo e a ferramenta. Com a pausa, a lista para de mexer e os eventos novos esperam no aviso "novos".'),
    ),
  );

  // ---------- filtros ----------

  const search = el('input', { type: 'search', class: 'feed-input', maxlength: '100', placeholder: 'Buscar no resumo ou na ferramenta…', 'aria-label': 'Buscar no resumo ou na ferramenta' });
  const from = el('input', { type: 'date', class: 'feed-input', 'aria-label': 'De' });
  const until = el('input', { type: 'date', class: 'feed-input', 'aria-label': 'Até' });
  const selector = (label) => el('select', { class: 'feed-chip feed-selector', 'aria-label': label }, el('option', { value: '' }, label));
  const sStatus = selector('Status');
  const sType = selector('Tipo de evento');
  const sTool = selector('Ferramenta');
  const sSession = selector('Sessão');
  optionsOf(sStatus, 'Status', Object.entries(STATUS));

  const filtersCard = el(
    'div',
    { class: 'card feed-filters' },
    el(
      'div',
      { class: 'feed-filters-row' },
      el('label', { class: 'feed-field feed-search' }, icon('filter'), search),
      el('label', { class: 'feed-field feed-day' }, icon('calendar'), el('span', {}, 'De'), from),
      el('label', { class: 'feed-field feed-day' }, icon('calendar'), el('span', {}, 'Até'), until),
    ),
    el('div', { class: 'feed-filters-row' }, sStatus, sType, sTool, sSession),
  );

  function readFilters() {
    filters.search = search.value;
    filters.from = dayToIso(from.value);
    filters.to = dayToIso(until.value, true);
    filters.status = sStatus.value;
    filters.type = sType.value;
    filters.tool = sTool.value;
    filters.session = sSession.value;
  }
  const filterChanged = () => (readFilters(), reload());
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(filterChanged, TYPING_MS);
  });
  for (const c of [from, until, sStatus, sType, sTool, sSession]) c.addEventListener('change', filterChanged);

  /** Troca as opções de um seletor, sem perder a escolhida. */
  function optionsOf(select, label, pairs) {
    const current = select.value;
    const list = [...pairs];
    if (current && !list.some(([v]) => v === current)) list.unshift([current, current]);
    select.replaceChildren(el('option', { value: '' }, label), ...list.map(([v, t]) => el('option', { value: v }, t)));
    select.value = current;
  }

  function refreshOptions(options) {
    if (!options) return;
    optionsOf(sType, 'Tipo de evento', (options.types ?? []).map((t) => [t, t]));
    optionsOf(sTool, 'Ferramenta', (options.tools ?? []).map((t) => [t, t]));
    optionsOf(sSession, 'Sessão', (options.sessions ?? []).map((s) => [s.id, [s.project, s.title ?? s.id].filter(Boolean).join(' › ')]));
  }

  // ---------- aviso de novos, faixa e corpo ----------

  const notice = el('button', { type: 'button', class: 'btn outline feed-new', hidden: true, onClick: () => drop() });
  const band = el('div', { class: 'feed-band' });
  const body = el('div', { class: 'feed-body' });
  const listEl = el('div', { class: 'feed-list' });
  const moreButton = el('button', { type: 'button', class: 'btn outline feed-more', onClick: () => showMore() }, 'Mostrar mais');
  const listCard = el('div', { class: 'card feed-rows' }, listEl, el('div', { class: 'feed-foot' }, moreButton));

  area.replaceChildren(head, about, filtersCard, notice, band, body);
  drawPause();

  const showBody = (node) => body.replaceChildren(node);
  const clearBand = () => band.replaceChildren();
  const showBand = (title, text) => band.replaceChildren(errorBand({ title, text, action: { label: 'Atualizar', onClick: () => reload() } }));

  // ---------- linhas ----------

  function row(ev) {
    const isOpen = state.aberto === ev.id;
    const route = sessionRoute(ev.session?.id);
    const pill = rowPill(ev);
    const arrow = el(
      'button',
      { type: 'button', class: 'feed-arrow', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-label': isOpen ? 'Fechar o detalhe' : 'Abrir o detalhe' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
    );
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOpen(ev.id);
    });
    const path = trail(ev);
    const headEl = el(
      'div',
      { class: `feed-row${isOpen ? ' feed-open' : ''}` },
      arrow,
      el('span', { class: 'feed-o mono feed-time' }, shortTime(ev.createdAt)),
      pill.attention ? attentionPill(pill.attention) : el('span', { class: `badge b-${pill.status}` }, el('span', { class: 'p' }), STATUS[pill.status]),
      el('span', { class: 'feed-o feed-trunc feed-trail', title: path }, path),
      el('span', { class: 'feed-trunc feed-summary', title: ev.summary ?? ev.type ?? '' }, ev.summary ?? ev.type ?? ''),
      ev.tool ? el('span', { class: 'feed-chip' }, ev.tool) : null,
      el('span', { class: 'feed-o feed-rel', title: dateTime(ev.createdAt) }, relativeTime(ev.createdAt)),
      route ? el('a', { class: 'btn outline feed-session', href: route }, 'Sessão', icon('external')) : null,
    );
    headEl.addEventListener('click', (e) => {
      if (e.target?.closest?.('a, button')) return;
      toggleOpen(ev.id);
    });
    return headEl;
  }

  function detail(ev) {
    const d = ev.detail ?? {};
    const agent = ev.agent ?? {};
    const pairs = [
      ['Evento', ev.type],
      ['Registrado', dateTime(ev.createdAt)],
      ['Sessão', ev.session?.id],
      ['Agente', [agentName(agent.name), shortId(agent.id)].filter(Boolean).join(' · ')],
      ['Ferramenta', ev.tool],
      ['Call id', d.callId],
    ];
    const block = ev.tool
      ? el('div', { class: 'feed-toolblock' }, icon('terminal'), el('span', { class: 'feed-n' }, ev.tool), el('span', { class: 'feed-cmd feed-trunc', title: d.input ?? '' }, d.input ?? ''))
      : el('p', { class: 'feed-text' }, ev.summary ?? d.input ?? '—');
    return el(
      'div',
      { class: 'feed-detail' },
      el('div', { class: 'card feed-block' }, el('div', { class: 'eyebrow' }, 'Resumo'), block, ev.tool && ev.summary ? el('p', { class: 'feed-text' }, ev.summary) : null),
      el('dl', { class: 'feed-kv mono' }, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'feed-trunc', title: v ?? '' }, v || '—')])),
    );
  }

  function item(ev) {
    const node = el('div', { class: 'feed-item', 'data-id': ev.id });
    fill(node, ev);
    items.set(ev.id, { no: node, ev });
    return node;
  }

  function fill(node, ev) {
    node.replaceChildren(...[row(ev), state.aberto === ev.id ? detail(ev) : null].filter(Boolean));
  }

  function toggleOpen(id) {
    const before = state.aberto;
    toggleOne(state, id);
    for (const k of new Set([before, state.aberto])) {
      const it = k && items.get(k);
      if (it) fill(it.no, it.ev);
    }
  }

  function drawAll() {
    items.clear();
    if (!state.events.length) {
      showBody(
        hasFilter(filters)
          ? empty({ title: 'Nenhum evento com esses filtros', text: 'Mude ou limpe os filtros para ver mais.' })
          : empty({ title: 'Nenhum evento ainda', text: 'Os eventos aparecem aqui assim que uma sessão do Claude Code registrar algo.' }),
      );
      return;
    }
    listEl.replaceChildren(...state.events.map(item));
    moreButton.hidden = !state.older;
    showBody(listCard);
  }

  function drawNew({ entraram: entered, cortados: cutOff, noTopo: atTop }) {
    if (!entered.length) return;
    if (body.firstChild !== listCard || !atTop) return drawAll();
    for (const ev of cutOff) {
      items.get(ev.id)?.no.remove();
      items.delete(ev.id);
    }
    listEl.prepend(...entered.map(item));
    moreButton.hidden = !state.older;
  }

  function drawPause() {
    pauseButton.replaceChildren(icon(state.pausado ? 'resume' : 'pause'), state.pausado ? 'Retomar' : 'Pausar');
    pauseButton.setAttribute('aria-pressed', state.pausado ? 'true' : 'false');
    const n = state.chegados;
    notice.hidden = !n;
    notice.textContent = n ? `${n} ${n === 1 ? 'novo' : 'novos'}` : '';
  }

  function freeze() {
    pause(state);
    drawPause();
  }

  function drop() {
    drawNew(resume(state));
    drawPause();
  }

  // ---------- leitura ----------

  async function reload({ manterLista: keepList = false } = {}) {
    const g = ++generation;
    ready = false;
    again = false;
    if (!keepList) showBody(loading({ label: 'Carregando eventos' }));
    try {
      const r = await ctx.read(query(filters));
      if (g !== generation) return;
      load(state, r);
      refreshOptions(r.options);
      ready = true;
      clearBand();
      drawAll();
      drawPause();
    } catch (e) {
      if (isAbort(e) || g !== generation) return;
      if (keepList && body.firstChild === listCard) showBand('Não deu para reler o feed.', e?.message);
      else showBody(error({ text: e?.message ?? String(e), retry: () => reload() }));
    }
  }

  async function fetchNew() {
    if (!ready) return;
    if (inFlight) return void (again = true);
    inFlight = true;
    const g = generation;
    try {
      const r = await ctx.read(query(filters, { after: state.cursor }));
      if (g !== generation) return;
      clearBand();
      refreshOptions(r.options);
      drawNew(receiveNewer(state, r));
      drawPause();
      // Lote cheio: há mais gravado depois deste cursor; pede de novo na hora.
      if ((r.events?.length ?? 0) >= LIVE_BATCH) again = true;
    } catch (e) {
      if (isAbort(e) || g !== generation) return;
      showBand('O ao vivo do feed falhou.', e?.message);
    } finally {
      inFlight = false;
      if (again && !ctx.signal?.aborted) {
        again = false;
        fetchNew();
      }
    }
  }

  async function showMore() {
    if (!state.older) return;
    const g = generation;
    moreButton.disabled = true;
    try {
      const r = await ctx.read(query(filters, { before: state.older }));
      if (g !== generation) return;
      const stale = receiveOlder(state, r);
      listEl.append(...stale.map(item));
      moreButton.hidden = !state.older;
    } catch (e) {
      if (isAbort(e) || g !== generation) return;
      showBand('Não deu para ler os eventos mais velhos.', e?.message);
    } finally {
      moreButton.disabled = false;
    }
  }

  ctx.onChange(() => fetchNew());
  ctx.onRestart(() => reload({ manterLista: true }));

  // Evento novo sozinho não é mudança no long polling (só estado, plano, decisão...): o relógio também
  // pergunta pelos novos, para o feed não esperar a próxima mudança de estado.
  const clock = setInterval(() => {
    if (ctx.liveState?.() !== 'offline') fetchNew();
    const now = Date.now();
    for (const { no: node, ev } of items.values()) {
      const rel = node.querySelector('.feed-rel');
      if (rel) rel.textContent = relativeTime(ev.createdAt, now);
    }
  }, CLOCK_MS);

  function clear() {
    clearInterval(clock);
    clearTimeout(typing);
    css?.remove();
  }
  // Sair durante a primeira carga aborta o sinal antes de a moldura receber a limpeza: liga aqui.
  ctx.signal?.addEventListener('abort', clear, { once: true });

  await reload();
  if (ctx.signal?.aborted) clear();

  return clear;
}
