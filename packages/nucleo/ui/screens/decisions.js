// A página Decisões (C21, issue 103): todas as decisões, agrupadas por branch, família ou sessão, com
// busca. Responde "o que decidimos sobre X?" sem abrir sessão nenhuma. Lê `GET /api/decisions`
// (src/api/decisoes-ui.ts); Confirmar, Descartar e Promover escrevem por `escrever()` (api.js).

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { alternador, campoDeBusca, carregarCssDasDecisoes, cartaoDeDecisao, VALOR_DA_API } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

/** A rota da leitura, com os filtros que não são o padrão. */
export function rotaDasDecisoes({ agrupar = 'branch', estado = 'todas', q = '', grupo = null } = {}) {
  const p = new URLSearchParams();
  p.set('groupBy', VALOR_DA_API[agrupar] ?? agrupar);
  if (estado !== 'todas') p.set('state', estado);
  if (q) p.set('q', q.slice(0, 200));
  if (grupo) p.set('group', grupo);
  return `/api/decisions?${p}`;
}

/** "vitrine-demo · 6 vigentes · 1 a confirmar". */
export function resumoDoGrupo(g) {
  return [g.pasta && g.pasta !== g.titulo ? g.pasta : null, `${num(g.vigentes)} ${g.vigentes === 1 ? 'vigente' : 'vigentes'}`, g.aConfirmar ? `${num(g.aConfirmar)} a confirmar` : null].filter(Boolean).join(' · ');
}

function numero({ rotulo, valor, detalhe, icone: nome, cor }) {
  return el('div', { class: 'card dec-number' }, el('div', { class: 'eyebrow' }, rotulo), el('span', { class: `dec-number-ico dec-color-${cor}` }, icon(nome)), el('b', {}, num(valor)), el('small', {}, detalhe));
}

export async function mount(area, ctx) {
  carregarCssDasDecisoes();
  const filtros = { agrupar: 'branch', estado: 'todas', q: '', grupo: null };

  const atualizar = el('button', { type: 'button', class: 'btn', onClick: () => desenhar() }, icon('refresh'), 'Atualizar');
  const cab = header({
    icon: 'decision',
    title: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    actions: [
      alternador({ rotulo: 'Agrupar por', opcoes: [['sessao', 'Sessão'], ['familia', 'Família'], ['branch', 'Branch']], atual: filtros.agrupar, aoTrocar: (v) => ((filtros.agrupar = v), (filtros.grupo = null), desenhar()) }),
      atualizar,
    ],
  });
  const numeros = el('div', { class: 'dec-numbers' });
  const barra = el(
    'div',
    { class: 'dec-bar' },
    campoDeBusca({ placeholder: 'Buscar: "banco de testes", "kanban", "review"…', aoBuscar: (q) => ((filtros.q = q), desenhar()) }),
    alternador({ rotulo: 'Estado', opcoes: [['todas', 'Todas'], ['vigentes', 'Vigentes'], ['a_confirmar', 'A confirmar']], atual: filtros.estado, aoTrocar: (v) => ((filtros.estado = v), desenhar()) }),
  );
  const lista = el('div', { class: 'dec-groups', 'aria-live': 'polite' });
  const faixa = el('div', {});

  let ultimo = null;
  let pedido = 0;

  function grupo(g) {
    const cabeca = el(
      'div',
      { class: 'dec-group-head' },
      icon(g.tipo === 'branch' ? 'branch' : 'sessions'),
      el('span', { class: g.tipo === 'branch' ? 'mono dec-name' : 'dec-name' }, g.titulo),
      el('span', { class: 'dec-summary' }, resumoDoGrupo(g)),
      filtros.grupo
        ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filtros.grupo = null), desenhar()) }, icon('back'), 'Todos os grupos')
        : g.mais > 0
          ? el('button', { type: 'button', class: 'dec-link', onClick: () => ((filtros.grupo = g.chave), desenhar()) }, `Ver todas (${num(g.total)})`, icon('chevron-right'))
          : null,
    );
    const agora = Date.now();
    return el('section', { class: 'dec-group', 'aria-label': g.titulo }, cabeca, ...g.itens.map((d) => cartaoDeDecisao(d, { sessao: d.sessionId, aoMudar: desenhar, agora })));
  }

  function desenharDados(r) {
    const c = r.contagens;
    numeros.replaceChildren(
      numero({ rotulo: 'Vigentes', valor: c.vigentes, detalhe: `em ${num(c.branches)} ${c.branches === 1 ? 'branch' : 'branches'}`, icone: 'ok', cor: 'completed' }),
      numero({ rotulo: 'A confirmar', valor: c.aConfirmar, detalhe: 'sugeridas pelo agente', icone: 'suggested', cor: 'waiting' }),
      numero({ rotulo: 'Substituídas', valor: c.substituidas30d, detalhe: 'nos últimos 30 dias', icone: 'repeat', cor: 'muted' }),
      numero({ rotulo: 'Promovidas', valor: c.promovidas, detalhe: 'viraram registro de decisão no repositório', icone: 'promote', cor: 'accent' }),
    );
    const total = c.vigentes + c.aConfirmar + c.substituidas30d;
    if (r.grupos.length) lista.replaceChildren(...r.grupos.map(grupo));
    else if (!total && !filtros.q && filtros.estado === 'todas')
      lista.replaceChildren(empty({ icon: 'decision', title: 'Nenhuma decisão ainda', text: 'Quando você responder uma pergunta, aprovar um plano ou corrigir um agente, a decisão aparece aqui.' }));
    else lista.replaceChildren(empty({ icon: 'search', title: 'Nada com esses filtros', text: filtros.q ? `Nenhuma decisão fala de "${filtros.q}".` : 'Troque o filtro de estado para ver as outras.' }));
  }

  async function desenhar() {
    const meu = ++pedido;
    try {
      const r = await ctx.read(rotaDasDecisoes(filtros));
      if (meu !== pedido) return;
      faixa.replaceChildren();
      const primeira = !ultimo;
      ultimo = r;
      desenharDados(r);
      if (primeira) area.replaceChildren(cab, numeros, barra, faixa, lista);
    } catch (e) {
      if (e.name === 'AbortError' || meu !== pedido) return;
      if (!ultimo) area.replaceChildren(cab, error({ text: e.message, retry: desenhar }));
      else faixa.replaceChildren(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: desenhar } }));
    }
  }

  // Ao vivo: qualquer decisão que muda relê a página, juntando as que chegam perto.
  let espera = null;
  ctx.onChange((mudancas) => {
    if (!mudancas.some((m) => m.tipo === 'decisao')) return;
    clearTimeout(espera);
    espera = setTimeout(desenhar, 400);
  });
  ctx.onRestart(desenhar);

  area.replaceChildren(cab, loading({ label: 'Carregando as decisões' }));
  await desenhar();
  return () => clearTimeout(espera);
}
