// Kanban (#31, C9 e C10 do wireframe): as sessões, ou os agentes, em colunas por status. Só leitura.
//
// - The view comes from the query (`/ui/kanban?view=agents`; without it, sessions). Switching the
//   view rewrites the URL with `history.replaceState`, without reloading, and re-reads.
// - `GET /api/kanban?view=<v>` brings every column on page 1; "mostrar mais" asks for
//   `&column=<id>&page=<n>` and appends the items at the end of the column.
// - Ao vivo: uma mudança de sessão relê o quadro (com um respiro de 400 ms, para juntar rajadas);
//   reset relê. A releitura volta cada coluna à página 1.
// - O estilo está em `ui/kanban.css`, que a tela põe no <head> ao montar e tira ao sair.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { attentionBadges, attentionOf, attentionTone, statusWithoutAttention } from '../attention.js';
import { createMachineFilter, itemHref, itemKey, isRemote, machineTag, queryWithMachine, whereText } from '../machine-filter.js';

// ---------- Funções puras (testadas em test/api/ui-kanban.test.ts) ----------

export const VIEWS = ['sessions', 'agents'];

/** A visão pedida na query; qualquer outra coisa é `sessions`. */
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

/**
 * Status da sessão ou do agente → a cor (classe) e o rótulo do selo. O agente "working" é ativo. The
 * waiting ones are drawn by their `attention` (issue 245): "Precisa de você" or "Ociosa".
 */
const STATUS = {
  active: { cor: 'active', rotulo: 'Ativa' },
  working: { cor: 'active', rotulo: 'Ativa' },
  completed: { cor: 'completed', rotulo: 'Concluída' },
  error: { cor: 'error', rotulo: 'Com erro' },
  abandoned: { cor: 'abandoned', rotulo: 'Abandonada' },
};

export function status(st) {
  return STATUS[st] ?? { cor: 'abandoned', rotulo: '—' };
}

/** The card's tone: the attention (blocked, idle, error) first, then the status; waiting without attention is active. */
export function cardTone(item) {
  return attentionTone(item?.attention) ?? status(statusWithoutAttention(item?.status)).cor;
}

/** A cor da coluna, pelo id dela (as duas visões; os ids são os da API, em inglês desde a issue 173). */
const COLUMN_COLOR = {
  active: 'active',
  working: 'active',
  blocked: 'blocked',
  idle: 'idle',
  completed: 'completed',
  done: 'completed',
  error: 'error',
  abandoned: 'abandoned',
};

export function columnColor(id) {
  return COLUMN_COLOR[id] ?? 'abandoned';
}

/** Quantos faltam mostrar numa coluna. */
export function missing(column, shown) {
  return Math.max(0, (column?.total ?? 0) - shown);
}

/** Uma mudança do long polling que mexe no quadro. */
const TYPES_THAT_MATTER = new Set(['session', 'state', 'needs-you']);
export function touchesBoard(changes) {
  return Array.isArray(changes) && changes.some((m) => TYPES_THAT_MATTER.has(m?.type));
}

// ---------- Peças ----------

const SUB = {
  sessions: 'As sessões por status, só leitura',
  agents: 'Os agentes por status, só leitura',
};

/** The empty board; `where` is where its sessions would start (issue 243: "em uma das máquinas" with Todas). */
const emptyFor = (view, where = 'nesta máquina') =>
  view === 'agents'
    ? { title: 'Nenhum agente ainda', text: `Quando uma sessão do Claude Code começar ${where}, os agentes dela aparecem aqui.` }
    : { title: 'Nenhuma sessão ainda', text: `Quando uma sessão do Claude Code começar ${where}, ela aparece aqui.` };

/** Where each view's items come from, with a remote known (issue 243): "As sessões das duas máquinas…". */
function subWith(view, of) {
  return `${view === 'agents' ? 'Os agentes' : 'As sessões'} ${of} por status, só leitura`;
}

function badges(item) {
  if (attentionOf(item.attention)) return el('div', { class: 'kb-badges' }, ...attentionBadges(item.attention));
  const s = status(statusWithoutAttention(item.status));
  return el('div', { class: 'kb-badges' }, el('span', { class: `kb-badge-st kb-b-${s.cor}` }, el('span', { class: 'kb-p' }), s.rotulo));
}

function avatar(name) {
  return el('span', { class: 'kb-av' }, icon(name));
}

function info(iconName, text, className = null) {
  return el('span', { class: className }, icon(iconName), el('span', { class: 'kb-t' }, text));
}

function sessionCard(s) {
  const cost = formatCost(s.costUsd);
  // C46: the card is narrow, so a remote one swaps the folder icon for the server's, the machine in the tooltip.
  const lead = isRemote(s) ? el('span', { class: 'kb-av' }, machineTag(s, { iconOnly: true })) : avatar('folder');
  return el(
    'a',
    { class: `card kb-kc kb-st-${cardTone(s)}`, href: itemHref(s), title: s.title || null, 'data-key': itemKey(s) },
    el('div', { class: 'kb-l1' }, lead, el('div', { class: 'kb-name' }, el('div', { class: 'kb-tt' }, s.title || '(sem título)'), el('small', {}, shortId(s.id)))),
    badges(s),
    s.lastPrompt ? el('blockquote', {}, s.lastPrompt) : null,
    s.cwd ? el('div', { class: 'kb-cwd' }, s.cwd) : null,
    el(
      'div',
      { class: 'kb-foot' },
      info('bot', agentsLabel(s.agents)),
      s.model ? info('model', s.model) : null,
      cost ? info('coins', cost) : null,
      info('duration', formatDuration(s.durationMs), s.running ? 'kb-dur kb-running' : 'kb-dur'),
    ),
  );
}

function agentCard(a) {
  return el(
    'a',
    // C46: no tag on an agent card (the tag is the session's), but it opens the right machine's Detail.
    { class: `card kb-kc kb-agent kb-st-${cardTone(a)}`, href: itemHref(a, a.sessionId), 'data-key': itemKey(a), title: a.description || a.name || null },
    el('div', { class: 'kb-l1' }, avatar(a.main ? 'bot' : 'subagent'), el('div', { class: 'kb-name' }, el('div', { class: 'kb-tt' }, a.name || '(sem nome)'), a.description ? el('small', {}, a.description) : null)),
    badges(a),
    el('div', { class: 'kb-foot' }, a.model ? info('model', a.model) : null, info('duration', formatDuration(a.durationMs), a.running ? 'kb-dur kb-running' : 'kb-dur')),
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
  // Issue 243 (C46): the machine filter on its own row under the header; both views follow it.
  const machines = createMachineFilter(ctx, { onChange: () => ((boardInFlight = false), draw()), reread: () => draw(), onLayout: () => draw() });
  const subText = () => (machines.hasRemotes() ? subWith(view, whereText(machines.choice, machines.machines(), { form: 'of' })) : SUB[view]);

  function switchTo(v) {
    if (v === view) return;
    view = v;
    for (const [k, b] of Object.entries(buttons)) b.setAttribute('aria-pressed', String(k === view));
    sub.textContent = subText();
    history.replaceState(history.state, '', `${location.pathname}${queryWithMachine(viewQuery(view), machines.choice)}`);
    boardInFlight = false;
    draw();
  }

  async function draw() {
    const mine = ++reading;
    const v = view;
    if (!boardInFlight) area.replaceChildren(head, ...machines.parts(), loading({ label: 'Carregando o quadro', blocks: 2 }));
    refresh.disabled = true;
    try {
      const data = await ctx.read(machines.route(kanbanRoute(v)));
      if (mine !== reading) return;
      machines.update(data);
      sub.textContent = subText();
      const columns = Array.isArray(data?.columns) ? data.columns : [];
      if (!columns.some((c) => c.total > 0)) {
        boardInFlight = false;
        // C48: the chosen remote is down; the notice says why the board is empty.
        area.replaceChildren(head, ...machines.parts(), ...(machines.chosenDown() ? [] : [empty(emptyFor(v, machines.hasRemotes() ? whereText(machines.choice, machines.machines(), { form: 'any' }) : undefined))]));
      } else {
        // A releitura ao vivo não joga a rolagem horizontal para o começo.
        const scroll = boardInFlight ? (area.querySelector('.kb-kanban')?.scrollLeft ?? 0) : 0;
        boardInFlight = true;
        area.replaceChildren(head, ...machines.parts(), board(v, columns));
        const fresh = area.querySelector('.kb-kanban');
        if (fresh) fresh.scrollLeft = scroll;
      }
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== reading) return;
      if (machines.recover(e)) return;
      const text = e?.message ?? String(e);
      if (boardInFlight) {
        // O quadro de antes fica; a faixa diz que esta leitura falhou.
        area.querySelector('.error-band')?.remove();
        (machines.parts().at(-1) ?? head).after(errorBand({ title: 'O quadro não atualizou.', text, action: { label: 'Tentar de novo', onClick: () => draw() } }));
      } else {
        area.replaceChildren(head, ...machines.parts(), error({ text, retry: () => draw() }));
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
    const list = el('div', { class: 'kb-cards' }, ...(c.items ?? []).map(card));
    const counter = el('span', { class: 'kb-n', 'aria-label': `${c.total} no total` }, String(c.total ?? 0));
    let page = c.page ?? 1;
    // A ordem é pela última atividade: entre uma página e a próxima um card pode ter subido ou descido,
    // então o que já está na coluna não entra de novo.
    // Issue 243: the ids of two machines can repeat, so the key is machine + id.
    const seen = new Set((c.items ?? []).map((i) => itemKey(i)));
    let shown = seen.size;
    let hasMore = Boolean(c.hasMore);
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
        const r = await ctx.read(machines.route(kanbanRoute(v, c.id, page + 1)));
        if (ofThis !== reading) return; // o quadro foi relido nesse meio-tempo
        const col = r?.columns?.find((x) => x.id === c.id);
        if (!col) throw new Error('a coluna não veio');
        const newOnes = (col.items ?? []).filter((i) => !seen.has(itemKey(i)));
        for (const i of newOnes) seen.add(itemKey(i));
        list.append(...newOnes.map(card));
        shown += newOnes.length;
        page = col.page ?? page + 1;
        hasMore = Boolean(col.hasMore);
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
      { class: `kb-col${color === 'idle' ? ' kb-col-idle' : ''}`, 'aria-label': `${c.label}: ${c.total}` },
      el('h2', { class: 'kb-head' }, el('span', { class: `kb-dot kb-d-${color}` }), el('span', { class: `kb-c-${color}`, title: c.label }, c.label), counter),
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
