// O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes (C4), Conversa (C5) e Linha do
// tempo (C6), sobre `GET /api/sessions/<id>…` (src/api/session-detail.ts). Workflow e Decisões não entram
// nesta versão.
//
// Tudo o que vem do núcleo, e o texto da conversa mais ainda, é conteúdo não confiável: entra por
// `textContent` (`el()`), nunca como HTML.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { openAction } from '../open-action.js';
import { create as workflowTab } from './session-detail-workflow.js';
import { create as decisionsTab } from './session-detail-decisions.js';
import { createComposeBox } from './session-message.js';
import { messageBody } from './chat-text.js';
import { downNotice, isMachineUnreachable, LOCAL, machineFromQuery, normalizeMachines, readAgeText, REMOTE_REREAD_MS, routeWithMachine, touchesRemotes, withQuery } from '../machine-filter.js';
import { attentionOf, attentionPill, isBlocked, isIdle, reasonChip, reasonLabel, attentionDot, statusWithoutAttention } from '../attention.js';

// ---------- Formatos ----------

const NUM = new Intl.NumberFormat('pt-BR');
const DEC = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HOUR = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

const num = (n) => NUM.format(n);
const usd = (v) => (v === null || v === undefined ? 'sem preço' : `~US$ ${USD.format(v)}`);

/** 6.000.000 → "6,0 M"; 230.000 → "230 k"; 4.100 → "4,1 k". */
function tokens(n) {
  if (n >= 1e6) return `${DEC.format(n / 1e6)} M`;
  if (n >= 1e4) return `${num(Math.round(n / 1e3))} k`;
  if (n >= 1e3) return `${DEC.format(n / 1e3)} k`;
  return num(n);
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelName(id) {
  if (!id) return null;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** 40 s, 12 min, 1 h 05 min. */
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "agora", "2 min", "3 h", "2 d". */
function ago(iso, now = Date.now()) {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

/** "hoje, 22:41", "ontem, 09:10" ou "18/10, 09:10". */
function when(iso, now = new Date()) {
  const d = new Date(iso);
  const day = (x) => x.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const prefix = day(d) === day(now) ? 'hoje' : day(d) === day(yesterday) ? 'ontem' : DAY.format(d);
  return `${prefix}, ${HOUR.format(d)}`;
}

// issue 245: a waiting session, agent or event is drawn by its attention ("Precisa de você" or "Ociosa").
const STATUS = { active: 'Ativa', working: 'Ativa', error: 'Com erro', completed: 'Concluída', abandoned: 'Abandonada' };
const COLOR = { active: 'active', working: 'active', error: 'error', completed: 'completed', abandoned: 'abandoned' };
/** The timeline's status filter: the core's `waiting` takes both the blocked and the idle events. */
const STATUS_FILTER = { ...STATUS, waiting: 'Precisa de você ou ociosa' };

/** The pill: the attention when there is one; a waiting one without it is active; the rest by status. */
function statusPill(status, attention = null) {
  if (attentionOf(attention)) return attentionPill(attention);
  const st = statusWithoutAttention(status);
  return el('span', { class: `sd-status sd-s-${COLOR[st] ?? 'abandoned'}` }, STATUS[st] ?? '—');
}

/** The idle line (issue 245): no band, only what happened and since when. */
export function idleNote(attention, since, now = Date.now()) {
  const when = since ? ago(since, now).replace('agora', 'menos de 1 min') : null;
  const what = {
    turn_ended: when ? `o turno terminou há ${when} e a vez é sua` : 'o turno terminou e a vez é sua',
    interrupted: when ? `interrompida há ${when}, no meio do turno` : 'interrompida no meio do turno',
    first_prompt: when ? `aberta no prompt há ${when}, sem o primeiro pedido` : 'aberta no prompt, sem o primeiro pedido',
  }[attentionOf(attention)?.reason ?? ''];
  return `Ociosa · ${what ?? 'a vez é sua'}. Nada trava a sessão.`;
}

/** Texto com `código` entre crases: cada pedaço vira nó de texto ou `<code>`, nunca HTML. */
function withCode(text) {
  const parts = String(text ?? '').split(/`([^`\n]+)`/);
  return parts.map((p, i) => (i % 2 ? el('code', { class: 'sd-code' }, p) : p));
}

const TOOL_ICON = { Bash: 'terminal', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', Read: 'file', Agent: 'robot', Task: 'robot', Grep: 'search', Glob: 'search', TaskUpdate: 'tasks', TaskCreate: 'tasks', TodoWrite: 'tasks' };

function copyButton(text, label) {
  const b = el('button', { type: 'button', class: 'sd-copy', title: `Copiar ${label}`, 'aria-label': `Copiar ${label}` }, icon('copy'));
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.classList.add('sd-copied');
      setTimeout(() => b.classList.remove('sd-copied'), 1200);
    } catch {}
  });
  return b;
}

function pill(iconName, ...children) {
  return el('span', { class: 'sd-pill mono' }, iconName ? icon(iconName) : null, ...children);
}

// ---------- A tela ----------

// O registro das abas, na ordem da barra. Uma aba nova é uma linha aqui e um módulo em
// `ui/screens/detalhe-<aba>.js` que exporta `criar(ctx, base, { cabeca, rotular })` e devolve
// `{ mostrar(corpo), esconder(), atualizar() }`:
// - `base` é `/api/sessions/<id>`; `cabeca()` é o topo já lido (`GET /api/sessions/<id>`);
// - `rotular(texto)` põe o "(…)" ao lado do nome da aba; `null` tira.
// A aba carrega o próprio CSS, se tiver.
const TABS_LIST = [
  { id: 'agents', rotulo: 'Agentes', icone: 'robot', create: agentsTab },
  { id: 'conversation', rotulo: 'Conversa', icone: 'conversation', create: conversationTab },
  { id: 'timeline', rotulo: 'Linha do tempo', icone: 'list', create: timelineTab },
  { id: 'workflow', rotulo: 'Workflow', icone: 'graph', create: workflowTab },
  { id: 'decisions', rotulo: 'Decisões', icone: 'decision', create: decisionsTab },
];

let cssLoaded = false;
function loadCss() {
  if (cssLoaded || document.querySelector('link[data-screen="session-detail"]')) return;
  cssLoaded = true;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/session-detail.css', 'data-screen': 'session-detail' }));
}

/** Why a remote session's Detail writes nothing here (issue 243): every write of the Detail is local. */
export const REMOTE_READ_ONLY = 'Esta sessão roda em outra máquina: daqui o console só lê.';

/**
 * The Detail's read and write for a remote session (issue 243, C49): every route under `base` goes with
 * `?machine=<id>`; a write is refused before it leaves (this core would write about a local session).
 * `onRead()` is called after a good read, `onUnreachable(machine)` on the 503 `machine-unreachable`.
 * A 503 on a route that already answered becomes a quiet `AbortError` (the tab keeps what it shows);
 * on a route that never answered, an error with the notice's text.
 */
export function remoteDetailContext(ctx, base, machineId, { onRead = () => {}, onUnreachable = () => {} } = {}) {
  const answered = new Set();
  const pathOf = (route) => String(route).split('?')[0];
  const ours = (route) => typeof route === 'string' && (route === base || route.startsWith(`${base}/`) || route.startsWith(`${base}?`));
  return {
    ...ctx,
    async read(route, options) {
      if (!ours(route)) return ctx.read(route, options);
      try {
        const answer = await ctx.read(routeWithMachine(route, machineId), options);
        answered.add(pathOf(route));
        onRead();
        return answer;
      } catch (e) {
        if (!isMachineUnreachable(e)) throw e;
        const m = normalizeMachines([{ ...e.body.machine, id: e.body.machine?.id ?? machineId }])[0] ?? { id: machineId, label: 'Máquina remota', lastReadAt: null };
        onUnreachable(m);
        if (answered.has(pathOf(route))) {
          const quiet = new Error('machine-unreachable');
          quiet.name = 'AbortError';
          throw quiet;
        }
        const told = new Error(`${m.label} sem conexão. As sessões de lá voltam quando ela responder.`);
        Object.assign(told, { status: e.status, body: e.body });
        throw told;
      }
    },
    write: () => Promise.reject(Object.assign(new Error(REMOTE_READ_ONLY), { name: 'WriteError', status: 0 })),
  };
}

export async function mount(area, ctx) {
  loadCss();
  const id = ctx.params.id;
  const base = `/api/sessions/${encodeURIComponent(id)}`;
  // Issue 243 (C49): `?machine=<id>` opens a remote session, read through the tunnel.
  const machineChoice = machineFromQuery(location.search);
  const remoteId = machineChoice && machineChoice !== LOCAL && machineChoice !== 'all' ? machineChoice : null;
  let lastRead = null;
  let down = null;
  const noticeSlot = el('div', { class: 'sd-machine-notice' });
  noticeSlot.hidden = true;
  const sourceLine = el('div', { class: 'sd-source' });
  function drawNotice() {
    noticeSlot.replaceChildren(...(down ? [downNotice(down)] : []));
    noticeSlot.hidden = !down;
  }
  function drawSource() {
    if (!remoteId) return;
    const label = headData?.machine?.label ?? down?.label ?? 'máquina remota';
    sourceLine.replaceChildren(icon('cable'), el('span', {}, `Lida do núcleo da ${label}, pelo túnel${lastRead ? ` · ${readAgeText(Date.now() - lastRead)}` : ''}`));
  }
  if (remoteId) {
    ctx = remoteDetailContext(ctx, base, remoteId, {
      onRead: () => {
        lastRead = Date.now();
        if (down) {
          down = null;
          drawNotice();
        }
        drawSource();
      },
      onUnreachable: (m) => {
        down = m;
        drawNotice();
        drawSource();
      },
    });
  }
  const top = el('div', { class: 'sd-top' });
  const tabs = el('nav', { class: 'sd-tabs', role: 'tablist', 'aria-label': 'Abas da sessão' });
  const body = el('div', { class: 'sd-body', role: 'tabpanel' });
  area.replaceChildren(loading({ label: 'Carregando a sessão' }));

  let headData = null;
  let tab = (location.hash.slice(1) && TABS_LIST.some((a) => a.id === location.hash.slice(1))) ? location.hash.slice(1) : null;
  const labels = {};
  const tabScreens = Object.fromEntries(
    TABS_LIST.map((a) => [a.id, a.create(ctx, base, { head: () => headData, setLabel: (t) => ((labels[a.id] = t ?? undefined), drawTabs()), remote: remoteId ? { id: remoteId } : null })]),
  );

  function drawTabs() {
    tabs.replaceChildren(
      ...TABS_LIST.map((a) => {
        // Até a aba dizer o dela, Agentes e Linha do tempo usam as contagens do topo.
        const fallback = { agents: headData?.counts.agents, timeline: headData ? num(headData.counts.events) : null }[a.id];
        const label = labels[a.id] ?? fallback;
        const suffix = label === undefined || label === null ? '' : ` (${label})`;
        const b = el('button', { type: 'button', role: 'tab', class: `sd-tab${a.id === tab ? ' on' : ''}`, 'aria-selected': a.id === tab ? 'true' : 'false', 'data-tab': a.id }, icon(a.icone), `${a.rotulo}${suffix}`);
        b.addEventListener('click', () => switchTo(a.id));
        return b;
      }),
    );
  }

  function switchTo(fresh) {
    if (fresh === tab) return;
    tabScreens[tab]?.hide();
    tab = fresh;
    history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
    drawTabs();
    body.replaceChildren(loading({ label: 'Carregando', blocks: 2 }));
    tabScreens[tab].show(body);
  }

  async function readHead() {
    try {
      headData = await ctx.read(base);
      ctx.title(headData.session.title);
      top.replaceChildren(...drawTop(headData, refreshAll, ctx.write, remoteId ? sourceLine : null));
      drawSource();
      drawTabs();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // C49: the remote does not answer and nothing was read yet: the notice is the state.
      if (!headData && remoteId && down) {
        area.replaceChildren(noticeSlot);
        return false;
      }
      if (!headData) {
        area.replaceChildren(
          e.status === 404
            ? empty({ title: 'Sessão não encontrada', text: `O núcleo não conhece a sessão ${id}.`, action: { label: 'Voltar para Sessões', icon: 'back', onClick: () => ctx.navigate('/ui/sessions') } })
            : error({ text: e.message, retry: () => first() }),
        );
      } else {
        top.querySelector('.error-band')?.remove();
        top.append(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: refreshAll } }));
      }
      return false;
    }
  }

  async function first() {
    // C49: while the remote is down and nothing was read, a retry keeps the notice on screen.
    if (!(remoteId && down)) area.replaceChildren(loading({ label: 'Carregando a sessão' }));
    if (!(await readHead())) return;
    tab ??= attentionOf(headData.session.attention) ? 'conversation' : 'agents';
    area.replaceChildren(noticeSlot, top, tabs, body);
    drawTabs();
    body.replaceChildren(loading({ label: 'Carregando', blocks: 2 }));
    tabScreens[tab].show(body);
  }

  async function refreshAll() {
    if (!headData) return first();
    await readHead();
    tabScreens[tab].refresh();
  }

  // Ao vivo: a mudança desta sessão relê o topo e a aba aberta, juntando as que chegam perto.
  let wait = null;
  ctx.onChange((changes) => {
    if (!changes.some((m) => m.sessionId === id)) return;
    clearTimeout(wait);
    wait = setTimeout(refreshAll, 400);
  });
  ctx.onRestart(refreshAll);

  // A remote session changes nothing on this core's `/api/changes`: re-read now and then, and soon after
  // a machine goes down or comes back; the age of the read ticks every second.
  let background = null;
  let ticker = null;
  if (remoteId) {
    background = setInterval(() => refreshAll(), REMOTE_REREAD_MS);
    ticker = setInterval(drawSource, 1000);
    ctx.onChange((changes) => {
      if (!touchesRemotes(changes)) return;
      clearTimeout(wait);
      wait = setTimeout(refreshAll, 1000);
    });
  }
  const stop = () => {
    clearTimeout(wait);
    clearInterval(background);
    clearInterval(ticker);
  };
  ctx.signal?.addEventListener?.('abort', stop);

  await first();
  return stop;
}

// ---------- Topo (A5) ----------

function drawTop(c, refresh, write, source = null) {
  const s = c.session;
  const now = Date.now();
  const end = s.status === 'active' || s.status === 'waiting' ? now : Date.parse(c.endedAt ?? s.since);
  const row1 = el(
    'div',
    { class: 'sd-row' },
    el('a', { class: 'sd-back', href: '/ui/sessions', title: 'Voltar para Sessões', 'aria-label': 'Voltar para Sessões' }, icon('back')),
    el('h1', {}, s.title),
    statusPill(s.status, s.attention),
    reasonChip(s.attention),
    // C70 (issue 285): the open action beside Atualizar, whether the session needs you or not.
    // A remote session (C49) gets the "outra máquina" case of C70: off, with where it runs.
    openAction({ id: s.id, open: c.open, machine: c.machine }, { size: 'full', className: 'sd-open', write, machine: c.machine?.label ?? null }),
    el('button', { type: 'button', class: 'sd-refresh', title: 'Atualizar', 'aria-label': 'Atualizar', onClick: refresh }, icon('refresh')),
  );
  const pills = el(
    'div',
    { class: 'sd-pills' },
    pill(null, s.id.slice(0, 12), copyButton(s.id, 'o id da sessão')),
    s.model ? pill('port', modelName(s.model)) : null,
    pill('clock', `${when(s.startedAt)} (${duration(end - Date.parse(s.startedAt))})`),
    c.cost ? el('span', { class: 'sd-pill mono sd-cost', title: 'Estimativa' }, usd(c.cost.usd)) : null,
    c.branch ? pill('branch', c.branch) : null,
    // C49: the machine chip of a remote session.
    source && c.machine?.label ? pill('server', c.machine.label) : null,
  );
  const folder = s.cwd ? el('div', { class: 'sd-folder mono' }, icon('folder'), el('span', {}, s.cwd), copyButton(s.cwd, 'a pasta')) : null;
  // The yellow band only when the session is stuck (or stopped by an error); idle gets one muted line.
  const blocked = isBlocked(s.attention) || s.status === 'error';
  const notice = s.banner && blocked ? band(c) : isIdle(s.attention) ? idleLine(c) : null;
  const config = el('a', { class: 'btn outline', href: `/ui/agent-config?tab=settings&session=${encodeURIComponent(s.id)}${source ? '&machine=remote' : ''}` }, 'Configuração em vigor');
  return [row1, pills, folder, source, config, notice].filter(Boolean);
}

function idleLine(c) {
  return el('section', { class: 'sd-idle', role: 'status' }, attentionDot('idle'), el('p', {}, idleNote(c.session.attention, c.session.since)));
}

/** O texto da faixa com o comando que pede permissão em `<code>`, montado pelo DOM. */
function withCommand(text, command) {
  const i = command ? text.indexOf(command) : -1;
  if (i < 0) return withCode(text);
  return [text.slice(0, i), el('code', { class: 'sd-code' }, command), text.slice(i + command.length)];
}

// The class of each tool state and of the band is its API value (`sd-e-<state>`, `sd-t-<type>`).
/** The band title: "Precisa de você · Pede permissão." or "Com erro." */
export function bandTitle(session) {
  if (session.banner?.type === 'error' || session.attention?.reason === 'error') return 'Com erro.';
  const reason = reasonLabel(session.attention);
  return reason ? `Precisa de você · ${reason}.` : 'Precisa de você.';
}

function band(c) {
  const f = c.session.banner;
  return el(
    'section',
    { class: `sd-band sd-t-${f.type}`, role: f.type === 'error' ? 'alert' : 'status' },
    icon(f.type === 'error' ? 'error' : 'shield'),
    el('p', {}, el('b', {}, bandTitle(c.session)), ' ', ...withCommand(f.text, c.command), `. Há ${ago(f.since).replace('agora', 'menos de 1 min')}.`),
  );
}

// ---------- Aba Agentes (C4) ----------

function agentsTab(ctx, base, { head } = {}) {
  let target = null;
  async function draw() {
    try {
      const a = await ctx.read(`${base}/agents`);
      target?.replaceChildren(...agents(a, head?.()?.session?.attention ?? null));
    } catch (e) {
      if (e.name === 'AbortError') return;
      target?.replaceChildren(error({ title: 'Não deu para ler os agentes', text: e.message, retry: draw }));
    }
  }
  return {
    show(node) {
      target = node;
      return draw();
    },
    hide: () => (target = null),
    refresh: () => draw(),
  };
}

function number(iconName, label, value, detail) {
  return el('div', { class: 'card sd-number' }, el('div', { class: 'eyebrow' }, icon(iconName), label), el('div', { class: 'sd-value' }, el('b', { class: 'mono' }, value), detail ? el('small', {}, detail) : null));
}

function agents(a, sessionAttention = null) {
  const n = a.numbers;
  const numbers = el(
    'div',
    { class: 'sd-numbers' },
    number('bolt', 'Eventos', num(n.events), `${num(n.perMinute)}/min`),
    number('key', 'Ferramentas', num(n.tools), `${num(n.uniqueTools)} únicas`),
    number('subagent', 'Subagentes', num(n.subagents), '+1 principal'),
    number('layers', 'Compactações', num(n.compactions)),
    number('alert', 'Erros', num(n.errors)),
    number('timer', 'Duração', `${num(n.durationMin)} min`, n.running ? 'rodando' : null),
  );

  const largest = Math.max(1, ...a.tools.map((f) => f.n));
  const tools = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icon('key'), 'Ferramentas mais usadas'), el('small', {}, `${num(n.uniqueTools)} no total`)),
    a.tools.length
      ? el(
          'ul',
          { class: 'sd-bars' },
          ...a.tools.map((f) => {
            const bar = el('span', { class: 'sd-full' });
            bar.style.setProperty('--w', `${(f.n / largest) * 100}%`);
            return el('li', {}, el('span', { class: 'sd-ico' }, icon(TOOL_ICON[f.name] ?? 'key')), el('span', { class: 'mono sd-name' }, f.name), el('span', { class: 'sd-rail' }, bar), el('span', { class: 'mono sd-n' }, num(f.n)));
          }),
        )
      : el('p', { class: 'sd-none' }, 'Nenhuma ferramenta ainda.'),
  );

  const t = a.tasks;
  const tasks = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icon('tasks'), 'Progresso das tarefas')),
    t && t.total ? progress(t) : el('p', { class: 'sd-none' }, 'Sem plano nesta sessão.'),
  );

  const k = a.tokens;
  const flow = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icon('coins'), 'Fluxo de tokens'), k ? el('small', {}, `${tokens(k.total)} no total`) : null),
    k && k.total ? tokenFlow(k) : el('p', { class: 'sd-none' }, 'Nenhum uso medido ainda.'),
  );

  const tree = el(
    'section',
    { class: 'sd-tree' },
    el('div', { class: 'eyebrow' }, icon('robot'), `Agentes · ${a.agents.length}`),
    ...a.agents.map((g) => node(g, sessionAttention)),
  );

  return [numbers, el('div', { class: 'sd-two' }, tools, tasks), flow, tree];
}

function progress(t) {
  const pct = Math.round((t.done / t.total) * 100);
  const r = 26;
  const back = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'sd-ring');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dash] of [['sd-bg', `${back} ${back}`], ['sd-front', `${(back * pct) / 100} ${back}`]]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [k, v] of Object.entries({ cx: 32, cy: 32, r, class: cls, 'stroke-dasharray': dash, transform: 'rotate(-90 32 32)' })) c.setAttribute(k, String(v));
    svg.append(c);
  }
  const inProgress = t.steps.filter((p) => p.state === 'in_progress').length;
  const pending = t.steps.filter((p) => p.state === 'pending').length;
  const show = 4;
  const steps = t.steps.slice(0, show);
  const rest = t.steps.length - steps.length;
  return el(
    'div',
    { class: 'sd-tasks' },
    el('div', { class: 'sd-ring-box' }, svg, el('b', { class: 'sd-pct' }, `${pct}%`), el('div', {}, el('b', {}, `${t.done} / ${t.total} concluídas`), t.current ? el('div', { class: 'sd-current' }, `Atual: ${t.current}`) : null)),
    el(
      'div',
      { class: 'sd-legend' },
      el('span', { class: 'sd-l-ok' }, 'Concluídas ', el('b', {}, num(t.done))),
      el('span', { class: 'sd-l-progress' }, 'Em andamento ', el('b', {}, num(inProgress))),
      el('span', { class: 'sd-l-pending' }, 'Pendentes ', el('b', {}, num(pending))),
    ),
    el(
      'ul',
      { class: 'sd-steps' },
      ...steps.map((p, i) =>
        el('li', { class: `sd-p-${p.state}` }, icon(p.state === 'completed' ? 'done' : 'circle'), p.state === 'in_progress' ? (p.activeText ?? p.text) : p.text, i === steps.length - 1 && rest > 0 ? el('span', { class: 'sd-more' }, ` · +${rest}`) : null),
      ),
    ),
  );
}

function tokenFlow(k) {
  const parts = [
    ['read', 'Cache lido', k.cacheRead],
    ['written', 'Cache gravado', k.cacheWrite],
    ['input', 'Entrada', k.input],
    ['output', 'Saída', k.output],
  ];
  const bar = el('div', { class: 'sd-flow', role: 'img', 'aria-label': parts.map(([, r, v]) => `${r} ${tokens(v)}`).join(', ') });
  for (const [cls, , v] of parts) {
    if (!v) continue;
    const p = el('span', { class: `sd-f-${cls}` });
    p.style.setProperty('--w', `${(v / k.total) * 100}%`);
    bar.append(p);
  }
  return el('div', {}, bar, el('div', { class: 'sd-legend' }, ...parts.map(([cls, r, v]) => el('span', { class: `sd-f-${cls}` }, `${r} `, el('b', { class: 'mono' }, tokens(v))))));
}

/** An agent node; the main one carries the session's attention (issue 245), a subagent none. */
function node(g, sessionAttention = null) {
  const end = g.end ? Date.parse(g.end) : Date.now();
  const sub =
    g.type === 'main'
      ? [modelName(g.model), g.turns !== null ? `${num(g.turns)} turno${g.turns === 1 ? '' : 's'}` : null]
      : [g.task, duration(end - Date.parse(g.start))];
  return el(
    'div',
    { class: `card sd-node${g.type === 'subagent' ? ' sd-sub' : ''}` },
    el('span', { class: 'sd-ico' }, icon(g.type === 'main' ? 'robot' : 'subagent')),
    el('div', { class: 'sd-text' }, el('b', {}, g.name), el('small', {}, sub.filter(Boolean).join(' · '))),
    el('span', { class: 'mono sd-cost' }, g.costUsd === null ? '' : usd(g.costUsd)),
    statusPill(g.status, g.type === 'main' && (g.status === 'waiting' || g.status === 'error') ? sessionAttention : null),
  );
}

// ---------- Aba Conversa (C5) ----------

const TOOL_STATE = {
  ok: { rotulo: 'OK', icone: 'ok' },
  error: { rotulo: 'Erro', icone: 'error' },
  permission: { rotulo: 'Aguardando permissão', icone: 'hourglass' },
  running: { rotulo: 'Rodando', icone: 'clock' },
};

/** "mcp__ccd_turn__update_plan" → "update_plan"; the full name stays in the tooltip. */
const shortTool = (name) => String(name ?? '').replace(/^mcp__.+__/, '');

function conversationTab(ctx, base, { head, remote = null } = {}) {
  let target = null;
  // `?agent=<id>` (the Workflow tab's steps, issue 332) opens the conversation of that subagent.
  let agent = new URLSearchParams(location.search).get('agent');
  // #61: the compose box at the foot of the tab. It is made once and survives every re-draw of the
  // list, so the text being typed and the message in flight stay.
  let compose = null;
  const composeBox = () =>
    (compose ??= createComposeBox(ctx, ctx.params.id, {
      // Issue 243: a remote session's process runs over there; the box stays off, with the reason.
      remote: Boolean(remote),
      head: () => head?.() ?? null,
      // C53: a session with no live process offers the header's open action (issue 285) in the box too.
      openControl: () => { const h = head?.(); return h?.open ? openAction({ id: ctx.params.id, open: h.open }, { size: 'full', className: 'sm-open', write: ctx.write }) : null; },
      onDelivered: () => draw(),
      onShowConversation: () => draw().then(() => list.lastElementChild?.scrollIntoView?.({ block: 'end' })),
    }));
  const opened = new Set();
  const closed = new Set();
  const openedRuns = new Set();
  const list = el('div', { class: 'card sd-messages' });
  const selector = el('select', { class: 'sd-select', 'aria-label': 'Agente' });
  const count = el('span', { class: 'sd-pill mono' });
  selector.addEventListener('change', () => {
    agent = selector.value;
    draw();
  });
  const bar = el('div', { class: 'sd-bar' }, selector, count, el('button', { type: 'button', class: 'btn outline', onClick: () => draw() }, icon('refresh'), 'Atualizar'));
  // A re-draw replaces only this wrapper: the compose box is placed once per show and never moved, so a
  // live change does not take the focus, the caret or an IME composition away from the person typing.
  const content = el('div', { class: 'sd-conversation' });

  async function draw() {
    try {
      const c = await ctx.read(`${base}/conversation${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
      agent = c.agent;
      selector.replaceChildren(...c.agents.map((a) => el('option', { value: a.id, selected: a.id === c.agent }, a.name)));
      count.replaceChildren(icon('conversation'), `${num(c.total)} mensage${c.total === 1 ? 'm' : 'ns'}`);
      list.replaceChildren(...(c.messages.length ? conversation(c.messages) : [el('p', { class: 'sd-none' }, 'Nenhuma mensagem deste agente ainda.')]));
      content.replaceChildren(bar, list);
    } catch (e) {
      if (e.name === 'AbortError') return;
      content.replaceChildren(error({ title: 'Não deu para ler a conversa', text: e.message, retry: draw }));
    }
  }

  // The text leads; the tool calls are the how, folded into one "N ações" line. A run of assistant
  // messages that only call tools folds into a single line, so a long stretch of work reads as one
  // step. A call waiting for permission stays out and open: it asks for the person.
  // The tool-only messages before an assistant reply fold into that reply, above its text, the way a
  // chat shows "used N tools" inside the turn; a run with no reply after it gets its own assistant row.
  const asks = (f) => f.state === 'permission';
  function conversation(messages) {
    const nodes = [];
    let run = [];
    let runAt = null;
    for (const m of messages) {
      if (m.role !== 'you' && !m.text && !m.tools.some(asks)) {
        run.push(...m.tools);
        runAt ??= m;
        continue;
      }
      if (m.role !== 'you') {
        nodes.push(message(m, run));
      } else {
        if (run.length) nodes.push(message({ ...runAt, tools: [] }, run));
        nodes.push(message(m, []));
      }
      run = [];
      runAt = null;
    }
    if (run.length) nodes.push(message({ ...runAt, tools: [] }, run));
    return nodes;
  }

  function message(m, before = []) {
    const you = m.role === 'you';
    const body = m.text ? messageBody(m.text) : { nodes: [], system: false };
    const done = [...before, ...m.tools.filter((f) => !asks(f))];
    // A message with only harness tags (a reminder, a task notice, a slash command) reads as a notice row.
    if (you && body.system) {
      return el('div', { class: 'sd-msg sd-system', title: HOUR.format(new Date(m.at)) }, el('span', { class: 'sd-avatar' }), el('div', { class: 'sd-content' }, ...body.nodes));
    }
    return el(
      'article',
      { class: `sd-msg ${you ? 'sd-you' : 'sd-assistant'}` },
      el('span', { class: 'sd-avatar' }, icon(you ? 'person' : 'robot')),
      el(
        'div',
        { class: 'sd-content' },
        el(
          'header',
          {},
          el('b', {}, you ? 'Você' : 'Assistente'),
          m.model ? el('span', { class: 'sd-pill mono' }, modelName(m.model)) : null,
          m.tokens ? el('span', { class: 'sd-pill mono', title: 'Tokens de entrada e de saída' }, `↓ ${tokens(m.tokens.input)} · ↑ ${tokens(m.tokens.output)}`) : null,
          el('time', { class: 'mono', datetime: m.at }, HOUR.format(new Date(m.at))),
        ),
        done.length ? activity(done) : null,
        ...body.nodes,
        ...m.tools.filter(asks).map(tool),
      ),
    );
  }

  function activity(tools) {
    // Keyed by its first call, so an open fold stays open across the live re-draws.
    const key = tools[0].id;
    const isOpen = openedRuns.has(key);
    const failed = tools.filter((f) => f.state === 'error').length;
    const names = [...new Set(tools.map((f) => shortTool(f.name)))];
    const body = el('div', { class: 'sd-activity-body', hidden: !isOpen }, ...tools.map(tool));
    const head = el(
      'button',
      { type: 'button', class: 'sd-activity-head', 'aria-expanded': isOpen ? 'true' : 'false' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
      el('span', { class: 'sd-activity-count' }, `${num(tools.length)} aç${tools.length === 1 ? 'ão' : 'ões'}`),
      el('span', { class: 'sd-activity-names' }, names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '')),
      failed ? el('span', { class: 'sd-e-error' }, icon('error'), `${num(failed)} com erro`) : null,
    );
    head.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.firstChild.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
      if (open) openedRuns.add(key);
      else openedRuns.delete(key);
    });
    return el('div', { class: 'sd-activity' }, head, body);
  }

  function tool(f) {
    // A que pede permissão já vem aberta, como no C5; a pessoa pode fechar.
    const isOpen = opened.has(f.id) || (f.state === 'permission' && !closed.has(f.id));
    const st = TOOL_STATE[f.state];
    const detail = el(
      'div',
      { class: 'sd-tool-body', hidden: !isOpen },
      f.input ? el('div', {}, el('div', { class: 'eyebrow' }, 'Entrada'), el('pre', { class: 'mono sd-pre' }, f.input)) : null,
      f.result ? el('div', {}, el('div', { class: 'eyebrow' }, 'Resultado'), el('pre', { class: 'mono sd-pre' }, f.result)) : null,
      !f.input && !f.result ? el('p', { class: 'sd-none' }, 'Sem entrada nem resultado guardados.') : null,
    );
    const headData = el(
      'button',
      { type: 'button', class: 'sd-tool-head', 'aria-expanded': isOpen ? 'true' : 'false' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
      el('b', { class: 'mono sd-name', title: f.name }, shortTool(f.name)),
      el('span', { class: 'mono sd-summary' }, f.summary ?? ''),
      st ? el('span', { class: `mono sd-situation sd-e-${f.state}` }, icon(st.icone), st.rotulo) : null,
    );
    headData.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      headData.setAttribute('aria-expanded', open ? 'true' : 'false');
      headData.firstChild.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
      (open ? opened : closed).add(f.id);
      (open ? closed : opened).delete(f.id);
    });
    return el('div', { class: `sd-tool${f.state === 'permission' ? ' sd-asks' : ''}` }, headData, detail);
  }

  return {
    async show(node) {
      target = node;
      await draw();
      if (target !== node) return;
      node.replaceChildren(content, composeBox().node);
      // Opening the tab lands on the latest message and the compose box, like a chat; a live re-draw
      // does not scroll, so someone reading further up is not pulled down.
      composeBox().node.scrollIntoView?.({ block: 'end' });
      // "Mandar mensagem" from a list opens here with `?focus=message`: the box takes the focus once.
      if (new URLSearchParams(location.search).get('focus') === 'message') {
        history.replaceState(null, '', `${location.pathname}${withQuery(location.search, { focus: null })}${location.hash}`);
        composeBox().focus();
      }
    },
    hide: () => (target = null),
    refresh: () => (compose?.refresh(), draw()),
  };
}

// ---------- Aba Linha do tempo (C6) ----------

const PER_PAGE = 50;

function timelineTab(ctx, base, { setLabel }) {
  let target = null;
  let last = null;
  let howMany = PER_PAGE;
  const expanded = new Set();
  const filters = { q: '', from: '', to: '', status: '', type: '', tool: '', agent: '' };

  const search = el('input', { type: 'search', class: 'sd-field', placeholder: 'Buscar no resumo, ferramenta, conteúdo…', 'aria-label': 'Buscar' });
  const from = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'De' });
  const until = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'Até' });
  const selects = {
    status: el('select', { class: 'sd-chip mono', 'aria-label': 'Status' }),
    type: el('select', { class: 'sd-chip mono', 'aria-label': 'Tipo de evento' }),
    tool: el('select', { class: 'sd-chip mono', 'aria-label': 'Ferramenta' }),
    agent: el('select', { class: 'sd-chip mono', 'aria-label': 'Agente' }),
  };
  let pause = null;
  search.addEventListener('input', () => {
    clearTimeout(pause);
    pause = setTimeout(() => ((filters.q = search.value.trim()), restart()), 250);
  });
  from.addEventListener('change', () => ((filters.from = from.value), restart()));
  until.addEventListener('change', () => ((filters.to = until.value), restart()));
  for (const [k, s] of Object.entries(selects)) s.addEventListener('change', () => ((filters[k] = s.value), restart()));

  const filtersPanel = el(
    'section',
    { class: 'card sd-filters' },
    el('div', { class: 'sd-filters-row' }, el('label', { class: 'sd-search' }, icon('filter'), search), el('label', { class: 'sd-date' }, icon('calendar'), el('span', {}, 'De'), from), el('label', { class: 'sd-date' }, icon('calendar'), el('span', {}, 'Até'), until)),
    el('div', { class: 'sd-filters-row' }, ...Object.values(selects)),
  );
  const list = el('div', { class: 'card sd-events' });
  const footer = el('div', { class: 'sd-footer' });

  function options(sel, label, items, current) {
    sel.replaceChildren(el('option', { value: '' }, label), ...items.map(([v, r]) => el('option', { value: v, selected: v === current }, r)));
    sel.classList.toggle('on', !!current);
  }

  function query() {
    const p = new URLSearchParams();
    for (const k of ['q', 'status', 'type', 'tool', 'agent']) if (filters[k]) p.set(k, filters[k]);
    // `datetime-local` é a hora do lugar; a API quer ISO em UTC.
    for (const k of ['from', 'to']) if (filters[k]) p.set(k, new Date(filters[k]).toISOString());
    p.set('limit', String(howMany));
    return `${base}/events?${p}`;
  }

  function restart() {
    howMany = PER_PAGE;
    draw();
  }

  async function draw() {
    try {
      const r = await ctx.read(query());
      last = r;
      setLabel(`${num(r.filtered)}/${num(r.total)}`);
      options(selects.status, 'Status', r.options.status.filter((s) => STATUS_FILTER[s]).map((s) => [s, STATUS_FILTER[s]]), filters.status);
      options(selects.type, 'Tipo de evento', r.options.types.map((t) => [t, t]), filters.type);
      options(selects.tool, 'Ferramenta', r.options.tools.map((t) => [t, t]), filters.tool);
      options(selects.agent, 'Agente', r.options.agents.map((a) => [a.id, a.name]), filters.agent);
      list.replaceChildren(...(r.items.length ? r.items.map(row) : [el('p', { class: 'sd-none' }, r.total ? 'Nenhum evento com esses filtros.' : 'Nenhum evento ainda.')]));
      footer.replaceChildren(
        ...[
          r.items.length ? el('small', {}, `Mostrando ${num(r.items.length)} de ${num(r.filtered)}`) : null,
          r.next ? el('button', { type: 'button', class: 'btn outline', onClick: () => ((howMany += PER_PAGE), draw()) }, 'Carregar mais') : null,
        ].filter(Boolean),
      );
      target?.replaceChildren(filtersPanel, list, footer);
    } catch (e) {
      if (e.name === 'AbortError') return;
      target?.replaceChildren(error({ title: 'Não deu para ler a linha do tempo', text: e.message, retry: draw }));
    }
  }

  function row(e) {
    const isOpen = expanded.has(e.id);
    const data = el('pre', { class: 'mono sd-pre sd-data', hidden: !isOpen }, e.data ?? 'Sem dados guardados.');
    const head = el(
      'button',
      { type: 'button', class: 'sd-event-head', 'aria-expanded': isOpen ? 'true' : 'false' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
      el('time', { class: 'mono', datetime: e.at, title: new Date(e.at).toLocaleString('pt-BR') }, ago(e.at)),
      statusPill(e.status, e.attention),
      el('span', { class: 'mono sd-type' }, e.type),
      el('span', { class: 'sd-summary' }, e.summary ?? ''),
      e.tool ? el('span', { class: 'sd-chip mono' }, e.tool) : null,
    );
    head.addEventListener('click', () => {
      const open = data.hidden;
      data.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.firstChild.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
      if (open) expanded.add(e.id);
      else expanded.delete(e.id);
    });
    return el('div', { class: 'sd-event' }, head, data);
  }

  return {
    show(node) {
      target = node;
      if (last) target.replaceChildren(filtersPanel, list, footer);
      return draw();
    },
    hide: () => (target = null),
    refresh: () => draw(),
  };
}
