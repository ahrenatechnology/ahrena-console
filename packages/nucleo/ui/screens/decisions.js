// A página Decisões (C21, issue 103): todas as decisões, agrupadas por branch, família ou sessão, com
// busca. Responde "o que decidimos sobre X?" sem abrir sessão nenhuma. Lê `GET /api/decisions`
// (src/api/decisions-ui.ts); Confirmar, Descartar e Promover escrevem por `escrever()` (api.js).

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { toggle, searchField, loadDecisionsCss, decisionCard } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

/** A rota da leitura, com os filtros que não são o padrão (os valores são os da API). */
export function decisionsRoute({ groupBy = 'branch', state = 'all', q = '', group = null } = {}) {
  const p = new URLSearchParams();
  p.set('groupBy', groupBy);
  if (state !== 'all') p.set('state', state);
  if (q) p.set('q', q.slice(0, 200));
  if (group) p.set('group', group);
  return `/api/decisions?${p}`;
}

/** "vitrine-demo · 6 vigentes · 1 a confirmar". */
export function groupSummary(g) {
  return [g.folder && g.folder !== g.title ? g.folder : null, `${num(g.current)} ${g.current === 1 ? 'vigente' : 'vigentes'}`, g.toConfirm ? `${num(g.toConfirm)} a confirmar` : null].filter(Boolean).join(' · ');
}

function number({ label, value, detail, icon: name, color }) {
  return el('div', { class: 'card dec-number' }, el('div', { class: 'eyebrow' }, label), el('span', { class: `dec-number-ico dec-color-${color}` }, icon(name)), el('b', {}, num(value)), el('small', {}, detail));
}

export async function mount(area, ctx) {
  loadDecisionsCss();
  const filters = { groupBy: 'branch', state: 'all', q: '', group: null };

  const refresh = el('button', { type: 'button', class: 'btn', onClick: () => draw() }, icon('refresh'), 'Atualizar');
  const head = header({
    icon: 'decision',
    title: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    actions: [
      toggle({ label: 'Agrupar por', options: [['session', 'Sessão'], ['family', 'Família'], ['branch', 'Branch']], current: filters.groupBy, onSwitch: (v) => ((filters.groupBy = v), (filters.group = null), draw()) }),
      refresh,
    ],
  });
  const numbers = el('div', { class: 'dec-numbers' });
  const bar = el(
    'div',
    { class: 'dec-bar' },
    searchField({ placeholder: 'Buscar: "banco de testes", "kanban", "review"…', onSearch: (q) => ((filters.q = q), draw()) }),
    toggle({ label: 'Estado', options: [['all', 'Todas'], ['current', 'Vigentes'], ['to_confirm', 'A confirmar']], current: filters.state, onSwitch: (v) => ((filters.state = v), draw()) }),
  );
  const list = el('div', { class: 'dec-groups', 'aria-live': 'polite' });
  const band = el('div', {});

  let last = null;
  let request = 0;

  function group(g) {
    const headEl = el(
      'div',
      { class: 'dec-group-head' },
      icon(g.type === 'branch' ? 'branch' : 'sessions'),
      el('span', { class: g.type === 'branch' ? 'mono dec-name' : 'dec-name' }, g.title),
      el('span', { class: 'dec-summary' }, groupSummary(g)),
      filters.group
        ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filters.group = null), draw()) }, icon('back'), 'Todos os grupos')
        : g.more > 0
          ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filters.group = g.key), draw()) }, `Ver todas (${num(g.total)})`, icon('chevron-right'))
          : null,
    );
    const now = Date.now();
    return el('section', { class: 'dec-group', 'aria-label': g.title }, headEl, ...g.items.map((d) => decisionCard(d, { session: d.sessionId, onChange: draw, now })));
  }

  function drawData(r) {
    const c = r.counts;
    numbers.replaceChildren(
      number({ label: 'Vigentes', value: c.current, detail: `em ${num(c.branches)} ${c.branches === 1 ? 'branch' : 'branches'}`, icon: 'ok', color: 'completed' }),
      number({ label: 'A confirmar', value: c.toConfirm, detail: 'sugeridas pelo agente', icon: 'suggested', color: 'waiting' }),
      number({ label: 'Substituídas', value: c.superseded30d, detail: 'nos últimos 30 dias', icon: 'repeat', color: 'muted' }),
      number({ label: 'Promovidas', value: c.promoted, detail: 'viraram registro de decisão no repositório', icon: 'promote', color: 'accent' }),
    );
    const total = c.current + c.toConfirm + c.superseded30d;
    if (r.groups.length) list.replaceChildren(...r.groups.map(group));
    else if (!total && !filters.q && filters.state === 'all')
      list.replaceChildren(empty({ icon: 'decision', title: 'Nenhuma decisão ainda', text: 'Quando você responder uma pergunta, aprovar um plano ou corrigir um agente, a decisão aparece aqui.' }));
    else list.replaceChildren(empty({ icon: 'search', title: 'Nada com esses filtros', text: filters.q ? `Nenhuma decisão fala de "${filters.q}".` : 'Troque o filtro de estado para ver as outras.' }));
  }

  async function draw() {
    const mine = ++request;
    try {
      const r = await ctx.read(decisionsRoute(filters));
      if (mine !== request) return;
      band.replaceChildren();
      const first = !last;
      last = r;
      drawData(r);
      if (first) area.replaceChildren(head, numbers, bar, band, list);
    } catch (e) {
      if (e.name === 'AbortError' || mine !== request) return;
      if (!last) area.replaceChildren(head, error({ text: e.message, retry: draw }));
      else band.replaceChildren(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: draw } }));
    }
  }

  // Ao vivo: qualquer decisão que muda relê a página, juntando as que chegam perto.
  let wait = null;
  ctx.onChange((changes) => {
    if (!changes.some((m) => m.type === 'decision')) return;
    clearTimeout(wait);
    wait = setTimeout(draw, 400);
  });
  ctx.onRestart(draw);

  area.replaceChildren(head, loading({ label: 'Carregando as decisões' }));
  await draw();
  return () => clearTimeout(wait);
}
