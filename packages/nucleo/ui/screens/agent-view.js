// The agent view (issue 521, wireframe 521-1 to 521-10): the screen of one agent seen from the inside, drawn
// from the data of the agent-view contract (docs/contracts/agent-view.md). The components come first; `mount`
// at the end is the state layer (issue 539): the read, the retry, the live update and the focus on Back, over
// the `read` the shell gives it. Registering the route and the real read are the contract layer (issue 540).
// Everything from the core goes in through `textContent` (`el()`), never as HTML.

import { el, icon } from '../dom.js';
import { error } from '../states.js';
import { routeWithMachine } from '../machine-filter.js';
import { shortAgentName } from './workflow-format.js';
import {
  agentViewHref, clock, machineQuery, remoteMachine, costNoteText, costText, durationText, elide, foldText, num, offsetText, stateLabel, stepDurationText,
} from './agent-view-format.js';
import { agentReadRoute, createAgentReader, isRunning } from './agent-view-state.js';

function ensureStyle() {
  if (document.querySelector('link[data-screen="agent-view"]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/agent-view.css', 'data-screen': 'agent-view' }));
}

// A remote session's links keep its `?machine=<id>`, so Back and the crumb return to the same machine (issue 540).
const sessionHref = (sessionId) => `/ui/sessions/${encodeURIComponent(sessionId)}${machineQuery()}`;
const agentsTabHref = (sessionId) => `${sessionHref(sessionId)}#agents`;

/** The name the agent goes by: the short type, else "Agente principal" for the main one, else what it was asked. (issue 521) */
export function agentLabel(data) {
  return shortAgentName(data.agentType) ?? (data.agentId === 'main' ? 'Agente principal' : (data.description ?? data.agentId));
}


/** The session, the Agents tab, the agents above this one and this one: every part but the last is a link. (issue 521) */
function crumb({ sessionId, sessionTitle = null, trail = [], current }) {
  const sep = () => icon('chevron-right');
  return el(
    'nav',
    { class: 'av-crumb', 'aria-label': 'Onde você está' },
    el('a', { class: 'av-crumb-link', href: sessionHref(sessionId) }, icon('back'), sessionTitle ? `Sessão · ${sessionTitle}` : 'Sessão'),
    sep(),
    el('a', { class: 'av-crumb-link', href: agentsTabHref(sessionId) }, 'Agentes'),
    ...trail.flatMap((t) => [sep(), el('a', { class: 'av-crumb-link', href: t.href }, t.label)]),
    sep(),
    el('span', { class: 'av-crumb-current', 'aria-current': 'page' }, current),
  );
}


const STEP_STATE = {
  ok: { tone: 'ok', icon: 'ok', label: 'OK' },
  error: { tone: 'err', icon: 'error', label: 'Erro' },
  running: { tone: 'run', icon: 'clock', label: 'Rodando' },
  unknown: { tone: 'unknown', icon: 'circle', label: '—' },
};
const CHILD_STATE = { running: 'working', ok: 'completed', error: 'error' };

function stateBadge(state, className = 'av-state') {
  return el('span', { class: `${className} av-s-${state}` }, stateLabel(state));
}

function fact(className, iconName, label, value, small) {
  return el('div', { class: `card av-fact ${className}` }, el('span', { class: 'eyebrow' }, icon(iconName), label), el('span', { class: 'av-fact-value' }, el('b', { class: 'mono' }, value), small ? el('small', {}, small) : null));
}

function failedBand(data) {
  const last = [...data.steps].reverse().find((s) => s.state === 'error');
  return el(
    'div',
    { class: 'av-failed', role: 'alert' },
    icon('error'),
    el('p', {}, el('b', {}, 'O agente falhou.'), last ? [' A última ferramenta devolveu erro: ', el('code', { class: 'mono' }, [last.name, last.summary].filter(Boolean).join(' ')), '.'] : null),
  );
}

function header(data, { sessionId, now }) {
  const label = agentLabel(data);
  const duration = durationText(data, now);
  const subs = data.steps.filter((s) => s.kind === 'agent');
  const tools = data.steps.filter((s) => s.kind === 'tool');
  const costSmall = [
    data.costUsd === null ? costNoteText(data.costNote) : null,
    data.totalCostUsd !== null && data.totalCostUsd !== data.costUsd ? `com os filhos ${costText(data.totalCostUsd)}` : null,
    duration.partial ? 'até agora' : null,
  ].filter(Boolean).join(' · ');
  return [
    el(
      'div',
      { class: 'av-head' },
      el('span', { class: 'av-ico' }, icon('subagent')),
      el('h2', { class: 'av-kind', title: data.agentType ?? '' }, label),
      data.agentType?.includes(':') ? el('span', { class: 'av-kind-full mono' }, data.agentType) : null,
      stateBadge(data.state),
      el('a', { class: 'btn outline av-conversation', href: `${sessionHref(sessionId)}${machineQuery() ? '&' : '?'}agent=${encodeURIComponent(`${sessionId}:${data.agentId}`)}#conversation`, title: 'A aba Conversa, já com este agente escolhido' }, icon('conversation'), 'Abrir a conversa'),
    ),
    data.description ? el('p', { class: 'av-description' }, data.description) : null,
    data.state === 'error' ? failedBand(data) : null,
    el(
      'div',
      { class: 'av-facts' },
      fact('av-duration', 'timer', 'Duração', duration.text, duration.partial ? `até agora · desde ${clock(data.start)}` : `${clock(data.start)} → ${clock(data.end)}`),
      fact('av-cost', 'coins', 'Custo', costText(data.costUsd), costSmall),
      fact('av-tools', 'key', 'Ferramentas', num(tools.length), `${num(new Set(tools.map((s) => s.name)).size)} únicas`),
      fact('av-subagents', 'subagent', 'Subagentes', num(subs.length), subs.length ? null : 'nenhum'),
    ),
  ];
}


const NONE_ICON = { brief: 'file', result: 'ok' };

function none(kind, title, text) {
  return el('div', { class: 'av-none' }, icon(NONE_ICON[kind]), el('p', {}, el('b', {}, title), ` ${text}`));
}

/** A block of text that folds at 6 lines; `open` is the person's choice, kept by the caller. (issue 521) */
function textBlock({ kind, title, iconName, text, truncated, open, onToggle, empty }) {
  const box = el('section', { class: `card av-sec av-${kind}` }, el('div', { class: 'eyebrow' }, icon(iconName), title));
  if (text === null || text === undefined || text === '') return (box.append(empty), box);
  const fold = foldText(text);
  const shown = fold.folded && !open ? fold.shown : text;
  if (fold.folded) box.setAttribute('data-folded', String(!open));
  box.append(el('p', { class: 'av-text' }, shown));
  if (truncated) box.append(el('small', { class: 'av-cut' }, 'O núcleo guarda só os 32.000 primeiros caracteres deste texto.'));
  if (fold.folded) {
    box.append(
      el(
        'button',
        { type: 'button', class: 'btn ghost sm av-fold', 'aria-expanded': String(open), 'data-key': `fold:${kind}`, onClick: onToggle },
        icon(open ? 'chevron-down' : 'chevron-right'),
        open ? 'Dobrar' : `Ver ${kind === 'brief' ? 'o brief' : 'o resultado'} inteiro · ${num(fold.total)} caracteres`,
      ),
    );
  }
  return box;
}


function detail(step) {
  const row = (k, v) => [el('dt', {}, k), el('dd', { class: 'mono' }, v)];
  return el('dl', { class: 'av-detail' }, ...row('Ferramenta', step.name), ...row('Alvo', step.summary ?? '—'), ...row('Começou', clock(step.start)), ...row('Terminou', step.end ? clock(step.end) : '—'), ...row('Estado', STEP_STATE[step.state]?.label ?? '—'));
}

/**
 * The agent view: the header, the brief, the sequence and the result, from the data of the contract. (issue 521)
 *
 * `opts`: `sessionId`; `sessionTitle` and `trail` (`[{ label, href }]`, the agents above) for the crumb; `now`
 * for a running agent's duration; `onOpenChild(agentId)` when the person opens a child in line, so the state
 * layer reads it and answers with `setChild(agentId, data)`, or with `setChildError(agentId, retry)` when that
 * read fails: the child's slot says so and "Tentar de novo" calls `retry()` and goes back to reading (issue 539). The node has `update(next)`, for a running
 * agent that grew: the header and the result follow, the steps wait behind "N passos novos" and the view
 * never scrolls by itself.
 */
export function agentView(initial, opts = {}) {
  ensureStyle();
  const { sessionId } = opts;
  const root = el('section', { class: 'av-root' });
  const body = el('div', { class: 'av-body' });
  const pill = el('button', { type: 'button', class: 'btn outline sm av-new-steps', hidden: true, onClick: () => ((shown = data.steps.length), draw('new-steps')) });
  root.append(body);

  let data = initial;
  let shown = initial.steps.length; // steps the person has accepted; the rest wait behind the pill (issue 521)
  const children = new Map();
  const childErrors = new Map(); // agentId -> retry, for an open child whose read failed (issue 539)
  const open = new Set(); // details, folds, elided runs and open children, by key (issue 521)
  const flip = (key) => () => {
    if (!open.delete(key)) open.add(key);
    draw(key);
  };

  function stepRow(step, depth, from) {
    const info = STEP_STATE[step.state] ?? STEP_STATE.unknown;
    const meta = [offsetText(step.start, from), stepDurationText(step)].filter(Boolean).join(' · ');
    const key = `step:${depth}:${step.id}`;
    const isOpen = open.has(key);
    if (step.kind === 'agent') {
      const label = step.summary ?? step.name;
      const child = step.childAgentId ? children.get(step.childAgentId) : null;
      const line = el(
        'div',
        { class: 'av-line av-child-line' },
        step.childAgentId ? el('button', { type: 'button', class: 'av-toggle', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Fechar' : 'Abrir'} ${label} aqui`, 'data-key': key, onClick: () => ((!isOpen && opts.onOpenChild?.(step.childAgentId)), flip(key)()) }, icon(isOpen ? 'chevron-down' : 'chevron-right')) : el('span', { class: 'av-toggle-gap' }),
        el('span', { class: 'av-ag' }, icon('subagent')),
        el('b', { class: 'av-child-name' }, label),
        stateBadge(CHILD_STATE[step.state] ?? 'unknown', 'av-child-state'),
        el('span', { class: 'av-time mono' }, meta),
        step.childAgentId ? el('a', { class: 'av-open-view', href: agentViewHref(sessionId, step.childAgentId), 'aria-label': `Abrir a vista de ${label}` }, 'Abrir a vista', icon('external')) : null,
      );
      const inner = !isOpen ? null : child ? el('ol', { class: 'av-seq' }, ...sequence(child.steps, depth + 1, child.start)) : childErrors.has(step.childAgentId) ? childError(step.childAgentId) : el('p', { class: 'av-child-loading' }, 'Lendo o agente…');
      return el('li', { class: 'av-step av-child', 'data-depth': String(depth), 'data-kind': 'agent', 'data-state': step.state }, line, inner);
    }
    return el(
      'li',
      { class: 'av-step', 'data-depth': String(depth), 'data-kind': 'tool', 'data-state': step.state },
      el(
        'div',
        { class: 'av-line' },
        el('button', { type: 'button', class: 'av-toggle', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Fechar' : 'Ver'} o detalhe de ${step.name}`, 'data-key': key, onClick: flip(key) }, icon(isOpen ? 'chevron-down' : 'chevron-right')),
        el('span', { class: 'av-name mono' }, step.name),
        el('span', { class: 'av-target mono' }, step.summary ?? ''),
        el('span', { class: 'av-time mono' }, meta),
        el('span', { class: `av-step-state av-st-${info.tone}` }, icon(info.icon), info.label),
      ),
      isOpen ? detail(step) : null,
    );
  }

  // The slot of a child whose read failed: one line, and a retry that repeats only that child's read (issue 539).
  function childError(agentId) {
    const retry = childErrors.get(agentId);
    return el(
      'div',
      { class: 'av-none av-child-error', role: 'alert' },
      el('span', { class: 'ic c-error' }, icon('wifi-off')),
      el('div', {}, el('b', {}, 'Não deu para ler o agente.'), ' ', el('button', { type: 'button', class: 'btn outline sm av-child-retry', onClick: () => (childErrors.delete(agentId), retry(), draw()) }, icon('refresh'), 'Tentar de novo')),
    );
  }

  function sequence(steps, depth, from) {
    return elide(steps).map((part) => {
      if (part.step) return stepRow(part.step, depth, from);
      const key = `gap:${depth}:${part.hidden[0].id}`;
      if (open.has(key)) return part.hidden.map((s) => stepRow(s, depth, from));
      const n = part.hidden.length;
      const last = part.hidden.at(-1);
      return el(
        'li',
        { class: 'av-elided' },
        el('span', {}, `${num(n)} ${n === 1 ? 'passo escondido' : 'passos escondidos'}, do ${offsetText(part.hidden[0].start, from)} ao ${offsetText(last.end ?? last.start, from)}`),
        el('button', { type: 'button', class: 'btn ghost sm av-fold', 'data-key': key, onClick: flip(key) }, `Mostrar ${n === 1 ? 'o' : 'os'} ${num(n)}`),
      );
    }).flat();
  }

  function sequenceSection() {
    const steps = data.steps.slice(0, shown);
    const tools = steps.filter((s) => s.kind === 'tool').length;
    const subs = steps.length - tools;
    const running = data.state === 'working' || data.state === 'waiting';
    return el(
      'section',
      { class: 'card av-sec av-sequence' },
      el('div', { class: 'eyebrow' }, icon('list'), 'O que fez', el('span', { class: 'av-count' }, `${num(tools)} ${tools === 1 ? 'ferramenta' : 'ferramentas'} · ${num(subs)} ${subs === 1 ? 'subagente' : 'subagentes'}${running ? ' · até agora' : ''}`), pill),
      steps.length ? el('ol', { class: 'av-seq' }, ...sequence(steps, 0, data.start)) : el('div', { class: 'av-none' }, icon('list'), el('p', {}, el('b', {}, 'Nenhum passo registrado.'), running ? ' A sequência aparece aqui conforme o agente trabalha.' : '')),
    );
  }

  function resultBlock() {
    const running = data.state === 'working' || data.state === 'waiting';
    const empty = running
      ? none('result', 'Ainda sem resultado.', 'O agente está rodando; o resultado aparece aqui quando ele terminar.')
      : data.state === 'error'
        ? none('result', 'Falhou antes de devolver um resultado.', 'O último erro está na faixa de cima. A vista só lê: não há como rodar o agente de novo daqui.')
        : none('result', 'Sem resultado registrado.', 'O agente terminou sem uma última mensagem.');
    return textBlock({ kind: 'result', title: 'Resultado final', iconName: 'ok', text: data.result, truncated: data.resultTruncated, open: open.has('fold:result'), onToggle: flip('fold:result'), empty });
  }

  function draw(focusKey = null) {
    const wanted = focusKey ?? document.activeElement?.getAttribute?.('data-key') ?? null;
    const running = data.state === 'working' || data.state === 'waiting';
    const nothing = data.brief === null && data.steps.length === 0 && (data.result === null || data.result === undefined) && !running;
    pill.hidden = data.steps.length <= shown;
    pill.replaceChildren(`${num(data.steps.length - shown)} ${data.steps.length - shown === 1 ? 'passo novo' : 'passos novos'}`);
    const sections = nothing
      ? [el('section', { class: 'card state center av-nodata' }, el('div', { class: 'seal' }, icon('empty')), el('h2', {}, 'Sem dados deste agente'), el('p', {}, 'O núcleo não guardou o brief, os passos nem o resultado deste agente.'))]
      : [
          textBlock({ kind: 'brief', title: 'Brief recebido', iconName: 'file', text: data.brief, truncated: data.briefTruncated, open: open.has('fold:brief'), onToggle: flip('fold:brief'), empty: none('brief', 'Sem brief registrado.', 'O transcript deste agente não traz o pedido que ele recebeu.') }),
          sequenceSection(),
          resultBlock(),
        ];
    body.replaceChildren(...[crumb({ sessionId, sessionTitle: opts.sessionTitle, trail: opts.trail, current: agentLabel(data) }), ...header(data, { sessionId, now: opts.now }), ...sections].filter(Boolean));
    if (wanted) [...root.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === wanted)?.focus();
  }

  root.update = (next) => {
    data = next;
    shown = Math.min(shown, next.steps.length);
    draw();
  };
  root.setChild = (agentId, child) => {
    children.set(agentId, child);
    childErrors.delete(agentId);
    draw();
  };
  root.setChildError = (agentId, retry) => {
    childErrors.set(agentId, retry);
    draw();
  };
  // A read of the child starts again: the slot goes back to "Lendo o agente…" and offers no retry (issue 539).
  root.setChildLoading = (agentId) => {
    childErrors.delete(agentId);
    draw();
  };

  draw();
  return root;
}


/** Loading: the crumb comes from the address, each block is a skeleton in the shape of the view. (issue 521) */
export function agentViewLoading({ sessionId, sessionTitle = null, agentId = null }) {
  ensureStyle();
  const bone = (cls) => el('div', { class: `bone ${cls}` });
  return el(
    'section',
    { class: 'av-root av-loading state loading', 'aria-busy': 'true', 'aria-label': 'Lendo o agente' },
    crumb({ sessionId, sessionTitle, current: agentId ?? '…' }),
    el('div', { class: 'av-head' }, el('span', { class: 'av-ico' }, icon('subagent')), el('div', { class: 'bone medium av-skeleton-title' }), el('span', { class: 'av-reading' }, 'Lendo o agente…')),
    el('div', { class: 'av-facts' }, ...[1, 2, 3, 4].map(() => el('div', { class: 'card av-fact av-skeleton-fact' }, bone('short'), bone('medium')))),
    ...['Brief recebido', 'O que fez', 'Resultado final'].map((t) => el('section', { class: 'card av-sec av-skeleton-section', 'aria-busy': 'true' }, el('div', { class: 'eyebrow' }, t), bone(''), bone('medium'), bone(''))),
  );
}

/** The read failed: the shell's error state, with the crumb left in place to leave the screen. (issue 521) */
export function agentViewError({ sessionId, sessionTitle = null, agentId = null, text, retry }) {
  ensureStyle();
  return el('section', { class: 'av-root av-error' }, crumb({ sessionId, sessionTitle, current: agentId ?? '…' }), error({ title: 'Não deu para ler este agente', text, retry }));
}

/** The address points to an agent the core does not know in this session. (issue 521) */
export function agentViewMissing({ sessionId, sessionTitle = null, agentId = null }) {
  ensureStyle();
  return el(
    'section',
    { class: 'av-root av-missing' },
    crumb({ sessionId, sessionTitle, current: agentId ?? '…' }),
    el(
      'section',
      { class: 'card state center' },
      el('div', { class: 'seal' }, icon('search')),
      el('h2', {}, 'Este agente não existe nesta sessão'),
      el('p', {}, 'O endereço aponta para um agente que o núcleo não conhece (a sessão foi apagada ou o link está errado).'),
      el('a', { class: 'btn outline av-back', href: agentsTabHref(sessionId) }, icon('back'), 'Voltar para os agentes da sessão'),
    ),
  );
}


/**
 * The screen: `/ui/sessions/<id>/agents/<agentId>` (issue 539). It reads the agent, shows the state the read is
 * in, repeats only the read on "Tentar de novo", follows a running agent and opens children in line. Back (the
 * crumb's Agents link, or the link of the missing state) navigates with `{ focusAgent }` so the Agents tab
 * gives the focus back to the row the person came from. Nothing writes, and nothing scrolls by itself.
 */
export async function mount(area, ctx) {
  const { id: sessionId, agentId } = ctx.params;
  // A remote session's agent lives on its machine: the reads carry `machine=<id>`; a local one reads as before (issue 540).
  const machine = remoteMachine();
  const readAgent = (id) => ctx.read(machine ? routeWithMachine(agentReadRoute(sessionId, id), machine) : agentReadRoute(sessionId, id));
  const reader = createAgentReader({ read: () => readAgent(agentId) });
  const children = new Set(); // the children read or being read: opened once, read once (issue 539)
  const here = { sessionId, agentId };
  let view = null;
  let live = true;

  function openChild(childId) {
    if (children.has(childId)) return;
    children.add(childId);
    view?.setChildLoading(childId); // a stale error from the read before must not show while this one runs (issue 539)
    const read = () =>
      readAgent(childId).then(
        (data) => live && view?.setChild(childId, data),
        () => {
          children.delete(childId); // read again the next time it opens (issue 539)
          // The retry repeats only this child's read and puts the child back in the read-once set, so a reopen
          // while it runs, or after it succeeds, does not read it again (issue 539).
          if (live) view?.setChildError(childId, () => { children.add(childId); read(); });
        },
      );
    read();
  }

  function draw({ phase, data, message }) {
    if (!live) return;
    if (phase === 'ready') {
      if (view) return view.update(data);
      view = agentView(data, { sessionId, onOpenChild: openChild });
      return area.replaceChildren(view);
    }
    view = null;
    children.clear();
    area.replaceChildren(
      phase === 'loading'
        ? agentViewLoading(here)
        : phase === 'missing'
          ? agentViewMissing(here)
          : agentViewError({ ...here, text: message, retry: () => reader.load() }),
    );
  }

  // Back to the Agents tab is a navigation of the shell that carries the agent, so its row gets the focus
  // (issue 539). `area` is the shell's shared content element, so the listener must come off when the screen is
  // left. The shell registers the returned cleanup only after `mount` resolves, so a person who leaves during the
  // first read would never trigger it: the release hangs on the screen's own signal as well (issue 539).
  const onBack = (ev) => {
    if (ev.defaultPrevented || ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const link = ev.target?.closest?.('a[href]');
    if (link?.getAttribute('href') !== agentsTabHref(sessionId)) return;
    ev.preventDefault();
    ctx.navigate(agentsTabHref(sessionId), { focusAgent: agentId });
  };
  const release = () => {
    live = false;
    area.removeEventListener('click', onBack);
  };
  if (ctx.signal.aborted) return release; // left before it began: nothing is added to the shared area (issue 539)
  ctx.signal.addEventListener('abort', release, { once: true });
  area.addEventListener('click', onBack);

  reader.subscribe(draw);
  const follow = () => {
    if (live) void reader.refresh(); // `refresh` answers every failed read itself: it never rejects on one (issue 539)
  };
  ctx.onChange(() => {
    if (isRunning(reader.snapshot().data)) follow();
  });
  ctx.onRestart(follow);
  await reader.load();
  return release;
}
