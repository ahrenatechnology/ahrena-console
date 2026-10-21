// ADR e PDR (C28 e C38, issue 174): os registros de decisão de todos os repositórios da conta, por
// repositório, com busca no título e no texto e filtro por status. A mesma tela desenha as duas: o
// tipo vem do caminho (`/ui/adrs` ou `/ui/pdrs`), e muda só o rótulo, o ícone e a rota da API.
//
// - Lê `GET /api/adrs?q=&status=&repo=` (src/adrs/model.ts `DecisionList`). A rota nunca espera o
//   GitHub: com `state: 'loading'`, a tela espera a mudança ao vivo `{ type: 'adrs', key: 'list' }`
//   (e relê a cada 5 s, se ela não vier).
// - Os filtros ficam na URL (`?q=&status=&repo=&sort=`), trocados sem entrada nova no histórico.
// - Sem filtro, cada repositório mostra até 5 registros e o link "Ver as N" para a aba do repositório.
// - O GitHub limitando: a faixa diz a hora do cache e quando tenta de novo (C31); a lista continua.

import { el, header, icon } from '../dom.js';
import { loading, error, empty } from '../states.js';
import { NO_GITHUB } from '../repos-format.js';
import { ADR_FOLDERS, PDR_FOLDERS, HOW_TO_WRITE, foldersText, FORMAT_LABEL, KINDS, STATUS_FILTERS, decisionsChangeMatters, joinPt, kindOfPath, limitedBand, loadDecisionsStyle, recordRow, repoTabHref, segmented } from './adrs-common.js';
import { connectEmptyFor, connectionChanged, isGithubNotConnected } from '../github-connect.js';

const REREAD_MS = 5000;
const PER_GROUP = 5;
const SEARCH_DEBOUNCE_MS = 250;

/** Os filtros da URL: só os valores que a tela conhece. */
export function filtersFrom(search) {
  const p = new URLSearchParams(search);
  const status = p.get('status') ?? '';
  const sort = p.get('sort') === 'date' ? 'date' : 'number';
  return { q: (p.get('q') ?? '').slice(0, 200), status: STATUS_FILTERS.some(([v]) => v === status) ? status : '', repo: p.get('repo') ?? '', sort };
}

/** A consulta da API com os filtros (a ordem é da tela, não do núcleo). */
export function listRoute(api, { q, status, repo }) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (status) p.set('status', status);
  if (repo) p.set('repo', repo);
  const s = p.toString();
  return s ? `${api}?${s}` : api;
}

/** Ordena as linhas de um grupo: pelo número (o padrão do núcleo) ou pela data, mais nova primeiro. */
export function sortRecords(records, sort) {
  if (sort !== 'date') return records;
  return [...records].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.number ?? -1) - (a.number ?? -1));
}

export async function mount(area, ctx) {
  loadDecisionsStyle();
  const K = kindOfPath(location.pathname);
  let filters = filtersFrom(location.search);
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;
  let searchTimer = null;
  ctx.title(K.label);

  // ---------- as peças fixas ----------
  const accountChip = el('span', { class: 'adr-chip mono', hidden: true });
  const refresh = el('button', { type: 'button', class: 'btn outline' }, icon('refresh'), 'Atualizar');
  refresh.addEventListener('click', () => read({ refresh: true }));
  const head = header({ icon: K.icon, title: K.label, sub: K.kind === 'pdr' ? 'Decisões de produto dos repositórios da sua conta: o que o produto faz, para quem e por quê' : 'Decisões de arquitetura dos repositórios da sua conta, lidas das pastas de cada um', actions: [accountChip, refresh] });
  const band = el('div', { class: 'adr-bands' });
  const stats = el('div', { class: 'adr-stats' });
  const input = el('input', { type: 'search', value: filters.q, placeholder: K.kind === 'pdr' ? 'Buscar no título e no texto: "gratuito", "preço", "onboarding"…' : 'Buscar no título e no texto: "fila", "cache", "SQLite"…', 'aria-label': `Buscar nas ${K.plural}` });
  input.value = filters.q;
  const ownerSelect = el('select', { class: 'adr-select', 'aria-label': 'Organização' });
  const repoSelect = el('select', { class: 'adr-select', 'aria-label': 'Repositório' });
  const statusSlot = el('div', { class: 'adr-status-slot' });
  const sortSelect = el('select', { class: 'adr-select adr-sort', 'aria-label': 'Ordem' }, el('option', { value: 'number' }, 'Mais recentes primeiro'), el('option', { value: 'date' }, 'Pela data, mais nova primeiro'));
  sortSelect.value = filters.sort;
  const filterCard = el(
    'div',
    { class: 'card adr-filters' },
    el('label', { class: 'adr-field' }, icon('search'), input),
    ownerSelect,
    repoSelect,
    el('div', { class: 'adr-filters-row' }, statusSlot, sortSelect),
  );
  const body = el('div', { class: 'adr-groups' });
  area.replaceChildren(head, band, stats, filterCard, body);

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilters({ q: input.value.trim() }), SEARCH_DEBOUNCE_MS);
  });
  ownerSelect.addEventListener('change', () => setFilters({ repo: ownerSelect.value }));
  repoSelect.addEventListener('change', () => setFilters({ repo: repoSelect.value || ownerSelect.value }));
  sortSelect.addEventListener('change', () => {
    filters = { ...filters, sort: sortSelect.value };
    writeUrl();
    draw();
  });

  function writeUrl() {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.status) p.set('status', filters.status);
    if (filters.repo) p.set('repo', filters.repo);
    if (filters.sort !== 'number') p.set('sort', filters.sort);
    const s = p.toString();
    history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}`);
  }

  function setFilters(next) {
    filters = { ...filters, ...next };
    writeUrl();
    read();
  }

  // ---------- leitura ----------
  async function read({ refresh: force = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    try {
      const route = listRoute(K.api, filters);
      const d = await ctx.read(force ? `${route}${route.includes('?') ? '&' : '?'}refresh=1` : route);
      if (n !== request) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  // ---------- desenho ----------
  function stat(label, value, sub, iconName, tone) {
    return el('section', { class: 'card adr-stat' }, el('span', { class: 'adr-stat-label' }, label), el('span', { class: `adr-stat-ic adr-tone-${tone}` }, icon(iconName)), el('span', { class: 'adr-stat-v' }, String(value)), el('span', { class: 'adr-stat-s' }, sub));
  }

  function drawStats() {
    const t = data.totals;
    stats.replaceChildren(
      stat(K.plural, t.records, `em ${t.reposWith} de ${t.reposRead} repositórios`, K.icon, 'accent'),
      stat('Aceitas', t.accepted, 'valem hoje', 'check-circle-2', 'ok'),
      stat('Propostas', t.proposed, 'esperando decisão', 'circle-dashed', 'wait'),
      stat('Substituídas', t.replaced, 'substituídas ou obsoletas', 'git-compare', 'muted'),
      stat('Incompletas', t.incomplete, 'sem status, data ou seção', 'file-warning', 'muted'),
    );
  }

  function drawFilters() {
    const owners = data.owners ?? [];
    const [owner, repo] = filters.repo.split('/');
    ownerSelect.replaceChildren(el('option', { value: '' }, 'Todas as organizações'), ...owners.map((o) => el('option', { value: o }, o)));
    ownerSelect.value = owners.includes(owner) ? owner : '';
    const repos = (data.repos ?? []).filter((r) => !ownerSelect.value || r.startsWith(`${ownerSelect.value}/`));
    repoSelect.replaceChildren(el('option', { value: '' }, 'Todos os repositórios'), ...repos.map((r) => el('option', { value: r }, r)));
    repoSelect.value = repo && repos.includes(filters.repo) ? filters.repo : '';
    const c = data.counts;
    statusSlot.replaceChildren(segmented('Status', STATUS_FILTERS.map(([v, label, k]) => [v, `${label} ${c[k] ?? 0}`]), filters.status, (v) => setFilters({ status: v })));
  }

  function group(g, filtered) {
    const records = (data.state === 'ready' ? sortRecords(g.records, filters.sort) : g.records).slice(0, filtered ? undefined : PER_GROUP);
    const more = !filtered && g.total > records.length;
    const meta = [g.folders.join(', '), FORMAT_LABEL[g.format] ?? g.format, `${g.total} ${g.total === 1 ? K.label : K.plural}`];
    if (K.kind === 'pdr' && g.byTypeField) meta.push('separadas das ADRs pelo campo Tipo: produto');
    return el(
      'section',
      { class: 'adr-group', 'data-repo': g.repo },
      el(
        'div',
        { class: 'adr-group-head' },
        icon('repos'),
        el('a', { class: 'mono adr-group-repo', href: repoTabHref(g.repo, K.kind) }, g.repo),
        el('span', { class: 'adr-group-meta adr-trunc' }, meta.filter(Boolean).join(' · ')),
        more ? el('a', { class: 'adr-group-more', href: repoTabHref(g.repo, K.kind) }, `Ver as ${g.total} ›`) : null,
      ),
      el('div', { class: 'card adr-list' }, ...records.map((r) => recordRow(r))),
    );
  }

  function foldersLine() {
    const folders = K.kind === 'pdr' ? PDR_FOLDERS : ADR_FOLDERS;
    const names = data.without.map((r) => r.split('/')[1]);
    const details = el('details', { class: 'adr-folders' }, el('summary', {}, 'Pastas procuradas'), el('p', {}, ...folders.flatMap((f, i) => [i ? ', ' : '', el('code', {}, f)]), K.kind === 'pdr' ? ' e, nas pastas de ADR, as decisões com Tipo: produto.' : '.'));
    const text = names.length ? [`Sem ${K.label} em ${names.length} ${names.length === 1 ? 'repositório' : 'repositórios'}: `, ...joinParts(names)] : [`Todos os repositórios lidos têm ${K.plural}.`];
    return el('div', { class: 'card adr-without' }, icon('folder-search'), el('span', { class: 'adr-without-text' }, ...text, '.'), details);
  }

  function joinParts(names) {
    const joined = joinPt(names.map((_, i) => `\u0000${i}\u0000`));
    return joined.split(/\u0000(\d+)\u0000/).map((part, i) => (i % 2 ? el('b', {}, names[Number(part)]) : part)).filter((x) => x !== '');
  }

  function emptyAll() {
    const folders = K.kind === 'pdr' ? PDR_FOLDERS : ADR_FOLDERS;
    const node = empty({ icon: 'folder-search', title: `Nenhuma ${K.label} nos repositórios da conta`, text: ' ' });
    node.querySelector('p')?.replaceChildren(foldersText(folders, { after: `, nos ${data.totals.reposRead} repositórios lidos` }));
    node.append(el('a', { class: 'btn outline', href: HOW_TO_WRITE, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), `Como escrever uma ${K.label}`));
    return node;
  }

  function draw() {
    clearTimeout(timer);
    timer = null;
    band.replaceChildren();
    if (isGithubNotConnected(failure)) {
      stats.hidden = true;
      filterCard.hidden = true;
      accountChip.hidden = true;
      return body.replaceChildren(connectEmptyFor(K.kind === 'pdr' ? 'pdrs' : 'adrs', ctx.navigate));
    }
    if (failure && data?.state === 'ready') band.append(limitedBand({ error: `${failure.message}`, readAt: null, retryAt: null, plural: K.plural, onRetry: () => read() }));
    if (!data || data.state !== 'ready') {
      stats.hidden = true;
      filterCard.hidden = true;
      if (failure) return body.replaceChildren(error({ text: failure.message, retry: () => (body.replaceChildren(loading()), read()) }));
      if (!data) return body.replaceChildren(loading());
      if (data.state === 'loading') {
        timer = setTimeout(read, REREAD_MS);
        return body.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
      }
      if (data.state === 'no-github') return body.replaceChildren(empty({ icon: 'github', title: NO_GITHUB.titulo, text: NO_GITHUB.texto }));
      return body.replaceChildren(error({ title: 'O GitHub não respondeu', text: data.error ?? `A leitura das ${K.plural} falhou.`, retry: () => read({ refresh: true }) }));
    }
    if (data.error) band.append(limitedBand({ error: data.error, readAt: data.readAt, retryAt: data.retryAt, plural: K.plural, onRetry: () => read({ refresh: true }) }));
    accountChip.hidden = !data.account;
    accountChip.replaceChildren(icon('github'), `conta: ${data.account ?? ''}`);
    stats.hidden = false;
    filterCard.hidden = false;
    drawStats();
    drawFilters();
    if (!data.totals.records) return body.replaceChildren(emptyAll());
    const filtered = Boolean(filters.q || filters.status || filters.repo);
    const groups = data.groups.map((g) => group(g, filtered));
    if (!groups.length) groups.push(empty({ icon: 'search', title: `Nenhuma ${K.label} com esses filtros`, text: 'Troque a busca, o status ou o repositório.' }));
    body.replaceChildren(...groups, foldersLine());
  }

  ctx.onChange((changes) => {
    if (decisionsChangeMatters(changes, 'list') || connectionChanged(changes)) read();
  });
  ctx.onRestart(() => read());

  body.replaceChildren(loading());
  await read();
  return () => {
    clearTimeout(timer);
    clearTimeout(searchTimer);
    request++;
  };
}

export { KINDS };
