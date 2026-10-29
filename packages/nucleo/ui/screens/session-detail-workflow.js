// A aba Workflow do detalhe da sessão (#97, C7): o grafo dos agentes, com o laço dev → review →
// ajustes (`changes-requested`), e a linha do tempo dos agentes, sobre `GET /api/sessions/<id>/workflow`
// (src/api/workflows.ts).
//
// O contrato das abas do detalhe: `criar(ctx, base, { cabeca, rotular })` devolve
// `{ mostrar(corpo), esconder(), atualizar() }`. `base` é `/api/sessions/<id>`. A mudança da sessão
// chega pelo `atualizar()` do detalhe; como subagente que começa ou termina não gera mudança, enquanto
// houver agente ativo a aba relê a cada 10 s, e para quando sai de cena (`esconder()`).
//
// Tudo o que vem do núcleo entra por `textContent` (`el()` e `svg()`), nunca como HTML.

import { el, icon } from '../dom.js';
import { loading, error, errorBand } from '../states.js';
import { duration, modelName, num } from './workflow-format.js';
import { lineageStrip, loopPanel } from './workflow-loop.js';

const SVG = 'http://www.w3.org/2000/svg';
const REREAD_ACTIVE_MS = 10_000;
const DEC = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

// ---------- Partes puras (testadas no node) ----------

/**
 * Colunas pelas dependências e linhas para os ramos. A coluna de um nó é o maior caminho até ele
 * pelas arestas (quem abriu ou entregou vem antes). O ramo mais longo segue na linha do pai; os
 * outros filhos ocupam a linha livre mais perto, primeiro abaixo, depois acima.
 * Devolve `{ colunas, linhas, pos: { [id]: { coluna, linha } } }`.
 */
export function graphLayout(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const exists = new Set(ids);
  const valid = edges.filter((a) => exists.has(a.from) && exists.has(a.to) && a.from !== a.to);
  const children = new Map(ids.map((i) => [i, []]));
  const country = new Map(ids.map((i) => [i, []]));
  for (const a of valid) {
    if (!children.get(a.from).includes(a.to)) children.get(a.from).push(a.to);
    if (!country.get(a.to).includes(a.from)) country.get(a.to).push(a.from);
  }

  // Profundidade: o maior caminho desde uma raiz (Kahn). Num ciclo, o nó fica depois dos pais já vistos.
  const depth = new Map();
  const degree = new Map(ids.map((i) => [i, country.get(i).length]));
  const queue = ids.filter((i) => degree.get(i) === 0);
  for (const i of queue) depth.set(i, 0);
  while (queue.length) {
    const i = queue.shift();
    for (const f of children.get(i)) {
      depth.set(f, Math.max(depth.get(f) ?? 0, depth.get(i) + 1));
      degree.set(f, degree.get(f) - 1);
      if (degree.get(f) === 0) queue.push(f);
    }
  }
  for (const i of ids) {
    if (depth.has(i)) continue;
    const seen = country.get(i).filter((p) => depth.has(p));
    depth.set(i, seen.length ? Math.max(...seen.map((p) => depth.get(p))) + 1 : 0);
  }

  // Quem põe cada nó na tela: o primeiro pai da coluna anterior (ou o primeiro pai).
  const owner = new Map();
  for (const i of ids) {
    const ps = country.get(i);
    const p = ps.find((x) => depth.get(x) === depth.get(i) - 1) ?? ps.find((x) => depth.get(x) < depth.get(i));
    if (p !== undefined) owner.set(i, p);
  }
  const below = new Map(ids.map((i) => [i, []]));
  for (const i of ids) if (owner.has(i)) below.get(owner.get(i)).push(i);

  // Altura do ramo: quantas colunas ele ainda anda.
  const alt = new Map();
  const height = (i, stack = new Set()) => {
    if (alt.has(i)) return alt.get(i);
    if (stack.has(i)) return 0;
    stack.add(i);
    const h = 1 + Math.max(0, ...below.get(i).map((f) => height(f, stack)));
    stack.delete(i);
    alt.set(i, h);
    return h;
  };

  const busy = new Map();
  const free = (column, wanted) => {
    const used = busy.get(column) ?? new Set();
    for (let d = 0; ; d++) {
      for (const l of d === 0 ? [wanted] : [wanted + d, wanted - d]) if (!used.has(l)) return l;
    }
  };
  const pos = {};
  const by = (i, wanted) => {
    if (pos[i]) return;
    const column = depth.get(i);
    const row = free(column, wanted);
    if (!busy.has(column)) busy.set(column, new Set());
    busy.get(column).add(row);
    pos[i] = { coluna: column, linha: row };
    const order = [...below.get(i)].sort((a, b) => height(b) - height(a));
    for (const f of order) by(f, row);
  };
  for (const i of ids) if (!owner.has(i)) by(i, 0);
  for (const i of ids) by(i, 0);

  const rows = Object.values(pos).map((p) => p.linha);
  const smallest = rows.length ? Math.min(...rows) : 0;
  for (const p of Object.values(pos)) p.linha -= smallest;
  return {
    colunas: ids.length ? Math.max(...Object.values(pos).map((p) => p.coluna)) + 1 : 0,
    linhas: rows.length ? Math.max(...rows) - smallest + 1 : 0,
    pos,
  };
}

/** Minutos para o eixo: inteiros a partir de 4 min, uma casa abaixo disso. */
function minutes(ms, total) {
  const m = ms / 60_000;
  return total >= 4 * 60_000 ? String(Math.round(m)) : DEC.format(m);
}

/**
 * A escala da linha do tempo, de `start` a `end` da sessão: `fracao(iso)` de 0 a 1, as marcas do
 * eixo (0, ¼, ½, ¾ e o fim, em min) e o resumo "0 a 28 min".
 */
export function timelineScale({ start, end }) {
  const a = Date.parse(start);
  const total = Math.max(1, Date.parse(end) - a);
  const fraction = (iso) => (iso === null || iso === undefined ? 1 : Math.min(1, Math.max(0, (Date.parse(iso) - a) / total)));
  const marks = [0, 0.25, 0.5, 0.75, 1].map((k) => (k === 0 ? '0' : `${minutes(k * total, total)} min`));
  return { total, fracao: fraction, marcas: marks, resumo: `0 a ${minutes(total, total)} min` };
}

/** Os trechos de uma faixa em porcentagem da sessão: `{ x, largura, state }`. Trecho aberto vai até o fim. */
export function bandSegments(lane, scale) {
  return lane.spans.map((t) => {
    const x = scale.fracao(t.start);
    const f = scale.fracao(t.end);
    return { x: Math.round(x * 10000) / 100, largura: Math.max(0.4, Math.round((f - x) * 10000) / 100), state: t.state };
  });
}

/** O nome do nó com a rodada: "dev · r1". */
export const nodeName = (n) => (n.round ? `${n.name} · r${n.round}` : n.name);

/** A segunda linha do nó: "3 ajustes pedidos" no review que pediu; senão a tarefa (ou o modelo) e o tempo. */
export function nodeDetail(n) {
  if (n.changesRequested > 0) return { texto: `${num(n.changesRequested)} ${n.changesRequested === 1 ? 'ajuste pedido' : 'ajustes pedidos'}`, ajustes: true };
  const who = n.task ?? (n.model ? modelName(n.model) : null);
  return { texto: [who, duration(n.durationMs)].filter(Boolean).join(' · '), ajustes: false };
}

const STATE_LABEL = { active: 'Ativa', completed: 'Concluída', error: 'Erro' };
// The class of each node state is its API value: `wfd-e-<state>`.
const stateClass = (state) => `wfd-e-${state}`;

// ---------- DOM ----------

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const f of children.flat()) if (f !== null && f !== undefined && f !== false) node.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return node;
}

const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function loadCss() {
  if (document.querySelector('link[data-screen="session-detail-workflow"]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/session-detail-workflow.css', 'data-screen': 'session-detail-workflow' }));
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/workflow-loop.css', 'data-screen': 'workflow-loop' }));
}

// As medidas do C7 (6 colunas em ~980 px): o SVG encolhe para caber no painel, o texto junto.
const NODE_W = 128;
const NODE_H = 64;
const STEP_X = 168;
const STEP_Y = 96;
const MARGIN = 4;

function graph(w) {
  const lay = graphLayout(w.nodes, w.edges);
  const width = MARGIN * 2 + (lay.colunas - 1) * STEP_X + NODE_W;
  const height = MARGIN * 2 + (lay.linhas - 1) * STEP_Y + NODE_H;
  const xy = (id) => ({ x: MARGIN + lay.pos[id].coluna * STEP_X, y: MARGIN + lay.pos[id].linha * STEP_Y });
  const root = svg('svg', { class: width > 720 ? 'wfd-graph wfd-wide' : 'wfd-graph', viewBox: `0 0 ${width} ${height}`, width: width, height: height, role: 'img', 'aria-label': 'Grafo dos agentes da sessão' });
  const arrow = (id, cls) => svg('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, svg('path', { d: 'M0,0 L8,4 L0,8 Z', class: cls }));
  root.append(svg('defs', {}, arrow('wfd-arrow', 'wfd-tip'), arrow('wfd-arrow-adj', 'wfd-tip wfd-adj')));

  for (const a of w.edges) {
    if (!lay.pos[a.from] || !lay.pos[a.to]) continue;
    const A = xy(a.from);
    const B = xy(a.to);
    const x1 = A.x + NODE_W;
    const y1 = A.y + NODE_H / 2;
    const x2 = B.x - 3;
    const y2 = B.y + NODE_H / 2;
    const m = (x1 + x2) / 2;
    const adj = a.type === 'changes-requested';
    root.append(svg('path', { class: `wfd-edge${adj ? ' wfd-adj' : ''}`, d: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`, 'marker-end': `url(#${adj ? 'wfd-arrow-adj' : 'wfd-arrow'})` }));
    if (a.label) root.append(svg('text', { class: `wfd-label${adj ? ' wfd-adj' : ''}`, x: m, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle' }, a.label));
  }

  for (const n of w.nodes) {
    if (!lay.pos[n.id]) continue;
    const { x, y } = xy(n.id);
    const detail = nodeDetail(n);
    const state = STATE_LABEL[n.state] ?? n.state;
    root.append(
      svg(
        'g',
        { class: `wfd-node ${stateClass(n.state)}` },
        svg('title', {}, [nodeName(n), n.task, duration(n.durationMs), state].filter(Boolean).join(' · ')),
        svg('rect', { class: 'wfd-box', x, y, width: NODE_W, height: NODE_H, rx: 8 }),
        svg('rect', { class: 'wfd-border', x, y: y + 1, width: 3, height: NODE_H - 2, rx: 1.5 }),
        svg('text', { class: 'wfd-node-name', x: x + 11, y: y + 19 }, short(nodeName(n), 18)),
        svg('text', { class: `wfd-node-detail${detail.ajustes ? ' wfd-adj' : ''}`, x: x + 11, y: y + 36 }, short(detail.texto, 20)),
        n.state === 'active' ? svg('circle', { class: 'wfd-node-dot', cx: x + 15, cy: y + 49, r: 3.5 }) : null,
        svg('text', { class: 'wfd-node-state', x: x + (n.state === 'active' ? 22 : 11), y: y + 53 }, n.state === 'completed' ? `✓ ${state}` : n.state === 'error' ? `✕ ${state}` : state),
      ),
    );
  }
  return el('div', { class: 'wfd-scroll' }, root);
}

function legend(w) {
  const dashed = svg('svg', { class: 'wfd-dashed', viewBox: '0 0 18 4', width: 18, height: 4, 'aria-hidden': 'true' }, svg('line', { x1: 0, y1: 2, x2: 18, y2: 2 }));
  return el(
    'div',
    { class: 'wfd-legend' },
    el('span', {}, el('i', { class: 'wfd-ball wfd-e-active' }), 'Ativo'),
    el('span', {}, el('i', { class: 'wfd-ball wfd-e-completed' }), 'Concluído'),
    el('span', {}, dashed, 'review pediu ajustes: volta para o dev'),
    el('span', {}, 'Rodadas de review ', el('b', { class: 'mono' }, num(w.reviewRounds))),
    el('span', {}, 'Ajustes ', el('b', { class: 'mono' }, num(w.changesRequested))),
  );
}

function timeline(w) {
  const scale = timelineScale(w.timeline);
  const bands = w.timeline.lanes.map((f) =>
    el(
      'div',
      { class: 'wfd-band' },
      el('span', { class: 'mono wfd-name', title: f.label }, f.label),
      svg(
        'svg',
        { class: 'wfd-lane', width: '100%', height: 16, 'aria-hidden': 'true' },
        svg('rect', { class: 'wfd-bg', x: 0, y: 0, width: '100%', height: 16, rx: 4 }),
        ...bandSegments(f, scale).map((t) => svg('rect', { class: `wfd-segment ${stateClass(t.state)}`, x: `${t.x}%`, y: 2, width: `${t.largura}%`, height: 12, rx: 3 })),
      ),
    ),
  );
  const axis = el('div', { class: 'wfd-band wfd-axis mono' }, el('span', {}), el('div', {}, ...scale.marcas.map((m) => el('span', {}, m))));
  return el(
    'section',
    { class: 'card wfd-panel' },
    el('div', { class: 'wfd-ttl' }, icon('gantt'), 'Linha do tempo dos agentes', el('span', { class: 'wfd-ttl-r' }, `${scale.resumo} · concorrência`)),
    ...bands,
    axis,
  );
}

const VIEWS = [['by-pr', 'Por PR'], ['nodes', 'Todos os nós']];

/** The toggle between the loop by PR (the default, C81) and the graph of every node (C7). */
function viewToggle(view, setView, hasLoop = true) {
  // Without the loop in the answer (an older core) there is only the graph: the toggle has nothing to offer.
  if (!hasLoop) return null;
  const buttons = VIEWS.map(([id, label]) => el('button', { type: 'button', 'data-view': id, 'aria-pressed': id === view ? 'true' : 'false', onClick: () => id !== view && setView(id) }, label));
  return el('div', { class: 'wfd-views', role: 'group', 'aria-label': 'Como ver o fluxo' }, ...buttons);
}

function drawing(w, view = 'by-pr', setView = () => {}) {
  const toggle = viewToggle(view, setView, Boolean(w.loop));
  const strip = lineageStrip(w.lineage);
  if (view === 'by-pr' && w.loop) return [strip, loopPanel(w, toggle)].filter(Boolean);
  return [
    strip,
    el(
      'section',
      { class: 'card wfd-panel' },
      el('div', { class: 'wfd-ttl' }, icon('subagent'), 'Grafo de agentes', el('span', { class: 'wfd-ttl-r' }, w.summary ?? ''), toggle),
      graph(w),
      legend(w),
    ),
    timeline(w),
  ].filter(Boolean);
}

// ---------- A aba ----------

export function create(ctx, base) {
  let target = null;
  let data = null;
  let seq = 0;
  let timer = null;
  // The loop by PR is the view that opens (decision of the wireframe, issue 332); the choice lasts while the tab lives.
  let view = 'by-pr';
  const setView = (v) => {
    view = v;
    if (target && data) {
      target.replaceChildren(...drawing(data, view, setView));
      // The redraw replaces the clicked button: give the focus back to the same choice.
      [...target.querySelectorAll('.wfd-views button')].find((b) => b.getAttribute('data-view') === v)?.focus();
    }
  };
  ctx.signal?.addEventListener('abort', () => clearTimeout(timer));

  async function draw() {
    const mine = ++seq;
    clearTimeout(timer);
    if (!target) return;
    loadCss();
    try {
      const w = await ctx.read(`${base}/workflow`);
      if (mine !== seq || !target) return;
      data = w;
      target.replaceChildren(...drawing(w, view, setView));
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== seq || !target) return;
      if (data) target.replaceChildren(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: () => draw() } }), ...drawing(data, view, setView));
      else target.replaceChildren(error({ title: e.status === 404 ? 'Sessão não encontrada' : 'Não deu para ler o workflow', text: e.message, retry: () => (target?.replaceChildren(loading({ label: 'Carregando', blocks: 2 })), draw()) }));
    }
    if (mine === seq && target && !ctx.signal?.aborted && data?.nodes.some((n) => n.state === 'active')) timer = setTimeout(draw, REREAD_ACTIVE_MS);
  }

  return {
    show(body) {
      target = body;
      return draw();
    },
    hide() {
      target = null;
      seq++;
      clearTimeout(timer);
    },
    refresh: () => draw(),
  };
}
