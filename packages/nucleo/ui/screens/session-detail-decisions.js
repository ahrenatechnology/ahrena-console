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
import { toggle, searchField, loadDecisionsCss, decisionCard, API_VALUE } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

// The scope is the API's value (English since issue 173, phase 2b); an old one still maps through `API_VALUE`.
const SCOPE_OPTIONS = { session: 'Sessão', family: 'Família', branch: 'Branch' };

/** A rota da leitura da aba. */
export function tabRoute(base, { escopo: scope = 'session', estado: state = 'todas', q = '' } = {}) {
  const p = new URLSearchParams({ scope: API_VALUE[scope] ?? scope });
  if (state !== 'todas') p.set('state', state);
  if (q) p.set('q', q.slice(0, 200));
  return `${base}/decisions?${p}`;
}

/** A chamada do MCP em duas partes: o nome da ferramenta (em destaque) e os argumentos. */
export function callParts(mcp) {
  const call = String(mcp?.chamada ?? '');
  const name = String(mcp?.ferramenta ?? '');
  return name && call.startsWith(name) ? [name, call.slice(name.length).trim()] : [name, call];
}

function injectionCard(i) {
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
    el('div', { class: 'dec-leg' }, el('span', {}, 'Escopo ', el('b', {}, SCOPE_OPTIONS[i.escopo] ?? i.escopo)), el('span', {}, 'Decisões ', el('b', {}, num(i.decisoes))), el('span', {}, 'Custo ', el('b', {}, `~${num(i.tokens)} tokens`))),
    el('pre', { class: 'mono dec-injection' }, i.texto || 'Nenhuma decisão vigente para injetar.'),
  );
}

function mcpCard(m) {
  const [name, args] = callParts(m);
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('mcp'), el('h3', {}, 'Quando o agente perguntar'), el('span', { class: 'dec-r' }, 'MCP')),
    el('div', { class: 'dec-call mono', title: m.chamada }, icon('chevron-right'), el('span', { class: 'dec-n' }, name), el('span', { class: 'dec-cmd' }, args)),
    el('p', {}, m.resposta),
    m.existe ? null : el('p', { class: 'dec-note' }, `A ferramenta ${name} ainda não existe no MCP do núcleo: esta é a chamada que ela vai responder.`),
  );
}

function promoteCard() {
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('promote'), el('h3', {}, 'Promover a registro de decisão')),
    el('p', {}, 'Gera um rascunho de registro de decisão para o repositório da sessão, com contexto, decisão, alternativas e o link para a conversa. O caminho vem do núcleo e aparece antes de gravar.'),
  );
}

export function create(ctx, base, { head: headEl = () => null, setLabel = () => {} } = {}) {
  // Abre em Sessão, como o C20; Família e Branch somam as das outras sessões.
  const filters = { escopo: 'session', estado: 'todas', q: '' };
  let target = null;
  let last = null;
  let request = 0;

  // O DOM nasce na primeira vez que a aba aparece: escondida, ela só lê e rotula.
  let els = null;
  function pieces() {
    if (els) return els;
    const bar = el(
      'div',
      { class: 'dec-bar' },
      toggle({ rotulo: 'Escopo', opcoes: [['session', 'Sessão'], ['family', 'Família'], ['branch', 'Branch']], atual: filters.escopo, aoTrocar: (v) => ((filters.escopo = v), draw()) }),
      toggle({ rotulo: 'Estado', opcoes: [['todas', 'Todas'], ['vigentes', 'Vigentes'], ['a_confirmar', 'A confirmar']], atual: filters.estado, aoTrocar: (v) => ((filters.estado = v), draw()) }),
      searchField({ placeholder: 'Buscar nas decisões…', aoBuscar: (q) => ((filters.q = q), draw()) }),
    );
    const list = el('div', { class: 'dec-list', 'aria-live': 'polite' });
    const side = el('div', { class: 'dec-sides' });
    els = { barra: bar, lista: list, lado: side, grade: el('div', { class: 'dec-grid' }, list, side) };
    return els;
  }

  function nothing(r) {
    const text = filters.q ? `Nenhuma decisão fala de "${filters.q}".` : filters.estado !== 'todas' ? 'Troque o filtro de estado para ver as outras.' : `Nenhuma decisão no escopo ${SCOPE_OPTIONS[filters.escopo].toLowerCase()} ainda.`;
    return el('div', { class: 'card dec-none' }, el('b', {}, r.total || filters.q || filters.estado !== 'todas' ? 'Nada com esses filtros' : 'Nenhuma decisão ainda'), el('p', {}, text));
  }

  function paint(r) {
    const { barra: bar, lista: list, lado: side, grade: grid } = pieces();
    const session = r.sessao ?? headEl()?.session?.id;
    const now = Date.now();
    list.replaceChildren(...(r.itens.length ? r.itens.map((d) => decisionCard(d, { sessao: session, aoMudar: draw, agora: now })) : [nothing(r)]));
    side.replaceChildren(injectionCard(r.injecao), mcpCard(r.mcp), promoteCard());
    target?.replaceChildren(bar, grid);
  }

  async function draw() {
    const mine = ++request;
    try {
      const r = await ctx.read(tabRoute(base, filters));
      if (mine !== request) return;
      last = r;
      setLabel(num(r.total));
      if (target) paint(r);
    } catch (e) {
      if (e.name === 'AbortError' || mine !== request) return;
      target?.replaceChildren(error({ title: 'Não deu para ler as decisões', text: e.message, retry: draw }));
    }
  }

  // As decisões de outra sessão da família ou do branch também mudam esta aba: o session-detail.js só relê
  // pelas mudanças desta sessão, então a aba escuta as de decisão por conta própria.
  let wait = null;
  ctx.onChange((changes) => {
    if (!changes.some((m) => m.type === 'decision')) return;
    clearTimeout(wait);
    wait = setTimeout(draw, 400);
  });
  ctx.signal?.addEventListener('abort', () => clearTimeout(wait));

  return {
    show(node) {
      loadDecisionsCss();
      target = node;
      if (last) paint(last);
      return draw();
    },
    hide: () => (target = null),
    refresh: () => draw(),
  };
}
