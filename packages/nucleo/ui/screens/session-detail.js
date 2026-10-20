// O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes (C4), Conversa (C5) e Linha do
// tempo (C6), sobre `GET /api/sessions/<id>…` (src/api/detalhe.ts). Workflow e Decisões não entram
// nesta versão.
//
// Tudo o que vem do núcleo, e o texto da conversa mais ainda, é conteúdo não confiável: entra por
// `textContent` (`el()`), nunca como HTML.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { openInDesktop } from '../api.js';
import { create as workflowTab } from './session-detail-workflow.js';
import { create as decisionsTab } from './session-detail-decisions.js';

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

const STATUS = { active: 'Ativa', working: 'Ativa', waiting: 'Esperando você', error: 'Erro', completed: 'Concluída', abandoned: 'Abandonada' };
const COLOR = { active: 'active', working: 'active', waiting: 'waiting', error: 'error', completed: 'completed', abandoned: 'abandoned' };

function statusPill(status, label = STATUS[status] ?? status) {
  return el('span', { class: `sd-status sd-s-${COLOR[status] ?? 'abandoned'}` }, label);
}

/** O motivo da espera, como no A5: "Pede permissão", "Pergunta", "Sua vez"… */
function reasonOf(session) {
  if (session.status === 'error') return null;
  if (session.faixa?.tipo === 'permissao') return 'Pede permissão';
  if (session.faixa?.tipo === 'pergunta') return 'Pergunta';
  return { interrupted: 'Interrompida', stop: 'Sua vez', session_start: 'No prompt', notification: 'Pede permissão' }[session.motivo] ?? null;
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

export async function mount(area, ctx) {
  loadCss();
  const id = ctx.params.id;
  const base = `/api/sessions/${encodeURIComponent(id)}`;
  const top = el('div', { class: 'sd-top' });
  const tabs = el('nav', { class: 'sd-tabs', role: 'tablist', 'aria-label': 'Abas da sessão' });
  const body = el('div', { class: 'sd-body', role: 'tabpanel' });
  area.replaceChildren(loading({ label: 'Carregando a sessão' }));

  let headData = null;
  let tab = (location.hash.slice(1) && TABS_LIST.some((a) => a.id === location.hash.slice(1))) ? location.hash.slice(1) : null;
  const labels = {};
  const tabScreens = Object.fromEntries(
    TABS_LIST.map((a) => [a.id, a.create(ctx, base, { head: () => headData, setLabel: (t) => ((labels[a.id] = t ?? undefined), drawTabs()) })]),
  );

  function drawTabs() {
    tabs.replaceChildren(
      ...TABS_LIST.map((a) => {
        // Até a aba dizer o dela, Agentes e Linha do tempo usam as contagens do topo.
        const fallback = { agents: headData?.contagens.agentes, timeline: headData ? num(headData.contagens.eventos) : null }[a.id];
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
    history.replaceState(null, '', `${location.pathname}#${tab}`);
    drawTabs();
    body.replaceChildren(loading({ label: 'Carregando', blocks: 2 }));
    tabScreens[tab].show(body);
  }

  async function readHead() {
    try {
      headData = await ctx.read(base);
      ctx.title(headData.sessao.titulo);
      top.replaceChildren(...drawTop(headData, refreshAll));
      drawTabs();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
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
    area.replaceChildren(loading({ label: 'Carregando a sessão' }));
    if (!(await readHead())) return;
    tab ??= headData.sessao.status === 'waiting' ? 'conversation' : 'agents';
    area.replaceChildren(top, tabs, body);
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

  await first();
  return () => clearTimeout(wait);
}

// ---------- Topo (A5) ----------

function drawTop(c, refresh) {
  const s = c.sessao;
  const now = Date.now();
  const reason = reasonOf(s);
  const end = s.status === 'active' || s.status === 'waiting' ? now : Date.parse(c.encerradaEm ?? s.desde);
  const row1 = el(
    'div',
    { class: 'sd-row' },
    el('a', { class: 'sd-back', href: '/ui/sessions', title: 'Voltar para Sessões', 'aria-label': 'Voltar para Sessões' }, icon('back')),
    el('h1', {}, s.titulo),
    statusPill(s.status),
    reason && s.status === 'waiting' ? el('span', { class: `sd-reason${s.urgente ? ' sd-urgent' : ''}` }, s.faixa?.tipo === 'permissao' ? icon('shield') : null, reason) : null,
    el('button', { type: 'button', class: 'sd-refresh', title: 'Atualizar', 'aria-label': 'Atualizar', onClick: refresh }, icon('refresh')),
  );
  const pills = el(
    'div',
    { class: 'sd-pills' },
    pill(null, s.id.slice(0, 12), copyButton(s.id, 'o id da sessão')),
    s.modelo ? pill('port', modelName(s.modelo)) : null,
    pill('clock', `${when(s.iniciadaEm)} (${duration(end - Date.parse(s.iniciadaEm))})`),
    c.custo ? el('span', { class: 'sd-pill mono sd-cost', title: 'Estimativa' }, usd(c.custo.usd)) : null,
    c.branch ? pill('branch', c.branch) : null,
  );
  const folder = s.cwd ? el('div', { class: 'sd-folder mono' }, icon('folder'), el('span', {}, s.cwd), copyButton(s.cwd, 'a pasta')) : null;
  return [row1, pills, folder, s.faixa ? band(c) : null].filter(Boolean);
}

/** O texto da faixa com o comando que pede permissão em `<code>`, montado pelo DOM. */
function withCommand(text, command) {
  const i = command ? text.indexOf(command) : -1;
  if (i < 0) return withCode(text);
  return [text.slice(0, i), el('code', { class: 'sd-code' }, command), text.slice(i + command.length)];
}

// The class of each band type and tool state (the API value stays as it comes).
const BAND_CLASS = { permissao: 'permission', pergunta: 'question', erro: 'error' };
const TOOL_STATE_CLASS = { ok: 'ok', erro: 'error', permissao: 'permission', rodando: 'running' };
const BAND_TITLE = { permissao: 'Esperando você · Pede permissão.', pergunta: 'Esperando você · Pergunta.', erro: 'Erro.' };

function band(c) {
  const f = c.sessao.faixa;
  const notice = el('span', { class: 'sd-notice', role: 'status' });
  const button = el('button', { type: 'button', class: 'btn outline', disabled: !c.local, title: c.local ? null : 'Esta sessão não está no Claude Desktop' }, 'Abrir no Claude Desktop', icon('external'));
  button.addEventListener('click', async () => {
    notice.textContent = '';
    try {
      await openInDesktop(c.local);
    } catch (e) {
      // Sem quem abra (fora do macOS, ou a demonstração): o link de reserva leva ao `claude://`.
      if (e.status === 501) return void (location.href = `/open/${c.local}`);
      notice.textContent = e.message;
    }
  });
  return el(
    'section',
    { class: `sd-band sd-t-${BAND_CLASS[f.tipo] ?? f.tipo}`, role: f.tipo === 'erro' ? 'alert' : 'status' },
    icon(f.tipo === 'erro' ? 'error' : 'shield'),
    el('p', {}, el('b', {}, BAND_TITLE[f.tipo] ?? ''), ' ', ...withCommand(f.texto, c.comando), `. Há ${ago(f.desde).replace('agora', 'menos de 1 min')}.`, notice),
    button,
  );
}

// ---------- Aba Agentes (C4) ----------

function agentsTab(ctx, base) {
  let target = null;
  async function draw() {
    try {
      const a = await ctx.read(`${base}/agents`);
      target?.replaceChildren(...agents(a));
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

function agents(a) {
  const n = a.numeros;
  const numbers = el(
    'div',
    { class: 'sd-numbers' },
    number('bolt', 'Eventos', num(n.eventos), `${num(n.porMinuto)}/min`),
    number('key', 'Ferramentas', num(n.ferramentas), `${num(n.ferramentasUnicas)} únicas`),
    number('subagent', 'Subagentes', num(n.subagentes), '+1 principal'),
    number('layers', 'Compactações', num(n.compactacoes)),
    number('alert', 'Erros', num(n.erros)),
    number('timer', 'Duração', `${num(n.duracaoMin)} min`, n.rodando ? 'rodando' : null),
  );

  const largest = Math.max(1, ...a.ferramentas.map((f) => f.n));
  const tools = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icon('key'), 'Ferramentas mais usadas'), el('small', {}, `${num(n.ferramentasUnicas)} no total`)),
    a.ferramentas.length
      ? el(
          'ul',
          { class: 'sd-bars' },
          ...a.ferramentas.map((f) => {
            const bar = el('span', { class: 'sd-full' });
            bar.style.setProperty('--w', `${(f.n / largest) * 100}%`);
            return el('li', {}, el('span', { class: 'sd-ico' }, icon(TOOL_ICON[f.nome] ?? 'key')), el('span', { class: 'mono sd-name' }, f.nome), el('span', { class: 'sd-rail' }, bar), el('span', { class: 'mono sd-n' }, num(f.n)));
          }),
        )
      : el('p', { class: 'sd-none' }, 'Nenhuma ferramenta ainda.'),
  );

  const t = a.tarefas;
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
    el('div', { class: 'eyebrow' }, icon('robot'), `Agentes · ${a.agentes.length}`),
    ...a.agentes.map((g) => node(g)),
  );

  return [numbers, el('div', { class: 'sd-two' }, tools, tasks), flow, tree];
}

function progress(t) {
  const pct = Math.round((t.feitos / t.total) * 100);
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
  const inProgress = t.passos.filter((p) => p.estado === 'in_progress').length;
  const pending = t.passos.filter((p) => p.estado === 'pending').length;
  const show = 4;
  const steps = t.passos.slice(0, show);
  const rest = t.passos.length - steps.length;
  return el(
    'div',
    { class: 'sd-tasks' },
    el('div', { class: 'sd-ring-box' }, svg, el('b', { class: 'sd-pct' }, `${pct}%`), el('div', {}, el('b', {}, `${t.feitos} / ${t.total} concluídas`), t.atual ? el('div', { class: 'sd-current' }, `Atual: ${t.atual}`) : null)),
    el(
      'div',
      { class: 'sd-legend' },
      el('span', { class: 'sd-l-ok' }, 'Concluídas ', el('b', {}, num(t.feitos))),
      el('span', { class: 'sd-l-progress' }, 'Em andamento ', el('b', {}, num(inProgress))),
      el('span', { class: 'sd-l-pending' }, 'Pendentes ', el('b', {}, num(pending))),
    ),
    el(
      'ul',
      { class: 'sd-steps' },
      ...steps.map((p, i) =>
        el('li', { class: `sd-p-${p.estado}` }, icon(p.estado === 'completed' ? 'done' : 'circle'), p.estado === 'in_progress' ? (p.textoAtivo ?? p.texto) : p.texto, i === steps.length - 1 && rest > 0 ? el('span', { class: 'sd-more' }, ` · +${rest}`) : null),
      ),
    ),
  );
}

function tokenFlow(k) {
  const parts = [
    ['read', 'Cache lido', k.cacheLido],
    ['written', 'Cache gravado', k.cacheGravado],
    ['input', 'Entrada', k.entrada],
    ['output', 'Saída', k.saida],
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

function node(g) {
  const end = g.fim ? Date.parse(g.fim) : Date.now();
  const sub =
    g.tipo === 'principal'
      ? [modelName(g.modelo), g.turnos !== null ? `${num(g.turnos)} turno${g.turnos === 1 ? '' : 's'}` : null]
      : [g.tarefa, duration(end - Date.parse(g.inicio))];
  return el(
    'div',
    { class: `card sd-node${g.tipo === 'subagente' ? ' sd-sub' : ''}` },
    el('span', { class: 'sd-ico' }, icon(g.tipo === 'principal' ? 'robot' : 'subagent')),
    el('div', { class: 'sd-text' }, el('b', {}, g.nome), el('small', {}, sub.filter(Boolean).join(' · '))),
    el('span', { class: 'mono sd-cost' }, g.custoUsd === null ? '' : usd(g.custoUsd)),
    statusPill(g.status),
  );
}

// ---------- Aba Conversa (C5) ----------

const TOOL_STATE = {
  ok: { rotulo: 'OK', icone: 'ok' },
  erro: { rotulo: 'Erro', icone: 'error' },
  permissao: { rotulo: 'Aguardando permissão', icone: 'hourglass' },
  rodando: { rotulo: 'Rodando', icone: 'clock' },
};

function conversationTab(ctx, base) {
  let target = null;
  let agent = null;
  const opened = new Set();
  const closed = new Set();
  const list = el('div', { class: 'card sd-messages' });
  const selector = el('select', { class: 'sd-select', 'aria-label': 'Agente' });
  const count = el('span', { class: 'sd-pill mono' });
  selector.addEventListener('change', () => {
    agent = selector.value;
    draw();
  });
  const bar = el('div', { class: 'sd-bar' }, selector, count, el('button', { type: 'button', class: 'btn outline', onClick: () => draw() }, icon('refresh'), 'Atualizar'));

  async function draw() {
    try {
      const c = await ctx.read(`${base}/conversation${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
      agent = c.agente;
      selector.replaceChildren(...c.agentes.map((a) => el('option', { value: a.id, selected: a.id === c.agente }, a.nome)));
      count.replaceChildren(icon('conversation'), `${num(c.total)} mensage${c.total === 1 ? 'm' : 'ns'}`);
      list.replaceChildren(...(c.mensagens.length ? c.mensagens.map(message) : [el('p', { class: 'sd-none' }, 'Nenhuma mensagem deste agente ainda.')]));
      target?.replaceChildren(bar, list);
    } catch (e) {
      if (e.name === 'AbortError') return;
      target?.replaceChildren(error({ title: 'Não deu para ler a conversa', text: e.message, retry: draw }));
    }
  }

  function message(m) {
    const you = m.papel === 'voce';
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
          m.modelo ? el('span', { class: 'sd-pill mono' }, modelName(m.modelo)) : null,
          m.tokens ? el('span', { class: 'sd-pill mono', title: 'Tokens de entrada e de saída' }, `↓ ${tokens(m.tokens.entrada)} · ↑ ${tokens(m.tokens.saida)}`) : null,
          el('time', { class: 'mono', datetime: m.em }, HOUR.format(new Date(m.em))),
        ),
        m.texto ? el('p', {}, ...withCode(m.texto)) : null,
        ...m.ferramentas.map(tool),
      ),
    );
  }

  function tool(f) {
    // A que pede permissão já vem aberta, como no C5; a pessoa pode fechar.
    const isOpen = opened.has(f.id) || (f.estado === 'permissao' && !closed.has(f.id));
    const st = TOOL_STATE[f.estado];
    const detail = el(
      'div',
      { class: 'sd-tool-body', hidden: !isOpen },
      f.entrada ? el('div', {}, el('div', { class: 'eyebrow' }, 'Entrada'), el('pre', { class: 'mono sd-pre' }, f.entrada)) : null,
      f.resultado ? el('div', {}, el('div', { class: 'eyebrow' }, 'Resultado'), el('pre', { class: 'mono sd-pre' }, f.resultado)) : null,
      !f.entrada && !f.resultado ? el('p', { class: 'sd-none' }, 'Sem entrada nem resultado guardados.') : null,
    );
    const headData = el(
      'button',
      { type: 'button', class: 'sd-tool-head', 'aria-expanded': isOpen ? 'true' : 'false' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
      el('b', { class: 'mono sd-name' }, f.nome),
      el('span', { class: 'mono sd-summary' }, f.resumo ?? ''),
      st ? el('span', { class: `mono sd-situation sd-e-${TOOL_STATE_CLASS[f.estado] ?? f.estado}` }, icon(st.icone), st.rotulo) : null,
    );
    headData.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      headData.setAttribute('aria-expanded', open ? 'true' : 'false');
      headData.firstChild.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
      (open ? opened : closed).add(f.id);
      (open ? closed : opened).delete(f.id);
    });
    return el('div', { class: `sd-tool${f.estado === 'permissao' ? ' sd-asks' : ''}` }, headData, detail);
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

// ---------- Aba Linha do tempo (C6) ----------

const PER_PAGE = 50;

function timelineTab(ctx, base, { setLabel }) {
  let target = null;
  let last = null;
  let howMany = PER_PAGE;
  const expanded = new Set();
  const filters = { q: '', de: '', ate: '', status: '', tipo: '', ferramenta: '', agente: '' };

  const search = el('input', { type: 'search', class: 'sd-field', placeholder: 'Buscar no resumo, ferramenta, conteúdo…', 'aria-label': 'Buscar' });
  const from = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'De' });
  const until = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'Até' });
  const selects = {
    status: el('select', { class: 'sd-chip mono', 'aria-label': 'Status' }),
    tipo: el('select', { class: 'sd-chip mono', 'aria-label': 'Tipo de evento' }),
    ferramenta: el('select', { class: 'sd-chip mono', 'aria-label': 'Ferramenta' }),
    agente: el('select', { class: 'sd-chip mono', 'aria-label': 'Agente' }),
  };
  let pause = null;
  search.addEventListener('input', () => {
    clearTimeout(pause);
    pause = setTimeout(() => ((filters.q = search.value.trim()), restart()), 250);
  });
  from.addEventListener('change', () => ((filters.de = from.value), restart()));
  until.addEventListener('change', () => ((filters.ate = until.value), restart()));
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
    // The filter state keeps its names; the API reads the English parameters.
    for (const [k, name] of [['q', 'q'], ['status', 'status'], ['tipo', 'type'], ['ferramenta', 'tool'], ['agente', 'agent']]) if (filters[k]) p.set(name, filters[k]);
    // `datetime-local` é a hora do lugar; a API quer ISO em UTC.
    for (const [k, name] of [['de', 'from'], ['ate', 'to']]) if (filters[k]) p.set(name, new Date(filters[k]).toISOString());
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
      setLabel(`${num(r.filtrados)}/${num(r.total)}`);
      options(selects.status, 'Status', r.opcoes.status.map((s) => [s, STATUS[s]]), filters.status);
      options(selects.tipo, 'Tipo de evento', r.opcoes.tipos.map((t) => [t, t]), filters.tipo);
      options(selects.ferramenta, 'Ferramenta', r.opcoes.ferramentas.map((t) => [t, t]), filters.ferramenta);
      options(selects.agente, 'Agente', r.opcoes.agentes.map((a) => [a.id, a.nome]), filters.agente);
      list.replaceChildren(...(r.itens.length ? r.itens.map(row) : [el('p', { class: 'sd-none' }, r.total ? 'Nenhum evento com esses filtros.' : 'Nenhum evento ainda.')]));
      footer.replaceChildren(
        ...[
          r.itens.length ? el('small', {}, `Mostrando ${num(r.itens.length)} de ${num(r.filtrados)}`) : null,
          r.proximo ? el('button', { type: 'button', class: 'btn outline', onClick: () => ((howMany += PER_PAGE), draw()) }, 'Carregar mais') : null,
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
    const data = el('pre', { class: 'mono sd-pre sd-data', hidden: !isOpen }, e.dados ?? 'Sem dados guardados.');
    const head = el(
      'button',
      { type: 'button', class: 'sd-event-head', 'aria-expanded': isOpen ? 'true' : 'false' },
      icon(isOpen ? 'chevron-down' : 'chevron-right'),
      el('time', { class: 'mono', datetime: e.em, title: new Date(e.em).toLocaleString('pt-BR') }, ago(e.em)),
      statusPill(e.status),
      el('span', { class: 'mono sd-type' }, e.tipo),
      el('span', { class: 'sd-summary' }, e.resumo ?? ''),
      e.ferramenta ? el('span', { class: 'sd-chip mono' }, e.ferramenta) : null,
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
