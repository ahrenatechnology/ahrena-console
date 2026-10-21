// A aba ADRs de um repositório (C29 e C31, issue 174): a lista do repositório, onde foi lida e a
// cadeia de substituições. A tela Repositório (repo.js) monta o cabeçalho e as abas; esta monta o
// conteúdo da aba em `/ui/repos/<owner>/<repo>/adrs`.
//
// - O seletor ADR · PDR · Todas no topo, em `?kind=` (o padrão é ADR); "Todas" lista os dois tipos,
//   com a marca do tipo em cada linha.
// - Lê `GET /api/adrs/<owner>/<repo>?kind=` (src/adrs/model.ts `RepoDecisions`). A rota nunca espera
//   o GitHub: com `state: 'loading'`, espera a mudança ao vivo `{ type: 'adrs', key: '<owner>/<repo>' }`
//   (e relê a cada 5 s, se ela não vier).
// - A busca (título e texto do título; o texto inteiro fica na tela geral) e o filtro de status são
//   locais: a lista do repositório já veio inteira.
// - Estados (C31): o GitHub limitando (a faixa com a hora do cache), o repositório sem registro (o
//   vazio com as pastas procuradas) e, no registro aberto, o que falta tracejado.

import { el, icon } from '../dom.js';
import { loading, error, empty } from '../states.js';
import { NO_GITHUB } from '../repos-format.js';
import { ADR_FOLDERS, FORMAT_LABEL, HOW_TO_WRITE, KINDS, PDR_FOLDERS, ago, chainList, decisionsChangeMatters, fold, foldersText, limitedBand, loadDecisionsStyle, recordRow, segmented } from './adrs-common.js';
import { connectEmptyFor, connectionChanged, isGithubNotConnected } from '../github-connect.js';

const REREAD_MS = 5000;

const KIND_OPTIONS = ['adr', 'pdr', 'all'];

/** O tipo da aba, da URL: `adr` (padrão), `pdr` ou `all`. */
export const tabKindFrom = (search) => {
  const k = new URLSearchParams(search).get('kind');
  return KIND_OPTIONS.includes(k) ? k : 'adr';
};

/** A lista com a busca e o status, na tela. */
export function filterRecords(records, { q = '', status = '' } = {}) {
  const f = fold(q.trim());
  return records.filter((r) => (!status || r.status === status) && (!f || fold(r.title).includes(f) || fold(r.path).includes(f)));
}

const TAB_STATUS = [
  ['', 'Todas'],
  ['accepted', 'Aceitas'],
  ['proposed', 'Propostas'],
  ['superseded', 'Substituídas'],
];

/**
 * Monta a aba no `area`. `onCount(n)` recebe o total de registros do repositório (ADR e PDR) para a
 * contagem da aba no cabeçalho.
 */
export async function mountRepoDecisions(area, ctx, { owner, name, onCount = () => {} }) {
  loadDecisionsStyle();
  const key = `${owner}/${name}`;
  let kind = tabKindFrom(location.search);
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;
  let q = '';
  let status = '';

  const band = el('div', { class: 'adr-bands' });
  const kindSlot = el('div', { class: 'adr-kind-bar' });
  const input = el('input', { type: 'search', placeholder: 'Buscar nas decisões deste repositório…', 'aria-label': 'Buscar nas decisões deste repositório' });
  const statusSlot = el('div', {});
  const toolbar = el('div', { class: 'adr-toolbar' }, el('label', { class: 'adr-field' }, icon('search'), input), statusSlot);
  const list = el('div', { class: 'card adr-list' });
  const side = el('aside', { class: 'adr-side' });
  const grid = el('div', { class: 'adr-repo-grid' }, list, side);
  const body = el('div', { class: 'adr-repo-body' });
  const root = el('div', { class: 'adr-repo' }, band, kindSlot, body);
  area.replaceChildren(root);

  input.addEventListener('input', () => {
    q = input.value;
    drawList();
  });

  function route(force = false) {
    const base = `/api/adrs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?kind=${kind}`;
    return force ? `${base}&refresh=1` : base;
  }

  async function read({ refresh = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    try {
      const d = await ctx.read(route(refresh));
      if (n !== request) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  function pickKind(k) {
    if (k === kind) return;
    kind = k;
    history.replaceState(history.state, '', `${location.pathname}${k === 'adr' ? '' : `?kind=${k}`}`);
    read();
  }

  function drawKinds() {
    const c = data?.counts ?? { adr: 0, pdr: 0, all: 0 };
    kindSlot.replaceChildren(
      segmented('Tipo', [['adr', `ADR ${c.adr}`, 'scroll-text'], ['pdr', `PDR ${c.pdr}`, 'lightbulb'], ['all', `Todas ${c.all}`]], kind, pickKind),
      el('span', { class: 'adr-muted adr-kind-hint' }, 'ADR é arquitetura; PDR é produto. O tipo vem do campo de tipo, do prefixo ou da pasta.'),
    );
  }

  function drawList() {
    const shown = filterRecords(data.records, { q, status });
    list.replaceChildren(...(shown.length ? shown.map((r) => recordRow(r, { listKind: kind })) : [el('p', { class: 'adr-none' }, 'Nenhuma decisão com essa busca.')]));
    statusSlot.replaceChildren(
      segmented('Status', TAB_STATUS, status, (v) => {
        status = v;
        drawList();
      }),
    );
  }

  function drawSide() {
    const plural = kind === 'all' ? 'decisões' : KINDS[kind].plural;
    const where = el(
      'section',
      { class: 'card adr-side-card', 'aria-label': 'Onde li', 'data-card': 'where' },
      el('h2', { class: 'adr-sec-ttl' }, icon('folder-search'), 'Onde li'),
      el(
        'div',
        { class: 'adr-where' },
        el('span', {}, data.folders.length > 1 ? 'Pastas ' : 'Pasta ', el('b', { class: 'mono' }, data.folders.join(', ') || '—')),
        el('span', {}, 'Arquivos ', el('b', {}, String(data.records.length)), data.format ? [' · formato ', el('b', {}, FORMAT_LABEL[data.format] ?? data.format)] : null),
        el('span', {}, 'Lido ', el('b', {}, ago(data.readAt)), data.fromCache ? ' · do cache' : ''),
      ),
      el('span', { class: 'adr-muted adr-small' }, `Sem ${plural} novas enquanto o commit da pasta não mudar.`),
    );
    const chains = data.chains.length
      ? el('section', { class: 'card adr-side-card', 'aria-label': 'Substituições', 'data-card': 'chains' }, el('h2', { class: 'adr-sec-ttl' }, icon('git-compare'), 'Substituições'), ...data.chains.map((c) => chainList(c, data.repo)))
      : null;
    side.replaceChildren(...[where, chains].filter(Boolean));
  }

  function emptyRepo() {
    const folders = kind === 'pdr' ? PDR_FOLDERS : kind === 'all' ? [...ADR_FOLDERS, ...PDR_FOLDERS] : ADR_FOLDERS;
    const label = kind === 'pdr' ? 'PDR' : kind === 'all' ? 'decisão' : 'ADR';
    const node = empty({ icon: 'folder-search', title: `Nenhuma ${label} neste repositório`, text: ' ' });
    node.querySelector('p')?.replaceChildren(foldersText(folders, { after: kind === 'all' ? ', de ADR e de PDR' : '' }));
    node.setAttribute('class', `${node.getAttribute('class')} adr-empty`);
    node.append(el('a', { class: 'btn outline', href: HOW_TO_WRITE, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), `Como escrever uma ${kind === 'pdr' ? 'PDR' : 'ADR'}`));
    return node;
  }

  function draw() {
    clearTimeout(timer);
    timer = null;
    band.replaceChildren();
    drawKinds();
    const ready = data && data.state === 'ready';
    if (failure && ready) band.append(limitedBand({ error: failure.message, readAt: data.readAt, retryAt: null, plural: 'decisões', onRetry: () => read() }));
    if (isGithubNotConnected(failure)) return body.replaceChildren(connectEmptyFor('instructions', ctx.navigate));
    if (!ready) {
      if (failure) return body.replaceChildren(error({ text: failure.message, retry: () => (body.replaceChildren(loading()), read()) }));
      if (!data) return body.replaceChildren(loading());
      if (data.state === 'loading') {
        timer = setTimeout(read, REREAD_MS);
        return body.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
      }
      if (data.state === 'no-github') return body.replaceChildren(empty({ icon: 'github', title: NO_GITHUB.titulo, text: NO_GITHUB.texto }));
      if (data.state === 'not-found') return body.replaceChildren(empty({ icon: 'repos', title: 'Repositório não encontrado', text: `${key} não existe ou a conta do GitHub não tem acesso a ele.` }));
      return body.replaceChildren(error({ title: 'O GitHub não respondeu', text: data.error ?? 'A leitura das decisões falhou.', retry: () => read({ refresh: true }) }));
    }
    onCount(data.counts.all);
    if (data.error) band.append(limitedBand({ error: data.error, readAt: data.readAt, retryAt: data.retryAt, plural: kind === 'pdr' ? 'PDRs' : kind === 'all' ? 'decisões' : 'ADRs', onRetry: () => read({ refresh: true }) }));
    if (!data.records.length) return body.replaceChildren(emptyRepo());
    drawList();
    drawSide();
    body.replaceChildren(toolbar, grid);
  }

  ctx.onChange((changes) => {
    if (decisionsChangeMatters(changes, key) || connectionChanged(changes)) read();
  });
  ctx.onRestart(() => read());

  body.replaceChildren(loading());
  await read();
  return () => {
    clearTimeout(timer);
    request++;
  };
}
