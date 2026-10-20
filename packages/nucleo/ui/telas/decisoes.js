// A página Decisões (C21, issue 103): todas as decisões, agrupadas por branch, família ou sessão, com
// busca. Responde "o que decidimos sobre X?" sem abrir sessão nenhuma. Lê `GET /api/decisoes`
// (src/api/decisoes-ui.ts); Confirmar, Descartar e Promover escrevem por `escrever()` (ler.js).

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';
import { alternador, campoDeBusca, carregarCssDasDecisoes, cartaoDeDecisao } from './decisoes-comum.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

/** A rota da leitura, com os filtros que não são o padrão. */
export function rotaDasDecisoes({ agrupar = 'branch', estado = 'todas', q = '', grupo = null } = {}) {
  const p = new URLSearchParams();
  p.set('agrupar', agrupar);
  if (estado !== 'todas') p.set('estado', estado);
  if (q) p.set('q', q.slice(0, 200));
  if (grupo) p.set('grupo', grupo);
  return `/api/decisoes?${p}`;
}

/** "vitrine-demo · 6 vigentes · 1 a confirmar". */
export function resumoDoGrupo(g) {
  return [g.pasta && g.pasta !== g.titulo ? g.pasta : null, `${num(g.vigentes)} ${g.vigentes === 1 ? 'vigente' : 'vigentes'}`, g.aConfirmar ? `${num(g.aConfirmar)} a confirmar` : null].filter(Boolean).join(' · ');
}

function numero({ rotulo, valor, detalhe, icone: nome, cor }) {
  return el('div', { class: 'cartao dec-numero' }, el('div', { class: 'olhinho' }, rotulo), el('span', { class: `dec-numero-ico dec-cor-${cor}` }, icone(nome)), el('b', {}, num(valor)), el('small', {}, detalhe));
}

export async function montar(area, ctx) {
  carregarCssDasDecisoes();
  const filtros = { agrupar: 'branch', estado: 'todas', q: '', grupo: null };

  const atualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => desenhar() }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({
    icone: 'decisoes',
    titulo: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    acoes: [
      alternador({ rotulo: 'Agrupar por', opcoes: [['sessao', 'Sessão'], ['familia', 'Família'], ['branch', 'Branch']], atual: filtros.agrupar, aoTrocar: (v) => ((filtros.agrupar = v), (filtros.grupo = null), desenhar()) }),
      atualizar,
    ],
  });
  const numeros = el('div', { class: 'dec-numeros' });
  const barra = el(
    'div',
    { class: 'dec-barra' },
    campoDeBusca({ placeholder: 'Buscar: "banco de testes", "kanban", "review"…', aoBuscar: (q) => ((filtros.q = q), desenhar()) }),
    alternador({ rotulo: 'Estado', opcoes: [['todas', 'Todas'], ['vigentes', 'Vigentes'], ['a_confirmar', 'A confirmar']], atual: filtros.estado, aoTrocar: (v) => ((filtros.estado = v), desenhar()) }),
  );
  const lista = el('div', { class: 'dec-grupos', 'aria-live': 'polite' });
  const faixa = el('div', {});

  let ultimo = null;
  let pedido = 0;

  function grupo(g) {
    const cabeca = el(
      'div',
      { class: 'dec-grupo-cab' },
      icone(g.tipo === 'branch' ? 'branch' : 'sessoes'),
      el('span', { class: g.tipo === 'branch' ? 'mono dec-nome' : 'dec-nome' }, g.titulo),
      el('span', { class: 'dec-resumo' }, resumoDoGrupo(g)),
      filtros.grupo
        ? el('button', { type: 'button', class: 'dec-link', aoClicar: () => ((filtros.grupo = null), desenhar()) }, '‹ Todos os grupos')
        : g.mais > 0
          ? el('button', { type: 'button', class: 'dec-link', aoClicar: () => ((filtros.grupo = g.chave), desenhar()) }, `Ver todas (${num(g.total)}) ›`)
          : null,
    );
    const agora = Date.now();
    return el('section', { class: 'dec-grupo', 'aria-label': g.titulo }, cabeca, ...g.itens.map((d) => cartaoDeDecisao(d, { sessao: d.sessionId, aoMudar: desenhar, agora })));
  }

  function desenharDados(r) {
    const c = r.contagens;
    numeros.replaceChildren(
      numero({ rotulo: 'Vigentes', valor: c.vigentes, detalhe: `em ${num(c.branches)} ${c.branches === 1 ? 'branch' : 'branches'}`, icone: 'vigente', cor: 'completed' }),
      numero({ rotulo: 'A confirmar', valor: c.aConfirmar, detalhe: 'sugeridas pelo agente', icone: 'sugerida', cor: 'waiting' }),
      numero({ rotulo: 'Substituídas', valor: c.substituidas30d, detalhe: 'nos últimos 30 dias', icone: 'substituida', cor: 'muted' }),
      numero({ rotulo: 'Promovidas', valor: c.promovidas, detalhe: 'viraram registro em docs/decisoes', icone: 'promover', cor: 'accent' }),
    );
    const total = c.vigentes + c.aConfirmar + c.substituidas30d;
    if (r.grupos.length) lista.replaceChildren(...r.grupos.map(grupo));
    else if (!total && !filtros.q && filtros.estado === 'todas')
      lista.replaceChildren(vazio({ icone: 'decisoes', titulo: 'Nenhuma decisão ainda', texto: 'Quando você responder uma pergunta, aprovar um plano ou corrigir um agente, a decisão aparece aqui.' }));
    else lista.replaceChildren(vazio({ icone: 'busca', titulo: 'Nada com esses filtros', texto: filtros.q ? `Nenhuma decisão fala de "${filtros.q}".` : 'Troque o filtro de estado para ver as outras.' }));
  }

  async function desenhar() {
    const meu = ++pedido;
    try {
      const r = await ctx.ler(rotaDasDecisoes(filtros));
      if (meu !== pedido) return;
      faixa.replaceChildren();
      const primeira = !ultimo;
      ultimo = r;
      desenharDados(r);
      if (primeira) area.replaceChildren(cab, numeros, barra, faixa, lista);
    } catch (e) {
      if (e.name === 'AbortError' || meu !== pedido) return;
      if (!ultimo) area.replaceChildren(cab, erro({ texto: e.message, tentar: desenhar }));
      else faixa.replaceChildren(faixaDeErro({ titulo: 'Não deu para atualizar.', texto: e.message, acao: { rotulo: 'Tentar de novo', aoClicar: desenhar } }));
    }
  }

  // Ao vivo: qualquer decisão que muda relê a página, juntando as que chegam perto.
  let espera = null;
  ctx.aoMudar((mudancas) => {
    if (!mudancas.some((m) => m.tipo === 'decisao')) return;
    clearTimeout(espera);
    espera = setTimeout(desenhar, 400);
  });
  ctx.aoReiniciar(desenhar);

  area.replaceChildren(cab, carregando({ rotulo: 'Carregando as decisões' }));
  await desenhar();
  return () => clearTimeout(espera);
}
