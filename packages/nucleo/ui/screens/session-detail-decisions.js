// A aba Decisões do Detalhe da sessão (C20, issue 103), num módulo à parte para o session-detail.js (#29 e #30)
// só importar. Lê `GET /api/sessions/<id>/decisions?scope=&state=&q=` (src/api/decisoes-ui.ts).
//
// Contrato com o session-detail.js, igual às outras abas:
//   const aba = criar(ctx, base, { cabeca: () => cabeca, rotular: (texto) => … });
//   aba.mostrar(corpo); aba.esconder(); aba.atualizar();
// `rotular(texto)` recebe o que vai entre parênteses na aba (o total do escopo, "4"), ou `null` para tirar
// o número; o session-detail.js redesenha as abas. O escopo padrão é a família, como o da API.
// `atualizar()` também serve com a aba escondida: lê e só rotula.

import { el, icon } from '../dom.js';
import { error } from '../states.js';
import { alternador, campoDeBusca, carregarCssDasDecisoes, cartaoDeDecisao, VALOR_DA_API } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

const ESCOPOS = { sessao: 'Sessão', familia: 'Família', branch: 'Branch' };

/** A rota da leitura da aba. */
export function rotaDaAba(base, { escopo = 'sessao', estado = 'todas', q = '' } = {}) {
  const p = new URLSearchParams({ scope: VALOR_DA_API[escopo] ?? escopo });
  if (estado !== 'todas') p.set('state', estado);
  if (q) p.set('q', q.slice(0, 200));
  return `${base}/decisions?${p}`;
}

/** A chamada do MCP em duas partes: o nome da ferramenta (em destaque) e os argumentos. */
export function partesDaChamada(mcp) {
  const chamada = String(mcp?.chamada ?? '');
  const nome = String(mcp?.ferramenta ?? '');
  return nome && chamada.startsWith(nome) ? [nome, chamada.slice(nome.length).trim()] : [nome, chamada];
}

function cartaoDaInjecao(i) {
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('start'), el('h3', {}, 'No início de cada sessão'), i.ligada ? el('span', { class: 'dec-pill dec-e-current' }, 'Ligado') : el('span', { class: 'dec-pill dec-e-superseded' }, 'Ainda não ligado')),
    el(
      'p',
      {},
      i.ligada
        ? 'Uma sessão nova neste branch já começa sabendo das decisões vigentes.'
        : 'A injeção ainda não está ligada. Quando estiver, uma sessão nova neste branch vai começar sabendo destas decisões vigentes, com este texto:',
    ),
    el('div', { class: 'dec-leg' }, el('span', {}, 'Escopo ', el('b', {}, ESCOPOS[i.escopo] ?? i.escopo)), el('span', {}, 'Decisões ', el('b', {}, num(i.decisoes))), el('span', {}, 'Custo ', el('b', {}, `~${num(i.tokens)} tokens`))),
    el('pre', { class: 'mono dec-injection' }, i.texto || 'Nenhuma decisão vigente para injetar.'),
  );
}

function cartaoDoMcp(m) {
  const [nome, args] = partesDaChamada(m);
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('mcp'), el('h3', {}, 'Quando o agente perguntar'), el('span', { class: 'dec-r' }, 'MCP')),
    el('div', { class: 'dec-call mono', title: m.chamada }, icon('chevron-right'), el('span', { class: 'dec-n' }, nome), el('span', { class: 'dec-cmd' }, args)),
    el('p', {}, m.resposta),
    m.existe ? null : el('p', { class: 'dec-note' }, `A ferramenta ${nome} ainda não existe no MCP do núcleo: esta é a chamada que ela vai responder.`),
  );
}

function cartaoDoPromover() {
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('promote'), el('h3', {}, 'Promover a registro de decisão')),
    el('p', {}, 'Gera um rascunho de registro de decisão para o repositório da sessão, com contexto, decisão, alternativas e o link para a conversa. O caminho vem do núcleo e aparece antes de gravar.'),
  );
}

export function criar(ctx, base, { cabeca = () => null, rotular = () => {} } = {}) {
  // Abre em Sessão, como o C20; Família e Branch somam as das outras sessões.
  const filtros = { escopo: 'sessao', estado: 'todas', q: '' };
  let alvo = null;
  let ultimo = null;
  let pedido = 0;

  // O DOM nasce na primeira vez que a aba aparece: escondida, ela só lê e rotula.
  let dom = null;
  function pecas() {
    if (dom) return dom;
    const barra = el(
      'div',
      { class: 'dec-bar' },
      alternador({ rotulo: 'Escopo', opcoes: [['sessao', 'Sessão'], ['familia', 'Família'], ['branch', 'Branch']], atual: filtros.escopo, aoTrocar: (v) => ((filtros.escopo = v), desenhar()) }),
      alternador({ rotulo: 'Estado', opcoes: [['todas', 'Todas'], ['vigentes', 'Vigentes'], ['a_confirmar', 'A confirmar']], atual: filtros.estado, aoTrocar: (v) => ((filtros.estado = v), desenhar()) }),
      campoDeBusca({ placeholder: 'Buscar nas decisões…', aoBuscar: (q) => ((filtros.q = q), desenhar()) }),
    );
    const lista = el('div', { class: 'dec-list', 'aria-live': 'polite' });
    const lado = el('div', { class: 'dec-sides' });
    dom = { barra, lista, lado, grade: el('div', { class: 'dec-grid' }, lista, lado) };
    return dom;
  }

  function nada(r) {
    const texto = filtros.q ? `Nenhuma decisão fala de "${filtros.q}".` : filtros.estado !== 'todas' ? 'Troque o filtro de estado para ver as outras.' : `Nenhuma decisão no escopo ${ESCOPOS[filtros.escopo].toLowerCase()} ainda.`;
    return el('div', { class: 'card dec-none' }, el('b', {}, r.total || filtros.q || filtros.estado !== 'todas' ? 'Nada com esses filtros' : 'Nenhuma decisão ainda'), el('p', {}, texto));
  }

  function pintar(r) {
    const { barra, lista, lado, grade } = pecas();
    const sessao = r.sessao ?? cabeca()?.sessao?.id;
    const agora = Date.now();
    lista.replaceChildren(...(r.itens.length ? r.itens.map((d) => cartaoDeDecisao(d, { sessao, aoMudar: desenhar, agora })) : [nada(r)]));
    lado.replaceChildren(cartaoDaInjecao(r.injecao), cartaoDoMcp(r.mcp), cartaoDoPromover());
    alvo?.replaceChildren(barra, grade);
  }

  async function desenhar() {
    const meu = ++pedido;
    try {
      const r = await ctx.read(rotaDaAba(base, filtros));
      if (meu !== pedido) return;
      ultimo = r;
      rotular(num(r.total));
      if (alvo) pintar(r);
    } catch (e) {
      if (e.name === 'AbortError' || meu !== pedido) return;
      alvo?.replaceChildren(error({ title: 'Não deu para ler as decisões', text: e.message, retry: desenhar }));
    }
  }

  // As decisões de outra sessão da família ou do branch também mudam esta aba: o session-detail.js só relê
  // pelas mudanças desta sessão, então a aba escuta as de decisão por conta própria.
  let espera = null;
  ctx.onChange((mudancas) => {
    if (!mudancas.some((m) => m.tipo === 'decisao')) return;
    clearTimeout(espera);
    espera = setTimeout(desenhar, 400);
  });
  ctx.signal?.addEventListener('abort', () => clearTimeout(espera));

  return {
    mostrar(no) {
      carregarCssDasDecisoes();
      alvo = no;
      if (ultimo) pintar(ultimo);
      return desenhar();
    },
    esconder: () => (alvo = null),
    atualizar: () => desenhar(),
  };
}
