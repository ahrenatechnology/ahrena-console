// Dashboard (C1, #27): os seis números, "precisam de você" em destaque, os agentes ativos com os
// subagentes e a atividade recente. Lê `GET /api/dashboard` e `GET /api/attention` (#87).
// issue 245: the inbox counts only the blocked sessions (`blocked` of the attention, the menu bar number);
// the idle ones go to a neutral row below it, with the reason in a light chip.
//
// As funções sem DOM (formatação e o que cada parte mostra) saem exportadas para o teste.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { lastAvailability, loadAvailability, messageAction, useMessageStyle } from './session-message.js';
import { attentionOf, attentionOfItem, attentionPill, attentionTone, attentionDot, isBlocked, isIdle, reasonChip, statusWithoutAttention } from '../attention.js';
import { sessionOrigin } from '../session-origin.js';
import { openAction } from '../open-action.js';
import { newSessionButton } from '../new-session.js';
import { attentionForChoice, createMachineFilter, isRemote, itemHref, itemKey, machineTag, remoteParts, sessionHref, whereText } from '../machine-filter.js';

const STYLE = '/ui/dashboard.css';
// As rotas do núcleo, num lugar só. A da atenção é a `ATTENTION_ROUTE` de src/api/attention-route.ts (#87):
// se o nome mudar lá, muda aqui.
export const DASHBOARD_ROUTE = '/api/dashboard';
export const ATTENTION_ROUTE = '/api/attention';
/** Releitura depois de uma rajada de mudanças, e a releitura de fundo das idades ("2 min"). */
const DEBOUNCE_MS = 400;
const BACKGROUND_MS = 30_000;
const IN_INBOX = 5;
const IN_IDLE_ROW = 3;

export const STATUS_LABEL = { active: 'Ativa', completed: 'Concluída', error: 'Com erro', abandoned: 'Abandonada' };
// A subagent has no attention of its own (issue 245): a waiting one does not wait on the person, so it is active.
const SUBAGENT_STATUS = { working: 'active', waiting: 'active', completed: 'completed', error: 'error' };
/** The sessions screen filtered on the idle ones, and on the blocked ones. */
export const IDLE_SESSIONS_HREF = '/ui/sessions?status=idle';
export const BLOCKED_SESSIONS_HREF = '/ui/sessions?status=blocked';

// ---------- Formatação ----------

const decimal1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pt-BR');
const dollar = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 412 → "412"; 3200 → "3,2 mil"; 48100 → "48,1 mil"; 2,1 milhões → "2,1 mi". */
export function quantity(n) {
  if (n < 1000) return integer.format(n);
  if (n < 1_000_000) return `${decimal1.format(n / 1000)} mil`;
  return `${decimal1.format(n / 1_000_000)} mi`;
}

/** Sempre com "~": é estimativa. `null` é "sem preço". */
export const cost = (usd) => (usd === null || usd === undefined ? '~US$ —' : `~US$ ${dollar.format(usd)}`);

/** Há quanto tempo, curto: "agora", "12 s", "2 min", "1 h", "3 d". */
export function age(iso, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** "claude-opus-5-5" → "Opus 5.5"; o que não reconhece sai como veio. */
export function modelName(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const inSessions = (n) => `em ${plural(n, 'sessão', 'sessões')}`;

/**
 * Os seis cards, na ordem do C1. Issue 243 (C47): with Todas and a remote, `byMachine` and `machines` say how
 * many are the remote's: "3 na Workstation · 5 precisam de você", "em 4 sessões · 1 na Workstation".
 */
export function cards(numbers, { byMachine = null, machines = [] } = {}) {
  const { sessions, agents, subagents, events, cost: c } = numbers;
  const remoteSessions = remoteParts(byMachine, machines, (b) => b.numbers?.sessions?.total);
  const remoteAgents = remoteParts(byMachine, machines, (b) => b.numbers?.agents?.active);
  return [
    { id: 'sessions', rotulo: 'Sessões', icone: 'sessions', cor: 'accent', valor: integer.format(sessions.total), extra: `${sessions.active} ${sessions.active === 1 ? 'ativa' : 'ativas'}`, sub: [...remoteSessions, sessionsDetail(sessions)].join(' · ') },
    { id: 'agents', rotulo: 'Agentes ativos', icone: 'bot', cor: 'active', valor: integer.format(agents.active), sub: [inSessions(agents.sessions), ...remoteAgents].join(' · ') },
    { id: 'subagents', rotulo: 'Subagentes ativos', icone: 'subagent', cor: 'accent', valor: integer.format(subagents.active), sub: inSessions(subagents.sessions) },
    { id: 'events-today', rotulo: 'Eventos hoje', icone: 'events', cor: 'waiting', valor: quantity(events.today), sub: `+${quantity(events.lastHour)} na última hora` },
    { id: 'events-total', rotulo: 'Eventos no total', icone: 'activity', cor: 'muted', valor: quantity(events.total), sub: 'desde a importação' },
    {
      id: 'cost',
      rotulo: 'Custo',
      icone: 'cost',
      cor: 'completed',
      valor: cost(c.usd),
      sub: c.usd === null ? `sem preço para ${c.unpriced.join(', ')}` : `estimativa · ${c.days} dias`,
    },
  ];
}

/** "5 precisam de você · 3 ociosas"; without either, "ninguém precisa de você". */
export function sessionsDetail(sessions) {
  const blocked = Number(sessions.blocked) || 0;
  const idle = Number(sessions.idle) || 0;
  const parts = [blocked ? `${blocked} ${blocked === 1 ? 'precisa' : 'precisam'} de você` : null, idle ? `${idle} ${idle === 1 ? 'ociosa' : 'ociosas'}` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'ninguém precisa de você';
}

/** The blocked items of `/api/attention`, in its order (the oldest wait first). */
export const blockedItems = (attention) => (attention?.items ?? []).filter((i) => isBlocked(attentionOfItem(i)));
/** The idle items of `/api/attention`. */
export const idleItems = (attention) => (attention?.items ?? []).filter((i) => isIdle(attentionOfItem(i)));
/** How many need you: the `blocked` number of the route, or the blocked items. */
export const blockedCount = (attention) => (Number.isInteger(attention?.blocked) ? attention.blocked : blockedItems(attention).length);
/** How many are idle: the `idle` number of the route, or the idle items. */
export const idleCount = (attention) => (Number.isInteger(attention?.idle) ? attention.idle : idleItems(attention).length);

/**
 * Os cartões do "precisam de você": a ordem e o texto da `/api/attention`; o pedido ("Bash: npm run
 * migrate") e o modelo vêm do card do agente, quando a sessão está entre os ativos.
 */
export function inboxCards(attention, agents) {
  // By machine and session (issue 243): a remote agent with the same session id is another session.
  const bySession = new Map((agents ?? []).map((a) => [itemKey(a, (x) => x.session), a]));
  return blockedItems(attention).slice(0, IN_INBOX).map((i) => {
    const machine = isRemote(i) ? { id: i.machine.id, label: typeof i.machine.label === 'string' && i.machine.label ? i.machine.label : 'Máquina remota' } : null;
    const a = bySession.get(itemKey({ id: i.session, machine }));
    return {
      session: i.session,
      identity: i.identity ?? a?.identity,
      attention: attentionOfItem(i),
      age: i.minutes < 1 ? 'agora' : `${i.minutes} min`,
      name: i.project ?? i.title,
      text: (i.reason === 'permission' && a?.task) || i.longReason,
      // C47: the remote card's machine is the server icon beside the project; the foot is the model, as for a local one.
      foot: modelName(a?.model) ?? i.account?.label ?? '',
      machine,
      // Issue 243 (C49): a remote session's Detail is read through the tunnel, with `?machine=<id>`.
      href: sessionHref(i.session, machine?.id),
      // issue 285: where the session opens (`{ target, command }`), for the icon beside "Abrir ›".
      open: i.open ?? null,
    };
  });
}

export const inboxTitle = (total) => (total === 0 ? 'Ninguém precisa de você agora' : `${total} ${total === 1 ? 'precisa' : 'precisam'} de você`);
export const idleTitle = (total) => `${total} ${total === 1 ? 'ociosa' : 'ociosas'}`;

/** The idle row: the reason and the project of the first ones. */
export function idleChips(attention) {
  return idleItems(attention)
    .slice(0, IN_IDLE_ROW)
    .map((i) => ({ session: i.session, key: itemKey({ id: i.session, machine: i.machine }), attention: attentionOfItem(i), name: i.project ?? i.title ?? '' }));
}

// ---------- Peças ----------

const badge = (status) => el('span', { class: `badge b-${status}` }, el('span', { class: 'p' }), STATUS_LABEL[status] ?? '');

/**
 * The pill of a card or a row: the attention when there is one (Precisa de você, Ociosa, Com erro);
 * a waiting one without it does not wait on the person and is active; the rest by status.
 */
export function statusPill(status, attention) {
  if (attentionOf(attention)) return attentionPill(attention);
  return badge(statusWithoutAttention(status));
}

/** The edge color of an agent card: the attention tone, or the status (waiting without attention is active). */
const cardTone = (status, attention) => attentionTone(attention) ?? statusWithoutAttention(status);

/** The edge class of an agent card: the two attention tones carry the screen prefix, the legacy ones keep `st-`. */
export function cardToneClass(status, attention) {
  const tone = cardTone(status, attention);
  return tone === 'blocked' || tone === 'idle' ? `dash-st-${tone}` : `st-${tone}`;
}

function numberCard(c) {
  return el(
    'div',
    { class: 'card stat', 'data-card': c.id },
    el('span', { class: 'label' }, c.rotulo),
    el('span', { class: `ic color-${c.cor}` }, icon(c.icone)),
    el('span', { class: 'v' }, c.valor, c.extra ? el('small', {}, c.extra) : null),
    el('span', { class: 's' }, c.sub),
  );
}

function inbox(attention, agents, write, navigate = () => {}) {
  const total = blockedCount(attention);
  const title = el(
    'div',
    { class: 'ttl' },
    icon('bell'),
    el('span', { class: total ? 'c-waiting' : 'c-dim' }, inboxTitle(total)),
    el('a', { class: 'r', href: BLOCKED_SESSIONS_HREF }, 'travadas até você agir · quem espera há mais tempo primeiro', icon('chevron-right')),
  );
  if (!total) return el('section', { class: 'card inbox calm', 'aria-label': 'Precisam de você' }, title);
  const mini = inboxCards(attention, agents).map((c) => {
    // #61 (C53): with the availability known, the foot has "Mandar mensagem" (or "sem processo vivo")
    // beside the open icon and "Abrir ›", and the age goes up beside the reason; unknown, it is the C1 foot.
    // A remote session's process runs over there: this core has no availability for it.
    const known = c.machine ? undefined : lastAvailability(c.session);
    const action = known ? messageAction(c.session, known, navigate, { variant: 'link' }) : null;
    const withAction = known !== undefined && known !== null;
    const lead = withAction
      ? (action ?? el('span', {}, ''))
      : el('span', { class: 'trunc' }, [c.foot, c.age].filter(Boolean).join(' · '));
    // C47: a remote card names its machine with the server icon beside the project, the label in the tooltip.
    const tag = c.machine ? machineTag({ machine: c.machine }, { iconOnly: true }) : null;
    return el(
      'div',
      { class: `card mini dash-mini${withAction ? ' dash-mini-sm' : ''}`, 'data-session': c.session, 'data-machine': c.machine?.id, 'data-key': itemKey({ id: c.session, machine: c.machine }) },
      el('div', { class: 'l1' }, reasonChip(c.attention, { withError: true }), withAction ? el('span', { class: 'age' }, c.age) : null),
      tag ? el('div', { class: 'n mf-with-tag' }, el('span', { class: 'mf-shrink' }, c.name), tag) : el('div', { class: 'n trunc' }, c.name),
      el('div', { class: 'x trunc' }, c.text),
      // C1 (issue 245): the model and the age in the foot, "Opus 5.5 · 2 min", beside "Abrir ›".
      el('div', { class: 'foot' }, sessionOrigin(c.identity?.provider), lead, c.href ? miniActions(c, write) : null),
    );
  });
  return el('section', { class: 'card inbox', 'aria-label': 'Precisam de você' }, title, el('div', { class: 'grid4' }, ...mini));
}

/**
 * C71 (issue 285): the icon that opens the session where it runs, then "Abrir ›", the link to the
 * Detail stretched over the whole card (the card is a div, so the button is never inside a link).
 * A remote card has neither: its foot already names the machine, and this core has no Detail for it.
 */
function miniActions(c, write) {
  return el(
    'span',
    { class: 'dash-mini-actions' },
    openAction({ id: c.session, open: c.open, machine: c.machine }, { size: 'icon', write, machine: c.machine?.label ?? null }),
    // Each link says which session it opens, not five "Abrir ›" in a row.
    el('a', { class: 'dash-open-link', href: c.href, 'aria-label': c.name ? `Abrir ${c.name}` : 'Abrir a sessão' }, 'Abrir ›'),
  );
}

/** The idle ones, apart and neutral: "3 ociosas · sem pressa", a light chip per session and the link. */
function idleRow(attention) {
  const total = idleCount(attention);
  if (!total) return null;
  return el(
    'section',
    { class: 'card dash-idle', 'aria-label': 'Ociosas' },
    el('span', { class: 'dash-idle-title' }, attentionDot('idle'), el('b', {}, idleTitle(total)), ' · sem pressa'),
    ...idleChips(attention).map((c) => el('span', { class: 'dash-idle-item', 'data-session': c.session, 'data-key': c.key }, reasonChip(c.attention), el('span', { class: 'mono trunc' }, c.name))),
    el('a', { class: 'dash-idle-link', href: IDLE_SESSIONS_HREF }, 'Ver em Sessões', icon('chevron-right')),
  );
}

/** The DOM id of an agent's subagent list: the key of its session (issue 243), safe for an id. */
const subsId = (a) => `subs-${itemKey(a, (x) => x.session).replace(/[^A-Za-z0-9_-]/g, '-')}`;

function tree(a) {
  return el(
    'ul',
    { class: 'tree', id: subsId(a) },
    ...a.subagents.map((s) =>
      el(
        'li',
        { class: 'card child', 'data-subagent': s.id },
        el('span', { class: 'av' }, icon('subagent')),
        el('div', { class: 'trunc' }, el('b', {}, s.type ?? 'Subagente'), s.task ? el('span', { class: 'meta' }, ` · ${s.task}`) : null),
        el('span', { class: 'age' }, age(s.until ?? s.since)),
        statusPill(SUBAGENT_STATUS[s.status] ?? 'active', null),
      ),
    ),
  );
}

function agentCard(a, expanded, toggleOne) {
  const n = a.subagents.length;
  const key = itemKey(a, (x) => x.session);
  const isOpen = n > 0 && expanded.has(key);
  const activeCount = a.subagents.filter((s) => s.status === 'working').length;
  const exp = n
    ? el('button', { type: 'button', class: `exp${isOpen ? ' open' : ''}`, 'aria-expanded': String(isOpen), 'aria-controls': subsId(a), 'aria-label': isOpen ? 'Esconder os subagentes' : 'Mostrar os subagentes', onClick: () => toggleOne(key) }, icon('chevron-right'))
    : el('span', { class: 'exp' }, icon('dot'));
  const messages = a.messages.length ? a.messages : ['(sem mensagens)'];
  const card = el(
    'a',
    { class: `card ac ${cardToneClass(a.status, a.attention)}`, href: itemHref(a, a.session), 'data-session': a.session, 'data-key': key },
    el(
      'div',
      { class: 'l1' },
      el('span', { class: 'av' }, icon('bot')),
      el(
        'div',
        { class: 'trunc' },
        el('div', { class: 'tt trunc' }, `Agente principal · ${a.title}`),
        // C47: a remote agent's tag beside the meta line, which truncates instead of the tag.
        isRemote(a)
          ? el('div', { class: 'meta mf-with-tag' }, el('span', { class: 'mf-shrink' }, [a.project, plural(n, 'subagente', 'subagentes'), plural(a.turns, 'turno', 'turnos')].filter(Boolean).join(' · ')), machineTag(a))
          : el('div', { class: 'meta trunc' }, [a.project, plural(n, 'subagente', 'subagentes'), plural(a.turns, 'turno', 'turnos')].filter(Boolean).join(' · ')),
      ),
      statusPill(a.status, a.attention),
    ),
    el('blockquote', {}, ...messages.map((m) => el('span', { class: 'trunc' }, m))),
    el(
      'div',
      { class: 'footer' },
      a.model ? el('span', {}, icon('model'), modelName(a.model)) : null,
      el('span', {}, icon('coins'), cost(a.costUsd)),
      el('span', {}, icon('clock'), age(a.lastActivity)),
      a.task ? el('span', { class: 'trunc task' }, a.task) : null,
      el('span', { class: 'id' }, a.session.slice(0, 8)),
    ),
  );
  const subs = n
    ? el('button', { type: 'button', class: 'subs', 'aria-expanded': String(isOpen), 'aria-controls': subsId(a), onClick: () => toggleOne(key) }, icon('subagent'), plural(n, 'subagente', 'subagentes'), activeCount && activeCount < n ? ` · ${activeCount} ${activeCount === 1 ? 'ativo' : 'ativos'}` : null)
    : null;
  return el('div', { class: 'agent' }, exp, el('div', { class: 'column' }, card, subs, isOpen ? tree(a) : null));
}

function activeAgents(agents, expanded, toggleOne) {
  const title = el('div', { class: 'ttl' }, 'Agentes ativos');
  if (!agents.length) return el('div', { class: 'column' }, title, empty({ icon: 'bot', title: 'Nenhum agente ativo', text: 'Quando uma sessão estiver aberta, o agente dela aparece aqui.' }));
  return el('div', { class: 'column' }, title, ...agents.map((a) => agentCard(a, expanded, toggleOne)));
}

function recentActivity(activity) {
  const title = el('div', { class: 'ttl' }, 'Atividade recente', el('a', { class: 'r', href: '/ui/sessions' }, 'Ver tudo', icon('arrow-right')));
  if (!activity.length) return el('div', { class: 'column' }, title, empty({ icon: 'activity', title: 'Nada ainda', text: 'Os eventos das sessões aparecem aqui assim que chegam.' }));
  return el(
    'div',
    { class: 'column' },
    title,
    el(
      'div',
      { class: 'card rows' },
      ...activity.map((l) =>
        el(
          'a',
          { class: 'row', href: itemHref(l, l.session), 'data-session': l.session, 'data-key': itemKey(l, (x) => x.session) },
          statusPill(l.status, l.attention),
          el('span', { class: 'trunc' }, l.text),
          l.project ? el('span', { class: 'o mono trunc' }, l.project) : null,
          // C47: only the server icon in a recent activity row, the machine in the tooltip.
          machineTag(l, { iconOnly: true }),
          el('span', { class: 't' }, age(l.at)),
        ),
      ),
    ),
  );
}

function useStyle() {
  if (document.querySelector(`link[href="${STYLE}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLE }));
}

// ---------- A tela ----------

export async function mount(area, ctx) {
  useStyle();
  useMessageStyle();
  const refresh = el('button', { type: 'button', class: 'btn', onClick: () => draw() }, icon('refresh'), 'Atualizar');
  const head = header({ icon: 'dashboard', title: 'Dashboard', sub: 'O agora das suas sessões', actions: [refresh, newSessionButton({ read: ctx.read, write: ctx.write })] });
  const sub = head.querySelector?.('.sub') ?? null;
  // Issue 243 (C47): the machine filter on its own row under the header. The Dashboard's own background
  // re-read (BACKGROUND_MS) and its re-read on every change already cover the remotes: the filter adds no
  // timer and no debounce of its own (the slow /api/dashboard is never read twice for one tick).
  const machines = createMachineFilter(ctx, {
    onChange: () => ((last = null), area.replaceChildren(head, ...machines.parts(), loading({ label: 'Lendo as sessões' })), draw()),
    onLayout: () => last && paint(last),
    periodic: false,
    watchChanges: false,
  });
  area.replaceChildren(head, loading({ label: 'Lendo as sessões' }));

  const expanded = new Set();
  let last = null;
  let request = 0;

  function toggleOne(session) {
    if (expanded.has(session)) expanded.delete(session);
    else expanded.add(session);
    if (last) paint(last);
  }

  function paint({ dashboard, atencao: attention }) {
    const all = machines.choice === 'all';
    if (sub) sub.textContent = machines.hasRemotes() ? `O agora das suas sessões, ${whereText(machines.choice, machines.machines())}` : 'O agora das suas sessões';
    const parts = [head, ...machines.parts(), el('div', { class: 'stats' }, ...cards(dashboard.numbers, all ? { byMachine: dashboard.byMachine, machines: machines.machines() } : {}).map(numberCard))];
    // `/api/attention` covers every machine: the inbox keeps the chosen one's.
    const chosen = attention.ok ? attentionForChoice(attention.valor, machines.choice) : null;
    if (attention.ok) parts.push(inbox(chosen, dashboard.agents, ctx.write, ctx.navigate), idleRow(chosen));
    else parts.push(errorBand({ title: 'Não deu para ler quem precisa de você.', text: attention.erro.message, action: { label: 'Tentar de novo', onClick: () => draw() } }));
    parts.push(el('div', { class: 'two' }, activeAgents(dashboard.agents, expanded, toggleOne), recentActivity(dashboard.activity)));
    area.replaceChildren(...parts.filter(Boolean));
  }

  async function draw() {
    const mine = ++request;
    const [d, a] = await Promise.allSettled([ctx.read(machines.route(DASHBOARD_ROUTE)), ctx.read(ATTENTION_ROUTE)]);
    if (mine !== request || ctx.signal.aborted) return;
    if (d.status === 'rejected') {
      if (d.reason?.name === 'AbortError') return;
      if (machines.recover(d.reason)) return;
      last = null;
      area.replaceChildren(head, ...machines.parts(), error({ text: d.reason?.message, retry: () => draw() }));
      return;
    }
    if (a.status === 'rejected' && a.reason?.name === 'AbortError') return;
    const attention = a.status === 'fulfilled' ? { ok: true, valor: a.value } : { ok: false, erro: a.reason };
    // The sidebar number counts only who needs you (issue 245), as the menu bar.
    ctx.counter('dashboard', attention.ok ? blockedCount(attention.valor) : 0);
    machines.update(d.value);
    last = { dashboard: d.value, atencao: attention };
    paint(last);
    // #61: the availability of the local cards of the inbox (at most five), then one more paint.
    if (attention.ok) {
      const ids = inboxCards(attentionForChoice(attention.valor, machines.choice), d.value.agents).filter((c) => !c.machine).map((c) => c.session);
      let changed = false;
      await loadAvailability(ctx.read, ids, () => (changed = true)).catch(() => {});
      if (changed && mine === request && !ctx.signal.aborted && last) paint(last);
    }
  }

  // Uma rajada de mudanças vira uma releitura só.
  let wait = null;
  const rereadSoon = () => {
    clearTimeout(wait);
    wait = setTimeout(() => draw(), DEBOUNCE_MS);
  };
  ctx.onChange(rereadSoon);
  ctx.onRestart(() => draw());
  const background = setInterval(() => draw(), BACKGROUND_MS);

  await draw();
  return () => {
    clearTimeout(wait);
    clearInterval(background);
  };
}
