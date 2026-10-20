// Kanban (#31, C9 e C10 do wireframe): as sessões, ou os agentes, em colunas por status. Só leitura.
//
// - The view comes from the query (`/ui/kanban?view=agents`; without it, sessions). Switching the
//   view rewrites the URL with `history.replaceState`, without reloading, and re-reads.
// - `GET /api/kanban?view=<v>` brings every column on page 1; "mostrar mais" asks for
//   `&column=<id>&page=<n>` and appends the items at the end of the column.
// - Ao vivo: uma mudança de sessão relê o quadro (com um respiro de 400 ms, para juntar rajadas);
//   reiniciar relê. A releitura volta cada coluna à página 1.
// - O estilo está em `ui/kanban.css`, que a tela põe no <head> ao montar e tira ao sair.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';

// ---------- Funções puras (testadas em test/api/ui-kanban.test.ts) ----------

export const VIEWS = ['sessions', 'agents'];

/** A visão pedida na query; qualquer outra coisa é `sessoes`. */
export function viewFromUrl(search) {
  const v = new URLSearchParams(search ?? '').get('view');
  return VIEWS.includes(v) ? v : 'sessions';
}

/** A query da URL do navegador para uma visão: sessões é o padrão e não aparece. */
export function viewQuery(view) {
  return view === 'agents' ? '?view=agents' : '';
}

/** A rota da API: o quadro todo, ou uma página de uma coluna. */
export function kanbanRoute(view, column = null, page = null) {
  const q = new URLSearchParams({ view });
  if (column) {
    q.set('column', column);
    q.set('page', String(page ?? 1));
  }
  return `/api/kanban?${q}`;
}

/** Duração legível: "40 s", "12 min", "3 h 10", "2 h". */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

const REAL_ONES = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Custo estimado: "~US$ 1,84"; sem custo, `null` (a linha some). */
export function formatCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
  return `~US$ ${REAL_ONES.format(usd)}`;
}

/** Os 8 primeiros caracteres do id. */
export function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

/** "1 agente", "3 agentes". */
export function agentsLabel(n) {
  const k = Number.isFinite(n) ? n : 0;
  return `${k} agente${k === 1 ? '' : 's'}`;
}

/** O motivo da espera: rótulo, ícone e se é urgente (peso maior no selo). */
const REASONS = {
  notification: { rotulo: 'Pede permissão', icone: 'permission', urgente: true },
  interrupted: { rotulo: 'Interrompida', icone: 'interrupted', urgente: true },
  stop: { rotulo: 'Sua vez', icone: 'your-turn', urgente: false },
  session_start: { rotulo: 'Sua vez', icone: 'your-turn', urgente: false },
};

export function reason(m) {
  return REASONS[m] ?? null;
}

export function reasonLabel(m) {
  return REASONS[m]?.rotulo ?? null;
}

/** Status da sessão ou do agente → a cor (classe) e o rótulo do selo. O agente "working" é ativo. */
const STATUS = {
  active: { cor: 'active', rotulo: 'Ativa' },
  working: { cor: 'active', rotulo: 'Ativa' },
  waiting: { cor: 'waiting', rotulo: 'Esperando você' },
  completed: { cor: 'completed', rotulo: 'Concluída' },
  error: { cor: 'error', rotulo: 'Com erro' },
  abandoned: { cor: 'abandoned', rotulo: 'Abandonada' },
};

export function status(st) {
  return STATUS[st] ?? { cor: 'abandoned', rotulo: String(st ?? '—') };
}

/** A cor da coluna, pelo id dela (as duas visões). */
const COLUMN_COLOR = {
  ativa: 'active',
  trabalhando: 'active',
  esperando: 'waiting',
  concluida: 'completed',
  concluidos: 'completed',
  erro: 'error',
  abandonada: 'abandoned',
};

export function columnColor(id) {
  return COLUMN_COLOR[id] ?? 'abandoned';
}

/** Quantos faltam mostrar numa coluna. */
export function missing(column, shown) {
  return Math.max(0, (column?.total ?? 0) - shown);
}

/** Uma mudança do long polling que mexe no quadro. */
const TYPES_THAT_MATTER = new Set(['sessao', 'estado', 'precisa-de-voce']);
export function touchesBoard(changes) {
  return Array.isArray(changes) && changes.some((m) => TYPES_THAT_MATTER.has(m?.tipo));
}

// ---------- Peças ----------

const SUB = {
  sessions: 'As sessões por status, só leitura',
  agents: 'Os agentes por status, só leitura',
};

const EMPTY = {
  sessions: { title: 'Nenhuma sessão ainda', text: 'Quando uma sessão do Claude Code começar nesta máquina, ela aparece aqui.' },
  agents: { title: 'Nenhum agente ainda', text: 'Quando uma sessão do Claude Code começar nesta máquina, os agentes dela aparecem aqui.' },
};

const sessionHref = (id) => `/ui/sessions/${encodeURIComponent(id)}`;

function badges(st, reasonKey) {
  const s = status(st);
  const m = reason(reasonKey);
  return el(
    'div',
    { class: 'kb-badges' },
    el('span', { class: `kb-badge-st kb-b-${s.cor}` }, el('span', { class: 'kb-p' }), s.rotulo),
    m ? el('span', { class: `kb-badge-reason${m.urgente ? '' : ' kb-soft'}` }, icon(m.icone), m.rotulo) : null,
  );
}

function avatar(name) {
  return el('span', { class: 'kb-av' }, icon(name));
}

function info(iconName, text, className = null) {
  return el('span', { class: className }, icon(iconName), el('span', { class: 'kb-t' }, text));
}

function sessionCard(s) {
  const cost = formatCost(s.custoUsd);
  return el(
    'a',
    { class: `card kb-kc kb-st-${status(s.status).cor}`, href: sessionHref(s.id), title: s.titulo || null },
    el('div', { class: 'kb-l1' }, avatar('folder'), el('div', { class: 'kb-name' }, el('div', { class: 'kb-tt' }, s.titulo || '(sem título)'), el('small', {}, shortId(s.id)))),
    badges(s.status, s.motivo),
    s.ultimoPrompt ? el('blockquote', {}, s.ultimoPrompt) : null,
    s.cwd ? el('div', { class: 'kb-cwd' }, s.cwd) : null,
    el(
      'div',
      { class: 'kb-foot' },
      info('bot', agentsLabel(s.agentes)),
      s.modelo ? info('model', s.modelo) : null,
      cost ? info('coins', cost) : null,
      info('duration', formatDuration(s.duracaoMs), s.rodando ? 'kb-dur kb-running' : 'kb-dur'),
    ),
  );
}

function agentCard(a) {
  return el(
    'a',
    { class: `card kb-kc kb-agent kb-st-${status(a.status).cor}`, href: sessionHref(a.sessaoId), title: a.descricao || a.nome || null },
    el('div', { class: 'kb-l1' }, avatar(a.principal ? 'bot' : 'subagent'), el('div', { class: 'kb-name' }, el('div', { class: 'kb-tt' }, a.nome || '(sem nome)'), a.descricao ? el('small', {}, a.descricao) : null)),
    badges(a.status, a.motivo),
    el('div', { class: 'kb-foot' }, a.modelo ? info('model', a.modelo) : null, info('duration', formatDuration(a.duracaoMs), a.rodando ? 'kb-dur kb-running' : 'kb-dur')),
  );
}

// ---------- A tela ----------

export async function mount(area, ctx) {
  const sheet = attachSheet();
  ctx.title('Kanban');
  let view = viewFromUrl(location.search);
  let reading = 0; // descarta resposta de leitura velha
  let boardInFlight = false;

  const buttons = Object.fromEntries(
    VIEWS.map((v) => [v, el('button', { type: 'button', 'aria-pressed': String(v === view), onClick: () => switchTo(v) }, v === 'agents' ? 'Agentes' : 'Sessões')]),
  );
  const toggle = el('div', { class: 'kb-seg', role: 'group', 'aria-label': 'Visão do Kanban' }, buttons.agents, buttons.sessions);
  const refresh = el('button', { type: 'button', class: 'btn', onClick: () => draw() }, icon('refresh'), 'Atualizar');
  const head = header({ icon: 'kanban', title: 'Kanban', sub: SUB[view], actions: [toggle, refresh] });
  const sub = head.querySelector('.sub');

  function switchTo(v) {
    if (v === view) return;
    view = v;
    for (const [k, b] of Object.entries(buttons)) b.setAttribute('aria-pressed', String(k === view));
    sub.textContent = SUB[view];
    history.replaceState(history.state, '', `${location.pathname}${viewQuery(view)}`);
    boardInFlight = false;
    draw();
  }

  async function draw() {
    const mine = ++reading;
    const v = view;
    if (!boardInFlight) area.replaceChildren(head, loading({ label: 'Carregando o quadro', blocks: 2 }));
    refresh.disabled = true;
    try {
      const data = await ctx.read(kanbanRoute(v));
      if (mine !== reading) return;
      const columns = Array.isArray(data?.colunas) ? data.colunas : [];
      if (!columns.some((c) => c.total > 0)) {
        boardInFlight = false;
        area.replaceChildren(head, empty(EMPTY[v]));
      } else {
        // A releitura ao vivo não joga a rolagem horizontal para o começo.
        const scroll = boardInFlight ? (area.querySelector('.kb-kanban')?.scrollLeft ?? 0) : 0;
        boardInFlight = true;
        area.replaceChildren(head, board(v, columns));
        const fresh = area.querySelector('.kb-kanban');
        if (fresh) fresh.scrollLeft = scroll;
      }
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== reading) return;
      const text = e?.message ?? String(e);
      if (boardInFlight) {
        // O quadro de antes fica; a faixa diz que esta leitura falhou.
        area.querySelector('.error-band')?.remove();
        head.after(errorBand({ title: 'O quadro não atualizou.', text, action: { label: 'Tentar de novo', onClick: () => draw() } }));
      } else {
        area.replaceChildren(head, error({ text, retry: () => draw() }));
      }
    } finally {
      if (mine === reading) refresh.disabled = false;
    }
  }

  function board(v, columns) {
    return el('div', { class: 'kb-kanban', role: 'region', 'aria-label': v === 'agents' ? 'Agentes por status' : 'Sessões por status', tabindex: '0' }, ...columns.map((c) => column(v, c)));
  }

  function column(v, c) {
    const card = v === 'agents' ? agentCard : sessionCard;
    const color = columnColor(c.id);
    const list = el('div', { class: 'kb-cards' }, ...(c.itens ?? []).map(card));
    const counter = el('span', { class: 'kb-n', 'aria-label': `${c.total} no total` }, String(c.total ?? 0));
    let page = c.pagina ?? 1;
    // A ordem é pela última atividade: entre uma página e a próxima um card pode ter subido ou descido,
    // então o que já está na coluna não entra de novo.
    const seen = new Set((c.itens ?? []).map((i) => i.id));
    let shown = seen.size;
    let hasMore = Boolean(c.temMais);
    const more = el('button', { type: 'button', class: 'kb-more' });

    function setLabel(text = null) {
      const n = missing({ total: Number(counter.textContent) }, shown);
      more.hidden = !hasMore || n === 0;
      more.textContent = text ?? `mostrar mais ${n}`;
    }

    more.addEventListener('click', async () => {
      const ofThis = reading;
      more.disabled = true;
      setLabel('carregando…');
      try {
        const r = await ctx.read(kanbanRoute(v, c.id, page + 1));
        if (ofThis !== reading) return; // o quadro foi relido nesse meio-tempo
        const col = r?.colunas?.find((x) => x.id === c.id);
        if (!col) throw new Error('a coluna não veio');
        const newOnes = (col.itens ?? []).filter((i) => !seen.has(i.id));
        for (const i of newOnes) seen.add(i.id);
        list.append(...newOnes.map(card));
        shown += newOnes.length;
        page = col.pagina ?? page + 1;
        hasMore = Boolean(col.temMais);
        counter.textContent = String(col.total ?? counter.textContent);
        setLabel();
      } catch (e) {
        if (e?.name === 'AbortError' || ofThis !== reading) return;
        setLabel('não carregou · tentar de novo');
      } finally {
        more.disabled = false;
      }
    });
    setLabel();

    return el(
      'section',
      { class: 'kb-col', 'aria-label': `${c.rotulo}: ${c.total}` },
      el('h2', { class: 'kb-head' }, el('span', { class: `kb-dot kb-d-${color}` }), el('span', { class: `kb-c-${color}`, title: c.rotulo }, c.rotulo), counter),
      list,
      more,
    );
  }

  // Ao vivo: junta as mudanças de sessão numa releitura só.
  let wait = null;
  ctx.onChange((changes) => {
    if (!touchesBoard(changes)) return;
    clearTimeout(wait);
    wait = setTimeout(() => draw(), 400);
  });
  ctx.onRestart(() => draw());

  // A limpeza vale mesmo se a pessoa sair antes da primeira leitura voltar.
  ctx.signal.addEventListener('abort', () => {
    clearTimeout(wait);
    sheet.remove();
  });
  await draw();
}

/** Põe `kanban.css` no <head>, uma vez só; devolve o <link> para a limpeza. */
function attachSheet() {
  const already = document.head.querySelector('link[data-screen="kanban"]');
  if (already) return already;
  const link = el('link', { rel: 'stylesheet', href: '/ui/kanban.css', 'data-screen': 'kanban' });
  document.head.append(link);
  return link;
}
