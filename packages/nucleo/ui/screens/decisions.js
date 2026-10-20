// A página Decisões (C21, issue 103): todas as decisões, agrupadas por branch, família ou sessão, com
// busca. Responde "o que decidimos sobre X?" sem abrir sessão nenhuma. Lê `GET /api/decisions`
// (src/api/decisoes-ui.ts); Confirmar, Descartar e Promover escrevem por `escrever()` (api.js).

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { toggle, searchField, loadDecisionsCss, decisionCard, API_VALUE } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

/** A rota da leitura, com os filtros que não são o padrão. */
export function decisionsRoute({ agrupar: groupBy = 'branch', estado: state = 'todas', q = '', grupo: group = null } = {}) {
  const p = new URLSearchParams();
  p.set('groupBy', API_VALUE[groupBy] ?? groupBy);
  if (state !== 'todas') p.set('state', state);
  if (q) p.set('q', q.slice(0, 200));
  if (group) p.set('group', group);
  return `/api/decisions?${p}`;
}

/** "vitrine-demo · 6 vigentes · 1 a confirmar". */
export function groupSummary(g) {
  return [g.pasta && g.pasta !== g.titulo ? g.pasta : null, `${num(g.vigentes)} ${g.vigentes === 1 ? 'vigente' : 'vigentes'}`, g.aConfirmar ? `${num(g.aConfirmar)} a confirmar` : null].filter(Boolean).join(' · ');
}

function number({ rotulo: label, valor: value, detalhe: detail, icone: name, cor: color }) {
  return el('div', { class: 'card dec-number' }, el('div', { class: 'eyebrow' }, label), el('span', { class: `dec-number-ico dec-color-${color}` }, icon(name)), el('b', {}, num(value)), el('small', {}, detail));
}

export async function mount(area, ctx) {
  loadDecisionsCss();
  const filters = { agrupar: 'branch', estado: 'todas', q: '', grupo: null };

  const refresh = el('button', { type: 'button', class: 'btn', onClick: () => draw() }, icon('refresh'), 'Atualizar');
  const head = header({
    icon: 'decision',
    title: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    actions: [
      toggle({ rotulo: 'Agrupar por', opcoes: [['sessao', 'Sessão'], ['familia', 'Família'], ['branch', 'Branch']], atual: filters.agrupar, aoTrocar: (v) => ((filters.agrupar = v), (filters.grupo = null), draw()) }),
      refresh,
    ],
  });
  const numbers = el('div', { class: 'dec-numbers' });
  const bar = el(
    'div',
    { class: 'dec-bar' },
    searchField({ placeholder: 'Buscar: "banco de testes", "kanban", "review"…', aoBuscar: (q) => ((filters.q = q), draw()) }),
    toggle({ rotulo: 'Estado', opcoes: [['todas', 'Todas'], ['vigentes', 'Vigentes'], ['a_confirmar', 'A confirmar']], atual: filters.estado, aoTrocar: (v) => ((filters.estado = v), draw()) }),
  );
  const list = el('div', { class: 'dec-groups', 'aria-live': 'polite' });
  const band = el('div', {});

  let last = null;
  let request = 0;

  function group(g) {
    const headEl = el(
      'div',
      { class: 'dec-group-head' },
      icon(g.tipo === 'branch' ? 'branch' : 'sessions'),
      el('span', { class: g.tipo === 'branch' ? 'mono dec-name' : 'dec-name' }, g.titulo),
      el('span', { class: 'dec-summary' }, groupSummary(g)),
      filters.grupo
        ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filters.grupo = null), draw()) }, icon('back'), 'Todos os grupos')
        : g.mais > 0
          ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filters.grupo = g.chave), draw()) }, `Ver todas (${num(g.total)})`, icon('chevron-right'))
          : null,
    );
    const now = Date.now();
    return el('section', { class: 'dec-group', 'aria-label': g.titulo }, headEl, ...g.itens.map((d) => decisionCard(d, { sessao: d.sessionId, aoMudar: draw, agora: now })));
  }

  function drawData(r) {
    const c = r.contagens;
    numbers.replaceChildren(
      number({ rotulo: 'Vigentes', valor: c.vigentes, detalhe: `em ${num(c.branches)} ${c.branches === 1 ? 'branch' : 'branches'}`, icone: 'ok', cor: 'completed' }),
      number({ rotulo: 'A confirmar', valor: c.aConfirmar, detalhe: 'sugeridas pelo agente', icone: 'suggested', cor: 'waiting' }),
      number({ rotulo: 'Substituídas', valor: c.substituidas30d, detalhe: 'nos últimos 30 dias', icone: 'repeat', cor: 'muted' }),
      number({ rotulo: 'Promovidas', valor: c.promovidas, detalhe: 'viraram registro de decisão no repositório', icone: 'promote', cor: 'accent' }),
    );
    const total = c.vigentes + c.aConfirmar + c.substituidas30d;
    if (r.grupos.length) list.replaceChildren(...r.grupos.map(group));
    else if (!total && !filters.q && filters.estado === 'todas')
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
