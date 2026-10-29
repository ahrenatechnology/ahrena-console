// Mural ao vivo (C2, #34): um card por sessão aberta nesta máquina, do mesmo tamanho, três por linha.
// Lê `GET /api/wall`, que já vem ordenado pelo núcleo (issue 245: blocked, idle, then the rest); the
// selector Todas / Precisam de você / Ociosas / Ativas filters on the client, without a new request. Ao vivo: qualquer mudança relê o mural (com uma pequena espera, para
// juntar a rajada); `aoReiniciar` relê na hora.
//
// As barras são `<progress>`: a largura sai do `value`, sem estilo inline (a CSP bloqueia).
// As funções sem DOM (formatação e o que cada card mostra) saem exportadas para o teste.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { attentionOf, attentionPill, attentionTone, isBlocked, isIdle, reasonChip, statusWithoutAttention } from '../attention.js';
import { openAction } from '../open-action.js';
import { createMachineFilter, itemHref, itemKey, machineTag, sinceText, whereText } from '../machine-filter.js';

const STYLE = '/ui/wall.css';
export const WALL_ROUTE = '/api/wall';
/** Releitura depois de uma rajada de mudanças. */
export const DEBOUNCE_MS = 400;
/** Contexto a partir daqui pinta a barra com a cor de erro. */
export const HIGH_CONTEXT = 80;

/** C85: the "Paradas" band shows this many rows at first; "Mostrar mais" asks for all of them (the core stops at 100). */
export const PARKED_PAGE = 7;
export const PARKED_MAX = 100;

export const STATUS_LABEL = { active: 'Ativa', completed: 'Concluída', error: 'Com erro', abandoned: 'Abandonada' };
const EFFORTS = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo' };

// The same groups as the core's `count` (issue 245): blocked (errors included), idle, active.
export const FILTERS = [
  { id: 'all', rotulo: 'Todas', passa: () => true, vazio: 'Nenhuma sessão aberta' },
  { id: 'blocked', rotulo: 'Precisam de você', count: 'blocked', passa: (c) => isBlocked(c.attention), vazio: 'Ninguém precisa de você agora' },
  { id: 'idle', rotulo: 'Ociosas', count: 'idle', passa: (c) => isIdle(c.attention), vazio: 'Nenhuma sessão ociosa' },
  { id: 'active', rotulo: 'Ativas', passa: (c) => !attentionOf(c.attention) && ['active', 'delegating', 'background'].includes(c.state), vazio: 'Nenhuma sessão ativa' },
];

/** The selector label: "Precisam de você · 5" with the core's count; without it, the label alone. */
export function filterLabel(filter, count) {
  const n = filter.count ? count?.[filter.count] : undefined;
  return Number.isInteger(n) ? `${filter.rotulo} · ${n}` : filter.rotulo;
}

// ---------- Formatação ----------

const dollar = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Em dólar, como no wireframe ("~1,84"), sempre com "~": é estimativa. `null` (uso sem preço) é traço. */
export const cost = (usd) => (usd === null || usd === undefined ? '—' : `~${dollar.format(usd)}`);

/** Só a família: "claude-opus-5-5" → "Opus"; "Sonnet 5.5" → "Sonnet"; sem modelo, traço. */
export function modelName(id) {
  const text = String(id ?? '').trim();
  if (!text) return '—';
  const family = /(opus|sonnet|haiku|fable)/i.exec(text);
  const word = family ? family[1].toLowerCase() : text.split(/\s+/)[0];
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

/** "high" → "alto"; o que não reconhece sai como veio; sem esforço, traço. */
export const effort = (e) => (e ? (EFFORTS[e] ?? e) : '—');

const limit = (n) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * O que o card mostra, sem DOM. Plano `null` é "Plano 0/0" com a barra vazia (o wireframe desenha
 * assim a sessão sem plano); contexto `null` é "contexto —" com a barra vazia.
 */
export function cardContent(c) {
  const plan = c.plan ?? { done: 0, total: 0 };
  const pct = c.context ? limit(c.context.pct) : null;
  let row;
  const attention = attentionOf(c.attention);
  if (attention && attention.reason !== 'error') row = { tipo: 'pede', attention, texto: c.activity?.text ?? '' };
  else if (c.status === 'error') row = { tipo: 'erro', texto: c.activity?.text ?? '' };
  else if (c.status === 'completed') row = { tipo: 'concluida', texto: 'Terminou sem erro' };
  else if (c.status === 'abandoned') row = { tipo: 'parada', texto: c.activity?.text ?? '' };
  else row = { tipo: 'fazendo', texto: c.activity?.text ?? '' };
  return {
    id: c.id,
    // Issue 243: two machines can have the same id; a remote card opens its Detail with `?machine=`.
    key: itemKey(c),
    machine: c.machine ?? null,
    href: itemHref(c),
    open: c.open ?? null,
    status: c.status,
    attention,
    tone: attentionTone(attention) ?? statusWithoutAttention(c.status),
    title: c.title,
    origem: [c.project, c.branch].filter(Boolean).join(' · ') || '—',
    linha: row,
    grade: [
      ['Modelo', modelName(c.model)],
      ['Esforço', effort(c.effort)],
      ['Agentes', String(c.agents?.total ?? 0)],
      ['Custo', cost(c.cost?.usd)],
    ],
    agents: c.agents ?? { active: 0, total: 0 },
    plan: { done: plan.done, total: plan.total, label: `Plano ${plan.done}/${plan.total}`, current: c.plan?.current ?? null },
    context: { pct, label: pct === null ? 'contexto —' : `contexto ${pct}%`, high: pct !== null && pct >= HIGH_CONTEXT },
  };
}

// ---------- The nested children and the "Paradas" band (C85 to C87, issue 333) ----------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The line under a leader's card: "4 filhas", "1 precisa de você", "2 ativas", "1 parada", the counts of its
 * whole tree, without the zeros. `null` when the card has no children.
 */
export function treeSummary(tree) {
  if (!tree || !(tree.total > 0)) return null;
  return [
    { text: plural(tree.total, 'filha', 'filhas'), tone: 'total' },
    tree.blocked ? { text: tree.blocked === 1 ? '1 precisa de você' : `${tree.blocked} precisam de você`, tone: 'blocked' } : null,
    tree.active ? { text: plural(tree.active, 'ativa', 'ativas'), tone: 'active' } : null,
    tree.parked ? { text: plural(tree.parked, 'parada', 'paradas'), tone: 'parked' } : null,
  ].filter(Boolean);
}

/** What a nested child shows, without DOM: the title, the pill's input and how long ago its state began. */
export function childContent(node, now = Date.now()) {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    attention: attentionOf(node.attention),
    since: sinceText(node.since, now),
    parked: Boolean(node.parked),
    children: node.children ?? [],
  };
}

/** The band: "Paradas (23)", and how many rows "Mostrar mais" would add; `null` without any. */
export function parkedContent(parked) {
  const total = parked?.total ?? 0;
  if (!(total > 0)) return null;
  const shown = parked.items?.length ?? 0;
  return { title: `Paradas (${total})`, shown, total, more: Math.max(0, Math.min(total, PARKED_MAX) - shown) };
}

// ---------- Peças ----------

function useStyle() {
  if (document.querySelector(`link[href="${STYLE}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLE }));
}

/** The pill: the attention (Precisa de você, Ociosa, Com erro) or the status. */
function badge(v) {
  if (v.attention) return attentionPill(v.attention, { extraClass: 'wall-pill' });
  const st = statusWithoutAttention(v.status);
  return el('span', { class: `wall-badge wall-pill wall-b-${st}` }, el('span', { class: 'p' }), STATUS_LABEL[st] ?? '');
}

function cardRow(l) {
  if (l.tipo === 'pede') return el('div', { class: 'wall-row' }, reasonChip(l.attention), el('span', { class: 'wall-trunc wall-muted' }, l.texto));
  if (l.tipo === 'erro') return el('div', { class: 'wall-row wall-error' }, icon('error'), el('span', { class: 'wall-trunc' }, l.texto));
  if (l.tipo === 'concluida') return el('div', { class: 'wall-row wall-completed' }, icon('wall-check'), el('span', { class: 'wall-trunc' }, l.texto));
  if (l.tipo === 'parada') return el('div', { class: 'wall-row wall-muted' }, el('span', { class: 'wall-trunc' }, l.texto));
  return el('div', { class: 'wall-row wall-muted' }, icon('wall-loader'), el('span', { class: 'wall-trunc' }, l.texto));
}

/** A barra: `<progress>` estilizado, a largura vem do `value`. */
function bar({ valor: value, max, rotulo: label, alto: high = false, tipo: type }) {
  return el('progress', { class: `wall-bar${high ? ' wall-high' : ''}`, 'data-bar': type, max: max > 0 ? max : 1, value: max > 0 ? Math.min(value, max) : 0, 'aria-label': label });
}

/**
 * A card: the title is the link to the Detail and stretches over the whole card (`wall-link`), so the
 * card stays clickable without wrapping the foot's button in an `<a>` (C71, issue 285).
 * Returns the card and its link (the one the keyboard focus goes back to).
 */
function card(c, write, nest) {
  const v = cardContent(c);
  const summary = treeSummary(c.tree);
  const opened = Boolean(summary) && nest.isOpen(c.id);
  const parentTitle = c.parentId ? nest.titleOf(c.parentId) : null;
  const link = el('a', { class: 'wall-tt wall-trunc wall-link', href: v.href, title: v.title, 'data-session': v.id, 'data-key': v.key }, v.title);
  // C46: a remote card's tag shares the project line; the project truncates, never the tag.
  const tag = machineTag(v);
  const node = el(
    'div',
    { class: `card wall-card wall-st-${v.tone}${summary ? ' wall-lead' : ''}${opened ? ' wall-span' : ''}`, 'data-session': v.id, 'data-key': v.key },
    el('div', { class: 'wall-l1' }, link, badge(v)),
    tag ? el('div', { class: 'wall-prj mf-with-tag' }, el('span', { class: 'mf-shrink' }, v.origem), tag) : el('div', { class: 'wall-prj wall-trunc' }, v.origem, parentTitle ? el('span', { class: 'wall-from', title: `Aberta por ${parentTitle}` }, `filha de ${parentTitle}`) : null),
    cardRow(v.linha),
    el(
      'div',
      { class: 'wall-gr' },
      ...v.grade.map(([label, value]) =>
        el('div', label === 'Agentes' ? { title: `${v.agents.active} ativos de ${v.agents.total}` } : label === 'Custo' ? { title: value === '—' ? 'Sem preço para o modelo' : `US$ ${value.slice(1)}, estimado` } : {}, label, el('b', { class: 'wall-trunc' }, value)),
      ),
    ),
    el('div', { class: 'wall-planrow' }, el('span', { title: v.plan.current ?? null }, v.plan.label), el('span', {}, v.context.label)),
    el(
      'div',
      { class: 'wall-bars' },
      bar({ tipo: 'plan', valor: v.plan.done, max: v.plan.total, rotulo: `Plano: ${v.plan.done} de ${v.plan.total}` }),
      bar({ tipo: 'context', valor: v.context.pct ?? 0, max: 100, alto: v.context.high, rotulo: v.context.pct === null ? 'Contexto: sem leitura' : `Contexto: ${v.context.pct}%` }),
    ),
    summary ? treeLine(c, summary, opened, nest) : null,
    opened ? el('div', { class: 'wall-kids' }, ...kidRows(c.children, 0, c, nest)) : null,
    foot(v, write),
  );
  return { node, link };
}

/** The toggle under a leader's card (C85): the counts of its whole tree; it opens the children in place (C86). */
function treeLine(c, summary, opened, nest) {
  return el(
    'button',
    { type: 'button', class: 'wall-treeline', 'data-tree': c.id, 'aria-expanded': opened ? 'true' : 'false', onClick: () => nest.toggle(c.id) },
    icon(opened ? 'chevron-down' : 'chevron-right'),
    ...summary.flatMap((part, i) => [i ? el('span', { class: 'wall-muted' }, '·') : null, el('span', { class: `wall-tree-${part.tone}` }, part.text)].filter(Boolean)),
  );
}

/** One row per nested child, one level inside the other; a child with children opens recolhida. */
function kidRows(nodes, depth, leader, nest) {
  return nodes.flatMap((node) => {
    const k = childContent(node);
    const hasKids = k.children.length > 0;
    const opened = hasKids && nest.isOpen(k.id);
    const pill = k.attention ? attentionPill(k.attention, { extraClass: 'wall-pill' }) : el('span', { class: `wall-badge wall-pill wall-b-${statusWithoutAttention(k.status)}` }, el('span', { class: 'p' }), STATUS_LABEL[statusWithoutAttention(k.status)] ?? '');
    const row = el(
      'div',
      { class: `wall-kid wall-depth-${Math.min(depth, 6)}${k.parked ? ' wall-kid-parked' : ''}`, 'data-child': k.id },
      hasKids ? el('button', { type: 'button', class: 'wall-kid-toggle', 'aria-expanded': opened ? 'true' : 'false', 'aria-label': opened ? 'Recolher' : 'Abrir as filhas', onClick: () => nest.toggle(k.id) }, icon(opened ? 'chevron-down' : 'chevron-right')) : el('span', { class: 'wall-kid-toggle' }),
      el('a', { class: 'wall-trunc wall-kid-title', href: itemHref({ id: k.id, machine: leader.machine }), title: k.title }, k.title),
      pill,
      k.parked ? el('span', { class: 'wall-muted' }, 'parada') : null,
      el('span', { class: 'wall-muted wall-kid-age' }, k.since),
    );
    return [row, ...(opened ? kidRows(k.children, depth + 1, leader, nest) : [])];
  });
}

/** The "Paradas" band (C85, C86): recolhida with the counter; opened, the most recent rows and "Mostrar mais". */
function parkedBand(parked, opened, { toggle, more }) {
  const p = parkedContent(parked);
  if (!p) return null;
  const head = el(
    'button',
    { type: 'button', class: 'wall-parked-head', 'data-parked': 'toggle', 'aria-expanded': opened ? 'true' : 'false', onClick: toggle },
    icon(opened ? 'chevron-down' : 'chevron-right'),
    el('b', {}, p.title),
    el('span', { class: 'wall-muted wall-trunc' }, 'sem atividade há mais de 180 min e sem pedir nada a você'),
    el('span', { class: 'wall-muted wall-parked-r' }, opened ? `Mostrando ${p.shown} de ${p.total} · as mais recentes` : 'Recolhida'),
  );
  const rows = !opened
    ? []
    : parked.items.map((c) => {
        const v = cardContent(c);
        return el(
          'div',
          { class: 'wall-kid', 'data-parked-row': v.id },
          el('a', { class: 'wall-trunc wall-kid-title', href: v.href, title: v.title }, v.title),
          el('span', { class: 'wall-prj wall-trunc' }, v.origem),
          el('span', { class: 'wall-chip' }, v.linha.texto || (v.attention ? 'Sua vez' : '—')),
          el('span', { class: 'wall-muted wall-kid-age' }, sinceText(c.since)),
          el('a', { class: 'btn', href: v.href }, 'Abrir'),
        );
      });
  const moreButton = opened && p.more > 0 ? el('button', { type: 'button', class: 'btn', 'data-parked': 'more', onClick: more }, `Mostrar mais ${p.more}`) : null;
  return el('div', { class: 'card wall-parked' }, head, ...(opened ? [el('div', { class: 'wall-parked-list' }, ...rows, moreButton)] : []));
}

/**
 * The foot (C71): the open action with its label and "Detalhe ›". Every card links to the Detail, as
 * it did before issue 285 (the whole card was the link), so a remote one keeps "Detalhe ›" too.
 */
function foot(v, write) {
  const action = openAction({ id: v.id, open: v.open, machine: v.machine }, { size: 'small', write, machine: v.machine?.label ?? null });
  return el('div', { class: 'wall-foot' }, action, el('a', { class: 'wall-detail', href: v.href, tabindex: '-1' }, 'Detalhe ›'));
}

// ---------- A tela ----------

export async function mount(area, ctx) {
  useStyle();
  let filter = 'all';
  let wall = null;
  let failure = null;
  let request = 0;
  let wait = null;
  // C86: what is open (a leader or a child with children) and whether the band is, kept while the page lives.
  const opened = new Set();
  let parkedOpen = false;
  let parkedLimit = PARKED_PAGE;

  // The selector with the core's `count` on "Precisam de você" and "Ociosas" (C2, issue 245).
  const buttons = new Map();
  const selector = el(
    'div',
    { class: 'wall-seg', role: 'group', 'aria-label': 'Filtrar sessões' },
    ...FILTERS.map((f) => {
      const b = el('button', { type: 'button', 'data-filter': f.id, 'aria-pressed': f.id === filter ? 'true' : 'false', onClick: () => choose(f.id) }, f.rotulo);
      buttons.set(f.id, b);
      return b;
    }),
  );
  const refresh = el('button', { type: 'button', class: 'btn', 'data-action': 'refresh', onClick: () => read() }, icon('refresh'), 'Atualizar');
  const head = header({ icon: 'wall', title: 'Mural ao vivo', sub: 'Um card por sessão aberta nesta máquina', actions: [selector, refresh] });
  const sub = head.querySelector?.('.sub') ?? null;
  // Issue 243 (C46): the machine filter on its own row under the header.
  const machines = createMachineFilter(ctx, { onChange: () => ((wall = null), draw(), read()), reread: () => read(), onLayout: () => draw() });

  function choose(id) {
    filter = id;
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
    draw();
  }

  function draw() {
    if (!wall) {
      area.replaceChildren(head, ...machines.parts(), failure ? error({ text: failure.message, retry: () => read() }) : loading({ label: 'Lendo o mural' }));
      return;
    }
    for (const f of FILTERS) buttons.get(f.id).replaceChildren(filterLabel(f, wall.count));
    const f = FILTERS.find((x) => x.id === filter);
    const cards = (wall.cards ?? []).filter(f.passa);
    const band = failure ? errorBand({ title: 'O mural não atualizou.', text: failure.message, action: { label: 'Tentar de novo', onClick: () => read() } }) : null;
    const nest = {
      isOpen: (id) => opened.has(id),
      toggle: (id) => (opened.has(id) ? opened.delete(id) : opened.add(id), draw()),
      titleOf: (id) => (wall.cards ?? []).find((x) => x.id === id)?.title ?? null,
    };
    const built = cards.map((c) => card(c, ctx.write, nest));
    const nodes = built.map((b) => b.node);
    // The keyboard lands on the card's link (the title stretched over the card).
    const links = built.map((b) => b.link);
    const body = cards.length
      ? el('div', { class: 'wall-grid' }, ...nodes)
      : machines.chosenDown()
        ? null
        : empty({ icon: 'wall', title: f.vazio, text: filter === 'all' ? `Abra uma sessão do Claude Code ${machines.hasRemotes() ? whereText(machines.choice, machines.machines(), { form: 'any' }) : 'nesta máquina'} e ela aparece aqui.` : 'Troque o filtro para ver as outras.' });
    // Redesenhar troca os cards: o foco do teclado volta ao card da mesma sessão.
    // Issue 243: by machine + id (`data-key`), since two machines can have the same session id.
    const holder = globalThis.document?.activeElement?.closest?.('[data-session]') ?? null;
    const focused = holder ? (holder.getAttribute('data-key') ?? holder.getAttribute('data-session')) : null;
    if (sub) sub.textContent = machines.hasRemotes() ? `Um card por sessão aberta, ${whereText(machines.choice, machines.machines())}` : 'Um card por sessão aberta nesta máquina';
    // The band is part of "Todas": the other filters are about the cards.
    const parked = filter === 'all' ? parkedBand(wall.parked, parkedOpen, { toggle: () => ((parkedOpen = !parkedOpen), draw()), more: () => ((parkedLimit = PARKED_MAX), read()) }) : null;
    area.replaceChildren(...[head, ...machines.parts(), band, body, parked].filter(Boolean));
    if (focused) links.find((n) => n.getAttribute('data-key') === focused)?.focus();
  }

  async function read() {
    const mine = ++request;
    try {
      const route = machines.route(WALL_ROUTE);
      const fresh = await ctx.read(parkedLimit === PARKED_PAGE ? route : `${route}${route.includes('?') ? '&' : '?'}parkedLimit=${parkedLimit}`);
      if (mine !== request) return;
      machines.update(fresh);
      wall = fresh;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== request) return;
      if (machines.recover(e)) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  ctx.onRestart(() => read());
  // Junta a rajada, mas com teto: com atividade contínua, relê no máximo a cada ESPERA_MS.
  ctx.onChange(() => {
    wait ??= setTimeout(() => {
      wait = null;
      read();
    }, DEBOUNCE_MS);
  });

  draw();
  await read();
  return () => clearTimeout(wait);
}
