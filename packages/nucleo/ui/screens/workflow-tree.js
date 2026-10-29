// The tree between sessions (issue 332, C83) and its KPIs, over the `trees` and `loopKpis` of `GET /api/workflows`
// (src/api/workflows.ts). Everything from the core goes in through `textContent` (`el()`), never as HTML.

import { el, icon } from '../dom.js';
import { decimal, num, percent } from './workflow-format.js';

// ---------- Pure parts (tested in node) ----------

const STATUS = { active: ['Ativa', 'active'], completed: ['Concluída', 'completed'], error: ['Com erro', 'error'], abandoned: ['Abandonada', 'muted'] };
export const statusOf = (s) => STATUS[s] ?? STATUS.completed;

/** The six numbers over the tree: trees, PRs in the loop, rounds per PR, approved, stopped loops and sessions. */
export function treeKpis(d) {
  const k = d.loopKpis;
  return [
    { id: 'trees', label: 'Árvores', value: num(d.trees.total), sub: 'raízes sem pai', icon: 'subagent', tone: 'accent' },
    { id: 'prs', label: 'PRs no laço', value: num(k.prs), sub: 'no período', icon: 'pr', tone: 'accent' },
    { id: 'rounds', label: 'Rodadas por PR', value: decimal(k.roundsPerPr), sub: 'de revisão', icon: 'refresh', tone: 'accent' },
    { id: 'approved', label: 'Aprovados', value: k.prs ? percent(k.approved / k.prs) : '—', sub: 'dos PRs do período', icon: 'ok', tone: 'ok' },
    { id: 'stopped', label: 'Laços parados', value: num(k.stopped), sub: k.stopped ? 'a sessão acabou num pedido de mudança' : 'nenhum', icon: 'error', tone: k.stopped ? 'error' : 'ok' },
    { id: 'sessions', label: 'Sessões', value: num(d.sessions), sub: 'no período', icon: 'sessions', tone: 'wait' },
  ];
}

/** "15 subagentes · 4 PRs · 2 rodadas · 1 pedido de mudança" from the loop totals of a node; `null` without them. */
export function nodeMeta(node) {
  const t = node.loop;
  if (!t) return null;
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  const parts = [plural(t.subagents, 'subagente', 'subagentes'), plural(t.prs, 'PR', 'PRs')];
  if (t.rounds) parts.push(plural(t.rounds, 'rodada', 'rodadas'));
  if (t.changeRequests) parts.push(plural(t.changeRequests, 'pedido de mudança', 'pedidos de mudança'));
  return parts.join(' · ');
}

/** How many sessions hang below a node, itself not counted. */
export function descendants(node) {
  return node.children.reduce((t, c) => t + 1 + descendants(c), 0);
}

// ---------- DOM ----------

function row(node, depth, open, toggle) {
  const [label, tone] = statusOf(node.status);
  const has = node.children.length > 0;
  const isOpen = open.has(node.sessionId);
  const link = el('a', { class: 'wft-open', href: `/ui/sessions/${encodeURIComponent(node.sessionId)}#workflow`, title: 'Abrir a sessão', 'aria-label': `Abrir a sessão ${node.name ?? node.sessionId}` }, icon('external'));
  const meta = nodeMeta(node);
  const kids = descendants(node);
  const head = el(
    'div',
    { class: `card wft-node wft-depth-${Math.min(depth, 8)}` },
    has
      ? el('button', { type: 'button', class: 'wft-toggle', 'data-node': node.sessionId, 'aria-expanded': isOpen ? 'true' : 'false', 'aria-label': isOpen ? 'Recolher' : 'Expandir', onClick: () => toggle(node.sessionId) }, icon(isOpen ? 'chevron-down' : 'chevron-right'))
      : el('span', { class: 'wft-toggle wft-none' }),
    el('b', { class: 'wft-name' }, node.name ?? node.sessionId.slice(0, 8)),
    el('span', { class: 'wft-chip mono' }, node.kind === 'child' ? 'Filha' : 'Sessão'),
    el('span', { class: `wft-pill wft-pill-${tone}` }, label),
    node.parentOutsidePeriod ? el('span', { class: 'wft-chip wft-warn', title: 'Quem abriu esta sessão está fora do período' }, 'pai fora do período') : null,
    node.outsidePeriod ? el('span', { class: 'wft-chip wft-warn', title: 'Ativa, mais velha que o período: entra sempre' }, 'fora do período') : null,
    el('span', { class: 'wft-meta' }, [has ? `${num(kids)} ${kids === 1 ? 'filha' : 'filhas'}` : null, meta].filter(Boolean).join(' · ')),
    link,
  );
  const out = [head];
  if (has && isOpen) for (const c of node.children) out.push(...row(c, depth + 1, open, toggle));
  return out;
}

/** The expanded set: every node that has children starts open, down to three levels (PM → TL → session). */
export function initialOpen(trees, levels = 3) {
  const open = new Set();
  const walk = (n, d) => {
    if (n.children.length && d < levels) open.add(n.sessionId);
    n.children.forEach((c) => walk(c, d + 1));
  };
  trees.forEach((t) => walk(t.root, 0));
  return open;
}

/** `items` are the pages loaded so far; `onMore` is set while there is another page ("Carregar mais"). */
export function treePanel(d, open, toggle, { items = d.trees.items, nextCursor = d.trees.nextCursor, onMore = null, loadingMore = false } = {}) {
  return el(
    'section',
    { class: 'card wf-panel' },
    el('div', { class: 'wf-ttl' }, icon('subagent'), 'Árvore entre sessões', el('span', { class: 'wf-ttl-r' }, `${num(items.length)} de ${num(d.trees.total)} árvores · clique abre a sessão`)),
    items.length ? el('div', { class: 'wft-tree' }, ...items.flatMap((t) => row(t.root, 0, open, toggle))) : el('p', { class: 'wf-none' }, 'Nenhuma sessão neste filtro.'),
    nextCursor && onMore ? el('div', { class: 'wft-more' }, el('button', { type: 'button', class: 'btn outline', disabled: loadingMore ? '' : null, onClick: onMore }, icon('chevron-down'), loadingMore ? 'Carregando…' : `Carregar mais ${num(Math.min(d.trees.pageSize ?? 50, d.trees.total - items.length))}`)) : null,
    el('div', { class: 'wf-legend wft-legend' }, el('span', {}, icon('chevron-down'), ' expandido'), el('span', {}, icon('chevron-right'), ' recolhido'), el('span', {}, icon('external'), ' abre a sessão, na aba Workflow'), el('span', {}, 'A indentação é quem abriu quem: o índice do Claude Desktop, sem ligação deduzida')),
  );
}

export function treeKpiRow(d) {
  return el(
    'div',
    { class: 'wf-kpis' },
    ...treeKpis(d).map((c) =>
      el('div', { class: `card wf-kpi wf-kpi-${c.id}` }, el('span', { class: 'wf-kpi-label' }, c.label), el('span', { class: `wf-kpi-ic wf-color-${c.tone}` }, icon(c.icon)), el('span', { class: 'wf-kpi-v mono' }, c.value), el('span', { class: 'wf-kpi-s' }, c.sub ?? '')),
    ),
  );
}
