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

const STYLE = '/ui/wall.css';
export const WALL_ROUTE = '/api/wall';
/** Releitura depois de uma rajada de mudanças. */
export const DEBOUNCE_MS = 400;
/** Contexto a partir daqui pinta a barra com a cor de erro. */
export const HIGH_CONTEXT = 80;

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
    href: `/ui/sessions/${encodeURIComponent(c.id)}`,
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
function card(c, write) {
  const v = cardContent(c);
  const link = el('a', { class: 'wall-tt wall-trunc wall-link', href: v.href, title: v.title, 'data-session': v.id }, v.title);
  const node = el(
    'div',
    { class: `card wall-card wall-st-${v.tone}`, 'data-session': v.id },
    el('div', { class: 'wall-l1' }, link, badge(v)),
    el('div', { class: 'wall-prj wall-trunc' }, v.origem),
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
    foot(v, write),
  );
  return { node, link };
}

/**
 * The foot (C71): the open action with its label and "Detalhe ›". Every card links to the Detail, as
 * it did before issue 285 (the whole card was the link), so a remote one keeps "Detalhe ›" too.
 */
function foot(v, write) {
  const action = openAction({ id: v.id, open: v.open }, { size: 'small', write });
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

  function choose(id) {
    filter = id;
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
    draw();
  }

  function draw() {
    if (!wall) {
      area.replaceChildren(head, failure ? error({ text: failure.message, retry: () => read() }) : loading({ label: 'Lendo o mural' }));
      return;
    }
    for (const f of FILTERS) buttons.get(f.id).replaceChildren(filterLabel(f, wall.count));
    const f = FILTERS.find((x) => x.id === filter);
    const cards = (wall.cards ?? []).filter(f.passa);
    const band = failure ? errorBand({ title: 'O mural não atualizou.', text: failure.message, action: { label: 'Tentar de novo', onClick: () => read() } }) : null;
    const built = cards.map((c) => card(c, ctx.write));
    const nodes = built.map((b) => b.node);
    // The keyboard lands on the card's link (the title stretched over the card).
    const links = built.map((b) => b.link);
    const body = cards.length
      ? el('div', { class: 'wall-grid' }, ...nodes)
      : empty({ icon: 'wall', title: f.vazio, text: filter === 'all' ? 'Abra uma sessão do Claude Code nesta máquina e ela aparece aqui.' : 'Troque o filtro para ver as outras.' });
    // Redesenhar troca os cards: o foco do teclado volta ao card da mesma sessão.
    const focused = globalThis.document?.activeElement?.closest?.('[data-session]')?.getAttribute('data-session') ?? null;
    area.replaceChildren(...[head, band, body].filter(Boolean));
    if (focused) links.find((n) => n.getAttribute('data-session') === focused)?.focus();
  }

  async function read() {
    const mine = ++request;
    try {
      const fresh = await ctx.read(WALL_ROUTE);
      if (mine !== request) return;
      wall = fresh;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== request) return;
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
