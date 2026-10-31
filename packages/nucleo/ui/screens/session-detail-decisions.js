// A aba Decisões do Detalhe da sessão (C20, issue 103), num módulo à parte para o session-detail.js (#29 e #30)
// só importar. Lê `GET /api/sessions/<id>/decisions?scope=&state=&q=` (src/api/decisions-ui.ts).
//
// Contrato com o session-detail.js, igual às outras abas:
//   const tab = create(ctx, base, { head: () => head, setLabel: (text) => … });
//   tab.show(node); tab.hide(); tab.refresh();
// `setLabel(text)` recebe o que vai entre parênteses na aba (o total do escopo, "4"), ou `null` para tirar
// o número; o session-detail.js redesenha as abas. A aba abre em Sessão (a API, sem `?scope=`, usa a família).
// `refresh()` também serve com a aba escondida: lê e só rotula.

import { el, icon } from '../dom.js';
import { error } from '../states.js';
import { toggle, searchField, loadDecisionsCss, decisionCard } from './decisions-common.js';

const NUM = new Intl.NumberFormat('pt-BR');
const num = (n) => NUM.format(n ?? 0);

// The scope and the state filter are the API's values (English since issue 173, phase 2b).
const SCOPE_OPTIONS = { session: 'Sessão', family: 'Família', branch: 'Branch' };

/** A rota da leitura da aba. */
export function tabRoute(base, { scope = 'session', state = 'all', q = '' } = {}) {
  const p = new URLSearchParams({ scope });
  if (state !== 'all') p.set('state', state);
  if (q) p.set('q', q.slice(0, 200));
  return `${base}/decisions?${p}`;
}

/** A chamada do MCP em duas partes: o nome da ferramenta (em destaque) e os argumentos. */
export function callParts(mcp) {
  const call = String(mcp?.call ?? '');
  const name = String(mcp?.tool ?? '');
  return name && call.startsWith(name) ? [name, call.slice(name.length).trim()] : [name, call];
}

function injectionCard(i) {
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('start'), el('h3', {}, 'No início de cada sessão'), i.enabled ? el('span', { class: 'dec-pill dec-e-current' }, 'Ligado') : el('span', { class: 'dec-pill dec-e-superseded' }, 'Ainda não ligado')),
    el(
      'p',
      {},
      i.enabled
        ? 'Uma sessão nova neste branch já começa sabendo das decisões vigentes.'
        : 'A injeção ainda não está ligada. Quando estiver, uma sessão nova neste branch vai começar sabendo destas decisões vigentes, com este texto:',
    ),
    el('div', { class: 'dec-leg' }, el('span', {}, 'Escopo ', el('b', {}, SCOPE_OPTIONS[i.scope] ?? i.scope)), el('span', {}, 'Decisões ', el('b', {}, num(i.decisions))), el('span', {}, 'Custo ', el('b', {}, `~${num(i.tokens)} tokens`))),
    el('pre', { class: 'mono dec-injection' }, i.text || 'Nenhuma decisão vigente para injetar.'),
  );
}

function mcpCard(m) {
  const [name, args] = callParts(m);
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('mcp'), el('h3', {}, 'Quando o agente perguntar'), el('span', { class: 'dec-r' }, 'MCP')),
    el('div', { class: 'dec-call mono', title: m.call }, icon('chevron-right'), el('span', { class: 'dec-n' }, name), el('span', { class: 'dec-cmd' }, args)),
    el('p', {}, m.response),
    m.exists ? null : el('p', { class: 'dec-note' }, `A ferramenta ${name} ainda não existe no MCP do núcleo: esta é a chamada que ela vai responder.`),
  );
}

function promoteCard(remote = false) {
  return el(
    'section',
    { class: 'card dec-side' },
    el('div', { class: 'dec-side-ttl' }, icon('promote'), el('h3', {}, 'Promover a registro de decisão')),
    el('p', {}, 'Gera um rascunho de registro de decisão para o repositório da sessão, com contexto, decisão, alternativas e o link para a conversa. O caminho vem do núcleo e aparece antes de gravar.'),
    // Issue 243: the draft and the save are writes of this core, about a session it does not have.
    remote ? el('p', { class: 'dec-note' }, 'Desligado nesta sessão: ela roda em outra máquina, e o registro é gravado pelo núcleo daqui.') : null,
  );
}

export function create(ctx, base, { head: headEl = () => null, setLabel = () => {}, remote = null } = {}) {
  // Abre em Sessão, como o C20; Família e Branch somam as das outras sessões.
  const filters = { scope: 'session', state: 'all', q: '' };
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
      toggle({ label: 'Escopo', options: [['session', 'Sessão'], ['family', 'Família'], ['branch', 'Branch']], current: filters.scope, onSwitch: (v) => ((filters.scope = v), draw()) }),
      toggle({ label: 'Estado', options: [['all', 'Todas'], ['current', 'Vigentes'], ['to_confirm', 'A confirmar']], current: filters.state, onSwitch: (v) => ((filters.state = v), draw()) }),
      searchField({ placeholder: 'Buscar nas decisões…', onSearch: (q) => ((filters.q = q), draw()) }),
    );
    const list = el('div', { class: 'dec-list', 'aria-live': 'polite' });
    const side = el('div', { class: 'dec-sides' });
    els = { bar, list, side, grid: el('div', { class: 'dec-grid' }, list, side) };
    return els;
  }

  function nothing(r) {
    const text = filters.q ? `Nenhuma decisão fala de "${filters.q}".` : filters.state !== 'all' ? 'Troque o filtro de estado para ver as outras.' : `Nenhuma decisão no escopo ${SCOPE_OPTIONS[filters.scope].toLowerCase()} ainda.`;
    return el('div', { class: 'card dec-none' }, el('b', {}, r.total || filters.q || filters.state !== 'all' ? 'Nada com esses filtros' : 'Nenhuma decisão ainda'), el('p', {}, text));
  }

  function paint(r) {
    const { bar, list, side, grid } = pieces();
    const session = r.session ?? headEl()?.session?.id;
    const now = Date.now();
    // A remote session's decisions come from the remote (issue 243): only read here, never confirmed,
    // dismissed or promoted by this core.
    const readOnly = remote ? 'Esta sessão roda em outra máquina: daqui as decisões só se leem.' : null;
    list.replaceChildren(...(r.items.length ? r.items.map((d) => decisionCard(d, { session, onChange: draw, now, readOnly, machine: remote?.id ?? null })) : [nothing(r)]));
    side.replaceChildren(injectionCard(r.injection), mcpCard(r.mcp), promoteCard(Boolean(remote)));
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
