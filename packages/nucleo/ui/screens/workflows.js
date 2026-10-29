// Workflows (#96, C14): as KPIs de orquestração, os runs do Workflow tool (fases e agentes) e o grafo
// de orquestração, sobre `GET /api/workflows?filter=&node=` (src/api/workflows.ts). O filtro do topo e o
// clique num nó do grafo valem para a tela inteira: os dois vão para a API, que devolve tudo filtrado.
//
// Ao vivo: relê a cada mudança `session` ou `state` (de qualquer sessão) e quando a moldura manda
// reler. Subagente que começa ou termina não gera mudança, então, enquanto houver run ativo ou sessão
// em andamento, relê a cada 10 s.
//
// Tudo o que vem do núcleo entra por `textContent` (`el()` e `svg()`), nunca como HTML.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { decimal, duration, modelName, num, percent, when, tokens } from './workflow-format.js';
import { initialOpen, treeKpiRow, treePanel } from './workflow-tree.js';

const SVG = 'http://www.w3.org/2000/svg';

/** The views of the page (issue 332): the overview of today and the tree between sessions (C83). */
export const VIEWS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'tree', label: 'Árvore' },
];
const REREAD_ACTIVE_MS = 10_000;

/** The periods of the page (issue 332, C84); the first read uses the default, the core's too. */
export const PERIODS = [
  { id: '24h', label: '24 h', text: 'as últimas 24 h' },
  { id: '7d', label: '7 dias', text: 'os últimos 7 dias' },
  { id: '30d', label: '30 dias', text: 'os últimos 30 dias' },
  { id: 'all', label: 'Tudo', text: 'todo o histórico' },
];
export const DEFAULT_PERIOD = '30d';

/** The period in the URL (`?period=7d`), when it is one the page knows. */
export function periodFromSearch(search) {
  const p = new URLSearchParams(search).get('period');
  return PERIODS.some((x) => x.id === p) ? p : DEFAULT_PERIOD;
}

/** The line under the filters: how many sessions the numbers cover, and what is never left out. */
export function coverageText(d) {
  const p = PERIODS.find((x) => x.id === d.period) ?? PERIODS[2];
  const base = d.period === 'all' ? `${num(d.sessions)} ${d.sessions === 1 ? 'sessão' : 'sessões'} no histórico` : `${num(d.sessions)} ${d.sessions === 1 ? 'sessão' : 'sessões'} em ${p.label}`;
  const outside = d.activeOutsidePeriod > 0 ? ` ${num(d.activeOutsidePeriod)} ${d.activeOutsidePeriod === 1 ? 'ativa mais velha entra' : 'ativas mais velhas entram'} assim mesmo.` : ' Nenhuma sessão ativa fica de fora.';
  return { title: base, text: `Os números e o grafo contam todas, não só as da lista.${outside}` };
}

export const FILTERS = [
  { id: 'all', rotulo: 'Todas as sessões', resumo: 'todas as sessões' },
  { id: 'active', rotulo: 'Só ativas', resumo: 'só as ativas' },
  { id: 'completed', rotulo: 'Concluídas', resumo: 'só as concluídas' },
];

// ---------- Partes puras (testadas no node) ----------

/** A rota da API para o filtro, o nó e o período escolhidos; `cursor` pede a página seguinte das árvores (issue 332). */
export function workflowsRoute(filter, node, period = DEFAULT_PERIOD, cursor = null) {
  const q = new URLSearchParams({ filter: filter });
  if (node) q.set('node', node);
  if (period !== DEFAULT_PERIOD) q.set('period', period);
  if (cursor) q.set('cursor', cursor);
  return `/api/workflows?${q}`;
}

/** As seis KPIs do C14, já escritas: `{ id, rotulo, valor, sub, icone, cor }`. `null` vira "—". */
export function writtenKpis(k) {
  return [
    { id: 'depth', rotulo: 'Profundidade', valor: decimal(k.averageDepth), sub: 'níveis de agente', icone: 'subagent', cor: 'accent' },
    { id: 'subagents', rotulo: 'Subagentes', valor: decimal(k.subagentsPerSession), sub: 'por sessão', icone: 'people', cor: 'accent' },
    { id: 'success', rotulo: 'Sucesso', valor: percent(k.subagentSuccess), sub: 'dos subagentes', icone: 'ok', cor: 'ok' },
    { id: 'flow', rotulo: 'Fluxo comum', valor: k.commonFlow?.label ?? '—', sub: k.commonFlow ? `${percent(k.commonFlow.fraction)} das sessões` : null, icone: 'repeat', cor: 'accent' },
    { id: 'rounds', rotulo: 'Rodadas', valor: decimal(k.roundsPerPr), sub: 'de review por PR', icone: 'refresh', cor: 'accent' },
    { id: 'duration', rotulo: 'Duração', valor: duration(k.averageDurationMs), sub: 'média', icone: 'timer', cor: 'wait' },
  ];
}

/** "motor-de-regras · 5 agentes · 36 ferramentas · 223 k tokens · 28 min" e, se acabou, "· ontem". */
export function runMeta(run, now = new Date()) {
  const n = run.agents.length;
  const parts = [
    run.project,
    `${num(n)} ${n === 1 ? 'agente' : 'agentes'}`,
    `${num(run.tools)} ${run.tools === 1 ? 'ferramenta' : 'ferramentas'}`,
    `${tokens(run.tokens)} tokens`,
    duration(run.durationMs),
    run.state === 'active' ? null : when(run.end ?? run.start, now),
  ];
  return parts.filter(Boolean).join(' · ');
}

const RUN_STATE = { active: ['Ativa', 'active'], completed: ['Concluída', 'completed'], error: ['Erro', 'error'] };

/** O estado de um agente do run: `[texto, cor]`. */
export function agentState(a) {
  if (a.state === 'completed') return ['Concluído', 'completed'];
  if (a.state === 'running') return ['Rodando', 'active'];
  if (a.state === 'error') return ['Erro', 'error'];
  if (a.changesRequested === null || a.changesRequested === undefined) return ['Ajustes', 'error'];
  return [`${num(a.changesRequested)} ${a.changesRequested === 1 ? 'ajuste' : 'ajustes'}`, 'error'];
}

/** Espessura de uma aresta pelo volume, entre 1,2 e 22 (a mais grossa é a de maior volume). */
export function thickness(volume, largest) {
  if (!(largest > 0)) return 1.2;
  return Math.max(1.2, Math.round((volume / largest) * 220) / 10);
}

const WIDTH = 960;
const NODE_H = 30;
const STEP = 42;
const LETTER = 5.8; // largura de um caractere do rótulo (mono, 9,5 px)

/**
 * O desenho do grafo de orquestração na `largura` do painel, em px, sem escala: as colunas, na ordem da
 * API, dividem a largura; os nós ficam empilhados no meio de cada coluna; as arestas vão em curva da
 * direita de um nó à esquerda do outro, com espessura pelo volume. O rótulo que não cabe no nó encolhe
 * com reticências (`texto`); o inteiro fica em `label`.
 */
export function orchestrationLayout(graph, width = WIDTH) {
  const columns = graph.columns;
  const n = Math.max(1, columns.length);
  const NODE_W = Math.round(Math.min(152, Math.max(104, (width - 20) / n - 18)));
  const stepX = columns.length > 1 ? (width - 20 - NODE_W) / (columns.length - 1) : 0;
  const byColumn = columns.map((c) => graph.nodes.filter((node) => node.column === c.id));
  const height = Math.max(1, ...byColumn.map((l) => l.length)) * STEP;
  const pos = new Map();
  const nodes = [];
  byColumn.forEach((list, i) => {
    const x = Math.round(10 + i * stepX);
    const k = list.length;
    const s = k > 1 ? Math.min(70, (height - NODE_H) / (k - 1)) : 0;
    const top = (height - (NODE_H + s * (k - 1))) / 2;
    list.forEach((node, j) => {
      const y = Math.round(top + j * s);
      const volume = num(node.volume);
      const fits = Math.max(4, Math.floor((NODE_W - 22 - volume.length * LETTER) / LETTER));
      pos.set(node.id, { x, y });
      nodes.push({ ...node, x, y, texto: node.label.length > fits ? `${node.label.slice(0, fits - 1)}…` : node.label, volumeEscrito: volume });
    });
  });
  const largest = Math.max(0, ...graph.edges.map((a) => a.volume));
  const edges = graph.edges
    .filter((a) => pos.has(a.from) && pos.has(a.to))
    .map((a) => {
      const A = pos.get(a.from);
      const B = pos.get(a.to);
      const x1 = A.x + NODE_W;
      const y1 = A.y + NODE_H / 2;
      const x2 = B.x;
      const y2 = B.y + NODE_H / 2;
      const m = (x1 + x2) / 2;
      return { ...a, d: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`, espessura: thickness(a.volume, largest), erro: a.to === 'outcome:error' };
    });
  return {
    largura: width,
    altura: height,
    columns: columns.map((c, i) => ({ ...c, x: Math.round(10 + i * stepX + NODE_W / 2) })),
    nodes,
    edges,
    no: { largura: NODE_W, altura: NODE_H },
  };
}

/** Há o que mudar sem aviso? Run ativo ou sessão em andamento: a tela relê de tempos em tempos. */
export function hasActive(data) {
  return data.runs.some((r) => r.state === 'active') || data.graph.nodes.some((n) => n.id === 'outcome:active' && n.volume > 0);
}

// ---------- DOM ----------

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const f of children.flat()) if (f !== null && f !== undefined && f !== false) node.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return node;
}

function loadCss() {
  if (document.querySelector('link[data-screen="workflows"]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/workflows.css', 'data-screen': 'workflows' }));
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/workflow-loop.css', 'data-screen': 'workflow-loop' }));
}

function badgeEl(text, color) {
  return el('span', { class: `badge b-${color}` }, el('span', { class: 'p' }), text);
}

function kpis(k) {
  return el(
    'div',
    { class: 'wf-kpis' },
    ...writtenKpis(k).map((c) =>
      el(
        'div',
        { class: `card wf-kpi wf-kpi-${c.id}` },
        el('span', { class: 'wf-kpi-label' }, c.rotulo),
        el('span', { class: `wf-kpi-ic wf-color-${c.cor}` }, icon(c.icone)),
        el('span', { class: 'wf-kpi-v mono' }, c.valor),
        el('span', { class: 'wf-kpi-s' }, c.sub ?? ''),
      ),
    ),
  );
}

/** The card under the filters (C84): what the numbers cover and that no active session is left out. */
function coverage(d) {
  const c = coverageText(d);
  return el('div', { class: 'card wf-coverage' }, el('span', { class: 'wf-coverage-ic' }, icon('ok')), el('div', {}, el('b', {}, `${c.title}. `), c.text));
}

function panel(title, right, ...body) {
  return el('section', { class: 'card wf-panel' }, el('div', { class: 'wf-ttl' }, ...title, el('span', { class: 'wf-ttl-r' }, right)), ...body);
}

function chip(text, extra = '') {
  return el('span', { class: `wf-chip${extra}` }, text);
}

function runRow(run, isOpen, toggleOne, ctx) {
  const [label, color] = RUN_STATE[run.state] ?? RUN_STATE.completed;
  const target = `/ui/sessions/${encodeURIComponent(run.sessionId)}`;
  const link = el('a', { class: 'wf-run-link', href: `${target}#workflow`, title: 'Abrir a sessão', 'aria-label': `Abrir a sessão de ${run.name}` }, icon('external'));
  // A moldura troca de tela pelo caminho e deixaria o `#workflow` para trás: o hash vai antes.
  link.addEventListener('click', (ev) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    history.pushState(null, '', `${target}#workflow`);
    ctx.navigate(target);
  });
  const head = el(
    'div',
    { class: 'wf-run-head' },
    el(
      'button',
      { type: 'button', class: 'wf-run-expand', 'data-run': run.id, 'aria-expanded': isOpen ? 'true' : 'false', onClick: toggleOne },
      el('span', { class: 'wf-mute' }, icon(isOpen ? 'chevron-down' : 'chevron-right')),
      el('b', {}, run.name),
      badgeEl(label, color),
      isOpen && run.model ? chip(modelName(run.model), ' wf-chip-model mono') : null,
      el('span', { class: 'wf-meta' }, runMeta(run)),
    ),
    link,
  );
  if (!isOpen) return el('div', { class: 'wf-run' }, head);

  const phases = run.phases.length
    ? el(
        'div',
        { class: 'wf-phases' },
        el('span', { class: 'wf-mute' }, icon('layers')),
        ...run.phases.flatMap((f, i) => [i ? el('span', { class: 'wf-mute' }, icon('arrow-right')) : null, chip(f.name)]),
        run.loop ? el('span', { class: 'wf-back' }, run.loop) : null,
      )
    : null;

  const table = el(
    'table',
    { class: 'wf-table' },
    el('colgroup', {}, ...['agent', 'phase', 'state', 'tokens', 'tools', 'duration'].map((c) => el('col', { class: `wf-col-${c}` }))),
    el('thead', {}, el('tr', {}, el('th', {}, 'Agente'), el('th', {}, 'Fase'), el('th', {}, 'Estado'), el('th', { class: 'wf-num' }, 'Tokens'), el('th', { class: 'wf-num' }, 'Ferramentas'), el('th', { class: 'wf-num' }, 'Duração'))),
    el(
      'tbody',
      {},
      ...run.agents.map((a) => {
        const [text, c] = agentState(a);
        return el(
          'tr',
          {},
          el('td', { title: a.type ? `${a.label} · ${a.type}` : a.label }, el('span', { class: 'mono' }, a.label), a.type ? el('span', { class: 'wf-type' }, `· ${a.type}`) : null),
          el('td', {}, a.phase ? chip(a.phase) : el('span', { class: 'wf-mute' }, '—')),
          el('td', {}, el('span', { class: `wf-pill b-${c}` }, text)),
          el('td', { class: 'wf-num mono' }, tokens(a.tokens)),
          el('td', { class: 'wf-num mono' }, num(a.tools)),
          el('td', { class: 'wf-num mono' }, duration(a.durationMs)),
        );
      }),
    ),
  );
  return el('div', { class: 'wf-run wf-run-open' }, head, phases, el('div', { class: 'wf-table-box' }, table));
}

function graphSvg(graph, width, selected, choose) {
  const g = orchestrationLayout(graph, width);
  const { largura: W, altura: H } = g.no;
  const root = svg('svg', { class: 'wf-orch', viewBox: `0 -26 ${g.largura} ${g.altura + 30}`, width: g.largura, height: g.altura + 30, role: 'group', 'aria-label': 'Grafo de orquestração' });
  for (const c of g.columns) root.append(svg('text', { class: 'wf-orch-col', x: c.x, y: -10, 'text-anchor': 'middle' }, c.label.toUpperCase()));
  for (const a of g.edges) root.append(svg('path', { class: `wf-edge${a.erro ? ' wf-edge-error' : ''}`, d: a.d, 'stroke-width': a.espessura }, svg('title', {}, `${a.volume}`)));
  for (const n of g.nodes) {
    const cls = ['wf-node', n.id === 'outcome:completed' ? 'wf-node-ok' : '', n.id === 'outcome:error' ? 'wf-node-error' : '', n.id === selected ? 'wf-node-sel' : ''].filter(Boolean).join(' ');
    const group = svg(
      'g',
      { class: cls, 'data-node': n.id, tabindex: 0, role: 'button', 'aria-pressed': n.id === selected ? 'true' : 'false', 'aria-label': `${n.label}: ${n.volume}. ${n.id === selected ? 'Limpar o filtro' : 'Filtrar a tela por este nó'}` },
      svg('title', {}, `${n.label} · ${n.id === selected ? 'clique para limpar o filtro' : 'clique para filtrar a tela'}`),
      svg('rect', { x: n.x, y: n.y, width: W, height: H, rx: 7 }),
      svg('text', { class: 'wf-node-label', x: n.x + 8, y: n.y + 19 }, n.texto),
      svg('text', { class: 'wf-node-vol', x: n.x + W - 8, y: n.y + 19, 'text-anchor': 'end' }, n.volumeEscrito),
    );
    group.addEventListener('click', () => choose(n.id));
    group.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      choose(n.id);
    });
    root.append(group);
  }
  return root;
}

// ---------- A tela ----------

export async function mount(area, ctx) {
  loadCss();
  let filter = 'all';
  let node = null;
  let data = null;
  let failure = null;
  let seq = 0;
  let timer = null;
  let wait = null;
  let view = 'overview';
  let period = periodFromSearch(location.search);
  let more = []; // the tree pages loaded after the first one ("Carregar mais")
  let nextCursor = null;
  let loadingMore = false;
  let openNodes = null; // the tree nodes that are open; `null` until the first read opens the first levels
  let expanded = null; // os runs abertos; `null` até a primeira leitura abrir o primeiro
  let focusTarget = null; // o nó que tinha o foco, para devolvê-lo depois de redesenhar

  const buttons = FILTERS.map((f) => {
    const b = el('button', { type: 'button', 'aria-pressed': f.id === filter ? 'true' : 'false' }, f.rotulo);
    b.addEventListener('click', () => {
      if (filter === f.id) return;
      filter = f.id;
      markFilter();
      read();
    });
    return b;
  });
  const markFilter = () => FILTERS.forEach((f, i) => buttons[i].setAttribute('aria-pressed', f.id === filter ? 'true' : 'false'));
  const seg = el('div', { class: 'wf-seg', role: 'group', 'aria-label': 'Quais sessões' }, ...buttons);
  const viewButtons = VIEWS.map((v) =>
    el('button', { type: 'button', 'aria-pressed': v.id === view ? 'true' : 'false', onClick: () => {
      if (view === v.id) return;
      view = v.id;
      viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', VIEWS[i].id === view ? 'true' : 'false'));
      if (data) draw();
    } }, v.label),
  );
  const periodButtons = PERIODS.map((p) =>
    el('button', { type: 'button', 'aria-pressed': p.id === period ? 'true' : 'false', onClick: () => {
      if (period === p.id) return;
      period = p.id;
      if (period === 'all') area.replaceChildren(head, loading({ label: 'Lendo todo o histórico' }));
      periodButtons.forEach((b, i) => b.setAttribute('aria-pressed', PERIODS[i].id === period ? 'true' : 'false'));
      const q = new URLSearchParams(location.search);
      period === DEFAULT_PERIOD ? q.delete('period') : q.set('period', period);
      history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
      read();
    } }, p.label),
  );
  const periodSeg = el('div', { class: 'wf-seg', role: 'group', 'aria-label': 'Período' }, ...periodButtons);
  const viewSeg = el('div', { class: 'wf-seg', role: 'group', 'aria-label': 'Como ver' }, ...viewButtons);
  const head = header({ icon: 'workflows', title: 'Workflows', sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado', actions: [viewSeg, seg, periodSeg] });

  area.replaceChildren(head, loading({ label: 'Carregando os workflows' }));

  function chooseNode(id) {
    node = node === id ? null : id;
    focusTarget = id;
    read();
  }

  const graphBox = el('div', { class: 'wf-orch-box' });
  let graphWidth = 0;
  function drawGraph() {
    const width = Math.floor(graphBox.clientWidth);
    if (!data || !graphBox.isConnected || width <= 0) return;
    graphWidth = width;
    graphBox.replaceChildren(graphSvg(data.graph, width, data.node, chooseNode));
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (Math.floor(graphBox.clientWidth) !== graphWidth) drawGraph();
  }) : null;
  observer?.observe(graphBox);

  function draw() {
    const d = data;
    // Nenhuma sessão, sem filtro nenhum: a tela inteira diz isso.
    if (!d.sessions && d.filter === 'all' && !d.node) {
      area.replaceChildren(
        ...[head, failure ? errorBand({ title: 'Não deu para atualizar.', text: failure, action: { label: 'Tentar de novo', onClick: () => read() } }) : null].filter(Boolean),
        empty(
          d.period === 'all'
            ? { icon: 'workflows', title: 'Nenhuma sessão ainda', text: 'Quando houver sessões do Claude Code nesta máquina, a orquestração dos agentes aparece aqui.' }
            : { icon: 'workflows', title: `Nada em ${PERIODS.find((x) => x.id === d.period)?.label ?? d.period}`, text: 'Nenhuma sessão se mexeu neste período e nenhuma está ativa. Escolha um período maior para ver mais.' },
        ),
      );
      return;
    }
    if (view === 'tree') {
      openNodes ??= initialOpen(d.trees.items);
      const toggle = (id) => {
        openNodes.has(id) ? openNodes.delete(id) : openNodes.add(id);
        draw();
        // The redraw replaces the button that had the focus: give it back, or the keyboard loses its place.
        [...area.querySelectorAll('.wft-toggle')].find((b) => b.getAttribute('data-node') === id)?.focus();
      };
      const onMore = nextCursor ? loadMore : null;
      area.replaceChildren(...[head, failure ? errorBand({ title: 'Não deu para atualizar.', text: failure, action: { label: 'Tentar de novo', onClick: () => read() } }) : null, coverage(d), treeKpiRow(d), treePanel(d, openNodes, toggle, { items: [...d.trees.items, ...more], nextCursor, onMore, loadingMore })].filter(Boolean));
      return;
    }
    if (expanded === null) expanded = new Set(d.runs.length ? [d.runs[0].id] : []);
    const nodeLabel = node ? (d.graph.nodes.find((n) => n.id === node)?.label ?? node) : null;
    // Com o teto de sessões lidas cortando, o subtítulo diz que são só as mais recentes.
    const summary = FILTERS.find((f) => f.id === d.filter)?.resumo ?? 'todas as sessões';

    const runs = d.runs.length
      ? d.runs.map((r) =>
          runRow(r, expanded.has(r.id), () => {
            expanded.has(r.id) ? expanded.delete(r.id) : expanded.add(r.id);
            draw();
            [...area.querySelectorAll('.wf-run-expand')].find((b) => b.getAttribute('data-run') === r.id)?.focus();
          }, ctx),
        )
      : [el('p', { class: 'wf-none' }, d.sessions ? 'Nenhum run do Workflow tool nestas sessões.' : 'Nenhuma sessão neste filtro.')];

    // O grafo é desenhado depois, na largura que o painel tem na tela (e de novo quando ela muda).
    const graph = d.graph.nodes.length
      ? graphBox
      : el(
          'div',
          { class: 'wf-none' },
          el('p', {}, 'Nenhuma sessão para desenhar.'),
          node ? el('button', { type: 'button', class: 'btn outline', onClick: () => chooseNode(node) }, 'Limpar o filtro do nó') : null,
        );

    const parts = [
      head,
      failure ? errorBand({ title: 'Não deu para atualizar.', text: failure, action: { label: 'Tentar de novo', onClick: () => read() } }) : null,
      coverage(d),
      kpis(d.kpis),
      panel([icon('workflows'), 'Workflows dinâmicos'], 'frotas do Workflow tool, lidas dos journals', el('div', { class: 'wf-runs' }, ...runs)),
      panel(
        ['Grafo de orquestração'],
        node ? `${summary} · passando por ${nodeLabel} · clique de novo para limpar` : `${summary} · clique num nó para filtrar`,
        graph,
      ),
    ];
    area.replaceChildren(...parts.filter(Boolean));
    if (d.graph.nodes.length) drawGraph();
    if (focusTarget) {
      [...area.querySelectorAll('.wf-node')].find((g) => g.getAttribute('data-node') === focusTarget)?.focus();
      focusTarget = null;
    }
  }

  async function loadMore() {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    draw();
    try {
      const r = await ctx.read(workflowsRoute(filter, node, period, nextCursor));
      more = [...more, ...r.trees.items];
      nextCursor = r.trees.nextCursor;
      for (const id of initialOpen(r.trees.items)) openNodes?.add(id);
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      failure = e.message;
    }
    loadingMore = false;
    if (data) draw();
  }

  async function read() {
    const mine = ++seq;
    clearTimeout(timer);
    try {
      const d = await ctx.read(workflowsRoute(filter, node, period));
      if (mine !== seq) return;
      data = d;
      more = [];
      nextCursor = d.trees.nextCursor;
      failure = null;
      draw();
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== seq) return;
      if (!data) area.replaceChildren(head, error({ text: e.message, retry: () => (area.replaceChildren(head, loading({ label: 'Carregando os workflows' })), read()) }));
      else {
        failure = e.message;
        draw();
      }
    }
    if (mine === seq && !ctx.signal.aborted && data && hasActive(data)) timer = setTimeout(read, REREAD_ACTIVE_MS);
  }

  ctx.onChange((changes) => {
    if (!changes.some((m) => m.type === 'session' || m.type === 'state')) return;
    clearTimeout(wait);
    wait = setTimeout(read, 400);
  });
  ctx.onRestart(() => read());

  await read();
  return () => {
    clearTimeout(timer);
    clearTimeout(wait);
    observer?.disconnect();
  };
}
